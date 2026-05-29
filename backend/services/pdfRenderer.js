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

// Slice 8 of the #902 GST & Compliance module — surfaces per-line SAC
// codes + CGST/SGST/IGST split + HSN/SAC summary in the travel invoice
// PDF. We require the two helpers as `module.exports.<fn>` indirection
// so a future vitest can spy on the surface; for the consumer it's the
// same shape.
const hsnSacMapper = require("../lib/hsnSacMapper");
const gstCalculation = require("../lib/gstCalculation");

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

// Render an array of [label, value] pairs as one continued line with the
// labels bold and the values regular weight. Used by the case-history
// visit summary so "Service: …  •  Doctor: …" shows each label clearly.
function renderBoldLabeledLine(doc, pairs, x, width, sep = "   •   ") {
  const startX = x;
  doc.fillColor("#111").fontSize(10);
  pairs.forEach(([label, value], i) => {
    if (i === 0) {
      doc.font("Helvetica-Bold").text(`${label}: `, startX, doc.y, { continued: true });
    } else {
      doc.font("Helvetica").fillColor("#9ca3af").text(sep, { continued: true });
      doc.font("Helvetica-Bold").fillColor("#111").text(`${label}: `, { continued: true });
    }
    const isLast = i === pairs.length - 1;
    doc.font("Helvetica").fillColor("#333")
      .text(String(value), isLast ? { width } : { continued: true });
  });
}

