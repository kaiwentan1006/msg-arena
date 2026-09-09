// Rank-reward cosmetics: banners/name-effects are server-gated by level — a
// client can only apply a cosmetic its level has unlocked, and the profile
// payload carries the choice back + the level that gates the picker.
'use strict';
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

const JWT_SECRET = 'k'.repeat(64);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function availablePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(e => e ? reject(e) : resolve(port)); });
  });
}
async function waitForServer(url, child, out) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Server exited early:\n' + out());
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Server not ready:\n' + out());
}
function connectSocket(baseUrl, token) {
  const url = baseUrl.replace(/^http/, 'ws') + '/socket.io/?EIO=4&transport=websocket';
  const ws = new WebSocket(url); const events = []; const waiters = [];
  function push(ev, pl) { events.push({ ev, pl }); for (let i = waiters.length - 1; i >= 0; i--) { const w = waiters[i]; if (w.ev === ev && w.pred(pl)) { waiters.splice(i, 1); clearTimeout(w.timer); w.resolve(pl); } } }
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('connect timeout')), 6000);
    ws.on('message', raw => { const p = raw.toString();
      if (p === '2') return ws.send('3');
      if (p.startsWith('0')) return ws.send('40' + JSON.stringify({ token }));
      if (p.startsWith('44')) { clearTimeout(timer); return reject(new Error('auth failed: ' + p)); }
      if (p.startsWith('40')) { clearTimeout(timer); return resolve(); }
      if (p.startsWith('42')) { const [ev, pl] = JSON.parse(p.slice(2)); push(ev, pl); }
    });
    ws.once('error', reject);
  });
  return {
    ready,
    emit(ev, pl) { ws.send('42' + JSON.stringify([ev, pl])); },
    waitFor(ev, pred = () => true, ms = 5000) {
      const hit = events.find(e => e.ev === ev && pred(e.pl));
      if (hit) return Promise.resolve(hit.pl);
      return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('timeout ' + ev)), ms); waiters.push({ ev, pred, resolve, timer }); });
    },
    close() { try { ws.terminate(); } catch {} },
  };
}

test('rank perks: level-gated banner/name-effect + profile payload', async (t) => {
  const root = path.resolve(__dirname, '..');
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'haven-rp-'));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = { ...process.env, HAVEN_DATA_DIR: dataDir, FORCE_HTTP: 'true', HOST: '127.0.0.1', JWT_SECRET, PORT: String(port) };

  // Alice is level 6 (gradients unlocked, animated still locked at 15).
  const seed = spawnSync(process.execPath, ['-e', `
    const { initDatabase } = require('./src/database');
    const db = initDatabase();
    const alice = db.prepare("INSERT INTO users (username,password_hash,display_name) VALUES ('alice','x','Alice')").run().lastInsertRowid;
    db.prepare('INSERT INTO user_xp (user_id, xp, level, updated_at) VALUES (?, ?, ?, ?)').run(alice, 5000, 6, Date.now());
    require('fs').writeFileSync(require('path').join(process.env.HAVEN_DATA_DIR,'ids.json'), JSON.stringify({ alice:Number(alice) }));
    db.close();
  `], { cwd: root, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, seed.stderr || seed.stdout);
  const ids = JSON.parse(await fs.promises.readFile(path.join(dataDir, 'ids.json'), 'utf8'));
  const tok = jwt.sign({ id: ids.alice, username: 'alice', pwv: 1 }, JWT_SECRET);

  let logs = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', c => logs += c); child.stderr.on('data', c => logs += c);
  let A;
  t.after(async () => { A?.close(); if (child.exitCode === null) child.kill('SIGTERM'); await sleep(300); await fs.promises.rm(dataDir, { recursive: true, force: true }).catch(() => {}); });
  await waitForServer(`${baseUrl}/api/health`, child, () => logs);

  A = connectSocket(baseUrl, tok); await A.ready;

  // Allowed: gradient banner at level 6.
  A.emit('set-profile-banner', { banner: 'grad-aurora' });
  const up = await A.waitFor('profile-updated', p => p && 'profileBanner' in p);
  assert.equal(up.profileBanner, 'grad-aurora', 'gradient banner applied');

  // Locked: animated banner needs level 15 → rejected, DB unchanged.
  A.emit('set-profile-banner', { banner: 'anim-holo' });
  let rejected = false;
  try { await A.waitFor('error-msg', () => true, 1200); rejected = true; } catch {}
  assert.equal(rejected, true, 'animated banner rejected below its level');

  // Name effect gated too: name-glow needs level 20 → rejected.
  A.emit('set-name-effect', { effect: 'name-glow' });
  let fxRejected = false;
  try { await A.waitFor('error-msg', () => true, 1200); fxRejected = true; } catch {}
  assert.equal(fxRejected, true, 'name-glow rejected below its level');

  // Profile payload carries the applied banner + the gating level.
  A.emit('get-user-profile', { userId: ids.alice });
  const prof = await A.waitFor('user-profile', p => p && p.id === ids.alice);
  assert.equal(prof.profileBanner, 'grad-aurora', 'profile returns chosen banner');
  // Level is derived from XP (MEE6 curve), not the stored column; the seed puts
  // Alice in the gradient tier (>=5) but below the animated tier (<15).
  assert.ok(prof.level >= 5 && prof.level < 15, 'profile returns the gating level (gradient tier): ' + prof.level);

  // DB persisted only the allowed banner (not the locked one).
  const db = new Database(path.join(dataDir, 'haven.db'), { readonly: true });
  const row = db.prepare('SELECT profile_banner, name_effect FROM users WHERE id=?').get(ids.alice);
  db.close();
  assert.equal(row.profile_banner, 'grad-aurora');
  assert.equal(row.name_effect, null, 'locked name effect never stored');
});
