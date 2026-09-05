'use strict';
const { levelInfo, totalXpForLevel } = require('./xp');

/**
 * createXpService(db) — server-authoritative XP. Awards are never client-asserted
 * (consistent with the "scores must be server-derived" rule). A per-user in-memory
 * cooldown keeps the hot message path cheap: at most one DB write per user per
 * cooldown window. Callers emit any level-up (they hold the socket/socketId).
 */
module.exports = function createXpService(db, opts = {}) {
  const cooldownMs = opts.messageCooldownMs ?? 60000;
  const msgMin = opts.msgMin ?? 15;
  const msgMax = opts.msgMax ?? 25;
  const voiceXp = opts.voiceXp ?? 10;

  const _cooldown = new Map(); // userId -> last message-award ts (bounded by user count)

  const getRow      = db.prepare('SELECT xp, level FROM user_xp WHERE user_id = ?');
  const insertRow   = db.prepare('INSERT INTO user_xp (user_id, xp, level, updated_at) VALUES (?, ?, ?, ?)');
  const updateRow   = db.prepare('UPDATE user_xp SET xp = ?, level = ?, updated_at = ? WHERE user_id = ?');

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
    return { xp: newXp, level: newLevel, leveledUp: newLevel > prevLevel };
  }

  return {
    // Chat message award (per-user cooldown). Returns null if on cooldown or the
    // sender isn't a real user (bots/system have id <= 0). Caller emits level-up.
    awardMessage(userId) {
      if (!Number.isInteger(userId) || userId <= 0) return null;
      const now = Date.now();
      if (now - (_cooldown.get(userId) || 0) < cooldownMs) return null;
      _cooldown.set(userId, now);
      const amount = msgMin + Math.floor(Math.random() * (msgMax - msgMin + 1));
      return _award(userId, amount);
    },
    // One minute of voice activity.
    awardVoice(userId) {
      if (!Number.isInteger(userId) || userId <= 0) return null;
      return _award(userId, voiceXp);
    },
    getUserXp(userId) {
      const row = getRow.get(userId);
      return levelInfo(row ? row.xp : 0);
    },
    getTopLevels(limit = 10) {
      return db.prepare('SELECT user_id AS userId, xp, level FROM user_xp WHERE xp > 0 ORDER BY xp DESC LIMIT ?').all(limit);
    },
  };
};
