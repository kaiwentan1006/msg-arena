// ═══════════════════════════════════════════════════════════
// MSG Arena — Squads / teams (client)
// Persistent teams with rosters, invites, roles and on-demand voice.
// Methods prefixed _squad*/_setupSquads to avoid prototype collisions.
// ═══════════════════════════════════════════════════════════

const SquadsMethods = {
  _setupSquads() {
    this._squadsView = 'home';
    this._mySquads = [];
    this._browseSquads = [];
    this._squadInvites = [];
    this._squadDetail = null;

    const openBtn = document.getElementById('squads-btn');
    if (openBtn) openBtn.addEventListener('click', () => this._openSquads());
    const closeBtn = document.getElementById('squads-close-btn');
    if (closeBtn) closeBtn.addEventListener('click', () => this._closeSquads());
    const overlay = document.getElementById('squads-modal');
    if (overlay) overlay.addEventListener('click', (e) => { if (e.target === overlay) this._closeSquads(); });

    if (this.socket) {
      this.socket.on('squad:mine', (d) => { this._mySquads = (d && d.squads) || []; if (this._squadsView === 'home') this._renderSquadsHome(); this._updateSquadsBadge(); });
      this.socket.on('squad:browse', (d) => { this._browseSquads = (d && d.squads) || []; if (this._squadsView === 'browse') this._renderSquadsList('browse'); });
      this.socket.on('squad:invites', (d) => { this._squadInvites = (d && d.invites) || []; if (this._squadsView === 'home') this._renderSquadsHome(); this._updateSquadsBadge(); });
      this.socket.on('squad:detail', (d) => {
        if (!d) return;
        if (d.gone) { this._squadsView = 'home'; this.socket.emit('squad:mine'); this._renderSquadsHome(); return; }
        this._squadDetail = d; this._squadsView = 'detail'; this._renderSquadDetail();
      });
      this.socket.on('squad:candidates', (d) => { if (d && this._squadDetail && d.squadId === this._squadDetail.id) this._renderSquadCandidates(d.candidates || []); });
      this.socket.on('squad:invited', (d) => { this._showToast('🛡️ ' + this._squadsT('squads.invited_toast', 'You were invited to') + ' ' + ((d && d.name) || ''), 'info'); this.socket.emit('squad:invites'); });
      this.socket.on('squad:removed', () => { this.socket.emit('squad:mine'); if (this._squadsView === 'detail') { this._squadsView = 'home'; this._renderSquadsHome(); } });
      this.socket.on('squad:voice-started', (d) => { this._showToast('🔊 ' + ((d && d.name) || 'Squad') + ': ' + this._squadsT('squads.voice_started', 'squad voice started'), 'info'); });
      this.socket.on('squad:voice-ready', (d) => { if (d && d.code && this.switchChannel) { this.switchChannel(d.code); setTimeout(() => this._joinVoice && this._joinVoice(), 600); } });
      this.socket.emit('squad:invites');
    }
  },

  _squadsT(k, def) { const v = t(k); return (v && v !== k) ? v : def; },

  _updateSquadsBadge() {
    const btn = document.getElementById('squads-btn'); if (!btn) return;
    const n = (this._squadInvites || []).length;
    let dot = btn.querySelector('.squads-badge');
    if (n > 0) { if (!dot) { dot = document.createElement('span'); dot.className = 'squads-badge'; btn.appendChild(dot); } dot.textContent = String(n); }
    else if (dot) dot.remove();
  },

  _openSquads() { const m = document.getElementById('squads-modal'); if (!m) return; m.style.display = 'flex'; this._squadsView = 'home'; this.socket.emit('squad:mine'); this.socket.emit('squad:invites'); this._renderSquadsHome(); },
  _closeSquads() { const m = document.getElementById('squads-modal'); if (m) m.style.display = 'none'; },

  _squadTabs(active) {
    const T = (k, d) => this._escapeHtml(this._squadsT(k, d));
    const tab = (id, label) => `<button class="squad-tab${active === id ? ' active' : ''}" data-squad-tab="${id}">${label}</button>`;
    return `<div class="squad-tabs">${tab('home', T('squads.tab_mine', 'My Squads'))}${tab('browse', T('squads.tab_browse', 'Browse'))}${tab('create', '+ ' + T('squads.tab_create', 'Create'))}</div>`;
  },

  _squadRow(s) {
    const esc = (x) => this._escapeHtml(String(x));
    const role = s.myRole ? `<span class="squad-role squad-role-${esc(s.myRole)}">${esc(s.myRole)}</span>` : '';
    const tag = s.tag ? `<span class="squad-tag">[${esc(s.tag)}]</span> ` : '';
    return `<div class="squad-row" data-squad-open="${s.id}"><span class="squad-name">${tag}${esc(s.name)}</span>${role}<span class="squad-members">👥 ${s.members || 0}</span></div>`;
  },

  _renderSquadsHome() {
    this._squadsView = 'home';
    const body = document.getElementById('squads-body'); if (!body) return;
    const esc = (s) => this._escapeHtml(String(s));
    const invites = this._squadInvites || [];
    const invHtml = invites.length ? `<div class="squad-invites"><div class="squad-section-label">${esc(this._squadsT('squads.pending_invites', 'Pending invites'))}</div>${invites.map(iv => `<div class="squad-invite-row"><span class="squad-name">${iv.tag ? '<span class="squad-tag">[' + esc(iv.tag) + ']</span> ' : ''}${esc(iv.name)}</span><span class="squad-invite-by">${iv.invitedBy ? esc(this._squadsT('squads.from', 'from') + ' ' + iv.invitedBy) : ''}</span><span class="squad-invite-actions"><button class="btn-sm btn-accent" data-squad-accept="${iv.squadId}">${esc(this._squadsT('squads.accept', 'Accept'))}</button><button class="btn-sm" data-squad-decline="${iv.squadId}">${esc(this._squadsT('squads.decline', 'Decline'))}</button></span></div>`).join('')}</div>` : '';
    const mine = this._mySquads || [];
    const listHtml = mine.length ? `<div class="squad-list">${mine.map(s => this._squadRow(s)).join('')}</div>` : `<div class="lb-empty">${esc(this._squadsT('squads.none_mine', 'You are not in any squads yet. Browse or create one!'))}</div>`;
    body.innerHTML = this._squadTabs('home') + invHtml + listHtml;
    this._wireSquadsBody(body);
  },

  _renderSquadsList(kind) {
    this._squadsView = kind;
    const body = document.getElementById('squads-body'); if (!body) return;
    const esc = (s) => this._escapeHtml(String(s));
    const list = this._browseSquads || [];
    body.innerHTML = this._squadTabs(kind) + (list.length ? `<div class="squad-list">${list.map(s => this._squadRow(s)).join('')}</div>` : `<div class="lb-empty">${esc(this._squadsT('squads.none', 'No squads yet — create the first!'))}</div>`);
    this._wireSquadsBody(body);
  },

  _renderSquadCreate() {
    this._squadsView = 'create';
    const body = document.getElementById('squads-body'); if (!body) return;
    const ph = (k, d) => this._escapeHtml(this._squadsT(k, d));
    body.innerHTML = this._squadTabs('create') + `<form id="squad-create-form" class="squad-create" autocomplete="off"><input id="squad-name" class="lfg-input" maxlength="40" required placeholder="${ph('squads.name_ph', 'Squad name')}"><input id="squad-tag" class="lfg-input" maxlength="6" placeholder="${ph('squads.tag_ph', 'Tag (e.g. MSG)')}"><textarea id="squad-desc" class="lfg-input" maxlength="300" rows="2" placeholder="${ph('squads.desc_ph', 'Description (optional)')}"></textarea><button type="submit" class="btn-accent">${ph('squads.create_btn', 'Create squad')}</button></form>`;
    this._wireSquadsBody(body);
  },

  _renderSquadDetail() {
    this._squadsView = 'detail';
    const body = document.getElementById('squads-body'); if (!body) return;
    const d = this._squadDetail; if (!d) return;
    const esc = (s) => this._escapeHtml(String(s));
    const T = (k, def) => esc(this._squadsT(k, def));
    const canManage = d.myRole === 'owner' || d.myRole === 'captain';
    const isOwner = d.myRole === 'owner';
    const roster = (d.roster || []).map(m => {
      const name = m.displayName || m.username || '?';
      const initial = esc((name.charAt(0) || '?').toUpperCase());
      const av = m.avatar ? `<img class="gp-avatar" src="${esc(m.avatar)}" alt="">` : `<span class="gp-avatar gp-initial" style="background:${this._getUserColor ? this._getUserColor(m.username) : '#3a3f4b'}">${initial}</span>`;
      let actions = '';
      if (m.userId !== this.user.id) {
        if (isOwner && m.role !== 'owner') actions += `<button class="btn-sm" data-squad-promote="${m.userId}" title="${T('squads.toggle_captain', 'Toggle captain')}">${m.role === 'captain' ? '▼' : '▲'}</button>`;
        if (isOwner && m.role !== 'owner') actions += `<button class="btn-sm btn-danger" data-squad-kick="${m.userId}">${T('squads.kick', 'Remove')}</button>`;
        else if (d.myRole === 'captain' && m.role === 'member') actions += `<button class="btn-sm btn-danger" data-squad-kick="${m.userId}">${T('squads.kick', 'Remove')}</button>`;
      }
      return `<div class="squad-member-row"><span class="squad-avatar-wrap">${av}</span><span class="gp-name">${esc(name)}</span><span class="squad-role squad-role-${esc(m.role)}">${esc(m.role)}</span><span class="squad-member-actions">${actions}</span></div>`;
    }).join('');
    const tag = d.tag ? `<span class="squad-tag">[${esc(d.tag)}]</span> ` : '';
    const inviteHtml = canManage ? `<div class="squad-invite-box"><input id="squad-invite-search" class="lfg-input" placeholder="${T('squads.invite_ph', 'Invite a member by name…')}"><div id="squad-candidates" class="squad-candidates"></div></div>` : '';
    const footer = `<div class="squad-detail-footer"><button class="btn-sm btn-accent" data-squad-voice="${d.id}">🔊 ${T('squads.voice_btn', 'Squad voice')}</button>${isOwner ? `<button class="btn-sm btn-danger" data-squad-disband="${d.id}">${T('squads.disband', 'Disband')}</button>` : `<button class="btn-sm" data-squad-leave="${d.id}">${T('squads.leave', 'Leave squad')}</button>`}</div>`;
    body.innerHTML = `<button class="games-back" id="squad-back">← ${T('squads.back', 'Back')}</button>` +
      `<div class="squad-detail-head">${tag}${esc(d.name)} <span class="squad-members">👥 ${d.members || 0}</span></div>` +
      (d.description ? `<div class="squad-desc">${esc(d.description)}</div>` : '') +
      inviteHtml +
      `<div class="squad-section-label">${T('squads.roster', 'Roster')}</div><div class="squad-roster">${roster}</div>` +
      footer;
    this._wireSquadsBody(body);
  },

  _renderSquadCandidates(list) {
    const box = document.getElementById('squad-candidates'); if (!box) return;
    const esc = (s) => this._escapeHtml(String(s));
    box.innerHTML = (list || []).map(c => `<div class="squad-candidate" data-squad-invite="${c.userId}">${esc(c.displayName || c.username)}</div>`).join('') || `<div class="squad-cand-empty">${esc(this._squadsT('squads.no_matches', 'No matches'))}</div>`;
    box.querySelectorAll('[data-squad-invite]').forEach(el => el.addEventListener('click', () => {
      const uid = parseInt(el.dataset.squadInvite, 10);
      if (this._squadDetail) this.socket.emit('squad:invite', { squadId: this._squadDetail.id, userId: uid });
      const s = document.getElementById('squad-invite-search'); if (s) s.value = '';
      box.innerHTML = '';
    }));
  },

  _wireSquadsBody(body) {
    body.querySelectorAll('[data-squad-tab]').forEach(el => el.addEventListener('click', () => {
      const v = el.dataset.squadTab;
      if (v === 'home') { this.socket.emit('squad:mine'); this.socket.emit('squad:invites'); this._renderSquadsHome(); }
      else if (v === 'browse') { this.socket.emit('squad:browse'); this._renderSquadsList('browse'); }
      else if (v === 'create') { this._renderSquadCreate(); }
    }));
    body.querySelectorAll('[data-squad-open]').forEach(el => el.addEventListener('click', () => this.socket.emit('squad:get', { squadId: parseInt(el.dataset.squadOpen, 10) })));
    body.querySelectorAll('[data-squad-accept]').forEach(el => el.addEventListener('click', () => { this.socket.emit('squad:accept', { squadId: parseInt(el.dataset.squadAccept, 10) }); }));
    body.querySelectorAll('[data-squad-decline]').forEach(el => el.addEventListener('click', () => { this.socket.emit('squad:decline', { squadId: parseInt(el.dataset.squadDecline, 10) }); }));
    const back = document.getElementById('squad-back'); if (back) back.addEventListener('click', () => { this.socket.emit('squad:mine'); this.socket.emit('squad:invites'); this._renderSquadsHome(); });
    const form = document.getElementById('squad-create-form');
    if (form) form.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = (document.getElementById('squad-name').value || '').trim();
      const tag = (document.getElementById('squad-tag').value || '').trim();
      const description = (document.getElementById('squad-desc').value || '').trim();
      if (name.length < 2) return;
      this.socket.emit('squad:create', { name, tag, description });
    });
    const search = document.getElementById('squad-invite-search');
    if (search) search.addEventListener('input', () => {
      clearTimeout(this._squadSearchT);
      this._squadSearchT = setTimeout(() => {
        if (this._squadDetail) this.socket.emit('squad:candidates', { squadId: this._squadDetail.id, q: search.value.trim() });
      }, 220);
    });
    body.querySelectorAll('[data-squad-promote]').forEach(el => el.addEventListener('click', () => { if (this._squadDetail) this.socket.emit('squad:promote', { squadId: this._squadDetail.id, userId: parseInt(el.dataset.squadPromote, 10) }); }));
    body.querySelectorAll('[data-squad-kick]').forEach(el => el.addEventListener('click', () => { if (this._squadDetail) this.socket.emit('squad:kick', { squadId: this._squadDetail.id, userId: parseInt(el.dataset.squadKick, 10) }); }));
    body.querySelectorAll('[data-squad-voice]').forEach(el => el.addEventListener('click', () => { this.socket.emit('squad:voice', { squadId: parseInt(el.dataset.squadVoice, 10) }); this._closeSquads(); }));
    body.querySelectorAll('[data-squad-leave]').forEach(el => el.addEventListener('click', () => { this.socket.emit('squad:leave', { squadId: parseInt(el.dataset.squadLeave, 10) }); this.socket.emit('squad:mine'); this._renderSquadsHome(); }));
    body.querySelectorAll('[data-squad-disband]').forEach(el => el.addEventListener('click', () => { if (confirm(this._squadsT('squads.disband_confirm', 'Disband this squad? This cannot be undone.'))) this.socket.emit('squad:disband', { squadId: parseInt(el.dataset.squadDisband, 10) }); }));
  },
};

export default SquadsMethods;
