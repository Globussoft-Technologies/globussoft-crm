// Unit tests for backend/lib/brandLogo.js — the brand-logo resolver used by
// PDF headers. Resolution order: remote S3/HTTP → local /uploads → bundled
// asset → null. We mock fs + global.fetch. (We do NOT delete the module from
// the require cache mid-test: re-requiring while fs.readFileSync is mocked
// crashes Node's own module loader.)
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const fs = requireCJS('fs');
const { resolveBrandLogoBuffer } = requireCJS('../../lib/brandLogo');

const prevFetch = global.fetch;
beforeEach(() => {
  global.fetch = vi.fn();
});
afterEach(() => {
  global.fetch = prevFetch;
  vi.restoreAllMocks();
});

describe('resolveBrandLogoBuffer', () => {
  test('fetches a remote S3/HTTP URL into a Buffer (S3 is the source of truth)', async () => {
    global.fetch.mockResolvedValue({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
    const buf = await resolveBrandLogoBuffer('https://s3.example.com/logo.png');
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBe(3);
  });

  test('reads a local /uploads path off disk when the URL is not remote', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('local-logo'));
    const buf = await resolveBrandLogoBuffer('/uploads/branding/tenant-2/logo.png');
    expect(buf.toString()).toBe('local-logo');
  });

  test('returns null when the remote fails and no bundled asset exists', async () => {
    global.fetch.mockResolvedValue({ ok: false });
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const buf = await resolveBrandLogoBuffer('https://s3.example.com/logo.png');
    expect(buf).toBeNull();
  });
});
