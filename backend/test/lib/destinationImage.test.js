// @ts-check
/**
 * backend/lib/destinationImage.js — server-side destination hero photo for the
 * itinerary PDF. Verifies title resolution, the two-step Wikipedia fetch, and
 * that every failure mode degrades to null (so the PDF still renders). axios is
 * injected; jimp banner-cropping falls back to the raw buffer on non-images,
 * so the canned bytes round-trip as a Buffer.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { fetchDestinationImageBuffer, wikiTitleFor, _resetCache } from '../../lib/destinationImage.js';

beforeEach(() => { _resetCache(); });

describe('wikiTitleFor', () => {
  test('maps sub-brand aliases to canonical Wikipedia titles', () => {
    expect(wikiTitleFor('Makka madinah')).toBe('Mecca');
    expect(wikiTitleFor('Banaras')).toBe('Varanasi');
    expect(wikiTitleFor('Tokyo')).toBe('Tokyo');
  });
  test('cleans an unknown destination to its first segment', () => {
    expect(wikiTitleFor('Reykjavik, Iceland')).toBe('Reykjavik');
  });
  test('returns null for empty input', () => {
    expect(wikiTitleFor('')).toBeNull();
  });
});

// axios stub: first call = pageimages JSON, second call = image bytes.
function makeAxios({ thumbUrl = 'https://upload/img.jpg', bytes = Buffer.from('rawimagebytes') } = {}) {
  return {
    get: vi.fn()
      .mockResolvedValueOnce({ data: { query: { pages: { 1: { thumbnail: { source: thumbUrl } } } } } })
      .mockResolvedValueOnce({ data: bytes }),
  };
}

describe('fetchDestinationImageBuffer', () => {
  test('resolves the lead image then returns its bytes (jimp falls back to raw on non-image)', async () => {
    const axiosStub = makeAxios();
    const buf = await fetchDestinationImageBuffer('Tokyo', { axios: axiosStub });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.toString()).toBe('rawimagebytes');
    // First call hits the CORS action API; second downloads the image.
    expect(axiosStub.get.mock.calls[0][0]).toContain('en.wikipedia.org/w/api.php');
    expect(axiosStub.get.mock.calls[1][0]).toBe('https://upload/img.jpg');
  });

  test('caches by title — a second call does not re-fetch', async () => {
    const axiosStub = makeAxios();
    await fetchDestinationImageBuffer('Tokyo', { axios: axiosStub });
    await fetchDestinationImageBuffer('Tokyo', { axios: axiosStub });
    expect(axiosStub.get).toHaveBeenCalledTimes(2); // not 4
  });

  test('returns null when the article has no image', async () => {
    const axiosStub = { get: vi.fn().mockResolvedValueOnce({ data: { query: { pages: { 1: {} } } } }) };
    expect(await fetchDestinationImageBuffer('Nowhereville', { axios: axiosStub })).toBeNull();
  });

  test('returns null (never throws) on network error', async () => {
    const axiosStub = { get: vi.fn().mockRejectedValue(new Error('offline')) };
    expect(await fetchDestinationImageBuffer('Tokyo', { axios: axiosStub })).toBeNull();
  });

  test('returns null for an empty destination without fetching', async () => {
    const axiosStub = { get: vi.fn() };
    expect(await fetchDestinationImageBuffer('', { axios: axiosStub })).toBeNull();
    expect(axiosStub.get).not.toHaveBeenCalled();
  });
});
