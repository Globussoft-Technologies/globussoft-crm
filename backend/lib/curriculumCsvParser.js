// C6 — TMC Curriculum CSV import/export parser.
//
// Slice C6 of docs/TRAVEL_CODEABLE_BACKLOG.md. Per
// docs/PRD_TMC_CURRICULUM_MAPPING.md FR-2 (CSV import) + FR-4 (CSV export) +
// FR-8 (coverage report).
//
// Pure module — no DB, no HTTP, no audit. parseCsv() and serializeCsv() are
// each exception-free at the cell level: per-row validation errors surface as
// { row, message } entries on the parse result; the calling route decides
// whether to 400-reject or partial-accept.
//
// Why hand-rolled (not csv-parse)
// -------------------------------
// The project's backend/package.json doesn't bundle csv-parse and we're not
// adding a dep for this slice. backend/lib/csvHelpers.js already ships a
// RFC4180-compliant parseCsv() + serializeRows() pair tolerant of CRLF/LF/CR
// line endings + UTF-8 BOM + Excel "double-quote escape" inside quoted
// fields (lib was promoted from inline implementations in routes/contacts.js
// + routes/audit_viewer.js — see csvHelpers.js header). We build on that
// foundation here.
//
// Adaptation to the actual TravelCurriculumMapping model
// ------------------------------------------------------
// The C6 slice spec used placeholder column names (board / gradeBand /
// outcome / topicCode / topicTitle). The real Prisma model
// (backend/prisma/schema.prisma:6186) has different field names with a
// 5-column composite uniqueness key:
//
//   @@unique([tenantId, curriculum, grade, subject, learningOutcome])
//
// So the canonical CSV column set is:
//
//   curriculum, grade, subject, learningOutcome, destinationLabel,
//   destinationId, fitScore, fitRationale, isActive
//
// where (curriculum, grade, subject, learningOutcome) is the composite
// natural key the route's upsert keys off. destinationId is optional (FK to
// TmcTrip); destinationLabel is the free-text fallback. fitScore is 1-100
// (default 50). isActive flips on import (default true on create, preserved
// on update unless explicitly set).
//
// REQUIRED_COLUMNS = ['curriculum', 'grade', 'subject', 'learningOutcome']
//   — the 4 fields that form the composite key. Everything else is
//   optional (destinationLabel + destinationId + fitScore + fitRationale +
//   isActive can all be empty on a row).
//
// Validation rules
// ----------------
//   - curriculum: must be in ALLOWED_CURRICULA (CBSE / ICSE / IB / Cambridge).
//     Case-insensitive match; canonical-case rewritten on output.
//   - grade: non-empty string, trimmed.
//   - subject: non-empty string, trimmed.
//   - learningOutcome: non-empty string, trimmed (composite-key member).
//   - destinationId: when present, must parse as a positive integer.
//   - fitScore: when present, integer in [1, 100].
//   - isActive: when present, "true"/"false"/"1"/"0" (case-insensitive).
//
// Round-trip discipline
// ---------------------
// parseCsv() returns rows whose values are EXACTLY as the route will store
// them post-validation (canonical curriculum casing, fitScore as Number,
// destinationId as Number, isActive as Boolean). serializeCsv() emits the
// same shape back. parse → serialize → parse → byte-equal rows is a
// pinned contract in the vitest suite.

const {
  parseCsv: rfc4180ParseCsv,
  serializeRows,
} = require("./csvHelpers");

// The composite-key columns + the optional metadata columns. Order matches
// CSV header on export.
const REQUIRED_COLUMNS = ["curriculum", "grade", "subject", "learningOutcome"];
const OPTIONAL_COLUMNS = [
  "destinationLabel",
  "destinationId",
  "fitScore",
  "fitRationale",
  "isActive",
];
const ALL_COLUMNS = [...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS];

// Canonical curriculum identifiers (PC-2 / PC-7 — V1 ships CBSE + ICSE; IB +
// Cambridge enabled but rows unseeded). Match is case-insensitive on input;
// canonical case is rewritten on output.
const ALLOWED_CURRICULA = ["CBSE", "ICSE", "IB", "Cambridge"];
const ALLOWED_CURRICULA_LC = new Set(
  ALLOWED_CURRICULA.map((c) => c.toLowerCase()),
);
const CURRICULUM_CANONICAL_BY_LC = Object.fromEntries(
  ALLOWED_CURRICULA.map((c) => [c.toLowerCase(), c]),
);

