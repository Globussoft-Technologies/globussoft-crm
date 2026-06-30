// Public Travel Stall Family Travel Quiz wizard (PRD §4.7).
//
// Lives at /travel-stall/quiz (no auth). Single-page form: fetches the
// active travelstall diagnostic bank on mount, renders 5 questions +
// lead-capture fields, POSTs to /api/travel/diagnostics/public/submit,
// then shows the persona result screen.
//
// Tenant is resolved server-side via `?tenant=<slug>` query (default
// "travel-stall"). This lets a single bundle serve multiple Travel Stall
// franchisees by stamping a different slug in the marketing URL — same
// pattern as the wellness PublicBooking page.
//
// Calls the public unauthenticated endpoints (commit 1260caa):
//   GET  /api/travel/diagnostics/public/banks
//   POST /api/travel/diagnostics/public/submit
// Uses raw `fetch()` (not utils/api.js's fetchApi) — the page renders
// outside the AuthContext shell, so no token / no 401 redirect dance.

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { CheckCircle2, Globe, Sparkles, Send, RefreshCw } from "lucide-react";

const DEFAULT_TENANT_SLUG = "travel-stall";
const SUB_BRAND = "travelstall";

// Back-compat: older diagnostics stored /uploads/diagnostics/... which the
// frontend SPA may intercept in production. Rewrite to /api/uploads/... so
// the request reaches the backend static mount.
function normalizeDiagnosticPdfUrl(url) {
  if (!url || typeof url !== "string") return url;
  if (url.startsWith("/uploads/diagnostics/")) {
    return `/api/uploads/diagnostics/${url.slice("/uploads/diagnostics/".length)}`;
  }
  return url;
}

