// ═══════════════════════════════════════════════════════════
// MSG Arena — Clips / highlights (client)
// A gallery of short highlight videos. Upload is REST (multipart) so it reuses
// the server's disk-guard + ownership pipeline; the poster frame is captured
// here from a seeked <video> (no server ffmpeg). Methods are prefixed _clip*
// to avoid prototype collisions when merged onto HavenApp via Object.assign.
// ═══════════════════════════════════════════════════════════

const ClipMethods = {
  _setupClips() {
    this._clipGames = [];
    this._clipSort = 'new';
    this._clipGameFilter = '';

    const openBtn = document.getElementById('clips-btn');
    if (openBtn) openBtn.addEventListener('click', () => this._openClipsModal());
    const closeBtn = document.getElementById('clips-close-btn');
    if (closeBtn) closeBtn.addEventListener('click', () => this._closeClipsModal());
    const overlay = document.getElementById('clips-modal');
    if (overlay) overlay.addEventListener('click', (e) => { if (e.target === overlay) this._closeClipsModal(); });

    const form = document.getElementById('clip-upload-form');
    if (form) form.addEventListener('submit', (e) => { e.preventDefault(); this._uploadClip(); });

    const fileInput = document.getElementById('clip-file');
    if (fileInput) fileInput.addEventListener('change', () => this._onClipFilePicked());

    const sortSel = document.getElementById('clip-sort');
    if (sortSel) sortSel.addEventListener('change', () => { this._clipSort = sortSel.value; this._loadClips(); });
    const gameFilter = document.getElementById('clip-game-filter');
    if (gameFilter) gameFilter.addEventListener('change', () => { this._clipGameFilter = gameFilter.value; this._loadClips(); });

    // Delegated actions on clip cards.
    const list = document.getElementById('clips-gallery');
    if (list) list.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-clip-act]');
      if (btn) {
        const id = parseInt(btn.dataset.clipId, 10);
        const act = btn.dataset.clipAct;
        if (act === 'vote') this._voteClip(id, btn);
        else if (act === 'delete') this._deleteClip(id);
        else if (act === 'play') this._playClip(id);
        return;
      }
      const poster = e.target.closest('[data-clip-play]');
      if (poster) this._playClip(parseInt(poster.dataset.clipPlay, 10));
    });

    // The games catalogue is shared with LFG; listen for it and refresh both
    // dropdowns when it arrives.
    if (this.socket) {
      this.socket.on('lfg:games', (data) => {
        this._clipGames = (data && data.games) || [];
        this._renderClipGameOptions();
      });
    }
  },

  _openClipsModal() {
    const m = document.getElementById('clips-modal');
    if (!m) return;
    m.style.display = 'flex';
    if (this.socket && this.socket.connected) this.socket.emit('lfg:games');
    // Reuse the catalogue LFG may already have fetched.
    if ((!this._clipGames || this._clipGames.length === 0) && Array.isArray(this._lfgGames)) {
      this._clipGames = this._lfgGames;
    }
    this._renderClipGameOptions();
    this._loadClips();
  },

  _closeClipsModal() {
    const m = document.getElementById('clips-modal');
    if (m) m.style.display = 'none';
    // Stop any playing video so audio doesn't continue in the background.
    document.querySelectorAll('#clips-gallery video').forEach(v => { try { v.pause(); } catch {} });
  },

  _renderClipGameOptions() {
    const games = this._clipGames || [];
    const opts = games.map(g => `<option value="${this._escapeHtml(g.slug)}">${g.icon ? this._escapeHtml(g.icon) + ' ' : ''}${this._escapeHtml(g.name)}</option>`).join('');
    const upload = document.getElementById('clip-game');
    if (upload) upload.innerHTML = `<option value="" data-i18n="clips.no_game">No game</option>` + opts;
    const filter = document.getElementById('clip-game-filter');
    if (filter) {
      const cur = filter.value;
      filter.innerHTML = `<option value="">${t('clips.all_games') || 'All games'}</option>` + opts;
      filter.value = cur;
    }
  },

  // When a file is picked, show its name and a size hint.
  _onClipFilePicked() {
    const input = document.getElementById('clip-file');
    const label = document.getElementById('clip-file-label');
    if (!input || !label) return;
    const f = input.files && input.files[0];
    if (!f) { label.textContent = t('clips.choose_file') || 'Choose a video…'; return; }
    const mb = (f.size / 1024 / 1024).toFixed(1);
    label.textContent = `${f.name} · ${mb} MB`;
  },

  // Grab a poster frame + duration from the video, entirely client-side.
  _captureClipPoster(file) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (blob, duration) => { if (settled) return; settled = true; try { URL.revokeObjectURL(url); } catch {} resolve({ blob, duration }); };
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;
      video.playsInline = true;
      const url = URL.createObjectURL(file);
      video.src = url;
      video.onloadedmetadata = () => {
        const d = Number.isFinite(video.duration) ? video.duration : 0;
        // A frame a little into the clip is more representative than frame 0.
        const seekTo = d > 2 ? Math.min(1.5, d * 0.15) : 0;
        try { video.currentTime = seekTo; } catch { done(null, d); }
      };
      video.onseeked = () => {
        try {
          const w = video.videoWidth || 640;
          const h = video.videoHeight || 360;
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          canvas.getContext('2d').drawImage(video, 0, 0, w, h);
          canvas.toBlob(b => done(b, video.duration || 0), 'image/jpeg', 0.82);
        } catch { done(null, video.duration || 0); }
      };
      video.onerror = () => done(null, 0);
      setTimeout(() => done(null, video.duration || 0), 8000); // never hang the upload
    });
  },

  async _uploadClip() {
    const fileInput = document.getElementById('clip-file');
    const titleInput = document.getElementById('clip-title');
    const descInput = document.getElementById('clip-desc');
    const gameSel = document.getElementById('clip-game');
    const btn = document.getElementById('clip-upload-btn');

    const file = fileInput && fileInput.files && fileInput.files[0];
    const title = (titleInput && titleInput.value || '').trim();
    if (!file) { this._showToast(t('clips.pick_a_file') || 'Pick a video to upload', 'error'); return; }
    if (!title) { this._showToast(t('clips.title_required') || 'Give your clip a title', 'error'); return; }
    if (!/^video\//.test(file.type)) { this._showToast(t('clips.not_a_video') || 'That is not a video file', 'error'); return; }

    if (btn) { btn.disabled = true; btn.dataset.orig = btn.textContent; btn.textContent = t('clips.uploading') || 'Uploading…'; }
    try {
      const { blob: poster, duration } = await this._captureClipPoster(file);
      const fd = new FormData();
      fd.append('title', title.slice(0, 120));
      if (descInput) fd.append('description', (descInput.value || '').trim().slice(0, 1000));
      if (gameSel && gameSel.value) fd.append('game', gameSel.value);
      if (Number.isFinite(duration) && duration > 0) fd.append('durationSec', String(duration));
      fd.append('video', file, file.name);
      if (poster) fd.append('poster', poster, 'poster.jpg');

      const res = await fetch('/api/clips', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}` },
        body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { this._showToast(data.error || (t('clips.upload_failed') || 'Upload failed'), 'error'); return; }

      this._showToast(t('clips.posted') || 'Clip posted!', 'success');
      if (fileInput) fileInput.value = '';
      if (titleInput) titleInput.value = '';
      if (descInput) descInput.value = '';
      this._onClipFilePicked();
      this._loadClips();
    } catch (err) {
      this._showToast((err && err.message) || 'Upload failed', 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = btn.dataset.orig || (t('clips.post_btn') || 'Post clip'); }
    }
  },

  async _loadClips() {
    const gallery = document.getElementById('clips-gallery');
    if (!gallery) return;
    gallery.innerHTML = `<div class="clips-empty">${t('clips.loading') || 'Loading…'}</div>`;
    try {
      const params = new URLSearchParams({ sort: this._clipSort || 'new' });
      if (this._clipGameFilter) params.set('game', this._clipGameFilter);
      const res = await fetch(`/api/clips?${params.toString()}`, { headers: { Authorization: `Bearer ${this.token}` } });
      const data = await res.json().catch(() => ({ clips: [] }));
      this._renderClips(data.clips || []);
    } catch {
      gallery.innerHTML = `<div class="clips-empty">${t('clips.load_failed') || 'Could not load clips.'}</div>`;
    }
  },

  _renderClips(clips) {
    const gallery = document.getElementById('clips-gallery');
    if (!gallery) return;
    if (!clips.length) {
      gallery.innerHTML = `<div class="clips-empty">${t('clips.empty') || 'No clips yet — be the first to post a highlight.'}</div>`;
      return;
    }
    const myId = this.user && this.user.id;
    gallery.innerHTML = clips.map(c => {
      const canDelete = c.uploaderId === myId || this._hasPerm('manage_clips');
      const poster = c.posterUrl
        ? `<img class="clip-poster" src="${this._escapeHtml(c.posterUrl)}" alt="" loading="lazy">`
        : `<div class="clip-poster clip-poster-none">🎬</div>`;
      const dur = (Number.isFinite(c.durationSec) && c.durationSec > 0) ? this._formatClipDuration(c.durationSec) : '';
      const gameChip = c.game ? `<span class="clip-game-chip">${c.game.icon ? this._escapeHtml(c.game.icon) + ' ' : ''}${this._escapeHtml(c.game.name)}</span>` : '';
      return `
        <div class="clip-card" data-clip-id="${c.id}">
          <div class="clip-thumb" data-clip-play="${c.id}" role="button" tabindex="0" title="${t('clips.play') || 'Play'}">
            ${poster}
            <span class="clip-play-badge">▶</span>
            ${dur ? `<span class="clip-duration">${dur}</span>` : ''}
          </div>
          <div class="clip-meta">
            <div class="clip-title" title="${this._escapeHtml(c.title)}">${this._escapeHtml(c.title)}</div>
            <div class="clip-sub">${gameChip}<span class="clip-uploader">${this._escapeHtml(c.uploader)}</span></div>
            <div class="clip-actions">
              <button class="clip-vote${c.voted ? ' voted' : ''}" data-clip-act="vote" data-clip-id="${c.id}" title="${t('clips.vote') || 'Up-vote'}">▲ <span class="clip-vote-count">${c.votes}</span></button>
              ${canDelete ? `<button class="clip-del" data-clip-act="delete" data-clip-id="${c.id}" title="${t('clips.delete') || 'Delete'}">🗑</button>` : ''}
            </div>
          </div>
        </div>`;
    }).join('');
  },

  _formatClipDuration(sec) {
    const s = Math.round(sec);
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  },

  _playClip(id) {
    const card = document.querySelector(`.clip-card[data-clip-id="${id}"] .clip-thumb`);
    if (!card) return;
    card.innerHTML = `<video class="clip-video" src="/api/clips/${id}/video" controls autoplay playsinline></video>`;
    card.removeAttribute('data-clip-play');
  },

  async _voteClip(id, btn) {
    try {
      const res = await fetch(`/api/clips/${id}/vote`, { method: 'POST', headers: { Authorization: `Bearer ${this.token}` } });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) return;
      if (btn) {
        btn.classList.toggle('voted', data.voted);
        const count = btn.querySelector('.clip-vote-count');
        if (count) count.textContent = data.votes;
      }
    } catch { /* silent */ }
  },

  async _deleteClip(id) {
    if (!confirm(t('clips.confirm_delete') || 'Delete this clip? This cannot be undone.')) return;
    try {
      const res = await fetch(`/api/clips/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${this.token}` } });
      if (!res.ok) { const d = await res.json().catch(() => ({})); this._showToast(d.error || (t('clips.delete_failed') || 'Delete failed'), 'error'); return; }
      const card = document.querySelector(`.clip-card[data-clip-id="${id}"]`);
      if (card) card.remove();
      const gallery = document.getElementById('clips-gallery');
      if (gallery && !gallery.querySelector('.clip-card')) this._renderClips([]);
    } catch (err) {
      this._showToast((err && err.message) || 'Delete failed', 'error');
    }
  },
};

export default ClipMethods;
