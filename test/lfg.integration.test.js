'use strict';

// End-to-end LFG test: two authed Socket.IO clients drive
// create → join → party fills → both get lfg:party-ready and a temp voice
// channel is created. Uses the raw ws Socket.IO v4 protocol (no client dep),
// mirroring test/webhookBulkDelete.integration.test.js.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
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

// A minimal authed Socket.IO client over raw ws.
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

test('LFG: create → join fills the party → both members get party-ready + temp voice', async t => {
  const root = path.resolve(__dirname, '..');
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'haven-lfg-'));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = { ...process.env, HAVEN_DATA_DIR: dataDir, FORCE_HTTP: 'true', HOST: '127.0.0.1', JWT_SECRET, PORT: String(port) };

  const seed = spawnSync(process.execPath, ['-e', `
    const { initDatabase } = require('./src/database');
    const db = initDatabase();
    const a = db.prepare("INSERT INTO users (username, password_hash, display_name) VALUES ('alice','x','Alice')").run();
    const b = db.prepare("INSERT INTO users (username, password_hash, display_name) VALUES ('bob','x','Bob')").run();
    // Ensure Alice has create_lfg via the auto-assigned User role.
    const userRole = db.prepare("SELECT id FROM roles WHERE name='User'").get();
    if (userRole) { const ins = db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)'); ins.run(a.lastInsertRowid, userRole.id); ins.run(b.lastInsertRowid, userRole.id); }
    const game = db.prepare("SELECT id FROM games WHERE slug='valorant'").get();
    require('fs').writeFileSync(require('path').join(process.env.HAVEN_DATA_DIR,'ids.json'), JSON.stringify({ a:Number(a.lastInsertRowid), b:Number(b.lastInsertRowid), gameId: game.id }));
    db.close();
  `], { cwd: root, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, seed.stderr || seed.stdout);
  const ids = JSON.parse(await fs.promises.readFile(path.join(dataDir, 'ids.json'), 'utf8'));
  const tokenA = jwt.sign({ id: ids.a, username: 'alice', pwv: 1 }, JWT_SECRET);
  const tokenB = jwt.sign({ id: ids.b, username: 'bob', pwv: 1 }, JWT_SECRET);

  let logs = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', c => logs += c); child.stderr.on('data', c => logs += c);
  let A, B;
  t.after(async () => {
    A?.close(); B?.close();
    if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.race([child.exitCode === null ? new Promise(r => child.once('exit', r)) : Promise.resolve(), new Promise(r => setTimeout(r, 3000))]);
    await fs.promises.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });
  await waitForServer(`${baseUrl}/api/health`, child, () => logs);

  A = connectSocket(baseUrl, tokenA); await A.ready;
  B = connectSocket(baseUrl, tokenB); await B.ready;

  // Alice creates a 2-slot party for Valorant.
  A.emit('lfg:create', { gameId: ids.gameId, slots: 2, note: 'need 1 for ranked', mode: 'Competitive' });
  const created = await B.waitFor('lfg:post-created', p => p.post && p.post.slots === 2);
  const postId = created.post.id;
  assert.equal(created.post.filled, 1, 'owner holds one slot');
  assert.equal(created.post.status, 'open');
  assert.equal(created.post.game.slug, 'valorant');

  // Bob joins → party fills.
  const bReady = B.waitFor('lfg:party-ready', p => p.postId === postId);
  const aReady = A.waitFor('lfg:party-ready', p => p.postId === postId);
  const updated = A.waitFor('lfg:post-updated', p => p.post && p.post.id === postId && p.post.status === 'full');
  B.emit('lfg:join', { postId, role: 'Duelist' });

  const [bp, ap, up] = await Promise.all([bReady, aReady, updated]);
  assert.ok(bp.voiceCode && bp.voiceCode === ap.voiceCode, 'both members get the same voice code');
  assert.equal(up.post.filled, 2, 'party is full');
  assert.equal(up.post.status, 'full');

  // The temp voice channel exists.
  const db = new Database(path.join(dataDir, 'haven.db'));
  t.after(() => db.close());
  const ch = db.prepare('SELECT is_temp_voice, voice_enabled FROM channels WHERE code = ?').get(bp.voiceCode);
  assert.ok(ch, 'temp voice channel row exists');
  assert.equal(ch.is_temp_voice, 1);
  assert.equal(ch.voice_enabled, 1);
});
