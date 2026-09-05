'use strict';

/**
 * MSG Arena — tournament brackets (pure)
 *
 * No db, no io. Generates seeded single- AND double-elimination brackets (with
 * byes for non-power-of-two fields) and advances winners. This is exactly where
 * off-by-one and bye/loser-routing bugs corrupt a live tournament, so it lives
 * on its own and is unit-tested without a socket.
 *
 * Match shape (match.id === array index):
 *   { id, round, bracket, aId, bId, winnerId, feedsInto, loserTo, isReset }
 *   - bracket: 'W' winners | 'L' losers | 'GF' grand final (single-elim uses 'W')
 *   - aId/bId: a participant id (> 0), null (a slot still waiting on a feeder),
 *     or BYE (-1, a slot that resolved to "no player")
 *   - winnerId: null until decided
 *   - feedsInto: { matchId, slot:'a'|'b' } | null — where the WINNER goes
 *   - loserTo:   { matchId, slot:'a'|'b' } | null — where the LOSER goes
 *     (winners bracket + the 2-player grand final; single-elim leaves it null)
 */

const BYE = -1;
const _isPlayer = (v) => typeof v === 'number' && v > 0;

function nextPow2(n) { return 1 << Math.ceil(Math.log2(n)); }

/**
 * Standard tournament seed order for `size` slots (a power of two). Returns
 * seeds (1-based) in bracket-slot order so top seeds only meet in the final and
 * byes land opposite the highest seeds. e.g. size 4 -> [1,4,2,3].
 */
function seedOrder(size) {
  let order = [1, 2];
  while (order.length < size) {
    const sum = order.length * 2 + 1;
    const next = [];
    for (const s of order) { next.push(s); next.push(sum - s); }
    order = next;
  }
  return order;
}

// Put a value (id or BYE) into a match slot.
function _put(bracket, ref, value) {
  const nm = bracket.matches[ref.matchId];
  if (ref.slot === 'a') nm.aId = value; else nm.bId = value;
}

// Single-elim bye auto-advance: set a winner and push into the next slot.
function _setWinner(bracket, matchId, winnerId) {
  const m = bracket.matches[matchId];
  m.winnerId = winnerId;
  if (m.feedsInto) _put(bracket, m.feedsInto, winnerId);
}

/**
 * Build a seeded single-elimination bracket from participant ids in SEED ORDER
 * (participantIds[0] is the #1 seed). Byes are auto-resolved in round 0.
 */
function generateSingleElim(participantIds) {
  const n = participantIds.length;
  if (n < 2) throw new Error('need at least 2 participants');
  const size = nextPow2(n);
  const numRounds = Math.log2(size);
  const order = seedOrder(size);
  const matches = [];
  let id = 0;

  let prev = [];
  for (let i = 0; i < size; i += 2) {
    const sA = order[i], sB = order[i + 1];
    const aId = sA <= n ? participantIds[sA - 1] : null;
    const bId = sB <= n ? participantIds[sB - 1] : null;
    matches.push({ id, round: 0, bracket: 'W', aId, bId, winnerId: null, feedsInto: null, loserTo: null });
    prev.push(id); id++;
  }
  for (let r = 1; r < numRounds; r++) {
    const cur = [];
    for (let i = 0; i < prev.length; i += 2) {
      const mId = id++;
      matches.push({ id: mId, round: r, bracket: 'W', aId: null, bId: null, winnerId: null, feedsInto: null, loserTo: null });
      matches[prev[i]].feedsInto = { matchId: mId, slot: 'a' };
      matches[prev[i + 1]].feedsInto = { matchId: mId, slot: 'b' };
      cur.push(mId);
    }
    prev = cur;
  }

  const bracket = { type: 'single_elim', size, numRounds, matches };
  for (const m of matches) {
    if (m.round === 0 && m.winnerId === null) {
      if (m.aId !== null && m.bId === null) _setWinner(bracket, m.id, m.aId);
      else if (m.bId !== null && m.aId === null) _setWinner(bracket, m.id, m.bId);
    }
  }
  return bracket;
}

