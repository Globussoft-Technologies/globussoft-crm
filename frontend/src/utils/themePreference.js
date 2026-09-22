export const VALID_THEME_VALUES = new Set(["light", "dark", "system"]);

export function normalizeThemePreference(theme) {
  return VALID_THEME_VALUES.has(theme) ? theme : null;
}

// Resolve the theme we should actually apply.
//
// Priority:
//   1. Explicit server preference ("light" / "dark") wins.
//   2. Otherwise, keep any explicit local preference.
//   3. Fall back to "system".
export function resolveThemePreference(localTheme, serverTheme) {
  const explicitServerTheme = normalizeThemePreference(serverTheme);
  if (explicitServerTheme === "light" || explicitServerTheme === "dark") {
    return explicitServerTheme;
  }

  const explicitLocalTheme = normalizeThemePreference(localTheme);
  if (explicitLocalTheme === "light" || explicitLocalTheme === "dark") {
    return explicitLocalTheme;
  }

  return "system";
}
