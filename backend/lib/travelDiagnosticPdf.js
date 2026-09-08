/**
 * Shared diagnostic PDF generator for both the staff travel route and the
 * customer portal. Keeps the RAG + PDF orchestration in one place so the two
 * entry points (advisor-initiated vs customer self-serve) behave identically.
 */

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const prisma = require("./prisma");
const pdfRenderer = require("../services/pdfRenderer");
const travelRag = require("./travelRag");

const DIAG_PDF_DIR = path.join(__dirname, "..", "uploads", "diagnostics");
try {
  fs.mkdirSync(DIAG_PDF_DIR, { recursive: true });
} catch {
  /* best-effort */
}

/**
 * Best-effort branded PDF generation for a TravelDiagnostic.
 *
 * @param {object} diag - TravelDiagnostic row (must include tenantId, subBrand, id, etc.)
 * @param {object} bank - Question bank snapshot (or bank-like object with questionsJson)
 * @param {object} [opts]
 * @param {object} [opts.ragResult] - Optional pre-computed RAG result
 * @returns {Promise<string|null>} - PDF URL or null on failure
 */
async function generateDiagnosticPdfBestEffort(diag, bank, opts = {}) {
  try {
    const contact = diag.contactId
      ? await prisma.contact.findUnique({
          where: { id: diag.contactId },
          select: { name: true, email: true, phone: true },
        })
      : { name: "Anonymous customer", email: null, phone: null };

    let logoBuffer = null;
    try {
      const { resolveBrandLogoBuffer } = require("./brandLogo");
      const tenant = await prisma.tenant.findUnique({
        where: { id: diag.tenantId },
        select: { logoUrl: true },
      });
      logoBuffer = await resolveBrandLogoBuffer(tenant?.logoUrl);
    } catch (logoErr) {
      console.warn("[travel-diag-pdf] logo resolve failed:", logoErr.message);
    }

    let ragResult = opts?.ragResult;
    if (!ragResult) {
      try {
        ragResult = await travelRag.getRagResultForDiagnostic(diag.id);
      } catch (ragFetchErr) {
        console.warn("[travel-diag-pdf] failed to fetch RAG result for PDF:", ragFetchErr.message);
      }
    }

    const pdfBuf = await pdfRenderer.renderTravelDiagnosticPdf(diag, contact, bank, {
      logoBuffer,
      ragResult,
      cancellationPolicy: opts?.cancellationPolicy || null,
    });
    const rand = crypto.randomBytes(16).toString("hex");
    const filename = `diag-${diag.id}-${rand}.pdf`;
    const filepath = path.join(DIAG_PDF_DIR, filename);
    await fs.promises.writeFile(filepath, pdfBuf);
    const url = `/api/uploads/diagnostics/${filename}`;
    await prisma.travelDiagnostic.update({
      where: { id: diag.id },
      data: { reportPdfUrl: url },
    });
    return url;
  } catch (e) {
    console.error("[travel-diag-pdf] PDF generation failed:", e.message);
    return null;
  }
}

module.exports = {
  generateDiagnosticPdfBestEffort,
};