/**
 * Parse a CSV string into curriculum-mapping rows + per-row errors.
 *
 * @param {string} csvText  Raw CSV body (UTF-8, BOM-tolerant, CRLF or LF).
 * @param {object} [opts]   Reserved for future options; currently unused.
 * @returns {{
 *   rows: Array<{
 *     curriculum: string,
 *     grade: string,
 *     subject: string,
 *     learningOutcome: string,
 *     destinationLabel: string,
 *     destinationId: (number|null),
 *     fitScore: (number|null),
 *     fitRationale: string,
 *     isActive: (boolean|null),
 *   }>,
 *   errors: Array<{ row: number, message: string }>,
 *   headerError: (string|null),
 * }}
 *
 * Result invariant: when `headerError` is non-null, `rows` is empty and the
 * route should 400-reject. When `headerError` is null but `errors` is
 * non-empty, the parser still returns whatever rows DID validate so the
 * route can return both a partial-imported summary AND an error list (the
 * route decides whether to reject atomic or partial-accept).
 */
function parseCsv(csvText, opts = {}) {
  // Defensive — never throw on non-string input.
  if (typeof csvText !== "string") {
    return {
      rows: [],
      errors: [],
      headerError: "input must be a string",
    };
  }

  // Empty / whitespace-only body → no header, no rows, no errors.
  if (csvText.replace(/\uFEFF/g, "").trim() === "") {
    return { rows: [], errors: [], headerError: null };
  }

  const { headers, rows: rawRows } = rfc4180ParseCsv(csvText);

  // Header sanity — every REQUIRED_COLUMNS member must be present.
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
    // CSV row numbers are 1-based with row 1 being the header; data rows
    // start at row 2 so error reports cite the row the user sees in Excel.
    const rowNumber = i + 2;
    const raw = rawRows[i];

    // Skip blank rows (Excel-appended trailing empties).
    if (isBlankRow(raw)) continue;

    const rowErrors = [];

    const curriculumRaw = trim(raw.curriculum);
    const gradeRaw = trim(raw.grade);
    const subjectRaw = trim(raw.subject);
    const learningOutcomeRaw = trim(raw.learningOutcome);

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

    // Optional fields — validate when present, null when absent.
    let destinationId = null;
    const destinationIdRaw = trim(raw.destinationId);
    if (destinationIdRaw !== "") {
      const parsed = Number(destinationIdRaw);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        rowErrors.push(
          `destinationId "${destinationIdRaw}" must be a positive integer`,
        );
      } else {
        destinationId = parsed;
      }
    }

    let fitScore = null;
    const fitScoreRaw = trim(raw.fitScore);
    if (fitScoreRaw !== "") {
      const parsed = Number(fitScoreRaw);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
        rowErrors.push(
          `fitScore "${fitScoreRaw}" must be an integer in [1, 100]`,
        );
      } else {
        fitScore = parsed;
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
        rowErrors.push(
          `isActive "${raw.isActive}" must be true/false/1/0`,
        );
      }
    }

    if (rowErrors.length > 0) {
      // Record EACH validation error so the user sees the full picture per
      // row, not just the first failure.
      for (const message of rowErrors) {
        errors.push({ row: rowNumber, message });
      }
      // Don't push the partial row — the route's contract is "rows[] is
      // every fully-validated row; errors[] is everything else."
      continue;
    }

    rows.push({
      curriculum: CURRICULUM_CANONICAL_BY_LC[curriculumRaw.toLowerCase()],
      grade: gradeRaw,
      subject: subjectRaw,
      learningOutcome: learningOutcomeRaw,
      destinationLabel: trim(raw.destinationLabel),
      destinationId,
      fitScore,
      fitRationale: trim(raw.fitRationale),
      isActive,
    });
  }

  return { rows, errors, headerError: null };
}

/**
 * Serialize an array of rows back to CSV. Round-trips with parseCsv(): rows
 * emitted by this function and immediately re-parsed yield byte-identical
 * row shapes (modulo case-normalisation of curriculum which is also done on
 * parse, so the round-trip is idempotent after one pass).
 *
 * Outputs UTF-8 BOM + CRLF endings via the shared csvHelpers serializer for
 * Excel-on-Windows compatibility.
 *
 * @param {Array<object>} rows  Rows in the shape returned by parseCsv.rows.
 * @returns {string}  CSV string with header + rows.
 */
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
