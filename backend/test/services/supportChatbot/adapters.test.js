// @ts-check
/**
 * supportChatbot/providerAdapters — unit coverage for the Wellness Admin
 * Support Chatbot LLM abstraction.
 *
 * What's pinned
 * -------------
 *   - maskApiKey            sk-...XXXX masking; short keys fully masked
 *   - normalizeGeminiResponse   thought-parts dropped; functionCall parts →
 *                           toolCalls [{id, name, args}]; usage mapped
 *   - normalizeOpenAIResponse tool_calls JSON-string args parsed (bad JSON
 *                           degrades to {}); usage mapped
 *   - toGeminiContents      system → systemInstruction; assistant → model;
 *                           tool → function/functionResponse role
 *   - generateChatCompletion  gemini dispatch: URL shape
 *                           {base}/v1beta/models/{model}:generateContent +
 *                           dual auth headers; openai-compatible dispatch:
 *                           {base}/chat/completions + tools translated
 *   - error hygiene         non-OK upstream → throws status-bearing error
 *                           whose message NEVER contains the apiKey
 *   - resolveProviderConfig BYOK (TenantSetting blob) → internal env
 *                           fallback (non-production) → null (production)
 *
 * Pattern: prisma singleton patched BEFORE requiring the SUT (mirrors
 * test/routes/tenant_settings.test.js). The HTTP layer is stubbed by
 * passing an explicit fetchImpl into the adapter — no module mocks.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import prisma from '../../../lib/prisma.js';

// Patch prisma BEFORE requiring the SUT (resolveProviderConfig reads the
// TenantSetting row through lib/tenantSettings.getSetting).
prisma.tenantSetting = {
  findUnique: vi.fn(),
};

import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);
const adapters = requireCJS('../../../services/supportChatbot/providerAdapters');
const {
  maskApiKey,
  normalizeGeminiResponse,
  normalizeOpenAIResponse,
  toGeminiContents,
  generateChatCompletion,
  resolveProviderConfig,
  validateProviderBaseUrl,
} = adapters;

const RAW_KEY = 'sk-test-1234567890abcdef';

function okFetch(body) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }));
}

beforeEach(() => {
  prisma.tenantSetting.findUnique.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('maskApiKey', () => {
  test('masks a long key as sk-...XXXX', () => {
    expect(maskApiKey(RAW_KEY)).toBe('sk-...cdef');
  });
  test('fully masks short keys', () => {
    expect(maskApiKey('short')).toBe('••••••••');
  });
  test('returns null for missing keys', () => {
    expect(maskApiKey(null)).toBeNull();
    expect(maskApiKey('')).toBeNull();
  });
});

describe('normalizeGeminiResponse', () => {
  test('joins text parts, drops thought parts', () => {
    const out = normalizeGeminiResponse({
      candidates: [
        {
          content: {
            parts: [
              { text: 'internal chain', thought: true },
              { text: 'Hello. ' },
              { text: 'How can I help?' },
            ],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7, totalTokenCount: 18 },
    });
    expect(out.text).toBe('Hello. How can I help?');
    expect(out.toolCalls).toEqual([]);
    expect(out.usage).toEqual({ promptTokens: 11, completionTokens: 7, totalTokens: 18 });
  });

  test('maps functionCall parts to normalised toolCalls', () => {
    const out = normalizeGeminiResponse({
      candidates: [
        {
          content: {
            parts: [
              { functionCall: { name: 'search_help_docs', args: { query: 'refund' } } },
              { functionCall: { name: 'get_page_info', args: { page: 'billing' } } },
            ],
          },
        },
      ],
    });
    expect(out.text).toBe('');
    expect(out.toolCalls).toHaveLength(2);
    expect(out.toolCalls[0].name).toBe('search_help_docs');
    expect(out.toolCalls[0].args).toEqual({ query: 'refund' });
    expect(out.toolCalls[0].id).toBeTruthy();
    expect(out.toolCalls[1].name).toBe('get_page_info');
  });

  test('tolerates an empty/garbled payload', () => {
    const out = normalizeGeminiResponse({});
    expect(out.text).toBe('');
    expect(out.toolCalls).toEqual([]);
    expect(out.usage.totalTokens).toBe(0);
  });
});

describe('normalizeOpenAIResponse', () => {
  test('maps content + tool_calls, parsing JSON-string args', () => {
    const out = normalizeOpenAIResponse({
      choices: [
        {
          message: {
            content: '',
            tool_calls: [
              {
                id: 'call_1',
                function: { name: 'get_page_info', arguments: '{"page":"appointments"}' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
    });
    expect(out.toolCalls).toEqual([
      {
        id: 'call_1',
        name: 'get_page_info',
        args: { page: 'appointments' },
      },
    ]);
    expect(out.usage).toEqual({ promptTokens: 9, completionTokens: 4, totalTokens: 13 });
  });

  test('invalid JSON args degrade to {} instead of throwing', () => {
    const out = normalizeOpenAIResponse({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ id: 'call_2', function: { name: 'get_page_info', arguments: '{not json' } }],
          },
        },
      ],
    });
    expect(out.toolCalls[0].args).toEqual({});
  });

  test('plain prose response', () => {
    const out = normalizeOpenAIResponse({
      choices: [{ message: { content: 'Open the Appointments page.' } }],
    });
    expect(out.text).toBe('Open the Appointments page.');
    expect(out.toolCalls).toEqual([]);
  });
});

describe('toGeminiContents', () => {
  test('maps roles: system→systemInstruction, assistant→model, tool→function', () => {
    const { systemInstruction, contents } = toGeminiContents([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello' },
      { role: 'tool', name: 'search_help_docs', toolCallId: 'x', content: '{"articles":[]}' },
    ]);
    expect(systemInstruction).toEqual({ parts: [{ text: 'You are helpful.' }] });
    expect(contents).toEqual([
      { role: 'user', parts: [{ text: 'Hi' }] },
      { role: 'model', parts: [{ text: 'Hello' }] },
      {
        role: 'function',
        parts: [
          {
            functionResponse: {
              name: 'search_help_docs',
              response: { result: '{"articles":[]}' },
            },
          },
        ],
      },
    ]);
  });
});

describe('generateChatCompletion — gemini dispatch', () => {
  test('allows the approved PowerAdSpy Gemini proxy and preserves its base path', async () => {
    const fetchImpl = okFetch({ candidates: [{ content: { parts: [{ text: 'OK' }] } }] });
    await generateChatCompletion(
      {
        provider: 'gemini',
        apiKey: RAW_KEY,
        model: 'gemini-2.5-flash-lite',
        baseUrl: 'https://gemini-central-beta-v1-pn-ds-01.poweradspy.ai/nx/direct',
      },
      { messages: [{ role: 'user', content: 'ping' }] },
      fetchImpl,
    );

    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://gemini-central-beta-v1-pn-ds-01.poweradspy.ai/nx/direct/v1beta/models/gemini-2.5-flash-lite:generateContent',
    );
    expect(fetchImpl.mock.calls[0][1].headers['x-goog-api-key']).toBe(RAW_KEY);
  });

  test('POSTs to {base}/v1beta/models/{model}:generateContent with dual auth headers', async () => {
    const fetchImpl = okFetch({
      candidates: [{ content: { parts: [{ text: 'OK' }] } }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 },
    });
    const out = await generateChatCompletion(
      {
        provider: 'gemini',
        apiKey: RAW_KEY,
        model: 'gemini-2.5-flash-lite',
        baseUrl: 'https://generativelanguage.googleapis.com',
      },
      { messages: [{ role: 'user', content: 'ping' }] },
      fetchImpl,
    );
    expect(out.text).toBe('OK');
    expect(out.provider).toBe('gemini');
    expect(out.model).toBe('gemini-2.5-flash-lite');

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent',
    );
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Bearer ${RAW_KEY}`);
    expect(init.headers['x-goog-api-key']).toBe(RAW_KEY);
    const body = JSON.parse(init.body);
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'ping' }] }]);
  });

  test('translates tool definitions into Gemini functionDeclarations', async () => {
    const fetchImpl = okFetch({ candidates: [{ content: { parts: [{ text: 'OK' }] } }] });
    await generateChatCompletion(
      { provider: 'gemini', apiKey: RAW_KEY, model: 'm', baseUrl: 'https://generativelanguage.googleapis.com' },
      {
        messages: [{ role: 'user', content: 'hi' }],
        tools: [
          {
            name: 'get_page_info',
            description: 'page lookup',
            parameters: { type: 'object', properties: { page: { type: 'string' } } },
          },
        ],
      },
      fetchImpl,
    );
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: 'get_page_info',
            description: 'page lookup',
            parameters: { type: 'object', properties: { page: { type: 'string' } } },
          },
        ],
      },
    ]);
  });
});

describe('generateChatCompletion — openai-compatible dispatch', () => {
  test('POSTs to {base}/chat/completions with Bearer auth + translated tools', async () => {
    const fetchImpl = okFetch({
      choices: [{ message: { content: 'pong' } }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    });
    const out = await generateChatCompletion(
      {
        provider: 'openai-compatible',
        apiKey: RAW_KEY,
        model: 'gpt-4o-mini',
        baseUrl: 'https://api.openai.com/v1',
      },
      {
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'ping' },
          { role: 'tool', name: 't', toolCallId: 'call_9', content: '{}' },
        ],
        tools: [
          {
            name: 'search_help_docs',
            description: 'kb search',
            parameters: { type: 'object', properties: { query: { type: 'string' } } },
          },
        ],
      },
      fetchImpl,
    );
    expect(out.text).toBe('pong');

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.headers.Authorization).toBe(`Bearer ${RAW_KEY}`);
    const body = JSON.parse(init.body);
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'ping' },
      { role: 'tool', tool_call_id: 'call_9', content: '{}' },
    ]);
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'search_help_docs',
          description: 'kb search',
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
        },
      },
    ]);
  });
});

describe('generateChatCompletion — error hygiene', () => {
  test.each([
    'http://api.openai.com/v1',
    'https://127.0.0.1/v1',
    'https://169.254.169.254/latest',
    'https://localhost/v1',
    'https://attacker.example/v1',
    'https://user:password@api.openai.com/v1',
    'https://api.openai.com:8443/v1',
  ])('rejects unsafe provider base URL %s before fetch', async (baseUrl) => {
    const fetchImpl = okFetch({ choices: [{ message: { content: 'should not run' } }] });
    await expect(
      generateChatCompletion(
        { provider: 'openai-compatible', apiKey: RAW_KEY, model: 'm', baseUrl },
        { messages: [{ role: 'user', content: 'hi' }] },
        fetchImpl,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_BASE_URL' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('accepts an exact deployment-allowlisted HTTPS hostname', () => {
    vi.stubEnv('WELLNESS_AI_ALLOWED_HOSTS', 'llm.example.com');
    expect(
      validateProviderBaseUrl('openai-compatible', 'https://llm.example.com/v1'),
    ).toBe('https://llm.example.com/v1');
  });

  test('does not allow an allowlisted hostname suffix attack', () => {
    vi.stubEnv('WELLNESS_AI_ALLOWED_HOSTS', 'llm.example.com');
    try {
      validateProviderBaseUrl('openai-compatible', 'https://llm.example.com.attacker.test/v1');
      expect.unreachable('should have rejected an unapproved hostname');
    } catch (e) {
      expect(e).toMatchObject({ code: 'INVALID_PROVIDER_BASE_URL' });
    }
  });

  test('non-OK upstream throws a status error that never contains the key', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => `invalid key: ${RAW_KEY}`,
    }));
    await expect(
      generateChatCompletion(
        { provider: 'gemini', apiKey: RAW_KEY, model: 'm', baseUrl: 'https://generativelanguage.googleapis.com' },
        { messages: [{ role: 'user', content: 'hi' }] },
        fetchImpl,
      ),
    ).rejects.toMatchObject({ status: 401, provider: 'gemini' });
    await expect(
      generateChatCompletion(
        { provider: 'gemini', apiKey: RAW_KEY, model: 'm', baseUrl: 'https://generativelanguage.googleapis.com' },
        { messages: [{ role: 'user', content: 'hi' }] },
        fetchImpl,
      ),
    ).rejects.toThrow(/status 401/);
    // And the thrown message must NOT leak the key even though the upstream
    // body echoed it.
    try {
      await generateChatCompletion(
        { provider: 'gemini', apiKey: RAW_KEY, model: 'm', baseUrl: 'https://generativelanguage.googleapis.com' },
        { messages: [{ role: 'user', content: 'hi' }] },
        fetchImpl,
      );
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(String(e.message)).not.toContain(RAW_KEY);
    }
  });

  test('missing apiKey rejects with AI_PROVIDER_NOT_CONFIGURED', async () => {
    await expect(
      generateChatCompletion({ provider: 'gemini' }, { messages: [] }, okFetch({})),
    ).rejects.toMatchObject({ code: 'AI_PROVIDER_NOT_CONFIGURED' });
  });

  test('unknown provider rejects', async () => {
    await expect(
      generateChatCompletion({ provider: 'anthropic', apiKey: RAW_KEY }, { messages: [] }, okFetch({})),
    ).rejects.toMatchObject({ code: 'AI_PROVIDER_UNSUPPORTED' });
  });
});

describe('resolveProviderConfig', () => {
  test('returns BYOK config from the TenantSetting blob', async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue({
      value: JSON.stringify({
        provider: 'openai-compatible',
        apiKey: RAW_KEY,
        model: 'gpt-4o-mini',
        baseUrl: 'https://api.openai.com/v1',
      }),
    });
    const cfg = await resolveProviderConfig(1);
    expect(cfg).toEqual({
      provider: 'openai-compatible',
      apiKey: RAW_KEY,
      model: 'gpt-4o-mini',
      baseUrl: 'https://api.openai.com/v1',
      source: 'byok',
    });
    expect(prisma.tenantSetting.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId_key: { tenantId: 1, key: 'wellness.aiProviderConfig' } },
      }),
    );
  });

  test('gemini BYOK without an explicit model defaults to gemini-2.5-flash-lite', async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue({
      value: JSON.stringify({ provider: 'gemini', apiKey: RAW_KEY }),
    });
    const cfg = await resolveProviderConfig(1);
    expect(cfg.model).toBe('gemini-2.5-flash-lite');
    expect(cfg.source).toBe('byok');
  });

  test('falls back to the internal Gemini proxy env vars outside production', async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue(null);
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('GEMINI_PROXY_API_KEY', 'proxy-key-123');
    vi.stubEnv('GEMINI_PROXY_BASE_URL', 'https://proxy.test/nx/direct');
    const cfg = await resolveProviderConfig(1);
    expect(cfg).toEqual({
      provider: 'gemini',
      apiKey: 'proxy-key-123',
      model: 'gemini-2.5-flash-lite',
      baseUrl: 'https://proxy.test/nx/direct',
      source: 'internal',
    });
  });

  test('production without BYOK returns null (no internal fallback)', async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue(null);
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('GEMINI_PROXY_API_KEY', 'proxy-key-123');
    const cfg = await resolveProviderConfig(1);
    expect(cfg).toBeNull();
  });

  test('corrupt BYOK blob falls through to the env fallback', async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue({ value: '{broken json' });
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('GEMINI_PROXY_API_KEY', 'proxy-key-123');
    const cfg = await resolveProviderConfig(1);
    expect(cfg.source).toBe('internal');
  });
});
