// ═══════════════════════════════════════════════════════════
// MSG Arena — Leaderboards hub (client)
// Server-wide competitive rankings: tournament titles, top clip creators, ELO
// ladders and arcade high scores. Read-only. Methods prefixed _lb*.
// ═══════════════════════════════════════════════════════════

const LeaderboardMethods = {
  _setupLeaderboards() {
    const openBtn = document.getElementById('leaderboards-btn');
    if (openBtn) openBtn.addEventListener('click', () => this._openLeaderboards());
    const closeBtn = document.getElementById('leaderboards-close-btn');
    if (closeBtn) closeBtn.addEventListener('click', () => this._closeLeaderboards());
    const overlay = document.getElementById('leaderboards-modal');
    if (overlay) overlay.addEventListener('click', (e) => { if (e.target === overlay) this._closeLeaderboards(); });
    if (this.socket) this.socket.on('leaderboards', (data) => this._renderLeaderboards(data));
  },

  _openLeaderboards() {
    const m = document.getElementById('leaderboards-modal');
    if (!m) return;
    m.style.display = 'flex';
    const body = document.getElementById('leaderboards-body');
    if (body) body.innerHTML = `<div class="lb-empty">${this._escapeHtml(this._lbT('leaderboards.loading', 'Loading…'))}</div>`;
    if (this.socket && this.socket.connected) this.socket.emit('get-leaderboards', {});
  },

  _closeLeaderboards() {
    const m = document.getElementById('leaderboards-modal');
    if (m) m.style.display = 'none';
  },

  _lbT(key, def) { const v = t(key); return (v && v !== key) ? v : def; },
  _lbPretty(slug) { return String(slug || '').replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()); },

  _renderLeaderboards(data) {
    const body = document.getElementById('leaderboards-body');
    if (!body || !data) return;
    const esc = (s) => this._escapeHtml(String(s));
    const rows = (arr, fmt) => arr.map((e, i) => `
      <div class="lb-row${i < 3 ? ' lb-top' + (i + 1) : ''}">
        <span class="lb-rank">${e.rank || i + 1}</span>
        <span class="lb-name">${esc(e.name)}</span>
        <span class="lb-val">${fmt(e)}</span>
      </div>`).join('');

    const sections = [];

    if (data.levels && data.levels.length) {
      sections.push(`<div class="lb-card"><h4>⭐ ${esc(this._lbT('leaderboards.levels', 'Top levels'))}</h4>
        ${rows(data.levels, e => `${esc(this._lbT('leaderboards.level', 'Lvl'))} ${e.level} · ${e.xp} XP`)}</div>`);
    }

    if (data.titles && data.titles.length) {
      sections.push(`<div class="lb-card"><h4>🏆 ${esc(this._lbT('leaderboards.champions', 'Champions'))}</h4>
        ${rows(data.titles, e => `${e.count} ${esc(e.count === 1 ? this._lbT('leaderboards.title_one', 'title') : this._lbT('leaderboards.titles', 'titles'))}`)}</div>`);
    }
    if (data.clips && data.clips.length) {
      sections.push(`<div class="lb-card"><h4>🎬 ${esc(this._lbT('leaderboards.top_clips', 'Top clip creators'))}</h4>
        ${rows(data.clips, e => `▲ ${e.votes} · ${e.clips} ${esc(this._lbT('leaderboards.clips', 'clips'))}`)}</div>`);
    }
    for (const l of (data.ladders || [])) {
      sections.push(`<div class="lb-card"><h4>📊 ${esc(l.name)}</h4>
        ${rows(l.top, e => `${e.rating} ELO`)}</div>`);
    }
    for (const b of (data.arcade || [])) {
      sections.push(`<div class="lb-card"><h4>🕹️ ${esc(this._lbPretty(b.game))}</h4>
        ${rows(b.top, e => `${e.score}`)}</div>`);
    }

    body.innerHTML = sections.length
      ? `<div class="lb-grid">${sections.join('')}</div>`
      : `<div class="lb-empty">${esc(this._lbT('leaderboards.empty', 'No rankings yet — play some games!'))}</div>`;
  },
};

export default LeaderboardMethods;
