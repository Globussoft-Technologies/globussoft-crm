// PR-E Phase 2.3.5 / 2.3.6 — TEE Decision Panel + Regenerate Strategy.
//
// Surfaces the Travel Experience Engine's decision log to the operator
// so demos and audits can explain WHY a page rendered with this family,
// theme, visual mood, composition, and image strategy.
//
// Reads `content._tee` (stamped by `teeContentBridge.stampTeeMetadata`)
// and renders nine first-class fields plus a "Why this decision?"
// reasoning chain assembled from `_tee.decisions`.
//
// Also wires the Regenerate Strategy modal — the operator can what-if
// a different `tripType`, `audience`, or explicit theme override and
// see the before/after diff WITHOUT regenerating the LLM content or
// re-fetching images (R3 — `POST /api/landing-pages/:id/tee/reclassify`).
//
// Architectural promises this component honours:
//   • Read-only by default — surfaces TEE decisions; never re-classifies
//     unless the operator explicitly clicks Reclassify.
//   • No destination-specific logic — every field shown comes from the
//     `_tee` block, which is destination-agnostic by Option-B contract.
//   • The Reclassify endpoint returns TEE output ONLY — no LLM call,
//     no image fetch. The before/after diff is rendered locally.

import React, { useState, useMemo } from 'react';
import {
  Sparkles, Brain, RefreshCcw, ChevronDown, ChevronUp,
  X, ArrowRight, AlertCircle, CheckCircle2, Edit3,
} from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';

const ROW_STYLE = {
  display: 'grid',
  gridTemplateColumns: '110px 1fr',
  gap: '8px',
  alignItems: 'baseline',
  padding: '6px 0',
  borderBottom: '1px solid var(--border-color)',
  fontSize: '0.78rem',
};

const LABEL_STYLE = {
  fontSize: '0.7rem',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  fontWeight: 600,
  color: 'var(--text-secondary)',
};

const VALUE_STYLE = {
  fontSize: '0.82rem',
  color: 'var(--text-primary)',
  fontWeight: 500,
  wordBreak: 'break-word',
};

const BADGE_STYLE = {
  fontSize: '0.62rem',
  fontWeight: 700,
  padding: '1px 6px',
  borderRadius: 4,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
};

const SOURCE_BADGE = {
  static: { background: 'rgba(16, 185, 129, 0.14)', color: '#059669' },
  derived: { background: 'rgba(59, 130, 246, 0.14)', color: '#1d4ed8' },
  'ai-classified': { background: 'rgba(168, 85, 247, 0.14)', color: '#7e22ce' },
  override: { background: 'rgba(234, 88, 12, 0.14)', color: '#c2410c' },
  default: { background: 'rgba(107, 114, 128, 0.14)', color: '#4b5563' },
  partial: { background: 'rgba(245, 158, 11, 0.14)', color: '#b45309' },
};

