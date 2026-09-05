'use strict';

/**
 * MSG Arena — Rich presence / user activity
 *
 * Collects "what is this person doing right now" from four sources and hands
 * it to the presence broadcast in socketHandlers/index.js:
 *
 *   haven   — MSG Arena's own voice-channel music player (no external calls)
 *   steam   — Steam Web API GetPlayerSummaries (one batched call for everyone)
 *   lastfm  — Last.fm getRecentTracks (username + server API key, no OAuth)
 *   spotify — Spotify Web API currently-playing (full OAuth, one call per user)
 *
 * Prefer Last.fm for music. It needs no per-user OAuth, no token storage, and
 * has no per-app user cap; it also covers whatever the person actually listens
 * with (Spotify, Apple Music, YouTube Music, Navidrome, Plex) because those all
 * scrobble to it. Spotify remains for people who specifically want it, but it
 * costs a registered app, a client secret, and a limited development-mode user
 * allowlist.
 *
 * Design notes worth keeping in mind before changing anything here:
 *
 * - Activity is IN MEMORY ONLY. It never touches the database. It's ephemeral
 *   and high-churn, and persisting it would quietly build a play-history log
 *   of every user that nobody consented to.
 *
 * - Sharing is ON by default, but nothing appears until a user links an account
 *   (an explicit act, and the real consent gate) or plays music in a MSG Arena
 *   voice channel. Users can opt out entirely, or mute games/music separately.
 *   Anyone with status 'invisible' reports nothing regardless of preferences —
 *   being invisible while broadcasting "playing Helldivers 2" would defeat the
 *   entire point.
 *
 * - Polling only covers users who are actually connected AND opted in. An
 *   idle self-hosted server with two linked accounts makes no external calls
 *   at all, and quota scales with concurrent users rather than signups.
 *
 * - Tokens are encrypted at rest (AES-256-GCM, key derived from JWT_SECRET).
 *   A Spotify refresh token is a long-lived credential and the SQLite file
 *   ends up in backups.
 */

const crypto = require('crypto');

// ── Token encryption ──────────────────────────────────────
// Key is derived from JWT_SECRET, so rotating that secret invalidates stored
// OAuth tokens. That's the correct failure mode — decryption returns null and
// the user is asked to re-link, rather than the server using a stale token.
function deriveKey() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET required for connection token encryption');
  return crypto.createHash('sha256').update(String(secret) + ':haven-connections').digest();
}

function encryptToken(plain) {
  if (!plain) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}

