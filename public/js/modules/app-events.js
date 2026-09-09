// ═══════════════════════════════════════════════════════════
// MSG Arena — Scheduled events / game nights (client)
// Upcoming sessions with RSVP. Broadcasts carry the attendee list, so we derive
// our own RSVP locally. Methods prefixed _ev*.
// ═══════════════════════════════════════════════════════════

const EventMethods = {
  _setupEvents() {
    this._events = new Map();   // id → event
    this._evGames = [];

    const openBtn = document.getElementById('events-btn');
    if (openBtn) openBtn.addEventListener('click', () => this._openEvents());
    const closeBtn = document.getElementById('events-close-btn');
    if (closeBtn) closeBtn.addEventListener('click', () => this._closeEvents());
    const overlay = document.getElementById('events-modal');
    if (overlay) overlay.addEventListener('click', (e) => { if (e.target === overlay) this._closeEvents(); });

    const body = document.getElementById('events-body');
    if (body) {
      body.addEventListener('click', (e) => this._onEventsClick(e));
      body.addEventListener('submit', (e) => this._onEventsSubmit(e));
    }

    if (this.socket) {
      this.socket.on('event:list', (d) => { this._events = new Map(((d && d.events) || []).map(e => [e.id, e])); if (this._evOpen()) this._renderEvents(); });
      this.socket.on('event:updated', (d) => { if (d && d.event) { this._events.set(d.event.id, d.event); if (this._evOpen()) this._renderEvents(); } });
      this.socket.on('event:removed', (d) => { if (d) { this._events.delete(d.id); if (this._evOpen()) this._renderEvents(); } });
      this.socket.on('event:error', (d) => this._showToast((d && d.message) || 'Event error', 'error'));
      this.socket.on('event:starting', (d) => {
        if (!d || !d.event) return;
        this._showToast(`🎮 ${this._evT('events.starting_now', 'Starting now')}: ${d.event.title}`, 'success');
      });
      this.socket.on('lfg:games', (d) => { this._evGames = (d && d.games) || []; });
    }
  },

  _evOpen() { const m = document.getElementById('events-modal'); return m && m.style.display !== 'none'; },
  _evT(key, def) { const v = t(key); return (v && v !== key) ? v : def; },
  _evCanManage() { return this._hasPerm && this._hasPerm('manage_events'); },

  _openEvents() {
    const m = document.getElementById('events-modal');
    if (!m) return;
    m.style.display = 'flex';
    if (this.socket && this.socket.connected) { this.socket.emit('event:list'); this.socket.emit('lfg:games'); }
    if ((!this._evGames || !this._evGames.length) && Array.isArray(this._lfgGames)) this._evGames = this._lfgGames;
    this._renderEvents();
  },

  _closeEvents() { const m = document.getElementById('events-modal'); if (m) m.style.display = 'none'; },

  _evWhen(ms) {
    const d = new Date(ms);
    const abs = d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const diff = ms - Date.now();
    let rel;
    if (diff <= 0) rel = this._evT('events.live_now', 'now');
    else if (diff < 3600e3) rel = `${Math.max(1, Math.round(diff / 60e3))}m`;
    else if (diff < 86400e3) rel = `${Math.round(diff / 3600e3)}h`;
    else rel = `${Math.round(diff / 86400e3)}d`;
    return { abs, rel };
  },

  _renderEvents() {
    const body = document.getElementById('events-body');
    if (!body) return;
    const mine = this.user && this.user.id;
    const list = [...this._events.values()].sort((a, b) => a.startAt - b.startAt);

    const cards = list.map(e => {
      const my = (e.attendees || []).find(a => a.id === mine);
      const when = this._evWhen(e.startAt);
      const gameChip = e.game ? `<span class="ev-chip">${e.game.icon ? this._escapeHtml(e.game.icon) + ' ' : ''}${this._escapeHtml(e.game.name)}</span>` : '';
      const cap = e.maxAttendees > 0 ? `/${e.maxAttendees}` : '';
      const canCancel = this._evCanManage() || e.createdBy === mine;
      return `
        <div class="ev-card" data-id="${e.id}">
          <div class="ev-when"><span class="ev-rel">${this._escapeHtml(when.rel)}</span><span class="ev-abs">${this._escapeHtml(when.abs)}</span></div>
          <div class="ev-main">
            <div class="ev-title">${this._escapeHtml(e.title)} ${gameChip}</div>
            ${e.description ? `<div class="ev-desc">${this._escapeHtml(e.description)}</div>` : ''}
            <div class="ev-meta">👥 ${e.going}${cap} ${this._escapeHtml(this._evT('events.going', 'going'))} · ${e.interested} ${this._escapeHtml(this._evT('events.interested', 'interested'))}<span class="ev-host"> · ${this._escapeHtml(this._evT('events.by', 'by'))} ${this._escapeHtml(e.createdByName || '')}</span></div>
            <div class="ev-actions">
              <button class="btn-xs ev-rsvp${my && my.status === 'going' ? ' active' : ''}" data-ev-act="going" data-id="${e.id}">✅ ${this._escapeHtml(this._evT('events.going_btn', 'Going'))}</button>
              <button class="btn-xs ev-rsvp${my && my.status === 'interested' ? ' active' : ''}" data-ev-act="interested" data-id="${e.id}">⭐ ${this._escapeHtml(this._evT('events.interested_btn', 'Interested'))}</button>
              ${canCancel ? `<button class="btn-xs btn-danger" data-ev-act="cancel" data-id="${e.id}">${this._escapeHtml(this._evT('events.cancel', 'Cancel'))}</button>` : ''}
            </div>
          </div>
        </div>`;
    }).join('');

    body.innerHTML = `
      <div class="ev-header">
        <span data-i18n="events.upcoming">Upcoming</span>
        ${this._evCanManage() ? `<button class="btn-accent btn-sm" data-ev-act="new">${this._escapeHtml(this._evT('events.new_btn', 'Schedule event'))}</button>` : ''}
      </div>
      ${this._evCanManage() ? this._evCreateFormHtml() : ''}
      <div class="ev-list">${cards || `<div class="ev-empty">${this._escapeHtml(this._evT('events.empty', 'No upcoming events.'))}</div>`}</div>`;
  },

  _evCreateFormHtml() {
    const games = (this._evGames || []).map(g => `<option value="${g.id}">${g.icon ? this._escapeHtml(g.icon) + ' ' : ''}${this._escapeHtml(g.name)}</option>`).join('');
    const dflt = new Date(Date.now() + 3600e3 - (new Date()).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    return `
      <form id="events-create-form" class="ev-create" style="display:none">
        <input id="ev-title" class="ev-input" maxlength="100" placeholder="${this._escapeHtml(this._evT('events.title_placeholder', 'Event title'))}" required>
        <select id="ev-game" class="ev-input"><option value="">${this._escapeHtml(this._evT('events.no_game', 'No game'))}</option>${games}</select>
        <input id="ev-when" class="ev-input" type="datetime-local" value="${dflt}" required>
        <input id="ev-max" class="ev-input" type="number" min="0" max="1000" placeholder="${this._escapeHtml(this._evT('events.max_placeholder', 'Max (0=∞)'))}" style="width:110px">
        <input id="ev-descr" class="ev-input ev-descr" maxlength="1000" placeholder="${this._escapeHtml(this._evT('events.desc_placeholder', 'Description (optional)'))}">
        <button type="submit" class="btn-accent">${this._escapeHtml(this._evT('events.create_btn', 'Schedule'))}</button>
      </form>`;
  },

  _onEventsClick(e) {
    const btn = e.target.closest('[data-ev-act]');
    if (!btn) return;
    const act = btn.dataset.evAct;
    const id = btn.dataset.id ? parseInt(btn.dataset.id, 10) : null;
    const s = this.socket;
    if (act === 'new') { const f = document.getElementById('events-create-form'); if (f) f.style.display = f.style.display === 'none' ? 'flex' : 'none'; return; }
    if (act === 'cancel') { if (confirm(this._evT('events.confirm_cancel', 'Cancel this event?'))) s && s.emit('event:cancel', { id }); return; }
    if (act === 'going' || act === 'interested') {
      // Toggle off if already that status.
      const ev = this._events.get(id);
      const my = ev && (ev.attendees || []).find(a => a.id === (this.user && this.user.id));
      const next = (my && my.status === act) ? null : act;
      s && s.emit('event:rsvp', { id, status: next });
    }
  },

  _onEventsSubmit(e) {
    if (e.target.id !== 'events-create-form') return;
    e.preventDefault();
    const title = (document.getElementById('ev-title').value || '').trim();
    const whenVal = document.getElementById('ev-when').value;
    if (!title || !whenVal) return;
    const startAt = new Date(whenVal).getTime();
    if (!Number.isFinite(startAt)) { this._showToast(this._evT('events.bad_time', 'Pick a valid date & time'), 'error'); return; }
    const gameId = parseInt(document.getElementById('ev-game').value, 10);
    const maxAttendees = parseInt(document.getElementById('ev-max').value, 10);
    this.socket && this.socket.emit('event:create', {
      title,
      gameId: Number.isInteger(gameId) ? gameId : undefined,
      startAt,
      description: (document.getElementById('ev-descr').value || '').trim(),
      maxAttendees: Number.isInteger(maxAttendees) ? maxAttendees : 0,
    });
    e.target.reset(); e.target.style.display = 'none';
  },
};

export default EventMethods;
