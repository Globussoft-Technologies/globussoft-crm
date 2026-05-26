// Travel CRM — Diagnostic Wizard (multi-step taker).
//
// Lands at /travel/diagnostics/new. Flow:
//   1. Bank picker — choose an active bank (filtered by sub-brand)
//   2. Step through questions (single-choice + multi-select)
//   3. Submit → backend scores + classifies → shows result card
//
// All scoring lives server-side (see backend/lib/travelDiagnosticScoring.js)
// — this UI only collects answers + renders the result. Per Q16 the bank
// content is read-only at the operator level; admins create new banks
// via /travel/diagnostics/banks/new.

import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, ClipboardCheck, Send, CheckCircle, AlertTriangle } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';

const SUB_BRANDS = [
  { value: 'tmc', label: 'TMC (school trips)' },
  { value: 'rfu', label: 'RFU (Umrah)' },
  { value: 'travelstall', label: 'Travel Stall' },
  { value: 'visasure', label: 'Visa Sure' },
];

export default function DiagnosticWizard() {
  const notify = useNotify();
  const navigate = useNavigate();

  // ── Step 1: pick a bank ────────────────────────────────────────────
  const [subBrand, setSubBrand] = useState('tmc');
  const [banks, setBanks] = useState([]);
  const [loadingBanks, setLoadingBanks] = useState(true);
  const [selectedBank, setSelectedBank] = useState(null);

  // ── Step 2: answer questions ───────────────────────────────────────
  const [parsedBank, setParsedBank] = useState(null);
  const [answers, setAnswers] = useState({});
  const [qIndex, setQIndex] = useState(0);

  // ── Step 3: result ─────────────────────────────────────────────────
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    setLoadingBanks(true);
    setSelectedBank(null);
    setParsedBank(null);
    setAnswers({});
    setQIndex(0);
    setResult(null);
    fetchApi(`/api/travel/diagnostic-banks?subBrand=${subBrand}&active=true`)
      .then((res) => setBanks(Array.isArray(res?.banks) ? res.banks : []))
      .catch((e) => {
        const msg = e?.body?.error || 'Failed to load banks';
        notify.error(msg);
        setBanks([]);
      })
      .finally(() => setLoadingBanks(false));
    // notify is stable from useNotify; subBrand is the only real dep.
  }, [subBrand]); // eslint-disable-line react-hooks/exhaustive-deps

  const onPickBank = (bank) => {
    try {
      const q = JSON.parse(bank.questionsJson);
      const questions = Array.isArray(q?.questions) ? q.questions : [];
      if (questions.length === 0) {
        notify.error('Bank has no questions');
        return;
      }
      setSelectedBank(bank);
      setParsedBank({ questions });
      setAnswers({});
      setQIndex(0);
    } catch (_e) {
      notify.error('Bank JSON is malformed — admin needs to fix it.');
    }
  };

  const setAnswer = (qid, value) => {
    setAnswers((a) => ({ ...a, [qid]: value }));
  };

  const toggleMulti = (qid, value) => {
    setAnswers((a) => {
      const current = Array.isArray(a[qid]) ? a[qid] : [];
      return {
        ...a,
        [qid]: current.includes(value)
          ? current.filter((v) => v !== value)
          : [...current, value],
      };
    });
  };

  const onSubmit = async () => {
    if (!selectedBank) return;
    setSubmitting(true);
    try {
      const res = await fetchApi('/api/travel/diagnostics', {
        method: 'POST',
        body: JSON.stringify({
          bankId: selectedBank.id,
          answers,
        }),
      });
      setResult(res);
      if (res?.warnings?.length > 0) {
        notify.info(`Submitted with ${res.warnings.length} warning(s) — see result panel.`);
      } else {
        notify.success('Diagnostic submitted.');
      }
    } catch (e) {
      const msg = e?.body?.error || 'Submit failed';
      notify.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────

  if (result) {
    return <ResultCard result={result} onAnother={() => navigate('/travel/diagnostics')} />;
  }

  // Step 1: bank picker
  if (!selectedBank) {
    return (
      <div style={shell}>
        <header style={headerRow}>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 10, margin: 0 }}>
            <ClipboardCheck size={28} aria-hidden /> Take a diagnostic
          </h1>
          <Link to="/travel/diagnostics" style={backLink}>
            <ChevronLeft size={16} aria-hidden /> Back to list
          </Link>
        </header>

        <section style={card}>
          <h2 style={cardTitle}>1. Select sub-brand</h2>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {SUB_BRANDS.map((s) => (
              <button
                key={s.value}
                type="button"
                onClick={() => setSubBrand(s.value)}
                style={subBrand === s.value ? subBrandActive : subBrandIdle}
                aria-pressed={subBrand === s.value}
              >
                {s.label}
              </button>
            ))}
          </div>
        </section>

        <section style={card}>
          <h2 style={cardTitle}>2. Choose a question bank</h2>
          {loadingBanks ? (
            <div style={empty}>Loading banks&hellip;</div>
          ) : banks.length === 0 ? (
            <div style={empty}>
              No active banks for <strong>{subBrand}</strong> yet. Ask an admin to
              create one via <Link to="/travel/diagnostics/banks/new">New bank</Link>.
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              {banks.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => onPickBank(b)}
                  style={bankRow}
                  aria-label={`Use bank version ${b.version}`}
                >
                  <div>
                    <strong>Bank v{b.version}</strong>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                      Created {new Date(b.createdAt).toLocaleDateString()} · {b.isActive ? 'active' : 'inactive'}
                    </div>
                  </div>
                  <ChevronRight size={18} aria-hidden style={{ color: 'var(--text-secondary)' }} />
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    );
  }

  // Step 2: answer questions
  const questions = parsedBank.questions;
  const q = questions[qIndex];
  const isLast = qIndex === questions.length - 1;
  const ansForQ = answers[q.id];
  const isAnswered = q.type === 'multi-select'
    ? Array.isArray(ansForQ) && ansForQ.length > 0
    : ansForQ !== undefined && ansForQ !== '';

  return (
    <div style={shell}>
      <header style={headerRow}>
        <h1 style={{ display: 'flex', alignItems: 'center', gap: 10, margin: 0 }}>
          <ClipboardCheck size={28} aria-hidden /> Diagnostic — {subBrand.toUpperCase()}
        </h1>
        <button type="button" onClick={() => setSelectedBank(null)} style={backLink} aria-label="Change bank">
          <ChevronLeft size={16} aria-hidden /> Change bank
        </button>
      </header>

      {/* Progress */}
      <div style={{ marginBottom: 12, color: 'var(--text-secondary)', fontSize: 13 }}>
        Question {qIndex + 1} of {questions.length}
      </div>
      <div style={progressTrack}>
        <div
          style={{
            ...progressFill,
            width: `${((qIndex + 1) / questions.length) * 100}%`,
          }}
        />
      </div>

      {/* Current question */}
      <section style={{ ...card, marginTop: 16 }}>
        <h2 style={{ ...cardTitle, marginBottom: 8 }}>{q.text || `Question ${qIndex + 1}`}</h2>
        {q.help && (
          <p style={{ color: 'var(--text-secondary)', marginTop: 0, fontSize: 14 }}>{q.help}</p>
        )}

        {/* Options */}
        <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
          {(q.options || []).map((opt) => {
            const selected = q.type === 'multi-select'
              ? Array.isArray(ansForQ) && ansForQ.includes(opt.value)
              : ansForQ === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => q.type === 'multi-select' ? toggleMulti(q.id, opt.value) : setAnswer(q.id, opt.value)}
                style={selected ? optionActive : optionIdle}
                aria-pressed={selected}
              >
                <span>{opt.label || opt.value}</span>
                {selected && <CheckCircle size={16} aria-hidden style={{ color: 'var(--primary-color)' }} />}
              </button>
            );
          })}
        </div>
      </section>

      {/* Nav */}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 16 }}>
        <button
          type="button"
          onClick={() => setQIndex((i) => Math.max(0, i - 1))}
          disabled={qIndex === 0}
          style={qIndex === 0 ? navBtnDisabled : navBtn}
          aria-label="Previous question"
        >
          <ChevronLeft size={16} aria-hidden /> Previous
        </button>
        {isLast ? (
          <button
            type="button"
            onClick={onSubmit}
            disabled={!isAnswered || submitting}
            style={!isAnswered || submitting ? primaryBtnDisabled : primaryBtn}
            aria-label="Submit diagnostic"
          >
            <Send size={16} aria-hidden /> {submitting ? 'Submitting…' : 'Submit'}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setQIndex((i) => Math.min(questions.length - 1, i + 1))}
            disabled={!isAnswered}
            style={!isAnswered ? primaryBtnDisabled : primaryBtn}
            aria-label="Next question"
          >
            Next <ChevronRight size={16} aria-hidden />
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Result card ──────────────────────────────────────────────────────

function ResultCard({ result, onAnother }) {
  const { classification, classificationLabel, recommendedTier, score, warnings = [] } = result;
  return (
    <div style={shell}>
      <header style={headerRow}>
        <h1 style={{ display: 'flex', alignItems: 'center', gap: 10, margin: 0 }}>
          <CheckCircle size={28} aria-hidden style={{ color: 'var(--success-color)' }} />
          Diagnostic complete
        </h1>
      </header>

      <section style={{ ...card, textAlign: 'center', padding: 32 }}>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.6 }}>
          Score
        </div>
        <div style={{ fontSize: 48, fontWeight: 700, margin: '8px 0', color: 'var(--primary-color)' }}>
          {score !== null ? Number(score).toFixed(2) : '—'}
        </div>
        {classificationLabel && (
          <div style={{ fontSize: 20, fontWeight: 600, marginBottom: 6 }}>{classificationLabel}</div>
        )}
        {classification && (
          <div style={{ color: 'var(--text-secondary)' }}>Classification: {classification}</div>
        )}
        {recommendedTier && (
          <div style={{ marginTop: 16 }}>
            <span style={{
              display: 'inline-block', padding: '6px 16px', borderRadius: 20,
              background: 'var(--primary-color)', color: '#fff', fontWeight: 600, textTransform: 'uppercase',
              letterSpacing: 0.5, fontSize: 13,
            }}>
              Recommended tier: {recommendedTier}
            </span>
          </div>
        )}
      </section>

      {warnings.length > 0 && (
        <section style={{ ...card, borderLeft: '4px solid var(--warning-color)' }}>
          <h3 style={{ ...cardTitle, display: 'flex', alignItems: 'center', gap: 8, color: 'var(--warning-color)' }}>
            <AlertTriangle size={18} aria-hidden /> Scoring warnings
          </h3>
          <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: 'var(--text-secondary)' }}>
            {warnings.map((w) => <li key={w}>{w}</li>)}
          </ul>
        </section>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <button type="button" onClick={onAnother} style={primaryBtn} aria-label="Back to diagnostics list">
          Back to list
        </button>
      </div>
    </div>
  );
}

