'use strict';

/**
 * MSG Arena — self-declared game IDs (Riot ID, gamertag, …).
 *
 * These are typed by the user and NOT verified — they're stored as
 * user_connections rows with link_method='self', kept apart from the OAuth /
 * lookup providers (steam/spotify/lastfm) so a self-asserted handle can never
 * render with a "verified" badge. Verified providers (Steam, Spotify, Twitch)
 * come in through connectRoutes.js instead.
 *
 *   gameid:set-handle    { provider, handle }
 *   gameid:remove-handle { provider }
 *   gameid:list          { userId? }          → gameid:list { userId, ids }
 */

// The platforms we let people self-declare, with a friendly label and a light
// format hint. Kept deliberately permissive — these are cosmetic profile tags.
const SELF_PROVIDERS = {
  riot:      { label: 'Riot ID' },
  xbox:      { label: 'Xbox Gamertag' },
  psn:       { label: 'PlayStation Network' },
  epic:      { label: 'Epic Games' },
  battlenet: { label: 'BattleTag' },
  nintendo:  { label: 'Nintendo Friend Code' },
  ea:        { label: 'EA ID' },
  discord:   { label: 'Discord' },
};

const MAX_HANDLE = 40;

module.exports = function register(socket, ctx) {
  const { io, emitOnlineUsers } = ctx;
  const activity = () => ctx.state && ctx.state.activity;

  function sendOwn() {
    const a = activity();
    if (!a) return;
    socket.emit('gameid:list', { userId: socket.user.id, ids: a.getProfileConnections(socket.user.id) });
  }

  socket.on('gameid:set-handle', (data) => {
    const a = activity();
    if (!a || !data || typeof data !== 'object') return;
    if (socket.user.isGuest) return socket.emit('error-msg', 'Guests cannot set game IDs');
    const provider = typeof data.provider === 'string' ? data.provider : '';
    if (!Object.prototype.hasOwnProperty.call(SELF_PROVIDERS, provider)) {
      return socket.emit('error-msg', 'Unknown platform');
    }
    let handle = typeof data.handle === 'string' ? data.handle.trim().slice(0, MAX_HANDLE) : '';
    if (!handle) return socket.emit('error-msg', 'Enter your ' + SELF_PROVIDERS[provider].label);
    // Public, shown on profiles — run it through automod (blocks slurs/links).
    if (ctx.enforceAutomod && ctx.enforceAutomod(handle, { surface: 'profile' })) return;

    if (!a.setSelfHandle(socket.user.id, provider, handle)) {
      return socket.emit('error-msg', 'Could not save that handle');
    }
    sendOwn();
    if (socket.currentChannel) emitOnlineUsers(socket.currentChannel);
    socket.emit('toast', { message: `${SELF_PROVIDERS[provider].label} saved`, type: 'success' });
  });

  socket.on('gameid:remove-handle', (data) => {
    const a = activity();
    if (!a || !data) return;
    const provider = typeof data.provider === 'string' ? data.provider : '';
    if (!Object.prototype.hasOwnProperty.call(SELF_PROVIDERS, provider)) return;
    a.removeConnection(socket.user.id, provider);
    sendOwn();
    if (socket.currentChannel) emitOnlineUsers(socket.currentChannel);
  });

  socket.on('gameid:list', (data) => {
    const a = activity();
    if (!a) return;
    const userId = data && Number.isInteger(data.userId) ? data.userId : socket.user.id;
    socket.emit('gameid:list', { userId, ids: a.getProfileConnections(userId) });
  });
};

module.exports.SELF_PROVIDERS = SELF_PROVIDERS;
