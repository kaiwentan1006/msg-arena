'use strict';

/**
 * MSG Arena — tournaments & ladders.
 *
 * Two formats over one set of tables (see database.js):
 *   single_elim — seeded bracket in tournaments.bracket_json (src/bracket.js).
 *   ladder      — ELO in tournament_participants.rating (src/elo.js).
 *
 * Results are TWO-PARTY CONFIRMED: one participant reports a winner, the other
 * confirms it before it counts. Someone with manage_tournaments can report-and-
 * confirm in one step (organiser override). A client-asserted result never
 * becomes standing without that second party — the deliberate line from the plan.
 *
 * Events (client → server):
 *   tourney:list                                    → tourney:list
 *   tourney:get      { id }                          → tourney:detail
 *   tourney:create   { name, gameId?, format, maxParticipants }   (manage_tournaments)
 *   tourney:join     { id }
 *   tourney:leave    { id }
 *   tourney:start    { id }                          (creator or manage_tournaments)
 *   tourney:delete   { id }                          (creator or manage_tournaments)
 *   tourney:report   { matchId, winnerId, score? }   (bracket match; a participant or manage)
 *   tourney:confirm  { matchId }                     (the other participant, or manage)
 *   tourney:dispute  { matchId }                     (clears a pending report)
 *   tourney:ladder-report { id, opponentId, winnerId, score? }    (creates a ladder match)
 *
 * Events (server → client):
 *   tourney:list     { tournaments }                 (to requester)
 *   tourney:detail   { tournament }                  (to requester)
 *   tourney:updated  { tournament }                  (broadcast — full detail)
 *   tourney:removed  { id }                          (broadcast)
 *   tourney:error    { message }                     (to requester)
 */

const elo = require('../elo');
const bracket = require('../bracket');
const achievements = require('../achievements');

const FORMATS = new Set(['single_elim', 'double_elim', 'ladder']);
const MAX_NAME = 80;
const MAX_PARTICIPANTS_CAP = 64;

function displayName(db, userId) {
  if (!userId) return null;
  const u = db.prepare('SELECT username, display_name FROM users WHERE id = ?').get(userId);
  return u ? (u.display_name || u.username) : 'Unknown';
}

function gameOf(db, gameId) {
  if (!gameId) return null;
  const g = db.prepare('SELECT slug, name, icon FROM games WHERE id = ?').get(gameId);
  return g ? { slug: g.slug, name: g.name, icon: g.icon || '🎮' } : null;
}

function participantsOf(db, tid, format) {
  const rows = db.prepare(
    'SELECT user_id, seed, rating, wins, losses, draws FROM tournament_participants WHERE tournament_id = ?'
  ).all(tid);
  const list = rows.map(r => ({
    id: r.user_id,
    name: displayName(db, r.user_id),
    seed: r.seed,
    rating: r.rating,
    wins: r.wins,
    losses: r.losses,
    draws: r.draws,
  }));
  // Ladder standings sort by rating; bracket by seed.
  if (format === 'ladder') list.sort((a, b) => b.rating - a.rating || b.wins - a.wins);
  else list.sort((a, b) => (a.seed || 0) - (b.seed || 0));
  return list;
}

function matchesOf(db, tid, segMap) {
  const rows = db.prepare(
    'SELECT * FROM tournament_matches WHERE tournament_id = ? ORDER BY round, id'
  ).all(tid);
  return rows.map(m => ({
    id: m.id,
    bracketMatchId: m.bracket_match_id,
    round: m.round,
    seg: segMap ? (segMap[m.bracket_match_id] || null) : null,  // 'W' | 'L' | 'GF' (double elim)
    aId: m.a_id,
    bId: m.b_id,
    aName: displayName(db, m.a_id),
    bName: displayName(db, m.b_id),
    winnerId: m.winner_id,
    score: m.score || '',
    reportedWinner: m.reported_winner,
    reportedBy: m.reported_by,
    status: m.status,
  }));
}

