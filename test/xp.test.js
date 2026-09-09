'use strict';
const test = require('node:test');
const assert = require('node:assert');
const xp = require('../src/xp');

test('xpToNext follows the MEE6 curve', () => {
  assert.strictEqual(xp.xpToNext(0), 100);
  assert.strictEqual(xp.xpToNext(1), 155);
  assert.strictEqual(xp.xpToNext(2), 220);
});

test('totalXpForLevel is cumulative', () => {
  assert.strictEqual(xp.totalXpForLevel(0), 0);
  assert.strictEqual(xp.totalXpForLevel(1), 100);
  assert.strictEqual(xp.totalXpForLevel(2), 255);
  assert.strictEqual(xp.totalXpForLevel(3), 475);
});

test('levelForXp maps xp to the right level (boundaries)', () => {
  assert.strictEqual(xp.levelForXp(0), 0);
  assert.strictEqual(xp.levelForXp(99), 0);
  assert.strictEqual(xp.levelForXp(100), 1);
  assert.strictEqual(xp.levelForXp(254), 1);
  assert.strictEqual(xp.levelForXp(255), 2);
});

test('levelInfo gives progress within the level', () => {
  const i = xp.levelInfo(150);
  assert.strictEqual(i.level, 1);
  assert.strictEqual(i.into, 50);      // 150 - 100
  assert.strictEqual(i.span, 155);     // 255 - 100
  assert.ok(i.pct > 0 && i.pct < 100);
});

test('handles junk input safely', () => {
  assert.strictEqual(xp.levelInfo(-5).level, 0);
  assert.strictEqual(xp.levelInfo(undefined).level, 0);
});