// Render a free-text notes block where embedded "Label:" tokens
// (Services:, Products:, Employee:, Location: …) become bold AND start
// on their own line. The legacy free-text format mashed every labelled
// section onto one wrapping paragraph which made the structure invisible
// — e.g. "AFTProducts: …" with no separator between value and next
// label. Splitting into one line per label gives a clean list view.
function renderNotesWithBoldLabels(doc, raw, x, width) {
  if (!raw || typeof raw !== "string") return;
  doc.fillColor("#111").fontSize(10);
  const indent = 12;

  // Always lead with a bold "Notes:" header on its own line so the row
  // is clearly a notes block and not a continuation of the summary line
  // above.
  doc.font("Helvetica-Bold").fillColor("#111").text("Notes:", x, doc.y, { width });

  // Tokenize: split on the capture group so the alternating array
  // yields [pre, label, mid, label, …, post]. The "pre" before the
  // first label is any free-text that came BEFORE any labelled chunk
  // (rare in practice but we still print it). After that, every
  // (label, value) pair gets its OWN line, indented under the Notes
  // header so the structure reads as a list.
  const labelRe = /(\b[A-Z][A-Za-z][\w&/-]*:)/g;
  const parts = raw.split(labelRe);

  // Stitch into rows: { label, value }. The very first segment (parts[0])
  // is any unlabelled prefix.
  const rows = [];
  if (parts[0] && parts[0].trim()) rows.push({ label: null, value: parts[0].trim() });
  for (let i = 1; i < parts.length; i += 2) {
    const label = parts[i];
    const value = (parts[i + 1] || "").trim();
    rows.push({ label, value });
  }

  for (const row of rows) {
    if (row.label) {
      doc.font("Helvetica-Bold").fillColor("#111")
        .text(`${row.label} `, x + indent, doc.y, { continued: true });
      doc.font("Helvetica").fillColor("#333")
        .text(row.value || "—", { width: width - indent });
    } else {
      doc.font("Helvetica").fillColor("#333")
        .text(row.value, x + indent, doc.y, { width: width - indent });
    }
  }
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
  // After the drug-table rows pdfkit's `doc.x` is wherever the last cell
  // wrote (typically the Instructions column, x≈435). Subsequent
  // `doc.text("Additional Advice")` / `text("Notes")` calls without an
  // explicit x would inherit that offset and render the body starting
  // from ~x=435 with width=495 — pushing the tail off the right edge of
  // the page (the visible chop on the last line of Notes). Reset the
  // cursor to the left margin before continuing.
  doc.x = leftCol;
  doc.y = rowY + 8;
  const bodyWidth = pageRight - leftCol;

  // ── Additional Advice.
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#111")
    .text("Additional Advice", leftCol, doc.y, { width: bodyWidth });
  doc.font("Helvetica").fontSize(10).fillColor("#222")
    .text(parsed.advice || "—", leftCol, doc.y, { width: bodyWidth });
  doc.moveDown(0.5);
  doc.x = leftCol;

  // ── Notes.
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#111")
    .text("Notes", leftCol, doc.y, { width: bodyWidth });
  doc.font("Helvetica").fontSize(10).fillColor("#222")
    .text(
      parsed.notes || "No clinical notes recorded.",
      leftCol,
      doc.y,
      { width: bodyWidth },
    );
  doc.moveDown(1.5);
  doc.x = leftCol;

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

// ── 4. Patient Summary PDF ─────────────────────────────────────────
// Full multi-page dossier: profile, case history (visits + Rx + consents
// chronologically), detailed prescriptions, treatment plans, wallet ledger,
// and memberships. One file per patient, downloadable from PatientDetail.

// Strip every customer-facing reference to the upstream Zylu POS — source
// values like "zylu-import", "[ZYLU-#nnn]" markers, "Zylu booking #N"
// strings — mirroring the same UI rule applied in PatientDetail.jsx.
function scrubZyluText(text) {
  if (!text || typeof text !== 'string') return text || '';
  let t = text.replace(/\bzylu\s+booking\s*#?\s*\d+\.?/gi, '').trim();
  t = t.replace(/\[\s*zylu-?#?\d+\s*\]/gi, '').trim();
  t = t.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return t;
}
function scrubZyluSource(v) {
  if (!v || (typeof v === 'string' && /^zylu/i.test(v.trim()))) return null;
  return v;
}

// Parse a Visit.photosBefore / photosAfter column. Schema stores them as
// `String? @db.Text` containing a JSON array of URLs; tolerate null,
// already-decoded arrays, and malformed JSON without throwing.
function parsePhotoUrls(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter((u) => typeof u === 'string' && u.length);
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((u) => typeof u === 'string' && u.length) : [];
    } catch {
      return [];
    }
  }
  return [];
}

async function renderPatientSummaryPdf({
  patient,
  tenant,
  clinic,
  wallet,
  walletTransactions,
  memberships,
  logoBuffer,
  photoBuffers,
}) {
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const bufPromise = streamToBuffer(doc);
  const pageRight = doc.page.width - doc.page.margins.right;
  const leftX = 50;
  const usableW = pageRight - leftX;

  const ensureSpace = (needed) => {
    if (doc.y + needed > 770) {
      doc.addPage();
      doc.y = 60;
    }
  };

  // Section heading — light-grey fill band with a teal accent stripe on
  // the left so every section is unambiguously distinct from body text.
  // Adds extra vertical breathing room before the band so consecutive
  // sections never visually crash into each other.
  const sectionTitle = (text) => {
    ensureSpace(50);
    doc.moveDown(1.0);
    const barY = doc.y;
    const barH = 26;
    doc.save();
    doc.rect(leftX, barY, usableW, barH).fillColor("#f3f4f6").fill();
    doc.rect(leftX, barY, 4, barH).fillColor("#265855").fill();
    doc.restore();
    doc.font("Helvetica-Bold").fontSize(12).fillColor("#111")
      .text(text, leftX + 14, barY + 8, { width: usableW - 24 });
    doc.y = barY + barH;
    doc.moveDown(0.5);
  };

  // Label-value row — two fixed columns (uppercase grey label, then the
  // value in normal weight). The previous `continued: true` approach
  // made the value butt directly against the label with no breathing
  // room and ran the two together when the label wrapped — replaced
  // with absolute-positioned columns that always align.
  const KV_LABEL_W = 140;
  const kv = (label, value, opts = {}) => {
    const v = value == null || value === "" ? "—" : String(value);
    ensureSpace(18);
    const y = doc.y;
    doc.font("Helvetica-Bold").fontSize(8.5).fillColor("#6b7280")
      .text(String(label).toUpperCase(), leftX, y + 2, { width: opts.labelWidth || KV_LABEL_W });
    doc.font("Helvetica").fontSize(10).fillColor("#111")
      .text(v, leftX + (opts.labelWidth || KV_LABEL_W), y, {
        width: usableW - (opts.labelWidth || KV_LABEL_W),
      });
    doc.y = Math.max(doc.y, y + 16);
    doc.moveDown(0.15);
  };

  const currency = wallet?.currency || patient?.currency || "INR";

  const visits = patient?.visits || [];
  const prescriptions = patient?.prescriptions || [];
  const consents = patient?.consents || [];
  const treatmentPlans = patient?.treatmentPlans || [];
  const membershipList = memberships || [];
  const transactions = walletTransactions || [];
  const hasWalletActivity = wallet && (Number(wallet.balance) !== 0 || transactions.length > 0);

  // ── Cover / header: logo tile in the corner, org name + address beside it ──
  // Tenant.name is the company brand (e.g. "Dr. Haror's Wellness").
  // Clinic (Location) gives the branch address / phone / email beside it.
  const companyName = tenant?.name || clinic?.name || "Clinic";
  const c = safeClinic(clinic);

  const headerY = 50;
  const logoTileSize = 78;
  const headerH = logoTileSize;
  const textBlockX = leftX + logoTileSize + 18;
  const textBlockW = usableW - logoTileSize - 18;

  // Logo tile: top-left corner, fixed square slot. The source image is
  // scaled by HEIGHT to the slot size then clipped to a square anchored
  // to the left edge — this extracts only the icon portion of combined
  // "icon + wordmark" brand assets (e.g. the bundled GlobusCRM logo)
  // while passing icon-only square uploads through unchanged. The clip
  // rectangle is also rounded to match the visual rhythm of the rest
  // of the page.
  if (logoBuffer) {
    try {
      doc.save();
      doc.roundedRect(leftX, headerY, logoTileSize, logoTileSize, 6).clip();
      // height: logoTileSize → image is scaled so its rendered height
      // equals the slot height; any excess width on the right is
      // clipped away by the rect above. A square source ends up exactly
      // filling the slot; a wide source surfaces only its left square.
      doc.image(logoBuffer, leftX, headerY, { height: logoTileSize });
      doc.restore();
    } catch (_e) {
      doc.restore(); // ensure clip is unwound even on render failure
    }
  }

  // Org name + address block, vertically centred against the logo tile.
  const addressLine = [
    c.addressLine,
    [c.city, c.state, c.pincode].filter(Boolean).join(", "),
  ].filter(Boolean).join(", ");
  const contactLine = [c.phone, c.email].filter(Boolean).join("  ·  ");

  doc.font("Helvetica-Bold").fontSize(17);
  const nameH = doc.heightOfString(companyName, { width: textBlockW });
  doc.font("Helvetica").fontSize(10);
  const addrH = addressLine ? doc.heightOfString(addressLine, { width: textBlockW }) : 0;
  const contactH = contactLine ? doc.heightOfString(contactLine, { width: textBlockW }) : 0;
  const textBlockH = nameH + (addrH ? addrH + 4 : 0) + (contactH ? contactH + 2 : 0);
  let cursorY = headerY + Math.max(0, (headerH - textBlockH) / 2);

  doc.font("Helvetica-Bold").fontSize(17).fillColor("#111")
    .text(companyName, textBlockX, cursorY, { width: textBlockW });
  cursorY = doc.y + 2;
  if (addressLine) {
    doc.font("Helvetica").fontSize(10).fillColor("#444")
      .text(addressLine, textBlockX, cursorY, { width: textBlockW });
    cursorY = doc.y;
  }
  if (contactLine) {
    doc.font("Helvetica").fontSize(10).fillColor("#666")
      .text(contactLine, textBlockX, cursorY, { width: textBlockW });
  }

  // Thin divider between header band and the document body.
  const dividerY = headerY + headerH + 14;
  doc.moveTo(leftX, dividerY).lineTo(pageRight, dividerY)
    .lineWidth(0.6).strokeColor("#d1d5db").stroke();

  // Title row — "Patient Summary" on the left, generated timestamp on
  // the right, both sitting on a single baseline so the page opens with
  // a clean horizontal rule above and a clean title row below.
  const titleY = dividerY + 14;
  doc.font("Helvetica-Bold").fontSize(20).fillColor("#111")
    .text("Patient Summary", leftX, titleY);
  doc.font("Helvetica").fontSize(9.5).fillColor("#666")
    .text(
      `Generated ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`,
      leftX,
      titleY,
      { width: usableW, align: "right" },
    );
  doc.y = titleY + 28;

  // ── Profile (always rendered) ─────────────────────────────────────
  sectionTitle("Profile");
  kv("Name", patient?.name);
  kv("Patient ID", patient?.id);
  kv("Date of Birth", patient?.dob ? `${formatDate(patient.dob)} (age ${computeAge(patient.dob)})` : "—");
  kv("Gender", patient?.gender);
  kv("Phone", patient?.phone);
  kv("Email", patient?.email);
  if (patient?.bloodGroup) kv("Blood Group", patient.bloodGroup);
  if (patient?.address) kv("Address", patient.address);
  { const src = scrubZyluSource(patient?.source); if (src) kv("Source", src); }
  if (patient?.allergies) kv("Allergies", patient.allergies);
  if (patient?.medicalHistory) kv("Medical History", patient.medicalHistory);
  if (patient?.notes) kv("Notes", patient.notes);

  // Breathing room between Profile and the next section.
  doc.moveDown(1.5);

  // ── Case history (chronological) ──────────────────────────────────
  const events = [
    ...visits.map((v) => ({ kind: "Visit", date: v.visitDate, data: v })),
    ...prescriptions.map((p) => ({ kind: "Prescription", date: p.createdAt, data: p })),
    ...consents.map((c) => ({ kind: "Consent", date: c.signedAt, data: c })),
  ].sort((a, b) => new Date(b.date) - new Date(a.date));

  if (events.length > 0) {
    sectionTitle(`Case History (${events.length})`);
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      ensureSpace(46);
      // Date pill + event-kind badge. Visits = blue, Rx = teal, Consent
      // = amber — colour-coded so the page is glanceable instead of one
      // wall of black text.
      const KIND_COLORS = { Visit: "#1d4ed8", Prescription: "#0f766e", Consent: "#b45309" };
      const kindColor = KIND_COLORS[e.kind] || "#374151";
      const headY = doc.y;
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#111")
        .text(formatDate(e.date), leftX, headY, { continued: true })
        .fillColor("#9ca3af").text("   •   ", { continued: true })
        .fillColor(kindColor).text(e.kind);
      doc.moveDown(0.2);

      doc.font("Helvetica").fontSize(10).fillColor("#333");
      if (e.kind === "Visit") {
        const v = e.data;
        // Bold each "Label: value" pair so the keys stand out from the
        // values. Rendered as one continued line with font/colour
        // flipped per segment; pdfkit auto-wraps when the line overflows.
        const pairs = [
          ["Service", v.service?.name],
          ["Doctor", v.doctor?.name],
          ["Amount", v.amount != null ? formatMoney(v.amount, currency) : null],
          ["Status", v.status],
        ].filter(([, val]) => val);
        if (pairs.length) {
          renderBoldLabeledLine(doc, pairs, leftX + 14, usableW - 14, "   •   ");
        }
        const n = scrubZyluText(v.notes);
        if (n) renderNotesWithBoldLabels(doc, n, leftX + 14, usableW - 14);
      } else if (e.kind === "Prescription") {
        const p = e.data;
        const drugs = parseDrugs(p.drugs);
        const summary = drugs.length
          ? drugs.map((d) => d.name || d.drug || "").filter(Boolean).join(", ")
          : "(no medications listed)";
        doc.font("Helvetica-Bold").fontSize(10).fillColor("#111")
          .text(`Rx #${p.id}`, leftX + 14, doc.y, { continued: true })
          .font("Helvetica").fillColor("#333")
          .text(` — ${summary}`, { width: usableW - 14 });
        if (p.doctor?.name) {
          doc.font("Helvetica-Bold").fillColor("#111")
            .text(`Prescribed by: `, leftX + 14, doc.y, { continued: true })
            .font("Helvetica").fillColor("#333")
            .text(p.doctor.name, { width: usableW - 14 });
        }
      } else if (e.kind === "Consent") {
        const c = e.data;
        doc.font("Helvetica-Bold").fontSize(10).fillColor("#111")
          .text(`${c.templateName || "general"}`, leftX + 14, doc.y, { continued: Boolean(c.service?.name) });
        if (c.service?.name) {
          doc.font("Helvetica").fillColor("#333").text(` — ${c.service.name}`, { width: usableW - 14 });
        }
      }

      // Thin row separator between events so they don't smear into one
      // another. Skipped after the last row to keep the trailing gap clean.
      if (i < events.length - 1) {
        doc.moveDown(0.35);
        ensureSpace(8);
        doc.moveTo(leftX, doc.y).lineTo(pageRight, doc.y)
          .lineWidth(0.3).strokeColor("#e5e7eb").stroke();
        doc.moveDown(0.35);
      } else {
        doc.moveDown(0.3);
      }
    }
  }

  // ── Visits (detailed) — start on a fresh page ─────────────────────
  if (visits.length > 0) {
    doc.addPage();
    doc.y = 60;
    sectionTitle(`Visits (${visits.length})`);
    for (let i = 0; i < visits.length; i++) {
      const v = visits[i];
      ensureSpace(80);
      // Visit header bar — bold ID + date so each visit is clearly its
      // own card, not one continuous wall of text.
      doc.font("Helvetica-Bold").fontSize(11).fillColor("#111")
        .text(`Visit #${v.id}`, leftX, doc.y, { continued: true })
        .font("Helvetica").fontSize(10).fillColor("#555")
        .text(`   ·   ${formatDate(v.visitDate)}`);
      doc.moveDown(0.3);

      const rows = [
        ["Service", v.service?.name],
        ["Doctor", v.doctor?.name],
        ["Status", v.status],
        ["Amount", v.amount != null ? formatMoney(v.amount, currency) : null],
        ["Payment", v.paymentMode],
        ["Notes", scrubZyluText(v.notes)],
      ];
      for (const [k, val] of rows) {
        if (val == null || val === "") continue;
        kv(k, val);
      }

      // Before / After photos — rendered as a two-column thumbnail strip
      // when the visit has any photos uploaded. Up to 3 thumbnails per
      // side at 90x90pt; a "+N more" caption surfaces overflow. Photos
      // PDFKit can't decode (webp/gif/svg) render as a labelled
      // placeholder box rather than failing the whole page.
      const beforeUrls = parsePhotoUrls(v.photosBefore);
      const afterUrls = parsePhotoUrls(v.photosAfter);
      if (photoBuffers && (beforeUrls.length || afterUrls.length)) {
        const thumbSize = 90;
        const thumbGap = 6;
        const MAX_PER_SIDE = 3;
        const colGap = 18;
        const colW = (usableW - colGap) / 2;
        const beforeColX = leftX;
        const afterColX = leftX + colW + colGap;

        // Reserve vertical space for label row + thumbnail row + "+N
        // more" caption. Triggers a page break upfront if the strip
        // would otherwise be split across pages.
        ensureSpace(thumbSize + 36);
        doc.moveDown(0.3);

        const labelY = doc.y;
        doc.font("Helvetica-Bold").fontSize(8.5).fillColor("#6b7280")
          .text(`BEFORE (${beforeUrls.length})`, beforeColX, labelY, { width: colW });
        doc.font("Helvetica-Bold").fontSize(8.5).fillColor("#6b7280")
          .text(`AFTER (${afterUrls.length})`, afterColX, labelY, { width: colW });
        const thumbY = labelY + 14;

        const drawThumbStrip = (urls, xStart) => {
          let x = xStart;
          const shown = urls.slice(0, MAX_PER_SIDE);
          for (const url of shown) {
            const buf = photoBuffers.get(url);
            let rendered = false;
            if (buf) {
              try {
                doc.image(buf, x, thumbY, {
                  fit: [thumbSize, thumbSize],
                  align: "center",
                  valign: "center",
                });
                rendered = true;
              } catch (_e) {
                rendered = false;
              }
            }
            if (!rendered) {
              // Placeholder for missing / undecodable images.
              doc.save();
              doc.rect(x, thumbY, thumbSize, thumbSize).fillColor("#f3f4f6").fill();
              doc.restore();
              doc.font("Helvetica").fontSize(7.5).fillColor("#9ca3af")
                .text("(image)", x, thumbY + thumbSize / 2 - 4, { width: thumbSize, align: "center" });
            }
            doc.lineWidth(0.4).strokeColor("#d1d5db")
              .rect(x, thumbY, thumbSize, thumbSize).stroke();
            x += thumbSize + thumbGap;
          }
          const extras = urls.length - shown.length;
          if (extras > 0) {
            doc.font("Helvetica").fontSize(8).fillColor("#6b7280")
              .text(`+${extras} more`, xStart, thumbY + thumbSize + 3, { width: colW });
          }
        };

        drawThumbStrip(beforeUrls, beforeColX);
        drawThumbStrip(afterUrls, afterColX);

        // Account for the "+N more" caption when present so the next
        // visit's separator doesn't overlap.
        const captionPad = (beforeUrls.length > MAX_PER_SIDE || afterUrls.length > MAX_PER_SIDE) ? 14 : 0;
        doc.y = thumbY + thumbSize + 10 + captionPad;
        doc.x = leftX;
      }

      // Thin separator between consecutive visits (skipped for last row).
      if (i < visits.length - 1) {
        doc.moveDown(0.4);
        ensureSpace(8);
        doc.moveTo(leftX, doc.y).lineTo(pageRight, doc.y)
          .lineWidth(0.4).strokeColor("#e5e7eb").stroke();
        doc.moveDown(0.5);
      } else {
        doc.moveDown(0.4);
      }
    }
  }

  // ── Prescriptions (full Rx layout — mirrors renderPrescriptionPdf) ──
  // Each Rx renders as its own block: title row with Rx badge + right-
  // aligned metadata, doctor info, Medical Information rows, Prescription
  // Medications table (same column layout as the single-Rx PDF), Advice,
  // Notes. Page-break per Rx so each one is self-contained.
  if (prescriptions.length > 0) {
    for (let i = 0; i < prescriptions.length; i++) {
      const p = prescriptions[i];
      const parsed = parseRxInstructions(p.instructions);
      const status = parsed.status || "Issued";
      const drugs = parseDrugs(p.drugs);
      const doctor = p.doctor || null;

      // Start each Rx on its own page (matches single-Rx PDF layout).
      doc.addPage();
      doc.y = 60;
      sectionTitle(i === 0 ? `Prescriptions (${prescriptions.length})` : `Prescription ${i + 1} of ${prescriptions.length}`);

      // Title + Rx badge + right-aligned metadata.
      const headerY = doc.y;
      doc.font("Helvetica-Bold").fontSize(13).fillColor("#111")
        .text(`Prescription - ${p.id ?? ""}`, leftX, headerY, { continued: false });
      doc.lineWidth(0.6).strokeColor("#444").rect(230, headerY - 2, 28, 16).stroke();
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#222").text("Rx", 230, headerY + 1, { width: 28, align: "center" });
      const rightX = 360, rightW = pageRight - rightX;
      doc.font("Helvetica").fontSize(10).fillColor("#222");
      doc.text(`Date: ${formatDate(p.createdAt)}`, rightX, headerY, { width: rightW, align: "right" });
      doc.text(`Prescription #: ${p.id ?? "—"}`, rightX, doc.y, { width: rightW, align: "right" });
      doc.text(`Appointment #: ${p.visitId ?? "—"}`, rightX, doc.y, { width: rightW, align: "right" });
      doc.moveDown(0.6);
      doc.y = Math.max(doc.y, headerY + 48);

      // Patient + Doctor side-by-side blocks.
      const blockTop = doc.y;
      const rightCol = 300, colWidth = 240;
      doc.font("Helvetica-Bold").fontSize(11).fillColor("#111").text("Patient Information", leftX, blockTop);
      doc.font("Helvetica").fontSize(10).fillColor("#222");
      const patientLines = [
        ["Name", patient?.name],
        ["ID", patient?.id != null ? String(patient.id) : ""],
        ["Gender", patient?.gender],
        ["Phone", patient?.phone],
      ];
      let py = doc.y;
      for (const [k, v] of patientLines) {
        doc.font("Helvetica-Bold").text(`${k}: `, leftX, py, { continued: true })
          .font("Helvetica").text(String(v || "—"));
        py = doc.y;
      }
      const patientEndY = doc.y;

      doc.font("Helvetica-Bold").fontSize(11).fillColor("#111").text("Doctor Information", rightCol, blockTop);
      doc.font("Helvetica").fontSize(10).fillColor("#222");
      const doctorLines = [
        ["Name", doctor?.name],
        ["Phone", doctor?.phone],
        ["Email", doctor?.email],
      ];
      if (doctor?.registrationNumber) doctorLines.push(["Registration Number", doctor.registrationNumber]);
      let dy = doc.y;
      for (const [k, v] of doctorLines) {
        doc.font("Helvetica-Bold").text(`${k}: `, rightCol, dy, { continued: true, width: colWidth })
          .font("Helvetica").text(String(v || "—"));
        dy = doc.y;
      }
      const doctorEndY = doc.y;

      const sectionEndY = Math.max(patientEndY, doctorEndY) + 8;
      doc.moveTo(leftX, sectionEndY).lineTo(pageRight, sectionEndY).lineWidth(0.5).strokeColor("#bbb").stroke();
      doc.y = sectionEndY + 10;

      // Medical Information.
      doc.font("Helvetica-Bold").fontSize(11).fillColor("#111").text("Medical Information", leftX);
      doc.moveDown(0.3);
      const medRows = [
        ["Chief Complaint", parsed.chiefComplaint || "Not Specified"],
        ["Diagnosis", parsed.diagnosis || "Not Specified"],
        ["Investigations", parsed.investigations || "Not Specified"],
      ];
      doc.font("Helvetica").fontSize(10).fillColor("#222");
      for (const [k, v] of medRows) {
        const y = doc.y;
        doc.font("Helvetica-Bold").text(`${k}: `, leftX, y, { continued: true, width: pageRight - leftX })
          .font("Helvetica").text(String(v));
      }
      doc.moveDown(0.5);

      // Prescription Medications table — same column layout as single-Rx PDF.
      doc.font("Helvetica-Bold").fontSize(11).fillColor("#111").text("Prescription Medications");
      doc.moveDown(0.3);
      const tableTop = doc.y;
      const cols = [
        { label: "Medication", x: 50, w: 95 },
        { label: "Dosage", x: 145, w: 55 },
        { label: "Form", x: 200, w: 50 },
        { label: "Route", x: 250, w: 50 },
        { label: "Frequency", x: 300, w: 60 },
        { label: "Duration", x: 360, w: 75 },
        { label: "Instructions", x: 435, w: 110 },
      ];
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
          const heights = cells.map((val, i) => doc.heightOfString(String(val), { width: cols[i].w - 6 }));
          const rowH = Math.max(18, ...heights) + 6;
          if (rowY + rowH > 740) {
            doc.addPage();
            rowY = 60;
          }
          cells.forEach((val, i) => {
            doc.text(String(val), cols[i].x + 3, rowY + 3, { width: cols[i].w - 6 });
          });
          doc.moveTo(50, rowY + rowH).lineTo(545, rowY + rowH).lineWidth(0.3).strokeColor("#e5e7eb").stroke();
          rowY += rowH;
        }
      }
      // Same cursor-reset as the standalone Rx PDF — after the drug table
      // rows pdfkit's doc.x is parked at the Instructions column; without
      // resetting it the Additional Advice / Notes body wraps from x≈435
      // and tails off the right edge. Pin x to leftX before continuing.
      doc.x = leftX;
      doc.y = rowY + 8;
      const noteWidth = pageRight - leftX;

      // Additional Advice + Notes.
      doc.font("Helvetica-Bold").fontSize(11).fillColor("#111")
        .text("Additional Advice", leftX, doc.y, { width: noteWidth });
      doc.font("Helvetica").fontSize(10).fillColor("#222")
        .text(parsed.advice || "—", leftX, doc.y, { width: noteWidth });
      doc.moveDown(0.5);
      doc.x = leftX;
      doc.font("Helvetica-Bold").fontSize(11).fillColor("#111")
        .text("Notes", leftX, doc.y, { width: noteWidth });
      doc.font("Helvetica").fontSize(10).fillColor("#222")
        .text(
          parsed.notes || "No clinical notes recorded.",
          leftX,
          doc.y,
          { width: noteWidth },
        );
      doc.moveDown(0.4);
      doc.x = leftX;
      doc.font("Helvetica-Bold").fontSize(9).fillColor("#222")
        .text("Status: ", leftX, doc.y, { continued: true })
        .font("Helvetica").text(status);
    }
  }

  // ── Treatment plans ───────────────────────────────────────────────
  if (treatmentPlans.length > 0) {
    sectionTitle(`Treatment Plans (${treatmentPlans.length})`);
    for (let i = 0; i < treatmentPlans.length; i++) {
      const t = treatmentPlans[i];
      ensureSpace(60);
      doc.font("Helvetica-Bold").fontSize(11).fillColor("#111")
        .text(`Plan #${t.id}`, leftX, doc.y, { continued: true })
        .font("Helvetica").fontSize(10).fillColor("#555")
        .text(`   ·   ${t.service?.name || "—"}`);
      doc.moveDown(0.3);
      if (t.sessionsTotal != null || t.sessionsCompleted != null) {
        kv("Sessions", `${t.sessionsCompleted ?? 0} / ${t.sessionsTotal ?? "—"}`);
      }
      if (t.totalPrice != null) kv("Total Price", formatMoney(t.totalPrice, currency));
      if (t.status) kv("Status", t.status);
      if (t.notes) kv("Notes", t.notes);
      if (i < treatmentPlans.length - 1) {
        doc.moveDown(0.4);
        ensureSpace(8);
        doc.moveTo(leftX, doc.y).lineTo(pageRight, doc.y)
          .lineWidth(0.4).strokeColor("#e5e7eb").stroke();
        doc.moveDown(0.5);
      } else {
        doc.moveDown(0.4);
      }
    }
  }

  // ── Wallet ────────────────────────────────────────────────────────
  if (hasWalletActivity) {
    sectionTitle("Wallet");
    kv("Balance", formatMoney(wallet.balance, currency));
    kv("Currency", currency);
    if (transactions.length > 0) {
      doc.moveDown(0.4);
      doc.font("Helvetica-Bold").fontSize(11).fillColor("#111").text(`Recent transactions (${transactions.length})`, leftX);
      doc.moveDown(0.2);
      const tableTop = doc.y;
      const cols = [
        { label: "Date", x: leftX, w: 90 },
        { label: "Type", x: leftX + 90, w: 110 },
        { label: "Amount", x: leftX + 200, w: 90 },
        { label: "Reason", x: leftX + 290, w: usableW - 290 },
      ];
      doc.rect(leftX, tableTop, usableW, 18).fillColor("#f3f4f6").fill();
      doc.fillColor("#333").font("Helvetica-Bold").fontSize(9);
      for (const c of cols) doc.text(c.label, c.x + 3, tableTop + 5, { width: c.w - 6 });
      let rowY = tableTop + 18;
      doc.font("Helvetica").fontSize(9).fillColor("#222");
      for (const tx of transactions) {
        const cells = [
          formatDate(tx.createdAt),
          String(tx.type || "").replace(/_/g, " "),
          `${tx.amount >= 0 ? "+" : ""}${formatMoney(tx.amount, currency)}`,
          tx.reason || "—",
        ];
        const heights = cells.map((val, i) => doc.heightOfString(String(val), { width: cols[i].w - 6 }));
        const rowH = Math.max(16, ...heights) + 6;
        if (rowY + rowH > 770) {
          doc.addPage();
          rowY = 60;
        }
        cells.forEach((val, i) => {
          doc.text(String(val), cols[i].x + 3, rowY + 3, { width: cols[i].w - 6 });
        });
        doc.moveTo(leftX, rowY + rowH).lineTo(pageRight, rowY + rowH)
          .lineWidth(0.3).strokeColor("#e5e7eb").stroke();
        rowY += rowH;
      }
      doc.y = rowY + 8;
    }
  }

  // ── Memberships ───────────────────────────────────────────────────
  if (membershipList.length > 0) {
    sectionTitle(`Memberships (${membershipList.length})`);
    for (let i = 0; i < membershipList.length; i++) {
      const m = membershipList[i];
      ensureSpace(60);
      doc.font("Helvetica-Bold").fontSize(11).fillColor("#111")
        .text(m.plan?.name || "Plan", leftX, doc.y, { continued: true })
        .font("Helvetica").fontSize(10).fillColor("#555")
        .text(`   ·   Membership #${m.id}`);
      doc.moveDown(0.3);
      if (m.status) kv("Status", m.status);
      if (m.startDate) kv("Start", formatDate(m.startDate));
      if (m.endDate) kv("End", formatDate(m.endDate));
      if (m.plan?.price != null) kv("Price Paid", formatMoney(m.plan.price, m.plan.currency || currency));
      if (m.balanceJson || m.balance) {
        let balText = "";
        try {
          const bal = typeof m.balanceJson === "string" ? JSON.parse(m.balanceJson) : (m.balanceJson || m.balance);
          if (bal && typeof bal === "object") {
            balText = Object.entries(bal).map(([k, v]) => `${k}: ${v}`).join("   •   ");
          }
        } catch {
          /* ignore */
        }
        if (balText) kv("Balance", balText);
      }
      if (i < membershipList.length - 1) {
        doc.moveDown(0.4);
        ensureSpace(8);
        doc.moveTo(leftX, doc.y).lineTo(pageRight, doc.y)
          .lineWidth(0.4).strokeColor("#e5e7eb").stroke();
        doc.moveDown(0.5);
      } else {
        doc.moveDown(0.4);
      }
    }
  }

  doc.end();
  return bufPromise;
}

