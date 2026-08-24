import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const aiProviderManagement = require('../../lib/aiProviderManagement.js');
const embedClient = require('../../lib/embedClient.js');

describe('embedClient — provider mapping', () => {
  test('getSupportedProviders returns openai and gemini', () => {
    expect(embedClient.getSupportedProviders()).toEqual(['openai', 'gemini']);
  });

  test('getVectorSize returns correct dimensions', () => {
    expect(embedClient.getVectorSize('openai')).toBe(1536);
    expect(embedClient.getVectorSize('gemini')).toBe(3072);
    expect(embedClient.getVectorSize('unknown')).toBeNull();
  });

  test('getDefaultModel returns hard-coded embedding model per provider', () => {
    expect(embedClient.getDefaultModel('openai')).toBe('text-embedding-3-small');
    expect(embedClient.getDefaultModel('gemini')).toBe('models/gemini-embedding-001');
    expect(embedClient.getDefaultModel('unknown')).toBeNull();
  });
});

describe('embedClient — resolveEmbedConfig', () => {
  let resolveSpy;

  beforeEach(() => {
    resolveSpy = vi.spyOn(aiProviderManagement, 'resolveProviderConfig');
  });

  afterEach(() => {
    resolveSpy.mockRestore();
  });

  test('returns null when no provider is configured', async () => {
    resolveSpy.mockResolvedValue(null);
    const cfg = await embedClient.resolveEmbedConfig(1);
    expect(cfg).toBeNull();
  });

  test('returns null when provider is unsupported', async () => {
    resolveSpy.mockResolvedValue({ providerId: 'groq', apiKey: 'k' });
    const cfg = await embedClient.resolveEmbedConfig(1);
    expect(cfg).toBeNull();
  });

  test('returns OpenAI config when active provider is openai', async () => {
    resolveSpy.mockResolvedValue({
      providerId: 'openai',
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
    });
    const cfg = await embedClient.resolveEmbedConfig(1);
    expect(cfg.providerId).toBe('openai');
    expect(cfg.model).toBe('text-embedding-3-small');
    expect(cfg.vectorSize).toBe(1536);
    expect(cfg.apiKey).toBe('sk-test');
  });

  test('returns Gemini config when active provider is gemini', async () => {
    resolveSpy.mockResolvedValue({
      providerId: 'gemini',
      apiKey: 'gk-test',
      baseUrl: 'https://generativelanguage.googleapis.com',
    });
    const cfg = await embedClient.resolveEmbedConfig(1);
    expect(cfg.providerId).toBe('gemini');
    expect(cfg.model).toBe('models/gemini-embedding-001');
    expect(cfg.vectorSize).toBe(3072);
    expect(cfg.apiKey).toBe('gk-test');
  });
});

describe('embedClient — isEnabled', () => {
  let resolveSpy;

  beforeEach(() => {
    resolveSpy = vi.spyOn(aiProviderManagement, 'resolveProviderConfig');
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    resolveSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  test('isEnabled is false when no provider configured', async () => {
    resolveSpy.mockResolvedValue(null);
    expect(await embedClient.isEnabled(1)).toBe(false);
  });

  test('isEnabled is true when provider configured with apiKey', async () => {
    resolveSpy.mockResolvedValue({ providerId: 'openai', apiKey: 'sk-test' });
    expect(await embedClient.isEnabled(1)).toBe(true);
  });
});

describe('embedClient — embedText', () => {
  let resolveSpy;

  beforeEach(() => {
    resolveSpy = vi.spyOn(aiProviderManagement, 'resolveProviderConfig');
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    resolveSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  test('returns null when no provider configured', async () => {
    resolveSpy.mockResolvedValue(null);
    const result = await embedClient.embedText('hello', 1);
    expect(result).toBeNull();
  });

  test('dispatches to OpenAI embed client', async () => {
    resolveSpy.mockResolvedValue({ providerId: 'openai', apiKey: 'sk-test' });
    fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }),
    });
    const result = await embedClient.embedText('hello', 1);
    expect(result).toEqual([0.1, 0.2, 0.3]);
    expect(fetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/embeddings',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('text-embedding-3-small'),
      }),
    );
  });
});
