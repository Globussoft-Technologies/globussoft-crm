"use strict";

const DEFAULT_TMC_CONSENT_TERMS =
  "I confirm that the information provided is accurate. I have read and agree to the terms and conditions for this trip, and I give permission for the travel team to use this information to organise the participant's travel.";

const TMC_DIGITAL_CONSENT_FIELDS = Object.freeze([
  Object.freeze({ key: "parentName", label: "Parent or guardian full name", type: "text", required: true }),
  Object.freeze({ key: "participantName", label: "Student / participant full name", type: "text", required: true }),
  Object.freeze({ key: "relationship", label: "Relationship to the student", type: "text", required: true }),
  Object.freeze({ key: "signatureName", label: "Type your full name as your signature", type: "text", required: true }),
  Object.freeze({ key: "notes", label: "Additional notes", type: "textarea", required: false }),
]);

function parseConsentAnswers(value) {
  if (value && typeof value === "object" && !Buffer.isBuffer(value)) return value;
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (_err) {
    return {};
  }
}

function projectDigitalConsentRequirement(requirement) {
  if (!requirement) return null;
  const captureMode = String(requirement.captureMode || "file").trim().toLowerCase() === "digital_consent"
    ? "digital_consent"
    : "file";
  return {
    ...requirement,
    captureMode,
    ...(captureMode === "digital_consent"
      ? {
          consentForm: {
            fields: TMC_DIGITAL_CONSENT_FIELDS,
            terms: String(requirement.consentTerms || "").trim() || DEFAULT_TMC_CONSENT_TERMS,
          },
        }
      : {}),
  };
}

module.exports = {
  DEFAULT_TMC_CONSENT_TERMS,
  TMC_DIGITAL_CONSENT_FIELDS,
  parseConsentAnswers,
  projectDigitalConsentRequirement,
};
