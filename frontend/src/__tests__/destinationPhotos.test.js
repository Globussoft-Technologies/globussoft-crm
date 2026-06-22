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
  it('returns real photo URLs, filtering out flags/maps/SVGs, respecting the limit', async () => {
    const fetchImpl = vi.fn(() => okJson({
      query: { pages: {
        1: { title: 'File:Paris view.jpg', imageinfo: [{ thumburl: 'https://up/paris-view.jpg' }] },
        2: { title: 'File:Flag of France.svg', imageinfo: [{ thumburl: 'https://up/flag.svg' }] },
        3: { title: 'File:Paris locator map.png', imageinfo: [{ thumburl: 'https://up/map.png' }] },
        4: { title: 'File:Eiffel Tower.jpeg', imageinfo: [{ thumburl: 'https://up/eiffel.jpeg' }] },
        5: { title: 'File:Louvre.jpg', imageinfo: [{ thumburl: 'https://up/louvre.jpg' }] },
      } },
    }));
    const items = await fetchDestinationGallery('Paris', { fetchImpl, limit: 2 });
    // flag + map dropped, capped at 2, each carries a place-name caption.
    expect(items).toEqual([
      { url: 'https://up/paris-view.jpg', caption: 'Paris view', description: null },
      { url: 'https://up/eiffel.jpeg', caption: 'Eiffel Tower', description: null },
    ]);
  });

  it('returns [] on error / empty / no destination', async () => {
    expect(await fetchDestinationGallery('Paris', { fetchImpl: () => Promise.reject(new Error('x')) })).toEqual([]);
    expect(await fetchDestinationGallery('Paris', { fetchImpl: () => okJson({}) })).toEqual([]);
    const fetchImpl = vi.fn();
    expect(await fetchDestinationGallery('', { fetchImpl })).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
