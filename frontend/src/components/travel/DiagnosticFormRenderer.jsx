// Shared diagnostic form renderer (Travel CRM v3.9.4).
//
// Used by:
//   * Public form page  (/diagnostic-form/:tenantSlug/:subBrand)
//   * Admin preview      (DiagnosticPublicFormPanel)
//   * Public report page (lightweight theme wrapper)
//
// This component is the single source of truth for how a branded diagnostic
// form looks. Both live and preview modes use the exact same layout + styles
// so the admin preview is trustworthy.

import { Send, Loader2, AlertCircle } from "lucide-react";
import {
  DEFAULT_PRIMARY,
  DEFAULT_BG,
  DEFAULT_TEXT,
  DEFAULT_CARD_BG,
  parseStyling,
  buildTheme,
  getIdentityFields,
  secondaryBtn,
} from "./diagnosticFormTheme";

export default function DiagnosticFormRenderer({
  config,
  questions = [],
  answers = {},
  identity = {},
  onAnswerChange,
  onToggleMulti,
  onIdentityChange,
  onSubmit,
  submitting = false,
  submitError = "",
  submitLabel = "See my diagnostic result",
  mode = "live", // "live" | "preview"
  preview = false,
}) {
  const theme = buildTheme(config);
  const styling = parseStyling(config?.form?.stylingConfigJson);
  const form = config?.form || {};
  const identityFields = getIdentityFields(form, styling);

  const showLogo = Boolean(theme.logoUrl);
  const showHeader = Boolean(form.headerHtml || form.title || form.subtitle);

  return (
    <Shell theme={theme} styling={styling} preview={preview}>
      <div style={card(theme, styling)}>
        {showLogo && renderLogo(theme, styling)}
        {showHeader && (
          <header style={headerWrap(styling)}>
            {form.title && <h1 style={title(theme, styling)}>{form.title}</h1>}
            {form.subtitle && <p style={subtitle(theme, styling)}>{form.subtitle}</p>}
            {form.headerHtml && (
              <div
                style={headerHtml(styling)}
                dangerouslySetInnerHTML={{ __html: form.headerHtml }}
              />
            )}
          </header>
        )}

        {questions.map((q) => (
          <QuestionBlock
            key={q.id}
            question={q}
            value={answers[q.id]}
            onChange={mode === "preview" ? undefined : (v) => onAnswerChange?.(q.id, v)}
            onToggleMulti={mode === "preview" ? undefined : (v, max) => onToggleMulti?.(q.id, v, max)}
            theme={theme}
            styling={styling}
            mode={mode}
          />
        ))}

        {identityFields.length > 0 && (
          <IdentityFields
            fields={identityFields}
            identity={identity}
            onChange={mode === "preview" ? undefined : onIdentityChange}
            theme={theme}
            styling={styling}
          />
        )}

        {submitError && mode !== "preview" && (
          <div style={errorBox}>
            <AlertCircle size={18} />
            <span>{submitError}</span>
          </div>
        )}

        <button
          type="button"
          onClick={mode === "preview" ? undefined : onSubmit}
          disabled={submitting || mode === "preview"}
          style={primaryBtn(theme, styling, submitting || mode === "preview")}
        >
          {submitting ? (
            <>
              <Loader2 size={16} aria-hidden style={{ animation: "spin 1s linear infinite" }} />
              Analyzing your curriculum needs
            </>
          ) : (
            <>
              <Send size={16} aria-hidden />
              {submitLabel}
            </>
          )}
        </button>

        {form.footerHtml && (
          <footer
            style={footerHtml(styling)}
            dangerouslySetInnerHTML={{ __html: form.footerHtml }}
          />
        )}
      </div>
    </Shell>
  );
}

export function DiagnosticFormLoading({ config }) {
  const theme = buildTheme(config);
  const styling = parseStyling(config?.form?.stylingConfigJson);
  return (
    <Shell theme={theme} styling={styling}>
      <div style={card(theme, styling)}>
        <div style={centerMsg(theme)}>
          <Loader2 size={28} style={{ animation: "spin 1s linear infinite" }} />
          <span>Loading form…</span>
        </div>
      </div>
    </Shell>
  );
}

