'use strict';

/**
 * MSG Arena — scheduled events / game nights.
 *
 * An organiser (manage_events) schedules a session, optionally tied to a game;
 * members RSVP going / interested and get a reminder when it starts. start_at is
 * epoch ms. Broadcasts are viewer-agnostic — they carry the full attendee list,
 * so each client derives its own RSVP locally (no per-viewer payloads).
 *
 * Events (client → server):
 *   event:list                                              → event:list
 *   event:get     { id }                                    → event:detail
 *   event:create  { title, gameId?, startAt, description?, maxAttendees? }  (manage_events)
 *   event:rsvp    { id, status:'going'|'interested'|null }  (null clears)
 *   event:cancel  { id }                                    (creator or manage_events)
 *
 * Events (server → client):
 *   event:list      { events }        (requester)
 *   event:detail    { event }         (requester)
 *   event:updated   { event }         (broadcast; includes attendees)
 *   event:removed   { id }            (broadcast)
 *   event:starting  { event }         (RSVP'd users, when it begins)
 *   event:error     { message }       (requester)
 */

const MAX_TITLE = 100;
const MAX_DESC = 1000;
const KEEP_AFTER_MS = 2 * 60 * 60 * 1000;   // keep showing an event for 2h after start
const REMIND_WINDOW_MS = 10 * 60 * 1000;    // fire the "starting" reminder within 10m of start

let _sweeper = null;

