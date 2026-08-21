"use strict";

const sharp = require("sharp");
const passportOcrClient = require("./passportOcrClient");
const aiGateway = require("../lib/aiGateway");

const MAX_ROWS = 4;
const DEFAULT_CURRENCY = "INR";

function toText(value) {
  return String(value == null ? "" : value).trim();
}

function parsePrice(value) {
  if (Number.isFinite(value)) {
    return Math.round(Number(value) * 100) / 100;
  }
  const raw = toText(value);
  if (!raw) return null;
  const cleaned = raw.replace(/[^0-9.-]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function parseJsonLoose(text) {
  if (!text || typeof text !== "string") return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const raw = fenced ? fenced[1] : text;
  const start = raw.search(/[[{]/);
  if (start === -1) return null;
  const slice = raw.slice(start);
  try {
    return JSON.parse(slice);
  } catch {
    const lastArr = slice.lastIndexOf("]");
    const lastObj = slice.lastIndexOf("}");
    const end = Math.max(lastArr, lastObj);
    if (end > 0) {
      try {
        return JSON.parse(slice.slice(0, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function normalizePriceBasis(value, fallback = "total") {
  const text = toText(value).toLowerCase();
  if (!text) return fallback;
  if (/(per[\s_-]?night|nightly|night)/.test(text)) return "per_night";
  if (/(total|stay|package|quote)/.test(text)) return "total";
  return fallback;
}

function normalizeRows(payload, fallbackCurrency = DEFAULT_CURRENCY) {
  const source = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.rows)
      ? payload.rows
      : Array.isArray(payload?.hotels)
        ? payload.hotels
        : Array.isArray(payload?.rooms)
          ? payload.rooms
          : Array.isArray(payload?.prices)
            ? payload.prices
            : Array.isArray(payload?.options)
              ? payload.options
              : Array.isArray(payload?.stays)
                ? payload.stays
                : [];

  return source
    .map((row, index) => {
      const parsedBasePrice = parsePrice(row?.basePrice ?? row?.price ?? row?.ratePerNight ?? row?.nightlyRate ?? row?.totalRate ?? row?.amount ?? row?.finalPrice);
      if (!Number.isFinite(parsedBasePrice)) return null;

      const hasPerNight = row?.ratePerNight != null || row?.nightlyRate != null;
      const hasTotal = row?.totalRate != null || row?.amount != null || row?.finalPrice != null;
      const parsedNights = Number(row?.nights);

      return {
        label: toText(row?.label ?? row?.title ?? row?.name ?? row?.hotelName ?? row?.propertyName ?? row?.description) || `Hotel ${index + 1}`,
        roomType: toText(row?.roomType ?? row?.room ?? row?.roomLabel ?? row?.roomName ?? row?.category),
        basePrice: parsedBasePrice,
        priceBasis: normalizePriceBasis(
          row?.priceBasis ?? row?.basis ?? row?.rateBasis ?? row?.pricingBasis ?? row?.chargeBasis ?? (hasPerNight ? "per_night" : hasTotal ? "total" : ""),
          hasPerNight ? "per_night" : "total",
        ),
        nights: Number.isFinite(parsedNights) ? Math.max(1, Math.round(parsedNights)) : null,
        note: toText(row?.note ?? row?.notes ?? row?.priceNote ?? row?.details),
        city: toText(row?.city ?? row?.destination ?? row?.location),
        currency: toText(row?.currency || payload?.currency || fallbackCurrency).toUpperCase() || fallbackCurrency,
      };
    })
    .filter(Boolean)
    .slice(0, MAX_ROWS);
}

function buildPrompt({ fileCount }) {
  return [
    "You are reading one or more hotel price screenshots.",
    "Extract the hotel rows that are visible in the screenshot(s) and return STRICT JSON only.",
    "Do not add markup. Do not invent hotel prices that are not visible.",
    "Return a JSON object with this shape:",
    '{ "currency": "INR", "hotelLabel": "optional short title", "city": "optional city", "stayLabel": "optional stay summary", "checkIn": "optional check-in date", "checkOut": "optional check-out date", "rows": [{ "label": "Hotel or property name", "roomType": "Deluxe Room", "basePrice": 12345, "priceBasis": "total|per_night", "nights": 2 }] }',
    "Use the exact visible price before markup or any final quote adjustment.",
    "If the screenshot shows a per-night rate, set priceBasis to per_night. If it shows a total stay amount, set priceBasis to total.",
    "Return at most 4 rows, in the same order they appear.",
    `Screenshot count: ${fileCount}.`,
    "Return only JSON, no markdown, no explanation.",
  ].join("\n");
}

async function normalizeUploadedFile(file, index) {
  if (!file || !Buffer.isBuffer(file.buffer)) {
    const err = new Error(`images[${index}] is missing file data`);
    err.code = "INVALID_IMAGE";
    throw err;
  }

  try {
    const pngBuffer = await sharp(file.buffer, { animated: false }).rotate().png().toBuffer();
    return {
      mimeType: "image/png",
      buffer: pngBuffer,
      originalMimeType: toText(file.mimetype).toLowerCase() || "image/png",
      originalName: toText(file.originalname) || `image-${index + 1}`,
    };
  } catch (error) {
    const err = new Error(`Unable to read screenshot ${index + 1}: ${error.message}`);
    err.code = "UNREADABLE_IMAGE";
    throw err;
  }
}

async function prepareImages(files = []) {
  const list = Array.isArray(files) ? files.slice(0, MAX_ROWS) : [];
  const prepared = [];
  for (let i = 0; i < list.length; i += 1) {
    prepared.push(await normalizeUploadedFile(list[i], i));
  }
  return prepared;
}

function buildStubRows(imageCount) {
  const count = Math.max(1, Math.min(MAX_ROWS, Number(imageCount) || 1));
  return Array.from({ length: count }, (_unused, index) => ({
    label: `Hotel ${index + 1}`,
    roomType: "Standard",
    basePrice: null,
    priceBasis: "total",
    nights: null,
    currency: DEFAULT_CURRENCY,
  }));
}

function summaryOf(parsed) {
  const hotelLabel = toText(parsed?.hotelLabel || parsed?.routeLabel || parsed?.offerLabel) || null;
  return {
    hotelLabel,
    city: toText(parsed?.city) || null,
    stayLabel: toText(parsed?.stayLabel) || null,
    checkIn: toText(parsed?.checkIn) || null,
    checkOut: toText(parsed?.checkOut) || null,
  };
}

// Single multimodal call through aiGateway (BYOK or a funded CRM-managed
// subscription) — resolves to whatever vision-capable provider the tenant
// has, rather than looping through raw env keys.
async function callVisionExtraction({ tenantId, files }) {
  const prompt = buildPrompt({ fileCount: files.length });
  const content = [
    { type: "text", text: prompt },
    ...files.map((file) => ({
      type: "image",
      mimeType: file.mimeType,
      data: file.buffer.toString("base64"),
    })),
  ];
  const resp = await aiGateway.runAiRequest({
    tenantId,
    task: "hotel-offer-extraction",
    surface: "hotelOfferImageExtractionLLM",
    requestedModelLabel: "gemini-flash",
    messages: [{ role: "user", content }],
  });
  const rawText = resp.text || "";
  const parsed = parseJsonLoose(rawText);
  const rows = normalizeRows(parsed);
  if (!rows.length) {
    throw new Error(`${resp.provider} did not return any hotel rows`);
  }
  const summary = summaryOf(parsed);
  return {
    provider: resp.provider,
    model: resp.model,
    stub: false,
    currency: toText(parsed?.currency || DEFAULT_CURRENCY).toUpperCase() || DEFAULT_CURRENCY,
    ...summary,
    rows,
    rawText,
    summary,
  };
}

// Last-resort fallback: OCR the images to text first, then a plain-text
// aiGateway call. Used only when the vision call above fails (including a
// resolved provider that can't do vision) but AI access is still available.
async function callOcrTextFallback({ tenantId, files }) {
  const ocrChunks = [];
  for (let i = 0; i < files.length; i += 1) {
    const ocr = await passportOcrClient.runOcr(files[i].buffer, {});
    const chunk = [ocr?.vizText, ocr?.mrzText].filter(Boolean).join("\n").trim();
    ocrChunks.push(`Screenshot ${i + 1}:\n${chunk || "(no readable text)"}`);
  }

  const prompt = [
    "You are reading OCR text extracted from hotel price screenshots.",
    "Return STRICT JSON only using this shape:",
    '{ "currency": "INR", "hotelLabel": "optional short title", "city": "optional city", "stayLabel": "optional stay summary", "checkIn": "optional check-in date", "checkOut": "optional check-out date", "rows": [{ "label": "Hotel or property name", "roomType": "Deluxe Room", "basePrice": 12345, "priceBasis": "total|per_night", "nights": 2 }] }',
    "Extract only visible hotels and prices from the OCR text. Return up to 4 rows.",
    "",
    ocrChunks.join("\n\n"),
  ].join("\n");

  const resp = await aiGateway.runAiRequest({
    tenantId,
    task: "hotel-offer-extraction-ocr-fallback",
    surface: "hotelOfferImageExtractionLLM",
    messages: [{ role: "user", content: prompt }],
  });
  const rawText = resp.text || "";
  const parsed = parseJsonLoose(rawText);
  const rows = normalizeRows(parsed);
  if (!rows.length) {
    throw new Error(`${resp.provider} (OCR fallback) did not return any hotel rows`);
  }
  const summary = summaryOf(parsed);
  return {
    provider: resp.provider,
    model: resp.model,
    stub: false,
    currency: toText(parsed?.currency || DEFAULT_CURRENCY).toUpperCase() || DEFAULT_CURRENCY,
    ...summary,
    rows,
    rawText,
    summary,
  };
}

function stubResult(imageCount, note) {
  return {
    provider: "stub",
    model: null,
    stub: true,
    currency: DEFAULT_CURRENCY,
    hotelLabel: null,
    city: null,
    stayLabel: null,
    checkIn: null,
    checkOut: null,
    rows: buildStubRows(imageCount),
    note,
    summary: {
      hotelLabel: null,
      city: null,
      stayLabel: null,
      checkIn: null,
      checkOut: null,
    },
  };
}

async function extractHotelOfferPricing({ tenantId = null, files = [] } = {}) {
  const prepared = await prepareImages(files);

  if (tenantId) {
    try {
      return await module.exports.callVisionExtraction({ tenantId, files: prepared });
    } catch (visionErr) {
      if (visionErr.friendly) {
        return stubResult(prepared.length || 1, visionErr.message);
      }
      try {
        return await module.exports.callOcrTextFallback({ tenantId, files: prepared });
      } catch (ocrErr) {
        return stubResult(prepared.length || 1, ocrErr.message);
      }
    }
  }

  return stubResult(prepared.length || 1, "No tenant context available for extraction.");
}

module.exports = {
  extractHotelOfferPricing,
  prepareImages,
  normalizeUploadedFile,
  parseJsonLoose,
  normalizeRows,
  parsePrice,
  buildPrompt,
  buildStubRows,
  callVisionExtraction,
  callOcrTextFallback,
};
