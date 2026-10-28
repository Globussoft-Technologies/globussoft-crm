"use strict";

const { parseCsv, parseXlsxBuffer } = require("./csvIO");
const { toE164 } = require("../utils/deduplication");

const PARTICIPANT_IMPORT_STATUS = new Set(["pending", "approved", "rejected", "waitlisted"]);
const PARTICIPANT_IMPORT_HEADERS = [
  "fullName",
  "parentName",
  "parentPhone",
  "parentEmail",
  "applicationStatus",
  "passportNumber",
  "passportExpiry",
  "aadhaarLast4",
  "medicalNotes",
  "reviewNotes",
];
const PARTICIPANT_REQUIRED_HEADERS = ["fullName", "parentName", "parentPhone", "parentEmail"];

function isXlsxUpload(file) {
  if (!file) return false;
  const name = String(file.originalname || "").toLowerCase();
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) return true;
  const mt = String(file.mimetype || "").toLowerCase();
  return (
    mt === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mt === "application/vnd.ms-excel"
  );
}

function parseSpreadsheetBuffer(buffer, file) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error("parseSpreadsheetBuffer: buffer is required");
  }
  return isXlsxUpload(file)
    ? parseXlsxBuffer(buffer, { rawColumns: ["parentPhone"] })
    : parseCsv(buffer.toString("utf8"));
}

function buildParticipantImportTemplate(format) {
  if (format === "xlsx") {
    const XLSX = require("xlsx");
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([PARTICIPANT_REQUIRED_HEADERS]);
    sheet["!cols"] = PARTICIPANT_REQUIRED_HEADERS.map((header) => ({ wch: Math.max(18, header.length + 2) }));
    XLSX.utils.book_append_sheet(workbook, sheet, "Participants");
    const guide = XLSX.utils.aoa_to_sheet([
      ["Column", "Required", "Format"],
      ["fullName", "Yes", "Participant's full name"],
      ["parentName", "Yes", "Parent or guardian's full name"],
      ["parentPhone", "Yes", "10-digit Indian mobile or E.164 number; Excel numeric values are read without scientific-notation rounding"],
      ["parentEmail", "Yes", "Valid parent or guardian email address"],
      ["applicationStatus", "No", "pending, approved, rejected, or waitlisted"],
      ["passportNumber", "No", "International trips only"],
      ["passportExpiry", "No", "YYYY-MM-DD, e.g. 2027-02-21"],
      ["aadhaarLast4", "No", "Exactly 4 digits; never enter a full Aadhaar number"],
      ["medicalNotes", "No", "Free text"],
      ["reviewNotes", "No", "Free text"],
    ]);
    guide["!cols"] = [{ wch: 22 }, { wch: 12 }, { wch: 68 }];
    XLSX.utils.book_append_sheet(workbook, guide, "Instructions");
    return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  }
  const { serializeRows } = require("./csvHelpers");
  return serializeRows(
    PARTICIPANT_REQUIRED_HEADERS.map((header) => ({ key: header, header })),
    [],
  );
}

function missingParticipantImportHeaders(headers) {
  const available = new Set((headers || []).map((header) => String(header).trim()));
  return PARTICIPANT_REQUIRED_HEADERS.filter((header) =>
    header === "fullName" ? !available.has("fullName") && !available.has("name") : !available.has(header),
  );
}

