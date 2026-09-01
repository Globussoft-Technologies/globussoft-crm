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
  AlertTriangle, Check, CheckCircle, ChevronDown, ChevronLeft, ChevronUp,
  Download, FileJson, Info, Lightbulb, Pencil, Plus, Save, Settings, Trash2, Upload, X,
} from 'lucide-react';
import { fetchApi, getAuthToken } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { AuthContext } from '../../App';
import DiagnosticPublicFormPanel from './DiagnosticPublicFormPanel';
import DiagnosticNotificationPanel from './DiagnosticNotificationPanel';
import {
  SUGGESTED_DIAGNOSTIC_QUESTIONS,
  SUGGESTION_CATEGORY_LABELS,
  questionMatchesSuggestion,
} from '../../components/travel/suggestedDiagnosticQuestions';

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
  // Snapshot of what's actually persisted for the currently-loaded bank —
  // { templateName, qJson, rJson } | null (null while drafting a brand-new
  // template, where there's nothing yet to compare against). Used by
  // onSaveAndUse to skip creating a pointless new version when nothing
  // changed (every save otherwise unconditionally creates v(N+1) — harmless
  // in isolation, but clicking Save repeatedly with no edits was flooding
  // the template picker with dozens of identical versions).
  const [savedSnapshot, setSavedSnapshot] = useState(null);
  const fileRef = useRef(null);

  const defaultTemplateName = useCallback(
    () => `${SUB_BRANDS.find((item) => item.value === subBrand)?.label || subBrand.toUpperCase()} Template`,
    [subBrand],
  );

  const loadTemplateIntoEditor = useCallback((bank) => {
    if (!bank) return;
    const q = prettyJson(bank.questionsJson, QUESTIONS_EXAMPLE);
    const r = prettyJson(bank.scoringRulesJson, SCORING_EXAMPLE);
    const name = bank.templateName || defaultTemplateName();
    setQJson(q);
    setRJson(r);
    setSelectedBankId(String(bank.id));
    setTemplateName(name);
    setBankInfo({
      existing: true,
      id: bank.id,
      version: bank.version,
      templateName: name,
      isActive: bank.isActive !== false,
    });
    setSavedSnapshot({ templateName: name, qJson: q, rJson: r });
    setIsCreatingTemplate(false);
    setTemplatePickerOpen(false);
    setTemplateSearch('');
  }, [defaultTemplateName]);

  const beginTemplateDraft = useCallback((name) => {
    const resolvedName = String(name || '').trim() || defaultTemplateName();
    setQJson(QUESTIONS_EXAMPLE);
    setRJson(SCORING_EXAMPLE);
    setSelectedBankId('');
    setTemplateName(resolvedName);
    setBankInfo({ existing: false, templateName: resolvedName });
    setSavedSnapshot(null);
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
    let normalizedRJson = rJson;
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
      } else if (r.method !== 'weighted-sum') {
        normalizedRJson = JSON.stringify({ ...r, method: 'weighted-sum' }, null, 2);
      }
    } catch (e) {
      errors.push(`scoringRulesJson is not valid JSON: ${e.message}`);
    }
    return { ok: errors.length === 0, errors, normalizedRJson };
  };

  const onSaveAndUse = async () => {
    const result = validate();
    if (!result.ok) {
      notify.error(result.errors[0] || 'Fix validation errors before saving');
      return;
    }
    if (result.normalizedRJson !== rJson) {
      setRJson(result.normalizedRJson);
    }
    const cleanTemplateName = String(templateName || '').trim();
    if (!cleanTemplateName) {
      notify.error('Template name is required');
      return;
    }
    if (
      bankInfo?.existing &&
      savedSnapshot &&
      cleanTemplateName === savedSnapshot.templateName &&
      jsonEquivalent(qJson, savedSnapshot.qJson) &&
      jsonEquivalent(rJson, savedSnapshot.rJson)
    ) {
      notify.info('No changes to save — this template is already up to date.');
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
          scoringRulesJson: result.normalizedRJson,
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

  const onRenameTemplate = async (nextName) => {
    if (!bankInfo?.existing || !bankInfo?.id) return;
    const cleanTemplateName = String(nextName ?? templateName ?? '').trim();
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
      notify.success(`Renamed to "${cleanTemplateName}".`);
      await loadBanks(bankInfo.id);
    } catch (e) {
      notify.error(e?.body?.error || 'Failed to rename template');
    } finally {
      setRenamingTemplate(false);
    }
  };

  const onClickRename = async () => {
    if (!bankInfo?.existing || !bankInfo?.id) return;
    const current = bankInfo.templateName || templateName || '';
    const next = await notify.prompt({
      title: 'Rename template',
      message: 'Give this template a clear name so your team can recognize it later.',
      defaultValue: current,
      placeholder: 'Template name',
      confirmText: 'Rename',
    });
    if (next == null) return; // cancelled
    const cleanName = String(next).trim();
    if (!cleanName) {
      notify.error('Template name is required');
      return;
    }
    if (cleanName === current) return;
    setTemplateName(cleanName);
    await onRenameTemplate(cleanName);
  };

  const onClickNewTemplate = async () => {
    const brandLabel = SUB_BRANDS.find((s) => s.value === subBrand)?.label || subBrand.toUpperCase();
    const next = await notify.prompt({
      title: 'New template',
      message: `Name your new ${brandLabel} template. You'll build out its questions and scoring next, then save it to finish creating it.`,
      defaultValue: defaultTemplateName(),
      placeholder: 'Template name',
      confirmText: 'Start template',
    });
    if (next == null) return; // cancelled
    const cleanName = String(next).trim();
    if (!cleanName) {
      notify.error('Template name is required');
      return;
    }
    beginTemplateDraft(cleanName);
  };

  // Bulk delete (2026-08-25) — invoked from TemplatePicker's multi-select
  // mode. Reuses the existing single-bank DELETE endpoint (no bulk endpoint
  // exists and none is needed) fired in parallel via Promise.allSettled so
  // one failing row never blocks the rest. Returns true once the user has
  // confirmed and the requests were issued (success or partial failure),
  // false if they cancelled — TemplatePicker uses that to decide whether to
  // clear its selection.
  const onBulkDeleteTemplates = useCallback(async (ids) => {
    const idSet = new Set(ids.map(String));
    const selectedRows = banks.filter((row) => idSet.has(String(row.id)));
    if (!selectedRows.length) return false;

    const willWipeAll = idSet.size === banks.length;
    const includesCurrent = idSet.has(String(selectedBankId));
    // Cap the listed names — the confirm modal has no scroll/max-height, so
    // an unbounded list (seen with a 99-row bulk selection) blows past the
    // viewport and hides the confirm/cancel buttons entirely.
    const NAME_LIST_LIMIT = 10;
    const nameLines = selectedRows
      .slice(0, NAME_LIST_LIMIT)
      .map((row) => `• ${row.templateName || defaultTemplateName()} (v${row.version ?? '—'})`);
    if (selectedRows.length > NAME_LIST_LIMIT) {
      nameLines.push(`…and ${selectedRows.length - NAME_LIST_LIMIT} more.`);
    }
    const names = nameLines.join('\n');
    const warnings = [
      includesCurrent
        ? 'The template you are currently editing is included — the editor will switch to another template afterward.'
        : null,
      willWipeAll
        ? 'This removes every saved template for this sub-brand — you will start from a blank draft afterward.'
        : null,
    ].filter(Boolean);

    const ok = await notify.confirm({
      title: `Delete ${selectedRows.length} template${selectedRows.length > 1 ? 's' : ''}?`,
      message: ['This cannot be undone.', '', names, ...(warnings.length ? ['', ...warnings] : [])].join('\n'),
      confirmText: `Delete ${selectedRows.length}`,
      destructive: true,
    });
    if (!ok) return false;

    const results = await Promise.allSettled(
      selectedRows.map((row) => fetchApi(`/api/travel/diagnostic-banks/${row.id}`, { method: 'DELETE' })),
    );
    const failedCount = results.filter((r) => r.status === 'rejected').length;
    const succeededCount = selectedRows.length - failedCount;
    if (succeededCount > 0) {
      notify.success(`Deleted ${succeededCount} template${succeededCount > 1 ? 's' : ''}.`);
    }
    if (failedCount > 0) {
      notify.error(`Failed to delete ${failedCount} template${failedCount > 1 ? 's' : ''}. Try again.`);
    }
    await loadBanks();
    return true;
  }, [banks, selectedBankId, defaultTemplateName, notify, loadBanks]);

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
        <div style={{ marginTop: 16 }}>
          <Field label="Active template" info="Choose the saved diagnostic template to edit and use for this travel brand. Each save creates a new version, so a template can have several versions listed here — the newest is shown first.">
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 320px', minWidth: 240 }}>
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
                  onBulkDelete={onBulkDeleteTemplates}
                />
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {bankInfo?.existing && !isCreatingTemplate && (
                  <button
                    type="button"
                    onClick={onClickRename}
                    disabled={renamingTemplate}
                    style={renamingTemplate ? primaryBtnDisabled : secondaryBtn}
                    title="Rename this template"
                  >
                    <Pencil size={14} aria-hidden /> {renamingTemplate ? 'Renaming...' : 'Rename'}
                  </button>
                )}
                {bankInfo?.existing && !isCreatingTemplate && (
                  <button
                    type="button"
                    onClick={onDeleteTemplate}
                    disabled={deletingTemplate}
                    style={deletingTemplate ? primaryBtnDisabled : dangerBtn}
                    title="Delete this template version"
                  >
                    <Trash2 size={14} aria-hidden /> {deletingTemplate ? 'Deleting...' : 'Delete'}
                  </button>
                )}
                <button type="button" onClick={onClickNewTemplate} style={primaryBtn} title="Start a new template from scratch">
                  <Plus size={14} aria-hidden /> New template
                </button>
              </div>
            </div>
          </Field>
        </div>
        {isCreatingTemplate ? (
          <div style={draftBanner}>
            <Lightbulb size={16} aria-hidden style={{ flexShrink: 0, marginTop: 1 }} />
            <span>
              <strong>Creating &ldquo;{templateName}&rdquo;</strong> — build out its questions and scoring below, then click{' '}
              <strong>Save and use</strong> to finish creating it. Nothing is saved until you do.
            </span>
          </div>
        ) : (
          <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: '10px 0 0' }}>
            {loadingBank
              ? 'Loading this brand’s current templates…'
              : bankInfo?.existing
                ? `Editing "${bankInfo.templateName || templateName}" (version ${bankInfo.version ?? '—'}). Saving creates a new version — the current one is kept in the history above.`
                : 'No diagnostic template exists for this brand yet — starting from a fresh template.'}
          </p>
        )}
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
      {mode === 'notifications' && (
        <DiagnosticNotificationPanel
          subBrand={subBrand}
          notify={notify}
          isAdmin={isAdmin}
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

      {/* Only the Visual/Advanced-JSON tabs edit qJson/rJson — Public Form
          and Recommendation Settings each have their own dedicated Save
          button for a completely different payload, so showing this bar
          there too was a redundant, overlapping second "Save" control. */}
      {(mode === 'visual' || mode === 'json') && (
        <div style={saveBar}>
          <button
            type="button"
            onClick={onSaveAndUse}
            disabled={saving}
            style={saving ? primaryBtnDisabled : { ...primaryBtn, boxShadow: '0 8px 24px rgba(79, 70, 229, 0.35)' }}
            aria-label={isCreatingTemplate ? 'Create and use template' : 'Save and use template'}
          >
            <Save size={16} aria-hidden /> {saving ? 'Saving...' : isCreatingTemplate ? 'Create and use' : 'Save and use'}
          </button>
        </div>
      )}
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
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'notifications'}
        onClick={() => onChange('notifications')}
        style={mode === 'notifications' ? tabActive : tabIdle}
      >
        Notifications
      </button>
    </div>
  );
}

