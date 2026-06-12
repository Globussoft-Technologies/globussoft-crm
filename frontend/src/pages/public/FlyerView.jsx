/**
 * FlyerView.jsx — public customer-facing flyer landing
 * (PRD_TRAVEL_MARKETING_FLYER #908 slice S18 — `docs/TRAVEL_BIG_SCOPE_BACKLOG.md`).
 *
 * Per PRD FR-3.5.3 + FR-3.5.4 — the public read-only flyer view. Mirrors
 * slice C9's QuoteAcceptLanding shape (no-auth, calm-institutional voice,
 * theme-token-driven CTA) but stripped of the action surface — a flyer is
 * a one-way marketing artefact, not a transaction.
 *
 * URL: `/p/flyer/:slug?t=<jwt>[&embed=1][&format=<format>]`
 *
 * Wire:
 *   GET /api/v1/flyers/public/:slug/meta?t=<jwt>   → render header + chrome
 *   GET /api/v1/flyers/public/:slug?t=<jwt>&format=<f>
 *                                                   → load the binary asset
 *                                                     (PNG → <img>, PDF → <iframe>)
 *
 * Error-state mapping (mirror to backend envelope):
 *   404 FLYER_NOT_FOUND / FLYER_NOT_AVAILABLE  → "This flyer is no longer available"
 *   410 LINK_EXPIRED                            → "This flyer link has expired"
 *   401 INVALID_TOKEN / MISSING_TOKEN           → "Invalid share link"
 *   400 INVALID_FORMAT                          → "Format not supported"
 *
 * Theme + voice per CLAUDE.md standing rules:
 *   - Primary CTA uses var(--primary-color, var(--accent-color)) — wellness
 *     embedders won't render salmon.
 *   - Responsive grid via auto-fit minmax pattern; no media queries needed.
 *
 * Embed mode (?embed=1):
 *   - Hides the "Copy embed code" + "Download PDF" controls.
 *   - Hides the operator-facing card chrome.
 *   - Shows just the rendered flyer, full-bleed, so the iframe-hosting
 *     page sees only the flyer body. Useful when the operator drops the
 *     embed code into a partner site / a microsite.
 */

import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Download, Copy, AlertCircle, Check } from "lucide-react";

const FORMAT_LABELS = Object.freeze({
  "png-square": "Square (1200×1200)",
  "png-portrait-ig": "Portrait (1080×1920)",
  "png-landscape-fb": "Landscape (1920×1080)",
  "pdf-a4": "PDF A4",
  "pdf-a5": "PDF A5",
});

const DEFAULT_FORMAT = "png-square";
const ALLOWED_FORMATS = Object.keys(FORMAT_LABELS);

function isPdfFormat(fmt) {
  return typeof fmt === "string" && fmt.startsWith("pdf-");
}

function formatExpires(iso) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: "numeric", month: "long", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch { return String(iso); }
}

