import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const geminiEmbedClient = require('../../lib/geminiEmbedClient.js');

describe('geminiEmbedClient — env surface', () => {
  test('isEnabled is false when config has no apiKey', () => {
    expect(geminiEmbedClient.isEnabled({})).toBe(false);
    expect(geminiEmbedClient.isEnabled(null)).toBe(false);
  });

  test('isEnabled is true when config has an apiKey', () => {
    expect(geminiEmbedClient.isEnabled({ apiKey: 'test-key' })).toBe(true);
  });

  test('exposes expected defaults', () => {
    expect(geminiEmbedClient.DEFAULT_MODEL).toBe('models/gemini-embedding-001');
    expect(geminiEmbedClient.VECTOR_SIZE).toBe(3072);
  });
});

describe('geminiEmbedClient — embedText', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function successResponse(values) {
    return {
      ok: true,
      json: async () => ({ embeddings: [{ values }] }),
    };
  }

  test('returns the first embedding on success', async () => {
    const values = Array(3072).fill(0.1);
    fetch.mockResolvedValue(successResponse(values));
    const result = await geminiEmbedClient.embedText('hello', { apiKey: 'gk-test' });
    expect(result).toEqual(values);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1beta/models/gemini-embedding-001:batchEmbedContents'),
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('hello'),
      }),
    );
  });

  test('returns null when embedding dimension does not match', async () => {
    fetch.mockResolvedValue(successResponse([0.1, 0.2, 0.3]));
    const result = await geminiEmbedClient.embedText('hello', { apiKey: 'gk-test' });
    expect(result).toBeNull();
  });

  test('returns null on fetch failure and logs', async () => {
    fetch.mockRejectedValue(new Error('network'));
    const result = await geminiEmbedClient.embedText('hello', { apiKey: 'gk-test' });
    expect(result).toBeNull();
  });

  test('returns null when Gemini returns non-2xx', async () => {
    fetch.mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ error: { message: 'quota' } }),
      statusText: 'Too Many Requests',
    });
    const result = await geminiEmbedClient.embedText('hello', { apiKey: 'gk-test' });
    expect(result).toBeNull();
  });

  test('returns null when apiKey is missing', async () => {
    const result = await geminiEmbedClient.embedText('hello', {});
    expect(result).toBeNull();
  });
});

describe('geminiEmbedClient — embedTexts', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('maps embeddings by original index', async () => {
    const v1 = Array(3072).fill(0.1);
    const v2 = Array(3072).fill(0.2);
    fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ embeddings: [{ values: v1 }, { values: v2 }] }),
    });
    const { embeddings, errors } = await geminiEmbedClient.embedTexts(
      ['a', 'b'],
      { apiKey: 'gk-test' },
    );
    expect(embeddings.get(0)).toEqual(v1);
    expect(embeddings.get(1)).toEqual(v2);
    expect(errors.size).toBe(0);
  });

  test('empty inputs return empty maps', async () => {
    const { embeddings, errors } = await geminiEmbedClient.embedTexts([], { apiKey: 'gk-test' });
    expect(embeddings.size).toBe(0);
    expect(errors.size).toBe(0);
  });

  test('empty strings are reported as errors', async () => {
    const values = Array(3072).fill(0.1);
    fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ embeddings: [{ values }] }),
    });
    const { embeddings, errors } = await geminiEmbedClient.embedTexts(
      ['valid', '', '  '],
      { apiKey: 'gk-test' },
    );
    expect(embeddings.get(0)).toEqual(values);
    expect(errors.has(1)).toBe(true);
    expect(errors.has(2)).toBe(true);
  });
});
