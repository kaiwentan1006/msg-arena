'use strict';

// Unit test for the achievements engine against the real schema (temp DB, no
// server). Covers threshold awarding, idempotency, and the apex ladder rule.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.HAVEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-ach-'));
process.env.JWT_SECRET = 'a'.repeat(64);
const { initDatabase } = require('../src/database');
const ach = require('../src/achievements');
const db = initDatabase();

test('achievements: awarded on thresholds, idempotent', () => {
  const uid = Number(db.prepare("INSERT INTO users (username,password_hash) VALUES ('achA','x')").run().lastInsertRowid);
  assert.deepEqual(ach.checkAndAward(db, uid), [], 'nothing yet');

  db.prepare("INSERT INTO clips (uploader_id,title,file_path) VALUES (?,'c','c.mp4')").run(uid);
  let keys = ach.checkAndAward(db, uid).map(a => a.key);
  assert.ok(keys.includes('first_clip'), 'first clip badge');

  assert.deepEqual(ach.checkAndAward(db, uid), [], 'no re-award (idempotent)');

  const tid = Number(db.prepare("INSERT INTO tournaments (name,format,status,champion_id) VALUES ('C','single_elim','complete',?)").run(uid).lastInsertRowid);
  db.prepare('INSERT INTO tournament_participants (tournament_id,user_id,wins) VALUES (?,?,1)').run(tid, uid);
  keys = ach.checkAndAward(db, uid).map(a => a.key);
  assert.ok(keys.includes('champion'), 'champion');
  assert.ok(keys.includes('first_blood'), 'first match win');

  const listed = ach.listFor(db, uid).map(a => a.key);
  assert.ok(listed.includes('first_clip') && listed.includes('champion'), 'listFor returns earned');
});

test('achievements: apex needs #1 on a 4+ player ladder', () => {
  const me = Number(db.prepare("INSERT INTO users (username,password_hash) VALUES ('apexme','x')").run().lastInsertRowid);
  const lad = Number(db.prepare("INSERT INTO tournaments (name,format,status) VALUES ('L','ladder','live')").run().lastInsertRowid);
  db.prepare('INSERT INTO tournament_participants (tournament_id,user_id,rating) VALUES (?,?,1500)').run(lad, me);

  let keys = ach.checkAndAward(db, me).map(a => a.key);
  assert.ok(keys.includes('ranked_up'), '1500 ≥ 1200');
  assert.ok(!keys.includes('apex'), 'no apex with < 4 players');

  for (let i = 0; i < 3; i++) {
    const u = Number(db.prepare('INSERT INTO users (username,password_hash) VALUES (?, ?)').run('apex' + i, 'x').lastInsertRowid);
    db.prepare('INSERT INTO tournament_participants (tournament_id,user_id,rating) VALUES (?,?,1000)').run(lad, u);
  }
  keys = ach.checkAndAward(db, me).map(a => a.key);
  assert.ok(keys.includes('apex'), 'apex at #1 of 4');
});
