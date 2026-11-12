// Passport is required only for international TMC trips. Missing or unknown
// values remain international for backwards compatibility with legacy trips.
export function normalizeTripType(value) {
  const normalized = String(value || "international")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return ["domestic", "international", "day_trip"].includes(normalized)
    ? normalized
    : "international";
}

export function tripRequiresPassport(value) {
  return normalizeTripType(value) === "international";
}

export function requiredParentDocumentTypes(value) {
  return tripRequiresPassport(value)
    ? ["passport", "aadhaar", "consent-form", "visa"]
    : ["aadhaar", "consent-form"];
}

export const TMC_DOCUMENT_FILE_TYPES = [
  { value: "pdf", label: "PDF", accept: "application/pdf", extensions: [".pdf"] },
  { value: "jpg", label: "JPG / JPEG", accept: "image/jpeg", extensions: [".jpg", ".jpeg"] },
  { value: "png", label: "PNG", accept: "image/png", extensions: [".png"] },
  { value: "doc", label: "DOC", accept: "application/msword", extensions: [".doc"] },
  {
    value: "docx",
    label: "DOCX",
    accept: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extensions: [".docx"],
  },
];

export const DEFAULT_TMC_DOCUMENT_FILE_TYPES = ["pdf", "jpg", "png"];

export function normalizeAcceptedFileTypes(value) {
  let values = value;
  if (typeof values === "string") {
    try {
      values = JSON.parse(values);
    } catch {
      values = values.split(",");
    }
  }
  if (!Array.isArray(values)) values = DEFAULT_TMC_DOCUMENT_FILE_TYPES;
  const known = new Set(TMC_DOCUMENT_FILE_TYPES.map((type) => type.value));
  const normalized = [...new Set(values.map((item) => String(item || "").trim().toLowerCase()).filter((item) => known.has(item)))];
  return normalized.length ? normalized : [...DEFAULT_TMC_DOCUMENT_FILE_TYPES];
}

export function acceptedFileTypesToAccept(value) {
  return normalizeAcceptedFileTypes(value)
    .flatMap((typeValue) => {
      const type = TMC_DOCUMENT_FILE_TYPES.find((item) => item.value === typeValue);
      return type ? [type.accept, ...type.extensions] : [];
    })
    .join(",");
}

export function formatAcceptedFileTypes(value) {
  const labels = normalizeAcceptedFileTypes(value)
    .map((typeValue) => TMC_DOCUMENT_FILE_TYPES.find((item) => item.value === typeValue)?.label)
    .filter(Boolean);
  return labels.join(", ");
}
