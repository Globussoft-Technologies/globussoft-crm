"use strict";

const { parseCsv, parseXlsxBuffer } = require("./csvIO");
const { toE164 } = require("../utils/deduplication");

const PARTICIPANT_IMPORT_STATUS = new Set(["pending", "approved", "rejected", "waitlisted"]);

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
    ? parseXlsxBuffer(buffer)
    : parseCsv(buffer.toString("utf8"));
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
  isXlsxUpload,
  parseSpreadsheetBuffer,
  normalizeText,
  normalizeEmail,
  parseDateValue,
  normalizeApplicationStatus,
  parseParticipantImportRow,
};
