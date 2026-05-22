// v3.7.17 — Token-based survey respondent page.
//
// Public (no auth) page mounted at /surveys/respond/:token. This is where
// the Send-Survey email link lands. Two flavours of survey:
//
//   1. Legacy NPS / CSAT / CUSTOM: one numeric score + optional comment.
//      Submitted via POST /api/surveys/respond/:token { score, comment }.
//      Matches the pre-v3.7.17 contract — the existing wellnessOpsEngine
//      cron + portal flows depend on it staying intact.
//
//   2. v3.7.17 multi-question PRODUCT / SERVICE / DOCTOR / CUSTOM: an
//      ordered list of SurveyQuestion rows with field-type-specific
//      inputs (TEXT, TEXTAREA, SELECT, RATE, RADIO, YES_NO). Submitted
//      via POST /api/surveys/respond/:token/submit with an `answers`
//      array. The backend validates that every required questionId is
//      present and that no answer references an unknown questionId.
//
// Authentication: none. The token IS the authentication — a fresh
// random hex-48 string minted by the Send Survey flow with a 30-day
// TTL and a one-shot `used` flag. The page reads the token from the
// URL, fetches the survey via GET /api/surveys/respond/:token (which
// surfaces `Invalid or expired link.` / `already been answered.` /
// `no longer active.` errors), and renders the appropriate UI.

import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

const FIELD_TYPES = ['TEXT', 'TEXTAREA', 'SELECT', 'RATE', 'RADIO', 'YES_NO'];

