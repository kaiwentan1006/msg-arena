'use strict';

/**
 * MSG Arena — achievements / badges (progression).
 *
 * The catalog is pure data: each badge is a predicate over a user's aggregated
 * gaming stats. Awarding is "recompute on trigger" — after any gaming action we
 * recompute the user's stats and insert any newly-cleared badges (idempotent via
 * INSERT OR IGNORE), so there are no per-event deltas to get wrong.
 */

const CATALOG = [
  { key: 'first_clip',    name: 'First Clip',    icon: '🎬', desc: 'Posted your first clip',                 test: s => s.clipsPosted >= 1 },
  { key: 'clip_machine',  name: 'Clip Machine',  icon: '🎞️', desc: 'Posted 10 clips',                        test: s => s.clipsPosted >= 10 },
  { key: 'crowd_pleaser', name: 'Crowd Pleaser', icon: '📣', desc: 'Earned 25 up-votes on your clips',        test: s => s.clipVotes >= 25 },
  { key: 'first_blood',   name: 'First Blood',   icon: '⚔️', desc: 'Won your first tournament match',         test: s => s.matchWins >= 1 },
  { key: 'champion',      name: 'Champion',      icon: '🏆', desc: 'Won a tournament',                        test: s => s.championships >= 1 },
  { key: 'triple_crown',  name: 'Triple Crown',  icon: '👑', desc: 'Won 3 tournaments',                       test: s => s.championships >= 3 },
  { key: 'ranked_up',     name: 'Ranked Up',     icon: '📈', desc: 'Reached 1200 ELO on a ladder',            test: s => s.bestRating >= 1200 },
  { key: 'apex',          name: 'Apex Predator', icon: '🥇', desc: 'Reached #1 on a ladder (4+ players)',     test: s => s.ladderApex },
  { key: 'arcade_ace',    name: 'Arcade Ace',    icon: '🕹️', desc: 'Set an arcade high score',               test: s => s.arcadeScores >= 1 },
  { key: 'party_starter', name: 'Party Starter', icon: '🎯', desc: 'Started a Looking-For-Group party',       test: s => s.lfgPosts >= 1 },
];

const BY_KEY = new Map(CATALOG.map(a => [a.key, a]));
const _n = (v) => (v && typeof v.n === 'number') ? v.n : 0;

// Aggregate everything the predicates need. Each query is guarded so a missing
// table (older DB) degrades to zero rather than throwing.
function computeStats(db, userId) {
  const q = (sql, ...args) => { try { return db.prepare(sql).get(...args); } catch { return null; } };
  const clipsPosted = _n(q('SELECT COUNT(*) n FROM clips WHERE uploader_id = ?', userId));
  const clipVotes = _n(q('SELECT COUNT(*) n FROM clip_votes v JOIN clips c ON v.clip_id = c.id WHERE c.uploader_id = ?', userId));
  const matchWins = (() => { const r = q('SELECT COALESCE(SUM(wins),0) n FROM tournament_participants WHERE user_id = ?', userId); return _n(r); })();
  const championships = _n(q('SELECT COUNT(*) n FROM tournaments WHERE champion_id = ?', userId));
  const bestRating = (() => {
    const r = q("SELECT COALESCE(MAX(tp.rating),0) n FROM tournament_participants tp JOIN tournaments t ON t.id = tp.tournament_id WHERE tp.user_id = ? AND t.format = 'ladder'", userId);
    return _n(r);
  })();
  const arcadeScores = _n(q('SELECT COUNT(*) n FROM high_scores WHERE user_id = ? AND score > 0', userId));
  const lfgPosts = _n(q('SELECT COUNT(*) n FROM lfg_posts WHERE owner_id = ?', userId));
  // Apex: #1 on any ladder with 4+ participants.
  let ladderApex = false;
  try {
    const rows = db.prepare(
      "SELECT tp.tournament_id AS tid, tp.rating AS rating FROM tournament_participants tp JOIN tournaments t ON t.id = tp.tournament_id WHERE tp.user_id = ? AND t.format = 'ladder'"
    ).all(userId);
    for (const r of rows) {
      const total = _n(db.prepare('SELECT COUNT(*) n FROM tournament_participants WHERE tournament_id = ?').get(r.tid));
      if (total < 4) continue;
      const better = _n(db.prepare('SELECT COUNT(*) n FROM tournament_participants WHERE tournament_id = ? AND rating > ?').get(r.tid, r.rating));
      if (better === 0) { ladderApex = true; break; }
    }
  } catch { /* older DB */ }
  return { clipsPosted, clipVotes, matchWins, championships, bestRating, arcadeScores, lfgPosts, ladderApex };
}

// Insert any newly-earned badges; returns the definitions of the new ones.
function checkAndAward(db, userId) {
  if (!Number.isInteger(userId)) return [];
  const stats = computeStats(db, userId);
  const earned = new Set(db.prepare('SELECT key FROM achievements WHERE user_id = ?').all(userId).map(r => r.key));
  const ins = db.prepare('INSERT OR IGNORE INTO achievements (user_id, key) VALUES (?, ?)');
  const newly = [];
  for (const a of CATALOG) {
    if (!earned.has(a.key) && a.test(stats)) {
      const res = ins.run(userId, a.key);
      if (res.changes > 0) newly.push({ key: a.key, name: a.name, icon: a.icon, desc: a.desc });
    }
  }
  return newly;
}

// A user's earned badges, in catalog order, for display.
function listFor(db, userId) {
  let rows = [];
  try { rows = db.prepare('SELECT key, earned_at FROM achievements WHERE user_id = ?').all(userId); } catch { return []; }
  const at = new Map(rows.map(r => [r.key, r.earned_at]));
  return CATALOG.filter(a => at.has(a.key)).map(a => ({ key: a.key, name: a.name, icon: a.icon, desc: a.desc, earnedAt: at.get(a.key) }));
}

// Award + push a real-time toast to the user's live sockets.
function awardAndNotify(io, db, userId) {
  let newly = [];
  try { newly = checkAndAward(db, userId); } catch (e) { return []; }
  if (newly.length && io) {
    try {
      for (const [, s] of io.of('/').sockets) {
        if (s.user && s.user.id === userId) s.emit('achievement-earned', { achievements: newly });
      }
    } catch { /* emit best-effort */ }
  }
  return newly;
}

module.exports = { CATALOG, BY_KEY, computeStats, checkAndAward, listFor, awardAndNotify };
