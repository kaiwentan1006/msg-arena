'use strict';

/**
 * MSG Arena — server directory (opt-in central registry).
 *
 * A self-hosted server can *announce* itself to a registry hub; anyone can then
 * browse the list and join. This keeps the product self-hosted (each server is
 * still independent) while giving the Discord-style "find a server" the user
 * asked for.
 *
 * Roles of one deploy:
 *   • HUB    — REGISTRY_URL unset (or == this server). Stores announcements in
 *              registry_servers and serves the list from its own table.
 *   • MEMBER — REGISTRY_URL points at a hub. It announces itself to the hub and
 *              PROXIES /api/registry/servers to the hub, so its own web client can
 *              browse the shared list same-origin (no CORS).
 *
 * Safety: announced URLs must be public https(ish) origins (no localhost/private
 * ranges → no SSRF/LAN scanning), and are verified reachable (`/api/health`)
 * before listing. Announces are rate-limited. Admins can block a URL.
 */

const express = require('express');
const { getDb } = require('./database');   // resolved lazily per request (db is null at boot)
const ACTIVE_MS = 48 * 60 * 60 * 1000;   // drop servers silent for 48h
const VERIFY_TIMEOUT = 4000;
let _tableReady = false;
function ensureTable(db) {
  if (_tableReady) return;
  db.exec(`CREATE TABLE IF NOT EXISTS registry_servers (
    url            TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    description    TEXT DEFAULT '',
    members        INTEGER DEFAULT 0,
    last_heartbeat INTEGER NOT NULL,
    created_at     INTEGER NOT NULL,
    blocked        INTEGER NOT NULL DEFAULT 0
  )`);
  _tableReady = true;
}

// Public origin only — rejects localhost / private / link-local / .local so the
// hub never fetches internal addresses on an announcer's behalf.
function publicOrigin(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const h = u.hostname.toLowerCase();
  if (!h || h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan')) return null;
  if (/^127\.|^10\.|^192\.168\.|^169\.254\.|^0\./.test(h)) return null;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return null;
  if (h === '::1' || /^fe80:|^f[cd]/i.test(h)) return null;
  return u.origin;
}

module.exports = function createRegistryRoutes({ publicUrl }) {
  const selfOrigin = publicOrigin(publicUrl) || null;
  const hubOrigin = publicOrigin(process.env.REGISTRY_URL) || null;
  const isHub = !hubOrigin || hubOrigin === selfOrigin;

  const router = express.Router();
  const _rl = new Map();   // ip -> last announce ts

  // A server announces itself to THIS hub.
  router.post('/announce', express.json({ limit: '8kb' }), async (req, res) => {
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || '';
    const now = Date.now();
    if (_rl.get(ip) && now - _rl.get(ip) < 15000) return res.status(429).json({ error: 'Too many announcements' });
    _rl.set(ip, now);
    const db = getDb(); ensureTable(db);

    const origin = publicOrigin((req.body || {}).url);
    if (!origin) return res.status(400).json({ error: 'A public server URL is required' });
    const name = String((req.body || {}).name || '').trim().slice(0, 60) || origin.replace(/^https?:\/\//, '');
    const description = String((req.body || {}).description || '').trim().slice(0, 200);

    const existing = db.prepare('SELECT blocked FROM registry_servers WHERE url = ?').get(origin);
    if (existing && existing.blocked) return res.status(403).json({ error: 'This server is blocked from the directory' });

    // Verify it's actually a reachable MSG Arena server before listing it.
    let ok = false;
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), VERIFY_TIMEOUT);
      const r = await fetch(origin + '/api/health', { signal: ctrl.signal, redirect: 'error' });
      clearTimeout(to);
      ok = r.ok;
    } catch { ok = false; }
    if (!ok) return res.status(400).json({ error: 'Could not reach ' + origin });

    db.prepare(`INSERT INTO registry_servers (url, name, description, members, last_heartbeat, created_at)
                VALUES (?, ?, ?, 0, ?, ?)
                ON CONFLICT(url) DO UPDATE SET name = excluded.name, description = excluded.description, last_heartbeat = excluded.last_heartbeat`)
      .run(origin, name, description, now, now);
    res.json({ ok: true });
  });

  // Browse the directory. On a hub, from our own table; on a member server, proxied
  // from the hub so the web client can fetch same-origin (no CORS).
  router.get('/servers', async (req, res) => {
    const q = String(req.query.q || '').toLowerCase().trim();
    if (!isHub && hubOrigin) {
      try {
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), VERIFY_TIMEOUT);
        const r = await fetch(hubOrigin + '/api/registry/servers' + (q ? ('?q=' + encodeURIComponent(q)) : ''), { signal: ctrl.signal });
        clearTimeout(to);
        const j = await r.json();
        return res.json({ servers: Array.isArray(j.servers) ? j.servers : [], hub: hubOrigin });
      } catch { return res.json({ servers: [], hub: hubOrigin, error: 'hub unreachable' }); }
    }
    const db = getDb(); ensureTable(db);
    const cutoff = Date.now() - ACTIVE_MS;
    let rows = db.prepare('SELECT url, name, description, members FROM registry_servers WHERE blocked = 0 AND last_heartbeat > ? ORDER BY last_heartbeat DESC LIMIT 200').all(cutoff);
    if (q) rows = rows.filter(r => (r.name + ' ' + r.description + ' ' + r.url).toLowerCase().includes(q));
    res.json({ servers: rows });
  });

  return router;
};

module.exports.publicOrigin = publicOrigin;
