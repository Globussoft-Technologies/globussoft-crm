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
//
// #839 — Prescription PDF redesigned to a proper clinical-prescription
// layout per the bug report's acceptance criteria. Pre-this-fix the
// document had a thin clinic header, a 3-line patient block (Name /
// Phone / Age+Gender / Date), a 4-column drug table (Medication /
// Dosage / Frequency / Duration), an optional single Instructions
// paragraph, and a single signature line. The output was technically
// readable but pharmacies and patients rated it "not a clinical Rx".
//
// Post-fix layout (per the issue's "Expected Behavior" block):
//   1. Clinic header (drawClinicHeader) — name + address + contact
//   2. Doctor letterhead row — Dr. <name>, qualification, registration
//      number, contact (right-aligned strip directly under the clinic
//      header). All fields are optional and degrade gracefully.
//   3. Patient block — Name, Patient ID, Age + Gender + Date (grid),
//      Phone, Email. Includes Patient ID so pharmacies can cross-check.
//   4. Vitals row — BP, Pulse, Weight, Height, Temp, SpO2. Only renders
//      when at least one vital is supplied on the Rx.
//   5. Symptoms / Diagnosis section — top-level Rx fields. Each renders
//      only when present.
//   6. Rx symbol + medications table — adds a 5th "Instructions" column
//      (per-drug instructions like "with food", "at bedtime"); top-level
//      `prescription.instructions` is rendered in the Advice block.
//   7. Advice / Notes section — top-level instructions paragraph.
//   8. Follow-up — "Next follow-up: <date>" line when supplied.
//   9. Signature block — doctor name (bold), qualification, registration
//      number stacked under the signature line on the right.
//   10. Footer — clinic phone + email, centered, on the last page.
//
// All new fields are OPTIONAL on the input — old Rx rows with no extra
// columns render identically to the pre-#839 layout (modulo the new
// table column, which simply shows a "—" placeholder for legacy rows).
//
// `prescription` shape (all new fields optional):
//   {
//     drugs: string|array|object,    // existing
//     instructions: string,          // existing — rendered in Advice
//     createdAt: Date,               // existing
//     symptoms: string,              // NEW — chief complaint
//     diagnosis: string,             // NEW — clinical diagnosis
//     vitals: {                      // NEW — vitals row
//       bp: string,                  //   e.g. "120/80"
//       pulse: string|number,
//       weight: string|number,       //   kg
//       height: string|number,       //   cm
//       temperature: string|number,  //   F
//       spo2: string|number,         //   %
//     },
//     followUpAt: Date,              // NEW — next follow-up date
//   }
//
// `doctor` shape (all new fields optional):
//   {
//     name: string,                  // existing
//     qualification: string,         // NEW — e.g. "MBBS, MD (Derm)"
//     registrationNumber: string,    // NEW — e.g. "MCI-123456"
//     phone: string,                 // NEW — direct contact
//     email: string,                 // NEW
//   }
//
// `patient.id` is the human-readable patient identifier shown in the
// patient block (pharmacies cross-reference it against the dispensed
// drug log). Falls back to "—" when missing.

function drawDoctorLetterhead(doc, doctor) {
  if (!doctor) return;
  const parts = [];
  if (doctor.qualification) parts.push(doctor.qualification);
  if (doctor.registrationNumber) parts.push(`Reg. No. ${doctor.registrationNumber}`);
  const contactParts = [];
  if (doctor.phone) contactParts.push(doctor.phone);
  if (doctor.email) contactParts.push(doctor.email);

  doc.font("Helvetica-Bold").fontSize(11).fillColor("#111")
    .text(doctor.name ? `Dr. ${doctor.name}` : "Attending physician");
  if (parts.length) {
    doc.font("Helvetica").fontSize(9).fillColor("#555").text(parts.join("  ·  "));
  }
  if (contactParts.length) {
    doc.font("Helvetica").fontSize(9).fillColor("#555").text(contactParts.join("  ·  "));
  }
  doc.moveDown(0.5);
  // Divider beneath the doctor strip
  const y = doc.y;
  doc.moveTo(doc.page.margins.left, y)
    .lineTo(doc.page.width - doc.page.margins.right, y)
    .lineWidth(0.5).strokeColor("#bbb").stroke();
  doc.moveDown(0.6);
  doc.fillColor("#111");
}

