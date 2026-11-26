// Editable native Contact fields that can be entered while creating a Generic
// CRM lead. Keep Field Config and the Create Lead picker on this shared list so
// a selectable Quick-add checkbox always has a matching form control.
export const GENERIC_LEAD_QUICK_ADD_FIELDS = [
  { key: "name", label: "Full Name", inputType: "text" },
  { key: "email", label: "Email Address", inputType: "email" },
  { key: "company", label: "Company", inputType: "text" },
  { key: "title", label: "Job Title", inputType: "text" },
  { key: "phone", label: "Phone", inputType: "tel" },
  { key: "website", label: "Website URL", inputType: "url" },
  { key: "source", label: "Lead Source", inputType: "select" },
  { key: "whatsappPhone", label: "WhatsApp Number", inputType: "tel" },
  { key: "linkedin", label: "LinkedIn", inputType: "url" },
  { key: "industry", label: "Service Type", inputType: "text" },
  { key: "companySize", label: "No Of Employee", inputType: "text" },
  { key: "subBrand", label: "Sub-brand", inputType: "text" },
  { key: "note", label: "Note", inputType: "textarea" },
  { key: "stateCode", label: "State", inputType: "text", maxLength: 10 },
  { key: "medium", label: "Medium", inputType: "text" },
  { key: "firstTouchSource", label: "First Touch Source", inputType: "text" },
  { key: "lastTouchSource", label: "Last Touch Source", inputType: "text" },
  { key: "treatmentOfInterest", label: "Treatment Of Interest", inputType: "text" },
  { key: "birthDate", label: "Birth Date", inputType: "date" },
  { key: "anniversary", label: "Anniversary", inputType: "date" },
  { key: "gst", label: "GSTIN", inputType: "text", maxLength: 15 },
  { key: "billingStateCode", label: "Billing State Code", inputType: "text", maxLength: 10 },
];

export const GENERIC_LEAD_QUICK_ADD_FIELD_KEYS = new Set(
  GENERIC_LEAD_QUICK_ADD_FIELDS.map((field) => field.key),
);

