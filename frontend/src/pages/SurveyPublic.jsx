import React, { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Star, CheckCircle2 } from 'lucide-react';

// Public-facing survey page mounted at /survey/:id (rendered OUTSIDE the
// authenticated <Layout>, so no admin sidebar / nav leaks to recipients).
// Loads the survey from /api/surveys/public/:id and POSTs the response to
// /api/surveys/public/:id/respond. Patient attribution token is read from ?p=.
export default function SurveyPublic() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const patientToken = searchParams.get('p');

  const [survey, setSurvey] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [score, setScore] = useState(null);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/surveys/public/${id}`)
      .then((r) => r.ok ? r.json() : Promise.reject(r.status))
      .then((data) => { if (!cancelled) setSurvey(data); })
      .catch((status) => {
        if (cancelled) return;
        if (status === 410) setError('This survey is no longer accepting responses.');
        else if (status === 404) setError('Survey not found.');
        else setError('Unable to load survey. Please try again later.');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id]);

  // Update document.title to the tenant brand on the public route, so the
  // browser tab doesn't expose the internal product name to recipients.
  useEffect(() => {
    if (survey?.brand?.name) {
      const prev = document.title;
      document.title = survey.brand.name;
      return () => { document.title = prev; };
    }
  }, [survey]);

  const submit = async (e) => {
    e.preventDefault();
    if (score === null) {
      setError('Please pick a score before submitting.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch(`/api/surveys/public/${id}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ score, comment: comment.trim() || null, p: patientToken }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setDone(true);
      else setError(data.error || 'Failed to submit response.');
    } catch (err) {
      setError('Network error. Please try again.');
    }
    setSubmitting(false);
  };

  const isCsat = survey?.type === 'CSAT';
  const maxScore = isCsat ? 5 : 10;
  const scaleHint = survey?.type === 'NPS'
    ? 'On a scale of 0–10, how likely are you to recommend us?'
    : isCsat
      ? 'How satisfied were you? (1 = poor, 5 = excellent)'
      : 'Please rate from 0 to 10.';

  return (
    <div style={pageStyle}>
      <div style={cardStyle} className="glass">
        {loading ? (
          <div style={{ textAlign: 'center', padding: '2rem 0', color: 'var(--text-secondary)' }}>
            Loading…
          </div>
        ) : done ? (
          <div style={{ textAlign: 'center', padding: '1rem 0' }}>
            <CheckCircle2 size={56} color="var(--success-color, #10b981)" style={{ marginBottom: '1rem' }} />
            <h2 style={{ fontSize: '1.4rem', fontWeight: 600, marginBottom: '0.5rem' }}>Thank you!</h2>
            <p style={{ color: 'var(--text-secondary)' }}>
              Your feedback has been recorded. We appreciate you taking the time to respond.
            </p>
          </div>
        ) : !survey ? (
          <div style={{ textAlign: 'center', padding: '2rem 0', color: 'var(--text-secondary)' }}>
            {error || 'Survey unavailable.'}
          </div>
        ) : (
          <form onSubmit={submit}>
            {survey.brand?.name && (
              <div style={brandStyle}>{survey.brand.name}</div>
            )}
            <h1 style={titleStyle}>{scaleHint}</h1>
            <p style={questionStyle}>{survey.question}</p>

            <div role="group" aria-label="score" style={scoreRowStyle}>
              {Array.from({ length: maxScore + 1 }, (_, i) => i).map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setScore(n)}
                  aria-label={`Score ${n}`}
                  aria-pressed={score === n}
                  style={{
                    ...scoreButtonStyle,
                    background: score === n ? 'var(--accent-color, #265855)' : 'transparent',
                    color: score === n ? '#fff' : 'var(--text-primary, #1f2937)',
                    borderColor: score === n ? 'var(--accent-color, #265855)' : 'var(--border-color, #d1d5db)',
                  }}
                >
                  {isCsat ? <Star size={18} /> : n}
                </button>
              ))}
            </div>

            <label style={labelStyle}>
              Comments (optional)
              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                rows={4}
                maxLength={2000}
                placeholder="Anything you'd like to share?"
                style={textareaStyle}
              />
            </label>

            {error && <div style={errorStyle}>{error}</div>}

            <button type="submit" disabled={submitting} style={submitStyle}>
              {submitting ? 'Submitting…' : 'Submit feedback'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

const pageStyle = {
  minHeight: '100vh',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '2rem 1rem',
  background: 'var(--bg-primary, #f9fafb)',
};

const cardStyle = {
  width: '100%',
  maxWidth: '560px',
  padding: '2rem',
  borderRadius: '16px',
  background: 'var(--bg-secondary, #fff)',
  boxShadow: '0 8px 32px rgba(0, 0, 0, 0.08)',
};

const brandStyle = {
  fontSize: '0.85rem',
  fontWeight: 600,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: 'var(--accent-color, #265855)',
  marginBottom: '0.75rem',
};

const titleStyle = {
  fontSize: '1.35rem',
  fontWeight: 600,
  marginBottom: '0.5rem',
  color: 'var(--text-primary, #1f2937)',
};

const questionStyle = {
  fontSize: '1rem',
  color: 'var(--text-secondary, #4b5563)',
  marginBottom: '1.5rem',
};

const scoreRowStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '0.5rem',
  marginBottom: '1.5rem',
};

const scoreButtonStyle = {
  minWidth: '40px',
  height: '40px',
  padding: '0 0.6rem',
  borderRadius: '8px',
  border: '1px solid',
  fontSize: '0.95rem',
  fontWeight: 500,
  cursor: 'pointer',
  transition: 'all 120ms ease',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const labelStyle = {
  display: 'block',
  fontSize: '0.85rem',
  fontWeight: 500,
  color: 'var(--text-secondary, #4b5563)',
  marginBottom: '1rem',
};

const textareaStyle = {
  width: '100%',
  marginTop: '0.4rem',
  padding: '0.6rem 0.75rem',
  borderRadius: '8px',
  border: '1px solid var(--border-color, #d1d5db)',
  background: 'var(--bg-primary, #fff)',
  color: 'var(--text-primary, #1f2937)',
  fontFamily: 'inherit',
  fontSize: '0.95rem',
  resize: 'vertical',
};

const errorStyle = {
  padding: '0.6rem 0.75rem',
  marginBottom: '1rem',
  borderRadius: '8px',
  background: 'rgba(220, 38, 38, 0.1)',
  color: '#dc2626',
  fontSize: '0.9rem',
};

const submitStyle = {
  width: '100%',
  padding: '0.75rem 1rem',
  borderRadius: '10px',
  border: 'none',
  background: 'var(--accent-color, #265855)',
  color: '#fff',
  fontSize: '1rem',
  fontWeight: 600,
  cursor: 'pointer',
};
