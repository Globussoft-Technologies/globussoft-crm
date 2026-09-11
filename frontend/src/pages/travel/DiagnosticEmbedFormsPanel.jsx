// Diagnostic Builder — Embed Forms panel (Travel CRM, rewritten 2026-09-08).
//
// Configures the styling of the THIRD-PARTY-embeddable diagnostic widget
// (frontend/public/embed/diagnostic.html + diagnostic.js) — a separate
// surface from the CRM-hosted "Public form" tab, since the whole point of
// embedding on a partner site is letting the widget match THAT site's own
// colors/fonts instead of this tenant's CRM brand kit.
//
// Rewrite fixes three real bugs the previous version had (not just a
// visual pass):
//   1. Config now round-trips through the backend (GET/PUT
//      /api/travel/diagnostics/embed-settings) instead of localStorage —
//      previously the ENTIRE config was serialized into a `?config=` URL
//      param baked into the copied snippet at copy time, so an admin's
//      later edits never reached any already-embedded widget. Now the
//      widget fetches the live config by tenant+subBrand on every load
//      (see the public GET /diagnostics/public/embed-config/:tenantSlug/
//      :subBrand route), so edits apply everywhere immediately.
//   2. The "Diagnostic template" picker is gone — it only ever drove this
//      panel's OWN preview; the real embed always uses whatever bank is
//      currently active + published, same as the Public form tab. That's
//      now surfaced as a read-only status line instead of a fake control.
//   3. The preview here mirrors the real widget's rendering rules by hand
//      (marker-before-label, auto-contrast selected text, etc.) — see the
//      inline comments next to each place that has to stay in sync with
//      frontend/public/embed/diagnostic.html if that file's rendering
//      logic ever changes.

import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Copy, Check, ExternalLink, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { AuthContext } from '../../App';

const TABS = ['general', 'branding', 'layout', 'results', 'code'];
const TAB_LABELS = {
  general: 'General',
  branding: 'Branding',
  layout: 'Layout',
  results: 'Results',
  code: 'Get the code',
};

const CONFIG_DEFAULTS = {
  title: '',
  subtitle: '',
  hideTitle: false, // true = show no title at all, not even the Public form's own title
  hideSubtitle: false, // true = show no subtitle at all, not even the Public form's own subtitle
  progress: true,
  poweredBy: true,
  submitLabel: '', // '' = falls back to the Public form's own submit label, then "See my result"
  submitAlignment: 'right',
  submitStyle: 'rounded',
  submitWidth: 'auto',
  primary: '#4f46e5',
  background: '#f8fafc',
  card: '#ffffff',
  text: '#0f172a',
  selectedText: '', // '' = auto-pick a readable color against `primary`
  fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
  radius: 16,
  maxWidth: 860,
  singleChoiceStyle: 'buttons', // buttons | pills
  multiSelectStyle: 'checkboxes', // checkboxes | pills
  selectionMarker: 'auto', // auto | radio | checkbox | tick | none
  optionColumns: 1,
  questionSize: 16,
  optionSize: 14.5,
  cardPadding: 22, // px, inside each question's card
  optionGap: 10, // px, between option rows
  resultTitle: 'Your result',
  showScore: true,
  showSummary: true,
  recommendations: true,
  recommendationTitle: 'Recommended for you',
};

const FONT_OPTIONS = [
  { value: 'Inter, system-ui, -apple-system, sans-serif', label: 'System / Inter' },
  { value: 'Arial, sans-serif', label: 'Arial' },
  { value: 'Georgia, serif', label: 'Georgia' },
  { value: "'Courier New', monospace", label: 'Courier New' },
];

export function getEmbedPreviewQuestions(bank) {
  try {
    const questions = JSON.parse(bank?.questionsJson || '{}')?.questions;
    return Array.isArray(questions) ? questions : [];
  } catch {
    return [];
  }
}

// Same relative-luminance contrast pick as frontend/public/embed/
// diagnostic.html's pickReadableText() — keep these two in sync.
function pickReadableText(hex) {
  let h = String(hex || '').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return '#ffffff';
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lum = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return lum > 0.5 ? '#0f172a' : '#ffffff';
}