function buildDetail(db, id) {
  const t = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(id);
  if (!t) return null;
  let br = null;
  try { br = t.bracket_json ? JSON.parse(t.bracket_json) : null; } catch { br = null; }
  const segMap = br ? Object.fromEntries(br.matches.map(m => [m.id, m.bracket])) : null;
  return {
    id: t.id,
    name: t.name,
    game: gameOf(db, t.game_id),
    format: t.format,
    status: t.status,
    maxParticipants: t.max_participants,
    createdBy: t.created_by,
    createdByName: displayName(db, t.created_by),
    championId: t.champion_id,
    championName: displayName(db, t.champion_id),
    numRounds: br ? br.numRounds : null,
    participants: participantsOf(db, t.id, t.format),
    matches: matchesOf(db, t.id, segMap),
  };
}

function listSummaries(db) {
  const rows = db.prepare("SELECT id FROM tournaments ORDER BY (status = 'complete') ASC, created_at DESC LIMIT 100").all();
  return rows.map(r => {
    const t = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(r.id);
    const count = db.prepare('SELECT COUNT(*) n FROM tournament_participants WHERE tournament_id = ?').get(r.id).n;
    return {
      id: t.id, name: t.name, game: gameOf(db, t.game_id), format: t.format,
      status: t.status, participants: count, maxParticipants: t.max_participants,
      championId: t.champion_id, championName: displayName(db, t.champion_id),
    };
  });
}

