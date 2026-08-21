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

function normalizeRows(payload, fallbackCurrency = DEFAULT_CURRENCY) {
  const source = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.rows)
      ? payload.rows
      : Array.isArray(payload?.fares)
        ? payload.fares
        : Array.isArray(payload?.prices)
          ? payload.prices
          : Array.isArray(payload?.options)
            ? payload.options
            : [];
  return source
    .map((row, index) => {
      const basePrice = parsePrice(row?.basePrice ?? row?.price ?? row?.fare ?? row?.amount ?? row?.totalPrice ?? row?.finalPrice);
      if (!Number.isFinite(basePrice)) return null;
      return {
        label: toText(row?.label ?? row?.title ?? row?.name ?? row?.flightLabel ?? row?.description) || `Fare ${index + 1}`,
        basePrice,
        currency: toText(row?.currency || payload?.currency || fallbackCurrency).toUpperCase() || fallbackCurrency,
      };
    })
    .filter(Boolean)
    .slice(0, MAX_ROWS);
}

function buildPrompt({ tripType, fileCount }) {
  const tripLabel = tripType === "international" ? "international" : "domestic";
  return [
    "You are reading one or more flight fare screenshots.",
    "Extract the fare rows that are visible in the screenshot(s) and return STRICT JSON only.",
    "Do not add markup. Do not invent fares that are not visible.",
    "Return a JSON object with this shape:",
    '{ "currency": "INR", "tripType": "domestic|international|null", "routeLabel": "optional short title", "rows": [{ "label": "Airline or fare label", "basePrice": 12345 }] }',
    "Use the exact visible base fare before markup or any final quote adjustment.",
    "Return at most 4 rows, in the same order they appear.",
    `Trip hint from the UI: ${tripLabel}. Screenshot count: ${fileCount}.`,
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
    label: `Fare ${index + 1}`,
    basePrice: null,
    currency: DEFAULT_CURRENCY,
  }));
}

// Single multimodal call through aiGateway (BYOK or a funded CRM-managed
// subscription) — resolves to whatever vision-capable provider the tenant
// has, rather than looping through raw env keys. requestedModelLabel hints
// toward Gemini for CRM-managed access since that's the family this feature
// originated on; BYOK ignores the hint and uses the tenant's fixed provider.
async function callVisionExtraction({ tenantId, files, tripType }) {
  const prompt = buildPrompt({ tripType, fileCount: files.length });
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
    task: "flight-offer-extraction",
    surface: "flightOfferImageExtractionLLM",
    requestedModelLabel: "gemini-flash",
    messages: [{ role: "user", content }],
  });
  const rawText = resp.text || "";
  const parsed = parseJsonLoose(rawText);
  const rows = normalizeRows(parsed);
  if (!rows.length) {
    throw new Error(`${resp.provider} did not return any fare rows`);
  }
  return {
    provider: resp.provider,
    model: resp.model,
    stub: false,
    currency: toText(parsed?.currency || DEFAULT_CURRENCY).toUpperCase() || DEFAULT_CURRENCY,
    tripType: parsed?.tripType || tripType || null,
    routeLabel: toText(parsed?.routeLabel) || null,
    rows,
    rawText,
  };
}

// Last-resort fallback: OCR the images to text first, then a plain-text
// aiGateway call. Used only when the vision call above fails (including a
// resolved provider that can't do vision) but AI access is still available —
// gives low-vision-capability deployments a chance at partial extraction
// before falling back to the stub.
async function callOcrTextFallback({ tenantId, files, tripType }) {
  const ocrChunks = [];
  for (let i = 0; i < files.length; i += 1) {
    const ocr = await passportOcrClient.runOcr(files[i].buffer, {});
    const chunk = [ocr?.vizText, ocr?.mrzText].filter(Boolean).join("\n").trim();
    ocrChunks.push(`Screenshot ${i + 1}:\n${chunk || "(no readable text)"}`);
  }

  const prompt = [
    "You are reading OCR text extracted from flight fare screenshots.",
    "Return STRICT JSON only using this shape:",
    '{ "currency": "INR", "tripType": "domestic|international|null", "routeLabel": "optional short title", "rows": [{ "label": "Airline or fare label", "basePrice": 12345 }] }',
    "Extract only visible fares and prices from the OCR text. Return up to 4 rows.",
    `Trip hint from the UI: ${tripType || "unknown"}.`,
    "",
    ocrChunks.join("\n\n"),
  ].join("\n");

  const resp = await aiGateway.runAiRequest({
    tenantId,
    task: "flight-offer-extraction-ocr-fallback",
    surface: "flightOfferImageExtractionLLM",
    messages: [{ role: "user", content: prompt }],
  });
  const rawText = resp.text || "";
  const parsed = parseJsonLoose(rawText);
  const rows = normalizeRows(parsed);
  if (!rows.length) {
    throw new Error(`${resp.provider} (OCR fallback) did not return any fare rows`);
  }
  return {
    provider: resp.provider,
    model: resp.model,
    stub: false,
    currency: toText(parsed?.currency || DEFAULT_CURRENCY).toUpperCase() || DEFAULT_CURRENCY,
    tripType: parsed?.tripType || tripType || null,
    routeLabel: toText(parsed?.routeLabel) || null,
    rows,
    rawText,
  };
}

async function extractFlightOfferPricing({ tenantId = null, files = [], tripType = null } = {}) {
  const prepared = await prepareImages(files);

  if (tenantId) {
    try {
      return await module.exports.callVisionExtraction({ tenantId, files: prepared, tripType });
    } catch (visionErr) {
      if (visionErr.friendly) {
        return {
          provider: "stub",
          model: null,
          stub: true,
          currency: DEFAULT_CURRENCY,
          tripType: tripType || null,
          routeLabel: null,
          rows: buildStubRows(prepared.length || 1),
          note: visionErr.message,
        };
      }
      try {
        return await module.exports.callOcrTextFallback({ tenantId, files: prepared, tripType });
      } catch (ocrErr) {
        return {
          provider: "stub",
          model: null,
          stub: true,
          currency: DEFAULT_CURRENCY,
          tripType: tripType || null,
          routeLabel: null,
          rows: buildStubRows(prepared.length || 1),
          note: ocrErr.message,
        };
      }
    }
  }

  return {
    provider: "stub",
    model: null,
    stub: true,
    currency: DEFAULT_CURRENCY,
    tripType: tripType || null,
    routeLabel: null,
    rows: buildStubRows(prepared.length || 1),
    note: "No tenant context available for extraction.",
  };
}

module.exports = {
  extractFlightOfferPricing,
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
