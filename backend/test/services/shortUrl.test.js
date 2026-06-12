/**
 * Unit tests for backend/services/shortUrl.js (slice S87).
 *
 * What this module does:
 *   Stub-mode short-URL service for SMS-channel flyer attachments.
 *   Real-mode providers (Bitly / Cloudflare / internal) land as a
 *   single-file extension once the product decision drops. Stub mode is
 *   deterministic (content-addressed via sha256 prefix) so identical
 *   buffers collapse to the same URL — good for caching, dedupe, and
 *   idempotent test assertions.
 *
 * Surface area covered:
 *   1. Module shape pin (exports + constants)
 *   2. Stub provider returns deterministic URL for identical buffer
 *   3. Different buffers → different URLs
 *   4. TTL hint flows into the stub URL query param
 *   5. Default TTL = 86400 (24h) when omitted
 *   6. Invalid TTL (NaN / negative / zero / non-number) → default
 *   7. filename + mimeType echoed verbatim
 *   8. filename / mimeType defaults when omitted
 *   9. SHORT_URL_PROVIDER unset → stub
 *  10. SHORT_URL_PROVIDER=stub → stub
 *  11. SHORT_URL_PROVIDER='   ' (whitespace) → stub
 *  12. SHORT_URL_PROVIDER=Stub (mixed case) → stub (normalised)
 *  13. SHORT_URL_PROVIDER=bitly (unimplemented) → throws with clear message
 *  14. SHORT_URL_PROVIDER=cloudflare → throws with provider name in message
 *  15. Missing buffer → throws (validation)
 *  16. Non-Buffer buffer (string / null) → throws (validation)
 *  17. source field returns 'stub' string in stub mode
 *  18. URL uses STUB_BASE_URL constant
 *  19. Provider name is lower-cased + trimmed
 *
 * Pins the contract that sequenceEngine.js SMS branch (S87 consumer)
 * consumes — both modes return the same envelope shape so the call site
 * never branches on `source`.
 */

import { describe, test, expect, afterEach, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);
const shortUrl = requireCjs('../../services/shortUrl.js');

let originalProvider;

beforeEach(() => {
  originalProvider = process.env.SHORT_URL_PROVIDER;
  delete process.env.SHORT_URL_PROVIDER;
});

afterEach(() => {
  if (typeof originalProvider === 'undefined') {
    delete process.env.SHORT_URL_PROVIDER;
  } else {
    process.env.SHORT_URL_PROVIDER = originalProvider;
  }
});

// ── module-shape pin ──────────────────────────────────────────────────

describe('shortUrl — module shape', () => {
  test('exports the documented surface', () => {
    expect(typeof shortUrl.shortenUrl).toBe('function');
    expect(typeof shortUrl.provider).toBe('function');
    expect(typeof shortUrl.buildStubUrl).toBe('function');
    expect(shortUrl.STUB_BASE_URL).toBe('https://stub-flyer.demo');
    expect(shortUrl.DEFAULT_TTL_SECONDS).toBe(86400);
  });
});

// ── stub-mode determinism ─────────────────────────────────────────────

describe('shortUrl — stub provider determinism', () => {
  test('identical buffers → identical URLs', async () => {
    const buf = Buffer.from('PDFBYTES');
    const a = await shortUrl.shortenUrl({ buffer: buf, filename: 'flyer.pdf', mimeType: 'application/pdf' });
    const b = await shortUrl.shortenUrl({ buffer: Buffer.from('PDFBYTES'), filename: 'flyer.pdf', mimeType: 'application/pdf' });
    expect(a.shortUrl).toBe(b.shortUrl);
    expect(a.source).toBe('stub');
  });

  test('different buffers → different URLs', async () => {
    const a = await shortUrl.shortenUrl({ buffer: Buffer.from('AAA'), filename: 'a.pdf', mimeType: 'application/pdf' });
    const b = await shortUrl.shortenUrl({ buffer: Buffer.from('BBB'), filename: 'b.pdf', mimeType: 'application/pdf' });
    expect(a.shortUrl).not.toBe(b.shortUrl);
  });

  test('URL uses the documented STUB_BASE_URL constant', async () => {
    const out = await shortUrl.shortenUrl({ buffer: Buffer.from('X'), filename: 'x.pdf', mimeType: 'application/pdf' });
    expect(out.shortUrl.startsWith(`${shortUrl.STUB_BASE_URL}/`)).toBe(true);
  });

  test('source field is "stub" in stub mode', async () => {
    const out = await shortUrl.shortenUrl({ buffer: Buffer.from('X') });
    expect(out.source).toBe('stub');
  });
});

// ── TTL handling ──────────────────────────────────────────────────────

