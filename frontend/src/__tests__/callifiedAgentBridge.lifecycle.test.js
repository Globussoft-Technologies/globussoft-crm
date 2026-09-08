/**
 * CallifiedAgentBridge lifecycle — the one-shot-ticket race.
 *
 * THE BUG THIS PINS
 *   The relay ticket is single-use by design. `start()` awaits getUserMedia
 *   (which parks on the browser's permission prompt) and then opens the
 *   socket. React StrictMode double-mounts every effect in dev — mount,
 *   cleanup, remount — so the FIRST bridge is stopped while its getUserMedia
 *   is still pending. Without a `stopped` check after that await, the
 *   abandoned bridge sailed on and redeemed the ticket, and the bridge
 *   actually on screen then got a 401:
 *
 *       "Call ended — Could not connect to the call bridge."
 *
 *   It also leaked a live microphone, because stop() had already run and
 *   returns early on its `stopped` guard.
 *
 *   The same race exists outside StrictMode any time the dialog is closed
 *   mid-connect, so this is not a dev-only concern.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import CallifiedAgentBridge, { BRIDGE_STATE } from '../utils/callifiedAgentBridge';

let socketsConstructed;
let micTracks;
let deferredMic;

class FakeWebSocket {
  constructor(url) {
    socketsConstructed.push(url);
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.binaryType = '';
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    // openSocket() resolves on the open event, so the fake has to complete
    // the handshake or every awaiting test hangs.
    queueMicrotask(() => {
      this.readyState = 1; // OPEN
      if (this.onopen) this.onopen();
    });
  }
  send() {}
  close() {
    this.readyState = 3; // CLOSED
  }
}
FakeWebSocket.CONNECTING = 0;
FakeWebSocket.OPEN = 1;
FakeWebSocket.CLOSING = 2;
FakeWebSocket.CLOSED = 3;

class FakeAudioContext {
  constructor() {
    this.state = 'running';
    this.currentTime = 0;
    this.sampleRate = 8000;
    this.destination = {};
    this.audioWorklet = null; // force the ScriptProcessor path
  }
  createMediaStreamSource() { return { connect: vi.fn(), disconnect: vi.fn() }; }
  createGain() { return { gain: { value: 0 }, connect: vi.fn(), disconnect: vi.fn() }; }
  createScriptProcessor() { return { connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null }; }
  close() { return Promise.resolve(); }
  resume() { return Promise.resolve(); }
}

function makeBridge(overrides = {}) {
  return new CallifiedAgentBridge({
    callSid: 'EXsid-test',
    ticket: 'one-shot-ticket',
    bridgePath: '/ws/callified-agent',
    ...overrides,
  });
}

beforeEach(() => {
  socketsConstructed = [];
  micTracks = [];

  deferredMic = {};
  deferredMic.promise = new Promise((resolve, reject) => {
    deferredMic.resolve = resolve;
    deferredMic.reject = reject;
  });

  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: vi.fn(() => deferredMic.promise),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function grantMicrophone() {
  const track = { stop: vi.fn() };
  micTracks.push(track);
  deferredMic.resolve({ getTracks: () => [track] });
  return track;
}

describe('CallifiedAgentBridge — stopped mid-connect', () => {
  test('a bridge stopped while the mic prompt is open never redeems the ticket', async () => {
    const bridge = makeBridge();
    const started = bridge.start();

    // StrictMode cleanup fires before the user answers the permission prompt.
    bridge.stop({ silent: true });

    const track = grantMicrophone();
    await started;

    // The load-bearing assertion: no socket, so the one-shot ticket is still
    // available to the bridge that is actually on screen.
    expect(socketsConstructed).toEqual([]);
    // And the microphone we opened is handed straight back.
    expect(track.stop).toHaveBeenCalledOnce();
  });

  test('the surviving bridge can still redeem the same ticket', async () => {
    // Bridge A: mounted then immediately discarded, exactly as StrictMode does.
    const abandoned = makeBridge();
    const abandonedStart = abandoned.start();
    abandoned.stop({ silent: true });
    grantMicrophone();
    await abandonedStart;
    expect(socketsConstructed).toEqual([]);

    // Bridge B: the real one. Fresh mic promise for the second mount.
    deferredMic.promise = new Promise((resolve) => { deferredMic.resolve = resolve; });
    const live = makeBridge();
    const liveStart = live.start();
    grantMicrophone();
    await liveStart;

    expect(socketsConstructed).toHaveLength(1);
    expect(socketsConstructed[0]).toContain('ticket=one-shot-ticket');
    live.stop({ silent: true });
  });

  test('a normally-started bridge does open the socket', async () => {
    const bridge = makeBridge();
    const started = bridge.start();
    grantMicrophone();
    await started;

    expect(socketsConstructed).toHaveLength(1);
    expect(socketsConstructed[0]).toMatch(/^wss?:\/\//);
    expect(socketsConstructed[0]).toContain('/ws/callified-agent');
    bridge.stop({ silent: true });
  });

  test('a denied microphone reports a actionable error and opens no socket', async () => {
    const bridge = makeBridge();
    const started = bridge.start();
    deferredMic.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));

    await expect(started).rejects.toThrow(/Microphone access was blocked/i);
    expect(socketsConstructed).toEqual([]);
  });

  test('stop() is idempotent and leaves the bridge ended', async () => {
    const bridge = makeBridge();
    const started = bridge.start();
    grantMicrophone();
    await started;

    bridge.stop();
    const stateAfterFirst = bridge.state;
    bridge.stop();
    bridge.stop();

    expect(stateAfterFirst).toBe(BRIDGE_STATE.ENDED);
    expect(bridge.state).toBe(BRIDGE_STATE.ENDED);
    expect(micTracks[0].stop).toHaveBeenCalledOnce();
  });

  test('start() refuses to run on an already-stopped bridge', async () => {
    const bridge = makeBridge();
    bridge.stop({ silent: true });
    await expect(bridge.start()).rejects.toThrow(/already ended/i);
    expect(socketsConstructed).toEqual([]);
  });
});

/**
 * Microphone gating.
 *
 * Symptom this pins: customer audio reached the agent but the agent's
 * microphone never reached the customer, while Callified's own agent app
 * worked fine. Two causes, both confirmed from bridge.go:244 —
 *
 *     if msgType != "audio" || !customerAudioReady.Load() { continue }
 *
 * (a) the frame must be exactly `type:"audio"` (see the protocol tests), and
 * (b) frames sent before Callified reports `status: connected` are discarded.
 *
 * (b) is not merely wasteful: the frames sit in TCP buffers and flush the
 * instant the relay starts, so the customer hears seconds of stale silence
 * before the agent's real voice. Callified's own client gates on the same
 * signal for exactly this reason.
 */
