export const DEFAULT_TMC_CONSENT_TERMS =
  "I confirm that the information provided is accurate. I have read and agree to the terms and conditions for this trip, and I give permission for the travel team to use this information to organise the participant's travel.";

export const TMC_DIGITAL_CONSENT_FIELDS = [
  { key: "parentName", label: "Parent or guardian full name", type: "text", required: true },
  { key: "participantName", label: "Student / participant full name", type: "text", required: true },
  { key: "relationship", label: "Relationship to the student", type: "text", required: true },
  { key: "signatureName", label: "Type your full name as your signature", type: "text", required: true },
  { key: "notes", label: "Additional notes", type: "textarea", required: false },
];

export function isDigitalConsentRequirement(requirement) {
  return String(requirement?.captureMode || "file").trim().toLowerCase() === "digital_consent";
}

export function consentTermsForRequirement(requirement) {
  return String(requirement?.consentForm?.terms || requirement?.consentTerms || "").trim()
    || DEFAULT_TMC_CONSENT_TERMS;
}