/**
 * Build a seeded DOUBLE-elimination bracket. Losers of the winners bracket (WB)
 * drop into the losers bracket (LB); a second loss eliminates. The LB champion
 * meets the WB champion in the grand final, with a bracket reset if the LB
 * champion wins (the WB champion had not yet lost).
 */
function generateDoubleElim(participantIds) {
  const n = participantIds.length;
  if (n < 2) throw new Error('need at least 2 participants');
  const size = nextPow2(n);
  const numRounds = Math.log2(size);   // WB rounds
  const order = seedOrder(size);
  const matches = [];
  let id = 0;
  const add = (br, round) => { const m = { id, round, bracket: br, aId: null, bId: null, winnerId: null, feedsInto: null, loserTo: null }; matches.push(m); return id++; };
  const wire = (ref, matchId, slot) => {
    const src = matches[ref.id];
    if (ref.which === 'W') src.feedsInto = { matchId, slot };
    else src.loserTo = { matchId, slot };
  };

  // ── Winners bracket (single-elim shape) ──
  const wb = [];
  let prev = [];
  for (let i = 0; i < size; i += 2) {
    const mId = add('W', 0);
    const sA = order[i], sB = order[i + 1];
    matches[mId].aId = sA <= n ? participantIds[sA - 1] : BYE;
    matches[mId].bId = sB <= n ? participantIds[sB - 1] : BYE;
    prev.push(mId);
  }
  wb.push(prev);
  for (let r = 1; r < numRounds; r++) {
    const cur = [];
    for (let i = 0; i < prev.length; i += 2) {
      const mId = add('W', r);
      matches[prev[i]].feedsInto = { matchId: mId, slot: 'a' };
      matches[prev[i + 1]].feedsInto = { matchId: mId, slot: 'b' };
      cur.push(mId);
    }
    wb.push(cur);
    prev = cur;
  }
  const wbFinalId = wb[numRounds - 1][0];

  // ── Losers bracket ──
  const pairInto = (producers, round) => {
    const winners = [];
    for (let i = 0; i < producers.length; i += 2) {
      const mId = add('L', round);
      wire(producers[i], mId, 'a');
      wire(producers[i + 1], mId, 'b');
      winners.push({ id: mId, which: 'W' });
    }
    return winners;
  };

  let lbFinalRef;
  if (numRounds === 1) {
    // 2 players: no LB matches; the WB final loser is the "LB champion".
    lbFinalRef = { id: wbFinalId, which: 'L' };
  } else {
    let lbRound = 0;
    let prevWinners = pairInto(wb[0].map(mid => ({ id: mid, which: 'L' })), lbRound++); // L0: WB r0 losers
    for (let r = 1; r < numRounds; r++) {
      // Major round: each previous LB winner meets a fresh WB-round-r loser.
      const major = [];
      for (let j = 0; j < prevWinners.length; j++) {
        const mId = add('L', lbRound);
        wire(prevWinners[j], mId, 'a');
        wire({ id: wb[r][j], which: 'L' }, mId, 'b');
        major.push({ id: mId, which: 'W' });
      }
      lbRound++;
      prevWinners = major;
      if (prevWinners.length > 1) prevWinners = pairInto(prevWinners, lbRound++); // minor round
    }
    lbFinalRef = prevWinners[0];
  }

  // ── Grand final (+ reset) ──
  const gfId = add('GF', numRounds);
  matches[wbFinalId].feedsInto = { matchId: gfId, slot: 'a' };
  wire(lbFinalRef, gfId, 'b');
  const resetId = add('GF', numRounds + 1);
  matches[resetId].isReset = true;

  const bracket = { type: 'double_elim', size, numRounds, matches, wbFinalId, lbFinalId: numRounds === 1 ? null : lbFinalRef.id, grandFinalId: gfId, resetId };
  _resolveByes(bracket);
  return bracket;
}

