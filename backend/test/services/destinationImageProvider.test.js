// PR-E Phase 2.1 — vitest coverage for the destination image provider
// abstraction and the per-provider normalization.

import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';

const provider = require('../../services/destinationImageProvider');
const unsplashProvider = require('../../services/imageProviders/unsplashProvider');
const pexelsProvider = require('../../services/imageProviders/pexelsProvider');
const pixabayProvider = require('../../services/imageProviders/pixabayProvider');
const aiImageFallbackProvider = require('../../services/imageProviders/aiImageFallbackProvider');

beforeEach(() => {
  provider._resetForTests();
  // Clear env keys between tests so isAvailable() flips predictably.
  delete process.env.UNSPLASH_ACCESS_KEY;
  delete process.env.PEXELS_API_KEY;
  delete process.env.PIXABAY_API_KEY;
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('provider hierarchy + fallback', () => {
  test('PROVIDERS is the 4 declared providers in priority order', () => {
    // Pexels is primary per ops decision 2026-06-24 (the only stock
    // provider with a configured key on demo). Unsplash + Pixabay stay
    // in the chain as defensive fallbacks; ai-fallback lands last.
    expect(provider.PROVIDERS.map((p) => p.id)).toEqual([
      'pexels', 'unsplash', 'pixabay', 'ai-fallback',
    ]);
  });

  test('Unsplash isAvailable() is false without UNSPLASH_ACCESS_KEY', () => {
    expect(unsplashProvider.isAvailable()).toBe(false);
  });

  test('Unsplash isAvailable() is true when UNSPLASH_ACCESS_KEY set', () => {
    process.env.UNSPLASH_ACCESS_KEY = 'test-key';
    expect(unsplashProvider.isAvailable()).toBe(true);
  });

  test('Pexels isAvailable() respects PEXELS_API_KEY env var', () => {
    expect(pexelsProvider.isAvailable()).toBe(false);
    process.env.PEXELS_API_KEY = 'test-key';
    expect(pexelsProvider.isAvailable()).toBe(true);
  });

  test('Pixabay isAvailable() is ALWAYS true (anonymous tier guarantees fallback)', () => {
    expect(pixabayProvider.isAvailable()).toBe(true);
  });

  test('AI fallback isAvailable() is ALWAYS true (budget-gated internally)', () => {
    expect(aiImageFallbackProvider.isAvailable()).toBe(true);
  });
});

describe('per-provider orientation mapping', () => {
  test('Unsplash maps aspectRatio → orientation', () => {
    expect(unsplashProvider._pickOrientation('4:3')).toBe('landscape');
    expect(unsplashProvider._pickOrientation('3:4')).toBe('portrait');
    expect(unsplashProvider._pickOrientation('1:1')).toBe('squarish');
    expect(unsplashProvider._pickOrientation()).toBe('landscape');
  });

  test('Pexels maps aspectRatio → orientation', () => {
    expect(pexelsProvider._pickOrientation('16:9')).toBe('landscape');
    expect(pexelsProvider._pickOrientation('3:4')).toBe('portrait');
    expect(pexelsProvider._pickOrientation('1:1')).toBe('square');
  });

  test('Pixabay maps aspectRatio → orientation', () => {
    expect(pixabayProvider._pickOrientation('4:3')).toBe('horizontal');
    expect(pixabayProvider._pickOrientation('3:4')).toBe('vertical');
    expect(pixabayProvider._pickOrientation()).toBe('all');
  });
});

describe('per-provider normalization', () => {
  test('Unsplash normalize handles full API response shape', () => {
    const raw = {
      urls: { regular: 'https://images.unsplash.com/photo-x.jpg', thumb: 'https://images.unsplash.com/thumb-x.jpg' },
      width: 1200, height: 900,
      user: { name: 'Jane Doe', links: { html: 'https://unsplash.com/@jane' } },
      links: { html: 'https://unsplash.com/photos/x' },
    };
    const out = unsplashProvider._normalize(raw);
    expect(out.url).toBe('https://images.unsplash.com/photo-x.jpg');
    expect(out.attribution.photographer).toBe('Jane Doe');
    expect(out.attribution.providerId).toBe('unsplash');
    expect(out.attribution.license).toBe('unsplash-license');
  });

  test('Unsplash normalize returns null for malformed response', () => {
    expect(unsplashProvider._normalize(null)).toBeNull();
    expect(unsplashProvider._normalize({})).toBeNull();
    expect(unsplashProvider._normalize({ urls: null })).toBeNull();
  });

  test('Pexels normalize handles full API response shape', () => {
    const raw = {
      src: { large2x: 'https://images.pexels.com/photo-x-large2x.jpg', medium: 'https://images.pexels.com/photo-x-med.jpg' },
      width: 1500, height: 1000,
      photographer: 'John Smith',
      photographer_url: 'https://www.pexels.com/@john',
      url: 'https://www.pexels.com/photo/x/',
    };
    const out = pexelsProvider._normalize(raw);
    expect(out.url).toBe('https://images.pexels.com/photo-x-large2x.jpg');
    expect(out.attribution.photographer).toBe('John Smith');
    expect(out.attribution.providerId).toBe('pexels');
  });

  test('Pixabay normalize handles full API response shape', () => {
    const raw = {
      largeImageURL: 'https://pixabay.com/photo-x.jpg',
      previewURL: 'https://pixabay.com/preview-x.jpg',
      imageWidth: 1200, imageHeight: 900,
      user: 'pixabay_user', user_id: 12345,
      pageURL: 'https://pixabay.com/photos/x-12345/',
    };
    const out = pixabayProvider._normalize(raw);
    expect(out.url).toBe('https://pixabay.com/photo-x.jpg');
    expect(out.attribution.providerId).toBe('pixabay');
    expect(out.attribution.photographer).toBe('pixabay_user');
  });
});

describe('fetchOne — fallback hierarchy behaviour', () => {
  test('skips unavailable providers, lands on first available with results', async () => {
    process.env.PIXABAY_API_KEY = ''; // anonymous mode
    // Mock Pixabay to return one result; all others naturally unavailable.
    vi.spyOn(pixabayProvider, 'search').mockResolvedValue([
      { url: 'https://pix.example/photo.jpg', thumbUrl: 'https://pix.example/thumb.jpg', width: 1200, height: 900, attribution: { providerId: 'pixabay', photographer: 'X', license: 'pixabay-license' } },
    ]);
    const result = await provider.fetchOne('Iceland aurora');
    expect(result).toBeTruthy();
    expect(result.url).toContain('pix.example');
    expect(result.attribution.providerId).toBe('pixabay');
  });

  test('returns null when ALL providers return no results', async () => {
    vi.spyOn(unsplashProvider, 'search').mockResolvedValue([]);
    vi.spyOn(pexelsProvider, 'search').mockResolvedValue([]);
    vi.spyOn(pixabayProvider, 'search').mockResolvedValue([]);
    vi.spyOn(aiImageFallbackProvider, 'search').mockResolvedValue([]);
    const result = await provider.fetchOne('some query');
    expect(result).toBeNull();
  });

  test('returns null on empty query', async () => {
    const result = await provider.fetchOne('');
    expect(result).toBeNull();
  });

  test('Pexels wins when available + has results (primary provider)', async () => {
    process.env.UNSPLASH_ACCESS_KEY = 'test-key';
    process.env.PEXELS_API_KEY = 'test-key';
    vi.spyOn(pexelsProvider, 'search').mockResolvedValue([
      { url: 'https://pexels.example/photo.jpg', attribution: { providerId: 'pexels' } },
    ]);
    vi.spyOn(unsplashProvider, 'search').mockResolvedValue([
      { url: 'https://unsplash.example/photo.jpg', attribution: { providerId: 'unsplash' } },
    ]);
    const result = await provider.fetchOne('Iceland');
    expect(result.attribution.providerId).toBe('pexels');
  });

  test('Falls through Pexels → Unsplash when Pexels empty', async () => {
    process.env.UNSPLASH_ACCESS_KEY = 'test-key';
    process.env.PEXELS_API_KEY = 'test-key';
    vi.spyOn(pexelsProvider, 'search').mockResolvedValue([]);
    vi.spyOn(unsplashProvider, 'search').mockResolvedValue([
      { url: 'https://unsplash.example/photo.jpg', attribution: { providerId: 'unsplash' } },
    ]);
    const result = await provider.fetchOne('Bali');
    expect(result.attribution.providerId).toBe('unsplash');
  });

  test('excludeProviders option skips named providers', async () => {
    process.env.UNSPLASH_ACCESS_KEY = 'test-key';
    vi.spyOn(unsplashProvider, 'search').mockResolvedValue([
      { url: 'https://unsplash.example/photo.jpg', attribution: { providerId: 'unsplash' } },
    ]);
    vi.spyOn(pixabayProvider, 'search').mockResolvedValue([
      { url: 'https://pix.example/photo.jpg', attribution: { providerId: 'pixabay' } },
    ]);
    const result = await provider.fetchOne('Iceland', { excludeProviders: ['unsplash'] });
    expect(result.attribution.providerId).toBe('pixabay');
  });
});

describe('fetchMany — gallery (public destination-photo proxy)', () => {
  test('returns up to `limit` distinct images across the cascade', async () => {
    process.env.PEXELS_API_KEY = 'test-key';
    vi.spyOn(pexelsProvider, 'search').mockResolvedValue([
      { url: 'https://pexels.example/a.jpg', thumbUrl: 'https://pexels.example/a-t.jpg', attribution: { providerId: 'pexels', photographer: 'A' } },
      { url: 'https://pexels.example/b.jpg', attribution: { providerId: 'pexels', photographer: 'B' } },
      { url: 'https://pexels.example/a.jpg', attribution: { providerId: 'pexels', photographer: 'A' } }, // dup URL — dropped
    ]);
    const out = await provider.fetchMany('Srinagar', { limit: 5 });
    expect(out.map((r) => r.url)).toEqual([
      'https://pexels.example/a.jpg',
      'https://pexels.example/b.jpg',
    ]);
  });

  test('EXCLUDES the AI fallback by default (stock-only for customer pages)', async () => {
    // No stock keys → pexels/unsplash unavailable; pixabay anonymous returns [].
    vi.spyOn(pixabayProvider, 'search').mockResolvedValue([]);
    const aiSpy = vi.spyOn(aiImageFallbackProvider, 'search').mockResolvedValue([
      { url: 'https://ai.example/generated.png', attribution: { providerId: 'ai-fallback' } },
    ]);
    const out = await provider.fetchMany('Nowhere-ville');
    expect(out).toEqual([]);            // did NOT fall through to AI generation
    expect(aiSpy).not.toHaveBeenCalled();
  });

  test('clamps limit to the 1..30 range and returns [] on empty query', async () => {
    expect(await provider.fetchMany('')).toEqual([]);
    process.env.PEXELS_API_KEY = 'test-key';
    const spy = vi.spyOn(pexelsProvider, 'search').mockResolvedValue([]);
    await provider.fetchMany('Goa', { limit: 999 });
    expect(spy.mock.calls[0][1].perPage).toBe(30); // clamped to MAX
  });
});

describe('cache behaviour', () => {
  test('cache hit returns the cached envelope without re-calling the provider', async () => {
    vi.spyOn(pixabayProvider, 'search').mockResolvedValue([
      { url: 'https://pix.example/photo.jpg', attribution: { providerId: 'pixabay' } },
    ]);
    const first = await provider.fetchOne('Bali');
    const second = await provider.fetchOne('Bali');
    expect(first.url).toBe(second.url);
    // Provider called exactly once (cache hit on second).
    expect(pixabayProvider.search).toHaveBeenCalledTimes(1);
  });

  test('cache key varies by aspectRatio', () => {
    const k1 = provider._cacheKey('unsplash', 'Iceland', { aspectRatio: '4:3' });
    const k2 = provider._cacheKey('unsplash', 'Iceland', { aspectRatio: '3:4' });
    expect(k1).not.toBe(k2);
  });

  test('cache bounded — evicts oldest entries past MAX_ENTRIES', () => {
    provider._resetForTests();
    for (let i = 0; i < 5100; i++) {
      provider._cache.set(`key-${i}`, { url: `u${i}` });
    }
    expect(provider._cache.size()).toBeLessThanOrEqual(5000);
  });
});

describe('fetchStrategy — full TeeOutput.imageStrategy', () => {
  test('fetches hero + marquee[] + brochure in parallel', async () => {
    // Pixabay returns DIFFERENT URLs per query so the dedup pass in
    // fetchStrategy() doesn't trigger — this test exercises the happy
    // path, not the dedup path (covered by the "dedup across slots"
    // test below).
    let counter = 0;
    vi.spyOn(pixabayProvider, 'search').mockImplementation(() => {
      counter += 1;
      return Promise.resolve([
        { url: `https://pix.example/img-${counter}.jpg`, attribution: { providerId: 'pixabay' } },
      ]);
    });
    const strategy = {
      hero: { query: 'Iceland aurora', aspectRatio: '4:3' },
      marquee: [
        { slot: 0, query: 'Reykjavik morning' },
        { slot: 1, query: 'Vik basalt' },
        { slot: 2, query: 'Hofn icebergs' },
      ],
      brochure: { query: 'Iceland glacier hike', aspectRatio: '4:5' },
      cultural: [],
    };
    const result = await provider.fetchStrategy(strategy);
    expect(result.hero).toBeTruthy();
    expect(result.hero.url).toContain('pix.example');
    expect(result.marquee.length).toBe(3);
    expect(result.marquee[0].image.url).toContain('pix.example');
    expect(result.brochure.url).toContain('pix.example');
  });

  test('dedup across slots — when a provider returns the same top image for two queries, the second slot picks the next candidate', async () => {
    process.env.PEXELS_API_KEY = 'test-key';
    // Pexels returns the same 2-result list for every query — the dedup
    // pass should pick result[0] for slot 0 and result[1] for slot 1.
    vi.spyOn(pexelsProvider, 'search').mockResolvedValue([
      { url: 'https://pex.example/dup-a.jpg', attribution: { providerId: 'pexels' } },
      { url: 'https://pex.example/dup-b.jpg', attribution: { providerId: 'pexels' } },
    ]);
    const result = await provider.fetchStrategy({
      hero: { query: 'h', aspectRatio: '4:3' },
      marquee: [
        { slot: 0, query: 'm0' },
        { slot: 1, query: 'm1' },
      ],
      brochure: { query: 'b', aspectRatio: '4:5' },
      cultural: [],
    });
    const urls = [
      result.hero?.url,
      result.marquee[0].image?.url,
      result.marquee[1].image?.url,
      result.brochure?.url,
    ].filter(Boolean);
    // Every used URL is unique within the page.
    expect(new Set(urls).size).toBe(urls.length);
  });

  test('empty marquee + empty cultural arrays handled gracefully', async () => {
    vi.spyOn(pixabayProvider, 'search').mockResolvedValue([
      { url: 'https://pix.example/img.jpg', attribution: { providerId: 'pixabay' } },
    ]);
    const result = await provider.fetchStrategy({
      hero: { query: 'X' },
      marquee: [],
      cultural: [],
      brochure: { query: 'Y' },
    });
    expect(result.marquee).toEqual([]);
    expect(result.cultural).toEqual([]);
    expect(result.hero.url).toBeTruthy();
    expect(result.brochure.url).toBeTruthy();
  });

  test('slot with empty query yields null image (no fetch)', async () => {
    const searchSpy = vi.spyOn(pixabayProvider, 'search').mockResolvedValue([]);
    const result = await provider.fetchStrategy({
      hero: { query: '' },
      marquee: [{ slot: 0, query: '' }],
      brochure: { query: '' },
    });
    expect(result.hero).toBeNull();
    expect(result.marquee[0].image).toBeNull();
    expect(result.brochure).toBeNull();
    // No provider calls made.
    expect(searchSpy).not.toHaveBeenCalled();
  });
});

describe('applyImagesToContent — bridge into LandingPage.content', () => {
  test('writes hero + marquee + brochure URLs + attribution _tee block', () => {
    const content = {
      hero: { headline: 'X' },
      marquee: { cities: [{ tag: 'A', title: 'A' }, { tag: 'B', title: 'B' }] },
      brochure: { show: true },
    };
    const fetched = {
      hero: { url: 'https://u.example/hero.jpg', attribution: { providerId: 'unsplash', photographer: 'Jane' } },
      marquee: [
        { slot: 0, image: { url: 'https://u.example/m0.jpg', attribution: { providerId: 'unsplash' } } },
        { slot: 1, image: null }, // gracefully handled
      ],
      brochure: { url: 'https://u.example/bro.jpg', attribution: { providerId: 'unsplash' } },
      cultural: [],
    };
    const out = provider.applyImagesToContent(content, fetched);
    expect(out.hero.posterUrl).toBe('https://u.example/hero.jpg');
    expect(out.hero.posterAlt).toContain('Jane');
    expect(out.marquee.cities[0].img).toBe('https://u.example/m0.jpg');
    expect(out.marquee.cities[1].img).toBeUndefined(); // null image preserved
    expect(out.brochure.coverUrl).toBe('https://u.example/bro.jpg');
    expect(out._tee.images).toBeTruthy();
    expect(out._tee.images.hero.providerId).toBe('unsplash');
    expect(out._tee.images.hero.photographer).toBe('Jane');
    expect(out._tee.images.marquee[0].providerId).toBe('unsplash');
    expect(out._tee.images.marquee[1]).toBeNull();
  });

  test('preserves operator-uploaded URLs (anything starting with /uploads/)', () => {
    const content = {
      hero: { posterUrl: '/uploads/landing-page-images/tenant-1/my-hero.jpg' },
      marquee: { cities: [{ img: '/uploads/landing-page-images/tenant-1/ubud.jpg' }, { img: null }] },
    };
    const fetched = {
      hero: { url: 'https://u.example/hero.jpg', attribution: { providerId: 'unsplash' } },
      marquee: [
        { slot: 0, image: { url: 'https://u.example/m0.jpg', attribution: { providerId: 'unsplash' } } },
        { slot: 1, image: { url: 'https://u.example/m1.jpg', attribution: { providerId: 'unsplash' } } },
      ],
      brochure: null,
      cultural: [],
    };
    const out = provider.applyImagesToContent(content, fetched);
    // Operator hero stays; operator marquee[0] stays; TEE-fetched marquee[1] applied.
    expect(out.hero.posterUrl).toBe('/uploads/landing-page-images/tenant-1/my-hero.jpg');
    expect(out.marquee.cities[0].img).toBe('/uploads/landing-page-images/tenant-1/ubud.jpg');
    expect(out.marquee.cities[1].img).toBe('https://u.example/m1.jpg');
  });

  test('isOperatorOwned recognizes /uploads/ paths and external URLs', () => {
    expect(provider.isOperatorOwned('/api/uploads/landing-page-images/x.jpg')).toBe(true);
    expect(provider.isOperatorOwned('/uploads/landing-page-images/x.jpg')).toBe(true);
    expect(provider.isOperatorOwned('https://images.unsplash.com/x.jpg')).toBe(false);
    expect(provider.isOperatorOwned('')).toBe(false);
    expect(provider.isOperatorOwned(null)).toBe(false);
  });

  test('always stores _tee.images attribution metadata (Q3: always-store)', () => {
    const content = { hero: {} };
    const fetched = {
      hero: { url: 'https://u.example/x.jpg', attribution: { providerId: 'unsplash', photographer: 'X', license: 'unsplash-license' } },
      marquee: [], cultural: [], brochure: null,
    };
    const out = provider.applyImagesToContent(content, fetched);
    expect(out._tee.images.hero.providerId).toBe('unsplash');
    expect(out._tee.images.hero.license).toBe('unsplash-license');
    expect(typeof out._tee.images.fetchedAt).toBe('string');
  });
});
