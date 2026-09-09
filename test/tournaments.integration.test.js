'use strict';

// End-to-end tournaments test over raw Socket.IO (like lfg.integration.test.js):
//  - single elimination: admin creates → two players join → start → one reports,
//    the other confirms → bracket completes with the right champion.
//  - ladder: report a head-to-head, opponent confirms → ELO ratings move.

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

test('tournaments: single-elim + ladder end to end', async t => {
  const root = path.resolve(__dirname, '..');
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'haven-tourney-'));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = { ...process.env, HAVEN_DATA_DIR: dataDir, FORCE_HTTP: 'true', HOST: '127.0.0.1', JWT_SECRET, PORT: String(port) };

  const seed = spawnSync(process.execPath, ['-e', `
    const { initDatabase } = require('./src/database');
    const db = initDatabase();
    const mk = (u,admin) => db.prepare("INSERT INTO users (username, password_hash, display_name, is_admin) VALUES (?,?,?,?)").run(u,'x',u,admin?1:0).lastInsertRowid;
    const alice = mk('alice', true);   // organiser (admin ⇒ manage_tournaments)
    const bob = mk('bob', false);
    const carol = mk('carol', false);
    const userRole = db.prepare("SELECT id FROM roles WHERE name='User'").get();
    const ins = db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)');
    [alice,bob,carol].forEach(id => userRole && ins.run(id, userRole.id));
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

  // ── Single elimination ──
  A.emit('tourney:create', { name: 'Launch Cup', format: 'single_elim', maxParticipants: 4 });
  const created = await B.waitFor('tourney:updated', p => p.tournament.name === 'Launch Cup');
  const tid = created.tournament.id;
  assert.equal(created.tournament.status, 'open');

  B.emit('tourney:join', { id: tid });
  await A.waitFor('tourney:updated', p => p.tournament.id === tid && p.tournament.participants.some(x => x.id === ids.bob));
  C.emit('tourney:join', { id: tid });
  await A.waitFor('tourney:updated', p => p.tournament.id === tid && p.tournament.participants.length === 2);

  A.emit('tourney:start', { id: tid });
  const live = await B.waitFor('tourney:updated', p => p.tournament.id === tid && p.tournament.status === 'live');
  const match = live.tournament.matches.find(m => m.status === 'pending' && m.aId && m.bId);
  assert.ok(match, 'a playable match was materialised');
  assert.deepEqual([match.aId, match.bId].sort(), [ids.bob, ids.carol].sort());

  // Bob (a normal participant) reports; it must NOT be final yet.
  B.emit('tourney:report', { matchId: match.id, winnerId: ids.bob });
  const reported = await C.waitFor('tourney:updated', p => p.tournament.matches.some(m => m.id === match.id && m.status === 'reported'));
  assert.equal(reported.tournament.status, 'live', 'still live — needs the opponent to confirm');

  // Carol confirms → bracket completes with Bob as champion.
  C.emit('tourney:confirm', { matchId: match.id });
  const done = await A.waitFor('tourney:updated', p => p.tournament.id === tid && p.tournament.status === 'complete');
  assert.equal(done.tournament.championId, ids.bob);

  // ── Ladder ──
  A.emit('tourney:create', { name: 'Ranked Ladder', format: 'ladder', maxParticipants: 8 });
  const lad = await B.waitFor('tourney:updated', p => p.tournament.name === 'Ranked Ladder');
  const lid = lad.tournament.id;
  B.emit('tourney:join', { id: lid });
  await A.waitFor('tourney:updated', p => p.tournament.id === lid && p.tournament.participants.some(x => x.id === ids.bob));
  C.emit('tourney:join', { id: lid });
  await A.waitFor('tourney:updated', p => p.tournament.id === lid && p.tournament.participants.length === 2);
  A.emit('tourney:start', { id: lid });
  await B.waitFor('tourney:updated', p => p.tournament.id === lid && p.tournament.status === 'live');

  // Bob reports beating Carol; Carol confirms → ratings move (winner up, loser down).
  B.emit('tourney:ladder-report', { id: lid, opponentId: ids.carol, winnerId: ids.bob });
  const lreport = await C.waitFor('tourney:updated', p => p.tournament.id === lid && p.tournament.matches.some(m => m.status === 'reported'));
  const lmatch = lreport.tournament.matches.find(m => m.status === 'reported');
  C.emit('tourney:confirm', { matchId: lmatch.id });
  const lfinal = await A.waitFor('tourney:updated', p => p.tournament.id === lid && p.tournament.matches.some(m => m.id === lmatch.id && m.status === 'confirmed'));
  const bob = lfinal.tournament.participants.find(x => x.id === ids.bob);
  const carol = lfinal.tournament.participants.find(x => x.id === ids.carol);
  assert.equal(bob.rating, 1016, 'winner gains 16 from an even start');
  assert.equal(carol.rating, 984, 'loser drops 16');
  assert.equal(bob.wins, 1);
  assert.equal(carol.losses, 1);

  // ── Double elimination (with a grand-final reset) ──
  A.emit('tourney:create', { name: 'DE Cup', format: 'double_elim', maxParticipants: 4 });
  const de = await B.waitFor('tourney:updated', p => p.tournament.name === 'DE Cup');
  const did = de.tournament.id;
  B.emit('tourney:join', { id: did });
  await A.waitFor('tourney:updated', p => p.tournament.id === did && p.tournament.participants.some(x => x.id === ids.bob));
  C.emit('tourney:join', { id: did });
  await A.waitFor('tourney:updated', p => p.tournament.id === did && p.tournament.participants.length === 2);
  A.emit('tourney:start', { id: did });
  const dlive = await B.waitFor('tourney:updated', p => p.tournament.id === did && p.tournament.status === 'live');

  const reportConfirm = async (matchId, winnerId) => {
    B.emit('tourney:report', { matchId, winnerId });
    await C.waitFor('tourney:updated', p => p.tournament.matches.some(m => m.id === matchId && m.status === 'reported'));
    C.emit('tourney:confirm', { matchId });
  };
  const readyGF = (tourn) => tourn.matches.find(m => m.seg === 'GF' && m.status === 'pending' && m.aId && m.bId);

  // WB final (bob vs carol) → bob wins; carol drops to the grand final.
  const wbm = dlive.tournament.matches.find(m => m.status === 'pending' && m.aId && m.bId);
  await reportConfirm(wbm.id, ids.bob);
  const gfState = await A.waitFor('tourney:updated', p => p.tournament.id === did && readyGF(p.tournament));
  const gfm = readyGF(gfState.tournament);

  // Carol (the losers-bracket finalist) wins GF game 1 → a reset is forced.
  await reportConfirm(gfm.id, ids.carol);
  const resetState = await A.waitFor('tourney:updated', p => {
    if (p.tournament.id !== did || p.tournament.status !== 'live') return false;
    const r = readyGF(p.tournament); return r && r.id !== gfm.id;
  });
  const rm = readyGF(resetState.tournament);
  assert.ok(rm && rm.id !== gfm.id, 'a reset match was created');

  // Carol wins the reset → champion.
  await reportConfirm(rm.id, ids.carol);
  const deDone = await A.waitFor('tourney:updated', p => p.tournament.id === did && p.tournament.status === 'complete');
  assert.equal(deDone.tournament.championId, ids.carol, 'the reset winner is the champion');
});
