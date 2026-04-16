const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");

const router = express.Router();
const prisma = require("../lib/prisma");

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
  } catch (err) {
    res.status(500).json({ error: "File upload failed" });
  }
});

// Generate dynamic PDF Quote
router.post("/:dealId/generate-quote", async (req, res) => {
  try {
    const deal = await prisma.deal.findFirst({
      where: { id: parseInt(req.params.dealId), tenantId: req.user.tenantId },
      include: { contact: true, owner: true }
    });
    if (!deal) return res.status(404).json({ error: "Deal not found" });

    const doc = new PDFDocument();
    const pdfFilename = `quote-${deal.id}-${Date.now()}.pdf`;
    const pdfPath = path.join(uploadPath, pdfFilename);

    doc.pipe(fs.createWriteStream(pdfPath));

    // PDF Styling
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

    // Attach to deal
    const attachment = await prisma.attachment.create({
      data: {
        filename: "System Generated Quote.pdf",
        fileUrl: `/uploads/${pdfFilename}`,
        dealId: deal.id,
        tenantId: req.user.tenantId,
      }
    });

    res.status(201).json(attachment);
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
  } catch (err) {
    res.status(500).json({ error: "Failed to load attachments" });
  }
});

module.exports = router;
