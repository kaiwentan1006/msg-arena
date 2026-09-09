'use strict';

/**
 * MSG Arena — Clips / highlights routes
 *
 * A clip is a short video a member deliberately uploads to share a highlight.
 * This lives in its own mounted router (like connectRoutes) rather than inline
 * in the 5,900-line server.js. Upload goes over REST so it inherits the shared
 * uploadLimiter + uploadDiskGuard (which MUST run before multer) and the
 * upload-ownership accounting. There is deliberately NO ffmpeg on the server:
 * the poster/thumbnail frame is captured client-side (canvas.drawImage over a
 * seeked <video>) and uploaded alongside the video.
 *
 * Permissions (see helpers.js VALID_ROLE_PERMS):
 *   post_clips    — upload a clip
 *   manage_clips  — delete anyone's clip (owners can always delete their own)
 *
 * Votes are an up-vote toggle in the clip_votes table — not `reactions`, whose
 * message_id is NOT NULL and would force a fake chat message per clip.
 *
 * The raw video is served by a Range-capable streaming route here rather than
 * through /uploads, because /uploads forces Content-Disposition: attachment on
 * non-image files (which breaks inline <video> playback and seeking). Poster
 * images are plain images, so they go through /uploads like any avatar.
 */

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { getDb } = require('./database');
const createPermissions = require('./socketHandlers/permissions');
const { UPLOADS_DIR } = require('./paths');

