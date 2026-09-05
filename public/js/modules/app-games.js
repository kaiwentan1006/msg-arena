// ═══════════════════════════════════════════════════════════
// MSG Arena — "My Games" + Find Players (client)
// Persistent discovery: mark the games you play, browse who plays what.
// Methods prefixed _games* / _setupGames to avoid prototype collisions.
// ═══════════════════════════════════════════════════════════

const GamesMethods = {
  _setupGames() {
    this._gamesCatalogue = [];
    this._myGamesSet = new Set();
    this._gameCounts = {};
    this._gamesView = 'list';

    const openBtn = document.getElementById('games-btn');
    if (openBtn) openBtn.addEventListener('click', () => this._openGamesModal());
    const closeBtn = document.getElementById('games-close-btn');
    if (closeBtn) closeBtn.addEventListener('click', () => this._closeGamesModal());
    const overlay = document.getElementById('games-modal');
    if (overlay) overlay.addEventListener('click', (e) => { if (e.target === overlay) this._closeGamesModal(); });

    if (this.socket) {
      this.socket.on('games:catalogue', (d) => { this._gamesCatalogue = (d && d.games) || []; if (this._gamesView === 'list') this._renderGamesList(); });
      this.socket.on('games:mine', (d) => {
        if (d && d.userId === this.user.id) { this._myGamesSet = new Set((d.games || []).map(g => g.id)); if (this._gamesView === 'list') this._renderGamesList(); }
      });
      this.socket.on('games:counts', (d) => { this._gameCounts = {}; for (const r of (d && d.counts) || []) this._gameCounts[r.gameId] = r.players; if (this._gamesView === 'list') this._renderGamesList(); });
      this.socket.on('games:players', (d) => this._renderGamePlayers(d));
    }
  },

  _gamesT(key, def) { const v = t(key); return (v && v !== key) ? v : def; },

  _openGamesModal() {
    const m = document.getElementById('games-modal'); if (!m) return;
    m.style.display = 'flex';
    this._gamesView = 'list';
    this.socket.emit('games:catalogue');
    this.socket.emit('games:mine', {});
    this.socket.emit('games:counts');
  },
  _closeGamesModal() { const m = document.getElementById('games-modal'); if (m) m.style.display = 'none'; },

  _renderGamesList() {
    this._gamesView = 'list';
    const body = document.getElementById('games-body'); if (!body) return;
    const esc = (s) => this._escapeHtml(String(s));
    const mine = this._myGamesSet || new Set();
    const counts = this._gameCounts || {};
    const sorted = [...(this._gamesCatalogue || [])].sort((a, b) =>
      (mine.has(b.id) - mine.has(a.id)) || ((counts[b.id] || 0) - (counts[a.id] || 0)) || String(a.name).localeCompare(String(b.name)));
    const hint = `<div class="games-hint">${esc(this._gamesT('games.hint', 'Star the games you play, then tap a game to find other players.'))}</div>`;
    body.innerHTML = hint + `<div class="games-grid">${sorted.map(g => `
      <div class="game-row${mine.has(g.id) ? ' mine' : ''}" data-game-id="${g.id}">
        <span class="game-row-icon">${esc(g.icon || '🎮')}</span>
        <span class="game-row-name">${esc(g.name)}</span>
        <span class="game-row-count">${counts[g.id] ? '👥 ' + counts[g.id] : ''}</span>
        <button class="game-star${mine.has(g.id) ? ' on' : ''}" data-star="${g.id}"
                title="${mine.has(g.id) ? esc(this._gamesT('games.remove', 'Remove from my games')) : esc(this._gamesT('games.add', 'Add to my games'))}"
                aria-pressed="${mine.has(g.id) ? 'true' : 'false'}">${mine.has(g.id) ? '★' : '☆'}</button>
      </div>`).join('') || `<div class="lb-empty">${esc(this._gamesT('games.empty', 'No games in the catalogue yet.'))}</div>`}</div>`;
    body.onclick = (e) => {
      const star = e.target.closest('[data-star]');
      if (star) {
        e.stopPropagation();
        const id = parseInt(star.dataset.star, 10);
        if ((this._myGamesSet || new Set()).has(id)) this.socket.emit('games:remove', { gameId: id });
        else this.socket.emit('games:add', { gameId: id });
        this.socket.emit('games:counts');
        return;
      }
      const row = e.target.closest('[data-game-id]');
      if (row) { this._gamesView = 'players'; this.socket.emit('games:players', { gameId: parseInt(row.dataset.gameId, 10) }); }
    };
  },

  _renderGamePlayers(d) {
    if (!d || !d.game || this._gamesView !== 'players') return;
    const body = document.getElementById('games-body'); if (!body) return;
    const esc = (s) => this._escapeHtml(String(s));
    const players = d.players || [];
    body.innerHTML =
      `<button class="games-back" id="games-back">← ${esc(this._gamesT('games.back', 'All games'))}</button>` +
      `<div class="games-players-head">${esc(d.game.icon || '🎮')} ${esc(d.game.name)} · ${players.length} ${esc(this._gamesT('games.players', 'players'))}</div>` +
      `<div class="games-players">${players.map(p => {
        const online = p.status && p.status !== 'offline' && p.status !== 'invisible';
        const name = p.displayName || p.username || '?';
        const initial = esc(name.charAt(0).toUpperCase());
        const av = p.avatar
          ? `<img class="gp-avatar" src="${esc(p.avatar)}" alt="">`
          : `<span class="gp-avatar gp-initial" style="background:${this._getUserColor ? this._getUserColor(p.username) : '#3a3f4b'}">${initial}</span>`;
        return `<div class="gp-row" data-uid="${p.userId}"><span class="gp-dot${online ? ' on' : ''}"></span>${av}<span class="gp-name">${esc(name)}</span></div>`;
      }).join('') || `<div class="lb-empty">${esc(this._gamesT('games.no_players', 'No one plays this yet — star it to be the first!'))}</div>`}</div>`;
    const back = document.getElementById('games-back');
    if (back) back.onclick = () => this._renderGamesList();
    body.querySelectorAll('.gp-row').forEach(r => r.addEventListener('click', () => {
      const uid = parseInt(r.dataset.uid, 10);
      if (uid) this.socket.emit('get-user-profile', { userId: uid });
    }));
  },
};

export default GamesMethods;