export function DiagnosticFormError({ config, error, onBack }) {
  const theme = buildTheme(config);
  const styling = parseStyling(config?.form?.stylingConfigJson);
  return (
    <Shell theme={theme} styling={styling}>
      <div style={card(theme, styling)}>
        <div style={errorBox}>
          <AlertCircle size={22} />
          <span>{error}</span>
        </div>
        {onBack && (
          <button type="button" onClick={onBack} style={secondaryBtn(theme)}>
            Back to form
          </button>
        )}
      </div>
    </Shell>
  );
}

function QuestionBlock({ question, value, onChange, onToggleMulti, theme, styling, mode }) {
  const q = question;
  const opts = Array.isArray(q.options) ? q.options : [];
  const cardStyle = questionCard(styling, theme);

  return (
    <fieldset style={cardStyle}>
      <legend style={legend(theme, styling)}>
        <span style={{ display: "block", padding: "0 4px" }}>
          {q.text}
          {q.required && <span aria-hidden="true"> *</span>}
        </span>
      </legend>
      {q.type === "multi-select" ? (
        <div style={optionsGrid}>
          {opts.map((o) => {
            const cur = Array.isArray(value) ? value : [];
            const checked = cur.includes(o.value);
            return (
              <label
                key={o.value}
                style={optionRow(theme, checked)}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  readOnly={mode === "preview"}
                  onChange={mode === "preview" ? undefined : () => onToggleMulti(o.value, q.max)}
                  style={{ marginRight: 10 }}
                />
                {o.label}
              </label>
            );
          })}
        </div>
      ) : (
        <div style={optionsGrid}>
          {opts.map((o) => {
            const checked = value === o.value;
            return (
              <label
                key={o.value}
                style={optionRow(theme, checked)}
              >
                <input
                  type="radio"
                  name={q.id}
                  checked={checked}
                  readOnly={mode === "preview"}
                  onChange={mode === "preview" ? undefined : () => onChange(o.value)}
                  style={{ marginRight: 10 }}
                />
                {o.label}
              </label>
            );
          })}
        </div>
      )}
    </fieldset>
  );
}

function IdentityFields({ fields, identity, onChange, theme, styling }) {
  return (
    <div style={identityGrid}>
      {fields.map((f) => (
        <label key={f.id} style={fieldLabel(theme)}>
          <span>
            {f.label}
            {f.required && " *"}
          </span>
          <input
            type={f.type || "text"}
            value={identity[f.id] || ""}
            onChange={onChange ? (e) => onChange({ ...identity, [f.id]: e.target.value }) : undefined}
            readOnly={!onChange}
            style={input(theme, styling)}
            required={f.required}
            placeholder={f.placeholder || ""}
          />
        </label>
      ))}
    </div>
  );
}

function renderLogo(theme, styling) {
  const placement = theme.logoPlacement || "top-center";
  const logoSize = normalizeLogoSize(styling.logoSize ?? styling.logoMaxHeight);
  const align =
    placement === "top-left"
      ? "flex-start"
      : placement === "top-right"
        ? "flex-end"
        : "center";
  return (
    <div style={{ display: "flex", justifyContent: align, marginBottom: 18 }}>
      <img
        src={theme.logoUrl}
        alt=""
        style={{
          width: `min(${logoSize}px, 100%)`,
          height: "auto",
          maxWidth: styling.logoMaxWidth ? `${styling.logoMaxWidth}px` : "100%",
          objectFit: "contain",
          display: "block",
        }}
      />
    </div>
  );
}

function normalizeLogoSize(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 64;
  return Math.min(240, Math.max(24, n));
}

