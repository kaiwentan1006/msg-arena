// ═══════════════════════════════════════════════════════════
// MSG Arena — Player Discovery hub (client)
//   • Find Players — search members by game + country + language + online.
//   • My Games — the games you play (with per-game rank) + your gamer profile
//     (country + languages) that powers the search.
// Methods prefixed _games* to avoid prototype collisions.
// ═══════════════════════════════════════════════════════════

// Compact facet lists (kept short on purpose — clean, filterable options).
const GAMES_COUNTRIES = [
  ['US','United States','🇺🇸'],['GB','United Kingdom','🇬🇧'],['DE','Germany','🇩🇪'],['FR','France','🇫🇷'],
  ['ES','Spain','🇪🇸'],['IT','Italy','🇮🇹'],['PL','Poland','🇵🇱'],['NL','Netherlands','🇳🇱'],
  ['SE','Sweden','🇸🇪'],['NO','Norway','🇳🇴'],['FI','Finland','🇫🇮'],['DK','Denmark','🇩🇰'],
  ['PT','Portugal','🇵🇹'],['TR','Turkey','🇹🇷'],['RU','Russia','🇷🇺'],['UA','Ukraine','🇺🇦'],
  ['CA','Canada','🇨🇦'],['BR','Brazil','🇧🇷'],['MX','Mexico','🇲🇽'],['AR','Argentina','🇦🇷'],
  ['AU','Australia','🇦🇺'],['NZ','New Zealand','🇳🇿'],['JP','Japan','🇯🇵'],['KR','South Korea','🇰🇷'],
  ['CN','China','🇨🇳'],['IN','India','🇮🇳'],['ID','Indonesia','🇮🇩'],['PH','Philippines','🇵🇭'],
  ['SG','Singapore','🇸🇬'],['SA','Saudi Arabia','🇸🇦'],['ZA','South Africa','🇿🇦'],['OT','Other','🌍'],
];
const GAMES_LANGS = [
  ['en','English'],['de','German'],['fr','French'],['es','Spanish'],['pt','Portuguese'],['it','Italian'],
  ['pl','Polish'],['nl','Dutch'],['sv','Swedish'],['tr','Turkish'],['ru','Russian'],['uk','Ukrainian'],
  ['ar','Arabic'],['ja','Japanese'],['ko','Korean'],['zh','Chinese'],['hi','Hindi'],['id','Indonesian'],
];