export default function FlyerView() {
  const { slug } = useParams();
  const [searchParams] = useSearchParams();
  const token = searchParams.get("t") || "";
  const isEmbed = searchParams.get("embed") === "1";
  const urlFormat = searchParams.get("format");

  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null); // { message, code, status }
  const [format, setFormat] = useState(
    ALLOWED_FORMATS.includes(urlFormat) ? urlFormat : DEFAULT_FORMAT,
  );
  const [copied, setCopied] = useState(false);

  // Build the asset URL once and memoize so <img>/<iframe> doesn't re-fetch
  // on every render. Includes the format so the backend renders the right
  // aspect.
  const assetUrl = useMemo(() => {
    if (!token || !slug) return null;
    const params = new URLSearchParams();
    params.set("t", token);
    params.set("format", format);
    if (isEmbed) params.set("embed", "1");
    return `/api/v1/flyers/public/${encodeURIComponent(slug)}?${params.toString()}`;
  }, [token, slug, format, isEmbed]);

  // Embed code surfaces in the operator-facing UI, NOT in embed mode. The
  // value is the iframe snippet the backend's POST /:id/share returns —
  // here we reconstruct it client-side so the page can ALSO surface a
  // "Copy embed code" affordance to a customer who's been forwarded the
  // share link and wants to drop it on their own site.
  const embedCode = useMemo(() => {
    if (!token || !slug) return "";
    const host = typeof window !== "undefined" ? window.location.host : "";
    const url = `https://${host}/p/flyer/${encodeURIComponent(slug)}?t=${encodeURIComponent(token)}&embed=1`;
    return `<iframe src="${url}" width="1200" height="1200" frameborder="0" allowfullscreen></iframe>`;
  }, [token, slug]);

  useEffect(() => {
    let cancelled = false;
    async function loadMeta() {
      setLoading(true);
      setError(null);
      if (!token) {
        setError({ message: "Invalid share link", code: "MISSING_TOKEN", status: 401 });
        setLoading(false);
        return;
      }
      try {
        const r = await fetch(
          `/api/v1/flyers/public/${encodeURIComponent(slug)}/meta?t=${encodeURIComponent(token)}${isEmbed ? "&embed=1" : ""}`,
        );
        if (cancelled) return;
        if (!r.ok) {
          let body = {};
          try { body = await r.json(); } catch { /* tolerate */ }
          let message;
          if (r.status === 410) message = "This flyer link has expired";
          else if (r.status === 401) message = "Invalid share link";
          else if (r.status === 404) message = "This flyer is no longer available";
          else message = body.error || "Could not load this flyer";
          setError({ message, code: body.code || `HTTP_${r.status}`, status: r.status });
          setLoading(false);
          return;
        }
        const body = await r.json();
        if (cancelled) return;
        setMeta(body);
        setLoading(false);
      } catch (_e) {
        if (cancelled) return;
        setError({
          message: "Could not load this flyer. Please try again later.",
          code: "NETWORK_ERROR",
        });
        setLoading(false);
      }
    }
    loadMeta();
    return () => { cancelled = true; };
  }, [slug, token, isEmbed]);

  async function copyEmbed() {
    try {
      if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(embedCode);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (_e) {
      // Clipboard API can fail in non-secure contexts — surface inline.
      setCopied(false);
    }
  }

  // -- Render --

  if (loading) {
    return (
      <div style={pageStyle}>
        <div style={cardStyle}>
          <p style={{ color: "var(--text-muted, #6b7280)" }}>Loading flyer…</p>
        </div>
      </div>
    );
  }

  if (error && !meta) {
    return (
      <div style={pageStyle}>
        <div style={cardStyle}>
          <AlertCircle size={32} color="var(--text-muted, #6b7280)" />
          <h1 style={headingStyle}>{error.message}</h1>
          <p style={{ color: "var(--text-muted, #6b7280)" }}>
            If you believe this is in error, please contact our team for a fresh link.
          </p>
        </div>
      </div>
    );
  }

  // Embed mode — minimal chrome, just the rendered flyer.
  if (isEmbed) {
    return (
      <div style={{ ...pageStyle, padding: 0, background: "transparent" }}>
        {isPdfFormat(format) ? (
          <iframe
            title={meta?.templateName || "Flyer"}
            src={assetUrl}
            style={{ width: "100%", height: "100vh", border: 0 }}
          />
        ) : (
          <img
            alt={meta?.templateName || "Flyer"}
            src={assetUrl}
            style={{ width: "100%", height: "auto", display: "block" }}
          />
        )}
      </div>
    );
  }

  // Full landing — header + flyer + share affordances.
  return (
    <div style={pageStyle}>
      <div style={{ ...cardStyle, textAlign: "left", maxWidth: 960 }}>
        <header style={{ marginBottom: 24 }}>
          <h1 style={{ ...headingStyle, textAlign: "left" }}>
            {meta?.templateName || "Travel flyer"}
          </h1>
          {meta?.brandName && (
            <p style={{ color: "var(--text-muted, #6b7280)", marginTop: 6 }}>
              From <strong>{meta.brandName}</strong>
              {meta.subBrand ? <> · {meta.subBrand.toUpperCase()}</> : null}
            </p>
          )}
          {meta?.expiresAt && (
            <p style={{ color: "var(--text-muted, #6b7280)", marginTop: 6, fontSize: 13 }}>
              Link valid until {formatExpires(meta.expiresAt)}
            </p>
          )}
        </header>

        <section
          aria-label="Flyer preview"
          style={{
            marginBottom: 24,
            background: "var(--bg-color, #f9fafb)",
            borderRadius: 12,
            padding: 16,
            display: "flex",
            justifyContent: "center",
          }}
        >
          {isPdfFormat(format) ? (
            <iframe
              title={meta?.templateName || "Flyer"}
              src={assetUrl}
              style={{ width: "100%", height: "75vh", border: 0, borderRadius: 8 }}
            />
          ) : (
            <img
              alt={meta?.templateName || "Flyer"}
              src={assetUrl}
              style={{ maxWidth: "100%", height: "auto", borderRadius: 8 }}
            />
          )}
        </section>

        <section style={formatRowStyle} aria-label="Format selector">
          <label style={{ ...labelStyle, marginTop: 0 }}>
            Format
            <select
              value={format}
              onChange={(e) => setFormat(e.target.value)}
              style={selectStyle}
              aria-label="Pick a flyer format"
            >
              {ALLOWED_FORMATS.map((f) => (
                <option key={f} value={f}>{FORMAT_LABELS[f]}</option>
              ))}
            </select>
          </label>
        </section>

        <section style={actionRowStyle} aria-label="Share actions">
          <a
            href={assetUrl}
            download={`${meta?.templateName ? meta.templateName.replace(/[^a-z0-9]+/gi, "-").toLowerCase() : "flyer"}.${isPdfFormat(format) ? "pdf" : "png"}`}
            style={primaryBtnStyle}
            aria-label="Download flyer"
          >
            <Download size={18} /> Download {isPdfFormat(format) ? "PDF" : "image"}
          </a>
          <button
            type="button"
            style={secondaryBtnStyle}
            onClick={copyEmbed}
            aria-label={copied ? "Copied" : "Copy embed code"}
          >
            {copied ? <Check size={18} /> : <Copy size={18} />}
            {copied ? "Copied" : "Copy embed code"}
          </button>
        </section>

        {copied && (
          <p
            role="status"
            style={{ color: "var(--text-muted, #6b7280)", marginTop: 12, fontSize: 13 }}
          >
            Paste this iframe snippet into your own website to embed the flyer.
          </p>
        )}
      </div>
    </div>
  );
}

