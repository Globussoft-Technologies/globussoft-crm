export const GENERIC_LEAD_STATUS_OPTIONS = Object.freeze([
  "New",
  "Contacted",
  "Interested",
  "Unqualified",
  "Qualified",
  "Lost",
  "Won",
  "Churned",
]);

const LEGACY_GENERIC_STATUS_LABELS = Object.freeze({
  Lead: "New",
  Prospect: "Contacted",
  Customer: "Won",
  Junk: "Unqualified",
});

const GENERIC_LEAD_STATUS_VALUES = Object.freeze({
  New: "Lead",
  Contacted: "Contacted",
  Interested: "Interested",
  Unqualified: "Unqualified",
  Qualified: "Qualified",
  Lost: "Lost",
  Won: "Won",
  Churned: "Churned",
});

export function genericLeadStatusLabel(status) {
  const value = String(status || "").trim();
  return LEGACY_GENERIC_STATUS_LABELS[value] || value || "New";
}

export function genericLeadStatusValue(status) {
  const label = genericLeadStatusLabel(status);
  return GENERIC_LEAD_STATUS_VALUES[label] || String(status || "").trim() || "Lead";
}

export const GENERIC_LEAD_STATUS_EDIT_OPTIONS = Object.freeze(
  GENERIC_LEAD_STATUS_OPTIONS.map((label) => ({
    value: GENERIC_LEAD_STATUS_VALUES[label],
    label,
  })),
);

export const GENERIC_LEAD_STATUS_FILTER_OPTIONS = Object.freeze(
  GENERIC_LEAD_STATUS_OPTIONS.map((status) => ({ value: status, label: status })),
);
