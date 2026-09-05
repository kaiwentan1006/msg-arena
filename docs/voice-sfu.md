# Voice SFU mode (scaling past ~8 people)

MSG Arena voice is **peer-to-peer (P2P mesh)** by default: every person in a call
uploads their microphone to every other person. That is simple, private (media
never touches the server) and works great up to roughly **5–8 people** — past
that, each participant's upload bandwidth and CPU become the bottleneck and audio
degrades for everyone.

**SFU mode** (Selective Forwarding Unit) fixes this. Each person uploads their mic
**once** to the server, and the server forwards it to everyone else. Uplink stays
flat no matter how many people are in the room, so calls scale to far larger
groups.

MSG Arena's SFU runs **inside the existing server process** (built on
[`werift`](https://github.com/shinyoshiaki/werift-webrtc), a pure-JavaScript
WebRTC stack). There is **no separate server to run**, no Docker/Go dependency,
and no extra software for members to install — their browser just makes one
WebRTC connection to your server instead of one to each peer.

## Trade-offs — read before enabling

- **Privacy.** Because media flows through your server, your server can
  technically see/hear the voice data. In P2P mesh mode it cannot. This is why
  SFU mode is **off by default** and must be turned on deliberately.
- **Network.** The server needs its **voice UDP port reachable from the
  internet**, exactly like running a TURN/coturn server for the mesh. On a VPS
  with a public IP this usually works out of the box; behind home NAT you must
  port-forward.
- **v1 scope.** This first version carries **voice audio**. Screen share and
  webcam remain peer-to-peer for now — starting them in an SFU room shows a
  "not available in SFU mode yet" notice rather than half-working.

## Enabling it

1. Go to **Settings → Admin → Privacy/Security → Voice scaling (SFU)** and turn
   on **Enable SFU voice**.
2. Make sure your server's voice UDP is reachable (see below). That's it — new
   voice calls will use the SFU. Leave it off to keep the P2P mesh.

The choice is made per voice room when the first person joins and stays fixed for
that call. (Automatic mesh-for-small-rooms / SFU-for-large-rooms switching mid-call
is planned for a later version.)

## Network / firewall

The SFU gathers WebRTC ICE candidates like any peer. To help it advertise a
reachable address behind NAT it uses your configured STUN servers (`STUN_URLS`,
or sensible public defaults).

By default werift picks an ephemeral UDP port for media. To pin it to a fixed
range you can forward, set in `.env`:

```
# Fixed UDP port range for SFU media (min-max). Forward these on your firewall.
SFU_UDP_PORT_RANGE=50000-50100
```

If voice connects but no audio flows in SFU mode, the media UDP port almost
certainly is not reachable — the same failure mode as a misconfigured TURN
server.

## Verifying it works

With Chrome installed you can certify the whole media path locally — it boots a
throwaway server, joins two fake-mic browsers to a voice call and checks each
receives the other's live audio through the SFU:

```
npm run verify-sfu
```

## How it works (for maintainers)

- `src/voice/sfu.js` — the SFU room manager. One `RTCPeerConnection` per
  participant; the **server is the sole offerer** (clients only answer), so there
  is no renegotiation glare. Each offer carries `sendMids` (the client's own
  publish slots) and `trackMap` (which forwarded track belongs to which user), so
  no SDP munging is needed.
- `src/socketHandlers/voice.js` — decides the provider per room on `voice-join`
  (`sfu_enabled` setting) and relays `sfu-answer` / `sfu-ice` / `sfu-publish`.
- `public/js/voice.js` — the client `VoiceManager` gains an SFU adapter
  (`_setupSfuListeners` / `_sfuHandleOffer` / `_sfuOnTrack`). Mesh code is
  untouched; only the media path forks on `voice-provider-config`.
- Presence, mute, speaking indicators and permissions use the **same** events in
  both modes — only media transport changes.

Tests: `test/sfu.test.js` (in-process SFU forwarding/leave with a werift client
stand-in) and `test/sfuProvider.integration.test.js` (the server's provider
decision + offer over a real socket).
