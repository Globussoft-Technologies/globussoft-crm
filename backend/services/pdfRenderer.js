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

async function renderPrescriptionPdf(prescription, patient, clinic, doctor) {
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

  // Drug table — #278: Rx label uses the unicode ℞ glyph (U+211E). pdfkit's
  // built-in Helvetica covers the BMP enough for this symbol on every
  // platform we target; if a future custom font drops it, fall back to "Rx".
  doc.font("Helvetica-Bold").fontSize(13).fillColor("#111").text("℞");
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

  // Signature line — #278: when the Rx has a tracked prescriber, name them
  // under the line so the document reads as a proper doctor-attributed Rx.
  const sigY = Math.max(doc.y + 40, 700);
  doc.moveTo(360, sigY).lineTo(545, sigY).lineWidth(0.5).strokeColor("#444").stroke();
  doc.font("Helvetica").fontSize(10).fillColor("#333").text("Doctor's signature", 360, sigY + 4);
  if (doctor?.name) {
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#222").text(doctor.name, 360, sigY + 18);
  }

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

// ── 2b. Full Patient Report PDF ────────────────────────────────────
//
// #840: clinicians + admins need a single consolidated patient record
// (visits + Rx + consents + treatment plans + photos + inventory consumed)
// as one PDF for hand-offs to referring providers, patient archives, and
// medico-legal documentation. Pre-this-fix the operator had to download
// each section individually and manually staple them together.
//
// Shape mirrors renderPrescriptionPdf / renderConsentPdf — same clinic
// header + IST-locale date formatting + Helvetica typography so the
// consolidated report visually matches the per-section docs operators are
// already used to handing over.
//
// Caller responsibilities (in routes/wellness.js):
//   - Tenant + role scoping (PHI gate)
//   - Loading patient + all relations + consumptions (consumptions live on
//     Visit, not Patient — caller flattens before passing).
//   - Embedding signature images inline via consent.signatureSvg (data URL).
//   - Writing the PATIENT_FULL_REPORT_DOWNLOAD audit row.
//
// `payload` shape:
//   {
//     patient: { id, name, phone, email, dob, gender, bloodGroup, allergies, source, createdAt, gst, anniversary },
//     visits: [{ visitDate, status, service:{name,category}, doctor:{name}, notes, amountCharged }],
//     prescriptions: [{ createdAt, drugs (string|array), instructions, doctor:{name} }],
//     consents: [{ templateName, signedAt, service:{name}, signatureSvg }],
//     treatmentPlans: [{ name, totalSessions, completedSessions, status, startedAt, nextDueAt, totalPrice, service:{name} }],
//     photos: [{ visitDate, before:[url], after:[url] }],   // optional
//     consumptions: [{ visitDate, productName, qty, unitCost }],
//     operator: { name, email },
//     generatedAt: Date
//   }
async function renderFullPatientReportPdf(payload, clinic) {
  const {
    patient = {},
    visits = [],
    prescriptions = [],
    consents = [],
    treatmentPlans = [],
    photos = [],
    consumptions = [],
    operator = null,
    generatedAt = new Date(),
  } = payload || {};

  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const bufPromise = streamToBuffer(doc);

  // ── Header ───────────────────────────────────────────────────────
  drawClinicHeader(doc, clinic);

  doc.font("Helvetica-Bold").fontSize(16).fillColor("#111")
    .text("Patient Record — Consolidated Report", { align: "center" });
  doc.moveDown(0.4);
  doc.font("Helvetica").fontSize(9).fillColor("#666")
    .text(`Generated ${formatDate(generatedAt)}${operator?.name ? ` by ${operator.name}` : ""}`, { align: "center" });
  doc.moveDown(0.8);

  // ── Patient profile block ────────────────────────────────────────
  const age = computeAge(patient.dob);
  doc.font("Helvetica-Bold").fontSize(12).fillColor("#111").text("Patient Profile");
  doc.moveDown(0.3);
  doc.font("Helvetica").fontSize(10).fillColor("#222");
  const left = doc.page.margins.left;
  const colWidth = (doc.page.width - left - doc.page.margins.right) / 2;
  const pTop = doc.y;
  doc.text(`Name: ${patient.name || "—"}`, left, pTop, { width: colWidth });
  doc.text(`Phone: ${patient.phone || "—"}`, left, doc.y, { width: colWidth });
  doc.text(`Email: ${patient.email || "—"}`, left, doc.y, { width: colWidth });
  doc.text(`DOB: ${formatDate(patient.dob)} (${age})`, left, doc.y, { width: colWidth });
  const leftEndY = doc.y;
  // Right column
  doc.text(`Gender: ${patient.gender || "—"}`, left + colWidth, pTop, { width: colWidth });
  doc.text(`Blood group: ${patient.bloodGroup || "—"}`, left + colWidth, doc.y, { width: colWidth });
  doc.text(`Source: ${patient.source || "—"}`, left + colWidth, doc.y, { width: colWidth });
  doc.text(`Registered: ${formatDate(patient.createdAt)}`, left + colWidth, doc.y, { width: colWidth });
  doc.y = Math.max(leftEndY, doc.y);
  if (patient.allergies) {
    doc.moveDown(0.3);
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#a33").text("Allergies:", { continued: true });
    doc.font("Helvetica").fillColor("#222").text(` ${patient.allergies}`);
  }
  doc.moveDown(0.8);

  // Helper — section title renderer with page-break awareness.
  function sectionTitle(label) {
    if (doc.y > 720) doc.addPage();
    doc.moveDown(0.3);
    doc.font("Helvetica-Bold").fontSize(12).fillColor("#111").text(label);
    doc.moveTo(left, doc.y + 2)
      .lineTo(doc.page.width - doc.page.margins.right, doc.y + 2)
      .lineWidth(0.5).strokeColor("#bbb").stroke();
    doc.moveDown(0.4);
    doc.fillColor("#222");
  }

  function ensureRoom(neededLines = 4) {
    // Each "line" ≈ 14pt; bail-out at ~720 for A4 margin=50.
    if (doc.y + neededLines * 14 > 760) {
      doc.addPage();
    }
  }

  // ── Section 1: Visits ────────────────────────────────────────────
  sectionTitle(`Visits (${visits.length})`);
  if (visits.length === 0) {
    doc.font("Helvetica-Oblique").fontSize(9).fillColor("#777").text("(no visits on file)");
  } else {
    doc.font("Helvetica").fontSize(9).fillColor("#222");
    for (const v of visits) {
      ensureRoom(3);
      const head = `${formatDate(v.visitDate)} — ${v.service?.name || "Consultation"}${v.status ? ` [${v.status}]` : ""}`;
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#111").text(head);
      doc.font("Helvetica").fontSize(9).fillColor("#444");
      const sub = [];
      if (v.doctor?.name) sub.push(`Doctor: ${v.doctor.name}`);
      if (v.amountCharged != null) sub.push(`Charged: ${formatMoney(v.amountCharged)}`);
      if (sub.length) doc.text(sub.join("  ·  "));
      if (v.notes) doc.fillColor("#222").text(v.notes, { width: 495 });
      doc.moveDown(0.4);
    }
  }

  // ── Section 2: Prescriptions ─────────────────────────────────────
  sectionTitle(`Prescriptions (${prescriptions.length})`);
  if (prescriptions.length === 0) {
    doc.font("Helvetica-Oblique").fontSize(9).fillColor("#777").text("(no prescriptions on file)");
  } else {
    for (const rx of prescriptions) {
      ensureRoom(4);
      const drugs = parseDrugs(rx.drugs);
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#111").text(
        `${formatDate(rx.createdAt)}${rx.doctor?.name ? ` — ${rx.doctor.name}` : ""}`
      );
      doc.font("Helvetica").fontSize(9).fillColor("#222");
      if (drugs.length === 0) {
        doc.fillColor("#777").text("(no medications listed)", { indent: 12 });
      } else {
        for (const d of drugs) {
          const line = `  • ${d.name || d.drug || "—"} — ${d.dosage || "—"}, ${d.frequency || "—"}, ${d.duration || "—"}`;
          doc.fillColor("#222").text(line, { width: 495 });
        }
      }
      if (rx.instructions) {
        doc.font("Helvetica-Oblique").fontSize(9).fillColor("#444")
          .text(`Instructions: ${rx.instructions}`, { width: 495, indent: 12 });
      }
      doc.moveDown(0.4);
    }
  }

  // ── Section 3: Consents ──────────────────────────────────────────
  sectionTitle(`Consent records (${consents.length})`);
  if (consents.length === 0) {
    doc.font("Helvetica-Oblique").fontSize(9).fillColor("#777").text("(no consents on file)");
  } else {
    for (const c of consents) {
      ensureRoom(5);
      const label = `${formatDate(c.signedAt)} — ${(c.templateName || "general").replace(/-/g, " ")}`;
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#111").text(label);
      doc.font("Helvetica").fontSize(9).fillColor("#444");
      if (c.service?.name) doc.text(`Service: ${c.service.name}`);
      // Inline signature image if a data-URL is available.
      if (c.signatureSvg && typeof c.signatureSvg === "string") {
        const m = c.signatureSvg.match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/i);
        if (m) {
          try {
            const buf = Buffer.from(m[2], "base64");
            ensureRoom(4);
            doc.image(buf, left + 12, doc.y + 2, { fit: [140, 50] });
            doc.moveDown(3.5);
          } catch {
            // ignore — corrupt signature payload
          }
        }
      }
      doc.moveDown(0.3);
    }
  }

  // ── Section 4: Treatment Plans ───────────────────────────────────
  sectionTitle(`Treatment plans (${treatmentPlans.length})`);
  if (treatmentPlans.length === 0) {
    doc.font("Helvetica-Oblique").fontSize(9).fillColor("#777").text("(no treatment plans on file)");
  } else {
    for (const tp of treatmentPlans) {
      ensureRoom(3);
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#111").text(
        `${tp.name || tp.service?.name || "Plan"} [${tp.status || "active"}]`
      );
      doc.font("Helvetica").fontSize(9).fillColor("#444");
      const meta = [];
      meta.push(`Sessions: ${tp.completedSessions ?? 0}/${tp.totalSessions ?? "—"}`);
      if (tp.startedAt) meta.push(`Started ${formatDate(tp.startedAt)}`);
      if (tp.nextDueAt) meta.push(`Next due ${formatDate(tp.nextDueAt)}`);
      if (tp.totalPrice != null) meta.push(`Plan total: ${formatMoney(tp.totalPrice)}`);
      doc.text(meta.join("  ·  "));
      doc.moveDown(0.3);
    }
  }

  // ── Section 5: Photos (URLs/thumbnails) ──────────────────────────
  sectionTitle(`Photos (${photos.reduce((s, p) => s + (p.before?.length || 0) + (p.after?.length || 0), 0)})`);
  if (!photos.length) {
    doc.font("Helvetica-Oblique").fontSize(9).fillColor("#777").text("(no photos on file)");
  } else {
    for (const p of photos) {
      ensureRoom(3);
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#111").text(formatDate(p.visitDate));
      doc.font("Helvetica").fontSize(9).fillColor("#444");
      const beforeUrls = Array.isArray(p.before) ? p.before : [];
      const afterUrls = Array.isArray(p.after) ? p.after : [];
      if (beforeUrls.length) doc.text(`Before: ${beforeUrls.length} image(s)`);
      if (afterUrls.length) doc.text(`After: ${afterUrls.length} image(s)`);
      // URLs listed (PDF reader can click). We do not inline-embed remote
      // images — the PDF renderer would have to fetch them, which adds
      // latency + failure modes; PDFKit accepts buffers/local paths only.
      doc.fontSize(8).fillColor("#666");
      [...beforeUrls, ...afterUrls].forEach((u) => doc.text(`  ${u}`, { width: 495 }));
      doc.moveDown(0.3);
    }
  }

  // ── Section 6: Inventory consumed ────────────────────────────────
  sectionTitle(`Inventory consumed (${consumptions.length})`);
  if (consumptions.length === 0) {
    doc.font("Helvetica-Oblique").fontSize(9).fillColor("#777").text("(no inventory consumed on file)");
  } else {
    ensureRoom(3);
    const tableTop = doc.y;
    const cols = [left, left + 130, left + 260, left + 340, left + 420];
    const headers = ["Date", "Product", "Qty", "Unit cost", "Total"];
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#333");
    headers.forEach((h, i) => doc.text(h, cols[i], tableTop, { width: (cols[i + 1] || left + 495) - cols[i] - 4 }));
    doc.moveTo(left, tableTop + 12).lineTo(doc.page.width - doc.page.margins.right, tableTop + 12)
      .lineWidth(0.4).strokeColor("#bbb").stroke();
    let rowY = tableTop + 16;
    doc.font("Helvetica").fontSize(9).fillColor("#222");
    let grandTotal = 0;
    for (const it of consumptions) {
      if (rowY > 760) { doc.addPage(); rowY = 60; }
      const total = (Number(it.qty) || 0) * (Number(it.unitCost) || 0);
      grandTotal += total;
      const cells = [
        formatDate(it.visitDate),
        String(it.productName || "—"),
        String(it.qty ?? "—"),
        formatMoney(it.unitCost),
        formatMoney(total),
      ];
      cells.forEach((val, i) => {
        doc.text(val, cols[i], rowY, { width: (cols[i + 1] || left + 495) - cols[i] - 4 });
      });
      rowY += 14;
    }
    doc.y = rowY + 4;
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#111")
      .text(`Total: ${formatMoney(grandTotal)}`, left, doc.y, { width: doc.page.width - left - doc.page.margins.right, align: "right" });
  }

  // ── Footer (last-page only) ─────────────────────────────────────
  doc.moveDown(2);
  const footerY = Math.min(doc.y, doc.page.height - doc.page.margins.bottom - 24);
  doc.moveTo(left, footerY).lineTo(doc.page.width - doc.page.margins.right, footerY)
    .lineWidth(0.4).strokeColor("#bbb").stroke();
  doc.font("Helvetica").fontSize(8).fillColor("#777").text(
    `Report generated ${formatDate(generatedAt)}${operator?.name ? ` by ${operator.name}` : ""}` +
      ` — Confidential clinical record. Distribute only to authorized parties.`,
    left, footerY + 6, { width: doc.page.width - left - doc.page.margins.right, align: "center" },
  );

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