export default function SurveyRespond() {
  const { token } = useParams();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [survey, setSurvey] = useState(null);
  // Multi-question answers, keyed by questionId.
  const [answers, setAnswers] = useState({});
  // Legacy single-score state (NPS / CSAT).
  const [score, setScore] = useState('');
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/surveys/respond/${encodeURIComponent(token)}`)
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) {
          throw new Error(body?.error || `Failed to load survey (${r.status})`);
        }
        return body;
      })
      .then((data) => {
        if (cancelled) return;
        setSurvey(data);
        // Pre-seed the answers map so each question's value flows through
        // controlled inputs without React warnings.
        if (Array.isArray(data.questions)) {
          const seed = {};
          for (const q of data.questions) seed[q.id] = '';
          setAnswers(seed);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Failed to load survey.');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token]);

  const isMulti = survey && Array.isArray(survey.questions);

  // Client-side validation mirrors the server: required questions need a
  // value; SELECT / RADIO / YES_NO need a non-empty pick; RATE values
  // must sit within the question's min/max bounds.
  function validate() {
    if (!isMulti) {
      const n = Number(score);
      if (!Number.isFinite(n) || n < 0 || n > 10) {
        return 'Please pick a score between 0 and 10.';
      }
      return null;
    }
    for (const q of survey.questions) {
      const v = answers[q.id];
      const empty = v === '' || v == null;
      if (q.isRequired && empty) {
        return `"${q.question}" is required.`;
      }
      if (empty) continue;
      if (q.fieldType === 'RATE') {
        const n = Number(v);
        if (!Number.isFinite(n) || n < q.minRating || n > q.maxRating) {
          return `Rating for "${q.question}" must be between ${q.minRating} and ${q.maxRating}.`;
        }
      }
    }
    return null;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const err = validate();
    if (err) { setError(err); return; }
    setError(null);
    setSubmitting(true);
    try {
      if (isMulti) {
        // Drop blank optional answers — the server tolerates them but
        // there's no value in storing empty rows.
        const payload = Object.entries(answers)
          .filter(([, v]) => v !== '' && v != null)
          .map(([questionId, v]) => ({
            questionId: parseInt(questionId, 10),
            answer: String(v),
          }));
        const res = await fetch(`/api/surveys/respond/${encodeURIComponent(token)}/submit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ answers: payload }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.error || 'Failed to submit.');
      } else {
        const res = await fetch(`/api/surveys/respond/${encodeURIComponent(token)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ score: Number(score), comment }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.error || 'Failed to submit.');
      }
      setSubmitted(true);
    } catch (err) {
      setError(err.message || 'Failed to submit response.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={pageWrap} data-testid="survey-respond-page">
      <div style={card}>
        {loading && (
          <p style={{ color: 'var(--text-secondary)' }}>Loading survey…</p>
        )}

        {!loading && error && !survey && (
          <div data-testid="survey-respond-error">
            <h2 style={{ marginBottom: '0.6rem' }}>We couldn't open this survey</h2>
            <p style={{ color: 'var(--text-secondary)' }}>{error}</p>
          </div>
        )}

        {!loading && submitted && (
          <div data-testid="survey-respond-thanks">
            <h2 style={{ marginBottom: '0.6rem' }}>Thank you for your feedback!</h2>
            <p style={{ color: 'var(--text-secondary)' }}>Your response has been recorded.</p>
          </div>
        )}

        {!loading && survey && !submitted && (
          <form onSubmit={handleSubmit}>
            <h2 style={{ marginBottom: '1.25rem' }} data-testid="survey-title">
              {survey.title || survey.surveyName}
            </h2>

            {!isMulti && (
              <>
                <label style={labelStyle}>
                  {survey.question || 'How would you rate your experience?'}
                </label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }} data-testid="legacy-score-buttons">
                  {Array.from({ length: 11 }).map((_, n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => setScore(String(n))}
                      data-testid={`score-${n}`}
                      style={{
                        padding: '0.55rem 0.9rem',
                        borderRadius: 8,
                        border: '1px solid var(--border-color)',
                        background: String(score) === String(n) ? 'var(--primary-color, #265855)' : 'transparent',
                        color: String(score) === String(n) ? '#fff' : 'var(--text-primary)',
                        cursor: 'pointer',
                        minWidth: 38,
                      }}
                    >
                      {n}
                    </button>
                  ))}
                </div>
                <label style={labelStyle}>Comments (optional)</label>
                <textarea
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  rows={4}
                  style={inputStyle}
                  data-testid="legacy-comment-input"
                />
              </>
            )}

            {isMulti && survey.questions.length === 0 && (
              <p style={{ color: 'var(--text-secondary)' }}>
                This survey has no active questions yet.
              </p>
            )}

            {isMulti && survey.questions.map((q) => (
              <div key={q.id} style={{ marginBottom: '1.25rem' }} data-testid={`question-${q.id}`}>
                <label style={{ ...labelStyle, marginTop: 0 }}>
                  {q.question}
                  {q.isRequired && <span style={{ color: 'var(--danger-color, #ef4444)', marginLeft: '0.3rem' }}>*</span>}
                </label>
                <QuestionInput
                  q={q}
                  value={answers[q.id]}
                  onChange={(v) => setAnswers((prev) => ({ ...prev, [q.id]: v }))}
                />
              </div>
            ))}

            {error && (
              <p data-testid="survey-respond-validation-error" style={{ color: 'var(--danger-color, #ef4444)', fontSize: '0.85rem', marginTop: '0.75rem' }}>
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={submitting || (isMulti && survey.questions.length === 0)}
              data-testid="survey-respond-submit"
              style={{
                marginTop: '1rem',
                padding: '0.7rem 1.4rem',
                borderRadius: 8,
                background: 'var(--primary-color, #265855)',
                color: '#fff',
                border: 'none',
                fontWeight: 600,
                cursor: submitting ? 'not-allowed' : 'pointer',
                opacity: submitting ? 0.6 : 1,
              }}
            >
              {submitting ? 'Submitting…' : 'Submit feedback'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

// Field-type-specific input renderer. Mirrors the question-builder UI's
// type catalog so respondents see the same UX shape the admin saw while
// authoring the form. All values flow as strings — the server normalizes.
function QuestionInput({ q, value, onChange }) {
  if (!FIELD_TYPES.includes(q.fieldType)) {
    return <input style={inputStyle} value={value || ''} onChange={(e) => onChange(e.target.value)} />;
  }
  if (q.fieldType === 'TEXT') {
    return (
      <input
        type="text"
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        style={inputStyle}
        data-testid={`input-${q.id}`}
      />
    );
  }
  if (q.fieldType === 'TEXTAREA') {
    return (
      <textarea
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        rows={4}
        style={inputStyle}
        data-testid={`input-${q.id}`}
      />
    );
  }
  if (q.fieldType === 'SELECT') {
    return (
      <select
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        style={inputStyle}
        data-testid={`input-${q.id}`}
      >
        <option value="">— Select —</option>
        {(q.options || []).map((opt, i) => (
          <option key={i} value={opt}>{opt}</option>
        ))}
      </select>
    );
  }
  if (q.fieldType === 'RADIO' || q.fieldType === 'YES_NO') {
    const opts = q.fieldType === 'YES_NO' ? ['True', 'False'] : (q.options || []);
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }} data-testid={`input-${q.id}`}>
        {opts.map((opt, i) => (
          <label key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer' }}>
            <input
              type="radio"
              name={`q-${q.id}`}
              value={opt}
              checked={value === opt}
              onChange={() => onChange(opt)}
            />
            <span>{opt}</span>
          </label>
        ))}
      </div>
    );
  }
  if (q.fieldType === 'RATE') {
    const lo = Number.isFinite(q.minRating) ? q.minRating : 1;
    const hi = Number.isFinite(q.maxRating) ? q.maxRating : 5;
    // For short ranges (≤10) we render buttons; for longer ranges fall
    // back to a number input so the buttons don't run off the page.
    if (hi - lo <= 10) {
      return (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }} data-testid={`input-${q.id}`}>
          {Array.from({ length: hi - lo + 1 }).map((_, idx) => {
            const n = lo + idx;
            const selected = String(value) === String(n);
            return (
              <button
                key={n}
                type="button"
                onClick={() => onChange(String(n))}
                data-testid={`rate-${q.id}-${n}`}
                style={{
                  padding: '0.5rem 0.85rem',
                  borderRadius: 8,
                  border: '1px solid var(--border-color)',
                  background: selected ? 'var(--primary-color, #265855)' : 'transparent',
                  color: selected ? '#fff' : 'var(--text-primary)',
                  cursor: 'pointer',
                  minWidth: 38,
                }}
              >
                {n}
              </button>
            );
          })}
        </div>
      );
    }
    return (
      <input
        type="number"
        min={lo}
        max={hi}
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        style={inputStyle}
        data-testid={`input-${q.id}`}
      />
    );
  }
  return null;
}

const pageWrap = {
  minHeight: '100vh',
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'center',
  padding: '2.5rem 1rem',
  background: 'var(--bg-color, #0b1216)',
};
const card = {
  width: 'min(640px, 100%)',
  background: 'var(--surface-color, rgba(255,255,255,0.04))',
  border: '1px solid var(--border-color)',
  borderRadius: 12,
  padding: '1.75rem',
  boxShadow: '0 18px 56px rgba(0,0,0,0.35)',
  color: 'var(--text-primary)',
};
const labelStyle = {
  display: 'block',
  fontSize: '0.85rem',
  color: 'var(--text-secondary)',
  marginTop: '1rem',
  marginBottom: '0.35rem',
};
const inputStyle = {
  width: '100%',
  padding: '0.6rem 0.85rem',
  background: 'var(--input-bg, rgba(255,255,255,0.04))',
  border: '1px solid var(--border-color)',
  borderRadius: 8,
  color: 'var(--text-primary)',
  fontSize: '0.92rem',
  fontFamily: 'inherit',
};