function drawVitalsRow(doc, vitals) {
  if (!vitals || typeof vitals !== "object") return false;
  const entries = [
    ["BP", vitals.bp],
    ["Pulse", vitals.pulse],
    ["Weight", vitals.weight ? `${vitals.weight} kg` : null],
    ["Height", vitals.height ? `${vitals.height} cm` : null],
    ["Temp", vitals.temperature ? `${vitals.temperature} °F` : null],
    ["SpO2", vitals.spo2 ? `${vitals.spo2}%` : null],
  ].filter(([, v]) => v != null && v !== "");
  if (entries.length === 0) return false;

  doc.font("Helvetica-Bold").fontSize(11).fillColor("#111").text("Vitals");
  doc.moveDown(0.2);
  doc.font("Helvetica").fontSize(10).fillColor("#222");
  // Single-line "BP: 120/80  ·  Pulse: 72  ·  Weight: 65 kg  …"
  const line = entries.map(([k, v]) => `${k}: ${v}`).join("  ·  ");
  doc.text(line, { width: 495 });
  doc.moveDown(0.6);
  return true;
}

async function renderPrescriptionPdf(prescription, patient, clinic, doctor) {
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const bufPromise = streamToBuffer(doc);

  // 1. Clinic header
  drawClinicHeader(doc, clinic);

  // 2. Doctor letterhead (qualification, reg. number, contact)
  drawDoctorLetterhead(doc, doctor);

  // Title
  doc.font("Helvetica-Bold").fontSize(14).text("Prescription", { align: "center" });
  doc.moveDown(0.6);

  // 3. Patient block — two-column grid for compactness
  const age = computeAge(patient?.dob);
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#111").text("Patient");
  doc.moveDown(0.2);
  doc.font("Helvetica").fontSize(10).fillColor("#222");

  const left = doc.page.margins.left;
  const colWidth = (doc.page.width - left - doc.page.margins.right) / 2;
  const pTop = doc.y;
  // Left column
  doc.text(`Name: ${patient?.name || "—"}`, left, pTop, { width: colWidth });
  doc.text(`Patient ID: ${patient?.id != null ? String(patient.id) : "—"}`, left, doc.y, { width: colWidth });
  doc.text(`Phone: ${patient?.phone || "—"}`, left, doc.y, { width: colWidth });
  if (patient?.email) {
    doc.text(`Email: ${patient.email}`, left, doc.y, { width: colWidth });
  }
  const leftEndY = doc.y;
  // Right column
  doc.text(`Date: ${formatDate(prescription?.createdAt || new Date())}`, left + colWidth, pTop, { width: colWidth });
  doc.text(`Age: ${age}`, left + colWidth, doc.y, { width: colWidth });
  doc.text(`Gender: ${patient?.gender || "—"}`, left + colWidth, doc.y, { width: colWidth });
  doc.y = Math.max(leftEndY, doc.y);
  doc.moveDown(0.6);

  // 4. Vitals (optional)
  drawVitalsRow(doc, prescription?.vitals);

  // 5. Symptoms / Diagnosis (each optional)
  if (prescription?.symptoms) {
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#111").text("Symptoms");
    doc.font("Helvetica").fontSize(10).fillColor("#222").text(prescription.symptoms, { width: 495 });
    doc.moveDown(0.4);
  }
  if (prescription?.diagnosis) {
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#111").text("Diagnosis");
    doc.font("Helvetica").fontSize(10).fillColor("#222").text(prescription.diagnosis, { width: 495 });
    doc.moveDown(0.4);
  }

  // 6. Rx symbol + medications table — #278: ℞ (U+211E) glyph survives in
  // pdfkit's built-in Helvetica on every platform we target. Five columns
  // now — added per-drug Instructions per the #839 acceptance criteria.
  doc.font("Helvetica-Bold").fontSize(13).fillColor("#111").text("℞");
  doc.moveDown(0.3);

  const drugs = parseDrugs(prescription?.drugs);
  let tableTop = doc.y;
  // Column layout: name 50-195, dosage 195-275, freq 275-355, duration 355-435, instructions 435-545
  const colX = [50, 195, 275, 355, 435];
  const colEnd = [195, 275, 355, 435, 545];
  const headers = ["Medication", "Dosage", "Frequency", "Duration", "Instructions"];

  doc.font("Helvetica-Bold").fontSize(10).fillColor("#333");
  headers.forEach((h, i) => doc.text(h, colX[i], tableTop, { width: colEnd[i] - colX[i] - 4 }));
  doc.moveTo(50, tableTop + 14)
    .lineTo(545, tableTop + 14)
    .lineWidth(0.5).strokeColor("#bbb").stroke();

  let rowY = tableTop + 20;
  doc.font("Helvetica").fontSize(10).fillColor("#222");
  if (drugs.length === 0) {
    doc.text("(no medications listed)", 50, rowY);
    rowY += 16;
  } else {
    for (const d of drugs) {
      // Page-break headroom — re-render table headers on the new page so
      // the medications table stays readable across pages (acceptance
      // criterion: "page-break safety").
      if (rowY > 720) {
        doc.addPage();
        tableTop = 60;
        doc.font("Helvetica-Bold").fontSize(10).fillColor("#333");
        headers.forEach((h, i) => doc.text(h, colX[i], tableTop, { width: colEnd[i] - colX[i] - 4 }));
        doc.moveTo(50, tableTop + 14)
          .lineTo(545, tableTop + 14)
          .lineWidth(0.5).strokeColor("#bbb").stroke();
        rowY = tableTop + 20;
        doc.font("Helvetica").fontSize(10).fillColor("#222");
      }
      const cells = [
        d.name || d.drug || "—",
        d.dosage || "—",
        d.frequency || "—",
        d.duration || "—",
        d.instructions || d.notes || "—",
      ];
      cells.forEach((val, i) => {
        doc.text(String(val), colX[i], rowY, {
          width: colEnd[i] - colX[i] - 4,
        });
      });
      rowY += 22;
    }
  }

  doc.moveDown(1);
  doc.y = Math.max(doc.y, rowY + 10);

  // 7. Advice / Notes (top-level instructions paragraph)
  if (prescription?.instructions) {
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#111").text("Advice / Notes");
    doc.font("Helvetica").fontSize(10).fillColor("#222").text(prescription.instructions, {
      width: 495,
    });
    doc.moveDown(0.6);
  }

  // 8. Follow-up date
  if (prescription?.followUpAt) {
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#111")
      .text("Next follow-up: ", { continued: true });
    doc.font("Helvetica").fontSize(10).fillColor("#222")
      .text(formatDate(prescription.followUpAt));
    doc.moveDown(0.6);
  }

  // 9. Signature block — doctor name + qualification + reg number stacked
  // under the signature line on the right side of the page.
  const sigY = Math.max(doc.y + 40, 680);
  doc.moveTo(360, sigY).lineTo(545, sigY).lineWidth(0.5).strokeColor("#444").stroke();
  doc.font("Helvetica").fontSize(9).fillColor("#555").text("Doctor's signature", 360, sigY + 4);
  if (doctor?.name) {
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#222")
      .text(`Dr. ${doctor.name}`, 360, sigY + 16, { width: 185 });
  }
  if (doctor?.qualification) {
    doc.font("Helvetica").fontSize(8).fillColor("#555")
      .text(doctor.qualification, 360, doc.y, { width: 185 });
  }
  if (doctor?.registrationNumber) {
    doc.font("Helvetica").fontSize(8).fillColor("#555")
      .text(`Reg. No. ${doctor.registrationNumber}`, 360, doc.y, { width: 185 });
  }

  // 10. Footer — clinic contact strip on the last page. Drawn near the
  // page bottom so it doesn't clash with the signature block above.
  const c = safeClinic(clinic);
  const footerLine = [c.phone, c.email].filter(Boolean).join("  |  ");
  if (footerLine) {
    const footerY = doc.page.height - doc.page.margins.bottom - 18;
    doc.moveTo(50, footerY - 6).lineTo(doc.page.width - 50, footerY - 6)
      .lineWidth(0.4).strokeColor("#bbb").stroke();
    doc.font("Helvetica").fontSize(8).fillColor("#777")
      .text(footerLine, 50, footerY, { width: doc.page.width - 100, align: "center" });
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

// ── Travel CRM — quote PDF (DD-5.6) ─────────────────────────────────
//
// Travel-quote PDF, customer-facing. Mirrors the shape of
// renderBrandedInvoicePdf (page setup → branded header → bill-to → items
// table → totals → footer) but is sub-brand-aware via SUB_BRAND_LABEL /
// SUB_BRAND_ACCENT (same convention used by the diagnostic + itinerary
// renderers above).
//
// DD-5.6 ("Extend pdfRenderer.js — single PDF lib path; operator
// branding via shared theme tokens") resolved 2026-05-24. Three decisions
// land in this function:
//   - DD-5.6 — single PDFKit code path; no React-PDF, no Puppeteer.
//   - DD-5.4 — currency is per-quote (`quote.currency`), operator-set
//     per sub-brand. formatMoney handles INR / USD / GBP symbols; other
//     ISO codes render as the bare 3-letter code prefix.
//   - DD-5.3 — taxTreatment is one of 'inclusive' | 'exclusive'.
//     Inclusive → an "Includes GST" footnote under the totals line.
//     Exclusive → an explicit GST line item added after subtotal
//     (using the provided gstAmount, or zero if absent).
//
// BrandKit integration is V1-placeholder: the function accepts an
// optional `quote.brandKit` projection with `{ logoUrl, accent }` but
// only renders a textual placeholder for the logo (per the strict
// "do NOT fetch the file" rule). When BrandKit.logoUrl is present we
// note that fact in the header band as "[Logo: <url>]"; the real image
// substitution lands once tick #95's BrandKit asset-fetching is wired.
//
// `quote` shape:
//   {
//     id,                              // for invoice-style references
//     quoteNumber,                     // tenant-scoped human ID (e.g. "TQ-2026-0042")
//     subBrand,                        // 'tmc' | 'rfu' | 'travelstall' | 'visasure'
//     customerName, customerEmail, customerPhone,
//     status,                          // 'Draft' | 'Sent' | 'Accepted' | 'Rejected'
//     issuedDate,                      // optional
//     validUntil,                      // DD-5.6 validity-date footer
//     items: [{ description, qty, unitPrice, totalPrice }],
//     subtotal, gstAmount, totalAmount,
//     currency,                        // DD-5.4 — 'INR' | 'USD' | 'GBP' | …
//     taxTreatment,                    // DD-5.3 — 'inclusive' | 'exclusive'
//     brandKit: { logoUrl, accent }    // optional, tick #95 placeholder
//   }
//
// Currency rendering note (DD-5.4): renderTravelQuotePdf falls through
// formatMoney for the 3 well-known glyphs (INR ₹, USD $, GBP £) and
// otherwise prefixes the bare ISO code (e.g. "EUR 1234.50"); operators
// rarely use exotic currencies in V1 and the bare code is unambiguous.
//
// @param {object} quote — see shape above
// @returns {Promise<Buffer>}
function renderTravelQuotePdf(quote) {
  const q = quote || {};
  const sub = q.subBrand;
  const brandLabel = SUB_BRAND_LABEL[sub] || "Travel CRM";
  // BrandKit accent (when present) wins; otherwise fall back to the
  // sub-brand default. Either way, a hex string usable as fillColor.
  const accent = (q.brandKit && q.brandKit.accent) || SUB_BRAND_ACCENT[sub] || "#111111";
  const currency = q.currency || "INR";
  const items = Array.isArray(q.items) ? q.items : [];
  const taxTreatment = q.taxTreatment === "inclusive" ? "inclusive" : "exclusive";

  // Money helper that handles a wider currency set than the in-module
  // helper (which only knows INR / USD). We keep the in-module helper
  // unchanged to avoid churning the prescription / invoice renderers.
  function fmt(n) {
    const v = Number(n) || 0;
    if (currency === "INR") return `₹${v.toFixed(2)}`;
    if (currency === "USD") return `$${v.toFixed(2)}`;
    if (currency === "GBP") return `£${v.toFixed(2)}`;
    return `${currency} ${v.toFixed(2)}`;
  }

  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const bufPromise = streamToBuffer(doc);

  // ── Branded header band ────────────────────────────────────────────
  doc.rect(0, 0, doc.page.width, 60).fill(accent);
  doc.font("Helvetica-Bold").fontSize(18).fillColor("#fff")
    .text(brandLabel, 50, 22, { align: "left" });
  doc.fillColor("#fff").fontSize(10).text("Quote", 50, 42, { align: "left" });

  // BrandKit logo placeholder — text marker only (no fetch per the
  // tick-173 strict rule). Real image swap is a 1-line drop-in once
  // BrandKit asset-fetching ships.
  if (q.brandKit && q.brandKit.logoUrl) {
    doc.font("Helvetica").fontSize(8).fillColor("#fff")
      .text(`[Logo: ${q.brandKit.logoUrl}]`, doc.page.width - 250, 22, { width: 200, align: "right" });
  }
  doc.fillColor("#111").moveDown(2);

  // ── Quote meta (right column) + customer block (left column) ──────
  const metaTop = 80;
  // Right column — quote number, dates, status
  doc.font("Helvetica-Bold").fontSize(18).fillColor("#111")
    .text("QUOTE", 380, metaTop, { width: 165, align: "right" });
  doc.font("Helvetica").fontSize(10).fillColor("#333");
  doc.text(`Quote #: ${q.quoteNumber || q.id || "—"}`, 380, metaTop + 26, { width: 165, align: "right" });
  doc.text(`Issued: ${formatDate(q.issuedDate || new Date())}`, 380, metaTop + 40, { width: 165, align: "right" });
  doc.text(`Valid until: ${formatDate(q.validUntil)}`, 380, metaTop + 54, { width: 165, align: "right" });
  doc.text(`Status: ${q.status || "Draft"}`, 380, metaTop + 68, { width: 165, align: "right" });

  // Left column — bill-to
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#111").text("Quote For", 50, metaTop);
  doc.font("Helvetica").fontSize(10).fillColor("#222");
  doc.text(q.customerName || "—", 50, metaTop + 18);
  if (q.customerEmail) doc.text(q.customerEmail, 50, doc.y);
  if (q.customerPhone) doc.text(q.customerPhone, 50, doc.y);

  // Advance below both columns
  doc.y = Math.max(doc.y, metaTop + 100);
  doc.moveDown(0.6);
  const divY = doc.y;
  doc.moveTo(50, divY).lineTo(545, divY).lineWidth(0.7).strokeColor(accent).stroke();
  doc.moveDown(0.8);

  // ── Items table ───────────────────────────────────────────────────
  const tableTop = doc.y;
  const colX = { desc: 50, qty: 340, unit: 400, total: 470 };
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#333");
  doc.text("Description", colX.desc, tableTop);
  doc.text("Qty", colX.qty, tableTop, { width: 50, align: "right" });
  doc.text("Unit", colX.unit, tableTop, { width: 60, align: "right" });
  doc.text("Total", colX.total, tableTop, { width: 75, align: "right" });
  doc.moveTo(50, tableTop + 14).lineTo(545, tableTop + 14).lineWidth(0.5).strokeColor("#bbb").stroke();

  let rowY = tableTop + 22;
  doc.font("Helvetica").fontSize(10).fillColor("#222");
  let computedSubtotal = 0;
  if (items.length === 0) {
    doc.fillColor("#777").text("(No line items on this quote yet.)", colX.desc, rowY, { width: 480 });
    rowY += 18;
  } else {
    for (const it of items) {
      if (rowY > 700) { doc.addPage(); rowY = 60; }
      const qty = Number(it.qty) || 0;
      const unit = Number(it.unitPrice) || 0;
      const total = it.totalPrice != null ? Number(it.totalPrice) : qty * unit;
      computedSubtotal += total;
      doc.fillColor("#222");
      doc.text(String(it.description || "—"), colX.desc, rowY, { width: 280 });
      doc.text(qty === 0 ? "—" : String(qty), colX.qty, rowY, { width: 50, align: "right" });
      doc.text(unit === 0 ? "—" : fmt(unit), colX.unit, rowY, { width: 60, align: "right" });
      doc.text(fmt(total), colX.total, rowY, { width: 75, align: "right" });
      rowY += 20;
    }
  }
  doc.y = rowY + 4;

  // ── Totals block ──────────────────────────────────────────────────
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
    // DD-5.3 — explicit GST line item AFTER subtotal.
    doc.text("GST", 350, ty, { width: 95, align: "right" });
    doc.text(fmt(gstAmount), 450, ty, { width: 95, align: "right" });
    ty += 16;
  }

  // Grand-total line (bold)
  doc.moveTo(350, ty).lineTo(545, ty).lineWidth(0.5).strokeColor("#bbb").stroke();
  ty += 6;
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#111");
  doc.text("Total", 350, ty, { width: 95, align: "right" });
  doc.text(fmt(grandTotal), 450, ty, { width: 95, align: "right" });
  ty += 18;

  if (taxTreatment === "inclusive") {
    // DD-5.3 — inclusive footnote sits directly under the total line.
    doc.font("Helvetica-Oblique").fontSize(9).fillColor("#666");
    doc.text("Includes GST", 350, ty, { width: 195, align: "right" });
    ty += 14;
  }
  doc.y = ty + 8;

  // ── Validity footer + signature placeholder ───────────────────────
  doc.moveDown(1);
  const validityY = doc.y;
  doc.font("Helvetica").fontSize(10).fillColor("#333")
    .text(`Valid until ${formatDate(q.validUntil)}`, 50, validityY, { width: 495 });
  doc.moveDown(2.5);

  // Signature block placeholder
  const sigY = Math.max(doc.y, 700);
  doc.moveTo(50, sigY).lineTo(250, sigY).lineWidth(0.5).strokeColor("#444").stroke();
  doc.font("Helvetica").fontSize(9).fillColor("#555")
    .text("Authorised signature", 50, sigY + 4);

  // ── Footer band ───────────────────────────────────────────────────
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

// Back-compat alias — the tick-173 prompt + downstream callers reference
// this as `generateTravelQuotePdf`; we expose both names to avoid forcing
// a rename of the (yet-to-land) route caller.
const generateTravelQuotePdf = renderTravelQuotePdf;

// ── Travel CRM — invoice PDF (Arc 2 #901 slice 2) ───────────────────
//
// Travel-invoice PDF, customer-facing. Mirrors renderTravelQuotePdf's
// layout primitives (A4, 50pt margins, sub-brand-aware accent + label
// band) but renders an INVOICE rather than a quote — issuedDate +
// dueDate replace the validUntil meta block, and the title strip
// reads "INVOICE" rather than "QUOTE".
//
// Slice scope: SIMPLEST renderable invoice PDF that covers PRD §3
// "operator clicks Download invoice PDF and gets a branded PDF of the
// invoice + its line items". Rich templates (per-sub-brand letterhead,
// GST breakdown rows beyond the existing tax-treatment line, multi-
// currency split, payment-receipt overlay) land in subsequent slices
// once Q22 brand-pack creds drop.
//
// Input shape — accepts EITHER:
//   { invoice: { ...lines: [...] }, tenant }   // lines attached on row
//   { invoice, lines: [...], tenant }          // lines passed alongside
// `tenant` is optional (currently informational — surfaces in the
// footer if provided; the header band uses sub-brand labels). Future
// slices will use tenant for per-tenant address/GSTIN insertion.
//
// `invoice` shape:
//   {
//     id,                              // for invoice references
//     invoiceNum,                      // tenant-scoped human ID (e.g. "TINV-2026-0042")
//     subBrand,                        // 'tmc' | 'rfu' | 'travelstall' | 'visasure'
//     status,                          // 'Draft' | 'Issued' | 'Partial' | 'Paid' | 'Voided'
//     issuedDate,                      // optional; falls back to invoice.createdAt or now
//     dueDate,                         // optional
//     totalAmount,                     // numeric or string-decimal
//     currency,                        // 'INR' | 'USD' | 'GBP' | …
//     contactName, contactEmail, contactPhone,  // optional bill-to fields
//   }
//
// `lines` shape (each):
//   { description, quantity, unitPrice, amount, lineType, currency, notes }
//
// Currency rendering mirrors renderTravelQuotePdf's `fmt(n)` helper —
// glyphs for INR/USD/GBP, otherwise bare ISO code prefix.
//
// @returns {Promise<Buffer>}
// ── docType taxonomy (Arc 2 #901 slice 13) ─────────────────────────
//
// TravelInvoice.docType (added in slice 11, `7c54451c`) classifies an
// invoice into one of five legal-document shapes. The renderer flips
// the header title strip + the legal-text footer line so the printed
// document is unambiguous about its tax-legal status.
//
// Unknown docType values fall back to the TaxInvoice shape — defensive
// against a future schema-enum expansion where a new value reaches the
// renderer before the renderer learns to format it. TaxInvoice is the
// safest fallback (it carries the strictest legal interpretation; the
// reader sees standard tax-invoice framing rather than a misleading
// proforma/voucher label).
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

function renderTravelInvoicePdf(opts) {
  // Accept either the row-with-attached-lines form or the explicit
  // { invoice, lines, tenant } form. The first is friendlier for
  // callers that already have a Prisma `findFirst({ include: { lines } })`
  // row; the second is friendlier for the route handler that loads the
  // lines separately and wants to pass them in cleanly.
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
  // docType drives both the main header title strip ("TAX INVOICE" vs
  // "PROFORMA INVOICE" etc.) and the legal-text footer line. Nullable
  // (back-compat with rows predating slice 11); default = TaxInvoice.
  const docType = invoice.docType || "TaxInvoice";
  const docHeaderTitle = docTypeHeader(docType);
  const docFooterText = docTypeFooter(docType);

  // Money formatter mirrored from renderTravelQuotePdf (same currency
  // glyph set + same fallback to bare ISO code prefix).
  function fmt(n) {
    const v = Number(n) || 0;
    if (currency === "INR") return `₹${v.toFixed(2)}`;
    if (currency === "USD") return `$${v.toFixed(2)}`;
    if (currency === "GBP") return `£${v.toFixed(2)}`;
    return `${currency} ${v.toFixed(2)}`;
  }

  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const bufPromise = streamToBuffer(doc);

  // ── Branded header band ────────────────────────────────────────────
  doc.rect(0, 0, doc.page.width, 60).fill(accent);
  doc.font("Helvetica-Bold").fontSize(18).fillColor("#fff")
    .text(brandLabel, 50, 22, { align: "left" });
  // Sub-label in the colored header band mirrors the docType
  // (e.g. "Tax Invoice" / "Proforma Invoice") — title-case for the
  // narrow band so it reads as a label rather than a heading.
  const bandSubLabel = docHeaderTitle
    .toLowerCase()
    .replace(/(^|\s)\S/g, (c) => c.toUpperCase());
  doc.fillColor("#fff").fontSize(10).text(bandSubLabel, 50, 42, { align: "left" });
  doc.fillColor("#111").moveDown(2);

  // ── Invoice meta (right column) + bill-to block (left column) ─────
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

  // Left column — bill-to (optional; falls back to em-dash placeholder).
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#111").text("Bill To", 50, metaTop);
  doc.font("Helvetica").fontSize(10).fillColor("#222");
  doc.text(invoice.contactName || "—", 50, metaTop + 18);
  if (invoice.contactEmail) doc.text(invoice.contactEmail, 50, doc.y);
  if (invoice.contactPhone) doc.text(invoice.contactPhone, 50, doc.y);

  // Advance below both columns
  doc.y = Math.max(doc.y, metaTop + 100);
  doc.moveDown(0.6);
  const divY = doc.y;
  doc.moveTo(50, divY).lineTo(545, divY).lineWidth(0.7).strokeColor(accent).stroke();
  doc.moveDown(0.8);

  // ── Line-items table ──────────────────────────────────────────────
  const tableTop = doc.y;
  const colX = { desc: 50, qty: 340, unit: 400, total: 470 };
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#333");
  doc.text("Description", colX.desc, tableTop);
  doc.text("Qty", colX.qty, tableTop, { width: 50, align: "right" });
  doc.text("Unit", colX.unit, tableTop, { width: 60, align: "right" });
  doc.text("Amount", colX.total, tableTop, { width: 75, align: "right" });
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
      // Prefer the stored amount (route layer already computed qty*unit
      // at write time; this keeps the PDF consistent with the DB row even
      // if floating-point edge cases would drift).
      const amount = line.amount != null ? Number(line.amount) : qty * unit;
      computedSubtotal += amount;
      doc.fillColor("#222");
      doc.text(String(line.description || "—"), colX.desc, rowY, { width: 280 });
      doc.text(qty === 0 ? "—" : String(qty), colX.qty, rowY, { width: 50, align: "right" });
      doc.text(unit === 0 ? "—" : fmt(unit), colX.unit, rowY, { width: 60, align: "right" });
      doc.text(fmt(amount), colX.total, rowY, { width: 75, align: "right" });
      rowY += 20;
    }
  }
  doc.y = rowY + 4;

  // ── Totals block ──────────────────────────────────────────────────
  // Prefer the invoice's stored totalAmount (route layer's
  // recomputeInvoiceTotal keeps it consistent with sum-of-lines). Fall
  // back to the in-PDF computed subtotal if the header total isn't set
  // (e.g. header-only invoices with no lines).
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

  // Grand-total line (bold)
  doc.moveTo(350, ty).lineTo(545, ty).lineWidth(0.5).strokeColor("#bbb").stroke();
  ty += 6;
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#111");
  doc.text("Total Due", 350, ty, { width: 95, align: "right" });
  doc.text(fmt(grandTotal), 450, ty, { width: 95, align: "right" });
  ty += 18;
  doc.y = ty + 8;

  // ── Payment-terms footer ──────────────────────────────────────────
  doc.moveDown(1);
  const termsY = doc.y;
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#333").text("Payment Terms", 50, termsY);
  doc.font("Helvetica").fontSize(9).fillColor("#555").text(
    invoice.dueDate
      ? `Payment is due by ${formatDate(invoice.dueDate)}. Please quote invoice number ${invoice.invoiceNum || invoice.id || ""} on any payment or correspondence.`
      : "Please quote the invoice number on any payment or correspondence.",
    50, termsY + 14, { width: 495 },
  );

  // ── docType legal-text line ───────────────────────────────────────
  // Slice 13: prints the per-docType legal disclosure ABOVE the footer
  // band. Sits in the body of the page (not the chrome footer) so it
  // reads as a legal-status declaration tied to the document, not as a
  // page-margin annotation.
  doc.moveDown(1);
  doc.font("Helvetica-Oblique").fontSize(9).fillColor("#444").text(
    docFooterText,
    50, doc.y, { width: 495 },
  );

  // ── Footer band ───────────────────────────────────────────────────
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

// Public name mirrors generateTravelQuotePdf — the route handler imports
// `generateTravelInvoicePdf`; we keep `renderTravelInvoicePdf` as the
// internal name for symmetry with the other render* helpers in this file.
const generateTravelInvoicePdf = renderTravelInvoicePdf;

// ── POS Receipt PDF (D17 slice 6) ──────────────────────────────────
//
// Wellness POS issues a paper / PDF receipt after each Sale is finalized.
// PRD §3.7 (receipt) + §6.4 (PDF format) call out:
//
//   • Top-of-receipt: tenant name + tenant address + invoice number
//     "INV-{sale.id}" + sale.completedAt formatted
//   • Patient block: patient name + phone (when available)
//   • Line items table: Description / Qty / Unit Price / Line Total
//   • Totals: Subtotal / Discount / Tax / Grand Total (₹ formatted)
//   • Payments section: each payment "Method ... ₹Amount"
//   • Footer: "Thank you for your visit" + "Powered by Globussoft CRM"
//
// Input shape (all fields are optional unless noted):
//
//   sale     { id (required), completedAt, subtotal, discount, tax,
//              grandTotal, currency }
//   lines    [{ description, qty, unitPrice, lineTotal }]
//   payments [{ method, amount }]
//   patient  { name, phone }
//   tenant   { name, addressLine, city, state, pincode, phone, email }
//
// Returns a Promise<Buffer> — the caller (route handler) is responsible
// for streaming to res or writing to disk.
//
// The helper is pure: caller fetches tenant-scoped rows via prisma, we
// just turn plain objects into PDF bytes. Mirrors the layout primitives
// already used by renderTravelQuotePdf (A4, 50pt margins, pdfkit fonts).

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

module.exports = {
  renderPrescriptionPdf,
  renderConsentPdf,
  renderFullPatientReportPdf,
  renderBrandedInvoicePdf,
  renderTravelDiagnosticPdf,
  renderTravelItineraryPdf,
  renderTravelStallPersonalisedPdf,
  renderTravelQuotePdf,
  generateTravelQuotePdf,
  renderTravelInvoicePdf,
  generateTravelInvoicePdf,
  generatePosReceiptPdf,
};
