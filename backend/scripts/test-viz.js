const fs = require("fs");
const sharp = require("sharp");
const { createWorker } = require("tesseract.js");
const { parseViz } = require("../lib/passportVizParser");

const INPUT = process.argv[2];
if (!INPUT) {
  console.error("Usage: node scripts/test-viz.js <image>");
  process.exit(1);
}

async function tryApproach(label, buffer) {
  const worker = await createWorker("eng");
  await worker.setParameters({
    tessedit_char_whitelist: "",
    tessedit_pageseg_mode: "3",
  });
  const { data } = await worker.recognize(buffer);
  const parsed = parseViz(data.text);
  await worker.terminate();
  console.log(`\n=== ${label} ===`);
  console.log("conf:", data.confidence);
  console.log("text:\n" + data.text);
  console.log("parsed:", parsed);
  return { text: data.text, parsed };
}

async function main() {
  const buf = fs.readFileSync(INPUT);

  // Full page enhanced greyscale.
  const full = await sharp(buf)
    .rotate()
    .greyscale()
    .normalize()
    .sharpen({ sigma: 1, flat: 1, jagged: 2 })
    .resize(2500, null, { fit: "inside" })
    .png()
    .toBuffer();
  await tryApproach("full enhanced 2500px", full);

  // Upper 80% (exclude MRZ) enhanced greyscale.
  const { width, height } = await sharp(buf).metadata();
  const upperH = Math.floor(height * 0.78);
  const upper = await sharp(buf)
    .rotate()
    .greyscale()
    .normalize()
    .sharpen({ sigma: 1, flat: 1, jagged: 2 })
    .extract({ left: 0, top: 0, width, height: upperH })
    .resize(2500, null, { fit: "inside" })
    .png()
    .toBuffer();
  await tryApproach("upper 78% enhanced 2500px", upper);

  // Full page threshold.
  const fullBin = await sharp(buf)
    .rotate()
    .greyscale()
    .threshold(150)
    .resize(2500, null, { fit: "inside", kernel: sharp.kernel.nearest })
    .png()
    .toBuffer();
  await tryApproach("full threshold 150 2500px", fullBin);
}

main().catch((e) => { console.error(e); process.exit(1); });
