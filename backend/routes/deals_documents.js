const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const { verifyToken } = require("../middleware/auth");

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

// Delete attachment
router.delete("/:attachmentId", verifyToken, async (req, res) => {
  try {
    const attachment = await prisma.attachment.findFirst({
      where: {
        id: parseInt(req.params.attachmentId),
        tenantId: req.user.tenantId
      }
    });

    if (!attachment) {
      return res.status(404).json({ error: "Attachment not found" });
    }

    await prisma.attachment.delete({
      where: { id: attachment.id }
    });

    res.json({ success: true });
  } catch (_err) {
    res.status(500).json({ error: "Failed to delete attachment" });
  }
});

// Generate and track PDF Quote (created on-demand, no disk storage)
router.post("/:dealId/generate-quote", verifyToken, async (req, res) => {
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

    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', async () => {
      const pdfBuffer = Buffer.concat(chunks);

      // Create attachment record (marks it as system-generated, no file on disk)
      const attachment = await prisma.attachment.create({
        data: {
          filename: "System Generated Quote.pdf",
          fileUrl: `/api/deals_documents/generate-quote/${deal.id}`, // Points to on-demand endpoint
          dealId: deal.id,
          tenantId: req.user.tenantId,
        }
      });

      // Send as download without saving to disk
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="quote-${deal.id}.pdf"`);
      res.send(pdfBuffer);
    });

    // PDF Content
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
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "PDF generation failed" });
  }
});

// Download on-demand generated quote (no disk file, generated fresh each time)
router.get("/generate-quote/:dealId", verifyToken, async (req, res) => {
  try {
    const deal = await prisma.deal.findFirst({
      where: { id: parseInt(req.params.dealId), tenantId: req.user.tenantId },
      include: { contact: true, owner: true }
    });
    if (!deal) return res.status(404).json({ error: "Deal not found" });

    const doc = new PDFDocument();
    const chunks = [];

    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => {
      const pdfBuffer = Buffer.concat(chunks);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="quote-${deal.id}.pdf"`);
      res.send(pdfBuffer);
    });

    // PDF Content
    doc.fontSize(24).text("Enterprise CRM Quote", { align: "center" });
    doc.moveDown();
    doc.fontSize(16).text(`Prepared For: ${deal.contact?.name || deal.company || "Valued Client"}`);
    doc.text(`Company: ${deal.company || "N/A"}`);
    doc.moveDown();
    doc.fontSize(14).text(`Project: ${deal.title}`);
    doc.text(`Total Amount: $${(deal.amount || 0).toLocaleString()}`);
    doc.moveDown(2);
    doc.fontSize(10).fillColor('gray').text("This is an automatically generated legally binding quote valid for 30 days.", { align: "center" });

    doc.end();
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

// Download attachment with authentication & ownership validation
router.get("/download/:attachmentId", verifyToken, async (req, res) => {
  try {
    const attachment = await prisma.attachment.findFirst({
      where: {
        id: parseInt(req.params.attachmentId),
        tenantId: req.user.tenantId
      },
      include: { deal: true }
    });

    if (!attachment) {
      return res.status(404).json({ error: "Attachment not found or access denied" });
    }

    // Extract filename from fileUrl (e.g., /uploads/quote-123-456.pdf -> quote-123-456.pdf)
    const filename = attachment.fileUrl.split('/').pop();
    const filepath = path.join(__dirname, "..", "uploads", filename);

    res.download(filepath, attachment.filename);
  } catch (_err) {
    res.status(500).json({ error: "Failed to download attachment" });
  }
});

module.exports = router;