function Shell({ theme, styling, children, preview }) {
  const normalizedBgUrl = normalizeImageUrl(styling.bgImageUrl);
  const bgImage = normalizedBgUrl ? { backgroundImage: `url("${normalizedBgUrl}")` } : {};
  const overlayOpacity = styling.bgOverlayOpacity ?? 0;
  const overlayColor = styling.bgOverlayColor || "#000000";

  return (
    <div
      style={{
        minHeight: preview ? 420 : "100vh",
        background: theme.bgColor || DEFAULT_BG,
        color: theme.textColor || DEFAULT_TEXT,
        fontFamily: theme.fontFamily || "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
        padding: "24px 16px",
        boxSizing: "border-box",
        backgroundSize: normalizeBackgroundSize(styling.bgImageSize),
        backgroundPosition: styling.bgImagePosition || "center",
        backgroundRepeat: styling.bgImageRepeat || "no-repeat",
        ...bgImage,
        position: "relative",
      }}
    >
      {styling.bgImageUrl && overlayOpacity > 0 && (
        <div
          style={{
            position: preview ? "absolute" : "fixed",
            inset: 0,
            backgroundColor: overlayColor,
            opacity: overlayOpacity,
            zIndex: 0,
            pointerEvents: "none",
          }}
        />
      )}
      <div style={{ position: "relative", zIndex: 1 }}>{children}</div>
    </div>
  );
}

function card(theme, styling) {
  const formOpacity = clamp01(styling.formBgOpacity ?? 1);
  const cardBg = withOpacity(styling.formBgColor || DEFAULT_CARD_BG, formOpacity);
  return {
    maxWidth: styling.formMaxWidth ? `${styling.formMaxWidth}px` : "760px",
    margin: "0 auto",
    background: cardBg,
    backdropFilter: formOpacity < 1 ? "blur(18px) saturate(1.2)" : undefined,
    WebkitBackdropFilter: formOpacity < 1 ? "blur(18px) saturate(1.2)" : undefined,
    borderRadius: styling.formBorderRadius ?? 16,
    padding: styling.formPadding ? `${styling.formPadding}px` : "28px",
    boxShadow:
      (styling.formShadow || "md") === "none"
        ? "none"
        : (styling.formShadow || "md") === "sm"
          ? "0 2px 8px rgba(0,0,0,0.06)"
          : (styling.formShadow || "md") === "lg"
            ? "0 16px 48px rgba(18,38,71,0.12)"
            : "0 8px 32px rgba(18,38,71,0.08)",
    border: "1px solid rgba(0,0,0,0.06)",
  };
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(1, Math.max(0, n));
}

function withOpacity(color, opacity) {
  if (opacity >= 1) return color;
  const hex = String(color || "").trim();
  const short = hex.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (short) {
    const r = parseInt(short[1] + short[1], 16);
    const g = parseInt(short[2] + short[2], 16);
    const b = parseInt(short[3] + short[3], 16);
    return `rgba(${r}, ${g}, ${b}, ${opacity})`;
  }
  const full = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (full) {
    const r = parseInt(full[1], 16);
    const g = parseInt(full[2], 16);
    const b = parseInt(full[3], 16);
    return `rgba(${r}, ${g}, ${b}, ${opacity})`;
  }
  return color;
}

function headerWrap() {
  return {
    marginBottom: 24,
  };
}

function title(theme, styling) {
  return {
    margin: "0 0 8px",
    fontSize: styling.titleFontSize ? `${styling.titleFontSize}px` : 24,
    color: theme.textColor || DEFAULT_TEXT,
    lineHeight: 1.25,
    textAlign: styling.titleAlign || "left",
  };
}

function subtitle(theme, styling) {
  return {
    margin: "0 0 12px",
    fontSize: styling.subtitleFontSize ? `${styling.subtitleFontSize}px` : 15,
    lineHeight: 1.5,
    color: theme.textColor || DEFAULT_TEXT,
    opacity: 0.8,
    textAlign: styling.subtitleAlign || styling.titleAlign || "left",
  };
}

function headerHtml(styling) {
  return { marginTop: 12, textAlign: styling.headerAlign || "left" };
}

function footerHtml(styling) {
  return { marginTop: 24, fontSize: 13, opacity: 0.8, textAlign: styling.footerAlign || "left" };
}

