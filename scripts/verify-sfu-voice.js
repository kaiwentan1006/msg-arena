'use strict';

/**
 * End-to-end SFU voice certification (needs Chrome; NOT part of `npm test`).
 *
 * Boots a throwaway MSG Arena server, seeds two members of a voice channel with
 * SFU mode ON, launches TWO headless Chrome instances with FAKE microphones,
 * has both join the voice channel, and verifies each browser receives the
 * OTHER's live audio track through the in-process werift SFU. This exercises the
 * real media path end to end (getUserMedia → SFU publish → forward → playback)
 * that unit tests can't reach.
 *
 *   node scripts/verify-sfu-voice.js
 *   CHROME_PATH="C:/path/to/chrome.exe" node scripts/verify-sfu-voice.js
 *
 * Exits 0 on success, 1 on failure. Chrome path defaults to the Windows install.
 */

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');
const JWT_SECRET = 'e'.repeat(64);
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function availablePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(e => e ? reject(e) : resolve(port)); });
  });
}
function getJSON(u) {
  return new Promise((res, rej) => { http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }).on('error', rej); });
}
async function waitHttp(url, ms = 12000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if ((await fetch(url)).ok) return; } catch {} await sleep(150); }
  throw new Error('server did not come up');
}

class Browser {
  constructor(port, name) { this.port = port; this.name = name; this._id = 0; this._pend = {}; }
  async launch() {
    const udir = path.join(os.tmpdir(), `sfuverify-${this.name}-${Date.now()}`);
    this.proc = spawn(CHROME, [
      '--headless=new', '--disable-gpu', '--no-sandbox',
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      `--remote-debugging-port=${this.port}`, `--user-data-dir=${udir}`, 'about:blank',
    ]);
    let list;
    for (let i = 0; i < 40; i++) { try { list = await getJSON(`http://localhost:${this.port}/json`); if (list.some(t => t.type === 'page' && t.webSocketDebuggerUrl)) break; } catch {} await sleep(250); }
    const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
    this.ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    this.ws.on('message', m => { const o = JSON.parse(m); if (o.id && this._pend[o.id]) { this._pend[o.id](o); delete this._pend[o.id]; } });
    await new Promise(r => this.ws.on('open', r));
    await this.send('Page.enable'); await this.send('Runtime.enable');
  }
  send(method, params = {}) { return new Promise((r, j) => { const i = ++this._id; const to = setTimeout(() => j(new Error(this.name + ' timeout ' + method)), 20000); this._pend[i] = o => { clearTimeout(to); r(o); }; this.ws.send(JSON.stringify({ id: i, method, params })); }); }
  async evalv(expr, awaitPromise = false) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise }); return r && r.result && r.result.result && r.result.result.value; }
  async nav(url) { await this.send('Page.navigate', { url }); }
  kill() { try { this.proc.kill('SIGKILL'); } catch {} }
}

(async () => {
  if (!fs.existsSync(CHROME)) { console.error('Chrome not found at', CHROME, '- set CHROME_PATH'); process.exit(1); }
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sfuverify-'));
  const port = await availablePort();
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, HAVEN_DATA_DIR: dataDir, FORCE_HTTP: 'true', HOST: '127.0.0.1', JWT_SECRET, PORT: String(port) };
  const code = crypto.randomBytes(4).toString('hex');

  const seed = spawnSync(process.execPath, ['-e', `
    const { initDatabase } = require('./src/database');
    const db = initDatabase();
    const a = db.prepare("INSERT INTO users (username,password_hash,display_name,is_admin) VALUES ('alice','x','Alice',1)").run().lastInsertRowid;
    const b = db.prepare("INSERT INTO users (username,password_hash,display_name,is_admin) VALUES ('bob','x','Bob',1)").run().lastInsertRowid;
    const ch = db.prepare("INSERT INTO channels (name,code,voice_enabled) VALUES ('Voice',?,1)").run(${JSON.stringify(code)}).lastInsertRowid;
    const jm = db.prepare('INSERT OR IGNORE INTO channel_members (channel_id,user_id) VALUES (?,?)');
    jm.run(ch, a); jm.run(ch, b);
    db.prepare("INSERT OR REPLACE INTO server_settings (key,value) VALUES ('sfu_enabled','true')").run();
    require('fs').writeFileSync(require('path').join(process.env.HAVEN_DATA_DIR,'ids.json'), JSON.stringify({ a:Number(a), b:Number(b) }));
    db.close();
  `], { cwd: ROOT, env, encoding: 'utf8' });
  if (seed.status !== 0) { console.error('seed failed:', seed.stderr || seed.stdout); process.exit(1); }
  const ids = JSON.parse(fs.readFileSync(path.join(dataDir, 'ids.json'), 'utf8'));
  const tokA = jwt.sign({ id: ids.a, username: 'alice', pwv: 1 }, JWT_SECRET);
  const tokB = jwt.sign({ id: ids.b, username: 'bob', pwv: 1 }, JWT_SECRET);
  const usrA = JSON.stringify({ id: ids.a, username: 'alice', displayName: 'Alice', isAdmin: true });
  const usrB = JSON.stringify({ id: ids.b, username: 'bob', displayName: 'Bob', isAdmin: true });

  const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: 'ignore' });
  let A, B, ok = false;
  const cleanup = async () => {
    try { A && A.kill(); B && B.kill(); } catch {}
    spawn('taskkill', ['/F', '/IM', 'chrome.exe', '/T']);
    try { server.kill('SIGTERM'); } catch {}
    await sleep(500);
    await fs.promises.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  };
  const timer = setTimeout(async () => { console.error('TIMEOUT'); await cleanup(); process.exit(1); }, 90000);

  try {
    await waitHttp(`${base}/api/health`);
    A = new Browser(9360, 'A'); B = new Browser(9361, 'B');
    await A.launch(); await B.launch();
    for (const [br, tok, usr] of [[A, tokA, usrA], [B, tokB, usrB]]) {
      await br.nav(`${base}/`); await sleep(1200);
      await br.evalv(`localStorage.setItem('haven_token',${JSON.stringify(tok)});localStorage.setItem('haven_user',${JSON.stringify(usr)});localStorage.removeItem('haven_theme');true`);
      await br.nav(`${base}/app`);
    }
    await sleep(9000);
    await A.evalv(`window.app.voice.join(${JSON.stringify(code)}).then(()=>1).catch(()=>0)`, true);
    await sleep(1500);
    await B.evalv(`window.app.voice.join(${JSON.stringify(code)}).then(()=>1).catch(()=>0)`, true);
    await sleep(8000);
    const probe = (otherId) => `JSON.stringify({provider:window.app.voice.provider, pc:(window.app.voice._sfuPc&&window.app.voice._sfuPc.connectionState)||'none', other: (()=>{const el=document.getElementById('voice-audio-'+${otherId});return el&&el.srcObject?el.srcObject.getAudioTracks().some(t=>t.readyState==='live'):false;})()})`;
    const a = JSON.parse(await A.evalv(probe(ids.b)));
    const b = JSON.parse(await B.evalv(probe(ids.a)));
    console.log('Alice:', a);
    console.log('Bob:  ', b);
    ok = a.provider === 'sfu' && a.pc === 'connected' && a.other && b.provider === 'sfu' && b.pc === 'connected' && b.other;
  } catch (e) {
    console.error('error:', e.message);
  }
  clearTimeout(timer);
  await cleanup();
  console.log(ok ? '\n✅ SFU voice verified end-to-end (both peers receive live audio through the SFU).' : '\n❌ SFU voice verification FAILED.');
  process.exit(ok ? 0 : 1);
})();
