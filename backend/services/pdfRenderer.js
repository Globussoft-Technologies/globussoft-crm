/**
 * PDF Renderer — Wellness vertical
 *
 * Uses pdfkit (already in deps). Each exported function returns a Promise<Buffer>.
 *
 *   renderPrescriptionPdf(prescription, patient, clinic)
 *   renderConsentPdf(consent, patient, service, clinic, signatureDataUrl)
 *   renderBrandedInvoicePdf(invoice, contact, clinic)
 *
 * The `clinic` argument is typically the primary Location row:
 *   { name, addressLine, city, state, pincode, phone, email }
 *
 * Callers are responsible for tenant-scoped lookups.
 */

const PDFDocument = require("pdfkit");

// ── Helpers ────────────────────────────────────────────────────────

function streamToBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
}

function computeAge(dob) {
  if (!dob) return "—";
  try {
    const d = new Date(dob);
    if (isNaN(d.getTime())) return "—";
    const now = new Date();
    let age = now.getFullYear() - d.getFullYear();
    const m = now.getMonth() - d.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
    return String(age);
  } catch {
    return "—";
  }
}

function formatDate(d) {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return String(d);
  }
}

function formatMoney(n, currency = "INR") {
  const v = Number(n) || 0;
  const symbol = currency === "INR" ? "\u20B9" : currency === "USD" ? "$" : "";
  return `${symbol}${v.toFixed(2)}`;
}

function safeClinic(clinic) {
  return {
    name: clinic?.name || "Clinic",
    addressLine: clinic?.addressLine || "",
    city: clinic?.city || "",
    state: clinic?.state || "",
    pincode: clinic?.pincode || "",
    phone: clinic?.phone || "",
    email: clinic?.email || "",
  };
}

function drawClinicHeader(doc, clinic) {
  const c = safeClinic(clinic);
  doc.font("Helvetica-Bold").fontSize(18).fillColor("#111").text(c.name);
  doc.font("Helvetica").fontSize(10).fillColor("#555");
  const addr = [c.addressLine, [c.city, c.state, c.pincode].filter(Boolean).join(", ")]
    .filter(Boolean)
    .join("\n");
  if (addr) doc.text(addr);
  const contact = [c.phone, c.email].filter(Boolean).join("  |  ");
  if (contact) doc.text(contact);
  doc.moveDown(0.5);
  // Divider
  const y = doc.y;
  doc.moveTo(doc.page.margins.left, y)
    .lineTo(doc.page.width - doc.page.margins.right, y)
    .lineWidth(0.7)
    .strokeColor("#999")
    .stroke();
  doc.moveDown(0.8);
  doc.fillColor("#111");
}

