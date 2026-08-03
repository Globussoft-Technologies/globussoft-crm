// C6 - TMC Curriculum CSV import/export parser.
//
// Extended for Issue 23 curriculum-library versioning + review metadata.
// The parser stays backward-compatible: legacy CSVs with only the original
// columns still import cleanly, while newer CSVs can include academicYear,
// learningOutcomeCode, confidenceScore, and mappingSource.

const {
  parseCsv: rfc4180ParseCsv,
  serializeRows,
} = require("./csvHelpers");

const REQUIRED_COLUMNS = ["curriculum", "grade", "subject", "learningOutcome"];
const OPTIONAL_COLUMNS = [
  "academicYear",
  "learningOutcomeCode",
  "destinationLabel",
  "destinationId",
  "fitScore",
  "confidenceScore",
  "fitRationale",
  "mappingSource",
  "isActive",
];
const ALL_COLUMNS = [...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS];

const ALLOWED_CURRICULA = ["CBSE", "ICSE", "IB", "Cambridge", "IGCSE", "State Board"];
const ALLOWED_CURRICULA_LC = new Set(ALLOWED_CURRICULA.map((c) => c.toLowerCase()));
const CURRICULUM_CANONICAL_BY_LC = Object.fromEntries(
  ALLOWED_CURRICULA.map((c) => [c.toLowerCase(), c]),
);

function parseCsv(csvText, opts = {}) {
  if (typeof csvText !== "string") {
    return { rows: [], errors: [], headerError: "input must be a string" };
  }
  if (csvText.replace(/\uFEFF/g, "").trim() === "") {
    return { rows: [], errors: [], headerError: null };
  }

  const { headers, rows: rawRows } = rfc4180ParseCsv(csvText);
  const headerSet = new Set(headers);
  const missing = REQUIRED_COLUMNS.filter((c) => !headerSet.has(c));
  if (missing.length > 0) {
    return {
      rows: [],
      errors: [],
      headerError: `missing required column(s): ${missing.join(", ")}`,
    };
  }

  const rows = [];
  const errors = [];

  for (let i = 0; i < rawRows.length; i++) {
    const rowNumber = i + 2;
    const raw = rawRows[i];
    if (isBlankRow(raw)) continue;

    const rowErrors = [];
    const curriculumRaw = trim(raw.curriculum);
    const gradeRaw = trim(raw.grade);
    const subjectRaw = trim(raw.subject);
    const learningOutcomeRaw = trim(raw.learningOutcome);
    const academicYearRaw = trim(raw.academicYear);
    const learningOutcomeCodeRaw = trim(raw.learningOutcomeCode);
    const mappingSourceRaw = trim(raw.mappingSource);

    if (!curriculumRaw) {
      rowErrors.push("curriculum is required");
    } else if (!ALLOWED_CURRICULA_LC.has(curriculumRaw.toLowerCase())) {
      rowErrors.push(
        `curriculum "${curriculumRaw}" not in allowed set (${ALLOWED_CURRICULA.join(", ")})`,
      );
    }
    if (!gradeRaw) rowErrors.push("grade is required");
    if (!subjectRaw) rowErrors.push("subject is required");
    if (!learningOutcomeRaw) rowErrors.push("learningOutcome is required");

    let destinationId = null;
    const destinationIdRaw = trim(raw.destinationId);
    if (destinationIdRaw !== "") {
      const parsed = Number(destinationIdRaw);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        rowErrors.push(`destinationId "${destinationIdRaw}" must be a positive integer`);
      } else {
        destinationId = parsed;
      }
    }

    let fitScore = null;
    const fitScoreRaw = trim(raw.fitScore);
    if (fitScoreRaw !== "") {
      const parsed = Number(fitScoreRaw);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
        rowErrors.push(`fitScore "${fitScoreRaw}" must be an integer in [1, 100]`);
      } else {
        fitScore = parsed;
      }
    }

    let confidenceScore = null;
    const confidenceScoreRaw = trim(raw.confidenceScore);
    if (confidenceScoreRaw !== "") {
      const parsed = Number(confidenceScoreRaw);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
        rowErrors.push(`confidenceScore "${confidenceScoreRaw}" must be an integer in [0, 100]`);
      } else {
        confidenceScore = parsed;
      }
    }

    let isActive = null;
    const isActiveRaw = trim(raw.isActive).toLowerCase();
    if (isActiveRaw !== "") {
      if (isActiveRaw === "true" || isActiveRaw === "1") {
        isActive = true;
      } else if (isActiveRaw === "false" || isActiveRaw === "0") {
        isActive = false;
      } else {
        rowErrors.push(`isActive "${raw.isActive}" must be true/false/1/0`);
      }
    }

    if (rowErrors.length > 0) {
      for (const message of rowErrors) errors.push({ row: rowNumber, message });
      continue;
    }

    rows.push({
      academicYear: academicYearRaw,
      curriculum: CURRICULUM_CANONICAL_BY_LC[curriculumRaw.toLowerCase()],
      grade: gradeRaw,
      subject: subjectRaw,
      learningOutcomeCode: learningOutcomeCodeRaw,
      learningOutcome: learningOutcomeRaw,
      destinationLabel: trim(raw.destinationLabel),
      destinationId,
      fitScore,
      confidenceScore,
      fitRationale: trim(raw.fitRationale),
      mappingSource: mappingSourceRaw,
      isActive,
    });
  }

  return { rows, errors, headerError: null };
}

function serializeCsv(rows) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const columns = ALL_COLUMNS.map((key) => ({
    key,
    header: key,
    render: (row) => renderCell(row, key),
  }));
  return serializeRows(columns, safeRows);
}

function renderCell(row, key) {
  const v = row[key];
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

function trim(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function isBlankRow(rawRow) {
  if (!rawRow || typeof rawRow !== "object") return true;
  for (const k of Object.keys(rawRow)) {
    if (trim(rawRow[k]) !== "") return false;
  }
  return true;
}

module.exports = {
  parseCsv,
  serializeCsv,
  REQUIRED_COLUMNS,
  OPTIONAL_COLUMNS,
  ALL_COLUMNS,
  ALLOWED_CURRICULA,
};