export default function DiagnosticEmbedFormsPanel({ subBrand, notify }) {
  const { tenant } = useContext(AuthContext) || {};
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [config, setConfig] = useState(CONFIG_DEFAULTS);
  const [baseline, setBaseline] = useState(CONFIG_DEFAULTS);
  const [tab, setTab] = useState('general');
  const [previewScreen, setPreviewScreen] = useState('questions'); // local UI toggle only — never saved
  const [previewDevice, setPreviewDevice] = useState('desktop');
  const [previewAnswers, setPreviewAnswers] = useState({});
  const [currentBank, setCurrentBank] = useState(null);
  const [isPublished, setIsPublished] = useState(false);
  const [copied, setCopied] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [settingsRes, banksRes, formRes] = await Promise.all([
        fetchApi(`/api/travel/diagnostics/embed-settings?subBrand=${encodeURIComponent(subBrand)}`, { silent: true }).catch(() => null),
        fetchApi(`/api/travel/diagnostic-banks?subBrand=${encodeURIComponent(subBrand)}`, { silent: true }).catch(() => null),
        fetchApi(`/api/travel/diagnostic-public-forms/${encodeURIComponent(subBrand)}`, { silent: true }).catch(() => null),
      ]);
      const merged = { ...CONFIG_DEFAULTS, ...(settingsRes?.config || {}) };
      setConfig(merged);
      setBaseline(merged);

      const banks = Array.isArray(banksRes?.banks) ? banksRes.banks : [];
      const active = banks.reduce(
        (best, row) => (!best || Number(row.version || 0) > Number(best.version || 0) ? row : best),
        null,
      );
      setCurrentBank(active);
      setIsPublished(Boolean(formRes?.form?.isPublished));
      setPreviewAnswers({});
    } finally {
      setLoading(false);
    }
  }, [subBrand]);

  useEffect(() => { load(); }, [load]);

  const dirty = useMemo(() => JSON.stringify(config) !== JSON.stringify(baseline), [config, baseline]);

  const update = (patch) => setConfig((prev) => ({ ...prev, ...patch }));

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetchApi('/api/travel/diagnostics/embed-settings', {
        method: 'PUT',
        body: JSON.stringify({ subBrand, config }),
      });
      const saved = { ...CONFIG_DEFAULTS, ...(res?.config || config) };
      setConfig(saved);
      setBaseline(saved);
      notify.success('Embed styling saved — every already-embedded widget picks this up on its next load.');
    } catch (e) {
      notify.error(e?.body?.error || e?.message || 'Failed to save embed settings');
    } finally {
      setSaving(false);
    }
  };

  const previewQuestions = getEmbedPreviewQuestions(currentBank);

  const togglePreviewAnswer = (question, value) => {
    setPreviewAnswers((prev) => {
      if (question.type !== 'multi-select') return { ...prev, [question.id]: value };
      const chosen = Array.isArray(prev[question.id]) ? prev[question.id] : [];
      return {
        ...prev,
        [question.id]: chosen.includes(value) ? chosen.filter((v) => v !== value) : [...chosen, value],
      };
    });
  };

  const host = typeof window !== 'undefined' ? window.location.origin : '';
  let tenantSlug = tenant?.slug || '';
  try {
    const stored = JSON.parse(localStorage.getItem('tenant') || 'null');
    if (!tenantSlug && stored?.slug) tenantSlug = stored.slug;
  } catch {
    // localStorage unavailable/unparseable — fall back to whatever AuthContext gave us.
  }
  const formUrl = `${host}/embed/diagnostic.html?tenant=${encodeURIComponent(tenantSlug)}&subBrand=${encodeURIComponent(subBrand)}`;
  const iframeCode = `<iframe src="${formUrl}" title="${config.title || 'Diagnostic'}" style="width:100%;min-height:720px;border:0" loading="lazy"></iframe>`;
  const scriptCode = `<div id="diagnostic-form"></div>\n<script src="${host}/embed/diagnostic.js" data-tenant="${tenantSlug}" data-sub-brand="${subBrand}" data-container="#diagnostic-form"></script>`;

  const copy = async (kind) => {
    try {
      await navigator.clipboard.writeText(kind === 'script' ? scriptCode : iframeCode);
      setCopied(kind);
      setTimeout(() => setCopied(''), 1800);
    } catch {
      notify.error('Could not copy — your browser blocked clipboard access.');
    }
  };

  if (loading) {
    return (
      <section style={card} aria-busy="true">
        <h2 style={cardTitle}>Embed Forms</h2>
        <p style={{ color: 'var(--text-secondary)' }}>Loading embed settings...</p>
      </section>
    );
  }

  return (
    <section style={card}>
      <style>{embedPanelCss}</style>
      <h2 style={cardTitle}>Embed Forms</h2>
      <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: '0 0 8px' }}>
        Style a version of the {subBrand.toUpperCase()} diagnostic that a partner site can embed with its own look —
        independent of this tenant&rsquo;s CRM brand kit.
      </p>

      <StatusLine subBrand={subBrand} currentBank={currentBank} isPublished={isPublished} />

      <div className="diagnostic-embed-workspace">
        <div className="diagnostic-embed-editor">
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(160px, 200px) minmax(0, 1fr)', gap: 24, alignItems: 'start' }}>
            <div style={{ display: 'grid', alignContent: 'start', gap: 6 }}>
          {TABS.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setTab(item)}
              style={tab === item ? primaryBtn : secondaryBtn}
            >
              {TAB_LABELS[item]}
            </button>
          ))}
        </div>

            <div style={{ display: 'grid', gap: 14, minWidth: 0 }}>
          {tab === 'general' && (
            <GeneralTab config={config} update={update} />
          )}
          {tab === 'branding' && (
            <BrandingTab config={config} update={update} />
          )}
          {tab === 'layout' && (
            <LayoutTab config={config} update={update} />
          )}
          {tab === 'results' && (
            <ResultsTab config={config} update={update} />
          )}
          {tab === 'code' && (
            <CodeTab
              formUrl={formUrl}
              iframeCode={iframeCode}
              scriptCode={scriptCode}
              copied={copied}
              onCopy={copy}
            />
          )}
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
        <button
          type="button"
          onClick={save}
          disabled={saving || !dirty}
          style={saving || !dirty ? primaryBtnDisabled : primaryBtn}
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
          </div>
        </div>

        <aside className="diagnostic-embed-preview" aria-label="Live embed preview">
          <div style={previewHeader}>Live preview <span>Updates as you edit</span></div>
          <EmbedPreview
            config={config}
            questions={previewQuestions}
            hasBank={Boolean(currentBank)}
            previewScreen={previewScreen}
            onScreenChange={setPreviewScreen}
            previewDevice={previewDevice}
            onDeviceChange={setPreviewDevice}
            previewAnswers={previewAnswers}
            onToggleAnswer={togglePreviewAnswer}
          />
        </aside>
      </div>
    </section>
  );
}

