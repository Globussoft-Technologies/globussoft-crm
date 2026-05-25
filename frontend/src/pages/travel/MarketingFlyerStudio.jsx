/**
 * MarketingFlyerStudio.jsx — Phase 2 composer surface for the Travel
 * vertical Marketing Flyer Studio (GH #908). Slice 5 wires the SHELL
 * page to the /api/travel/flyer-templates CRUD endpoints shipped by
 * slice 3 (commit 5c2dd474):
 *
 *   - On mount: parse ?template=<id> from the URL. If present, GET
 *     /api/travel/flyer-templates/:id and seed the composer's local
 *     palette/layout/assets state from the parsed JSON columns.
 *   - "Save as Template" button → modal with name + sub-brand → POSTs
 *     to /api/travel/flyer-templates with palette/layout/assets
 *     serialized as JSON-string @db.Text payloads (matching the
 *     route's parseJsonColumn shape).
 *
 * The four sub-brand placeholder cards from the prior SHELL are kept
 * (Phase 2 follow-up ticks layer the canvas editor / asset library /
 * AI copy / PDF export onto this same page). The slice-5 surface is
 * additive: load + save template lifecycle without disturbing the
 * existing SHELL affordances.
 *
 * PRD reference: docs/PRD_TRAVEL_MARKETING_FLYER.md §3.1 (template
 * editor) + §3.7 (templates marketplace). Companion: FlyerTemplates
 * .jsx (commit a64c1058) is the saved-templates LIST page; the
 * composer here is the load + save surface.
 *
 * Mount: /travel/marketing/flyer-studio — wrapped in <TravelOnly> +
 * <RoleGuard allow={['ADMIN','MANAGER']}/> per the PRD's NFR-4.8 RBAC
 * surface.
 *
 * Sub-brand pre-highlight: consumes useActiveSubBrand() so the
 * operator's session-scoped "I'm working on TMC today" preference
 * pre-highlights the matching sub-brand card AND pre-fills the "Save
 * as Template" modal's sub-brand dropdown.
 *
 * Save-template URL-update decision: on successful POST, the URL is
 * updated to ?template=<newId> via setSearchParams({ template: id })
 * so a subsequent page refresh re-loads the just-saved template
 * (otherwise the operator loses their work on refresh). This is
 * non-blocking — if setSearchParams isn't available (e.g. tests
 * without Router mounted), the save still succeeds; the URL just
 * stays as-is.
 *
 * Path: frontend/src/pages/travel/MarketingFlyerStudio.jsx — sibling
 * to FlyerTemplates.jsx (the list page) + the Phase 2 Travel scaffold
 * cohort.
 */
import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Sparkles, FileImage, Lock, Save, Loader } from 'lucide-react';
import { useActiveSubBrand } from '../../utils/subBrand';
import { useNotify } from '../../utils/notify';
import { fetchApi } from '../../utils/api';

// Canonical 4-sub-brand catalogue. Kept inline (rather than imported
// from utils/travelSubBrand.js) so the SHELL is self-contained for
// reviewers + grep — the canonical id set is asserted by
// subBrand.test.jsx's cross-file invariant, so drift here would
// surface upstream.
const SUB_BRAND_CARDS = [
  {
    id: 'tmc',
    label: 'TMC',
    tagline: 'School trips — Bronze / Silver / Gold tiered packages',
    sample: 'Summer Europe — Class IX-X — 12 nights',
  },
  {
    id: 'rfu',
    label: 'RFU',
    tagline: 'Umrah & religious-tourism packages',
    sample: 'Ramadan Umrah — Departures Mar / Apr / May',
  },
  {
    id: 'travelstall',
    label: 'Travel Stall',
    tagline: 'Family weekend offers + seasonal getaways',
    sample: 'Goa weekend — ₹14,999/pax — limited time',
  },
  {
    id: 'visasure',
    label: 'Visa Sure',
    tagline: 'Visa-service flyers — KPI tiles + testimonials',
    sample: 'UK Visa in 5 days — 97% approval rate',
  },
];

