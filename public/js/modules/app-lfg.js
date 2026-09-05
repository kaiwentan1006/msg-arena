// ═══════════════════════════════════════════════════════════
// MSG Arena — LFG (Looking For Group) / party finder (client)
// Methods prefixed _lfg* to avoid prototype collisions when merged onto
// HavenApp via Object.assign in app.js.
// ═══════════════════════════════════════════════════════════

const LfgMethods = {
  _setupLfg() {
    this._lfgPosts = new Map();   // postId → post payload
    this._lfgGames = [];

    const openBtn = document.getElementById('lfg-btn');
    if (openBtn) openBtn.addEventListener('click', () => this._openLfgModal());
    const closeBtn = document.getElementById('lfg-close-btn');
    if (closeBtn) closeBtn.addEventListener('click', () => this._closeLfgModal());
    const overlay = document.getElementById('lfg-modal');
    if (overlay) overlay.addEventListener('click', (e) => { if (e.target === overlay) this._closeLfgModal(); });
    const refresh = document.getElementById('lfg-refresh-btn');
    if (refresh) refresh.addEventListener('click', () => this.socket.emit('lfg:list', {}));

    const form = document.getElementById('lfg-create-form');
    if (form) form.addEventListener('submit', (e) => { e.preventDefault(); this._lfgCreate(); });

    // Delegate action buttons in the list.
    const list = document.getElementById('lfg-list');
    if (list) list.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-lfg-act]');
      if (!btn) return;
      const id = parseInt(btn.dataset.postId, 10);
      const act = btn.dataset.lfgAct;
      if (act === 'join') this.socket.emit('lfg:join', { postId: id });
      else if (act === 'leave') this.socket.emit('lfg:leave', { postId: id });
      else if (act === 'close') this.socket.emit('lfg:close', { postId: id });
      else if (act === 'voice') this.socket.emit('lfg:start-voice', { postId: id });
      else if (act === 'kick') this.socket.emit('lfg:kick', { postId: id, userId: parseInt(btn.dataset.userId, 10) });
    });

    // ── Socket events ──
    this.socket.on('lfg:games', (data) => { this._lfgGames = (data && data.games) || []; this._renderLfgGames(); });
    this.socket.on('lfg:posts', (data) => {
      this._lfgPosts = new Map(((data && data.posts) || []).map(p => [p.id, p]));
      this._renderLfgBoard();
    });
    this.socket.on('lfg:post-created', (data) => {
      if (data && data.post) { this._lfgPosts.set(data.post.id, data.post); this._renderLfgBoard(); }
    });
    this.socket.on('lfg:post-updated', (data) => {
      if (data && data.post) { this._lfgPosts.set(data.post.id, data.post); this._renderLfgBoard(); }
    });
    this.socket.on('lfg:post-removed', (data) => {
      if (data && data.postId != null) { this._lfgPosts.delete(data.postId); this._renderLfgBoard(); }
    });
    this.socket.on('lfg:party-ready', (data) => {
      if (!data || !data.voiceCode) return;
      this._showToast(t('lfg.party_ready') || 'Your party is ready — joining voice…', 'success');
      // Mirror temp-channel-join-voice: switch to the party channel and join.
      this.switchChannel(data.voiceCode);
      setTimeout(() => this._joinVoice(), 600);
      this._closeLfgModal();
    });
  },

  _openLfgModal() {
    const m = document.getElementById('lfg-modal');
    if (!m) return;
    m.style.display = 'flex';
    this.socket.emit('lfg:games');
    this.socket.emit('lfg:list', {});
  },

  _closeLfgModal() {
    const m = document.getElementById('lfg-modal');
    if (m) m.style.display = 'none';
  },

  _renderLfgGames() {
    const sel = document.getElementById('lfg-game');
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = this._lfgGames
      .map(g => `<option value="${g.id}" data-size="${g.default_party_size || 5}">${this._escapeHtml((g.icon ? g.icon + ' ' : '') + g.name)}</option>`)
      .join('');
    if (prev) sel.value = prev;
    // Default the slot count to the selected game's party size.
    sel.onchange = () => {
      const opt = sel.options[sel.selectedIndex];
      const size = opt && opt.dataset.size ? parseInt(opt.dataset.size, 10) : 5;
      const slots = document.getElementById('lfg-slots');
      if (slots && size >= 2 && size <= 8) slots.value = String(size);
    };
    sel.onchange();
  },

  _lfgCreate() {
    const gameId = parseInt(document.getElementById('lfg-game')?.value, 10);
    if (!gameId) return this._showToast(t('lfg.pick_game') || 'Pick a game', 'error');
    this.socket.emit('lfg:create', {
      gameId,
      slots: parseInt(document.getElementById('lfg-slots')?.value, 10) || 5,
      mode: (document.getElementById('lfg-mode')?.value || '').trim(),
      note: (document.getElementById('lfg-note')?.value || '').trim(),
      expiresInMinutes: parseInt(document.getElementById('lfg-expiry')?.value, 10) || 60,
    });
    const note = document.getElementById('lfg-note'); if (note) note.value = '';
    const mode = document.getElementById('lfg-mode'); if (mode) mode.value = '';
  },

  _renderLfgBoard() {
    const list = document.getElementById('lfg-list');
    if (!list) return;
    const posts = [...this._lfgPosts.values()].sort((a, b) => b.id - a.id);
    if (!posts.length) {
      list.innerHTML = `<div class="lfg-empty">${this._escapeHtml(t('lfg.empty') || 'No open parties. Post one above!')}</div>`;
      return;
    }
    const myId = this.user && this.user.id;
    list.innerHTML = posts.map(p => {
      const inParty = p.members.some(m => m.id === myId);
      const isOwner = p.ownerId === myId;
      const isFull = p.status === 'full' || p.filled >= p.slots;
      const members = p.members.map(m =>
        `<span class="lfg-member${m.isOwner ? ' owner' : ''}">${m.isOwner ? '👑 ' : ''}${this._escapeHtml(m.name)}${m.role ? ` <em>(${this._escapeHtml(m.role)})</em>` : ''}${(isOwner && !m.isOwner) ? ` <button class="lfg-kick" data-lfg-act="kick" data-post-id="${p.id}" data-user-id="${m.id}" title="Remove">✕</button>` : ''}</span>`
      ).join('');
      let actions = '';
      if (isFull && inParty) actions += `<button class="btn-sm btn-accent" data-lfg-act="voice" data-post-id="${p.id}">🔊 ${this._escapeHtml(t('lfg.join_voice') || 'Join voice')}</button>`;
      else if (!inParty && !isFull) actions += `<button class="btn-sm btn-accent" data-lfg-act="join" data-post-id="${p.id}">${this._escapeHtml(t('lfg.join') || 'Join')}</button>`;
      if (isOwner) actions += `<button class="btn-sm btn-danger" data-lfg-act="close" data-post-id="${p.id}">${this._escapeHtml(t('lfg.close') || 'Close')}</button>`;
      else if (inParty) actions += `<button class="btn-sm" data-lfg-act="leave" data-post-id="${p.id}">${this._escapeHtml(t('lfg.leave') || 'Leave')}</button>`;
      return `
        <div class="lfg-card${isFull ? ' full' : ''}">
          <div class="lfg-card-head">
            <span class="lfg-game-name">${this._escapeHtml((p.game.icon ? p.game.icon + ' ' : '') + p.game.name)}</span>
            ${p.mode ? `<span class="lfg-mode-tag">${this._escapeHtml(p.mode)}</span>` : ''}
            <span class="lfg-count${isFull ? ' full' : ''}">${p.filled}/${p.slots}</span>
          </div>
          ${p.note ? `<div class="lfg-card-note">${this._escapeHtml(p.note)}</div>` : ''}
          <div class="lfg-members">${members}</div>
          <div class="lfg-card-actions">${actions}</div>
        </div>`;
    }).join('');
  },
};

export default LfgMethods;