// ── POS receipt PDF (D17 Arc 1 slice 6) ────────────────────────────
//
// Pure helper: caller fetches tenant-scoped sale/lines/payments/patient/
// tenant rows via prisma and passes plain objects in — we turn them into
// PDF bytes ready for res.send() or disk write. Layout per PRD §3.7 +
// §6.4; mirrors renderBrandedInvoicePdf primitives (A4, 50pt margin).
//
// NOTE: this helper was lost when PR #916 merged a stale rewrite of
// pdfRenderer.js (slice 6 had landed via commit 4ee88c47 prior). Restored
// here against the original spec so backend/test/services/pdfRenderer-
// pos-receipt.test.js can pin the contract again.

function generatePosReceiptPdf(opts) {
  const {
    sale = {},
    lines = [],
    payments = [],
    patient = null,
    tenant = null,
  } = opts || {};

  const currency = sale.currency || "INR";
  function fmt(n) {
    const v = Number(n) || 0;
    if (currency === "INR") return `₹${v.toFixed(2)}`;
    if (currency === "USD") return `$${v.toFixed(2)}`;
    if (currency === "GBP") return `£${v.toFixed(2)}`;
    return `${currency} ${v.toFixed(2)}`;
  }

  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const bufPromise = streamToBuffer(doc);

  // ── Top header: tenant name + address + invoice meta ──────────────
  const tenantName = (tenant && tenant.name) || "Clinic";
  const addrParts = tenant
    ? [
        tenant.addressLine,
        [tenant.city, tenant.state, tenant.pincode].filter(Boolean).join(", "),
      ].filter(Boolean)
    : [];
  const tenantContact = tenant
    ? [tenant.phone, tenant.email].filter(Boolean).join("  |  ")
    : "";

  doc.font("Helvetica-Bold").fontSize(16).fillColor("#111").text(tenantName, 50, 50);
  doc.font("Helvetica").fontSize(10).fillColor("#555");
  if (addrParts.length > 0) doc.text(addrParts.join("\n"), 50, doc.y);
  if (tenantContact) doc.text(tenantContact, 50, doc.y);

  // Right-column: invoice number + completedAt
  const invoiceNumber = `INV-${sale.id != null ? sale.id : "?"}`;
  doc.font("Helvetica-Bold").fontSize(14).fillColor("#111")
    .text("RECEIPT", 380, 50, { width: 165, align: "right" });
  doc.font("Helvetica").fontSize(10).fillColor("#333");
  doc.text(invoiceNumber, 380, 70, { width: 165, align: "right" });
  doc.text(formatDate(sale.completedAt || new Date()), 380, 84, {
    width: 165,
    align: "right",
  });

  // Advance below both columns
  doc.y = Math.max(doc.y, 110);
  doc.moveDown(0.6);
  const divY = doc.y;
  doc.moveTo(50, divY).lineTo(545, divY).lineWidth(0.7).strokeColor("#999").stroke();
  doc.moveDown(0.8);
  doc.fillColor("#111");

  // ── Patient block ─────────────────────────────────────────────────
  if (patient) {
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#111").text("Customer", 50, doc.y);
    doc.font("Helvetica").fontSize(10).fillColor("#222");
    if (patient.name) doc.text(patient.name, 50, doc.y);
    if (patient.phone) doc.text(patient.phone, 50, doc.y);
    doc.moveDown(0.6);
  }

  // ── Line items table ──────────────────────────────────────────────
  const tableTop = doc.y;
  const colX = { desc: 50, qty: 300, unit: 370, total: 460 };
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#333");
  doc.text("Description", colX.desc, tableTop);
  doc.text("Qty", colX.qty, tableTop, { width: 50, align: "right" });
  doc.text("Unit Price", colX.unit, tableTop, { width: 80, align: "right" });
  doc.text("Line Total", colX.total, tableTop, { width: 85, align: "right" });
  doc.moveTo(50, tableTop + 14)
    .lineTo(545, tableTop + 14)
    .lineWidth(0.5)
    .strokeColor("#bbb")
    .stroke();

  let rowY = tableTop + 22;
  doc.font("Helvetica").fontSize(10).fillColor("#222");
  if (!Array.isArray(lines) || lines.length === 0) {
    doc.fillColor("#777").text("(No line items.)", colX.desc, rowY, { width: 480 });
    rowY += 18;
  } else {
    for (const ln of lines) {
      if (rowY > 700) {
        doc.addPage();
        rowY = 60;
      }
      const qty = Number(ln.qty) || 0;
      const unit = Number(ln.unitPrice) || 0;
      const total = ln.lineTotal != null ? Number(ln.lineTotal) : qty * unit;
      doc.fillColor("#222");
      doc.text(String(ln.description || "—"), colX.desc, rowY, { width: 240 });
      doc.text(String(qty), colX.qty, rowY, { width: 50, align: "right" });
      doc.text(fmt(unit), colX.unit, rowY, { width: 80, align: "right" });
      doc.text(fmt(total), colX.total, rowY, { width: 85, align: "right" });
      rowY += 20;
    }
  }
  doc.y = rowY + 4;

  // ── Totals block (right-aligned) ──────────────────────────────────
  const subtotal = Number(sale.subtotal) || 0;
  const discount = Number(sale.discount) || 0;
  const tax = Number(sale.tax) || 0;
  const grandTotal =
    sale.grandTotal != null
      ? Number(sale.grandTotal)
      : subtotal - discount + tax;

  doc.moveDown(0.5);
  const totalsY = doc.y;
  doc.moveTo(350, totalsY).lineTo(545, totalsY).lineWidth(0.5).strokeColor("#bbb").stroke();
  let ty = totalsY + 8;
  doc.font("Helvetica").fontSize(10).fillColor("#333");
  doc.text("Subtotal", 350, ty, { width: 95, align: "right" });
  doc.text(fmt(subtotal), 450, ty, { width: 95, align: "right" });
  ty += 16;

  // Discount + Tax rows only render when non-zero (PRD §6.4: hide-or-zero
  // is acceptable; we hide to keep the receipt visually tight).
  if (discount > 0) {
    doc.text("Discount", 350, ty, { width: 95, align: "right" });
    doc.text(`-${fmt(discount)}`, 450, ty, { width: 95, align: "right" });
    ty += 16;
  }
  if (tax > 0) {
    doc.text("Tax", 350, ty, { width: 95, align: "right" });
    doc.text(fmt(tax), 450, ty, { width: 95, align: "right" });
    ty += 16;
  }

  // Grand-total line (bold)
  doc.moveTo(350, ty).lineTo(545, ty).lineWidth(0.5).strokeColor("#bbb").stroke();
  ty += 6;
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#111");
  doc.text("Grand Total", 350, ty, { width: 95, align: "right" });
  doc.text(fmt(grandTotal), 450, ty, { width: 95, align: "right" });
  ty += 22;

  doc.y = ty + 8;

  // ── Payments section (split-tender shows every row) ───────────────
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#111").text("Payments", 50, doc.y);
  doc.font("Helvetica").fontSize(10).fillColor("#222");
  if (!Array.isArray(payments) || payments.length === 0) {
    doc.fillColor("#777").text("(No payments recorded.)", 50, doc.y, { width: 480 });
  } else {
    for (const p of payments) {
      const method = String(p.method || "—");
      const amount = Number(p.amount) || 0;
      doc.fillColor("#222").text(`${method} ... ${fmt(amount)}`, 50, doc.y);
    }
  }
  doc.moveDown(1.2);

  // ── Footer: thank-you + powered-by ────────────────────────────────
  const footerY = doc.page.height - doc.page.margins.bottom - 36;
  doc.moveTo(50, footerY).lineTo(doc.page.width - 50, footerY).lineWidth(0.4).strokeColor("#bbb").stroke();
  doc.font("Helvetica").fontSize(10).fillColor("#333").text(
    "Thank you for your visit",
    50,
    footerY + 8,
    { width: doc.page.width - 100, align: "center" },
  );
  doc.font("Helvetica-Oblique").fontSize(8).fillColor("#888").text(
    "Powered by Globussoft CRM",
    50,
    footerY + 22,
    { width: doc.page.width - 100, align: "center" },
  );

  doc.end();
  return bufPromise;
}

