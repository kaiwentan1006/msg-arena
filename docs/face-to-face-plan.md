# Face-to-Face — plan to make it perfect

MSG Arena is a messenger centered on face-to-face interaction, so the webcam
experience (`.webcam-container` / `.webcam-grid` / `.webcam-tile`, rendered by
`_handleWebcamStream` in `public/js/modules/app-voice.js`) is the product's
centrepiece. This is the state of it and the roadmap to "perfect."

## Done & verified (v4.3.1 base + Tier 1 v4.3.2 + Tier 2 v4.3.3 + Tier 3 v4.3.4 — plan complete)

- **Premium tile design** (theme-aware, `public/css/msg-arena.css`): glassy stage
  with a glowing cyan lip, live pulse dot, rounded tiles with depth and a soft
  placeholder while the camera warms up, hover lift.
- **Floating glass name pills** instead of a tiny centred bar.
- **Circular glass call-controls** (pop-out / fullscreen / minimize / close),
  always reachable on touch; close goes red on hover.
- **Live active-speaker ring** — reads the real mic level (Web Audio
  `AnalyserNode` over the streams `VoiceManager` already holds), lights a glowing
  cyan ring + cyan name pill for whoever is talking. Observes only (no echo),
  self-cleaning, feature-detected.
- **Cinematic focus mode**, reduced-motion + touch handling.

**Verified end-to-end** in a real headless browser with a fake camera/mic: the
tile renders, the video plays (640×480 fake feed), and the speaker ring lights
with the exact accent colour (`rgb(34,211,238)`) when the mic tone plays. Full
server suite 120/120.

## Roadmap to perfect

### Tier 1 — completes the core experience — DONE (v4.3.2) ✓

All four shipped and verified end-to-end (headless, fake camera/mic + injected
second participant; zero console errors) and visually (gallery render):

1. **✓ Camera-off presence tiles.** Today a tile exists only while a camera is on.
   Show a tile for every voice participant — avatar / coloured initial + a
   camera-off glyph — so the grid always answers "who's in the call." Pure
   addition to `_handleWebcamStream` + a `.webcam-tile.cam-off` style.
2. **✓ Per-tile mic-muted badge.** A small mic-off pill (bottom-right) driven by the
   existing mute state, to complement the speaker ring.
3. **✓ Gallery / spotlight layout.** Optional full-area Zoom-style grid (auto 2×2 /
   3×3) when cameras are on, in addition to today's top strip + focus mode. A
   layout the size slider and focus mode already hint at.
4. **✓ Uniform 16:9 framing.** Give tiles a consistent aspect so the grid stays
   tidy regardless of each camera's native resolution (needs care with the size
   slider + focus mode; scoped to normal mode).

### Tier 2 — quality & feedback — DONE (v4.3.3) ✓

All verified end-to-end (headless: mock getStats, seeded talkingState, gallery↔spotlight):

5. **✓ Connection-quality dots** per tile from `RTCPeerConnection.getStats()`
   (packet loss / rtt) so people can see who's lagging.
6. **✓ Active-speaker in the member/voice list**, reusing the same detector, so the
   speaking cue shows even when a tile isn't on screen.
7. **✓ Pin / spotlight a participant** — click to make one person the big view.
8. **✓ Resolution / framerate caps** for low-end devices, plus an "HD" toggle;
   apply as `applyConstraints()` on the outgoing track.

### Tier 3 — accessibility & robustness — DONE (v4.3.4) ✓

Verified headless (aria attributes, overlay show/hide, blur feature-detect + graceful):

9. **✓ Accessibility**: ARIA roles/labels on tiles and controls, keyboard focus
   order, and an opt-in "announce who's speaking" for screen readers.
10. **✓ Reconnecting overlay** on a stalled tile (surface the retry logic that
    already exists in `_handleWebcamStream`).
11. **✓ Virtual background / blur** — shipped as best-effort NATIVE blur via the
    platform `backgroundBlur` MediaTrack constraint (feature-detected; the toggle
    only appears where the OS/browser supports it). No ML model / CDN, so it stays
    within the strict CSP. A full model-based blur for unsupported browsers remains
    an optional future add.

## Constraints to design around
- **Webcam video is P2P mesh** (like voice), so a camera-on room is comfortable
  to ~5–8 people. Large face-to-face rooms need the SFU (`src/voice/sfu.js`)
  extended to forward **video** — today it carries audio only. That is a project
  in its own right, and **the SFU needs a public UDP port, which Railway does not
  provide** (run on a VPS for large video rooms). See
  [voice-sfu.md](voice-sfu.md).
- **No ffmpeg** on the server — anything frame-level (thumbnails, recording)
  stays client-side via `canvas`.

## Suggested order — ALL TIERS COMPLETE
Tier 1 items 1–2 give the biggest jump in "feels finished" for the least risk and
are self-contained. Item 3 (gallery layout) is the marquee upgrade if you want the
call view to feel like a dedicated video app. Everything here layers on the
verified v4.3.1 base without touching the voice engine.
