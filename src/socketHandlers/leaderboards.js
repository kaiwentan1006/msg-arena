'use strict';

/**
 * MSG Arena — Leaderboards hub: server-wide competitive rankings.
 *
 * Read-only. One request returns the "who's on top" boards across every
 * competitive surface: tournament titles, top clip creators, ELO ladders, and
 * arcade high scores. Champions / clips are public acts so names always show;
 * arcade respects the existing hide_score_badge privacy preference.
 *
 *   get-leaderboards {}  →  leaderboards { titles, clips, ladders, arcade }
 */

const TOP = 10;
const PER_BOARD = 5;

module.exports = function register(socket, ctx) {
  const { db, xp } = ctx;

  socket.on('get-leaderboards', () => {
    try {
      // Memoize within the request so a user topping several boards (champion +
      // top clip creator + ladder) is looked up once, not per entry. (perf L5)
      const _nameCache = new Map();
      const nameOf = (id) => {
        if (_nameCache.has(id)) return _nameCache.get(id);
        const u = db.prepare('SELECT username, display_name FROM users WHERE id = ?').get(id);
        const n = u ? (u.display_name || u.username) : 'Unknown';
        _nameCache.set(id, n);
        return n;
      };

      // ── Most tournament titles ──
      const titles = db.prepare(`
        SELECT champion_id AS userId, COUNT(*) AS count
        FROM tournaments
        WHERE champion_id IS NOT NULL AND status = 'complete'
        GROUP BY champion_id
        ORDER BY count DESC, MAX(completed_at) DESC
        LIMIT ?
      `).all(TOP).map(r => ({ userId: r.userId, name: nameOf(r.userId), count: r.count }));

      // ── Top clip creators (by votes received, then clip count) ──
      const clipCounts = new Map();
      for (const r of db.prepare('SELECT uploader_id AS id, COUNT(*) AS clips FROM clips GROUP BY uploader_id').all()) {
        clipCounts.set(r.id, { userId: r.id, clips: r.clips, votes: 0 });
      }
      for (const r of db.prepare('SELECT c.uploader_id AS id, COUNT(*) AS votes FROM clip_votes v JOIN clips c ON v.clip_id = c.id GROUP BY c.uploader_id').all()) {
        const e = clipCounts.get(r.id); if (e) e.votes = r.votes;
      }
      const clips = [...clipCounts.values()]
        .sort((a, b) => b.votes - a.votes || b.clips - a.clips)
        .slice(0, TOP)
        .map(e => ({ userId: e.userId, name: nameOf(e.userId), clips: e.clips, votes: e.votes }));

      // ── ELO ladders — top players per active/recent ladder ──
      const ladderRows = db.prepare(
        "SELECT id, name FROM tournaments WHERE format = 'ladder' ORDER BY (status='complete') ASC, created_at DESC LIMIT 6"
      ).all();
      const ladders = ladderRows.map(l => ({
        name: l.name,
        top: db.prepare(
          'SELECT user_id AS userId, rating FROM tournament_participants WHERE tournament_id = ? ORDER BY rating DESC LIMIT ?'
        ).all(l.id, PER_BOARD).map((r, i) => ({ rank: i + 1, userId: r.userId, name: nameOf(r.userId), rating: r.rating })),
      })).filter(l => l.top.length > 0);

      // ── Arcade high scores — top per game (honours hide_score_badge) ──
      const games = db.prepare('SELECT DISTINCT game FROM high_scores WHERE score > 0 ORDER BY game LIMIT 12').all().map(r => r.game);
      const arcade = games.map(game => ({
        game,
        top: db.prepare(`
          SELECT hs.user_id AS userId, COALESCE(u.display_name, u.username) AS name, MAX(hs.score) AS score
          FROM high_scores hs JOIN users u ON hs.user_id = u.id
          WHERE hs.game = ? AND hs.score > 0
            AND NOT EXISTS (SELECT 1 FROM user_preferences up WHERE up.user_id = u.id AND up.key = 'hide_score_badge' AND up.value = 'true')
          GROUP BY hs.user_id
          ORDER BY score DESC LIMIT ?
        `).all(game, PER_BOARD).map((r, i) => ({ rank: i + 1, userId: r.userId, name: r.name, score: r.score })),
      })).filter(b => b.top.length > 0);

      // ── Activity levels — top XP earners ──
      const levels = (xp ? xp.getTopLevels(TOP) : []).map((r, i) => ({
        rank: i + 1, userId: r.userId, name: nameOf(r.userId), level: r.level, xp: r.xp,
      }));

      socket.emit('leaderboards', { titles, clips, ladders, arcade, levels });
    } catch (e) {
      console.warn('[leaderboards] failed:', e.message);
      socket.emit('leaderboards', { titles: [], clips: [], ladders: [], arcade: [], levels: [] });
    }
  });
};