// ── Travel CRM — diagnostic report ──────────────────────────────────
//
// PRD §4.2: "Auto-generated branded PDF report — sub-brand logo/colors/
// fonts; sent by WhatsApp + email immediately on completion."

const SUB_BRAND_LABEL = {
  tmc: "TMC — School Trips",
  rfu: "RFU — Umrah Readiness",
  travelstall: "Travel Stall — Family Travel",
  visasure: "Visa Sure — Visa Readiness",
};
const SUB_BRAND_ACCENT = {
  tmc: "#0B4F6C",
  rfu: "#2F7A4D",
  travelstall: "#122647",
  visasure: "#7A2F5C",
};

function resolveAnswerLabel(question, rawAnswer) {
  if (rawAnswer == null) return "—";
  if (Array.isArray(question?.options) && question.options.length > 0) {
    const lookup = (val) => {
      const opt = question.options.find((o) => o && o.value === val);
      return opt ? (opt.label || opt.value) : String(val);
    };
    if (Array.isArray(rawAnswer)) return rawAnswer.map(lookup).join(", ");
    return lookup(rawAnswer);
  }
  if (Array.isArray(rawAnswer)) return rawAnswer.join(", ");
  return String(rawAnswer);
}

// ── Travel CRM — branded itinerary PDF (PRD §6.1) ────────────────────
// Ported from the canonical implementation; the routes
// (travel_itineraries.js / travel_travelstall.js) reference these two
// renderers but they were missing from this worktree's pdfRenderer.js,
// so every /itineraries/:id/pdf + personalised-pdf call 500'd.
function renderTravelItineraryPdf(itinerary, contact) {
  const sub = itinerary.subBrand;
  const brandLabel = SUB_BRAND_LABEL[sub] || "Travel CRM";
  const accent = SUB_BRAND_ACCENT[sub] || "#111111";
  const currency = itinerary.currency || "INR";
  const items = Array.isArray(itinerary.items) ? itinerary.items : [];

  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const bufPromise = streamToBuffer(doc);

  // Brand header band
  doc.rect(0, 0, doc.page.width, 60).fill(accent);
  doc.font("Helvetica-Bold").fontSize(18).fillColor("#fff")
    .text(brandLabel, 50, 22, { align: "left" });
  doc.fillColor("#fff").fontSize(10).text(
    `Itinerary v${itinerary.version || 1}`,
    50, 42, { align: "left" },
  );
  doc.fillColor("#111").moveDown(2);

  // Customer block
  doc.font("Helvetica-Bold").fontSize(13).fillColor("#111").text(contact?.name || "Customer", 50, 90);
  const metaLine = [contact?.email, contact?.phone].filter(Boolean).join("  •  ");
  if (metaLine) doc.font("Helvetica").fontSize(10).fillColor("#555").text(metaLine);
  doc.moveDown(0.5);

  // Trip-summary block
  doc.font("Helvetica-Bold").fontSize(12).fillColor("#111").text(itinerary.destination || "Destination TBD");
  const dateLine = [
    itinerary.startDate && `From ${formatDate(itinerary.startDate)}`,
    itinerary.endDate && `to ${formatDate(itinerary.endDate)}`,
  ].filter(Boolean).join(" ");
  if (dateLine) doc.font("Helvetica").fontSize(10).fillColor("#555").text(dateLine);
  doc.fillColor("#111").moveDown(0.8);

  // Items table
  if (items.length === 0) {
    doc.font("Helvetica").fontSize(10).fillColor("#777").text("(No items on this itinerary yet — quote pending.)");
  } else {
    // Table header
    const colX = { type: 50, desc: 115, qty: 360, unit: 410, total: 480 };
    const tableTop = doc.y;
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#555");
    doc.text("Type", colX.type, tableTop);
    doc.text("Description", colX.desc, tableTop);
    doc.text("Markup", colX.qty, tableTop);
    doc.text("Unit cost", colX.unit, tableTop);
    doc.text("Total", colX.total, tableTop);
    doc.moveTo(50, tableTop + 14)
      .lineTo(doc.page.width - 50, tableTop + 14)
      .lineWidth(0.5).strokeColor(accent).stroke();
    doc.font("Helvetica").fontSize(10).fillColor("#111");

    let y = tableTop + 22;
    const sorted = [...items].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    for (const it of sorted) {
      // Page-break headroom
      if (y > doc.page.height - 120) {
        doc.addPage();
        y = 50;
      }
      doc.text(String(it.itemType || "—"), colX.type, y, { width: 60 });
      doc.text(String(it.description || ""), colX.desc, y, { width: 240 });
      const markupStr = it.markup != null ? formatMoney(Number(it.markup), currency) : "—";
      const unitStr = it.unitCost != null ? formatMoney(Number(it.unitCost), currency) : "—";
      const totalStr = it.totalPrice != null ? formatMoney(Number(it.totalPrice), currency) : "—";
      doc.text(markupStr, colX.qty, y, { width: 50, align: "right" });
      doc.text(unitStr, colX.unit, y, { width: 65, align: "right" });
      doc.text(totalStr, colX.total, y, { width: 60, align: "right" });
      y += 24;
    }
    doc.y = y + 6;
  }

  // Grand total band
  if (itinerary.totalAmount != null) {
    doc.moveDown(0.8);
    const totalY = doc.y;
    doc.rect(50, totalY, doc.page.width - 100, 40).fillAndStroke("#f4f6f8", accent);
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#555")
      .text("Grand total", 60, totalY + 10);
    doc.font("Helvetica-Bold").fontSize(16).fillColor(accent)
      .text(formatMoney(Number(itinerary.totalAmount), currency), 60, totalY + 8, {
        width: doc.page.width - 120, align: "right",
      });
    doc.fillColor("#111").y = totalY + 50;
  }

  // Footer
  const footerY = doc.page.height - doc.page.margins.bottom - 32;
  doc.moveTo(50, footerY).lineTo(doc.page.width - 50, footerY).lineWidth(0.5).strokeColor("#bbb").stroke();
  doc.font("Helvetica").fontSize(8).fillColor("#777")
    .text(
      `${brandLabel} — Itinerary #${itinerary.id || "?"} v${itinerary.version || 1}. ` +
        `Pricing subject to availability at the time of booking.`,
      50, footerY + 8, { width: doc.page.width - 100, align: "center" },
    );

  doc.end();
  return bufPromise;
}