function normalizeText(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function normalizeEmail(value) {
  const text = normalizeText(value);
  return text ? text.toLowerCase() : "";
}

function parseDateValue(value) {
  const text = normalizeText(value);
  if (!text) return null;
  const dt = new Date(text);
  if (!Number.isFinite(dt.getTime())) return { error: `invalid date: ${text}` };
  return dt;
}

function normalizeApplicationStatus(value) {
  const text = normalizeText(value).toLowerCase();
  if (!text) return null;
  if (!PARTICIPANT_IMPORT_STATUS.has(text)) {
    return { error: `applicationStatus must be one of: ${Array.from(PARTICIPANT_IMPORT_STATUS).join(", ")}` };
  }
  return text;
}

function parseParticipantImportRow(raw, rowNumber) {
  const errors = [];
  const fullName = normalizeText(raw.fullName || raw.name);
  if (!fullName) {
    errors.push({ rowNumber, reason: "fullName is required" });
  }

  const parentName = normalizeText(raw.parentName);
  const parentEmail = normalizeEmail(raw.parentEmail);
  if (!parentName) errors.push({ rowNumber, reason: "parentName is required" });
  if (!parentEmail) errors.push({ rowNumber, reason: "parentEmail is required" });
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parentEmail)) {
    errors.push({ rowNumber, reason: "invalid parentEmail" });
  }

  let parentPhone = normalizeText(raw.parentPhone);
  if (parentPhone) {
    const formatted = toE164(parentPhone);
    if (!formatted) {
      errors.push({ rowNumber, reason: "invalid parentPhone" });
    } else {
      parentPhone = formatted;
    }
  } else {
    parentPhone = "";
    errors.push({ rowNumber, reason: "parentPhone is required" });
  }

  let applicationStatus = normalizeApplicationStatus(raw.applicationStatus || raw.status);
  if (applicationStatus && applicationStatus.error) {
    errors.push({ rowNumber, reason: applicationStatus.error });
    applicationStatus = null;
  }

  const consentCapturedAt = parseDateValue(raw.consentCapturedAt);
  if (consentCapturedAt && consentCapturedAt.error) {
    errors.push({ rowNumber, reason: consentCapturedAt.error });
  }
  const passportExtractedAt = parseDateValue(raw.passportExtractedAt);
  if (passportExtractedAt && passportExtractedAt.error) {
    errors.push({ rowNumber, reason: passportExtractedAt.error });
  }
  const passportVerifiedAt = parseDateValue(raw.passportVerifiedAt);
  if (passportVerifiedAt && passportVerifiedAt.error) {
    errors.push({ rowNumber, reason: passportVerifiedAt.error });
  }
  const passportRejectedAt = parseDateValue(raw.passportRejectedAt);
  if (passportRejectedAt && passportRejectedAt.error) {
    errors.push({ rowNumber, reason: passportRejectedAt.error });
  }
  const passportExpiry = parseDateValue(raw.passportExpiry);
  if (passportExpiry && passportExpiry.error) {
    errors.push({ rowNumber, reason: passportExpiry.error });
  }

  const aadhaarLast4 = normalizeText(raw.aadhaarLast4);
  if (aadhaarLast4 && !/^\d{4}$/.test(aadhaarLast4)) {
    errors.push({ rowNumber, reason: "aadhaarLast4 must be exactly 4 digits" });
  }

  const data = {};
  if (fullName) data.fullName = fullName;
  if (parentName) data.parentName = parentName;
  if (parentPhone) data.parentPhone = parentPhone;
  if (parentEmail) data.parentEmail = parentEmail;
  if (applicationStatus) data.applicationStatus = applicationStatus;
  if (consentCapturedAt && !consentCapturedAt.error) data.consentCapturedAt = consentCapturedAt;
  if (passportExtractedAt && !passportExtractedAt.error) data.passportExtractedAt = passportExtractedAt;
  if (passportVerifiedAt && !passportVerifiedAt.error) data.passportVerifiedAt = passportVerifiedAt;
  if (passportRejectedAt && !passportRejectedAt.error) data.passportRejectedAt = passportRejectedAt;
  if (passportExpiry && !passportExpiry.error) data.passportExpiry = passportExpiry;
  if (aadhaarLast4) data.aadhaarLast4 = aadhaarLast4;
  if (normalizeText(raw.passportNumber)) data.passportNumber = normalizeText(raw.passportNumber);
  if (normalizeText(raw.passportDocId)) data.passportDocId = normalizeText(raw.passportDocId);
  if (normalizeText(raw.medicalNotes)) data.medicalNotes = normalizeText(raw.medicalNotes);
  if (normalizeText(raw.reviewNotes)) data.reviewNotes = normalizeText(raw.reviewNotes);

  return {
    errors,
    data,
    naturalKey: [
      fullName.toLowerCase(),
      parentPhone || "",
      parentEmail || "",
    ].join("|"),
  };
}

module.exports = {
  PARTICIPANT_IMPORT_HEADERS,
  PARTICIPANT_REQUIRED_HEADERS,
  missingParticipantImportHeaders,
  isXlsxUpload,
  parseSpreadsheetBuffer,
  buildParticipantImportTemplate,
  normalizeText,
  normalizeEmail,
  parseDateValue,
  normalizeApplicationStatus,
  parseParticipantImportRow,
};
