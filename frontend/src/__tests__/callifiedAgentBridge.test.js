/**
 * callifiedAgentBridge.test.js — the browser side of the manual-call bridge.
 *
 * The wire protocol here is CONFIRMED, not inferred. It comes from Callified's
 * own source — `backend/internal/wshandler/bridge.go` (ServeAgent) documents
 * it and `frontend/src/components/campaigns/BrowserCallModal.jsx` is their
 * working client:
 *
 *   Server → Agent: {"type":"status","status":"waiting"|"connected"}
 *   Server → Agent: {"type":"audio","payload":"<base64 pcm16 8k>"}
 *   Server → Agent: {"type":"hangup"}
 *   Server → Agent: {"type":"error","msg":"…"}
 *   Agent  → Server: {"type":"audio","payload":"<base64 pcm16 8k>"}
 *
 * bridge.go:244 discards anything that is not exactly `type:"audio"`, which is
 * what made an earlier Exotel-style `{"event":"media",…}` envelope produce a
 * call the customer could be heard on but not heard through. These tests pin
 * the vocabulary so that cannot regress.
 */

import { describe, test, expect } from 'vitest';
import {
  parseInboundFrame,
  bridgeSocketUrl,
  resampleTo8k,
  base64ToPcmFloat32,
  BRIDGE_STATE,
} from '../utils/callifiedAgentBridge';

/** One 16-bit sample (value 1000) as the base64 Callified would send. */
function pcm16Base64(values) {
  const int16 = new Int16Array(values);
  const bytes = new Uint8Array(int16.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

describe('parseInboundFrame', () => {
  test('decodes an audio frame from the top-level payload field', () => {
    const parsed = parseInboundFrame({ type: 'audio', payload: pcm16Base64([1000, -1000]) });
    expect(parsed.audio).toBeInstanceOf(Float32Array);
    expect(parsed.audio).toHaveLength(2);
    expect(parsed.audio[0]).toBeCloseTo(1000 / 32768, 5);
    expect(parsed.audio[1]).toBeCloseTo(-1000 / 32768, 5);
  });

  test('status connected is what ungates the microphone', () => {
    const parsed = parseInboundFrame({ type: 'status', status: 'connected' });
    expect(parsed.answered).toBe(true);
    expect(parsed.status).toBe('connected');
  });

  test('status waiting is NOT answered — the phone is still ringing', () => {
    const parsed = parseInboundFrame({ type: 'status', status: 'waiting' });
    expect(parsed.answered).toBeUndefined();
    expect(parsed.status).toBe('waiting');
  });

  test('hangup ends the call', () => {
    expect(parseInboundFrame({ type: 'hangup' }).ended).toBe(true);
  });

  test('an error frame surfaces the server message', () => {
    expect(parseInboundFrame({ type: 'error', msg: 'call not found' }).errorMessage).toBe(
      'call not found',
    );
    // Server uses `msg`; tolerate `message` too rather than showing nothing.
    expect(parseInboundFrame({ type: 'error', message: 'boom' }).errorMessage).toBe('boom');
    expect(parseInboundFrame({ type: 'error' }).errorMessage).toBeTruthy();
  });

  test('the OLD Exotel envelope is not audio — it is what the server discards', () => {
    // Pinning the negative: if someone reintroduces this shape, the customer
    // hears nothing and the failure is silent on both ends.
    const parsed = parseInboundFrame({
      event: 'media',
      media: { payload: pcm16Base64([1000]) },
    });
    expect(parsed.audio).toBeUndefined();
  });

  test('a malformed payload drops one frame instead of killing the call', () => {
    const parsed = parseInboundFrame({ type: 'audio', payload: '!!!not base64!!!' });
    expect(parsed.audio).toBeUndefined();
    expect(parsed.ended).toBeUndefined();
  });

  test('ignores frames that are not objects, and unknown types', () => {
    expect(parseInboundFrame(null)).toEqual({});
    expect(parseInboundFrame('audio')).toEqual({});
    expect(parseInboundFrame(undefined)).toEqual({});
    expect(parseInboundFrame({ type: 'mark', name: 'x' })).toEqual({});
  });
});

describe('resampleTo8k', () => {
  test('passes 8 kHz input through untouched', () => {
    const input = new Float32Array([0.1, 0.2, 0.3]);
    expect(resampleTo8k(input, 8000)).toBe(input);
  });

  test('downsamples 48 kHz by six', () => {
    const input = new Float32Array(48).fill(0.5);
    expect(resampleTo8k(input, 48000)).toHaveLength(8);
  });

  test('downsamples 44.1 kHz without overrunning the source buffer', () => {
    const input = new Float32Array(441).fill(0.25);
    const out = resampleTo8k(input, 44100);
    expect(out).toHaveLength(80);
    expect(out.every((v) => Number.isFinite(v))).toBe(true);
  });
});

describe('base64ToPcmFloat32', () => {
  test('round-trips the sample values Callified sends', () => {
    const out = base64ToPcmFloat32(pcm16Base64([0, 32767, -32768]));
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(0);
    expect(out[1]).toBeCloseTo(0.99997, 4);
    expect(out[2]).toBe(-1);
  });

  test('tolerates an odd byte length rather than throwing mid-call', () => {
    expect(() => base64ToPcmFloat32(btoa('abc'))).not.toThrow();
  });
});

describe('bridgeSocketUrl', () => {
  test('builds a same-origin ws URL carrying the ticket', () => {
    const url = bridgeSocketUrl('/ws/callified-agent', 'ticket-abc');
    expect(url).toMatch(/^wss?:\/\//);
    expect(url).toContain(window.location.host);
    expect(url).toContain('/ws/callified-agent?ticket=ticket-abc');
  });

  test('defaults the path when the server did not send one', () => {
    expect(bridgeSocketUrl(undefined, 'tkt')).toContain('/ws/callified-agent?ticket=tkt');
  });

  test('url-encodes the ticket', () => {
    expect(bridgeSocketUrl('/ws/callified-agent', 'a b&c')).toContain('ticket=a%20b%26c');
  });
});

describe('BRIDGE_STATE', () => {
  test('covers the full call lifecycle the UI renders', () => {
    expect(Object.values(BRIDGE_STATE)).toEqual(
      expect.arrayContaining([
        'idle',
        'requesting-mic',
        'connecting',
        'ringing',
        'live',
        'ending',
        'ended',
        'error',
      ]),
    );
  });
});