const GamesMethods = {
  _setupGames() {
    this._gamesCatalogue = [];
    this._myGamesSet = new Set();
    this._myGamesRanks = {};
    this._gameCounts = {};
    this._myProfile = { country: '', languages: [] };
    this._gamesView = 'find';
    this._gamesSearchResults = null;

    const openBtn = document.getElementById('games-btn');
    if (openBtn) openBtn.addEventListener('click', () => this._openGamesModal());
    const closeBtn = document.getElementById('games-close-btn');
    if (closeBtn) closeBtn.addEventListener('click', () => this._closeGamesModal());
    const overlay = document.getElementById('games-modal');
    if (overlay) overlay.addEventListener('click', (e) => { if (e.target === overlay) this._closeGamesModal(); });

    if (this.socket) {
      this.socket.on('games:catalogue', (d) => {
        this._gamesCatalogue = (d && d.games) || [];
        if (this._gamesView === 'find') this._renderGamesFind();
        else this._renderGamesMine();
      });
      this.socket.on('games:mine', (d) => {
        if (!d || d.userId !== this.user.id) return;
        this._myGamesSet = new Set((d.games || []).map(g => g.id));
        this._myGamesRanks = {}; (d.games || []).forEach(g => { if (g.rank) this._myGamesRanks[g.id] = g.rank; });
        if (d.profile) this._myProfile = { country: d.profile.country || '', languages: d.profile.languages || [] };
        if (this._gamesView === 'mine') this._renderGamesMine();
      });
      this.socket.on('games:counts', (d) => {
        this._gameCounts = {}; for (const r of (d && d.counts) || []) this._gameCounts[r.gameId] = r.players;
        if (this._gamesView === 'mine') this._renderGamesMine();
      });
      this.socket.on('players:search', (d) => { this._gamesSearchResults = (d && d.players) || []; if (this._gamesView === 'find') this._renderGamesResults(); });
      this.socket.on('profile-updated', (d) => { if (!d) return; if ('country' in d) this._myProfile.country = d.country || ''; if ('languages' in d) this._myProfile.languages = (d.languages || '').split(',').filter(Boolean); });
    }
  },

  _gamesT(key, def) { const v = t(key); return (v && v !== key) ? v : def; },
  _flag(code) { const c = GAMES_COUNTRIES.find(x => x[0] === code); return c ? c[2] : ''; },
  _langName(code) { const l = GAMES_LANGS.find(x => x[0] === code); return l ? l[1] : code; },

  _openGamesModal() {
    const m = document.getElementById('games-modal'); if (!m) return;
    m.style.display = 'flex';
    this.socket.emit('games:catalogue');
    this.socket.emit('games:mine', {});
    this.socket.emit('games:counts');
    this._gamesView = 'find';
    this._renderGamesShell();
    this._runGamesSearch();
  },
  _closeGamesModal() { const m = document.getElementById('games-modal'); if (m) m.style.display = 'none'; },

  // Tab shell + the active view.
  _renderGamesShell() {
    const body = document.getElementById('games-body'); if (!body) return;
    const esc = (s) => this._escapeHtml(String(s));
    body.innerHTML =
      `<div class="games-tabs">
        <button class="games-tab${this._gamesView === 'find' ? ' active' : ''}" data-gtab="find">${esc(this._gamesT('games.tab_find', 'Find Players'))}</button>
        <button class="games-tab${this._gamesView === 'mine' ? ' active' : ''}" data-gtab="mine">${esc(this._gamesT('games.tab_mine', 'My Games'))}</button>
      </div>
      <div class="games-view" id="games-view"></div>`;
    body.querySelectorAll('[data-gtab]').forEach(b => b.addEventListener('click', () => {
      this._gamesView = b.dataset.gtab;
      body.querySelectorAll('.games-tab').forEach(x => x.classList.toggle('active', x === b));
      if (this._gamesView === 'find') this._renderGamesFind(); else this._renderGamesMine();
    }));
    if (this._gamesView === 'find') this._renderGamesFind(); else this._renderGamesMine();
  },

  _gameOptions(selectedId) {
    const esc = (s) => this._escapeHtml(String(s));
    return (this._gamesCatalogue || []).map(g =>
      `<option value="${g.id}"${String(selectedId) === String(g.id) ? ' selected' : ''}>${esc((g.icon ? g.icon + ' ' : '') + g.name)}</option>`).join('');
  },

  // ── Find Players (search) ──────────────────────────────
  _renderGamesFind() {
    const view = document.getElementById('games-view'); if (!view) return;
    const esc = (s) => this._escapeHtml(String(s));
    const f = this._gamesFilters || {};
    view.innerHTML =
      `<div class="games-filters">
        <select id="gf-game" class="games-input" aria-label="Game"><option value="">${esc(this._gamesT('games.any_game', 'Any game'))}</option>${this._gameOptions(f.gameId)}</select>
        <select id="gf-country" class="games-input" aria-label="Country"><option value="">${esc(this._gamesT('games.any_country', 'Any country'))}</option>${GAMES_COUNTRIES.map(c => `<option value="${c[0]}"${f.country === c[0] ? ' selected' : ''}>${c[2]} ${esc(c[1])}</option>`).join('')}</select>
        <select id="gf-lang" class="games-input" aria-label="Language"><option value="">${esc(this._gamesT('games.any_language', 'Any language'))}</option>${GAMES_LANGS.map(l => `<option value="${l[0]}"${f.language === l[0] ? ' selected' : ''}>${esc(l[1])}</option>`).join('')}</select>
        <input id="gf-q" class="games-input" maxlength="40" placeholder="${esc(this._gamesT('games.name_ph', 'Name…'))}" value="${esc(f.query || '')}">
        <label class="games-online-toggle"><input type="checkbox" id="gf-online"${f.onlineOnly ? ' checked' : ''}> ${esc(this._gamesT('games.online_only', 'Online only'))}</label>
        <button class="btn-accent games-search-btn" id="gf-search">${esc(this._gamesT('games.search', 'Search'))}</button>
      </div>
      <div class="games-results" id="games-results"></div>`;
    const run = () => this._runGamesSearch();
    view.querySelector('#gf-search').addEventListener('click', run);
    view.querySelector('#gf-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
    ['gf-game', 'gf-country', 'gf-lang', 'gf-online'].forEach(id => view.querySelector('#' + id).addEventListener('change', run));
    this._renderGamesResults();
  },

  _runGamesSearch() {
    const g = document.getElementById('gf-game'); const c = document.getElementById('gf-country');
    const l = document.getElementById('gf-lang'); const q = document.getElementById('gf-q'); const o = document.getElementById('gf-online');
    const filters = {
      gameId: g && g.value ? parseInt(g.value, 10) : null,
      country: c && c.value ? c.value : null,
      language: l && l.value ? l.value : null,
      query: q && q.value ? q.value.trim() : '',
      onlineOnly: !!(o && o.checked),
    };
    this._gamesFilters = filters;
    const req = {};
    if (filters.gameId) req.gameId = filters.gameId;
    if (filters.country) req.country = filters.country;
    if (filters.language) req.language = filters.language;
    if (filters.query) req.query = filters.query;
    if (filters.onlineOnly) req.onlineOnly = true;
    const results = document.getElementById('games-results');
    if (results) results.innerHTML = `<div class="games-loading">${this._escapeHtml(this._gamesT('games.searching', 'Searching…'))}</div>`;
    this.socket.emit('players:search', req);
  },

  _renderGamesResults() {
    const box = document.getElementById('games-results'); if (!box) return;
    const esc = (s) => this._escapeHtml(String(s));
    const players = this._gamesSearchResults;
    if (players == null) { box.innerHTML = ''; return; }
    if (!players.length) { box.innerHTML = `<div class="lb-empty">${esc(this._gamesT('games.no_matches', 'No players match those filters.'))}</div>`; return; }
    box.innerHTML = `<div class="games-count">${players.length} ${esc(this._gamesT('games.players', 'players'))}</div>` + players.map(p => {
      const name = p.displayName || p.username || '?';
      const initial = esc(name.charAt(0).toUpperCase());
      const av = p.avatar
        ? `<img class="gp-avatar" src="${esc(p.avatar)}" alt="">`
        : `<span class="gp-avatar gp-initial" style="background:${this._getUserColor ? this._getUserColor(p.username) : '#3a3f4b'}">${initial}</span>`;
      const flag = p.country ? this._flag(p.country) : '';
      const langs = (p.languages ? String(p.languages).split(',').filter(Boolean) : []).map(x => x.toUpperCase()).join(' · ');
      const games = (p.games || []).slice(0, 4).map(gm =>
        `<span class="gp-game" title="${esc(gm.name)}${gm.rank ? ' — ' + esc(gm.rank) : ''}">${esc(gm.icon || '🎮')} ${esc(gm.name)}${gm.rank ? ` <b>${esc(gm.rank)}</b>` : ''}</span>`).join('');
      const meta = [flag ? `${flag} ${esc(p.country)}` : '', langs].filter(Boolean).join(' &nbsp;·&nbsp; ');
      return `<div class="gp-card" data-uid="${p.userId}">
        <div class="gp-card-head"><span class="gp-dot${p.online ? ' on' : ''}"></span>${av}<span class="gp-name">${esc(name)}</span></div>
        ${meta ? `<div class="gp-meta">${meta}</div>` : ''}
        ${games ? `<div class="gp-games">${games}</div>` : ''}
      </div>`;
    }).join('');
    box.querySelectorAll('.gp-card').forEach(el => el.addEventListener('click', () => {
      const uid = parseInt(el.dataset.uid, 10);
      if (uid) this.socket.emit('get-user-profile', { userId: uid });
    }));
  },

  // ── My Games + gamer profile ───────────────────────────
  _renderGamesMine() {
    const view = document.getElementById('games-view'); if (!view) return;
    const esc = (s) => this._escapeHtml(String(s));
    const mine = this._myGamesSet || new Set();
    const counts = this._gameCounts || {};
    const prof = this._myProfile || { country: '', languages: [] };
    const sorted = [...(this._gamesCatalogue || [])].sort((a, b) =>
      (mine.has(b.id) - mine.has(a.id)) || ((counts[b.id] || 0) - (counts[a.id] || 0)) || String(a.name).localeCompare(String(b.name)));

    const profileEditor =
      `<div class="games-profile">
        <div class="games-profile-title">${esc(this._gamesT('games.profile_title', 'Your gamer profile'))}</div>
        <div class="games-profile-row">
          <label>${esc(this._gamesT('games.country', 'Country'))}
            <select id="gp-country" class="games-input"><option value="">${esc(this._gamesT('games.not_set', 'Not set'))}</option>${GAMES_COUNTRIES.map(c => `<option value="${c[0]}"${prof.country === c[0] ? ' selected' : ''}>${c[2]} ${esc(c[1])}</option>`).join('')}</select>
          </label>
        </div>
        <div class="games-profile-row">
          <span class="games-profile-label">${esc(this._gamesT('games.languages', 'Languages'))}</span>
          <div class="games-lang-picks">${GAMES_LANGS.map(l => `<label class="games-lang-chip${prof.languages.includes(l[0]) ? ' on' : ''}"><input type="checkbox" data-lang="${l[0]}"${prof.languages.includes(l[0]) ? ' checked' : ''}> ${esc(l[1])}</label>`).join('')}</div>
        </div>
      </div>`;

    const gamesGrid =
      `<div class="games-hint">${esc(this._gamesT('games.hint', 'Star the games you play and set your rank, so others can find you.'))}</div>
       <div class="games-grid">${sorted.map(g => {
        const on = mine.has(g.id);
        return `<div class="game-row${on ? ' mine' : ''}" data-game-id="${g.id}">
          <span class="game-row-icon">${esc(g.icon || '🎮')}</span>
          <span class="game-row-name">${esc(g.name)}</span>
          ${on ? `<input class="game-rank-input" data-rank="${g.id}" maxlength="40" placeholder="${esc(this._gamesT('games.rank_ph', 'Rank…'))}" value="${esc(this._myGamesRanks[g.id] || '')}">` : `<span class="game-row-count">${counts[g.id] ? '👥 ' + counts[g.id] : ''}</span>`}
          <button class="game-star${on ? ' on' : ''}" data-star="${g.id}" title="${on ? esc(this._gamesT('games.remove', 'Remove')) : esc(this._gamesT('games.add', 'Add'))}" aria-pressed="${on ? 'true' : 'false'}">${on ? '★' : '☆'}</button>
        </div>`;
      }).join('') || `<div class="lb-empty">${esc(this._gamesT('games.empty', 'No games in the catalogue yet.'))}</div>`}</div>`;

    view.innerHTML = profileEditor + gamesGrid;

    // Profile: country
    const cSel = view.querySelector('#gp-country');
    if (cSel) cSel.addEventListener('change', () => { this._myProfile.country = cSel.value; this.socket.emit('set-country', { country: cSel.value }); });
    // Profile: languages
    view.querySelectorAll('[data-lang]').forEach(cb => cb.addEventListener('change', () => {
      const picks = [...view.querySelectorAll('[data-lang]:checked')].map(x => x.getAttribute('data-lang'));
      this._myProfile.languages = picks;
      cb.closest('.games-lang-chip').classList.toggle('on', cb.checked);
      this.socket.emit('set-languages', { languages: picks });
    }));
    // Star add/remove
    view.querySelectorAll('[data-star]').forEach(btn => btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = parseInt(btn.dataset.star, 10);
      if ((this._myGamesSet || new Set()).has(id)) this.socket.emit('games:remove', { gameId: id });
      else this.socket.emit('games:add', { gameId: id });
      this.socket.emit('games:counts');
    }));
    // Per-game rank (save on change/blur)
    view.querySelectorAll('[data-rank]').forEach(inp => {
      const save = () => { const id = parseInt(inp.dataset.rank, 10); this._myGamesRanks[id] = inp.value.trim(); this.socket.emit('games:set-rank', { gameId: id, rank: inp.value.trim() }); };
      inp.addEventListener('change', save);
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { save(); inp.blur(); } });
      inp.addEventListener('click', (e) => e.stopPropagation());
    });
  },
};

export default GamesMethods;