function StatusLine({ subBrand, currentBank, isPublished }) {
  if (!currentBank) {
    return (
      <div style={statusBox('warn')}>
        <AlertTriangle size={15} aria-hidden />
        No diagnostic template exists yet for {subBrand.toUpperCase()} — create one on the Questions tab before embedding.
      </div>
    );
  }
  if (!isPublished) {
    return (
      <div style={statusBox('warn')}>
        <AlertTriangle size={15} aria-hidden />
        Embedding <strong>&nbsp;{currentBank.templateName || `${subBrand.toUpperCase()} Template`}&nbsp;</strong>
        (v{currentBank.version}) — but the public form isn&rsquo;t published yet, so the embed will show an error
        until you publish it on the Public form tab.
      </div>
    );
  }
  return (
    <div style={statusBox('ok')}>
      <CheckCircle2 size={15} aria-hidden />
      Embedding the current template: <strong>&nbsp;{currentBank.templateName || `${subBrand.toUpperCase()} Template`}&nbsp;</strong>
      (v{currentBank.version}) · Published
    </div>
  );
}

function GeneralTab({ config, update }) {
  // An empty text field alone can't distinguish "never touched this, keep
  // falling back to the Public form's own title" from "I deliberately want
  // no title at all" — clearing the field just falls back again either way.
  // hideTitle/hideSubtitle are the explicit "no, really, none" switches;
  // the text field stays usable for the normal case (a custom override, or
  // leaving it blank to inherit the Public form's title/subtitle).
  return (
    <>
      <TextField
        label="Public title"
        value={config.title}
        onChange={(v) => update({ title: v })}
        placeholder="Falls back to the Public form title"
        disabled={config.hideTitle}
      />
      <CheckField label="No title at all (don't fall back to the Public form's title either)" checked={config.hideTitle} onChange={(v) => update({ hideTitle: v })} />

      <TextField
        label="Subtitle"
        value={config.subtitle}
        onChange={(v) => update({ subtitle: v })}
        placeholder="Falls back to the Public form subtitle"
        disabled={config.hideSubtitle}
      />
      <CheckField label="No subtitle at all (don't fall back to the Public form's subtitle either)" checked={config.hideSubtitle} onChange={(v) => update({ hideSubtitle: v })} />

      <TextField
        label="Submit button label"
        value={config.submitLabel}
        onChange={(v) => update({ submitLabel: v })}
        placeholder="Falls back to the Public form's submit label, or “See my result”"
      />

      <SelectField label="Submit button placement" value={config.submitAlignment} onChange={(v) => update({ submitAlignment: v })} options={[{ value: 'left', label: 'Left' }, { value: 'center', label: 'Center' }, { value: 'right', label: 'Right' }]} />
      <SelectField label="Submit button width" value={config.submitWidth} onChange={(v) => update({ submitWidth: v })} options={[{ value: 'auto', label: 'Fit label' }, { value: 'full', label: 'Full width' }]} />
      <SelectField label="Submit button shape" value={config.submitStyle} onChange={(v) => update({ submitStyle: v })} options={[{ value: 'square', label: 'Square' }, { value: 'rounded', label: 'Rounded' }, { value: 'pill', label: 'Pill' }]} />
      <CheckField label="Show progress bar" checked={config.progress} onChange={(v) => update({ progress: v })} />
      <CheckField label='Show "Powered by Globussoft Travel CRM"' checked={config.poweredBy} onChange={(v) => update({ poweredBy: v })} />
    </>
  );
}

function BrandingTab({ config, update }) {
  return (
    <>
      <ColorField label="Primary color" value={config.primary} onChange={(v) => update({ primary: v })} />
      <ColorField label="Background color" value={config.background} onChange={(v) => update({ background: v })} />
      <ColorField label="Card color" value={config.card} onChange={(v) => update({ card: v })} />
      <ColorField label="Text color" value={config.text} onChange={(v) => update({ text: v })} />
      <label style={fieldLabel}>
        Selected-option text color
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="color"
            value={
              /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(config.selectedText || '')
                ? toSixDigitHex(config.selectedText).toLowerCase()
                : pickReadableText(config.primary)
            }
            onChange={(e) => update({ selectedText: e.target.value })}
            style={{ width: 40, height: 34, padding: 2, border: '1px solid var(--border-color)', borderRadius: 6, flexShrink: 0, cursor: 'pointer' }}
          />
          <input
            type="text"
            value={config.selectedText || ''}
            onChange={(e) => update({ selectedText: normalizeHexInput(e.target.value) })}
            placeholder={pickReadableText(config.primary)}
            spellCheck={false}
            style={{ ...textareaStyle, minWidth: 0, flex: 1, fontFamily: 'monospace' }}
          />
          <button type="button" onClick={() => update({ selectedText: '' })} style={{ ...secondaryBtn, padding: '6px 10px', fontSize: 12, flexShrink: 0 }}>
            Auto (recommended)
          </button>
        </div>
        <span style={hintText}>Auto picks black or white for readable contrast against your primary color — override only if you need an exact brand color. Type a hex code above to override, or use the swatch.</span>
      </label>
      <SelectField
        label="Font family"
        value={config.fontFamily}
        onChange={(v) => update({ fontFamily: v })}
        options={FONT_OPTIONS}
      />
    </>
  );
}

