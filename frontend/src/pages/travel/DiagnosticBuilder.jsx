// Travel CRM — Diagnostic Bank Builder (admin only).
//
// Lands at /travel/diagnostics/banks/new. Two authoring modes:
//   - Visual (default) — form-based editor for questions + scoring bands
//     with add / remove / reorder controls. Phase 1.5 polish item from
//     the 2026-05-20 PM handoff (replaces the JSON-paste anti-pattern
//     for in-app authoring).
//   - JSON (advanced) — the two textareas verbatim. Preserves Yasin's
//     Q13 deliverable workflow: Q-sets land as authored documents and
//     paste-and-validate keeps the source of truth in the document the
//     brand team controls.
//
// The JSON string state (qJson, rJson) is the single source of truth.
// Visual edits parse → mutate → re-serialize, so Validate + Create read
// the same payload regardless of which tab authored it. If qJson is
// unparseable the Visual tab shows an inline "fix the JSON first" panel
// rather than guessing at a repair.
//
// POST shape unchanged: { subBrand, questionsJson, scoringRulesJson }
// goes to /api/travel/diagnostic-banks; backend revalidates server-side
// and creates v(N+1). Per Q16, existing banks are not mutated.

import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  AlertTriangle, CheckCircle, ChevronDown, ChevronLeft, ChevronUp,
  Download, FileJson, Plus, Save, Trash2, Upload,
} from 'lucide-react';
import { fetchApi, getAuthToken } from '../../utils/api';
import { useNotify } from '../../utils/notify';

const SUB_BRANDS = [
  { value: 'tmc', label: 'TMC (school trips)' },
  { value: 'rfu', label: 'RFU (Umrah)' },
  { value: 'travelstall', label: 'Travel Stall' },
  { value: 'visasure', label: 'Visa Sure' },
];

