const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");

const router = express.Router();
const prisma = require("../lib/prisma");
const { formatMoney } = require("../utils/formatMoney");

// Configure multer for file uploads
const uploadPath = path.join(__dirname, "..", "uploads");
if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});
const upload = multer({ storage });

// Helper: ensure deal belongs to current tenant
async function ensureOwnDeal(req, res) {
  const dealId = parseInt(req.params.dealId);
  const deal = await prisma.deal.findFirst({ where: { id: dealId, tenantId: req.user.tenantId } });
  if (!deal) {
    res.status(404).json({ error: "Deal not found" });
    return null;
  }
  return deal;
}

// Upload attachment
router.post("/:dealId/upload", upload.single("file"), async (req, res) => {
  try {
    const deal = await ensureOwnDeal(req, res);
    if (!deal) return;
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const attachment = await prisma.attachment.create({
      data: {
        filename: req.file.originalname,
        fileUrl: `/uploads/${req.file.filename}`,
        dealId: deal.id,
        tenantId: req.user.tenantId,
      }
    });

    res.status(201).json(attachment);
  } catch (_err) {
    res.status(500).json({ error: "File upload failed" });
  }
});

// Generate dynamic PDF Quote.
//
// #585: prior to this fix, the route piped the PDF to disk asynchronously
// then returned a JSON envelope referencing /uploads/<file>.pdf. The user-
// observed effect was that clicking "Generate Quote" never delivered a
// downloadable PDF inline — the customer-facing artifact was effectively
// invisible until they discovered it in the attachments list, and the
// async write-then-respond ordering risked serving 0-byte / partial
// content if the static handler raced the doc.end() flush.
//
// The route now buffers the PDF in memory (mirrors the streamToBuffer
// pattern in services/pdfRenderer.js for the wellness vertical), persists
// the same buffer to disk for the attachment row (so the existing
// "see it in attachments" UX still works after a refresh), and responds
// with binary PDF bytes + Content-Type: application/pdf +
// Content-Disposition: attachment; filename="quote-<id>.pdf".
router.post("/:dealId/generate-quote", async (req, res) => {
  try {
    const deal = await prisma.deal.findFirst({
      where: { id: parseInt(req.params.dealId), tenantId: req.user.tenantId },
      include: { contact: true, owner: true }
    });
    if (!deal) return res.status(404).json({ error: "Deal not found" });

    // #286/#330: tenant-aware currency on quote PDF — wellness/INR shows ₹.
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.user.tenantId },
      select: { defaultCurrency: true, locale: true },
    });
    const currency = deal.currency || tenant?.defaultCurrency || "USD";
    const locale = tenant?.locale || undefined;

    const doc = new PDFDocument();
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    const bufferPromise = new Promise((resolve, reject) => {
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
    });

    // PDF Styling
    doc.fontSize(24).text("Enterprise CRM Quote", { align: "center" });
    doc.moveDown();
    doc.fontSize(16).text(`Prepared For: ${deal.contact?.name || deal.company || "Valued Client"}`);
    doc.text(`Company: ${deal.company || "N/A"}`);
    doc.moveDown();
    doc.fontSize(14).text(`Project: ${deal.title}`);
    doc.text(`Total Amount: ${formatMoney(deal.amount || 0, currency, locale)}`);
    doc.moveDown(2);
    doc.fontSize(10).fillColor('gray').text("This is an automatically generated legally binding quote valid for 30 days.", { align: "center" });

    doc.end();
    const pdfBuffer = await bufferPromise;

    // Persist alongside the attachment row so the existing
    // "view in attachments → /uploads/..." flow still resolves to the
    // same bytes. Failures here are logged but don't block the inline
    // response — the user still receives their PDF.
    const pdfFilename = `quote-${deal.id}-${Date.now()}.pdf`;
    const pdfPath = path.join(uploadPath, pdfFilename);
    try {
      fs.writeFileSync(pdfPath, pdfBuffer);
      await prisma.attachment.create({
        data: {
          filename: `quote-${deal.id}.pdf`,
          fileUrl: `/uploads/${pdfFilename}`,
          dealId: deal.id,
          tenantId: req.user.tenantId,
        }
      });
    } catch (persistErr) {
      console.error("[generate-quote] attachment persist failed:", persistErr);
    }

    res.status(200);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="quote-${deal.id}.pdf"`,
    );
    res.setHeader("Content-Length", pdfBuffer.length);
    res.end(pdfBuffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "PDF generation failed" });
  }
});

// Fetch deal attachments
router.get("/:dealId/attachments", async (req, res) => {
  try {
    const deal = await ensureOwnDeal(req, res);
    if (!deal) return;
    const attachments = await prisma.attachment.findMany({
      where: { dealId: deal.id, tenantId: req.user.tenantId },
      orderBy: { createdAt: 'desc' }
    });
    res.json(attachments);
  } catch (_err) {
    res.status(500).json({ error: "Failed to load attachments" });
  }
});

module.exports = router;
