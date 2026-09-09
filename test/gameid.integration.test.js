'use strict';

// Self-declared game IDs: set a handle → it appears on the profile as
// UNVERIFIED → remove it. Single authed Socket.IO client over raw ws.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');

const JWT_SECRET = 'e'.repeat(64);

async function availablePort() {
  return new Promise((res, rej) => { const s = net.createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(e => e ? rej(e) : res(port)); }); });
}
async function waitForServer(url, child, out) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('exited early:\n' + out());
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('not ready:\n' + out());
}
function connectSocket(baseUrl, token) {
  const url = baseUrl.replace(/^http/, 'ws') + '/socket.io/?EIO=4&transport=websocket';
  const ws = new WebSocket(url);
  const events = []; const waiters = [];
  function push(event, payload) {
    events.push({ event, payload });
    for (let i = waiters.length - 1; i >= 0; i--) { const w = waiters[i]; if (w.event === event && w.pred(payload)) { waiters.splice(i, 1); clearTimeout(w.timer); w.resolve(payload); } }
  }
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('connect timeout')), 6000);
    ws.on('message', raw => {
      const p = raw.toString();
      if (p === '2') return ws.send('3');
      if (p.startsWith('0')) return ws.send('40' + JSON.stringify({ token }));
      if (p.startsWith('44')) { clearTimeout(timer); return reject(new Error('auth failed: ' + p)); }
      if (p.startsWith('40')) { clearTimeout(timer); return resolve(); }
      if (p.startsWith('42')) { const [e, pl] = JSON.parse(p.slice(2)); push(e, pl); }
    });
    ws.once('error', reject);
  });
  return {
    ready,
    emit(e, pl) { ws.send('42' + JSON.stringify([e, pl])); },
    waitFor(event, pred = () => true, ms = 5000) {
      const hit = events.find(e => e.event === event && pred(e.payload));
      if (hit) return Promise.resolve(hit.payload);
      return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('timeout ' + event)), ms); waiters.push({ event, pred, resolve, timer }); });
    },
    close() { try { ws.terminate(); } catch {} },
  };
}

test('game IDs: set a self-declared handle → shows on profile as unverified → remove', async t => {
  const root = path.resolve(__dirname, '..');
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'haven-gameid-'));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = { ...process.env, HAVEN_DATA_DIR: dataDir, FORCE_HTTP: 'true', HOST: '127.0.0.1', JWT_SECRET, PORT: String(port) };

  const seed = spawnSync(process.execPath, ['-e', `
    const { initDatabase } = require('./src/database');
    const db = initDatabase();
    const u = db.prepare("INSERT INTO users (username, password_hash, display_name) VALUES ('gamer','x','Gamer')").run();
    require('fs').writeFileSync(require('path').join(process.env.HAVEN_DATA_DIR,'ids.json'), JSON.stringify({ id: Number(u.lastInsertRowid) }));
    db.close();
  `], { cwd: root, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, seed.stderr || seed.stdout);
  const ids = JSON.parse(await fs.promises.readFile(path.join(dataDir, 'ids.json'), 'utf8'));
  const token = jwt.sign({ id: ids.id, username: 'gamer', pwv: 1 }, JWT_SECRET);

  let logs = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', c => logs += c); child.stderr.on('data', c => logs += c);
  let S;
  t.after(async () => {
    S?.close();
    if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.race([child.exitCode === null ? new Promise(r => child.once('exit', r)) : Promise.resolve(), new Promise(r => setTimeout(r, 3000))]);
    await fs.promises.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });
  await waitForServer(`${baseUrl}/api/health`, child, () => logs);

  S = connectSocket(baseUrl, token); await S.ready;

  // Set a Riot ID.
  S.emit('gameid:set-handle', { provider: 'riot', handle: ' Shadow#EUW ' });
  const list = await S.waitFor('gameid:list', p => p.ids && p.ids.some(i => i.provider === 'riot'));
  const riot = list.ids.find(i => i.provider === 'riot');
  assert.equal(riot.handle, 'Shadow#EUW', 'handle is trimmed and stored');
  assert.equal(riot.verified, false, 'self-declared handles are never verified');

  // It shows on the profile.
  S.emit('get-user-profile', { userId: ids.id });
  const prof = await S.waitFor('user-profile', p => p.id === ids.id);
  assert.ok(Array.isArray(prof.connections), 'profile carries a connections array');
  const pr = prof.connections.find(c => c.provider === 'riot');
  assert.ok(pr && pr.handle === 'Shadow#EUW' && pr.verified === false, 'profile shows the unverified Riot ID');

  // An unknown platform is rejected.
  S.emit('gameid:set-handle', { provider: 'not-a-platform', handle: 'x' });
  const err = await S.waitFor('error-msg', m => /Unknown platform/i.test(String(m)));
  assert.match(String(err), /Unknown platform/);

  // Remove it.
  S.emit('gameid:remove-handle', { provider: 'riot' });
  const after = await S.waitFor('gameid:list', p => !p.ids.some(i => i.provider === 'riot'));
  assert.ok(!after.ids.some(i => i.provider === 'riot'), 'handle is gone after removal');
});