module.exports = function register(socket, ctx) {
  const { db, io, userHasPermission, sendUserPush } = ctx;
  const broadcast = (event, payload) => io.except('bot-sockets').emit(event, payload);
  const me = () => socket.user;
  const canManage = () => me().isAdmin || userHasPermission(me().id, 'manage_events');
  const err = (message) => socket.emit('event:error', { message });

  const nameOf = (id) => { if (!id) return null; const u = db.prepare('SELECT username, display_name FROM users WHERE id = ?').get(id); return u ? (u.display_name || u.username) : 'Unknown'; };
  const gameOf = (gid) => { if (!gid) return null; const g = db.prepare('SELECT slug, name, icon FROM games WHERE id = ?').get(gid); return g ? { slug: g.slug, name: g.name, icon: g.icon || '🎮' } : null; };

  function serialize(id) {
    const e = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
    if (!e) return null;
    const attendees = db.prepare('SELECT user_id, status FROM event_rsvps WHERE event_id = ? ORDER BY created_at').all(id)
      .map(r => ({ id: r.user_id, name: nameOf(r.user_id), status: r.status }));
    return {
      id: e.id, title: e.title, description: e.description || '',
      game: gameOf(e.game_id), startAt: e.start_at, maxAttendees: e.max_attendees,
      channelCode: e.channel_code || null, status: e.status,
      createdBy: e.created_by, createdByName: nameOf(e.created_by),
      going: attendees.filter(a => a.status === 'going').length,
      interested: attendees.filter(a => a.status === 'interested').length,
      attendees,
    };
  }

  function upcoming() {
    const cutoff = Date.now() - KEEP_AFTER_MS;
    return db.prepare("SELECT id FROM events WHERE status = 'scheduled' AND start_at >= ? ORDER BY start_at ASC LIMIT 100")
      .all(cutoff).map(r => serialize(r.id)).filter(Boolean);
  }

  socket.on('event:list', () => socket.emit('event:list', { events: upcoming() }));

  socket.on('event:get', (d) => {
    const id = d && Number.isInteger(d.id) ? d.id : null;
    const e = id && serialize(id);
    if (!e) return err('Event not found');
    socket.emit('event:detail', { event: e });
  });

  socket.on('event:create', (d) => {
    if (!canManage()) return err("You don't have permission to schedule events");
    if (!d || typeof d !== 'object') return err('Invalid request');
    const title = typeof d.title === 'string' ? d.title.trim().slice(0, MAX_TITLE) : '';
    if (!title) return err('A title is required');
    const startAt = Number(d.startAt);
    if (!Number.isFinite(startAt) || startAt < Date.now() - 60000) return err('Pick a start time in the future');
    const description = typeof d.description === 'string' ? d.description.trim().slice(0, MAX_DESC) : '';
    let gameId = null;
    if (Number.isInteger(d.gameId)) { const g = db.prepare('SELECT id FROM games WHERE id = ?').get(d.gameId); if (g) gameId = g.id; }
    const maxAttendees = Number.isInteger(d.maxAttendees) ? Math.max(0, Math.min(1000, d.maxAttendees)) : 0;
    const info = db.prepare(
      'INSERT INTO events (title, description, game_id, start_at, max_attendees, created_by) VALUES (?,?,?,?,?,?)'
    ).run(title, description, gameId, Math.round(startAt), maxAttendees, me().id);
    // The organiser is going by default.
    db.prepare("INSERT OR IGNORE INTO event_rsvps (event_id, user_id, status) VALUES (?, ?, 'going')").run(info.lastInsertRowid, me().id);
    broadcast('event:updated', { event: serialize(info.lastInsertRowid) });
  });

  socket.on('event:rsvp', (d) => {
    const id = d && Number.isInteger(d.id) ? d.id : null;
    const e = id && db.prepare('SELECT * FROM events WHERE id = ?').get(id);
    if (!e) return err('Event not found');
    if (e.status !== 'scheduled') return err('This event is no longer open');
    const status = ['going', 'interested'].includes(d.status) ? d.status : null; // null clears
    if (status === null) {
      db.prepare('DELETE FROM event_rsvps WHERE event_id = ? AND user_id = ?').run(id, me().id);
    } else {
      if (status === 'going' && e.max_attendees > 0) {
        const going = db.prepare("SELECT COUNT(*) n FROM event_rsvps WHERE event_id = ? AND status = 'going'").get(id).n;
        const already = db.prepare("SELECT status FROM event_rsvps WHERE event_id = ? AND user_id = ?").get(id, me().id);
        if ((!already || already.status !== 'going') && going >= e.max_attendees) return err('This event is full');
      }
      db.prepare('INSERT INTO event_rsvps (event_id, user_id, status) VALUES (?,?,?) ON CONFLICT(event_id, user_id) DO UPDATE SET status = excluded.status').run(id, me().id, status);
    }
    broadcast('event:updated', { event: serialize(id) });
  });

  socket.on('event:cancel', (d) => {
    const id = d && Number.isInteger(d.id) ? d.id : null;
    const e = id && db.prepare('SELECT * FROM events WHERE id = ?').get(id);
    if (!e) return err('Event not found');
    if (!(canManage() || e.created_by === me().id)) return err("You can't cancel this event");
    db.prepare("UPDATE events SET status = 'cancelled' WHERE id = ?").run(id);
    broadcast('event:removed', { id });
  });

  // ── Reminder sweeper (started once, process-wide) ──
  if (!_sweeper) {
    const tick = () => {
      try {
        const now = Date.now();
        const due = db.prepare(
          "SELECT id FROM events WHERE status = 'scheduled' AND reminded = 0 AND start_at <= ? AND start_at > ?"
        ).all(now, now - REMIND_WINDOW_MS);
        for (const row of due) {
          db.prepare('UPDATE events SET reminded = 1 WHERE id = ?').run(row.id);
          const e = serialize(row.id);
          if (!e) continue;
          const goers = e.attendees.filter(a => a.status === 'going').map(a => a.id);
          for (const [, s] of io.of('/').sockets) {
            if (s.user && goers.includes(s.user.id)) s.emit('event:starting', { event: e });
          }
          if (typeof sendUserPush === 'function' && goers.length) {
            const label = e.game ? `${e.game.name}: ${e.title}` : e.title;
            sendUserPush(goers, '🎮 Event starting now', label, '/app');
          }
        }
      } catch (err2) { console.warn('[events] reminder sweep failed:', err2.message); }
    };
    _sweeper = setInterval(tick, 60 * 1000);
    if (_sweeper.unref) _sweeper.unref();
    setTimeout(tick, 5000).unref?.();
  }
};
