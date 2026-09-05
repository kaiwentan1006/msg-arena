// ═══════════════════════════════════════════════════════════
// MSG Arena — Tunnel Manager (localtunnel / cloudflared)
// Exposes the MSG Arena server over a public URL for remote access
// ═══════════════════════════════════════════════════════════

const { spawn, spawnSync } = require('child_process');

let active = null;
let status = { active: false, url: null, provider: null, error: null };
let starting = false;

function providerAvailable(provider) {
  if (provider === 'localtunnel') {
    try { require.resolve('localtunnel'); return true; } catch { return false; }
  }
  if (provider === 'cloudflared') {
    try {
      const result = spawnSync('cloudflared', ['--version'], { stdio: 'ignore', windowsHide: true });
      return result && result.status === 0;
    } catch {
      return false;
    }
  }
  return false;
}

function getTunnelStatus() {
  return {
    ...status,
    starting,
    available: {
      localtunnel: providerAvailable('localtunnel'),
      cloudflared: providerAvailable('cloudflared')
    }
  };
}

async function stopTunnel() {
  if (!active) {
    status = { ...status, active: false, url: null };
    return true;
  }
  const current = active;
  active = null;
  try {
    if (current.type === 'localtunnel' && current.ref?.close) await current.ref.close();
    if (current.type === 'cloudflared' && current.ref && !current.ref.killed) current.ref.kill();
  } catch { /* cleanup errors are non-critical */ }
  status = { ...status, active: false, url: null };
  return true;
}

async function startTunnel(port, provider = 'localtunnel', ssl = false) {
  if (starting) return getTunnelStatus();
  starting = true;
  status = { ...status, error: null, provider };
  await stopTunnel();
  try {
    if (!providerAvailable(provider)) {
      throw new Error(provider === 'localtunnel'
        ? 'localtunnel package not installed (run: npm install localtunnel)'
        : 'cloudflared binary not found in PATH');
    }

    if (provider === 'localtunnel') {
      const localtunnel = require('localtunnel');
      const opts = { port };
      if (ssl) { opts.local_https = true; opts.allow_invalid_cert = true; }
      const tunnel = await localtunnel(opts);
      active = { type: 'localtunnel', ref: tunnel };
      status = { active: true, url: tunnel.url, provider, error: null };
      tunnel.on('close', () => {
        if (active?.ref === tunnel) {
          active = null;
          status = { ...status, active: false, url: null };
        }
      });
      tunnel.on('error', (err) => {
        status = { ...status, active: false, url: null, error: err?.message || 'Tunnel error' };
      });
      return getTunnelStatus();
    }

    // Cloudflared quick-tunnel — use HTTPS origin + skip cert verify for self-signed
    const origin = ssl ? `https://127.0.0.1:${port}` : `http://127.0.0.1:${port}`;
    const args = ['tunnel', '--url', origin, '--no-autoupdate'];
    if (ssl) args.push('--no-tls-verify');
    const proc = spawn('cloudflared', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    active = { type: 'cloudflared', ref: proc };

    const url = await new Promise((resolve, reject) => {
      let done = false;
      let stderrLog = ''; // collect stderr for better error messages
      const finalize = (val, err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        err ? reject(err) : resolve(val);
      };
      const parseLine = (data) => {
        const line = data.toString();
        // Match cloudflared tunnel URLs — both trycloudflare.com and cfargotunnel.com
        const match = line.match(/https?:\/\/[a-zA-Z0-9._-]+\.(?:trycloudflare|cfargotunnel)\.com\b/);
        if (match) return finalize(match[0]);
        // Broader fallback — but exclude known non-tunnel URLs (cloudflare.com, github.com, etc.)
        const broader = line.match(/https:\/\/[a-zA-Z0-9]+-[a-zA-Z0-9-]+\.[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
        if (broader && !broader[0].includes('127.0.0.1') && !broader[0].includes('localhost')
            && !broader[0].includes('www.cloudflare.com') && !broader[0].includes('github.com')
            && !broader[0].includes('developers.cloudflare.com')) {
          finalize(broader[0]);
        }
      };
      // Increased timeout to 90s — cloudflared can be slow on first launch or slow connections
      const timer = setTimeout(() => {
        const hint = stderrLog.includes('failed to connect')
          ? ' (cloudflared could not reach your local server — is it running?)'
          : stderrLog.includes('ERR')
            ? ` (cloudflared error: ${stderrLog.split('ERR').pop().trim().slice(0, 100)})`
            : ' (cloudflared took too long — check your internet connection)';
        finalize(null, new Error('Timed out waiting for cloudflared URL' + hint));
      }, 90000);
      proc.stdout.on('data', parseLine);
      proc.stderr.on('data', (data) => {
        stderrLog += data.toString();
        parseLine(data);
      });
      proc.on('error', (err) => finalize(null, new Error(`cloudflared failed to start: ${err.message}`)));
      proc.on('close', (code) => {
        if (!done) {
          const reason = stderrLog.includes('ERR')
            ? stderrLog.split('ERR').pop().trim().slice(0, 150)
            : `exit code ${code}`;
          finalize(null, new Error(`cloudflared exited before URL was ready (${reason})`));
        }
        if (active?.ref === proc) {
          active = null;
          status = { ...status, active: false, url: null };
        }
      });
    });

    status = { active: true, url, provider, error: null };
    return getTunnelStatus();
  } catch (err) {
    status = { active: false, url: null, provider, error: err?.message || 'Failed to start tunnel' };
    await stopTunnel();
    return getTunnelStatus();
  } finally {
    starting = false;
  }
}

let hooked = false;
function registerProcessCleanup() {
  if (hooked) return;
  hooked = true;
  const cleanup = () => { try { stopTunnel(); } catch { /* exit cleanup */ } };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('exit', cleanup);
}

module.exports = { startTunnel, stopTunnel, getTunnelStatus, registerProcessCleanup };