describe('shortUrl — TTL handling', () => {
  test('explicit ttlSeconds flows into URL query param', async () => {
    const out = await shortUrl.shortenUrl({ buffer: Buffer.from('Y'), ttlSeconds: 3600 });
    expect(out.shortUrl).toMatch(/[?&]t=3600(?:$|&)/);
  });

  test('default ttlSeconds = 86400 when omitted', async () => {
    const out = await shortUrl.shortenUrl({ buffer: Buffer.from('Y') });
    expect(out.shortUrl).toMatch(/[?&]t=86400(?:$|&)/);
  });

  test('NaN / negative / zero / non-number ttlSeconds → default', async () => {
    const cases = [NaN, -1, 0, 'long', null, undefined];
    for (const ttl of cases) {
      const out = await shortUrl.shortenUrl({ buffer: Buffer.from('Z'), ttlSeconds: ttl });
      expect(out.shortUrl).toMatch(/[?&]t=86400(?:$|&)/);
    }
  });
});

// ── echoed descriptor fields ──────────────────────────────────────────

describe('shortUrl — descriptor field echo', () => {
  test('filename + mimeType returned verbatim', async () => {
    const out = await shortUrl.shortenUrl({
      buffer: Buffer.from('X'),
      filename: 'Umrah-Spring-42.pdf',
      mimeType: 'application/pdf',
    });
    expect(out.filename).toBe('Umrah-Spring-42.pdf');
    expect(out.mimeType).toBe('application/pdf');
  });

  test('filename + mimeType default when omitted', async () => {
    const out = await shortUrl.shortenUrl({ buffer: Buffer.from('X') });
    expect(out.filename).toBe('attachment');
    expect(out.mimeType).toBe('application/octet-stream');
  });
});

// ── provider() resolution ─────────────────────────────────────────────

describe('shortUrl — provider() resolution', () => {
  test('SHORT_URL_PROVIDER unset → stub', () => {
    delete process.env.SHORT_URL_PROVIDER;
    expect(shortUrl.provider()).toBe('stub');
  });

  test('SHORT_URL_PROVIDER=stub → stub', () => {
    process.env.SHORT_URL_PROVIDER = 'stub';
    expect(shortUrl.provider()).toBe('stub');
  });

  test('SHORT_URL_PROVIDER whitespace-only → stub', () => {
    process.env.SHORT_URL_PROVIDER = '   ';
    expect(shortUrl.provider()).toBe('stub');
  });

  test('SHORT_URL_PROVIDER mixed case → lower-cased', () => {
    process.env.SHORT_URL_PROVIDER = 'Stub';
    expect(shortUrl.provider()).toBe('stub');
    process.env.SHORT_URL_PROVIDER = 'BITLY';
    expect(shortUrl.provider()).toBe('bitly');
  });
});

// ── unimplemented-provider error path ─────────────────────────────────

describe('shortUrl — unimplemented provider error path', () => {
  test('SHORT_URL_PROVIDER=bitly → throws with clear message', async () => {
    process.env.SHORT_URL_PROVIDER = 'bitly';
    await expect(
      shortUrl.shortenUrl({ buffer: Buffer.from('X') }),
    ).rejects.toThrow(/provider 'bitly' not implemented/);
  });

  test('SHORT_URL_PROVIDER=cloudflare → throws with provider name', async () => {
    process.env.SHORT_URL_PROVIDER = 'cloudflare';
    await expect(
      shortUrl.shortenUrl({ buffer: Buffer.from('X') }),
    ).rejects.toThrow(/cloudflare/);
  });
});

// ── input validation ─────────────────────────────────────────────────

describe('shortUrl — input validation', () => {
  test('missing buffer throws', async () => {
    await expect(shortUrl.shortenUrl({})).rejects.toThrow(/buffer.*required/i);
  });

  test('null buffer throws', async () => {
    await expect(shortUrl.shortenUrl({ buffer: null })).rejects.toThrow(/buffer.*required/i);
  });

  test('string instead of Buffer throws', async () => {
    await expect(shortUrl.shortenUrl({ buffer: 'plain-string' })).rejects.toThrow(/buffer.*required/i);
  });

  test('shortenUrl called with no args throws', async () => {
    await expect(shortUrl.shortenUrl()).rejects.toThrow(/buffer.*required/i);
  });
});

// ── buildStubUrl pure-function pin ────────────────────────────────────

describe('shortUrl — buildStubUrl pure-function', () => {
  test('same buffer + ttl → same URL (deterministic)', () => {
    const buf = Buffer.from('repeatable');
    const a = shortUrl.buildStubUrl(buf, 3600);
    const b = shortUrl.buildStubUrl(buf, 3600);
    expect(a).toBe(b);
  });

  test('URL has 12-char hex hash + ttl in expected shape', () => {
    const out = shortUrl.buildStubUrl(Buffer.from('X'), 60);
    expect(out).toMatch(/^https:\/\/stub-flyer\.demo\/[0-9a-f]{12}\?t=60$/);
  });
});