function LayoutTab({ config, update }) {
  return (
    <>
      <RangeNumberField label="Form width" value={config.maxWidth} onChange={(v) => update({ maxWidth: v })} min={320} max={1400} suffix="px" />
      <RangeNumberField label="Corner roundness" value={config.radius} onChange={(v) => update({ radius: v })} min={0} max={32} suffix="px" />
      <SelectField
        label="Single-choice controls"
        value={config.singleChoiceStyle}
        onChange={(v) => update({ singleChoiceStyle: v })}
        options={[{ value: 'buttons', label: 'Full-width buttons' }, { value: 'pills', label: 'Pills' }]}
      />
      <SelectField
        label="Multi-select controls"
        value={config.multiSelectStyle}
        onChange={(v) => update({ multiSelectStyle: v })}
        options={[{ value: 'checkboxes', label: 'Checkbox rows' }, { value: 'pills', label: 'Pills' }]}
      />
      <SelectField
        label="Selection marker"
        value={config.selectionMarker}
        onChange={(v) => update({ selectionMarker: v })}
        options={[
          { value: 'auto', label: 'Automatic for the question type' },
          { value: 'radio', label: 'Radio circle' },
          { value: 'checkbox', label: 'Checkbox / tick box' },
          { value: 'tick', label: 'Tick on the right' },
          { value: 'none', label: 'No marker' },
        ]}
      />
      <SelectField
        label="Option columns"
        value={String(config.optionColumns)}
        onChange={(v) => update({ optionColumns: Number(v) })}
        options={[{ value: '1', label: '1 column' }, { value: '2', label: '2 columns' }, { value: '3', label: '3 columns' }]}
      />
      <RangeNumberField label="Question text size" value={config.questionSize} onChange={(v) => update({ questionSize: v })} min={12} max={28} suffix="px" />
      <RangeNumberField label="Option text size" value={config.optionSize} onChange={(v) => update({ optionSize: v })} min={11} max={22} step={0.5} suffix="px" />
      <RangeNumberField label="Card padding" value={config.cardPadding} onChange={(v) => update({ cardPadding: v })} min={8} max={48} suffix="px" />
      <RangeNumberField label="Space between options" value={config.optionGap} onChange={(v) => update({ optionGap: v })} min={4} max={24} suffix="px" />
    </>
  );
}

function ResultsTab({ config, update }) {
  return (
    <>
      <TextField label="Result heading" value={config.resultTitle} onChange={(v) => update({ resultTitle: v })} />
      <CheckField label="Show score & classification" checked={config.showScore} onChange={(v) => update({ showScore: v })} />
      <CheckField label="Show AI-generated summary" checked={config.showSummary} onChange={(v) => update({ showSummary: v })} />
      <CheckField label="Show recommendations" checked={config.recommendations} onChange={(v) => update({ recommendations: v })} />
      <TextField label="Recommendations heading" value={config.recommendationTitle} onChange={(v) => update({ recommendationTitle: v })} />
      <p style={{ ...hintText, margin: 0 }}>
        The number shown is controlled centrally in Recommendation Settings and is shared by public forms, embeds, and API submissions.
      </p>
    </>
  );
}

