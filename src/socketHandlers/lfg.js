'use strict';

/**
 * MSG Arena — LFG (Looking For Group) / party finder.
 *
 * A post says "I need N players for <game>". People claim slots; when the party
 * fills, an ephemeral voice channel is spun up (via ctx.createTempVoiceChannel)
 * and every member is invited into it. Posts auto-expire.
 *
 * Events (client → server):
 *   lfg:list         { gameId?, status? }        → lfg:posts (to requester)
 *   lfg:create       { gameId, slots, note, mode, expiresInMinutes }
 *   lfg:join         { postId, role? }
 *   lfg:leave        { postId }
 *   lfg:kick         { postId, userId }
 *   lfg:close        { postId }
 *   lfg:start-voice  { postId }
 *
 * Events (server → client):
 *   lfg:posts        { posts }                    (to the requester)
 *   lfg:post-created { post }                      (broadcast)
 *   lfg:post-updated { post }                      (broadcast)
 *   lfg:post-removed { postId, reason }            (broadcast)  reason: closed|expired
 *   lfg:party-ready  { postId, voiceCode }         (party members only)
 */

const MAX_PARTY = 8;            // P2P voice mesh gets rough past this
const MAX_NOTE = 200;
const MAX_MODE = 40;
const DEFAULT_MINUTES = 60;
const MIN_MINUTES = 5;
const MAX_MINUTES = 24 * 60;

let _sweeperStarted = false;

function displayName(db, userId) {
  const u = db.prepare('SELECT username, display_name FROM users WHERE id = ?').get(userId);
  return u ? (u.display_name || u.username) : 'Unknown';
}

// Full post payload the client renders. Null if the post is gone.
function buildPost(db, postId) {
  const p = db.prepare('SELECT * FROM lfg_posts WHERE id = ?').get(postId);
  if (!p) return null;
  const game = db.prepare('SELECT slug, name, icon FROM games WHERE id = ?').get(p.game_id) || { slug: '', name: 'Unknown', icon: '🎮' };
  const slotRows = db.prepare('SELECT user_id, role, joined_at FROM lfg_slots WHERE post_id = ? ORDER BY joined_at').all(postId);
  const members = slotRows.map(s => ({
    id: s.user_id,
    name: displayName(db, s.user_id),
    role: s.role || '',
    isOwner: s.user_id === p.owner_id,
  }));
  return {
    id: p.id,
    gameId: p.game_id,
    game: { slug: game.slug, name: game.name, icon: game.icon || '🎮' },
    ownerId: p.owner_id,
    owner: { id: p.owner_id, name: displayName(db, p.owner_id) },
    note: p.note || '',
    mode: p.mode || '',
    slots: p.slots,
    filled: members.length,
    status: p.status,
    expiresAt: p.expires_at,
    channelId: p.channel_id || null,
    voiceCode: p.voice_code || null,
    members,
  };
}

function activePosts(db, { gameId, status } = {}) {
  let sql = "SELECT id FROM lfg_posts WHERE status IN ('open','full')";
  const args = [];
  if (gameId) { sql += ' AND game_id = ?'; args.push(gameId); }
  if (status) { sql = "SELECT id FROM lfg_posts WHERE status = ?"; args.length = 0; args.push(status); if (gameId) { sql += ' AND game_id = ?'; args.push(gameId); } }
  sql += ' ORDER BY created_at DESC LIMIT 100';
  return db.prepare(sql).all(...args).map(r => buildPost(db, r.id)).filter(Boolean);
}

function emitToUsers(io, userIds, event, payload) {
  const ids = new Set(userIds);
  for (const [, s] of io.sockets.sockets) {
    if (s.user && ids.has(s.user.id) && !s.user.isBot) s.emit(event, payload);
  }
}

