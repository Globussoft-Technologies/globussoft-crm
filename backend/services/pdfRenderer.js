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

// Parse Zylu-style structured `instructions` into clinical sections. Mirrors
// frontend/src/pages/wellness/PatientDetail.jsx's parseRxInstructions so the
// PDF and the on-screen modal render the same sections.
function parseRxInstructions(raw) {
  const out = { zyluId: "", chiefComplaint: "", diagnosis: "", investigations: "", advice: "", status: "", notes: "" };
  if (!raw || typeof raw !== "string") return out;
  const lines = raw.split(/\r?\n/);
  const leftover = [];
  let bucket = null;
  for (const line of lines) {
    const z = line.match(/^\s*\[ZYLU-#?(\d+)\]\s*$/i);
    if (z) { out.zyluId = z[1]; bucket = null; continue; }
    const m = line.match(/^\s*(chief complaint|diagnosis|investigations?|advice|advice\/referrals?|status|notes?)\s*:\s*(.*)$/i);
    if (m) {
      const key = m[1].toLowerCase();
      const val = m[2].trim();
      if (key.startsWith("chief")) { out.chiefComplaint = val; bucket = "chiefComplaint"; }
      else if (key.startsWith("diagnosis")) { out.diagnosis = val; bucket = "diagnosis"; }
      else if (key.startsWith("invest")) { out.investigations = val; bucket = "investigations"; }
      else if (key.startsWith("advice")) { out.advice = val; bucket = "advice"; }
      else if (key.startsWith("status")) { out.status = val; bucket = null; }
      else if (key.startsWith("note")) { out.notes = val; bucket = "notes"; }
      continue;
    }
    if (bucket && line.trim()) {
      out[bucket] = (out[bucket] ? out[bucket] + "\n" : "") + line.trim();
    } else if (line.trim()) {
      leftover.push(line.trim());
    }
  }
  if (!out.notes && leftover.length) out.notes = leftover.join("\n");
  return out;
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

async function renderPrescriptionPdf(prescription, patient, clinic, doctor) {
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const bufPromise = streamToBuffer(doc);

  const parsed = parseRxInstructions(prescription?.instructions);
  const status = parsed.status || "Issued";
  const drugs = parseDrugs(prescription?.drugs);
  const pageRight = doc.page.width - doc.page.margins.right; // 545 with margin 50

  // ── Header: clinic on the left, prescription metadata on the right.
  drawClinicHeader(doc, clinic);
  const headerY = doc.y;
  doc.font("Helvetica-Bold").fontSize(13).fillColor("#111")
    .text(`Prescription - ${prescription?.id ?? ""}`, 50, headerY, { continued: false });

  // Rx badge (boxed) centered between the title and the right block.
  doc.lineWidth(0.6).strokeColor("#444").rect(280, headerY - 2, 28, 16).stroke();
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#222").text("Rx", 280, headerY + 1, { width: 28, align: "center" });

  // Right-aligned metadata column. pdfkit's `continued: true` with
  // `align: "right"` aligns each segment independently and overlaps them,
  // so render each line as one pre-composed string instead.
  const rightX = 360, rightW = pageRight - rightX;
  doc.font("Helvetica").fontSize(10).fillColor("#222");
  doc.text(`Date: ${formatDate(prescription?.createdAt)}`, rightX, headerY, { width: rightW, align: "right" });
  doc.text(`Prescription #: ${prescription?.id ?? "—"}`, rightX, doc.y, { width: rightW, align: "right" });
  doc.text(`Appointment #: ${prescription?.visitId ?? "—"}`, rightX, doc.y, { width: rightW, align: "right" });

  doc.moveDown(1);
  doc.y = Math.max(doc.y, headerY + 48);

  // ── Patient + Doctor side-by-side blocks.
  const blockTop = doc.y;
  const leftCol = 50, rightCol = 300, colWidth = 240;

  doc.font("Helvetica-Bold").fontSize(11).fillColor("#111").text("Patient Information", leftCol, blockTop);
  doc.font("Helvetica").fontSize(10).fillColor("#222");
  const patientLines = [
    ["Name", patient?.name],
    ["ID", patient?.id != null ? String(patient.id) : ""],
    ["Gender", patient?.gender],
    ["Phone", patient?.phone],
  ];
  let py = doc.y;
  for (const [k, v] of patientLines) {
    doc.font("Helvetica-Bold").text(`${k}: `, leftCol, py, { continued: true })
      .font("Helvetica").text(String(v || "—"));
    py = doc.y;
  }
  const patientEndY = doc.y;

  // Reset to top of the right column.
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#111").text("Doctor Information", rightCol, blockTop);
  doc.font("Helvetica").fontSize(10).fillColor("#222");
  // Registration Number is only included when present — the User model
  // doesn't carry one today, so for most rows we just drop the line.
  const doctorLines = [
    ["Name", doctor?.name],
    ["Phone", doctor?.phone],
    ["Email", doctor?.email],
  ];
  if (doctor?.registrationNumber) {
    doctorLines.push(["Registration Number", doctor.registrationNumber]);
  }
  let dy = doc.y;
  for (const [k, v] of doctorLines) {
    doc.font("Helvetica-Bold").text(`${k}: `, rightCol, dy, { continued: true, width: colWidth })
      .font("Helvetica").text(String(v || "—"));
    dy = doc.y;
  }
  const doctorEndY = doc.y;

  // Realign cursor to the lower of the two columns + a divider.
  const sectionEndY = Math.max(patientEndY, doctorEndY) + 8;
  doc.moveTo(leftCol, sectionEndY).lineTo(pageRight, sectionEndY).lineWidth(0.5).strokeColor("#bbb").stroke();
  doc.y = sectionEndY + 10;

  // ── Medical Information.
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#111").text("Medical Information", leftCol);
  doc.moveDown(0.3);
  const medRows = [
    ["Chief Complaint", parsed.chiefComplaint || "Not Specified"],
    ["Diagnosis", parsed.diagnosis || "Not Specified"],
    ["Investigations", parsed.investigations || "Not Specified"],
  ];
  doc.font("Helvetica").fontSize(10).fillColor("#222");
  for (const [k, v] of medRows) {
    const y = doc.y;
    doc.font("Helvetica-Bold").text(`${k}: `, leftCol, y, { continued: true, width: pageRight - leftCol })
      .font("Helvetica").text(String(v));
  }
  doc.moveDown(0.5);

  // ── Prescription Medications table.
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#111").text("Prescription Medications");
  doc.moveDown(0.3);

  const tableTop = doc.y;
  // Column layout sized to A4 with 50pt margins (usable width = 495).
  const cols = [
    { label: "Medication", x: 50, w: 95 },
    { label: "Dosage", x: 145, w: 55 },
    { label: "Form", x: 200, w: 50 },
    { label: "Route", x: 250, w: 50 },
    { label: "Frequency", x: 300, w: 60 },
    { label: "Duration", x: 360, w: 75 },
    { label: "Instructions", x: 435, w: 110 },
  ];

  // Header band.
  doc.rect(50, tableTop, 495, 18).fillColor("#f3f4f6").fill();
  doc.fillColor("#333").font("Helvetica-Bold").fontSize(9);
  for (const c of cols) doc.text(c.label, c.x + 3, tableTop + 5, { width: c.w - 6 });

  let rowY = tableTop + 18;
  doc.font("Helvetica").fontSize(9).fillColor("#222");
  if (drugs.length === 0) {
    doc.text("(no medications listed)", 53, rowY + 4);
    rowY += 22;
  } else {
    for (const d of drugs) {
      const strength = [d.strengthValue, d.strengthUnit].filter(Boolean).join("") || d.strength || "";
      const dosageCell = [d.dosage || "—", strength || "—"].join(" ");
      const cells = [
        d.name || d.drug || "—",
        dosageCell,
        d.preparation || d.dosageForm || "—",
        d.route || "—",
        d.frequency || "—",
        d.duration || "—",
        d.instructions || "—",
      ];
      // Estimate row height from the tallest cell.
      const heights = cells.map((val, i) => doc.heightOfString(String(val), { width: cols[i].w - 6 }));
      const rowH = Math.max(18, ...heights) + 6;
      // Page-break guard.
      if (rowY + rowH > 740) {
        doc.addPage();
        rowY = 60;
      }
      cells.forEach((val, i) => {
        doc.text(String(val), cols[i].x + 3, rowY + 3, { width: cols[i].w - 6 });
      });
      // Row border line.
      doc.moveTo(50, rowY + rowH).lineTo(545, rowY + rowH).lineWidth(0.3).strokeColor("#e5e7eb").stroke();
      rowY += rowH;
    }
  }
  doc.y = rowY + 8;

  // ── Additional Advice.
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#111").text("Additional Advice");
  doc.font("Helvetica").fontSize(10).fillColor("#222")
    .text(parsed.advice || "—", { width: 495 });
  doc.moveDown(0.5);

  // ── Notes.
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#111").text("Notes");
  doc.font("Helvetica").fontSize(10).fillColor("#222")
    .text(parsed.notes || "No clinical notes recorded.", { width: 495 });
  doc.moveDown(1.5);

  // ── Doctor's signature.
  const sigY = Math.max(doc.y + 30, 680);
  doc.moveTo(340, sigY).lineTo(545, sigY).lineWidth(0.5).strokeColor("#444").stroke();
  doc.font("Helvetica").fontSize(10).fillColor("#444").text("Doctor's Signature", 340, sigY + 4, { width: 205, align: "center" });

  // ── Footer: status (left) + printed-on (right).
  const footerY = 760;
  doc.font("Helvetica-Bold").fontSize(9).fillColor("#222")
    .text("Status: ", 50, footerY, { continued: true })
    .font("Helvetica").text(status);
  doc.font("Helvetica").fontSize(9).fillColor("#666")
    .text(`Printed on: ${new Date().toLocaleString("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}`,
      50, footerY, { width: 495, align: "right" });

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
      } catch (_e) {
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
