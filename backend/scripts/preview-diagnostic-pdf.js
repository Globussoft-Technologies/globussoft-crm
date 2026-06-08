// Throwaway preview: renders a sample TMC diagnostic report PDF WITH the
// FR-7 "Why these destinations fit your curriculum" section so you can eyeball
// the new output without needing data/auth. Delete when done.
//   run:  node scripts/preview-diagnostic-pdf.js
const fs = require("fs");
const path = require("path");
const { renderTravelDiagnosticPdf } = require("../services/pdfRenderer");

const curriculumFit = {
  curriculum: "CBSE",
  grade: "Class 9",
  subject: "Geography",
  recommendations: [
    {
      destination: "Switzerland + Austria",
      fitScore: 85,
      reasons: [
        { subject: "Geography", learningOutcome: "Glacial landforms + river systems", rationale: "Alpine glaciation + the Rhine basin make textbook landforms tangible." },
        { subject: "Geography", learningOutcome: "Plate tectonics + uplift", rationale: "Active uplift zones across the Alps." },
      ],
    },
    {
      destination: "Italy + Iceland",
      fitScore: 78,
      reasons: [
        { subject: "Geography", learningOutcome: "Volcanism + rift zones", rationale: "Iceland sits on the Mid-Atlantic Ridge." },
      ],
    },
  ],
};

const diagnostic = {
  subBrand: "tmc",
  classification: "level_2",
  classificationLabel: "Premium",
  recommendedTier: "premium",
  score: 7.5,
  createdAt: new Date("2026-06-08"),
  answersJson: JSON.stringify({ budget: "high" }),
  curriculumFitJson: JSON.stringify(curriculumFit),
};
const contact = { name: "Demo School — Class 9", email: "principal@demoschool.edu", phone: "+91 90000 00000" };
const bank = {
  version: 1,
  questionsJson: JSON.stringify({
    questions: [{ id: "budget", text: "What is the trip budget tier?", type: "single", options: [{ value: "high", label: "High" }] }],
  }),
};

(async () => {
  const buf = await renderTravelDiagnosticPdf(diagnostic, contact, bank);
  const out = path.resolve(__dirname, "..", "preview-diagnostic-pdf.pdf");
  fs.writeFileSync(out, buf);
  console.log("Wrote", out, `(${buf.length} bytes) — open it to see the curriculum-fit section.`);
})();
