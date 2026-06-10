export const modalInputStyle = {
  width: "100%",
  padding: "0.6rem 0.8rem",
  // Theme-adaptive: surface-color is white in light wellness, dark-teal-tint
  // in dark wellness. Border picks the same adaptive token. The wellness
  // theme also has an `[data-vertical="wellness"] input { ... !important }`
  // rule that wins anyway, but we keep the inline values sane for both
  // themes + generic vertical.
  background: "var(--surface-color, #fff)",
  border: "1px solid var(--border-color, rgba(0,0,0,0.12))",
  borderRadius: 8,
  color: "var(--text-primary)",
  fontSize: "0.92rem",
  outline: "none",
  boxSizing: "border-box",
};

export const iconBtnSmall = {
  background: "var(--subtle-bg, rgba(0,0,0,0.04))",
  border: "1px solid var(--border-color, rgba(0,0,0,0.12))",
  borderRadius: 6,
  color: "var(--text-secondary)",
  cursor: "pointer",
  padding: "0.25rem 0.4rem",
  display: "inline-flex",
  alignItems: "center",
  flexShrink: 0,
  fontSize: "0.8rem",
};

export const filterLabelStyle = {
  fontSize: "0.75rem",
  fontWeight: 600,
  color: "var(--text-secondary)",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  marginBottom: "0.5rem",
  display: "inline-flex",
  alignItems: "center",
};

export const paginationBtn = (disabled) => ({
  display: "flex",
  alignItems: "center",
  gap: "0.25rem",
  padding: "0.5rem 1rem",
  background: disabled ? "transparent" : "var(--subtle-bg, rgba(0,0,0,0.04))",
  border: "1px solid var(--border-color, rgba(0,0,0,0.12))",
  borderRadius: 8,
  cursor: disabled ? "not-allowed" : "pointer",
  color: disabled ? "var(--text-secondary)" : "var(--text-primary)",
  fontSize: "0.85rem",
  opacity: disabled ? 0.5 : 1,
});

export const bulkBtnStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.3rem",
  padding: "0.4rem 0.75rem",
  background: "var(--subtle-bg, rgba(0,0,0,0.04))",
  border: "1px solid var(--border-color, rgba(0,0,0,0.12))",
  borderRadius: 8,
  color: "var(--text-primary)",
  cursor: "pointer",
  fontSize: "0.85rem",
};

export const tagChipStyle = (colour) => ({
  display: "inline-flex",
  alignItems: "center",
  gap: "0.2rem",
  padding: "0.15rem 0.45rem",
  borderRadius: 999,
  background: `${colour}33`,
  color: "var(--text-primary)",
  border: `1px solid ${colour}66`,
  fontSize: "0.75rem",
  whiteSpace: "nowrap",
});

export const inRowChipBtnStyle = (colour, isSelected) => ({
  display: "inline-flex",
  alignItems: "center",
  gap: "0.25rem",
  padding: isSelected ? "0.15rem 0.5rem" : "0.15rem 0.45rem",
  borderRadius: 999,
  background: isSelected ? `${colour}66` : `${colour}22`,
  color: "var(--text-primary)",
  border: isSelected ? `2px solid ${colour}` : `1px solid ${colour}55`,
  fontSize: "0.75rem",
  fontWeight: isSelected ? 600 : 400,
  whiteSpace: "nowrap",
  cursor: "pointer",
  outline: "none",
  transition: "background 0.12s ease, border-color 0.12s ease",
});

export const chipRemoveStyle = {
  background: "transparent",
  border: "none",
  color: "inherit",
  cursor: "pointer",
  padding: 0,
  display: "inline-flex",
  alignItems: "center",
  opacity: 0.7,
};

export const overflowChipStyle = {
  display: "inline-flex",
  alignItems: "center",
  padding: "0.15rem 0.45rem",
  borderRadius: 999,
  background: "var(--subtle-bg, rgba(0,0,0,0.06))",
  color: "var(--text-secondary)",
  fontSize: "0.75rem",
  cursor: "default",
};

export const tagPopoverStyle = {
  position: "absolute",
  top: "100%",
  left: 0,
  marginTop: 6,
  zIndex: 200,
  minWidth: 220,
  // --bg-color (not --surface-color) — see comment on the MultiSelect
  // dropdown popover: --surface-color is translucent in dark wellness.
  background: "var(--bg-color, #fff)",
  border: "1px solid var(--border-color, rgba(0,0,0,0.18))",
  borderRadius: 10,
  boxShadow: "var(--shadow-lg, 0 12px 32px rgba(0,0,0,0.25))",
};

export const tagOptionStyle = {
  width: "100%",
  textAlign: "left",
  padding: "0.4rem 0.6rem",
  border: "none",
  background: "transparent",
  cursor: "pointer",
  color: "var(--text-primary)",
  fontSize: "0.85rem",
  borderRadius: 6,
};

export const dropdownMenuStyle = {
  position: "absolute",
  top: "calc(100% + 4px)",
  right: 0,
  minWidth: 160,
  // --bg-color: opaque in both themes (--surface-color is translucent
  // in dark wellness, which makes menu items hard to read).
  background: "var(--bg-color, #fff)",
  border: "1px solid var(--border-color, rgba(0,0,0,0.18))",
  borderRadius: 8,
  boxShadow: "var(--shadow-lg, 0 12px 32px rgba(0,0,0,0.25))",
  padding: "0.25rem",
  zIndex: 100,
  display: "flex",
  flexDirection: "column",
};

export const dropdownItemStyle = {
  textAlign: "left",
  padding: "0.5rem 0.75rem",
  background: "transparent",
  color: "var(--text-primary, inherit)",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: "0.85rem",
};

// ── Primary (teal) dropdown button styles ──────────────────────────
// Per the wellness-theme standing rule, primary CTAs read from
// --primary-color (teal in wellness; falls back to --accent-color in
// generic). This keeps the "Add" button on-brand in both verticals.
export const primaryTealBtn = {
  display: "flex",
  alignItems: "center",
  gap: "0.3rem",
  padding: "0.5rem 1rem",
  background: "var(--primary-color, var(--accent-color))",
  color: "#fff",
  border: "none",
  borderRadius: 8,
  cursor: "pointer",
  fontWeight: 500,
};

export const primaryMenuStyle = {
  position: "absolute",
  top: "calc(100% + 6px)",
  right: 0,
  minWidth: 240,
  // --bg-color: opaque in both themes (--surface-color is translucent
  // in dark wellness, which makes "New patient" / "Bulk tag" items
  // hard to read against the page behind them).
  background: "var(--bg-color, #fff)",
  border: "1px solid var(--border-color, rgba(0,0,0,0.18))",
  borderRadius: 10,
  boxShadow: "var(--shadow-lg, 0 12px 32px rgba(0,0,0,0.25))",
  padding: "0.4rem",
  zIndex: 200,
  display: "flex",
  flexDirection: "column",
  gap: "0.15rem",
};

export const primaryMenuItem = {
  display: "flex",
  alignItems: "center",
  gap: "0.6rem",
  textAlign: "left",
  padding: "0.55rem 0.7rem",
  background: "transparent",
  color: "var(--text-primary)",
  border: "none",
  borderRadius: 8,
  cursor: "pointer",
};
