// Shared post-trip review form (2026-06-16). Renders a destination-interpolated
// form definition ({ formTitle, sections:[{ title, questions:[{id,text,type,
// options,max,required}] }] }) from the backend (lib/travelReviewQuestions.js)
// and collects answers. Question types: "rating" (1-max stars), "choice"
// (option pills), "text" (textarea). Used by BOTH the public review page
// (/p/review/:token) and the customer portal.
//
// Self-contained: owns the answers state, does client-side required-field
// validation, then calls onSubmit(answers). The parent handles the API call and
// passes `submitting` + `submitError`.

import { useState } from "react";
import { Star } from "lucide-react";

const PRIMARY = "var(--primary-color, var(--accent-color, #122647))";

function StarRating({ value, max, onChange }) {
  return (
    <div role="radiogroup" style={{ display: "flex", gap: 4 }}>
      {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={`${n} star${n > 1 ? "s" : ""}`}
          onClick={() => onChange(n)}
          style={{ background: "none", border: "none", cursor: "pointer", padding: 2, lineHeight: 0 }}
        >
          <Star
            size={26}
            aria-hidden
            fill={value && n <= value ? "#F5B301" : "none"}
            color={value && n <= value ? "#F5B301" : "var(--text-secondary, #94a3b8)"}
          />
        </button>
      ))}
    </div>
  );
}

export default function TravelReviewForm({ form, onSubmit, submitting, submitError }) {
  const [answers, setAnswers] = useState({});
  const [errors, setErrors] = useState({});

  if (!form || !Array.isArray(form.sections)) return null;
  const set = (id, val) => setAnswers((a) => ({ ...a, [id]: val }));

  const allQuestions = form.sections.flatMap((s) => s.questions);

  const handleSubmit = (e) => {
    e.preventDefault();
    const errs = {};
    for (const q of allQuestions) {
      const v = answers[q.id];
      if (q.required && (v === undefined || v === null || String(v).trim() === "")) {
        errs[q.id] = "Required";
      }
    }
    setErrors(errs);
    if (Object.keys(errs).length === 0) onSubmit(answers);
  };

  const labelStyle = { display: "block", fontSize: 14, fontWeight: 600, marginBottom: 6, color: "var(--text-primary, #1e293b)" };
  const sectionTitleStyle = { fontSize: 16, fontWeight: 700, margin: "20px 0 10px", color: PRIMARY };

  return (
    <form onSubmit={handleSubmit}>
      {form.sections.map((section) => (
        <div key={section.key}>
          <h3 style={sectionTitleStyle}>{section.title}</h3>
          {section.questions.map((q) => (
            <div key={q.id} style={{ marginBottom: 16 }}>
              <label style={labelStyle} htmlFor={`q-${q.id}`}>
                {q.text} {q.required && <span style={{ color: "#dc2626" }}>*</span>}
              </label>
              {q.type === "rating" && (
                <StarRating value={answers[q.id]} max={q.max || 5} onChange={(n) => set(q.id, n)} />
              )}
              {q.type === "choice" && (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {(q.options || []).map((opt) => {
                    const active = answers[q.id] === opt;
                    return (
                      <button
                        key={opt}
                        type="button"
                        onClick={() => set(q.id, opt)}
                        aria-pressed={active}
                        style={{
                          padding: "7px 14px", borderRadius: 20, fontSize: 14, fontWeight: 600, cursor: "pointer",
                          border: `1px solid ${active ? PRIMARY : "var(--border-light, #d1d5db)"}`,
                          background: active ? PRIMARY : "transparent",
                          color: active ? "#fff" : "var(--text-secondary, #475569)",
                        }}
                      >
                        {opt}
                      </button>
                    );
                  })}
                </div>
              )}
              {q.type === "text" && (
                <textarea
                  id={`q-${q.id}`}
                  value={answers[q.id] || ""}
                  onChange={(e) => set(q.id, e.target.value)}
                  rows={3}
                  maxLength={2000}
                  placeholder="Share your thoughts…"
                  style={{
                    width: "100%", padding: 10, borderRadius: 8, fontSize: 14, fontFamily: "inherit",
                    border: "1px solid var(--border-light, #d1d5db)", boxSizing: "border-box", resize: "vertical",
                  }}
                />
              )}
              {errors[q.id] && <div style={{ color: "#dc2626", fontSize: 12, marginTop: 4 }}>{errors[q.id]}</div>}
            </div>
          ))}
        </div>
      ))}

      {submitError && <div role="alert" style={{ color: "#b91c1c", fontSize: 13, margin: "8px 0" }}>{submitError}</div>}

      <button
        type="submit"
        disabled={submitting}
        style={{
          marginTop: 8, padding: "10px 22px", border: "none", borderRadius: 8, fontSize: 15, fontWeight: 700,
          cursor: submitting ? "default" : "pointer", background: PRIMARY, color: "#fff", opacity: submitting ? 0.7 : 1,
        }}
      >
        {submitting ? "Submitting…" : "Submit review"}
      </button>
    </form>
  );
}
