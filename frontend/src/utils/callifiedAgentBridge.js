/**
 * Browser side of the Callified agent bridge (manual / human calls).
 *
 * WHAT IT DOES
 *   After the backend places a browser call
 *   (`POST .../manual-call` → `{ callSid, bridgeTicket, bridgePath }`), this
 *   module opens the CRM's relay WebSocket, captures the staff member's
 *   microphone, streams it to Callified, and plays the customer's audio back.
 *
 * WHY THE RELAY
 *   Callified's own `agent_url` requires the tenant's Callified API JWT. The
 *   browser never receives that credential — it redeems a single-use ticket
 *   against the CRM relay instead, and the backend holds the credential. See
 *   backend/lib/callifiedAgentBridge.js.
 *
 * WIRE PROTOCOL — CONFIRMED against Callified's source, not inferred.
 *   `backend/internal/wshandler/bridge.go` (ServeAgent) documents it, and
 *   `frontend/src/components/campaigns/BrowserCallModal.jsx` is their working
 *   client. JSON text frames only — no binary, no Exotel `media` envelope:
 *
 *     Server → Agent: {"type":"status","status":"waiting"|"connected"}
 *     Server → Agent: {"type":"audio","payload":"<base64 pcm16 8k>"}
 *     Server → Agent: {"type":"hangup"}
 *     Server → Agent: {"type":"error","msg":"…"}
 *     Agent  → Server: {"type":"audio","payload":"<base64 pcm16 8k>"}
 *     Agent  → Server: {"type":"hangup"}
 *
 *   bridge.go:244 is the load-bearing line:
 *       if msgType != "audio" || !customerAudioReady.Load() { continue }
 *   Anything that is not exactly `type:"audio"` is DISCARDED SILENTLY, which
 *   is why an earlier Exotel-style `{"event":"media","media":{…}}` envelope
 *   produced a call where the customer could be heard but the agent could not
 *   be. There is no handshake frame — connect and send.
 *
 *   Audio is 16-bit signed little-endian PCM, mono, 8 kHz, base64.
 */

import { describeMediaError } from './callified';

const SAMPLE_RATE = 8000;

/** States the UI renders. */
export const BRIDGE_STATE = {
  IDLE: 'idle',
  REQUESTING_MIC: 'requesting-mic',
  CONNECTING: 'connecting',
  RINGING: 'ringing',
  LIVE: 'live',
  ENDING: 'ending',
  ENDED: 'ended',
  ERROR: 'error',
};

// --------------------------------------------------------------------------
// Codec helpers — PCM16 LE @ 8 kHz, matching Callified's client exactly.
// --------------------------------------------------------------------------

/** Linear-resample a Float32 buffer down to 8 kHz. */
export function resampleTo8k(input, srcRate) {
  if (!srcRate || srcRate === SAMPLE_RATE) return input;
  const ratio = srcRate / SAMPLE_RATE;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i += 1) {
    const src = i * ratio;
    const lo = Math.floor(src);
    const hi = Math.min(lo + 1, input.length - 1);
    const frac = src - lo;
    out[i] = input[lo] * (1 - frac) + input[hi] * frac;
  }
  return out;
}

function float32ToInt16(input) {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    out[i] = Math.max(-32768, Math.min(32767, input[i] * 32767));
  }
  return out;
}

function toBase64(typedArray) {
  const bytes = new Uint8Array(typedArray.buffer || typedArray);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.byteLength; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Decode base64 PCM-16 bytes to Float32. */
export function base64ToPcmFloat32(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  // A WebSocket payload is not guaranteed to land on an even byte offset.
  const usable = bytes.length - (bytes.length % 2);
  const int16 = new Int16Array(bytes.buffer.slice(0, usable));
  const f32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i += 1) f32[i] = int16[i] / 32768;
  return f32;
}

/**
 * Absolute ws(s):// URL for the CRM relay. Same origin as the SPA, so it
 * follows whatever host/proxy the app is served from.
 */
export function bridgeSocketUrl(bridgePath, ticket) {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const path = bridgePath || '/ws/callified-agent';
  return `${proto}//${window.location.host}${path}?ticket=${encodeURIComponent(ticket)}`;
}