// Sub-brand options for the "Save as Template" modal — the canonical
// 4 ids plus "no sub-brand" (tenant-wide template).
const SAVE_SUB_BRAND_OPTIONS = [
  { value: '', label: 'Tenant-wide (no sub-brand)' },
  { value: 'tmc', label: 'TMC (schools)' },
  { value: 'rfu', label: 'RFU (Umrah)' },
  { value: 'travelstall', label: 'Travel Stall' },
  { value: 'visasure', label: 'Visa Sure' },
];

// Default composer state. Matches the slice-1 validator's minimum-
// valid shape: 4 required hex colors + 1 placeholder text block. The
// renderer requires at least one block, so the default is a single
// "Tap to edit" text block; operators replace it via the (future)
// canvas editor.
const DEFAULT_PALETTE = {
  primaryHex: '#122647',
  secondaryHex: '#265855',
  accentHex: '#C89A4E',
  textHex: '#222222',
  bgHex: '#FFFDF7',
};

const DEFAULT_LAYOUT = [
  {
    type: 'text',
    x: 24,
    y: 24,
    width: 480,
    height: 80,
    content: 'Tap to edit headline',
  },
];

const DEFAULT_ASSETS = {};

export default function MarketingFlyerStudio() {
  const { activeSubBrand } = useActiveSubBrand() || { activeSubBrand: null };
  const notify = useNotify();
  const [searchParams, setSearchParams] = useSearchParams();

  // Composer state — palette / layout / assets. Seeded from the
  // template-load GET when ?template=<id> is present; otherwise
  // initialised to the placeholder defaults above.
  const [palette, setPalette] = useState(DEFAULT_PALETTE);
  const [layout, setLayout] = useState(DEFAULT_LAYOUT);
  const [assets, setAssets] = useState(DEFAULT_ASSETS);

  // Loaded-template metadata (display only — the canvas editor reads
  // palette/layout/assets directly).
  const [loadedTemplate, setLoadedTemplate] = useState(null);
  const [loading, setLoading] = useState(false);

  // "Save as Template" modal state.
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveSubBrand, setSaveSubBrand] = useState(activeSubBrand || '');
  const [saving, setSaving] = useState(false);

  // Parse @db.Text JSON columns from the load-template response.
  // Each column may arrive as either a JSON string (the canonical
  // storage shape) or — defensively — an already-parsed object if
  // the backend ever changes its mind. Helper handles both.
  const parseJsonField = useCallback((field, fallback) => {
    if (field == null) return fallback;
    if (typeof field === 'object') return field;
    if (typeof field === 'string') {
      try {
        return JSON.parse(field);
      } catch (_e) {
        return fallback;
      }
    }
    return fallback;
  }, []);

  const loadTemplate = useCallback(
    async (templateId) => {
      setLoading(true);
      try {
        const data = await fetchApi(`/api/travel/flyer-templates/${templateId}`);
        const parsedPalette = parseJsonField(data?.paletteJson, DEFAULT_PALETTE);
        const parsedLayout = parseJsonField(data?.layoutJson, DEFAULT_LAYOUT);
        const parsedAssets = parseJsonField(data?.assetsJson, DEFAULT_ASSETS);
        setPalette(parsedPalette || DEFAULT_PALETTE);
        setLayout(Array.isArray(parsedLayout) ? parsedLayout : DEFAULT_LAYOUT);
        setAssets(parsedAssets && typeof parsedAssets === 'object' ? parsedAssets : DEFAULT_ASSETS);
        setLoadedTemplate({
          id: data?.id ?? templateId,
          name: data?.name || `Template #${templateId}`,
          subBrand: data?.subBrand || null,
        });
        // Pre-fill the save modal with the loaded template's metadata
        // so "Save as Template" without rename overwrites cleanly
        // (well — POST creates a new row; this is the suggested name).
        setSaveName(data?.name ? `${data.name} (copy)` : '');
        setSaveSubBrand(data?.subBrand || activeSubBrand || '');
        notify?.info?.(`Loaded template: ${data?.name || `#${templateId}`}`);
      } catch (err) {
        // fetchApi already toasted via global notify on the 4xx/5xx
        // path; the route-level handler here only needs to clear the
        // loaded-template indicator and reset to defaults so the
        // composer stays usable.
        setLoadedTemplate(null);
        if (!err?.status) {
          // Non-HTTP error (parse / network race not handled by fetchApi).
          notify?.error?.(err?.message || 'Failed to load template');
        }
      } finally {
        setLoading(false);
      }
    },
    [activeSubBrand, notify, parseJsonField],
  );

  // Mount effect: if ?template=<id> is in the URL, fire the load GET.
  // Depends on the param VALUE (string), not the URLSearchParams
  // object — useSearchParams returns a fresh object reference on
  // every render, so depending on the object would re-fire the GET
  // every render (thrashes the backend; also confuses tests).
  const templateIdParam = searchParams?.get?.('template') || null;
  useEffect(() => {
    if (templateIdParam && /^\d+$/.test(templateIdParam)) {
      loadTemplate(parseInt(templateIdParam, 10));
    }
    // Intentionally only depend on the param string. loadTemplate
    // captures the latest notify + activeSubBrand via useCallback,
    // but we don't want the effect re-firing when those change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateIdParam]);

  const openSaveModal = () => {
    setSaveName(loadedTemplate?.name ? `${loadedTemplate.name} (copy)` : '');
    setSaveSubBrand(loadedTemplate?.subBrand || activeSubBrand || '');
    setShowSaveModal(true);
  };

  const closeSaveModal = () => {
    setShowSaveModal(false);
  };

  const handleSaveTemplate = async (e) => {
    e?.preventDefault?.();
    const trimmedName = (saveName || '').trim();
    if (!trimmedName) {
      notify?.error?.('Template name is required');
      return;
    }
    setSaving(true);
    try {
      const body = {
        name: trimmedName,
        // Empty-string sub-brand sends as omitted — the backend
        // treats absent subBrand as "tenant-wide" (NULL column).
        paletteJson: JSON.stringify(palette),
        layoutJson: JSON.stringify(layout),
        assetsJson: JSON.stringify(assets),
      };
      if (saveSubBrand) body.subBrand = saveSubBrand;
      const created = await fetchApi('/api/travel/flyer-templates', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      notify?.success?.(`Template "${trimmedName}" saved`);
      setShowSaveModal(false);
      // Update the URL so a refresh re-loads what was just saved
      // (otherwise the operator loses their work on refresh). The
      // try/catch guards against test environments without a router
      // (setSearchParams may throw).
      try {
        if (created?.id && setSearchParams) {
          setSearchParams({ template: String(created.id) });
        }
      } catch (_e) {
        /* no-op — URL update is best-effort */
      }
      // Reflect the freshly-saved template as the active one so the
      // next "Save as Template" pre-fills with the new name.
      if (created?.id) {
        setLoadedTemplate({
          id: created.id,
          name: created.name || trimmedName,
          subBrand: created.subBrand || null,
        });
      }
    } catch (err) {
      // fetchApi auto-toasted any 4xx/5xx via global notify. Only
      // re-surface here for non-HTTP errors (validator parse failures
      // bubble through fetchApi's err.data.errors path; for the
      // first-cut wire-in we surface the generic message).
      if (!err?.status) {
        notify?.error?.(err?.message || 'Failed to save template');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={pageWrap} data-testid="marketing-flyer-studio">
      <header style={headerWrap}>
        <div>
          <h1 style={headingStyle}>
            <FileImage size={28} aria-hidden /> Marketing Flyer Studio
          </h1>
          <p style={subtitleStyle}>
            Build branded flyers for TMC / RFU / Travel Stall / Visa Sure.
            Pick a sub-brand template to get started — your sub-brand kit
            (logo, palette, fonts) auto-loads from the tenant config.
          </p>
        </div>
        <div style={headerActions}>
          <button
            type="button"
            onClick={openSaveModal}
            style={savePrimaryBtn}
            data-testid="save-as-template-button"
            aria-label="Save current composer state as a new template"
          >
            <Save size={14} aria-hidden /> Save as Template
          </button>
          <div style={comingSoonPill} aria-label="Feature status: coming soon">
            <Sparkles size={14} aria-hidden /> Coming soon
          </div>
        </div>
      </header>

      {/* Loaded-template indicator — visible affordance that the
          composer state reflects a stored row, not the placeholder
          defaults. */}
      {loading && (
        <div role="status" style={statusBanner} data-testid="loading-template">
          <Loader size={14} aria-hidden /> Loading template&hellip;
        </div>
      )}
      {!loading && loadedTemplate && (
        <div
          role="status"
          style={statusBanner}
          data-testid="loaded-template-banner"
        >
          <strong>Editing:</strong> {loadedTemplate.name}
          {loadedTemplate.subBrand ? ` — ${loadedTemplate.subBrand.toUpperCase()}` : ''}
        </div>
      )}
      {!loading && !loadedTemplate && (
        <div role="status" style={statusBanner}>
          <strong>Phase 2 scaffold.</strong> The Marketing Flyer Studio is
          designed in <code>docs/PRD_TRAVEL_MARKETING_FLYER.md</code>;
          implementation lands in follow-up ticks (canvas editor, asset
          library, AI copy/image generation, PDF/PNG export, WhatsApp
          share). This page previews the surface only.
        </div>
      )}

      <section
        aria-label="Sub-brand template cards"
        style={cardsGrid}
        data-testid="marketing-flyer-studio-cards"
      >
        {SUB_BRAND_CARDS.map((card) => {
          const isActive = card.id === activeSubBrand;
          return (
            <article
              key={card.id}
              data-testid={`flyer-card-${card.id}`}
              data-sub-brand={card.id}
              data-active={isActive ? 'true' : 'false'}
              aria-current={isActive ? 'true' : undefined}
              style={isActive ? { ...cardStyle, ...cardActiveStyle } : cardStyle}
            >
              <div style={cardHeader}>
                <FileImage size={22} aria-hidden />
                <div>
                  <h2 style={cardTitle}>{card.label}</h2>
                  <p style={cardTagline}>{card.tagline}</p>
                </div>
              </div>
              <div style={cardSample}>
                <span style={cardSampleLabel}>Sample headline</span>
                <span style={cardSampleText}>{card.sample}</span>
              </div>
              <div
                style={comingSoonOverlay}
                data-testid={`flyer-card-${card.id}-coming-soon`}
                role="note"
                aria-label={`${card.label} flyer templates coming soon`}
              >
                <Lock size={14} aria-hidden /> Coming soon
              </div>
            </article>
          );
        })}
      </section>

      {/* "Save as Template" modal — minimal form with name + sub-brand.
          Palette / layout / assets serialize from current composer
          state. Full canvas editing lives in follow-up ticks. */}
      {showSaveModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="save-template-heading"
          style={modalOverlay}
          data-testid="save-template-modal"
        >
          <form
            onSubmit={handleSaveTemplate}
            style={modalDialog}
            data-testid="save-template-form"
          >
            <h2 id="save-template-heading" style={modalHeading}>
              Save as Template
            </h2>
            <p style={modalHint}>
              Capture the current palette + layout + assets as a reusable
              template. You can find it later on the Flyer Templates list
              page.
            </p>
            <label style={modalLabel}>
              Template name *
              <input
                type="text"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                style={modalInput}
                aria-label="Template name"
                data-testid="save-template-name"
                placeholder="e.g. Summer Europe — Class IX-X"
                autoFocus
              />
            </label>
            <label style={modalLabel}>
              Sub-brand
              <select
                value={saveSubBrand}
                onChange={(e) => setSaveSubBrand(e.target.value)}
                style={modalInput}
                aria-label="Sub-brand"
                data-testid="save-template-sub-brand"
              >
                {SAVE_SUB_BRAND_OPTIONS.map((opt) => (
                  <option key={opt.value || 'none'} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
            <div style={modalActions}>
              <button
                type="button"
                onClick={closeSaveModal}
                style={secondaryBtn}
                disabled={saving}
                data-testid="save-template-cancel"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                style={savePrimaryBtn}
                data-testid="save-template-submit"
              >
                {saving ? 'Saving…' : 'Save Template'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* TODO chunks — each maps to a PRD §3 group. Follow-up ticks
          should pick these in §8 dependency order. Grep markers
          intentionally include the PRD-section anchor so a future
          implementer's `grep -rn 'PRD §3.1'` finds the wire-in site. */}

      {/* TODO(PRD §3.1 — flyer template editor):
          Build the drag-drop block builder. Mirror the substrate from
          frontend/src/pages/LandingPageBuilder.jsx — extract into a
          shared <VisualBuilder/> first (PRD §8 dep #1). Block-type
          registry per FR-3.1.2: header / image / text / button /
          pricing-tile / testimonial / destination-grid / footer /
          kpi-tile / badge / divider. Per-block style props per
          FR-3.1.3; snap-to-grid + spacing visualizer FR-3.1.4; undo/
          redo stack FR-3.1.5; responsive preview toggle FR-3.1.6;
          concurrent-edit lock (60min TTL) FR-3.1.7. */}

      {/* TODO(PRD §3.2 — asset library):
          Per-tenant image library — new Asset model rows scoped by
          tenantId + subBrandKey + kind (LOGO/PHOTO/ICON/ILLUSTRATION).
          Multer pipeline upload FR-3.2.2; full-text tag search
          FR-3.2.3; AI image generation STUB mode FR-3.2.4 (cred-
          blocked Q-MF-2 — placeholder + ops-fulfillment queue until
          DALL-E / Replicate / Midjourney key lands per DD-5.3).
          Usage count + stale-flagging FR-3.2.5; ZIP bulk import
          FR-3.2.6. */}

      {/* TODO(PRD §3.3 — brand consistency):
          Per-sub-brand brand kit reader. Pull from
          Tenant.subBrandConfigJson.<subBrandKey> (commit 621aab7 wired
          the consumer; this page consumes per FR-3.3.1). Brand-kit-
          aware block defaults FR-3.3.2; lock-to-brand mode default
          ON per DD-5.5 (operator with MANAGER+ can toggle FR-3.3.3);
          "Apply latest brand kit" diff button FR-3.3.4. */}

      {/* TODO(PRD §3.4 — output formats):
          PDF export — extend backend/services/pdfRenderer.js with
          renderFlyer(flyerId, format) for A4 / US-letter print-quality
          (FR-3.4.1). PNG export — new backend service imageRenderer.js
          using Puppeteer for square (1080×1080) / portrait (1080×1920)
          / landscape (1920×1080) / email-banner (1200×628) aspects
          (FR-3.4.2). WhatsApp-share-ready compression to ≤5MB
          FR-3.4.3; draft-status diagonal watermark FR-3.4.4; output-
          URL caching keyed by template-hash FR-3.4.5. */}

      {/* TODO(PRD §3.5 — distribution flow):
          Direct WhatsApp share FR-3.5.1 — consumes
          whatsappProvider.sendMedia() + logs Touchpoint with flyerId.
          Cred-blocked Q-MF-3 (overlaps with WHATSAPP_INTEGRATION_PRD
          Q9 + PRD_TRAVEL_B2B_AGENT_PORTAL Q-B2B-3). Email-attach
          single + bulk FR-3.5.2; public signed-URL share FR-3.5.3;
          iframe embed-code snippet FR-3.5.4. */}

      {/* TODO(PRD §3.6 — AI assistance):
          Extend backend/lib/llmRouter.js with two task classes —
          'marketing-flyer-copy' (headline / CTA / body variants
          FR-3.6.1) and 'marketing-flyer-image' (DALL-E / Stable
          Diffusion / Midjourney per DD-5.3; STUB until Q-MF-2 lands
          FR-3.6.3). AI-suggested layouts FR-3.6.2 (rule-based Phase
          1, ML-driven Phase 2). Performance-hint engine FR-3.6.4
          deferred to Phase 2 (needs impression / conversion tracking
          plumbing). */}

      {/* TODO(PRD §3.7 — templates marketplace):
          Curated templates per sub-brand FR-3.7.1 — TMC schools
          (8-12) / RFU Umrah (6-10) / Travel Stall family (10-15) /
          Visa Sure (5-8). Per-template metadata FR-3.7.2. Operator-
          submitted templates with admin-moderated queue per DD-5.4
          (FR-3.7.3). Marketplace search + filter FR-3.7.4. */}

      {/* TODO(PRD §8 — dependency build order):
          Phase 1 ships AC-6.1 through AC-6.10 except AC-6.9 (Q-MF-3
          cred-blocked, stub mode acceptable). Phase 2 layers
          analytics, A/B testing, animated MP4/GIF output. Phase 3
          adds print-on-demand fulfillment via Printful / Vistaprint.
          Do NOT start in-house editor build until DD-5.1 is resolved
          (sunk cost: 4-6 weeks if Polotno would have worked). */}
    </div>
  );
}

const pageWrap = {
  padding: 24,
  maxWidth: 1200,
  margin: '0 auto',
};

const headerWrap = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  flexWrap: 'wrap',
  gap: 12,
  marginBottom: 16,
};

const headerActions = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  flexWrap: 'wrap',
};

const headingStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  margin: 0,
  marginBottom: 4,
  color: 'var(--text-primary)',
};

const subtitleStyle = {
  color: 'var(--text-secondary)',
  margin: 0,
  maxWidth: 720,
  lineHeight: 1.5,
};

const comingSoonPill = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 12px',
  borderRadius: 999,
  background: 'var(--primary-color, var(--accent-color))',
  color: 'var(--accent-text, #fff)',
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: 0.3,
};

const statusBanner = {
  padding: '12px 16px',
  borderRadius: 8,
  background: 'var(--surface-color)',
  border: '1px solid var(--border-color)',
  color: 'var(--text-primary)',
  fontSize: 13,
  lineHeight: 1.5,
  marginBottom: 20,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
};

const cardsGrid = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))',
  gap: 16,
  marginBottom: 24,
};

const cardStyle = {
  position: 'relative',
  background: 'var(--surface-color)',
  border: '1px solid var(--border-color)',
  borderRadius: 10,
  padding: 16,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  minHeight: 180,
  transition: 'border-color 120ms ease, box-shadow 120ms ease',
};

const cardActiveStyle = {
  borderColor: 'var(--primary-color, var(--accent-color))',
  boxShadow: '0 0 0 2px rgba(38, 88, 85, 0.18)',
};

const cardHeader = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 10,
  color: 'var(--primary-color, var(--accent-color))',
};

const cardTitle = {
  margin: 0,
  fontSize: 16,
  fontWeight: 600,
  color: 'var(--text-primary)',
};

const cardTagline = {
  margin: '2px 0 0',
  fontSize: 12,
  color: 'var(--text-secondary)',
  lineHeight: 1.4,
};

const cardSample = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: '10px 12px',
  borderRadius: 6,
  background: 'var(--subtle-bg, rgba(0,0,0,0.03))',
  border: '1px dashed var(--border-color)',
};

const cardSampleLabel = {
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  color: 'var(--text-secondary)',
};

const cardSampleText = {
  fontSize: 13,
  color: 'var(--text-primary)',
  fontStyle: 'italic',
};

const comingSoonOverlay = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  alignSelf: 'flex-start',
  padding: '4px 10px',
  borderRadius: 999,
  background: 'rgba(0, 0, 0, 0.08)',
  color: 'var(--text-secondary)',
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: 0.3,
  textTransform: 'uppercase',
};

