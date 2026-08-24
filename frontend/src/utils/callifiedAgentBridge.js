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
 * AUDIO FRAME FORMAT — READ THIS BEFORE CHANGING
 *   API_FLOW.md documents that `/ws/agent?call_sid=…` exists and what
 *   browser-call returns, but NOT the audio envelope that socket speaks. The
 *   surrounding evidence (Exotel call_sids, an `exotel_account_id` parameter)
 *   points at Exotel's Voice Streaming convention, so that is what we speak:
 *
 *     out  {"event":"start","start":{"call_sid":…,"media_format":{…}}}   once
 *     out  {"event":"media","media":{"payload":"<base64 audio>"}}        ~50/s
 *     out  {"event":"stop","stop":{"call_sid":…}}                        once
 *     in   the same shapes, plus binary frames
 *
 *   The receive path is deliberately liberal: it accepts binary frames, the
 *   `media.payload` envelope, a bare `payload`/`audio` field, and adapts its
 *   codec + sample rate from whatever `media_format` the server announces in
 *   its `start`/`connected` frame. Both PCM16-LE and G.711 µ-law are handled.
 *   If Callified confirms a different envelope, `MEDIA_DEFAULTS` and
 *   `parseInboundFrame` are the only two places that need to change.
 */

const DEFAULT_SAMPLE_RATE = 8000;
const FRAME_SAMPLES = 160; // 20 ms at 8 kHz — the usual telephony frame size

const MEDIA_DEFAULTS = {
  encoding: 'audio/l16', // 16-bit signed little-endian PCM
  sampleRate: DEFAULT_SAMPLE_RATE,
  channels: 1,
};

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
// Codec helpers
// --------------------------------------------------------------------------

function floatToPcm16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i += 1) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function pcm16ToFloat(int16) {
  const out = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i += 1) {
    out[i] = int16[i] / (int16[i] < 0 ? 0x8000 : 0x7fff);
  }
  return out;
}

