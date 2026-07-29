/**
 * landingSiteGeneratorLLM.test.js ? covers the provider cascade and the
 * wellness landing-site fallback behaviour.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import prisma from '../../lib/prisma.js';

// Patch the shared prisma singleton so the budget-cap check in
// landingSiteGeneratorLLM.js does not trip the prisma-surface guard.
prisma.tenantSetting = {
  findUnique: vi.fn().mockResolvedValue(null),
};

const requireCjs = createRequire(import.meta.url);
const MODULE_PATH = '../../services/landingSiteGeneratorLLM.js';
const llmRouter = requireCjs('../../lib/llmRouter');
const destinationImageProvider = requireCjs('../../services/destinationImageProvider');
let previousOpenAiModel;
let previousGroqModel;

function loadClient() {
  return requireCjs(MODULE_PATH);
}

function mockProviderKeys(map) {
  vi.spyOn(llmRouter, 'getLlmKey').mockImplementation(async (_tenantId, model) => map[model] || null);
}

function mockFetchJson(payload) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify(payload) } }],
      usage: { prompt_tokens: 18, completion_tokens: 42 },
    }),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  previousOpenAiModel = process.env.LLM_MODEL_OPENAI_LANDING;
  previousGroqModel = process.env.GROQ_MODEL;
  delete requireCjs.cache[requireCjs.resolve(MODULE_PATH)];
  destinationImageProvider._resetForTests();
  vi.restoreAllMocks();
  prisma.tenantSetting.findUnique.mockReset().mockResolvedValue(null);
  vi.spyOn(destinationImageProvider, 'fetchOne').mockResolvedValue({
    url: 'https://example.com/landing-stock.jpg',
    attribution: { photographer: 'Test', providerId: 'test' },
  });
});

afterEach(() => {
  process.env.LLM_MODEL_OPENAI_LANDING = previousOpenAiModel;
  process.env.GROQ_MODEL = previousGroqModel;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('generateLandingSiteContent', () => {
  test('builds a wellness scaffold from OpenAI content fields', async () => {
    process.env.LLM_MODEL_OPENAI_LANDING = 'gpt-4o-mini';
    mockProviderKeys({
      'gemini-flash': null,
      'gpt-4': 'openai-key',
      'groq-llama': null,
    });

    const modelPayload = {
      suggestedTitle: 'Hair Treatment Consultation',
      suggestedSlug: 'hair-treatment-consultation',
      description: 'A polished landing page for a hair treatment consultation day.',
      seoMeta: {
        metaTitle: 'Hair Treatment Consultation',
        metaDescription: 'A clear registration page for people exploring hair treatment options.',
      },
      content: {
        heroKicker: 'VISIT - CALL - WRITE',
        heroTitleLine1: 'Hair Treatment',
        heroTitleLine2: 'Consultation',
        heroCopy: 'Glow Studio invites people exploring hair treatment options to register for a professional consultation day.',
        heroNote: 'Every submission is editable, trackable, and routed to the right team instantly.',
        heroPrimaryCta: 'View Details',
        heroSecondaryCta: 'Contact Us',
        detailDateValue: '15 August 2026',
        detailTimeValue: '10:00 AM - 4:00 PM',
        detailLocationValue: 'Harbor Wellness Centre',
        detailAudienceValue: 'people exploring hair treatment options',
        benefitsTitle: 'Why it works',
        benefitsCopy: 'The landing page explains the offer clearly and keeps the enquiry flow simple.',
        formTitle: 'Request More Information',
        formCopy: 'Share your details and the team will follow up with confirmation and next steps.',
        formSubmitText: 'Submit Enquiry',
        formThankYou: 'Thanks. We have received your enquiry for Hair Treatment Consultation.',
        footerContact: 'Glow Studio\nhello@glowstudio.example\nKoramangala, Bengaluru',
      },
    };

    const fetchMock = mockFetchJson(modelPayload);
    const client = loadClient();

    const result = await client.generateLandingSiteContent({
      tenantId: 1,
      sectorKey: 'wellness',
      sectorLabel: 'Wellness',
      campaignName: 'Hair Treatment Consultation',
      businessName: 'Glow Studio',
      campaignGoal: 'book consultations',
      audience: 'people exploring hair treatment options',
      location: 'Bangalore',
      eventDate: '15 August 2026',
      eventTime: '10:00 AM - 4:00 PM',
      eventLocation: 'Harbor Wellness Centre',
      ctaText: 'Register Now',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.source).toBe('openai');
    expect(result.stub).toBe(false);
    expect(result.model).toBe('gpt-4o-mini');
    const body = JSON.stringify(result.blocks);
    expect(body).toContain('Hair Treatment Consultation');
    expect(body).toContain('Glow Studio');
    expect(body).toContain('people exploring hair treatment options');
    expect(body).not.toContain('Blood Donation');
  });

  test('builds a wellness scaffold from Groq content fields when other keys are unavailable', async () => {
    process.env.GROQ_MODEL = 'llama-3.3-70b-versatile';
    mockProviderKeys({
      'gemini-flash': null,
      'gpt-4': null,
      'groq-llama': 'groq-key',
    });

    const modelPayload = {
      suggestedTitle: 'Wellness Follow-Up Day',
      suggestedSlug: 'wellness-follow-up-day',
      description: 'A polished follow-up day landing page for wellness enquiries.',
      seoMeta: {
        metaTitle: 'Wellness Follow-Up Day',
        metaDescription: 'A clear registration page with a professional follow-up message.',
      },
      content: {
        heroTitleLine1: 'Wellness Follow-Up Day',
        heroCopy: 'The team will review your request and respond with next steps.',
        detailDateValue: '22 August 2026',
        detailTimeValue: '11:00 AM - 3:00 PM',
        detailLocationValue: 'Harbor Wellness Clinic',
        detailAudienceValue: 'patients and families',
        formThankYou: 'Thanks. We have received your enquiry for Wellness Follow-Up Day.',
        footerContact: 'Harbor Wellness\nhello@harborwellness.example\nChennai',
      },
    };

    mockFetchJson(modelPayload);
    const client = loadClient();

    const result = await client.generateLandingSiteContent({
      tenantId: 1,
      sectorKey: 'health',
      sectorLabel: 'Health',
      campaignName: 'Wellness Follow-Up Day',
      businessName: 'Harbor Wellness',
      campaignGoal: 'follow up on enquiries',
      audience: 'patients and families',
      location: 'Chennai',
      eventDate: '22 August 2026',
      eventTime: '11:00 AM - 3:00 PM',
      eventLocation: 'Harbor Wellness Clinic',
      ctaText: 'Book Follow-Up',
    });

    expect(result.source).toBe('groq');
    expect(result.stub).toBe(false);
    expect(result.model).toBe('llama-3.3-70b-versatile');
    const body = JSON.stringify(result.blocks);
    expect(body).toContain('Wellness Follow-Up Day');
    expect(body).toContain('Harbor Wellness');
    expect(body).toContain('patients and families');
    expect(body).not.toContain('Blood Donation');
  });
});