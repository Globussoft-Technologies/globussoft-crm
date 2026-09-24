const fs = require("fs");
const path = require("path");

const PDF_MIME_TYPE = "application/pdf";

const CONSENT_TEMPLATES = [
  { tripType: "day_trip", filename: "day-tour-terms.pdf", sourceFile: "day-tour-terms.pdf" },
  { tripType: "domestic", filename: "domestic-terms.pdf", sourceFile: "domestic-terms.pdf" },
  { tripType: "international", filename: "international-terms.pdf", sourceFile: "international-terms.pdf" },
];

async function seedTmcConsentTemplates(prisma, tenantId) {
  const assetsDir = path.resolve(__dirname, "../assets/tmc-consent-templates");
  let synced = 0;

  for (const template of CONSENT_TEMPLATES) {
    const filePath = path.join(assetsDir, template.sourceFile);
    if (!fs.existsSync(filePath)) {
      console.warn(`[seed-tmc-consent-templates] missing asset: ${filePath}`);
      continue;
    }
    const fileBlob = fs.readFileSync(filePath);
    await prisma.tmcConsentTemplate.upsert({
      where: { tenantId_tripType: { tenantId, tripType: template.tripType } },
      update: {
        filename: template.filename,
        mimeType: PDF_MIME_TYPE,
        fileSize: fileBlob.length,
        fileBlob,
      },
      create: {
        tenantId,
        tripType: template.tripType,
        filename: template.filename,
        mimeType: PDF_MIME_TYPE,
        fileSize: fileBlob.length,
        fileBlob,
      },
    });
    synced += 1;
  }

  console.log(`[seed-tmc-consent-templates] ${synced} template(s) synced for tenant ${tenantId}`);
  return synced;
}

module.exports = { CONSENT_TEMPLATES, seedTmcConsentTemplates };