module.exports = function register(socket, ctx) {
  const { db, io, userHasPermission, sendUserPush } = ctx;
  const broadcast = (event, payload) => io.except('bot-sockets').emit(event, payload);
  const me = () => socket.user;
  const canManage = () => me().isAdmin || userHasPermission(me().id, 'manage_tournaments');
  const err = (message) => socket.emit('tourney:error', { message });
  const pushDetail = (id) => { const d = buildDetail(db, id); if (d) broadcast('tourney:updated', { tournament: d }); };

  // Create a tournament_matches row for each bracket match that is ready to be
  // played (both participants known, no winner) and has no row yet. Called on
  // start and after every confirmed advance so the "playable now" set stays live.
  function syncBracketMatches(tid, br) {
    const existing = new Set(
      db.prepare('SELECT bracket_match_id FROM tournament_matches WHERE tournament_id = ? AND bracket_match_id IS NOT NULL').all(tid)
        .map(r => r.bracket_match_id)
    );
    const ins = db.prepare(
      'INSERT INTO tournament_matches (tournament_id, bracket_match_id, round, a_id, b_id, status) VALUES (?,?,?,?,?,?)'
    );
    for (const m of bracket.readyMatches(br)) {
      if (!existing.has(m.id)) ins.run(tid, m.id, m.round, m.aId, m.bId, 'pending');
    }
  }

  // Finalise a confirmed result. For single_elim, advance the bracket + roll new
  // matches; for ladder, apply ELO. `winnerId` may be null for a draw (ladder).
  function finalizeMatch(t, matchRow, winnerId, isDraw) {
    const now = new Date().toISOString();
    db.prepare(
      "UPDATE tournament_matches SET winner_id = ?, status = 'confirmed', confirmed_at = ? WHERE id = ?"
    ).run(winnerId, now, matchRow.id);
    // Both players' records just changed — re-check their badges after the DB
    // writes below settle.
    const awardBoth = () => {
      achievements.awardAndNotify(io, db, matchRow.a_id);
      achievements.awardAndNotify(io, db, matchRow.b_id);
    };

    if (t.format === 'ladder') {
      const pa = db.prepare('SELECT rating FROM tournament_participants WHERE tournament_id = ? AND user_id = ?').get(t.id, matchRow.a_id);
      const pb = db.prepare('SELECT rating FROM tournament_participants WHERE tournament_id = ? AND user_id = ?').get(t.id, matchRow.b_id);
      if (pa && pb) {
        const scoreA = isDraw ? 0.5 : (winnerId === matchRow.a_id ? 1 : 0);
        const res = elo.applyMatch(pa.rating, pb.rating, scoreA);
        db.prepare('UPDATE tournament_participants SET rating = ? WHERE tournament_id = ? AND user_id = ?').run(res.a, t.id, matchRow.a_id);
        db.prepare('UPDATE tournament_participants SET rating = ? WHERE tournament_id = ? AND user_id = ?').run(res.b, t.id, matchRow.b_id);
        if (isDraw) {
          db.prepare('UPDATE tournament_participants SET draws = draws + 1 WHERE tournament_id = ? AND user_id IN (?, ?)').run(t.id, matchRow.a_id, matchRow.b_id);
        } else {
          const loserId = winnerId === matchRow.a_id ? matchRow.b_id : matchRow.a_id;
          db.prepare('UPDATE tournament_participants SET wins = wins + 1 WHERE tournament_id = ? AND user_id = ?').run(t.id, winnerId);
          db.prepare('UPDATE tournament_participants SET losses = losses + 1 WHERE tournament_id = ? AND user_id = ?').run(t.id, loserId);
        }
      }
      awardBoth();
      return;
    }

    // single_elim: advance the bracket and materialise newly-ready matches.
    let br;
    try { br = JSON.parse(t.bracket_json); } catch { return; }
    try { bracket.reportWinner(br, matchRow.bracket_match_id, winnerId); } catch { /* already advanced */ }
    const loserId = winnerId === matchRow.a_id ? matchRow.b_id : matchRow.a_id;
    db.prepare('UPDATE tournament_participants SET wins = wins + 1 WHERE tournament_id = ? AND user_id = ?').run(t.id, winnerId);
    db.prepare('UPDATE tournament_participants SET losses = losses + 1 WHERE tournament_id = ? AND user_id = ?').run(t.id, loserId);
    db.prepare('UPDATE tournaments SET bracket_json = ? WHERE id = ?').run(JSON.stringify(br), t.id);
    syncBracketMatches(t.id, br);
    if (bracket.isComplete(br)) {
      db.prepare("UPDATE tournaments SET status = 'complete', champion_id = ?, completed_at = ? WHERE id = ?")
        .run(bracket.championId(br), now, t.id);
    }
    awardBoth();
  }

  // ── List / detail ───────────────────────────────────────
  socket.on('tourney:list', () => socket.emit('tourney:list', { tournaments: listSummaries(db) }));

  socket.on('tourney:get', (data) => {
    const id = data && Number.isInteger(data.id) ? data.id : null;
    if (!id) return err('Invalid tournament');
    const d = buildDetail(db, id);
    if (!d) return err('Tournament not found');
    socket.emit('tourney:detail', { tournament: d });
  });

  // ── Create ──────────────────────────────────────────────
  socket.on('tourney:create', (data) => {
    if (!canManage()) return err("You don't have permission to create tournaments");
    if (!data || typeof data !== 'object') return err('Invalid request');
    const name = typeof data.name === 'string' ? data.name.trim().slice(0, MAX_NAME) : '';
    if (!name) return err('A tournament name is required');
    const format = FORMATS.has(data.format) ? data.format : 'single_elim';
    let gameId = null;
    if (Number.isInteger(data.gameId)) {
      const g = db.prepare('SELECT id FROM games WHERE id = ?').get(data.gameId);
      if (g) gameId = g.id;
    }
    let maxP = Number.isInteger(data.maxParticipants) ? data.maxParticipants : 16;
    maxP = Math.max(2, Math.min(MAX_PARTICIPANTS_CAP, maxP));
    const info = db.prepare(
      'INSERT INTO tournaments (name, game_id, format, max_participants, created_by) VALUES (?,?,?,?,?)'
    ).run(name, gameId, format, maxP, me().id);
    broadcast('tourney:list', { tournaments: listSummaries(db) });
    pushDetail(info.lastInsertRowid);
  });

  // ── Join / leave (only while open) ──────────────────────
  socket.on('tourney:join', (data) => {
    const id = data && Number.isInteger(data.id) ? data.id : null;
    const t = id && db.prepare('SELECT * FROM tournaments WHERE id = ?').get(id);
    if (!t) return err('Tournament not found');
    if (t.status !== 'open') return err('This tournament is no longer open to join');
    const count = db.prepare('SELECT COUNT(*) n FROM tournament_participants WHERE tournament_id = ?').get(id).n;
    if (count >= t.max_participants) return err('This tournament is full');
    const already = db.prepare('SELECT 1 FROM tournament_participants WHERE tournament_id = ? AND user_id = ?').get(id, me().id);
    if (already) return err('You have already joined');
    db.prepare('INSERT INTO tournament_participants (tournament_id, user_id, rating) VALUES (?,?,?)').run(id, me().id, elo.DEFAULT_RATING);
    broadcast('tourney:list', { tournaments: listSummaries(db) });
    pushDetail(id);
  });

  socket.on('tourney:leave', (data) => {
    const id = data && Number.isInteger(data.id) ? data.id : null;
    const t = id && db.prepare('SELECT * FROM tournaments WHERE id = ?').get(id);
    if (!t) return err('Tournament not found');
    if (t.status !== 'open') return err('You cannot leave once the tournament has started');
    db.prepare('DELETE FROM tournament_participants WHERE tournament_id = ? AND user_id = ?').run(id, me().id);
    broadcast('tourney:list', { tournaments: listSummaries(db) });
    pushDetail(id);
  });

  // ── Start ───────────────────────────────────────────────
  socket.on('tourney:start', (data) => {
    const id = data && Number.isInteger(data.id) ? data.id : null;
    const t = id && db.prepare('SELECT * FROM tournaments WHERE id = ?').get(id);
    if (!t) return err('Tournament not found');
    if (!(canManage() || t.created_by === me().id)) return err("You can't start this tournament");
    if (t.status !== 'open') return err('Tournament already started');
    const parts = db.prepare('SELECT user_id FROM tournament_participants WHERE tournament_id = ? ORDER BY joined_at').all(id).map(r => r.user_id);
    if (parts.length < 2) return err('Need at least 2 participants to start');

    const now = new Date().toISOString();
    if (t.format === 'single_elim' || t.format === 'double_elim') {
      // Seed by join order.
      parts.forEach((uid, i) => db.prepare('UPDATE tournament_participants SET seed = ? WHERE tournament_id = ? AND user_id = ?').run(i + 1, id, uid));
      const br = t.format === 'double_elim' ? bracket.generateDoubleElim(parts) : bracket.generateSingleElim(parts);
      db.prepare("UPDATE tournaments SET status = 'live', bracket_json = ?, started_at = ? WHERE id = ?").run(JSON.stringify(br), now, id);
      syncBracketMatches(id, br);
    } else {
      db.prepare("UPDATE tournaments SET status = 'live', started_at = ? WHERE id = ?").run(now, id);
    }
    broadcast('tourney:list', { tournaments: listSummaries(db) });
    pushDetail(id);
  });

  // ── Delete ──────────────────────────────────────────────
  socket.on('tourney:delete', (data) => {
    const id = data && Number.isInteger(data.id) ? data.id : null;
    const t = id && db.prepare('SELECT * FROM tournaments WHERE id = ?').get(id);
    if (!t) return err('Tournament not found');
    if (!(canManage() || t.created_by === me().id)) return err("You can't delete this tournament");
    db.prepare('DELETE FROM tournaments WHERE id = ?').run(id); // cascades
    broadcast('tourney:removed', { id });
    broadcast('tourney:list', { tournaments: listSummaries(db) });
  });

  // ── Report a bracket match result ───────────────────────
  socket.on('tourney:report', (data) => {
    const matchId = data && Number.isInteger(data.matchId) ? data.matchId : null;
    const winnerId = data && Number.isInteger(data.winnerId) ? data.winnerId : null;
    const m = matchId && db.prepare('SELECT * FROM tournament_matches WHERE id = ?').get(matchId);
    if (!m) return err('Match not found');
    const t = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(m.tournament_id);
    if (!t || t.status !== 'live') return err('Tournament is not live');
    if (m.status === 'confirmed') return err('That match is already decided');
    if (m.a_id === null || m.b_id === null) return err('That match is not ready yet');
    const isParticipant = m.a_id === me().id || m.b_id === me().id;
    if (!isParticipant && !canManage()) return err("You're not in this match");
    if (winnerId !== m.a_id && winnerId !== m.b_id) return err('Winner must be one of the two players');
    const score = typeof data.score === 'string' ? data.score.trim().slice(0, 20) : null;

    // An organiser (or admin) reporting is authoritative — confirm immediately.
    if (canManage()) {
      db.prepare("UPDATE tournament_matches SET reported_winner = ?, reported_by = ?, score = ?, status = 'reported' WHERE id = ?")
        .run(winnerId, me().id, score, matchId);
      finalizeMatch(t, m, winnerId, false);
    } else {
      db.prepare("UPDATE tournament_matches SET reported_winner = ?, reported_by = ?, score = ?, status = 'reported' WHERE id = ?")
        .run(winnerId, me().id, score, matchId);
      // Nudge the opponent to confirm.
      const opponent = me().id === m.a_id ? m.b_id : m.a_id;
      sendUserPush([opponent], 'Confirm your match result',
        `${displayName(db, me().id)} reported a result in ${t.name}. Open MSG Arena to confirm.`, '/app');
    }
    pushDetail(t.id);
  });

  // ── Confirm a reported result ───────────────────────────
  socket.on('tourney:confirm', (data) => {
    const matchId = data && Number.isInteger(data.matchId) ? data.matchId : null;
    const m = matchId && db.prepare('SELECT * FROM tournament_matches WHERE id = ?').get(matchId);
    if (!m) return err('Match not found');
    if (m.status !== 'reported') return err('There is nothing to confirm');
    const t = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(m.tournament_id);
    if (!t) return err('Tournament not found');
    // The confirmer must be the OTHER participant (not the reporter), or manage.
    const isOtherParty = (me().id === m.a_id || me().id === m.b_id) && me().id !== m.reported_by;
    if (!isOtherParty && !canManage()) return err('Only the opponent can confirm this result');
    const isDraw = m.reported_winner === null;
    finalizeMatch(t, m, m.reported_winner, isDraw);
    pushDetail(t.id);
  });

  // ── Dispute (clear) a reported result ───────────────────
  socket.on('tourney:dispute', (data) => {
    const matchId = data && Number.isInteger(data.matchId) ? data.matchId : null;
    const m = matchId && db.prepare('SELECT * FROM tournament_matches WHERE id = ?').get(matchId);
    if (!m) return err('Match not found');
    if (m.status !== 'reported') return err('Nothing to dispute');
    const involved = me().id === m.a_id || me().id === m.b_id;
    if (!involved && !canManage()) return err("You're not in this match");
    db.prepare("UPDATE tournament_matches SET reported_winner = NULL, reported_by = NULL, score = NULL, status = 'pending' WHERE id = ?").run(matchId);
    pushDetail(m.tournament_id);
  });

  // ── Ladder: report a head-to-head (creates the match, pending confirm) ──
  socket.on('tourney:ladder-report', (data) => {
    const id = data && Number.isInteger(data.id) ? data.id : null;
    const opponentId = data && Number.isInteger(data.opponentId) ? data.opponentId : null;
    const t = id && db.prepare('SELECT * FROM tournaments WHERE id = ?').get(id);
    if (!t) return err('Tournament not found');
    if (t.format !== 'ladder') return err('Not a ladder');
    if (t.status !== 'live') return err('Ladder is not live');
    if (!opponentId || opponentId === me().id) return err('Pick a valid opponent');
    const inA = db.prepare('SELECT 1 FROM tournament_participants WHERE tournament_id = ? AND user_id = ?').get(id, me().id);
    const inB = db.prepare('SELECT 1 FROM tournament_participants WHERE tournament_id = ? AND user_id = ?').get(id, opponentId);
    if (!inA || !inB) return err('Both players must be in the ladder');
    // winnerId null => draw; otherwise must be one of the two.
    let winnerId = Number.isInteger(data.winnerId) ? data.winnerId : null;
    const isDraw = winnerId === null;
    if (!isDraw && winnerId !== me().id && winnerId !== opponentId) return err('Invalid winner');
    const score = typeof data.score === 'string' ? data.score.trim().slice(0, 20) : null;
    const info = db.prepare(
      "INSERT INTO tournament_matches (tournament_id, a_id, b_id, reported_winner, reported_by, score, status) VALUES (?,?,?,?,?,?, 'reported')"
    ).run(id, me().id, opponentId, winnerId, me().id, score);

    if (canManage()) {
      const m = db.prepare('SELECT * FROM tournament_matches WHERE id = ?').get(info.lastInsertRowid);
      finalizeMatch(t, m, winnerId, isDraw);
    } else {
      sendUserPush([opponentId], 'Confirm your ladder match',
        `${displayName(db, me().id)} reported a result in ${t.name}. Open MSG Arena to confirm.`, '/app');
    }
    pushDetail(id);
  });
};
