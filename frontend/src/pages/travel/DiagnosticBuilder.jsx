// Travel CRM — Diagnostic Bank Builder (admin only).
//
// Lands at /travel/diagnostics/banks/new. Two authoring modes:
//   - Visual (default) — form-based editor for questions + scoring bands
//     with add / remove / reorder controls. Phase 1.5 polish item from
//     the 2026-05-20 PM handoff (replaces the JSON-paste anti-pattern
//     for in-app authoring).
//   - Advanced tools — raw JSON textareas for support and recovery.
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
// POST shape unchanged apart from additive templateName support:
// { subBrand, templateName, questionsJson, scoringRulesJson }
// goes to /api/travel/diagnostic-banks; backend revalidates server-side
// and creates v(N+1). Per Q16, existing banks are not mutated.

import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, CheckCircle, ChevronDown, ChevronLeft, ChevronUp,
  Download, FileJson, Info, Plus, Save, Send, Settings, Trash2, Upload,
} from 'lucide-react';
import { fetchApi, getAuthToken } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { AuthContext } from '../../App';
import DiagnosticPublicFormPanel from './DiagnosticPublicFormPanel';

const SUB_BRANDS = [
  { value: 'tmc', label: 'TMC (school trips)' },
  { value: 'rfu', label: 'RFU (Umrah)' },
  { value: 'travelstall', label: 'Travel Stall' },
  { value: 'visasure', label: 'Visa Sure' },
];

