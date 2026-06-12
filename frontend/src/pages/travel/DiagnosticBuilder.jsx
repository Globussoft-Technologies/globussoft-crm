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

import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  AlertTriangle, CheckCircle, ChevronDown, ChevronLeft, ChevronUp,
  Download, FileJson, Plus, Save, Send, Settings, Trash2, Upload,
} from 'lucide-react';
import { fetchApi, getAuthToken } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { AuthContext } from '../../App';

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
  const { user } = useContext(AuthContext) || {};
  const isAdmin = user?.role === 'ADMIN';

  const [mode, setMode] = useState('visual');
  const [subBrand, setSubBrand] = useState('tmc');
  const [qJson, setQJson] = useState(QUESTIONS_EXAMPLE);
  const [rJson, setRJson] = useState(SCORING_EXAMPLE);
  const [validation, setValidation] = useState(null);
  const [saving, setSaving] = useState(false);
  // Current active bank for the selected sub-brand (so switching brand shows
  // THAT brand's existing questions to edit, not a static template).
  const [loadingBank, setLoadingBank] = useState(true);
  const [bankInfo, setBankInfo] = useState(null); // { existing, id?, version? } | null
  // PRD §4.2 — Phase-1 scoring is view-only; "Request change" files a GS ticket.
  const [showRequestChange, setShowRequestChange] = useState(false);
  const fileRef = useRef(null);
  const firstLoad = useRef(true);

  // Load the selected sub-brand's current active bank whenever it changes.
  // Existing bank → pre-fill the editors with its questions + scoring (so
  // admins edit a copy and ship v+1). No bank yet → start from a template.
  // On a brand SWITCH with no bank we reset to the template; on the very
  // first mount with no bank we leave the initial template untouched (so a
  // late-resolving fetch can't wipe edits the admin already started).
  useEffect(() => {
    let cancelled = false;
    setLoadingBank(true);
    setValidation(null);
    fetchApi(`/api/travel/diagnostic-banks?subBrand=${encodeURIComponent(subBrand)}&active=true`)
      .then((res) => {
        if (cancelled) return;
        const bank = Array.isArray(res?.banks) ? res.banks[0] : null;
        if (bank) {
          setQJson(prettyJson(bank.questionsJson, QUESTIONS_EXAMPLE));
          setRJson(prettyJson(bank.scoringRulesJson, SCORING_EXAMPLE));
          setBankInfo({ existing: true, id: bank.id, version: bank.version });
        } else {
          if (!firstLoad.current) {
            setQJson(QUESTIONS_EXAMPLE);
            setRJson(SCORING_EXAMPLE);
          }
          setBankInfo({ existing: false });
        }
      })
      .catch(() => {
        if (!cancelled) setBankInfo({ existing: false });
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingBank(false);
          firstLoad.current = false;
        }
      });
    return () => { cancelled = true; };
  }, [subBrand]);

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
        <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: '10px 0 0' }}>
          {loadingBank
            ? 'Loading this brand’s current questions…'
            : bankInfo?.existing
              ? `Editing a copy of v${bankInfo.version}. Saving ships v${bankInfo.version + 1} for this brand.`
              : 'No diagnostic bank yet for this brand — starting from a template. Saving ships v1.'}
        </p>
        {!loadingBank && bankInfo?.existing && (
          <div style={{ marginTop: 10 }}>
            <button
              type="button"
              onClick={() => setShowRequestChange(true)}
              style={secondaryBtn}
              title="Scoring is view-only in Phase 1 — this routes a change-request ticket to GS."
              aria-label="Request change"
            >
              <Send size={14} aria-hidden style={{ verticalAlign: -2, marginRight: 6 }} />
              Request change
            </button>
            <span style={{ color: 'var(--text-secondary)', fontSize: 12, marginLeft: 8 }}>
              Scoring is view-only in Phase 1 — file a change request and GS will pick it up.
            </span>
          </div>
        )}
      </section>

      {showRequestChange && bankInfo?.existing && (
        <RequestChangeModal
          bankId={bankInfo.id}
          subBrand={subBrand}
          version={bankInfo.version}
          notify={notify}
          onClose={() => setShowRequestChange(false)}
        />
      )}

      <ModeTabs mode={mode} onChange={setMode} subBrand={subBrand} />

      {mode === 'visual' && (
        <>
          <QuestionsVisualEditor json={qJson} onChange={setQJson} onSwitchToJson={() => setMode('json')} />
          <ScoringVisualEditor json={rJson} onChange={setRJson} onSwitchToJson={() => setMode('json')} />
        </>
      )}
      {mode === 'json' && (
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
      {mode === 'engineWeights' && subBrand === 'tmc' && (
        <EngineWeightsPanel notify={notify} isAdmin={isAdmin} />
      )}
      {mode === 'engineWeights' && subBrand === 'tmc' && (
        <div
          style={{
            marginTop: '1.5rem', padding: '1rem',
            background: 'var(--surface-subtle, #f5f5f5)', borderRadius: '8px',
          }}
        >
          <strong>Promote trips to active:</strong>{' '}
          <Link
            to="/travel/tmc/catalogue"
            style={{ color: 'var(--primary-color, var(--accent-color))', textDecoration: 'none' }}
          >
            Open TMC Catalogue Admin →
          </Link>
        </div>
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

function ModeTabs({ mode, onChange, subBrand }) {
  // Engine Weights tab is TMC-only — the §3.3 deterministic 6-signal
  // engine is a TMC-specific contract; other sub-brands continue to use
  // the generic weighted-sum scorer with no weight knobs to expose.
  const showEngineWeights = subBrand === 'tmc';
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
      {showEngineWeights && (
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'engineWeights'}
          onClick={() => onChange('engineWeights')}
          style={mode === 'engineWeights' ? tabActive : tabIdle}
        >
          Engine Weights
        </button>
      )}
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

// ─── Request-change modal (PRD §4.2 — Phase-1 view-only scoring) ──────
//
// Scoring rules can't be edited in place during Phase 1 (protects the
// 90-day analytics baseline). This modal files a change-request ticket
// to GS via POST /api/travel/diagnostics/banks/:id/request-change and
// toasts the created ticket id.

function RequestChangeModal({ bankId, subBrand, version, notify, onClose }) {
  const [summary, setSummary] = useState('');
  const [details, setDetails] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async () => {
    if (!summary.trim()) {
      notify.error('Summary is required.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetchApi(`/api/travel/diagnostics/banks/${bankId}/request-change`, {
        method: 'POST',
        body: JSON.stringify({
          summary: summary.trim(),
          details: details.trim() || undefined,
        }),
      });
      notify.success(`Change request submitted — ticket #${res?.ticket?.id} routed to GS.`);
      onClose();
    } catch (e) {
      notify.error(e?.data?.error || e?.message || 'Failed to submit change request');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="Request scoring change" style={modalOverlay}>
      <div style={modalCard}>
        <h2 style={{ ...cardTitle, marginBottom: 4 }}>Request change</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginTop: 0 }}>
          Scoring is view-only in Phase 1. This files a ticket to GS against the{' '}
          {String(subBrand).toUpperCase()} bank v{version}.
        </p>
        <Field label="Summary (required)">
          <input
            type="text"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            style={input}
            maxLength={140}
            placeholder="e.g. Band 2 threshold feels too low for repeat organisers"
            aria-label="Change request summary"
          />
        </Field>
        <div style={{ marginTop: 10 }}>
          <Field label="Details (optional)">
            <textarea
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              rows={5}
              style={{ ...textareaStyle, fontFamily: 'inherit' }}
              placeholder="What should change, and why?"
              aria-label="Change request details"
            />
          </Field>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button type="button" onClick={onClose} style={secondaryBtn} disabled={submitting}>
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={submitting}
            style={submitting ? primaryBtnDisabled : primaryBtn}
            aria-label="Submit change request"
          >
            <Send size={14} aria-hidden /> {submitting ? 'Submitting…' : 'Submit request'}
          </button>
        </div>
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

// Pretty-print a stored JSON string for the editor; fall back to the raw
// string (or a template) if it doesn't parse.
function prettyJson(s, fallback) {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s || fallback;
  }
}

// ─── Engine Weights panel (TMC) ───────────────────────────────────────
//
// PRD_TMC_DIAGNOSTIC_SALES_ROUTING_ENGINE §3.3.3 + §3.3.7 + §3.8.
// Six weight knobs + scoresWellThreshold + version label, sourced from
// the EngineWeights config row (single-row-per-tenant).
//
// Endpoints (T11 backend follow-up — see PRD §10 row T11 notes):
//   GET  /api/travel/engine-weights → current row (defaults if empty)
//   PUT  /api/travel/engine-weights → save (auto-bumps version if any
//                                     numeric weight changed)
//
// Validation: each weight must be an integer ≥ 0; threshold must be an
// integer in [0, 100]. The Save button stays disabled while validation
// is open until errors clear.

const DEFAULT_TMC_WEIGHTS = {
  version: 'v1',
  weightPrimaryOutcome: 50,
  weightSecondarySkill: 20,
  weightGrowthArea: 15,
  weightCurriculumHook: 10,
  weightGradeBandCenter: 10,
  weightTierValueLean: 8,
  scoresWellThreshold: 70,
};

const WEIGHT_FIELDS = [
  { key: 'weightPrimaryOutcome',  label: 'Primary-outcome match',  defaultValue: 50, hint: 'Q1 primary-outcome match. PRD §3.3.3 default 50.' },
  { key: 'weightSecondarySkill',  label: 'Secondary-skill match',  defaultValue: 20, hint: 'Per Q2 match, capped at 40 (max 2 secondaries). PRD §3.3.3 default 20.' },
  { key: 'weightGrowthArea',      label: 'Growth-area match',      defaultValue: 15, hint: 'Awarded once; 0 if duplicates a Q2 pick. PRD §3.3.3 default 15.' },
  { key: 'weightCurriculumHook',  label: 'Curriculum hook depth',  defaultValue: 10, hint: 'Trip has a curriculum_hooks entry matching school board × grade. PRD §3.3.3 default 10.' },
  { key: 'weightGradeBandCenter', label: 'Grade-band centering',   defaultValue: 10, hint: 'School band at/above trip range midpoint ceiling. PRD §3.3.3 default 10.' },
  { key: 'weightTierValueLean',   label: 'Tier-value lean',        defaultValue:  8, hint: 'Only when geo_preference=open. Prefer higher affordable tier. PRD §3.3.3 default 8.' },
];

function validateWeights(weights) {
  const errors = [];
  for (const f of WEIGHT_FIELDS) {
    const v = weights[f.key];
    if (!Number.isInteger(v) || v < 0) {
      errors.push(`${f.label} must be an integer ≥ 0 (got ${JSON.stringify(v)}).`);
    }
  }
  const t = weights.scoresWellThreshold;
  if (!Number.isInteger(t) || t < 0 || t > 100) {
    errors.push(`Scores-well threshold must be an integer in [0, 100] (got ${JSON.stringify(t)}).`);
  }
  if (!weights.version || typeof weights.version !== 'string' || !weights.version.trim()) {
    errors.push('Version label must be a non-empty string.');
  }
  return errors;
}

// Compute the next auto-bumped version when any numeric weight changed.
// "vN" → "v(N+1)"; everything else gets a "-revised" suffix appended.
function autoBumpVersion(prev) {
  const m = /^v(\d+)$/i.exec(String(prev || '').trim());
  if (m) return `v${Number(m[1]) + 1}`;
  return `${prev || 'v1'}-revised`;
}

function weightsNumericallyEqual(a, b) {
  for (const f of WEIGHT_FIELDS) {
    if (Number(a[f.key]) !== Number(b[f.key])) return false;
  }
  return Number(a.scoresWellThreshold) !== Number(b.scoresWellThreshold) ? false : true;
}

function EngineWeightsPanel({ notify, isAdmin }) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [weights, setWeights] = useState(DEFAULT_TMC_WEIGHTS);
  const [baseline, setBaseline] = useState(DEFAULT_TMC_WEIGHTS);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState([]);

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    fetchApi('/api/travel/engine-weights', { silent: true })
      .then((res) => {
        // Tolerate either a bare row OR an envelope { engineWeights }.
        const row = res?.engineWeights || res;
        if (row && typeof row === 'object') {
          const merged = { ...DEFAULT_TMC_WEIGHTS, ...row };
          setWeights(merged);
          setBaseline(merged);
        } else {
          setWeights(DEFAULT_TMC_WEIGHTS);
          setBaseline(DEFAULT_TMC_WEIGHTS);
        }
      })
      .catch((e) => {
        // 404 = no row yet; show the §3.3.3 defaults so the first save
        // POSTs a brand-new row. Other errors surface to the operator.
        if (e?.status === 404) {
          setWeights(DEFAULT_TMC_WEIGHTS);
          setBaseline(DEFAULT_TMC_WEIGHTS);
        } else {
          setLoadError(e?.message || 'Failed to load engine weights');
        }
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const updateField = (key, raw) => {
    const next = { ...weights };
    if (key === 'version') {
      next.version = raw;
    } else {
      next[key] = raw === '' ? 0 : Number(raw);
    }
    setWeights(next);
    setErrors([]);
  };

  const onSave = async () => {
    if (!isAdmin) {
      notify.error('Engine Weights save is ADMIN-only.');
      return;
    }
    const v = validateWeights(weights);
    if (v.length > 0) {
      setErrors(v);
      notify.error('Fix validation errors before saving.');
      return;
    }
    // Auto-bump version if any numeric weight changed AND the operator
    // didn't explicitly edit the version field themselves.
    let payload = { ...weights };
    const numericChanged = !weightsNumericallyEqual(weights, baseline);
    const versionUntouched = weights.version === baseline.version;
    if (numericChanged && versionUntouched) {
      payload.version = autoBumpVersion(baseline.version);
      setWeights(payload);
    }
    setSaving(true);
    try {
      const res = await fetchApi('/api/travel/engine-weights', {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      const row = res?.engineWeights || res || payload;
      const merged = { ...DEFAULT_TMC_WEIGHTS, ...row };
      setWeights(merged);
      setBaseline(merged);
      notify.success(`Engine weights saved (version ${merged.version}).`);
    } catch (e) {
      notify.error(e?.body?.error || e?.message || 'Failed to save engine weights');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <section style={card} aria-busy="true">
        <h2 style={cardTitle}>
          <Settings size={18} aria-hidden /> Engine Weights (TMC)
        </h2>
        <p style={{ color: 'var(--text-secondary)' }}>Loading current weights&hellip;</p>
      </section>
    );
  }

  if (loadError) {
    return (
      <section style={{ ...card, borderLeft: '4px solid var(--danger-color)' }}>
        <h2 style={cardTitle}>
          <Settings size={18} aria-hidden /> Engine Weights (TMC)
        </h2>
        <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--danger-color)' }}>
          <AlertTriangle size={16} aria-hidden /> {loadError}
        </div>
        <div style={{ marginTop: 12 }}>
          <button type="button" onClick={load} style={secondaryBtn}>Retry</button>
        </div>
      </section>
    );
  }

  return (
    <section style={card} aria-label="Engine Weights">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ ...cardTitle, margin: 0 }}>
          <Settings size={18} aria-hidden /> Engine Weights (TMC)
        </h2>
        <span style={versionPill} aria-label="Current version">
          version: <strong style={{ marginLeft: 4 }}>{baseline.version}</strong>
        </span>
      </div>
      <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: '0 0 12px' }}>
        Per PRD §3.3.3 the six weights below + the §3.3.5 "scores-well" threshold drive the
        deterministic 6-signal engine. Tuning here is config; the engine reads
        the live row at submission time (§3.3.7). Changing any weight auto-bumps
        the version so each scored submission's <code>weightsVersion</code> stays replayable.
      </p>

      <div style={fieldGrid}>
        {WEIGHT_FIELDS.map((f) => (
          <Field key={f.key} label={f.label}>
            <input
              type="number"
              value={weights[f.key]}
              onChange={(e) => updateField(f.key, e.target.value)}
              style={input}
              aria-label={f.label}
              min={0}
              step={1}
            />
            <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{f.hint}</span>
          </Field>
        ))}
        <Field label="Scores-well threshold (0-100)">
          <input
            type="number"
            value={weights.scoresWellThreshold}
            onChange={(e) => updateField('scoresWellThreshold', e.target.value)}
            style={input}
            aria-label="Scores-well threshold"
            min={0}
            max={100}
            step={1}
          />
          <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
            PRD §3.3.5 "scores well" floor. Default 70.
          </span>
        </Field>
        <Field label="Version label">
          <input
            type="text"
            value={weights.version}
            onChange={(e) => updateField('version', e.target.value)}
            style={input}
            aria-label="Version label"
          />
          <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
            Auto-bumps when weights change (vN → v(N+1)). Override freely if needed.
          </span>
        </Field>
      </div>

      {errors.length > 0 && (
        <div
          role="alert"
          style={{
            marginTop: 12, padding: 10, borderRadius: 6,
            background: 'rgba(190, 50, 50, 0.08)',
            border: '1px solid var(--danger-color)',
            color: 'var(--danger-color)', fontSize: 13,
          }}
        >
          <strong>Validation errors:</strong>
          <ul style={{ margin: '6px 0 0', paddingLeft: 20 }}>
            {errors.map((e, i) => <li key={i}>{e}</li>)}
          </ul>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12, gap: 8 }}>
        {!isAdmin && (
          <span style={{ color: 'var(--text-secondary)', fontSize: 12, alignSelf: 'center' }}>
            Read-only (ADMIN required to save).
          </span>
        )}
        <button
          type="button"
          onClick={onSave}
          disabled={saving || !isAdmin}
          style={saving || !isAdmin ? primaryBtnDisabled : primaryBtn}
          aria-label="Save engine weights"
        >
          <Save size={14} aria-hidden /> {saving ? 'Saving…' : 'Save engine weights'}
        </button>
      </div>
    </section>
  );
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
const versionPill = {
  display: 'inline-flex', alignItems: 'center',
  padding: '4px 10px', borderRadius: 999, fontSize: 12, fontWeight: 500,
  background: 'var(--subtle-bg)', color: 'var(--text-primary)',
  border: '1px solid var(--border-color)',
};
const modalOverlay = {
  position: 'fixed', inset: 0, zIndex: 1000,
  background: 'rgba(0, 0, 0, 0.45)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: 16,
};
const modalCard = {
  ...card,
  width: 'min(520px, 100%)', marginBottom: 0,
  maxHeight: '90vh', overflowY: 'auto',
};