export default function TravelStallQuiz() {
  const [searchParams] = useSearchParams();
  const tenantSlug = searchParams.get("tenant") || DEFAULT_TENANT_SLUG;

  const [bank, setBank] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);

  // answers: { qid: optionValue }. Lead capture: { name, phone, email }.
  const [answers, setAnswers] = useState({});
  const [lead, setLead] = useState({ name: "", phone: "", email: "" });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [result, setResult] = useState(null);

  useEffect(() => {
    setLoading(true);
    setLoadError("");
    const qs = new URLSearchParams({ tenantSlug, subBrand: SUB_BRAND });
    fetch(`/api/travel/diagnostics/public/banks?${qs.toString()}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then(setBank)
      .catch(() => setLoadError("Quiz is unavailable right now. Please try again later."))
      .finally(() => setLoading(false));
  }, [tenantSlug]);

  const allAnswered = useMemo(() => {
    if (!bank?.questions) return false;
    return bank.questions.every((q) => answers[q.id]);
  }, [bank, answers]);

  const phoneOk = /^\+?\d[\d\s-]{7,}$/.test(lead.phone);
  const nameOk = lead.name.trim().length >= 2;
  const canSubmit = allAnswered && nameOk && phoneOk && !submitting;

  const submit = async () => {
    setSubmitting(true);
    setSubmitError("");
    try {
      const r = await fetch("/api/travel/diagnostics/public/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantSlug,
          subBrand: SUB_BRAND,
          bankId: bank.bankId,
          answers,
          name: lead.name.trim(),
          phone: lead.phone.trim(),
          email: lead.email.trim() || undefined,
        }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error || "Submission failed. Please try again.");
      }
      setResult(await r.json());
    } catch (e) {
      setSubmitError(e.message || "Submission failed. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const restart = () => {
    setAnswers({});
    setLead({ name: "", phone: "", email: "" });
    setResult(null);
    setSubmitError("");
  };

  if (loading) {
    return <Shell><p style={{ color: "#5a6275" }}>Loading the quiz…</p></Shell>;
  }
  if (loadError) {
    return <Shell><p style={{ color: "#c0392b" }}>{loadError}</p></Shell>;
  }
  if (result) {
    return (
      <Shell tenantName={bank?.tenantName}>
        <ResultScreen result={result} onRestart={restart} />
      </Shell>
    );
  }

  return (
    <Shell tenantName={bank?.tenantName}>
      <header style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0, display: "flex", alignItems: "center", gap: 10, fontSize: 26 }}>
          <Sparkles size={26} aria-hidden style={{ color: "#C89A4E" }} />
          Family Travel Quiz
        </h1>
        <p style={{ color: "#5a6275", marginTop: 8, fontSize: 15, lineHeight: 1.5 }}>
          Five quick questions to help our advisors recommend the right family-holiday tier for you. No account required.
        </p>
      </header>

      <ol style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 20 }}>
        {bank.questions.map((q, idx) => (
          <li key={q.id} style={questionCard}>
            <div style={questionNumber}>Q{idx + 1}</div>
            <h2 style={questionText}>{q.text}</h2>
            <div role="radiogroup" aria-labelledby={`q-${q.id}-text`} style={{ display: "grid", gap: 8 }}>
              {q.options.map((opt) => {
                const checked = answers[q.id] === opt.value;
                return (
                  <label
                    key={opt.value}
                    style={{
                      ...optionRow,
                      borderColor: checked ? "#C89A4E" : "#dadfe8",
                      background: checked ? "#fdf6ec" : "#fff",
                    }}
                  >
                    <input
                      type="radio"
                      name={`q-${q.id}`}
                      value={opt.value}
                      checked={checked}
                      onChange={() => setAnswers({ ...answers, [q.id]: opt.value })}
                      style={{ marginRight: 10 }}
                    />
                    {opt.label}
                  </label>
                );
              })}
            </div>
          </li>
        ))}
      </ol>

      <section style={leadSection} aria-labelledby="lead-heading">
        <h2 id="lead-heading" style={{ fontSize: 17, margin: "0 0 12px" }}>
          Where should our advisor reach you?
        </h2>
        <div style={{ display: "grid", gap: 10 }}>
          <input
            placeholder="Your name *"
            value={lead.name}
            onChange={(e) => setLead({ ...lead, name: e.target.value })}
            style={input}
            aria-required="true"
          />
          <input
            placeholder="Phone (+91 …) *"
            value={lead.phone}
            onChange={(e) => setLead({ ...lead, phone: e.target.value })}
            style={input}
            aria-required="true"
            inputMode="tel"
          />
          <input
            placeholder="Email (optional)"
            value={lead.email}
            onChange={(e) => setLead({ ...lead, email: e.target.value })}
            style={input}
            type="email"
            inputMode="email"
          />
        </div>
      </section>

      {submitError && (
        <div role="alert" style={errorBox}>{submitError}</div>
      )}

      <button
        type="button"
        onClick={submit}
        disabled={!canSubmit}
        style={{ ...submitBtn, opacity: canSubmit ? 1 : 0.55, cursor: canSubmit ? "pointer" : "not-allowed" }}
      >
        <Send size={16} aria-hidden />
        {submitting ? "Sending…" : "See my recommendation"}
      </button>

      <p style={fineprint}>
        By submitting, you agree we may contact you about your holiday enquiry.
      </p>
    </Shell>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────

function Shell({ children, tenantName }) {
  return (
    <div style={page}>
      <div style={card}>
        <div style={brand}>
          <Globe size={18} aria-hidden style={{ color: "#122647" }} />
          <strong>{tenantName || "Travel Stall"}</strong>
        </div>
        {children}
      </div>
    </div>
  );
}

function ResultScreen({ result, onRestart }) {
  return (
    <div style={{ textAlign: "center", padding: "20px 0" }}>
      <CheckCircle2 size={56} aria-hidden style={{ color: "#2ecc71" }} />
      <h1 style={{ fontSize: 26, margin: "12px 0 4px" }}>
        You&rsquo;re a {result.classificationLabel}
      </h1>
      <p style={{ color: "#5a6275", fontSize: 15, marginTop: 0 }}>
        Recommended tier: <strong>{titleCase(result.recommendedTier)}</strong>
      </p>
      <p style={{ color: "#5a6275", marginTop: 16, fontSize: 14, lineHeight: 1.55 }}>
        {result.message}
      </p>
      {result.reportPdfUrl && (
        <p style={{ marginTop: 16 }}>
          <a
            href={normalizeDiagnosticPdfUrl(result.reportPdfUrl)}
            target="_blank"
            rel="noreferrer"
            style={{ color: "#122647", fontWeight: 600 }}
          >
            Download your personalised report (PDF)
          </a>
        </p>
      )}
      <button type="button" onClick={onRestart} style={{ ...secondaryBtn, marginTop: 20 }}>
        <RefreshCw size={14} aria-hidden /> Retake the quiz
      </button>
    </div>
  );
}

function titleCase(s) {
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ─── Styles ──────────────────────────────────────────────────────────
// Travel Stall theme placeholder colours (PRD Q22 — Yasin's brand
// assets pending). Navy #122647 + warm gold #C89A4E on cream
// #fbf7f0 background per the existing TravelOnly theme.

const page = {
  minHeight: "100vh",
  background: "#fbf7f0",
  padding: "32px 16px",
  fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
  color: "#1c2233",
};
const card = {
  maxWidth: 680,
  margin: "0 auto",
  background: "#fff",
  borderRadius: 16,
  padding: "28px 28px 32px",
  boxShadow: "0 8px 32px rgba(18, 38, 71, 0.08)",
  border: "1px solid #ece6da",
};
const brand = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 14,
  color: "#122647",
  marginBottom: 20,
  borderBottom: "1px solid #ece6da",
  paddingBottom: 14,
};
const questionCard = {
  position: "relative",
  border: "1px solid #e5e7ee",
  borderRadius: 12,
  padding: "20px 20px 16px",
  background: "#fff",
};
const questionNumber = {
  position: "absolute",
  top: -10,
  left: 16,
  background: "#122647",
  color: "#fff",
  fontSize: 11,
  fontWeight: 700,
  padding: "3px 8px",
  borderRadius: 4,
  letterSpacing: 0.5,
};
const questionText = { fontSize: 16, margin: "0 0 14px", fontWeight: 600 };
const optionRow = {
  display: "flex",
  alignItems: "center",
  padding: "10px 14px",
  border: "1px solid #dadfe8",
  borderRadius: 8,
  cursor: "pointer",
  fontSize: 14,
  transition: "border-color 0.15s, background 0.15s",
};
const leadSection = {
  marginTop: 28,
  padding: 20,
  background: "#f7f3eb",
  borderRadius: 12,
  border: "1px solid #ece6da",
};
const input = {
  padding: "10px 12px",
  border: "1px solid #dadfe8",
  borderRadius: 8,
  fontSize: 14,
  background: "#fff",
  color: "#1c2233",
  width: "100%",
  boxSizing: "border-box",
};
const errorBox = {
  marginTop: 16,
  padding: "10px 14px",
  background: "#fdecea",
  border: "1px solid #f5b7b1",
  color: "#922b21",
  borderRadius: 8,
  fontSize: 14,
};
const submitBtn = {
  marginTop: 20,
  width: "100%",
  padding: "13px 18px",
  background: "#122647",
  color: "#fff",
  border: "none",
  borderRadius: 8,
  fontSize: 15,
  fontWeight: 600,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
};
const secondaryBtn = {
  padding: "10px 16px",
  background: "transparent",
  color: "#122647",
  border: "1px solid #122647",
  borderRadius: 8,
  fontSize: 14,
  fontWeight: 600,
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  cursor: "pointer",
};
const fineprint = {
  textAlign: "center",
  color: "#7a8294",
  fontSize: 12,
  marginTop: 14,
};