// ─── Questions visual editor ──────────────────────────────────────────

function QuestionsVisualEditor({ json, onChange, onSwitchToJson }) {
  const [suggestOpen, setSuggestOpen] = useState(false);
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

  const addSuggestedQuestion = (suggestion) => {
    writeQuestions([
      ...questions,
      {
        id: suggestion.question.id,
        text: suggestion.question.text,
        type: suggestion.question.type,
        options: suggestion.question.options.map((o) => ({ ...o })),
      },
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

  const setAllRequired = (required) =>
    writeQuestions(questions.map((q) => ({ ...q, required })));

  const allRequired = questions.length > 0 && questions.every((q) => q.required);
  const noneRequired = questions.length === 0 || questions.every((q) => !q.required);

  return (
    <section style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4, flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ ...cardTitle, marginBottom: 0 }}>Questions ({questions.length})</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={() => setSuggestOpen(true)} style={secondaryBtn}>
            <Lightbulb size={14} aria-hidden /> Suggested questions
          </button>
          <button type="button" onClick={addQuestion} style={addBtn}>
            <Plus size={14} aria-hidden /> Add question
          </button>
        </div>
      </div>
      {questions.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            Customers must answer required questions before they can submit.
          </span>
          <button
            type="button"
            onClick={() => setAllRequired(true)}
            disabled={allRequired}
            style={allRequired ? bulkRequireBtnActive : bulkRequireBtn}
          >
            <CheckCircle size={13} aria-hidden /> Require all
          </button>
          <button
            type="button"
            onClick={() => setAllRequired(false)}
            disabled={noneRequired}
            style={noneRequired ? bulkRequireBtnActive : bulkRequireBtn}
          >
            Make all optional
          </button>
        </div>
      )}
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
      {suggestOpen && (
        <SuggestedQuestionsPanel
          questions={questions}
          onAdd={addSuggestedQuestion}
          onClose={() => setSuggestOpen(false)}
        />
      )}
    </section>
  );
}

