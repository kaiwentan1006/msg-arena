'use strict';

/**
 * MSG Arena — ELO ratings (pure)
 *
 * No db, no io, no side effects — just the maths, so it is unit-testable on its
 * own. The ladder handler persists the numbers this returns; it does not
 * reimplement any of this.
 *
 * Convention: a match "score" is from A's point of view — 1 = A won,
 * 0.5 = draw, 0 = A lost. `applyMatch` returns both players' new ratings.
 */

const DEFAULT_RATING = 1000;
const DEFAULT_K = 32;

/** Expected score (win probability, 0..1) of `rating` against `opponentRating`. */
function expectedScore(rating, opponentRating) {
  return 1 / (1 + Math.pow(10, (opponentRating - rating) / 400));
}

/**
 * New rating for one player after a single game.
 * @param {number} rating         current rating
 * @param {number} opponentRating opponent's current rating
 * @param {number} score          1 win / 0.5 draw / 0 loss (this player's POV)
 * @param {number} [k]            K-factor (volatility)
 */
function newRating(rating, opponentRating, score, k = DEFAULT_K) {
  return Math.round(rating + k * (score - expectedScore(rating, opponentRating)));
}

/**
 * Apply a head-to-head result and return both new ratings.
 * @param {number} ratingA
 * @param {number} ratingB
 * @param {number} scoreA  1 = A wins, 0.5 = draw, 0 = B wins
 * @param {number} [k]
 * @returns {{a:number, b:number, deltaA:number, deltaB:number}}
 */
function applyMatch(ratingA, ratingB, scoreA, k = DEFAULT_K) {
  if (![0, 0.5, 1].includes(scoreA)) throw new Error('scoreA must be 0, 0.5, or 1');
  const a = newRating(ratingA, ratingB, scoreA, k);
  const b = newRating(ratingB, ratingA, 1 - scoreA, k);
  return { a, b, deltaA: a - ratingA, deltaB: b - ratingB };
}

module.exports = { DEFAULT_RATING, DEFAULT_K, expectedScore, newRating, applyMatch };
