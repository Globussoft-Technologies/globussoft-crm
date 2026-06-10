// Public TMC Readiness diagnostic form (PRD §3.1 — 12 fixed questions).
//
// Lives at /p/tmc/readiness (no auth, renders outside AuthContext shell).
// One-question-per-screen wizard with progress bar + forward/back nav +
// per-screen answer persistence. Q12 email is the ONLY hard wall —
// everything else can be skipped (engine handles missing data per
// PRD §3.3 hard-filter "unknown" branches; lead-quality classifier
// catches garbage submissions). NF-6 governs this surface.
//
// Submits to POST /api/travel/diagnostics/public/submit-tmc (T8) which
// runs the deterministic engine (T2) + lead-quality (T3) and returns a
// `{diagnosticId, reportSlug, tenantSlug, engineState, message}` envelope.
// On success we navigate to /p/tmc/report/:reportSlug (T10 ships that
// page; the navigation contract is wired here even though the target
// page may 404 today).
//
// Uses raw `fetch()` (not utils/api.js's fetchApi) — public page, no
// AuthContext, no token, no 401-redirect dance. Tenant slug resolved
// via `?tenant=<slug>` query (defaults to PRD's TMC fixed slug).
//
// Theme awareness: primary CTAs use `var(--primary-color, var(--accent-color))`
// per CLAUDE.md standing rule so wellness-themed tenants don't render
// salmon CTAs. Cream/navy palette here matches sibling Travel Stall quiz
// for visual cohesion when launching from the same marketing URL pack.