function CodeTab({ formUrl, iframeCode, scriptCode, copied, onCopy }) {
  return (
    <>
      <label style={fieldLabel}>
        Embed URL
        <input readOnly value={formUrl} style={textareaStyle} onFocus={(e) => e.target.select()} />
      </label>
      <label style={fieldLabel}>
        iframe snippet
        <textarea readOnly value={iframeCode} rows={3} style={textareaStyle} onFocus={(e) => e.target.select()} />
      </label>
      <button type="button" onClick={() => onCopy('iframe')} style={secondaryBtn}>
        {copied === 'iframe' ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
        {copied === 'iframe' ? 'Copied' : 'Copy iframe snippet'}
      </button>

      <label style={{ ...fieldLabel, marginTop: 8 }}>
        JavaScript snippet (auto-sizes to the diagnostic&rsquo;s height)
        <textarea readOnly value={scriptCode} rows={3} style={textareaStyle} onFocus={(e) => e.target.select()} />
      </label>
      <button type="button" onClick={() => onCopy('script')} style={secondaryBtn}>
        {copied === 'script' ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
        {copied === 'script' ? 'Copied' : 'Copy JavaScript snippet'}
      </button>

      <a href={formUrl} target="_blank" rel="noopener noreferrer" style={{ ...secondaryBtn, textDecoration: 'none', width: 'fit-content' }}>
        <ExternalLink size={14} aria-hidden /> Open the live embed in a new tab
      </a>
    </>
  );
}

// ─── Preview (mirrors frontend/public/embed/diagnostic.html's rendering
// rules by hand — marker-before-label, auto-contrast, pill vs button
// radius — so what an admin sees here matches the real widget) ──────────

function EmbedPreview({
  config, questions, hasBank, previewScreen, onScreenChange, previewDevice, onDeviceChange, previewAnswers, onToggleAnswer,
}) {
  const width = previewDevice === 'mobile' ? 380 : previewDevice === 'tablet' ? 680 : Math.max(360, Math.min(1100, Number(config.maxWidth) || 860));
  const selectedText = config.selectedText || pickReadableText(config.primary);
  const completedQuestions = questions.filter((question) => {
    const answer = previewAnswers[question.id];
    return question.type === 'multi-select' ? Array.isArray(answer) && answer.length > 0 : Boolean(answer);
  }).length;
  const progressPercent = questions.length ? Math.round((completedQuestions / questions.length) * 100) : 0;

  return (
    <div style={{ marginTop: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" onClick={() => onScreenChange('questions')} style={previewScreen === 'questions' ? primaryBtnSmall : secondaryBtnSmall}>Questions</button>
          <button type="button" onClick={() => onScreenChange('result')} style={previewScreen === 'result' ? primaryBtnSmall : secondaryBtnSmall}>Result</button>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" onClick={() => onDeviceChange('desktop')} style={previewDevice === 'desktop' ? primaryBtnSmall : secondaryBtnSmall}>Desktop</button>
          <button type="button" onClick={() => onDeviceChange('tablet')} style={previewDevice === 'tablet' ? primaryBtnSmall : secondaryBtnSmall}>Tablet</button>
          <button type="button" onClick={() => onDeviceChange('mobile')} style={previewDevice === 'mobile' ? primaryBtnSmall : secondaryBtnSmall}>Mobile</button>
        </div>
      </div>

      <div
        style={{
          padding: 24,
          background: config.background,
          color: config.text,
          borderRadius: config.radius,
          width: '100%',
          maxWidth: width,
          minHeight: 300,
          border: '1px solid rgba(15, 23, 42, 0.08)',
          marginLeft: 'auto',
          marginRight: 'auto',
          boxSizing: 'border-box',
          fontFamily: config.fontFamily,
        }}
      >
        {!config.hideTitle && (
          <h3 style={{ margin: '4px 0 6px', color: config.primary }}>{config.title || 'Travel diagnostic'}</h3>
        )}
        {!config.hideSubtitle && (
          <p style={{ margin: '0 0 16px', fontSize: 13.5 }}>{config.subtitle || 'Answer a few questions to receive your result.'}</p>
        )}

        {previewScreen === 'questions' && !hasBank && (
          <div style={{ padding: 18, background: config.card, borderRadius: config.radius, fontSize: 13 }}>
            No template to preview yet — create one on the Questions tab.
          </div>
        )}

        {previewScreen === 'questions' && hasBank && config.progress !== false && (
          <div style={{ height: 6, background: 'rgba(0,0,0,0.08)', borderRadius: 999, marginBottom: 20, overflow: 'hidden' }}>
            <div role="progressbar" aria-label="Diagnostic completion" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPercent} aria-valuetext={`${completedQuestions} of ${questions.length} questions completed`} style={{ height: '100%', width: `${progressPercent}%`, borderRadius: 999, background: config.primary, transition: 'width 180ms ease' }} />
          </div>
        )}

        {previewScreen === 'questions' && hasBank && questions.map((question, index) => (
          <PreviewQuestion
            key={question.id || index}
            index={index}
            question={question}
            config={config}
            selectedText={selectedText}
            answer={previewAnswers[question.id]}
            onToggle={onToggleAnswer}
            mobile={previewDevice === 'mobile'}
          />
        ))}

        {previewScreen === 'questions' && hasBank && (
          <>
            {/* Every embed always collects Name/Email/Phone before the
                submit button — not admin-configurable, so illustrating it
                here just sets accurate expectations for what a submitter
                sees, it's not something to toggle. */}
            <div style={{ display: 'grid', gridTemplateColumns: previewDevice === 'mobile' ? '1fr' : 'repeat(2, 1fr)', gap: 12, margin: '20px 0' }}>
              {['Name', 'Email', 'Phone'].map((label) => (
                <label key={label} style={{ display: 'grid', gap: 6, fontSize: 12.5, fontWeight: 600 }}>
                  {label}
                  <input disabled placeholder={label} style={{ padding: '10px 12px', borderRadius: 8, border: '1.5px solid rgba(0,0,0,0.12)', fontSize: 13 }} />
                </label>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: config.submitAlignment || 'right', marginTop: 10 }}>
              <button
                type="button"
                disabled
                style={{
                  border: 'none', borderRadius: config.submitStyle === 'pill' ? 999 : config.submitStyle === 'square' ? 0 : 8, padding: '13px 24px', fontWeight: 700, fontSize: 14,
                  background: config.primary, color: selectedText, cursor: 'default',
                  width: config.submitWidth === 'full' ? '100%' : 'auto',
                }}
              >
                {config.submitLabel || 'See my result'}
              </button>
            </div>
          </>
        )}

        {previewScreen === 'result' && (
          <div style={{ padding: config.cardPadding, background: config.card, borderRadius: config.radius }}>
            <h2 style={{ margin: 0, color: config.primary }}>{config.resultTitle || 'Your result'}</h2>
            {config.showScore && (
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginTop: 12 }}>
                <strong style={{ fontSize: 15 }}>Power User</strong>
                <span style={{ fontSize: 32, fontWeight: 800, color: config.primary }}>82</span>
              </div>
            )}
            {config.showSummary && (
              <p style={{ margin: '10px 0 0', fontSize: 13.5, opacity: 0.8 }}>
                A short AI-written summary of the submitter&rsquo;s fit appears here — real wording, generated per submission.
              </p>
            )}
            {config.recommendations && (
              <>
                <h3 style={{ margin: '20px 0 10px', color: config.primary, fontSize: 15 }}>{config.recommendationTitle || 'Recommended for you'}</h3>
                <SampleRecommendations config={config} mobile={previewDevice === 'mobile'} selectedText={selectedText} />
              </>
            )}
          </div>
        )}

        {config.poweredBy && (
          <p style={{ marginTop: 18, textAlign: 'center', fontSize: 11, color: '#94a3b8' }}>
            Powered by Globussoft Travel CRM
          </p>
        )}
      </div>
    </div>
  );
}

// Illustrates the real widget's grouped-by-category, pick-your-interests
// recommendations — sample data only (this preview has no real submission
// to fetch trips for), but the layout/behavior sketch matches
// diagnostic.html's renderResult() exactly: category headings, a checkbox
// on each card, and a disabled "Submit chosen interests" button.
const SAMPLE_RECOMMENDATION_GROUPS = [
  { label: 'Day trips', items: ['Hampi Heritage Trail', 'Nandi Hills Nature Walk', 'Pondicherry Coastal Programme'] },
  { label: 'International', items: ['Singapore Discovery Programme', 'Dubai Innovation Trail'] },
  { label: 'Overnight adventure', items: ['Chikkamagaluru Nature Camp', 'Coorg Hills Expedition', 'Wayanad Wildlife Trek'] },
];

function SampleRecommendations({ config, mobile, selectedText }) {
  const groups = SAMPLE_RECOMMENDATION_GROUPS;
  return (
    <>
      {groups.map((group) => (
        <div key={group.label}>
          <h4 style={{ margin: '20px 0 8px', fontSize: 11.5, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {group.label}
          </h4>
          <div style={{ display: 'grid', gridTemplateColumns: mobile ? '1fr' : 'repeat(2, 1fr)', gap: 10 }}>
            {group.items.map((name) => (
              <label
                key={name}
                style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: 12, border: '1px solid rgba(15,23,42,0.08)', borderRadius: 10, background: config.background, cursor: 'default' }}
              >
                <input type="checkbox" disabled style={{ marginTop: 3, flexShrink: 0 }} />
                <span>
                  <strong style={{ fontSize: 13 }}>{name}</strong>
                  <p style={{ margin: '6px 0 0', fontSize: 11.5, opacity: 0.7 }}>Real submissions show actual matched trips here.</p>
                </span>
              </label>
            ))}
          </div>
        </div>
      ))}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 20 }}>
        <button
          type="button"
          disabled
          style={{ border: 'none', borderRadius: 999, padding: '10px 18px', fontWeight: 700, fontSize: 12.5, background: config.primary, color: selectedText, cursor: 'default' }}
        >
          Submit chosen interests
        </button>
        <span style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
          A submitter can select multiple trips above and send their picks to your team.
        </span>
      </div>
    </>
  );
}