// G.711 µ-law. Present because Exotel-family media streams frequently use it;
// which one is active is decided by the server's announced media_format.
function pcm16ToMulaw(input) {
  const BIAS = 0x84;
  const CLIP = 32635;
  const sign = (input >> 8) & 0x80;
  let sample = sign !== 0 ? -input : input;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;

  let exponent = 7;
  let mask = 0x4000;
  while ((sample & mask) === 0 && exponent > 0) {
    exponent -= 1;
    mask >>= 1;
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function mulawToPcm16(muByte) {
  const BIAS = 0x84;
  const value = ~muByte & 0xff;
  const sign = value & 0x80;
  const exponent = (value >> 4) & 0x07;
  const mantissa = value & 0x0f;
  let sample = ((mantissa << 3) + BIAS) << exponent;
  sample -= BIAS;
  return sign !== 0 ? -sample : sample;
}

function isMulaw(encoding) {
  return /mulaw|ulaw|pcmu|g711u/i.test(String(encoding || ''));
}

function encodeAudio(float32, encoding) {
  const pcm = floatToPcm16(float32);
  if (!isMulaw(encoding)) return new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const out = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i += 1) out[i] = pcm16ToMulaw(pcm[i]);
  return out;
}

function decodeAudio(bytes, encoding) {
  if (isMulaw(encoding)) {
    const pcm = new Int16Array(bytes.length);
    for (let i = 0; i < bytes.length; i += 1) pcm[i] = mulawToPcm16(bytes[i]);
    return pcm16ToFloat(pcm);
  }
  // 16-bit LE PCM. Copy into an aligned buffer — a WebSocket payload slice is
  // not guaranteed to start on an even byte offset.
  const usable = bytes.length - (bytes.length % 2);
  const aligned = new Uint8Array(usable);
  aligned.set(bytes.subarray(0, usable));
  return pcm16ToFloat(new Int16Array(aligned.buffer));
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
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

    this.media = { ...MEDIA_DEFAULTS };
    this.state = BRIDGE_STATE.IDLE;
    this.muted = false;
    this.stopped = false;
    this.playCursor = 0;
    this.captureBuffer = [];
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
   * Resolves once the socket is open; the call goes LIVE when the relay
   * reports its upstream is ready.
   */
  async start() {
    if (this.stopped) throw new Error('This call has already ended.');

    this.setState(BRIDGE_STATE.REQUESTING_MIC);
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
    } catch (e) {
      const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      throw new Error(
        denied
          ? 'Microphone access was blocked. Allow the microphone for this site, then try again.'
          : `Could not open the microphone: ${e?.message || e}`,
      );
    }

    this.setState(BRIDGE_STATE.CONNECTING);
    await this.openAudioGraph();
    await this.openSocket();
  }

  async openAudioGraph() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error('This browser does not support the Web Audio API.');

    // Running the graph at the telephony rate lets the browser resample the
    // mic for us, so the capture callback already yields 8 kHz frames.
    try {
      this.audioContext = new Ctx({ sampleRate: this.media.sampleRate });
    } catch (_e) {
      this.audioContext = new Ctx();
    }
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
    // 2048 frames ≈ 256 ms at 8 kHz — the smallest size that stays glitch-free
    // on the main thread across browsers.
    const node = this.audioContext.createScriptProcessor(2048, 1, 1);
    node.onaudioprocess = (event) => {
      this.onCapturedFrame(event.inputBuffer.getChannelData(0));
    };
    this.sourceNode.connect(node);
    node.connect(this.silentGain);
    this.captureNode = node;
  }

  /** Buffer captured audio into fixed 20 ms frames and ship them. */
  onCapturedFrame(float32) {
    if (this.stopped || !float32 || !float32.length) return;
    if (this.muted) return;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;

    this.captureBuffer.push(new Float32Array(float32));
    let total = this.captureBuffer.reduce((n, chunk) => n + chunk.length, 0);

    while (total >= FRAME_SAMPLES) {
      const frame = new Float32Array(FRAME_SAMPLES);
      let filled = 0;
      while (filled < FRAME_SAMPLES) {
        const head = this.captureBuffer[0];
        const take = Math.min(head.length, FRAME_SAMPLES - filled);
        frame.set(head.subarray(0, take), filled);
        filled += take;
        if (take === head.length) this.captureBuffer.shift();
        else this.captureBuffer[0] = head.subarray(take);
      }
      total -= FRAME_SAMPLES;
      this.sendMedia(frame);
    }
  }

  sendMedia(float32) {
    const bytes = encodeAudio(float32, this.media.encoding);
    this.sendJson({
      event: 'media',
      stream_sid: this.callSid,
      media: { payload: bytesToBase64(bytes) },
    });
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
      socket.binaryType = 'arraybuffer';
      this.socket = socket;

      socket.onopen = () => {
        settled = true;
        this.setState(BRIDGE_STATE.RINGING);
        this.sendJson({
          event: 'start',
          start: {
            call_sid: this.callSid,
            stream_sid: this.callSid,
            media_format: {
              encoding: this.media.encoding,
              sample_rate: this.media.sampleRate,
              channels: this.media.channels,
            },
          },
        });
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
    if (data instanceof ArrayBuffer) {
      this.playAudio(new Uint8Array(data));
      return;
    }
    if (typeof data !== 'string') return;

    let frame;
    try {
      frame = JSON.parse(data);
    } catch (_e) {
      return; // non-JSON text frames are not part of any contract we honour
    }

    // Relay control frames are namespaced so they cannot collide with
    // Callified's own `event` frames.
    if (frame.type === 'bridge') {
      if (frame.event === 'ready') {
        this.setState(BRIDGE_STATE.LIVE, { callSid: frame.callSid });
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

    if (parsed.mediaFormat) {
      this.media = { ...this.media, ...parsed.mediaFormat };
    }
    if (parsed.audio) {
      this.playAudio(parsed.audio);
    }
    if (parsed.ended) {
      this.setState(BRIDGE_STATE.ENDED, { reason: parsed.status || 'stopped' });
      this.stop({ silent: true });
    } else if (parsed.answered) {
      this.setState(BRIDGE_STATE.LIVE, { reason: parsed.status });
    }
  }

  /** Schedule inbound audio back-to-back so playback stays continuous. */
  playAudio(bytes) {
    if (!this.audioContext || this.stopped || !bytes || !bytes.length) return;
    const samples = decodeAudio(bytes, this.media.encoding);
    if (!samples.length) return;

    const rate = this.media.sampleRate || this.audioContext.sampleRate;
    let buffer;
    try {
      buffer = this.audioContext.createBuffer(1, samples.length, rate);
    } catch (_e) {
      // Some browsers refuse buffers below 8 kHz; fall back to the graph rate.
      buffer = this.audioContext.createBuffer(1, samples.length, this.audioContext.sampleRate);
    }
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
    if (this.muted) this.captureBuffer = [];
    return this.muted;
  }

  /** Hang up and release every resource. Safe to call more than once. */
  stop({ silent = false } = {}) {
    if (this.stopped) return;
    this.stopped = true;
    if (!silent) this.setState(BRIDGE_STATE.ENDING);

    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.sendJson({ event: 'stop', stop: { call_sid: this.callSid } });
    }

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
      this.audioContext.close().catch(() => {});
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

    this.captureBuffer = [];
    if (!silent) this.setState(BRIDGE_STATE.ENDED);
  }
}

/**
 * Normalize one inbound Callified frame.
 *
 * Exported for tests and because it is the single place that needs editing if
 * Callified's agent socket turns out to speak a different envelope.
 *
 * @param {object} frame
 * @returns {{audio?:Uint8Array, mediaFormat?:object, answered?:boolean,
 *            ended?:boolean, status?:string}}
 */
export function parseInboundFrame(frame) {
  if (!frame || typeof frame !== 'object') return {};
  const result = {};
  const event = String(frame.event || frame.type || '').toLowerCase();

  const format = frame.media_format || frame.mediaFormat || frame.start?.media_format;
  if (format) {
    result.mediaFormat = {
      encoding: format.encoding || format.codec || MEDIA_DEFAULTS.encoding,
      sampleRate: Number(format.sample_rate || format.sampleRate) || MEDIA_DEFAULTS.sampleRate,
      channels: Number(format.channels) || MEDIA_DEFAULTS.channels,
    };
  }

  const payload =
    frame.media?.payload ?? frame.media?.audio ?? frame.payload ?? frame.audio ?? null;
  if (typeof payload === 'string' && payload.length) {
    try {
      result.audio = base64ToBytes(payload);
    } catch (_e) {
      /* malformed chunk — dropping one frame is better than killing the call */
    }
  }

  const status = String(frame.status || frame.call_status || frame.callStatus || '').toLowerCase();
  if (status) result.status = status;

  if (event === 'stop' || event === 'disconnected' || event === 'hangup') {
    result.ended = true;
  } else if (['completed', 'ended', 'failed', 'busy', 'no-answer', 'canceled'].includes(status)) {
    result.ended = true;
  } else if (
    event === 'answered' ||
    ['answered', 'in-progress', 'connected', 'live'].includes(status)
  ) {
    result.answered = true;
  }

  return result;
}

export default CallifiedAgentBridge;
