'use strict';

// Pure unit tests for the ELO + single-elimination bracket maths. No server,
// no db — these are the parts where bugs silently corrupt a live tournament.

const assert = require('node:assert/strict');
const test = require('node:test');
const elo = require('../src/elo');
const bracket = require('../src/bracket');

test('elo: equal ratings → 0.5 expected, symmetric swing', () => {
  assert.equal(elo.expectedScore(1000, 1000), 0.5);
  const r = elo.applyMatch(1000, 1000, 1); // A wins
  assert.equal(r.a, 1016); // 1000 + 32*(1-0.5)
  assert.equal(r.b, 984);
  assert.equal(r.a - 1000, -(r.b - 1000)); // zero-sum for equal ratings
});

test('elo: beating a higher-rated player gains more than beating a peer', () => {
  const underdog = elo.applyMatch(1000, 1400, 1); // 1000 beats 1400
  const peer = elo.applyMatch(1000, 1000, 1);
  assert.ok(underdog.deltaA > peer.deltaA, 'upset win worth more');
  // and the favourite losing drops a lot
  assert.ok(underdog.deltaB < 0 && Math.abs(underdog.deltaB) > Math.abs(peer.deltaB));
});

test('elo: draw nudges toward the mean and rejects bad scores', () => {
  const d = elo.applyMatch(1000, 1400, 0.5); // lower-rated draws the favourite → gains
  assert.ok(d.deltaA > 0 && d.deltaB < 0);
  assert.throws(() => elo.applyMatch(1000, 1000, 0.7), /scoreA/);
});

test('bracket: seedOrder is standard (1 and 2 only meet in the final)', () => {
  assert.deepEqual(bracket.seedOrder(2), [1, 2]);
  assert.deepEqual(bracket.seedOrder(4), [1, 4, 2, 3]);
  assert.deepEqual(bracket.seedOrder(8), [1, 8, 4, 5, 2, 7, 3, 6]);
});

test('bracket: power-of-two field has no byes and a clean depth', () => {
  const b = bracket.generateSingleElim([10, 20, 30, 40]); // seeds 1..4
  assert.equal(b.size, 4);
  assert.equal(b.numRounds, 2);
  assert.equal(b.matches.length, 3); // 2 semis + 1 final
  const r0 = b.matches.filter(m => m.round === 0);
  // #1(10) vs #4(40), #2(20) vs #3(30)
  assert.deepEqual([r0[0].aId, r0[0].bId], [10, 40]);
  assert.deepEqual([r0[1].aId, r0[1].bId], [20, 30]);
  assert.equal(bracket.readyMatches(b).length, 2);
  assert.equal(bracket.isComplete(b), false);
});

test('bracket: non-power-of-two auto-advances byes for the top seeds', () => {
  const b = bracket.generateSingleElim([1, 2, 3]); // size 4, seed 4 is a bye
  // seedOrder(4)=[1,4,2,3] → matches (1 vs bye)(2 vs 3)
  const m0 = b.matches[0];
  assert.equal(m0.winnerId, 1, 'top seed auto-advances past the bye');
  // The final's slot 'a' is already filled by that bye winner.
  const fin = bracket.finalMatch(b);
  assert.equal(fin.aId, 1);
  assert.equal(fin.bId, null, 'other finalist still to be decided');
  // Only the real 2v3 match is playable right now.
  const ready = bracket.readyMatches(b);
  assert.equal(ready.length, 1);
  assert.deepEqual([ready[0].aId, ready[0].bId], [2, 3]);
});

test('bracket: full run of a 4-player bracket crowns the reported winner', () => {
  const b = bracket.generateSingleElim([10, 20, 30, 40]);
  bracket.reportWinner(b, 0, 10); // 10 beats 40
  bracket.reportWinner(b, 1, 30); // 30 upsets 20
  assert.equal(bracket.isComplete(b), false);
  const fin = bracket.finalMatch(b);
  assert.deepEqual([fin.aId, fin.bId], [10, 30], 'winners advanced into the final');
  bracket.reportWinner(b, fin.id, 30);
  assert.equal(bracket.isComplete(b), true);
  assert.equal(bracket.championId(b), 30);
});

test('bracket: guards against invalid reports', () => {
  const b = bracket.generateSingleElim([10, 20, 30, 40]);
  // Can't report a winner who did not play in the match.
  assert.throws(() => bracket.reportWinner(b, 0, 20), /did not play/);
  // Can't report the final before its feeders resolve.
  const fin = bracket.finalMatch(b);
  assert.throws(() => bracket.reportWinner(b, fin.id, 10), /not ready/);
  // Can't re-decide a settled match.
  bracket.reportWinner(b, 0, 10);
  assert.throws(() => bracket.reportWinner(b, 0, 40), /already decided/);
});

