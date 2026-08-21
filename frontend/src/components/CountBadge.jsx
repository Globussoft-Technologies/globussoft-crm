function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toTitleCase(value) {
  return String(value)
    .toLowerCase()
    .replace(/\b([a-z])/g, (_, char) => char.toUpperCase());
}

function deriveVisibleLabel({ countText, title, ariaLabel }) {
  const source = [title, ariaLabel].find(
    (value) => typeof value === "string" && value.trim(),
  );
  if (!source) return "";

  const normalized = source.trim().replace(/\s+/g, " ");
  if (normalized === countText) return "";

  const countPrefix = new RegExp(
    `^${escapeRegExp(countText)}(?:\\s*[-:|/]\\s*|\\s+)?`,
    "u",
  );
  let stripped = normalized.replace(countPrefix, "").trim();
  if (!stripped) return "";

  stripped = stripped.replace(/\s+in view$/i, "").trim();
  stripped = stripped.replace(/[\s\u2013\u2014:|/-]+$/u, "").trim();
  if (!stripped) return "";

  const titleCased = toTitleCase(stripped);
  return /^total\b/i.test(titleCased) ? titleCased : `Total ${titleCased}`;
}

const CountBadge = ({ count, className, style, title, ariaLabel }) => {
  const numericCount = Number(count);
  const safeCount = Number.isFinite(numericCount) ? numericCount : 0;
  const countText = safeCount.toLocaleString();
  const visibleLabel = deriveVisibleLabel({ countText, title, ariaLabel });
  const label = ariaLabel || (visibleLabel ? `${countText} ${visibleLabel}` : `${countText} total`);

  return (
    <span
      className={className}
      aria-label={label}
      title={label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: visibleLabel ? "0.4rem" : 0,
        padding: visibleLabel ? "0.35rem 0.8rem 0.35rem 0.55rem" : "0 0.75rem",
        minWidth: visibleLabel ? "auto" : 30,
        minHeight: 30,
        borderRadius: 999,
        boxSizing: "border-box",
        fontSize: "0.82rem",
        fontWeight: 700,
        letterSpacing: "0.02em",
        lineHeight: 1,
        whiteSpace: "nowrap",
        background: "var(--page-header-count-bg, rgba(18, 38, 71, 0.08))",
        color:
          "var(--page-header-count-text, var(--primary-color, var(--accent-color)))",
        border: "1px solid var(--page-header-count-border, transparent)",
        flexShrink: 0,
        alignSelf: "center",
        ...style,
      }}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {countText}
      </span>
      {visibleLabel && " "}
      {visibleLabel && (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            fontSize: "0.76rem",
            fontWeight: 600,
            letterSpacing: "0.01em",
            color: "inherit",
          }}
        >
          {visibleLabel}
        </span>
      )}
    </span>
  );
};

export default CountBadge;