// ── Travel CRM — Travel Stall personalised 3-5 destination PDF (PRD §4.5)
// Downstream artefact of the llmRouter bulk-text consumer. STUB branding
// (SUB_BRAND_ACCENT.travelstall + Helvetica) pending Q22 brand assets.
function renderTravelStallPersonalisedPdf(payload) {
  const sub = "travelstall";
  const brandLabel = SUB_BRAND_LABEL[sub] || "Travel Stall";
  const accent = SUB_BRAND_ACCENT[sub] || "#122647";
  const contact = payload?.contact || {};
  const destinations = Array.isArray(payload?.destinations) ? payload.destinations.slice(0, 5) : [];
  const budget = payload?.budget != null ? Number(payload.budget) : null;
  const durationDays = payload?.durationDays != null ? Number(payload.durationDays) : null;
  const diagnostic = payload?.diagnostic || null;
  const proseText = String(payload?.proseText || "");
  const generatedAt = payload?.generatedAt || new Date().toISOString();

  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const bufPromise = streamToBuffer(doc);

  // Brand header band — STUB: placeholder until Q22 brand assets land.
  doc.rect(0, 0, doc.page.width, 60).fill(accent);
  doc.font("Helvetica-Bold").fontSize(18).fillColor("#fff")
    .text(brandLabel, 50, 22, { align: "left" });
  doc.fillColor("#fff").fontSize(10).text("Personalised Recommendations", 50, 42, { align: "left" });
  doc.fillColor("#111").moveDown(2);

  // Customer block
  doc.font("Helvetica-Bold").fontSize(13).fillColor("#111").text(contact?.name || "Customer", 50, 90);
  const metaLine = [contact?.email, contact?.phone].filter(Boolean).join("  •  ");
  if (metaLine) doc.font("Helvetica").fontSize(10).fillColor("#555").text(metaLine);
  doc.moveDown(0.4);

  // Trip parameters band
  const params = [];
  if (durationDays) params.push(`${durationDays} day${durationDays === 1 ? "" : "s"}`);
  if (budget != null) params.push(`Budget: ${formatMoney(budget, "INR")}`);
  if (diagnostic?.recommendedTier) params.push(`Tier: ${diagnostic.recommendedTier}`);
  if (params.length > 0) {
    doc.font("Helvetica").fontSize(10).fillColor("#555").text(params.join("  •  "));
  }
  doc.moveDown(0.6);

  // Personalised prose (LLM output)
  doc.font("Helvetica-Bold").fontSize(12).fillColor("#111").text("Why these destinations");
  doc.moveDown(0.2);
  doc.font("Helvetica").fontSize(10).fillColor("#222").text(
    proseText || "(personalised summary unavailable)",
    { width: doc.page.width - 100, align: "justify" },
  );
  doc.moveDown(0.8);

  // Destination cards
  doc.font("Helvetica-Bold").fontSize(12).fillColor("#111").text("Suggested destinations");
  doc.moveDown(0.4);

  if (destinations.length === 0) {
    doc.font("Helvetica-Oblique").fontSize(10).fillColor("#777")
      .text("(Advisor will populate destinations from your preferences during the next call.)");
  } else {
    const cardWidth = (doc.page.width - 100 - 20) / 2; // 2 cards per row, 20px gutter
    const cardHeight = 110;
    let col = 0;
    let cardY = doc.y;
    for (let i = 0; i < destinations.length; i++) {
      const dest = destinations[i];
      const cardX = 50 + col * (cardWidth + 20);
      // Card border
      doc.rect(cardX, cardY, cardWidth, cardHeight)
        .lineWidth(0.7).strokeColor(accent).stroke();
      // STUB: placeholder image slot — Q22 brand pack supplies real photos
      doc.rect(cardX + 8, cardY + 8, 60, 60).fillAndStroke("#eef1f5", "#cdd3da");
      doc.font("Helvetica").fontSize(7).fillColor("#888")
        .text("photo", cardX + 8, cardY + 32, { width: 60, align: "center" });
      doc.fillColor("#111");
      // Destination name + short prose
      doc.font("Helvetica-Bold").fontSize(11).fillColor("#111")
        .text(dest, cardX + 78, cardY + 12, { width: cardWidth - 86 });
      doc.font("Helvetica").fontSize(9).fillColor("#444")
        .text(
          `Suggested for your ${diagnostic?.classificationLabel || diagnostic?.classification || "family"} profile.`,
          cardX + 78, cardY + 30, { width: cardWidth - 86 },
        );
      // Advance column
      col++;
      if (col >= 2) {
        col = 0;
        cardY += cardHeight + 14;
      }
    }
    doc.y = (col === 0 ? cardY : cardY + cardHeight + 14);
  }

  // Footer — brand strip + generated-at timestamp + STUB marker.
  const footerY = doc.page.height - doc.page.margins.bottom - 32;
  doc.moveTo(50, footerY).lineTo(doc.page.width - 50, footerY).lineWidth(0.5).strokeColor("#bbb").stroke();
  doc.font("Helvetica").fontSize(8).fillColor("#777")
    .text(
      `${brandLabel} — Personalised Recommendations. Generated ${formatDate(generatedAt)}. ` +
        `Branding placeholder — final assets pending.`,
      50, footerY + 8, { width: doc.page.width - 100, align: "center" },
    );

  doc.end();
  return bufPromise;
}

