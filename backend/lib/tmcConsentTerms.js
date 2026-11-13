"use strict";

const fs = require("fs");
const path = require("path");
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");

const TMC_CONSENT_TEMPLATE_ASSETS = Object.freeze({
  day_trip: "day-tour-terms.pdf",
  domestic: "domestic-terms.pdf",
  international: "international-terms.pdf",
});
const TMC_CONSENT_TEMPLATE_ASSET_DIR = path.resolve(__dirname, "../assets/tmc-consent-templates");
const STANDARD_FONT_DATA_URL = `${path.join(__dirname, "../node_modules/pdfjs-dist/standard_fonts")}${path.sep}`;
const termsCache = new Map();

function normalizeTmcConsentTripType(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (normalized === "day" || normalized === "day_tour") return "day_trip";
  return Object.prototype.hasOwnProperty.call(TMC_CONSENT_TEMPLATE_ASSETS, normalized)
    ? normalized
    : null;
}

async function extractPdfTerms(buffer) {
  const pdf = await pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
  }).promise;
  const pages = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const text = textContent.items
      .map((item) => String(item.str || "").trim())
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text) pages.push(text);
  }
  return pages.join("\n\n").trim();
}

async function loadBundledTmcConsentTerms(tripType) {
  const normalizedTripType = normalizeTmcConsentTripType(tripType);
  if (!normalizedTripType) return "";
  if (termsCache.has(normalizedTripType)) return termsCache.get(normalizedTripType);

  const filePath = path.join(TMC_CONSENT_TEMPLATE_ASSET_DIR, TMC_CONSENT_TEMPLATE_ASSETS[normalizedTripType]);
  if (!fs.existsSync(filePath)) return "";

  try {
    const terms = await extractPdfTerms(fs.readFileSync(filePath));
    termsCache.set(normalizedTripType, terms);
    return terms;
  } catch (error) {
    console.warn(`[tmc-consent-terms] unable to extract ${normalizedTripType} terms: ${error.message || error}`);
    return "";
  }
}

module.exports = {
  extractPdfTerms,
  loadBundledTmcConsentTerms,
  normalizeTmcConsentTripType,
};
