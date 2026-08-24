/**
 * callifiedAgentBridge.test.js — the browser side of the manual-call bridge.
 *
 * API_FLOW.md documents that `/ws/agent?call_sid=…` exists but not the audio
 * envelope it speaks, so `parseInboundFrame` is deliberately liberal in what
 * it accepts. That liberality is the thing worth pinning: if Callified's
 * frames arrive in any of the shapes the telephony convention produces, the
 * agent must still hear the customer, and a call that has clearly ended must
 * not be reported as live.
 */

import { describe, test, expect } from 'vitest';
import { parseInboundFrame, bridgeSocketUrl, BRIDGE_STATE } from '../utils/callifiedAgentBridge';

// "hello" as base64 — content is irrelevant, only that it decodes to bytes.
const AUDIO_B64 = btoa('hello');

describe('parseInboundFrame', () => {
  test('reads audio from the standard media.payload envelope', () => {
    const parsed = parseInboundFrame({ event: 'media', media: { payload: AUDIO_B64 } });
    expect(parsed.audio).toBeInstanceOf(Uint8Array);
    expect(parsed.audio.length).toBe(5);
  });

  test('also reads audio from the bare payload / audio variants', () => {
    expect(parseInboundFrame({ event: 'media', payload: AUDIO_B64 }).audio).toHaveLength(5);
    expect(parseInboundFrame({ event: 'media', audio: AUDIO_B64 }).audio).toHaveLength(5);
    expect(parseInboundFrame({ event: 'media', media: { audio: AUDIO_B64 } }).audio).toHaveLength(5);
  });

  test('adopts the media format the server announces', () => {
    const parsed = parseInboundFrame({
      event: 'start',
      start: { media_format: { encoding: 'audio/x-mulaw', sample_rate: 8000, channels: 1 } },
    });
    expect(parsed.mediaFormat).toEqual({
      encoding: 'audio/x-mulaw',
      sampleRate: 8000,
      channels: 1,
    });
  });

  test('falls back to the PCM defaults when the format is partially specified', () => {
    const parsed = parseInboundFrame({ event: 'connected', media_format: {} });
    expect(parsed.mediaFormat).toEqual({
      encoding: 'audio/l16',
      sampleRate: 8000,
      channels: 1,
    });
  });

  test('treats stop / hangup / disconnected as the end of the call', () => {
    for (const event of ['stop', 'hangup', 'disconnected']) {
      expect(parseInboundFrame({ event }).ended).toBe(true);
    }
  });

  test('treats terminal call statuses as ended, not as answered', () => {
    for (const status of ['completed', 'failed', 'busy', 'no-answer', 'canceled']) {
      const parsed = parseInboundFrame({ event: 'status', status });
      expect(parsed.ended).toBe(true);
      expect(parsed.answered).toBeUndefined();
    }
  });

  test('recognises the answered statuses that mean the customer picked up', () => {
    for (const status of ['answered', 'in-progress', 'connected', 'live']) {
      expect(parseInboundFrame({ event: 'status', status }).answered).toBe(true);
    }
  });

  test('a malformed base64 payload drops one frame instead of killing the call', () => {
    const parsed = parseInboundFrame({ event: 'media', media: { payload: '!!!not base64!!!' } });
    expect(parsed.audio).toBeUndefined();
    expect(parsed.ended).toBeUndefined();
  });

  test('ignores frames that are not objects', () => {
    expect(parseInboundFrame(null)).toEqual({});
    expect(parseInboundFrame('media')).toEqual({});
    expect(parseInboundFrame(undefined)).toEqual({});
  });

  test('an unknown event with no payload changes nothing', () => {
    expect(parseInboundFrame({ event: 'mark', name: 'x' })).toEqual({});
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
