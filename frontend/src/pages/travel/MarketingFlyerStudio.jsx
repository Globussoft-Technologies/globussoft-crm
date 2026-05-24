/**
 * MarketingFlyerStudio.jsx — Phase 2 SHELL for the Travel vertical
 * Marketing Flyer Studio (GH #908). This is a NON-FUNCTIONAL scaffold
 * that mounts under the Travel vertical and previews the upcoming
 * flyer-builder surface; the actual flyer authoring (canvas editor,
 * asset library, AI copy/image generation, PDF/PNG export, WhatsApp
 * share) ships in follow-up ticks per the PRD's §8 build-order.
 *
 * PRD reference: docs/PRD_TRAVEL_MARKETING_FLYER.md
 *   - §3.1 — flyer template editor (block-builder; canonical
 *     LandingPageBuilder substrate to mirror; concurrent-edit lock)
 *   - §3.2 — asset library (per-tenant images, AI image gen STUB)
 *   - §3.3 — brand consistency (per-sub-brand kit, lock-to-brand)
 *   - §3.4 — output formats (A4 PDF / PNG aspects / watermark draft)
 *   - §3.5 — distribution flow (WhatsApp share, email attach, public
 *     signed URL, embed code)
 *   - §3.6 — AI assistance (llmRouter task classes — copy + layout +
 *     image)
 *   - §3.7 — templates marketplace (curated + operator-submitted)
 *
 * Mount: /travel/marketing/flyer-studio — wrapped in <TravelOnly> +
 * <RoleGuard allow={['ADMIN','MANAGER']}/> per the PRD's NFR-4.8 RBAC
 * surface ("Asset upload + flyer create requires role ∈ {ADMIN,
 * MANAGER, USER}" — but this is an OPERATOR-FACING marketing surface,
 * so the SHELL gates at MANAGER+ until product calls in §5 / OQ-9.3
 * resolve the per-role workflow defaults).
 *
 * Sub-brand pre-highlight: consumes useActiveSubBrand() so the
 * operator's session-scoped "I'm working on TMC today" preference
 * (set via the Sidebar switcher per PRD §4.10 / Q25) pre-highlights
 * the matching sub-brand card. Falls back gracefully to "no active
 * sub-brand" when the context is null (e.g. first-load + nothing
 * stored in sessionStorage).
 *
 * Sub-brand cards: ONE card per Travel sub-brand (TMC / RFU /
 * Travel Stall / Visa Sure — the canonical 4 ids per
 * frontend/src/utils/travelSubBrand.js's SUB_BRAND_IDS array, kept
 * in sync with VALID_SUB_BRANDS in subBrand.jsx). Each card carries
 * a "Coming soon" overlay since the implementation hasn't shipped
 * yet — visible affordances per the SHELL-page convention used by
 * TravelStallDashboard.jsx (tick #154) + TravelVisaDashboard
 * (cluster B3 scaffolding).
 *
 * Implementation ordering (TODO chunks below map directly to PRD §3
 * functional-requirement groups; each chunk is a separate follow-up
 * tick so a future agent's grep on the TODO landmarks finds the
 * PRD section number).
 *
 * Path: frontend/src/pages/travel/MarketingFlyerStudio.jsx — sibling
 * to CurriculumAdmin.jsx (tick #181) and TravelStallDashboard.jsx
 * (tick #154) in the Phase 2 Travel scaffold cohort.
 */
import { Sparkles, FileImage, Lock } from 'lucide-react';
import { useActiveSubBrand } from '../../utils/subBrand';

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

export default function MarketingFlyerStudio() {
  const { activeSubBrand } = useActiveSubBrand() || { activeSubBrand: null };

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
        <div style={comingSoonPill} aria-label="Feature status: coming soon">
          <Sparkles size={14} aria-hidden /> Coming soon
        </div>
      </header>

      {/* PRD §1 status banner — SHELL-page convention: visible affordance
          that the surface is scaffolded, not implemented. Operators
          landing here should understand the feature is announced + the
          UI shape is locked, but the create/edit/export pipeline is
          still building. */}
      <div role="status" style={statusBanner}>
        <strong>Phase 2 scaffold.</strong> The Marketing Flyer Studio is
        designed in <code>docs/PRD_TRAVEL_MARKETING_FLYER.md</code>;
        implementation lands in follow-up ticks (canvas editor, asset
        library, AI copy/image generation, PDF/PNG export, WhatsApp
        share). This page previews the surface only.
      </div>

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