function titleCase(s) {
  if (typeof s !== 'string' || !s) return '';
  return s.split(/[-_\s]+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function SourceBadge({ source }) {
  const style = SOURCE_BADGE[source] || SOURCE_BADGE.default;
  return <span style={{ ...BADGE_STYLE, ...style }} title={`Decision source: ${source}`}>{source}</span>;
}

function Row({ label, value, source, title }) {
  return (
    <div style={ROW_STYLE} title={title || ''}>
      <span style={LABEL_STYLE}>{label}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={VALUE_STYLE}>{value || <em style={{ opacity: 0.6 }}>—</em>}</span>
        {source && <SourceBadge source={source} />}
      </span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Main panel
// ─────────────────────────────────────────────────────────────────────

export function TeeDecisionPanel({ teeBlock, pageId, page, onReclassified, defaultExpanded = true }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [reclassifyOpen, setReclassifyOpen] = useState(false);

  // No TEE block on this page (e.g. block-array page, or template page
  // edited before TEE generation existed). Show the empty-state hint
  // so the operator knows the panel exists but applies to AI-generated
  // pages only.
  if (!teeBlock || typeof teeBlock !== 'object') {
    return (
      <section
        aria-label="TEE decisions"
        style={{
          marginTop: '1rem', padding: '0.85rem 0.9rem', borderRadius: 8,
          border: '1px dashed var(--border-color)', background: 'var(--subtle-bg, rgba(0,0,0,0.02))',
          fontSize: '0.78rem', color: 'var(--text-secondary)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
          <Sparkles size={14} aria-hidden="true" />
          <strong style={{ color: 'var(--text-primary)' }}>AI Decisions</strong>
        </div>
        <p style={{ margin: 0, lineHeight: 1.45 }}>
          This page wasn't generated through the Travel Experience Engine — no decision log is attached. Pages created via "Generate with TEE" carry a full decision chain here.
        </p>
      </section>
    );
  }

  const traits = teeBlock.traits || {};
  const decisions = teeBlock.decisions || {};
  const composition = Array.isArray(teeBlock.composition) ? teeBlock.composition : [];

  // Extract decision-source per trait for the badges.
  const traitSource = (key) => {
    const d = decisions && decisions.traits && decisions.traits[key];
    return d && d.source;
  };

  return (
    <section
      aria-label="Travel Experience Engine decisions"
      style={{
        marginTop: '1rem', padding: '0.85rem 0.9rem 0.95rem', borderRadius: 8,
        border: '1px solid var(--border-color)', background: 'var(--surface-color)',
        fontSize: '0.82rem',
      }}
    >
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: expanded ? 8 : 0 }}>
        <Sparkles size={14} aria-hidden="true" style={{ color: 'var(--accent-color)' }} />
        <strong style={{ flex: 1, fontSize: '0.85rem' }}>AI Decisions</strong>
        <button
          type="button"
          onClick={() => setReclassifyOpen(true)}
          title="Re-run the classifier with different inputs (no LLM call, no image fetch)"
          style={{
            background: 'transparent', border: '1px solid var(--border-color)',
            borderRadius: 6, padding: '3px 8px', cursor: 'pointer',
            fontSize: '0.7rem', color: 'var(--text-primary)',
            display: 'inline-flex', alignItems: 'center', gap: 4,
          }}
        >
          <RefreshCcw size={11} /> Regenerate Strategy
        </button>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse decisions' : 'Expand decisions'}
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}
        >
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </header>

      {expanded && (
        <>
          {/* The 9 first-class fields the user listed. */}
          <div role="list" aria-label="TEE decision fields">
            <Row label="Family"
                 value={titleCase(teeBlock.family)}
                 source={(decisions.family && 'static')}
                 title={decisions.family && `Rule ${decisions.family.ruleId}: ${decisions.family.rationale}`} />
            <Row label="Theme"
                 value={teeBlock.themeId}
                 title={decisions.themeId && `Rule ${decisions.themeId.ruleId}: ${decisions.themeId.rationale}`} />
            <Row label="Visual Mood"
                 value={teeBlock.visualMood}
                 source={traitSource('visualMood')} />
            <Row label="Climate"
                 value={titleCase(traits.climate)}
                 source={traitSource('climate')} />
            <Row label="Region"
                 value={titleCase(traits.regionFeel)}
                 source={traitSource('regionFeel')} />
            <Row label="Audience"
                 value={titleCase(traits.audienceTier)}
                 source={traitSource('audienceTier')} />
            <Row label="Luxury Level"
                 value={typeof traits.luxuryLevel === 'number' ? `${traits.luxuryLevel} / 5` : '—'}
                 source={traitSource('luxuryLevel')} />
            <Row label="Composition"
                 value={composition.length > 0 ? `${composition.length} sections` : '—'}
                 title={composition.join(' → ')} />
            <Row label="Image Strategy"
                 value={
                   teeBlock.images && teeBlock.images.fetchedAt
                     ? `Fetched ${countImageProviders(teeBlock.images)} (${new Date(teeBlock.images.fetchedAt).toLocaleString()})`
                     : 'Not fetched'
                 } />
          </div>

          {/* "Why this decision?" reasoning chain. */}
          <ReasoningChain teeBlock={teeBlock} />
        </>
      )}

      {reclassifyOpen && (
        <RegenerateStrategyModal
          pageId={pageId}
          page={page}
          currentTee={teeBlock}
          onClose={() => setReclassifyOpen(false)}
          onApplied={(newTee) => {
            setReclassifyOpen(false);
            if (typeof onReclassified === 'function') onReclassified(newTee);
          }}
        />
      )}
    </section>
  );
}

function countImageProviders(images) {
  if (!images) return '';
  const ids = [];
  if (images.hero && images.hero.providerId) ids.push(images.hero.providerId);
  if (Array.isArray(images.marquee)) {
    images.marquee.forEach((m) => { if (m && m.providerId) ids.push(m.providerId); });
  }
  const counts = {};
  ids.forEach((id) => { counts[id] = (counts[id] || 0) + 1; });
  return Object.entries(counts).map(([id, n]) => `${n} from ${id}`).join(', ') || `${ids.length} images`;
}

// ─────────────────────────────────────────────────────────────────────
// "Why this decision?" reasoning chain
// ─────────────────────────────────────────────────────────────────────

function ReasoningChain({ teeBlock }) {
  const items = useMemo(() => buildReasoningItems(teeBlock), [teeBlock]);
  if (items.length === 0) return null;
  return (
    <details style={{ marginTop: '0.7rem' }}>
      <summary
        style={{
          cursor: 'pointer', fontSize: '0.72rem', fontWeight: 600,
          color: 'var(--text-secondary)', letterSpacing: '0.04em',
          display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 0',
        }}
      >
        <Brain size={12} /> Why this decision?
      </summary>
      <ol
        aria-label="Reasoning chain"
        style={{
          listStyle: 'none', padding: 0, margin: '0.5rem 0 0', display: 'flex',
          flexDirection: 'column', gap: '0.3rem',
        }}
      >
        {items.map((item, i) => (
          <li key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: '0.76rem' }}>
            <CheckCircle2 size={12} style={{ flex: '0 0 12px', marginTop: 3, color: '#10b981' }} aria-hidden="true" />
            <div>
              <strong style={{ marginRight: 4 }}>{item.label}:</strong>
              <span>{item.value}</span>
              {item.detail && (
                <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: 2 }}>{item.detail}</div>
              )}
            </div>
          </li>
        ))}
      </ol>
    </details>
  );
}

