const fs = require("fs");
const sharp = require("sharp");
const { createWorker } = require("tesseract.js");
const { parseMrz } = require("../lib/mrzParser");

const INPUT = process.argv[2];
if (!INPUT) {
  console.error("Usage: node scripts/test-preprocessing.js <image>");
  process.exit(1);
}

async function tryApproach(label, buffer) {
  const worker = await createWorker("eng");
  await worker.setParameters({
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<",
    tessedit_pageseg_mode: "6",
  });
  const { data } = await worker.recognize(buffer);
  const parsed = parseMrz(data.text, { nowYearLast2: 26 });
  await worker.terminate();
  console.log(`\n=== ${label} ===`);
  console.log("conf:", data.confidence);
  console.log("text:\n" + data.text);
  console.log("parsed:", parsed);
  return { text: data.text, parsed };
}

async function main() {
  const buf = fs.readFileSync(INPUT);
  const { width, height } = await sharp(buf).metadata();
  console.log("Original:", width, "x", height);

  // Approach 1: just greyscale + resize to 2000px width.
  const grey = await sharp(buf)
    .rotate()
    .greyscale()
    .resize(2000, null, { fit: "inside" })
    .png()
    .toBuffer();
  await tryApproach("greyscale 2000px", grey);

  // Approach 2: greyscale + normalize + sharpen + resize 2000px.
  const enhanced = await sharp(buf)
    .rotate()
    .greyscale()
    .normalize()
    .sharpen({ sigma: 1, flat: 1, jagged: 2 })
    .resize(2000, null, { fit: "inside" })
    .png()
    .toBuffer();
  await tryApproach("enhanced greyscale 2000px", enhanced);

  // Approach 3: crop bottom 30% + greyscale + resize 2000px.
  const bottomH = Math.floor(height * 0.35);
  const band = await sharp(buf)
    .rotate()
    .greyscale()
    .extract({ left: 0, top: height - bottomH, width, height: bottomH })
    .resize(2000, null, { fit: "inside" })
    .png()
    .toBuffer();
  await tryApproach("bottom band greyscale 2000px", band);

  // Approach 4: crop bottom 30% + otsu threshold + resize 2000px.
  const bandOtsu = await sharp(buf)
    .rotate()
    .greyscale()
    .extract({ left: 0, top: height - bottomH, width, height: bottomH })
    .threshold(128)
    .resize(2000, null, { fit: "inside", kernel: sharp.kernel.nearest })
    .png()
    .toBuffer();
  await tryApproach("bottom band otsu 2000px", bandOtsu);

  // Approach 5: original jimp-like: greyscale + contrast + upscale.
  const jimpLike = await sharp(buf)
    .rotate()
    .greyscale()
    .linear(1.4, 0) // contrast-ish
    .resize(1400, null, { fit: "inside" })
    .png()
    .toBuffer();
  await tryApproach("jimp-like 1400px", jimpLike);
}

main().catch((e) => { console.error(e); process.exit(1); });
