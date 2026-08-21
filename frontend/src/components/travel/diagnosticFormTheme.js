// Theme + styling helpers shared by the public diagnostic form and the admin preview.
// Kept in a separate module so the renderer file can remain a single exported component
// (Fast Refresh requirement) while still sharing logic with the admin panel and report page.

export const DEFAULT_PRIMARY = "#122647";
export const DEFAULT_BG = "#fbf7f0";
export const DEFAULT_TEXT = "#1c2233";
export const DEFAULT_CARD_BG = "#ffffff";

export const FONT_OPTIONS = [
  { value: "", label: "System default" },
  { value: "Inter, system-ui, sans-serif", label: "Inter" },
  { value: "Roboto, system-ui, sans-serif", label: "Roboto" },
  { value: "Open Sans, system-ui, sans-serif", label: "Open Sans" },
  { value: "Lato, system-ui, sans-serif", label: "Lato" },
  { value: "Montserrat, system-ui, sans-serif", label: "Montserrat" },
  { value: "Poppins, system-ui, sans-serif", label: "Poppins" },
  { value: "Nunito, system-ui, sans-serif", label: "Nunito" },
  { value: "Merriweather, Georgia, serif", label: "Merriweather (serif)" },
  { value: "Playfair Display, Georgia, serif", label: "Playfair Display (serif)" },
  { value: "Georgia, Times New Roman, serif", label: "Georgia (serif)" },
];

export function parseStyling(raw) {
  if (!raw) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) return raw;
  try {
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

export function buildTheme(config) {
  const form = config?.form || {};
  const kit = config?.brandKit || {};
  const hasKit = Boolean(kit?.id);

  const pick = (formVal, ...kitKeys) => {
    if (formVal) return formVal;
    if (hasKit) {
      for (const key of kitKeys) {
        if (kit[key]) return kit[key];
      }
    }
    return null;
  };

  return {
    primaryColor: pick(form.primaryColor, "primaryColor", "accentColor") || DEFAULT_PRIMARY,
    secondaryColor: pick(form.secondaryColor, "secondaryColor") || null,
    accentColor: pick(form.accentColor, "accentColor") || null,
    bgColor: pick(form.bgColor, "bgColor") || DEFAULT_BG,
    textColor: pick(form.textColor, "textColor") || DEFAULT_TEXT,
    fontFamily: pick(form.fontFamily, "fontFamily", "bodyFontFamily", "headingFontFamily") || undefined,
    logoUrl: pick(form.logoUrl, "logoUrl", "logoDarkUrl", "wordmarkUrl") || null,
    logoPlacement: form.logoPlacement || "top-center",
  };
}

export function getIdentityFields(form, styling) {
  const custom = Array.isArray(styling.identityFields) ? styling.identityFields : [];
  if (custom.length > 0) {
    return custom
      .filter((f) => f.enabled !== false)
      .map((f) => {
        if (f.id === "name") {
          return { ...f, required: form.nameRequired !== false };
        }
        if (f.id === "email") {
          return { ...f, required: form.emailRequired !== false };
        }
        if (f.id === "phone") {
          return { ...f, required: form.phoneRequired === true };
        }
        return f;
      });
  }

  const legacy = [];
  if (form.includeName)
    legacy.push({ id: "name", label: "Name", type: "text", required: form.nameRequired !== false });
  if (form.includeEmail)
    legacy.push({ id: "email", label: "Email", type: "email", required: form.emailRequired !== false });
  if (form.includePhone)
    legacy.push({ id: "phone", label: "Phone", type: "tel", required: form.phoneRequired === true });
  return legacy;
}

export function secondaryBtn(theme) {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "8px 14px",
    borderRadius: 8,
    border: `1px solid ${theme.primaryColor || DEFAULT_PRIMARY}`,
    background: "transparent",
    color: theme.primaryColor || DEFAULT_PRIMARY,
    fontWeight: 600,
    fontSize: 14,
    textDecoration: "none",
    cursor: "pointer",
  };
}