function buildReasoningItems(teeBlock) {
  if (!teeBlock) return [];
  const items = [];
  const t = teeBlock.traits || {};
  const d = teeBlock.decisions || {};

  // Each step in the chain references a single decision and the rationale.
  if (t.luxuryLevel != null) {
    items.push({ label: 'Luxury Level', value: `${t.luxuryLevel} / 5` });
  }
  if (t.audienceTier) {
    items.push({ label: 'Audience', value: titleCase(t.audienceTier) });
  }
  if (t.climate) {
    items.push({ label: 'Climate', value: titleCase(t.climate) });
  }
  if (t.regionFeel) {
    items.push({ label: 'Region', value: titleCase(t.regionFeel) });
  }
  if (t.visualMood) {
    items.push({ label: 'Visual Mood', value: t.visualMood });
  }
  if (teeBlock.family) {
    items.push({
      label: 'Family',
      value: titleCase(teeBlock.family),
      detail: d.family ? `Rule ${d.family.ruleId}: ${d.family.rationale}` : undefined,
    });
  }
  if (teeBlock.themeId) {
    items.push({
      label: 'Theme',
      value: teeBlock.themeId,
      detail: d.themeId ? `Rule ${d.themeId.ruleId}: ${d.themeId.rationale}` : undefined,
    });
  }
  if (Array.isArray(teeBlock.composition) && teeBlock.composition.length > 0) {
    items.push({
      label: 'Composition',
      value: `${teeBlock.composition.length} sections`,
      detail: d.composition ? `Rule ${d.composition.ruleId}: ${d.composition.rationale}` : undefined,
    });
  }
  return items;
}

// ─────────────────────────────────────────────────────────────────────
// Regenerate Strategy modal (R3)
// ─────────────────────────────────────────────────────────────────────

const MODAL_OVERLAY = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 80,
};
const MODAL_CARD = {
  background: 'var(--surface-color)', borderRadius: 10,
  width: 'min(720px, 92vw)', maxHeight: '88vh', overflow: 'hidden',
  display: 'flex', flexDirection: 'column',
  boxShadow: '0 20px 50px rgba(0,0,0,0.3)',
};

