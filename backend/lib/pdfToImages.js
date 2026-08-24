"use strict";

// Convert PDF pages to PNG image parts so non-Gemini vision providers
// (OpenAI-compatible / Anthropic) can consume them. Gemini already accepts
// application/pdf inline_data, so this path is only used as a fallback.

const path = require("path");
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");

const STANDARD_FONT_DATA_URL = path.join(__dirname, "..", "node_modules", "pdfjs-dist", "standard_fonts");

let canvasModule = null;
let canvasModuleFailed = false;

function getCanvasModule() {
  if (canvasModule) return canvasModule;
  if (canvasModuleFailed) return null;
  try {
    canvasModule = require("canvas");
    return canvasModule;
  } catch (e) {
    canvasModuleFailed = true;
    console.warn("[pdfToImages] Node canvas unavailable; PDF-to-image conversion disabled:", e.message);
    return null;
  }
}

class NodeCanvasFactory {
  create(width, height) {
    const canvasMod = getCanvasModule();
    if (!canvasMod || typeof canvasMod.createCanvas !== "function") {
      throw new Error("Node canvas not available for PDF rendering");
    }
    const canvas = canvasMod.createCanvas(width, height);
    const context = canvas.getContext("2d");
    return { canvas, context };
  }
}

async function renderPageToPngBuffer(pdfDocument, pageNumber, scale) {
  const page = await pdfDocument.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const canvasFactory = new NodeCanvasFactory();
  const canvasAndContext = canvasFactory.create(viewport.width, viewport.height);
  await page.render({ canvasContext: canvasAndContext.context, viewport }).promise;

  const canvasMod = getCanvasModule();
  const buf = canvasMod.toBuffer
    ? canvasMod.toBuffer(canvasAndContext.canvas, "image/png")
    : canvasAndContext.canvas.toBuffer("image/png");
  return buf;
}

/**
 * Convert a PDF buffer to vision-provider image parts.
 *
 * @param {Buffer} buffer
 * @param {object} options
 * @param {number} [options.maxPages=5]
 * @param {number} [options.scale=2.0] - page render scale (DPI ratio; 2 = ~144 DPI)
 * @returns {Promise<Array<{type:'image', mimeType:'image/png', data:string}>>}
 */
async function pdfBufferToImageParts(buffer, { maxPages = 5, scale = 200 / 72 } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return [];
  if (!getCanvasModule()) return [];

  try {
    const data = new Uint8Array(buffer);
    const pdf = await pdfjsLib.getDocument({ data, standardFontDataUrl: STANDARD_FONT_DATA_URL }).promise;
    const count = Math.min(pdf.numPages, Math.max(1, Number(maxPages) || 1));
    const parts = [];
    for (let i = 1; i <= count; i += 1) {
      const pngBuf = await renderPageToPngBuffer(pdf, i, scale);
      parts.push({ type: "image", mimeType: "image/png", data: pngBuf.toString("base64") });
    }
    return parts;
  } catch (e) {
    console.error("[pdfToImages] conversion failed:", e.message);
    return [];
  }
}

module.exports = { pdfBufferToImageParts };
