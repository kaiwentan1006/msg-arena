'use strict';

// Regression test for the TOTP-bypass in POST /api/auth/change-password-required.
//
// Before the fix, that endpoint used a raw jwt.verify and accepted the
// short-lived 'totp_challenge' token that /login issues BEFORE the second
// factor — so an attacker holding only a password could overwrite the password
// and receive a full session, skipping TOTP entirely. It also never checked
// password_version (revoked/stale tokens still worked) nor must_change_password
// (it doubled as a passwordless change path).
//
// This test spins up the real server against a throwaway data dir and asserts
// both that the attack is refused and that the legitimate forced-change flow
// (including the #5300 "submit original password to cancel the reset" escape
// hatch) still works.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const JWT_SECRET = 'c'.repeat(64);

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForServer(url, child, output) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early:\n${output()}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not become ready:\n${output()}`);
}

function sessionToken(user) {
  // Shape matches what /login and /totp/validate issue.
  return jwt.sign(
    { id: user.id, username: user.username, isAdmin: !!user.isAdmin, displayName: user.username, pwv: user.pwv },
    JWT_SECRET
  );
}

function challengeToken(id) {
  // Shape matches generateTotpChallengeToken in src/auth.js.
  return jwt.sign({ id, purpose: 'totp_challenge', mustChangePassword: false, cancelTempReset: false }, JWT_SECRET, { expiresIn: '5m' });
}

function connectToken(id) {
  // Shape matches generateConnectToken — a URL-borne linking token that must
  // never be accepted as a session.
  return jwt.sign({ id, scope: 'connect', provider: 'steam', pwv: 1 }, JWT_SECRET, { expiresIn: '5m' });
}

async function post(baseUrl, token, body) {
  const res = await fetch(`${baseUrl}/api/auth/change-password-required`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

test('change-password-required refuses the TOTP-bypass and honours the real forced-change flow', async t => {
  const root = path.resolve(__dirname, '..');
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'haven-cpr-'));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    HAVEN_DATA_DIR: dataDir,
    FORCE_HTTP: 'true',
    HOST: '127.0.0.1',
    JWT_SECRET,
    PORT: String(port)
  };

  const ORIGINAL_PW = 'original-password-123';
  const victimHash = bcrypt.hashSync(ORIGINAL_PW, 4);   // low cost — this is a test
  const resetTempHash = bcrypt.hashSync('temp-pw-000', 4);

  const seed = spawnSync(process.execPath, ['-e', `
    const bcrypt = require('bcryptjs');
    const { initDatabase } = require('./src/database');
    const db = initDatabase();
    const ins = db.prepare("INSERT INTO users (username, password_hash, display_name, is_admin, totp_enabled, must_change_password, temp_password_hash) VALUES (?, ?, ?, ?, ?, ?, ?)");
    // victim: TOTP on, NO pending reset — the account the bypass targets
    const victim = ins.run('victim', ${JSON.stringify(victimHash)}, 'Victim', 1, 1, 0, null);
    // resetnew: pending admin reset, will set a brand-new password
    const resetnew = ins.run('resetnew', ${JSON.stringify(victimHash)}, 'ResetNew', 0, 0, 1, ${JSON.stringify(resetTempHash)});
    // resetkeep: pending admin reset, will cancel it by proving the original pw
    const resetkeep = ins.run('resetkeep', ${JSON.stringify(victimHash)}, 'ResetKeep', 0, 0, 1, ${JSON.stringify(resetTempHash)});
    const out = { victim: Number(victim.lastInsertRowid), resetnew: Number(resetnew.lastInsertRowid), resetkeep: Number(resetkeep.lastInsertRowid) };
    require('fs').writeFileSync(require('path').join(process.env.HAVEN_DATA_DIR, 'ids.json'), JSON.stringify(out));
    db.close();
  `], { cwd: root, env, encoding: 'utf8' });
  assert.equal(seed.status, 0, seed.stderr || seed.stdout);

  const ids = JSON.parse(await fs.promises.readFile(path.join(dataDir, 'ids.json'), 'utf8'));

  let logs = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', c => { logs += c; });
  child.stderr.on('data', c => { logs += c; });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.race([
      child.exitCode === null ? new Promise(r => child.once('exit', r)) : Promise.resolve(),
      new Promise(r => setTimeout(r, 3000))
    ]);
    await fs.promises.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });
  await waitForServer(`${baseUrl}/api/health`, child, () => logs);

  const db = new Database(path.join(dataDir, 'haven.db'));
  t.after(() => db.close());
  const hashOf = id => db.prepare('SELECT password_hash FROM users WHERE id = ?').get(id).password_hash;
  const rowOf = id => db.prepare('SELECT password_version, must_change_password, temp_password_hash FROM users WHERE id = ?').get(id);

  // ── 1. The exploit: a totp_challenge token must be refused ──────────────
  const victimHashBefore = hashOf(ids.victim);
  const exploit = await post(baseUrl, challengeToken(ids.victim), { newPassword: 'attacker-owned-999' });
  assert.equal(exploit.status, 401, 'challenge token must be rejected');
  assert.equal(hashOf(ids.victim), victimHashBefore, 'victim password must be unchanged');

  // ── 1b. A connect-scoped token must not work as a session either ───────
  const connectExploit = await post(baseUrl, connectToken(ids.victim), { newPassword: 'attacker-owned-888' });
  assert.equal(connectExploit.status, 401, 'connect-scoped token must be rejected for session use');
  assert.equal(hashOf(ids.victim), victimHashBefore, 'victim password still unchanged');

  // ── 2. A full session token whose account has no pending reset → 403 ────
  const noReset = await post(baseUrl, sessionToken({ id: ids.victim, username: 'victim', isAdmin: false, pwv: 1 }), { newPassword: 'whatever-123' });
  assert.equal(noReset.status, 403, 'no pending reset must be refused');
  assert.equal(hashOf(ids.victim), victimHashBefore, 'victim password still unchanged');

  // ── 3. password_version enforcement: a stale token (wrong pwv) → 401 ────
  const stale = await post(baseUrl, sessionToken({ id: ids.resetnew, username: 'resetnew', isAdmin: false, pwv: 999 }), { newPassword: 'whatever-123' });
  assert.equal(stale.status, 401, 'stale pwv must be rejected');

  // ── 4. Legit forced change: valid session token + pending reset → 200 ──
  const newPwHashBefore = hashOf(ids.resetnew);
  const legit = await post(baseUrl, sessionToken({ id: ids.resetnew, username: 'resetnew', isAdmin: false, pwv: 1 }), { newPassword: 'brand-new-password-123' });
  assert.equal(legit.status, 200, `legit forced change should succeed: ${JSON.stringify(legit.json)}`);
  assert.ok(legit.json.token, 'a fresh session token is returned');
  assert.equal(legit.json.preserved, false);
  const afterNew = rowOf(ids.resetnew);
  assert.equal(afterNew.must_change_password, 0, 'flag cleared');
  assert.equal(afterNew.temp_password_hash, null, 'temp hash cleared');
  assert.equal(afterNew.password_version, 2, 'password_version bumped');
  assert.notEqual(hashOf(ids.resetnew), newPwHashBefore, 'password hash changed');
  assert.ok(bcrypt.compareSync('brand-new-password-123', hashOf(ids.resetnew)), 'new password takes effect');

  // ── 5. Legit escape hatch: submit the ORIGINAL password to cancel reset ─
  const keepHashBefore = hashOf(ids.resetkeep);
  const preserve = await post(
    baseUrl,
    sessionToken({ id: ids.resetkeep, username: 'resetkeep', isAdmin: false, pwv: 1 }),
    { oldPassword: ORIGINAL_PW }
  );
  assert.equal(preserve.status, 200, `escape hatch should succeed: ${JSON.stringify(preserve.json)}`);
  assert.equal(preserve.json.preserved, true, 'reset cancelled, password preserved');
  const afterKeep = rowOf(ids.resetkeep);
  assert.equal(afterKeep.must_change_password, 0, 'flag cleared');
  assert.equal(afterKeep.temp_password_hash, null, 'temp hash cleared');
  assert.equal(hashOf(ids.resetkeep), keepHashBefore, 'original password hash untouched');

  // ── 6. Escape hatch rejects a WRONG original password ──────────────────
  // resetkeep no longer has a pending reset, so use a fresh probe: re-arm one.
  db.prepare("UPDATE users SET must_change_password = 1, temp_password_hash = ? WHERE id = ?").run(resetTempHash, ids.resetkeep);
  const wrongOld = await post(
    baseUrl,
    sessionToken({ id: ids.resetkeep, username: 'resetkeep', isAdmin: false, pwv: 2 }),
    { oldPassword: 'not-the-right-one' }
  );
  assert.equal(wrongOld.status, 401, 'wrong original password must be rejected');
});