// The capture worklet, inlined so it can be registered from a Blob URL without
// shipping a separate asset that would need its own build + CSP entry.
const CAPTURE_WORKLET_SOURCE = `
class CallifiedCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length) {
      this.port.postMessage(new Float32Array(input[0]));
    }
    return true;
  }
}
registerProcessor('callified-capture', CallifiedCaptureProcessor);
`;

/**
 * One live agent bridge. Create it, `start()` it, `stop()` it — the instance
 * is single-use so a retry always begins from a clean audio graph.
 */
export class CallifiedAgentBridge {
  /**
   * @param {{callSid:string, bridgePath?:string, ticket:string,
   *          onState?:(state:string, detail?:object)=>void,
   *          onError?:(message:string)=>void,
   *          onEvent?:(frame:object)=>void}} options
   */
  constructor(options) {
    this.callSid = options.callSid;
    this.ticket = options.ticket;
    this.bridgePath = options.bridgePath;
    this.onState = options.onState || (() => {});
    this.onError = options.onError || (() => {});
    this.onEvent = options.onEvent || (() => {});

    this.socket = null;
    this.audioContext = null;
    this.micStream = null;
    this.sourceNode = null;
    this.captureNode = null;
    this.silentGain = null;

    this.state = BRIDGE_STATE.IDLE;
    this.muted = false;
    this.stopped = false;
    // Callified drops agent audio until the carrier leg is up
    // (bridge.go:244 `!customerAudioReady`). Sending anyway does not just
    // waste frames — it fills TCP buffers that flush the instant the relay
    // starts, so the customer hears seconds of stale silence before the
    // agent's real voice. Stay quiet until the server says "connected".
    this.connected = false;
    this.playCursor = 0;
  }

  setState(state, detail) {
    if (this.state === state) return;
    this.state = state;
    this.onState(state, detail);
  }

  fail(message) {
    if (this.stopped) return;
    this.onError(message);
    this.setState(BRIDGE_STATE.ERROR, { message });
    this.stop({ silent: true });
  }

  /**
   * Acquire the microphone, connect the relay, and start streaming.
   * Resolves once the socket is open; the call goes LIVE when Callified
   * reports `status: connected`.
   */
  async start() {
    if (this.stopped) throw new Error('This call has already ended.');

    // Each bridge opens its OWN stream. Sharing one across bridges is unsafe:
    // React StrictMode double-mounts the panel, and the discarded first bridge
    // stops the tracks of whatever stream it holds — leaving the bridge that is
    // actually on screen with dead tracks and a silent microphone. The caller
    // still PROBES the microphone before placing the call (probeMicrophone), so
    // a machine without one never rings the customer; permission is already
    // granted by then, so this second call raises no prompt.
    this.setState(BRIDGE_STATE.REQUESTING_MIC);
    let micStream;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
    } catch (e) {
      throw new Error(describeMediaError(e));
    }

    // The bridge can be torn down WHILE these awaits are parked — React
    // StrictMode double-mounts every effect in dev (mount → cleanup →
    // remount), and in production the dialog can be closed mid-connect.
    //
    // Without this check the abandoned bridge sails on and redeems the
    // ticket, which is single-use — so the bridge that is actually on screen
    // then gets a 401 and reports "Could not connect to the call bridge".
    // Bail before the socket, and hand back the resources we just took.
    if (this.stopped) {
      micStream.getTracks().forEach((track) => track.stop());
      return;
    }
    this.micStream = micStream;

    this.setState(BRIDGE_STATE.CONNECTING);
    await this.openAudioGraph();
    if (this.stopped) {
      this.releaseResources();
      return;
    }

