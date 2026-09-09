'use strict';

// End-to-end clips test: an authed user uploads a clip (video + poster) over
// REST, it appears in the gallery, the video streams with HTTP Range support,
// the up-vote toggles, and delete removes it. Mirrors the boot/seed pattern of
// test/lfg.integration.test.js.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');
const jwt = require('jsonwebtoken');

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

// A minimal but valid single-colour PNG (used as the client-captured poster).
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

test('clips: upload → gallery → range stream → vote toggle → delete', async t => {
  const root = path.resolve(__dirname, '..');
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'haven-clips-'));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = { ...process.env, HAVEN_DATA_DIR: dataDir, FORCE_HTTP: 'true', HOST: '127.0.0.1', JWT_SECRET, PORT: String(port) };

  const seed = spawnSync(process.execPath, ['-e', `
    const { initDatabase } = require('./src/database');
    const db = initDatabase();
    const a = db.prepare("INSERT INTO users (username, password_hash, display_name) VALUES ('alice','x','Alice')").run();
    const userRole = db.prepare("SELECT id FROM roles WHERE name='User'").get();
    if (userRole) db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)').run(a.lastInsertRowid, userRole.id);
    const game = db.prepare("SELECT id, slug FROM games WHERE slug='valorant'").get();
    require('fs').writeFileSync(require('path').join(process.env.HAVEN_DATA_DIR,'ids.json'), JSON.stringify({ a:Number(a.lastInsertRowid), gameSlug: game.slug }));
    db.close();
  `], { cwd: root, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, seed.stderr || seed.stdout);
  const ids = JSON.parse(await fs.promises.readFile(path.join(dataDir, 'ids.json'), 'utf8'));
  const token = jwt.sign({ id: ids.a, username: 'alice', pwv: 1 }, JWT_SECRET);
  const auth = { Authorization: `Bearer ${token}` };

  let logs = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', c => logs += c); child.stderr.on('data', c => logs += c);
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.race([child.exitCode === null ? new Promise(r => child.once('exit', r)) : Promise.resolve(), new Promise(r => setTimeout(r, 3000))]);
    await fs.promises.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });
  await waitForServer(`${baseUrl}/api/health`, child, () => logs);

  // ── Upload a clip (video bytes are arbitrary; mime drives the filter) ──
  const videoBytes = Buffer.alloc(2048, 7); // 2 KB so the Range request is meaningful
  const fd = new FormData();
  fd.append('title', 'Ace on Ascent');
  fd.append('description', 'clutch 1v4');
  fd.append('game', ids.gameSlug);
  fd.append('durationSec', '12.5');
  fd.append('video', new Blob([videoBytes], { type: 'video/mp4' }), 'clip.mp4');
  fd.append('poster', new Blob([PNG_1PX], { type: 'image/png' }), 'poster.png');

  const upRes = await fetch(`${baseUrl}/api/clips`, { method: 'POST', headers: auth, body: fd });
  const upText = await upRes.text();
  assert.equal(upRes.status, 200, `upload failed (${upRes.status}): ${upText}\n${logs}`);
  const clip = JSON.parse(upText);
  assert.ok(Number.isInteger(clip.id), 'clip has id');
  assert.equal(clip.title, 'Ace on Ascent');
  assert.equal(clip.game.slug, 'valorant');
  assert.equal(clip.votes, 0);
  assert.equal(clip.voted, false);
  assert.equal(clip.videoUrl, `/api/clips/${clip.id}/video`);
  assert.ok(clip.posterUrl && clip.posterUrl.startsWith('/uploads/'), 'poster served from /uploads');

  // ── Gallery lists it ──
  const listRes = await fetch(`${baseUrl}/api/clips?game=valorant&sort=new`, { headers: auth });
  assert.equal(listRes.status, 200);
  const { clips } = await listRes.json();
  assert.ok(clips.some(c => c.id === clip.id), 'clip appears in gallery');

  // ── Video streams with Range support (206 + Content-Range) ──
  const full = await fetch(`${baseUrl}${clip.videoUrl}`);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  const ranged = await fetch(`${baseUrl}${clip.videoUrl}`, { headers: { Range: 'bytes=0-99' } });
  assert.equal(ranged.status, 206, 'partial content');
  assert.equal(ranged.headers.get('content-range'), `bytes 0-99/${videoBytes.length}`);
  const chunk = Buffer.from(await ranged.arrayBuffer());
  assert.equal(chunk.length, 100, 'exactly the requested 100 bytes');

  // ── Up-vote toggles on then off ──
  let voteRes = await fetch(`${baseUrl}/api/clips/${clip.id}/vote`, { method: 'POST', headers: auth });
  let vote = await voteRes.json();
  assert.equal(vote.votes, 1); assert.equal(vote.voted, true);
  voteRes = await fetch(`${baseUrl}/api/clips/${clip.id}/vote`, { method: 'POST', headers: auth });
  vote = await voteRes.json();
  assert.equal(vote.votes, 0); assert.equal(vote.voted, false);

  // ── Delete (owner) then it is gone ──
  const delRes = await fetch(`${baseUrl}/api/clips/${clip.id}`, { method: 'DELETE', headers: auth });
  assert.equal(delRes.status, 200);
  const gone = await fetch(`${baseUrl}/api/clips/${clip.id}`, { headers: auth });
  assert.equal(gone.status, 404, 'clip is gone after delete');

  // ── Unauthenticated upload is rejected ──
  const noAuth = await fetch(`${baseUrl}/api/clips`, { method: 'POST', body: new FormData() });
  assert.equal(noAuth.status, 401);
});
