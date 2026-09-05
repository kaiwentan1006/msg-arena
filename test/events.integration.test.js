'use strict';

// End-to-end scheduled events over Socket.IO: create → RSVP (going/interested)
// → capacity limit → cancel, all via the live server broadcasts.

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

test('events: create → RSVP → capacity → cancel', async (t) => {
  const root = path.resolve(__dirname, '..');
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'haven-ev-'));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = { ...process.env, HAVEN_DATA_DIR: dataDir, FORCE_HTTP: 'true', HOST: '127.0.0.1', JWT_SECRET, PORT: String(port) };

  const seed = spawnSync(process.execPath, ['-e', `
    const { initDatabase } = require('./src/database');
    const db = initDatabase();
    const mk = (n,a) => db.prepare("INSERT INTO users (username,password_hash,display_name,is_admin) VALUES (?,?,?,?)").run(n,'x',n,a?1:0).lastInsertRowid;
    const alice = mk('alice', true), bob = mk('bob', false), carol = mk('carol', false);
    require('fs').writeFileSync(require('path').join(process.env.HAVEN_DATA_DIR,'ids.json'), JSON.stringify({ alice:Number(alice), bob:Number(bob), carol:Number(carol) }));
    db.close();
  `], { cwd: root, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, seed.stderr || seed.stdout);
  const ids = JSON.parse(await fs.promises.readFile(path.join(dataDir, 'ids.json'), 'utf8'));
  const tok = (id, u) => jwt.sign({ id, username: u, pwv: 1 }, JWT_SECRET);

  let logs = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', c => logs += c); child.stderr.on('data', c => logs += c);
  let A, B, C;
  t.after(async () => {
    A?.close(); B?.close(); C?.close();
    if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.race([child.exitCode === null ? new Promise(r => child.once('exit', r)) : Promise.resolve(), new Promise(r => setTimeout(r, 3000))]);
    await fs.promises.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });
  await waitForServer(`${baseUrl}/api/health`, child, () => logs);

  A = connectSocket(baseUrl, tok(ids.alice, 'alice')); await A.ready;
  B = connectSocket(baseUrl, tok(ids.bob, 'bob')); await B.ready;
  C = connectSocket(baseUrl, tok(ids.carol, 'carol')); await C.ready;

  const soon = Date.now() + 60 * 60 * 1000; // 1h out

  // A schedules an event → auto-going.
  A.emit('event:create', { title: 'Ranked Night', gameId: null, startAt: soon, description: 'valorant grind' });
  const created = await B.waitFor('event:updated', p => p.event.title === 'Ranked Night');
  const eid = created.event.id;
  assert.equal(created.event.going, 1, 'organiser auto-RSVPs going');
  assert.ok(created.event.attendees.some(a => a.id === ids.alice && a.status === 'going'));

  // Bob goes, Carol is interested.
  B.emit('event:rsvp', { id: eid, status: 'going' });
  await A.waitFor('event:updated', p => p.event.id === eid && p.event.going === 2);
  C.emit('event:rsvp', { id: eid, status: 'interested' });
  const withCarol = await A.waitFor('event:updated', p => p.event.id === eid && p.event.interested === 1);
  assert.equal(withCarol.event.going, 2);
  assert.ok(withCarol.event.attendees.some(a => a.id === ids.carol && a.status === 'interested'));

  // Capacity: a 1-seat event fills with the organiser; bob can't go.
  A.emit('event:create', { title: 'Duo Queue', startAt: soon, maxAttendees: 1 });
  const duo = await B.waitFor('event:updated', p => p.event.title === 'Duo Queue');
  B.emit('event:rsvp', { id: duo.event.id, status: 'going' });
  const full = await B.waitFor('event:error', p => /full/i.test(p.message || ''));
  assert.match(full.message, /full/i);

  // Cancel removes it.
  A.emit('event:cancel', { id: eid });
  const removed = await B.waitFor('event:removed', p => p.id === eid);
  assert.equal(removed.id, eid);
});