// ── Travel CRM — diagnostic report ──────────────────────────────────
//
// PRD §4.2: "Auto-generated branded PDF report — sub-brand logo/colors/
// fonts; sent by WhatsApp + email immediately on completion."
//
// Phase 1: text-only branded layout per sub-brand (logos/full asset pack
// lands once Yasin delivers Q22). The sub-brand drives the accent color
// + label string at the top of the document.
//
// Q&A rendering: walks bank.questions (parsed) and answers in parallel,
// printing each question text and the corresponding answer label (resolving
// option.value → option.label when the bank defines options).

const SUB_BRAND_LABEL = {
  tmc: "TMC — School Trips",
  rfu: "RFU — Umrah Readiness",
  travelstall: "Travel Stall — Family Travel",
  visasure: "Visa Sure — Visa Readiness",
};
const SUB_BRAND_ACCENT = {
  // Hex strings used directly by PDFKit fillColor / strokeColor.
  tmc: "#0B4F6C",
  rfu: "#2F7A4D",
  travelstall: "#122647",
  visasure: "#7A2F5C",
};

function resolveAnswerLabel(question, rawAnswer) {
  if (rawAnswer == null) return "—";
  // Option lists support both string + array answers (multi-select).
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

/**
 * Render the diagnostic report.
 * @param {object} diagnostic — TravelDiagnostic row (with subBrand, score,
 *   classification, classificationLabel, recommendedTier, answersJson)
 * @param {object} contact — { name, email, phone }
 * @param {object} bank — { version, questionsJson } (questionsJson parsed lazily here)
 * @returns {Promise<Buffer>}
 */
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

  // Brand header band
  doc.rect(0, 0, doc.page.width, 60).fill(accent);
  doc.font("Helvetica-Bold").fontSize(18).fillColor("#fff")
    .text(brandLabel, 50, 22, { align: "left" });
  doc.fillColor("#fff").fontSize(10).text("Diagnostic Report", 50, 42, { align: "left" });
  doc.fillColor("#111").moveDown(2);

  // Body — contact + meta
  doc.font("Helvetica-Bold").fontSize(13).fillColor("#111").text(contact?.name || "Customer", 50, 90);
  const metaLine = [contact?.email, contact?.phone].filter(Boolean).join("  •  ");
  if (metaLine) doc.font("Helvetica").fontSize(10).fillColor("#555").text(metaLine);
  doc.moveDown(0.5);

  doc.font("Helvetica").fontSize(10).fillColor("#555");
  doc.text(`Bank version: v${bank?.version ?? "?"}`);
  doc.text(`Submitted: ${formatDate(diagnostic.createdAt || new Date())}`);
  doc.moveDown();

  // Result band
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

  // Q&A section
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

  // Footer divider + disclaimer
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

// ── Travel CRM — itinerary PDF ──────────────────────────────────────
//
// PRD §6.1 — GET /api/travel/itineraries/:id/pdf returns the customer-
// facing branded itinerary PDF (the RFU "quotation" doc). Reuses the
// sub-brand header band from renderTravelDiagnosticPdf, then renders
// the trip-summary block + the items table (flight | hotel | transfer
// | activity | visa | insurance) with per-item unitCost + markup +
// gstAmount + totalPrice, capped by the itinerary's totalAmount.
//
// Items are sorted by `position` (caller is responsible for passing
// the rows in display order). The PDF gracefully degrades when fields
// are missing — Phase 1 itineraries often have description-only items
// before pricing is finalised, and we render those as-is rather than
// blocking the PDF on incomplete data.

/**
 * @param {object} itinerary — Itinerary row with subBrand, destination,
 *   startDate, endDate, totalAmount, currency, version, items
 * @param {object} contact — { name, email, phone }
 * @returns {Promise<Buffer>}
 */
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

// ── Travel CRM — Travel Stall personalised 3-5 destination PDF ────────
//
// PRD §4.5 — customer-facing "personalised recommendations" PDF (Phase 2,
// row TS18 from TRAVEL_CRM_PORTAL_FEATURE_MATRIX.md). The PDF is the
// downstream artefact of the 4th LLM-router consumer (POST
// /api/travel/travelstall/personalised-pdf/regen): prose is generated
// via llmRouter (bulk-text → gemini-flash), then this function renders
// 3-5 destination cards on a branded layout.
//
// STUB: Travel Stall personalised-PDF template pending Q22 brand assets
// (Yasin's hand-over of logo + font pack + colour palette). Today the
// template uses the existing SUB_BRAND_ACCENT.travelstall (#122647 navy)
// + Helvetica defaults; when the brand pack lands, the swap is a 1-line
// per-asset substitution (logo image at the header, font registration
// at the top, accent token from the palette JSON).
//
// Destination cards: caller passes an array of strings (typically 3-5;
// we render up to 5 visible cards). The LLM-generated prose is shown
// once at the top as the personalised summary; each destination then
// gets its own short card with the destination name + a placeholder
// image slot (the slot becomes a real per-destination image once Q22
// arrives with the curated photo library).

/**
 * @param {object} payload
 * @param {object} payload.contact — { name, email, phone }
 * @param {string[]} payload.destinations — 1..10 destination names (5 visible)
 * @param {number|null} payload.budget — optional INR amount
 * @param {number|null} payload.durationDays — optional trip length
 * @param {object|null} payload.diagnostic — latest TravelDiagnostic projection
 *   (classification + classificationLabel + recommendedTier + score), or null
 * @param {string} payload.proseText — LLM-generated personalised prose
 * @param {string} payload.generatedAt — ISO timestamp
 * @returns {Promise<Buffer>}
 */
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

  // Destination cards — 3..5 entries, each a small card with destination
  // name + placeholder image slot + a per-destination prose stub. The
  // per-destination prose is intentionally short; the main LLM summary
  // above covers the why-this-customer narrative.
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

  // Footer — brand strip + generated-at timestamp + STUB marker so the
  // operator can see at a glance that the doc is pre-Q22 placeholder
  // branding. The marker disappears with the brand-pack swap.
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

module.exports = {
  renderPrescriptionPdf,
  renderConsentPdf,
  renderFullPatientReportPdf,
  renderBrandedInvoicePdf,
  renderTravelDiagnosticPdf,
  renderTravelItineraryPdf,
  renderTravelStallPersonalisedPdf,
};
