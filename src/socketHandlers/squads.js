'use strict';

/**
 * MSG Arena — Squads / teams: persistent named groups with a roster.
 *
 * The community-building layer above ephemeral LFG parties. Consent-first: you
 * join only by accepting an invite. Roster reads are for signed-in users; every
 * write is authorised by the caller's role (owner | captain | member).
 */
module.exports = function register(socket, ctx) {
  const { db, io, sendUserPush, createTempVoiceChannel } = ctx;
  const me = () => socket.user.id;

  const roleOf = (squadId, userId) => {
    const r = db.prepare('SELECT role FROM squad_members WHERE squad_id = ? AND user_id = ?').get(squadId, userId);
    return r ? r.role : null;
  };
  const memberCount = (squadId) => db.prepare('SELECT COUNT(*) c FROM squad_members WHERE squad_id = ?').get(squadId).c;
  const rosterOf = (squadId) => db.prepare(
    "SELECT sm.user_id AS userId, sm.role, u.username, u.display_name AS displayName, u.avatar, u.status " +
    "FROM squad_members sm JOIN users u ON u.id = sm.user_id WHERE sm.squad_id = ? " +
    "ORDER BY CASE sm.role WHEN 'owner' THEN 0 WHEN 'captain' THEN 1 ELSE 2 END, COALESCE(u.display_name, u.username) COLLATE NOCASE"
  ).all(squadId);
  const summary = (s) => ({ id: s.id, name: s.name, tag: s.tag, description: s.description, ownerId: s.owner_id, members: memberCount(s.id) });

  function emitMine() {
    const rows = db.prepare(
      "SELECT s.*, sm.role AS myRole FROM squads s JOIN squad_members sm ON sm.squad_id = s.id " +
      "WHERE sm.user_id = ? ORDER BY s.name COLLATE NOCASE"
    ).all(me());
    socket.emit('squad:mine', { squads: rows.map((r) => ({ ...summary(r), myRole: r.myRole })) });
  }
  function emitInvites() {
    const rows = db.prepare(
      "SELECT s.id, s.name, s.tag, iu.username AS invitedBy FROM squad_invites si JOIN squads s ON s.id = si.squad_id " +
      "LEFT JOIN users iu ON iu.id = si.invited_by WHERE si.user_id = ? ORDER BY si.created_at DESC"
    ).all(me());
    socket.emit('squad:invites', { invites: rows.map((r) => ({ squadId: r.id, name: r.name, tag: r.tag, invitedBy: r.invitedBy })) });
  }
  function emitDetail(squadId) {
    const s = db.prepare('SELECT * FROM squads WHERE id = ?').get(squadId);
    if (!s) { socket.emit('squad:detail', { id: squadId, gone: true }); return; }
    socket.emit('squad:detail', { ...summary(s), createdAt: s.created_at, roster: rosterOf(s.id), myRole: roleOf(s.id, me()) });
  }

  socket.on('squad:mine', emitMine);
  socket.on('squad:invites', emitInvites);
  socket.on('squad:browse', () => {
    const rows = db.prepare('SELECT * FROM squads ORDER BY name COLLATE NOCASE LIMIT 200').all();
    socket.emit('squad:browse', { squads: rows.map(summary) });
  });
  socket.on('squad:get', (data) => { if (data && Number.isInteger(data.squadId)) emitDetail(data.squadId); });

  socket.on('squad:create', (data) => {
    const name = (data && typeof data.name === 'string') ? data.name.trim().slice(0, 40) : '';
    const tag = (data && typeof data.tag === 'string') ? data.tag.trim().slice(0, 6) : '';
    const desc = (data && typeof data.description === 'string') ? data.description.trim().slice(0, 300) : '';
    if (name.length < 2) return socket.emit('error-msg', 'Squad name must be at least 2 characters');
    if (db.prepare('SELECT COUNT(*) c FROM squads WHERE owner_id = ?').get(me()).c >= 5)
      return socket.emit('error-msg', 'You already own the maximum number of squads (5)');
    if (tag && db.prepare('SELECT 1 FROM squads WHERE tag = ? COLLATE NOCASE').get(tag))
      return socket.emit('error-msg', 'That tag is already taken');
    const info = db.prepare('INSERT INTO squads (name, tag, description, owner_id) VALUES (?, ?, ?, ?)').run(name, tag || null, desc, me());
    db.prepare("INSERT INTO squad_members (squad_id, user_id, role) VALUES (?, ?, 'owner')").run(info.lastInsertRowid, me());
    emitMine();
    emitDetail(info.lastInsertRowid);
  });

  socket.on('squad:invite', (data) => {
    if (!data || !Number.isInteger(data.squadId) || !Number.isInteger(data.userId)) return;
    const myRole = roleOf(data.squadId, me());
    if (myRole !== 'owner' && myRole !== 'captain') return socket.emit('error-msg', 'Only the owner or a captain can invite');
    const s = db.prepare('SELECT id, name, tag FROM squads WHERE id = ?').get(data.squadId);
    if (!s) return;
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(data.userId)) return;
    if (roleOf(data.squadId, data.userId)) return socket.emit('error-msg', 'They are already a member');
    if (memberCount(data.squadId) >= 50) return socket.emit('error-msg', 'Squad is full (50)');
    db.prepare('INSERT OR IGNORE INTO squad_invites (squad_id, user_id, invited_by) VALUES (?, ?, ?)').run(data.squadId, data.userId, me());
    io.to('user:' + data.userId).emit('squad:invited', { squadId: s.id, name: s.name, tag: s.tag, invitedBy: socket.user.username });
    try { sendUserPush([data.userId], 'Squad invite', socket.user.username + ' invited you to ' + s.name, '/app'); } catch (e) {}
    emitDetail(data.squadId);
  });

  socket.on('squad:accept', (data) => {
    if (!data || !Number.isInteger(data.squadId)) return;
    if (!db.prepare('SELECT 1 FROM squad_invites WHERE squad_id = ? AND user_id = ?').get(data.squadId, me()))
      return socket.emit('error-msg', 'No pending invite');
    if (memberCount(data.squadId) >= 50) {
      db.prepare('DELETE FROM squad_invites WHERE squad_id = ? AND user_id = ?').run(data.squadId, me());
      return socket.emit('error-msg', 'Squad is full');
    }
    db.prepare("INSERT OR IGNORE INTO squad_members (squad_id, user_id, role) VALUES (?, ?, 'member')").run(data.squadId, me());
    db.prepare('DELETE FROM squad_invites WHERE squad_id = ? AND user_id = ?').run(data.squadId, me());
    emitMine(); emitInvites(); emitDetail(data.squadId);
  });

  socket.on('squad:decline', (data) => {
    if (!data || !Number.isInteger(data.squadId)) return;
    db.prepare('DELETE FROM squad_invites WHERE squad_id = ? AND user_id = ?').run(data.squadId, me());
    emitInvites();
  });

  socket.on('squad:leave', (data) => {
    if (!data || !Number.isInteger(data.squadId)) return;
    const myRole = roleOf(data.squadId, me());
    if (!myRole) return;
    if (myRole === 'owner') return socket.emit('error-msg', 'The owner must disband the squad (or promote someone first)');
    db.prepare('DELETE FROM squad_members WHERE squad_id = ? AND user_id = ?').run(data.squadId, me());
    emitMine(); emitDetail(data.squadId);
  });

  socket.on('squad:kick', (data) => {
    if (!data || !Number.isInteger(data.squadId) || !Number.isInteger(data.userId) || data.userId === me()) return;
    const myRole = roleOf(data.squadId, me());
    const targetRole = roleOf(data.squadId, data.userId);
    if (!targetRole) return;
    if (myRole === 'owner' || (myRole === 'captain' && targetRole === 'member')) {
      db.prepare('DELETE FROM squad_members WHERE squad_id = ? AND user_id = ?').run(data.squadId, data.userId);
      io.to('user:' + data.userId).emit('squad:removed', { squadId: data.squadId });
      emitDetail(data.squadId);
    } else socket.emit('error-msg', 'You cannot remove that member');
  });

  socket.on('squad:promote', (data) => {
    if (!data || !Number.isInteger(data.squadId) || !Number.isInteger(data.userId)) return;
    if (roleOf(data.squadId, me()) !== 'owner') return socket.emit('error-msg', 'Only the owner can change roles');
    const tr = roleOf(data.squadId, data.userId);
    if (tr !== 'member' && tr !== 'captain') return;
    db.prepare('UPDATE squad_members SET role = ? WHERE squad_id = ? AND user_id = ?')
      .run(tr === 'member' ? 'captain' : 'member', data.squadId, data.userId);
    emitDetail(data.squadId);
  });

  socket.on('squad:disband', (data) => {
    if (!data || !Number.isInteger(data.squadId)) return;
    const s = db.prepare('SELECT owner_id FROM squads WHERE id = ?').get(data.squadId);
    if (!s || s.owner_id !== me()) return socket.emit('error-msg', 'Only the owner can disband');
    const members = db.prepare('SELECT user_id FROM squad_members WHERE squad_id = ?').all(data.squadId).map((r) => r.user_id);
    db.prepare('DELETE FROM squads WHERE id = ?').run(data.squadId);
    for (const uid of members) if (uid !== me()) io.to('user:' + uid).emit('squad:removed', { squadId: data.squadId });
    emitMine();
  });

  socket.on('squad:voice', (data) => {
    if (!data || !Number.isInteger(data.squadId)) return;
    if (!roleOf(data.squadId, me())) return;
    const s = db.prepare('SELECT name, tag FROM squads WHERE id = ?').get(data.squadId);
    if (!s) return;
    try {
      const label = ((s.tag ? '[' + s.tag + '] ' : '') + s.name).slice(0, 40);
      const res = createTempVoiceChannel({ name: label, creatorId: me(), userLimit: 0, hours: 6 });
      const members = db.prepare('SELECT user_id FROM squad_members WHERE squad_id = ? AND user_id != ?').all(data.squadId, me()).map((r) => r.user_id);
      for (const uid of members) io.to('user:' + uid).emit('squad:voice-started', { squadId: data.squadId, name: s.name, code: res.code });
      try { sendUserPush(members, s.name + ' voice', socket.user.username + ' started squad voice', '/app'); } catch (e) {}
      socket.emit('squad:voice-ready', { squadId: data.squadId, code: res.code });
    } catch (e) { socket.emit('error-msg', 'Could not start squad voice'); }
  });

  // Member search for the invite picker (owner/captain only). The community's
  // member list is already visible to members, so a name search is fine here;
  // returns only basic public fields, excluding current members + pending invites.
  socket.on('squad:candidates', (data) => {
    if (!data || !Number.isInteger(data.squadId)) return;
    const myRole = roleOf(data.squadId, me());
    if (myRole !== 'owner' && myRole !== 'captain') return;
    const q = (typeof data.q === 'string') ? data.q.trim().replace(/[%_]/g, '').slice(0, 40) : '';
    const like = '%' + q + '%';
    const rows = db.prepare(
      "SELECT id AS userId, username, display_name AS displayName, avatar FROM users " +
      "WHERE id > 0 AND id NOT IN (SELECT user_id FROM squad_members WHERE squad_id = ?) " +
      "AND id NOT IN (SELECT user_id FROM squad_invites WHERE squad_id = ?) " +
      "AND (username LIKE ? OR COALESCE(display_name,'') LIKE ?) " +
      "ORDER BY COALESCE(display_name, username) COLLATE NOCASE LIMIT 20"
    ).all(data.squadId, data.squadId, like, like);
    socket.emit('squad:candidates', { squadId: data.squadId, candidates: rows });
  });
};
