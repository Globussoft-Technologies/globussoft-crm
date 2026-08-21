// Unit tests for backend/services/flightOfferImageExtractionLLM.js.
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
// landingSiteGeneratorLLM.js earlier this session.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import sharp from 'sharp';

const requireCjs = createRequire(import.meta.url);
const MODULE_PATH = '../../services/flightOfferImageExtractionLLM.js';

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

describe('extractFlightOfferPricing — no tenant context', () => {
  it('returns the stub immediately when tenantId is not provided (no AI attempted)', async () => {
    const client = loadClient();
    const visionSpy = vi.spyOn(client, 'callVisionExtraction');

    const result = await client.extractFlightOfferPricing({ files: [{ buffer: pngBuffer }], tripType: 'domestic' });

    expect(result.provider).toBe('stub');
    expect(result.stub).toBe(true);
    expect(visionSpy).not.toHaveBeenCalled();
  });
});

describe('extractFlightOfferPricing — vision happy path', () => {
  it('returns the vision result and never attempts the OCR fallback', async () => {
    const client = loadClient();
    const visionResult = {
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      stub: false,
      currency: 'INR',
      tripType: 'domestic',
      routeLabel: 'Delhi to Goa',
      rows: [{ label: 'Air India', basePrice: 12000, currency: 'INR' }],
      rawText: '{"rows":[{"label":"Air India","basePrice":12000}]}',
    };
    const visionSpy = vi.spyOn(client, 'callVisionExtraction').mockResolvedValue(visionResult);
    const ocrSpy = vi.spyOn(client, 'callOcrTextFallback');

    const result = await client.extractFlightOfferPricing({ tenantId: 1, files: [{ buffer: pngBuffer }], tripType: 'domestic' });

    expect(result).toEqual(visionResult);
    expect(visionSpy).toHaveBeenCalledTimes(1);
    expect(visionSpy.mock.calls[0][0].tenantId).toBe(1);
    expect(ocrSpy).not.toHaveBeenCalled();
  });
});

describe('extractFlightOfferPricing — friendly-blocked access', () => {
  it('returns the stub immediately on a friendly error, never attempts OCR fallback', async () => {
    const client = loadClient();
    const friendlyErr = new Error('Your organization has not configured an AI provider yet.');
    friendlyErr.friendly = true;
    vi.spyOn(client, 'callVisionExtraction').mockRejectedValue(friendlyErr);
    const ocrSpy = vi.spyOn(client, 'callOcrTextFallback');

    const result = await client.extractFlightOfferPricing({ tenantId: 1, files: [{ buffer: pngBuffer }], tripType: 'domestic' });

    expect(result.provider).toBe('stub');
    expect(result.stub).toBe(true);
    expect(result.note).toBe(friendlyErr.message);
    expect(ocrSpy).not.toHaveBeenCalled();
  });
});

describe('extractFlightOfferPricing — non-friendly vision failure falls back to OCR', () => {
  it('attempts OCR+text fallback and returns its result on vision failure', async () => {
    const client = loadClient();
    vi.spyOn(client, 'callVisionExtraction').mockRejectedValue(new Error('vision provider 500'));
    const ocrResult = {
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      stub: false,
      currency: 'INR',
      tripType: 'international',
      routeLabel: 'Mumbai to Singapore',
      rows: [{ label: 'Singapore Airlines', basePrice: 45000, currency: 'INR' }],
      rawText: '{"rows":[{"label":"Singapore Airlines","basePrice":45000}]}',
    };
    const ocrSpy = vi.spyOn(client, 'callOcrTextFallback').mockResolvedValue(ocrResult);

    const result = await client.extractFlightOfferPricing({ tenantId: 1, files: [{ buffer: pngBuffer }], tripType: 'international' });

    expect(result).toEqual(ocrResult);
    expect(ocrSpy).toHaveBeenCalledTimes(1);
    expect(ocrSpy.mock.calls[0][0].tenantId).toBe(1);
  });

  it('returns the stub when both vision AND OCR fallback fail', async () => {
    const client = loadClient();
    vi.spyOn(client, 'callVisionExtraction').mockRejectedValue(new Error('vision provider 500'));
    vi.spyOn(client, 'callOcrTextFallback').mockRejectedValue(new Error('ocr fallback also failed'));

    const result = await client.extractFlightOfferPricing({ tenantId: 1, files: [{ buffer: pngBuffer }], tripType: 'domestic' });

    expect(result.provider).toBe('stub');
    expect(result.stub).toBe(true);
    expect(result.note).toBe('ocr fallback also failed');
  });
});