// ─── styles ───────────────────────────────────────────────
const pageStyle = {
  minHeight: "100vh",
  background: "var(--bg-color, #f9fafb)",
  padding: "32px 16px",
  display: "flex",
  justifyContent: "center",
};

const cardStyle = {
  maxWidth: 720,
  width: "100%",
  background: "var(--card-bg, #fff)",
  borderRadius: 16,
  padding: 32,
  boxShadow: "0 4px 14px rgba(0,0,0,0.06)",
  textAlign: "center",
};

const headingStyle = {
  fontSize: 28,
  fontWeight: 700,
  margin: 0,
  color: "var(--text-color, #111827)",
};

const formatRowStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 240px), 1fr))",
  gap: 12,
  marginBottom: 20,
};

const actionRowStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))",
  gap: 12,
};

const labelStyle = {
  display: "block",
  marginTop: 12,
  fontSize: 14,
  color: "var(--text-color, #111827)",
};

const selectStyle = {
  display: "block",
  width: "100%",
  marginTop: 6,
  padding: "10px 12px",
  border: "1px solid var(--border-color, #d1d5db)",
  borderRadius: 8,
  fontSize: 14,
  background: "var(--card-bg, #fff)",
  color: "var(--text-color, #111827)",
  boxSizing: "border-box",
};

const primaryBtnStyle = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  padding: "12px 20px",
  background: "var(--primary-color, var(--accent-color, #2563eb))",
  color: "#fff",
  border: "none",
  borderRadius: 8,
  fontWeight: 600,
  cursor: "pointer",
  textDecoration: "none",
};

const secondaryBtnStyle = {
  ...primaryBtnStyle,
  background: "var(--card-bg, #fff)",
  color: "var(--primary-color, var(--accent-color, #2563eb))",
  border: "1px solid var(--primary-color, var(--accent-color, #2563eb))",
};