const QUESTION_TYPES = [
  { value: 'single-choice', label: 'Single choice' },
  { value: 'multi-select', label: 'Multiple select' },
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
  const { user } = useContext(AuthContext) || {};
  const isAdmin = user?.role === 'ADMIN';

  const [mode, setMode] = useState('visual');
  const [subBrand, setSubBrand] = useState('tmc');
  const [qJson, setQJson] = useState(QUESTIONS_EXAMPLE);
  const [rJson, setRJson] = useState(SCORING_EXAMPLE);
  const [saving, setSaving] = useState(false);
  const [loadingBank, setLoadingBank] = useState(true);
  const [bankInfo, setBankInfo] = useState(null); // { existing, id?, version?, templateName? } | null
  const [banks, setBanks] = useState([]);
  const [selectedBankId, setSelectedBankId] = useState('');
  const [templateName, setTemplateName] = useState('');
  const [renamingTemplate, setRenamingTemplate] = useState(false);
  const [deletingTemplate, setDeletingTemplate] = useState(false);
  const [isCreatingTemplate, setIsCreatingTemplate] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [templateSearch, setTemplateSearch] = useState('');
  const fileRef = useRef(null);

  const defaultTemplateName = useCallback(
    () => `${SUB_BRANDS.find((item) => item.value === subBrand)?.label || subBrand.toUpperCase()} Template`,
    [subBrand],
  );

  const loadTemplateIntoEditor = useCallback((bank) => {
    if (!bank) return;
    setQJson(prettyJson(bank.questionsJson, QUESTIONS_EXAMPLE));
    setRJson(prettyJson(bank.scoringRulesJson, SCORING_EXAMPLE));
    setSelectedBankId(String(bank.id));
    setTemplateName(bank.templateName || defaultTemplateName());
    setBankInfo({
      existing: true,
      id: bank.id,
      version: bank.version,
      templateName: bank.templateName || defaultTemplateName(),
      isActive: bank.isActive !== false,
    });
    setIsCreatingTemplate(false);
    setTemplatePickerOpen(false);
    setTemplateSearch('');
  }, [defaultTemplateName]);

  const beginTemplateDraft = useCallback(() => {
    const fallbackName = defaultTemplateName();
    setQJson(QUESTIONS_EXAMPLE);
    setRJson(SCORING_EXAMPLE);
    setSelectedBankId('');
    setTemplateName(fallbackName);
    setBankInfo({ existing: false, templateName: fallbackName });
    setIsCreatingTemplate(true);
  }, [defaultTemplateName]);

  const loadBanks = useCallback(async (preferredId = null) => {
    setLoadingBank(true);
    try {
      const res = await fetchApi(`/api/travel/diagnostic-banks?subBrand=${encodeURIComponent(subBrand)}`);
      const rows = Array.isArray(res?.banks) ? res.banks : [];
      setBanks(rows);
      if (!rows.length) {
        beginTemplateDraft();
        return;
      }
      const picked =
        rows.find((row) => String(row.id) === String(preferredId || '')) ||
        rows.find((row) => row.isActive) ||
        rows[0];
      loadTemplateIntoEditor(picked);
    } catch (_e) {
      setBanks([]);
      beginTemplateDraft();
    } finally {
      setLoadingBank(false);
    }
  }, [beginTemplateDraft, loadTemplateIntoEditor, subBrand]);

  // Load the selected sub-brand's current active bank whenever it changes.
  // Existing bank → pre-fill the editors with its questions + scoring (so
  // admins edit a copy and ship v+1). No bank yet → start from a template.
  // On a brand SWITCH with no bank we reset to the template; on the very
  // first mount with no bank we leave the initial template untouched (so a
  // late-resolving fetch can't wipe edits the admin already started).
  useEffect(() => {
    loadBanks();
  }, [loadBanks]);

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
      // FormData upload (not raw text body) so both CSV and binary XLSX
      // files work — the backend's multer middleware already accepts
      // either via upload.single("file") and picks the parser by
      // extension/mimetype.
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/travel/diagnostic-banks/import.csv', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${getAuthToken()}`,
        },
        body: formData,
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
    return { ok: errors.length === 0, errors };
  };

  const onSaveAndUse = async () => {
    const result = validate();
    if (!result.ok) {
      notify.error(result.errors[0] || 'Fix validation errors before saving');
      return;
    }
    const cleanTemplateName = String(templateName || '').trim();
    if (!cleanTemplateName) {
      notify.error('Template name is required');
      return;
    }
    setSaving(true);
    try {
      const created = await fetchApi('/api/travel/diagnostic-banks', {
        method: 'POST',
        body: JSON.stringify({
          subBrand,
          templateName: cleanTemplateName,
          questionsJson: qJson,
          scoringRulesJson: rJson,
        }),
      });
      notify.success(
        isCreatingTemplate
          ? `Template "${cleanTemplateName}" created and now in use.`
          : `Template "${cleanTemplateName}" saved and now in use.`,
      );
      await loadBanks(created.id);
    } catch (e) {
      const msg = e?.body?.error || 'Failed to save diagnostic template';
      notify.error(msg);
    } finally {
      setSaving(false);
    }
  };

  const onRenameTemplate = async () => {
    if (!bankInfo?.existing || !bankInfo?.id) return;
    const cleanTemplateName = String(templateName || '').trim();
    if (!cleanTemplateName) {
      notify.error('Template name is required');
      return;
    }
    setRenamingTemplate(true);
    try {
      await fetchApi(`/api/travel/diagnostic-banks/${bankInfo.id}/template-name`, {
        method: 'PATCH',
        body: JSON.stringify({ templateName: cleanTemplateName }),
      });
      notify.success('Template renamed');
      await loadBanks(bankInfo.id);
    } catch (e) {
      notify.error(e?.body?.error || 'Failed to rename template');
    } finally {
      setRenamingTemplate(false);
    }
  };

  const onDeleteTemplate = async () => {
    if (!bankInfo?.existing || !bankInfo?.id) return;
    const label = bankInfo.templateName || templateName || 'this template';
    const ok = await notify.confirm({
      title: 'Delete template',
      message: `Delete template "${label}"? This cannot be undone.`,
      confirmText: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    setDeletingTemplate(true);
    try {
      await fetchApi(`/api/travel/diagnostic-banks/${bankInfo.id}`, {
        method: 'DELETE',
      });
      notify.success('Template deleted');
      await loadBanks();
    } catch (e) {
      notify.error(e?.body?.error || 'Failed to delete template');
    } finally {
      setDeletingTemplate(false);
    }
  };

  return (
    <div style={{ padding: 24, maxWidth: mode === 'publicForm' ? 1760 : 1000, margin: '0 auto' }}>
      <style>{diagnosticBuilderCss}</style>
      <header style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        <h1 style={{ display: 'flex', alignItems: 'center', gap: 10, margin: 0 }}>
          <FileJson size={28} aria-hidden /> Diagnostic Settings
        </h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" onClick={exportCsv} style={secondaryBtn}>
            <Upload size={14} aria-hidden /> Export CSV
          </button>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            style={secondaryBtn}
            title="Bulk-upload diagnostic banks (CSV or Excel). Columns: subBrand, version, questionsJson, scoringRulesJson, isActive."
          >
            <Download size={14} aria-hidden /> Import CSV/Excel
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.xlsx,.xls,text/csv"
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
        Create reusable diagnostic templates, edit questions, and publish the active form for each travel brand.
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
        <div style={{ ...fieldGrid, marginTop: 16 }}>
          <Field label="Active template" info="Choose the saved diagnostic template to edit and use for this travel brand.">
            <TemplatePicker
              banks={banks}
              loading={loadingBank}
              selectedBankId={selectedBankId}
              search={templateSearch}
              open={templatePickerOpen}
              onSearchChange={setTemplateSearch}
              onOpenChange={setTemplatePickerOpen}
              onPick={(bank) => {
                setSelectedBankId(String(bank.id));
                loadTemplateIntoEditor(bank);
              }}
            />
          </Field>
          <Field label="Template name" info="Use a clear name so your team can recognize this template later.">
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input
                type="text"
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
                style={{ ...input, flex: '1 1 240px' }}
                placeholder="Template name"
              />
              {bankInfo?.existing && !isCreatingTemplate && (
                <button
                  type="button"
                  onClick={onRenameTemplate}
                  disabled={renamingTemplate}
                  style={renamingTemplate ? primaryBtnDisabled : secondaryBtn}
                >
                  {renamingTemplate ? 'Renaming...' : 'Rename'}
                </button>
              )}
              {bankInfo?.existing && !isCreatingTemplate && (
                <button
                  type="button"
                  onClick={onDeleteTemplate}
                  disabled={deletingTemplate}
                  style={deletingTemplate ? primaryBtnDisabled : dangerBtn}
                >
                  {deletingTemplate ? 'Deleting...' : 'Delete'}
                </button>
              )}
              <button type="button" onClick={beginTemplateDraft} style={secondaryBtn}>
                Create template
              </button>
            </div>
          </Field>
        </div>
        <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: '10px 0 0' }}>
          {loadingBank
            ? 'Loading this brand’s current templates…'
            : isCreatingTemplate
              ? 'You are creating a fresh template. Saving will create it and make it the one in use for this sub-brand.'
              : bankInfo?.existing
                ? `Editing template "${bankInfo.templateName || templateName}".`
                : 'No diagnostic template exists for this brand yet — starting from a fresh template.'}
        </p>
      </section>

      <ModeTabs mode={mode} onChange={setMode} subBrand={subBrand} />

      <details
        open={advancedOpen || mode === 'json'}
        onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}
        style={advancedTools}
      >
        <summary style={advancedSummary}>
          <FileJson size={14} aria-hidden /> Advanced tools
        </summary>
        <div style={advancedBody}>
          <span style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
            Raw JSON is for support, bulk edits, and recovery. Most changes should be made in the visual editor.
          </span>
          <button type="button" onClick={() => setMode('json')} style={mode === 'json' ? primaryBtn : secondaryBtn}>
            Edit raw JSON
          </button>
        </div>
      </details>

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
      {mode === 'publicForm' && (
        <DiagnosticPublicFormPanel
          subBrand={subBrand}
          bankInfo={bankInfo}
          questionsJson={qJson}
          notify={notify}
        />
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

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
        <button
          type="button"
          onClick={onSaveAndUse}
          disabled={saving}
          style={saving ? primaryBtnDisabled : primaryBtn}
          aria-label={isCreatingTemplate ? 'Create and use template' : 'Save and use template'}
        >
          <Save size={16} aria-hidden /> {saving ? 'Saving...' : isCreatingTemplate ? 'Create and use' : 'Save and use'}
        </button>
      </div>
    </div>
  );
}

