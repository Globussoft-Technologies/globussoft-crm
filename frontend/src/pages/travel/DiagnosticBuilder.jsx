// Travel CRM — Diagnostic Bank Builder (admin only).
//
// Lands at /travel/diagnostics/banks/new. Admins paste in pre-prepared
// questionsJson + scoringRulesJson (per Yasin's Q13 deliverable). Phase 1
// is intentionally low-tech — a visual question/scoring builder lands in
// Phase 1.5 per Q16 (RFU "edit-with-audit" scoring). For Phase 1 admins:
//   1. Prepare the JSON in their preferred editor (Cursor / VS Code).
//   2. Paste into the textareas here.
//   3. Click Validate — checks JSON parseability + shape locally.
//   4. Click Create — POSTs to /api/travel/diagnostic-banks; backend
//      runs the same validation server-side and creates v(N+1).
//
// Why pasting-JSON instead of a visual editor: Yasin's Q-sets land as
// authored documents that need exact-fidelity preservation. A WYSIWYG
// risks structural drift. Paste-and-validate keeps the source of truth
// in the document the brand team controls.

import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronLeft, Save, FileJson, CheckCircle, AlertTriangle } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';

const SUB_BRANDS = [
  { value: 'tmc', label: 'TMC (school trips)' },
  { value: 'rfu', label: 'RFU (Umrah)' },
  { value: 'travelstall', label: 'Travel Stall' },
  { value: 'visasure', label: 'Visa Sure' },
];

const QUESTIONS_EXAMPLE = JSON.stringify(
  {
    questions: [
      {
        id: 'q1',
        text: 'How many trips do you organize per year?',
        type: 'single-choice',
        options: [
          { value: 'first', label: 'First-time', weight: 1 },
          { value: 'few', label: '2-4 trips', weight: 3 },
          { value: 'many', label: '5+ trips', weight: 5 },
        ],
      },
      {
        id: 'q2',
        text: 'Average group size?',
        type: 'single-choice',
        options: [
          { value: 'small', label: '< 20', weight: 1 },
          { value: 'medium', label: '20-50', weight: 3 },
          { value: 'large', label: '50+', weight: 5 },
        ],
      },
    ],
  },
  null,
  2,
);

const SCORING_EXAMPLE = JSON.stringify(
  {
    method: 'weighted-sum',
    bands: [
      { minScore: 0, maxScore: 4, classification: 'level_1', label: 'Starter', recommendedTier: 'entry' },
      { minScore: 5, maxScore: 7, classification: 'level_2', label: 'Established', recommendedTier: 'primary' },
      { minScore: 8, maxScore: 99, classification: 'level_3', label: 'Power User', recommendedTier: 'premium' },
    ],
  },
  null,
  2,
);

