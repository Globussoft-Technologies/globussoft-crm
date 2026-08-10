import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import sharp from 'sharp';

const requireCjs = createRequire(import.meta.url);
const MODULE_PATH = '../../services/hotelOfferImageExtractionLLM.js';

function loadClient() {
  delete requireCjs.cache[requireCjs.resolve(MODULE_PATH)];
  return requireCjs(MODULE_PATH);
}

beforeEach(() => {
  delete process.env.GEMINI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GROQ_API_KEY;
  delete process.env.LLM_MODEL_GEMINI;
  delete process.env.LLM_MODEL_GPT;
  delete process.env.LLM_MODEL_GROQ;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.GEMINI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GROQ_API_KEY;
});

describe('extractHotelOfferPricing provider fallback', () => {
  it('falls through from Gemini to OpenAI when Gemini fails', async () => {
    process.env.GEMINI_API_KEY = 'gemini-key';
    process.env.OPENAI_API_KEY = 'openai-key';
    process.env.GROQ_API_KEY = 'groq-key';

    const pngBuffer = await sharp({
      create: {
        width: 1,
        height: 1,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      },
    }).png().toBuffer();

    const client = loadClient();
    const geminiSpy = vi.spyOn(client, 'callGeminiVision').mockRejectedValue(new Error('Gemini unavailable'));
    const openAiResult = {
      provider: 'openai',
      model: 'gpt-4o',
      stub: false,
      currency: 'INR',
      hotelLabel: 'Hotel quotation',
      city: 'Goa',
      stayLabel: '2 nights',
      checkIn: '2026-08-02',
      checkOut: '2026-08-04',
      rows: [{ label: 'Grand Hotel', roomType: 'Deluxe', basePrice: 12000, priceBasis: 'total', nights: 2, currency: 'INR' }],
      rawText: '{"rows":[{"label":"Grand Hotel","basePrice":12000}]}',
      summary: { hotelLabel: 'Hotel quotation', city: 'Goa', stayLabel: '2 nights', checkIn: '2026-08-02', checkOut: '2026-08-04' },
    };
    const groqSpy = vi.spyOn(client, 'callGroqTextFallback').mockResolvedValue({
      provider: 'groq',
      model: 'llama-3.3-70b-versatile',
      stub: false,
      currency: 'INR',
      hotelLabel: 'Hotel quotation',
      city: 'Goa',
      stayLabel: '2 nights',
      checkIn: '2026-08-02',
      checkOut: '2026-08-04',
      rows: [{ label: 'Fallback', basePrice: 9999, priceBasis: 'total', nights: 1, currency: 'INR' }],
      rawText: '{}',
      summary: { hotelLabel: 'Hotel quotation', city: 'Goa', stayLabel: '2 nights', checkIn: '2026-08-02', checkOut: '2026-08-04' },
    });
    const openAiSpy = vi.spyOn(client, 'callOpenAIVision').mockResolvedValue(openAiResult);

    const result = await client.extractHotelOfferPricing({ files: [{ buffer: pngBuffer }] });

    expect(result.provider).toBe('openai');
    expect(result.rows).toHaveLength(1);
    expect(geminiSpy).toHaveBeenCalledTimes(1);
    expect(openAiSpy).toHaveBeenCalledTimes(1);
    expect(groqSpy).not.toHaveBeenCalled();
  });

  it('falls through to Groq when Gemini and OpenAI both fail', async () => {
    process.env.GEMINI_API_KEY = 'gemini-key';
    process.env.OPENAI_API_KEY = 'openai-key';
    process.env.GROQ_API_KEY = 'groq-key';

    const pngBuffer = await sharp({
      create: {
        width: 1,
        height: 1,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      },
    }).png().toBuffer();

    const client = loadClient();
    const geminiSpy = vi.spyOn(client, 'callGeminiVision').mockRejectedValue(new Error('Gemini unavailable'));
    const openAiSpy = vi.spyOn(client, 'callOpenAIVision').mockRejectedValue(new Error('OpenAI unavailable'));
    const groqResult = {
      provider: 'groq',
      model: 'llama-3.3-70b-versatile',
      stub: false,
      currency: 'INR',
      hotelLabel: 'Hotel quotation',
      city: 'Goa',
      stayLabel: '2 nights',
      checkIn: '2026-08-02',
      checkOut: '2026-08-04',
      rows: [{ label: 'Fallback', roomType: 'Standard', basePrice: 9999, priceBasis: 'total', nights: 1, currency: 'INR' }],
      rawText: '{"rows":[{"label":"Fallback","basePrice":9999}]}',
      summary: { hotelLabel: 'Hotel quotation', city: 'Goa', stayLabel: '2 nights', checkIn: '2026-08-02', checkOut: '2026-08-04' },
    };
    const groqSpy = vi.spyOn(client, 'callGroqTextFallback').mockResolvedValue(groqResult);

    const result = await client.extractHotelOfferPricing({ files: [{ buffer: pngBuffer }] });

    expect(result.provider).toBe('groq');
    expect(result.rows).toHaveLength(1);
    expect(geminiSpy).toHaveBeenCalledTimes(1);
    expect(openAiSpy).toHaveBeenCalledTimes(1);
    expect(groqSpy).toHaveBeenCalledTimes(1);
  });

  it('normalizes per-night and total rows', () => {
    const client = loadClient();
    const rows = client.normalizeRows({
      currency: 'usd',
      rows: [
        { name: 'Hotel A', ratePerNight: 5000, nights: 2, roomType: 'Deluxe' },
        { hotelName: 'Hotel B', totalRate: 12000, basis: 'total' },
      ],
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ label: 'Hotel A', roomType: 'Deluxe', basePrice: 5000, priceBasis: 'per_night', nights: 2, currency: 'USD' });
    expect(rows[1]).toMatchObject({ label: 'Hotel B', basePrice: 12000, priceBasis: 'total', currency: 'USD' });
  });
});


