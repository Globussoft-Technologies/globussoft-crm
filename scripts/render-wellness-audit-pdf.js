const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const puppeteer = require(path.resolve(__dirname, "../backend/node_modules/puppeteer"));

async function main() {
  const htmlPath = path.resolve(__dirname, "../docs/wellness-audit-2026-07-27.html");
  const pdfPath = path.resolve(__dirname, "../docs/wellness-audit-2026-07-27.pdf");
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "globuscrm-chrome-pdf-"));

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    userDataDir,
  });

  try {
    const page = await browser.newPage();
    await page.goto(`file:///${htmlPath.replace(/\\/g, "/")}`, {
      waitUntil: "networkidle0",
    });
    await page.pdf({
      path: pdfPath,
      format: "A4",
      printBackground: true,
      margin: {
        top: "14mm",
        right: "10mm",
        bottom: "14mm",
        left: "10mm",
      },
    });
    console.log(pdfPath);
  } finally {
    await browser.close();
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
