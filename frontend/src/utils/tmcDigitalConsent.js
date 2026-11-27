export const DEFAULT_TMC_CONSENT_TERMS =
  "I confirm that the information provided is accurate. I have read and agree to the terms and conditions for this trip, and I give permission for the travel team to use this information to organise the participant's travel.";

export const TMC_DIGITAL_CONSENT_FIELDS = [
  { key: "parentName", label: "Parent or guardian full name", type: "text", required: true },
  { key: "participantName", label: "Student / participant full name", type: "text", required: true },
  { key: "relationship", label: "Relationship to the student", type: "text", required: true },
  { key: "signatureName", label: "Type your full name as your signature", type: "text", required: true },
  { key: "notes", label: "Additional notes", type: "textarea", required: false },
];

export function parseConsentTermsForDisplay(value) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (!normalized) return { title: "", introduction: "", sections: [] };

  const chunks = normalized.split(/(?=\b\d+\.\s+[A-Z])/g).filter(Boolean);
  const opening = chunks.shift() || normalized;
  const titleMatch = opening.match(/^(.+?)(?=\s+These Terms)/i);
  const title = titleMatch ? titleMatch[1].trim() : "";
  const introduction = title ? opening.slice(titleMatch[0].length).trim() : opening.trim();

  const sections = chunks.map((chunk) => {
    const headingMatch = chunk.match(/^((?:\d+)\.\s+[A-Z][A-Z0-9 ,/&'’()-]*?)(?=\s+(?:[A-Z][a-z]|[A-Z]\.))/);
    const heading = headingMatch ? headingMatch[1].trim() : "";
    const body = heading ? chunk.slice(headingMatch[0].length).trim() : chunk.trim();
    const paragraphs = body.split(/(?=\b[A-Z]\.\s)/g).map((paragraph) => paragraph.trim()).filter(Boolean);
    return { heading, paragraphs: paragraphs.length ? paragraphs : [body] };
  });

  return { title, introduction, sections };
}

export function formatConsentTermsForEditing(value) {
  const original = String(value || "").trim();
  if (!original) return "";

  const content = parseConsentTermsForDisplay(original);
  if (!content.title && !content.sections.length) return original;

  const blocks = [];
  if (content.title) blocks.push(content.title);
  if (content.introduction) blocks.push(content.introduction);
  content.sections.forEach((section) => {
    const block = [section.heading, ...section.paragraphs].filter(Boolean).join("\n");
    if (block) blocks.push(block);
  });
  return blocks.join("\n\n");
}

export function isDigitalConsentRequirement(requirement) {
  return String(requirement?.captureMode || "file").trim().toLowerCase() === "digital_consent";
}

export function consentTermsForRequirement(requirement) {
  return String(requirement?.consentForm?.terms || requirement?.consentTerms || "").trim()
    || DEFAULT_TMC_CONSENT_TERMS;
}
