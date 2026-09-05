'use strict';

/**
 * MSG Arena — in-process SFU (Selective Forwarding Unit) for voice channels.
 *
 * Above the P2P mesh cap (~5-8), each client uploading N-1 copies of its audio
 * is the bottleneck. This SFU makes every client keep ONE RTCPeerConnection to
 * the server: it uploads its media once, and the server forwards each stream to
 * everyone else. Built on `werift` (pure-JS WebRTC), so it runs inside the
 * existing Node process — no extra server, no native build, no browser SDK.
 *
 * Negotiation model — the SFU is the SOLE OFFERER; the browser only ever
 * answers. On any change (a join, a leave, a new published track) the SFU
 * re-offers the affected client with the full current m-line set. One offerer
 * means there is never offer glare, which is the classic SFU renegotiation bug.
 *
 * Each re-offer carries a small signaling map so the deterministic-ID plumbing
 * never relies on SDP munging:
 *   sfu-offer { code, sdp, sendMids, trackMap }
 *     sendMids : { <mid>: kind }              transceivers the CLIENT publishes on
 *     trackMap : { <mid>: { userId, kind } }  remote streams the client receives
 *
 * This module is transport-only. Presence, mute state, speaking indicators and
 * permissions stay on the existing voice socket events; the SFU just moves media.
 */

const { RTCPeerConnection, MediaStreamTrack } = require('werift');

let _pubSeq = 0;
const nextPubKey = () => `p${++_pubSeq}`;

class Participant {
  constructor(userId, pc) {
    this.userId = userId;
    this.pc = pc;
    this.publications = new Map();  // pubKey -> { track, kind }  (media received FROM this client)
    this.seenTracks = new Set();    // track.uuid — werift re-fires onTrack per renegotiation; dedupe
    this.forwards = new Map();      // fwdKey  -> { transceiver, unsub }  (media sent TO this client)
    this.txMeta = new Map();        // transceiver -> { role:'recv'|'forward', kind, ownerId?, pubKey? }
    this.pendingRecvKinds = [];     // kinds this client still needs a publish slot for
    this.negChain = Promise.resolve(); // serialise (re)negotiations for this PC
    this.closed = false;
  }
}

class SFU {
  /**
   * @param {object} opts
   *   sendSignal(userId, event, payload)  — deliver a signaling message to a client
   *   iceServers                          — STUN/TURN list (reuse the mesh's)
   *   icePortRange   [min,max]            — optional UDP port range for media
   */
  constructor(opts = {}) {
    this.rooms = new Map();               // code -> Map(userId -> Participant)
    this.sendSignal = opts.sendSignal || (() => {});
    this.pcConfig = { iceServers: opts.iceServers || [] };
    if (Array.isArray(opts.icePortRange) && opts.icePortRange.length === 2) {
      this.pcConfig.icePortRange = opts.icePortRange;
    }
  }

  _room(code) {
    if (!this.rooms.has(code)) this.rooms.set(code, new Map());
    return this.rooms.get(code);
  }

  roomSize(code) { return this.rooms.get(code)?.size || 0; }
  hasParticipant(code, userId) { return !!this.rooms.get(code)?.has(userId); }

  // ── Join ────────────────────────────────────────────────
  // Creates the client's PC, wires ICE/track handlers, gives them a publish
  // slot for their mic plus forward slots for everyone already talking, then
  // sends the first offer.
  async join(code, userId) {
    const room = this._room(code);
    if (room.has(userId)) await this.leave(code, userId); // clean rejoin

    const pc = new RTCPeerConnection(this.pcConfig);
    const p = new Participant(userId, pc);
    room.set(userId, p);

    pc.onIceCandidate.subscribe((e) => {
      const cand = e && (e.candidate || e);
      if (cand && (cand.candidate !== undefined)) {
        this.sendSignal(userId, 'sfu-ice', { code, candidate: cand });
      }
    });
    pc.onTrack.subscribe((track) => this._onPublished(code, userId, track));

    p.pendingRecvKinds.push('audio'); // every client publishes a mic

    // Forward everyone else's existing publications down to the newcomer.
    for (const [otherId, other] of room) {
      if (otherId === userId) continue;
      for (const [pubKey, pub] of other.publications) {
        this._addForward(p, otherId, pubKey, pub);
      }
    }

    await this._renegotiate(code, userId);
    return p;
  }

  // ── Leave ───────────────────────────────────────────────
  async leave(code, userId) {
    const room = this.rooms.get(code);
    const p = room && room.get(userId);
    if (!p) return;
    p.closed = true;
    room.delete(userId);

    // Stop forwarding this user's media to everyone else, then re-offer them.
    for (const [otherId, other] of room) {
      let changed = false;
      for (const [fwdKey, fwd] of other.forwards) {
        if (fwdKey.startsWith(userId + ':')) {
          try { fwd.unsub && fwd.unsub(); } catch { /* already gone */ }
          other.txMeta.delete(fwd.transceiver);
          other.forwards.delete(fwdKey);
          changed = true;
        }
      }
      if (changed) this._renegotiate(code, otherId).catch(() => {});
    }

    try { p.pc.close(); } catch { /* already closed */ }
    if (room.size === 0) this.rooms.delete(code);
  }

