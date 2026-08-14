// Unit tests for backend/services/hotelOfferImageExtractionLLM.js.
//
// The service used to loop Gemini vision → OpenAI vision → Groq (OCR-text
// fallback) by raw env-key presence. It now goes through
// lib/aiGateway.runAiRequest — the mandatory resolve/gate/log/deduct entry
// point every AI feature in the CRM shares (BYOK first, then a funded
// CRM-managed subscription). BYOK resolves to ONE fixed provider regardless
// of which "attempt" is running, so the old 3-attempt loop was redesigned
// into: one multimodal vision call, and — only if that fails with a
// non-friendly error — a single OCR+text fallback call, before finally
// giving up to the stub. Mirrors the redesign already applied to
// landingSiteGeneratorLLM.js and flightOfferImageExtractionLLM.js.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import sharp from 'sharp';

const requireCjs = createRequire(import.meta.url);
const MODULE_PATH = '../../services/hotelOfferImageExtractionLLM.js';

function loadClient() {
  delete requireCjs.cache[requireCjs.resolve(MODULE_PATH)];
  return requireCjs(MODULE_PATH);
}

let pngBuffer;

beforeEach(async () => {
  pngBuffer = await sharp({
    create: { width: 1, height: 1, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
  }).png().toBuffer();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('extractHotelOfferPricing — no tenant context', () => {
  it('returns the stub immediately when tenantId is not provided (no AI attempted)', async () => {
    const client = loadClient();
    const visionSpy = vi.spyOn(client, 'callVisionExtraction');

    const result = await client.extractHotelOfferPricing({ files: [{ buffer: pngBuffer }] });

    expect(result.provider).toBe('stub');
    expect(result.stub).toBe(true);
    expect(visionSpy).not.toHaveBeenCalled();
  });
});

describe('extractHotelOfferPricing — vision happy path', () => {
  it('returns the vision result and never attempts the OCR fallback', async () => {
    const client = loadClient();
    const visionResult = {
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      stub: false,
      currency: 'INR',
      hotelLabel: 'Taj Lands End',
      city: 'Mumbai',
      stayLabel: '2 nights',
      checkIn: '2026-09-01',
      checkOut: '2026-09-03',
      rows: [{ label: 'Taj Lands End', roomType: 'Deluxe', basePrice: 15000, priceBasis: 'per_night', nights: 2, currency: 'INR' }],
      rawText: '{"rows":[{"label":"Taj Lands End","basePrice":15000}]}',
      summary: { hotelLabel: 'Taj Lands End', city: 'Mumbai', stayLabel: '2 nights', checkIn: '2026-09-01', checkOut: '2026-09-03' },
    };
    const visionSpy = vi.spyOn(client, 'callVisionExtraction').mockResolvedValue(visionResult);
    const ocrSpy = vi.spyOn(client, 'callOcrTextFallback');

    const result = await client.extractHotelOfferPricing({ tenantId: 1, files: [{ buffer: pngBuffer }] });

    expect(result).toEqual(visionResult);
    expect(visionSpy).toHaveBeenCalledTimes(1);
    expect(visionSpy.mock.calls[0][0].tenantId).toBe(1);
    expect(ocrSpy).not.toHaveBeenCalled();
  });
});

describe('extractHotelOfferPricing — friendly-blocked access', () => {
  it('returns the stub immediately on a friendly error, never attempts OCR fallback', async () => {
    const client = loadClient();
    const friendlyErr = new Error('Your organization has not configured an AI provider yet.');
    friendlyErr.friendly = true;
    vi.spyOn(client, 'callVisionExtraction').mockRejectedValue(friendlyErr);
    const ocrSpy = vi.spyOn(client, 'callOcrTextFallback');

    const result = await client.extractHotelOfferPricing({ tenantId: 1, files: [{ buffer: pngBuffer }] });

    expect(result.provider).toBe('stub');
    expect(result.stub).toBe(true);
    expect(result.note).toBe(friendlyErr.message);
    expect(ocrSpy).not.toHaveBeenCalled();
  });
});

describe('extractHotelOfferPricing — non-friendly vision failure falls back to OCR', () => {
  it('attempts OCR+text fallback and returns its result on vision failure', async () => {
    const client = loadClient();
    vi.spyOn(client, 'callVisionExtraction').mockRejectedValue(new Error('vision provider 500'));
    const ocrResult = {
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      stub: false,
      currency: 'INR',
      hotelLabel: 'Marina Bay Sands',
      city: 'Singapore',
      stayLabel: '3 nights',
      checkIn: '2026-10-01',
      checkOut: '2026-10-04',
      rows: [{ label: 'Marina Bay Sands', roomType: 'Deluxe', basePrice: 40000, priceBasis: 'total', nights: 3, currency: 'INR' }],
      rawText: '{"rows":[{"label":"Marina Bay Sands","basePrice":40000}]}',
      summary: { hotelLabel: 'Marina Bay Sands', city: 'Singapore', stayLabel: '3 nights', checkIn: '2026-10-01', checkOut: '2026-10-04' },
    };
    const ocrSpy = vi.spyOn(client, 'callOcrTextFallback').mockResolvedValue(ocrResult);

    const result = await client.extractHotelOfferPricing({ tenantId: 1, files: [{ buffer: pngBuffer }] });

    expect(result).toEqual(ocrResult);
    expect(ocrSpy).toHaveBeenCalledTimes(1);
    expect(ocrSpy.mock.calls[0][0].tenantId).toBe(1);
  });

  it('returns the stub when both vision AND OCR fallback fail', async () => {
    const client = loadClient();
    vi.spyOn(client, 'callVisionExtraction').mockRejectedValue(new Error('vision provider 500'));
    vi.spyOn(client, 'callOcrTextFallback').mockRejectedValue(new Error('ocr fallback also failed'));

    const result = await client.extractHotelOfferPricing({ tenantId: 1, files: [{ buffer: pngBuffer }] });

    expect(result.provider).toBe('stub');
    expect(result.stub).toBe(true);
    expect(result.note).toBe('ocr fallback also failed');
  });
});

describe('normalizeRows (pure fn)', () => {
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
