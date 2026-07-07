// Debug script for passport OCR — runs the pipeline on a local image and
// prints intermediate outputs so we can see where extraction breaks.
const fs = require("fs");
const path = require("path");
const passportImagePipeline = require("../lib/passportImagePipeline");
const { parseMrz } = require("../lib/mrzParser");

const INPUT = process.argv[2];
if (!INPUT || !fs.existsSync(INPUT)) {
  console.error("Usage: node scripts/debug-passport-ocr.js <image-path>");
  process.exit(1);
}

async function main() {
  const buffer = fs.readFileSync(INPUT);
  console.log("Input:", INPUT, "size:", buffer.length, "bytes");

  // Test preprocessing outputs.
  const band = await passportImagePipeline.preprocessImage(buffer, { mrzBand: true });
  const full = await passportImagePipeline.preprocessImage(buffer, { mrzBand: false });
  const viz = await passportImagePipeline.preprocessForViz(buffer);

  if (band) {
    const out = path.join(__dirname, "..", "uploads", "passport-ocr-debug-band.png");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, band);
    console.log("Wrote MRZ band preview:", out);
  }
  if (full) {
    const out = path.join(__dirname, "..", "uploads", "passport-ocr-debug-full.png");
    fs.writeFileSync(out, full);
    console.log("Wrote full page preview:", out);
  }
  if (viz) {
    const out = path.join(__dirname, "..", "uploads", "passport-ocr-debug-viz.png");
    fs.writeFileSync(out, viz);
    console.log("Wrote VIZ preview:", out);
  }

  // Run tesseract on raw and preprocessed images.
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("eng");

  async function ocr(label, img) {
    if (!img) return console.log(`${label}: skipped (no image)`);
    await worker.setParameters({
      tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<",
      tessedit_pageseg_mode: "6",
    });
    const { data } = await worker.recognize(img);
    const parsed = parseMrz(data.text, { nowYearLast2: new Date().getFullYear() % 100 });
    console.log(`\n--- ${label} ---`);
    console.log("Confidence:", data.confidence);
    console.log("Text:\n" + data.text);
    console.log("Parsed:", parsed);
  }

  await ocr("raw image", buffer);
  await ocr("preprocessed full", full);
  await ocr("preprocessed band", band);

  await worker.terminate();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