module.exports = function register(socket, ctx) {
  const { db, io, userHasPermission, enforceAutomod, logAudit, sendUserPush, createTempVoiceChannel } = ctx;

  const broadcast = (event, payload) => io.except('bot-sockets').emit(event, payload);
  const canManage = (post) =>
    socket.user.isAdmin ||
    post.owner_id === socket.user.id ||
    userHasPermission(socket.user.id, 'manage_lfg');

  // Spin up (or reuse) the party's voice channel and pull members in.
  function ensurePartyVoice(post) {
    if (post.voice_code) {
      const still = db.prepare('SELECT code FROM channels WHERE code = ?').get(post.voice_code);
      if (still) return post.voice_code;
    }
    const game = db.prepare('SELECT name, icon FROM games WHERE id = ?').get(post.game_id) || { name: 'Party', icon: '🎮' };
    let name = `${game.icon || '🎮'} ${game.name} — ${displayName(db, post.owner_id)}`;
    if (name.length > 50) name = name.slice(0, 50);
    const { code, channelId } = createTempVoiceChannel({
      name,
      creatorId: post.owner_id,
      userLimit: Math.min(post.slots, MAX_PARTY),
    });
    db.prepare('UPDATE lfg_posts SET voice_channel_id = ?, voice_code = ? WHERE id = ?').run(channelId, code, post.id);
    const memberIds = db.prepare('SELECT user_id FROM lfg_slots WHERE post_id = ?').all(post.id).map(r => r.user_id);
    emitToUsers(io, memberIds, 'lfg:party-ready', { postId: post.id, voiceCode: code });
    // Nudge anyone whose client isn't focused.
    sendUserPush(
      memberIds.filter(id => id !== socket.user.id),
      'Your party is ready 🎮',
      `${game.name}: your group is full — jump into voice.`,
      '/app'
    );
    return code;
  }

  // ── Games catalogue (for the create form dropdown) ──────
  socket.on('lfg:games', () => {
    const games = db.prepare(
      'SELECT id, slug, name, icon, default_party_size FROM games WHERE is_active = 1 ORDER BY kind DESC, name'
    ).all();
    socket.emit('lfg:games', { games });
  });

  // ── List ────────────────────────────────────────────────
  socket.on('lfg:list', (data) => {
    const gameId = data && Number.isInteger(data.gameId) ? data.gameId : null;
    const status = data && typeof data.status === 'string' ? data.status : null;
    socket.emit('lfg:posts', { posts: activePosts(db, { gameId, status }) });
  });

  // ── Create ──────────────────────────────────────────────
  socket.on('lfg:create', (data) => {
    if (!data || typeof data !== 'object') return;
    if (!socket.user.isAdmin && !userHasPermission(socket.user.id, 'create_lfg')) {
      return socket.emit('error-msg', "You don't have permission to post an LFG");
    }
    if (socket.user.isGuest) return socket.emit('error-msg', 'Guests cannot post LFG');

    const gameId = Number.isInteger(data.gameId) ? data.gameId : parseInt(data.gameId, 10);
    const game = gameId ? db.prepare('SELECT id, default_party_size FROM games WHERE id = ? AND is_active = 1').get(gameId) : null;
    if (!game) return socket.emit('error-msg', 'Pick a game');

    let slots = parseInt(data.slots, 10);
    if (!Number.isInteger(slots)) slots = game.default_party_size || 5;
    slots = Math.max(2, Math.min(MAX_PARTY, slots));

    const note = typeof data.note === 'string' ? data.note.trim().slice(0, MAX_NOTE) : '';
    const mode = typeof data.mode === 'string' ? data.mode.trim().slice(0, MAX_MODE) : '';
    if (note && enforceAutomod(note, { surface: 'lfg' })) return;   // enforceAutomod emits its own error
    if (mode && enforceAutomod(mode, { surface: 'lfg' })) return;

    let mins = parseInt(data.expiresInMinutes, 10);
    if (!Number.isInteger(mins)) mins = DEFAULT_MINUTES;
    mins = Math.max(MIN_MINUTES, Math.min(MAX_MINUTES, mins));
    const expiresAt = new Date(Date.now() + mins * 60000).toISOString();

    // One open post per user per game keeps the board tidy.
    const dupe = db.prepare("SELECT id FROM lfg_posts WHERE owner_id = ? AND game_id = ? AND status IN ('open','full')").get(socket.user.id, gameId);
    if (dupe) return socket.emit('error-msg', 'You already have an open LFG post for this game');

    const info = db.prepare(
      'INSERT INTO lfg_posts (game_id, owner_id, note, mode, slots, status, expires_at) VALUES (?, ?, ?, ?, ?, \'open\', ?)'
    ).run(gameId, socket.user.id, note, mode, slots, expiresAt);
    // Owner holds the first slot.
    db.prepare('INSERT INTO lfg_slots (post_id, user_id, role) VALUES (?, ?, ?)').run(info.lastInsertRowid, socket.user.id, '');

    const post = buildPost(db, info.lastInsertRowid);
    broadcast('lfg:post-created', { post });
    socket.emit('toast', { message: 'LFG posted', type: 'success' });
    try { require('../achievements').awardAndNotify(io, db, socket.user.id); } catch { /* nicety */ } // "Party Starter"
  });

  // ── Join ────────────────────────────────────────────────
  socket.on('lfg:join', (data) => {
    if (!data) return;
    const post = db.prepare('SELECT * FROM lfg_posts WHERE id = ?').get(data.postId);
    if (!post) return socket.emit('error-msg', 'That LFG post is gone');
    if (post.status !== 'open') return socket.emit('error-msg', 'That party is not open');
    if (socket.user.isGuest) return socket.emit('error-msg', 'Guests cannot join LFG');
    const already = db.prepare('SELECT 1 FROM lfg_slots WHERE post_id = ? AND user_id = ?').get(post.id, socket.user.id);
    if (already) return;
    const filled = db.prepare('SELECT COUNT(*) c FROM lfg_slots WHERE post_id = ?').get(post.id).c;
    if (filled >= post.slots) return socket.emit('error-msg', 'That party just filled up');

    const role = typeof data.role === 'string' ? data.role.trim().slice(0, MAX_MODE) : '';
    if (role && enforceAutomod(role, { surface: 'lfg' })) return;
    db.prepare('INSERT INTO lfg_slots (post_id, user_id, role) VALUES (?, ?, ?)').run(post.id, socket.user.id, role);

    const nowFilled = filled + 1;
    if (nowFilled >= post.slots) {
      db.prepare("UPDATE lfg_posts SET status = 'full' WHERE id = ?").run(post.id);
      const fresh = db.prepare('SELECT * FROM lfg_posts WHERE id = ?').get(post.id);
      ensurePartyVoice(fresh);
    }
    broadcast('lfg:post-updated', { post: buildPost(db, post.id) });
  });

  // ── Leave ───────────────────────────────────────────────
  socket.on('lfg:leave', (data) => {
    if (!data) return;
    const post = db.prepare('SELECT * FROM lfg_posts WHERE id = ?').get(data.postId);
    if (!post) return;
    // Owner leaving closes the whole post.
    if (post.owner_id === socket.user.id) {
      db.prepare("UPDATE lfg_posts SET status = 'closed', closed_at = CURRENT_TIMESTAMP WHERE id = ?").run(post.id);
      broadcast('lfg:post-removed', { postId: post.id, reason: 'closed' });
      return;
    }
    const res = db.prepare('DELETE FROM lfg_slots WHERE post_id = ? AND user_id = ?').run(post.id, socket.user.id);
    if (res.changes && post.status === 'full') {
      db.prepare("UPDATE lfg_posts SET status = 'open' WHERE id = ?").run(post.id);
    }
    broadcast('lfg:post-updated', { post: buildPost(db, post.id) });
  });

  // ── Kick a member (owner or manage_lfg) ─────────────────
  socket.on('lfg:kick', (data) => {
    if (!data) return;
    const post = db.prepare('SELECT * FROM lfg_posts WHERE id = ?').get(data.postId);
    if (!post) return;
    if (!canManage(post)) return socket.emit('error-msg', "You can't manage that post");
    const targetId = Number.isInteger(data.userId) ? data.userId : parseInt(data.userId, 10);
    if (targetId === post.owner_id) return socket.emit('error-msg', "Can't remove the party leader");
    db.prepare('DELETE FROM lfg_slots WHERE post_id = ? AND user_id = ?').run(post.id, targetId);
    if (post.status === 'full') db.prepare("UPDATE lfg_posts SET status = 'open' WHERE id = ?").run(post.id);
    broadcast('lfg:post-updated', { post: buildPost(db, post.id) });
  });

  // ── Close (owner or manage_lfg) ─────────────────────────
  socket.on('lfg:close', (data) => {
    if (!data) return;
    const post = db.prepare('SELECT * FROM lfg_posts WHERE id = ?').get(data.postId);
    if (!post) return;
    if (!canManage(post)) return socket.emit('error-msg', "You can't close that post");
    db.prepare("UPDATE lfg_posts SET status = 'closed', closed_at = CURRENT_TIMESTAMP WHERE id = ?").run(post.id);
    if (post.owner_id !== socket.user.id) {
      try {
        logAudit({
          actor: socket.user, action: 'lfg_close',
          target_type: 'lfg', target_id: post.id, target_name: `post #${post.id}`,
          details: { ownerId: post.owner_id },
        });
      } catch {}
    }
    broadcast('lfg:post-removed', { postId: post.id, reason: 'closed' });
  });

  // ── Manually (re)open the party's voice channel ─────────
  socket.on('lfg:start-voice', (data) => {
    if (!data) return;
    const post = db.prepare('SELECT * FROM lfg_posts WHERE id = ?').get(data.postId);
    if (!post) return;
    const member = db.prepare('SELECT 1 FROM lfg_slots WHERE post_id = ? AND user_id = ?').get(post.id, socket.user.id);
    if (!member && !canManage(post)) return socket.emit('error-msg', 'Only party members can start voice');
    const code = ensurePartyVoice(post);
    // Make sure the requester gets the code even if the push/broadcast missed.
    socket.emit('lfg:party-ready', { postId: post.id, voiceCode: code });
    broadcast('lfg:post-updated', { post: buildPost(db, post.id) });
  });

  // ── Expiry sweeper (once per process) ───────────────────
  if (!_sweeperStarted) {
    _sweeperStarted = true;
    setInterval(() => {
      try {
        const due = db.prepare("SELECT id FROM lfg_posts WHERE status IN ('open','full') AND expires_at <= CURRENT_TIMESTAMP").all();
        for (const row of due) {
          db.prepare("UPDATE lfg_posts SET status = 'expired', closed_at = CURRENT_TIMESTAMP WHERE id = ?").run(row.id);
          io.except('bot-sockets').emit('lfg:post-removed', { postId: row.id, reason: 'expired' });
        }
      } catch (err) {
        console.error('[lfg] sweeper error:', err.message);
      }
    }, 60 * 1000).unref?.();
  }
};
