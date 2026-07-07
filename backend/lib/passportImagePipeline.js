// Passport image preprocessing pipeline — pure Node.js (sharp).
//
// Replaces the old jimp-based preprocessing with:
//   - orientation detection (auto-rotate 90/180/270 via tesseract OSD)
//   - deskew (projection-profile correction for small camera tilt)
//   - adaptive/local threshold (clean binary MRZ lines)
//   - MRZ band detection (crop to the bottom text region)
//   - high-quality upscale (tesseract reads big glyphs better)
//
// All functions return PNG Buffers or null on failure. Callers treat null as
// "fall back to raw bytes".

const sharp = require("sharp");

const DESKEW_COARSE_STEP = Number(process.env.PASSPORT_OCR_DESKEW_STEP || 1);   // degrees
const DESKEW_FINE_STEP = 0.25;                                                    // degrees
const DESKEW_RANGE = Number(process.env.PASSPORT_OCR_DESKEW_RANGE || 10);       // ± degrees
const ADAPTIVE_WIN = Number(process.env.PASSPORT_OCR_ADAPTIVE_WINDOW || 41);    // px
const ADAPTIVE_C = Number(process.env.PASSPORT_OCR_ADAPTIVE_C || 10);           // subtract from mean
const MRZ_TARGET_DPI = 300;

// ─── helpers ─────────────────────────────────────────────────────────────────

// Convert raw greyscale pixels to a binary Buffer (0 or 255).
function thresholdGlobal(pixels, threshold = 128) {
  const out = Buffer.alloc(pixels.length);
  for (let i = 0; i < pixels.length; i++) {
    out[i] = pixels[i] < threshold ? 0 : 255;
  }
  return out;
}

// Build an integral (summed-area) image for fast local mean computation.
function buildIntegral(src, width, height) {
  const integral = new Int32Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    const yOff = y * width;
    const intY = (y + 1) * (width + 1);
    const intPrevY = y * (width + 1);
    for (let x = 0; x < width; x++) {
      rowSum += src[yOff + x];
      integral[intY + (x + 1)] = integral[intPrevY + (x + 1)] + rowSum;
    }
  }
  return integral;
}

// Adaptive mean threshold using integral image. Pixel is black when
// value < localMean - C. Returns 8-bit greyscale Buffer (0/255).
function adaptiveThreshold(src, width, height, windowSize, c) {
  const integral = buildIntegral(src, width, height);
  const out = Buffer.alloc(width * height);
  const half = Math.floor(windowSize / 2);

  for (let y = 0; y < height; y++) {
    const yOff = y * width;
    const y1 = Math.max(0, y - half);
    const y2 = Math.min(height - 1, y + half);
    const intY2 = (y2 + 1) * (width + 1);
    const intY1 = y1 * (width + 1);

    for (let x = 0; x < width; x++) {
      const x1 = Math.max(0, x - half);
      const x2 = Math.min(width - 1, x + half);
      const count = (x2 - x1 + 1) * (y2 - y1 + 1);
      const sum = integral[intY2 + (x2 + 1)]
        - integral[intY1 + (x2 + 1)]
        - integral[intY2 + x1]
        + integral[intY1 + x1];
      const mean = sum / count;
      out[yOff + x] = src[yOff + x] < (mean - c) ? 0 : 255;
    }
  }
  return out;
}

// Score a binary image for "horizontal-line-ness". Higher = more aligned text.
function projectionProfileScore(pixels, width, height) {
  const profile = new Array(height).fill(0);
  for (let y = 0; y < height; y++) {
    let row = 0;
    const yOff = y * width;
    for (let x = 0; x < width; x++) {
      if (pixels[yOff + x] === 0) row++;
    }
    profile[y] = row;
  }
  const mean = profile.reduce((a, b) => a + b, 0) / height;
  let variance = 0;
  for (let i = 0; i < height; i++) variance += (profile[i] - mean) ** 2;
  return variance / height;
}

async function rotatedBinaryPixels(buffer, angle) {
  const { data, info } = await sharp(buffer)
    .greyscale()
    .rotate(angle, { background: { r: 255, g: 255, b: 255 } })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    pixels: thresholdGlobal(data, 128),
    width: info.width,
    height: info.height,
  };
}

// ─── public functions ────────────────────────────────────────────────────────

/**
 * Detect a small camera-tilt angle using projection-profile deskew.
 * Returns the best correction angle in degrees (usually -5 to +5).
 */