function renderTravelDiagnosticPdf(diagnostic, contact, bank) {
  const sub = diagnostic.subBrand;
  const brandLabel = SUB_BRAND_LABEL[sub] || "Travel CRM";
  const accent = SUB_BRAND_ACCENT[sub] || "#111111";

  let questions = [];
  try {
    const parsed = JSON.parse(bank?.questionsJson || "{}");
    questions = Array.isArray(parsed.questions) ? parsed.questions : [];
  } catch { /* fall through with empty questions */ }
  let answers = {};
  try {
    answers = JSON.parse(diagnostic.answersJson || "{}");
  } catch { /* leave empty */ }

  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const bufPromise = streamToBuffer(doc);

  doc.rect(0, 0, doc.page.width, 60).fill(accent);
  doc.font("Helvetica-Bold").fontSize(18).fillColor("#fff")
    .text(brandLabel, 50, 22, { align: "left" });
  doc.fillColor("#fff").fontSize(10).text("Diagnostic Report", 50, 42, { align: "left" });
  doc.fillColor("#111").moveDown(2);

  doc.font("Helvetica-Bold").fontSize(13).fillColor("#111").text(contact?.name || "Customer", 50, 90);
  const metaLine = [contact?.email, contact?.phone].filter(Boolean).join("  •  ");
  if (metaLine) doc.font("Helvetica").fontSize(10).fillColor("#555").text(metaLine);
  doc.moveDown(0.5);

  doc.font("Helvetica").fontSize(10).fillColor("#555");
  doc.text(`Bank version: v${bank?.version ?? "?"}`);
  doc.text(`Submitted: ${formatDate(diagnostic.createdAt || new Date())}`);
  doc.moveDown();

  doc.rect(50, doc.y, doc.page.width - 100, 70).fillAndStroke("#f4f6f8", accent);
  const resultY = doc.y - 65;
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#555")
    .text("Classification", 60, resultY + 8);
  doc.font("Helvetica-Bold").fontSize(16).fillColor(accent)
    .text(diagnostic.classificationLabel || diagnostic.classification || "—", 60, resultY + 24);
  doc.font("Helvetica").fontSize(10).fillColor("#333")
    .text(`Score: ${diagnostic.score != null ? Number(diagnostic.score).toFixed(2) : "—"}`, 60, resultY + 50);
  if (diagnostic.recommendedTier) {
    doc.text(`Recommended tier: ${diagnostic.recommendedTier}`, 280, resultY + 50);
  }
  doc.fillColor("#111").moveDown(2);

  doc.font("Helvetica-Bold").fontSize(12).fillColor("#111").text("Your answers", { underline: false });
  doc.moveDown(0.3);
  doc.font("Helvetica").fontSize(10).fillColor("#111");

  if (questions.length === 0) {
    doc.fillColor("#777").text("(No question bank snapshot available.)");
  } else {
    questions.forEach((q, idx) => {
      const num = idx + 1;
      const qText = q?.text || `Question ${num}`;
      const ans = resolveAnswerLabel(q, answers[q?.id]);
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#333")
        .text(`${num}. ${qText}`);
      doc.font("Helvetica").fontSize(10).fillColor("#111")
        .text(`   ${ans}`);
      doc.moveDown(0.4);
    });
  }

  const footerY = doc.page.height - doc.page.margins.bottom - 32;
  doc.moveTo(50, footerY).lineTo(doc.page.width - 50, footerY).lineWidth(0.5).strokeColor("#bbb").stroke();
  doc.font("Helvetica").fontSize(8).fillColor("#777")
    .text(
      `Generated by ${brandLabel}. This report is informational; pricing and tier recommendations follow on consultation.`,
      50, footerY + 8, { width: doc.page.width - 100, align: "center" },
    );

  doc.end();
  return bufPromise;
}

// ── Travel CRM — quote PDF (DD-5.6) ─────────────────────────────────
function renderTravelQuotePdf(quote) {
  const q = quote || {};
  const sub = q.subBrand;
  const brandLabel = SUB_BRAND_LABEL[sub] || "Travel CRM";
  const accent = (q.brandKit && q.brandKit.accent) || SUB_BRAND_ACCENT[sub] || "#111111";
  const currency = q.currency || "INR";
  const rawItems = Array.isArray(q.items)
    ? q.items
    : Array.isArray(q.lines)
      ? q.lines
      : [];
  const items = rawItems;
  const taxTreatment = q.taxTreatment === "inclusive" ? "inclusive" : "exclusive";

  function fmt(n) {
    const v = Number(n) || 0;
    if (currency === "INR") return `₹${v.toFixed(2)}`;
    if (currency === "USD") return `$${v.toFixed(2)}`;
    if (currency === "GBP") return `£${v.toFixed(2)}`;
    return `${currency} ${v.toFixed(2)}`;
  }

  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const bufPromise = streamToBuffer(doc);

  doc.rect(0, 0, doc.page.width, 60).fill(accent);
  doc.font("Helvetica-Bold").fontSize(18).fillColor("#fff")
    .text(brandLabel, 50, 22, { align: "left" });
  doc.fillColor("#fff").fontSize(10).text("Quote", 50, 42, { align: "left" });

  if (q.brandKit && q.brandKit.logoUrl) {
    doc.font("Helvetica").fontSize(8).fillColor("#fff")
      .text(`[Logo: ${q.brandKit.logoUrl}]`, doc.page.width - 250, 22, { width: 200, align: "right" });
  }
  doc.fillColor("#111").moveDown(2);

  const metaTop = 80;
  doc.font("Helvetica-Bold").fontSize(18).fillColor("#111")
    .text("QUOTE", 380, metaTop, { width: 165, align: "right" });
  doc.font("Helvetica").fontSize(10).fillColor("#333");
  doc.text(`Quote #: ${q.quoteNumber || q.id || "—"}`, 380, metaTop + 26, { width: 165, align: "right" });
  doc.text(`Issued: ${formatDate(q.issuedDate || new Date())}`, 380, metaTop + 40, { width: 165, align: "right" });
  doc.text(`Valid until: ${formatDate(q.validUntil)}`, 380, metaTop + 54, { width: 165, align: "right" });
  doc.text(`Status: ${q.status || "Draft"}`, 380, metaTop + 68, { width: 165, align: "right" });

  doc.font("Helvetica-Bold").fontSize(11).fillColor("#111").text("Quote For", 50, metaTop);
  doc.font("Helvetica").fontSize(10).fillColor("#222");
  doc.text(q.customerName || "—", 50, metaTop + 18);
  if (q.customerEmail) doc.text(q.customerEmail, 50, doc.y);
  if (q.customerPhone) doc.text(q.customerPhone, 50, doc.y);

  doc.y = Math.max(doc.y, metaTop + 100);
  doc.moveDown(0.6);
  const divY = doc.y;
  doc.moveTo(50, divY).lineTo(545, divY).lineWidth(0.7).strokeColor(accent).stroke();
  doc.moveDown(0.8);

  const isInterstate = !!q.placeOfSupplyInterstate;
  const isGstAware = items.some(
    (it) =>
      (typeof it.lineType === "string" && it.lineType.length > 0) ||
      Number(it.gstPercent) > 0,
  );
  const tableTop = doc.y;
  const colX = isGstAware
    ? {
      desc: 50,
      sac: 270,
      gst: 315,
      qty: 380,
      unit: 415,
      total: 475,
    }
    : {
      desc: 50,
      qty: 340,
      unit: 400,
      total: 470,
    };
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#333");
  doc.text("Description", colX.desc, tableTop);
  if (isGstAware) {
    doc.text("SAC", colX.sac, tableTop, { width: 40, align: "left" });
    doc.text("Tax", colX.gst, tableTop, { width: 60, align: "right" });
    doc.text("Qty", colX.qty, tableTop, { width: 30, align: "right" });
    doc.text("Unit", colX.unit, tableTop, { width: 55, align: "right" });
    doc.text("Total", colX.total, tableTop, { width: 70, align: "right" });
  } else {
    doc.text("Qty", colX.qty, tableTop, { width: 50, align: "right" });
    doc.text("Unit", colX.unit, tableTop, { width: 60, align: "right" });
    doc.text("Total", colX.total, tableTop, { width: 75, align: "right" });
  }
  doc.moveTo(50, tableTop + 14).lineTo(545, tableTop + 14).lineWidth(0.5).strokeColor("#bbb").stroke();

  let rowY = tableTop + 22;
  doc.font("Helvetica").fontSize(10).fillColor("#222");
  let computedSubtotal = 0;
  const normalisedLines = [];
  if (items.length === 0) {
    doc.fillColor("#777").text("(No line items on this quote yet.)", colX.desc, rowY, { width: 480 });
    rowY += 18;
  } else {
    for (const it of items) {
      if (rowY > 700) { doc.addPage(); rowY = 60; }
      const qty = Number(it.qty != null ? it.qty : it.quantity) || 0;
      const unit = Number(it.unitPrice) || 0;
      const total = it.totalPrice != null
        ? Number(it.totalPrice)
        : it.amount != null
          ? Number(it.amount)
          : qty * unit;
      computedSubtotal += total;
      if (isGstAware) {
        const sacCode = hsnSacMapper.sacForLineType(it.lineType);
        const gstPct = Number(it.gstPercent) || 0;
        const taxable = it.taxableValue != null
          ? Number(it.taxableValue)
          : total;
        const split = gstCalculation.computeGstSplit({
          taxableAmount: taxable,
          gstPercent: gstPct,
          isInterstate,
        });
        let gstCell = "—";
        if (gstPct > 0) {
          if (isInterstate) {
            gstCell = `${gstPct}% IGST ${fmt(split.igst)}`;
          } else {
            const half = gstPct / 2;
            const halfStr = Number.isInteger(half) ? String(half) : half.toFixed(1);
            gstCell = `${halfStr}+${halfStr}% CGST/SGST ${fmt(split.cgst + split.sgst)}`;
          }
        }
        normalisedLines.push({
          lineType: it.lineType,
          taxableValue: taxable,
          gstPercent: gstPct,
        });
        doc.fillColor("#222");
        doc.text(String(it.description || "—"), colX.desc, rowY, { width: 210 });
        doc.text(sacCode == null ? "—" : sacCode, colX.sac, rowY, { width: 40, align: "left" });
        doc.fontSize(8);
        doc.text(gstCell, colX.gst, rowY, { width: 60, align: "right" });
        doc.fontSize(10);
        doc.text(qty === 0 ? "—" : String(qty), colX.qty, rowY, { width: 30, align: "right" });
        doc.text(unit === 0 ? "—" : fmt(unit), colX.unit, rowY, { width: 55, align: "right" });
        doc.text(fmt(total), colX.total, rowY, { width: 70, align: "right" });
      } else {
        doc.fillColor("#222");
        doc.text(String(it.description || "—"), colX.desc, rowY, { width: 280 });
        doc.text(qty === 0 ? "—" : String(qty), colX.qty, rowY, { width: 50, align: "right" });
        doc.text(unit === 0 ? "—" : fmt(unit), colX.unit, rowY, { width: 60, align: "right" });
        doc.text(fmt(total), colX.total, rowY, { width: 75, align: "right" });
      }
      rowY += 20;
    }
  }
  doc.y = rowY + 4;

  const subtotal = q.subtotal != null ? Number(q.subtotal) : computedSubtotal;
  const gstAmount = q.gstAmount != null ? Number(q.gstAmount) : 0;
  const grandTotal = q.totalAmount != null
    ? Number(q.totalAmount)
    : (taxTreatment === "exclusive" ? subtotal + gstAmount : subtotal);

  doc.moveDown(0.5);
  const totalsY = doc.y;
  doc.moveTo(350, totalsY).lineTo(545, totalsY).lineWidth(0.5).strokeColor("#bbb").stroke();
  let ty = totalsY + 8;
  doc.font("Helvetica").fontSize(10).fillColor("#333");
  doc.text("Subtotal", 350, ty, { width: 95, align: "right" });
  doc.text(fmt(subtotal), 450, ty, { width: 95, align: "right" });
  ty += 16;

  if (taxTreatment === "exclusive") {
    doc.text("GST", 350, ty, { width: 95, align: "right" });
    doc.text(fmt(gstAmount), 450, ty, { width: 95, align: "right" });
    ty += 16;
  }

  doc.moveTo(350, ty).lineTo(545, ty).lineWidth(0.5).strokeColor("#bbb").stroke();
  ty += 6;
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#111");
  doc.text("Total", 350, ty, { width: 95, align: "right" });
  doc.text(fmt(grandTotal), 450, ty, { width: 95, align: "right" });
  ty += 18;

  if (taxTreatment === "inclusive") {
    doc.font("Helvetica-Oblique").fontSize(9).fillColor("#666");
    doc.text("Includes GST", 350, ty, { width: 195, align: "right" });
    ty += 14;
  }
  doc.y = ty + 8;

  const hsnSummary = hsnSacMapper.groupLinesBySac(normalisedLines);
  if (hsnSummary.length > 0) {
    if (doc.y > 680) { doc.addPage(); }
    doc.moveDown(0.8);
    const summaryTop = doc.y;
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#333")
      .text("HSN/SAC Summary", 50, summaryTop);
    let sy = summaryTop + 16;
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#555");
    doc.text("SAC", 50, sy, { width: 50, align: "left" });
    doc.text("Description", 105, sy, { width: 230, align: "left" });
    doc.text("Rate", 340, sy, { width: 55, align: "right" });
    doc.text("Taxable Value", 400, sy, { width: 95, align: "right" });
    doc.text("Lines", 500, sy, { width: 45, align: "right" });
    sy += 12;
    doc.moveTo(50, sy).lineTo(545, sy).lineWidth(0.4).strokeColor("#bbb").stroke();
    sy += 4;
    doc.font("Helvetica").fontSize(9).fillColor("#222");
    for (const row of hsnSummary) {
      if (sy > 720) { doc.addPage(); sy = 60; }
      doc.text(row.sacCode, 50, sy, { width: 50, align: "left" });
      doc.text(row.description, 105, sy, { width: 230, align: "left" });
      doc.text(
        `${row.gstPercent}%`,
        340, sy, { width: 55, align: "right" },
      );
      doc.text(fmt(row.taxableValue), 400, sy, { width: 95, align: "right" });
      doc.text(String(row.count), 500, sy, { width: 45, align: "right" });
      doc.fillColor("#777").fontSize(7);
      doc.text(`${row.sacCode} / ${row.gstPercent}%`, 105, sy + 9, { width: 230, align: "left" });
      doc.fillColor("#222").fontSize(9);
      sy += 18;
    }
    doc.y = sy + 4;
  }

  doc.moveDown(1);
  const validityY = doc.y;
  doc.font("Helvetica").fontSize(10).fillColor("#333")
    .text(`Valid until ${formatDate(q.validUntil)}`, 50, validityY, { width: 495 });
  doc.moveDown(2.5);

  const sigY = Math.max(doc.y, 700);
  doc.moveTo(50, sigY).lineTo(250, sigY).lineWidth(0.5).strokeColor("#444").stroke();
  doc.font("Helvetica").fontSize(9).fillColor("#555")
    .text("Authorised signature", 50, sigY + 4);

  const footerY = doc.page.height - doc.page.margins.bottom - 24;
  doc.moveTo(50, footerY).lineTo(doc.page.width - 50, footerY).lineWidth(0.4).strokeColor("#bbb").stroke();
  doc.font("Helvetica").fontSize(8).fillColor("#777").text(
    `${brandLabel} — Quote #${q.quoteNumber || q.id || "?"}. ` +
      "Pricing valid until the date shown; subject to availability at booking.",
    50, footerY + 6, { width: doc.page.width - 100, align: "center" },
  );

  doc.end();
  return bufPromise;
}

