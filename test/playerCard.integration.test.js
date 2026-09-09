'use strict';

// The Player Card aggregates a user's gaming record (tournaments, ELO ladders,
// clips, arcade scores) from data already spread across those tables. This seeds
// one of each and asserts the get-player-card payload adds up.

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

test('player card: aggregates tournaments, ladders, clips and arcade scores', async (t) => {
  const root = path.resolve(__dirname, '..');
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'haven-pc-'));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = { ...process.env, HAVEN_DATA_DIR: dataDir, FORCE_HTTP: 'true', HOST: '127.0.0.1', JWT_SECRET, PORT: String(port) };

  const seed = spawnSync(process.execPath, ['-e', `
    const { initDatabase } = require('./src/database');
    const db = initDatabase();
    const alice = db.prepare("INSERT INTO users (username,password_hash,display_name) VALUES ('alice','x','Alice')").run().lastInsertRowid;
    const rival = db.prepare("INSERT INTO users (username,password_hash,display_name) VALUES ('rival','x','Rival')").run().lastInsertRowid;
    // A bracket alice won.
    const cup = db.prepare("INSERT INTO tournaments (name,format,status,champion_id) VALUES ('Cup','single_elim','complete',?)").run(alice).lastInsertRowid;
    db.prepare('INSERT INTO tournament_participants (tournament_id,user_id,wins,losses) VALUES (?,?,3,1)').run(cup, alice);
    // A ladder where alice leads.
    const lad = db.prepare("INSERT INTO tournaments (name,format,status) VALUES ('Ladder','ladder','live')").run().lastInsertRowid;
    db.prepare('INSERT INTO tournament_participants (tournament_id,user_id,rating) VALUES (?,?,1200)').run(lad, alice);
    db.prepare('INSERT INTO tournament_participants (tournament_id,user_id,rating) VALUES (?,?,1000)').run(lad, rival);
    // Two clips by alice, three votes across them.
    const c1 = db.prepare("INSERT INTO clips (uploader_id,title,file_path) VALUES (?, 'Ace','a.mp4')").run(alice).lastInsertRowid;
    const c2 = db.prepare("INSERT INTO clips (uploader_id,title,file_path) VALUES (?, 'Clutch','b.mp4')").run(alice).lastInsertRowid;
    db.prepare('INSERT INTO clip_votes (clip_id,user_id) VALUES (?,?)').run(c1, rival);
    db.prepare('INSERT INTO clip_votes (clip_id,user_id) VALUES (?,?)').run(c2, rival);
    db.prepare('INSERT INTO clip_votes (clip_id,user_id) VALUES (?,?)').run(c1, alice);
    // Arcade high score.
    db.prepare("INSERT INTO high_scores (user_id, game, score) VALUES (?, 'flappy', 500)").run(alice);
    require('fs').writeFileSync(require('path').join(process.env.HAVEN_DATA_DIR,'ids.json'), JSON.stringify({ alice:Number(alice) }));
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
  s.emit('get-player-card', { userId: ids.alice });
  const card = await s.waitFor('player-card', p => p.userId === ids.alice);

  assert.equal(card.tournaments.championships, 1, 'one title');
  assert.equal(card.tournaments.entered, 2, 'entered the cup and the ladder');
  assert.equal(card.tournaments.matchWins, 3, 'match wins summed');
  assert.equal(card.tournaments.matchLosses, 1);

  assert.equal(card.ladders.length, 1);
  assert.equal(card.ladders[0].rating, 1200);
  assert.equal(card.ladders[0].rank, 1, 'top of the ladder');
  assert.equal(card.ladders[0].total, 2);

  assert.equal(card.clips.posted, 2);
  assert.equal(card.clips.votes, 3, 'votes across her clips');

  assert.equal(card.arcade.length, 1);
  assert.equal(card.arcade[0].game, 'flappy');
  assert.equal(card.arcade[0].score, 500);
});
