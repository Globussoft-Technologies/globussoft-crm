// Passport OCR integration client — LOCAL MODE (tesseract.js + MRZ parser).
//
// Real, credential-free, on-box OCR focused on the passport MRZ (the two
// machine-readable lines at the bottom):
//
//   image ─► jimp preprocess (greyscale + contrast + upscale; MRZ-band crop)
//         ─► tesseract.js (eng, OCR-B-ish, MRZ char whitelist)
//         ─► lib/mrzParser.js (ICAO 9303 TD3) ─► fields + check digits
//         ─► extraction envelope (SAME shape as the old stub)
//
// Why MRZ-first: the MRZ is a fixed-layout, self-checking Latin/OCR-B string,
// so it survives messy scans far better than the free-form visual zone — and
// the check digits give us a real confidence. Place of birth / issue + issue
// date are NOT in the MRZ, so they stay null (operator fills via Edit&approve).
//
// English focus: only the `eng` traineddata is loaded. The MRZ alphabet is
// Latin regardless of the holder's language, so MRZ extraction is language-
// agnostic; non-Latin visual zones are out of scope.
//
// Contract (unchanged): extractPassport(...) →
//   { extraction, confidence, provider, extractedAt, mrzFound, checks?, note? }
// Throws PASSPORT_OCR_NOT_YET_ENABLED when disabled / no tenant. Never throws
// on a bad image / PDF / illegible scan: returns a low-confidence envelope with
// null fields + a note so the upload still lands and the operator completes it.

const fs = require("fs");
const { parseMrz } = require("../lib/mrzParser");
const { parseViz } = require("../lib/passportVizParser");

const INTEGRATION = "passport-ocr";
const PROVIDER = "local-mrz-v1";
// Hard cap so a pathological image / cold traineddata fetch can't hang the
// request thread indefinitely (review: OCR runs inline in the HTTP request).
const OCR_TIMEOUT_MS = Number(process.env.PASSPORT_OCR_TIMEOUT_MS || 30000);
const MRZ_WHITELIST = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<";

function isEnabledForTenant(tenantId) {
  if (!tenantId) return false;
  if (process.env.PASSPORT_OCR_DISABLED === "1") return false;
  return true;
}

// Resolve the OCR input to a Buffer (so jimp + tesseract both get bytes).
function resolveImageBuffer({ filePath, fileBuffer }) {
  if (Buffer.isBuffer(fileBuffer)) return fileBuffer;
  if (filePath && fs.existsSync(filePath)) {
    try { return fs.readFileSync(filePath); } catch (_e) { return null; }
  }
  return null;
}

// Preprocess for OCR with jimp: optional crop to the bottom MRZ band, then
// greyscale + contrast + upscale (tesseract reads big, high-contrast glyphs
// far better). Returns a PNG Buffer, or null if anything fails (caller then
// OCRs the raw bytes — preprocessing is an optimization, never a hard
// dependency).
async function preprocessImage(buffer, { mrzBand } = {}) {
  try {
    const { Jimp } = await import("jimp");
    const img = await Jimp.read(buffer);
    if (mrzBand) {
      const w = img.bitmap.width;
      const h = img.bitmap.height;
      const top = Math.floor(h * 0.7); // MRZ sits in the bottom ~30%
      img.crop({ x: 0, y: top, w, h: h - top });
    }
    img.greyscale().contrast(0.4);
    const curW = img.bitmap.width;
    if (curW > 0 && curW < 1400) {
      const factor = Math.min(4, Math.max(2, Math.ceil(1400 / curW)));
      img.scale(factor);
    }
    return await img.getBuffer("image/png");
  } catch (_e) {
    return null;
  }
}