const generateTravelQuotePdf = renderTravelQuotePdf;

// ── Travel CRM — invoice PDF (Arc 2 #901 slice 2) ───────────────────

function docTypeHeader(docType) {
  switch (docType) {
    case "Proforma": return "PROFORMA INVOICE";
    case "CreditNote": return "CREDIT NOTE";
    case "DebitNote": return "DEBIT NOTE";
    case "TravelVoucher": return "TRAVEL VOUCHER";
    case "TaxInvoice":
    default:
      return "TAX INVOICE";
  }
}

function docTypeFooter(docType) {
  switch (docType) {
    case "Proforma":
      return "This is a Proforma Invoice — not a tax invoice. No GST credit allowed.";
    case "CreditNote":
      return "Credit Note — reduces customer payable";
    case "DebitNote":
      return "Debit Note — increases customer payable";
    case "TravelVoucher":
      return "Voucher — non-billable; document of service entitlement";
    case "TaxInvoice":
    default:
      return "This is a Tax Invoice as per GST Rules";
  }
}

const VOUCHER_FULFILLMENT_TYPES = new Set([
  "per_pax",
  "per_room",
  "per_night",
  "per_trip",
  "addon",
  "other",
]);

function voucherSubtypeForLine(lineType) {
  switch (lineType) {
    case "per_night":
    case "per_room":
      return "Hotel";
    case "per_pax":
      return "Activity";
    case "per_trip":
      return "Transfer";
    case "addon":
      return "Add-on";
    case "other":
      return "Service";
    default:
      return String(lineType || "Service");
  }
}

function formatVoucherServiceRange(startDate, endDate) {
  const start = startDate ? formatDate(startDate) : null;
  const end = endDate ? formatDate(endDate) : null;
  if (start && end) {
    if (start === end) return start;
    return `${start} → ${end}`;
  }
  return start || end || "—";
}

function extractTravellerListFromInvoice(invoice, lines) {
  if (invoice && invoice.travellerList) {
    if (Array.isArray(invoice.travellerList)) {
      const cleaned = invoice.travellerList
        .map((n) => String(n).trim())
        .filter(Boolean);
      if (cleaned.length > 0) return cleaned.join(", ");
    } else if (typeof invoice.travellerList === "string") {
      const s = invoice.travellerList.trim();
      if (s) return s;
    }
  }
  if (Array.isArray(lines)) {
    for (const line of lines) {
      if (!line || !line.notes) continue;
      const m = String(line.notes).match(/Travellers?:\s*(.+)/i);
      if (m && m[1].trim()) return m[1].trim();
    }
  }
  return "—";
}

