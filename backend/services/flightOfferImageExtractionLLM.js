"use strict";

const sharp = require("sharp");
const passportOcrClient = require("./passportOcrClient");

const MAX_ROWS = 4;
const DEFAULT_CURRENCY = "INR";
const GEMINI_MODEL = process.env.LLM_MODEL_GEMINI || process.env.GEMINI_MODEL || "gemini-2.5-flash";
const OPENAI_MODEL = process.env.LLM_MODEL_GPT || "gpt-4o";
const GROQ_MODEL = process.env.LLM_MODEL_GROQ || "llama-3.3-70b-versatile";

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

async function callGeminiVision({ files, tripType }) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY not set");
  }
  const { GoogleGenerativeAI } = require("@google/generative-ai");
  const ai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = ai.getGenerativeModel({
    model: GEMINI_MODEL,
    generationConfig: {
      responseMimeType: "application/json",
      maxOutputTokens: 4096,
      temperature: 0.1,
    },
  });
  const prompt = buildPrompt({ tripType, fileCount: files.length });
  const parts = [
    { text: prompt },
    ...files.map((file) => ({
      inlineData: {
        mimeType: file.mimeType,
        data: file.buffer.toString("base64"),
      },
    })),
  ];
  const result = await model.generateContent(parts);
  const rawText = result?.response?.text?.() || "";
  const parsed = parseJsonLoose(rawText);
  const rows = normalizeRows(parsed);
  if (!rows.length) {
    throw new Error("Gemini did not return any fare rows");
  }
  return {
    provider: "gemini",
    model: GEMINI_MODEL,
    stub: false,
    currency: toText(parsed?.currency || DEFAULT_CURRENCY).toUpperCase() || DEFAULT_CURRENCY,
    tripType: parsed?.tripType || tripType || null,
    routeLabel: toText(parsed?.routeLabel) || null,
    rows,
    rawText,
  };
}

async function callOpenAIVision({ files, tripType }) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY not set");
  }

  const prompt = buildPrompt({ tripType, fileCount: files.length });
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "You extract flight prices from screenshots and return JSON only.",
        },
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            ...files.map((file) => ({
              type: "image_url",
              image_url: {
                url: `data:${file.mimeType};base64,${file.buffer.toString("base64")}`,
              },
            })),
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`OpenAI vision failed with status ${response.status}${text ? `: ${text}` : ""}`);
  }

  const data = await response.json();
  const rawText = data?.choices?.[0]?.message?.content || "";
  const parsed = parseJsonLoose(rawText);
  const rows = normalizeRows(parsed);
  if (!rows.length) {
    throw new Error("OpenAI did not return any fare rows");
  }
  return {
    provider: "openai",
    model: OPENAI_MODEL,
    stub: false,
    currency: toText(parsed?.currency || DEFAULT_CURRENCY).toUpperCase() || DEFAULT_CURRENCY,
    tripType: parsed?.tripType || tripType || null,
    routeLabel: toText(parsed?.routeLabel) || null,
    rows,
    rawText,
  };
}

async function callGroqTextFallback({ files, tripType }) {
  if (!process.env.GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY not set");
  }

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

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content: "You extract flight prices from OCR text and return JSON only.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Groq fallback failed with status ${response.status}${text ? `: ${text}` : ""}`);
  }

  const data = await response.json();
  const rawText = data?.choices?.[0]?.message?.content || "";
  const parsed = parseJsonLoose(rawText);
  const rows = normalizeRows(parsed);
  if (!rows.length) {
    throw new Error("Groq did not return any fare rows");
  }
  return {
    provider: "groq",
    model: GROQ_MODEL,
    stub: false,
    currency: toText(parsed?.currency || DEFAULT_CURRENCY).toUpperCase() || DEFAULT_CURRENCY,
    tripType: parsed?.tripType || tripType || null,
    routeLabel: toText(parsed?.routeLabel) || null,
    rows,
    rawText,
  };
}

async function extractFlightOfferPricing({ files = [], tripType = null } = {}) {
  const prepared = await prepareImages(files);
  const attemptPlan = [
    { key: process.env.GEMINI_API_KEY, run: () => module.exports.callGeminiVision({ files: prepared, tripType }) },
    { key: process.env.OPENAI_API_KEY, run: () => module.exports.callOpenAIVision({ files: prepared, tripType }) },
    { key: process.env.GROQ_API_KEY, run: () => module.exports.callGroqTextFallback({ files: prepared, tripType }) },
  ];

  let lastError = null;
  for (const attempt of attemptPlan) {
    if (!attempt.key) continue;
    try {
      const result = await attempt.run();
      if (result?.rows?.length) return result;
      lastError = new Error("No fare rows returned");
    } catch (error) {
      lastError = error;
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
    note: lastError ? lastError.message : "No LLM keys were available for extraction.",
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
  callGeminiVision,
  callOpenAIVision,
  callGroqTextFallback,
};
