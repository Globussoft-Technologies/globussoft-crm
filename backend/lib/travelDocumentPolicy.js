"use strict";

// Passport is required only for international TMC trips. Missing or unknown
// values remain international for backwards compatibility with legacy trips.
function normalizeTripType(value) {
  const normalized = String(value || "international")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return ["domestic", "international", "day_trip"].includes(normalized)
    ? normalized
    : "international";
}

function tripRequiresPassport(value) {
  return normalizeTripType(value) === "international";
}

function requiredParentDocumentTypes(value) {
  return tripRequiresPassport(value)
    ? ["passport", "aadhaar", "consent-form", "visa"]
    : ["aadhaar", "consent-form"];
}

// TMC admins can choose the file formats for every custom document
// requirement. The document name itself is intentionally unrestricted; these
// are only the safe upload formats the portal can validate consistently.
const TMC_DOCUMENT_FILE_TYPES = Object.freeze({
  pdf: Object.freeze({ label: "PDF", mimeTypes: ["application/pdf"], extensions: [".pdf"] }),
  jpg: Object.freeze({ label: "JPG / JPEG", mimeTypes: ["image/jpeg"], extensions: [".jpg", ".jpeg"] }),
  png: Object.freeze({ label: "PNG", mimeTypes: ["image/png"], extensions: [".png"] }),
  doc: Object.freeze({ label: "DOC", mimeTypes: ["application/msword"], extensions: [".doc"] }),
  docx: Object.freeze({
    label: "DOCX",
    mimeTypes: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    extensions: [".docx"],
  }),
});

const DEFAULT_TMC_DOCUMENT_FILE_TYPES = Object.freeze(["pdf", "jpg", "png"]);

const TMC_DOCUMENT_CAPTURE_MODES = Object.freeze(["file", "digital_consent"]);

function normalizeCaptureMode(value) {
  return String(value || "file").trim().toLowerCase() === "digital_consent"
    ? "digital_consent"
    : "file";
}

function normalizeAcceptedFileTypes(value) {
  let values = value;
  if (typeof values === "string") {
    try {
      values = JSON.parse(values);
    } catch {
      values = values.split(",");
    }
  }
  if (!Array.isArray(values)) values = DEFAULT_TMC_DOCUMENT_FILE_TYPES;
  const normalized = [...new Set(values
    .map((item) => String(item || "").trim().toLowerCase())
    .filter((item) => Object.prototype.hasOwnProperty.call(TMC_DOCUMENT_FILE_TYPES, item)))];
  return normalized.length ? normalized : [...DEFAULT_TMC_DOCUMENT_FILE_TYPES];
}

function acceptedFileTypeMatches(file, acceptedFileTypes) {
  const accepted = normalizeAcceptedFileTypes(acceptedFileTypes);
  const mimeType = String(file?.mimetype || "").trim().toLowerCase();
  const filename = String(file?.originalname || file?.filename || "").trim().toLowerCase();
  return accepted.some((type) => {
    const rule = TMC_DOCUMENT_FILE_TYPES[type];
    return rule.mimeTypes.includes(mimeType) || rule.extensions.some((extension) => filename.endsWith(extension));
  });
}

function projectTripDocumentRequirement(requirement) {
  if (!requirement) return null;
  return {
    ...requirement,
    captureMode: normalizeCaptureMode(requirement.captureMode),
    acceptedFileTypes: normalizeAcceptedFileTypes(requirement.acceptedFileTypes),
  };
}

module.exports = {
  normalizeTripType,
  tripRequiresPassport,
  requiredParentDocumentTypes,
  TMC_DOCUMENT_FILE_TYPES,
  DEFAULT_TMC_DOCUMENT_FILE_TYPES,
  TMC_DOCUMENT_CAPTURE_MODES,
  normalizeCaptureMode,
  normalizeAcceptedFileTypes,
  acceptedFileTypeMatches,
  projectTripDocumentRequirement,
};