function decryptToken(stored) {
  if (!stored || typeof stored !== 'string') return null;
  const parts = stored.split('.');
  if (parts.length !== 3) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(), Buffer.from(parts[0], 'base64'));
    decipher.setAuthTag(Buffer.from(parts[1], 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(parts[2], 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null; // wrong key or tampered — treat as "not linked"
  }
}

// ── Config ────────────────────────────────────────────────
// Read from process.env on every access rather than captured at module load,
// so an admin saving keys through Settings takes effect immediately instead of
// requiring a server restart. The Settings handler updates process.env and the
// .env file together.
const steamApiKey      = () => process.env.STEAM_API_KEY || '';
const spotifyClientId  = () => process.env.SPOTIFY_CLIENT_ID || '';
const spotifySecret    = () => process.env.SPOTIFY_CLIENT_SECRET || '';
const lastfmApiKey     = () => process.env.LASTFM_API_KEY || '';
const twitchClientId   = () => process.env.TWITCH_CLIENT_ID || '';
const twitchSecret     = () => process.env.TWITCH_CLIENT_SECRET || '';

const STEAM_POLL_MS   = 60_000; // one batched call covers every linked user
const SPOTIFY_POLL_MS = 30_000; // per-user; tracks change fast enough to matter
const LASTFM_POLL_MS  = 30_000; // per-user; scrobbles land within ~a minute anyway
const TWITCH_POLL_MS  = 60_000; // one batched Helix call covers every linked user

const isSteamConfigured   = () => !!steamApiKey();
const isSpotifyConfigured = () => !!(spotifyClientId() && spotifySecret());
const isLastfmConfigured  = () => !!lastfmApiKey();
const isTwitchConfigured  = () => !!(twitchClientId() && twitchSecret());

/**
 * Last.fm usernames: 2-15 chars, letters/digits/underscore/hyphen. Anchored
 * because this value goes straight into an API URL — no path traversal, no
 * query-string smuggling.
 */
const LASTFM_USERNAME_RE = /^[a-zA-Z0-9_-]{2,15}$/;

// Trim anything coming from an external API before it reaches other clients.
function clean(str, max = 120) {
  if (typeof str !== 'string') return '';
  return str.replace(/\p{C}/gu, '').trim().slice(0, max);
}

// Only allow image URLs from the CDNs we actually expect, so a compromised or
// unexpected API response can't point every client's <img> at an arbitrary host.
const ALLOWED_IMAGE_HOSTS = new Set([
  'cdn.cloudflare.steamstatic.com',
  'cdn.akamai.steamstatic.com',
  'media.steampowered.com',
  'i.scdn.co',
  'i.ytimg.com',
  'img.youtube.com',
  'lastfm.freetls.fastly.net',
  'lastfm-img.freetls.fastly.net',
  'static-cdn.jtvnw.net',   // Twitch stream thumbnails / box art
]);

function safeImage(url) {
  if (typeof url !== 'string' || !url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return null;
    return ALLOWED_IMAGE_HOSTS.has(u.hostname) ? u.href : null;
  } catch {
    return null;
  }
}

async function fetchJson(url, opts = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...opts, signal: ctrl.signal });
    if (resp.status === 204) return { _empty: true };
    if (!resp.ok) {
      const err = new Error(`HTTP ${resp.status}`);
      err.status = resp.status;
      throw err;
    }
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

// ══════════════════════════════════════════════════════════
// createActivity
// ══════════════════════════════════════════════════════════
/**
 * @param {object}   db               better-sqlite3 handle
 * @param {function} getOnlineUserIds () => number[] of connected user ids
 * @param {function} onChange         (userId) => void — fired when a user's
 *                                    activity actually changed, so the caller
 *                                    can re-broadcast presence for them
 */
