// Public branded diagnostic report for Travel CRM (v3.9.4).
//
// Lives at /diagnostic-form/:tenantSlug/:subBrand/report/:slug (no auth).
// Loads the diagnostic payload from the public report endpoint, renders the
// score/classification, RAG recommendations, and a PDF download link.
// Reuses the brand kit/theme from the linked public form config.

import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { Download, AlertCircle, Loader2, CheckCircle2 } from "lucide-react";
import {
  buildTheme,
  parseStyling,
  DEFAULT_PRIMARY,
  DEFAULT_BG,
  DEFAULT_TEXT,
} from "../../components/travel/diagnosticFormTheme";

export default function TravelDiagnosticPublicReport() {
  const { tenantSlug, subBrand, slug } = useParams();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [data, setData] = useState(null);
  const [theme, setTheme] = useState({});
  const [styling, setStyling] = useState({});

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError("");
      try {
        // Load report data and form theme in parallel.
        const [reportRes, formRes] = await Promise.all([
          fetch(
            `/api/travel/diagnostics/public/report/${encodeURIComponent(
              slug || "",
            )}`,
          ),
          fetch(
            `/api/travel/diagnostics/public/form/${encodeURIComponent(
              tenantSlug || "",
            )}/${encodeURIComponent(subBrand || "")}`,
          ).catch(() => null),
        ]);
        if (!reportRes.ok) {
          const body = await reportRes.json().catch(() => ({}));
          throw new Error(
            body.error || "This diagnostic report is not available right now.",
          );
        }
        const report = await reportRes.json();
        let formTheme = {};
        let formStyling = {};
        if (formRes && formRes.ok) {
          const formData = await formRes.json();
          formTheme = buildTheme(formData);
          formStyling = parseStyling(formData?.form?.stylingConfigJson);
        }
        if (cancelled) return;
        setData(report);
        setTheme(formTheme);
        setStyling(formStyling);
      } catch (e) {
        if (!cancelled) setError(e.message || "Failed to load report");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [tenantSlug, subBrand, slug]);

  if (loading) {
    return (
      <Shell theme={theme} styling={styling}>
        <div style={centerMsg}>
          <Loader2 size={28} style={{ animation: "spin 1s linear infinite" }} />
          <span>Loading your diagnostic report…</span>
        </div>
      </Shell>
    );
  }

  if (error) {
    return (
      <Shell theme={theme} styling={styling}>
        <div style={card(styling)}>
          <div style={errorBox}>
            <AlertCircle size={22} />
            <span>{error}</span>
          </div>
          <Link
            to={`/diagnostic-form/${encodeURIComponent(tenantSlug || "")}/${encodeURIComponent(
              subBrand || "",
            )}`}
            style={secondaryBtn(theme)}
          >
            Back to form
          </Link>
        </div>
      </Shell>
    );
  }

  const READINESS_NAMES = {
    1: "Curriculum-Aligned & Outcome-Focused",
    2: "Engagement-Focused & Experience-Driven",
    3: "Exploration-Ready & Value-Conscious",
    4: "Custom Support Recommended",
  };

  function resolveReadiness() {
    // Prefer the API's explicit top-level readiness fields.
    if (data?.readinessLevel >= 1 && data?.readinessLevel <= 4) {
      return {
        level: data.readinessLevel,
        name: data.readinessName || READINESS_NAMES[data.readinessLevel],
      };
    }
    // Next, prefer the RAG result's explicit 1-4 level + name.
    const rag = data?.ragResult?.recommendations || {};
    if (rag.readinessLevel >= 1 && rag.readinessLevel <= 4) {
      return {
        level: rag.readinessLevel,
        name: rag.readinessName || READINESS_NAMES[rag.readinessLevel],
      };
    }
    // Fall back to the server-side scoring classification (level_1 .. level_4).
    const cls = String(data?.classification || "").replace(/^level_/, "");
    const n = Number(cls);
    if (n >= 1 && n <= 4) {
      return { level: n, name: data?.classificationLabel || READINESS_NAMES[n] };
    }
    // Final fallback from legacy 0-10 readiness score.
    const score = data?.ragResult?.readinessScore ?? rag?.readinessScore ?? null;
    if (score !== null) {
      if (score >= 7.5) return { level: 1, name: READINESS_NAMES[1] };
      if (score >= 5.5) return { level: 2, name: READINESS_NAMES[2] };
      if (score >= 3.5) return { level: 3, name: READINESS_NAMES[3] };
      return { level: 4, name: READINESS_NAMES[4] };
    }
    return null;
  }

  const rag = data?.ragResult?.recommendations || {};
  const trips = Array.isArray(rag.recommendedTrips) ? rag.recommendedTrips : [];
  const readiness = resolveReadiness();
  const summary = rag.summary || "";
  // Deterministic curriculum × grade × subject matches from
  // travelDiagnosticCurriculumFit.js — computed and persisted at submit
  // time, always present when a mapping exists, independent of whether the
  // LLM-backed RAG pipeline (the `trips` section above) returned anything.
  // Previously computed by the backend but never rendered anywhere in this
  // report — this section was simply missing.
  const curriculumFitRecs = Array.isArray(data?.curriculumFit?.recommendations)
    ? data.curriculumFit.recommendations
    : [];

  return (
    <Shell theme={theme} styling={styling}>
      <div style={card(styling)}>
        {theme.logoUrl && (
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 18 }}>
            <img
              src={theme.logoUrl}
              alt=""
              style={{ maxHeight: 64, maxWidth: "100%", objectFit: "contain" }}
            />
          </div>
        )}

        <header style={{ marginBottom: 24, textAlign: "center" }}>
          <h1 style={title(theme)}>Your diagnostic result</h1>
          {data?.classificationLabel && (
            <div style={classificationBadge(theme)}>
              {data.classificationLabel}
            </div>
          )}
          {data?.recommendedTier && (
            <p style={{ margin: "8px 0 0", fontSize: 14, opacity: 0.8 }}>
              Recommended tier: <strong>{data.recommendedTier}</strong>
            </p>
          )}
        </header>

        {readiness && (
          <section style={section(theme)}>
            <h2 style={sectionTitle(theme)}>Readiness level</h2>
            <div style={scoreRing(theme)}>
              <span style={scoreNumber(theme)}>{readiness.level}</span>
              <span style={{ fontSize: 13, opacity: 0.8 }}>/ 4</span>
            </div>
            <div style={{ marginTop: 10, fontWeight: 600, fontSize: 15 }}>
              {readiness.name}
            </div>
          </section>
        )}

        {summary && (
          <section style={section(theme)}>
            <h2 style={sectionTitle(theme)}>Summary</h2>
            <p style={{ lineHeight: 1.6, margin: 0 }}>{summary}</p>
          </section>
        )}

        {curriculumFitRecs.length > 0 && (
          <section style={section(theme)}>
            <h2 style={sectionTitle(theme)}>Recommended destinations for your curriculum</h2>
            <div style={{ display: "grid", gap: 12 }}>
              {curriculumFitRecs.map((rec, idx) => (
                <div key={rec.mappingIds?.[0] ?? idx} style={tripCard(theme)}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                    <h3 style={{ margin: "0 0 6px", fontSize: 16 }}>{rec.destination}</h3>
                    {Number.isFinite(rec.fitScore) && (
                      <span style={{ fontSize: 13, fontWeight: 600, opacity: 0.8 }}>{rec.fitScore}% fit</span>
                    )}
                  </div>
                  {Array.isArray(rec.reasons) && rec.reasons.length > 0 && (
                    <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14 }}>
                      {rec.reasons.map((reason, i) => (
                        <li key={i}>{reason.rationale || reason.learningOutcome || reason.subject}</li>
                      ))}
                    </ul>
                  )}
                  {rec.brochurePdfUrl && (
                    <a
                      href={rec.brochurePdfUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ ...secondaryBtn(theme), marginTop: 10 }}
                    >
                      View brochure
                    </a>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {trips.length > 0 && (
          <section style={section(theme)}>
            <h2 style={sectionTitle(theme)}>Curriculum alignment recommendations</h2>
            <div style={{ display: "grid", gap: 12 }}>
              {trips.map((trip, idx) => (
                <div key={idx} style={tripCard(theme)}>
                  <h3 style={{ margin: "0 0 6px", fontSize: 16 }}>
                    {trip.name}
                  </h3>
                  {trip.summary && (
                    <p style={{ margin: "0 0 8px", fontSize: 14, opacity: 0.85 }}>
                      {trip.summary}
                    </p>
                  )}
                  {Array.isArray(trip.learnings) && trip.learnings.length > 0 && (
                    <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14 }}>
                      {trip.learnings.map((l, i) => (
                        <li key={i}>{l}</li>
                      ))}
                    </ul>
                  )}
                  {trip.driveLink && (
                    <a
                      href={trip.driveLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ ...secondaryBtn(theme), marginTop: 10 }}
                    >
                      View brochure
                    </a>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {data?.reportPdfUrl && (
          <section style={section(theme)}>
            <h2 style={sectionTitle(theme)}>Detailed report</h2>
            <a
              href={data.reportPdfUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={primaryBtn(theme)}
            >
              <Download size={16} />
              Download PDF report
            </a>
          </section>
        )}

        {!trips.length && !curriculumFitRecs.length && !summary && !data?.reportPdfUrl && (
          <div style={emptyState}>
            <CheckCircle2 size={36} style={{ opacity: 0.5 }} />
            <p>Your diagnostic has been recorded. An advisor will reach out soon.</p>
          </div>
        )}
      </div>
    </Shell>
  );
}

function Shell({ theme, styling, children }) {
  const bgImage = styling?.bgImageUrl
    ? { backgroundImage: `url(${styling.bgImageUrl})` }
    : {};
  const overlayOpacity = styling?.bgOverlayOpacity ?? 0;
  const overlayColor = styling?.bgOverlayColor || "#000000";

  return (
    <div
      style={{
        minHeight: "100vh",
        background: theme.bgColor || DEFAULT_BG,
        color: theme.textColor || DEFAULT_TEXT,
        fontFamily:
          theme.fontFamily ||
          "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
        padding: "24px 16px",
        boxSizing: "border-box",
        backgroundSize: styling?.bgImageSize || "cover",
        backgroundPosition: styling?.bgImagePosition || "center",
        backgroundRepeat: styling?.bgImageRepeat || "no-repeat",
        ...bgImage,
        position: "relative",
      }}
    >
      {styling?.bgImageUrl && overlayOpacity > 0 && (
        <div
          style={{
            position: "fixed",
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

// ─── Styles ─────────────────────────────────────────────────────────────────
const card = (styling) => ({
  maxWidth: styling?.formMaxWidth ? `${styling.formMaxWidth}px` : "760px",
  margin: "0 auto",
  background: styling?.formBgColor || "#fff",
  borderRadius: styling?.formBorderRadius ?? 16,
  padding: styling?.formPadding ? `${styling.formPadding}px` : "28px",
  boxShadow:
    (styling?.formShadow || "md") === "none"
      ? "none"
      : (styling?.formShadow || "md") === "sm"
        ? "0 2px 8px rgba(0,0,0,0.06)"
        : (styling?.formShadow || "md") === "lg"
          ? "0 16px 48px rgba(18,38,71,0.12)"
          : "0 8px 32px rgba(18, 38, 71, 0.08)",
  border: "1px solid rgba(0,0,0,0.06)",
});

const title = (theme) => ({
  margin: "0 0 10px",
  fontSize: 26,
  color: theme.textColor || DEFAULT_TEXT,
});

const classificationBadge = (theme) => ({
  display: "inline-block",
  padding: "8px 18px",
  borderRadius: 999,
  background: theme.primaryColor || DEFAULT_PRIMARY,
  color: "#fff",
  fontWeight: 600,
  fontSize: 15,
});

const section = (theme) => ({
  marginBottom: 22,
  padding: "18px 20px",
  borderRadius: 12,
  border: `1px solid ${theme.primaryColor || DEFAULT_PRIMARY}18`,
  background: "#fff",
});

const sectionTitle = (theme) => ({
  margin: "0 0 12px",
  fontSize: 16,
  color: theme.primaryColor || DEFAULT_PRIMARY,
});

const scoreRing = (theme) => ({
  display: "inline-flex",
  alignItems: "baseline",
  gap: 4,
  padding: "18px 28px",
  borderRadius: 999,
  border: `4px solid ${theme.primaryColor || DEFAULT_PRIMARY}`,
});

const scoreNumber = (theme) => ({
  fontSize: 38,
  fontWeight: 700,
  color: theme.primaryColor || DEFAULT_PRIMARY,
});

const tripCard = (theme) => ({
  padding: 14,
  borderRadius: 10,
  border: `1px solid ${theme.primaryColor || DEFAULT_PRIMARY}20`,
  background: "#fafafa",
});

const primaryBtn = (theme) => ({
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  padding: "12px 22px",
  background: theme.primaryColor || DEFAULT_PRIMARY,
  color: "#fff",
  border: "none",
  borderRadius: 8,
  fontSize: 15,
  fontWeight: 600,
  textDecoration: "none",
  cursor: "pointer",
});

const secondaryBtn = (theme) => ({
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  padding: "10px 18px",
  background: "#fff",
  color: theme.primaryColor || DEFAULT_PRIMARY,
  border: `1px solid ${theme.primaryColor || DEFAULT_PRIMARY}`,
  borderRadius: 8,
  fontSize: 14,
  fontWeight: 600,
  textDecoration: "none",
  cursor: "pointer",
});

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

const centerMsg = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 10,
  padding: "48px 20px",
  fontSize: 14,
};

const emptyState = {
  textAlign: "center",
  padding: "32px 20px",
  color: "var(--text-secondary, #5a6275)",
  fontSize: 15,
};