// ─── Mode tabs ────────────────────────────────────────────────────────

function ModeTabs({ mode, onChange, subBrand }) {
  // Recommendation Settings is TMC-only; the deterministic recommendation
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
        Questions
      </button>
      {showEngineWeights && (
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'engineWeights'}
          onClick={() => onChange('engineWeights')}
          style={mode === 'engineWeights' ? tabActive : tabIdle}
        >
          Recommendation Settings
        </button>
      )}
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'publicForm'}
        onClick={() => onChange('publicForm')}
        style={mode === 'publicForm' ? tabActive : tabIdle}
      >
        Public form
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
    onChange(JSON.stringify({ ...parsed, questions: normalizeQuestions(next) }, null, 2));

  const addQuestion = () => {
    writeQuestions([
      ...questions,
      { id: '', text: '', type: 'single-choice', options: [] },
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
    onChange({ options: [...opts, { value: '', label: '', weight: 0 }] });
  };

  const removeOption = (i) =>
    onChange({ options: opts.filter((_, j) => j !== i) });

  return (
    <div style={subCard}>
      <div style={subCardHeader}>
        <div>
          <span style={{ fontWeight: 700 }}>Question {index + 1}</span>
          <div style={microHint}>This is what the customer will answer on the public diagnostic form.</div>
        </div>
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

      <div className="diagnostic-question-layout" style={questionSetupGrid}>
        <Field
          label="Answer type"
          info="Single choice lets the customer pick one option. Multiple select lets them pick more than one."
        >
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
        <Field
          label="Question shown on form"
          info="Write the exact question the customer should see."
        >
          <input
            type="text"
            placeholder="Example: What type of school trip are you planning?"
            value={question.text || ''}
            onChange={(e) => {
              const text = e.target.value;
              const shouldRefreshId =
                !question.id ||
                question.id === buildQuestionId(question.text, index) ||
                (!question.text && /^q\d+$/i.test(String(question.id)));
              onChange({
                text,
                id: shouldRefreshId ? buildQuestionId(text, index) : question.id,
              });
            }}
            style={input}
          />
        </Field>
      </div>

      <div style={{ marginTop: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <div>
            <strong style={{ fontSize: 13 }}>Answer options ({opts.length})</strong>
            <div style={microHint}>Each option has customer text and a score impact used by the diagnostic result.</div>
          </div>
          <button type="button" onClick={addOption} style={addBtnSmall}>
            <Plus size={12} aria-hidden /> Add option
          </button>
        </div>
        {opts.length === 0 ? (
          <p style={{ ...emptyHint, fontSize: 12 }}>No options yet.</p>
        ) : (
          <div style={optionList}>
            <div className="diagnostic-option-layout" style={optionHeaderRow}>
              <span>Option text shown to customer</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                Score impact
                <InfoHint text="How much this answer adds to the diagnostic score, out of 10. Use 0 for no impact, low numbers for weaker signals, and 10 for the strongest signal." />
              </span>
              <span />
            </div>
            {opts.map((o, i) => (
              <div key={i} className="diagnostic-option-layout" style={optionEditorRow}>
                <input
                  type="text"
                  placeholder={`Option ${i + 1}`}
                  value={o.label || ''}
                  onChange={(e) => {
                    const label = e.target.value;
                    const shouldRefreshValue =
                      !o.value ||
                      o.value === buildOptionValue(o.label, i) ||
                      (!o.label && /^option_\d+$/i.test(String(o.value)));
                    updateOption(i, {
                      label,
                      value: shouldRefreshValue ? buildOptionValue(label, i) : o.value,
                    });
                  }}
                  style={input}
                  aria-label={`Option ${i + 1} text shown to customer`}
                />
                <input
                  type="number"
                  placeholder="0"
                  value={o.weight ?? ''}
                  min={0}
                  max={10}
                  step={1}
                  onChange={(e) => updateOption(i, { weight: clampScoreImpact(e.target.value) })}
                  style={{ ...input, textAlign: 'center', fontWeight: 700 }}
                  aria-label={`Option ${i + 1} score impact`}
                />
                <IconBtn onClick={() => removeOption(i)} title="Remove option" aria-label={`Remove option ${i + 1}`} danger>
                  <Trash2 size={14} aria-hidden />
                </IconBtn>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Result categories visual editor ──────────────────────────────────

function normalizeQuestions(questions) {
  const usedQuestionIds = new Set();
  return questions.map((question, index) => {
    let id = String(question.id || '').trim();
    if (!id) id = uniqueKey(buildQuestionId(question.text, index), usedQuestionIds);
    usedQuestionIds.add(id);

    const usedOptionValues = new Set();
    const options = Array.isArray(question.options)
      ? question.options.map((option, optionIndex) => {
        let value = String(option.value || '').trim();
        if (!value) value = uniqueKey(buildOptionValue(option.label, optionIndex), usedOptionValues);
        usedOptionValues.add(value);
        return { ...option, value };
      })
      : [];

    return { ...question, id, options };
  });
}

function buildQuestionId(text, index) {
  const raw = String(text || '').toLowerCase();
  if (/\bcurriculum\b|\bboard\b/.test(raw)) return 'curriculum';
  if (/\bgrade\b|\bclass\b|\bstandard\b/.test(raw)) return 'grade';
  if (/\bsubject\b/.test(raw)) return 'subject';
  return slugKey(text) || `q${index + 1}`;
}

function buildOptionValue(label, index) {
  return slugKey(label) || `option_${index + 1}`;
}

function clampScoreImpact(value) {
  if (value === '') return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(10, Math.round(parsed)));
}

function slugKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

function uniqueKey(base, used) {
  const clean = slugKey(base) || 'item';
  if (!used.has(clean)) return clean;
  let n = 2;
  while (used.has(`${clean}_${n}`)) n++;
  return `${clean}_${n}`;
}

function ScoringVisualEditor({ json, onChange, onSwitchToJson }) {
  const parsed = tryParse(json);

  // Normalize missing `method` upfront so validation never fails on an
  // unedited-but-otherwise-valid scoring JSON loaded from an existing bank.
  useEffect(() => {
    if (parsed && Array.isArray(parsed.bands) && !parsed.method) {
      onChange(JSON.stringify({ method: 'weighted-sum', ...parsed }, null, 2));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!parsed || !Array.isArray(parsed.bands)) {
    return (
      <ParseErrorPanel
        title="Result categories"
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
        <h2 style={{ ...cardTitle, marginBottom: 0 }}>Result categories ({bands.length})</h2>
        <button type="button" onClick={addBand} style={addBtn}>
          <Plus size={14} aria-hidden /> Add category
        </button>
      </div>
      <p style={{ color: 'var(--text-secondary)', marginTop: 0, fontSize: 12 }}>
        Use these ranges to decide what result the customer sees after submitting the diagnostic.
      </p>      {bands.length === 0 ? (
        <p style={emptyHint}>No result categories yet. Add one to define what customers see after submitting.</p>
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
        <span style={{ fontWeight: 600 }}>Result category {index + 1}</span>
        <div style={{ display: 'flex', gap: 4 }}>
          <IconBtn onClick={onMoveUp} disabled={index === 0} title="Move up" aria-label="Move category up">
            <ChevronUp size={14} aria-hidden />
          </IconBtn>
          <IconBtn onClick={onMoveDown} disabled={index === total - 1} title="Move down" aria-label="Move category down">
            <ChevronDown size={14} aria-hidden />
          </IconBtn>
          <IconBtn onClick={onRemove} title="Remove category" aria-label="Remove category" danger>
            <Trash2 size={14} aria-hidden />
          </IconBtn>
        </div>
      </div>
      <div style={fieldGrid}>
        <Field label="Score from" info="Lowest score that should use this result category.">
          <input
            type="number"
            value={band.minScore ?? ''}
            onChange={(e) => onChange({ minScore: e.target.value === '' ? 0 : Number(e.target.value) })}
            style={input}
          />
        </Field>
        <Field label="Score to" info="Highest score that should use this result category.">
          <input
            type="number"
            value={band.maxScore ?? ''}
            onChange={(e) => onChange({ maxScore: e.target.value === '' ? 0 : Number(e.target.value) })}
            style={input}
          />
        </Field>
        <Field label="Result name" info="Internal short name for this category. Keep it simple, like starter, ready, or premium.">
          <input
            type="text"
            value={band.classification || ''}
            onChange={(e) => onChange({ classification: e.target.value })}
            style={input}
          />
        </Field>
        <Field label="Shown label" info="Customer-facing result text shown in the CRM and PDF.">
          <input
            type="text"
            value={band.label || ''}
            onChange={(e) => onChange({ label: e.target.value })}
            style={input}
          />
        </Field>
        <Field label="Recommended tier" info="Suggested service or package level for customers in this score range.">
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

function Field({ label, info, children }) {
  return (
    <label style={fieldLabelWrap}>
      <span style={fieldLabel}>
        {label}
        {info && <InfoHint text={info} />}
      </span>
      {children}
    </label>
  );
}

function TemplatePicker({
  banks,
  loading,
  selectedBankId,
  search,
  open,
  onSearchChange,
  onOpenChange,
  onPick,
}) {
  const selected = banks.find((row) => String(row.id) === String(selectedBankId));
  const selectedLabel = selected
    ? selected.templateName || `${String(selected.subBrand || '').toUpperCase()} Template`
    : '';
  const query = String(search || '').trim().toLowerCase();
  const visibleBanks = query
    ? banks.filter((row) => {
      const label = row.templateName || `${String(row.subBrand || '').toUpperCase()} Template`;
      return label.toLowerCase().includes(query);
    })
    : banks;

  return (
    <div style={templatePickerWrap}>
      <input
        type="text"
        value={open ? search : selectedLabel}
        onChange={(e) => {
          onSearchChange(e.target.value);
          onOpenChange(true);
        }}
        onFocus={() => onOpenChange(true)}
        placeholder={loading ? 'Loading templates...' : banks.length ? 'Search templates...' : 'No saved templates yet'}
        disabled={loading || banks.length === 0}
        style={{ ...input, paddingRight: 38, width: '100%' }}
        aria-label="Search active templates"
      />
      <button
        type="button"
        onClick={() => {
          if (loading || banks.length === 0) return;
          onSearchChange('');
          onOpenChange(!open);
        }}
        style={templatePickerToggle}
        aria-label={open ? 'Close template list' : 'Open template list'}
        disabled={loading || banks.length === 0}
      >
        <ChevronDown size={16} aria-hidden />
      </button>
      {open && !loading && banks.length > 0 && (
        <div style={templatePickerMenu}>
          {visibleBanks.length === 0 ? (
            <div style={templatePickerEmpty}>No templates match this search.</div>
          ) : (
            visibleBanks.map((row) => {
              const label = row.templateName || `${String(row.subBrand || '').toUpperCase()} Template`;
              const active = String(row.id) === String(selectedBankId);
              return (
                <button
                  key={row.id}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onPick(row)}
                  style={active ? templatePickerOptionActive : templatePickerOption}
                >
                  {label}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

function InfoHint({ text }) {
  const [open, setOpen] = useState(false);

  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={text}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      style={infoHintWrap}
    >
      <Info size={13} aria-hidden style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
      {open && (
        <span style={infoTooltip}>
          {text}
        </span>
      )}
    </span>
  );
}

function IconBtn({ children, onClick, disabled, title, danger = false, ...rest }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        ...iconBtn,
        color: danger ? 'var(--danger-color)' : iconBtn.color,
        opacity: disabled ? 0.45 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
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
      <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--danger-color)', fontSize: 13 }}>
        <AlertTriangle size={16} aria-hidden /> {message}
      </div>
      <button type="button" onClick={onSwitchToJson} style={{ ...secondaryBtn, marginTop: 12 }}>
        Open advanced JSON
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

// ─── Recommendation Settings panel (TMC) ──────────────────────────────
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
  { key: 'weightPrimaryOutcome',  label: 'Main trip goal',          defaultValue: 50, max: 100, hint: 'How much the main selected goal should influence the recommended trip.' },
  { key: 'weightSecondarySkill',  label: 'Extra skills wanted',     defaultValue: 20, max: 60,  hint: 'How much additional learning or skill preferences should influence the match.' },
  { key: 'weightGrowthArea',      label: 'Growth focus',            defaultValue: 15, max: 60,  hint: 'How much the chosen student-growth area should influence recommendations.' },
  { key: 'weightCurriculumHook',  label: 'Curriculum match',        defaultValue: 10, max: 60,  hint: 'How strongly curriculum, board, grade, or subject fit should influence recommendations.' },
  { key: 'weightGradeBandCenter', label: 'Grade fit',               defaultValue: 10, max: 60,  hint: 'How much the student grade range should affect the recommended trip.' },
  { key: 'weightTierValueLean',   label: 'Budget and value fit',    defaultValue:  8, max: 60,  hint: 'How much budget/value preference should influence the final recommendation.' },
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
      notify.error('Recommendation settings are ADMIN-only.');
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
      notify.success(`Recommendation settings saved (version ${merged.version}).`);
    } catch (e) {
      notify.error(e?.body?.error || e?.message || 'Failed to save recommendation settings');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <section style={card} aria-busy="true">
        <h2 style={cardTitle}>
          <Settings size={18} aria-hidden /> Recommendation Settings
        </h2>
        <p style={{ color: 'var(--text-secondary)' }}>Loading recommendation settings...</p>
      </section>
    );
  }

  if (loadError) {
    return (
      <section style={{ ...card, borderLeft: '4px solid var(--danger-color)' }}>
        <h2 style={cardTitle}>
          <Settings size={18} aria-hidden /> Recommendation Settings
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
    <section style={card} aria-label="Recommendation Settings">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ ...cardTitle, margin: 0 }}>
          <Settings size={18} aria-hidden /> Recommendation Settings
        </h2>
      </div>
      <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: '0 0 12px' }}>
        Adjust how strongly each answer affects the recommended trip result.
      </p>

      <div style={fieldGrid}>
        {WEIGHT_FIELDS.map((f) => (
          <Field key={f.key} label={f.label} info={f.hint}>
            <div style={sliderControl}>
              <input
                type="range"
                value={weights[f.key]}
                onChange={(e) => updateField(f.key, e.target.value)}
                style={rangeInput}
                className="diagnostic-weight-range"
                aria-label={f.label}
                min={0}
                max={f.max || 100}
                step={1}
              />
              <span style={sliderValue}>{weights[f.key]}</span>
            </div>
            <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{f.hint}</span>
          </Field>
        ))}
        <Field label="Strong match threshold" info="Trips scoring at or above this value are treated as strong matches by the recommendation engine.">
          <div style={sliderControl}>
            <input
              type="range"
              value={weights.scoresWellThreshold}
              onChange={(e) => updateField('scoresWellThreshold', e.target.value)}
              style={rangeInput}
              className="diagnostic-weight-range"
              aria-label="Strong match threshold"
              min={0}
              max={100}
              step={1}
            />
            <span style={sliderValue}>{weights.scoresWellThreshold}</span>
          </div>
          <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
            Minimum score needed for the system to treat a trip as a strong recommendation.
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
            Read-only. Admin access is required to save.
          </span>
        )}
        <button
          type="button"
          onClick={onSave}
          disabled={saving || !isAdmin}
          style={saving || !isAdmin ? primaryBtnDisabled : primaryBtn}
          aria-label="Save recommendation settings"
        >
          <Save size={14} aria-hidden /> {saving ? 'Saving...' : 'Save recommendation settings'}
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
const advancedTools = {
  margin: '0 0 12px',
  padding: '10px 12px',
  borderRadius: 8,
  border: '1px solid var(--border-color)',
  background: 'var(--surface-color)',
};
const advancedSummary = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  cursor: 'pointer',
  fontWeight: 600,
  fontSize: 13,
  color: 'var(--text-primary)',
};
const advancedBody = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  flexWrap: 'wrap',
  marginTop: 10,
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
const dangerBtn = {
  ...secondaryBtn,
  color: 'var(--danger-color)',
  border: '1px solid rgba(220, 38, 38, 0.35)',
  background: 'rgba(220, 38, 38, 0.08)',
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
  display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))',
  gap: 16, marginTop: 6,
};
const questionSetupGrid = {
  display: 'grid',
  gridTemplateColumns: 'minmax(180px, 260px) minmax(280px, 1fr)',
  gap: 12,
  marginTop: 12,
};
const microHint = {
  color: 'var(--text-secondary)',
  fontSize: 11,
  lineHeight: 1.4,
  marginTop: 3,
};
const optionList = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};
const optionHeaderRow = {
  display: 'grid',
  gridTemplateColumns: 'minmax(220px, 1fr) 112px 28px',
  gap: 8,
  color: 'var(--text-secondary)',
  fontSize: 11,
  fontWeight: 700,
  padding: '0 0 2px',
};
const optionEditorRow = {
  display: 'grid',
  gridTemplateColumns: 'minmax(220px, 1fr) 112px 28px',
  gap: 8,
  alignItems: 'center',
};
const sliderControl = {
  display: 'grid',
  gridTemplateColumns: 'minmax(170px, 1fr) 58px',
  gap: 12,
  alignItems: 'center',
};
const rangeInput = {
  width: '100%',
  height: 28,
  accentColor: 'var(--primary-color)',
};
const sliderValue = {
  minWidth: 58,
  padding: '7px 10px',
  borderRadius: 8,
  background: 'var(--subtle-bg, rgba(91, 110, 248, 0.10))',
  border: '1px solid var(--border-color)',
  color: 'var(--text-primary)',
  fontSize: 13,
  fontWeight: 700,
  textAlign: 'center',
};
const fieldLabelWrap = {
  display: 'flex', flexDirection: 'column', gap: 4,
};
const fieldLabel = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  fontSize: 12, color: 'var(--text-secondary)', fontWeight: 500,
};
const infoHintWrap = {
  position: 'relative',
  display: 'inline-flex',
  alignItems: 'center',
  cursor: 'help',
  lineHeight: 1,
  zIndex: 30,
};
const infoTooltip = {
  position: 'absolute',
  left: 18,
  top: '50%',
  transform: 'translateY(-50%)',
  zIndex: 2147483647,
  width: 260,
  maxWidth: 'calc(100vw - 24px)',
  padding: '8px 10px',
  borderRadius: 8,
  border: '1px solid var(--border-color)',
  background: '#ffffff',
  color: '#111827',
  boxShadow: '0 16px 40px rgba(15, 23, 42, 0.28)',
  fontSize: 12,
  fontWeight: 500,
  lineHeight: 1.45,
  whiteSpace: 'normal',
  pointerEvents: 'none',
  opacity: 1,
};
const templatePickerWrap = {
  position: 'relative',
  width: '100%',
  zIndex: 40,
};
const templatePickerToggle = {
  position: 'absolute',
  right: 4,
  top: 4,
  width: 28,
  height: 28,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: 'none',
  borderRadius: 6,
  background: 'transparent',
  color: 'var(--text-secondary)',
  cursor: 'pointer',
};
const templatePickerMenu = {
  position: 'absolute',
  left: 0,
  right: 0,
  top: 'calc(100% + 6px)',
  zIndex: 2147483646,
  maxHeight: 260,
  overflowY: 'auto',
  padding: 6,
  borderRadius: 8,
  border: '1px solid var(--border-color)',
  background: 'var(--bg-color)',
  boxShadow: '0 18px 44px rgba(15, 23, 42, 0.34), inset 0 0 0 999px var(--bg-color)',
  opacity: 1,
};
const templatePickerOption = {
  width: '100%',
  display: 'block',
  padding: '8px 10px',
  border: 'none',
  borderRadius: 6,
  background: 'transparent',
  color: 'var(--text-primary)',
  textAlign: 'left',
  fontFamily: 'inherit',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
};
const templatePickerOptionActive = {
  ...templatePickerOption,
  background: 'var(--primary-color)',
  color: '#fff',
};
const templatePickerEmpty = {
  padding: '10px',
  color: 'var(--text-secondary)',
  fontSize: 13,
};
const diagnosticBuilderCss = `
  @media (max-width: 760px) {
    .diagnostic-question-layout {
      grid-template-columns: 1fr !important;
    }

    .diagnostic-option-layout {
      grid-template-columns: 1fr 96px 28px !important;
    }
  }

  .diagnostic-weight-range {
    appearance: none;
    -webkit-appearance: none;
    height: 28px;
    background: transparent;
    cursor: pointer;
  }

  .diagnostic-weight-range::-webkit-slider-runnable-track {
    height: 10px;
    border-radius: 999px;
    background: linear-gradient(90deg, var(--primary-color, #4f46e5), var(--accent-color, #6d5dfc));
    border: 1px solid rgba(15, 23, 42, 0.12);
    box-shadow: inset 0 1px 2px rgba(15, 23, 42, 0.16);
  }

  .diagnostic-weight-range::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 22px;
    height: 22px;
    margin-top: -7px;
    border-radius: 999px;
    border: 3px solid #ffffff;
    background: var(--primary-color, #4f46e5);
    box-shadow: 0 2px 8px rgba(15, 23, 42, 0.28);
  }

  .diagnostic-weight-range:focus-visible {
    outline: 2px solid var(--primary-color, #4f46e5);
    outline-offset: 4px;
    border-radius: 999px;
  }

  .diagnostic-weight-range::-moz-range-track {
    height: 10px;
    border-radius: 999px;
    background: linear-gradient(90deg, var(--primary-color, #4f46e5), var(--accent-color, #6d5dfc));
    border: 1px solid rgba(15, 23, 42, 0.12);
    box-shadow: inset 0 1px 2px rgba(15, 23, 42, 0.16);
  }

  .diagnostic-weight-range::-moz-range-thumb {
    width: 18px;
    height: 18px;
    border-radius: 999px;
    border: 3px solid #ffffff;
    background: var(--primary-color, #4f46e5);
    box-shadow: 0 2px 8px rgba(15, 23, 42, 0.28);
  }
`;
const emptyHint = {
  color: 'var(--text-secondary)', fontSize: 13, fontStyle: 'italic', margin: '4px 0',
};
