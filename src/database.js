const Database = require('better-sqlite3');
const path = require('path');
const { DB_PATH } = require('./paths');
const { ensureSearchIndex } = require('./searchIndex');

let db;

// ── Prepared-statement cache ──────────────────────────────
// Every `db.prepare(sql)` allocates a native sqlite3_stmt.  In
// socketHandlers.js the same queries are prepared on every socket event,
// creating hundreds of native objects that only get freed when V8 GC
// collects the JS wrapper.  Under load, GC can't keep up and Oilpan
// hits a fatal "large allocation" error.
//
// This cache wraps db.prepare() so duplicate SQL strings reuse the same
// Statement object.  Node.js is single-threaded, so concurrent access is
// not a concern.  Dynamic SQL (e.g. `IN (?,?,?)`) still works — each
// unique SQL string just gets its own cache entry.
const _stmtCache = new Map();
const MAX_STMT_CACHE = 500;   // safety cap — shouldn't be hit in practice

function initDatabase() {
  db = new Database(DB_PATH);

  // ── Performance settings (memory-conscious) ────────────
  // These were originally set much higher (64 MB cache, 256 MB mmap) which
  // combined to reserve ~320 MB of native memory for SQLite alone.  On the
  // MSG Arena Desktop machine that also runs Electron + a renderer, that left
  // too little headroom and caused the Oilpan OOM crash.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');       // safe with WAL, 2-3x faster writes
  db.pragma('cache_size = -8000');          // 8 MB page cache (was 64 MB — overkill for a chat app)
  db.pragma('busy_timeout = 5000');         // wait up to 5 s on lock contention
  db.pragma('temp_store = MEMORY');         // keep temp tables in RAM
  db.pragma('mmap_size = 33554432');        // 32 MB memory-mapped I/O (was 256 MB)

  // Hard-cap SQLite's own heap usage so it can never run away
  db.pragma('soft_heap_limit = 33554432');  // 32 MB soft limit — SQLite tries to stay under
  db.pragma('hard_heap_limit = 67108864');  // 64 MB hard ceiling

  // ── Statement cache — intercept db.prepare() ──────────
  const _origPrepare = db.prepare.bind(db);
  db.prepare = function cachedPrepare(sql) {
    let stmt = _stmtCache.get(sql);
    if (stmt) return stmt;
    // Safety cap: if cache grows too large (dynamic SQL), clear older entries
    if (_stmtCache.size >= MAX_STMT_CACHE) {
      // Remove oldest ~half of entries
      const keys = [..._stmtCache.keys()];
      for (let i = 0; i < keys.length / 2; i++) _stmtCache.delete(keys[i]);
    }
    stmt = _origPrepare(sql);
    _stmtCache.set(sql, stmt);
    return stmt;
  };

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      is_admin INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      code TEXT UNIQUE NOT NULL,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS channel_members (
      channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (channel_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      reply_to INTEGER REFERENCES messages(id) ON DELETE SET NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS reactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      emoji TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(message_id, user_id, emoji)
    );

    CREATE TABLE IF NOT EXISTS bans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      banned_by INTEGER NOT NULL REFERENCES users(id),
      reason TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id)
    );

    -- Ban appeals (#5457). A banned user who authenticates with the correct
    -- password can submit one appeal, which admins see next to the ban in the
    -- Banned Users list. UNIQUE(user_id) keeps it to one active appeal per
    -- user (re-submitting overwrites). Rows are removed when the user is
    -- unbanned or the appeal is dismissed.
    CREATE TABLE IF NOT EXISTS ban_appeals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      appeal TEXT NOT NULL DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id)
    );

    CREATE TABLE IF NOT EXISTS mutes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      muted_by INTEGER NOT NULL REFERENCES users(id),
      reason TEXT DEFAULT '',
      expires_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- IP-level bans (v3.20.0). Independent of bans (user_id) so an admin can
    -- ban an address without tying it to a specific user row, and a user-ban
    -- with the "also ban IP" checkbox writes into both tables. Connections
    -- from these IPs are rejected before auth runs.
    CREATE TABLE IF NOT EXISTS ip_bans (
      ip          TEXT PRIMARY KEY,
      banned_by   INTEGER REFERENCES users(id),
      reason      TEXT DEFAULT '',
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Recent IPs observed per user. Populated by the socket auth middleware
    -- after a successful token verify. Used so the "Also ban IP" checkbox
    -- on the Ban modal can look up the right address(es) to ban without
    -- the moderator having to type one in. Capped to the last 5 distinct
    -- IPs per user via a pruning step on insert.
    CREATE TABLE IF NOT EXISTS user_ips (
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ip         TEXT    NOT NULL,
      last_seen  DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, ip)
    );
    CREATE INDEX IF NOT EXISTS idx_user_ips_last_seen ON user_ips(user_id, last_seen);

    -- ── Auto-moderation (v3.42.0) ──────────────────────────
    -- Domain policy for posted links. mode is 'allow' or 'deny'; deny always
    -- wins over allow so a single bad subdomain can be carved out of an
    -- otherwise-trusted parent. Domains are stored normalized (lowercase, no
    -- scheme, no leading "www.", no trailing dot) by src/automod.js so that
    -- comparisons never have to guess at formatting.
    CREATE TABLE IF NOT EXISTS automod_domains (
      domain             TEXT PRIMARY KEY,
      mode               TEXT NOT NULL DEFAULT 'allow',
      include_subdomains INTEGER NOT NULL DEFAULT 1,
      note               TEXT DEFAULT '',
      added_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at         DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- One row per blocked action. Drives warn -> mute -> ban escalation via a
    -- rolling time window, and doubles as the admin-facing "what has automod
    -- been doing" feed. Kept separate from audit_log because it is written on
    -- a hot path and pruned on its own schedule.
    CREATE TABLE IF NOT EXISTS automod_infractions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
      rule       TEXT NOT NULL,
      channel_id INTEGER,
      host       TEXT,
      excerpt    TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_automod_inf_user ON automod_infractions(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_automod_inf_created ON automod_infractions(created_at DESC);

    CREATE TABLE IF NOT EXISTS server_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_preferences (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (user_id, key)
    );

    CREATE TABLE IF NOT EXISTS eula_acceptances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      version TEXT NOT NULL,
      ip_address TEXT,
      accepted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, version)
    );

    -- Managed invite links. Unlike the single server_code/vanity_code settings,
    -- each row is its own code with its own channel grant, on/off switch, and
    -- optional expiry (by time and/or distinct-user count). channels is a JSON
    -- array of channel IDs; '' or '[]' means "all public channels".
    CREATE TABLE IF NOT EXISTS invite_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      label TEXT DEFAULT '',
      channels TEXT DEFAULT '',
      enabled INTEGER DEFAULT 1,
      max_uses INTEGER DEFAULT 0,
      expires_at DATETIME DEFAULT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- One row per distinct user who redeemed a code, so re-entering a code a
    -- user already used never burns an extra "use" against max_uses.
    CREATE TABLE IF NOT EXISTS invite_code_uses (
      invite_code_id INTEGER NOT NULL REFERENCES invite_codes(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      used_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (invite_code_id, user_id)
    );

    -- Who uploaded which file, recorded at the upload endpoint. Message content
    -- is the only other record of an attachment, and in a DM that content is E2E
    -- ciphertext (the file bytes are encrypted client-side too), so scanning
    -- messages would silently miss every private upload, which is exactly the
    -- storage nobody could account for before. The upload endpoint is the one
    -- place the server still knows both the uploader and the file. Sizes are
    -- re-read from disk when the member list is built, so a file that has been
    -- deleted or purged stops counting without a bookkeeping hook here.
    CREATE TABLE IF NOT EXISTS upload_ownership (
      rel_path TEXT PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      bytes INTEGER NOT NULL DEFAULT 0,
      scope TEXT NOT NULL DEFAULT 'channel',   -- 'channel' | 'dm' | 'profile'
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_upload_ownership_user
      ON upload_ownership(user_id);

    CREATE INDEX IF NOT EXISTS idx_messages_channel
      ON messages(channel_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_channel_code
      ON channels(code);
    CREATE INDEX IF NOT EXISTS idx_reactions_message
      ON reactions(message_id);
    CREATE INDEX IF NOT EXISTS idx_bans_user
      ON bans(user_id);
    CREATE INDEX IF NOT EXISTS idx_mutes_user
      ON mutes(user_id, expires_at);
    CREATE INDEX IF NOT EXISTS idx_messages_channel_id
      ON messages(channel_id, id DESC);
  `);

  // ── Safe schema migration for existing databases ──────
  try {
    db.prepare("SELECT reply_to FROM messages LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE messages ADD COLUMN reply_to INTEGER REFERENCES messages(id) ON DELETE SET NULL");
  }

  // Create reactions table if it doesn't exist (already handled by CREATE IF NOT EXISTS above)
  // but index may be missing on older DBs
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id)");
  } catch { /* already exists */ }

  // ── Migration: must_change_password flag on users (#5300) ──
  // Set to 1 by admin password-reset; cleared the first time the user
  // sets a new password through the forced-change flow. Login still
  // succeeds when the flag is set — the client routes the user to a
  // mandatory change-password screen before the rest of the app loads.
  try {
    db.prepare("SELECT must_change_password FROM users LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE users ADD COLUMN must_change_password INTEGER DEFAULT 0");
  }

  // ── Migration: temp_password_hash for admin-reset DM preservation (#5300) ──
  // When an admin resets a user's password we now write the temp password's
  // bcrypt hash to this column instead of overwriting `password_hash`. Login
  // accepts EITHER hash. This gives the user an escape hatch: if they still
  // remember their original password they can log in with it and the temp
  // hash is silently cleared, cancelling the reset and preserving their
  // E2E DM wrap key (which is PBKDF2-derived from the password). Only if
  // the user logs in with the temp pw does the forced change-password
  // flow rotate `password_hash`, which is when DM history becomes
  // unrecoverable on their side.
  try {
    db.prepare("SELECT temp_password_hash FROM users LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE users ADD COLUMN temp_password_hash TEXT DEFAULT NULL");
  }

  // ── Migration: is_guest flag on users (#5381) ──────────
  // 1 = ephemeral guest account created via Join-as-Guest. Guests have no
  // password, can only see/post in channels the admin whitelisted, and are
  // deleted from the users table when their last socket disconnects so the
  // username is freed for the next person who wants it.
  try {
    db.prepare("SELECT is_guest FROM users LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE users ADD COLUMN is_guest INTEGER DEFAULT 0");
  }

  // ── Migration: edited_at column on messages ───────────
  try {
    db.prepare("SELECT edited_at FROM messages LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE messages ADD COLUMN edited_at DATETIME DEFAULT NULL");
  }

  // ── Migration: burn-after-read columns on messages (#5280) ──
  // burn_seconds: 0 = no burn (default); >0 = delete N seconds after first
  // recipient view. burning_started_at is NULL until the first viewer sends
  // a `mark-burning` event; once set, the periodic sweep below deletes the
  // row when (started_at + burn_seconds) < now.
  try {
    db.prepare("SELECT burn_seconds FROM messages LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE messages ADD COLUMN burn_seconds INTEGER DEFAULT 0");
    db.exec("ALTER TABLE messages ADD COLUMN burning_started_at DATETIME DEFAULT NULL");
  }

  // ── Migration: break_chain flag on messages (#5393) ────
  // 1 = this message must not visually compact with the previous one
  // (used by the `/break` slash command and reinforced for persona
  // messages so different personas under the same account never merge
  // into a single grouped block).
  try {
    db.prepare("SELECT break_chain FROM messages LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE messages ADD COLUMN break_chain INTEGER DEFAULT 0");
  }

  // ── Migration: type column on messages (persistent welcome messages) ──
  // 'user' (default) = an ordinary user message. 'welcome' = a persisted
  // welcome message posted when a new member first registers. It is stored
  // like any message so it stays in history for everyone, replacing the old
  // ephemeral (live-only) welcome that vanished on reload.
  try {
    db.prepare("SELECT type FROM messages LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE messages ADD COLUMN type TEXT DEFAULT 'user'");
  }

  // ── Migration: show_welcome flag on channels (persistent welcome messages) ──
  // 1 = new-member welcome messages are posted to this channel. On existing
  // servers the first/default channel is switched on so the feature works out
  // of the box; admins toggle it per channel in Channel Functions. Fresh
  // installs flag their first-ever channel at creation time instead.
  try {
    db.prepare("SELECT show_welcome FROM channels LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE channels ADD COLUMN show_welcome INTEGER DEFAULT 0");
    try {
      const firstChannel = db.prepare(
        "SELECT id FROM channels WHERE is_dm = 0 ORDER BY position ASC, id ASC LIMIT 1"
      ).get();
      if (firstChannel) {
        db.prepare("UPDATE channels SET show_welcome = 1 WHERE id = ?").run(firstChannel.id);
      }
    } catch { /* no channels yet — fresh install handles this at channel creation */ }
  }

  // ── Migration: high_scores table ────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS high_scores (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      game TEXT NOT NULL,
      score INTEGER NOT NULL DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, game)
    );
  `);

  // ── Migration: user_nicknames table (#5394) ──────────────
  // Personal, private nicknames — only visible to the user who set them.
  // owner_id = the user who assigned the nickname; target_id = the user being renamed.
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_nicknames (
      owner_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      target_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      nickname  TEXT NOT NULL,
      PRIMARY KEY (owner_id, target_id)
    );
  `);

  // ── Migration: whitelist table ─────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS whitelist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL COLLATE NOCASE,
      added_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // ── Migration: seed default server settings ───────────
  const insertSetting = db.prepare(
    'INSERT OR IGNORE INTO server_settings (key, value) VALUES (?, ?)'
  );
  insertSetting.run('member_visibility', 'online');  // 'all', 'online', 'none'
  insertSetting.run('cleanup_enabled', 'false');       // auto-cleanup toggle
  insertSetting.run('cleanup_max_age_days', '0');      // delete messages older than N days (0 = disabled)
  insertSetting.run('cleanup_max_size_mb', '0');       // delete oldest messages when DB exceeds N MB (0 = disabled)
  insertSetting.run('whitelist_enabled', 'false');     // whitelist toggle
  // Empty on purpose. A stored value always beats SERVER_NAME, so seeding the
  // literal 'MSG ARENA' here meant a server started with SERVER_NAME=Foo in its
  // compose file was named MSG ARENA anyway and nothing in the panel explained
  // why. Blank means "not set here", which lets SERVER_NAME through and falls
  // back to MSG Arena when that is unset too. (#5489)
  insertSetting.run('server_name', '');                // displayed in sidebar header + server bar
  insertSetting.run('server_icon', '');                // path to uploaded server icon image
  insertSetting.run('permission_thresholds', '{"create_channel":50,"manage_channel_settings":50}');    // JSON: { permission: minLevel } — auto-grant perms at level
  insertSetting.run('server_code', '');                // server-wide invite code (joins all channels)
  insertSetting.run('default_join_channels', '');       // (#5345) JSON array of channel IDs that server-code/vanity-code joiners get added to (empty = all public)
  insertSetting.run('registration_token_enabled', 'false'); // (#5344) require a token on the registration form
  insertSetting.run('invites_bypass_registration_token', 'false'); // Allow invite links to bypass token on the registration form
  insertSetting.run('registration_token', '');          // (#5344) the token value (admin-generated, rerollable)
  insertSetting.run('registration_captcha_enabled', 'false'); // opt-in Cloudflare Turnstile CAPTCHA on registration
  insertSetting.run('turnstile_site_key', '');          // Turnstile public site key (safe to expose to the page)
  insertSetting.run('turnstile_secret_key', '');        // Turnstile secret key (server-side verification only, never sent to clients)
  insertSetting.run('registration_rate_limit_enabled', 'false'); // opt-in global cap on new accounts per hour
  insertSetting.run('registration_rate_limit_per_hour', '20');   // the cap value when enabled
  insertSetting.run('max_invite_uses', '0');            // the maximum uses each non-admin/manage-server invite link can accept
  insertSetting.run('max_upload_mb', '25');             // max file upload size in MB
  insertSetting.run('max_poll_options', '10');            // max poll answer options (2–25)
  insertSetting.run('max_message_chars', '2000');         // max characters per message (200–100000)
  insertSetting.run('max_sound_kb', '1024');              // max soundboard file size in KB (256–10240)
  insertSetting.run('max_emoji_kb', '256');               // max emoji file size in KB (64–1024)
  insertSetting.run('max_sticker_kb', '1024');            // max sticker file size in KB (256–10240) — #5392
  insertSetting.run('max_clip_mb', '100');                // max clip (video) upload size in MB — separate from max_upload_mb so raising it doesn't raise every attachment cap
  insertSetting.run('clip_retention_days', '0');          // auto-delete clips older than N days; 0 = keep forever
  insertSetting.run('sfu_enabled', 'false');              // route voice through the in-process SFU (scales past the P2P mesh cap); off = P2P mesh (default)
  insertSetting.run('unicode_emoji_auto_update', 'false'); // monthly refresh of the built-in emoji set from unicode.org, opt-in, defaults off (UNICODE_EMOJI_AUTO_UPDATE env overrides)
  insertSetting.run('setup_wizard_complete', 'false');   // first-time admin setup wizard
  insertSetting.run('update_banner_admin_only', 'false'); // hide update banner from non-admins
  insertSetting.run('session_duration_days', '0');       // login token lifetime in days; 0 = never expire (default for new installs, #5391). Existing installs that were seeded with '7' keep that value until the admin changes it.
  insertSetting.run('published_themes', '[]');             // JSON array of *.theme.css filenames shown in the theme picker
  insertSetting.run('admin_password_reset_enabled', 'false'); // admin can reset user passwords (#5300), opt-in, defaults off
  insertSetting.run('guests_enabled', 'false');          // (#5381) allow Join-as-Guest on the login page
  insertSetting.run('guest_channels', '');               // (#5381) CSV of channel IDs guests are auto-joined to (empty = none)
  // (#5399) Voice connectivity. Admin-configurable STUN/TURN, served by
  // /api/ice-servers. All empty by default = use the built-in STUN pool.
  insertSetting.run('stun_urls', '');                    // newline/comma separated stun: URIs (empty = built-in defaults)
  insertSetting.run('turn_url', '');                     // optional turn: URI for relaying through hard NAT
  insertSetting.run('turn_username', '');                // static TURN username (used when turn_url is set)
  insertSetting.run('turn_password', '');                // static TURN credential
  // (v3.42.0) Force every voice peer connection through the TURN relay.
  // MSG Arena voice is a peer-to-peer WebRTC mesh, so by default anyone who joins
  // a voice channel with you learns your public IP from the ICE candidate
  // exchange, with no click and no consent prompt. Relay-only hides it behind
  // the TURN server. Requires turn_url to be configured; the settings handler
  // refuses to enable it otherwise, because without TURN this breaks voice.
  insertSetting.run('voice_force_relay', 'false');

  // ── Auto-moderation (v3.42.0) ─────────────────────────
  // Every value here is deliberately inert on upgrade: an existing server
  // gets the tables and the settings rows but no behaviour change until an
  // admin turns automod on.
  // (v3.43.0) On by default. The protections that cannot break a server are
  // enabled out of the box, because "secure only if the admin finds the
  // setting" is how the incident these were written for happened in the first
  // place. The two that CAN break things stay off: voice_force_relay (needs a
  // TURN server) and automod_ban_ip (shared/CGNAT addresses catch bystanders).
  insertSetting.run('automod_enabled', 'true');
  insertSetting.run('automod_link_mode', 'allowlist');        // 'off' | 'allowlist' | 'blocklist'
  insertSetting.run('automod_link_exempt_level', '50');       // effective level that bypasses link filtering
  insertSetting.run('automod_link_min_account_hours', '24');  // accounts younger than this post no links at all
  insertSetting.run('automod_scan_edits', 'true');            // otherwise: post clean, edit in the payload
  insertSetting.run('automod_scan_profile', 'true');          // display name / status text / bio
  insertSetting.run('automod_scan_dms', 'true');              // mass-DM spam is worse than a channel post
  insertSetting.run('automod_block_ip_urls', 'true');
  insertSetting.run('automod_block_punycode', 'true');        // homoglyph lookalike domains
  insertSetting.run('automod_block_obfuscated', 'true');      // hxxp:// and evil[.]com defanging
  insertSetting.run('automod_preview_allowlist_only', 'true'); // closes the passive IP leak via og:image
  insertSetting.run('automod_escalation', '{"windowHours":24,"warnAt":1,"muteAt":3,"muteMinutes":60,"banAt":5}');
  insertSetting.run('automod_ban_ip', 'false');               // escalated bans also ban recent IPs
  insertSetting.run('automod_log_channel', '');               // channel code to mirror automod actions into
  insertSetting.run('automod_seeded', 'false');               // starter allowlist planted once, see below

  // (v3.43.0) Server-side media proxy. Remote images are fetched by the server
  // and cached on disk so clients never contact a third-party host. On by
  // default: it costs bandwidth but nothing breaks without it, and leaving it
  // off means every embedded image leaks the viewer's IP to whoever posted it.
  insertSetting.run('media_proxy_enabled', 'true');

  // Google FCM mobile push. On by default so existing Android users keep getting
  // notifications on upgrade; admins who prefer a Google-free path (UnifiedPush /
  // ntfy) can turn it off under Settings → Security → FCM Privacy. Off skips FCM
  // sends only, so web-push to browsers is unaffected.
  insertSetting.run('fcm_enabled', 'true');
  insertSetting.run('xp_enabled', 'true');  // activity leveling on by default (gaming app); admin can disable

  // Unique server fingerprint — used by the multi-server sidebar to detect "self"
  const crypto = require('crypto');
  insertSetting.run('server_fingerprint', crypto.randomUUID());

  // ── Migration: starter link allowlist (v3.42.0) ───────
  // Planted exactly once, guarded by automod_seeded, so an admin who prunes
  // this list does not find it silently regrown on the next restart. These
  // are the domains a general-purpose community server actually needs before
  // allowlist mode becomes usable; anything else is the admin's call.
  try {
    const seeded = db.prepare("SELECT value FROM server_settings WHERE key = 'automod_seeded'").get();
    if (!seeded || seeded.value !== 'true') {
      const addDomain = db.prepare(
        "INSERT OR IGNORE INTO automod_domains (domain, mode, include_subdomains, note) VALUES (?, 'allow', 1, 'Seeded default')"
      );
      const starter = [
        'youtube.com', 'youtu.be', 'twitch.tv', 'x.com', 'twitter.com', 'bsky.app',
        'reddit.com', 'github.com', 'gitlab.com', 'stackoverflow.com', 'wikipedia.org',
        'imgur.com', 'giphy.com', 'tenor.com', 'spotify.com', 'soundcloud.com',
        'steamcommunity.com', 'steampowered.com', 'last.fm', 'archive.org'
      ];
      const seedAll = db.transaction((list) => { for (const d of list) addDomain.run(d); });
      seedAll(starter);
      db.prepare("INSERT OR REPLACE INTO server_settings (key, value) VALUES ('automod_seeded', 'true')").run();
    }
  } catch (err) {
    console.error('automod starter allowlist seed failed:', err.message);
  }

  // ── Migration: turn the safe protections on, once (v3.43.0) ──
  // The seeds above are INSERT OR IGNORE, so they only reach brand-new
  // installs. A server that already ran 3.42.0 (where everything defaulted
  // off) keeps its inert rows without this. Guarded by its own flag so an
  // admin who later decides to switch automod off does not find it turned
  // back on at the next restart.
  try {
    const done = db.prepare("SELECT value FROM server_settings WHERE key = 'automod_defaults_v343'").get();
    if (!done || done.value !== 'true') {
      const put = db.prepare('INSERT OR REPLACE INTO server_settings (key, value) VALUES (?, ?)');
      const flip = db.transaction(() => {
        put.run('automod_enabled', 'true');
        put.run('automod_link_mode', 'allowlist');
        put.run('automod_preview_allowlist_only', 'true');
        put.run('automod_scan_edits', 'true');
        put.run('automod_scan_dms', 'true');
        put.run('automod_scan_profile', 'true');
        put.run('automod_block_ip_urls', 'true');
        put.run('automod_block_punycode', 'true');
        put.run('automod_block_obfuscated', 'true');
        put.run('media_proxy_enabled', 'true');
        // Only set the new-account hold if the admin has not chosen a value.
        const cur = db.prepare("SELECT value FROM server_settings WHERE key = 'automod_link_min_account_hours'").get();
        if (!cur || cur.value === '0') put.run('automod_link_min_account_hours', '24');
        put.run('automod_defaults_v343', 'true');
      });
      flip();
      console.log('🛡️  Auto-mod protections enabled (v3.43.0 defaults). Settings → Auto-Mod to adjust.');
    }
  } catch (err) {
    console.error('automod default migration failed:', err.message);
  }

  // ── Migration: pinned_messages table ──────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS pinned_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      pinned_by INTEGER NOT NULL REFERENCES users(id),
      pinned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_pinned_channel ON pinned_messages(channel_id);
  `);

  // ── Migration: user status columns ──────────────────────
  try {
    db.prepare("SELECT status FROM users LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'online'");
  }
  try {
    db.prepare("SELECT status_text FROM users LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE users ADD COLUMN status_text TEXT DEFAULT ''");
  }

  // ── Migration: display_name column ────────────────────────
  try {
    db.prepare("SELECT display_name FROM users LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE users ADD COLUMN display_name TEXT DEFAULT NULL");
  }

  // ── Migration: display_name_locked (#5482) ────────────────
  // Set when a moderator sets someone's display name, cleared when it is
  // reset back to their username. Without it the moderated user just renames
  // themselves again a minute later and the moderation action means nothing.
  try {
    db.prepare("SELECT display_name_locked FROM users LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE users ADD COLUMN display_name_locked INTEGER DEFAULT 0");
  }

  // ── Migration: avatar column ──────────────────────────────
  try {
    db.prepare("SELECT avatar FROM users LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE users ADD COLUMN avatar TEXT DEFAULT NULL");
  }

  // ── Migration: avatar_shape column ────────────────────────
  try {
    db.prepare("SELECT avatar_shape FROM users LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE users ADD COLUMN avatar_shape TEXT DEFAULT 'circle'");
  }

  // ── Migration: animate_profile column (pfp animation policy) ──
  try {
    db.prepare("SELECT animate_profile FROM users LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE users ADD COLUMN animate_profile TEXT DEFAULT 'trigger'");
  }

  // ── Migration: border column (pfp overlay, mirrors avatar) ──
  try {
    db.prepare("SELECT border FROM users LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE users ADD COLUMN border TEXT DEFAULT NULL");
  }

  // ── Migration: border_transform column (pfp-overlay fit, JSON op log) ──
  try {
    db.prepare("SELECT border_transform FROM users LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE users ADD COLUMN border_transform TEXT DEFAULT NULL");
  }

  // ── Migration: bio column ─────────────────────────────────
  try {
    db.prepare("SELECT bio FROM users LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE users ADD COLUMN bio TEXT DEFAULT ''");
  }

  // ── Migration: custom_sounds table (admin-uploaded notification sounds) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_sounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      filename TEXT NOT NULL,
      uploaded_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // ── Migration: sound visibility/ordering (per-user sound preferences) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS sound_preferences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sound_name TEXT NOT NULL,
      hidden INTEGER DEFAULT 0,
      custom_order INTEGER DEFAULT NULL,
      UNIQUE(user_id, sound_name)
    );
    CREATE INDEX IF NOT EXISTS idx_sound_prefs_user ON sound_preferences(user_id);
  `);

  // ── Migration: disabled_builtin_sounds (admin-hidden built-in sounds) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS disabled_builtin_sounds (
      name TEXT PRIMARY KEY NOT NULL
    );
  `);

  // ── Migration: custom_emojis table (admin-uploaded server emojis) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_emojis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      filename TEXT NOT NULL,
      uploaded_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // ── Migration: stickers table (admin-uploaded server stickers) ──
  // Stickers are sent as standalone /uploads/stickers/<file> URLs (same
  // mechanism as GIFs) and grouped into packs in the picker.
  db.exec(`
    CREATE TABLE IF NOT EXISTS stickers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      pack_name TEXT NOT NULL DEFAULT 'General',
      filename TEXT NOT NULL,
      uploaded_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // ── Migration: channel topic column ─────────────────────
  try {
    db.prepare("SELECT topic FROM channels LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE channels ADD COLUMN topic TEXT DEFAULT ''");
  }

  // ── Migration: DM flag on channels ──────────────────────
  try {
    db.prepare("SELECT is_dm FROM channels LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE channels ADD COLUMN is_dm INTEGER DEFAULT 0");
  }

  // ── Migration: age_verified on eula_acceptances ─────────
  try {
    db.prepare("SELECT age_verified FROM eula_acceptances LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE eula_acceptances ADD COLUMN age_verified INTEGER DEFAULT 0");
  }

  // ── Migration: read positions table ─────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS read_positions (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      last_read_message_id INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, channel_id)
    );
  `);

  // ── Migration: original_name on messages for file uploads ──
  try {
    db.prepare("SELECT original_name FROM messages LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE messages ADD COLUMN original_name TEXT DEFAULT NULL");
  }

  // ── Migration: channel code settings columns ─────────────
  const codeSettingsCols = [
    { name: 'code_visibility',        sql: "ALTER TABLE channels ADD COLUMN code_visibility TEXT DEFAULT 'public'" },
    { name: 'code_mode',              sql: "ALTER TABLE channels ADD COLUMN code_mode TEXT DEFAULT 'static'" },
    { name: 'code_rotation_type',     sql: "ALTER TABLE channels ADD COLUMN code_rotation_type TEXT DEFAULT 'time'" },
    { name: 'code_rotation_interval', sql: "ALTER TABLE channels ADD COLUMN code_rotation_interval INTEGER DEFAULT 60" },
    { name: 'code_rotation_counter',  sql: "ALTER TABLE channels ADD COLUMN code_rotation_counter INTEGER DEFAULT 0" },
    { name: 'code_last_rotated',      sql: "ALTER TABLE channels ADD COLUMN code_last_rotated DATETIME DEFAULT NULL" },
  ];
  for (const col of codeSettingsCols) {
    try { db.prepare(`SELECT ${col.name} FROM channels LIMIT 0`).get(); } catch { db.exec(col.sql); }
  }

  // ── Migration: per-channel default role (#5389) ──────────
  // When set, every existing and future member of this channel is granted
  // this role scoped to this channel via user_roles. NULL = no auto-grant.
  try {
    db.prepare("SELECT default_role_id FROM channels LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE channels ADD COLUMN default_role_id INTEGER DEFAULT NULL REFERENCES roles(id) ON DELETE SET NULL");
  }

  // ── Migration: sub-channels (parent_channel_id, position) ──
  try {
    db.prepare("SELECT parent_channel_id FROM channels LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE channels ADD COLUMN parent_channel_id INTEGER DEFAULT NULL REFERENCES channels(id) ON DELETE SET NULL");
  }
  try {
    db.prepare("SELECT position FROM channels LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE channels ADD COLUMN position INTEGER DEFAULT 0");
  }

  // ── Migration: private sub-channels ──────────────────────
  try {
    db.prepare("SELECT is_private FROM channels LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE channels ADD COLUMN is_private INTEGER DEFAULT 0");
  }

  // ── Migration: temporary channel expiry ─────────────────
  try {
    db.prepare("SELECT expires_at FROM channels LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE channels ADD COLUMN expires_at DATETIME DEFAULT NULL");
  }

  // ── Migration: temporary voice channel flag (#163) ──────
  try {
    db.prepare("SELECT is_temp_voice FROM channels LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE channels ADD COLUMN is_temp_voice INTEGER DEFAULT 0");
  }

  // ── Migration: webhook message tracking ─────────────────
  try {
    db.prepare("SELECT is_webhook FROM messages LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE messages ADD COLUMN is_webhook INTEGER DEFAULT 0");
  }
  try {
    db.prepare("SELECT webhook_username FROM messages LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE messages ADD COLUMN webhook_username TEXT DEFAULT NULL");
  }

  // ── Migration: personas (proxy feature) (#86, #5349) ────
  // Per-user personas: name + avatar override stored on the message so the
  // real user_id stays intact for moderation / kicks / bans, but the
  // displayed identity is the persona.
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_personas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      avatar TEXT DEFAULT NULL,
      bio TEXT DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, name COLLATE NOCASE)
    );
    CREATE INDEX IF NOT EXISTS idx_user_personas_user ON user_personas(user_id);
  `);
  const personaMsgCols = [
    { name: 'persona_id',       sql: "ALTER TABLE messages ADD COLUMN persona_id INTEGER DEFAULT NULL REFERENCES user_personas(id) ON DELETE SET NULL" },
    { name: 'persona_username', sql: "ALTER TABLE messages ADD COLUMN persona_username TEXT DEFAULT NULL" },
    // Ferry: which Discord destination this message was addressed to, as a
    // display label ("MyServer#general") or the literal 'dm'. Null for the vast
    // majority of messages. Stored so channel history can show where a message
    // went instead of leaving the routing prefix in the body.
    { name: 'ferry_target', sql: "ALTER TABLE messages ADD COLUMN ferry_target TEXT DEFAULT NULL" },
    { name: 'persona_avatar',   sql: "ALTER TABLE messages ADD COLUMN persona_avatar TEXT DEFAULT NULL" },
  ];
  for (const col of personaMsgCols) {
    try { db.prepare(`SELECT ${col.name} FROM messages LIMIT 0`).get(); } catch { db.exec(col.sql); }
  }

  // ── Migration: roles system ─────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      level INTEGER NOT NULL DEFAULT 0,
      scope TEXT NOT NULL DEFAULT 'server',
      color TEXT DEFAULT NULL,
      auto_assign INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS user_roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      channel_id INTEGER DEFAULT NULL REFERENCES channels(id) ON DELETE CASCADE,
      granted_by INTEGER REFERENCES users(id),
      granted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (user_id, role_id, channel_id)
    );

    CREATE TABLE IF NOT EXISTS role_permissions (
      role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      permission TEXT NOT NULL,
      allowed INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (role_id, permission)
    );

    CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_roles_channel ON user_roles(channel_id);
  `);

  // Seed default roles if none exist
  const roleCount = db.prepare('SELECT COUNT(*) as cnt FROM roles').get();
  if (roleCount.cnt === 0) {
    const insertRole = db.prepare('INSERT INTO roles (name, level, scope, color) VALUES (?, ?, ?, ?)');
    const insertPerm = db.prepare('INSERT INTO role_permissions (role_id, permission, allowed) VALUES (?, ?, 1)');

    // Server Mod — level 50 (below admin which is implied level 100)
    const serverMod = insertRole.run('Server Mod', 50, 'server', '#3498db');
    const serverModPerms = [
      'kick_user', 'mute_user', 'delete_message', 'pin_message',
      'set_channel_topic', 'manage_sub_channels', 'rename_channel',
      'rename_sub_channel', 'delete_lower_messages', 'manage_webhooks',
      'use_ferry',
      'upload_files', 'use_voice', 'view_history', 'view_all_members',
      'manage_music_queue', 'manage_lfg', 'manage_clips', 'manage_tournaments', 'manage_events',
      'delete_own_messages', 'edit_own_messages'
    ];
    serverModPerms.forEach(p => insertPerm.run(serverMod.lastInsertRowid, p));

    // Channel Mod — level 25 (channel-scoped)
    const channelMod = insertRole.run('Channel Mod', 25, 'channel', '#2ecc71');
    const channelModPerms = [
      'kick_user', 'mute_user', 'delete_message', 'pin_message',
      'manage_sub_channels', 'rename_sub_channel', 'delete_lower_messages',
      'upload_files', 'use_voice', 'view_history', 'view_channel_members', 'manage_music_queue',
      'manage_lfg', 'manage_clips', 'manage_tournaments', 'manage_events',
      'delete_own_messages', 'edit_own_messages'
    ];
    channelModPerms.forEach(p => insertPerm.run(channelMod.lastInsertRowid, p));

    // User — level 1 (default role for all new users, auto-assigned)
    const userRole = insertRole.run('User', 1, 'server', '#95a5a6');
    db.prepare('UPDATE roles SET auto_assign = 1 WHERE id = ?').run(userRole.lastInsertRowid);
    const userPerms = [
      'delete_own_messages', 'edit_own_messages', 'upload_files',
      'use_voice', 'view_history', 'use_tts', 'create_lfg', 'post_clips'
    ];
    userPerms.forEach(p => insertPerm.run(userRole.lastInsertRowid, p));
  }

  // ── Migration: add auto_assign column to roles if missing ──
  try {
    db.prepare('SELECT auto_assign FROM roles LIMIT 0').get();
  } catch {
    db.exec('ALTER TABLE roles ADD COLUMN auto_assign INTEGER NOT NULL DEFAULT 0');
    // Mark the existing "User" role as auto-assign for backwards compat
    db.prepare("UPDATE roles SET auto_assign = 1 WHERE name = 'User' AND level = 1 AND scope = 'server'").run();
  }

  // ── Migration: auto-assign flagged roles to all existing users who lack any server role ──
  const autoRoles = db.prepare('SELECT id FROM roles WHERE auto_assign = 1 AND scope = ?').all('server');
  for (const ar of autoRoles) {
    db.prepare(`
      INSERT OR IGNORE INTO user_roles (user_id, role_id, channel_id, granted_by)
      SELECT u.id, ?, NULL, NULL FROM users u
      WHERE u.id NOT IN (SELECT DISTINCT user_id FROM user_roles WHERE channel_id IS NULL)
    `).run(ar.id);
  }

  // ── Cleanup: remove duplicate user_roles (NULL channel_id duplicates) ──
  // SQLite UNIQUE constraints don't prevent duplicate NULLs, so clean up on startup
  db.exec(`
    DELETE FROM user_roles WHERE id NOT IN (
      SELECT MIN(id) FROM user_roles
      GROUP BY user_id, role_id, COALESCE(channel_id, -1)
    )
  `);

  // ── Prevent future NULL-duplicate inserts with a functional unique index ──
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_user_roles_no_dupes ON user_roles(user_id, role_id, COALESCE(channel_id, -1))');

  // ── Migration: custom_level column on user_roles for per-assignment level overrides ──
  try {
    db.prepare('SELECT custom_level FROM user_roles LIMIT 0').get();
  } catch {
    db.exec('ALTER TABLE user_roles ADD COLUMN custom_level INTEGER DEFAULT NULL');
  }

  // ── Migration: per-user permission overrides table ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_role_perms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      channel_id INTEGER DEFAULT NULL REFERENCES channels(id) ON DELETE CASCADE,
      permission TEXT NOT NULL,
      allowed INTEGER NOT NULL DEFAULT 1
    )
  `);
  try {
    db.prepare('SELECT 1 FROM user_role_perms LIMIT 0').get();
  } catch { /* table just created */ }

  // ── Migration: push notification subscriptions ──────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, endpoint)
    );
    CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);
  `);

  // ── Migration: webhooks / bot integrations ───────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT 'Bot',
      token TEXT UNIQUE NOT NULL,
      avatar_url TEXT DEFAULT NULL,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      is_active INTEGER DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_webhooks_token ON webhooks(token);
    CREATE INDEX IF NOT EXISTS idx_webhooks_channel ON webhooks(channel_id);
  `);

  // ── Migration: webhook callback URL + secret for two-way bot integration ──
  const webhookCallbackCols = [
    { name: 'callback_url',    sql: "ALTER TABLE webhooks ADD COLUMN callback_url TEXT DEFAULT NULL" },
    { name: 'callback_secret', sql: "ALTER TABLE webhooks ADD COLUMN callback_secret TEXT DEFAULT NULL" },
    // 3.13.0 webhook expansion — per-event filtering, delivery health
    { name: 'subscribed_events',    sql: "ALTER TABLE webhooks ADD COLUMN subscribed_events TEXT DEFAULT '*'" },
    { name: 'last_delivery_status', sql: "ALTER TABLE webhooks ADD COLUMN last_delivery_status INTEGER DEFAULT NULL" },
    { name: 'last_delivery_at',     sql: "ALTER TABLE webhooks ADD COLUMN last_delivery_at DATETIME DEFAULT NULL" },
    { name: 'last_delivery_error',  sql: "ALTER TABLE webhooks ADD COLUMN last_delivery_error TEXT DEFAULT NULL" },
    { name: 'failure_count',        sql: "ALTER TABLE webhooks ADD COLUMN failure_count INTEGER DEFAULT 0" },
    // 3.18.0 — opt-in moderation actions (kick/ban/mute) for bot webhooks.
    // Defaults to 0 so existing bots cannot suddenly moderate. Per #5397.
    { name: 'can_moderate',         sql: "ALTER TABLE webhooks ADD COLUMN can_moderate INTEGER DEFAULT 0" },
    // Voice gateway access is also opt-in and can only be granted by admins.
    { name: 'can_use_voice',        sql: "ALTER TABLE webhooks ADD COLUMN can_use_voice INTEGER DEFAULT 0" },
  ];
  for (const col of webhookCallbackCols) {
    try { db.prepare(`SELECT ${col.name} FROM webhooks LIMIT 0`).get(); } catch { db.exec(col.sql); }
  }

  // ── Migration: Ferry (MSG Arena <-> Discord bridge) pairings ──
  // One row per MSG Arena channel paired with one Discord channel. A MSG Arena channel
  // may appear more than once (fan out to several Discord servers) and so may a
  // Discord channel, so the uniqueness is on the pair.
  //
  //   direction  'both' | 'to_discord' | 'to_haven'  — admin-selectable per pair
  //   out_mode   'all'     mirrors every message in the MSG Arena channel
  //              'command' only relays messages the author explicitly addressed
  //
  // webhook_id/webhook_token are the Discord channel webhook Ferry sends
  // through. They are filled in lazily on first send, because creating one
  // needs the bot to already be in that Discord server with Manage Webhooks.
  db.exec(`
    CREATE TABLE IF NOT EXISTS ferry_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      guild_id TEXT NOT NULL,
      guild_name TEXT,
      discord_channel_id TEXT NOT NULL,
      discord_channel_name TEXT,
      direction TEXT NOT NULL DEFAULT 'both',
      out_mode TEXT NOT NULL DEFAULT 'command',
      webhook_id TEXT DEFAULT NULL,
      webhook_token TEXT DEFAULT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      last_activity_at DATETIME DEFAULT NULL,
      last_error TEXT DEFAULT NULL,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(channel_id, discord_channel_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ferry_links_channel ON ferry_links(channel_id);
    CREATE INDEX IF NOT EXISTS idx_ferry_links_discord ON ferry_links(discord_channel_id);
  `);

  // ── Migration: mobile FCM push tokens ───────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS fcm_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, token)
    );
    CREATE INDEX IF NOT EXISTS idx_fcm_tokens_user ON fcm_tokens(user_id);
  `);

  // ── Migration: one device belongs to one account ────────
  // Both tables are UNIQUE(user_id, endpoint/token), so signing a device in
  // as a second account used to leave the first account's row behind pointing
  // at that same device. Push fan-out only skips rows whose user_id is the
  // sender, so the leftover row delivered the sender their own messages to
  // their own phone. Registration now claims the device, but installs that
  // already collected duplicates need them cleared once: keep only the newest
  // row per endpoint/token, which is the account that most recently signed in.
  // A stale web-push endpoint eventually 410s and gets pruned; a stale FCM
  // token stays valid forever, so it would never have cleaned itself up.
  try {
    db.exec(`
      DELETE FROM push_subscriptions WHERE id NOT IN (
        SELECT MAX(id) FROM push_subscriptions GROUP BY endpoint
      );
      DELETE FROM fcm_tokens WHERE id NOT IN (
        SELECT MAX(id) FROM fcm_tokens GROUP BY token
      );
    `);
  } catch { /* tables may not exist yet on a fresh schema race */ }

  // ── Migration: per-user channel notification prefs ──────
  // Before 3.20.2 these lived only in localStorage, which meant the server
  // had no way to honor them when fanning out web-push / FCM pushes — so
  // mobile users would get a notification for every message even on
  // channels they'd explicitly muted (#5399 follow-up, Amnibro report).
  // Mirroring the mute set to the server lets sendPushNotifications skip
  // muted recipients before they hit FCM.
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_channel_prefs (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel_code TEXT NOT NULL,
      muted INTEGER NOT NULL DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, channel_code)
    );
    CREATE INDEX IF NOT EXISTS idx_user_channel_prefs_user ON user_channel_prefs(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_channel_prefs_channel ON user_channel_prefs(channel_code);
  `);

  // ── Migration: channel feature toggles & QoL ────────────
  const channelQolCols = [
    { name: 'streams_enabled',    sql: "ALTER TABLE channels ADD COLUMN streams_enabled INTEGER DEFAULT 1" },
    { name: 'music_enabled',      sql: "ALTER TABLE channels ADD COLUMN music_enabled INTEGER DEFAULT 1" },
    { name: 'slow_mode_interval', sql: "ALTER TABLE channels ADD COLUMN slow_mode_interval INTEGER DEFAULT 0" },
    { name: 'category',           sql: "ALTER TABLE channels ADD COLUMN category TEXT DEFAULT NULL" },
    { name: 'sort_alphabetical',  sql: "ALTER TABLE channels ADD COLUMN sort_alphabetical INTEGER DEFAULT 0" },
    { name: 'cleanup_exempt',     sql: "ALTER TABLE channels ADD COLUMN cleanup_exempt INTEGER DEFAULT 0" },
    { name: 'channel_type',       sql: "ALTER TABLE channels ADD COLUMN channel_type TEXT DEFAULT 'standard'" },
    { name: 'voice_user_limit',   sql: "ALTER TABLE channels ADD COLUMN voice_user_limit INTEGER DEFAULT 0" },
    { name: 'media_enabled',      sql: "ALTER TABLE channels ADD COLUMN media_enabled INTEGER DEFAULT 1" },
    { name: 'notification_type',  sql: "ALTER TABLE channels ADD COLUMN notification_type TEXT DEFAULT 'default'" },
    { name: 'voice_enabled',     sql: "ALTER TABLE channels ADD COLUMN voice_enabled INTEGER DEFAULT 1" },
    { name: 'text_enabled',      sql: "ALTER TABLE channels ADD COLUMN text_enabled INTEGER DEFAULT 1" },
    { name: 'soundboard_enabled', sql: "ALTER TABLE channels ADD COLUMN soundboard_enabled INTEGER DEFAULT 1" },
    // #5390 — extend the self-destruct timer with a "clear messages only"
    // mode. `auto_delete_mode` is 'delete' (existing behaviour: drop the
    // whole channel) or 'clear' (wipe messages but keep channel, perms,
    // roles, integrations). `auto_delete_interval_hours` stores the
    // original interval so a 'clear' timer can rearm itself after firing
    // (recurring sweep) instead of being a one-shot.
    { name: 'auto_delete_mode',           sql: "ALTER TABLE channels ADD COLUMN auto_delete_mode TEXT DEFAULT 'delete'" },
    { name: 'auto_delete_interval_hours', sql: "ALTER TABLE channels ADD COLUMN auto_delete_interval_hours INTEGER DEFAULT NULL" },
  ];
  for (const col of channelQolCols) {
    try { db.prepare(`SELECT ${col.name} FROM channels LIMIT 0`).get(); } catch { db.exec(col.sql); }
  }

  // ── Migration: convert legacy channel_type to individual toggles ──
  try {
    const textOnlyChannels = db.prepare("SELECT id FROM channels WHERE channel_type = 'text'").all();
    if (textOnlyChannels.length > 0) {
      const update = db.prepare("UPDATE channels SET voice_enabled = 0, channel_type = 'standard' WHERE id = ?");
      for (const ch of textOnlyChannels) update.run(ch.id);
    }
    const voiceOnlyChannels = db.prepare("SELECT id FROM channels WHERE channel_type = 'voice'").all();
    if (voiceOnlyChannels.length > 0) {
      const update = db.prepare("UPDATE channels SET text_enabled = 0, channel_type = 'standard' WHERE id = ?");
      for (const ch of voiceOnlyChannels) update.run(ch.id);
    }
  } catch { /* channel_type column may not exist yet on first run */ }

  // ── Migration: E2E public key on users ──────────────────
  try {
    db.prepare("SELECT public_key FROM users LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE users ADD COLUMN public_key TEXT DEFAULT NULL");
  }

  // ── Migration: E2E encrypted private key (per-account sync) ──
  try {
    db.prepare("SELECT encrypted_private_key FROM users LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE users ADD COLUMN encrypted_private_key TEXT DEFAULT NULL");
  }
  try {
    db.prepare("SELECT e2e_key_salt FROM users LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE users ADD COLUMN e2e_key_salt TEXT DEFAULT NULL");
  }

  // ── Migration: E2E account secret (device-independent key wrapping) ──
  try {
    db.prepare("SELECT e2e_secret FROM users LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE users ADD COLUMN e2e_secret TEXT DEFAULT NULL");
  }

  // ── Migration: OIDC / SSO federated identity (#12) ──
  // A federated account is identified by the pair (issuer, subject), never by
  // email — an email can be reassigned inside a directory, `sub` cannot.
  // password_hash stays NULL for these accounts so the local login form can
  // never authenticate one.
  try {
    db.prepare("SELECT oidc_subject FROM users LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE users ADD COLUMN oidc_subject TEXT DEFAULT NULL");
  }
  try {
    db.prepare("SELECT oidc_issuer FROM users LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE users ADD COLUMN oidc_issuer TEXT DEFAULT NULL");
  }
  try {
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_oidc ON users(oidc_issuer, oidc_subject) WHERE oidc_subject IS NOT NULL");
  } catch { /* older SQLite without partial indexes — lookup still works */ }

  // ── Migration: ensure create_channel default threshold ──
  try {
    const row = db.prepare("SELECT value FROM server_settings WHERE key = 'permission_thresholds'").get();
    if (row) {
      const thresholds = JSON.parse(row.value);
      if (!thresholds.create_channel) {
        thresholds.create_channel = 50;
        db.prepare("UPDATE server_settings SET value = ? WHERE key = 'permission_thresholds'").run(JSON.stringify(thresholds));
      }
    }
  } catch { /* ignore */ }

  // ── Migration: imported_from column on messages (Discord import) ──
  try {
    db.prepare("SELECT imported_from FROM messages LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE messages ADD COLUMN imported_from TEXT DEFAULT NULL");
  }

  // ── Migration: webhook_avatar column on messages (Discord import avatars) ──
  try {
    db.prepare("SELECT webhook_avatar FROM messages LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE messages ADD COLUMN webhook_avatar TEXT DEFAULT NULL");
  }

  // ── Migration: discord_message_id for import deduplication ──────────────
  // Stores the original Discord snowflake ID so re-importing the same export
  // (or overlapping exports) is idempotent — duplicate snowflakes are skipped.
  try {
    db.prepare("SELECT discord_message_id FROM messages LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE messages ADD COLUMN discord_message_id TEXT DEFAULT NULL");
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_discord_id
      ON messages(discord_message_id)
      WHERE discord_message_id IS NOT NULL;
  `);

  // ── Migration: discord_channel_id on channels (import deduplication) ─────
  // Stores the originating Discord channel snowflake so a second import of the
  // same Discord channel appends into the existing MSG Arena channel rather than
  // creating a duplicate.
  try {
    db.prepare("SELECT discord_channel_id FROM channels LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE channels ADD COLUMN discord_channel_id TEXT DEFAULT NULL");
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_discord_id
      ON channels(discord_channel_id)
      WHERE discord_channel_id IS NOT NULL;
  `);

  // ── Migration: archived / protected messages ────────────
  try {
    db.prepare("SELECT is_archived FROM messages LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE messages ADD COLUMN is_archived INTEGER DEFAULT 0");
  }

  // ── Migration: password_version for session invalidation ──
  try {
    db.prepare("SELECT password_version FROM users LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE users ADD COLUMN password_version INTEGER DEFAULT 1");
  }

  // ── Migration: mark auto-joins made by view_all_channels ─
  // The permission inserts a real channel_members row per channel, which is
  // what makes losing it dangerous: without knowing which rows it created,
  // revoking cannot take them back and a demoted mod keeps every private
  // channel. Rows it adds carry this flag; everything else stays 0 and is
  // never touched by the cleanup. (#5512)
  try {
    db.prepare("SELECT auto_all_channels FROM channel_members LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE channel_members ADD COLUMN auto_all_channels INTEGER NOT NULL DEFAULT 0");
  }

  // ── Migration: role-based channel access ────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS role_channel_access (
      role_id    INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      grant_on_promote  INTEGER NOT NULL DEFAULT 0,
      revoke_on_demote  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (role_id, channel_id)
    );
    CREATE INDEX IF NOT EXISTS idx_rca_role ON role_channel_access(role_id);
    CREATE INDEX IF NOT EXISTS idx_rca_channel ON role_channel_access(channel_id);
  `);

  // ── Migration: self_assignable flag on roles ────────────
  // Roles an admin lets members grab themselves (Discord-style self-roles).
  // is_admin lives on users, never roles, so a self-assignable role can never
  // confer admin — the only grant is whatever cosmetic/access the admin chose.
  try {
    db.prepare("SELECT self_assignable FROM roles LIMIT 0").get();
  } catch (e) {
    db.exec("ALTER TABLE roles ADD COLUMN self_assignable INTEGER NOT NULL DEFAULT 0");
  }

  // ── Migration: link_channel_access flag on roles ────────
  try {
    db.prepare("SELECT link_channel_access FROM roles LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE roles ADD COLUMN link_channel_access INTEGER NOT NULL DEFAULT 0");
  }

  // ── Migration: TOTP 2FA columns on users ────────────────
  try {
    db.prepare("SELECT totp_secret FROM users LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE users ADD COLUMN totp_secret TEXT DEFAULT NULL");
  }
  try {
    db.prepare("SELECT totp_enabled FROM users LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE users ADD COLUMN totp_enabled INTEGER DEFAULT 0");
  }

  // ── Migration: TOTP backup codes table ──────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS totp_backup_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL,
      used INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_totp_backup_user ON totp_backup_codes(user_id);
  `);

  // ── Migration: account recovery codes ──────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS account_recovery_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL,
      used INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_recovery_codes_user ON account_recovery_codes(user_id);
  `);

  // ── Migration: polls support ─────────────────────────
  try {
    db.exec("ALTER TABLE messages ADD COLUMN poll_data TEXT DEFAULT NULL");
  } catch (e) { /* column already exists */ }

  db.exec(`
    CREATE TABLE IF NOT EXISTS poll_votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      option_index INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(message_id, user_id, option_index)
    );
    CREATE INDEX IF NOT EXISTS idx_poll_votes_msg ON poll_votes(message_id);
  `);

  // ── Migration: deleted_users log (audit trail for admin deletions) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS deleted_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      display_name TEXT DEFAULT NULL,
      reason TEXT DEFAULT '',
      deleted_by INTEGER REFERENCES users(id),
      deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // ── Migration: per-channel voice bitrate cap ────────────
  try {
    db.prepare("SELECT voice_bitrate FROM channels LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE channels ADD COLUMN voice_bitrate INTEGER DEFAULT 0");
  }

  // ── Migration: per-channel AFK sub-channel ────────────
  try {
    db.prepare("SELECT afk_sub_code FROM channels LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE channels ADD COLUMN afk_sub_code TEXT DEFAULT NULL");
  }
  try {
    db.prepare("SELECT afk_timeout_minutes FROM channels LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE channels ADD COLUMN afk_timeout_minutes INTEGER DEFAULT 0");
  }

  // ── Migration: read-only channel column ─────────────────
  try {
    db.prepare("SELECT read_only FROM channels LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE channels ADD COLUMN read_only INTEGER DEFAULT 0");
  }

  // ── Migration: encrypted server list for cross-device sync ──────────
  try {
    db.prepare("SELECT encrypted_servers FROM users LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE users ADD COLUMN encrypted_servers TEXT DEFAULT NULL");
  }

  // ── Migration: grant use_tts to all auto-assign roles (default ON) ──
  try {
    const autoAssignRoles = db.prepare('SELECT id FROM roles WHERE auto_assign = 1').all();
    const insertPerm = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission, allowed) VALUES (?, ?, 1)');
    for (const r of autoAssignRoles) {
      insertPerm.run(r.id, 'use_tts');
    }
  } catch { /* non-critical */ }

  // ── Migration: role icon column ─────────────────────────
  try {
    db.prepare("SELECT icon FROM roles LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE roles ADD COLUMN icon TEXT DEFAULT NULL");
  }

  // ── Migration: bot_commands table for extensible slash commands ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_commands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      webhook_id INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
      command TEXT NOT NULL,
      description TEXT DEFAULT '',
      subcommands_json TEXT DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(webhook_id, command)
    );
    CREATE INDEX IF NOT EXISTS idx_bot_commands_command ON bot_commands(command);
    CREATE INDEX IF NOT EXISTS idx_bot_commands_webhook ON bot_commands(webhook_id);
  `);

  try {
    db.prepare('SELECT subcommands_json FROM bot_commands LIMIT 0').get();
  } catch {
    db.exec('ALTER TABLE bot_commands ADD COLUMN subcommands_json TEXT DEFAULT NULL');
  }

  // ── Migration: split manage_channel_settings out of create_channel (#5467) ──
  // Editing an existing channel's settings used to ride on create_channel, so
  // anyone who could make a channel could also reconfigure every other channel
  // on the server. The two are now separate permissions. This backfill copies
  // create_channel to manage_channel_settings everywhere it is currently
  // granted, so no existing server loses a delegation on upgrade — admins who
  // want the narrower behaviour untick the new permission afterward.
  //
  // Guarded by a marker key: without it, every restart would re-grant the
  // permission an admin had deliberately removed.
  try {
    const marker = db.prepare(
      "SELECT value FROM server_settings WHERE key = 'perm_split_manage_channel_settings'"
    ).get();
    if (!marker) {
      const backfill = db.transaction(() => {
        db.prepare(`
          INSERT OR IGNORE INTO role_permissions (role_id, permission, allowed)
          SELECT role_id, 'manage_channel_settings', 1 FROM role_permissions
          WHERE permission = 'create_channel' AND allowed = 1
        `).run();

        // Per-user overrides carry their own scope (role_id / channel_id), and
        // explicit denies matter as much as grants — copy both verbatim.
        db.prepare(`
          INSERT INTO user_role_perms (user_id, role_id, channel_id, permission, allowed)
          SELECT user_id, role_id, channel_id, 'manage_channel_settings', allowed
          FROM user_role_perms urp
          WHERE urp.permission = 'create_channel'
            AND NOT EXISTS (
              SELECT 1 FROM user_role_perms x
              WHERE x.user_id = urp.user_id
                AND x.permission = 'manage_channel_settings'
                AND COALESCE(x.channel_id, -1) = COALESCE(urp.channel_id, -1)
            )
        `).run();

        // Level thresholds auto-grant permissions above a given role level.
        // MSG Arena ships create_channel at 50, which is what the default
        // "Server Mod" role sits at — mirror it so those mods keep working.
        const row = db.prepare(
          "SELECT value FROM server_settings WHERE key = 'permission_thresholds'"
        ).get();
        if (row) {
          const thresholds = JSON.parse(row.value);
          if (thresholds.create_channel && !thresholds.manage_channel_settings) {
            thresholds.manage_channel_settings = thresholds.create_channel;
            db.prepare("UPDATE server_settings SET value = ? WHERE key = 'permission_thresholds'")
              .run(JSON.stringify(thresholds));
          }
        }

        db.prepare(
          "INSERT OR IGNORE INTO server_settings (key, value) VALUES ('perm_split_manage_channel_settings', '1')"
        ).run();
      });
      backfill();
    }
  } catch (e) {
    console.warn('manage_channel_settings backfill failed:', e.message);
  }

  // ── Migration: let SERVER_NAME through on existing installs (#5489) ──
  // Every install created before this seeded the literal 'MSG ARENA' into
  // server_name, and a stored name beats the environment, so SERVER_NAME has
  // never actually applied to them. A stored 'MSG ARENA' is indistinguishable
  // from "never named it", and setting SERVER_NAME is a clear statement of
  // intent, so hand it back. Only touches installs where both are true, and
  // the marker key means an admin who later types MSG ARENA on purpose keeps it.
  try {
    const marker = db.prepare(
      "SELECT value FROM server_settings WHERE key = 'server_name_env_reclaim'"
    ).get();
    if (!marker) {
      const envName = (process.env.SERVER_NAME || '').trim();
      const stored = db.prepare("SELECT value FROM server_settings WHERE key = 'server_name'").get();
      if (envName && stored && stored.value === 'MSG ARENA') {
        db.prepare("UPDATE server_settings SET value = '' WHERE key = 'server_name'").run();
        console.log(`Server name now comes from SERVER_NAME ("${envName}") — set a name in Settings to override it.`);
      }
      db.prepare(
        "INSERT OR IGNORE INTO server_settings (key, value) VALUES ('server_name_env_reclaim', '1')"
      ).run();
    }
  } catch (e) {
    console.warn('server_name env reclaim failed:', e.message);
  }

  // ── Migration: chat threads (thread_id on messages) ─────
  try {
    db.prepare("SELECT thread_id FROM messages LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE messages ADD COLUMN thread_id INTEGER DEFAULT NULL REFERENCES messages(id) ON DELETE CASCADE");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id) WHERE thread_id IS NOT NULL");
  db.exec("CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(reply_to) WHERE reply_to IS NOT NULL");
  db.exec("CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id)");  // perf: ban/kick purge + bulk-remove preview

  // ── Audit log ───────────────────────────────────────────
  // Tracks admin/moderator actions: channel CRUD, role changes,
  // bans/kicks/mutes, server settings updates, member renames, etc.
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      actor_username TEXT,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id INTEGER,
      target_name TEXT,
      details TEXT DEFAULT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_id);
    CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
  `);

  // ── Rich presence: linked external accounts ─────────────
  // One row per (user, provider). access_token / refresh_token are stored
  // AES-256-GCM encrypted (see src/activity.js) — never in plaintext, because
  // a Spotify refresh token is a long-lived credential to someone's account
  // and the SQLite file travels with backups.
  //
  // Activity itself is deliberately NOT stored here. It's ephemeral,
  // high-churn, and lives in memory only (activity.js), so a restart forgets
  // what everyone was doing rather than persisting a play history nobody
  // asked for.
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_connections (
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider      TEXT    NOT NULL,
      external_id   TEXT,
      display_name  TEXT,
      access_token  TEXT,
      refresh_token TEXT,
      expires_at    INTEGER DEFAULT 0,
      -- How much this handle is worth:
      --   'oauth'  — ownership proven by a redirect round trip (Steam, Spotify, Twitch)
      --   'lookup' — the handle was confirmed to EXIST via an API call, but
      --              ownership was never proven (Last.fm)
      --   'self'   — typed into a text box, nothing verified (Riot ID, gamertag…)
      -- The profile badge reads this so a self-asserted handle can never render
      -- as though it were proven.
      link_method   TEXT NOT NULL DEFAULT 'oauth',
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, provider)
    );
    CREATE INDEX IF NOT EXISTS idx_user_connections_provider ON user_connections(provider);
  `);

  // Migration: add link_method to pre-existing user_connections tables, then
  // correct the rows whose method isn't the default 'oauth' (Last.fm is a
  // lookup, not a proven link).
  try {
    db.prepare('SELECT link_method FROM user_connections LIMIT 0').get();
  } catch {
    try {
      db.exec("ALTER TABLE user_connections ADD COLUMN link_method TEXT NOT NULL DEFAULT 'oauth'");
      db.exec("UPDATE user_connections SET link_method = 'lookup' WHERE provider = 'lastfm'");
    } catch (e) { console.warn('[connections] link_method migration skipped:', e.message); }
  }

  // ── Gaming layer: game catalogue ────────────────────────
  // One row per game the community plays. LFG (and later tournaments/clips)
  // foreign-key to this so "Valorant", "valorant" and "VALORANT" can't become
  // three separate lists. slug is the stable id; steam_appid lets the Steam
  // rich-presence poller map a "playing now" appid onto a catalogue row.
  db.exec(`
    CREATE TABLE IF NOT EXISTS games (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      slug               TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name               TEXT NOT NULL,
      icon               TEXT DEFAULT NULL,
      steam_appid        INTEGER DEFAULT NULL,
      kind               TEXT NOT NULL DEFAULT 'external',   -- 'arcade' | 'external'
      default_party_size INTEGER NOT NULL DEFAULT 5,
      is_active          INTEGER NOT NULL DEFAULT 1,
      created_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at         DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_games_active ON games(is_active, name);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_games_steam_appid ON games(steam_appid) WHERE steam_appid IS NOT NULL;
  `);

  // Seed the bundled arcade titles (slugs match _gamesRegistry in the client).
  // INSERT OR IGNORE so a re-run is a no-op and admin edits are never clobbered.
  {
    const seedGame = db.prepare(
      "INSERT OR IGNORE INTO games (slug, name, icon, kind, default_party_size) VALUES (?, ?, ?, 'arcade', 2)"
    );
    const arcade = [
      ['flappy', 'Shippy Container', '🚢'],
      ['flight', 'Flight', '✈️'],
      ['learn-to-fly-3', 'Learn to Fly 3', '🐧'],
      ['bubble-tanks-3', 'Bubble Tanks 3', '🫧'],
      ['tanks', 'Tanks', '🪖'],
      ['super-smash-flash-2', 'Super Smash Flash 2', '⚔️'],
      ['io-games', '.io Games', '🌐'],
    ];
    for (const [slug, name, icon] of arcade) seedGame.run(slug, name, icon);
    // A couple of popular multiplayer titles so LFG's dropdown isn't empty on
    // day one (admins can add/remove/rename via the catalogue; the Steam poller
    // also auto-adds titles people are actually playing).
    const external = [
      ['valorant', 'Valorant', '🔫', 5],
      ['league-of-legends', 'League of Legends', '⚔️', 5],
      ['counter-strike-2', 'Counter-Strike 2', '💣', 5],
      ['minecraft', 'Minecraft', '⛏️', 8],
      ['overwatch-2', 'Overwatch 2', '🧡', 5],
      ['rocket-league', 'Rocket League', '🚗', 3],
    ];
    const seedExt = db.prepare(
      "INSERT OR IGNORE INTO games (slug, name, icon, kind, default_party_size) VALUES (?, ?, ?, 'external', ?)"
    );
    for (const [slug, name, icon, size] of external) seedExt.run(slug, name, icon, size);
  }

  // ── Gaming layer: LFG / party finder ────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS lfg_posts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id     INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      owner_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel_id  INTEGER REFERENCES channels(id) ON DELETE SET NULL,
      note        TEXT NOT NULL DEFAULT '',
      mode        TEXT NOT NULL DEFAULT '',
      slots       INTEGER NOT NULL DEFAULT 5,       -- total party size incl. owner
      status      TEXT NOT NULL DEFAULT 'open',     -- open | full | closed | expired
      expires_at  DATETIME NOT NULL,                -- absolute; survives a restart
      voice_channel_id INTEGER REFERENCES channels(id) ON DELETE SET NULL,
      voice_code  TEXT DEFAULT NULL,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      closed_at   DATETIME DEFAULT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lfg_posts_sweep ON lfg_posts(status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_lfg_posts_game  ON lfg_posts(game_id, status);
    CREATE INDEX IF NOT EXISTS idx_lfg_posts_owner ON lfg_posts(owner_id);

    CREATE TABLE IF NOT EXISTS lfg_slots (
      post_id   INTEGER NOT NULL REFERENCES lfg_posts(id) ON DELETE CASCADE,
      user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role      TEXT NOT NULL DEFAULT '',
      joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (post_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_lfg_slots_user ON lfg_slots(user_id);
  `);

  // ── Gaming layer: XP / leveling (MEE6-style activity leveling) ──────────
  // Server-authoritative XP earned by DELIBERATE activity (chatting, being in
  // voice) — consistent with the privacy line (a message/voice join is a user
  // act) and the "scores must be server-derived" rule. `level` is stored so the
  // hot award path only checks the next threshold, not the whole curve.
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_xp (
      user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      xp         INTEGER NOT NULL DEFAULT 0,
      level      INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_user_xp_rank ON user_xp(xp DESC);
  `);

  // ── Gaming layer: "My Games" — the games a member plays (self-assigned from
  // the catalogue). Persistent discovery layer: LFG is "play now", presence is
  // "playing right now", this is "these are my games → find others who play them".
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_games (
      user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      game_id  INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, game_id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_games_game ON user_games(game_id);
  `);

  // ── Gaming layer: Squads / teams — persistent named groups with a roster.
  // The community-building layer above ephemeral LFG parties. Consent-first:
  // membership only via accepted invites.
  db.exec(`
    CREATE TABLE IF NOT EXISTS squads (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      tag         TEXT DEFAULT NULL,
      description TEXT NOT NULL DEFAULT '',
      owner_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS squad_members (
      squad_id  INTEGER NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
      user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role      TEXT NOT NULL DEFAULT 'member',   -- owner | captain | member
      joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (squad_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_squad_members_user ON squad_members(user_id);
    CREATE TABLE IF NOT EXISTS squad_invites (
      squad_id   INTEGER NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (squad_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_squad_invites_user ON squad_invites(user_id);
  `);

  // Grant the new LFG permissions to existing roles (fresh installs get them in
  // the role-seed block above; this covers servers that already have roles).
  // INSERT OR IGNORE keyed on (role_id, permission) so it's safe to re-run.
  try {
    const grant = db.prepare(
      "INSERT OR IGNORE INTO role_permissions (role_id, permission, allowed) " +
      "SELECT id, ?, 1 FROM roles WHERE name = ?"
    );
    grant.run('create_lfg', 'User');
    grant.run('manage_lfg', 'Server Mod');
    grant.run('manage_lfg', 'Channel Mod');
  } catch (e) { console.warn('[lfg] permission grant migration skipped:', e.message); }

  // ── Clips / highlights ────────────────────────────────────────────────
  // A clip is a short video a member deliberately uploads (consent = the act
  // of posting, per the Phase 3 privacy line). Files live under the uploads
  // dir like any other attachment; clip_votes is its OWN table rather than
  // reusing `reactions` because reactions.message_id is NOT NULL and there is
  // no chat message behind a clip. Clips foreign-key the games catalogue so a
  // clip's game matches LFG/tournament rows exactly instead of by free text.
  db.exec(`
    CREATE TABLE IF NOT EXISTS clips (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      uploader_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      game_id       INTEGER REFERENCES games(id) ON DELETE SET NULL,
      title         TEXT NOT NULL,
      description   TEXT NOT NULL DEFAULT '',
      file_path     TEXT NOT NULL,
      poster_path   TEXT DEFAULT NULL,
      mime          TEXT DEFAULT NULL,
      size_bytes    INTEGER NOT NULL DEFAULT 0,
      duration_sec  REAL DEFAULT NULL,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_clips_created ON clips(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_clips_game    ON clips(game_id);
    CREATE INDEX IF NOT EXISTS idx_clips_uploader ON clips(uploader_id);

    CREATE TABLE IF NOT EXISTS clip_votes (
      clip_id    INTEGER NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (clip_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_clip_votes_clip ON clip_votes(clip_id);
  `);

  // ── Achievements / badges (progression) ──────────────────────────────
  // Which users have earned which badges. Definitions live in code
  // (src/achievements.js); this only records what's been earned.
  db.exec(`
    CREATE TABLE IF NOT EXISTS achievements (
      user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key       TEXT NOT NULL,
      earned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, key)
    );
    CREATE INDEX IF NOT EXISTS idx_achievements_user ON achievements(user_id);
  `);

  // Grant clip permissions to existing roles (fresh installs also get them via
  // the role-seed block; INSERT OR IGNORE keyed on (role_id, permission)).
  try {
    const grantC = db.prepare(
      "INSERT OR IGNORE INTO role_permissions (role_id, permission, allowed) " +
      "SELECT id, ?, 1 FROM roles WHERE name = ?"
    );
    grantC.run('post_clips', 'User');
    grantC.run('manage_clips', 'Server Mod');
    grantC.run('manage_clips', 'Channel Mod');
  } catch (e) { console.warn('[clips] permission grant migration skipped:', e.message); }

  // ── Tournaments & ladders ─────────────────────────────────────────────
  // Two formats share these tables: 'single_elim' (bracket lives in
  // bracket_json, see src/bracket.js) and 'ladder' (ELO in tournament_
  // participants.rating, see src/elo.js). Match results are two-party
  // confirmed — the loser (or winner) reports, the opponent confirms — or
  // entered outright by someone with manage_tournaments. Client-asserted
  // numbers never become standing without that second party, per the plan.
  db.exec(`
    CREATE TABLE IF NOT EXISTS tournaments (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      name             TEXT NOT NULL,
      game_id          INTEGER REFERENCES games(id) ON DELETE SET NULL,
      format           TEXT NOT NULL DEFAULT 'single_elim',  -- 'single_elim' | 'ladder'
      status           TEXT NOT NULL DEFAULT 'open',          -- 'open' | 'live' | 'complete'
      bracket_json     TEXT DEFAULT NULL,
      champion_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      max_participants INTEGER NOT NULL DEFAULT 16,
      created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
      started_at       DATETIME DEFAULT NULL,
      completed_at     DATETIME DEFAULT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tournaments_status ON tournaments(status, created_at DESC);

    CREATE TABLE IF NOT EXISTS tournament_participants (
      tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      seed          INTEGER DEFAULT NULL,
      rating        INTEGER NOT NULL DEFAULT 1000,
      wins          INTEGER NOT NULL DEFAULT 0,
      losses        INTEGER NOT NULL DEFAULT 0,
      draws         INTEGER NOT NULL DEFAULT 0,
      joined_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (tournament_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_tparticipants_user ON tournament_participants(user_id);

    CREATE TABLE IF NOT EXISTS tournament_matches (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      tournament_id    INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
      bracket_match_id INTEGER DEFAULT NULL,   -- index into bracket_json.matches (single_elim)
      round            INTEGER DEFAULT NULL,
      a_id             INTEGER REFERENCES users(id) ON DELETE SET NULL,
      b_id             INTEGER REFERENCES users(id) ON DELETE SET NULL,
      winner_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
      score            TEXT DEFAULT NULL,
      reported_winner  INTEGER DEFAULT NULL,
      reported_by      INTEGER DEFAULT NULL,
      status           TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'reported' | 'confirmed'
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
      confirmed_at     DATETIME DEFAULT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tmatches_tournament ON tournament_matches(tournament_id, status);
  `);

  // Grant manage_tournaments to the mod roles (admins are always allowed).
  try {
    const grantT = db.prepare(
      "INSERT OR IGNORE INTO role_permissions (role_id, permission, allowed) " +
      "SELECT id, ?, 1 FROM roles WHERE name = ?"
    );
    grantT.run('manage_tournaments', 'Server Mod');
    grantT.run('manage_tournaments', 'Channel Mod');
  } catch (e) { console.warn('[tournaments] permission grant migration skipped:', e.message); }

  // ── Scheduled events / game nights ────────────────────────────────────
  // An organiser schedules a session (optionally tied to a game); members RSVP
  // and get a reminder when it starts. start_at is epoch MILLISECONDS so time
  // comparisons never trip over SQLite datetime string formats.
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      title          TEXT NOT NULL,
      description    TEXT NOT NULL DEFAULT '',
      game_id        INTEGER REFERENCES games(id) ON DELETE SET NULL,
      start_at       INTEGER NOT NULL,                 -- epoch ms
      max_attendees  INTEGER NOT NULL DEFAULT 0,       -- 0 = unlimited
      channel_code   TEXT DEFAULT NULL,                -- optional linked voice channel
      status         TEXT NOT NULL DEFAULT 'scheduled',-- 'scheduled' | 'cancelled'
      reminded       INTEGER NOT NULL DEFAULT 0,       -- start reminder sent
      created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_events_start ON events(start_at);

    CREATE TABLE IF NOT EXISTS event_rsvps (
      event_id   INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status     TEXT NOT NULL DEFAULT 'going',        -- 'going' | 'interested'
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (event_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_event_rsvps_user ON event_rsvps(user_id);
  `);
  try {
    const grantE = db.prepare(
      "INSERT OR IGNORE INTO role_permissions (role_id, permission, allowed) SELECT id, ?, 1 FROM roles WHERE name = ?"
    );
    grantE.run('manage_events', 'Server Mod');
    grantE.run('manage_events', 'Channel Mod');
  } catch (e) { console.warn('[events] permission grant migration skipped:', e.message); }

  // Full-text search index (messages_fts) — created/reconciled here so it runs
  // synchronously before the server listens. (search-overhaul phase 2)
  try {
    ensureSearchIndex(db);
  } catch (e) {
    console.warn('[search] Index setup failed:', e.message);
  }

  return db;
}

function getDb() {
  return db;
}

module.exports = { initDatabase, getDb };
