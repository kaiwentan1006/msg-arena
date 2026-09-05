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
  const { db } = ctx;

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
      const games = db.prepare(`
        SELECT g.id, g.slug, g.name, g.icon
        FROM user_games ug JOIN games g ON g.id = ug.game_id
        WHERE ug.user_id = ? AND g.is_active = 1
        ORDER BY g.name
      `).all(uid);
      socket.emit('games:mine', { userId: uid, games });
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
      const games = db.prepare(`
        SELECT g.id, g.slug, g.name, g.icon FROM user_games ug JOIN games g ON g.id = ug.game_id
        WHERE ug.user_id = ? AND g.is_active = 1 ORDER BY g.name
      `).all(socket.user.id);
      socket.emit('games:mine', { userId: socket.user.id, games });
    } catch (e) { console.warn('[games] add failed:', e.message); }
  });

  socket.on('games:remove', (data) => {
    if (!data || !Number.isInteger(data.gameId)) return;
    try {
      db.prepare('DELETE FROM user_games WHERE user_id = ? AND game_id = ?').run(socket.user.id, data.gameId);
      const games = db.prepare(`
        SELECT g.id, g.slug, g.name, g.icon FROM user_games ug JOIN games g ON g.id = ug.game_id
        WHERE ug.user_id = ? AND g.is_active = 1 ORDER BY g.name
      `).all(socket.user.id);
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
        SELECT u.id AS userId, u.username, u.display_name AS displayName, u.avatar, u.status
        FROM user_games ug JOIN users u ON u.id = ug.user_id
        WHERE ug.game_id = ?
        ORDER BY (u.status IS NOT NULL AND u.status != 'offline' AND u.status != 'invisible') DESC,
                 COALESCE(u.display_name, u.username) COLLATE NOCASE
        LIMIT 200
      `).all(data.gameId);
      socket.emit('games:players', { game, players });
    } catch (e) { console.warn('[games] players failed:', e.message); }
  });

  // Player counts per game — powers the browse view's "N players" badges.
  socket.on('games:counts', () => {
    try {
      const rows = db.prepare('SELECT game_id AS gameId, COUNT(*) AS players FROM user_games GROUP BY game_id').all();
      socket.emit('games:counts', { counts: rows });
    } catch (e) { console.warn('[games] counts failed:', e.message); }
  });
};