// Cascade byes to a fixpoint. A match with at least one BYE slot (and the other
// slot settled) resolves without being played; a real-vs-real match does not.
function _resolveByes(bracket) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const m of bracket.matches) {
      if (m.winnerId !== null || m.bye || m._skipped) continue;
      if (m.bracket === 'GF') continue; // the grand final is decided only by reportWinner
      const aSettled = _isPlayer(m.aId) || m.aId === BYE;
      const bSettled = _isPlayer(m.bId) || m.bId === BYE;
      if (!aSettled || !bSettled) continue;
      const aReal = _isPlayer(m.aId), bReal = _isPlayer(m.bId);
      if (aReal && bReal) continue; // a real match — must be played
      let winner = null;
      if (aReal) winner = m.aId;
      else if (bReal) winner = m.bId;
      else m.bye = true; // both byes: this match produces no one
      if (winner !== null) m.winnerId = winner;
      if (m.feedsInto) _put(bracket, m.feedsInto, winner !== null ? winner : BYE);
      if (m.loserTo) _put(bracket, m.loserTo, BYE); // a bye match never sends a real loser
      changed = true;
    }
  }
}

/** The final match of a single-elim bracket (feeds into nothing). */
function finalMatch(bracket) {
  return bracket.matches.find(m => m.bracket !== 'GF' && m.feedsInto === null) || null;
}

/** Matches playable now: both slots are real players, no winner, not skipped. */
function readyMatches(bracket) {
  return bracket.matches.filter(m => _isPlayer(m.aId) && _isPlayer(m.bId) && m.winnerId === null && !m._skipped);
}

function isComplete(bracket) {
  if (bracket.type === 'double_elim') {
    const gf = bracket.matches[bracket.grandFinalId];
    if (gf.winnerId === null) return false;
    if (gf.winnerId === gf.aId) return true;             // WB champion won outright
    return bracket.matches[bracket.resetId].winnerId !== null; // reset decided
  }
  const f = finalMatch(bracket);
  return !!(f && f.winnerId !== null);
}

function championId(bracket) {
  if (bracket.type === 'double_elim') {
    const gf = bracket.matches[bracket.grandFinalId];
    if (gf.winnerId === null) return null;
    if (gf.winnerId === gf.aId) return gf.aId;
    return bracket.matches[bracket.resetId].winnerId;
  }
  const f = finalMatch(bracket);
  return f ? f.winnerId : null;
}

/**
 * Record the winner of a match and advance them (and, in double elim, drop the
 * loser). Validates the match is ready and the winner played in it. Mutates and
 * returns the bracket.
 */
function reportWinner(bracket, matchId, winnerId) {
  const m = bracket.matches[matchId];
  if (!m) throw new Error('no such match');
  if (m.winnerId !== null) throw new Error('match already decided');
  if (!_isPlayer(m.aId) || !_isPlayer(m.bId)) throw new Error('match is not ready (a feeder is unresolved)');
  if (winnerId !== m.aId && winnerId !== m.bId) throw new Error('winner did not play in this match');
  const loserId = winnerId === m.aId ? m.bId : m.aId;
  m.winnerId = winnerId;
  if (m.feedsInto) _put(bracket, m.feedsInto, winnerId);
  if (m.loserTo) _put(bracket, m.loserTo, loserId);

  if (bracket.type === 'double_elim' && matchId === bracket.grandFinalId) {
    const reset = bracket.matches[bracket.resetId];
    if (winnerId === m.aId) reset._skipped = true;      // WB champion won → no reset
    else { reset.aId = m.bId; reset.bId = m.aId; }       // LB champion won → reset is played
  }
  // A WB loser dropping into a losers-bracket slot whose partner was a bye
  // creates a fresh "real vs bye" match that must auto-advance — so re-run the
  // bye cascade after every double-elim result.
  if (bracket.type === 'double_elim') _resolveByes(bracket);
  return bracket;
}

module.exports = {
  BYE, nextPow2, seedOrder,
  generateSingleElim, generateDoubleElim,
  finalMatch, readyMatches, isComplete, championId, reportWinner,
};
