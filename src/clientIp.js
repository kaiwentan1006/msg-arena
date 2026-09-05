'use strict';

// ══════════════════════════════════════════════════════════════════════
// Client IP resolution and matching (v3.42.0)
// ══════════════════════════════════════════════════════════════════════
//
// Fixes three defects that made IP bans unreliable before this module existed.
//
// 1. HTTP and WebSocket disagreed about what a client's IP *is*.
//    Express (with `trust proxy` set) hands back "1.2.3.4". Socket.IO's
//    `socket.handshake.address` is the raw TCP peer, which on a dual-stack
//    listener is "::ffff:1.2.3.4". Ban "1.2.3.4" and the HTTP gate blocked
//    them while the socket gate compared against a string that never matched,
//    so the ban looked applied but the client stayed connected. Everything
//    now goes through normalizeIp() before it is stored or compared.
//
// 2. `socket.handshake.address` ignores `trust proxy` entirely.
//    Express honours X-Forwarded-For; Socket.IO does not. Behind nginx or
//    Cloudflare every socket therefore reported the *proxy's* address. That
//    poisoned user_ips (so "also ban IP" would have banned the proxy and
//    locked out the whole server) and collapsed the per-IP connection rate
//    limiter into a single shared bucket. socketClientIp() reimplements
//    Express's proxy-addr hop-counting so both paths agree exactly.
//
// 3. Exact-string matching only.
//    An IPv6 subscriber is routinely handed an entire /64, so banning one
//    address of theirs accomplishes nothing. Entries may now be written as
//    CIDR ("2001:db8::/64", "203.0.113.0/24") and are matched by containment.

// ── Normalisation ───────────────────────────────────────────────────
// Produces the canonical form used for both storage and comparison.
function normalizeIp(ip) {
  if (typeof ip !== 'string') return '';
  let s = ip.trim().toLowerCase();
  if (!s) return '';

  // "[::1]:1234" or "[::1]" -> "::1"
  if (s.startsWith('[')) {
    const close = s.indexOf(']');
    if (close !== -1) s = s.slice(1, close);
  } else if (s.includes(':') && s.indexOf(':') === s.lastIndexOf(':')) {
    // Exactly one colon means IPv4 with a port: "1.2.3.4:5678".
    s = s.slice(0, s.indexOf(':'));
  }

  // IPv4-mapped IPv6 -> plain IPv4. This is the single most important line
  // in the file: it is what made bans half-apply before.
  if (s.startsWith('::ffff:')) {
    const tail = s.slice(7);
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(tail)) return tail;
  }
  if (s === '::1') return '127.0.0.1';

  return s;
}

function isIPv4(s) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(s) &&
         s.split('.').every(o => Number(o) >= 0 && Number(o) <= 255);
}

function isIPv6(s) {
  return s.includes(':') && /^[0-9a-f:]+$/.test(s);
}

// ── Address -> BigInt, for CIDR containment ─────────────────────────
function ipToBigInt(ip) {
  if (isIPv4(ip)) {
    return ip.split('.').reduce((acc, o) => (acc << 8n) + BigInt(Number(o)), 0n);
  }
  if (!isIPv6(ip)) return null;

  // Expand "::" then pad each group to 4 hex digits.
  const dbl = ip.split('::');
  if (dbl.length > 2) return null;
  const head = dbl[0] ? dbl[0].split(':') : [];
  const tail = dbl.length === 2 && dbl[1] ? dbl[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (dbl.length === 1 && head.length !== 8) return null;
  if (missing < 0) return null;
  const groups = dbl.length === 2
    ? [...head, ...Array(missing).fill('0'), ...tail]
    : head;

  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    n = (n << 16n) + BigInt(parseInt(g, 16));
  }
  return n;
}

// Does `ip` fall inside `entry`? `entry` is either a plain address or CIDR.
// Both sides are normalised first, so "::ffff:1.2.3.4" matches a ban on
// "1.2.3.4" and vice versa.
function ipMatches(ip, entry) {
  const a = normalizeIp(ip);
  if (!a || typeof entry !== 'string') return false;

  const slash = entry.indexOf('/');
  if (slash === -1) return a === normalizeIp(entry);

  const net = normalizeIp(entry.slice(0, slash));
  const bits = parseInt(entry.slice(slash + 1), 10);
  if (!net || !Number.isFinite(bits) || bits < 0) return false;

  // Never compare a v4 address against a v6 network or vice versa.
  const aIsV4 = isIPv4(a), nIsV4 = isIPv4(net);
  if (aIsV4 !== nIsV4) return false;
  const width = aIsV4 ? 32 : 128;
  if (bits > width) return false;

  const aNum = ipToBigInt(a), nNum = ipToBigInt(net);
  if (aNum === null || nNum === null) return false;

  const shift = BigInt(width - bits);
  return (aNum >> shift) === (nNum >> shift);
}

// Accepts a plain address or a CIDR range. Used to validate admin input.
function isValidIpOrCidr(s) {
  if (typeof s !== 'string' || !s.trim() || s.length > 64) return false;
  const slash = s.indexOf('/');
  const addr = normalizeIp(slash === -1 ? s : s.slice(0, slash));
  if (!addr || (!isIPv4(addr) && !isIPv6(addr))) return false;
  if (slash === -1) return true;
  const bits = parseInt(s.slice(slash + 1), 10);
  return Number.isFinite(bits) && bits >= 0 && bits <= (isIPv4(addr) ? 32 : 128);
}

// ── Socket.IO client IP, honouring TRUST_PROXY ──────────────────────
// Mirrors Express's proxy-addr so `socketClientIp(socket)` and `req.ip`
// return the same string for the same client.
//
// proxy-addr builds [remoteAddress, ...xff.reverse()] and, for a numeric
// `trust proxy` of n, returns element n (clamped to the list length).
function socketClientIp(socket, trustProxy) {
  if (!socket || !socket.handshake) return '';
  const raw = socket.handshake.address || '';

  // Default 0 (trust nothing) mirrors the Express `trust proxy` default in
  // server.js — a reverse-proxy deployment must set TRUST_PROXY explicitly.
  // Trusting an XFF hop that isn't there lets a client spoof its own IP past
  // IP bans and the connection/rate limiters on the socket path too.
  const tp = trustProxy !== undefined
    ? trustProxy
    : (process.env.TRUST_PROXY !== undefined ? Number(process.env.TRUST_PROXY) : 0);

  // Non-numeric or zero: trust nothing, use the peer address as-is.
  const hops = Number(tp);
  if (!Number.isFinite(hops) || hops <= 0) return normalizeIp(raw);

  const xff = socket.handshake.headers && socket.handshake.headers['x-forwarded-for'];
  if (!xff || typeof xff !== 'string') return normalizeIp(raw);

  const chain = [raw, ...xff.split(',').map(s => s.trim()).filter(Boolean).reverse()];
  const idx = Math.min(hops, chain.length - 1);
  return normalizeIp(chain[idx]);
}

module.exports = {
  normalizeIp,
  ipMatches,
  isValidIpOrCidr,
  socketClientIp,
  isIPv4,
  isIPv6,
  ipToBigInt
};
