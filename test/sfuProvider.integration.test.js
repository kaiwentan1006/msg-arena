'use strict';

// End-to-end test of the SERVER's voice-provider decision. With sfu_enabled on,
// joining voice must return voice-provider-config {provider:'sfu'} and the SFU
// must send an offer (proving sfu.join ran and signaling flows). With it off,
// the room stays on the P2P mesh and no SFU offer is sent.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
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
    ready, events,
    emit(event, payload) { ws.send('42' + JSON.stringify([event, payload])); },
    waitFor(event, pred = () => true, ms = 5000) {
      const hit = events.find(e => e.event === event && pred(e.payload));
      if (hit) return Promise.resolve(hit.payload);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for ' + event)), ms);
        waiters.push({ event, pred, resolve, timer });
      });
    },
    seen(event) { return events.some(e => e.event === event); },
    close() { try { ws.terminate(); } catch {} },
  };
}

async function boot(t, sfuEnabled) {
  const root = path.resolve(__dirname, '..');
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'haven-sfu-'));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = { ...process.env, HAVEN_DATA_DIR: dataDir, FORCE_HTTP: 'true', HOST: '127.0.0.1', JWT_SECRET, PORT: String(port) };
  const code = crypto.randomBytes(4).toString('hex');

  const seed = spawnSync(process.execPath, ['-e', `
    const { initDatabase } = require('./src/database');
    const db = initDatabase();
    const u = db.prepare("INSERT INTO users (username, password_hash, display_name, is_admin) VALUES ('alice','x','Alice',1)").run();
    const ch = db.prepare("INSERT INTO channels (name, code, voice_enabled) VALUES ('Voice', ?, 1)").run(${JSON.stringify(code)});
    db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(ch.lastInsertRowid, u.lastInsertRowid);
    db.prepare("INSERT OR REPLACE INTO server_settings (key, value) VALUES ('sfu_enabled', ?)").run(${sfuEnabled ? "'true'" : "'false'"});
    require('fs').writeFileSync(require('path').join(process.env.HAVEN_DATA_DIR,'ids.json'), JSON.stringify({ u:Number(u.lastInsertRowid), code:${JSON.stringify(code)} }));
    db.close();
  `], { cwd: root, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, seed.stderr || seed.stdout);
  const ids = JSON.parse(await fs.promises.readFile(path.join(dataDir, 'ids.json'), 'utf8'));
  const token = jwt.sign({ id: ids.u, username: 'alice', pwv: 1 }, JWT_SECRET);

  let logs = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', c => logs += c); child.stderr.on('data', c => logs += c);
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.race([child.exitCode === null ? new Promise(r => child.once('exit', r)) : Promise.resolve(), new Promise(r => setTimeout(r, 3000))]);
    await fs.promises.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });
  await waitForServer(`${baseUrl}/api/health`, child, () => logs);
  return { baseUrl, token, code: ids.code };
}

test('voice provider: SFU enabled → client gets provider:sfu and an SFU offer', async (t) => {
  const { baseUrl, token, code } = await boot(t, true);
  const s = connectSocket(baseUrl, token); await s.ready;
  t.after(() => s.close());

  s.emit('voice-join', { code });
  const cfg = await s.waitFor('voice-provider-config', p => p.channelCode === code);
  assert.equal(cfg.provider, 'sfu', 'server chose the SFU provider');
  const offer = await s.waitFor('sfu-offer', p => p.code === code, 8000);
  assert.ok(offer.sdp && offer.sdp.sdp, 'SFU sent a real offer');
  assert.ok(offer.sendMids && Object.values(offer.sendMids).includes('audio'), 'offer opens a mic publish slot');
});

test('voice provider: SFU disabled → mesh, no SFU offer', async (t) => {
  const { baseUrl, token, code } = await boot(t, false);
  const s = connectSocket(baseUrl, token); await s.ready;
  t.after(() => s.close());

  s.emit('voice-join', { code });
  const cfg = await s.waitFor('voice-provider-config', p => p.channelCode === code);
  assert.equal(cfg.provider, 'p2p', 'server stayed on the mesh');
  // Give the server a beat; assert no SFU offer was pushed.
  await new Promise(r => setTimeout(r, 800));
  assert.equal(s.seen('sfu-offer'), false, 'no SFU offer on a mesh room');
  // Mesh presence still works.
  assert.ok(s.seen('voice-existing-users'), 'mesh still sends existing-users');
});
