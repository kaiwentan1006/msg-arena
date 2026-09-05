// ═══════════════════════════════════════════════════════════
// MSG Arena — Tournaments & ladders (client)
// A list of tournaments; open one to see its bracket (single elimination) or
// standings (ELO ladder) and report/confirm results. Results are two-party
// confirmed on the server. Methods prefixed _t* to avoid prototype collisions.
// ═══════════════════════════════════════════════════════════

const TournamentMethods = {
  _setupTournaments() {
    this._tourneys = new Map();     // id → summary
    this._tourneyView = 'list';     // 'list' | 'detail'
    this._tourneyOpenId = null;     // detail being viewed
    this._tourneyDetail = null;     // last detail payload
    this._tourneyGames = [];

    const openBtn = document.getElementById('tourney-btn');
    if (openBtn) openBtn.addEventListener('click', () => this._openTourneyModal());
    const closeBtn = document.getElementById('tourney-close-btn');
    if (closeBtn) closeBtn.addEventListener('click', () => this._closeTourneyModal());
    const overlay = document.getElementById('tourney-modal');
    if (overlay) overlay.addEventListener('click', (e) => { if (e.target === overlay) this._closeTourneyModal(); });

    const body = document.getElementById('tourney-body');
    if (body) {
      body.addEventListener('click', (e) => this._onTourneyClick(e));
      body.addEventListener('submit', (e) => this._onTourneySubmit(e));
    }

    if (this.socket) {
      this.socket.on('tourney:list', (d) => {
        this._tourneys = new Map(((d && d.tournaments) || []).map(x => [x.id, x]));
        if (this._tourneyView === 'list') this._renderTourneyList();
      });
      this.socket.on('tourney:detail', (d) => {
        if (d && d.tournament) { this._tourneyDetail = d.tournament; if (this._tourneyView === 'detail' && this._tourneyOpenId === d.tournament.id) this._renderTourneyDetail(); }
      });
      this.socket.on('tourney:updated', (d) => {
        if (!d || !d.tournament) return;
        const tt = d.tournament;
        this._tourneys.set(tt.id, { id: tt.id, name: tt.name, game: tt.game, format: tt.format, status: tt.status, participants: (tt.participants || []).length, maxParticipants: tt.maxParticipants, championId: tt.championId, championName: tt.championName });
        if (this._tourneyView === 'detail' && this._tourneyOpenId === tt.id) { this._tourneyDetail = tt; this._renderTourneyDetail(); }
        else if (this._tourneyView === 'list') this._renderTourneyList();
      });
      this.socket.on('tourney:removed', (d) => {
        if (!d) return; this._tourneys.delete(d.id);
        if (this._tourneyOpenId === d.id) { this._tourneyView = 'list'; this._tourneyOpenId = null; }
        this._renderTourneyList();
      });
      this.socket.on('tourney:error', (d) => this._showToast((d && d.message) || 'Tournament error', 'error'));
      this.socket.on('lfg:games', (d) => { this._tourneyGames = (d && d.games) || []; });
    }
  },

  _openTourneyModal() {
    const m = document.getElementById('tourney-modal');
    if (!m) return;
    m.style.display = 'flex';
    this._tourneyView = 'list';
    this._tourneyOpenId = null;
    if (this.socket && this.socket.connected) { this.socket.emit('tourney:list'); this.socket.emit('lfg:games'); }
    if ((!this._tourneyGames || !this._tourneyGames.length) && Array.isArray(this._lfgGames)) this._tourneyGames = this._lfgGames;
    this._renderTourneyList();
  },

  _closeTourneyModal() {
    const m = document.getElementById('tourney-modal');
    if (m) m.style.display = 'none';
  },

  _tCanManage() { return this._hasPerm && this._hasPerm('manage_tournaments'); },

  _tFormatLabel(fmt) {
    if (fmt === 'ladder') return '📊 ' + (t('tourney.ladder') || 'ELO ladder');
    if (fmt === 'double_elim') return '⚔️ ' + (t('tourney.double_elim') || 'Double elim');
    return '⚔️ ' + (t('tourney.bracket') || 'Bracket');
  },

  // ── List view ───────────────────────────────────────────
  _renderTourneyList() {
    const body = document.getElementById('tourney-body');
    if (!body) return;
    const list = [...this._tourneys.values()];
    const statusPill = (s) => `<span class="t-status t-status-${s}">${this._escapeHtml(t('tourney.status_' + s) || s)}</span>`;
    const rows = list.map(x => `
      <div class="t-card" data-tact="open" data-id="${x.id}" role="button" tabindex="0">
        <div class="t-card-main">
          <span class="t-card-name">${this._escapeHtml(x.name)}</span>
          <span class="t-card-sub">
            ${x.game ? `<span class="t-chip">${x.game.icon ? this._escapeHtml(x.game.icon) + ' ' : ''}${this._escapeHtml(x.game.name)}</span>` : ''}
            <span class="t-chip">${this._tFormatLabel(x.format)}</span>
            <span class="t-chip">👥 ${x.participants}${x.maxParticipants ? '/' + x.maxParticipants : ''}</span>
          </span>
        </div>
        <div class="t-card-right">
          ${x.status === 'complete' && x.championName ? `<span class="t-champ">🏆 ${this._escapeHtml(x.championName)}</span>` : statusPill(x.status)}
        </div>
      </div>`).join('');
    body.innerHTML = `
      <div class="t-list-header">
        <span data-i18n="tourney.all">Tournaments</span>
        ${this._tCanManage() ? `<button class="btn-accent btn-sm" data-tact="new">${this._escapeHtml(t('tourney.new_btn') || 'New tournament')}</button>` : ''}
      </div>
      ${this._tCanManage() ? this._tourneyCreateFormHtml() : ''}
      <div class="t-list">${rows || `<div class="t-empty">${this._escapeHtml(t('tourney.empty') || 'No tournaments yet.')}</div>`}</div>`;
  },

  _tourneyCreateFormHtml() {
    const games = (this._tourneyGames || []).map(g => `<option value="${g.id}">${g.icon ? this._escapeHtml(g.icon) + ' ' : ''}${this._escapeHtml(g.name)}</option>`).join('');
    return `
      <form id="tourney-create-form" class="t-create" style="display:none">
        <input id="t-name" class="t-input" maxlength="80" placeholder="${this._escapeHtml(t('tourney.name_placeholder') || 'Tournament name')}" required>
        <select id="t-game" class="t-input"><option value="">${this._escapeHtml(t('tourney.no_game') || 'No game')}</option>${games}</select>
        <select id="t-format" class="t-input">
          <option value="single_elim">${this._escapeHtml(t('tourney.single_elim') || 'Single elimination')}</option>
          <option value="double_elim">${this._escapeHtml(t('tourney.double_elim') || 'Double elimination')}</option>
          <option value="ladder">${this._escapeHtml(t('tourney.ladder') || 'ELO ladder')}</option>
        </select>
        <select id="t-max" class="t-input" aria-label="Max players">
          <option value="4">4</option><option value="8">8</option><option value="16" selected>16</option><option value="32">32</option>
        </select>
        <button type="submit" class="btn-accent">${this._escapeHtml(t('tourney.create_btn') || 'Create')}</button>
      </form>`;
  },

  // ── Detail view ─────────────────────────────────────────
  _openTourneyDetail(id) {
    this._tourneyView = 'detail';
    this._tourneyOpenId = id;
    this._tourneyDetail = null;
    if (this.socket && this.socket.connected) this.socket.emit('tourney:get', { id });
    const body = document.getElementById('tourney-body');
    if (body) body.innerHTML = `<div class="t-empty">${this._escapeHtml(t('tourney.loading') || 'Loading…')}</div>`;
  },

  _renderTourneyDetail() {
    const body = document.getElementById('tourney-body');
    const tt = this._tourneyDetail;
    if (!body || !tt) return;
    const mine = this.user && this.user.id;
    const isParticipant = (tt.participants || []).some(p => p.id === mine);
    const isOwnerOrMgr = this._tCanManage() || tt.createdBy === mine;

    let actions = '';
    if (tt.status === 'open') {
      actions += isParticipant
        ? `<button class="btn-sm" data-tact="leave" data-id="${tt.id}">${this._escapeHtml(t('tourney.leave') || 'Leave')}</button>`
        : `<button class="btn-accent btn-sm" data-tact="join" data-id="${tt.id}">${this._escapeHtml(t('tourney.join') || 'Join')}</button>`;
      if (isOwnerOrMgr) actions += `<button class="btn-accent btn-sm" data-tact="start" data-id="${tt.id}">${this._escapeHtml(t('tourney.start') || 'Start')}</button>`;
    }
    if (isOwnerOrMgr) actions += `<button class="btn-sm btn-danger" data-tact="delete" data-id="${tt.id}">${this._escapeHtml(t('tourney.delete') || 'Delete')}</button>`;

    const champ = tt.status === 'complete' && tt.championName
      ? `<div class="t-champ-banner">🏆 ${this._escapeHtml(t('tourney.champion') || 'Champion')}: <strong>${this._escapeHtml(tt.championName)}</strong></div>` : '';

    const main = tt.format === 'ladder' ? this._renderLadder(tt) : this._renderBracket(tt);

    body.innerHTML = `
      <div class="t-detail-head">
        <button class="btn-sm" data-tact="back">← ${this._escapeHtml(t('tourney.back') || 'Back')}</button>
        <div class="t-detail-title">
          <span class="t-card-name">${this._escapeHtml(tt.name)}</span>
          <span class="t-card-sub">
            ${tt.game ? `<span class="t-chip">${tt.game.icon ? this._escapeHtml(tt.game.icon) + ' ' : ''}${this._escapeHtml(tt.game.name)}</span>` : ''}
            <span class="t-chip">${this._tFormatLabel(tt.format)}</span>
            <span class="t-status t-status-${tt.status}">${this._escapeHtml(t('tourney.status_' + tt.status) || tt.status)}</span>
          </span>
        </div>
        <div class="t-detail-actions">${actions}</div>
      </div>
      ${champ}
      ${main}`;
  },

  _tMatchActions(tt, m) {
    const mine = this.user && this.user.id;
    const canMgr = this._tCanManage();
    const iAmA = m.aId === mine, iAmB = m.bId === mine;
    const involved = iAmA || iAmB;
    if (m.status === 'confirmed') return '';
    if (!m.aId || !m.bId) return `<span class="t-pending-note">${this._escapeHtml(t('tourney.awaiting_players') || 'awaiting players')}</span>`;
    if (m.status === 'reported') {
      const canConfirm = (involved && m.reportedBy !== mine) || canMgr;
      const who = m.reportedWinner ? (m.reportedWinner === m.aId ? m.aName : m.bName) : (t('tourney.a_draw') || 'a draw');
      return `<span class="t-reported">${this._escapeHtml(t('tourney.reported') || 'Reported')}: ${this._escapeHtml(who)}</span>
        ${canConfirm ? `<button class="btn-accent btn-xs" data-tact="confirm" data-mid="${m.id}">${this._escapeHtml(t('tourney.confirm') || 'Confirm')}</button>
        <button class="btn-xs" data-tact="dispute" data-mid="${m.id}">${this._escapeHtml(t('tourney.dispute') || 'Dispute')}</button>` : ''}`;
    }
    // pending, ready
    if (involved || canMgr) {
      return `<button class="btn-xs" data-tact="report" data-mid="${m.id}" data-win="${m.aId}">${this._escapeHtml(t('tourney.a_won', { name: m.aName }) || (m.aName + ' won'))}</button>
        <button class="btn-xs" data-tact="report" data-mid="${m.id}" data-win="${m.bId}">${this._escapeHtml(t('tourney.a_won', { name: m.bName }) || (m.bName + ' won'))}</button>`;
    }
    return '';
  },

  _renderBracket(tt) {
    const matches = tt.matches || [];
    if (!matches.length) {
      // Show the seed list before it starts.
      const seeds = (tt.participants || []).map((p, i) => `<li>${i + 1}. ${this._escapeHtml(p.name)}</li>`).join('');
      return `<div class="t-seeds"><h4>${this._escapeHtml(t('tourney.participants') || 'Participants')}</h4><ol>${seeds || `<li class="t-empty">${this._escapeHtml(t('tourney.no_players') || 'No one has joined yet.')}</li>`}</ol></div>`;
    }

    if (tt.format === 'double_elim') {
      const wb = matches.filter(m => m.seg === 'W');
      const lb = matches.filter(m => m.seg === 'L');
      const gf = matches.filter(m => m.seg === 'GF');
      const genericName = (r, i) => (t('tourney.round') || 'Round') + ' ' + (i + 1);
      const gfName = (r, i) => i === 0 ? (t('tourney.grand_final') || 'Grand Final') : (t('tourney.reset') || 'Reset');
      const section = (title, ms, nameFn) => ms.length
        ? `<div class="t-de-section"><div class="t-de-title">${this._escapeHtml(title)}</div>${this._renderRoundColumns(tt, ms, nameFn)}</div>` : '';
      return section(t('tourney.winners') || 'Winners bracket', wb, genericName)
        + section(t('tourney.losers') || 'Losers bracket', lb, genericName)
        + section(t('tourney.grand_final') || 'Grand Final', gf, gfName);
    }

    // Single elimination — name rounds from the end (Final / Semis / Quarters).
    const numRounds = tt.numRounds || Math.max(...matches.map(m => m.round)) + 1;
    const roundName = (r) => {
      const fromEnd = numRounds - r;
      if (fromEnd === 1) return t('tourney.final') || 'Final';
      if (fromEnd === 2) return t('tourney.semis') || 'Semifinals';
      if (fromEnd === 3) return t('tourney.quarters') || 'Quarterfinals';
      return (t('tourney.round') || 'Round') + ' ' + (r + 1);
    };
    return this._renderRoundColumns(tt, matches, roundName);
  },

  // Render a set of matches as columns grouped by round. `nameFn(round, index)`
  // labels each column.
  _renderRoundColumns(tt, matches, nameFn) {
    const rounds = {};
    for (const m of matches) { (rounds[m.round] = rounds[m.round] || []).push(m); }
    const keys = Object.keys(rounds).map(Number).sort((a, b) => a - b);
    const cols = keys.map((r, i) => {
      const cells = rounds[r].map(m => {
        const aWin = m.winnerId && m.winnerId === m.aId;
        const bWin = m.winnerId && m.winnerId === m.bId;
        return `<div class="t-match">
          <div class="t-slot ${aWin ? 'win' : (m.winnerId ? 'lose' : '')}">${this._escapeHtml(m.aName || '—')}</div>
          <div class="t-slot ${bWin ? 'win' : (m.winnerId ? 'lose' : '')}">${this._escapeHtml(m.bName || '—')}</div>
          <div class="t-match-actions">${this._tMatchActions(tt, m)}</div>
        </div>`;
      }).join('');
      return `<div class="t-round"><div class="t-round-name">${this._escapeHtml(nameFn(r, i))}</div>${cells}</div>`;
    }).join('');
    return `<div class="t-bracket-scroll"><div class="t-bracket">${cols}</div></div>`;
  },

  _renderLadder(tt) {
    const mine = this.user && this.user.id;
    const parts = tt.participants || [];
    const rows = parts.map((p, i) => `
      <tr>
        <td class="t-rank">${i + 1}</td>
        <td>${this._escapeHtml(p.name)}${p.id === mine ? ' <span class="t-you">(you)</span>' : ''}</td>
        <td class="t-rating">${p.rating}</td>
        <td>${p.wins}</td><td>${p.losses}</td><td>${p.draws}</td>
      </tr>`).join('');
    const standings = `
      <table class="t-standings">
        <thead><tr>
          <th>#</th><th>${this._escapeHtml(t('tourney.player') || 'Player')}</th>
          <th>${this._escapeHtml(t('tourney.rating') || 'Rating')}</th><th>W</th><th>L</th><th>D</th>
        </tr></thead>
        <tbody>${rows || `<tr><td colspan="6" class="t-empty">${this._escapeHtml(t('tourney.no_players') || 'No one has joined yet.')}</td></tr>`}</tbody>
      </table>`;

    // Pending confirmations for me.
    const pending = (tt.matches || []).filter(m => m.status === 'reported' && (m.aId === mine || m.bId === mine) && m.reportedBy !== mine);
    const pendingHtml = pending.map(m => {
      const who = m.reportedWinner ? (m.reportedWinner === m.aId ? m.aName : m.bName) : (t('tourney.a_draw') || 'a draw');
      const opp = m.aId === mine ? m.bName : m.aName;
      return `<div class="t-pending-row"><span>${this._escapeHtml(opp)} → ${this._escapeHtml(t('tourney.reported') || 'Reported')}: <strong>${this._escapeHtml(who)}</strong></span>
        <span><button class="btn-accent btn-xs" data-tact="confirm" data-mid="${m.id}">${this._escapeHtml(t('tourney.confirm') || 'Confirm')}</button>
        <button class="btn-xs" data-tact="dispute" data-mid="${m.id}">${this._escapeHtml(t('tourney.dispute') || 'Dispute')}</button></span></div>`;
    }).join('');

    // Report form (only if live and I'm a participant).
    const isParticipant = parts.some(p => p.id === mine);
    let reportForm = '';
    if (tt.status === 'live' && isParticipant) {
      const opps = parts.filter(p => p.id !== mine).map(p => `<option value="${p.id}">${this._escapeHtml(p.name)}</option>`).join('');
      if (opps) reportForm = `
        <form class="t-ladder-report" data-id="${tt.id}">
          <span class="t-report-label">${this._escapeHtml(t('tourney.report_result') || 'Report a result')}:</span>
          <select class="t-input t-opp" aria-label="Opponent">${opps}</select>
          <select class="t-input t-outcome" aria-label="Outcome">
            <option value="win">${this._escapeHtml(t('tourney.i_won') || 'I won')}</option>
            <option value="loss">${this._escapeHtml(t('tourney.i_lost') || 'I lost')}</option>
            <option value="draw">${this._escapeHtml(t('tourney.draw') || 'Draw')}</option>
          </select>
          <button type="submit" class="btn-accent btn-sm">${this._escapeHtml(t('tourney.submit') || 'Submit')}</button>
        </form>`;
    }

    return `${standings}${pendingHtml ? `<div class="t-pending"><h4>${this._escapeHtml(t('tourney.to_confirm') || 'Awaiting your confirmation')}</h4>${pendingHtml}</div>` : ''}${reportForm}`;
  },

  // ── Event delegation ────────────────────────────────────
  _onTourneyClick(e) {
    const btn = e.target.closest('[data-tact]');
    if (!btn) return;
    const act = btn.dataset.tact;
    const id = btn.dataset.id ? parseInt(btn.dataset.id, 10) : this._tourneyOpenId;
    const mid = btn.dataset.mid ? parseInt(btn.dataset.mid, 10) : null;
    const s = this.socket;
    switch (act) {
      case 'open': this._openTourneyDetail(parseInt(btn.dataset.id, 10)); break;
      case 'back': this._tourneyView = 'list'; this._tourneyOpenId = null; this._renderTourneyList(); if (s) s.emit('tourney:list'); break;
      case 'new': { const f = document.getElementById('tourney-create-form'); if (f) f.style.display = f.style.display === 'none' ? 'flex' : 'none'; break; }
      case 'join': s && s.emit('tourney:join', { id }); break;
      case 'leave': s && s.emit('tourney:leave', { id }); break;
      case 'start': s && s.emit('tourney:start', { id }); break;
      case 'delete': if (confirm(t('tourney.confirm_delete') || 'Delete this tournament?')) s && s.emit('tourney:delete', { id }); break;
      case 'report': s && s.emit('tourney:report', { matchId: mid, winnerId: parseInt(btn.dataset.win, 10) }); break;
      case 'confirm': s && s.emit('tourney:confirm', { matchId: mid }); break;
      case 'dispute': s && s.emit('tourney:dispute', { matchId: mid }); break;
    }
  },

  _onTourneySubmit(e) {
    const s = this.socket;
    if (e.target.id === 'tourney-create-form') {
      e.preventDefault();
      const name = (document.getElementById('t-name').value || '').trim();
      if (!name) return;
      const gameId = parseInt(document.getElementById('t-game').value, 10);
      const format = document.getElementById('t-format').value;
      const maxParticipants = parseInt(document.getElementById('t-max').value, 10);
      s && s.emit('tourney:create', { name, gameId: Number.isInteger(gameId) ? gameId : undefined, format, maxParticipants });
      e.target.reset(); e.target.style.display = 'none';
    } else if (e.target.classList.contains('t-ladder-report')) {
      e.preventDefault();
      const id = parseInt(e.target.dataset.id, 10);
      const opponentId = parseInt(e.target.querySelector('.t-opp').value, 10);
      const outcome = e.target.querySelector('.t-outcome').value;
      const mine = this.user && this.user.id;
      const payload = { id, opponentId };
      if (outcome === 'win') payload.winnerId = mine;
      else if (outcome === 'loss') payload.winnerId = opponentId;
      else payload.winnerId = null; // draw
      s && s.emit('tourney:ladder-report', payload);
    }
  },
};

export default TournamentMethods;
