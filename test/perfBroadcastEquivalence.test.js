// Proves the two broadcast perf refactors are output-equivalent to the code
// they replace:
//   1. getEnrichedChannels — the per-channel unread COUNT(*) loop vs the single
//      batched grouped query.
//   2. emitOnlineUsers — the full users-table status scan vs the member-scoped
//      `WHERE id IN (...)` scan.
// Both are pure query rewrites; this asserts identical results across a
// realistic scenario with the edge cases that matter (viewer's own messages,
// thread replies, fully-read / empty / all-mine channels, banned members).
const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');

function seed() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY, channel_id INTEGER, user_id INTEGER, thread_id INTEGER
    );
    CREATE TABLE users (
      id INTEGER PRIMARY KEY, status TEXT, status_text TEXT, avatar TEXT,
      avatar_shape TEXT, border TEXT, border_transform TEXT,
      animate_profile TEXT, is_guest INTEGER
    );
    CREATE TABLE channel_members (channel_id INTEGER, user_id INTEGER);
  `);
  // Users 1..8 with assorted profile data (1 = viewer).
  const iu = db.prepare(`INSERT INTO users
    (id,status,status_text,avatar,avatar_shape,border,border_transform,animate_profile,is_guest)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  for (let i = 1; i <= 8; i++) {
    iu.run(i, i % 3 === 0 ? 'dnd' : 'online', 'st' + i, i % 2 ? ('a' + i) : null,
      'circle', null, null, 'trigger', i === 8 ? 1 : 0);
  }
  // Channels 10..14, members = users 1..6 (7,8 are non-members / e.g. banned).
  const im = db.prepare('INSERT INTO channel_members (channel_id,user_id) VALUES (?,?)');
  for (const c of [10, 11, 12, 13, 14]) for (let u = 1; u <= 6; u++) im.run(c, u);

  // Messages: mix of authors, thread replies, across channels.
  const imsg = db.prepare('INSERT INTO messages (id,channel_id,user_id,thread_id) VALUES (?,?,?,?)');
  let id = 0;
  // ch10: lots of activity by others + some by viewer(1) + thread replies
  for (const [ch, u, thr] of [
    [10, 2, null], [10, 1, null], [10, 3, null], [10, 2, 99], [10, 4, null], [10, 1, null], [10, 5, null],
    // ch11: only viewer's own messages after read point -> 0 unread beyond read
    [11, 1, null], [11, 1, null], [11, 1, null],
    // ch12: mix, thread replies only after a point
    [12, 2, null], [12, 3, null], [12, 2, 50], [12, 4, 50], [12, 3, 50],
    // ch13: normal
    [13, 6, null], [13, 2, null], [13, 3, null], [13, 4, null],
    // ch14: no messages (skip)
  ]) { imsg.run(++id, ch, u, thr); }
  return db;
}

// Per-channel counts, EXACTLY the query getEnrichedChannels used before.
function oldUnread(db, channels, readMap, latestMap, viewerId) {
  const out = {};
  const stmt = db.prepare('SELECT COUNT(*) as cnt FROM messages WHERE channel_id = ? AND id > ? AND user_id != ? AND thread_id IS NULL');
  for (const ch of channels) {
    const lastRead = readMap[ch] || 0, latestId = latestMap[ch] || 0;
    out[ch] = (latestId > lastRead) ? stmt.get(ch, lastRead, viewerId).cnt : 0;
  }
  return out;
}
// Batched grouped query, EXACTLY as the refactor computes it.
function newUnread(db, channels, readMap, latestMap, viewerId) {
  const out = {};
  const need = channels.filter(ch => (latestMap[ch] || 0) > (readMap[ch] || 0));
  const map = {};
  if (need.length > 0) {
    const conds = need.map(() => '(channel_id = ? AND id > ?)').join(' OR ');
    const params = [];
    need.forEach(ch => { params.push(ch, readMap[ch] || 0); });
    db.prepare(`SELECT channel_id, COUNT(*) AS cnt FROM messages WHERE user_id != ? AND thread_id IS NULL AND (${conds}) GROUP BY channel_id`)
      .all(viewerId, ...params).forEach(r => { map[r.channel_id] = r.cnt; });
  }
  for (const ch of channels) {
    const lastRead = readMap[ch] || 0, latestId = latestMap[ch] || 0;
    out[ch] = (latestId > lastRead) ? (map[ch] || 0) : 0;
  }
  return out;
}

test('unread counts: batched grouped query == per-channel COUNT loop', () => {
  const db = seed();
  const viewer = 1;
  const channels = [10, 11, 12, 13, 14];
  const latestMap = {};
  db.prepare('SELECT channel_id, MAX(id) as latest FROM messages GROUP BY channel_id')
    .all().forEach(r => { latestMap[r.channel_id] = r.latest; });

  // Try many read positions per channel, including 0, mid, latest, and beyond.
  const positions = [0, 1, 3, 5, 8, 12, 15, 19, 999];
  for (const p of positions) {
    const readMap = {};
    for (const ch of channels) readMap[ch] = p;
    const o = oldUnread(db, channels, readMap, latestMap, viewer);
    const n = newUnread(db, channels, readMap, latestMap, viewer);
    assert.deepStrictEqual(n, o, `mismatch at read position ${p}`);
  }

  // Mixed per-channel read positions.
  for (let trial = 0; trial < 50; trial++) {
    const readMap = {};
    for (const ch of channels) readMap[ch] = Math.floor(Math.random() * 20);
    assert.deepStrictEqual(
      newUnread(db, channels, readMap, latestMap, viewer),
      oldUnread(db, channels, readMap, latestMap, viewer),
      'mismatch on mixed read positions ' + JSON.stringify(readMap));
  }
  db.close();
});

test('status scan: member-scoped IN(...) == full scan filtered to members', () => {
  const db = seed();
  const cols = 'id, status, status_text, avatar, avatar_shape, border, border_transform, animate_profile, is_guest';
  // full scan (old behaviour), then filter to the rendered member set in JS
  const full = {};
  db.prepare(`SELECT ${cols} FROM users`).all().forEach(r => { full[r.id] = r; });

  // memberIds for channel 10 = users 1..6
  const memberIds = db.prepare('SELECT user_id FROM channel_members WHERE channel_id = ?').all(10).map(r => r.user_id);

  const ph = memberIds.map(() => '?').join(',');
  const scoped = {};
  db.prepare(`SELECT ${cols} FROM users WHERE id IN (${ph})`).all(...memberIds)
    .forEach(r => { scoped[r.id] = r; });

  // scoped must equal full restricted to memberIds (nothing more, nothing less)
  const expected = {};
  for (const id of memberIds) if (full[id]) expected[id] = full[id];
  assert.deepStrictEqual(scoped, expected);
  // and it must NOT include non-members (7,8)
  assert.ok(!(7 in scoped) && !(8 in scoped));
  db.close();
});