test('bracket: 16 players → 4 rounds, single champion after a full playout', () => {
  const ids = Array.from({ length: 16 }, (_, i) => (i + 1) * 100);
  const b = bracket.generateSingleElim(ids);
  assert.equal(b.numRounds, 4);
  assert.equal(b.matches.length, 15);
  // Always let the higher-seeded (lower id order → earlier in list = better seed) win:
  // simplest deterministic playout — the 'a' side always wins each ready match.
  let guard = 0;
  while (!bracket.isComplete(b) && guard++ < 100) {
    for (const m of bracket.readyMatches(b)) bracket.reportWinner(b, m.id, m.aId);
  }
  assert.equal(bracket.isComplete(b), true);
  assert.equal(bracket.championId(b), 100, '#1 seed wins if it always wins');
});

// ── Double elimination ──
function deFind(b, x, y) {
  return b.matches.find(m => m.winnerId === null && ((m.aId === x && m.bId === y) || (m.aId === y && m.bId === x)));
}

test('double elim: 4- and 8-player match counts', () => {
  const b4 = bracket.generateDoubleElim([10, 20, 30, 40]);
  assert.equal(b4.matches.length, 7);  // WB 3 + LB 2 + GF 1 + reset 1
  const b8 = bracket.generateDoubleElim(Array.from({ length: 8 }, (_, i) => (i + 1) * 10));
  assert.equal(b8.matches.length, 15); // WB 7 + LB 6 + GF 1 + reset 1
});

test('double elim: WB champion winning the grand final ends it with no reset', () => {
  const b = bracket.generateDoubleElim([10, 20, 30, 40]);
  let guard = 0;
  while (!bracket.isComplete(b) && guard++ < 200) {
    const ready = bracket.readyMatches(b);
    if (!ready.length) break;
    for (const m of ready) bracket.reportWinner(b, m.id, m.aId); // slot-a always wins
  }
  assert.equal(bracket.isComplete(b), true);
  assert.equal(bracket.championId(b), 10, 'top seed wins outright');
  assert.equal(b.matches[b.resetId]._skipped, true, 'the reset was never needed');
});

test('double elim: LB champion winning the grand final forces (and decides) a reset', () => {
  const b = bracket.generateDoubleElim([10, 20, 30, 40]);
  let guard = 0;
  while (!bracket.isComplete(b) && guard++ < 200) {
    // Don't auto-play the reset — we want to inspect the state after GF game 1.
    const ready = bracket.readyMatches(b).filter(m => m.id !== b.resetId);
    if (!ready.length) break;
    for (const m of ready) {
      if (m.id === b.grandFinalId) bracket.reportWinner(b, m.id, m.bId); // LB champ upsets
      else bracket.reportWinner(b, m.id, m.aId);
    }
  }
  assert.equal(bracket.isComplete(b), false, 'not over — a reset is required');
  const reset = b.matches[b.resetId];
  assert.ok(reset.aId > 0 && reset.bId > 0, 'reset is populated with both finalists');
  assert.ok(bracket.readyMatches(b).some(m => m.id === b.resetId), 'reset is playable');
  bracket.reportWinner(b, b.resetId, reset.aId);
  assert.equal(bracket.isComplete(b), true);
  assert.equal(bracket.championId(b), reset.aId);
});

test('double elim: a player who loses early can still win through the losers bracket', () => {
  const b = bracket.generateDoubleElim([10, 20, 30, 40]);
  bracket.reportWinner(b, deFind(b, 10, 40).id, 10); // 40 loses its opener
  bracket.reportWinner(b, deFind(b, 20, 30).id, 20);
  bracket.reportWinner(b, deFind(b, 10, 20).id, 10); // 10 takes the WB
  bracket.reportWinner(b, deFind(b, 40, 30).id, 40); // 40 climbs the LB
  bracket.reportWinner(b, deFind(b, 40, 20).id, 40);
  bracket.reportWinner(b, deFind(b, 10, 40).id, 40); // 40 wins GF game 1 → reset
  bracket.reportWinner(b, deFind(b, 40, 10).id, 40); // 40 wins the reset
  assert.equal(bracket.isComplete(b), true);
  assert.equal(bracket.championId(b), 40, 'a one-loss run to the title');
});

test('double elim: byes (3, 5, 6 players) still crown exactly one real champion', () => {
  for (const n of [3, 5, 6]) {
    const ids = Array.from({ length: n }, (_, i) => (i + 1) * 100);
    const b = bracket.generateDoubleElim(ids);
    let guard = 0;
    while (!bracket.isComplete(b) && guard++ < 400) {
      const ready = bracket.readyMatches(b);
      if (!ready.length) break;
      for (const m of ready) bracket.reportWinner(b, m.id, m.aId);
    }
    assert.equal(bracket.isComplete(b), true, `n=${n} completes`);
    assert.ok(ids.includes(bracket.championId(b)), `n=${n} champion is a real player`);
  }
});
