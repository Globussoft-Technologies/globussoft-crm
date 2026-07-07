// Passport OCR integration client — LOCAL MODE (tesseract.js + MRZ parser).
//
// Real, credential-free, on-box OCR focused on the passport MRZ (the two
// machine-readable lines at the bottom):
//
//   image ─► sharp preprocess (deskew + adaptive threshold + MRZ-band crop)
//         ─► tesseract.js (eng/osd, OCR-B-ish, MRZ char whitelist)
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
const path = require("path");
const { parseMrz, computeCheckDigit } = require("../lib/mrzParser");
const { parseViz } = require("../lib/passportVizParser");
const passportImagePipeline = require("../lib/passportImagePipeline");

const INTEGRATION = "passport-ocr";
const PROVIDER = "local-mrz-v1";
// Hard cap so a pathological image / cold traineddata fetch can't hang the
// request thread indefinitely (review: OCR runs inline in the HTTP request).
const OCR_TIMEOUT_MS = Number(process.env.PASSPORT_OCR_TIMEOUT_MS || 30000);
const MRZ_WHITELIST = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<";

// tesseract.js fetches the `eng` traineddata (~10 MB) from a CDN on first use
// and caches it. On an OUTBOUND-RESTRICTED server that download fails and OCR
// degrades to manual entry. To run fully offline, drop eng.traineddata into a
// directory and point PASSPORT_OCR_LANG_PATH at it (the file must be
// uncompressed, i.e. eng.traineddata, not .gz). When set we pass it as the
// worker's langPath with gzip:false; otherwise the default CDN path is used.
const LANG_PATH = process.env.PASSPORT_OCR_LANG_PATH
  || (fs.existsSync(path.join(__dirname, "..", "eng.traineddata")) ? path.join(__dirname, "..") : null);

// MRZ-specific OCR-B traineddata. We keep it optional: if `ocrb.traineddata`
// exists locally (or in the configured LANG_PATH) we use it for the MRZ passes
// and fall back to `eng` for the visual zone. This avoids fetching from the CDN
// on outbound-restricted servers and lets us ship a model tuned for the MRZ
// monospace/OCR-B glyph set.
const MRZ_LANG = (() => {
  if (!LANG_PATH) return "eng";
  const hasOcrb = fs.existsSync(path.join(LANG_PATH, "ocrb.traineddata"));
  return hasOcrb ? "ocrb" : "eng";
})();
const VIZ_LANG = "eng";

// Pre-load both language packs so reinitializing between MRZ and VIZ passes
// does not hit the network. If `ocrb` is not available, `eng` is used for both.
const WORKER_LANGS = MRZ_LANG === "ocrb" ? "eng+ocrb" : "eng";

// OSD orientation detection is DISABLED by default. tesseract.js will crash
// the Node process if `osd.traineddata` is not locally available and the CDN
// download fails/blocked. Only enable when PASSPORT_OCR_OSD=1 AND the file is
// present locally (or inside the configured LANG_PATH).
function isOsdEnabled() {
  if (process.env.PASSPORT_OCR_OSD !== "1") return false;
  const candidates = [
    LANG_PATH && path.join(LANG_PATH, "osd.traineddata"),
    path.join(__dirname, "..", "osd.traineddata"),
  ].filter(Boolean);
  return candidates.some((p) => fs.existsSync(p));
}

// OCR is CPU/RAM heavy and runs inline in the request (review #3). A small
// in-process semaphore bounds how many recognitions run at once so a burst of
// uploads can't spawn unbounded tesseract workers and exhaust the box. A real
// job queue / worker pool is the answer for high volume; this is the cheap
// guard until then. Configurable; default 2.
const OCR_MAX_CONCURRENCY = Math.max(1, Number(process.env.PASSPORT_OCR_MAX_CONCURRENCY || 2));
let ocrActive = 0;
const ocrWaiters = [];
async function withOcrSlot(fn) {
  if (ocrActive >= OCR_MAX_CONCURRENCY) {
    await new Promise((resolve) => ocrWaiters.push(resolve));
  }
  ocrActive++;
  try {
    return await fn();
  } finally {
    ocrActive--;
    const next = ocrWaiters.shift();
    if (next) next();
  }
}

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

