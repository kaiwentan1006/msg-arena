'use strict';

/**
 * MSG Arena — XP / leveling math (pure, no db/io so it's unit-testable).
 *
 * MEE6-style curve: the XP needed to advance FROM level `l` to `l+1` is
 *   xpToNext(l) = 5*l^2 + 50*l + 100
 * so higher levels cost progressively more. `totalXpForLevel(L)` is the
 * cumulative XP required to REACH level L. Cumulative thresholds are memoized.
 */

function xpToNext(level) {
  return 5 * level * level + 50 * level + 100;
}

const _cumulative = [0]; // _cumulative[L] = total XP to reach level L
function totalXpForLevel(level) {
  for (let l = _cumulative.length; l <= level; l++) {
    _cumulative[l] = _cumulative[l - 1] + xpToNext(l - 1);
  }
  return _cumulative[level];
}

function levelForXp(xp) {
  let level = 0;
  while (xp >= totalXpForLevel(level + 1)) level++;
  return level;
}

// UI-friendly breakdown of where a user sits within their current level.
function levelInfo(xp) {
  xp = Math.max(0, Math.floor(xp || 0));
  const level = levelForXp(xp);
  const base = totalXpForLevel(level);
  const next = totalXpForLevel(level + 1);
  const into = xp - base;
  const span = next - base;
  return { xp, level, into, span, pct: span > 0 ? Math.round((into / span) * 100) : 0, nextLevelXp: next };
}

module.exports = { xpToNext, totalXpForLevel, levelForXp, levelInfo };