export default function DiagnosticBuilder() {
  const notify = useNotify();
  const navigate = useNavigate();

  const [subBrand, setSubBrand] = useState('tmc');
  const [qJson, setQJson] = useState(QUESTIONS_EXAMPLE);
  const [rJson, setRJson] = useState(SCORING_EXAMPLE);
  const [validation, setValidation] = useState(null);
  const [saving, setSaving] = useState(false);

  const validate = () => {
    const errors = [];
    let q;
    let r;
    try {
      q = JSON.parse(qJson);
      if (!q || typeof q !== 'object' || !Array.isArray(q.questions) || q.questions.length === 0) {
        errors.push('questionsJson must contain a non-empty "questions" array');
      }
    } catch (e) {
      errors.push(`questionsJson is not valid JSON: ${e.message}`);
    }
    try {
      r = JSON.parse(rJson);
      if (!r || typeof r !== 'object' || !Array.isArray(r.bands) || r.bands.length === 0) {
        errors.push('scoringRulesJson must contain a non-empty "bands" array');
      } else if (!r.method || r.method !== 'weighted-sum') {
        errors.push('scoringRulesJson.method must be "weighted-sum" (Phase 1 only supports weighted-sum)');
      }
    } catch (e) {
      errors.push(`scoringRulesJson is not valid JSON: ${e.message}`);
    }
    setValidation({ errors, ok: errors.length === 0 });
    return errors.length === 0;
  };

  const onCreate = async () => {
    if (!validate()) {
      notify.error('Fix validation errors before creating');
      return;
    }
    setSaving(true);
    try {
      const created = await fetchApi('/api/travel/diagnostic-banks', {
        method: 'POST',
        body: JSON.stringify({
          subBrand,
          questionsJson: qJson,
          scoringRulesJson: rJson,
        }),
      });
      notify.success(`Bank v${created.version} created for ${subBrand.toUpperCase()}.`);
      navigate('/travel/diagnostics');
    } catch (e) {
      const msg = e?.body?.error || 'Failed to create bank';
      notify.error(msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ padding: 24, maxWidth: 1000, margin: '0 auto' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        <h1 style={{ display: 'flex', alignItems: 'center', gap: 10, margin: 0 }}>
          <FileJson size={28} aria-hidden /> New Diagnostic Bank
        </h1>
        <Link to="/travel/diagnostics" style={backLink}>
          <ChevronLeft size={16} aria-hidden /> Back to list
        </Link>
      </header>
      <p style={{ color: 'var(--text-secondary)', marginTop: 0 }}>
        Admin-only. Paste pre-prepared JSON for questions + scoring. The textareas
        come pre-filled with a working example you can edit. Per Q16 (view-only
        scoring in Phase 1), existing banks are not mutated — this form ships
        a new version.
      </p>

      <section style={card}>
        <h2 style={cardTitle}>Sub-brand</h2>
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
        <h2 style={cardTitle}>questionsJson</h2>
        <p style={{ color: 'var(--text-secondary)', marginTop: -8, fontSize: 13 }}>
          Shape: <code>{`{ "questions": [{ "id", "text", "type", "options": [{ "value", "label", "weight" }] }] }`}</code>
        </p>
        <textarea
          value={qJson}
          onChange={(e) => setQJson(e.target.value)}
          spellCheck={false}
          style={textareaStyle}
          rows={14}
          aria-label="Questions JSON"
        />
      </section>

      <section style={card}>
        <h2 style={cardTitle}>scoringRulesJson</h2>
        <p style={{ color: 'var(--text-secondary)', marginTop: -8, fontSize: 13 }}>
          Shape: <code>{`{ "method": "weighted-sum", "bands": [{ "minScore", "maxScore", "classification", "label", "recommendedTier" }] }`}</code>
        </p>
        <textarea
          value={rJson}
          onChange={(e) => setRJson(e.target.value)}
          spellCheck={false}
          style={textareaStyle}
          rows={10}
          aria-label="Scoring rules JSON"
        />
      </section>

      {validation && (
        <section
          role="alert"
          style={{
            ...card,
            borderLeft: validation.ok
              ? '4px solid var(--success-color)'
              : '4px solid var(--danger-color)',
          }}
        >
          {validation.ok ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--success-color)' }}>
              <CheckCircle size={18} aria-hidden /> Both JSON payloads parse and have the required shape.
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--danger-color)', marginBottom: 6 }}>
                <AlertTriangle size={18} aria-hidden /> Validation errors
              </div>
              <ul style={{ margin: 0, paddingLeft: 20, color: 'var(--text-secondary)', fontSize: 13 }}>
                {validation.errors.map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            </>
          )}
        </section>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
        <button type="button" onClick={validate} style={secondaryBtn} aria-label="Validate JSON locally">
          Validate
        </button>
        <button
          type="button"
          onClick={onCreate}
          disabled={saving}
          style={saving ? primaryBtnDisabled : primaryBtn}
          aria-label="Create bank"
        >
          <Save size={16} aria-hidden /> {saving ? 'Creating…' : 'Create bank'}
        </button>
      </div>
    </div>
  );
}

// ─── Shared styles ────────────────────────────────────────────────────

const card = {
  background: 'var(--surface-color)', borderRadius: 12, padding: 20,
  border: '1px solid var(--border-color)', marginBottom: 12,
  boxShadow: 'var(--shadow-sm)',
};
const cardTitle = { margin: 0, marginBottom: 12, fontSize: 16 };
const backLink = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  fontSize: 13, color: 'var(--text-secondary)',
  textDecoration: 'none', padding: '4px 10px', borderRadius: 6,
};
const textareaStyle = {
  width: '100%', padding: 12, borderRadius: 8,
  border: '1px solid var(--border-color)',
  background: 'var(--bg-color)', color: 'var(--text-primary)',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 12, lineHeight: 1.5, resize: 'vertical',
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
const primaryBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '8px 16px', borderRadius: 8, fontWeight: 600, fontSize: 14,
  background: 'var(--primary-color)', color: '#fff',
  border: 'none', cursor: 'pointer',
};
const primaryBtnDisabled = {
  ...primaryBtn,
  opacity: 0.4, cursor: 'not-allowed',
};
const secondaryBtn = {
  padding: '8px 16px', borderRadius: 8, fontWeight: 600, fontSize: 14,
  background: 'var(--surface-color)', color: 'var(--text-primary)',
  border: '1px solid var(--border-color)', cursor: 'pointer',
};
