"use strict";

const { parseCsv, parseXlsxBuffer, toXlsxBuffer } = require("./csvIO");
const { sanitizeText } = require("./sanitizeJson");

const TEMPLATE_HEADERS = [
  "tripId",
  "title",
  "tagline",
  "tier",
  "region",
  "durationDays",
  "durationNights",
  "minGradeBand",
  "maxGradeBand",
  "boardsSupportedJson",
  "minGroupSize",
  "priceBand",
  "indicativePricePerStudent",
  "primaryOutcomesJson",
  "skillsDevelopedJson",
  "subjectsTouchedJson",
  "anchorExperiencesJson",
  "curriculumHooksJson",
  "reportSkillBlurb",
  "summaryForBrief",
  "imageUrl",
];

const TEMPLATE_SAMPLE = {
  tripId: "golden-triangle-school-heritage",
  title: "Golden Triangle School Heritage Trail",
  tagline: "Delhi, Agra, and Jaipur as one classroom.",
  tier: "domestic",
  region: "North India",
  durationDays: 6,
  durationNights: 5,
  minGradeBand: "6-8",
  maxGradeBand: "9-10",
  boardsSupportedJson: "[\"CBSE\",\"ICSE\"]",
  minGroupSize: 25,
  priceBand: "30k-75k",
  indicativePricePerStudent: 55000,
  primaryOutcomesJson: "[\"cultural-immersion\",\"history-deep-dive\"]",
  skillsDevelopedJson: "[\"communication\",\"collaboration\"]",
  subjectsTouchedJson: "[\"History\",\"Geography\",\"Art\"]",
  anchorExperiencesJson:
    "[{\"name\":\"Taj Mahal sunrise\",\"what_students_do\":\"Sketching and discussion\",\"skill_link\":\"Cultural respect and inclusion\",\"subject_link\":\"History\"}]",
  curriculumHooksJson:
    "[{\"board\":\"CBSE\",\"grade_band\":\"9-10\",\"subject\":\"History\",\"topic\":\"Mughal India\",\"hook_text\":\"Direct alignment with medieval India topics\"}]",
  reportSkillBlurb:
    "Students build historical reasoning and cultural fluency through a structured three-city route.",
  summaryForBrief:
    "A school-focused heritage circuit that pairs cleanly with CBSE and ICSE middle-school history learning.",
  imageUrl: "",
};

const REQUIRED_FIELDS = new Set([
  "tripId",
  "title",
  "tier",
  "durationDays",
  "minGradeBand",
  "maxGradeBand",
  "boardsSupportedJson",
  "minGroupSize",
  "priceBand",
  "primaryOutcomesJson",
  "skillsDevelopedJson",
  "subjectsTouchedJson",
  "anchorExperiencesJson",
  "curriculumHooksJson",
  "reportSkillBlurb",
  "summaryForBrief",
]);

const JSON_ARRAY_FIELDS = new Set([
  "boardsSupportedJson",
  "primaryOutcomesJson",
  "skillsDevelopedJson",
  "subjectsTouchedJson",
  "anchorExperiencesJson",
  "curriculumHooksJson",
]);

const OPTIONAL_NUMERIC_FIELDS = new Set([
  "durationNights",
  "indicativePricePerStudent",
]);

function isXlsxUpload(file) {
  if (!file) return false;
  const name = String(file.originalname || "").toLowerCase();
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) return true;
  const mt = String(file.mimetype || "").toLowerCase();
  return (
    mt === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mt === "application/vnd.ms-excel"
  );
}

function parseSpreadsheetBuffer(buffer, file) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error("parseSpreadsheetBuffer: buffer is required");
  }
  return isXlsxUpload(file)
    ? parseXlsxBuffer(buffer)
    : parseCsv(buffer.toString("utf8"));
}

function normalizeText(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function parseNumericField(raw, fieldName, { allowZero = false } = {}) {
  const text = normalizeText(raw);
  if (!text) {
    if (OPTIONAL_NUMERIC_FIELDS.has(fieldName)) return null;
    return { error: `${fieldName} is required` };
  }
  const n = Number(text);
  if (!Number.isInteger(n) || (allowZero ? n < 0 : n <= 0)) {
    return {
      error: `${fieldName} must be a ${allowZero ? "non-negative" : "positive"} integer`,
    };
  }
  return n;
}

function parseJsonArrayField(raw, fieldName) {
  const text = normalizeText(raw);
  if (!text) {
    return { error: `${fieldName} is required` };
  }

  if (text.startsWith("[") || text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return JSON.stringify(parsed);
      }
      if (parsed && typeof parsed === "object") {
        return JSON.stringify(parsed);
      }
    } catch {
      return { error: `${fieldName} must be valid JSON or a comma-separated list` };
    }
  }

  return JSON.stringify(
    text
      .split(",")
      .map((item) => sanitizeText(item))
      .filter((item) => item.length > 0),
  );
}

