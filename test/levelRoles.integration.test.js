// Level role rewards, end to end over a real socket:
//   admin configures "level N → role" → members already at that level get the
//   role (backfill) and it's granted on future level-ups; a non-admin can't.
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
const { totalXpForLevel } = require('../src/xp');

const JWT_SECRET = 'l'.repeat(64);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function availablePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
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
// Minimal authed Socket.IO client over ws, WITH ack support.
function connectSocket(baseUrl, token) {
  const url = baseUrl.replace(/^http/, 'ws') + '/socket.io/?EIO=4&transport=websocket';
  const ws = new WebSocket(url);
  let ackId = 0; const acks = {};
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket connect timeout')), 6000);
    ws.on('message', raw => {
      const pkt = raw.toString();
      if (pkt === '2') return ws.send('3');
      if (pkt.startsWith('0')) return ws.send('40' + JSON.stringify({ token }));
      if (pkt.startsWith('44')) { clearTimeout(timer); return reject(new Error('auth failed: ' + pkt)); }
      if (pkt.startsWith('40')) { clearTimeout(timer); return resolve(); }
      if (pkt.startsWith('43')) {
        const m = pkt.match(/^43(\d+)(.*)$/);
        if (m && acks[m[1]]) { const args = JSON.parse(m[2] || '[]'); acks[m[1]](args[0]); delete acks[m[1]]; }
      }
    });
    ws.once('error', reject);
  });
  return {
    ready,
    emitAck(event, payload) {
      const id = ackId++;
      return new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error('ack timeout for ' + event)), 5000);
        acks[id] = (res) => { clearTimeout(to); resolve(res); };
        ws.send('42' + id + JSON.stringify([event, payload]));
      });
    },
    close() { try { ws.terminate(); } catch {} },
  };
}

test('level role rewards: admin configures + backfills; non-admin blocked', async (t) => {
  const root = path.resolve(__dirname, '..');
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'haven-lr-'));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = { ...process.env, HAVEN_DATA_DIR: dataDir, FORCE_HTTP: 'true', HOST: '127.0.0.1', JWT_SECRET, PORT: String(port) };

  const seed = spawnSync(process.execPath, ['-e', `
    const { initDatabase } = require('./src/database');
    const db = initDatabase();
    const admin = db.prepare("INSERT INTO users (username,password_hash,display_name,is_admin) VALUES ('admin','x','Admin',1)").run().lastInsertRowid;
    const bob   = db.prepare("INSERT INTO users (username,password_hash,display_name) VALUES ('bob','x','Bob')").run().lastInsertRowid;
    const role  = db.prepare("INSERT INTO roles (name,level,scope,color) VALUES ('Regular',10,'server','#22d3ee')").run().lastInsertRowid;
    // Bob is already at level 3; admin at 0.
    db.prepare('INSERT INTO user_xp (user_id,xp,level) VALUES (?,?,?)').run(bob, ${totalXpForLevel ? 'require("./src/xp").totalXpForLevel(3)' : 300}, 3);
    require('fs').writeFileSync(require('path').join(process.env.HAVEN_DATA_DIR,'ids.json'), JSON.stringify({ admin:Number(admin), bob:Number(bob), role:Number(role) }));
    db.close();
  `], { cwd: root, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, seed.stderr || seed.stdout);
  const ids = JSON.parse(await fs.promises.readFile(path.join(dataDir, 'ids.json'), 'utf8'));
  const tokAdmin = jwt.sign({ id: ids.admin, username: 'admin', pwv: 1 }, JWT_SECRET);
  const tokBob = jwt.sign({ id: ids.bob, username: 'bob', pwv: 1 }, JWT_SECRET);

  let logs = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', c => logs += c); child.stderr.on('data', c => logs += c);
  let A, B;
  t.after(async () => {
    A?.close(); B?.close();
    if (child.exitCode === null) child.kill('SIGTERM');
    await sleep(300);
    await fs.promises.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });
  await waitForServer(`${baseUrl}/api/health`, child, () => logs);

  A = connectSocket(baseUrl, tokAdmin); await A.ready;
  B = connectSocket(baseUrl, tokBob); await B.ready;

  // Non-admin cannot configure level roles.
  const denied = await B.emitAck('xp:set-level-role', { level: 2, roleId: ids.role });
  assert.ok(denied && denied.error, 'non-admin is refused');

  // Admin sets "level 2 → Regular"; Bob (level 3) is backfilled.
  const setRes = await A.emitAck('xp:set-level-role', { level: 2, roleId: ids.role });
  assert.equal(setRes.ok, true);
  assert.ok(setRes.granted >= 1, 'at least one existing member backfilled');
  assert.ok(setRes.levelRoles.some(lr => lr.level === 2 && lr.roleId === ids.role));

  // Verify in the DB that Bob actually holds the role now.
  const db = new Database(path.join(dataDir, 'haven.db'), { readonly: true });
  const has = db.prepare('SELECT 1 FROM user_roles WHERE user_id=? AND role_id=? AND channel_id IS NULL').get(ids.bob, ids.role);
  db.close();
  assert.ok(has, 'Bob was granted the level role by backfill');

  // List + remove.
  const list = await A.emitAck('xp:list-level-roles', {});
  assert.equal(list.levelRoles.length, 1);
  const rm = await A.emitAck('xp:remove-level-role', { level: 2 });
  assert.equal(rm.ok, true);
  assert.equal(rm.levelRoles.length, 0);
});
