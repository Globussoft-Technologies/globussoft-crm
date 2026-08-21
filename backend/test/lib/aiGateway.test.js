// Unit tests for backend/lib/aiGateway.js — the single mandatory entry point
// every AI feature in the CRM routes through (see the file's own header
// comment). This suite focuses on the shared plumbing every call site
// depends on:
//   - assertAccessOrThrow's friendly-block contract (no BYOK, no funded
//     CRM-managed subscription)
//   - the provider-quota/rate-limit rewrite (friendlyProviderErrorOrNull):
//     a raw 429/"quota exceeded"/"rate limit"-shaped provider failure gets
//     rewritten into a friendly, BYOK-vs-CRM-managed-aware message —
//     DISTINCT from the access-blocked friendly message, so callers can
//     tell "never configured" apart from "temporarily rate-limited" via
//     err.unavailableReason.
//   - credit deduction happens only for crm-managed access, never BYOK
//   - LlmCallLog is written on both success and failure
//
// Mocking strategy: monkey-patch the prisma singleton (llmCallLog.create)
// and require aiProviderManagement/aiCreditLedger fresh with their real
// implementations swapped for vi.fn()s via the module cache, mirroring the
// pattern used throughout this session's aiGateway-consumer test rewrites.
import { describe, test, expect, vi, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

const {
  mockResolveProviderConfig,
  mockGetTenantAiState,
  mockGenerateChatCompletion,
  mockCanUseManagedAi,
  mockDeductUsage,
  mockDeductCost,
  mockUsdCostToEquivalentTokens,
} = vi.hoisted(() => ({
  mockResolveProviderConfig: vi.fn(),
  mockGetTenantAiState: vi.fn(),
  mockGenerateChatCompletion: vi.fn(),
  mockCanUseManagedAi: vi.fn(),
  mockDeductUsage: vi.fn(),
  mockDeductCost: vi.fn(),
  mockUsdCostToEquivalentTokens: vi.fn((usd) => Math.round(usd * 1000)),
}));

const aiProviderManagementPath = requireCJS.resolve('../../lib/aiProviderManagement');
require('node:module')._cache[aiProviderManagementPath] = {
  id: aiProviderManagementPath, filename: aiProviderManagementPath, loaded: true,
  exports: {
    resolveProviderConfig: mockResolveProviderConfig,
    getTenantAiState: mockGetTenantAiState,
    generateChatCompletion: mockGenerateChatCompletion,
  },
  children: [], paths: [],
};
const aiCreditLedgerPath = requireCJS.resolve('../../lib/aiCreditLedger');
require('node:module')._cache[aiCreditLedgerPath] = {
  id: aiCreditLedgerPath, filename: aiCreditLedgerPath, loaded: true,
  exports: {
    canUseManagedAi: mockCanUseManagedAi,
    deductUsage: mockDeductUsage,
    deductCost: mockDeductCost,
    usdCostToEquivalentTokens: mockUsdCostToEquivalentTokens,
  },
  children: [], paths: [],
};

const aiGateway = requireCJS('../../lib/aiGateway.js');

beforeEach(() => {
  prisma.llmCallLog = { create: vi.fn().mockResolvedValue({ id: 1 }) };
  mockResolveProviderConfig.mockReset();
  mockGetTenantAiState.mockReset();
  mockGenerateChatCompletion.mockReset();
  mockCanUseManagedAi.mockReset();
  mockDeductUsage.mockReset();
  mockDeductCost.mockReset();
});

const BYOK_CONFIG = {
  providerId: 'openai', providerLabel: 'OpenAI', family: 'openai-compatible',
  apiKey: 'sk-test', model: 'gpt-4o-mini', source: 'byok', accessType: 'byok',
};
const CRM_MANAGED_CONFIG = {
  providerId: 'gemini', providerLabel: 'Google Gemini', family: 'gemini',
  apiKey: 'internal-key', model: 'gemini-2.5-flash-lite', source: 'internal', accessType: 'crm-managed',
};

describe('aiGateway.runAiRequest — access resolution', () => {
  test('throws with err.friendly=true and unavailableReason when no BYOK + no funded subscription', async () => {
    mockResolveProviderConfig.mockResolvedValue(null);
    mockGetTenantAiState.mockResolvedValue({
      friendlyMessage: 'Your organization has not configured an AI provider yet.',
      unavailableReason: 'NO_CONFIGURATION',
    });

    await expect(
      aiGateway.runAiRequest({ tenantId: 1, task: 'test', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject({
      friendly: true,
      code: 'AI_NOT_CONFIGURED',
      unavailableReason: 'NO_CONFIGURATION',
      message: 'Your organization has not configured an AI provider yet.',
    });
    expect(mockGenerateChatCompletion).not.toHaveBeenCalled();
  });

  test('CREDITS_EXHAUSTED maps to AI_CREDITS_EXHAUSTED code', async () => {
    mockResolveProviderConfig.mockResolvedValue(null);
    mockGetTenantAiState.mockResolvedValue({
      friendlyMessage: 'Your AI credits have been exhausted.',
      unavailableReason: 'CREDITS_EXHAUSTED',
    });

    await expect(
      aiGateway.runAiRequest({ tenantId: 1, task: 'test', messages: [] }),
    ).rejects.toMatchObject({ code: 'AI_CREDITS_EXHAUSTED', friendly: true });
  });

  test('requires tenantId and task', async () => {
    await expect(aiGateway.runAiRequest({ task: 't', messages: [] })).rejects.toThrow(/requires tenantId/);
    await expect(aiGateway.runAiRequest({ tenantId: 1, messages: [] })).rejects.toThrow(/requires task/);
  });
});

describe('aiGateway.runAiRequest — provider quota/rate-limit rewrite', () => {
  test('BYOK: a 429/quota-shaped provider failure is rewritten with BYOK-specific wording', async () => {
    mockResolveProviderConfig.mockResolvedValue(BYOK_CONFIG);
    mockGenerateChatCompletion.mockRejectedValue(new Error('Request failed with status 429: quota exceeded'));

    await expect(
      aiGateway.runAiRequest({ tenantId: 1, task: 'test', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject({
      friendly: true,
      code: 'AI_PROVIDER_RATE_LIMITED',
      unavailableReason: 'RATE_LIMITED',
      message: expect.stringMatching(/your.*provider key.*usage limit/i),
    });
    // No credit deduction on a failed call.
    expect(mockDeductUsage).not.toHaveBeenCalled();
  });

  test('CRM-managed: a rate-limit-shaped failure gets the shared-key wording, not the BYOK wording', async () => {
    mockResolveProviderConfig.mockResolvedValue(CRM_MANAGED_CONFIG);
    mockCanUseManagedAi.mockResolvedValue({ allowed: true });
    mockGenerateChatCompletion.mockRejectedValue(new Error('rate limit exceeded, please try again later'));

    await expect(
      aiGateway.runAiRequest({ tenantId: 1, task: 'test', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject({
      friendly: true,
      code: 'AI_PROVIDER_RATE_LIMITED',
      unavailableReason: 'RATE_LIMITED',
      message: expect.stringMatching(/shared AI provider is temporarily rate-limited/i),
    });
  });

  test('a non-rate-limit provider failure (e.g. malformed request) passes through unchanged, not marked friendly', async () => {
    mockResolveProviderConfig.mockResolvedValue(BYOK_CONFIG);
    const rawErr = new Error('Invalid request: missing required field');
    mockGenerateChatCompletion.mockRejectedValue(rawErr);

    await expect(
      aiGateway.runAiRequest({ tenantId: 1, task: 'test', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow('Invalid request: missing required field');
  });

  test('LlmCallLog is written with status=failed on a rate-limited failure', async () => {
    mockResolveProviderConfig.mockResolvedValue(BYOK_CONFIG);
    mockGenerateChatCompletion.mockRejectedValue(new Error('429 Too Many Requests'));

    await expect(
      aiGateway.runAiRequest({ tenantId: 1, task: 'test-task', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow();

    expect(prisma.llmCallLog.create).toHaveBeenCalledTimes(1);
    const arg = prisma.llmCallLog.create.mock.calls[0][0].data;
    expect(arg.status).toBe('failed');
    expect(arg.tenantId).toBe(1);
    expect(arg.task).toBe('test-task');
  });
});

describe('aiGateway.runAiRequest — successful call + credit deduction', () => {
  test('BYOK success never deducts credits', async () => {
    mockResolveProviderConfig.mockResolvedValue(BYOK_CONFIG);
    mockGenerateChatCompletion.mockResolvedValue({
      text: 'hello', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, model: 'gpt-4o-mini', provider: 'openai-compatible',
    });

    const result = await aiGateway.runAiRequest({ tenantId: 1, task: 'test', messages: [{ role: 'user', content: 'hi' }] });

    expect(result.text).toBe('hello');
    expect(result.accessType).toBe('byok');
    expect(mockDeductUsage).not.toHaveBeenCalled();
  });

  test('crm-managed success deducts usage with actual provider-reported tokens', async () => {
    mockResolveProviderConfig.mockResolvedValue(CRM_MANAGED_CONFIG);
    mockCanUseManagedAi.mockResolvedValue({ allowed: true });
    mockGenerateChatCompletion.mockResolvedValue({
      text: 'hello', usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 }, model: 'gemini-2.5-flash-lite', provider: 'gemini',
    });

    const result = await aiGateway.runAiRequest({ tenantId: 1, task: 'test', messages: [{ role: 'user', content: 'hi' }] });

    expect(result.accessType).toBe('crm-managed');
    expect(mockDeductUsage).toHaveBeenCalledTimes(1);
    const arg = mockDeductUsage.mock.calls[0][0];
    expect(arg.tenantId).toBe(1);
    expect(arg.promptTokens).toBe(20);
    expect(arg.completionTokens).toBe(10);
    expect(arg.totalTokens).toBe(30);
  });
});

describe('aiGateway.runNonTokenAiRequest — provider quota/rate-limit rewrite', () => {
  test('a rate-limit-shaped runFn failure is rewritten the same way as runAiRequest', async () => {
    mockResolveProviderConfig.mockResolvedValue(BYOK_CONFIG);
    const runFn = vi.fn().mockRejectedValue(new Error('quota exceeded'));

    await expect(
      aiGateway.runNonTokenAiRequest({ tenantId: 1, task: 'audio', runFn }),
    ).rejects.toMatchObject({ friendly: true, code: 'AI_PROVIDER_RATE_LIMITED', unavailableReason: 'RATE_LIMITED' });
  });

  test('requires tenantId, task, and runFn', async () => {
    await expect(aiGateway.runNonTokenAiRequest({ task: 't', runFn: vi.fn() })).rejects.toThrow(/requires tenantId/);
    await expect(aiGateway.runNonTokenAiRequest({ tenantId: 1, runFn: vi.fn() })).rejects.toThrow(/requires task/);
    await expect(aiGateway.runNonTokenAiRequest({ tenantId: 1, task: 't' })).rejects.toThrow(/requires runFn/);
  });
});
