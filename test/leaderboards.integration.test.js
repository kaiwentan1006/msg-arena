'use strict';

// The Leaderboards hub ranks players across every competitive surface. Seeds
// titles, clips+votes, a ladder and arcade scores (one hidden via
// hide_score_badge) and asserts the boards come back correctly ordered.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');

const JWT_SECRET = 'd'.repeat(64);

async function availablePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(e => e ? reject(e) : resolve(port)); });
  });
}
async function waitForServer(url, child, out) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Server exited early:\n' + out());
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Server not ready:\n' + out());
}
function connectSocket(baseUrl, token) {
  const url = baseUrl.replace(/^http/, 'ws') + '/socket.io/?EIO=4&transport=websocket';
  const ws = new WebSocket(url);
  const events = [];
  const waiters = [];
  function push(event, payload) {
    events.push({ event, payload });
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      if (w.event === event && w.pred(payload)) { waiters.splice(i, 1); clearTimeout(w.timer); w.resolve(payload); }
    }
  }
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket connect timeout')), 6000);
    ws.on('message', raw => {
      const pkt = raw.toString();
      if (pkt === '2') return ws.send('3');
      if (pkt.startsWith('0')) return ws.send('40' + JSON.stringify({ token }));
      if (pkt.startsWith('44')) { clearTimeout(timer); return reject(new Error('auth failed: ' + pkt)); }
      if (pkt.startsWith('40')) { clearTimeout(timer); return resolve(); }
      if (pkt.startsWith('42')) { const [event, payload] = JSON.parse(pkt.slice(2)); push(event, payload); }
    });
    ws.once('error', reject);
  });
  return {
    ready,
    emit(event, payload) { ws.send('42' + JSON.stringify([event, payload])); },
    waitFor(event, pred = () => true, ms = 5000) {
      const hit = events.find(e => e.event === event && pred(e.payload));
      if (hit) return Promise.resolve(hit.payload);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for ' + event)), ms);
        waiters.push({ event, pred, resolve, timer });
      });
    },
    close() { try { ws.terminate(); } catch {} },
  };
}

test('leaderboards: titles, clips, ladders and arcade rank correctly', async (t) => {
  const root = path.resolve(__dirname, '..');
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'haven-lb-'));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = { ...process.env, HAVEN_DATA_DIR: dataDir, FORCE_HTTP: 'true', HOST: '127.0.0.1', JWT_SECRET, PORT: String(port) };

  const seed = spawnSync(process.execPath, ['-e', `
    const { initDatabase } = require('./src/database');
    const db = initDatabase();
    const mk = (n) => db.prepare("INSERT INTO users (username,password_hash,display_name) VALUES (?,?,?)").run(n,'x',n).lastInsertRowid;
    const alice = mk('alice'), bob = mk('bob');
    // Titles: alice x2, bob x1.
    for (let i=0;i<2;i++) db.prepare("INSERT INTO tournaments (name,format,status,champion_id) VALUES ('C','single_elim','complete',?)").run(alice);
    db.prepare("INSERT INTO tournaments (name,format,status,champion_id) VALUES ('C','single_elim','complete',?)").run(bob);
    // Clips + votes: alice 2 clips/3 votes, bob 1 clip/1 vote.
    const ca=db.prepare("INSERT INTO clips (uploader_id,title,file_path) VALUES (?,'a','a.mp4')").run(alice).lastInsertRowid;
    const cb=db.prepare("INSERT INTO clips (uploader_id,title,file_path) VALUES (?,'a2','a2.mp4')").run(alice).lastInsertRowid;
    const cc=db.prepare("INSERT INTO clips (uploader_id,title,file_path) VALUES (?,'b','b.mp4')").run(bob).lastInsertRowid;
    db.prepare('INSERT INTO clip_votes (clip_id,user_id) VALUES (?,?)').run(ca,bob);
    db.prepare('INSERT INTO clip_votes (clip_id,user_id) VALUES (?,?)').run(cb,bob);
    db.prepare('INSERT INTO clip_votes (clip_id,user_id) VALUES (?,?)').run(ca,alice);
    db.prepare('INSERT INTO clip_votes (clip_id,user_id) VALUES (?,?)').run(cc,alice);
    // Ladder: alice 1300 > bob 1100.
    const lad=db.prepare("INSERT INTO tournaments (name,format,status) VALUES ('Ladder','ladder','live')").run().lastInsertRowid;
    db.prepare('INSERT INTO tournament_participants (tournament_id,user_id,rating) VALUES (?,?,1300)').run(lad,alice);
    db.prepare('INSERT INTO tournament_participants (tournament_id,user_id,rating) VALUES (?,?,1100)').run(lad,bob);
    // Arcade: alice flappy 900, bob flappy 400 but bob hides scores.
    db.prepare("INSERT INTO high_scores (user_id,game,score) VALUES (?, 'flappy', 900)").run(alice);
    db.prepare("INSERT INTO high_scores (user_id,game,score) VALUES (?, 'flappy', 400)").run(bob);
    db.prepare("INSERT OR REPLACE INTO user_preferences (user_id,key,value) VALUES (?, 'hide_score_badge', 'true')").run(bob);
    require('fs').writeFileSync(require('path').join(process.env.HAVEN_DATA_DIR,'ids.json'), JSON.stringify({ alice:Number(alice), bob:Number(bob) }));
    db.close();
  `], { cwd: root, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, seed.stderr || seed.stdout);
  const ids = JSON.parse(await fs.promises.readFile(path.join(dataDir, 'ids.json'), 'utf8'));
  const token = jwt.sign({ id: ids.alice, username: 'alice', pwv: 1 }, JWT_SECRET);

  let logs = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', c => logs += c); child.stderr.on('data', c => logs += c);
  let s;
  t.after(async () => {
    s?.close();
    if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.race([child.exitCode === null ? new Promise(r => child.once('exit', r)) : Promise.resolve(), new Promise(r => setTimeout(r, 3000))]);
    await fs.promises.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });
  await waitForServer(`${baseUrl}/api/health`, child, () => logs);

  s = connectSocket(baseUrl, token); await s.ready;
  s.emit('get-leaderboards', {});
  const lb = await s.waitFor('leaderboards');

  // Titles: alice (2) ahead of bob (1).
  assert.equal(lb.titles[0].userId, ids.alice);
  assert.equal(lb.titles[0].count, 2);
  assert.equal(lb.titles[1].userId, ids.bob);

  // Clips: alice (3 votes) ahead of bob (1 vote).
  assert.equal(lb.clips[0].userId, ids.alice);
  assert.equal(lb.clips[0].votes, 3);
  assert.equal(lb.clips[0].clips, 2);

  // Ladder top: alice then bob.
  const ladder = lb.ladders.find(l => l.name === 'Ladder');
  assert.ok(ladder, 'ladder present');
  assert.equal(ladder.top[0].userId, ids.alice);
  assert.equal(ladder.top[0].rating, 1300);
  assert.equal(ladder.top[1].userId, ids.bob);

  // Arcade flappy: only alice (bob hides scores).
  const flappy = lb.arcade.find(b => b.game === 'flappy');
  assert.ok(flappy, 'flappy board present');
  assert.equal(flappy.top.length, 1, 'bob is hidden by hide_score_badge');
  assert.equal(flappy.top[0].userId, ids.alice);
  assert.equal(flappy.top[0].score, 900);
});
