'use strict';

// Integration test for the in-process werift SFU (src/voice/sfu.js). A werift
// peer stands in for a browser client: it answers the SFU's offers, attaches a
// mic track to its publish slot, and accepts forwarded tracks. This exercises
// the whole signaling + track-fan-out path (join → offer → answer → connect →
// publish detected → forwards created on the next join) without a real browser.
// The raw audio bytes are validated live; here we prove the plumbing.

const assert = require('node:assert/strict');
const test = require('node:test');
const { RTCPeerConnection, MediaStreamTrack } = require('werift');
const { SFU } = require('../src/voice/sfu');

// A stand-in browser client: pure answerer, mirrors what the real client does.
class Client {
  constructor(sfu, code, userId) {
    this.sfu = sfu; this.code = code; this.userId = userId;
    this.pc = new RTCPeerConnection({});
    this.attached = new Set();   // mids we've already put our mic on
    this.remoteTracks = [];      // { userId, kind } we've been offered
    this.pc.onIceCandidate.subscribe((e) => {
      const c = e && (e.candidate || e);
      if (c && c.candidate !== undefined) this.sfu.handleIce(code, userId, c);
    });
  }
  // Called by the test's sendSignal router.
  async onSignal(event, payload) {
    if (event === 'sfu-ice') { await this.pc.addIceCandidate(payload.candidate).catch(() => {}); return; }
    if (event !== 'sfu-offer') return;
    await this.pc.setRemoteDescription(payload.sdp);
    // Attach our mic to each publish slot we haven't filled yet.
    for (const [mid, kind] of Object.entries(payload.sendMids || {})) {
      if (this.attached.has(mid)) continue;
      const tx = this.pc.getTransceivers().find(t => t.mid === mid);
      if (tx) {
        const track = new MediaStreamTrack({ kind });
        tx.sender.replaceTrack(track);
        tx.setDirection('sendonly');
        this.attached.add(mid);
      }
    }
    // Record what we're being sent.
    this.remoteTracks = Object.values(payload.trackMap || {});
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await this.sfu.handleAnswer(this.code, this.userId, this.pc.localDescription);
  }
  connected() {
    return this.pc.iceConnectionState === 'connected' || this.pc.iceConnectionState === 'completed';
  }
  close() { try { this.pc.close(); } catch { /* noop */ } }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 6000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (fn()) return; await sleep(50); }
  throw new Error('condition not met within ' + ms + 'ms');
}

test('sfu: join → offer/answer connects and the publish is detected', async (t) => {
  const clients = new Map();
  const sfu = new SFU({ sendSignal: (userId, event, payload) => {
    const c = clients.get(userId);
    if (c) c.onSignal(event, payload).catch(() => {});
  } });
  const code = 'room1';
  t.after(() => { sfu.closeRoom(code); for (const c of clients.values()) c.close(); });

  const alice = new Client(sfu, code, 1); clients.set(1, alice);
  await sfu.join(code, 1);
  await waitFor(() => alice.connected(), 8000);
  assert.ok(alice.connected(), 'alice PC connected to the SFU');
  // Her mic was negotiated → the SFU registered one publication.
  await waitFor(() => sfu.rooms.get(code).get(1).publications.size >= 1);
  assert.equal(sfu.rooms.get(code).get(1).publications.size, 1);
  assert.equal(sfu.roomSize(code), 1);
});

test('sfu: a second joiner receives a forward of the first, and vice-versa', async (t) => {
  const clients = new Map();
  const sfu = new SFU({ sendSignal: (userId, event, payload) => {
    const c = clients.get(userId);
    if (c) c.onSignal(event, payload).catch(() => {});
  } });
  const code = 'room2';
  t.after(() => { sfu.closeRoom(code); for (const c of clients.values()) c.close(); });

  const alice = new Client(sfu, code, 1); clients.set(1, alice);
  await sfu.join(code, 1);
  await waitFor(() => sfu.rooms.get(code).get(1).publications.size >= 1);

  const bob = new Client(sfu, code, 2); clients.set(2, bob);
  await sfu.join(code, 2);
  await waitFor(() => bob.connected(), 8000);

  // Bob is offered a forward of Alice's mic.
  await waitFor(() => bob.remoteTracks.some(rt => rt.userId === 1));
  assert.ok(bob.remoteTracks.some(rt => rt.userId === 1 && rt.kind === 'audio'), 'bob receives alice');
  assert.ok(sfu.rooms.get(code).get(2).forwards.has('1:' + [...sfu.rooms.get(code).get(1).publications.keys()][0]), 'server tracks the forward');

  // Once Bob publishes, Alice is re-offered a forward of Bob.
  await waitFor(() => sfu.rooms.get(code).get(2).publications.size >= 1);
  await waitFor(() => alice.remoteTracks.some(rt => rt.userId === 2), 8000);
  assert.ok(alice.remoteTracks.some(rt => rt.userId === 2 && rt.kind === 'audio'), 'alice receives bob');
  assert.equal(sfu.roomSize(code), 2);
});

test('sfu: leaving removes the departed user\'s forwards from everyone else', async (t) => {
  const clients = new Map();
  const sfu = new SFU({ sendSignal: (userId, event, payload) => {
    const c = clients.get(userId);
    if (c) c.onSignal(event, payload).catch(() => {});
  } });
  const code = 'room3';
  t.after(() => { sfu.closeRoom(code); for (const c of clients.values()) c.close(); });

  const alice = new Client(sfu, code, 1); clients.set(1, alice);
  const bob = new Client(sfu, code, 2); clients.set(2, bob);
  await sfu.join(code, 1);
  await waitFor(() => sfu.rooms.get(code).get(1).publications.size >= 1);
  await sfu.join(code, 2);
  await waitFor(() => sfu.rooms.get(code).get(2).publications.size >= 1);
  await waitFor(() => alice.remoteTracks.some(rt => rt.userId === 2), 8000);

  await sfu.leave(code, 2);
  assert.equal(sfu.roomSize(code), 1, 'bob is gone');
  // Alice keeps no forwards sourced from bob.
  const aliceForwards = [...sfu.rooms.get(code).get(1).forwards.keys()];
  assert.ok(!aliceForwards.some(k => k.startsWith('2:')), 'bob forwards removed from alice');
});
