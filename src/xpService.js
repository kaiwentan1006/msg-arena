'use strict';
const { levelInfo, totalXpForLevel } = require('./xp');

/**
 * createXpService(db) — server-authoritative XP + the engagement layer that
 * makes leveling actually retain gamers (from the leveling-bot research):
 *   • Level role rewards — cross a configured level, auto-earn a role.
 *   • Daily streaks — a bonus for returning day after day.
 * Awards are never client-asserted (the "scores must be server-derived" rule).
 * A per-user in-memory cooldown keeps the hot message path cheap. Callers hold
 * the socket, so they emit level-up / streak / role events themselves.
 */
module.exports = function createXpService(db, opts = {}) {
  const cooldownMs = opts.messageCooldownMs ?? 60000;
  const msgMin = opts.msgMin ?? 15;
  const msgMax = opts.msgMax ?? 25;
  const voiceXp = opts.voiceXp ?? 10;
  const referralXp = opts.referralXp ?? 100; // reward per friend recruited via your invite links
  // Streak bonus: escalates with the streak, capped so it stays a nudge not a
  // shortcut. Day-1 gives 1×, day-7+ gives 7× the per-day bonus.
  const streakBonusPerDay = opts.streakBonusPerDay ?? 20;
  const streakBonusMaxDays = opts.streakBonusMaxDays ?? 7;
  // Injectable clock (tests); returns a UTC 'YYYY-MM-DD' day string.
  const dayOf = opts.dayOf ?? ((ts = Date.now()) => new Date(ts).toISOString().slice(0, 10));

  const _cooldown = new Map(); // userId -> last message-award ts

  const getRow    = db.prepare('SELECT xp, level, last_active_day, streak, longest_streak FROM user_xp WHERE user_id = ?');
  const insertRow = db.prepare('INSERT INTO user_xp (user_id, xp, level, updated_at) VALUES (?, ?, ?, ?)');
  const updateRow = db.prepare('UPDATE user_xp SET xp = ?, level = ?, updated_at = ? WHERE user_id = ?');
  const setStreak = db.prepare('UPDATE user_xp SET last_active_day = ?, streak = ?, longest_streak = ? WHERE user_id = ?');

  const lrForRange = db.prepare('SELECT level, role_id FROM level_roles WHERE level > ? AND level <= ? ORDER BY level');
  const roleInfo   = db.prepare('SELECT id, name, color, icon FROM roles WHERE id = ?');
  const grantRole  = db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id, channel_id) VALUES (?, ?, NULL)');

  // Grant any level-reward roles for levels newly crossed in (prevLevel, newLevel].
  // Returns the roles actually newly granted (skips ones the user already had or
  // whose role row no longer exists), so the caller can announce + refresh badges.
  function _grantLevelRoles(userId, prevLevel, newLevel) {
    if (newLevel <= prevLevel) return [];
    const granted = [];
    for (const lr of lrForRange.all(prevLevel, newLevel)) {
      const role = roleInfo.get(lr.role_id);
      if (!role) continue; // mapping points at a deleted role — skip, don't FK-crash
      const res = grantRole.run(userId, lr.role_id);
      if (res.changes > 0) granted.push({ id: role.id, name: role.name, color: role.color, icon: role.icon, level: lr.level });
    }
    return granted;
  }

  function _award(userId, amount) {
    const row = getRow.get(userId);
    const prevXp = row ? row.xp : 0;
    const prevLevel = row ? row.level : 0;
    const newXp = prevXp + amount;
    let newLevel = prevLevel;
    while (newXp >= totalXpForLevel(newLevel + 1)) newLevel++;
    const now = Date.now();
    if (row) updateRow.run(newXp, newLevel, now, userId);
    else insertRow.run(userId, newXp, newLevel, now);
    const leveledUp = newLevel > prevLevel;
    const rewardedRoles = leveledUp ? _grantLevelRoles(userId, prevLevel, newLevel) : [];
    return { xp: newXp, level: newLevel, leveledUp, rewardedRoles };
  }

  // Update the daily streak on the first activity of a new day. Returns the
  // streak state + any bonus XP to award (the caller folds it into the total).
  function _tickStreak(userId, nowTs) {
    const row = getRow.get(userId) || {};
    const today = dayOf(nowTs);
    if (row.last_active_day === today) {
      return { streak: row.streak || 0, longest: row.longest_streak || 0, newDay: false, bonusXp: 0 };
    }
    const yesterday = dayOf(nowTs - 86400000);
    const streak = (row.last_active_day === yesterday) ? (row.streak || 0) + 1 : 1;
    const longest = Math.max(streak, row.longest_streak || 0);
    setStreak.run(today, streak, longest, userId);
    const bonusXp = streakBonusPerDay * Math.min(streak, streakBonusMaxDays);
    return { streak, longest, newDay: true, bonusXp };
  }

  return {
    // Chat message award (per-user cooldown). Returns null if on cooldown or the
    // sender isn't a real user. On the first award of a new day it also advances
    // the streak and folds the streak bonus into the total.
    awardMessage(userId) {
      if (!Number.isInteger(userId) || userId <= 0) return null;
      const now = Date.now();
      if (now - (_cooldown.get(userId) || 0) < cooldownMs) return null;
      _cooldown.set(userId, now);
      const amount = msgMin + Math.floor(Math.random() * (msgMax - msgMin + 1));
      const res = _award(userId, amount);           // ensures the row exists first
      const s = _tickStreak(userId, now);
      if (s.bonusXp > 0) {
        const bonus = _award(userId, s.bonusXp);
        res.xp = bonus.xp;
        res.level = bonus.level;
        res.leveledUp = res.leveledUp || bonus.leveledUp;
        if (bonus.rewardedRoles.length) res.rewardedRoles = res.rewardedRoles.concat(bonus.rewardedRoles);
      }
      res.streak = s.streak;
      res.streakBonus = s.bonusXp;
      res.newDay = s.newDay;
      return res;
    },
    // One minute of voice activity (no streak — streaks are message-driven).
    awardVoice(userId) {
      if (!Number.isInteger(userId) || userId <= 0) return null;
      return _award(userId, voiceXp);
    },
    // Reward the inviter for `count` newly-recruited members (referral rank).
    awardReferral(userId, count) {
      if (!Number.isInteger(userId) || userId <= 0 || !(count > 0)) return null;
      return _award(userId, referralXp * count);
    },
    getUserXp(userId) {
      const row = getRow.get(userId);
      const info = levelInfo(row ? row.xp : 0);
      info.streak = row ? (row.streak || 0) : 0;
      info.longestStreak = row ? (row.longest_streak || 0) : 0;
      return info;
    },
    getTopLevels(limit = 10) {
      return db.prepare('SELECT user_id AS userId, xp, level FROM user_xp WHERE xp > 0 ORDER BY xp DESC LIMIT ?').all(limit);
    },

    // ── Level role rewards (admin config) ──────────────────
    listLevelRoles() {
      return db.prepare(`
        SELECT lr.level, lr.role_id AS roleId, r.name, r.color, r.icon
        FROM level_roles lr JOIN roles r ON r.id = lr.role_id
        ORDER BY lr.level
      `).all();
    },
    setLevelRole(level, roleId) {
      level = parseInt(level, 10); roleId = parseInt(roleId, 10);
      if (!Number.isInteger(level) || level < 1 || level > 1000) return false;
      if (!roleInfo.get(roleId)) return false; // role must exist
      db.prepare('INSERT INTO level_roles (level, role_id) VALUES (?, ?) ON CONFLICT(level) DO UPDATE SET role_id = excluded.role_id').run(level, roleId);
      return true;
    },
    removeLevelRole(level) {
      db.prepare('DELETE FROM level_roles WHERE level = ?').run(parseInt(level, 10));
      return true;
    },
    // Roles a user is already entitled to by their current level — used to
    // backfill on demand (e.g. after an admin adds a new mapping).
    grantEarnedLevelRoles(userId) {
      const row = getRow.get(userId);
      const lvl = row ? row.level : 0;
      return _grantLevelRoles(userId, 0, lvl);
    },
  };
};
