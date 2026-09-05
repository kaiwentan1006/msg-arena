'use strict';

/**
 * MSG Arena — Player Card: a gamer's aggregated stats.
 *
 * Read-only. Pulls together the gaming record that already lives across the
 * tournament, clip and arcade tables into one "who is this player" payload the
 * profile popup renders. Separate from get-user-profile so the core profile
 * fetch stays untouched.
 *
 *   get-player-card { userId }  →  player-card { userId, tournaments, ladders, clips, arcade }
 */

module.exports = function register(socket, ctx) {
  const { db, xp } = ctx;

  socket.on('get-player-card', (data) => {
    if (!data || !Number.isInteger(data.userId)) return;
    const uid = data.userId;
    try {
      if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(uid)) return;

      // ── Tournaments ──
      const entered = db.prepare('SELECT COUNT(*) n FROM tournament_participants WHERE user_id = ?').get(uid).n;
      const championships = db.prepare('SELECT COUNT(*) n FROM tournaments WHERE champion_id = ?').get(uid).n;
      const rec = db.prepare(
        'SELECT COALESCE(SUM(wins),0) w, COALESCE(SUM(losses),0) l, COALESCE(SUM(draws),0) d FROM tournament_participants WHERE user_id = ?'
      ).get(uid);

      // ── ELO ladders (best few by rating, with live rank) ──
      const ladders = db.prepare(`
        SELECT t.name,
               tp.rating,
               (SELECT COUNT(*) + 1 FROM tournament_participants x
                  WHERE x.tournament_id = t.id AND x.rating > tp.rating) AS rank,
               (SELECT COUNT(*) FROM tournament_participants x WHERE x.tournament_id = t.id) AS total
        FROM tournament_participants tp
        JOIN tournaments t ON t.id = tp.tournament_id
        WHERE tp.user_id = ? AND t.format = 'ladder'
        ORDER BY tp.rating DESC
        LIMIT 5
      `).all(uid);

      // ── Clips ──
      const clipsPosted = db.prepare('SELECT COUNT(*) n FROM clips WHERE uploader_id = ?').get(uid).n;
      const clipVotes = db.prepare(
        'SELECT COUNT(*) n FROM clip_votes v JOIN clips c ON v.clip_id = c.id WHERE c.uploader_id = ?'
      ).get(uid).n;

      // ── Arcade high scores (best per game) ──
      const arcade = db.prepare(
        'SELECT game, MAX(score) score FROM high_scores WHERE user_id = ? GROUP BY game ORDER BY score DESC LIMIT 8'
      ).all(uid);

      let badges = [];
      try { badges = require('../achievements').listFor(db, uid); } catch { badges = []; }

      socket.emit('player-card', {
        userId: uid,
        tournaments: {
          entered,
          championships,
          matchWins: rec.w,
          matchLosses: rec.l,
          matchDraws: rec.d,
        },
        ladders: ladders.map(l => ({ name: l.name, rating: l.rating, rank: l.rank, total: l.total })),
        clips: { posted: clipsPosted, votes: clipVotes },
        arcade: arcade.map(a => ({ game: a.game, score: a.score })),
        achievements: badges,
        level: xp ? xp.getUserXp(uid) : null,
        games: db.prepare(`
          SELECT g.slug, g.name, g.icon FROM user_games ug JOIN games g ON g.id = ug.game_id
          WHERE ug.user_id = ? AND g.is_active = 1 ORDER BY g.name LIMIT 12
        `).all(uid),
        squads: db.prepare(`
          SELECT s.id, s.name, s.tag FROM squad_members sm JOIN squads s ON s.id = sm.squad_id
          WHERE sm.user_id = ? ORDER BY s.name LIMIT 8
        `).all(uid),
      });
    } catch (e) {
      // A stats panel must never break the profile popup.
      console.warn('[player-card] failed:', e.message);
    }
  });
};
