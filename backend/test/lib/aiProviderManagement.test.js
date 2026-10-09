const {
  DEFAULT_GEMINI_MODEL,
  generateChatCompletion,
  withGeminiModelFallbacks,
} = require('../../lib/aiProviderManagement');

const baseGeminiConfig = {
  providerId: 'gemini',
  providerLabel: 'Google Gemini',
  family: 'gemini',
  apiKey: 'test-key',
  model: 'gemini-2.5-flash-lite',
  baseUrl: 'https://generativelanguage.googleapis.com',
  source: 'byok',
  accessType: 'byok',
};

function successResponse(text = 'OK') {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 },
    }),
  };
}

describe('aiProviderManagement Gemini model resilience', () => {
  it('uses a model available to newly-active Gemini projects by default', () => {
    expect(DEFAULT_GEMINI_MODEL).toBe('gemini-3.5-flash-lite');
  });

  it('adds current Gemini models as same-key fallbacks for a saved legacy model', () => {
    const config = withGeminiModelFallbacks(baseGeminiConfig);

    expect(config.model).toBe('gemini-2.5-flash-lite');
    expect(config.fallbacks.map((candidate) => candidate.model)).toEqual([
      'gemini-3.5-flash-lite',
      'gemini-3.8-flash',
    ]);
    expect(config.fallbacks.every((candidate) => candidate.apiKey === 'test-key')).toBe(true);
  });

  it('falls through from a 404 legacy model to the current Flash-Lite model', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => JSON.stringify({ error: { message: 'Model is not available for this project.' } }),
      })
      .mockResolvedValueOnce(successResponse());

    const response = await generateChatCompletion(
      withGeminiModelFallbacks(baseGeminiConfig),
      { messages: [{ role: 'user', content: 'Reply with exactly: OK' }] },
      fetchMock,
    );

    expect(response.text).toBe('OK');
    expect(response.model).toBe('gemini-3.5-flash-lite');
    expect(fetchMock.mock.calls[0][0]).toContain('/models/gemini-2.5-flash-lite:generateContent');
    expect(fetchMock.mock.calls[1][0]).toContain('/models/gemini-3.5-flash-lite:generateContent');
  });

  it('includes the safe Google error detail when every attempt fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ error: { message: 'Requested model was not found.' } }),
    });

    await expect(generateChatCompletion(baseGeminiConfig, {
      messages: [{ role: 'user', content: 'Hello' }],
    }, fetchMock)).rejects.toThrow('status 404: Requested model was not found.');
  });
});