// Suggested-questions panel — self-contained modal listing curated TMC
// diagnostic questions (frontend/src/components/travel/suggestedDiagnosticQuestions.js)
// with "why this helps" copy tied to the curriculum-matching and RAG
// recommendation systems. Adding a suggestion pushes a normal question
// object through the same writeQuestions() path "Add question" uses, so it
// plugs into the existing add/edit/reorder flow with zero backend changes.
// Suggestions already present in the question list (matched by id or by
// close text match — see questionMatchesSuggestion) are left out of the list.
function SuggestedQuestionsPanel({ questions, onAdd, onClose }) {
  const visibleSuggestions = SUGGESTED_DIAGNOSTIC_QUESTIONS.filter(
    (suggestion) => !questions.some((q) => questionMatchesSuggestion(q, suggestion)),
  );

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="presentation"
      style={suggestModalBackdrop}
    >
      <div style={suggestModalCard} role="dialog" aria-modal="true" aria-labelledby="suggested-questions-title">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <h2
            id="suggested-questions-title"
            style={{ margin: 0, fontSize: 18, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}
          >
            <Lightbulb size={18} aria-hidden /> Suggested questions
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" style={iconBtn}>
            <X size={16} aria-hidden />
          </button>
        </div>
        <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: '0 0 14px' }}>
          Common TMC diagnostic questions that feed curriculum matching and the AI recommendation
          engine. Add the ones relevant to your form.
        </p>
        {visibleSuggestions.length === 0 ? (
          <p style={emptyHint}>All suggested questions have already been added.</p>
        ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            {visibleSuggestions.map((suggestion) => (
              <div key={suggestion.question.id} style={suggestCard}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 0, flex: '1 1 280px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <strong style={{ fontSize: 14 }}>{suggestion.question.text}</strong>
                      <span style={suggestBadge(suggestion.category)}>
                        {SUGGESTION_CATEGORY_LABELS[suggestion.category] || suggestion.category}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                      {QUESTION_TYPES.find((t) => t.value === suggestion.question.type)?.label || suggestion.question.type}
                      {Array.isArray(suggestion.question.options) && suggestion.question.options.length > 0 && (
                        <> · {suggestion.question.options.map((o) => o.label).join(', ')}</>
                      )}
                    </div>
                    <p style={{ margin: '8px 0 0', fontSize: 13, lineHeight: 1.5 }}>
                      <Info size={12} aria-hidden style={{ verticalAlign: -1, marginRight: 4, color: 'var(--text-secondary)' }} />
                      {suggestion.why}
                    </p>
                  </div>
                  <button type="button" onClick={() => onAdd(suggestion)} style={addBtnSmall}>
                    <Plus size={12} aria-hidden /> Add
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Standard pill toggle switch — same visual pattern used across the travel
// admin pages (e.g. CostMaster.jsx, DiagnosticPublicFormPanel.jsx). Kept
// locally since no shared toggle component exists yet in this codebase.
function PillToggle({ active, onChange, label }) {
  return (
    <button
      type="button"
      onClick={onChange}
      role="switch"
      aria-checked={active}
      aria-label={label}
      style={{
        position: 'relative', width: 36, height: 20, borderRadius: 999,
        border: active ? '1px solid var(--success-color, #3ecf7e)' : '1px solid var(--border-color)',
        background: active ? 'rgba(62,207,126,0.18)' : 'var(--surface-color)',
        cursor: 'pointer', padding: 0, flexShrink: 0,
        transition: 'background .15s ease, border-color .15s ease',
      }}
    >
      <span style={{
        position: 'absolute', top: 2, left: active ? 17 : 2,
        width: 14, height: 14, borderRadius: '50%',
        background: active ? 'var(--success-color, #3ecf7e)' : 'var(--text-secondary)',
        transition: 'left .15s ease, background .15s ease',
      }} />
    </button>
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: question.required ? 'var(--success-color, #3ecf7e)' : 'var(--text-secondary)', cursor: 'pointer' }}>
            Required
            <PillToggle
              active={Boolean(question.required)}
              onChange={() => onChange({ required: !question.required })}
              label={`Question ${index + 1} required`}
            />
          </label>
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

  // Normalize legacy/sentinel methods upfront because this editor saves
  // through the generic weighted-sum diagnostic-bank endpoint.
  useEffect(() => {
    if (parsed && Array.isArray(parsed.bands) && parsed.method !== 'weighted-sum') {
      onChange(JSON.stringify({ ...parsed, method: 'weighted-sum' }, null, 2));
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
  const method = 'weighted-sum';

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

// Short, locale-formatted date for disambiguating same-named template
// versions in the picker (e.g. several saves of "TMC Template" each create
// a new version row — see the file header note on POST /diagnostic-banks).
function formatBankTimestamp(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
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
  onBulkDelete,
}) {
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkSelectedIds, setBulkSelectedIds] = useState(() => new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
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

  // "Current" = the highest-version row for this sub-brand — the one the
  // public form + diagnostic engine actually resolve to. NOT the same as
  // the row's own `isActive` flag: every saved version keeps isActive=true
  // forever (nothing in this app flips it off on a new save — see
  // travel_diagnostics.js's POST /diagnostic-banks comment), so isActive
  // alone can't tell versions apart. Verified this against a real dropdown
  // where every entry showed "Live".
  const currentBankId = banks.reduce(
    (best, row) => (!best || Number(row.version || 0) > Number(best.version || 0) ? row : best),
    null,
  )?.id;

  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        onOpenChange(false);
      }
    };
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onOpenChange(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onOpenChange]);

  // Exit multi-select whenever the dropdown closes (outside click, Escape,
  // or a normal single-template pick) so it never reopens mid-selection for
  // an unrelated reason.
  useEffect(() => {
    if (!open) {
      setBulkMode(false);
      setBulkSelectedIds(new Set());
    }
  }, [open]);

  const toggleBulkSelected = (id) => {
    setBulkSelectedIds((prev) => {
      const next = new Set(prev);
      const key = String(id);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const allVisibleSelected = visibleBanks.length > 0 && visibleBanks.every((row) => bulkSelectedIds.has(String(row.id)));

  const handleSelectAllVisible = () => {
    setBulkSelectedIds((prev) => {
      if (allVisibleSelected) {
        const next = new Set(prev);
        visibleBanks.forEach((row) => next.delete(String(row.id)));
        return next;
      }
      const next = new Set(prev);
      visibleBanks.forEach((row) => next.add(String(row.id)));
      return next;
    });
  };

  const handleBulkDeleteClick = async () => {
    if (!bulkSelectedIds.size || !onBulkDelete) return;
    setBulkDeleting(true);
    try {
      const proceeded = await onBulkDelete([...bulkSelectedIds]);
      if (proceeded) {
        setBulkMode(false);
        setBulkSelectedIds(new Set());
      }
    } finally {
      setBulkDeleting(false);
    }
  };

  return (
    <div style={templatePickerWrap} ref={wrapRef}>
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
          {banks.length > 1 && (
            <div style={templatePickerBulkBar}>
              {!bulkMode ? (
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setBulkMode(true)}
                  style={templatePickerBulkToggle}
                >
                  <Trash2 size={12} aria-hidden /> Select multiple to delete
                </button>
              ) : (
                <>
                  <span style={templatePickerBulkCount}>
                    {bulkSelectedIds.size ? `${bulkSelectedIds.size} selected` : 'Select templates to delete'}
                  </span>
                  <span style={{ flex: 1 }} />
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={handleSelectAllVisible}
                    style={templatePickerBulkLink}
                  >
                    {allVisibleSelected ? 'Clear' : 'Select all'}
                  </button>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => { setBulkMode(false); setBulkSelectedIds(new Set()); }}
                    style={templatePickerBulkLink}
                  >
                    Cancel
                  </button>
                </>
              )}
            </div>
          )}
          {visibleBanks.length === 0 ? (
            <div style={templatePickerEmpty}>No templates match this search.</div>
          ) : (
            visibleBanks.map((row) => {
              const label = row.templateName || `${String(row.subBrand || '').toUpperCase()} Template`;
              const active = String(row.id) === String(selectedBankId);
              const meta = [
                Number.isFinite(row.version) ? `v${row.version}` : null,
                String(row.id) === String(currentBankId) ? 'Current' : null,
                formatBankTimestamp(row.updatedAt || row.createdAt),
              ].filter(Boolean).join(' · ');

              if (bulkMode) {
                const checked = bulkSelectedIds.has(String(row.id));
                return (
                  <button
                    key={row.id}
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    className="template-picker-option"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => toggleBulkSelected(row.id)}
                    style={templatePickerOption}
                  >
                    <span style={checked ? templatePickerCheckboxChecked : templatePickerCheckbox}>
                      {checked && <Check size={11} aria-hidden />}
                    </span>
                    <span style={templatePickerOptionText}>
                      <span style={templatePickerOptionName}>{label}</span>
                      {meta && <span style={templatePickerOptionMeta}>{meta}</span>}
                    </span>
                  </button>
                );
              }

              return (
                <button
                  key={row.id}
                  type="button"
                  className={active ? 'template-picker-option template-picker-option--active' : 'template-picker-option'}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onPick(row)}
                  style={active ? templatePickerOptionActive : templatePickerOption}
                >
                  <span style={templatePickerOptionCheck}>
                    {active && <Check size={14} aria-hidden />}
                  </span>
                  <span style={templatePickerOptionText}>
                    <span style={templatePickerOptionName}>{label}</span>
                    {meta && <span style={templatePickerOptionMeta}>{meta}</span>}
                  </span>
                </button>
              );
            })
          )}
          {bulkMode && bulkSelectedIds.size > 0 && (
            <div style={templatePickerBulkFooter}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={handleBulkDeleteClick}
                disabled={bulkDeleting}
                style={bulkDeleting ? templatePickerBulkDeleteBtnDisabled : templatePickerBulkDeleteBtn}
              >
                <Trash2 size={14} aria-hidden />
                {bulkDeleting ? 'Deleting…' : `Delete ${bulkSelectedIds.size} selected`}
              </button>
            </div>
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

// Order-of-keys-independent JSON equality (array order still matters) — used
// to tell whether the editor's current questions/scoring actually differ
// from what's persisted, so an unmodified "Save and use" click can skip
// creating a no-op version instead of always minting v(N+1).
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function jsonEquivalent(a, b) {
  try {
    return stableStringify(JSON.parse(a)) === stableStringify(JSON.parse(b));
  } catch {
    return false; // unparseable — never claim "unchanged", let validate() surface the real error
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
  // "Max recommendations shown" (topK) — a separate admin-configurable
  // setting from the weights above (see backend/lib/diagnosticRecommendationSettings.js).
  // Loaded alongside the weights but saved independently, so this doesn't
  // get tangled into the already-tested weights auto-bump-version flow.
  const [topK, setTopK] = useState(10);
  const [topKBaseline, setTopKBaseline] = useState(10);
  const [topKSaving, setTopKSaving] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    Promise.all([
      fetchApi('/api/travel/engine-weights', { silent: true }).catch((e) => {
        // 404 = no row yet; show the §3.3.3 defaults so the first save
        // POSTs a brand-new row. Other errors surface to the operator.
        if (e?.status === 404) return null;
        throw e;
      }),
      fetchApi('/api/travel/diagnostics/recommendation-settings?subBrand=tmc', { silent: true }).catch(() => null),
    ])
      .then(([weightsRes, topKRes]) => {
        const row = weightsRes?.engineWeights || weightsRes;
        if (row && typeof row === 'object') {
          const merged = { ...DEFAULT_TMC_WEIGHTS, ...row };
          setWeights(merged);
          setBaseline(merged);
        } else {
          setWeights(DEFAULT_TMC_WEIGHTS);
          setBaseline(DEFAULT_TMC_WEIGHTS);
        }
        const resolvedTopK = Number.isFinite(topKRes?.topK) ? topKRes.topK : 10;
        setTopK(resolvedTopK);
        setTopKBaseline(resolvedTopK);
      })
      .catch((e) => {
        setLoadError(e?.message || 'Failed to load engine weights');
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const onSaveTopK = async () => {
    if (!isAdmin) {
      notify.error('Recommendation settings are ADMIN-only.');
      return;
    }
    setTopKSaving(true);
    try {
      const res = await fetchApi('/api/travel/diagnostics/recommendation-settings', {
        method: 'PUT',
        body: JSON.stringify({ subBrand: 'tmc', topK }),
      });
      const saved = Number.isFinite(res?.topK) ? res.topK : topK;
      setTopK(saved);
      setTopKBaseline(saved);
      notify.success(`Max recommendations shown set to ${saved}.`);
    } catch (e) {
      notify.error(e?.body?.error || e?.message || 'Failed to save recommendation count');
    } finally {
      setTopKSaving(false);
    }
  };

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

      {/* Kept OUT of fieldGrid deliberately — it's a display-count cap with
          its own independent Save action, not another per-answer weight, so
          sharing the weight sliders' auto-fit grid let it land cramped into
          a narrow column next to an unrelated slider at common viewport
          widths (reported 2026-08-27). A full-width bordered section reads
          clearly regardless of how many weight fields wrap above it. */}
      <div style={topKSection}>
        <Field
          label="Max recommendations shown"
          info="How many trip recommendations a school sees after submitting a diagnostic — shown in the on-screen report and the downloaded PDF. Applies to both the curriculum-fit list and the AI-matched recommendation list."
        >
          <div style={{ ...sliderControl, gridTemplateColumns: 'minmax(170px, 420px) 58px' }}>
            <input
              type="range"
              value={topK}
              onChange={(e) => setTopK(Number(e.target.value))}
              style={rangeInput}
              className="diagnostic-weight-range"
              aria-label="Max recommendations shown"
              min={3}
              max={20}
              step={1}
            />
            <span style={sliderValue}>{topK}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 6, gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
              Applies to both curriculum-fit and AI-matched recommendations.
            </span>
            <button
              type="button"
              onClick={onSaveTopK}
              disabled={topKSaving || !isAdmin || topK === topKBaseline}
              style={{
                ...addBtnSmall,
                opacity: (topKSaving || !isAdmin || topK === topKBaseline) ? 0.5 : 1,
                cursor: (topKSaving || !isAdmin || topK === topKBaseline) ? 'not-allowed' : 'pointer',
              }}
              aria-label="Save recommendation count"
            >
              {topKSaving ? 'Saving...' : 'Save'}
            </button>
          </div>
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
// Sticky (not fixed) footer bar — the app's scrollable region is `<main
// className="app-main">` (see components/Layout.jsx), not the viewport, and
// it sits beside the sidebar rather than under it. `position: sticky`
// against that ancestor keeps the button reachable without scrolling to the
// page bottom while staying correctly confined to the content column (a
// fixed/viewport-relative bar would either sit under the sidebar or need
// its offset hardcoded and re-broken every time the sidebar width changes).
const saveBar = {
  position: 'sticky',
  bottom: 0,
  zIndex: 20,
  marginTop: 16,
  padding: '12px 0',
  display: 'flex',
  justifyContent: 'flex-end',
  background: 'var(--bg-color)',
  borderTop: '1px solid var(--border-color)',
  boxShadow: '0 -8px 24px rgba(15, 23, 42, 0.12)',
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
const bulkRequireBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  padding: '4px 10px', borderRadius: 6, fontWeight: 600, fontSize: 12,
  background: 'transparent', color: 'var(--text-secondary)',
  border: '1px solid var(--border-color)', cursor: 'pointer',
};
const bulkRequireBtnActive = {
  ...bulkRequireBtn,
  opacity: 0.5,
  cursor: 'default',
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
const topKSection = {
  marginTop: 16, padding: 14, borderRadius: 10,
  border: '1px solid var(--border-color)',
  background: 'var(--subtle-bg, rgba(91, 110, 248, 0.04))',
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
  display: 'flex',
  alignItems: 'flex-start',
  gap: 8,
  padding: '8px 10px',
  marginBottom: 2,
  border: 'none',
  borderRadius: 6,
  background: 'transparent',
  color: 'var(--text-primary)',
  textAlign: 'left',
  fontFamily: 'inherit',
  cursor: 'pointer',
};
const templatePickerOptionActive = {
  ...templatePickerOption,
  background: 'var(--primary-color)',
  color: '#fff',
};
const templatePickerOptionCheck = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 14,
  flexShrink: 0,
  marginTop: 2,
};
const templatePickerOptionText = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  minWidth: 0,
};
const templatePickerOptionName = {
  fontSize: 13,
  fontWeight: 600,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
const templatePickerOptionMeta = {
  fontSize: 11,
  fontWeight: 500,
  opacity: 0.75,
};
const templatePickerEmpty = {
  padding: '10px',
  color: 'var(--text-secondary)',
  fontSize: 13,
};
const templatePickerBulkBar = {
  position: 'sticky',
  top: 0,
  zIndex: 1,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '2px 4px 8px',
  marginBottom: 4,
  borderBottom: '1px solid var(--border-color)',
  background: 'var(--bg-color)',
};
const templatePickerBulkToggle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '4px 8px',
  borderRadius: 6,
  fontWeight: 600,
  fontSize: 12,
  background: 'transparent',
  color: 'var(--text-secondary)',
  border: '1px dashed var(--border-color)',
  cursor: 'pointer',
};
const templatePickerBulkCount = {
  fontSize: 12,
  fontWeight: 700,
  color: 'var(--text-primary)',
};
const templatePickerBulkLink = {
  padding: '2px 6px',
  borderRadius: 4,
  fontWeight: 600,
  fontSize: 12,
  background: 'transparent',
  color: 'var(--primary-color)',
  border: 'none',
  cursor: 'pointer',
};
const templatePickerBulkFooter = {
  position: 'sticky',
  bottom: 0,
  zIndex: 1,
  marginTop: 4,
  padding: '8px 4px 2px',
  borderTop: '1px solid var(--border-color)',
  background: 'var(--bg-color)',
};
const templatePickerBulkDeleteBtn = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  width: '100%',
  padding: '8px 10px',
  borderRadius: 6,
  fontWeight: 700,
  fontSize: 13,
  color: '#fff',
  background: 'var(--danger-color, #dc2626)',
  border: 'none',
  cursor: 'pointer',
};
const templatePickerBulkDeleteBtnDisabled = {
  ...templatePickerBulkDeleteBtn,
  opacity: 0.6,
  cursor: 'not-allowed',
};
const templatePickerCheckbox = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 16,
  height: 16,
  marginTop: 2,
  flexShrink: 0,
  borderRadius: 4,
  border: '1.5px solid var(--border-color)',
  background: 'transparent',
  color: '#fff',
};
const templatePickerCheckboxChecked = {
  ...templatePickerCheckbox,
  background: 'var(--primary-color)',
  borderColor: 'var(--primary-color)',
};
const draftBanner = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 10,
  marginTop: 10,
  padding: '10px 14px',
  borderRadius: 8,
  border: '1px solid color-mix(in srgb, var(--warning-color, #d97706) 40%, var(--border-color))',
  background: 'color-mix(in srgb, var(--warning-color, #d97706) 10%, transparent)',
  color: 'var(--text-primary)',
  fontSize: 13,
  lineHeight: 1.5,
};
const diagnosticBuilderCss = `
  .template-picker-option:hover:not(.template-picker-option--active) {
    background: var(--hover-bg, rgba(99, 102, 241, 0.12)) !important;
  }
  .template-picker-option--active:hover {
    filter: brightness(1.08);
  }
  .template-picker-option:focus-visible {
    outline: 2px solid var(--primary-color, #5b6cff);
    outline-offset: -2px;
  }

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
const suggestModalBackdrop = {
  position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.45)',
  backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  zIndex: 1000, padding: '1rem',
};
const suggestModalCard = {
  ...card,
  width: '100%', maxWidth: 640, maxHeight: '85vh', overflowY: 'auto',
  margin: 0,
};
const suggestCard = {
  ...subCard,
  marginBottom: 0,
};
const SUGGESTION_CATEGORY_COLORS = {
  curriculum: { background: 'rgba(91, 108, 255, 0.14)', color: 'var(--primary-color)' },
  both: { background: 'rgba(147, 51, 234, 0.14)', color: '#9333ea' },
  recommendation: { background: 'rgba(6, 182, 212, 0.14)', color: '#0891b2' },
  advisor: { background: 'rgba(217, 119, 6, 0.14)', color: '#b45309' },
};
function suggestBadge(category) {
  const colors = SUGGESTION_CATEGORY_COLORS[category] || {
    background: 'rgba(108, 117, 125, 0.14)', color: 'var(--text-secondary)',
  };
  return {
    display: 'inline-block', padding: '2px 8px', borderRadius: 999,
    fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap',
    ...colors,
  };
}