function parseDrugs(drugs) {
  if (!drugs) return [];
  if (Array.isArray(drugs)) return drugs;
  if (typeof drugs === "string") {
    try {
      const v = JSON.parse(drugs);
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }
  if (typeof drugs === "object") return [drugs];
  return [];
}

// ── Consent templates ──────────────────────────────────────────────

const CONSENT_TEMPLATES = {
  "hair-transplant": `I hereby give my informed consent to undergo a hair transplant procedure at the above clinic. I understand that the procedure involves the surgical extraction of hair follicles from a donor area and their implantation into the recipient area. I have been informed of the risks including (but not limited to) infection, scarring, temporary shock-loss, variable graft survival, and less-than-expected density. I acknowledge that individual results may vary and that no specific outcome has been guaranteed. I confirm I have disclosed all relevant medical history, current medications and allergies.`,
  "botox-fillers": `I consent to the administration of botulinum toxin and/or dermal filler injections. I understand the procedure's purpose, technique, and the temporary nature of its effects. I have been informed of the potential risks including bruising, swelling, asymmetry, infection, vascular occlusion, and allergic reaction. I confirm I am not pregnant or breastfeeding and have disclosed all relevant medical history.`,
  "laser": `I consent to laser treatment for the indicated condition. I understand that multiple sessions may be required and that results vary between individuals. I have been informed of possible side effects including erythema, pigmentation changes, blistering, scarring, and rare adverse reactions. I agree to follow post-procedure care instructions including sun avoidance.`,
  "chemical-peel": `I consent to a chemical peel procedure. I understand the procedure involves the controlled application of a chemical solution which will cause the superficial layers of skin to exfoliate. I have been informed of risks including erythema, prolonged flaking, pigmentary changes, infection, and scarring. I agree to strict sun protection and post-care instructions.`,
  "general": `I hereby give my informed consent for the treatment/procedure described above. I acknowledge that the nature, purpose, risks and alternatives of the procedure have been explained to me and that I have had the opportunity to ask questions. I confirm that I have disclosed all relevant medical history, current medications and known allergies.`,
};

function getConsentBody(templateName) {
  const key = (templateName || "general").toLowerCase();
  return CONSENT_TEMPLATES[key] || CONSENT_TEMPLATES.general;
}

// ── 1. Prescription PDF ────────────────────────────────────────────

async function renderPrescriptionPdf(prescription, patient, clinic) {
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const bufPromise = streamToBuffer(doc);

  drawClinicHeader(doc, clinic);

  // Title
  doc.font("Helvetica-Bold").fontSize(14).text("Prescription", { align: "center" });
  doc.moveDown(0.8);

  // Patient block
  const age = computeAge(patient?.dob);
  doc.font("Helvetica-Bold").fontSize(11).text("Patient", { continued: false });
  doc.font("Helvetica").fontSize(10).fillColor("#222");
  doc.text(`Name: ${patient?.name || "—"}`);
  doc.text(`Phone: ${patient?.phone || "—"}`);
  doc.text(`Age: ${age}    Gender: ${patient?.gender || "—"}`);
  doc.text(`Date: ${formatDate(prescription?.createdAt || new Date())}`);
  doc.moveDown(0.8);

  // Drug table
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#111").text("Rx");
  doc.moveDown(0.3);

  const drugs = parseDrugs(prescription?.drugs);
  const tableTop = doc.y;
  const colX = [50, 200, 310, 400]; // name, dosage, frequency, duration
  const headers = ["Medication", "Dosage", "Frequency", "Duration"];

  doc.font("Helvetica-Bold").fontSize(10).fillColor("#333");
  headers.forEach((h, i) => doc.text(h, colX[i], tableTop));
  doc.moveTo(50, tableTop + 14)
    .lineTo(545, tableTop + 14)
    .lineWidth(0.5)
    .strokeColor("#bbb")
    .stroke();

  let rowY = tableTop + 20;
  doc.font("Helvetica").fontSize(10).fillColor("#222");
  if (drugs.length === 0) {
    doc.text("(no medications listed)", 50, rowY);
    rowY += 16;
  } else {
    for (const d of drugs) {
      const cells = [
        d.name || d.drug || "—",
        d.dosage || "—",
        d.frequency || "—",
        d.duration || "—",
      ];
      cells.forEach((val, i) => {
        doc.text(String(val), colX[i], rowY, {
          width: (colX[i + 1] || 545) - colX[i] - 6,
        });
      });
      rowY += 20;
      if (rowY > 720) {
        doc.addPage();
        rowY = 60;
      }
    }
  }

  doc.moveDown(1);
  doc.y = Math.max(doc.y, rowY + 10);

  // Instructions
  if (prescription?.instructions) {
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#111").text("Instructions");
    doc.font("Helvetica").fontSize(10).fillColor("#222").text(prescription.instructions, {
      width: 495,
    });
    doc.moveDown(0.8);
  }

  // Signature line
  const sigY = Math.max(doc.y + 40, 700);
  doc.moveTo(360, sigY).lineTo(545, sigY).lineWidth(0.5).strokeColor("#444").stroke();
  doc.font("Helvetica").fontSize(10).fillColor("#333").text("Doctor's signature", 360, sigY + 4);

  doc.end();
  return bufPromise;
}

// ── 2. Consent PDF ─────────────────────────────────────────────────

async function renderConsentPdf(consent, patient, service, clinic, signatureDataUrl) {
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const bufPromise = streamToBuffer(doc);

  drawClinicHeader(doc, clinic);

  const tplName = consent?.templateName || "general";
  const title = `Consent Form — ${tplName.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}`;
  doc.font("Helvetica-Bold").fontSize(14).fillColor("#111").text(title, { align: "center" });
  doc.moveDown(0.6);

  if (service?.name) {
    doc.font("Helvetica-Oblique").fontSize(10).fillColor("#555").text(`Service: ${service.name}`, { align: "center" });
    doc.moveDown(0.6);
  }

  // Consent body
  doc.font("Helvetica").fontSize(11).fillColor("#222").text(getConsentBody(tplName), {
    align: "justify",
    width: 495,
  });
  doc.moveDown(1);

  // Patient declaration
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#111").text("Declaration");
  doc.font("Helvetica").fontSize(10).fillColor("#222").text(
    `I, ${patient?.name || "—"}, confirm that I have read and understood the above. ` +
      `I have had the opportunity to ask questions and all my questions have been answered ` +
      `to my satisfaction. I voluntarily give my consent to proceed.`,
    { width: 495 },
  );
  doc.moveDown(1.2);

  // Signature
  const sigTop = doc.y;
  let sigPlaced = false;
  if (signatureDataUrl && typeof signatureDataUrl === "string") {
    const m = signatureDataUrl.match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/i);
    if (m) {
      try {
        const buf = Buffer.from(m[2], "base64");
        doc.image(buf, 50, sigTop, { fit: [200, 70] });
        sigPlaced = true;
      } catch (e) {
        // fall through to line
      }
    }
  }
  if (!sigPlaced) {
    doc.moveTo(50, sigTop + 50).lineTo(250, sigTop + 50).lineWidth(0.5).strokeColor("#444").stroke();
  }
  const labelY = sigTop + 78;
  doc.font("Helvetica").fontSize(10).fillColor("#333").text("Patient Signature", 50, labelY);
  doc.text(`Name: ${patient?.name || "—"}`, 50, labelY + 14);
  doc.text(`Signed: ${formatDate(consent?.signedAt || new Date())}`, 50, labelY + 28);

  doc.end();
  return bufPromise;
}

