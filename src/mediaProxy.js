'use strict';

// ══════════════════════════════════════════════════════════════════════
// Server-side media proxy + disk cache (v3.43.0)
// ══════════════════════════════════════════════════════════════════════
//
// MSG Arena used to render remote images directly in every viewer's browser:
// link-preview og:image tags, markdown ![](url), and bare image URLs that the
// linkifier turns into <img>. That handed the remote host the IP address and
// User-Agent of everyone who scrolled past the message. Nobody clicked
// anything, and nothing in the UI suggested a request had been made.
//
// v3.42.0 narrowed that to allowlisted domains. This closes it outright: the
// server fetches remote media once, caches it on disk, and clients only ever
// talk to MSG Arena. It also means an embed keeps working after the origin has
// expired or gone offline, which is why chat history stays intact.
//
// ── Auth ──
// An <img> tag cannot send an Authorization header, so the usual Bearer check
// is unavailable. Leaving the endpoint open would make MSG Arena an anonymous
// image proxy for the whole internet. Instead the client fetches a short-lived
// media token over the authenticated API and appends it to proxy URLs.
//
// The token is deliberately NOT the session JWT: it is derived from it, grants
// nothing except media fetching, and rotates daily. If one leaks through a
// server log or a shared screenshot, it cannot be used to log in.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./paths');

const CACHE_DIR = path.join(DATA_DIR, 'media-cache');
try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch { /* created lazily below */ }

// ── Limits ──────────────────────────────────────────────────────────
const MAX_BYTES        = 20 * 1024 * 1024;        // per item
const CACHE_MAX_BYTES  = 2 * 1024 * 1024 * 1024;  // 2 GB total
const CACHE_TTL_MS     = 30 * 24 * 3600 * 1000;   // 30 days
const FETCH_TIMEOUT_MS = 12000;

// SVG is excluded on purpose: it is a script-bearing document format, and
// serving one from MSG Arena's own origin would hand an attacker same-origin
// script execution. Everything here is inert raster data.
const ALLOWED_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/jpg', 'image/gif',
  'image/webp', 'image/avif', 'image/bmp', 'image/x-icon', 'image/vnd.microsoft.icon'
]);

const EXT_FOR_TYPE = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/avif': 'avif', 'image/bmp': 'bmp',
  'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico'
};

const UA = 'Mozilla/5.0 (compatible; MSGArenaBot/2.1; +https://github.com/msg-arena)';

// ── Media token ─────────────────────────────────────────────────────
// Format: "<userId>.<hmac>", where the HMAC covers the user id and the current
// day bucket. Verification recomputes for today and yesterday so a token
// issued just before midnight keeps working for a while.
function _secret() {
  return process.env.JWT_SECRET || 'haven-fallback-media-secret';
}

function _sign(userId, dayBucket) {
  return crypto.createHmac('sha256', _secret())
    .update(`media:${userId}:${dayBucket}`)
    .digest('base64url')
    .slice(0, 32);
}

function _today() { return Math.floor(Date.now() / 86400000); }

function issueToken(userId) {
  if (!Number.isInteger(userId)) return null;
  return `${userId}.${_sign(userId, _today())}`;
}

// Returns the user id the token belongs to, or null.
function verifyToken(token) {
  if (typeof token !== 'string' || token.length > 128) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const userId = parseInt(token.slice(0, dot), 10);
  const sig = token.slice(dot + 1);
  if (!Number.isInteger(userId)) return null;

  for (const bucket of [_today(), _today() - 1]) {
    const expected = _sign(userId, bucket);
    // Constant-time compare; lengths already match by construction.
    if (sig.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      return userId;
    }
  }
  return null;
}

// ── Cache index ─────────────────────────────────────────────────────
// Built once at startup so eviction does not have to stat the whole directory
// on every write. Maps cache key -> { file, size, type, ts }.
const index = new Map();
let totalBytes = 0;
const inFlight = new Map();   // key -> Promise, collapses concurrent misses

function _keyFor(url) {
  return crypto.createHash('sha256').update(url).digest('hex');
}

function _metaPath(key) { return path.join(CACHE_DIR, key + '.json'); }

function loadIndex() {
  index.clear();
  totalBytes = 0;
  let files;
  try { files = fs.readdirSync(CACHE_DIR); } catch { return; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), 'utf8'));
      if (!meta || !meta.file || !meta.size) continue;
      if (!fs.existsSync(path.join(CACHE_DIR, meta.file))) continue;
      index.set(f.slice(0, -5), meta);
      totalBytes += meta.size;
    } catch { /* skip unreadable entry */ }
  }
  if (index.size) {
    console.log(`🖼️  Media cache: ${index.size} item(s), ${(totalBytes / 1048576).toFixed(1)} MB`);
  }
}

