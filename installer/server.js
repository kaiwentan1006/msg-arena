// ═══════════════════════════════════════════════════════════
// MSG Arena — Web-based Installer Server
// Uses ONLY Node.js built-in modules (no npm install needed)
// ═══════════════════════════════════════════════════════════
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const os = require('os');

const HAVEN_DIR = path.resolve(__dirname, '..');
const IS_WIN = process.platform === 'win32';
const DATA_DIR = IS_WIN
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Haven')
  : path.join(os.homedir(), '.haven');

// ── Serve the installer HTML ──────────────────────────────
const indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

// SECURITY: the localhost-only check is not enough on its own. Any web page the
// user has open can POST to 127.0.0.1:<port> (the request still originates from
// localhost), so a malicious page could scan the ephemeral port and drive the
// installer — planting attacker-chosen admin credentials. Reject cross-origin
// mutating requests: a browser always sends Origin on a cross-origin POST, and
// Sec-Fetch-Site marks anything not same-origin. Non-browser clients (curl) send
// neither and stay allowed, still bound by the localhost gate above.
function isSameOriginPost(req) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser caller; localhost gate already applied
  try {
    const u = new URL(origin);
    const port = server.address() ? String(server.address().port) : '';
    return (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && u.port === port;
  } catch { return false; }
}

// ── HTTP Server ───────────────────────────────────────────
const server = http.createServer((req, res) => {
  // Only allow localhost connections
  const host = req.socket.remoteAddress;
  if (host !== '127.0.0.1' && host !== '::1' && host !== '::ffff:127.0.0.1') {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(indexHtml);
    return;
  }

  if (req.method === 'GET' && req.url === '/api/check') {
    let nodeVersion = '';
    try { nodeVersion = process.version; } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      platform: process.platform,
      nodeVersion,
      dataDir: DATA_DIR,
      alreadyInstalled: fs.existsSync(path.join(DATA_DIR, '.tunnel_configured'))
    }));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/install') {
    if (!isSameOriginPost(req)) { res.writeHead(403); res.end('Forbidden'); return; }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let config;
      try { config = JSON.parse(body); } catch {
        res.writeHead(400); res.end('Bad JSON'); return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      runInstall(config, res);
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/launch') {
    if (!isSameOriginPost(req)) { res.writeHead(403); res.end('Forbidden'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    launchHaven();
    return;
  }

  res.writeHead(404); res.end('Not found');
});