import { useEffect, useMemo, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import {
  ChevronLeft,
  ChevronRight,
  Send,
  CheckCircle2,
  GraduationCap,
} from "lucide-react";

const DEFAULT_TENANT_SLUG = "tmc";
const SUBMIT_URL = "/api/travel/diagnostics/public/submit-tmc";

// PRD §3.1 — the 12 fixed questions. Field keys are the load-bearing
// contract with the T2 engine + T8 submit endpoint validator. Do not
// rename without sign-off; the engine reads named fields.
//
// `type`:
//   - "single"   → one option, persists as the option value
//   - "multi"    → array of option values, may have min/max
//   - "single-mapped" → one option, persists value + `${field}_skill` from mappedSkill
//   - "group"    → composite (Q11 school_profile, Q12 contact)
const QUESTIONS = [
  {
    id: "q1",
    field: "primary_outcome",
    text: "What's the one outcome you most want this trip to produce for your students?",
    helper:
      "Pick the single outcome that matters most. The engine uses this as the load-bearing sort tier.",
    type: "single",
    required: false, // hard wall is only Q12 email
    options: [
      { value: "confidence", label: "Confidence" },
      { value: "curiosity", label: "Curiosity" },
      { value: "empathy", label: "Empathy" },
      { value: "global_awareness", label: "Global awareness" },
      { value: "resilience", label: "Resilience" },
      { value: "pride", label: "Pride" },
    ],
  },
  {
    id: "q2",
    field: "secondary_skills",
    text: "Which two skills would you most want this trip to strengthen?",
    helper: "Pick exactly two.",
    type: "multi",
    min: 2,
    max: 2,
    options: [
      { value: "Empathy", label: "Empathy" },
      { value: "Self-awareness", label: "Self-awareness" },
      {
        value: "Collaboration and teamwork",
        label: "Collaboration and teamwork",
      },
      { value: "Mindfulness", label: "Mindfulness" },
      {
        value: "Lifelong learning and curiosity",
        label: "Lifelong learning and curiosity",
      },
      {
        value: "Cultural respect and inclusion",
        label: "Cultural respect and inclusion",
      },
      { value: "Emotional resilience", label: "Emotional resilience" },
    ],
  },
  {
    id: "q3",
    field: "growth_area",
    text: "Where do your students have the most room to grow?",
    helper:
      "Name a real uncomfortable gap. The engine maps this to one of the seven canonical skills.",
    type: "single-mapped",
    options: [
      {
        value: "speaking_up",
        label: "Speaking up in unfamiliar settings",
        mappedSkill: "Self-awareness",
      },
      {
        value: "handling_setbacks",
        label: "Handling setbacks without giving up",
        mappedSkill: "Emotional resilience",
      },
      {
        value: "comfort_with_difference",
        label: "Comfort with people unlike themselves",
        mappedSkill: "Cultural respect and inclusion",
      },
      {
        value: "working_with_peers",
        label: "Working effectively with peers they didn't choose",
        mappedSkill: "Collaboration and teamwork",
      },
      {
        value: "curiosity_beyond_syllabus",
        label: "Curiosity that survives beyond the syllabus",
        mappedSkill: "Lifelong learning and curiosity",
      },
      {
        value: "noticing_others",
        label: "Noticing what others are feeling",
        mappedSkill: "Empathy",
      },
      {
        value: "attention_to_now",
        label: "Slowing down and paying attention to the present",
        mappedSkill: "Mindfulness",
      },
    ],
  },
  {
    id: "q4",
    field: "travel_maturity",
    text: "How would you describe your school's travel maturity so far?",
    helper:
      "Does not gate any trip — shapes the report's tone.",
    type: "single",
    options: [
      { value: "first_time", label: "First-time — we've never run a school trip" },
      { value: "occasional_day", label: "Occasional day outings only" },
      { value: "regular_domestic", label: "Regular domestic trips" },
      { value: "already_international", label: "We've already run international" },
    ],
  },
  {
    id: "q5",
    field: "grade_band",
    text: "Which grade band is this trip for?",
    type: "single",
    options: [
      { value: "4-6", label: "Grades 4-6" },
      { value: "6-8", label: "Grades 6-8" },
      { value: "9-10", label: "Grades 9-10" },
      { value: "11-12", label: "Grades 11-12" },
    ],
  },
  {
    id: "q6",
    field: "curriculum",
    text: "Which curriculum does your school follow? (Select all that apply.)",
    type: "multi",
    min: 1,
    options: [
      { value: "CBSE", label: "CBSE" },
      { value: "ICSE_ISC", label: "ICSE / ISC" },
      { value: "IGCSE", label: "IGCSE (Cambridge)" },
      { value: "IB", label: "IB" },
      { value: "State Board", label: "State Board" },
    ],
  },
  {
    id: "q7",
    field: "geo_preference",
    text: "What kind of trip are you considering?",
    type: "single",
    options: [
      { value: "day", label: "A meaningful day out" },
      { value: "domestic", label: "Domestic overnight" },
      { value: "international", label: "International" },
      { value: "open", label: "Open — show me what's possible" },
    ],
  },
  {
    id: "q8",
    field: "group_size",
    text: "How many students are likely to travel?",
    type: "single",
    options: [
      { value: "under_35", label: "Under 35" },
      { value: "35-45", label: "35-45" },
      { value: "45-80", label: "45-80" },
      { value: "80-150", label: "80-150" },
      { value: "150_plus", label: "More than 150" },
    ],
  },
  {
    id: "q9",
    field: "budget_band",
    text: "What's a comfortable per-student budget for this trip?",
    helper: "This helps tailor what we show your families.",
    type: "single",
    options: [
      { value: "upto-5k", label: "Up to ₹5,000" },
      { value: "10k-30k", label: "₹10,000 - ₹30,000" },
      { value: "30k-75k", label: "₹30,000 - ₹75,000" },
      { value: "1l-2l", label: "₹1L - ₹2L" },
      { value: "2l-plus", label: "₹2L+" },
      { value: "unknown", label: "Not sure yet — guide me" },
    ],
  },
  {
    id: "q10",
    field: "timeline",
    text: "When are you hoping to run this trip?",
    type: "single",
    options: [
      { value: "this_term", label: "This term" },
      { value: "next_term", label: "Next term" },
      { value: "next_academic_year", label: "Next academic year" },
      { value: "exploring", label: "Just exploring" },
    ],
  },
  {
    id: "q11",
    field: "school_profile",
    text: "Tell us a little about your school.",
    type: "group",
    fields: [
      { id: "school_name", label: "School name", type: "text" },
      { id: "city", label: "City", type: "text" },
      {
        id: "branches",
        label: "How many branches does your school operate?",
        type: "single",
        options: [
          { value: "1", label: "1" },
          { value: "2", label: "2" },
          { value: "3_plus", label: "3 or more" },
        ],
      },
      {
        id: "student_strength",
        label: "Total student strength across all branches",
        type: "single",
        options: [
          { value: "under_500", label: "Under 500" },
          { value: "500_1000", label: "500 - 1,000" },
          { value: "1000_2000", label: "1,000 - 2,000" },
          { value: "2000_plus", label: "More than 2,000" },
        ],
      },
      {
        id: "fee_band",
        label: "Approximate annual fee per student",
        type: "single",
        options: [
          { value: "under_75k", label: "Under ₹75,000" },
          { value: "75k_1l", label: "₹75,000 - ₹1 lakh" },
          { value: "1l_plus", label: "More than ₹1 lakh" },
        ],
      },
    ],
  },
  {
    id: "q12",
    field: "contact",
    text: "Where should we send your readiness profile?",
    helper: "Email is required. We'll never share it.",
    type: "group",
    hardWall: true, // PRD §3.1 / NF-6
    fields: [
      { id: "contact_name", label: "Your name", type: "text" },
      {
        id: "contact_role",
        label: "Your role",
        type: "single",
        options: [
          { value: "owner_trustee", label: "Owner / Trustee" },
          { value: "principal", label: "Principal" },
          { value: "academic_coordinator", label: "Academic Coordinator" },
          { value: "vice_principal", label: "Vice Principal" },
          { value: "other", label: "Other" },
        ],
      },
      { id: "email", label: "Email", type: "email" },
      { id: "phone", label: "Phone", type: "tel" },
    ],
  },
];

const TOTAL = QUESTIONS.length;

function isValidEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());
}

