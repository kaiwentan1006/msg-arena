'use strict';

/**
 * MSG Arena — "My Games" + player discovery.
 *
 * The persistent discovery layer for gamers: a member marks which games they
 * play (from the auto-populating `games` catalogue), and anyone can browse who
 * plays what. Complements LFG (active party-finding) and live "playing now"
 * presence (ephemeral). All reads are for signed-in users; writes only touch
 * the caller's own rows.
 */
module.exports = function register(socket, ctx) {
  const { db, io } = ctx;

  // A member's games incl. per-game rank — used by mine/add/remove/set-rank.
  const _mine = (uid) => db.prepare(`
    SELECT g.id, g.slug, g.name, g.icon, ug.rank
    FROM user_games ug JOIN games g ON g.id = ug.game_id
    WHERE ug.user_id = ? AND g.is_active = 1 ORDER BY g.name
  `).all(uid);

  // The catalogue everyone picks from (same source LFG uses).
  socket.on('games:catalogue', () => {
    try {
      const games = db.prepare(
        'SELECT id, slug, name, icon FROM games WHERE is_active = 1 ORDER BY kind DESC, name'
      ).all();
      socket.emit('games:catalogue', { games });
    } catch (e) { console.warn('[games] catalogue failed:', e.message); }
  });

  // Games a given user plays (defaults to self).
  socket.on('games:mine', (data) => {
    try {
      const uid = (data && Number.isInteger(data.userId)) ? data.userId : socket.user.id;
      const games = _mine(uid);
      const payload = { userId: uid, games };
      // Include the caller's own discovery profile so the hub's editor prefills.
      if (uid === socket.user.id) {
        const u = db.prepare('SELECT country, languages FROM users WHERE id = ?').get(uid) || {};
        payload.profile = { country: u.country || '', languages: u.languages ? String(u.languages).split(',').filter(Boolean) : [] };
      }
      socket.emit('games:mine', payload);
    } catch (e) { console.warn('[games] mine failed:', e.message); }
  });

  socket.on('games:add', (data) => {
    if (!data || !Number.isInteger(data.gameId)) return;
    try {
      const g = db.prepare('SELECT id FROM games WHERE id = ? AND is_active = 1').get(data.gameId);
      if (!g) return socket.emit('error-msg', 'Unknown game');
      // Cap how many a user can list, to keep the discovery lists meaningful.
      const n = db.prepare('SELECT COUNT(*) c FROM user_games WHERE user_id = ?').get(socket.user.id).c;
      if (n >= 40) return socket.emit('error-msg', 'You have reached the game limit (40)');
      db.prepare('INSERT OR IGNORE INTO user_games (user_id, game_id) VALUES (?, ?)').run(socket.user.id, data.gameId);
      const games = _mine(socket.user.id);
      socket.emit('games:mine', { userId: socket.user.id, games });
    } catch (e) { console.warn('[games] add failed:', e.message); }
  });

  socket.on('games:remove', (data) => {
    if (!data || !Number.isInteger(data.gameId)) return;
    try {
      db.prepare('DELETE FROM user_games WHERE user_id = ? AND game_id = ?').run(socket.user.id, data.gameId);
      const games = _mine(socket.user.id);
      socket.emit('games:mine', { userId: socket.user.id, games });
    } catch (e) { console.warn('[games] remove failed:', e.message); }
  });

  // Who plays a given game — the discovery directory. One grouped query.
  socket.on('games:players', (data) => {
    if (!data || !Number.isInteger(data.gameId)) return;
    try {
      const game = db.prepare('SELECT id, slug, name, icon FROM games WHERE id = ?').get(data.gameId);
      if (!game) return;
      const players = db.prepare(`
        SELECT u.id AS userId, u.username, u.display_name AS displayName, u.avatar, u.status, u.country, u.languages, ug.rank
        FROM user_games ug JOIN users u ON u.id = ug.user_id
        WHERE ug.game_id = ?
        ORDER BY (u.status IS NOT NULL AND u.status != 'offline' AND u.status != 'invisible') DESC,
                 COALESCE(u.display_name, u.username) COLLATE NOCASE
        LIMIT 200
      `).all(data.gameId);
      socket.emit('games:players', { game, players });
    } catch (e) { console.warn('[games] players failed:', e.message); }
  });

  // Set the caller's rank/skill for a game they play (free text, e.g. "Radiant").
  socket.on('games:set-rank', (data) => {
    if (!data || !Number.isInteger(data.gameId)) return;
    try {
      const rank = (typeof data.rank === 'string') ? data.rank.trim().slice(0, 40) : '';
      db.prepare('UPDATE user_games SET rank = ? WHERE user_id = ? AND game_id = ?')
        .run(rank || null, socket.user.id, data.gameId);
      socket.emit('games:mine', { userId: socket.user.id, games: _mine(socket.user.id) });
    } catch (e) { console.warn('[games] set-rank failed:', e.message); }
  });

  // ── Player discovery search ─────────────────────────────
  // Find teammates by game + country + language + online, with per-game rank.
  // In-server discovery (everyone is already a member); no cross-server directory.
  socket.on('players:search', (data) => {
    data = data || {};
    try {
      const params = [];
      let sql = `SELECT DISTINCT u.id AS userId, u.username, u.display_name AS displayName,
                        u.avatar, u.avatar_shape AS avatarShape, u.status, u.country, u.languages
                 FROM users u`;
      if (Number.isInteger(data.gameId)) { sql += ' JOIN user_games ug ON ug.user_id = u.id AND ug.game_id = ?'; params.push(data.gameId); }
      const where = ['u.id > 0'];
      if (typeof data.country === 'string' && /^[A-Za-z]{2,3}$/.test(data.country.trim())) { where.push('u.country = ?'); params.push(data.country.trim().toUpperCase()); }
      if (typeof data.language === 'string' && /^[a-z]{2,3}$/i.test(data.language.trim())) { where.push("(',' || IFNULL(LOWER(u.languages),'') || ',') LIKE ?"); params.push('%,' + data.language.trim().toLowerCase() + ',%'); }
      if (typeof data.query === 'string' && data.query.trim()) { const q = '%' + data.query.trim().slice(0, 40).replace(/[%_]/g, '') + '%'; where.push('(u.username LIKE ? OR u.display_name LIKE ?)'); params.push(q, q); }
      sql += ' WHERE ' + where.join(' AND ');
      sql += ` ORDER BY COALESCE(u.display_name, u.username) COLLATE NOCASE LIMIT 200`;
      let players = db.prepare(sql).all(...params);
      // Real online = has a live socket (the status column is a chosen state).
      const onlineIds = new Set();
      for (const [, sk] of io.of('/').sockets) { if (sk.user) onlineIds.add(sk.user.id); }
      players.forEach(p => { p.online = onlineIds.has(p.userId); });
      if (data.onlineOnly) players = players.filter(p => p.online);
      // online first, then by name
      players.sort((a, b) => (b.online - a.online) || String(a.displayName || a.username).localeCompare(String(b.displayName || b.username)));
      players = players.slice(0, 100);
      // Attach each player's games (+rank), batched.
      if (players.length) {
        const ids = players.map(p => p.userId);
        const ph = ids.map(() => '?').join(',');
        const grows = db.prepare(`SELECT ug.user_id AS uid, g.slug, g.name, g.icon, ug.rank
                                  FROM user_games ug JOIN games g ON g.id = ug.game_id
                                  WHERE ug.user_id IN (${ph}) AND g.is_active = 1 ORDER BY g.name`).all(...ids);
        const byUser = {};
        grows.forEach(r => { (byUser[r.uid] || (byUser[r.uid] = [])).push({ slug: r.slug, name: r.name, icon: r.icon, rank: r.rank || null }); });
        players.forEach(p => { p.games = byUser[p.userId] || []; });
      }
      socket.emit('players:search', {
        players,
        filters: { gameId: data.gameId || null, country: data.country || null, language: data.language || null, onlineOnly: !!data.onlineOnly, query: data.query || '' },
      });
    } catch (e) { console.warn('[players] search failed:', e.message); }
  });

  // Player counts per game — powers the browse view's "N players" badges.
  socket.on('games:counts', () => {
    try {
      const rows = db.prepare('SELECT game_id AS gameId, COUNT(*) AS players FROM user_games GROUP BY game_id').all();
      socket.emit('games:counts', { counts: rows });
    } catch (e) { console.warn('[games] counts failed:', e.message); }
  });
};
