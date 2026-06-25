// destinationPhotos — keyless Wikipedia photo resolver.
// Verifies the title resolution (curated override + cleaning) and that the
// fetcher pulls the lead-image URL, follows the page-id shape, and degrades to
// null on miss/error — all with an injected fetch stub (no real network).
import { describe, it, expect, vi } from 'vitest';
import { wikiTitleFor, fetchDestinationPhoto, fetchDestinationGallery } from '../utils/destinationPhotos';

describe('wikiTitleFor', () => {
  it('uses the curated wiki title when known', () => {
    expect(wikiTitleFor('Makkah')).toBe('Mecca');     // curated override
    expect(wikiTitleFor('Banaras')).toBe('Varanasi'); // alias → curated title
  });
  it('cleans an unknown destination to its first segment', () => {
    expect(wikiTitleFor('Reykjavik, Iceland')).toBe('Reykjavik');
    expect(wikiTitleFor('Quito (Old Town)')).toBe('Quito');
  });
  it('returns null for empty input', () => {
    expect(wikiTitleFor('')).toBeNull();
  });
});

function okJson(body) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
}

describe('fetchDestinationPhoto', () => {
  it('returns the lead-image URL from the Wikipedia pageimages response', async () => {
    const fetchImpl = vi.fn(() => okJson({
      query: { pages: { 123: { title: 'Tokyo', thumbnail: { source: 'https://upload.wikimedia.org/tokyo.jpg' } } } },
    }));
    const url = await fetchDestinationPhoto('Tokyo', { fetchImpl });
    expect(url).toBe('https://upload.wikimedia.org/tokyo.jpg');
    // Hits the CORS-enabled action API with redirects + a hero-sized thumb.
    const calledUrl = fetchImpl.mock.calls[0][0];
    expect(calledUrl).toContain('en.wikipedia.org/w/api.php');
    expect(calledUrl).toContain('origin=*'); // CORS-enabled
    expect(calledUrl).toContain('redirects=1');
  });

  it('returns null when the page has no image', async () => {
    const fetchImpl = vi.fn(() => okJson({ query: { pages: { '-1': { title: 'Nowhere', missing: '' } } } }));
    expect(await fetchDestinationPhoto('Nowhere', { fetchImpl })).toBeNull();
  });

  it('resolves to a city photo when the destination contains a curated city name', async () => {
    // "Iskon Bangalore" — "Bangalore" is in the curated list so it appears as
    // the first candidate and resolves immediately without trying the full phrase.
    const fetchImpl = vi.fn((u) =>
      /titles=Bangalore/.test(u)
        ? okJson({ query: { pages: { 44: { title: 'Bengaluru', thumbnail: { source: 'https://up/blr.jpg' } } } } })
        : okJson({ query: { pages: { '-1': { title: 'Iskon Bangalore', missing: '' } } } }),
    );
    expect(await fetchDestinationPhoto('Iskon Bangalore', { fetchImpl })).toBe('https://up/blr.jpg');
    // At least one call must have resolved the Bangalore article.
    expect(fetchImpl.mock.calls.some((args) => /titles=Bangalore/.test(args[0]))).toBe(true);
  });

  it('returns null (never throws) on network/HTTP error', async () => {
    expect(await fetchDestinationPhoto('Tokyo', { fetchImpl: () => Promise.reject(new Error('offline')) })).toBeNull();
    expect(await fetchDestinationPhoto('Tokyo', { fetchImpl: () => Promise.resolve({ ok: false }) })).toBeNull();
  });

  it('returns null for an empty destination without fetching', async () => {
    const fetchImpl = vi.fn();
    expect(await fetchDestinationPhoto('', { fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('fetchDestinationGallery', () => {
  it('returns showInGallery photos from the REST media-list endpoint, respecting the limit', async () => {
    const fetchImpl = vi.fn(() => okJson({
      items: [
        { type: 'image', showInGallery: true,  title: 'File:Paris_view.jpg',   thumbnail: { source: 'https://up/paris-view.jpg' },  caption: { text: 'Paris view' } },
        { type: 'image', showInGallery: false, title: 'File:Flag_of_France.svg', thumbnail: { source: 'https://up/flag.svg' } },
        { type: 'image', showInGallery: false, title: 'File:Paris_map.png',    thumbnail: { source: 'https://up/map.png' } },
        { type: 'image', showInGallery: true,  title: 'File:Eiffel_Tower.jpeg', thumbnail: { source: 'https://up/eiffel.jpeg' } },
        { type: 'image', showInGallery: true,  title: 'File:Louvre.jpg',       thumbnail: { source: 'https://up/louvre.jpg' } },
      ],
    }));
    const items = await fetchDestinationGallery('Paris', { fetchImpl, limit: 2 });
    // showInGallery:false items dropped; capped at 2; description is null when
    // caption.text is supplied by the REST API directly.
    expect(items).toEqual([
      { url: 'https://up/paris-view.jpg', caption: 'Paris view', description: null },
      { url: 'https://up/eiffel.jpeg', caption: 'Eiffel Tower', description: null },
    ]);
    // Uses the REST media-list endpoint, not the action API.
    const calledUrl = fetchImpl.mock.calls[0][0];
    expect(calledUrl).toContain('en.wikipedia.org/api/rest_v1/page/media-list/');
  });

  it('normalises protocol-relative thumbnail URLs to https', async () => {
    const fetchImpl = vi.fn(() => okJson({
      items: [
        { type: 'image', showInGallery: true, title: 'File:Tokyo.jpg', thumbnail: { source: '//upload.wikimedia.org/thumb/tokyo.jpg' } },
      ],
    }));
    const items = await fetchDestinationGallery('Tokyo', { fetchImpl });
    expect(items[0].url).toBe('https://upload.wikimedia.org/thumb/tokyo.jpg');
  });

  it('falls back to captionFromFileTitle when caption.text is absent', async () => {
    const fetchImpl = vi.fn(() => okJson({
      items: [{ type: 'image', showInGallery: true, title: 'File:Kolkata_Howrah_Bridge.jpg', thumbnail: { source: 'https://up/howrah.jpg' } }],
    }));
    const items = await fetchDestinationGallery('Kolkata', { fetchImpl });
    expect(items[0].caption).toBe('Kolkata Howrah Bridge');
  });

  it('returns [] on error / empty / no destination', async () => {
    expect(await fetchDestinationGallery('Paris', { fetchImpl: () => Promise.reject(new Error('x')) })).toEqual([]);
    expect(await fetchDestinationGallery('Paris', { fetchImpl: () => okJson({}) })).toEqual([]);
    const fetchImpl = vi.fn();
    expect(await fetchDestinationGallery('', { fetchImpl })).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