const VIDEO_MIMES = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
const POSTER_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const VIDEO_EXT = { 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov' };
const POSTER_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

function getSettingInt(db, key, fallback) {
  try {
    const row = db.prepare('SELECT value FROM server_settings WHERE key = ?').get(key);
    const n = parseInt(row?.value, 10);
    return Number.isFinite(n) ? n : fallback;
  } catch { return fallback; }
}

// Resolve a stored relative filename to an absolute path, refusing anything
// that escapes the uploads dir (defence in depth — stored names are generated).
function safeUploadPath(relName) {
  if (typeof relName !== 'string' || !relName) return null;
  const abs = path.resolve(UPLOADS_DIR, relName);
  if (abs !== UPLOADS_DIR && !abs.startsWith(UPLOADS_DIR + path.sep)) return null;
  return abs;
}

/**
 * @param {object} deps
 *   verifyToken(token)            -> decoded user | null   (session tokens only)
 *   uploadLimiter                 -> express rate-limit middleware
 *   uploadDiskGuard               -> disk-headroom middleware (runs before multer)
 *   recordUploadOwnership(id, relPath, bytes, scope)
 *   deleteUpload(relPath)         -> move a file to the deleted-attachments quarantine
 *   verifyAdminFromDb(user)       -> boolean
 */
function createClipRoutes(deps) {
  const {
    verifyToken,
    uploadLimiter,
    uploadDiskGuard,
    recordUploadOwnership,
    deleteUpload,
    verifyAdminFromDb,
    awardAchievements,
  } = deps;

  const router = express.Router();
  // Build the permissions helper lazily: this router is mounted during server
  // boot, BEFORE initDatabase() runs, so getDb() is still undefined here.
  // Requests only arrive after boot, by which point getDb() returns the live db.
  let _perms = null;
  const getPerms = () => (_perms ||= createPermissions(getDb()));

  const storage = multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (req, file, cb) => {
      const map = file.fieldname === 'poster' ? POSTER_EXT : VIDEO_EXT;
      const ext = map[file.mimetype] || path.extname(file.originalname).toLowerCase() || '.bin';
      cb(null, `clip-${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
    },
  });
  const clipUpload = multer({
    storage,
    limits: { fileSize: 2 * 1024 * 1024 * 1024, files: 2 }, // 2 GB ceiling; DB max_clip_mb is the real limit
    fileFilter: (req, file, cb) => {
      if (file.fieldname === 'video') return cb(null, VIDEO_MIMES.has(file.mimetype));
      if (file.fieldname === 'poster') return cb(null, POSTER_MIMES.has(file.mimetype));
      return cb(null, false);
    },
  });

  // Pull the caller off the Authorization header; session tokens only.
  function authUser(req, res) {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user) { res.status(401).json({ error: 'Unauthorized' }); return null; }
    return user;
  }

  function isBanned(db, userId) {
    return !!db.prepare('SELECT id FROM bans WHERE user_id = ?').get(userId);
  }

  // Shape one clip row for the client, including vote count + whether `viewerId`
  // has voted, and uploader/game display fields.
  function serializeClip(db, id, viewerId) {
    const row = db.prepare(`
      SELECT c.*,
             u.username        AS uploader_username,
             u.display_name    AS uploader_display_name,
             g.slug            AS game_slug,
             g.name            AS game_name,
             g.icon            AS game_icon,
             (SELECT COUNT(*) FROM clip_votes v WHERE v.clip_id = c.id) AS votes,
             (SELECT COUNT(*) FROM clip_votes v WHERE v.clip_id = c.id AND v.user_id = ?) AS viewer_voted
      FROM clips c
      JOIN users u ON u.id = c.uploader_id
      LEFT JOIN games g ON g.id = c.game_id
      WHERE c.id = ?
    `).get(viewerId, id);
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      description: row.description || '',
      uploaderId: row.uploader_id,
      uploader: row.uploader_display_name || row.uploader_username,
      game: row.game_id ? { slug: row.game_slug, name: row.game_name, icon: row.game_icon } : null,
      videoUrl: `/api/clips/${row.id}/video`,
      posterUrl: row.poster_path ? `/uploads/${row.poster_path}` : null,
      durationSec: row.duration_sec,
      sizeBytes: row.size_bytes,
      votes: row.votes,
      voted: row.viewer_voted > 0,
      createdAt: row.created_at,
    };
  }

  // ── POST /api/clips — upload a clip ────────────────────────────────────
  router.post('/', uploadLimiter, uploadDiskGuard, (req, res) => {
    const user = authUser(req, res);
    if (!user) return;
    const db = getDb();
    if (isBanned(db, user.id)) return res.status(403).json({ error: 'Banned users cannot upload' });
    if (!verifyAdminFromDb(user) && !getPerms().userHasPermission(user.id, 'post_clips')) {
      return res.status(403).json({ error: "You don't have permission to post clips" });
    }

    clipUpload.fields([{ name: 'video', maxCount: 1 }, { name: 'poster', maxCount: 1 }])(req, res, (err) => {
      const cleanup = () => {
        for (const f of [...(req.files?.video || []), ...(req.files?.poster || [])]) {
          try { fs.unlinkSync(f.path); } catch { /* best effort */ }
        }
      };
      if (err) { cleanup(); return res.status(400).json({ error: err.message }); }

      const video = req.files?.video?.[0];
      const poster = req.files?.poster?.[0];
      if (!video) { cleanup(); return res.status(400).json({ error: 'No video uploaded (allowed: mp4, webm, mov)' }); }

      const maxBytes = getSettingInt(db, 'max_clip_mb', 100) * 1024 * 1024;
      if (video.size > maxBytes) {
        cleanup();
        return res.status(400).json({ error: `Clip too large (max ${Math.round(maxBytes / 1024 / 1024)} MB)` });
      }

      const title = (typeof req.body.title === 'string' ? req.body.title : '').trim().slice(0, 120);
      if (!title) { cleanup(); return res.status(400).json({ error: 'A title is required' }); }
      const description = (typeof req.body.description === 'string' ? req.body.description : '').trim().slice(0, 1000);

      // Resolve the game to a catalogue row (by slug); optional.
      let gameId = null;
      const gameSlug = (typeof req.body.game === 'string' ? req.body.game : '').trim();
      if (gameSlug) {
        const g = db.prepare('SELECT id FROM games WHERE slug = ? COLLATE NOCASE').get(gameSlug);
        if (g) gameId = g.id;
      }

      let duration = parseFloat(req.body.durationSec);
      if (!Number.isFinite(duration) || duration < 0 || duration > 60 * 60 * 6) duration = null;

      const info = db.prepare(`
        INSERT INTO clips (uploader_id, game_id, title, description, file_path, poster_path, mime, size_bytes, duration_sec)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(user.id, gameId, title, description, video.filename, poster ? poster.filename : null,
             video.mimetype, video.size, duration);

      recordUploadOwnership(user.id, video.filename, video.size, 'channel');
      if (poster) recordUploadOwnership(user.id, poster.filename, poster.size, 'channel');

      if (awardAchievements) awardAchievements(user.id); // may unlock clip badges

      res.json(serializeClip(db, info.lastInsertRowid, user.id));
    });
  });

  // ── GET /api/clips — gallery list ──────────────────────────────────────
  // Query: game=<slug>  sort=new|top  limit  offset
  router.get('/', (req, res) => {
    const user = authUser(req, res);
    if (!user) return;
    const db = getDb();

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const sort = req.query.sort === 'top' ? 'top' : 'new';
    const gameSlug = (typeof req.query.game === 'string' ? req.query.game : '').trim();

    const where = [];
    const args = [];
    if (gameSlug) { where.push('g.slug = ? COLLATE NOCASE'); args.push(gameSlug); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const orderSql = sort === 'top'
      ? 'ORDER BY votes DESC, c.created_at DESC'
      : 'ORDER BY c.created_at DESC';

    const rows = db.prepare(`
      SELECT c.id,
             (SELECT COUNT(*) FROM clip_votes v WHERE v.clip_id = c.id) AS votes
      FROM clips c
      LEFT JOIN games g ON g.id = c.game_id
      ${whereSql}
      ${orderSql}
      LIMIT ? OFFSET ?
    `).all(...args, limit, offset);

    const clips = rows.map(r => serializeClip(db, r.id, user.id)).filter(Boolean);
    res.json({ clips, limit, offset, sort });
  });

  // ── GET /api/clips/:id — one clip ──────────────────────────────────────
  router.get('/:id(\\d+)', (req, res) => {
    const user = authUser(req, res);
    if (!user) return;
    const clip = serializeClip(getDb(), parseInt(req.params.id, 10), user.id);
    if (!clip) return res.status(404).json({ error: 'Clip not found' });
    res.json(clip);
  });

  // ── GET /api/clips/:id/video — Range-capable inline stream ─────────────
  // Public-by-URL like /uploads (a <video> tag cannot send an auth header), but
  // served here so it plays inline and supports seeking. Filenames are random.
  router.get('/:id(\\d+)/video', (req, res) => {
    const db = getDb();
    const clip = db.prepare('SELECT file_path, mime FROM clips WHERE id = ?').get(parseInt(req.params.id, 10));
    if (!clip) return res.status(404).end();
    const abs = safeUploadPath(clip.file_path);
    if (!abs || !fs.existsSync(abs)) return res.status(404).end();

    const stat = fs.statSync(abs);
    const type = VIDEO_MIMES.has(clip.mime) ? clip.mime : 'video/mp4';
    res.setHeader('Content-Type', type);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'private, max-age=604800, immutable');

    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
      if (!Number.isFinite(start) || start < 0) start = 0;
      if (!Number.isFinite(end) || end >= stat.size) end = stat.size - 1;
      if (start > end) {
        res.status(416).setHeader('Content-Range', `bytes */${stat.size}`).end();
        return;
      }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      res.setHeader('Content-Length', end - start + 1);
      fs.createReadStream(abs, { start, end }).pipe(res);
    } else {
      res.setHeader('Content-Length', stat.size);
      fs.createReadStream(abs).pipe(res);
    }
  });

  // ── POST /api/clips/:id/vote — toggle up-vote ──────────────────────────
  router.post('/:id(\\d+)/vote', (req, res) => {
    const user = authUser(req, res);
    if (!user) return;
    const db = getDb();
    const id = parseInt(req.params.id, 10);
    const clip = db.prepare('SELECT id, uploader_id FROM clips WHERE id = ?').get(id);
    if (!clip) return res.status(404).json({ error: 'Clip not found' });

    const existing = db.prepare('SELECT 1 FROM clip_votes WHERE clip_id = ? AND user_id = ?').get(id, user.id);
    if (existing) db.prepare('DELETE FROM clip_votes WHERE clip_id = ? AND user_id = ?').run(id, user.id);
    else db.prepare('INSERT OR IGNORE INTO clip_votes (clip_id, user_id) VALUES (?, ?)').run(id, user.id);

    const votes = db.prepare('SELECT COUNT(*) AS n FROM clip_votes WHERE clip_id = ?').get(id).n;
    // The clip's owner may have just crossed a votes milestone.
    if (!existing && awardAchievements) awardAchievements(clip.uploader_id);
    res.json({ id, votes, voted: !existing });
  });

  // ── DELETE /api/clips/:id — owner or manage_clips ──────────────────────
  router.delete('/:id(\\d+)', (req, res) => {
    const user = authUser(req, res);
    if (!user) return;
    const db = getDb();
    const id = parseInt(req.params.id, 10);
    const clip = db.prepare('SELECT * FROM clips WHERE id = ?').get(id);
    if (!clip) return res.status(404).json({ error: 'Clip not found' });

    const isOwner = clip.uploader_id === user.id;
    if (!isOwner && !verifyAdminFromDb(user) && !getPerms().userHasPermission(user.id, 'manage_clips')) {
      return res.status(403).json({ error: "You don't have permission to delete this clip" });
    }

    db.prepare('DELETE FROM clips WHERE id = ?').run(id); // clip_votes cascade
    try {
      if (clip.file_path) deleteUpload(clip.file_path);
      if (clip.poster_path) deleteUpload(clip.poster_path);
    } catch { /* quarantine is best-effort */ }
    res.json({ ok: true, id });
  });

  return router;
}

// Delete clips older than clip_retention_days (0 = keep forever). Returns count.
// Called on an interval from server.js so retention doesn't need a live request.
function sweepExpiredClips(deleteUpload) {
  const db = getDb();
  const days = getSettingInt(db, 'clip_retention_days', 0);
  if (!days || days <= 0) return 0;
  const stale = db.prepare(
    "SELECT id, file_path, poster_path FROM clips WHERE created_at < datetime('now', ?)"
  ).all(`-${days} days`);
  if (stale.length === 0) return 0;
  const del = db.prepare('DELETE FROM clips WHERE id = ?');
  for (const c of stale) {
    del.run(c.id);
    try {
      if (c.file_path) deleteUpload(c.file_path);
      if (c.poster_path) deleteUpload(c.poster_path);
    } catch { /* best effort */ }
  }
  return stale.length;
}

module.exports = { createClipRoutes, sweepExpiredClips };