// ─── Shared styles ────────────────────────────────────────────────────

const shell = { padding: 24, maxWidth: 760, margin: '0 auto' };
const headerRow = { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16, flexWrap: 'wrap', gap: 12 };
const card = {
  background: 'var(--surface-color)', borderRadius: 12, padding: 20,
  border: '1px solid var(--border-color)', marginBottom: 12,
  boxShadow: 'var(--shadow-sm)',
};
const cardTitle = { margin: 0, marginBottom: 12, fontSize: 16 };
const empty = { padding: 16, textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13 };
const backLink = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  fontSize: 13, color: 'var(--text-secondary)',
  textDecoration: 'none', padding: '4px 10px', borderRadius: 6,
  background: 'transparent', border: '1px solid transparent', cursor: 'pointer',
};
const subBrandIdle = {
  padding: '8px 14px', borderRadius: 6, fontWeight: 500, fontSize: 13,
  background: 'var(--surface-color)', color: 'var(--text-primary)',
  border: '1px solid var(--border-color)', cursor: 'pointer',
};
const subBrandActive = {
  ...subBrandIdle,
  background: 'var(--primary-color)', color: '#fff',
  borderColor: 'var(--primary-color)',
};
const bankRow = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  padding: '12px 14px', borderRadius: 8,
  background: 'var(--surface-color)', border: '1px solid var(--border-color)',
  textAlign: 'left', cursor: 'pointer', width: '100%',
  font: 'inherit', color: 'inherit',
};
const optionIdle = {
  ...bankRow,
};
const optionActive = {
  ...bankRow,
  borderColor: 'var(--primary-color)',
  background: 'var(--subtle-bg)',
};
const progressTrack = { height: 6, background: 'var(--subtle-bg)', borderRadius: 3, overflow: 'hidden' };
const progressFill = {
  height: '100%', background: 'var(--primary-color)',
  transition: 'width 0.25s ease-out',
};
const navBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  padding: '8px 14px', borderRadius: 8,
  background: 'var(--surface-color)', color: 'var(--text-primary)',
  border: '1px solid var(--border-color)', cursor: 'pointer', fontSize: 14,
};
const navBtnDisabled = {
  ...navBtn,
  opacity: 0.4, cursor: 'not-allowed',
};
const primaryBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '8px 14px', borderRadius: 8, fontWeight: 600, fontSize: 14,
  background: 'var(--primary-color)', color: '#fff',
  border: 'none', cursor: 'pointer',
};
const primaryBtnDisabled = {
  ...primaryBtn,
  opacity: 0.4, cursor: 'not-allowed',
};