  closeRoom(code) {
    const room = this.rooms.get(code);
    if (!room) return;
    for (const p of room.values()) { p.closed = true; try { p.pc.close(); } catch { /* noop */ } }
    this.rooms.delete(code);
  }

  // ── A client asked to publish another track (screen share, webcam, music) ──
  async requestPublish(code, userId, kind) {
    const p = this.rooms.get(code)?.get(userId);
    if (!p || p.closed) return;
    p.pendingRecvKinds.push(kind === 'video' ? 'video' : 'audio');
    await this._renegotiate(code, userId);
  }

  // ── The client published a track we now receive; fan it out. ─────────────
  _onPublished(code, userId, track) {
    const room = this.rooms.get(code);
    const p = room && room.get(userId);
    if (!p || p.closed) return;
    // werift re-fires onTrack for an existing track on every renegotiation.
    // Without this guard each re-offer would spawn another forward, looping.
    const uuid = track.uuid || track;
    if (p.seenTracks.has(uuid)) return;
    p.seenTracks.add(uuid);
    const pubKey = nextPubKey();
    const kind = track.kind === 'video' ? 'video' : 'audio';
    p.publications.set(pubKey, { track, kind });

    for (const [otherId, other] of room) {
      if (otherId === userId || other.closed) continue;
      this._addForward(other, userId, pubKey, { track, kind });
      this._renegotiate(code, otherId).catch(() => {});
    }
  }

  // Add a forward track (ownerId's pubKey) to participant `dst` and pipe RTP.
  _addForward(dst, ownerId, pubKey, pub) {
    const fwdKey = `${ownerId}:${pubKey}`;
    if (dst.forwards.has(fwdKey)) return;
    const local = new MediaStreamTrack({ kind: pub.kind });
    const transceiver = dst.pc.addTransceiver(local, { direction: 'sendonly' });
    const { unSubscribe } = pub.track.onReceiveRtp.subscribe((rtp) => {
      try { local.writeRtp(rtp); } catch { /* peer mid-renegotiation */ }
    });
    dst.forwards.set(fwdKey, { transceiver, unsub: unSubscribe });
    dst.txMeta.set(transceiver, { role: 'forward', kind: pub.kind, ownerId, pubKey });
  }

  // ── Renegotiate one participant: fresh offer with the full m-line set. ────
  _renegotiate(code, userId) {
    const p = this.rooms.get(code)?.get(userId);
    if (!p) return Promise.resolve();
    // Chain so overlapping changes never produce two in-flight offers.
    p.negChain = p.negChain.then(() => this._doOffer(code, p)).catch(() => {});
    return p.negChain;
  }

  async _doOffer(code, p) {
    if (p.closed) return;

    // Give the client a publish slot (recvonly from the SFU's POV) for each
    // kind it still needs one for.
    while (p.pendingRecvKinds.length) {
      const kind = p.pendingRecvKinds.shift();
      const tx = p.pc.addTransceiver(kind, { direction: 'recvonly' });
      p.txMeta.set(tx, { role: 'recv', kind });
    }

    const offer = await p.pc.createOffer();
    await p.pc.setLocalDescription(offer);

    // mids are assigned once the local description is set — read them now.
    const sendMids = {};
    const trackMap = {};
    for (const [tx, meta] of p.txMeta) {
      const mid = tx.mid;
      if (mid == null) continue;
      if (meta.role === 'recv') sendMids[mid] = meta.kind;
      else if (meta.role === 'forward') trackMap[mid] = { userId: meta.ownerId, kind: meta.kind };
    }

    if (p.closed) return;
    this.sendSignal(p.userId, 'sfu-offer', {
      code,
      sdp: p.pc.localDescription,
      sendMids,
      trackMap,
    });
  }

  // ── Client → SFU signaling ───────────────────────────────
  async handleAnswer(code, userId, sdp) {
    const p = this.rooms.get(code)?.get(userId);
    if (!p || p.closed) return;
    try { await p.pc.setRemoteDescription(sdp); } catch { /* stale answer, next offer fixes it */ }
  }

  async handleIce(code, userId, candidate) {
    const p = this.rooms.get(code)?.get(userId);
    if (!p || p.closed || !candidate) return;
    try { await p.pc.addIceCandidate(candidate); } catch { /* candidate for a closed transport */ }
  }

  // Diagnostics
  stats() {
    const rooms = {};
    for (const [code, room] of this.rooms) {
      rooms[code] = { participants: room.size };
    }
    return { rooms, totalRooms: this.rooms.size };
  }
}

module.exports = { SFU, Participant };