// ── 3. Branded Invoice PDF ─────────────────────────────────────────

async function renderBrandedInvoicePdf(invoice, contact, clinic) {
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const bufPromise = streamToBuffer(doc);

  const c = safeClinic(clinic);

  // Header block — clinic name (bold, logo placeholder) + address on left, invoice meta on right
  const headerTop = doc.y;
  doc.font("Helvetica-Bold").fontSize(20).fillColor("#111").text(c.name, 50, headerTop);
  doc.font("Helvetica").fontSize(10).fillColor("#555");
  const addr = [c.addressLine, [c.city, c.state, c.pincode].filter(Boolean).join(", ")]
    .filter(Boolean)
    .join("\n");
  if (addr) doc.text(addr, 50, doc.y);

  // Right-hand invoice meta
  doc.font("Helvetica-Bold").fontSize(18).fillColor("#111").text("INVOICE", 380, headerTop, { width: 165, align: "right" });
  doc.font("Helvetica").fontSize(10).fillColor("#333");
  doc.text(`Invoice #: ${invoice?.invoiceNum || invoice?.id || "—"}`, 380, headerTop + 26, { width: 165, align: "right" });
  doc.text(`Issued: ${formatDate(invoice?.issuedDate || new Date())}`, 380, headerTop + 40, { width: 165, align: "right" });
  doc.text(`Due: ${formatDate(invoice?.dueDate)}`, 380, headerTop + 54, { width: 165, align: "right" });
  doc.text(`Status: ${invoice?.status || "UNPAID"}`, 380, headerTop + 68, { width: 165, align: "right" });

  // Move cursor below both columns
  doc.y = Math.max(doc.y, headerTop + 90);
  doc.moveDown(0.8);
  const divY = doc.y;
  doc.moveTo(50, divY).lineTo(545, divY).lineWidth(0.7).strokeColor("#999").stroke();
  doc.moveDown(0.8);

  // Bill To
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#111").text("Bill To");
  doc.font("Helvetica").fontSize(10).fillColor("#222");
  doc.text(contact?.name || "—");
  if (contact?.company) doc.text(contact.company);
  if (contact?.email) doc.text(contact.email);
  if (contact?.phone) doc.text(contact.phone);
  doc.moveDown(1);

  // Table header
  const tableTop = doc.y;
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#333");
  doc.text("Description", 50, tableTop);
  doc.text("Amount", 450, tableTop, { width: 95, align: "right" });
  doc.moveTo(50, tableTop + 14).lineTo(545, tableTop + 14).lineWidth(0.5).strokeColor("#bbb").stroke();

  // Single line (flat-amount invoices)
  const lineY = tableTop + 22;
  doc.font("Helvetica").fontSize(10).fillColor("#222");
  doc.text(`Invoice ${invoice?.invoiceNum || invoice?.id || ""}`.trim(), 50, lineY, { width: 380 });
  const amount = Number(invoice?.amount) || 0;
  doc.text(formatMoney(amount), 450, lineY, { width: 95, align: "right" });

  // Totals
  const totalsY = lineY + 40;
  doc.moveTo(350, totalsY).lineTo(545, totalsY).lineWidth(0.5).strokeColor("#bbb").stroke();
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#111");
  doc.text("Total", 350, totalsY + 8, { width: 95, align: "right" });
  doc.text(formatMoney(amount), 450, totalsY + 8, { width: 95, align: "right" });

  // Terms
  const termsY = totalsY + 60;
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#333").text("Terms", 50, termsY);
  doc.font("Helvetica").fontSize(9).fillColor("#555").text(
    "Payment is due by the date indicated above. Please quote the invoice number on any payment or correspondence.",
    50,
    termsY + 14,
    { width: 495 },
  );

  // Footer
  const footerY = 780;
  doc.font("Helvetica").fontSize(9).fillColor("#777");
  const footerLine = [c.phone, c.email].filter(Boolean).join("  |  ");
  if (footerLine) doc.text(footerLine, 50, footerY, { width: 495, align: "center" });

  doc.end();
  return bufPromise;
}

module.exports = {
  renderPrescriptionPdf,
  renderConsentPdf,
  renderBrandedInvoicePdf,
};
