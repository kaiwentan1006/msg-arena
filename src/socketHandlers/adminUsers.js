'use strict';

/**
 * MSG Arena — admin-only user intelligence + hard IP bans.
 *
 * Aggregates what the server already knows about a member so an admin can make a
 * ban stick: every IP the account has connected from, the country + whether that
 * IP is a VPN/proxy/datacenter (so a "clean" real IP can be told from an evasion
 * one), and which client they use (web / desktop app / Android app).
 *
 * ADMIN ONLY. Every handler checks socket.user.isAdmin — moderators and any
 * "assistant" roles get nothing here (they can time out / mute via the normal
 * moderation handlers, but this surface, and its data, is invisible to them).
 *
 * IP intelligence is fetched ON DEMAND (the admin clicks "look up") from ip-api's
 * free tier, and cached — member IPs are never sent off-box automatically. A VPN
 * cannot be fully "defeated" from the server (that's its purpose), so the design
 * is: flag proxy/hosting IPs, ban the address, and disconnect live sessions on it.
 */

const http = require('http');
const { normalizeIp, isPrivateIp } = require('../clientIp');

const _ipCache = new Map();               // ip -> { data, ts }
const IP_TTL = 6 * 60 * 60 * 1000;        // 6h

function clientFromUA(ua) {
  if (!ua || typeof ua !== 'string') return null;
  if (/MSGArenaAndroid/i.test(ua)) return 'Android app';
  if (/Haven|Electron/i.test(ua)) return 'Desktop app';
  return 'Web browser';
}

// ip-api free tier: country + proxy (VPN/proxy/Tor) + hosting (datacenter) + mobile.
function lookupIp(ip) {
  return new Promise((resolve) => {
    // Private / CGNAT / loopback addresses are not geolocatable — geolocating one
    // returns a bogus datacenter country. If we only have such an address, the
    // real client IP was never captured (usually TRUST_PROXY not set behind a
    // reverse proxy), so say so plainly instead of showing a wrong country (#20).
    if (isPrivateIp(ip)) {
      return resolve({ private: true, isp: '',
        note: 'Private/proxy address — the real public IP was not captured. Behind a reverse proxy set TRUST_PROXY (Railway does this automatically).' });
    }
    const cached = _ipCache.get(ip);
    if (cached && Date.now() - cached.ts < IP_TTL) return resolve(cached.data);
    // ip-api free tier returns country + proxy(VPN/proxy/Tor) + hosting(datacenter)
    // + mobile. `proxy: true` is the signal that the shown country is an evasion
    // exit node, not the user's real location (which cannot be revealed from the
    // server — a VPN's whole purpose). Flag it and ban the address.
    const url = `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,message,country,countryCode,region,regionName,city,proxy,hosting,mobile,isp,org,as,query`;
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const req = http.get(url, { timeout: 4500 }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          let data = null;
          try {
            const j = JSON.parse(body);
            if (j.status === 'success') {
              data = { country: j.country || '', countryCode: j.countryCode || '',
                       region: j.regionName || '', city: j.city || '',
                       proxy: !!j.proxy, hosting: !!j.hosting, mobile: !!j.mobile,
                       isp: j.isp || j.org || '', asn: j.as || '' };
            } else {
              data = { error: j.message || 'lookup failed' };
            }
          } catch { data = { error: 'bad response' }; }
          if (data && !data.error) _ipCache.set(ip, { data, ts: Date.now() });
          finish(data);
        });
      });
      req.on('error', () => finish({ error: 'network error' }));
      req.on('timeout', () => { try { req.destroy(); } catch {} finish({ error: 'timed out' }); });
    } catch { finish({ error: 'lookup error' }); }
  });
}

module.exports = function register(socket, ctx) {
  const { db, io } = ctx;
  const isAdmin = () => !!(socket.user && socket.user.isAdmin);

  // Full per-user dossier (admin only).
  socket.on('admin:user-details', (data) => {
    if (!isAdmin()) return;
    if (!data || !Number.isInteger(data.userId)) return;
    try {
      const u = db.prepare(
        'SELECT id, username, COALESCE(display_name, username) AS displayName, is_admin, created_at, status, last_client FROM users WHERE id = ?'
      ).get(data.userId);
      if (!u) return;
      const ipRows = db.prepare('SELECT ip, last_seen FROM user_ips WHERE user_id = ? ORDER BY last_seen DESC LIMIT 5').all(data.userId);
      const bannedIps = new Set(db.prepare('SELECT ip FROM ip_bans').all().map((r) => r.ip));
      const banned = !!db.prepare('SELECT 1 FROM bans WHERE user_id = ?').get(data.userId);

      let online = false, liveClient = null;
      for (const [, s] of io.of('/').sockets) {
        if (s.user && s.user.id === data.userId) {
          online = true;
          liveClient = clientFromUA(s.handshake && s.handshake.headers && s.handshake.headers['user-agent']);
          break;
        }
      }

      socket.emit('admin:user-details', {
        userId: u.id, username: u.username, displayName: u.displayName,
        isAdmin: !!u.is_admin, createdAt: u.created_at, status: u.status || 'offline',
        client: liveClient || u.last_client || 'unknown', online, banned,
        ips: ipRows.map((r) => ({ ip: r.ip, lastSeen: r.last_seen, banned: bannedIps.has(normalizeIp(r.ip)) })),
      });
    } catch (e) { console.error('admin:user-details error:', e); }
  });

  // On-demand IP intelligence (country / VPN-proxy / datacenter). Admin only.
  socket.on('admin:ip-intel', async (data) => {
    if (!isAdmin()) return;
    const ip = data && typeof data.ip === 'string' ? normalizeIp(data.ip.trim()) : '';
    if (!ip) return;
    const intel = await lookupIp(ip);
    socket.emit('admin:ip-intel', { ip, intel });
  });

  // Hard-ban an IP + drop any live sessions on it. Admin only.
  socket.on('admin:ban-ip', (data) => {
    if (!isAdmin()) return;
    const ip = data && typeof data.ip === 'string' ? normalizeIp(data.ip.trim()) : '';
    if (!ip) return;
    const reason = (data.reason || '').toString().slice(0, 200);
    try {
      db.prepare('INSERT OR REPLACE INTO ip_bans (ip, banned_by, reason) VALUES (?, ?, ?)').run(ip, socket.user.id, reason);
      // Disconnect anyone currently connected from that address.
      for (const [, s] of io.of('/').sockets) {
        if (!s.user) continue;
        try {
          const hit = db.prepare('SELECT 1 FROM user_ips WHERE user_id = ? AND ip = ?').get(s.user.id, ip);
          if (hit) s.disconnect(true);
        } catch { /* ignore */ }
      }
      socket.emit('admin:ip-banned', { ip });
    } catch (e) { console.error('admin:ban-ip error:', e); socket.emit('error-msg', 'Could not ban that IP'); }
  });

  // Lift an IP ban. Admin only.
  socket.on('admin:unban-ip', (data) => {
    if (!isAdmin()) return;
    const ip = data && typeof data.ip === 'string' ? normalizeIp(data.ip.trim()) : '';
    if (!ip) return;
    try {
      db.prepare('DELETE FROM ip_bans WHERE ip = ?').run(ip);
      socket.emit('admin:ip-unbanned', { ip });
    } catch (e) { console.error('admin:unban-ip error:', e); }
  });
};

module.exports.clientFromUA = clientFromUA;
