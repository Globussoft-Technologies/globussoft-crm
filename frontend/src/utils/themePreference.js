export const VALID_THEME_VALUES = new Set(["light", "dark", "system"]);

export function normalizeThemePreference(theme) {
  return VALID_THEME_VALUES.has(theme) ? theme : null;
}

// Resolve the theme we should actually apply.
//
// Priority:
//   1. Keep the explicit browser preference selected by the user.
//   2. Use the server preference only when there is no explicit local choice.
//   3. Fall back to "system".
export function resolveThemePreference(localTheme, serverTheme) {
  const explicitLocalTheme = normalizeThemePreference(localTheme);
  if (explicitLocalTheme === "light" || explicitLocalTheme === "dark") {
    return explicitLocalTheme;
  }

  const explicitServerTheme = normalizeThemePreference(serverTheme);
  if (explicitServerTheme === "light" || explicitServerTheme === "dark") {
    return explicitServerTheme;
  }

  return "system";
}
