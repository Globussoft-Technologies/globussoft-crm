const fs = require("fs");
const sharp = require("sharp");
const { createWorker } = require("tesseract.js");
const { parseMrz } = require("../lib/mrzParser");

const INPUT = process.argv[2];
if (!INPUT) {
  console.error("Usage: node scripts/test-preprocessing2.js <image>");
  process.exit(1);
}

async function tryApproach(label, buffer, psm = "6") {
  const worker = await createWorker("eng");
  await worker.setParameters({
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<",
    tessedit_pageseg_mode: psm,
  });
  const { data } = await worker.recognize(buffer);
  const parsed = parseMrz(data.text, { nowYearLast2: 26 });
  await worker.terminate();
  console.log(`\n=== ${label} (PSM ${psm}) ===`);
  console.log("conf:", data.confidence);
  console.log("text:\n" + data.text);
  console.log("parsed valid:", parsed?.valid, "checksPassed:", parsed?.checksPassed);
  if (parsed) console.log("fields:", parsed.fields);
  return { text: data.text, parsed };
}

async function makeBand(buf, targetWidth, threshold = null) {
  const { width, height } = await sharp(buf).metadata();
  const bottomH = Math.floor(height * 0.35);
  let img = sharp(buf)
    .rotate()
    .greyscale()
    .extract({ left: 0, top: height - bottomH, width, height: bottomH });
  if (threshold !== null) img = img.threshold(threshold);
  return img
    .resize(targetWidth, null, { fit: "inside", kernel: sharp.kernel.nearest })
    .png()
    .toBuffer();
}

async function main() {
  const buf = fs.readFileSync(INPUT);

  for (const w of [1500, 2000, 2500, 3000, 4000]) {
    for (const t of [null, 128, 150, 180]) {
      const label = `band ${w}px ${t === null ? "grey" : "threshold " + t}`;
      const img = await makeBand(buf, w, t);
      await tryApproach(label, img, "6");
    }
  }

  // Best candidate with PSM 13
  const best = await makeBand(buf, 3000, 128);
  await tryApproach("band 3000px threshold 128", best, "13");
}

main().catch((e) => { console.error(e); process.exit(1); });