function _remove(key) {
  const meta = index.get(key);
  if (!meta) return;
  try { fs.unlinkSync(path.join(CACHE_DIR, meta.file)); } catch {}
  try { fs.unlinkSync(_metaPath(key)); } catch {}
  totalBytes -= meta.size;
  index.delete(key);
}

// Evict expired entries first, then oldest-first until back under the cap.
function _evictIfNeeded() {
  const now = Date.now();
  for (const [key, meta] of index) {
    if (now - meta.ts > CACHE_TTL_MS) _remove(key);
  }
  if (totalBytes <= CACHE_MAX_BYTES) return;
  const byAge = [...index.entries()].sort((a, b) => a[1].ts - b[1].ts);
  for (const [key] of byAge) {
    if (totalBytes <= CACHE_MAX_BYTES * 0.9) break;
    _remove(key);
  }
}

function get(url) {
  const key = _keyFor(url);
  const meta = index.get(key);
  if (!meta) return null;
  if (Date.now() - meta.ts > CACHE_TTL_MS) { _remove(key); return null; }
  const file = path.join(CACHE_DIR, meta.file);
  if (!fs.existsSync(file)) { _remove(key); return null; }
  return { path: file, type: meta.type, size: meta.size };
}

// Fetch and cache. `validateUrlSafe` is injected from server.js so the proxy
// reuses the exact SSRF guard the link-preview scraper already uses (protocol
// check, private-range check, and a DNS resolve that defeats DNS rebinding).
async function fetchAndCache(url, validateUrlSafe) {
  const key = _keyFor(url);

  const hit = get(url);
  if (hit) return hit;

  if (inFlight.has(key)) return inFlight.get(key);

  const job = (async () => {
    await validateUrlSafe(url);

    // Follow redirects MANUALLY and re-validate every hop against the SSRF guard.
    // With redirect:'follow', a 3xx to an internal address (169.254.169.254,
    // 127.0.0.1, a LAN host) would be fetched without re-checking — blind SSRF.
    // This mirrors the link-preview scraper's per-hop validation. (security M1)
    let currentUrl = url;
    let res;
    const MAX_REDIRECTS = 5;
    for (let hop = 0; ; hop++) {
      res = await fetch(currentUrl, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'User-Agent': UA, 'Accept': 'image/*' },
        redirect: 'manual'
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        if (hop >= MAX_REDIRECTS) throw new Error('too many redirects');
        const nextUrl = new URL(res.headers.get('location'), currentUrl).href;
        await validateUrlSafe(nextUrl);   // throws on private/internal → SSRF blocked
        currentUrl = nextUrl;
        continue;
      }
      break;
    }
    if (!res.ok) throw new Error(`upstream ${res.status}`);

    const rawType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_TYPES.has(rawType)) throw new Error(`unsupported content-type: ${rawType || 'none'}`);

    const declared = parseInt(res.headers.get('content-length') || '0', 10);
    if (Number.isFinite(declared) && declared > MAX_BYTES) throw new Error('too large');

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error('too large');
    if (buf.length === 0) throw new Error('empty response');

    const file = `${key}.${EXT_FOR_TYPE[rawType] || 'bin'}`;
    const meta = { file, size: buf.length, type: rawType, ts: Date.now(), url };

    fs.writeFileSync(path.join(CACHE_DIR, file), buf);
    fs.writeFileSync(_metaPath(key), JSON.stringify(meta));

    // Replace rather than double-count if this key somehow already existed.
    if (index.has(key)) totalBytes -= index.get(key).size;
    index.set(key, meta);
    totalBytes += buf.length;
    _evictIfNeeded();

    return { path: path.join(CACHE_DIR, file), type: rawType, size: buf.length };
  })();

  inFlight.set(key, job);
  try { return await job; }
  finally { inFlight.delete(key); }
}

function stats() {
  return { items: index.size, bytes: totalBytes, dir: CACHE_DIR };
}

function clear() {
  for (const key of [...index.keys()]) _remove(key);
}

module.exports = {
  issueToken, verifyToken,
  get, fetchAndCache, loadIndex, stats, clear,
  CACHE_DIR, MAX_BYTES, ALLOWED_TYPES
};