describe('CallifiedAgentBridge — microphone gating', () => {
  function connectedBridge() {
    const bridge = makeBridge();
    bridge.socket = { readyState: 1, send: vi.fn(), close: vi.fn() };
    bridge.audioContext = { sampleRate: 48000, close: () => Promise.resolve() };
    return bridge;
  }

  const CHUNK = new Float32Array(48).fill(0.25);

  test('stays silent until Callified says connected', () => {
    const bridge = connectedBridge();
    bridge.onCapturedFrame(CHUNK);
    expect(bridge.socket.send).not.toHaveBeenCalled();
  });

  test('a status:connected frame ungates the microphone', () => {
    const bridge = connectedBridge();
    bridge.handleMessage(JSON.stringify({ type: 'status', status: 'connected' }));
    expect(bridge.connected).toBe(true);

    bridge.onCapturedFrame(CHUNK);
    expect(bridge.socket.send).toHaveBeenCalledOnce();
  });

  test('sends the exact envelope the server accepts', () => {
    const bridge = connectedBridge();
    bridge.connected = true;
    bridge.onCapturedFrame(CHUNK);

    const frame = JSON.parse(bridge.socket.send.mock.calls[0][0]);
    // bridge.go:244 drops anything whose `type` is not "audio".
    expect(frame.type).toBe('audio');
    expect(typeof frame.payload).toBe('string');
    expect(frame.payload.length).toBeGreaterThan(0);
    expect(frame).not.toHaveProperty('event');
    expect(frame).not.toHaveProperty('media');
  });

  test('status:waiting does NOT ungate — the phone is still ringing', () => {
    const bridge = connectedBridge();
    bridge.handleMessage(JSON.stringify({ type: 'status', status: 'waiting' }));
    expect(bridge.connected).toBe(false);
    bridge.onCapturedFrame(CHUNK);
    expect(bridge.socket.send).not.toHaveBeenCalled();
  });

  test('muting stops the stream without ending the call', () => {
    const bridge = connectedBridge();
    bridge.connected = true;
    bridge.setMuted(true);
    bridge.onCapturedFrame(CHUNK);
    expect(bridge.socket.send).not.toHaveBeenCalled();

    bridge.setMuted(false);
    bridge.onCapturedFrame(CHUNK);
    expect(bridge.socket.send).toHaveBeenCalledOnce();
  });

  test('hanging up tells Callified to release the carrier leg', () => {
    const bridge = connectedBridge();
    bridge.connected = true;
    // stop() nulls bridge.socket as part of teardown, so keep our own handle.
    const socket = bridge.socket;
    bridge.stop({ silent: true });

    const frame = JSON.parse(socket.send.mock.calls[0][0]);
    // Closing the socket alone leaves the customer's phone line open.
    expect(frame).toEqual({ type: 'hangup' });
  });

  test('an error frame from Callified surfaces its message', () => {
    const bridge = connectedBridge();
    const onError = vi.fn();
    bridge.onError = onError;
    bridge.handleMessage(JSON.stringify({ type: 'error', msg: 'call not found' }));
    expect(onError).toHaveBeenCalledWith('call not found');
  });
});