export function RegenerateStrategyModal({ pageId, page, currentTee, onClose, onApplied }) {
  const notify = useNotify();
  // Inputs default to the page's persisted metadata so the operator can
  // tweak ONE field and see the difference.
  const [destination, setDestination] = useState((page && page.destination) || '');
  const [durationDays, setDurationDays] = useState(7);
  const [audience, setAudience] = useState('');
  const [tripType, setTripType] = useState('');
  const [travelMonth, setTravelMonth] = useState('');
  const [overrideFamily, setOverrideFamily] = useState('');
  const [overrideThemeId, setOverrideThemeId] = useState('');

  const [loading, setLoading] = useState(false);
  const [proposed, setProposed] = useState(null);
  const [error, setError] = useState(null);

  const runReclassify = async () => {
    setLoading(true);
    setError(null);
    setProposed(null);
    try {
      const body = {
        destination: destination || (page && page.destination) || '',
        durationDays: parseInt(durationDays, 10) || 7,
        audience: audience || 'travellers',
        tripType: tripType || null,
        travelMonth: travelMonth || null,
      };
      const overrides = {};
      if (overrideFamily) overrides.family = overrideFamily;
      if (overrideThemeId) overrides.themeId = overrideThemeId;
      if (Object.keys(overrides).length > 0) body._teeOverrides = overrides;
      const res = await fetchApi(`/api/landing-pages/${pageId}/tee/reclassify`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (!res || !res.tee) throw new Error('Empty TEE response');
      setProposed(res.tee);
    } catch (e) {
      setError(e?.message || 'Reclassification failed.');
    } finally {
      setLoading(false);
    }
  };

  // Apply the proposed classification by writing the new _tee block to
  // the page's content. The operator can choose to APPLY (persist the
  // override block onto content._tee so the page rebuilds with the new
  // family/theme defaults — the actual content stays put) or CLOSE
  // without applying. We only update the metadata block, never content.
  const applyProposed = () => {
    if (!proposed) return;
    notify.info(
      'Strategy applied to the AI decision panel. Content + images stay as-is. Use "Generate with TEE" to regenerate the page under the new strategy.'
    );
    if (typeof onApplied === 'function') onApplied(proposed);
  };

  return (
    <div style={MODAL_OVERLAY} role="dialog" aria-modal="true" aria-label="Regenerate strategy">
      <div style={MODAL_CARD} onClick={(e) => e.stopPropagation()}>
        <header style={{ padding: '0.85rem 1rem', borderBottom: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <RefreshCcw size={16} />
          <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600, flex: 1 }}>Regenerate Strategy</h3>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}>
            <X size={16} />
          </button>
        </header>
        <div style={{ padding: '0.85rem 1rem', borderBottom: '1px solid var(--border-color)', fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          <strong style={{ color: 'var(--text-primary)' }}>Reclassify without rebuilding.</strong> Try a different <em>trip type</em>, <em>audience</em>, or explicit <em>family / theme</em> and see how the TEE would route the page — no LLM call, no image fetch, no content change.
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '1rem' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
            <Field label="Destination" value={destination} onChange={setDestination} placeholder="Iceland Reykjavik" />
            <Field label="Duration (days)" value={String(durationDays)} onChange={setDurationDays} type="number" />
            <Field label="Audience" value={audience} onChange={setAudience} placeholder="couples photographers" />
            <Field label="Trip Type" value={tripType} onChange={setTripType} placeholder="luxury / family / educational / religious" />
            <Field label="Travel Month" value={travelMonth} onChange={setTravelMonth} placeholder="2026-02" />
            <Field label="Override Family" value={overrideFamily} onChange={setOverrideFamily} placeholder="(optional)" />
            <Field label="Override Theme" value={overrideThemeId} onChange={setOverrideThemeId} placeholder="luxury-coastal (optional)" />
          </div>
          <button
            type="button"
            onClick={runReclassify}
            disabled={loading}
            style={{
              background: 'var(--accent-color)', color: '#fff', border: 'none',
              borderRadius: 6, padding: '0.55rem 1.1rem', cursor: loading ? 'wait' : 'pointer',
              fontSize: '0.82rem', fontWeight: 600,
            }}
          >
            {loading ? 'Classifying…' : 'Reclassify'}
          </button>

          {error && (
            <div role="alert" style={{ marginTop: 14, padding: '0.6rem 0.8rem', background: 'rgba(220, 38, 38, 0.08)', border: '1px solid rgba(220, 38, 38, 0.3)', borderRadius: 6, fontSize: '0.78rem', color: '#b91c1c', display: 'flex', gap: 6 }}>
              <AlertCircle size={14} style={{ flexShrink: 0, marginTop: 1 }} /> {error}
            </div>
          )}

          {proposed && (
            <BeforeAfterDiff current={currentTee} proposed={proposed} />
          )}
        </div>

        <footer style={{ padding: '0.7rem 1rem', borderTop: '1px solid var(--border-color)', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={onClose}
            style={{ background: 'transparent', border: '1px solid var(--border-color)', borderRadius: 6, padding: '0.45rem 0.9rem', cursor: 'pointer', fontSize: '0.78rem' }}
          >
            Close
          </button>
          <button
            type="button"
            disabled={!proposed}
            onClick={applyProposed}
            style={{
              background: proposed ? 'var(--accent-color)' : 'var(--border-color)',
              color: '#fff', border: 'none', borderRadius: 6,
              padding: '0.45rem 0.95rem', cursor: proposed ? 'pointer' : 'not-allowed',
              fontSize: '0.78rem', fontWeight: 600,
            }}
          >
            Apply Strategy
          </button>
        </footer>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, placeholder, type = 'text' }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-secondary)', fontWeight: 600 }}>{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          padding: '0.45rem 0.6rem', borderRadius: 6,
          border: '1px solid var(--border-color)',
          fontSize: '0.82rem', background: 'var(--bg-color)',
          color: 'var(--text-primary)',
        }}
      />
    </label>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Before/After diff renderer
// ─────────────────────────────────────────────────────────────────────

function BeforeAfterDiff({ current, proposed }) {
  if (!proposed) return null;
  const cur = current || {};
  const pTraits = (proposed && proposed.traits) || {};
  const cTraits = (cur && cur.traits) || {};
  const rows = [
    { label: 'Family', current: cur.family, proposed: proposed.family },
    { label: 'Theme', current: cur.themeId, proposed: proposed.themeId },
    { label: 'Visual Mood', current: cur.visualMood || cTraits.visualMood, proposed: pTraits.visualMood },
    {
      label: 'Composition',
      current: Array.isArray(cur.composition) ? `${cur.composition.length} sections` : '—',
      proposed: Array.isArray(proposed.composition) ? `${proposed.composition.length} sections` : '—',
    },
    {
      label: 'Image Strategy',
      current: imageStrategySummary(cur.imageStrategy),
      proposed: imageStrategySummary(proposed.imageStrategy),
    },
  ];
  return (
    <div style={{ marginTop: 18, border: '1px solid var(--border-color)', borderRadius: 8, overflow: 'hidden' }}>
      <div style={{ padding: '0.55rem 0.85rem', background: 'var(--subtle-bg, rgba(0,0,0,0.03))', borderBottom: '1px solid var(--border-color)', fontSize: '0.72rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-secondary)' }}>
        Before / After
      </div>
      <div role="table" aria-label="Strategy diff">
        <DiffHeader />
        {rows.map((r, i) => <DiffRow key={i} label={r.label} current={r.current} proposed={r.proposed} />)}
      </div>
    </div>
  );
}

function DiffHeader() {
  return (
    <div role="row" style={{
      display: 'grid', gridTemplateColumns: '110px 1fr 18px 1fr',
      padding: '0.4rem 0.85rem', gap: 8, fontSize: '0.66rem',
      fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em',
      color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-color)',
    }}>
      <span></span><span>Current</span><span></span><span>Proposed</span>
    </div>
  );
}

function DiffRow({ label, current, proposed }) {
  const changed = String(current ?? '') !== String(proposed ?? '');
  return (
    <div role="row" style={{
      display: 'grid', gridTemplateColumns: '110px 1fr 18px 1fr',
      padding: '0.45rem 0.85rem', gap: 8, alignItems: 'center',
      fontSize: '0.78rem',
      background: changed ? 'rgba(245, 158, 11, 0.06)' : 'transparent',
      borderBottom: '1px solid var(--border-color)',
    }}>
      <span style={{ fontWeight: 600, color: 'var(--text-secondary)', fontSize: '0.72rem' }}>{label}</span>
      <span style={{ wordBreak: 'break-word', opacity: changed ? 0.7 : 1 }}>{String(current ?? '—')}</span>
      <ArrowRight size={12} style={{ color: changed ? 'var(--accent-color)' : 'var(--border-color)' }} />
      <span style={{ wordBreak: 'break-word', fontWeight: changed ? 600 : 400, color: changed ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
        {String(proposed ?? '—')}
      </span>
    </div>
  );
}

function imageStrategySummary(s) {
  if (!s) return '—';
  const marqueeCount = Array.isArray(s.marquee) ? s.marquee.length : 0;
  return `1 hero, ${marqueeCount} marquee, ${s.brochure ? '1' : '0'} brochure`;
}

export default TeeDecisionPanel;