function PreviewQuestion({ index, question, config, selectedText, answer, onToggle, mobile }) {
  const options = Array.isArray(question.options) ? question.options : [];
  const cols = mobile ? 1 : Math.max(1, Math.min(3, Number(config.optionColumns) || 1));
  const multi = question.type === 'multi-select';
  const style = multi ? config.multiSelectStyle : config.singleChoiceStyle;
  const marker = config.selectionMarker === 'auto' ? (multi ? 'checkbox' : 'radio') : config.selectionMarker;

  return (
    <div
      style={{
        marginTop: 16,
        padding: config.cardPadding,
        background: config.card,
        borderRadius: (Number(config.radius) || 16) * 0.7,
        border: '1px solid rgba(15, 23, 42, 0.1)',
        textAlign: 'left',
      }}
    >
      <div style={{ fontWeight: 700, fontSize: config.questionSize, marginBottom: 10 }}>
        {config.progress !== false ? `${index + 1}. ` : ''}{question.text || `Question ${index + 1}`}
      </div>
      <div style={{ display: 'grid', gap: config.optionGap, gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
        {options.map((option) => {
          const selected = multi
            ? Array.isArray(answer) && answer.includes(option.value)
            : answer === option.value;
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => onToggle(question, option.value)}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '11px 14px',
                textAlign: 'left',
                fontSize: config.optionSize,
                background: selected ? config.primary : config.card,
                color: selected ? selectedText : config.text,
                border: `1.5px solid ${selected ? config.primary : 'rgba(15,23,42,0.15)'}`,
                borderRadius: style === 'pills' ? 999 : Math.max(6, config.radius / 2),
                cursor: 'pointer',
                boxSizing: 'border-box',
              }}
            >
              {/* Marker BEFORE the label — must match diagnostic.html */}
              {(marker === 'radio' || marker === 'checkbox') && (
                <span
                  style={{
                    width: 15,
                    height: 15,
                    flexShrink: 0,
                    border: `1.5px solid ${selected ? selectedText : '#94a3b8'}`,
                    borderRadius: marker === 'radio' ? '50%' : 4,
                    display: 'inline-grid',
                    placeItems: 'center',
                  }}
                >
                  {selected && <Check size={10} aria-hidden />}
                </span>
              )}
              <span>{option.label || option.value}</span>
              {selected && marker === 'tick' && <span style={{ marginLeft: 'auto' }}><Check size={14} aria-hidden /></span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Small field primitives ──────────────────────────────────────────────

function TextField({ label, value, onChange, placeholder, disabled }) {
  return (
    <label style={fieldLabel}>
      {label}
      <input
        type="text"
        value={value}
        placeholder={disabled ? "Hidden — see the checkbox below" : placeholder}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        style={{ ...textareaStyle, opacity: disabled ? 0.55 : 1, cursor: disabled ? 'not-allowed' : 'text' }}
      />
    </label>
  );
}

function NumberField({ label, value, onChange, min, max }) {
  return (
    <label style={fieldLabel}>
      {label}
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(Math.max(min, Math.min(max, Number(e.target.value) || 0)))}
        style={textareaStyle}
      />
    </label>
  );
}

function RangeNumberField({ label, value, onChange, min, max, step = 1, suffix = '' }) {
  const numericValue = Math.max(min, Math.min(max, Number(value) || min));
  const progress = `${((numericValue - min) / (max - min)) * 100}%`;
  return (
    <label style={fieldLabel}>
      {label}
      <div style={rangeControl}>
        <input className="diagnostic-embed-range" type="range" min={min} max={max} step={step} value={numericValue} onChange={(e) => onChange(Number(e.target.value))} style={{ ...rangeInput, '--range-progress': progress }} />
        <input type="number" min={min} max={max} step={step} value={numericValue} onChange={(e) => onChange(Math.max(min, Math.min(max, Number(e.target.value) || min)))} style={rangeNumberInput} />
        <span style={rangeSuffix}>{suffix}</span>
      </div>
    </label>
  );
}

// A native <input type="color"> popup's own RGB/HSL/HEX format toggle is
// rendered entirely by the OS/browser, outside this page's DOM — nothing
// here can restyle or replace it (a recent Chrome already renders it as a
// dropdown on its own). What IS ours to fix: typing directly into it is
// flaky in some Chrome builds (the swatch doesn't always pick up a value
// typed there until the popup is dismissed a certain way) — so the plain
// text field below is the reliable path for typing an exact code, and it
// needs to actually work for every hex a person might type:
//   - missing "#" (e.g. "4f46e5") is auto-prefixed
//   - a 3-digit shorthand (e.g. "#4f6") is expanded to 6 digits for the
//     swatch — a native color input only accepts the full #rrggbb form and
//     silently ignores shorthand, which looked exactly like "typing a hex
//     code doesn't work" for anyone using shorthand
function normalizeHexInput(raw) {
  let v = String(raw || "").trim();
  if (v && !v.startsWith("#")) v = `#${v}`;
  return v;
}

function toSixDigitHex(hex) {
  const m = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/.exec(hex || "");
  if (!m) return hex;
  const [, r, g, b] = m;
  return `#${r}${r}${g}${g}${b}${b}`;
}

function ColorField({ label, value, onChange }) {
  const isValidHex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value || '');
  const swatchValue = isValidHex ? toSixDigitHex(value).toLowerCase() : '#000000';
  return (
    <label style={fieldLabel}>
      {label}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          type="color"
          value={swatchValue}
          onChange={(e) => onChange(e.target.value)}
          style={{ width: 44, height: 36, padding: 2, border: '1px solid var(--border-color)', borderRadius: 6, flexShrink: 0, cursor: 'pointer' }}
        />
        <input
          type="text"
          value={value || ''}
          onChange={(e) => onChange(normalizeHexInput(e.target.value))}
          placeholder="#4f46e5"
          spellCheck={false}
          style={{ ...textareaStyle, minWidth: 0, flex: 1, fontFamily: 'monospace', borderColor: value && !isValidHex ? 'var(--danger-color, #ef4444)' : undefined }}
        />
      </div>
      {value && !isValidHex && (
        <span style={{ fontSize: 11.5, color: 'var(--danger-color, #ef4444)' }}>
          Enter a hex color, e.g. #4f46e5
        </span>
      )}
    </label>
  );
}

function SelectField({ label, value, onChange, options }) {
  return (
    <label style={fieldLabel}>
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)} style={textareaStyle}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

function CheckField({ label, checked, onChange }) {
  return (
    <label style={checkLabel}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────

const card = {
  background: 'var(--surface-color)', borderRadius: 12, padding: 16,
  border: '1px solid var(--border-color)',
};
const cardTitle = { margin: '0 0 6px', fontSize: 16 };
const fieldLabel = { display: 'grid', gap: 6, fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' };
const checkLabel = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' };
const hintText = { fontSize: 11.5, fontWeight: 400, color: 'var(--text-secondary)' };
const textareaStyle = {
  width: '100%', padding: '9px 11px', borderRadius: 8, fontSize: 13,
  border: '1px solid var(--border-color)', background: 'var(--bg-color)', color: 'var(--text-primary)',
  fontFamily: 'inherit', boxSizing: 'border-box',
};
const primaryBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '8px 16px', borderRadius: 8, fontWeight: 600, fontSize: 13,
  background: 'var(--primary-color)', color: '#fff', border: 'none', cursor: 'pointer',
};
const primaryBtnDisabled = { ...primaryBtn, opacity: 0.5, cursor: 'not-allowed' };
const secondaryBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '8px 16px', borderRadius: 8, fontWeight: 600, fontSize: 13,
  background: 'var(--bg-color)', color: 'var(--text-primary)',
  border: '1px solid var(--border-color)', cursor: 'pointer',
};
const primaryBtnSmall = { ...primaryBtn, padding: '5px 10px', fontSize: 12 };
const secondaryBtnSmall = { ...secondaryBtn, padding: '5px 10px', fontSize: 12 };
const previewHeader = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
  paddingBottom: 10, borderBottom: '1px solid var(--border-color)', fontSize: 13, fontWeight: 700,
};
const rangeControl = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 72px auto', gap: 8, alignItems: 'center' };
const rangeInput = { width: '100%', accentColor: 'var(--primary-color)', margin: 0 };
const rangeNumberInput = { ...textareaStyle, padding: '7px 8px', textAlign: 'right' };
const rangeSuffix = { fontSize: 12, color: 'var(--text-secondary)', minWidth: 16 };
const embedPanelCss = `
  .diagnostic-embed-workspace { display: grid; grid-template-columns: minmax(0, 1fr) minmax(380px, 44%); gap: 24px; align-items: start; margin-top: 16px; }
  .diagnostic-embed-editor { min-width: 0; }
  .diagnostic-embed-preview { position: sticky; top: 16px; min-width: 0; max-height: calc(100vh - 32px); overflow: auto; padding: 14px; border: 1px solid var(--border-color); border-radius: 10px; background: var(--surface-color); }
  .diagnostic-embed-preview > div:last-child { margin-top: 0 !important; }
  .diagnostic-embed-preview > div:last-child > div:first-child { margin-top: 12px; }
  .diagnostic-embed-preview span { color: var(--text-secondary); font-size: 11px; font-weight: 500; }
  @media (max-width: 1100px) {
    .diagnostic-embed-workspace { grid-template-columns: minmax(0, 1fr); }
    .diagnostic-embed-preview { position: static; max-height: none; }
  }
  @media (max-width: 640px) {
    .diagnostic-embed-editor > div { grid-template-columns: 1fr !important; gap: 14px !important; }
  }
  .diagnostic-embed-range { appearance: none; -webkit-appearance: none; height: 18px; background: transparent; cursor: pointer; }
  .diagnostic-embed-range::-webkit-slider-runnable-track { height: 6px; border-radius: 999px; background: linear-gradient(90deg, var(--primary-color) 0%, var(--primary-color) var(--range-progress), var(--border-color) var(--range-progress), var(--border-color) 100%); box-shadow: inset 0 1px 2px rgba(15, 23, 42, 0.12); }
  .diagnostic-embed-range::-webkit-slider-thumb { appearance: none; -webkit-appearance: none; width: 16px; height: 16px; margin-top: -5px; border: 3px solid var(--surface-color); border-radius: 50%; background: var(--primary-color); box-shadow: 0 1px 5px rgba(15, 23, 42, 0.28); }
  .diagnostic-embed-range::-moz-range-track { height: 6px; border-radius: 999px; background: var(--border-color); }
  .diagnostic-embed-range::-moz-range-progress { height: 6px; border-radius: 999px; background: var(--primary-color); }
  .diagnostic-embed-range::-moz-range-thumb { width: 12px; height: 12px; border: 3px solid var(--surface-color); border-radius: 50%; background: var(--primary-color); box-shadow: 0 1px 5px rgba(15, 23, 42, 0.28); }
  .diagnostic-embed-range:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 3px; border-radius: 999px; }
`;

function statusBox(kind) {
  const ok = kind === 'ok';
  return {
    display: 'flex', alignItems: 'center', gap: 8, marginTop: 10,
    padding: '9px 12px', borderRadius: 8, fontSize: 12.5,
    background: ok ? 'rgba(34, 197, 94, 0.10)' : 'rgba(217, 119, 6, 0.10)',
    color: ok ? 'var(--success-color, #16a34a)' : 'var(--warning-color, #d97706)',
    border: `1px solid ${ok ? 'rgba(34, 197, 94, 0.3)' : 'rgba(217, 119, 6, 0.3)'}`,
  };
}