    await this.openSocket();
  }

  async openAudioGraph() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error('This browser does not support the Web Audio API.');

    // Native rate + explicit resample, matching Callified's own client.
    // Forcing an 8 kHz context is rejected outright by some browsers.
    this.audioContext = new Ctx();
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume().catch(() => {});
    }

    this.sourceNode = this.audioContext.createMediaStreamSource(this.micStream);

    // A muted sink keeps the capture node inside a live graph without routing
    // the agent's own voice back to their speakers.
    this.silentGain = this.audioContext.createGain();
    this.silentGain.gain.value = 0;
    this.silentGain.connect(this.audioContext.destination);

    const usedWorklet = await this.tryAudioWorkletCapture();
    if (!usedWorklet) this.useScriptProcessorCapture();
  }

  async tryAudioWorkletCapture() {
    if (!this.audioContext.audioWorklet) return false;
    let blobUrl = null;
    try {
      blobUrl = URL.createObjectURL(
        new Blob([CAPTURE_WORKLET_SOURCE], { type: 'application/javascript' }),
      );
      await this.audioContext.audioWorklet.addModule(blobUrl);
      const node = new AudioWorkletNode(this.audioContext, 'callified-capture');
      node.port.onmessage = (event) => this.onCapturedFrame(event.data);
      this.sourceNode.connect(node);
      node.connect(this.silentGain);
      this.captureNode = node;
      return true;
    } catch (e) {
      // Older Safari / strict CSP without blob: worklets — fall back below.
      console.warn('[callifiedAgentBridge] AudioWorklet unavailable, using ScriptProcessor:', e?.message);
      return false;
    } finally {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    }
  }

  useScriptProcessorCapture() {
    if (!this.audioContext.createScriptProcessor) {
      throw new Error('This browser cannot capture microphone audio for calls.');
    }
    // 512 frames, matching Callified's own client — low enough latency that
    // the agent does not sound delayed.
    const node = this.audioContext.createScriptProcessor(512, 1, 1);
    node.onaudioprocess = (event) => {
      this.onCapturedFrame(event.inputBuffer.getChannelData(0));
    };
    this.sourceNode.connect(node);
    node.connect(this.silentGain);
    this.captureNode = node;
  }

  /** Resample a captured chunk to 8 kHz and ship it as one audio frame. */
  onCapturedFrame(float32) {
    if (this.stopped || !float32 || !float32.length) return;
    if (this.muted || !this.connected) return;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;

    const pcm8k = resampleTo8k(float32, this.audioContext?.sampleRate);
    const int16 = float32ToInt16(pcm8k);
    this.sendJson({ type: 'audio', payload: toBase64(int16) });
  }

  sendJson(payload) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    try {
      this.socket.send(JSON.stringify(payload));
    } catch (e) {
      console.warn('[callifiedAgentBridge] send failed:', e?.message);
    }
  }

  openSocket() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const url = bridgeSocketUrl(this.bridgePath, this.ticket);
      let socket;
      try {
        socket = new WebSocket(url);
      } catch (e) {
        reject(new Error(`Could not open the call connection: ${e?.message || e}`));
        return;
      }
      this.socket = socket;

      socket.onopen = () => {
        settled = true;
        // No handshake frame: Callified's agent socket expects audio only.
        this.setState(BRIDGE_STATE.RINGING);
        resolve();
      };

      socket.onmessage = (event) => this.handleMessage(event.data);

      socket.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new Error('Could not connect to the call bridge.'));
          return;
        }
        this.fail('The call connection dropped.');
      };

      socket.onclose = (event) => {
        if (!settled) {
          settled = true;
          reject(
            new Error(
              event.code === 1006
                ? 'The call bridge refused the connection. The call may have expired — try again.'
                : `The call bridge closed (${event.code}).`,
            ),
          );
          return;
        }
        if (this.stopped) return;
        this.setState(BRIDGE_STATE.ENDED, { code: event.code });
        this.stop({ silent: true });
      };
    });
  }

  handleMessage(data) {
    if (typeof data !== 'string') return;

    let frame;
    try {
      frame = JSON.parse(data);
    } catch (_e) {
      return; // the agent socket is JSON-only
    }

    // Relay control frames are namespaced so they cannot collide with
    // Callified's own `type` vocabulary.
    if (frame.type === 'bridge') {
      if (frame.event === 'ready') {
        // Upstream is open — the customer's phone is ringing. LIVE waits for
        // Callified's own `status: connected`.
        this.setState(BRIDGE_STATE.RINGING, { callSid: frame.callSid });
      } else if (frame.event === 'error') {
        this.fail(frame.message || 'The call bridge reported an error.');
      } else if (frame.event === 'closed') {
        this.setState(BRIDGE_STATE.ENDED, { code: frame.code });
        this.stop({ silent: true });
      }
      return;
    }

    this.onEvent(frame);
    const parsed = parseInboundFrame(frame);

    if (parsed.audio) this.playAudio(parsed.audio);

    if (parsed.errorMessage) {
      this.fail(parsed.errorMessage);
      return;
    }
    if (parsed.ended) {
      this.setState(BRIDGE_STATE.ENDED, { reason: parsed.status || 'hangup' });
      this.stop({ silent: true });
      return;
    }
    if (parsed.answered) {
      // Ungate the microphone — see the `connected` note in the constructor.
      this.connected = true;
      this.setState(BRIDGE_STATE.LIVE, { reason: parsed.status });
    } else if (parsed.status === 'waiting') {
      this.setState(BRIDGE_STATE.RINGING, { reason: parsed.status });
    }
  }

  /** Schedule inbound audio back-to-back so playback stays continuous. */
  playAudio(samples) {
    if (!this.audioContext || this.stopped || !samples || !samples.length) return;

    const buffer = this.audioContext.createBuffer(1, samples.length, SAMPLE_RATE);
    buffer.getChannelData(0).set(samples);

    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.audioContext.destination);

    // 60 ms of jitter headroom: enough to absorb network variance without an
    // audible delay building up over the call.
    const now = this.audioContext.currentTime;
    const startAt = Math.max(now + 0.06, this.playCursor);
    source.start(startAt);
    this.playCursor = startAt + buffer.duration;
  }

  setMuted(muted) {
    this.muted = Boolean(muted);
    return this.muted;
  }

  /**
   * Release the microphone, audio graph and socket without touching call
   * state. Split out of stop() so the mid-connect bail-outs in start() can
   * hand resources back too — those run when `stopped` is already true, so
   * stop() itself would return early and leak a hot microphone.
   *
   * Safe to call repeatedly; every branch nulls what it releases.
   */
  releaseResources() {
    if (this.captureNode) {
      try {
        this.captureNode.disconnect();
        if (this.captureNode.port) this.captureNode.port.onmessage = null;
        this.captureNode.onaudioprocess = null;
      } catch (_e) {
        /* already torn down */
      }
      this.captureNode = null;
    }
    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch (_e) {
        /* already torn down */
      }
      this.sourceNode = null;
    }
    if (this.silentGain) {
      try {
        this.silentGain.disconnect();
      } catch (_e) {
        /* already torn down */
      }
      this.silentGain = null;
    }
    if (this.micStream) {
      this.micStream.getTracks().forEach((track) => track.stop());
      this.micStream = null;
    }
    if (this.audioContext) {
      // Teardown must never throw — a failure here would abandon the socket
      // below and leave the microphone live.
      try {
        this.audioContext.close()?.catch?.(() => {});
      } catch (_e) {
        /* context already closed */
      }
      this.audioContext = null;
    }
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close(1000, 'agent hung up');
        }
      } catch (_e) {
        /* already closed */
      }
    }
  }

  /** Hang up and release every resource. Safe to call more than once. */
  stop({ silent = false } = {}) {
    if (this.stopped) return;
    this.stopped = true;
    if (!silent) this.setState(BRIDGE_STATE.ENDING);

    // Closing the socket alone only drops the browser leg — Callified needs
    // an explicit hangup to release the customer's carrier line
    // (bridge.go:239 → hangupBridgeCall).
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.sendJson({ type: 'hangup' });
    }

    this.releaseResources();

    if (!silent) this.setState(BRIDGE_STATE.ENDED);
  }
}

/**
 * Normalize one inbound Callified frame.
 *
 * Vocabulary confirmed from bridge.go's ServeAgent header:
 *   status / audio / hangup / error.
 *
 * @param {object} frame
 * @returns {{audio?:Float32Array, answered?:boolean, ended?:boolean,
 *            status?:string, errorMessage?:string}}
 */
export function parseInboundFrame(frame) {
  if (!frame || typeof frame !== 'object') return {};
  const result = {};
  const type = String(frame.type || '').toLowerCase();

  if (type === 'audio' && typeof frame.payload === 'string' && frame.payload) {
    try {
      result.audio = base64ToPcmFloat32(frame.payload);
    } catch (_e) {
      /* malformed chunk — dropping one frame beats killing the call */
    }
    return result;
  }

  if (type === 'status') {
    const status = String(frame.status || '').toLowerCase();
    result.status = status;
    if (status === 'connected') result.answered = true;
    return result;
  }

  if (type === 'hangup') {
    result.ended = true;
    return result;
  }

  if (type === 'error') {
    result.errorMessage = frame.msg || frame.message || 'The call failed.';
    return result;
  }

  return result;
}

export default CallifiedAgentBridge;