const savePrimaryBtn = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '8px 14px',
  borderRadius: 6,
  fontWeight: 600,
  fontSize: 13,
  background: 'var(--primary-color, var(--accent-color))',
  color: 'var(--accent-text, #fff)',
  border: 'none',
  cursor: 'pointer',
};

const secondaryBtn = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '8px 14px',
  borderRadius: 6,
  fontWeight: 600,
  fontSize: 13,
  background: 'var(--surface-color)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border-color)',
  cursor: 'pointer',
};

const modalOverlay = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.5)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
  padding: 16,
};

const modalDialog = {
  background: 'var(--surface-color)',
  border: '1px solid var(--border-color)',
  borderRadius: 10,
  padding: 20,
  width: '100%',
  maxWidth: 480,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};

const modalHeading = {
  margin: 0,
  fontSize: 18,
  fontWeight: 600,
  color: 'var(--text-primary)',
};

const modalHint = {
  margin: 0,
  fontSize: 12,
  color: 'var(--text-secondary)',
  lineHeight: 1.4,
};

const modalLabel = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  fontSize: 12,
  color: 'var(--text-secondary)',
};

const modalInput = {
  padding: '8px 10px',
  borderRadius: 6,
  border: '1px solid var(--border-color)',
  background: 'var(--bg-color, rgba(255,255,255,0.05))',
  color: 'var(--text-primary)',
  fontSize: 13,
  outline: 'none',
};

const modalActions = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 8,
  marginTop: 8,
};