function createActivity({ db, getOnlineUserIds, onChange, onConnectionsChanged }) {
  // userId -> { playing: Activity|null, listening: Activity|null }
  const activity = new Map();
  const notify = typeof onChange === 'function' ? onChange : () => {};
  // Fired when a user's linked accounts change. The OAuth callback can land in
  // a completely different browser than the one running MSG Arena, so the app has
  // to be told over its socket rather than relying on the redirect coming home.
  const notifyConnections = typeof onConnectionsChanged === 'function' ? onConnectionsChanged : () => {};

  const timers = [];
  let spotifyCursor = 0; // round-robin so one slow account can't starve others
  let lastfmCursor  = 0;

  // ── Preferences ─────────────────────────────────────────
  function prefsFor(userId) {
    let rows = [];
    try {
      rows = db.prepare(
        `SELECT key, value FROM user_preferences
         WHERE user_id = ? AND key IN ('share_activity','share_game_activity','share_music_activity')`
      ).all(userId);
    } catch { /* table missing on a very old DB */ }
    const map = {};
    rows.forEach(r => { map[r.key] = r.value; });
    return {
      // Default ON. The meaningful consent gate for Steam/Spotify is linking
      // the account, which is always an explicit act — so defaulting the master
      // switch off just meant people linked an account and then wondered why
      // nothing happened. The one case this discloses without an explicit
      // action is MSG Arena's own voice-channel music, which is already visible to
      // everyone in that channel anyway.
      master: map.share_activity !== 'false',
      games:  map.share_game_activity !== 'false',
      music:  map.share_music_activity !== 'false',
    };
  }

  function isInvisible(userId) {
    try {
      const row = db.prepare('SELECT status FROM users WHERE id = ?').get(userId);
      return !!row && row.status === 'invisible';
    } catch {
      return false;
    }
  }

  /** True if this user has opted into sharing anything at all right now. */
  function sharingEnabled(userId) {
    if (isInvisible(userId)) return false;
    return prefsFor(userId).master;
  }

  // ── Read side ───────────────────────────────────────────
  /**
   * The activity other people are allowed to see for this user, already
   * filtered by their privacy preferences. Returns null when there's nothing
   * to show, so callers can omit the field entirely.
   */
  function getPublicActivity(userId) {
    const entry = activity.get(userId);
    if (!entry) return null;
    if (isInvisible(userId)) return null;

    const prefs = prefsFor(userId);
    if (!prefs.master) return null;

    const playing   = prefs.games ? entry.playing   || null : null;
    const listening = prefs.music ? entry.listening || null : null;
    if (!playing && !listening) return null;

    return { playing, listening };
  }

  // ── Write side ──────────────────────────────────────────
  function sameActivity(a, b) {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return a.name === b.name && a.details === b.details && a.source === b.source;
  }

  /**
   * Set (or clear, with null) one slot of a user's activity. No-ops when
   * nothing actually changed so we don't re-broadcast presence on every poll
   * tick for someone who's been listening to the same track for four minutes.
   */
  function setSlot(userId, slot, value) {
    const entry = activity.get(userId) || { playing: null, listening: null };
    if (sameActivity(entry[slot], value)) return false;

    // Preserve the original start time across polls of an unchanged track so
    // elapsed-time display doesn't reset every 30 seconds.
    if (value && entry[slot] && entry[slot].name === value.name && entry[slot].source === value.source) {
      value.startedAt = entry[slot].startedAt;
    }

    entry[slot] = value;
    if (!entry.playing && !entry.listening) activity.delete(userId);
    else activity.set(userId, entry);
    notify(userId);
    return true;
  }

  function clearUser(userId) {
    if (!activity.has(userId)) return;
    activity.delete(userId);
    notify(userId);
  }

  // ── Source 1: MSG Arena's own music player ──────────────────
  /**
   * Called by the music handlers when a track starts/stops in a voice channel.
   * Everyone listening in that channel gets the activity, not just whoever
   * queued it — they are all, in fact, listening to it.
   */
  function setHavenMusic(userIds, track) {
    const ids = Array.isArray(userIds) ? userIds : [];
    const next = track && track.title
      ? {
          type: 'listening',
          name: clean(track.title, 120),
          details: clean(track.channelName || 'MSG Arena', 80),
          image: safeImage(track.thumbnail) || null,
          source: 'haven',
          startedAt: Date.now(),
        }
      : null;

    for (const id of ids) {
      // MSG Arena music must not clobber a Spotify/Navidrome-sourced listen for a
      // user who isn't actually in the voice channel; callers pass only the
      // channel's occupants, so anyone here really is hearing this.
      setSlot(id, 'listening', next);
    }
  }

  function clearHavenMusic(userIds) {
    for (const id of (Array.isArray(userIds) ? userIds : [])) {
      const entry = activity.get(id);
      if (entry && entry.listening && entry.listening.source === 'haven') {
        setSlot(id, 'listening', null);
      }
    }
  }

  // ── Connections ─────────────────────────────────────────
  function getConnection(userId, provider) {
    try {
      return db.prepare('SELECT * FROM user_connections WHERE user_id = ? AND provider = ?').get(userId, provider) || null;
    } catch {
      return null;
    }
  }

  function listConnections(userId) {
    let rows = [];
    try {
      rows = db.prepare('SELECT provider, display_name, link_method, created_at FROM user_connections WHERE user_id = ?').all(userId);
    } catch { /* table missing or pre-migration */ }
    return rows.map(r => ({
      provider: r.provider,
      displayName: r.display_name || '',
      linkMethod: r.link_method || 'oauth',
      linkedAt: r.created_at,
    }));
  }

  // Public game IDs for a profile card. Only the handle + how trustworthy it is
  // (verified = ownership was proven or the handle was confirmed to exist).
  function getProfileConnections(userId) {
    let rows = [];
    try {
      rows = db.prepare('SELECT provider, display_name, link_method FROM user_connections WHERE user_id = ? ORDER BY link_method, provider').all(userId);
    } catch { return []; }
    return rows
      .filter(r => r.display_name)
      .map(r => ({
        provider: r.provider,
        handle: r.display_name,
        verified: (r.link_method || 'oauth') !== 'self',
      }));
  }

  function saveConnection(userId, provider, { externalId, displayName, accessToken, refreshToken, expiresAt, linkMethod = 'oauth' }) {
    db.prepare(
      `INSERT INTO user_connections
         (user_id, provider, external_id, display_name, access_token, refresh_token, expires_at, link_method)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, provider) DO UPDATE SET
         external_id   = excluded.external_id,
         display_name  = excluded.display_name,
         access_token  = excluded.access_token,
         refresh_token = COALESCE(excluded.refresh_token, user_connections.refresh_token),
         expires_at    = excluded.expires_at,
         link_method   = excluded.link_method`
    ).run(
      userId, provider,
      externalId || null,
      clean(displayName, 80) || null,
      encryptToken(accessToken),
      encryptToken(refreshToken),
      Number(expiresAt) || 0,
      linkMethod || 'oauth'
    );
    notifyConnections(userId);
  }

  // A self-declared handle (Riot ID, gamertag, …). No token, no verification —
  // stored with link_method='self' so it always renders as unverified.
  function setSelfHandle(userId, provider, handle) {
    const clean_ = clean(handle, 80);
    if (!clean_) return false;
    saveConnection(userId, provider, {
      externalId: null, displayName: clean_,
      accessToken: null, refreshToken: null, expiresAt: 0,
      linkMethod: 'self',
    });
    return true;
  }

  function removeConnection(userId, provider) {
    try {
      db.prepare('DELETE FROM user_connections WHERE user_id = ? AND provider = ?').run(userId, provider);
    } catch { /* nothing to remove */ }
    notifyConnections(userId);
    // Drop whatever that provider was reporting so the activity doesn't linger
    // until the next poll tick that will no longer happen.
    const entry = activity.get(userId);
    if (!entry) return;
    if (entry.playing && entry.playing.source === provider) setSlot(userId, 'playing', null);
    if (entry.listening && entry.listening.source === provider) setSlot(userId, 'listening', null);
  }

  // ── Source 2: Steam ─────────────────────────────────────
  /**
   * GetPlayerSummaries accepts up to 100 steamids per call, so the entire
   * server costs one request per minute regardless of how many people linked.
   */
  async function pollSteam() {
    if (!isSteamConfigured()) return;

    const online = new Set(getOnlineUserIds());
    if (online.size === 0) return;

    let rows = [];
    try {
      rows = db.prepare("SELECT user_id, external_id FROM user_connections WHERE provider = 'steam' AND external_id IS NOT NULL").all();
    } catch { return; }

    const eligible = rows.filter(r => {
      if (!online.has(r.user_id)) return false;
      const p = prefsFor(r.user_id);
      return p.master && p.games && !isInvisible(r.user_id);
    });
    if (eligible.length === 0) return;

    const bySteamId = new Map();
    eligible.forEach(r => { bySteamId.set(String(r.external_id), r.user_id); });

    // Chunk defensively even though 100 concurrent linked players is unlikely
    // on a self-hosted server.
    const ids = Array.from(bySteamId.keys());
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);
      let data;
      try {
        data = await fetchJson(
          `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${encodeURIComponent(steamApiKey())}&steamids=${batch.join(',')}`
        );
      } catch (err) {
        console.warn('[MSG Arena activity] Steam poll failed:', err.message);
        return;
      }

      const players = data?.response?.players || [];
      const seen = new Set();
      for (const p of players) {
        const userId = bySteamId.get(String(p.steamid));
        if (!userId) continue;
        seen.add(userId);

        if (p.gameextrainfo) {
          setSlot(userId, 'playing', {
            type: 'playing',
            name: clean(p.gameextrainfo, 120),
            details: '',
            image: p.gameid
              ? safeImage(`https://cdn.cloudflare.steamstatic.com/steam/apps/${encodeURIComponent(String(p.gameid).replace(/\D/g, ''))}/capsule_231x87.jpg`)
              : null,
            source: 'steam',
            startedAt: Date.now(),
          });
        } else {
          const entry = activity.get(userId);
          if (entry?.playing?.source === 'steam') setSlot(userId, 'playing', null);
        }
      }

      // A steamid that vanished from the response (private profile flipped,
      // account deleted) should stop reporting rather than freeze forever.
      for (const [sid, userId] of bySteamId) {
        if (!batch.includes(sid) || seen.has(userId)) continue;
        const entry = activity.get(userId);
        if (entry?.playing?.source === 'steam') setSlot(userId, 'playing', null);
      }
    }
  }

  // ── Source 3: Spotify ───────────────────────────────────
  async function refreshSpotifyToken(userId, conn) {
    const refresh = decryptToken(conn.refresh_token);
    if (!refresh) return null;

    let data;
    try {
      const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh });
      data = await fetchJson('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: 'Basic ' + Buffer.from(`${spotifyClientId()}:${spotifySecret()}`).toString('base64'),
        },
        body,
      });
    } catch (err) {
      // A 400 here means the user revoked access on Spotify's side. Drop the
      // connection so we stop hammering a token that will never work again.
      if (err.status === 400) {
        console.warn(`[MSG Arena activity] Spotify refresh rejected for user ${userId}; unlinking`);
        removeConnection(userId, 'spotify');
      }
      return null;
    }

    if (!data?.access_token) return null;
    const expiresAt = Date.now() + ((Number(data.expires_in) || 3600) * 1000);
    saveConnection(userId, 'spotify', {
      externalId: conn.external_id,
      displayName: conn.display_name,
      accessToken: data.access_token,
      refreshToken: data.refresh_token || null, // Spotify often omits on refresh
      expiresAt,
    });
    return data.access_token;
  }

  async function pollSpotifyUser(userId) {
    const conn = getConnection(userId, 'spotify');
    if (!conn) return;

    let token = decryptToken(conn.access_token);
    // Refresh a minute early rather than racing the expiry.
    if (!token || !conn.expires_at || Date.now() > Number(conn.expires_at) - 60_000) {
      token = await refreshSpotifyToken(userId, conn);
    }
    if (!token) return;

    let data;
    try {
      data = await fetchJson('https://api.spotify.com/v1/me/player/currently-playing', {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (err) {
      if (err.status === 401) {
        const fresh = await refreshSpotifyToken(userId, conn);
        if (!fresh) return;
      } else if (err.status !== 429) {
        console.warn(`[MSG Arena activity] Spotify poll failed for user ${userId}:`, err.message);
      }
      return;
    }

    // 204 (nothing playing) or paused → clear, but only if Spotify is what put
    // the current listen there. MSG Arena's own player wins its own slot.
    const entry = activity.get(userId);
    if (data?._empty || !data?.is_playing || !data?.item) {
      if (entry?.listening?.source === 'spotify') setSlot(userId, 'listening', null);
      return;
    }
    if (entry?.listening && entry.listening.source === 'haven') return;

    const item = data.item;
    const artists = Array.isArray(item.artists) ? item.artists.map(a => a?.name).filter(Boolean).join(', ') : '';
    setSlot(userId, 'listening', {
      type: 'listening',
      name: clean(item.name, 120),
      details: clean(artists, 80),
      image: safeImage(item.album?.images?.[0]?.url) || null,
      source: 'spotify',
      startedAt: Date.now(),
    });
  }

  async function pollSpotify() {
    if (!isSpotifyConfigured()) return;

    const online = new Set(getOnlineUserIds());
    if (online.size === 0) return;

    let rows = [];
    try {
      rows = db.prepare("SELECT user_id FROM user_connections WHERE provider = 'spotify'").all();
    } catch { return; }

    const eligible = rows.map(r => r.user_id).filter(id => {
      if (!online.has(id)) return false;
      const p = prefsFor(id);
      return p.master && p.music && !isInvisible(id);
    });
    if (eligible.length === 0) return;

    // Spotify is one request per user with no batch endpoint. Cap how many go
    // out per tick and rotate through the rest, so a server with 200 linked
    // listeners spreads its calls instead of bursting into a 429.
    const MAX_PER_TICK = 20;
    const slice = [];
    for (let i = 0; i < Math.min(MAX_PER_TICK, eligible.length); i++) {
      slice.push(eligible[(spotifyCursor + i) % eligible.length]);
    }
    spotifyCursor = (spotifyCursor + slice.length) % Math.max(1, eligible.length);

    await Promise.allSettled(slice.map(id => pollSpotifyUser(id)));
  }

  // ── Source 4: Last.fm ───────────────────────────────────
  // The whole reason this source exists: it needs no OAuth. `getRecentTracks`
  // is a public read keyed by username plus the server's API key, so linking
  // is a text box rather than a redirect dance, there are no per-user tokens
  // to encrypt or refresh, and there is no per-app user cap to run into.
  // It also covers whatever the user actually listens with — Spotify, Apple
  // Music, YouTube Music, Navidrome, Plex — because they all scrobble here.

  /** Confirm a username exists before saving it, so typos fail loudly. */
  async function verifyLastfmUser(username) {
    if (!isLastfmConfigured()) return { ok: false, reason: 'Last.fm is not configured on this server' };
    if (!LASTFM_USERNAME_RE.test(username)) return { ok: false, reason: 'That is not a valid Last.fm username' };
    try {
      const data = await fetchJson(
        `https://ws.audioscrobbler.com/2.0/?method=user.getinfo&user=${encodeURIComponent(username)}` +
        `&api_key=${encodeURIComponent(lastfmApiKey())}&format=json`
      );
      // Last.fm signals "no such user" with a 200 + error body, not a 404.
      if (data?.error || !data?.user) return { ok: false, reason: 'No Last.fm user by that name' };
      return { ok: true, name: clean(data.user.name, 30) || username };
    } catch (err) {
      return { ok: false, reason: 'Could not reach Last.fm — try again in a moment' };
    }
  }

  async function pollLastfmUser(userId) {
    const conn = getConnection(userId, 'lastfm');
    if (!conn?.external_id) return;

    let data;
    try {
      data = await fetchJson(
        `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${encodeURIComponent(conn.external_id)}` +
        `&api_key=${encodeURIComponent(lastfmApiKey())}&format=json&limit=1`
      );
    } catch (err) {
      if (err.status !== 429) console.warn(`[MSG Arena activity] Last.fm poll failed for user ${userId}:`, err.message);
      return;
    }

    // With limit=1 the API returns either an array or a bare object.
    const raw = data?.recenttracks?.track;
    const track = Array.isArray(raw) ? raw[0] : raw;

    const entry = activity.get(userId);
    // Only the "now playing" flag counts. Without this check the most recent
    // *finished* scrobble would show forever as if it were still playing.
    const nowPlaying = track && track['@attr'] && track['@attr'].nowplaying === 'true';
    if (!nowPlaying) {
      if (entry?.listening?.source === 'lastfm') setSlot(userId, 'listening', null);
      return;
    }
    // MSG Arena's own player owns the slot when the user is in a voice channel.
    if (entry?.listening && entry.listening.source === 'haven') return;

    const images = Array.isArray(track.image) ? track.image : [];
    const art = images.length ? images[images.length - 1]['#text'] : '';

    setSlot(userId, 'listening', {
      type: 'listening',
      name: clean(track.name, 120),
      details: clean(track.artist?.['#text'] || track.artist?.name || '', 80),
      image: safeImage(art) || null,
      source: 'lastfm',
      startedAt: Date.now(),
    });
  }

  async function pollLastfm() {
    if (!isLastfmConfigured()) return;

    const online = new Set(getOnlineUserIds());
    if (online.size === 0) return;

    let rows = [];
    try {
      rows = db.prepare("SELECT user_id FROM user_connections WHERE provider = 'lastfm'").all();
    } catch { return; }

    const eligible = rows.map(r => r.user_id).filter(id => {
      if (!online.has(id)) return false;
      const p = prefsFor(id);
      return p.master && p.music && !isInvisible(id);
    });
    if (eligible.length === 0) return;

    // Same round-robin as Spotify — one request per user, no batch endpoint,
    // and Last.fm asks for well under a few calls per second.
    const MAX_PER_TICK = 20;
    const slice = [];
    for (let i = 0; i < Math.min(MAX_PER_TICK, eligible.length); i++) {
      slice.push(eligible[(lastfmCursor + i) % eligible.length]);
    }
    lastfmCursor = (lastfmCursor + slice.length) % Math.max(1, eligible.length);

    await Promise.allSettled(slice.map(id => pollLastfmUser(id)));
  }

  // ── Lifecycle ───────────────────────────────────────────
  // ── Source 5: Twitch "live now" ─────────────────────────
  // OAuth (connectRoutes.js) proves the user owns the Twitch account and stores
  // their user_id (external_id) + login (display_name). Stream status itself is
  // read with an APP access token (client_credentials) — no per-user token,
  // refresh, or scope needed — so one batched Helix call covers everyone.
  let _twitchApp = { token: '', expiresAt: 0 };
  async function twitchAppToken() {
    if (_twitchApp.token && Date.now() < _twitchApp.expiresAt - 60_000) return _twitchApp.token;
    try {
      const params = new URLSearchParams({
        client_id: twitchClientId(),
        client_secret: twitchSecret(),
        grant_type: 'client_credentials',
      });
      const resp = await fetch('https://id.twitch.tv/oauth2/token?' + params, { method: 'POST' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const j = await resp.json();
      if (!j.access_token) throw new Error('no token');
      _twitchApp = { token: j.access_token, expiresAt: Date.now() + ((Number(j.expires_in) || 3600) * 1000) };
      return _twitchApp.token;
    } catch (err) {
      console.warn('[MSG Arena activity] Twitch app token failed:', err.message);
      return '';
    }
  }

  async function pollTwitch() {
    if (!isTwitchConfigured()) return;
    const online = new Set(getOnlineUserIds());
    if (online.size === 0) return;

    let rows = [];
    try {
      rows = db.prepare("SELECT user_id, external_id, display_name FROM user_connections WHERE provider = 'twitch'").all();
    } catch { return; }

    // Eligible = online, opted into game/activity sharing, not invisible, and
    // has a stored Twitch user_id to query.
    const byTwitchId = new Map();     // twitch user_id → local userId
    const logins = new Map();         // local userId → login
    for (const r of rows) {
      if (!online.has(r.user_id) || !r.external_id) continue;
      const p = prefsFor(r.user_id);
      if (!p.master || !p.games || isInvisible(r.user_id)) continue;
      byTwitchId.set(String(r.external_id), r.user_id);
      logins.set(r.user_id, r.display_name || '');
    }
    if (byTwitchId.size === 0) return;

    const token = await twitchAppToken();
    if (!token) return;

    // Helix accepts up to 100 user_id params per call.
    const ids = [...byTwitchId.keys()].slice(0, 100);
    let live = new Map();   // twitch user_id → stream
    try {
      const qs = ids.map(id => 'user_id=' + encodeURIComponent(id)).join('&');
      const resp = await fetch('https://api.twitch.tv/helix/streams?' + qs, {
        headers: { 'Client-Id': twitchClientId(), Authorization: 'Bearer ' + token },
      });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const j = await resp.json();
      for (const s of (j.data || [])) if (s.user_id) live.set(String(s.user_id), s);
    } catch (err) {
      console.warn('[MSG Arena activity] Twitch stream poll failed:', err.message);
      return;
    }

    for (const [twitchId, userId] of byTwitchId) {
      const stream = live.get(twitchId);
      const entry = activity.get(userId);
      if (stream) {
        const login = logins.get(userId) || stream.user_login || stream.user_name || '';
        const thumb = typeof stream.thumbnail_url === 'string'
          ? stream.thumbnail_url.replace('{width}', '320').replace('{height}', '180')
          : null;
        setSlot(userId, 'playing', {
          type: 'streaming',
          name: clean(stream.game_name || 'Live on Twitch', 120),
          details: clean('🔴 ' + (stream.title || 'Live now'), 100),
          image: safeImage(thumb) || null,
          source: 'twitch',
          url: login ? ('https://twitch.tv/' + encodeURIComponent(login)) : null,
          startedAt: Date.now(),
        });
      } else if (entry?.playing?.source === 'twitch') {
        setSlot(userId, 'playing', null);   // went offline — clear our own slot
      }
    }
  }

  function start() {
    // Both timers always run; each poller no-ops while its provider is
    // unconfigured. Registering unconditionally is what lets an admin paste
    // keys into Settings and have presence start working without a restart —
    // gating the intervals on boot-time config would strand them until reboot.
    timers.push(setInterval(() => { pollSteam().catch(() => {}); }, STEAM_POLL_MS));
    timers.push(setInterval(() => { pollSpotify().catch(() => {}); }, SPOTIFY_POLL_MS));
    timers.push(setInterval(() => { pollLastfm().catch(() => {}); }, LASTFM_POLL_MS));
    timers.push(setInterval(() => { pollTwitch().catch(() => {}); }, TWITCH_POLL_MS));
    timers.forEach(t => t.unref?.());
    if (isSteamConfigured())   console.log('[MSG Arena activity] Steam presence enabled');
    if (isSpotifyConfigured()) console.log('[MSG Arena activity] Spotify presence enabled');
    if (isLastfmConfigured())  console.log('[MSG Arena activity] Last.fm presence enabled');
    if (isTwitchConfigured())  console.log('[MSG Arena activity] Twitch presence enabled');
    if (!isSteamConfigured() && !isSpotifyConfigured() && !isLastfmConfigured() && !isTwitchConfigured()) {
      console.log('[MSG Arena activity] MSG Arena music presence enabled (no external keys set)');
    }
  }

  function stop() {
    timers.forEach(clearInterval);
    timers.length = 0;
  }

  return {
    // read
    getPublicActivity,
    sharingEnabled,
    listConnections,
    getProfileConnections,
    // write
    setHavenMusic,
    clearHavenMusic,
    clearUser,
    saveConnection,
    setSelfHandle,
    removeConnection,
    getConnection,
    // polling
    pollSteam,
    pollSpotifyUser,
    pollLastfmUser,
    pollTwitch,
    verifyLastfmUser,
    start,
    stop,
    // config probes for the client-side settings UI
    isSteamConfigured,
    isSpotifyConfigured,
    isLastfmConfigured,
    isTwitchConfigured,
  };
}

module.exports = {
  createActivity,
  encryptToken,
  decryptToken,
  isSteamConfigured,
  isSpotifyConfigured,
};