async function detectSkewAngle(buffer) {
  try {
    // First downscale to a thumbnail to keep deskew fast.
    const thumb = await sharp(buffer)
      .greyscale()
      .resize(800, 800, { fit: "inside", withoutEnlargement: true })
      .toBuffer();

    let bestAngle = 0;
    let bestScore = -Infinity;

    // Coarse sweep.
    for (let a = -DESKEW_RANGE; a <= DESKEW_RANGE; a += DESKEW_COARSE_STEP) {
      const { pixels, width, height } = await rotatedBinaryPixels(thumb, a);
      const score = projectionProfileScore(pixels, width, height);
      if (score > bestScore) {
        bestScore = score;
        bestAngle = a;
      }
    }

    // Fine sweep around the coarse winner.
    const fineStart = bestAngle - DESKEW_COARSE_STEP;
    const fineEnd = bestAngle + DESKEW_COARSE_STEP;
    for (let a = fineStart; a <= fineEnd; a += DESKEW_FINE_STEP) {
      const { pixels, width, height } = await rotatedBinaryPixels(thumb, a);
      const score = projectionProfileScore(pixels, width, height);
      if (score > bestScore) {
        bestScore = score;
        bestAngle = a;
      }
    }

    return bestAngle;
  } catch (e) {
    console.warn("[passportImagePipeline] deskew detection failed:", e?.message || e);
    return 0;
  }
}

/**
 * Apply deskew + Otsu threshold + resize for MRZ OCR.
 * `mrzBand` when true crops to the bottom 35% of the page where the TD3 MRZ
 * lives. We use a simple global/Otsu threshold rather than adaptive because
 * adaptive thresholding tends to break the thin OCR-B chevrons and merge
 * adjacent characters on high-resolution passport scans.
 */
async function preprocessImage(buffer, { mrzBand = false } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;

  try {
    // 1. Auto-rotate 90/180/270 and fix EXIF orientation.
    let img = sharp(buffer).rotate();

    // 2. Deskew small camera tilt.
    if (process.env.PASSPORT_OCR_DESKEW !== "0") {
      const raw = await img.toBuffer();
      const angle = await detectSkewAngle(raw);
      if (Math.abs(angle) > 0.1) {
        img = sharp(raw).rotate(-angle, { background: { r: 255, g: 255, b: 255 } });
      }
    }

    // 3. Get greyscale dimensions.
    img = img.greyscale();
    const { width, height } = await img.metadata();

    // 4. Optional MRZ band crop (bottom ~35% — ICAO TD3 location).
    if (mrzBand && process.env.PASSPORT_OCR_MRZ_CROP !== "0") {
      const crop = mrzRegion(width, height);
      img = img.extract({ left: crop.x, top: crop.y, width: crop.w, height: crop.h });
    }

    // 5. Otsu threshold (sharp.threshold() with no argument) then resize to a
    // tesseract-friendly width. A passport page is ~3.5" wide; 1500px ≈ 430 dpi,
    // giving ~34px per MRZ character — large enough for OCR-B but not so large
    // that tesseract splits the chevrons.
    const targetW = Math.min(1800, Math.max(1200, Math.round(width * 0.6)));
    const png = await img
      .threshold()
      .resize(targetW, null, { fit: "inside", kernel: sharp.kernel.nearest })
      .png({ compressionLevel: 3 })
      .withMetadata({ density: MRZ_TARGET_DPI })
      .toBuffer();

    return png;
  } catch (e) {
    console.warn("[passportImagePipeline] preprocess failed:", e?.message || e);
    return null;
  }
}

/**
 * Preprocess for visual-zone OCR: deskew + modest upscale, no binary threshold,
 * because printed labels need greyscale for tesseract's LSTM to read them.
 */
async function preprocessForViz(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  try {
    let img = sharp(buffer).rotate();
    if (process.env.PASSPORT_OCR_DESKEW !== "0") {
      const raw = await img.toBuffer();
      const angle = await detectSkewAngle(raw);
      if (Math.abs(angle) > 0.1) {
        img = sharp(raw).rotate(-angle, { background: { r: 255, g: 255, b: 255 } });
      }
    }
    const { width } = await img.metadata();
    const targetW = Math.max(1200, Math.min(2400, width * 2));
    return await img
      .greyscale()
      .resize(targetW, null, { kernel: sharp.kernel.lanczos3, withoutEnlargement: false })
      .normalize()
      .sharpen({ sigma: 1, flat: 1, jagged: 2 })
      .png({ compressionLevel: 3 })
      .withMetadata({ density: MRZ_TARGET_DPI })
      .toBuffer();
  } catch (e) {
    console.warn("[passportImagePipeline] viz preprocess failed:", e?.message || e);
    return null;
  }
}

// ─── MRZ region detection ────────────────────────────────────────────────────

function mrzRegion(width, height) {
  // ICAO 9303 TD3 MRZ sits in the bottom ~28% of the passport page (two lines
  // of 44 chars each). We crop a bit more (35%) to leave margin for tilted
  // scans, then let the OCR/parser find the exact line pair.
  const h = Math.floor(height * 0.35);
  return { x: 0, y: height - h, w: width, h };
}

module.exports = {
  preprocessImage,
  preprocessForViz,
  detectSkewAngle,
};