// Run OCR over an image buffer → { mrzText, vizText, confidence }.
//
// opts.ocr is a test/vendor seam: when provided, it fully replaces the engine
// (no jimp, no worker created). Its return is normalised — { text } feeds both
// MRZ and VIZ; { mrzText, vizText } feeds them separately.
//
// Real path = two OCR passes on one worker:
//   - MRZ pass: char whitelist [A-Z0-9<] + PSM 6 over the cropped MRZ band AND
//     the full image — best signal for the two machine-readable lines.
//   - VIZ pass: NO whitelist + PSM 3 (auto) over the full image — needed to
//     read the printed labels ("Date of Birth", mixed case, slashes) that the
//     MRZ whitelist would strip.
async function runOcr(imageBuffer, opts = {}) {
  if (typeof opts.ocr === "function") {
    const r = (await opts.ocr(imageBuffer)) || {};
    return {
      mrzText: r.mrzText ?? r.text ?? "",
      vizText: r.vizText ?? r.text ?? "",
      confidence: r.confidence ?? null,
    };
  }
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("eng");
  try {
    const band = await preprocessImage(imageBuffer, { mrzBand: true });
    const full = await preprocessImage(imageBuffer, { mrzBand: false });

    // ── MRZ pass ──
    await worker.setParameters({
      tessedit_char_whitelist: MRZ_WHITELIST,
      tessedit_pageseg_mode: "6",
    });
    const mrzParts = [];
    let confidence = null;
    for (const view of [band, full].filter(Boolean)) {
      const { data } = await worker.recognize(view);
      if (data?.text) mrzParts.push(data.text);
      if (Number.isFinite(data?.confidence)) confidence = Math.max(confidence ?? 0, data.confidence);
    }
    if (!mrzParts.length) {
      const { data } = await worker.recognize(imageBuffer);
      mrzParts.push(data?.text || "");
      if (Number.isFinite(data?.confidence)) confidence = data.confidence;
    }

    // ── VIZ pass (labels need mixed case + punctuation → no whitelist) ──
    let vizText = "";
    try {
      await worker.setParameters({ tessedit_char_whitelist: "", tessedit_pageseg_mode: "3" });
      const { data } = await worker.recognize(full || imageBuffer);
      vizText = data?.text || "";
    } catch (_e) { /* VIZ is best-effort */ }

    return { mrzText: mrzParts.join("\n"), vizText, confidence };
  } finally {
    await worker.terminate().catch(() => {});
  }
}

// A name that still carries OCR'd MRZ filler (chevrons '<' misread as repeated
// K/L/etc.) shows runs of the same letter — real names almost never do.
function nameLooksCorrupted(name) {
  if (!name) return true;
  return /([A-Z])\1{2,}/.test(name) || name.replace(/\s/g, "").length > 30;
}