function questionCard(styling, theme) {
  const style = styling.questionCardStyle || "bordered";
  const fillColor = styling.questionFillColor || theme.primaryColor || DEFAULT_PRIMARY;
  const fillOpacity = clamp01(styling.questionFillOpacity ?? 0.06);
  const borderOpacity = clamp01(styling.questionBorderOpacity ?? 0.2);
  return {
    border:
      style === "plain"
        ? "none"
        : `1px solid ${withOpacity(styling.questionBorderColor || theme.primaryColor || DEFAULT_PRIMARY, borderOpacity)}`,
    borderRadius: styling.questionBorderRadius ?? 12,
    padding: "22px 18px 20px",
    margin: "0 0 16px",
    background: style === "filled" ? withOpacity(fillColor, fillOpacity) : "transparent",
  };
}

function normalizeBackgroundSize(value) {
  if (!value) return "cover";
  const raw = String(value).trim();
  if (["cover", "contain", "auto"].includes(raw)) return raw;
  const heightMatch = raw.match(/^auto\s+(\d+(?:\.\d+)?)%$/);
  if (heightMatch) {
    const size = Math.min(300, Math.max(10, Number(heightMatch[1])));
    return `auto ${size}%`;
  }
  const match = raw.match(/^(\d+(?:\.\d+)?)%/);
  if (!match) return "cover";
  const size = Math.min(300, Math.max(10, Number(match[1])));
  return size < 100 ? "cover" : `${size}% auto`;
}

function normalizeImageUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.hostname === "unsplash.com" && url.pathname.startsWith("/photos/")) {
      const photoId = url.pathname.split("/").filter(Boolean).pop();
      if (photoId) return `https://source.unsplash.com/${photoId}/1800x1200`;
    }
  } catch {
    return raw;
  }
  return raw;
}

function legend(theme) {
  return {
    fontWeight: 600,
    fontSize: 15,
    color: theme.textColor || DEFAULT_TEXT,
    padding: "0 8px",
    marginLeft: 4,
    width: "auto",
  };
}

const optionsGrid = {
  display: "grid",
  gap: 8,
  marginTop: 8,
};

function optionRow(theme, checked) {
  const primary = theme.primaryColor || DEFAULT_PRIMARY;
  return {
    display: "flex",
    alignItems: "center",
    padding: "12px 14px",
    borderRadius: 8,
    border: `1px solid ${checked ? primary : "#dadfe8"}`,
    background: checked ? `${primary}10` : "#fff",
    cursor: "pointer",
    fontSize: 14,
    transition: "border-color 0.15s, background 0.15s",
    color: theme.textColor || DEFAULT_TEXT,
  };
}

const identityGrid = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))",
  gap: 14,
  marginTop: 8,
  marginBottom: 18,
};

function fieldLabel(theme) {
  return {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    fontSize: 13,
    fontWeight: 600,
    color: theme.textColor || DEFAULT_TEXT,
  };
}

function input(theme, styling) {
  return {
    padding: "10px 12px",
    borderRadius: styling.formBorderRadius ? `${Math.min(styling.formBorderRadius, 12)}px` : 8,
    border: "1px solid #dadfe8",
    fontSize: 14,
    fontFamily: "inherit",
    background: "#fff",
    color: theme.textColor || DEFAULT_TEXT,
  };
}

function primaryBtn(theme, styling, disabled) {
  const shape = styling.buttonShape || "rounded";
  const radius =
    shape === "pill"
      ? 999
      : styling.buttonBorderRadius ?? (shape === "square" ? 0 : 8);
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "12px 24px",
    background: theme.primaryColor || DEFAULT_PRIMARY,
    color: "#fff",
    border: "none",
    borderRadius: radius,
    fontSize: 15,
    fontWeight: 600,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.65 : 1,
  };
}

const errorBox = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "12px 14px",
  background: "#fdecec",
  border: "1px solid #f5b5b5",
  color: "#7a1f1f",
  borderRadius: 8,
  marginBottom: 16,
  fontSize: 14,
};

function centerMsg(theme) {
  return {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    padding: "48px 20px",
    fontSize: 14,
    color: theme.textColor || DEFAULT_TEXT,
  };
}