// Preprocess for OCR. Delegates to the sharp-based pipeline (deskew, adaptive
// threshold, MRZ band detection, upscale). Returns a PNG Buffer, or null on any
// failure — the caller then falls back to raw bytes.
async function preprocessImage(buffer, { mrzBand } = {}) {
  try {
    return await passportImagePipeline.preprocessImage(buffer, { mrzBand });
  } catch (_e) {
    return null;
  }
}

async function preprocessForViz(buffer) {
  try {
    return await passportImagePipeline.preprocessForViz(buffer);
  } catch (_e) {
    return null;
  }
}

// Run OCR over an image buffer → { mrzText, vizText, confidence }.
//
// opts.ocr is a test/vendor seam: when provided, it fully replaces the engine
// (no sharp, no worker created). Its return is normalised — { text } feeds both
// MRZ and VIZ; { mrzText, vizText } feeds them separately.
//
// Real path = multi-pass strategy:
//   1. OSD orientation detection (90/180/270 correction).
//   2. MRZ passes: char whitelist [A-Z0-9<] + PSM 6 over (a) cropped MRZ band,
//      (b) full preprocessed page, (c) raw image — parsed and voted by MRZ
//      check-digit score so the best readable copy wins.
//   3. VIZ pass: no whitelist + PSM 3 over the deskewed full page for printed
//      labels ("Date of Birth", mixed case, slashes).
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
  const workerOpts = LANG_PATH ? { langPath: LANG_PATH, gzip: false } : {};

  // Try to load the preferred language pack (eng+ocrb when ocrb is available).
  // If that fails — e.g. a corrupted or incompatible traineddata file — fall
  // back to eng alone so OCR doesn't hard-fail for the whole request.
  let worker;
  try {
    worker = await createWorker(WORKER_LANGS, 1, workerOpts);
    console.log(`[passportOcrClient] worker ready: ${WORKER_LANGS}`);
  } catch (e) {
    console.warn(`[passportOcrClient] createWorker(${WORKER_LANGS}) failed, falling back to eng:`, e?.message || e);
    try {
      worker = await createWorker("eng", 1, workerOpts);
      console.log("[passportOcrClient] worker ready: eng (fallback)");
    } catch (e2) {
      console.error("[passportOcrClient] createWorker(eng) also failed:", e2?.message || e2);
      throw e2;
    }
  }
  async function useLanguage(lang) {
    try {
      await worker.reinitialize(lang);
    } catch (e) {
      console.warn(`[passportOcrClient] reinitialize(${lang}) failed, continuing with current language:`, e?.message || e);
    }
  }

  // Helper to run a single recognition pass and always return { text, confidence }.
  async function recognize(view) {
    try {
      const { data } = await worker.recognize(view);
      return { text: data?.text || "", confidence: Number.isFinite(data?.confidence) ? data.confidence : null };
    } catch (e) {
      console.warn("[passportOcrClient] recognize pass failed:", e?.message || e);
      return { text: "", confidence: null };
    }
  }

  try {
    // ── 1. Orientation detection (opt-in, requires local osd.traineddata) ──
    let orientedBuffer = imageBuffer;
    if (isOsdEnabled()) {
      try {
        await worker.reinitialize("osd");
        const osd = await worker.detect(imageBuffer);
        const deg = osd?.data?.orientation_degrees || 0;
        if (deg !== 0) {
          // Rotate the raw buffer first; the preprocessing pipeline then runs on
          // an upright image. We only handle 90°-step rotations here because the
          // pipeline's deskew fixes small camera tilt later.
          const sharp = require("sharp");
          orientedBuffer = await sharp(imageBuffer)
            .rotate(deg, { background: { r: 255, g: 255, b: 255 } })
            .toBuffer();
        }
        await useLanguage(MRZ_LANG);
      } catch (e) {
        console.warn("[passportOcrClient] OSD failed, continuing without rotation:", e?.message || e);
        await useLanguage(MRZ_LANG);
      }
    }

    // ── 2. MRZ passes (OCR-B when available, strict MRZ alphabet) ──
    await useLanguage(MRZ_LANG);
    await worker.setParameters({
      tessedit_char_whitelist: MRZ_WHITELIST,
      tessedit_pageseg_mode: "6",
    });

    const band = await preprocessImage(orientedBuffer, { mrzBand: true });
    const full = await preprocessImage(orientedBuffer, { mrzBand: false });
    const vizFull = await preprocessForViz(orientedBuffer);
    console.log("[passportOcrClient] preprocessed views:", { band: !!band, full: !!full, vizFull: !!vizFull });

    const mrzCandidates = [];
    let bestConfidence = null;

    for (const view of [band, full, orientedBuffer].filter(Boolean)) {
      const { text, confidence } = await recognize(view);
      const label = view === band ? "band" : view === full ? "full" : "raw";
      console.log(`[passportOcrClient] MRZ ${label} text (${text.length} chars):`, text.slice(0, 200).replace(/\n/g, "|"));
      if (text) {
        const parsed = parseMrz(text, { nowYearLast2: new Date().getFullYear() % 100 });
        console.log("[passportOcrClient] MRZ parse:", { found: !!parsed, valid: parsed?.valid, checksPassed: parsed?.checksPassed });
        mrzCandidates.push({ parsed, text, confidence });
        if (Number.isFinite(confidence)) bestConfidence = Math.max(bestConfidence ?? 0, confidence);
      }
    }

    // Pick the MRZ with the strongest check-digit evidence.
    let bestMrzText = "";
    if (mrzCandidates.length) {
      mrzCandidates.sort((a, b) => {
        const score = (c) => (c.parsed?.valid ? 100 : 0) + (c.parsed?.checksPassed || 0) + (Number.isFinite(c.confidence) ? c.confidence / 100 : 0);
        return score(b) - score(a);
      });
      bestMrzText = mrzCandidates[0].text;
    }

    // ── 3. VIZ pass (English, no whitelist, full-page segmentation) ──
    let vizText = "";
    try {
      await useLanguage(VIZ_LANG);
      await worker.setParameters({ tessedit_char_whitelist: "", tessedit_pageseg_mode: "3" });
      const { text } = await recognize(vizFull || full || orientedBuffer);
      vizText = text;
      console.log(`[passportOcrClient] VIZ text (${text.length} chars):`, text.slice(0, 200).replace(/\n/g, "|"));
    } catch (_e) { /* VIZ is best-effort */ }

    return { mrzText: bestMrzText || mrzCandidates.map((c) => c.text).join("\n"), vizText, confidence: bestConfidence };
  } catch (runErr) {
    console.error("[passportOcrClient] runOcr failed:", runErr?.message || runErr, runErr?.stack || "");
    return { mrzText: "", vizText: "", confidence: null };
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

// MRZ passport numbers are alphanumeric, but the digit portion is where OCR-B
// most often slips (G↔6, B↔8, Q↔9, S↔5, Z↔2, O↔0, I↔1). When the MRZ check
// digit happens to pass for the wrong character we use the VIZ value as a
// tie-breaker, provided the VIZ number is also consistent with that check digit.
const OCR_CONFUSIONS = {
  G: "6", "6": "G",
  B: "8", "8": "B",
  Q: "9", "9": "Q",
  S: "5", "5": "S",
  Z: "2", "2": "Z",
  O: "0", "0": "O",
  I: "1", "1": "I",
};

function vizCheckDigitMatches(passportNumber, checkChar) {
  if (!passportNumber || !/^[A-Z0-9<]{1,9}$/.test(passportNumber)) return false;
  const expected = checkChar === "<" ? 0 : parseInt(checkChar, 10);
  if (!Number.isInteger(expected)) return false;
  return computeCheckDigit(passportNumber.padEnd(9, "<")) === expected;
}

function differsByOneConfusion(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    if (OCR_CONFUSIONS[a[i]] === b[i]) {
      diff++;
      continue;
    }
    return false;
  }
  return diff === 1;
}

