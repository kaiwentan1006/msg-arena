// Engagement layer on top of XP: level role rewards + daily streaks.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const createXpService = require('../src/xpService');
const { totalXpForLevel } = require('../src/xp');

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE roles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, color TEXT, icon TEXT);
    CREATE TABLE user_roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL, role_id INTEGER NOT NULL,
      channel_id INTEGER DEFAULT NULL,
      UNIQUE (user_id, role_id, channel_id)
    );
    CREATE TABLE user_xp (
      user_id INTEGER PRIMARY KEY, xp INTEGER NOT NULL DEFAULT 0, level INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER, last_active_day TEXT DEFAULT NULL,
      streak INTEGER NOT NULL DEFAULT 0, longest_streak INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE level_roles (level INTEGER PRIMARY KEY, role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE);
  `);
  return db;
}
const hasRole = (db, uid, rid) => !!db.prepare('SELECT 1 FROM user_roles WHERE user_id=? AND role_id=? AND channel_id IS NULL').get(uid, rid);

test('level role reward: crossing the configured level auto-grants the role, once', () => {
  const db = freshDb();
  const roleId = db.prepare("INSERT INTO roles (name,color) VALUES ('Regular','#22d3ee')").run().lastInsertRowid;
  const xp = createXpService(db, { voiceXp: 10 });
  assert.equal(xp.setLevelRole(2, roleId), true);

  // Seed the user just below level 2, then push them over with an award.
  db.prepare('INSERT INTO user_xp (user_id, xp, level) VALUES (?,?,?)').run(1, totalXpForLevel(2) - 5, 1);
  assert.equal(hasRole(db, 1, roleId), false);

  const r = xp.awardVoice(1);
  assert.equal(r.level, 2, 'reached level 2');
  assert.equal(r.leveledUp, true);
  assert.equal(r.rewardedRoles.length, 1, 'one role rewarded');
  assert.equal(r.rewardedRoles[0].id, roleId);
  assert.equal(hasRole(db, 1, roleId), true, 'role now in user_roles');

  // Further awards at the same level must NOT re-grant / re-announce.
  const r2 = xp.awardVoice(1);
  assert.equal(r2.leveledUp, false);
  assert.equal(r2.rewardedRoles.length, 0);
});

test('level role reward: does not grant before the level is reached', () => {
  const db = freshDb();
  const roleId = db.prepare("INSERT INTO roles (name) VALUES ('Veteran')").run().lastInsertRowid;
  const xp = createXpService(db, { voiceXp: 10 });
  xp.setLevelRole(5, roleId);
  db.prepare('INSERT INTO user_xp (user_id, xp, level) VALUES (?,?,?)').run(2, 0, 0);
  xp.awardVoice(2); // level 0 -> maybe 1, nowhere near 5
  assert.equal(hasRole(db, 2, roleId), false);
});

test('level role reward: mapping to a deleted role is skipped, not fatal', () => {
  const db = freshDb();
  const roleId = db.prepare("INSERT INTO roles (name) VALUES ('Ghost')").run().lastInsertRowid;
  const xp = createXpService(db);
  xp.setLevelRole(2, roleId);
  db.prepare('DELETE FROM roles WHERE id=?').run(roleId); // cascade clears level_roles too
  db.prepare('INSERT INTO user_xp (user_id, xp, level) VALUES (?,?,?)').run(3, totalXpForLevel(2) - 2, 1);
  assert.doesNotThrow(() => xp.awardVoice(3));
});

test('setLevelRole rejects a non-existent role and bad levels', () => {
  const db = freshDb();
  const xp = createXpService(db);
  assert.equal(xp.setLevelRole(2, 999), false);
  const rid = db.prepare("INSERT INTO roles (name) VALUES ('R')").run().lastInsertRowid;
  assert.equal(xp.setLevelRole(0, rid), false);
  assert.equal(xp.setLevelRole(2, rid), true);
  assert.equal(xp.listLevelRoles().length, 1);
});

test('daily streak: increments across consecutive days, resets after a gap', () => {
  const db = freshDb();
  const realNow = Date.now;
  let nowMs = Date.parse('2026-03-01T10:00:00Z');
  global.Date.now = () => nowMs;
  try {
    const xp = createXpService(db, { messageCooldownMs: 60000, streakBonusPerDay: 20, streakBonusMaxDays: 7 });

    // Day 1 — first message: streak 1, bonus 20.
    let r = xp.awardMessage(1);
    assert.equal(r.streak, 1);
    assert.equal(r.streakBonus, 20);
    assert.equal(r.newDay, true);

    // Same day, after cooldown: no new day, no bonus.
    nowMs += 2 * 60000;
    r = xp.awardMessage(1);
    assert.equal(r.newDay, false);
    assert.equal(r.streakBonus, 0);

    // Next day: streak 2, bonus 40.
    nowMs = Date.parse('2026-03-02T09:00:00Z');
    r = xp.awardMessage(1);
    assert.equal(r.streak, 2);
    assert.equal(r.streakBonus, 40);

    // Day 3: streak 3.
    nowMs = Date.parse('2026-03-03T09:00:00Z');
    r = xp.awardMessage(1);
    assert.equal(r.streak, 3);

    // Skip day 4, return day 5: streak resets to 1.
    nowMs = Date.parse('2026-03-05T09:00:00Z');
    r = xp.awardMessage(1);
    assert.equal(r.streak, 1);
    assert.equal(r.streakBonus, 20);

    // getUserXp surfaces streak + longest (peaked at 3).
    const info = xp.getUserXp(1);
    assert.equal(info.streak, 1);
    assert.equal(info.longestStreak, 3);
  } finally {
    global.Date.now = realNow;
  }
});

test('streak bonus is capped at streakBonusMaxDays', () => {
  const db = freshDb();
  const realNow = Date.now;
  let day = Date.parse('2026-04-01T10:00:00Z');
  global.Date.now = () => day;
  try {
    const xp = createXpService(db, { streakBonusPerDay: 10, streakBonusMaxDays: 3 });
    let last;
    for (let i = 0; i < 6; i++) { last = xp.awardMessage(1); day += 86400000; }
    assert.equal(last.streak, 6);
    assert.equal(last.streakBonus, 30, 'capped at 3 * 10 even at a 6-day streak');
  } finally { global.Date.now = realNow; }
});
