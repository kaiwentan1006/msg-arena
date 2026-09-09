'use strict';

/**
 * MSG Arena — rank reward cosmetics.
 *
 * Cosmetics a player UNLOCKS by leveling up (the activity/leveling system in
 * xpService already gives everyone a level). This is the competitive-spirit
 * carrot: profile banners, then gradient banners, then animated ones, plus
 * name effects at higher ranks. Server-authoritative: a client can only apply a
 * cosmetic once its level clears the threshold — the whole point is that they're
 * earned, so the check can't live on the client.
 *
 * The catalog here (ids + minLevel) is mirrored on the client for rendering;
 * only the thresholds below are trusted. Banners/effects are pure CSS presets
 * (no uploads), so nothing here touches the filesystem or needs sanitising
 * beyond "is this a known id the user has earned".
 */

// type is informational; the client maps id -> CSS.
const BANNERS = [
  { id: 'default',       type: 'solid',    minLevel: 0 },
  { id: 'solid-slate',   type: 'solid',    minLevel: 0 },
  { id: 'solid-cyan',    type: 'solid',    minLevel: 0 },
  { id: 'solid-crimson', type: 'solid',    minLevel: 0 },
  { id: 'solid-violet',  type: 'solid',    minLevel: 0 },
  // Gradients unlock at level 5.
  { id: 'grad-aurora',   type: 'gradient', minLevel: 5 },
  { id: 'grad-sunset',   type: 'gradient', minLevel: 5 },
  { id: 'grad-ocean',    type: 'gradient', minLevel: 5 },
  { id: 'grad-ember',    type: 'gradient', minLevel: 5 },
  // Animated ("GIF-like" moving) banners unlock at level 15.
  { id: 'anim-holo',     type: 'animated', minLevel: 15 },
  { id: 'anim-pulse',    type: 'animated', minLevel: 15 },
  { id: 'anim-flow',     type: 'animated', minLevel: 15 },
];

const NAME_EFFECTS = [
  { id: 'none',          minLevel: 0 },
  { id: 'name-gradient', minLevel: 10 },  // gradient display name
  { id: 'name-glow',     minLevel: 20 },  // animated glow
];

const _b = new Map(BANNERS.map(b => [b.id, b]));
const _n = new Map(NAME_EFFECTS.map(n => [n.id, n]));

function bannerAllowed(level, id) {
  const b = _b.get(id);
  return !!b && (Number(level) || 0) >= b.minLevel;
}
function nameEffectAllowed(level, id) {
  const n = _n.get(id);
  return !!n && (Number(level) || 0) >= n.minLevel;
}

module.exports = { BANNERS, NAME_EFFECTS, bannerAllowed, nameEffectAllowed };