// ── Pick a random available port and start ────────────────
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}`;
  console.log(`\n  MSG Arena Installer running at ${url}\n`);

  // Open browser
  try {
    if (IS_WIN) {
      spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    } else {
      spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
    }
  } catch {
    console.log(`  Open this URL in your browser: ${url}`);
  }
});

// ── SSE helper ────────────────────────────────────────────
function send(res, data) {
  try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
}

// ── Run a command and return a promise ────────────────────
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd || HAVEN_DIR,
      env: { ...process.env, ...opts.env },
      shell: IS_WIN,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', err = '';
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('close', code => {
      if (code === 0) resolve(out);
      else reject(new Error(err || out || `Exit code ${code}`));
    });
    child.on('error', reject);
  });
}

// ── Installation pipeline ─────────────────────────────────
async function runInstall(config, res) {
  const { serverName, adminUser, adminPass, tunnel } = config;
  let hasError = false;

  // Validate the admin username up front. It is written into the .env and used
  // to create the admin account; an unchecked value can inject extra .env lines
  // or corrupt the file (see the replacement below). Match the server's own
  // username rules.
  if (adminUser && !/^[a-zA-Z0-9_]{1,20}$/.test(adminUser)) {
    send(res, { step: 'datadir', state: 'error', label: 'Invalid admin username (use letters, numbers, underscore; max 20)', progress: 40 });
    send(res, { done: true, error: true });
    return;
  }

  try {
    // ── Step 1: Install npm dependencies ──
    send(res, { step: 'deps', state: 'active', label: 'Installing dependencies\u2026', progress: 5 });
    try {
      const npmCmd = IS_WIN ? 'npm.cmd' : 'npm';
      const npmArgs = ['install', '--no-audit', '--no-fund'];
      if (tunnel === 'localtunnel') npmArgs.push('localtunnel');
      await run(npmCmd, npmArgs);
      send(res, { step: 'deps', state: 'done', label: 'Dependencies installed', progress: 35 });
    } catch (e) {
      send(res, { step: 'deps', state: 'error', label: 'npm install failed: ' + e.message, progress: 35 });
      hasError = true;
    }

    // ── Step 2: Create data directory ──
    send(res, { step: 'datadir', state: 'active', label: 'Creating data directory\u2026', progress: 40 });
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const envExample = path.join(HAVEN_DIR, '.env.example');
      const envDest = path.join(DATA_DIR, '.env');
      if (fs.existsSync(envExample) && !fs.existsSync(envDest)) {
        let envContent = fs.readFileSync(envExample, 'utf8');
        // Use a replacement FUNCTION, not a string: a string replacement treats
        // $&, $`, $', $n in adminUser as special, and a newline would inject
        // arbitrary .env lines. A function returns its value verbatim. adminUser
        // is also validated at the top of runInstall.
        if (adminUser) envContent = envContent.replace(/ADMIN_USERNAME=.*/, () => 'ADMIN_USERNAME=' + adminUser);
        // NOTE: intentionally NOT forcing FCM on. The old installer appended the
        // shared global relay URL plus a placeholder push key
        // ("YOUR_GLOBAL_SECRET_KEY_HERE"), which (a) made every install forward
        // message previews off-box by default and (b) was rejected by the relay
        // as an invalid key, so push silently never worked. FCM is opt-in; see
        // the FCM section in .env.example.
        fs.writeFileSync(envDest, envContent);
      }
      send(res, { step: 'datadir', state: 'done', label: 'Data directory ready', progress: 45 });
    } catch (e) {
      send(res, { step: 'datadir', state: 'error', label: 'Data dir failed: ' + e.message, progress: 45 });
      hasError = true;
    }

    // ── Step 3: Generate SSL certificate ──
    send(res, { step: 'ssl', state: 'active', label: 'Generating SSL certificate\u2026', progress: 50 });
    const certDir = path.join(DATA_DIR, 'certs');
    const certPath = path.join(certDir, 'cert.pem');
    const keyPath = path.join(certDir, 'key.pem');
    if (fs.existsSync(certPath)) {
      send(res, { step: 'ssl', state: 'done', label: 'SSL certificate exists', progress: 60 });
    } else {
      try {
        fs.mkdirSync(certDir, { recursive: true });
        // Detect local IP for SAN extension
        let localIp = '127.0.0.1';
        try {
          const nets = os.networkInterfaces();
          for (const ifaces of Object.values(nets)) {
            for (const iface of ifaces) {
              if (!iface.internal && iface.family === 'IPv4') { localIp = iface.address; break; }
            }
            if (localIp !== '127.0.0.1') break;
          }
        } catch {}

        // Always include a subjectAltName, Windows included. A cert with only
        // /CN=MSG Arena and no SAN is rejected by every current browser
        // (ERR_CERT_COMMON_NAME_INVALID), which — since WebRTC needs a secure
        // context — broke voice chat for exactly the Windows self-hosters this
        // installer targets. OpenSSL's -addext works on Windows too.
        const sanArg = ['-addext', `subjectAltName=IP:127.0.0.1,IP:${localIp},DNS:localhost`];
        await run('openssl', [
          'req', '-x509', '-newkey', 'rsa:2048',
          '-keyout', keyPath, '-out', certPath,
          '-days', '3650', '-nodes', '-subj', '/CN=MSG Arena',
          ...sanArg
        ]);
        send(res, { step: 'ssl', state: 'done', label: 'SSL certificate generated', progress: 60 });
      } catch {
        send(res, { step: 'ssl', state: 'done', label: 'Skipped (OpenSSL not found, will use HTTP)', progress: 60 });
      }
    }

    // ── Step 4: Configure server ──
    send(res, { step: 'config', state: 'active', label: 'Configuring server\u2026', progress: 65 });
    try {
      const tunnelEnabled = (tunnel === 'cloudflare' || tunnel === 'localtunnel') ? 'true' : 'false';
      const tunnelProvider = tunnel === 'cloudflare' ? 'cloudflared' :
                             tunnel === 'localtunnel' ? 'localtunnel' : '';

      // Build a configuration script that uses the project's own database module
      // Write to a temp file to avoid shell escaping issues on Windows
      const configScript = `
const { initDatabase, getDb } = require('./src/database');
initDatabase();
const db = getDb();
db.prepare("INSERT OR REPLACE INTO server_settings(key,value) VALUES('server_name',?)").run(${JSON.stringify(serverName || 'MSG Arena')});
db.prepare("INSERT OR REPLACE INTO server_settings(key,value) VALUES('tunnel_enabled',?)").run(${JSON.stringify(tunnelEnabled)});
db.prepare("INSERT OR REPLACE INTO server_settings(key,value) VALUES('tunnel_provider',?)").run(${JSON.stringify(tunnelProvider)});
${adminUser && adminPass ? `
const bcrypt = require('bcryptjs');
const hash = bcrypt.hashSync(${JSON.stringify(adminPass)}, 12);
const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(${JSON.stringify(adminUser)});
if (!existing) {
  db.prepare("INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, 1)").run(${JSON.stringify(adminUser)}, hash);
  console.log('Admin account created');
} else {
  db.prepare("UPDATE users SET is_admin = 1, password_hash = ? WHERE id = ?").run(hash, existing.id);
  console.log('Existing user promoted to admin and password updated');
}
` : ''}
`;

      const tmpScript = path.join(HAVEN_DIR, `haven-config-${Date.now()}.js`);
      fs.writeFileSync(tmpScript, configScript);
      try {
        await run('node', [tmpScript], { cwd: HAVEN_DIR });
        send(res, { step: 'config', state: 'done', label: 'Server configured', progress: 80 });
      } catch (runErr) {
        throw new Error(runErr.message || 'Run failed');
      } finally {
        // The temp script embeds the admin password in plaintext. Delete it
        // whether the run succeeded OR failed — the old code only unlinked on
        // success, leaving the password on disk after any failure.
        try { fs.unlinkSync(tmpScript); } catch {}
      }
    } catch (e) {
      send(res, { step: 'config', state: 'error', label: 'Config failed: ' + e.message, progress: 80 });
      hasError = true;
    }

    // Mark tunnel as configured
    try {
      fs.writeFileSync(path.join(DATA_DIR, '.tunnel_configured'), 'configured');
    } catch {}

    // ── Step 5: Create shortcuts (Windows only) ──
    send(res, { step: 'shortcuts', state: 'active', label: 'Creating shortcuts\u2026', progress: 85 });
    if (IS_WIN) {
      try {
        const desktop = path.join(os.homedir(), 'Desktop');
        const startMenu = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
        const batPath = path.join(HAVEN_DIR, 'Start MSG Arena.bat');

        const psScript = `
          $shell = New-Object -ComObject WScript.Shell
          $lnk = $shell.CreateShortcut('${desktop.replace(/'/g, "''")}\\\Haven.lnk')
          $lnk.TargetPath = '${batPath.replace(/'/g, "''")}'
          $lnk.WorkingDirectory = '${HAVEN_DIR.replace(/'/g, "''")}'
          $lnk.Description = 'Launch MSG Arena server'
          $lnk.Save()
          $lnk2 = $shell.CreateShortcut('${startMenu.replace(/'/g, "''")}\\\Haven.lnk')
          $lnk2.TargetPath = '${batPath.replace(/'/g, "''")}'
          $lnk2.WorkingDirectory = '${HAVEN_DIR.replace(/'/g, "''")}'
          $lnk2.Description = 'Launch MSG Arena server'
          $lnk2.Save()
        `.replace(/\n/g, '; ');

        await run('powershell.exe', ['-NoProfile', '-Command', psScript]);
        send(res, { step: 'shortcuts', state: 'done', label: 'Desktop & Start Menu shortcuts created', progress: 95 });
      } catch {
        send(res, { step: 'shortcuts', state: 'done', label: 'Shortcuts skipped', progress: 95 });
      }
    } else {
      // Linux: create a .desktop file if the desktop directory exists
      try {
        const desktopDir = path.join(os.homedir(), 'Desktop');
        const appsDir = path.join(os.homedir(), '.local', 'share', 'applications');
        const startSh = path.join(HAVEN_DIR, 'start.sh');

        const desktopEntry = [
          '[Desktop Entry]',
          'Type=Application',
          'Name=MSG Arena',
          'Comment=Launch MSG Arena private chat server',
          `Exec=bash "${startSh}"`,
          `Path=${HAVEN_DIR}`,
          'Terminal=true',
          'Categories=Network;Chat;',
          ''
        ].join('\n');

        if (fs.existsSync(desktopDir)) {
          const dFile = path.join(desktopDir, 'MSG Arena.desktop');
          fs.writeFileSync(dFile, desktopEntry);
          try { fs.chmodSync(dFile, 0o755); } catch {}
        }
        fs.mkdirSync(appsDir, { recursive: true });
        fs.writeFileSync(path.join(appsDir, 'MSG Arena.desktop'), desktopEntry);

        send(res, { step: 'shortcuts', state: 'done', label: 'Application shortcut created', progress: 95 });
      } catch {
        send(res, { step: 'shortcuts', state: 'done', label: 'Shortcuts skipped', progress: 95 });
      }
    }

    send(res, { progress: 100, done: true, error: hasError });
  } catch (e) {
    send(res, { done: true, error: true, message: e.message });
  }
  res.end();
}

// ── Launch MSG Arena server ───────────────────────────────────
function launchHaven() {
  setTimeout(() => {
    if (IS_WIN) {
      // Launch Start MSG Arena.bat in a new console window
      const batPath = path.join(HAVEN_DIR, 'Start MSG Arena.bat');
      spawn('cmd', ['/c', 'start', '', 'cmd', '/c', batPath], {
        cwd: HAVEN_DIR,
        stdio: 'ignore',
        detached: true
      }).unref();
    } else {
      // Launch start.sh
      const shPath = path.join(HAVEN_DIR, 'start.sh');
      spawn('bash', [shPath], {
        cwd: HAVEN_DIR,
        stdio: 'ignore',
        detached: true
      }).unref();
    }

    // Shut down installer server after a brief delay
    setTimeout(() => {
      server.close();
      process.exit(0);
    }, 2000);
  }, 500);
}
