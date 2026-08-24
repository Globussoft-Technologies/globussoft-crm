import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const embedClient = require('../../lib/openAIEmbedClient.js');

describe('openAIEmbedClient — env surface', () => {
  const originalKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  });

  test('isEnabled is false when OPENAI_API_KEY is unset', () => {
    expect(embedClient.isEnabled()).toBe(false);
  });

  test('isEnabled is true when OPENAI_API_KEY is set', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    expect(embedClient.isEnabled()).toBe(true);
  });
});

describe('openAIEmbedClient — embedText', () => {
  const originalKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'sk-test';
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    vi.unstubAllGlobals();
  });

  test('returns the first embedding on success', async () => {
    fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }),
    });
    const result = await embedClient.embedText('hello');
    expect(result).toEqual([0.1, 0.2, 0.3]);
    expect(fetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/embeddings',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer sk-test' }),
        body: expect.stringContaining('text-embedding-3-small'),
      }),
    );
  });

  test('does not double-prefix /v1 when config.baseUrl already includes it', async () => {
    fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }),
    });
    const result = await embedClient.embedText('hello', { baseUrl: 'https://api.openai.com/v1' });
    expect(result).toEqual([0.1, 0.2, 0.3]);
    expect(fetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/embeddings',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer sk-test' }),
        body: expect.stringContaining('text-embedding-3-small'),
      }),
    );
  });

  test('returns null on fetch failure and logs', async () => {
    fetch.mockRejectedValue(new Error('network'));
    const result = await embedClient.embedText('hello');
    expect(result).toBeNull();
  });

  test('returns null when OpenAI returns non-2xx', async () => {
    fetch.mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ error: { message: 'rate limit' } }),
      statusText: 'Too Many Requests',
    });
    const result = await embedClient.embedText('hello');
    expect(result).toBeNull();
  });
});
