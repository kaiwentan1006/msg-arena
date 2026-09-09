// Referral ranks: the inviter is rewarded with XP for members who joined via
// their invite links, once each (lazily on connect), and it surfaces on the
// player card + the recruiters leaderboard.
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

const JWT_SECRET = 'r'.repeat(64);
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

test('referral ranks: inviter rewarded once per recruit; surfaces on card + leaderboard', async (t) => {
  const root = path.resolve(__dirname, '..');
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'haven-ref-'));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = { ...process.env, HAVEN_DATA_DIR: dataDir, FORCE_HTTP: 'true', HOST: '127.0.0.1', JWT_SECRET, PORT: String(port) };

  const seed = spawnSync(process.execPath, ['-e', `
    const { initDatabase } = require('./src/database');
    const db = initDatabase();
    const alice = db.prepare("INSERT INTO users (username,password_hash,display_name) VALUES ('alice','x','Alice')").run().lastInsertRowid;
    const bob   = db.prepare("INSERT INTO users (username,password_hash,display_name) VALUES ('bob','x','Bob')").run().lastInsertRowid;
    const carol = db.prepare("INSERT INTO users (username,password_hash,display_name) VALUES ('carol','x','Carol')").run().lastInsertRowid;
    // Alice created an invite code; bob and carol joined through it.
    const ic = db.prepare("INSERT INTO invite_codes (code,created_by) VALUES ('alicecode',?)").run(alice).lastInsertRowid;
    const use = db.prepare('INSERT INTO invite_code_uses (invite_code_id,user_id) VALUES (?,?)');
    use.run(ic, bob); use.run(ic, carol);
    require('fs').writeFileSync(require('path').join(process.env.HAVEN_DATA_DIR,'ids.json'), JSON.stringify({ alice:Number(alice), bob:Number(bob) }));
    db.close();
  `], { cwd: root, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, seed.stderr || seed.stdout);
  const ids = JSON.parse(await fs.promises.readFile(path.join(dataDir, 'ids.json'), 'utf8'));
  const tok = (id, u) => jwt.sign({ id, username: u, pwv: 1 }, JWT_SECRET);

  let logs = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', c => logs += c); child.stderr.on('data', c => logs += c);
  let A;
  t.after(async () => { A?.close(); if (child.exitCode === null) child.kill('SIGTERM'); await sleep(300); await fs.promises.rm(dataDir, { recursive: true, force: true }).catch(() => {}); });
  await waitForServer(`${baseUrl}/api/health`, child, () => logs);

  // Alice connects → should be rewarded for her 2 recruits.
  A = connectSocket(baseUrl, tok(ids.alice, 'alice')); await A.ready;
  const ref = await A.waitFor('xp-referral', p => p && p.newReferrals > 0);
  assert.equal(ref.newReferrals, 2, 'rewarded for both recruits at once');
  assert.equal(ref.totalReferrals, 2);
  assert.ok(ref.xp >= 200, 'got referral XP (>=100 each)');

  // DB records they were rewarded (so it never double-pays).
  const db = new Database(path.join(dataDir, 'haven.db'), { readonly: true });
  const rewarded = db.prepare('SELECT referral_rewarded FROM users WHERE id=?').get(ids.alice).referral_rewarded;
  db.close();
  assert.equal(rewarded, 2, 'referral_rewarded persisted');

  // Player card shows the referral count.
  A.emit('get-player-card', { userId: ids.alice });
  const card = await A.waitFor('player-card', p => p && p.userId === ids.alice);
  assert.equal(card.referrals, 2, 'player card referral count');

  // Recruiters leaderboard has Alice on top with 2.
  A.emit('get-leaderboards', {});
  const lb = await A.waitFor('leaderboards', p => p && Array.isArray(p.recruiters));
  const top = (lb.recruiters || []).find(r => r.userId === ids.alice);
  assert.ok(top && top.count === 2, 'alice tops the recruiters board with 2');

  // Reconnect → no double reward (already rewarded).
  A.close();
  const A2 = connectSocket(baseUrl, tok(ids.alice, 'alice')); await A2.ready;
  let doubleRewarded = false;
  try { await A2.waitFor('xp-referral', () => true, 1200); doubleRewarded = true; } catch { /* expected timeout */ }
  A2.close();
  assert.equal(doubleRewarded, false, 'no second referral reward on reconnect');
});