// Race a promise against a timeout; clears the timer on settle.
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error("OCR timed out");
      err.code = "OCR_TIMEOUT";
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Confidence in [0,1], anchored on the check-digit pass ratio (the trustworthy
// signal), nudged by OCR's own word-confidence. Number.isFinite guards NaN
// (typeof NaN === 'number', which would otherwise poison the score → null).
function scoreConfidence(parsed, ocrConfidence) {
  if (!parsed) return 0;
  const ratio = parsed.checksTotal ? parsed.checksPassed / parsed.checksTotal : 0;
  let base = 0.3 + ratio * 0.65; // 0 checks → 0.3, all checks → 0.95
  if (Number.isFinite(ocrConfidence)) {
    base = base * 0.85 + (Math.max(0, Math.min(100, ocrConfidence)) / 100) * 0.15;
  }
  return Math.round(base * 100) / 100;
}

// PDF detection — prefer the validated mimetype (filename is attacker-supplied).
function isPdf(mimeType, fileName, filePath) {
  if ((mimeType || "").toLowerCase() === "application/pdf") return true;
  const n = `${fileName || ""}${filePath || ""}`.toLowerCase();
  return n.endsWith(".pdf");
}

function buildExtraction(parsed) {
  const f = parsed?.fields || {};
  return {
    passportNumber: f.passportNumber || null,
    surname: f.surname || null,
    givenNames: f.givenNames || null,
    dateOfBirth: f.dateOfBirth || null,
    sex: f.sex || null,
    nationality: f.nationality || null,
    placeOfBirth: null, // not in the MRZ
    placeOfIssue: null, // not in the MRZ
    dateOfIssue: null, // not in the MRZ
    dateOfExpiry: f.dateOfExpiry || null,
    mrz: parsed?.mrz || null,
  };
}

function manualEnvelope(extractedAt, note) {
  return {
    extraction: buildExtraction(null),
    confidence: 0,
    provider: PROVIDER,
    extractedAt,
    mrzFound: false,
    note,
  };
}

/**
 * Extract passport fields from an uploaded image.
 *
 * Options: tenantId (required), filePath | fileBuffer (the image), fileName,
 * mimeType (preferred for PDF detection), ocr (test/vendor seam).
 * Returns the extraction envelope; throws PASSPORT_OCR_NOT_YET_ENABLED only
 * when disabled / no tenant. All other failure modes degrade to a manual
 * envelope so the upload still lands.
 */
async function extractPassport({ tenantId, filePath, fileBuffer, fileName, mimeType, ocr } = {}) {
  if (!isEnabledForTenant(tenantId)) {
    const err = new Error("Passport OCR not enabled for this tenant (PASSPORT_OCR_DISABLED).");
    err.code = "PASSPORT_OCR_NOT_YET_ENABLED";
    throw err;
  }

  const extractedAt = new Date().toISOString();

  if (isPdf(mimeType, fileName, filePath)) {
    return manualEnvelope(extractedAt, "PDF uploads are not auto-extracted yet — please verify the fields manually.");
  }

  const buffer = resolveImageBuffer({ filePath, fileBuffer });
  if (!buffer) {
    return manualEnvelope(extractedAt, "No readable image was provided.");
  }

  let mrzText = "";
  let vizText = "";
  let ocrConfidence = null;
  try {
    const result = await withTimeout(runOcr(buffer, { ocr }), OCR_TIMEOUT_MS);
    mrzText = result?.mrzText || "";
    vizText = result?.vizText || "";
    ocrConfidence = result?.confidence ?? null;
  } catch (e) {
    console.error(`[passportOcrClient] OCR error (${e.code || "engine"}): ${e.message}`);
    return manualEnvelope(extractedAt, "Automatic extraction failed — please verify the fields manually.");
  }

  const mrz = parseMrz(mrzText, { nowYearLast2: new Date().getFullYear() % 100 });
  const viz = parseViz(vizText);

  if (!mrz && !viz) {
    return manualEnvelope(extractedAt, "Couldn't read the passport's machine-readable zone or printed fields — please verify the fields manually.");
  }

  return {
    ...mergeExtraction(mrz, viz, ocrConfidence),
    provider: PROVIDER,
    extractedAt,
  };
}

// Merge MRZ + VIZ into the extraction envelope. For the three check-protected
// fields (number / DOB / expiry) we trust the MRZ ONLY when its check digit
// passed, otherwise the VIZ value (then MRZ as a last resort). For fields with
// no check digit (name / nationality / sex) we trust the MRZ when it's broadly
// valid, else the VIZ. This is what lets a passport with a malformed/non-ICAO
// MRZ still extract correctly from its printed visual zone.
function mergeExtraction(mrz, viz, ocrConfidence) {
  const mf = mrz?.fields || {};
  const checks = mrz?.checks || {};
  const v = viz || {};
  const mrzBroadlyValid = Boolean(checks.passportNumber || checks.dateOfBirth || checks.dateOfExpiry);

  // Prefer MRZ when its per-field check passed; else VIZ; else MRZ raw.
  const pickChecked = (mrzVal, vizVal, ok) => (ok ? mrzVal : null) || vizVal || mrzVal || null;
  // Prefer MRZ when broadly valid; else VIZ; else MRZ raw.
  const pickTrust = (mrzVal, vizVal) => (mrzBroadlyValid ? mrzVal : null) || vizVal || mrzVal || null;

  // Name: MRZ line 1 is preferred when it's broadly valid AND not corrupted by
  // misread fillers; otherwise fall back to the printed full name.
  let surname = mf.surname || null;
  let givenNames = mf.givenNames || null;
  if (!mrzBroadlyValid || nameLooksCorrupted(mf.surname) || nameLooksCorrupted(mf.givenNames)) {
    if (v.fullName) { surname = null; givenNames = v.fullName; }
  }

  const extraction = {
    passportNumber: pickChecked(mf.passportNumber, v.passportNumber, checks.passportNumber),
    surname,
    givenNames,
    dateOfBirth: pickChecked(mf.dateOfBirth, v.dateOfBirth, checks.dateOfBirth),
    sex: mf.sex || v.sex || null,
    nationality: pickTrust(mf.nationality, v.nationality),
    placeOfBirth: null,
    placeOfIssue: null,
    dateOfIssue: v.dateOfIssue || null,
    dateOfExpiry: pickChecked(mf.dateOfExpiry, v.dateOfExpiry, checks.dateOfExpiry),
    mrz: mrz?.mrz || null,
  };

  let confidence;
  let note = null;
  if (mrz?.valid) {
    confidence = scoreConfidence(mrz, ocrConfidence);
  } else {
    // Relied on the visual zone (or a partial MRZ) — score by how many key
    // fields we recovered, and flag for an operator double-check.
    const hits = [extraction.passportNumber, extraction.dateOfBirth, extraction.dateOfExpiry, extraction.nationality].filter(Boolean).length;
    const mrzRatio = mrz ? mrz.checksPassed / mrz.checksTotal : 0;
    confidence = Math.round(Math.min(0.8, 0.35 + hits * 0.1 + mrzRatio * 0.2) * 100) / 100;
    note = "Some fields were read from the printed page (the machine-readable zone didn't fully validate) — please double-check before approving.";
  }

  return {
    extraction,
    confidence,
    mrzFound: Boolean(mrz),
    vizFound: Boolean(viz),
    checks: mrz?.checks || null,
    note,
  };
}

module.exports = { extractPassport, isEnabledForTenant, runOcr, INTEGRATION };
