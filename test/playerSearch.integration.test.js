// Player discovery search: filter members by game + country + language + online,
// with per-game rank; plus the profile-field setters it relies on.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');

const JWT_SECRET = 'p'.repeat(64);
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
function connectSocket(baseUrl, token) {
  const url = baseUrl.replace(/^http/, 'ws') + '/socket.io/?EIO=4&transport=websocket';
  const ws = new WebSocket(url);
  const events = []; const waiters = [];
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

test('player discovery search: game/country/language/online filters + rank + profile setters', async (t) => {
  const root = path.resolve(__dirname, '..');
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'haven-ps-'));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = { ...process.env, HAVEN_DATA_DIR: dataDir, FORCE_HTTP: 'true', HOST: '127.0.0.1', JWT_SECRET, PORT: String(port) };

  const seed = spawnSync(process.execPath, ['-e', `
    const { initDatabase } = require('./src/database');
    const db = initDatabase();
    const mk = (u, c, l) => db.prepare("INSERT INTO users (username,password_hash,display_name,country,languages,status) VALUES (?,?,?,?,?, 'online')").run(u,'x',u,c,l).lastInsertRowid;
    const alice = mk('alice','DE','en,de');
    const bob   = mk('bob','DE','de');
    const carol = mk('carol','US','en');
    const games = db.prepare("SELECT id FROM games WHERE is_active=1 ORDER BY id LIMIT 2").all();
    const g1 = games[0].id, g2 = games[1].id;
    const ug = db.prepare('INSERT INTO user_games (user_id,game_id,rank) VALUES (?,?,?)');
    ug.run(alice, g1, 'Radiant'); ug.run(bob, g1, null); ug.run(carol, g2, 'Global');
    require('fs').writeFileSync(require('path').join(process.env.HAVEN_DATA_DIR,'ids.json'), JSON.stringify({ alice:Number(alice), bob:Number(bob), carol:Number(carol), g1, g2 }));
    db.close();
  `], { cwd: root, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, seed.stderr || seed.stdout);
  const ids = JSON.parse(await fs.promises.readFile(path.join(dataDir, 'ids.json'), 'utf8'));
  const tok = (id, u) => jwt.sign({ id, username: u, pwv: 1 }, JWT_SECRET);

  let logs = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', c => logs += c); child.stderr.on('data', c => logs += c);
  let A, C;
  t.after(async () => { A?.close(); C?.close(); if (child.exitCode === null) child.kill('SIGTERM'); await sleep(300); await fs.promises.rm(dataDir, { recursive: true, force: true }).catch(() => {}); });
  await waitForServer(`${baseUrl}/api/health`, child, () => logs);

  // alice + carol are ONLINE (connected sockets); bob is offline (no socket).
  A = connectSocket(baseUrl, tok(ids.alice, 'alice')); await A.ready;
  C = connectSocket(baseUrl, tok(ids.carol, 'carol')); await C.ready;
  await sleep(300);

  const search = (q) => { A.emit('players:search', q); return A.waitFor('players:search', p => {
    const f = p.filters || {};
    return (f.gameId || null) === (q.gameId || null)
        && (f.country || null) === (q.country || null)
        && (f.language || null) === (q.language || null)
        && !!f.onlineOnly === !!q.onlineOnly;
  }); };

  // by game g1 → alice + bob (both play it), regardless of online
  let r = await search({ gameId: ids.g1 });
  let byId = Object.fromEntries(r.players.map(p => [p.userId, p]));
  assert.ok(byId[ids.alice] && byId[ids.bob] && !byId[ids.carol], 'game filter returns g1 players only');
  assert.equal(byId[ids.alice].online, true, 'alice online (connected)');
  assert.equal(byId[ids.bob].online, false, 'bob offline (no socket)');
  const aliceGame = (byId[ids.alice].games || []).find(g => g.rank);
  assert.equal(aliceGame && aliceGame.rank, 'Radiant', 'per-game rank surfaced');

  // by country DE → alice + bob
  r = await search({ country: 'DE' });
  byId = Object.fromEntries(r.players.map(p => [p.userId, p]));
  assert.ok(byId[ids.alice] && byId[ids.bob] && !byId[ids.carol], 'country filter');

  // by language en → alice + carol
  r = await search({ language: 'en' });
  byId = Object.fromEntries(r.players.map(p => [p.userId, p]));
  assert.ok(byId[ids.alice] && byId[ids.carol] && !byId[ids.bob], 'language filter');

  // online only → alice + carol (bob has no socket)
  r = await search({ onlineOnly: true });
  byId = Object.fromEntries(r.players.map(p => [p.userId, p]));
  assert.ok(byId[ids.alice] && byId[ids.carol] && !byId[ids.bob], 'onlineOnly excludes offline members');

  // combined: g1 + DE + online → alice only (bob offline)
  r = await search({ gameId: ids.g1, country: 'DE', onlineOnly: true });
  const set = new Set(r.players.map(p => p.userId));
  assert.ok(set.has(ids.alice) && !set.has(ids.bob) && !set.has(ids.carol), 'combined filters intersect');

  // profile setters round-trip
  A.emit('set-country', { country: 'fr' });
  const pu1 = await A.waitFor('profile-updated', p => 'country' in p);
  assert.equal(pu1.country, 'FR', 'country upper-cased + saved');
  A.emit('set-languages', { languages: 'EN, fr , xx1, es' });
  const pu2 = await A.waitFor('profile-updated', p => 'languages' in p);
  assert.equal(pu2.languages, 'en,fr,es', 'languages normalized + junk dropped');

  // games:set-rank round-trip
  A.emit('games:set-rank', { gameId: ids.g1, rank: 'Immortal' });
  const mine = await A.waitFor('games:mine', p => p.userId === ids.alice);
  const g = mine.games.find(x => x.id === ids.g1);
  assert.equal(g && g.rank, 'Immortal', 'rank updated via games:set-rank');
});
