// Generates a printable "Curriculum Mapping — Data Collection Worksheet" PDF
// for the 5 TMC starter trips. Hand it to testers / the academic team to fill
// in; the values are then entered in Travel → Curriculum Mappings.
//   run:  node scripts/generate-curriculum-worksheet.js
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");

const ACCENT = "#122647";
const TRIPS = [
  "Golden Triangle",
  "Madhya Pradesh",
  "Ladakh",
  "Europe",
  "USA STEM",
];
const ENTRIES_PER_TRIP = 2;

const doc = new PDFDocument({ size: "A4", margin: 50 });
const out = path.resolve(__dirname, "..", "curriculum-mapping-worksheet.pdf");
const stream = fs.createWriteStream(out);
doc.pipe(stream);

const PAGE_W = doc.page.width;
const LEFT = 50;
const RIGHT = PAGE_W - 50;
const LINE = "_________________________";

function header() {
  doc.rect(0, 0, PAGE_W, 64).fill(ACCENT);
  doc.font("Helvetica-Bold").fontSize(17).fillColor("#fff")
    .text("TMC Curriculum Mapping", LEFT, 18);
  doc.font("Helvetica").fontSize(10).fillColor("#fff")
    .text("Data Collection Worksheet — Travel Stall (school trips)", LEFT, 42);
  doc.fillColor("#111");
}

function ensureSpace(needed) {
  if (doc.y + needed > doc.page.height - 60) {
    doc.addPage();
    doc.y = 60;
  }
}

header();
doc.y = 84;

// Intro + rules
doc.font("Helvetica-Bold").fontSize(11).fillColor("#111")
  .text("Fill one block per subject/learning-outcome a trip teaches. A trip can have several.", LEFT, doc.y);
doc.moveDown(0.5);
doc.font("Helvetica").fontSize(9.5).fillColor("#333");
doc.text("Rules: use the EXACT spellings below — these must match the diagnostic question options and the Curriculum Mappings screen.", { width: RIGHT - LEFT });
doc.moveDown(0.4);
doc.font("Helvetica-Bold").fontSize(9.5).fillColor("#111").text("Allowed values", LEFT);
doc.font("Helvetica").fontSize(9).fillColor("#333");
doc.text("• Curriculum: CBSE | ICSE | IB | Cambridge", LEFT + 8);
doc.text("• Grade: Class 8 | Class 9 | Class 10 | Class 11 | Class 12   (format: \"Class N\")", LEFT + 8);
doc.text("• Subject: Geography | History | Biology | Physics | (other)", LEFT + 8);
doc.text("• Fit score: a number 0–100 (how well the trip fits that outcome; 80+ = strong)", LEFT + 8);
doc.moveDown(0.8);

function fieldLine(label, after) {
  doc.font("Helvetica-Bold").fontSize(9.5).fillColor("#111").text(label, LEFT + 10, doc.y, { continued: true });
  doc.font("Helvetica").fontSize(9.5).fillColor("#333").text(`  ${after}`);
}

for (const trip of TRIPS) {
  ensureSpace(150);
  doc.moveDown(0.4);
  doc.font("Helvetica-Bold").fontSize(12).fillColor(ACCENT).text(`Trip: ${trip}`, LEFT, doc.y);
  doc.moveDown(0.2);
  doc.moveTo(LEFT, doc.y).lineTo(RIGHT, doc.y).lineWidth(0.5).strokeColor("#bbb").stroke();
  doc.moveDown(0.4);

  for (let i = 1; i <= ENTRIES_PER_TRIP; i++) {
    ensureSpace(70);
    doc.font("Helvetica-Bold").fontSize(9.5).fillColor("#555").text(`Mapping ${i}`, LEFT + 4, doc.y);
    doc.moveDown(0.2);
    fieldLine("Curriculum:", `${LINE}    Grade: ${LINE}`);
    doc.moveDown(0.15);
    fieldLine("Subject:", `${LINE}    Fit score (0–100): ______`);
    doc.moveDown(0.15);
    fieldLine("Learning outcome:", "______________________________________________");
    doc.moveDown(0.15);
    fieldLine("Destination(s):", "________________________________________________");
    doc.moveDown(0.15);
    fieldLine("Rationale (why it fits):", "______________________________________");
    doc.moveDown(0.5);
  }
}

ensureSpace(60);
doc.moveDown(0.5);
doc.font("Helvetica-Oblique").fontSize(8.5).fillColor("#777")
  .text("Once filled, enter each block as one row in Travel → Curriculum Mappings (curriculum / grade / subject / learning outcome / destination / fit score / rationale). The curriculum, grade and subject values must match the diagnostic's question options exactly.", LEFT, doc.y, { width: RIGHT - LEFT });

doc.end();
stream.on("finish", () => console.log("Wrote", out));