function parseCatalogueImportRow(raw, rowNumber) {
  const errors = [];
  const data = {};

  for (const field of REQUIRED_FIELDS) {
    if (normalizeText(raw[field]).length === 0) {
      errors.push({ rowNumber, reason: `${field} is required` });
    }
  }

  const tripId = sanitizeText(normalizeText(raw.tripId));
  if (tripId) data.tripId = tripId;

  const title = sanitizeText(normalizeText(raw.title));
  if (title) data.title = title;

  const tagline = normalizeText(raw.tagline);
  data.tagline = tagline ? sanitizeText(tagline) : null;

  const tier = sanitizeText(normalizeText(raw.tier));
  if (tier) data.tier = tier;

  const region = normalizeText(raw.region);
  data.region = region ? sanitizeText(region) : null;

  const durationDays = parseNumericField(raw.durationDays, "durationDays", { allowZero: true });
  if (durationDays && durationDays.error) errors.push({ rowNumber, reason: durationDays.error });
  else if (durationDays !== null) data.durationDays = durationDays;

  const durationNights = parseNumericField(raw.durationNights, "durationNights", { allowZero: true });
  if (durationNights && durationNights.error) errors.push({ rowNumber, reason: durationNights.error });
  else if (durationNights !== null) data.durationNights = durationNights;

  const minGradeBand = sanitizeText(normalizeText(raw.minGradeBand));
  if (minGradeBand) data.minGradeBand = minGradeBand;

  const maxGradeBand = sanitizeText(normalizeText(raw.maxGradeBand));
  if (maxGradeBand) data.maxGradeBand = maxGradeBand;

  const boardsSupportedJson = parseJsonArrayField(raw.boardsSupportedJson, "boardsSupportedJson");
  if (boardsSupportedJson && boardsSupportedJson.error) errors.push({ rowNumber, reason: boardsSupportedJson.error });
  else if (boardsSupportedJson !== undefined) data.boardsSupportedJson = boardsSupportedJson;

  const minGroupSize = parseNumericField(raw.minGroupSize, "minGroupSize");
  if (minGroupSize && minGroupSize.error) errors.push({ rowNumber, reason: minGroupSize.error });
  else if (minGroupSize !== null) data.minGroupSize = minGroupSize;

  const priceBand = sanitizeText(normalizeText(raw.priceBand));
  if (priceBand) data.priceBand = priceBand;

  const indicativePricePerStudent = parseNumericField(raw.indicativePricePerStudent, "indicativePricePerStudent", {
    allowZero: true,
  });
  if (indicativePricePerStudent && indicativePricePerStudent.error) {
    errors.push({ rowNumber, reason: indicativePricePerStudent.error });
  } else if (indicativePricePerStudent !== null) {
    data.indicativePricePerStudent = indicativePricePerStudent;
  }

  for (const field of [
    "primaryOutcomesJson",
    "skillsDevelopedJson",
    "subjectsTouchedJson",
    "anchorExperiencesJson",
    "curriculumHooksJson",
  ]) {
    const parsed = parseJsonArrayField(raw[field], field);
    if (parsed && parsed.error) {
      errors.push({ rowNumber, reason: parsed.error });
    } else if (parsed !== undefined) {
      data[field] = parsed;
    }
  }

  const reportSkillBlurb = sanitizeText(normalizeText(raw.reportSkillBlurb));
  if (reportSkillBlurb) data.reportSkillBlurb = reportSkillBlurb;

  const summaryForBrief = sanitizeText(normalizeText(raw.summaryForBrief));
  if (summaryForBrief) data.summaryForBrief = summaryForBrief;

  const imageUrl = normalizeText(raw.imageUrl);
  data.imageUrl = imageUrl ? sanitizeText(imageUrl) : null;

  return {
    errors,
    data,
    naturalKey: tripId ? tripId.toLowerCase() : "",
    reviewLabel: "AI-classified, pending review",
  };
}

function buildTemplateBuffer(format) {
  const rows = [TEMPLATE_SAMPLE];
  if (format === "xlsx") {
    return toXlsxBuffer(TEMPLATE_HEADERS, rows, "TMC Catalogue");
  }
  const { serializeRows } = require("./csvHelpers");
  return serializeRows(
    TEMPLATE_HEADERS.map((header) => ({ key: header, header })),
    rows,
  );
}

module.exports = {
  TEMPLATE_HEADERS,
  TEMPLATE_SAMPLE,
  REQUIRED_FIELDS,
  isXlsxUpload,
  parseSpreadsheetBuffer,
  normalizeText,
  parseNumericField,
  parseJsonArrayField,
  parseCatalogueImportRow,
  buildTemplateBuffer,
};
