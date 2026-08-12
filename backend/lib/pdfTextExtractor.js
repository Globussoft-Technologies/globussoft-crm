/**
 * PDF text extraction for the Travel RAG knowledge base.
 *
 * Strategy:
 *   1. Use pdfjs-dist to extract embedded text from each page.
 *   2. If a page has fewer than 40 characters of text, treat it as scanned/image
 *      and run tesseract.js OCR on the rendered page bitmap (if the Node canvas
 *      package is available). If canvas is unavailable or incompatible, the page
 *      is returned with whatever text was extracted.
 *   3. Return { text, pages: [{ pageNumber, text, viaOcr }] }.
 *
 * The function is fail-soft: if text extraction returns nothing, an empty string
 * is returned (never throws) so the sync engine can mark the file as failed.
 */

const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");
const Tesseract = require("tesseract.js");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");

const OCR_TEXT_THRESHOLD = 40; // chars
const OCR_DPI = 150;

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
    console.warn("[pdfTextExtractor] Node canvas unavailable; OCR fallback disabled:", e.message);
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

async function renderPageToPng(pdfDocument, pageNumber, scale = OCR_DPI / 72) {
  const page = await pdfDocument.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const canvasFactory = new NodeCanvasFactory();
  const canvasAndContext = canvasFactory.create(viewport.width, viewport.height);
  const renderContext = {
    canvasContext: canvasAndContext.context,
    viewport,
  };
  await page.render(renderContext).promise;

  const canvasMod = getCanvasModule();
  const tmpFile = path.join(os.tmpdir(), `rag-pdf-ocr-${crypto.randomBytes(8).toString("hex")}.png`);
  const buf = canvasMod.toBuffer
    ? canvasMod.toBuffer(canvasAndContext.canvas, "image/png")
    : canvasAndContext.canvas.toBuffer("image/png");
  fs.writeFileSync(tmpFile, buf);
  return tmpFile;
}

async function runOcr(pdfDocument, pageNumber) {
  if (!getCanvasModule()) return "";
  const tmpFile = await renderPageToPng(pdfDocument, pageNumber);
  try {
    const {
      data: { text: ocrText },
    } = await Tesseract.recognize(tmpFile, "eng", { logger: () => {} });
    return String(ocrText || "")
      .replace(/\s+/g, " ")
      .trim();
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

async function extractPageText(pdfDocument, pageNumber) {
  let text = "";
  let viaOcr = false;
  try {
    const page = await pdfDocument.getPage(pageNumber);
    const textContent = await page.getTextContent();
    text = textContent.items
      .map((item) => (item.str || ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    if (text.length < OCR_TEXT_THRESHOLD) {
      viaOcr = true;
      try {
        text = await runOcr(pdfDocument, pageNumber);
      } catch (ocrErr) {
        console.warn(`[pdfTextExtractor] OCR failed page ${pageNumber}:`, ocrErr.message);
      }
    }
  } catch (pageErr) {
    console.warn(`[pdfTextExtractor] extract page ${pageNumber} failed:`, pageErr.message);
  }
  return { pageNumber, text, viaOcr };
}

/**
 * Extract text from a PDF buffer.
 *
 * @param {Buffer} buffer
 * @returns {Promise<{text: string, pages: Array<{pageNumber:number, text:string, viaOcr:boolean}>}>}
 */
async function extractText(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { text: "", pages: [] };
  }

  try {
    const data = new Uint8Array(buffer);
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    const pageCount = pdf.numPages;
    const pages = [];
    for (let i = 1; i <= pageCount; i += 1) {
      const pageResult = await extractPageText(pdf, i);
      pages.push(pageResult);
    }
    const text = pages
      .map((p) => `--- Page ${p.pageNumber} ---\n${p.text}`)
      .join("\n\n");
    return { text, pages };
  } catch (e) {
    console.error("[pdfTextExtractor] extractText failed:", e.message);
    return { text: "", pages: [] };
  }
}

module.exports = { extractText, OCR_TEXT_THRESHOLD };