function renderTravelInvoicePdf(opts) {
  const o = opts || {};
  const invoice = o.invoice || {};
  const lines = Array.isArray(o.lines)
    ? o.lines
    : Array.isArray(invoice.lines)
      ? invoice.lines
      : [];
  const tenant = o.tenant || null;

  const sub = invoice.subBrand;
  const brandLabel = SUB_BRAND_LABEL[sub] || "Travel CRM";
  const accent = SUB_BRAND_ACCENT[sub] || "#111111";
  const currency = invoice.currency || "INR";
  const docType = invoice.docType || "TaxInvoice";
  const docHeaderTitle = docTypeHeader(docType);
  const docFooterText = docTypeFooter(docType);

  function fmt(n) {
    const v = Number(n) || 0;
    if (currency === "INR") return `₹${v.toFixed(2)}`;
    if (currency === "USD") return `$${v.toFixed(2)}`;
    if (currency === "GBP") return `£${v.toFixed(2)}`;
    return `${currency} ${v.toFixed(2)}`;
  }

  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const bufPromise = streamToBuffer(doc);

  doc.rect(0, 0, doc.page.width, 60).fill(accent);
  doc.font("Helvetica-Bold").fontSize(18).fillColor("#fff")
    .text(brandLabel, 50, 22, { align: "left" });
  const bandSubLabel = docHeaderTitle
    .toLowerCase()
    .replace(/(^|\s)\S/g, (c) => c.toUpperCase());
  doc.fillColor("#fff").fontSize(10).text(bandSubLabel, 50, 42, { align: "left" });
  doc.fillColor("#111").moveDown(2);

  const metaTop = 80;
  doc.font("Helvetica-Bold").fontSize(18).fillColor("#111")
    .text(docHeaderTitle, 380, metaTop, { width: 165, align: "right" });
  doc.font("Helvetica").fontSize(10).fillColor("#333");
  doc.text(
    `Invoice #: ${invoice.invoiceNum || invoice.id || "—"}`,
    380, metaTop + 26, { width: 165, align: "right" },
  );
  doc.text(
    `Issued: ${formatDate(invoice.issuedDate || invoice.createdAt || new Date())}`,
    380, metaTop + 40, { width: 165, align: "right" },
  );
  doc.text(
    `Due: ${formatDate(invoice.dueDate)}`,
    380, metaTop + 54, { width: 165, align: "right" },
  );
  doc.text(
    `Status: ${invoice.status || "Draft"}`,
    380, metaTop + 68, { width: 165, align: "right" },
  );

  doc.font("Helvetica-Bold").fontSize(11).fillColor("#111").text("Bill To", 50, metaTop);
  doc.font("Helvetica").fontSize(10).fillColor("#222");
  doc.text(invoice.contactName || "—", 50, metaTop + 18);
  if (invoice.contactEmail) doc.text(invoice.contactEmail, 50, doc.y);
  if (invoice.contactPhone) doc.text(invoice.contactPhone, 50, doc.y);

  doc.y = Math.max(doc.y, metaTop + 100);
  doc.moveDown(0.6);
  const divY = doc.y;
  doc.moveTo(50, divY).lineTo(545, divY).lineWidth(0.7).strokeColor(accent).stroke();
  doc.moveDown(0.8);

  if (docType === "TravelVoucher") {
    const voucherLines = (lines || []).filter(
      (l) => l && VOUCHER_FULFILLMENT_TYPES.has(l.lineType || "other"),
    );
    const travellers = extractTravellerListFromInvoice(invoice, lines);

    const vTop = doc.y;
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#111")
      .text("Voucher Details", 50, vTop);
    let vy = vTop + 16;

    doc.font("Helvetica-Bold").fontSize(9).fillColor("#555")
      .text("Travellers:", 50, vy, { width: 65, continued: false });
    doc.font("Helvetica").fontSize(9).fillColor("#222")
      .text(travellers, 115, vy, { width: 430 });
    vy = Math.max(vy + 14, doc.y + 4);

    if (voucherLines.length === 0) {
      doc.font("Helvetica-Oblique").fontSize(9).fillColor("#777")
        .text(
          "(No fulfillment lines yet — add Hotel / Transfer / Activity lines to populate this block.)",
          50, vy, { width: 495 },
        );
      vy += 16;
    } else {
      const colVX = { subtype: 50, desc: 130, conf: 305, date: 405 };
      doc.font("Helvetica-Bold").fontSize(9).fillColor("#555");
      doc.text("Subtype", colVX.subtype, vy, { width: 70, align: "left" });
      doc.text("Description", colVX.desc, vy, { width: 165, align: "left" });
      doc.text("Supplier Conf #", colVX.conf, vy, { width: 90, align: "left" });
      doc.text("Service Date", colVX.date, vy, { width: 140, align: "left" });
      vy += 12;
      doc.moveTo(50, vy).lineTo(545, vy).lineWidth(0.4).strokeColor("#bbb").stroke();
      vy += 4;
      doc.font("Helvetica").fontSize(9).fillColor("#222");
      for (const line of voucherLines) {
        if (vy > 720) {
          doc.addPage();
          vy = 60;
        }
        const subtype = voucherSubtypeForLine(line.lineType);
        const confNum = line.bookingRef || line.pnr || "—";
        const range = formatVoucherServiceRange(
          line.serviceStartDate,
          line.serviceEndDate,
        );
        doc.text(subtype, colVX.subtype, vy, { width: 70, align: "left" });
        doc.text(String(line.description || "—"), colVX.desc, vy, {
          width: 165,
          align: "left",
        });
        doc.text(String(confNum), colVX.conf, vy, { width: 90, align: "left" });
        doc.text(range, colVX.date, vy, { width: 140, align: "left" });
        vy += 16;
      }
    }
    doc.y = vy + 6;
    doc.moveTo(50, doc.y).lineTo(545, doc.y).lineWidth(0.4).strokeColor("#ddd").stroke();
    doc.moveDown(0.6);
  }

  const isInterstate = !!invoice.placeOfSupplyInterstate;
  const tableTop = doc.y;
  const colX = {
    desc: 50,
    sac: 270,
    gst: 315,
    qty: 380,
    unit: 415,
    total: 475,
  };
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#333");
  doc.text("Description", colX.desc, tableTop);
  doc.text("SAC", colX.sac, tableTop, { width: 40, align: "left" });
  doc.text("GST", colX.gst, tableTop, { width: 60, align: "right" });
  doc.text("Qty", colX.qty, tableTop, { width: 30, align: "right" });
  doc.text("Unit", colX.unit, tableTop, { width: 55, align: "right" });
  doc.text("Amount", colX.total, tableTop, { width: 70, align: "right" });
  doc.moveTo(50, tableTop + 14).lineTo(545, tableTop + 14).lineWidth(0.5).strokeColor("#bbb").stroke();

  let rowY = tableTop + 22;
  doc.font("Helvetica").fontSize(10).fillColor("#222");
  let computedSubtotal = 0;
  if (lines.length === 0) {
    doc.fillColor("#777").text(
      "(No line items on this invoice yet.)",
      colX.desc, rowY, { width: 480 },
    );
    rowY += 18;
  } else {
    for (const line of lines) {
      if (rowY > 700) { doc.addPage(); rowY = 60; }
      const qty = Number(line.quantity) || 0;
      const unit = Number(line.unitPrice) || 0;
      const amount = line.amount != null ? Number(line.amount) : qty * unit;
      computedSubtotal += amount;
      const sacCode = hsnSacMapper.sacForLineType(line.lineType);
      const gstPct = Number(line.gstPercent) || 0;
      const taxable = line.taxableValue != null
        ? Number(line.taxableValue)
        : amount;
      const split = gstCalculation.computeGstSplit({
        taxableAmount: taxable,
        gstPercent: gstPct,
        isInterstate,
      });
      let gstCell = "—";
      if (gstPct > 0) {
        if (isInterstate) {
          gstCell = `${gstPct}% IGST ${fmt(split.igst)}`;
        } else {
          const half = gstPct / 2;
          const halfStr = Number.isInteger(half) ? String(half) : half.toFixed(1);
          gstCell = `${halfStr}+${halfStr}% CGST/SGST ${fmt(split.cgst + split.sgst)}`;
        }
      }
      doc.fillColor("#222");
      doc.text(String(line.description || "—"), colX.desc, rowY, { width: 210 });
      doc.text(sacCode == null ? "—" : sacCode, colX.sac, rowY, { width: 40, align: "left" });
      doc.fontSize(8);
      doc.text(gstCell, colX.gst, rowY, { width: 60, align: "right" });
      doc.fontSize(10);
      doc.text(qty === 0 ? "—" : String(qty), colX.qty, rowY, { width: 30, align: "right" });
      doc.text(unit === 0 ? "—" : fmt(unit), colX.unit, rowY, { width: 55, align: "right" });
      doc.text(fmt(amount), colX.total, rowY, { width: 70, align: "right" });
      rowY += 20;
    }
  }
  doc.y = rowY + 4;

  const grandTotal = invoice.totalAmount != null
    ? Number(invoice.totalAmount)
    : computedSubtotal;

  doc.moveDown(0.5);
  const totalsY = doc.y;
  doc.moveTo(350, totalsY).lineTo(545, totalsY).lineWidth(0.5).strokeColor("#bbb").stroke();
  let ty = totalsY + 8;
  doc.font("Helvetica").fontSize(10).fillColor("#333");
  doc.text("Subtotal", 350, ty, { width: 95, align: "right" });
  doc.text(fmt(computedSubtotal), 450, ty, { width: 95, align: "right" });
  ty += 16;

  doc.moveTo(350, ty).lineTo(545, ty).lineWidth(0.5).strokeColor("#bbb").stroke();
  ty += 6;
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#111");
  doc.text("Total Due", 350, ty, { width: 95, align: "right" });
  doc.text(fmt(grandTotal), 450, ty, { width: 95, align: "right" });
  ty += 18;
  doc.y = ty + 8;

  const hsnSummary = hsnSacMapper.groupLinesBySac(lines);
  if (hsnSummary.length > 0) {
    if (doc.y > 680) { doc.addPage(); }
    doc.moveDown(0.8);
    const summaryTop = doc.y;
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#333")
      .text("HSN/SAC Summary", 50, summaryTop);
    let sy = summaryTop + 16;
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#555");
    doc.text("SAC", 50, sy, { width: 50, align: "left" });
    doc.text("Description", 105, sy, { width: 230, align: "left" });
    doc.text("Rate", 340, sy, { width: 55, align: "right" });
    doc.text("Taxable Value", 400, sy, { width: 95, align: "right" });
    doc.text("Lines", 500, sy, { width: 45, align: "right" });
    sy += 12;
    doc.moveTo(50, sy).lineTo(545, sy).lineWidth(0.4).strokeColor("#bbb").stroke();
    sy += 4;
    doc.font("Helvetica").fontSize(9).fillColor("#222");
    for (const row of hsnSummary) {
      if (sy > 720) { doc.addPage(); sy = 60; }
      doc.text(row.sacCode, 50, sy, { width: 50, align: "left" });
      doc.text(row.description, 105, sy, { width: 230, align: "left" });
      doc.text(
        `${row.gstPercent}%`,
        340, sy, { width: 55, align: "right" },
      );
      doc.text(fmt(row.taxableValue), 400, sy, { width: 95, align: "right" });
      doc.text(String(row.count), 500, sy, { width: 45, align: "right" });
      doc.fillColor("#777").fontSize(7);
      doc.text(`${row.sacCode} / ${row.gstPercent}%`, 105, sy + 9, { width: 230, align: "left" });
      doc.fillColor("#222").fontSize(9);
      sy += 18;
    }
    doc.y = sy + 4;
  }

  doc.moveDown(1);
  const termsY = doc.y;
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#333").text("Payment Terms", 50, termsY);
  doc.font("Helvetica").fontSize(9).fillColor("#555").text(
    invoice.dueDate
      ? `Payment is due by ${formatDate(invoice.dueDate)}. Please quote invoice number ${invoice.invoiceNum || invoice.id || ""} on any payment or correspondence.`
      : "Please quote the invoice number on any payment or correspondence.",
    50, termsY + 14, { width: 495 },
  );

  doc.moveDown(1);
  doc.font("Helvetica-Oblique").fontSize(9).fillColor("#444").text(
    docFooterText,
    50, doc.y, { width: 495 },
  );

  const footerY = doc.page.height - doc.page.margins.bottom - 24;
  doc.moveTo(50, footerY).lineTo(doc.page.width - 50, footerY).lineWidth(0.4).strokeColor("#bbb").stroke();
  const tenantLine = tenant && tenant.name ? `${tenant.name} — ` : "";
  doc.font("Helvetica").fontSize(8).fillColor("#777").text(
    `${tenantLine}${brandLabel} — ${docHeaderTitle} #${invoice.invoiceNum || invoice.id || "?"}.`,
    50, footerY + 6, { width: doc.page.width - 100, align: "center" },
  );

  doc.end();
  return bufPromise;
}

const generateTravelInvoicePdf = renderTravelInvoicePdf;

module.exports = {
  renderPrescriptionPdf,
  renderConsentPdf,
  renderBrandedInvoicePdf,
  renderPatientSummaryPdf,
  generatePosReceiptPdf,
  // Exported for vitest coverage of the customer-facing zylu mask.
  scrubZyluText,
  scrubZyluSource,
  // Exported so route + tests can share the same visit-photo URL parser.
  parsePhotoUrls,
  // Travel CRM exports — ported from main worktree to satisfy
  // travel_invoices / travel_quotes route handlers and the
  // slice-2/8/13/18 gate specs (#900/#901/#902).
  renderTravelDiagnosticPdf,
  renderTravelItineraryPdf,
  renderTravelStallPersonalisedPdf,
  renderTravelQuotePdf,
  generateTravelQuotePdf,
  renderTravelInvoicePdf,
  generateTravelInvoicePdf,
  voucherSubtypeForLine,
  formatVoucherServiceRange,
  extractTravellerListFromInvoice,
};