const QUESTION_TYPES = [
  { value: 'single-choice', label: 'single-choice' },
  { value: 'multi-select', label: 'multi-select' },
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

  const [mode, setMode] = useState('visual');
  const [subBrand, setSubBrand] = useState('tmc');
  const [qJson, setQJson] = useState(QUESTIONS_EXAMPLE);
  const [rJson, setRJson] = useState(SCORING_EXAMPLE);
  const [validation, setValidation] = useState(null);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef(null);

  const exportCsv = async () => {
    try {
      const res = await fetch('/api/travel/diagnostic-banks/export.csv', {
        headers: { Authorization: `Bearer ${getAuthToken()}` },
      });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'travel-diagnostic-banks.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      notify.error(e.message || 'Failed to export');
    }
  };

  const importCsv = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const res = await fetch('/api/travel/diagnostic-banks/import.csv', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${getAuthToken()}`,
          'Content-Type': 'text/csv',
        },
        body: text,
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || `Import failed (${res.status})`);
      const summary = `Imported ${body.imported}, updated ${body.updated}, skipped ${body.skipped}`;
      if (body.errors?.length) {
        notify.error(`${summary}. Row ${body.errors[0].rowNumber}: ${body.errors[0].reason}`);
      } else {
        notify.success(summary);
      }
    } catch (e) {
      notify.error(e.message || 'Failed to import');
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

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
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" onClick={exportCsv} style={secondaryBtn}>
            <Download size={14} aria-hidden /> Export CSV
          </button>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            style={secondaryBtn}
            title="Bulk-upload diagnostic banks. Columns: subBrand, version, questionsJson, scoringRulesJson, isActive."
          >
            <Upload size={14} aria-hidden /> Import CSV
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            onChange={importCsv}
            style={{ display: 'none' }}
            aria-label="Upload diagnostic-banks CSV"
          />
          <Link to="/travel/diagnostics" style={backLink}>
            <ChevronLeft size={16} aria-hidden /> Back to list
          </Link>
        </div>
      </header>
      <p style={{ color: 'var(--text-secondary)', marginTop: 0 }}>
        Admin-only. Author in the Visual tab or paste pre-prepared JSON in the
        JSON (advanced) tab — either way the same payload ships. Per Q16 (view-only
        scoring in Phase 1), existing banks are not mutated; this form ships a new version.
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

      <ModeTabs mode={mode} onChange={setMode} />

      {mode === 'visual' ? (
        <>
          <QuestionsVisualEditor json={qJson} onChange={setQJson} onSwitchToJson={() => setMode('json')} />
          <ScoringVisualEditor json={rJson} onChange={setRJson} onSwitchToJson={() => setMode('json')} />
        </>
      ) : (
        <>
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
        </>
      )}

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

// ─── Mode tabs ────────────────────────────────────────────────────────

function ModeTabs({ mode, onChange }) {
  return (
    <div role="tablist" aria-label="Authoring mode" style={tabRow}>
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'visual'}
        onClick={() => onChange('visual')}
        style={mode === 'visual' ? tabActive : tabIdle}
      >
        Visual builder
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'json'}
        onClick={() => onChange('json')}
        style={mode === 'json' ? tabActive : tabIdle}
      >
        JSON (advanced)
      </button>
    </div>
  );
}

// ─── Questions visual editor ──────────────────────────────────────────

function QuestionsVisualEditor({ json, onChange, onSwitchToJson }) {
  const parsed = tryParse(json);
  if (!parsed || !Array.isArray(parsed.questions)) {
    return (
      <ParseErrorPanel
        title="Questions"
        message={parsed === null
          ? 'The questionsJson string is not valid JSON. Fix it in the JSON tab.'
          : 'questionsJson is missing a "questions" array. Fix it in the JSON tab.'}
        onSwitchToJson={onSwitchToJson}
      />
    );
  }

  const questions = parsed.questions;

  const writeQuestions = (next) =>
    onChange(JSON.stringify({ ...parsed, questions: next }, null, 2));

  const addQuestion = () => {
    const used = new Set(questions.map((q) => q.id).filter(Boolean));
    let n = questions.length + 1;
    while (used.has(`q${n}`)) n++;
    writeQuestions([
      ...questions,
      { id: `q${n}`, text: '', type: 'single-choice', options: [] },
    ]);
  };

  const updateQuestion = (idx, patch) =>
    writeQuestions(questions.map((q, i) => (i === idx ? { ...q, ...patch } : q)));

  const removeQuestion = (idx) =>
    writeQuestions(questions.filter((_, i) => i !== idx));

  const moveQuestion = (idx, dir) => {
    const target = idx + dir;
    if (target < 0 || target >= questions.length) return;
    const next = questions.slice();
    [next[idx], next[target]] = [next[target], next[idx]];
    writeQuestions(next);
  };

  return (
    <section style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h2 style={{ ...cardTitle, marginBottom: 0 }}>Questions ({questions.length})</h2>
        <button type="button" onClick={addQuestion} style={addBtn}>
          <Plus size={14} aria-hidden /> Add question
        </button>
      </div>
      {questions.length === 0 ? (
        <p style={emptyHint}>No questions yet — click <em>Add question</em> to start.</p>
      ) : (
        questions.map((q, idx) => (
          <QuestionCard
            key={idx}
            question={q}
            index={idx}
            total={questions.length}
            onChange={(patch) => updateQuestion(idx, patch)}
            onRemove={() => removeQuestion(idx)}
            onMoveUp={() => moveQuestion(idx, -1)}
            onMoveDown={() => moveQuestion(idx, 1)}
          />
        ))
      )}
    </section>
  );
}

function QuestionCard({ question, index, total, onChange, onRemove, onMoveUp, onMoveDown }) {
  const opts = Array.isArray(question.options) ? question.options : [];

  const updateOption = (i, patch) =>
    onChange({ options: opts.map((o, j) => (j === i ? { ...o, ...patch } : o)) });

  const addOption = () => {
    const used = new Set(opts.map((o) => o.value));
    let n = opts.length + 1;
    while (used.has(`opt${n}`)) n++;
    onChange({ options: [...opts, { value: `opt${n}`, label: '', weight: 0 }] });
  };

  const removeOption = (i) =>
    onChange({ options: opts.filter((_, j) => j !== i) });

  return (
    <div style={subCard}>
      <div style={subCardHeader}>
        <span style={{ fontWeight: 600 }}>Question {index + 1}</span>
        <div style={{ display: 'flex', gap: 4 }}>
          <IconBtn onClick={onMoveUp} disabled={index === 0} title="Move up" aria-label="Move question up">
            <ChevronUp size={14} aria-hidden />
          </IconBtn>
          <IconBtn onClick={onMoveDown} disabled={index === total - 1} title="Move down" aria-label="Move question down">
            <ChevronDown size={14} aria-hidden />
          </IconBtn>
          <IconBtn onClick={onRemove} title="Remove question" aria-label="Remove question" danger>
            <Trash2 size={14} aria-hidden />
          </IconBtn>
        </div>
      </div>

      <div style={fieldGrid}>
        <Field label="id (machine identifier, no spaces)">
          <input
            type="text"
            value={question.id || ''}
            onChange={(e) => onChange({ id: e.target.value })}
            style={input}
          />
        </Field>
        <Field label="type">
          <select
            value={question.type || 'single-choice'}
            onChange={(e) => onChange({ type: e.target.value })}
            style={input}
          >
            {QUESTION_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </Field>
      </div>

      <Field label="question text">
        <input
          type="text"
          value={question.text || ''}
          onChange={(e) => onChange({ text: e.target.value })}
          style={input}
        />
      </Field>

      <div style={{ marginTop: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <strong style={{ fontSize: 13 }}>Options ({opts.length})</strong>
          <button type="button" onClick={addOption} style={addBtnSmall}>
            <Plus size={12} aria-hidden /> Add option
          </button>
        </div>
        {opts.length === 0 ? (
          <p style={{ ...emptyHint, fontSize: 12 }}>No options yet.</p>
        ) : (
          opts.map((o, i) => (
            <div key={i} style={optRow}>
              <input
                type="text"
                placeholder="value"
                value={o.value || ''}
                onChange={(e) => updateOption(i, { value: e.target.value })}
                style={{ ...input, flex: '1 1 120px' }}
                aria-label={`Option ${i + 1} value`}
              />
              <input
                type="text"
                placeholder="label"
                value={o.label || ''}
                onChange={(e) => updateOption(i, { label: e.target.value })}
                style={{ ...input, flex: '2 1 200px' }}
                aria-label={`Option ${i + 1} label`}
              />
              <input
                type="number"
                placeholder="weight"
                value={o.weight ?? ''}
                onChange={(e) => updateOption(i, { weight: e.target.value === '' ? 0 : Number(e.target.value) })}
                style={{ ...input, width: 90, flex: '0 0 90px' }}
                aria-label={`Option ${i + 1} weight`}
              />
              <IconBtn onClick={() => removeOption(i)} title="Remove option" aria-label={`Remove option ${i + 1}`} danger>
                <Trash2 size={14} aria-hidden />
              </IconBtn>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ─── Scoring bands visual editor ──────────────────────────────────────

function ScoringVisualEditor({ json, onChange, onSwitchToJson }) {
  const parsed = tryParse(json);
  if (!parsed || !Array.isArray(parsed.bands)) {
    return (
      <ParseErrorPanel
        title="Scoring bands"
        message={parsed === null
          ? 'The scoringRulesJson string is not valid JSON. Fix it in the JSON tab.'
          : 'scoringRulesJson is missing a "bands" array. Fix it in the JSON tab.'}
        onSwitchToJson={onSwitchToJson}
      />
    );
  }

  const bands = parsed.bands;
  const method = parsed.method || 'weighted-sum';

  const writeBands = (next) =>
    onChange(JSON.stringify({ ...parsed, method, bands: next }, null, 2));

  const addBand = () =>
    writeBands([
      ...bands,
      { minScore: 0, maxScore: 0, classification: '', label: '', recommendedTier: 'entry' },
    ]);

  const updateBand = (idx, patch) =>
    writeBands(bands.map((b, i) => (i === idx ? { ...b, ...patch } : b)));

  const removeBand = (idx) =>
    writeBands(bands.filter((_, i) => i !== idx));

  const moveBand = (idx, dir) => {
    const target = idx + dir;
    if (target < 0 || target >= bands.length) return;
    const next = bands.slice();
    [next[idx], next[target]] = [next[target], next[idx]];
    writeBands(next);
  };

  return (
    <section style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h2 style={{ ...cardTitle, marginBottom: 0 }}>Scoring bands ({bands.length})</h2>
        <button type="button" onClick={addBand} style={addBtn}>
          <Plus size={14} aria-hidden /> Add band
        </button>
      </div>
      <p style={{ color: 'var(--text-secondary)', marginTop: 0, fontSize: 12 }}>
        Method: <code>{method}</code> — Phase 1 only supports <code>weighted-sum</code>.
        The first band whose <code>[minScore, maxScore]</code> contains the computed
        score wins; bands are checked in declared order.
      </p>
      {bands.length === 0 ? (
        <p style={emptyHint}>No bands yet — click <em>Add band</em> to start.</p>
      ) : (
        bands.map((b, idx) => (
          <ScoringBandCard
            key={idx}
            band={b}
            index={idx}
            total={bands.length}
            onChange={(patch) => updateBand(idx, patch)}
            onRemove={() => removeBand(idx)}
            onMoveUp={() => moveBand(idx, -1)}
            onMoveDown={() => moveBand(idx, 1)}
          />
        ))
      )}
    </section>
  );
}

function ScoringBandCard({ band, index, total, onChange, onRemove, onMoveUp, onMoveDown }) {
  return (
    <div style={subCard}>
      <div style={subCardHeader}>
        <span style={{ fontWeight: 600 }}>Band {index + 1}</span>
        <div style={{ display: 'flex', gap: 4 }}>
          <IconBtn onClick={onMoveUp} disabled={index === 0} title="Move up" aria-label="Move band up">
            <ChevronUp size={14} aria-hidden />
          </IconBtn>
          <IconBtn onClick={onMoveDown} disabled={index === total - 1} title="Move down" aria-label="Move band down">
            <ChevronDown size={14} aria-hidden />
          </IconBtn>
          <IconBtn onClick={onRemove} title="Remove band" aria-label="Remove band" danger>
            <Trash2 size={14} aria-hidden />
          </IconBtn>
        </div>
      </div>
      <div style={fieldGrid}>
        <Field label="minScore">
          <input
            type="number"
            value={band.minScore ?? ''}
            onChange={(e) => onChange({ minScore: e.target.value === '' ? 0 : Number(e.target.value) })}
            style={input}
          />
        </Field>
        <Field label="maxScore">
          <input
            type="number"
            value={band.maxScore ?? ''}
            onChange={(e) => onChange({ maxScore: e.target.value === '' ? 0 : Number(e.target.value) })}
            style={input}
          />
        </Field>
        <Field label="classification (e.g. level_1)">
          <input
            type="text"
            value={band.classification || ''}
            onChange={(e) => onChange({ classification: e.target.value })}
            style={input}
          />
        </Field>
        <Field label="label (display name)">
          <input
            type="text"
            value={band.label || ''}
            onChange={(e) => onChange({ label: e.target.value })}
            style={input}
          />
        </Field>
        <Field label="recommendedTier (e.g. entry / primary / premium)">
          <input
            type="text"
            value={band.recommendedTier || ''}
            onChange={(e) => onChange({ recommendedTier: e.target.value })}
            style={input}
          />
        </Field>
      </div>
    </div>
  );
}

// ─── Small helpers ────────────────────────────────────────────────────

function Field({ label, children }) {
  return (
    <label style={fieldLabelWrap}>
      <span style={fieldLabel}>{label}</span>
      {children}
    </label>
  );
}

function IconBtn({ onClick, disabled, title, danger, children, ...rest }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        ...iconBtn,
        ...(danger ? { color: 'var(--danger-color)' } : {}),
        ...(disabled ? { opacity: 0.35, cursor: 'not-allowed' } : {}),
      }}
      {...rest}
    >
      {children}
    </button>
  );
}

function ParseErrorPanel({ title, message, onSwitchToJson }) {
  return (
    <section style={{ ...card, borderLeft: '4px solid var(--danger-color)' }}>
      <h2 style={cardTitle}>{title}</h2>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--danger-color)', marginBottom: 8 }}>
        <AlertTriangle size={16} aria-hidden /> {message}
      </div>
      <button type="button" onClick={onSwitchToJson} style={secondaryBtn}>
        Open JSON tab
      </button>
    </section>
  );
}

function tryParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// ─── Shared styles ────────────────────────────────────────────────────

const card = {
  background: 'var(--surface-color)', borderRadius: 12, padding: 20,
  border: '1px solid var(--border-color)', marginBottom: 12,
  boxShadow: 'var(--shadow-sm)',
};
const cardTitle = { margin: 0, marginBottom: 12, fontSize: 16 };
const subCard = {
  background: 'var(--bg-color)', borderRadius: 8, padding: 14,
  border: '1px solid var(--border-color)', marginBottom: 10,
};
const subCardHeader = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  marginBottom: 10,
};
const tabRow = {
  display: 'flex', gap: 0, marginBottom: 12, borderBottom: '1px solid var(--border-color)',
};
const tabIdle = {
  padding: '8px 14px', fontWeight: 500, fontSize: 13,
  background: 'transparent', color: 'var(--text-secondary)',
  border: 'none', borderBottom: '2px solid transparent', cursor: 'pointer',
};
const tabActive = {
  ...tabIdle,
  color: 'var(--primary-color)',
  borderBottom: '2px solid var(--primary-color)',
};
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
const addBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  padding: '6px 12px', borderRadius: 6, fontWeight: 600, fontSize: 13,
  background: 'var(--primary-color)', color: '#fff',
  border: 'none', cursor: 'pointer',
};
const addBtnSmall = {
  ...addBtn,
  padding: '4px 10px', fontSize: 12,
};
const iconBtn = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 28, height: 28, padding: 0, borderRadius: 6,
  background: 'transparent', color: 'var(--text-secondary)',
  border: '1px solid var(--border-color)', cursor: 'pointer',
};
const input = {
  padding: '6px 10px', borderRadius: 6, fontSize: 13,
  border: '1px solid var(--border-color)',
  background: 'var(--surface-color)', color: 'var(--text-primary)',
  fontFamily: 'inherit',
};
const fieldGrid = {
  display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))',
  gap: 10, marginTop: 6,
};
const fieldLabelWrap = {
  display: 'flex', flexDirection: 'column', gap: 4,
};
const fieldLabel = {
  fontSize: 12, color: 'var(--text-secondary)', fontWeight: 500,
};
const optRow = {
  display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap',
};
const emptyHint = {
  color: 'var(--text-secondary)', fontSize: 13, fontStyle: 'italic', margin: '4px 0',
};
