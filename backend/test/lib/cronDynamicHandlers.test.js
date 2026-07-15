/**
 * Unit tests for backend/lib/cronDynamicHandlers.js — the fixed, safe
 * handler set for admin-created dynamic crons.
 *
 * Pinned:
 *   - VALID_HANDLER_KEYS / isValidHandlerKey reflect exactly the HANDLERS map.
 *   - http_webhook_ping: requires metadata.url; rejects non-URL strings;
 *     rejects non-http(s) protocols; refuses localhost/127.0.0.1/0.0.0.0/::1
 *     (SSRF guard); happy path calls fetch with the right method/headers/body;
 *     throws on a non-ok response.
 *   - log_note: always succeeds, echoes the message (or a default).
 *   - buildDynamicTickFn: throws synchronously on an unknown handlerKey or
 *     malformed metadataJson (fail-fast at registration, not per-tick);
 *     the returned tickFn correctly delegates to the resolved handler with
 *     the parsed metadata.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  HANDLERS,
  VALID_HANDLER_KEYS,
  isValidHandlerKey,
  getHandler,
  getHandlerCatalog,
  buildDynamicTickFn,
} from '../../lib/cronDynamicHandlers.js';

describe('module shape', () => {
  test('VALID_HANDLER_KEYS matches the HANDLERS map keys', () => {
    expect(VALID_HANDLER_KEYS.sort()).toEqual(Object.keys(HANDLERS).sort());
  });

  test('isValidHandlerKey', () => {
    expect(isValidHandlerKey('http_webhook_ping')).toBe(true);
    expect(isValidHandlerKey('log_note')).toBe(true);
    expect(isValidHandlerKey('rm_rf_slash')).toBe(false);
  });

  test('getHandler returns the handler entry or null', () => {
    expect(getHandler('http_webhook_ping')).toBe(HANDLERS.http_webhook_ping);
    expect(getHandler('log_note')).toBe(HANDLERS.log_note);
    expect(getHandler('not_real')).toBe(null);
  });

  test('getHandlerCatalog exposes label/description/schema for each handler', () => {
    const catalog = getHandlerCatalog();
    expect(catalog.map((h) => h.key).sort()).toEqual(VALID_HANDLER_KEYS.sort());
    const ping = catalog.find((h) => h.key === 'http_webhook_ping');
    expect(ping.label).toBeTruthy();
    expect(ping.description).toContain('URL');
    expect(ping.metadataSchema).toBeDefined();
  });
});

describe('http_webhook_ping', () => {
  let fetchMock;
  const originalFetch = global.fetch;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('throws when metadata.url is missing', async () => {
    await expect(HANDLERS.http_webhook_ping.fn({})).rejects.toThrow(/requires metadata.url/);
  });

  test('throws on a malformed URL string', async () => {
    await expect(HANDLERS.http_webhook_ping.fn({ url: 'not a url' })).rejects.toThrow(/not a valid URL/);
  });

  test('rejects non-http(s) protocols', async () => {
    await expect(HANDLERS.http_webhook_ping.fn({ url: 'file:///etc/passwd' })).rejects.toThrow(/unsupported protocol/);
  });

  test.each(['http://localhost/x', 'http://127.0.0.1/x', 'http://0.0.0.0/x', 'http://[::1]/x'])(
    'refuses internal host %s (SSRF guard)',
    async (url) => {
      await expect(HANDLERS.http_webhook_ping.fn({ url })).rejects.toThrow(/refusing to ping internal host/);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  test('happy path POSTs with JSON content-type + the given body', async () => {
    const result = await HANDLERS.http_webhook_ping.fn({
      url: 'https://example.com/webhook',
      bodyJson: '{"hello":"world"}',
    });
    expect(result).toEqual({ ok: true, status: 200 });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/webhook',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'content-type': 'application/json' }),
        body: '{"hello":"world"}',
      }),
    );
  });

  test('GET method sends no body', async () => {
    await HANDLERS.http_webhook_ping.fn({ url: 'https://example.com/x', method: 'GET' });
    expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
  });

  test('merges custom headersJson on top of the default content-type', async () => {
    await HANDLERS.http_webhook_ping.fn({
      url: 'https://example.com/x',
      headersJson: '{"authorization":"Bearer xyz"}',
    });
    expect(fetchMock.mock.calls[0][1].headers).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer xyz',
    });
  });

  test('malformed headersJson throws', async () => {
    await expect(
      HANDLERS.http_webhook_ping.fn({ url: 'https://example.com/x', headersJson: '{not json' }),
    ).rejects.toThrow(/headersJson is not valid JSON/);
  });

  test('a non-ok response throws with the status code', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 });
    await expect(HANDLERS.http_webhook_ping.fn({ url: 'https://example.com/x' })).rejects.toThrow(/responded 503/);
  });
});

describe('log_note', () => {
  test('echoes the given message', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await HANDLERS.log_note.fn({ message: 'hello from a dynamic cron' });
    expect(result).toEqual({ ok: true, message: 'hello from a dynamic cron' });
    logSpy.mockRestore();
  });

  test('falls back to a default message when none is given', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await HANDLERS.log_note.fn({});
    expect(result.message).toBe('(no message)');
    logSpy.mockRestore();
  });
});

describe('buildDynamicTickFn', () => {
  test('throws synchronously on an unknown handlerKey', () => {
    expect(() => buildDynamicTickFn('not_a_real_handler', null)).toThrow(/Unknown handlerKey/);
  });

  test('throws synchronously on malformed metadataJson (fail-fast at registration)', () => {
    expect(() => buildDynamicTickFn('log_note', '{not json')).toThrow(/metadataJson is not valid JSON/);
  });

  test('the returned tickFn delegates to the resolved handler with parsed metadata', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const tickFn = buildDynamicTickFn('log_note', '{"message":"parsed ok"}');
    const result = await tickFn();
    expect(result).toEqual({ ok: true, message: 'parsed ok' });
    logSpy.mockRestore();
  });

  test('an absent metadataJson defaults to an empty object (no throw)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const tickFn = buildDynamicTickFn('log_note', null);
    const result = await tickFn();
    expect(result.message).toBe('(no message)');
    logSpy.mockRestore();
  });
});
