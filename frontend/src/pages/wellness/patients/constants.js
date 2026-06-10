export const SOURCE_OPTIONS = [
  { value: "walk-in", label: "Walk-in" },
  { value: "indiamart", label: "IndiaMART" },
  { value: "google-ad", label: "Google ad" },
  { value: "referral", label: "Referral" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "meta-ad", label: "Meta ad" },
  { value: "import-zylu", label: "Import (Zylu)" },
];

export const GENDER_OPTIONS = [
  { value: "M", label: "Male" },
  { value: "F", label: "Female" },
  { value: "Other", label: "Other" },
];

// Lightweight palette for tags whose `color` is null — keyed by id so each
// tag gets a stable colour across renders without polluting the DB.
export const TAG_PALETTE = [
  "#7c9b97",
  "#cd9481",
  "#9d8cb0",
  "#8aabd3",
  "#d4a06a",
  "#7fb18c",
  "#c688a3",
  "#8ac2c4",
];

export function tagColour(tag) {
  if (tag?.color) return tag.color;
  const id = Number(tag?.id) || 0;
  return TAG_PALETTE[Math.abs(id) % TAG_PALETTE.length];
}
