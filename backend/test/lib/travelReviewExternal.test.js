import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const prisma = requireCJS('../../lib/prisma');
prisma.tenantSetting = prisma.tenantSetting || {};
prisma.tenantSetting.findUnique = vi.fn();

const sentimentEngine = requireCJS('../../cron/sentimentEngine');
sentimentEngine.analyzeMessageDetailed = vi.fn();

const helper = requireCJS('../../lib/travelReviewExternal');
const { KEYS } = requireCJS('../../lib/tenantSettings');

beforeEach(() => {
  prisma.tenantSetting.findUnique.mockReset();
  sentimentEngine.analyzeMessageDetailed.mockReset();
  prisma.tenantSetting.findUnique.mockResolvedValue(null);
  sentimentEngine.analyzeMessageDetailed.mockResolvedValue({
    sentiment: 'neutral',
    sentimentScore: 0,
    provider: 'rule-based',
    trusted: false,
    usedFallback: true,
  });
});

describe('travelReviewExternal', () => {
  test('returns null when no external review URL is configured', async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue(null);

    const out = await helper.buildExternalReviewCta({
      tenantId: 1,
      destination: 'Dubai',
      overallRating: 5,
      answers: { loved_most: 'Everything was smooth.' },
    });

    expect(out).toBeNull();
    expect(prisma.tenantSetting.findUnique).toHaveBeenCalledWith({
      where: { tenantId_key: { tenantId: 1, key: KEYS.TRAVEL_EXTERNAL_REVIEW_URL } },
      select: { value: true },
    });
    expect(sentimentEngine.analyzeMessageDetailed).not.toHaveBeenCalled();
  });

  test('returns null when sentiment came from fallback logic', async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue({ value: 'https://example.com/review' });
    sentimentEngine.analyzeMessageDetailed.mockResolvedValue({
      sentiment: 'positive',
      sentimentScore: 0.9,
      provider: 'rule-based',
      trusted: false,
      usedFallback: true,
    });

    const out = await helper.buildExternalReviewCta({
      tenantId: 1,
      destination: 'Dubai',
      overallRating: 5,
      answers: { loved_most: 'Everything was smooth.' },
    });

    expect(out).toBeNull();
  });

  test('returns CTA when a trusted positive AI result is available', async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue({ value: 'https://example.com/review' });
    sentimentEngine.analyzeMessageDetailed.mockResolvedValue({
      sentiment: 'positive',
      sentimentScore: 0.88,
      provider: 'gemini',
      trusted: true,
      usedFallback: false,
    });

    const out = await helper.buildExternalReviewCta({
      tenantId: 1,
      destination: 'Dubai',
      overallRating: 5,
      answers: { loved_most: 'Everything was smooth.', highlight: 'The support team was excellent.' },
    });

    expect(out).toMatchObject({
      enabled: true,
      url: 'https://example.com/review',
      label: 'Post to Google',
      analysis: {
        sentiment: 'positive',
        provider: 'gemini',
        trusted: true,
      },
    });
    expect(out.suggestedReview).toMatch(/smooth/i);
  });
});