function resolvePassportNumber(mrz, viz) {
  const mrzNumber = mrz?.fields?.passportNumber || null;
  const vizNumber = viz?.passportNumber || null;
  const checkChar = mrz?.mrz?.split("\n")[1]?.[9] || null;
  if (!mrzNumber) return vizNumber;
  if (!vizNumber) return mrzNumber;
  if (vizNumber === mrzNumber) return mrzNumber;

  // If the VIZ number is consistent with the MRZ check digit and differs by a
  // known single-character OCR confusion, trust the VIZ copy.
  if (checkChar && vizCheckDigitMatches(vizNumber, checkChar)) {
    if (differsByOneConfusion(mrzNumber, vizNumber)) return vizNumber;
    // Also prefer VIZ when the MRZ number has an obvious letter-in-digit slip
    // (e.g. Q34G56789) and the VIZ number is cleaner.
    const mrzLettersAfterPos0 = (mrzNumber.slice(1).match(/[A-Z]/g) || []).length;
    const vizLettersAfterPos0 = (vizNumber.slice(1).match(/[A-Z]/g) || []).length;
    if (mrzLettersAfterPos0 > vizLettersAfterPos0) return vizNumber;
  }

  return mrzNumber;
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

// Render the first page of a PDF buffer to a PNG image buffer so the existing
// tesseract OCR pipeline can process it unchanged.
// Uses pdfjs-dist (pure JS parser) + canvas (prebuilt Node bindings for rendering).
// Returns null on any failure — caller falls back to manual envelope.
async function pdfFirstPageToImageBuffer(pdfBuffer) {
  try {
    const { createCanvas } = require("canvas");
    const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");
    // Disable the worker thread — not needed for server-side synchronous rendering.
    pdfjsLib.GlobalWorkerOptions.workerSrc = false;

    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(pdfBuffer),
      useWorkerFetch: false,
      isEvalSupported: false,
      useSystemFonts: true,
    });
    const pdf = await loadingTask.promise;
    const page = await pdf.getPage(1);
    // 2× scale gives tesseract larger glyphs → better MRZ recognition.
    const viewport = page.getViewport({ scale: 2.0 });

    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext("2d");

    // NodeCanvasFactory is required by pdfjs for server-side rendering.
    const canvasFactory = {
      create(w, h) { const c = createCanvas(w, h); return { canvas: c, context: c.getContext("2d") }; },
      reset(cc, w, h) { cc.canvas.width = w; cc.canvas.height = h; },
      destroy(cc) { cc.canvas.width = 0; cc.canvas.height = 0; },
    };

    await page.render({ canvasContext: context, viewport, canvasFactory }).promise;
    return canvas.toBuffer("image/png");
  } catch (e) {
    console.warn("[passportOcrClient] PDF→image failed:", e?.message || e);
    return null;
  }
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

  let buffer = resolveImageBuffer({ filePath, fileBuffer });

  if (isPdf(mimeType, fileName, filePath)) {
    if (!buffer) {
      return manualEnvelope(extractedAt, "PDF upload received but the file could not be read — please verify the fields manually.");
    }
    const imgBuffer = await pdfFirstPageToImageBuffer(buffer);
    if (!imgBuffer) {
      return manualEnvelope(extractedAt, "PDF upload received but page rendering failed — please verify the fields manually.");
    }
    buffer = imgBuffer;
  }

  if (!buffer) {
    return manualEnvelope(extractedAt, "No readable image was provided.");
  }

  let mrzText = "";
  let vizText = "";
  let ocrConfidence = null;
  try {
    const result = await withOcrSlot(() => withTimeout(runOcr(buffer, { ocr }), OCR_TIMEOUT_MS));
    mrzText = result?.mrzText || "";
    vizText = result?.vizText || "";
    ocrConfidence = result?.confidence ?? null;
  } catch (e) {
    console.error(`[passportOcrClient] OCR error (${e.code || "engine"}): ${e.message}`);
    return manualEnvelope(extractedAt, "Automatic extraction failed — please verify the fields manually.");
  }

  const mrz = parseMrz(mrzText, { nowYearLast2: new Date().getFullYear() % 100 });
  const viz = parseViz(vizText);

  // Debug aid: when the MRZ is missing but VIZ is present, log the raw OCR
  // text so we can see why the MRZ lines were not detected.
  if (process.env.PASSPORT_OCR_DEBUG === "1" || (!mrz && viz)) {
    console.log("[passportOcrClient] mrzFound:", Boolean(mrz), "vizFound:", Boolean(viz), "mrzText preview:", mrzText.slice(0, 200).replace(/\n/g, "|"), "vizText preview:", vizText.slice(0, 200).replace(/\n/g, "|"));
  }

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
//
// Non-ICAO full-date MRZs (e.g. UAE) have no check digits but a fixed layout we
// detect explicitly, so we trust their positional fields and only use VIZ for
// fields the MRZ does not carry (place of birth / issue dates).
function mergeExtraction(mrz, viz, ocrConfidence) {
  const mf = mrz?.fields || {};
  const checks = mrz?.checks || {};
  const v = viz || {};
  const mrzBroadlyValid = Boolean(checks.passportNumber || checks.dateOfBirth || checks.dateOfExpiry);
  const nonIcao = mrz?.nonIcao === true;
  const mrzTrustworthy = mrzBroadlyValid || nonIcao;

  // Prefer MRZ when its per-field check passed; else VIZ; else MRZ raw.
  const pickChecked = (mrzVal, vizVal, ok) => (ok ? mrzVal : null) || vizVal || mrzVal || null;
  // Prefer MRZ when trustworthy; else VIZ; else MRZ raw.
  const pickTrust = (mrzVal, vizVal) => (mrzTrustworthy ? mrzVal : null) || vizVal || mrzVal || null;

  // Name: MRZ line 1 is preferred when it's trustworthy AND not corrupted by
  // misread fillers; otherwise fall back to the printed name (split into
  // surname + given names when the VIZ parser could separate them).
  let surname = mf.surname || null;
  let givenNames = mf.givenNames || null;
  if (!mrzTrustworthy || nameLooksCorrupted(mf.surname) || nameLooksCorrupted(mf.givenNames)) {
    surname = v.surname || null;
    givenNames = v.givenNames || v.fullName || null;
  }

  // Cross-check the passport number against the VIZ to catch cases where the
  // MRZ check digit passes for a misread digit/letter (e.g. G↔6). Only run the
  // cross-check when the MRZ check digit itself is valid; otherwise the normal
  // MRZ-failed → VIZ fallback path handles it.
  const passportNumber = checks.passportNumber
    ? resolvePassportNumber(mrz, viz)
    : pickChecked(mf.passportNumber, v.passportNumber, checks.passportNumber);
  const passportNumberChanged = checks.passportNumber && passportNumber && mf.passportNumber && passportNumber !== mf.passportNumber;

  // Sex has no check digit; prefer MRZ when trustworthy, otherwise VIZ.
  const sex = (mf.sex === "M" || mf.sex === "F" ? mf.sex : null) || v.sex || mf.sex || null;
  const sexChanged = sex && mf.sex && sex !== mf.sex;

  const extraction = {
    passportNumber,
    surname,
    givenNames,
    dateOfBirth: pickChecked(mf.dateOfBirth, v.dateOfBirth, checks.dateOfBirth),
    sex,
    nationality: pickTrust(mf.nationality, v.nationality),
    placeOfBirth: null,
    placeOfIssue: null,
    dateOfIssue: v.dateOfIssue || null,
    dateOfExpiry: pickChecked(mf.dateOfExpiry, v.dateOfExpiry, checks.dateOfExpiry),
    mrz: mrz?.mrz || null,
  };

  let confidence;
  let note = null;
  if (passportNumberChanged || sexChanged) {
    note = "The machine-readable zone and the printed page disagreed on passport details; the printed page value was used — please double-check before approving.";
  }
  if (mrz?.valid) {
    confidence = scoreConfidence(mrz, ocrConfidence);
  } else if (nonIcao) {
    // Non-ICAO full-date MRZ: no check digits, but the layout is fixed and was
    // detected confidently, so confidence is medium-high.
    const hits = [extraction.passportNumber, extraction.dateOfBirth, extraction.dateOfExpiry, extraction.nationality, extraction.surname, extraction.givenNames].filter(Boolean).length;
    confidence = Math.round(Math.min(0.88, 0.55 + hits * 0.05) * 100) / 100;
    note = "This passport uses a non-ICAO machine-readable layout; the fields were read positionally — please double-check before approving.";
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