export default function TmcReadiness() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const tenantSlug = searchParams.get("tenant") || DEFAULT_TENANT_SLUG;

  const [idx, setIdx] = useState(0); // 0-based question index
  const [answers, setAnswers] = useState({}); // { field: value }
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [emailError, setEmailError] = useState("");

  const current = QUESTIONS[idx];

  // Reset email error if user navigates away then back
  useEffect(() => {
    if (current?.id !== "q12") setEmailError("");
  }, [current?.id]);

  const progressLabel = `${idx + 1}/${TOTAL}`;
  const progressPct = Math.round(((idx + 1) / TOTAL) * 100);

  // Multi-select helpers
  const toggleMulti = (field, value, max) => {
    setAnswers((prev) => {
      const cur = Array.isArray(prev[field]) ? prev[field] : [];
      if (cur.includes(value)) {
        return { ...prev, [field]: cur.filter((v) => v !== value) };
      }
      // Cap at max if provided
      if (max && cur.length >= max) return prev;
      return { ...prev, [field]: [...cur, value] };
    });
  };

  // Single-mapped helpers (Q3 — persist mappedSkill alongside)
  const pickMapped = (field, optValue, mappedSkill) => {
    setAnswers((prev) => ({
      ...prev,
      [field]: optValue,
      [`${field}_skill`]: mappedSkill,
    }));
  };

  // Group helpers (Q11, Q12) — store as nested object under field
  const setGroupField = (field, subField, value) => {
    setAnswers((prev) => ({
      ...prev,
      [field]: { ...(prev[field] || {}), [subField]: value },
    }));
  };

  const goBack = () => {
    setSubmitError("");
    setEmailError("");
    setIdx((i) => Math.max(0, i - 1));
  };
  const goForward = () => {
    setSubmitError("");
    setIdx((i) => Math.min(TOTAL - 1, i + 1));
  };

  // Build the wire payload from accumulated answers state.
  const buildAnswersPayload = useMemo(() => {
    return () => {
      const out = {};
      for (const q of QUESTIONS) {
        const v = answers[q.field];
        if (v === undefined || v === null) continue;
        if (q.type === "multi") {
          if (Array.isArray(v) && v.length > 0) out[q.field] = v;
          continue;
        }
        if (q.type === "group") {
          if (v && typeof v === "object" && Object.keys(v).length > 0)
            out[q.field] = v;
          continue;
        }
        if (q.type === "single-mapped") {
          out[q.field] = v;
          const mapped = answers[`${q.field}_skill`];
          if (mapped) out[`${q.field}_skill`] = mapped;
          continue;
        }
        // single
        if (typeof v === "string" && v.length > 0) out[q.field] = v;
      }
      return out;
    };
  }, [answers]);

  const submit = async () => {
    setSubmitError("");
    setEmailError("");
    // Q12 email is the ONLY hard wall.
    const contact = (answers.contact && typeof answers.contact === "object") ? answers.contact : {};
    const email = String(contact.email || "").trim();
    if (!email) {
      setEmailError("Email is required to generate your readiness report.");
      return;
    }
    if (!isValidEmail(email)) {
      setEmailError("Please enter a valid email address.");
      return;
    }

    setSubmitting(true);
    try {
      const payload = {
        tenantSlug,
        answers: buildAnswersPayload(),
      };
      const r = await fetch(SUBMIT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(
          body.error ||
            "We couldn't submit your readiness diagnostic. Please try again.",
        );
      }
      const ok = await r.json();
      // Navigate to T10's report page (the contract is wired now; the
      // T10 page may not be implemented yet at the time of this commit).
      const slug = ok.reportSlug;
      if (slug) {
        navigate(`/p/tmc/report/${slug}`);
      } else {
        // Defensive fallback — extremely unlikely if backend responded ok.
        setSubmitError("Submission succeeded but no report link came back.");
      }
    } catch (e) {
      setSubmitError(
        e.message || "We couldn't submit your readiness diagnostic. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Shell>
      <header style={headerWrap}>
        <h1 style={headerTitle}>
          <GraduationCap size={22} aria-hidden style={{ color: "#122647" }} />
          School Readiness Diagnostic
        </h1>
        <p style={headerSub}>
          12 questions, one per screen. Helps us tailor a curriculum-aligned
          recommendation for your students.
        </p>
      </header>

      {/* Progress bar */}
      <div
        role="progressbar"
        aria-valuemin={1}
        aria-valuemax={TOTAL}
        aria-valuenow={idx + 1}
        aria-label="Progress through the diagnostic"
        style={progressTrack}
      >
        <div style={{ ...progressFill, width: `${progressPct}%` }} />
        <span style={progressLabelStyle}>{progressLabel}</span>
      </div>

      <section style={questionCard} aria-labelledby="question-text">
        <h2 id="question-text" style={questionText}>
          {current.text}
        </h2>
        {current.helper && <p style={helperText}>{current.helper}</p>}

        {/* Renderers per question type */}
        {current.type === "single" && (
          <div role="radiogroup" style={radioGroup}>
            {current.options.map((opt) => {
              const checked = answers[current.field] === opt.value;
              return (
                <label
                  key={opt.value}
                  style={{
                    ...optionRow,
                    borderColor: checked
                      ? "var(--primary-color, var(--accent-color, #122647))"
                      : "#dadfe8",
                    background: checked ? "#f7f3eb" : "#fff",
                  }}
                >
                  <input
                    type="radio"
                    name={current.field}
                    value={opt.value}
                    checked={checked}
                    onChange={() =>
                      setAnswers((prev) => ({ ...prev, [current.field]: opt.value }))
                    }
                    style={{ marginRight: 10 }}
                  />
                  {opt.label}
                </label>
              );
            })}
          </div>
        )}

        {current.type === "single-mapped" && (
          <div role="radiogroup" style={radioGroup}>
            {current.options.map((opt) => {
              const checked = answers[current.field] === opt.value;
              return (
                <label
                  key={opt.value}
                  style={{
                    ...optionRow,
                    borderColor: checked
                      ? "var(--primary-color, var(--accent-color, #122647))"
                      : "#dadfe8",
                    background: checked ? "#f7f3eb" : "#fff",
                  }}
                >
                  <input
                    type="radio"
                    name={current.field}
                    value={opt.value}
                    checked={checked}
                    onChange={() => pickMapped(current.field, opt.value, opt.mappedSkill)}
                    style={{ marginRight: 10 }}
                  />
                  {opt.label}
                </label>
              );
            })}
          </div>
        )}

        {current.type === "multi" && (
          <div style={radioGroup}>
            {current.options.map((opt) => {
              const cur = Array.isArray(answers[current.field])
                ? answers[current.field]
                : [];
              const checked = cur.includes(opt.value);
              const disabled =
                !checked && current.max && cur.length >= current.max;
              return (
                <label
                  key={opt.value}
                  style={{
                    ...optionRow,
                    borderColor: checked
                      ? "var(--primary-color, var(--accent-color, #122647))"
                      : "#dadfe8",
                    background: checked ? "#f7f3eb" : "#fff",
                    opacity: disabled ? 0.55 : 1,
                    cursor: disabled ? "not-allowed" : "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    value={opt.value}
                    checked={checked}
                    disabled={disabled}
                    onChange={() =>
                      toggleMulti(current.field, opt.value, current.max)
                    }
                    style={{ marginRight: 10 }}
                  />
                  {opt.label}
                </label>
              );
            })}
            {current.max && (
              <div style={multiCounter}>
                Selected: {(answers[current.field] || []).length}
                {current.max ? ` / ${current.max}` : ""}
              </div>
            )}
          </div>
        )}

        {current.type === "group" && (
          <div style={groupGrid}>
            {current.fields.map((sub) => {
              const groupVal = answers[current.field] || {};
              if (sub.type === "single") {
                return (
                  <fieldset key={sub.id} style={groupFieldset}>
                    <legend style={groupLegend}>{sub.label}</legend>
                    <div style={radioGroup}>
                      {sub.options.map((opt) => {
                        const checked = groupVal[sub.id] === opt.value;
                        return (
                          <label
                            key={opt.value}
                            style={{
                              ...optionRow,
                              borderColor: checked
                                ? "var(--primary-color, var(--accent-color, #122647))"
                                : "#dadfe8",
                              background: checked ? "#f7f3eb" : "#fff",
                            }}
                          >
                            <input
                              type="radio"
                              name={`${current.field}-${sub.id}`}
                              value={opt.value}
                              checked={checked}
                              onChange={() =>
                                setGroupField(current.field, sub.id, opt.value)
                              }
                              style={{ marginRight: 10 }}
                            />
                            {opt.label}
                          </label>
                        );
                      })}
                    </div>
                  </fieldset>
                );
              }
              // text/email/tel input
              return (
                <label key={sub.id} style={textFieldLabel}>
                  <span style={textFieldText}>{sub.label}</span>
                  <input
                    type={sub.type || "text"}
                    value={groupVal[sub.id] || ""}
                    onChange={(e) =>
                      setGroupField(current.field, sub.id, e.target.value)
                    }
                    style={input}
                    inputMode={
                      sub.type === "email"
                        ? "email"
                        : sub.type === "tel"
                          ? "tel"
                          : undefined
                    }
                    aria-label={sub.label}
                  />
                </label>
              );
            })}
          </div>
        )}

        {emailError && current.hardWall && (
          <div role="alert" style={inlineError}>
            {emailError}
          </div>
        )}
      </section>

      {submitError && (
        <div role="alert" style={inlineError}>
          {submitError}
        </div>
      )}

      <nav style={navRow} aria-label="Form navigation">
        <button
          type="button"
          onClick={goBack}
          disabled={idx === 0 || submitting}
          style={{ ...secondaryBtn, opacity: idx === 0 ? 0.45 : 1 }}
        >
          <ChevronLeft size={16} aria-hidden /> Back
        </button>

        {idx < TOTAL - 1 ? (
          <button
            type="button"
            onClick={goForward}
            disabled={submitting}
            style={primaryBtn}
          >
            Next <ChevronRight size={16} aria-hidden />
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={submitting}
            style={primaryBtn}
          >
            <Send size={16} aria-hidden />
            {submitting ? "Sending…" : "See my readiness report"}
          </button>
        )}
      </nav>

      <p style={fineprint}>
        <CheckCircle2 size={12} aria-hidden style={{ verticalAlign: "middle" }} />{" "}
        We only persist your school data once you submit Q12. Email is the only
        required field.
      </p>
    </Shell>
  );
}

// ─── Shell ──────────────────────────────────────────────────────────
function Shell({ children }) {
  return (
    <div style={page}>
      <div style={card}>{children}</div>
    </div>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────
// Cream/navy palette aligned with sibling Travel Stall quiz so a single
// marketing pack can launch both surfaces without visual jolt. Primary
// CTA + active-state colours use CSS vars so wellness-themed embedders
// don't render salmon buttons (CLAUDE.md standing rule).
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
const headerWrap = { marginBottom: 20 };
const headerTitle = {
  margin: 0,
  display: "flex",
  alignItems: "center",
  gap: 10,
  fontSize: 24,
};
const headerSub = {
  color: "#5a6275",
  marginTop: 8,
  fontSize: 14,
  lineHeight: 1.5,
};
const progressTrack = {
  position: "relative",
  height: 24,
  background: "#f1ece1",
  borderRadius: 12,
  overflow: "hidden",
  margin: "20px 0 24px",
  border: "1px solid #ece6da",
};
const progressFill = {
  height: "100%",
  background: "var(--primary-color, var(--accent-color, #122647))",
  transition: "width 0.2s ease",
};
const progressLabelStyle = {
  position: "absolute",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 12,
  fontWeight: 700,
  color: "#1c2233",
  letterSpacing: 0.5,
};
const questionCard = {
  border: "1px solid #e5e7ee",
  borderRadius: 12,
  padding: "22px",
  background: "#fff",
  marginBottom: 16,
};
const questionText = { fontSize: 17, margin: "0 0 6px", fontWeight: 600 };
const helperText = { fontSize: 13, color: "#5a6275", margin: "0 0 14px" };
const radioGroup = { display: "grid", gap: 8 };
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
const multiCounter = {
  marginTop: 8,
  fontSize: 12,
  color: "#5a6275",
};
const groupGrid = {
  display: "grid",
  // Single-source responsive: cells go below 240px on truly narrow viewports.
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 240px), 1fr))",
  gap: 14,
};
const groupFieldset = {
  gridColumn: "1 / -1",
  border: "1px solid #ece6da",
  borderRadius: 10,
  padding: "12px 14px 14px",
  margin: 0,
};
const groupLegend = {
  fontSize: 13,
  color: "#1c2233",
  fontWeight: 600,
  padding: "0 6px",
};
const textFieldLabel = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
};
const textFieldText = { fontSize: 13, color: "#1c2233", fontWeight: 600 };
const input = {
  padding: "10px 12px",
  border: "1px solid #dadfe8",
  borderRadius: 8,
  fontSize: 14,
  fontFamily: "inherit",
  background: "#fff",
};
const navRow = {
  display: "flex",
  justifyContent: "space-between",
  gap: 12,
  marginTop: 12,
};
const primaryBtn = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  padding: "12px 22px",
  background: "var(--primary-color, var(--accent-color, #122647))",
  color: "#fff",
  border: "none",
  borderRadius: 8,
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
};
const secondaryBtn = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "10px 16px",
  background: "#fff",
  color: "#1c2233",
  border: "1px solid #dadfe8",
  borderRadius: 8,
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
};
const inlineError = {
  marginTop: 12,
  padding: "10px 14px",
  borderRadius: 8,
  background: "#fdecec",
  border: "1px solid #f5b5b5",
  color: "#7a1f1f",
  fontSize: 13,
};
const fineprint = {
  marginTop: 14,
  fontSize: 12,
  color: "#5a6275",
  lineHeight: 1.5,
};
