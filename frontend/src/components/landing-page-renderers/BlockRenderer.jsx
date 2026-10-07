/**
 * BlockRenderer.jsx — Renders a block-array landing page (legacy format).
 * Supports both generic blocks and travel-destination blocks.
 * Maps each block to the appropriate React component.
 */

import React from 'react';
import {
  HeadingBlock,
  TextBlock,
  ImageBlock,
  ButtonBlock,
  FormBlock,
  DividerBlock,
  SpacerBlock,
  VideoBlock,
  ColumnsBlock,
} from '../landing-blocks/BasicBlocks';
import {
  DestinationHeroBlock,
  CityCardsBlock,
  HighlightsGridBlock,
  InclusionsGridBlock,
  TierPricingBlock,
  FaqAccordionBlock,
  SafetyFeaturesBlock,
  ItineraryTimelineBlock,
  ContactFooterBlock,
} from '../landing-blocks/TravelBlocks';
import { DEFAULT_WELLNESS_LANDING_THEME, resolveWellnessLandingTheme } from '../../utils/wellnessLandingThemes';

/**
 * Render a single block based on its type.
 * @param {Object} block - { type, props }
 * @param {string} slug - Landing page slug for form submissions
 * @param {number} pageId - Landing page ID for API submissions
 * @param {Function} renderBlockFn - Recursive render function for nested blocks
 */
function renderBlock(block, slug, pageId, renderBlockFn, submitEndpoint = '', tmcParentRegistrationUrl = '') {
  if (!block || !block.type) return null;

  const { type, props = {} } = block;

  switch (type) {
    // Basic blocks
    case 'heading':
      return <HeadingBlock key={block.id || Math.random()} props={props} />;
    case 'text':
      return <TextBlock key={block.id || Math.random()} props={props} />;
    case 'image':
      return <ImageBlock key={block.id || Math.random()} props={props} />;
    case 'button':
      return <ButtonBlock key={block.id || Math.random()} props={props} />;
    case 'form':
      return <FormBlock key={block.id || Math.random()} props={props} slug={slug} pageId={pageId} submitEndpoint={submitEndpoint} />;
    case 'divider':
      return <DividerBlock key={block.id || Math.random()} props={props} />;
    case 'spacer':
      return <SpacerBlock key={block.id || Math.random()} props={props} />;
    case 'video':
      return <VideoBlock key={block.id || Math.random()} props={props} />;
    case 'columns':
      return (
        <ColumnsBlock
          key={block.id || Math.random()}
          props={props}
          renderBlock={renderBlockFn}
        />
      );

    // Travel destination blocks
    case 'destinationHero':
      return <DestinationHeroBlock key={block.id || Math.random()} props={props} slug={slug} tmcParentRegistrationUrl={tmcParentRegistrationUrl} />;
    case 'cityCards':
      return <CityCardsBlock key={block.id || Math.random()} props={props} />;
    case 'highlightsGrid':
      return <HighlightsGridBlock key={block.id || Math.random()} props={props} />;
    case 'inclusionsGrid':
      return <InclusionsGridBlock key={block.id || Math.random()} props={props} />;
    case 'tierPricing':
      return <TierPricingBlock key={block.id || Math.random()} props={props} />;
    case 'faqAccordion':
      return <FaqAccordionBlock key={block.id || Math.random()} props={props} />;
    case 'safetyFeatures':
      return <SafetyFeaturesBlock key={block.id || Math.random()} props={props} />;
    case 'itineraryTimeline':
      return <ItineraryTimelineBlock key={block.id || Math.random()} props={props} />;
    case 'contactFooter':
      return <ContactFooterBlock key={block.id || Math.random()} props={props} />;

    default:
      console.warn(`Unknown block type: ${type}`);
      return null;
  }
}

/**
 * BlockRenderer — Renders a page from a block array.
 * The block array is stored in landingPage.content and parsed as JSON.
 */
function cloneBlocks(blocks) {
  try {
    return JSON.parse(JSON.stringify(blocks));
  } catch (_err) {
    return Array.isArray(blocks) ? blocks : [];
  }
}

function isCardishWellnessBlock(block) {
  if (!block || block.type !== 'columns') return false;
  const variant = block.props?.variant;
  if (variant === 'wellness-benefit-cards' || variant === 'wellness-supporting') return true;
  const ids = (block.props?.columns || [])
    .flatMap((col) => (col.components || []).map((child) => child.id));
  return ids.some((id) => ['contact-title', 'why-title', 'after-title'].includes(id));
}

function normalizeWellnessCampaignBlocks(blocks) {
  const next = cloneBlocks(blocks);
  const page = next.find((block) => block?.type === 'columns' && block.props?.variant === 'wellness-campaign-page');
  if (!page) return next;

  const findRow = (variant) => (page.props?.columns || [])
    .flatMap((column) => column?.components || [])
    .find((block) => block?.type === 'columns' && block.props?.variant === variant);

  const header = findRow('wellness-header-row');
  const headerBrandColumn = header?.props?.columns?.[0];
  if (headerBrandColumn) {
    headerBrandColumn.components = (headerBrandColumn.components || [])
      .filter((block) => block?.id !== 'brand-subline' && block?.props?.variant !== 'wellness-brand-subline');
  }
  const headerNavColumn = header?.props?.columns?.[1];
  if (headerNavColumn) {
    headerNavColumn.components = (headerNavColumn.components || [])
      .filter((block) => block?.type !== 'button');
  }

  const hero = findRow('wellness-hero-row');
  if (hero?.props?.columns) {
    hero.props.columns = hero.props.columns.map((column) => {
      const buttons = (column.components || []).filter((block) => block?.type === 'button');
      if (buttons.length <= 1) return column;
      const preferred = buttons.find((block) => block.id === 'hero-primary-cta') || buttons[0];
      return {
        ...column,
        components: (column.components || []).filter((block) => block?.type !== 'button' || block === preferred),
      };
    });
  }

  const allPageBlocks = [];
  const collectPageBlocks = (block) => {
    if (!block || typeof block !== 'object') return;
    allPageBlocks.push(block);
    (block.props?.columns || []).forEach((column) => (column.components || []).forEach(collectPageBlocks));
  };
  collectPageBlocks(page);
  const usedWellnessImageSources = new Set();
  allPageBlocks
    .filter((block) => block?.type === 'image' && typeof block?.props?.src === 'string' && block.props.src.trim())
    .forEach((block) => {
      const src = block.props.src.trim();
      if (usedWellnessImageSources.has(src)) {
        // Do not let a legacy/generated duplicate photo dominate multiple
        // campaign slots. The empty slot renders its intentional placeholder
        // until an operator adds a distinct campaign image.
        block.props.src = '';
      } else {
        usedWellnessImageSources.add(src);
      }
  });
  const heroImage = allPageBlocks.find((block) => block?.id === 'hero-image' && block?.type === 'image' && block?.props?.src);
  const cta = findRow('wellness-cta-row');
  if (cta?.props?.columns?.length >= 2 && heroImage) {
    const ctaColumns = cta.props.columns;
    const existingCtaImage = ctaColumns.flatMap((column) => column.components || []).find((block) => block?.id === 'cta-image');
    if (existingCtaImage) {
      if (existingCtaImage.props?.src === heroImage.props.src) existingCtaImage.props.src = '';
    } else {
      const copyComponents = (ctaColumns[0].components || []).filter((block) => block?.type !== 'button');
      const actionComponents = (ctaColumns[1].components || []).filter((block) => block?.type !== 'image');
      cta.props.columns = [
        {
          components: [{
            id: 'cta-image',
            type: 'image',
            props: {
              src: '',
              alt: 'Wellness campaign experience',
              variant: 'wellness-cta-image',
              width: '100%',
              maxWidth: '100%',
            },
          }],
        },
        { components: [...copyComponents, ...actionComponents] },
      ];
    }
  }

  const formRow = ['wellness-form-row', 'wellness-registration-row']
    .map((variant) => findRow(variant))
    .find((row) => row?.props?.columns?.some((column) => (column.components || []).some((block) => block?.id === 'lead-form')));
  const formColumn = formRow?.props?.columns?.find((column) => (column.components || []).some((block) => block?.id === 'lead-form'));
  if (formColumn) {
    formColumn.components = (formColumn.components || []).filter((block) => block?.id !== 'form-title-copy');
    formRow.props.columns = [formColumn];
  }

  const pageColumns = page.props?.columns || [];
  page.props.columns = pageColumns.filter((col) => {
    const components = col.components || [];
    const isRegistrationHolder = components.some((child) => child?.type === 'columns' && child.props?.variant === 'wellness-registration-row');
    if (isRegistrationHolder) return true;
    const cardBlocks = components.filter(isCardishWellnessBlock);
    return cardBlocks.length === 0;
  });

  const registration = (page.props.columns || [])
    .flatMap((col) => col.components || [])
    .find((child) => child?.type === 'columns' && child.props?.variant === 'wellness-registration-row');
  if (registration) {
    const formColumn = (registration.props.columns || [])
      .find((column) => (column.components || []).some((block) => block?.id === 'lead-form'));
    if (formColumn) registration.props.columns = [formColumn];
  }
  return next;
}

export default function BlockRenderer({ landingPage = {} }) {
  const rawBlocks = Array.isArray(landingPage.content)
    ? landingPage.content
    : [];
  const blocks = normalizeWellnessCampaignBlocks(rawBlocks);

  const slug = landingPage.slug || '';
  const isWellnessLandingPage = typeof landingPage.templateType === 'string'
    && landingPage.templateType.startsWith('generic-site-');
  const publicSubmit = !!landingPage.publicSubmit;
  const pageId = publicSubmit ? null : (landingPage.id || null);
  const submitEndpoint = publicSubmit && slug ? `/api/pages/${slug}/submit` : '';
  const tmcParentRegistrationUrl = landingPage.tmcParentRegistrationUrl || '';
  const wellnessRoot = blocks.find((block) => block?.type === 'columns' && block.props?.variant === 'wellness-campaign-page');
  const wellnessTheme = isWellnessLandingPage
    ? resolveWellnessLandingTheme(wellnessRoot?.props?.themeId || DEFAULT_WELLNESS_LANDING_THEME, wellnessRoot?.props?.customColors)
    : null;
  const wellnessLayoutId = wellnessRoot?.props?.layoutId || 'editorial';
  const wellnessVars = wellnessTheme ? {
    '--wellness-bg': wellnessTheme.bg,
    '--wellness-surface': wellnessTheme.surface,
    '--wellness-surface-soft': wellnessTheme.surfaceSoft,
    '--wellness-ink': wellnessTheme.ink,
    '--wellness-muted': wellnessTheme.muted,
    '--wellness-primary': wellnessTheme.primary,
    '--wellness-primary-deep': wellnessTheme.primaryDeep,
    '--wellness-accent': wellnessTheme.accent,
    '--wellness-accent-soft': wellnessTheme.accentSoft,
    '--wellness-border': wellnessTheme.border,
    '--wellness-inverse': wellnessTheme.inverse,
  } : undefined;

  // Track analytics (page view)
  React.useEffect(() => {
    if (slug) {
      new Image().src = `/api/pages/${slug}/track?event=VISIT`;
    }
  }, [slug]);

  const renderBlockWithContext = (block) => renderBlock(block, slug, pageId, renderBlockWithContext, submitEndpoint, tmcParentRegistrationUrl);

  return (
    <main className={`landing-page block-renderer${isWellnessLandingPage ? ` wellness-page wellness-campaign-page--${String(wellnessLayoutId).replace(/[^a-z0-9_-]/gi, '-').toLowerCase()}` : ''}`}>
      <style>{`
        .landing-page {
          margin: 0;
          padding: 0;
          min-height: 100vh;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif;
          color: #243244;
          line-height: 1.6;
          background: var(--wellness-bg, #fbf8f1);
        }

        .landing-page.wellness-page { min-height: 0 !important; background: var(--wellness-bg, #f4fbf7); overflow-x: hidden; }
        .landing-page.wellness-page .wellness-shell { position: relative; isolation: isolate; max-width: none; background: var(--wellness-bg, #f4fbf7) !important; color: var(--wellness-ink, #173b35) !important; overflow: hidden; }
        .landing-page.wellness-page .wellness-shell::before { content: ''; position: absolute; inset: 0 0 auto; height: 540px; z-index: -1; pointer-events: none; background: radial-gradient(circle at 12% 8%, color-mix(in srgb, var(--wellness-accent, #ef9b59) 22%, transparent), transparent 30%), radial-gradient(circle at 88% 2%, color-mix(in srgb, var(--wellness-primary, #1f8a70) 20%, transparent), transparent 34%); }
        .landing-page.wellness-page .wellness-shell > div { min-width: 0 !important; animation: wellness-float-in .65s ease both; }
        .landing-page.wellness-page .wellness-media { position: relative; overflow: hidden; display: block; margin: 0; border: 1px solid var(--wellness-border, #cfe3d9); background: linear-gradient(145deg, var(--wellness-primary-deep, #126052), var(--wellness-primary, #1f8a70) 58%, var(--wellness-accent, #ef9b59)); box-shadow: 0 22px 44px color-mix(in srgb, var(--wellness-primary-deep, #126052) 16%, transparent); }
        .landing-page.wellness-page .wellness-media--hero { min-height: clamp(360px, 43vw, 590px); border-radius: 34px 10px 34px 10px; transform: rotate(1deg); }
        .landing-page.wellness-page .wellness-media--gallery { min-height: 250px; border-radius: 22px 8px 22px 8px; }
        .landing-page.wellness-page .wellness-media--cta { min-height: 300px; height: 100%; border-radius: 28px 8px 28px 8px; }
        .landing-page.wellness-page .wellness-media img { display: block; width: 100%; height: 100%; min-height: inherit; object-fit: cover; transition: transform 700ms cubic-bezier(.2,.7,.2,1); }
        .landing-page.wellness-page .wellness-media:hover img { transform: scale(1.06); }
        .landing-page.wellness-page .wellness-media-placeholder { display: grid; place-items: center; min-height: inherit; padding: 2rem; color: rgba(255,255,255,.92); font-weight: 800; letter-spacing: .08em; text-transform: uppercase; text-align: center; }
        @keyframes wellness-float-in { from { opacity: 0; transform: translateY(18px); } to { opacity: 1; transform: translateY(0); } }
        @media (prefers-reduced-motion: reduce) { .landing-page.wellness-page .wellness-shell > div { animation: none; } .landing-page.wellness-page .wellness-media img { transition: none; } }

        /* Wellness campaign layout: full-bleed landing page bands, not a stack of cards. */
        .landing-page.wellness-page .landing-page-content.wellness-content {
          display: block !important;
          width: 100% !important;
          max-width: none !important;
          margin: 0 !important;
          padding: 0 !important;
        }
        .landing-page.wellness-page .wellness-shell {
          display: block !important;
          width: 100% !important;
          min-width: 100% !important;
          max-width: none !important;
          margin: 0 !important;
          padding: 0 !important;
          background: var(--wellness-bg, #f4fbf7) !important;
        }
        .landing-page.wellness-page .wellness-shell > div {
          width: 100% !important;
          max-width: none !important;
          min-width: 0 !important;
          margin: 0 !important;
          padding: 0 !important;
          display: block !important;
          background: transparent !important;
          border: 0 !important;
          box-shadow: none !important;
        }
        .landing-page.wellness-page .wellness-layout {
          width: 100% !important;
          max-width: none !important;
          margin: 0 !important;
          border: 0 !important;
          border-radius: 0 !important;
          box-shadow: none !important;
          overflow: visible !important;
        }
        .landing-page.wellness-page .wellness-layout > div {
          min-width: 0 !important;
          max-width: none !important;
          margin: 0 !important;
          background: transparent !important;
          border: 0 !important;
          border-radius: 0 !important;
          box-shadow: none !important;
        }
        .landing-page.wellness-page .wellness-layout--wellness-header-row {
          display: grid !important;
          grid-template-columns: minmax(0, 1fr) auto !important;
          align-items: center !important;
          gap: 28px !important;
          padding: 28px clamp(24px, 7vw, 120px) !important;
          background: color-mix(in srgb, var(--wellness-surface, #fff) 92%, transparent) !important;
          border-bottom: 1px solid var(--wellness-border, #cfe3d9) !important;
        }
        .landing-page.wellness-page .wellness-layout--wellness-header-row > div:first-child {
          display: flex !important;
          flex-direction: row !important;
          align-items: center !important;
          gap: 0 !important;
          min-width: 0 !important;
        }
        .landing-page.wellness-page .wellness-layout--wellness-header-row > div:first-child .wellness-brand-subline { display: none !important; }
        .landing-page.wellness-page .wellness-layout--wellness-header-row > div:first-child .wellness-logo { white-space: nowrap !important; }
        .landing-page.wellness-page .wellness-layout--wellness-header-row > div:last-child {
          display: flex !important;
          flex-direction: row !important;
          align-items: center !important;
          justify-content: flex-end !important;
          gap: clamp(20px, 3vw, 44px) !important;
          min-width: 0 !important;
        }
        .landing-page.wellness-page .wellness-layout--wellness-header-row > div:last-child .wellness-nav {
          display: flex !important;
          align-items: center !important;
          justify-content: flex-end !important;
          flex-wrap: nowrap !important;
          gap: clamp(16px, 2.2vw, 32px) !important;
          white-space: nowrap !important;
          word-spacing: normal !important;
          letter-spacing: 0.12em !important;
        }
        .landing-page.wellness-page .wellness-nav a,
        .landing-page.wellness-page .wellness-nav span { color: inherit !important; text-decoration: none !important; font-weight: 700 !important; }
        .landing-page.wellness-page .wellness-nav a { transition: color .2s ease, transform .2s ease; }
        .landing-page.wellness-page .wellness-nav a:hover,
        .landing-page.wellness-page .wellness-nav a:focus-visible { color: var(--wellness-primary, #2f6b50) !important; text-decoration: none !important; transform: translateY(-1px); }
        .landing-page.wellness-page [id^="wellness-"] { scroll-margin-top: 24px; }
        .landing-page.wellness-page .wellness-layout--wellness-header-row > div > div { margin: 0 !important; min-width: 0 !important; }
        .landing-page.wellness-page .wellness-layout--wellness-hero-row {
          display: grid !important;
          grid-template-columns: minmax(0, 0.92fr) minmax(360px, 0.88fr) !important;
          align-items: center !important;
          gap: clamp(40px, 7vw, 120px) !important;
          min-height: min(780px, calc(100vh - 92px)) !important;
          padding: clamp(72px, 10vw, 150px) clamp(24px, 8vw, 144px) !important;
          background:
            radial-gradient(circle at 80% 22%, color-mix(in srgb, var(--wellness-accent, #ef9b59) 24%, transparent), transparent 30%),
            linear-gradient(120deg, var(--wellness-bg, #f4fbf7) 0%, var(--wellness-surface-soft, #e8f4ee) 100%) !important;
        }
        .landing-page.wellness-page .wellness-layout--wellness-hero-row > div {
          justify-content: center !important;
        }
        .landing-page.wellness-page .wellness-layout--wellness-hero-row > div:first-child { max-width: 720px !important; }
        .landing-page.wellness-page .wellness-layout--wellness-hero-row > div:last-child { min-width: 0 !important; }
        .landing-page.wellness-page .wellness-layout--wellness-hero-row .wellness-media--hero {
          width: 100% !important;
          height: min(620px, 48vw) !important;
          min-height: 420px !important;
          border-radius: 36px 36px 36px 110px !important;
          transform: none !important;
          box-shadow: 0 32px 70px color-mix(in srgb, var(--wellness-primary-deep, #126052) 22%, transparent) !important;
        }
        .landing-page.wellness-page .wellness-layout--wellness-details-strip {
          display: grid !important;
          grid-template-columns: repeat(4, minmax(0, 1fr)) !important;
          gap: 0 !important;
          padding: 0 clamp(24px, 8vw, 144px) !important;
          background: var(--wellness-surface, #fff) !important;
          border-top: 1px solid var(--wellness-border, #cfe3d9) !important;
          border-bottom: 1px solid var(--wellness-border, #cfe3d9) !important;
        }
        .landing-page.wellness-page .wellness-layout--wellness-details-strip > div {
          min-height: 136px !important;
          padding: 30px 26px !important;
          justify-content: center !important;
          border-right: 1px solid var(--wellness-border, #cfe3d9) !important;
        }
        .landing-page.wellness-page .wellness-layout--wellness-details-strip > div:last-child { border-right: 0 !important; }
        .landing-page.wellness-page .wellness-layout--wellness-gallery-row {
          display: grid !important;
          grid-template-columns: minmax(0, 1.2fr) repeat(2, minmax(0, 0.8fr)) !important;
          gap: 20px !important;
          padding: clamp(58px, 8vw, 110px) clamp(24px, 8vw, 144px) !important;
          background: var(--wellness-surface-soft, #e8f4ee) !important;
        }
        .landing-page.wellness-page .wellness-layout--wellness-gallery-row > div { min-height: 320px !important; }
        .landing-page.wellness-page .wellness-layout--wellness-gallery-row .wellness-media--gallery {
          width: 100% !important;
          height: clamp(280px, 28vw, 420px) !important;
          min-height: 280px !important;
          border-radius: 26px !important;
          box-shadow: 0 18px 46px color-mix(in srgb, var(--wellness-primary-deep, #126052) 14%, transparent) !important;
        }
        .landing-page.wellness-page .wellness-layout--wellness-gallery-row > div:first-child .wellness-media--gallery { height: clamp(360px, 36vw, 520px) !important; }
        .landing-page.wellness-page .wellness-layout--wellness-benefits-row,
        .landing-page.wellness-page .wellness-layout--wellness-process-row {
          display: grid !important;
          grid-template-columns: minmax(260px, 0.62fr) minmax(0, 1.38fr) !important;
          align-items: start !important;
          gap: clamp(40px, 7vw, 120px) !important;
          padding: clamp(70px, 9vw, 128px) clamp(24px, 8vw, 144px) !important;
        }
        .landing-page.wellness-page .wellness-layout--wellness-benefits-row { background: var(--wellness-surface, #fff) !important; }
        .landing-page.wellness-page .wellness-layout--wellness-process-row { background: var(--wellness-bg, #f4fbf7) !important; }
        .landing-page.wellness-page .wellness-layout--wellness-benefit-grid,
        .landing-page.wellness-page .wellness-layout--wellness-step-grid {
          display: grid !important;
          grid-template-columns: repeat(4, minmax(0, 1fr)) !important;
          gap: 18px !important;
        }
        .landing-page.wellness-page .wellness-layout--wellness-benefit-grid > div,
        .landing-page.wellness-page .wellness-layout--wellness-step-grid > div {
          min-height: 210px !important;
          padding: 28px !important;
          background: var(--wellness-bg, #f4fbf7) !important;
          border: 1px solid var(--wellness-border, #cfe3d9) !important;
          border-radius: 22px !important;
          box-shadow: none !important;
        }
        .landing-page.wellness-page .wellness-layout--wellness-step-grid > div { background: var(--wellness-surface, #fff) !important; }
        .landing-page.wellness-page .wellness-layout--wellness-impact-band {
          display: grid !important;
          grid-template-columns: minmax(260px, 0.72fr) minmax(0, 1.28fr) !important;
          align-items: center !important;
          gap: clamp(40px, 7vw, 120px) !important;
          padding: clamp(58px, 8vw, 96px) clamp(24px, 8vw, 144px) !important;
          background: linear-gradient(120deg, var(--wellness-primary-deep, #126052), var(--wellness-primary, #1f8a70)) !important;
          color: var(--wellness-inverse, #fff) !important;
          overflow: hidden !important;
        }
        .landing-page.wellness-page .wellness-layout--wellness-impact-band > div { min-width: 0 !important; }
        .landing-page.wellness-page .wellness-layout--wellness-impact-band .landing-heading--wellness-band-title {
          max-width: 620px !important;
          line-height: 1.12 !important;
          overflow-wrap: anywhere !important;
        }
        .landing-page.wellness-page .wellness-layout--wellness-impact-band .landing-text--wellness-band-copy {
          max-width: 580px !important;
          color: color-mix(in srgb, var(--wellness-inverse, #fff) 90%, transparent) !important;
          line-height: 1.55 !important;
          overflow-wrap: anywhere !important;
        }
        .landing-page.wellness-page .wellness-layout--wellness-impact-band .landing-text--wellness-eyebrow {
          color: var(--wellness-accent-soft, #fff1d8) !important;
        }
        .landing-page.wellness-page .wellness-layout--wellness-metric-grid {
          display: grid !important;
          grid-template-columns: repeat(4, minmax(0, 1fr)) !important;
          gap: 14px !important;
          min-width: 0 !important;
        }
        .landing-page.wellness-page .wellness-layout--wellness-metric-grid > div {
          min-width: 0 !important;
          width: 100% !important;
          min-height: 170px !important;
          padding: 22px 14px !important;
          background: rgba(255,255,255,.12) !important;
          border: 1px solid rgba(255,255,255,.25) !important;
          border-radius: 18px !important;
          box-shadow: none !important;
          box-sizing: border-box !important;
          overflow-wrap: anywhere !important;
        }
        .landing-page.wellness-page .wellness-layout--wellness-metric-grid .landing-heading--wellness-metric-value {
          width: 100% !important;
          max-width: 100% !important;
          min-width: 0 !important;
          margin: 0 0 8px !important;
          font-size: clamp(1.15rem, 1.4vw, 1.85rem) !important;
          line-height: 1.08 !important;
          white-space: normal !important;
          overflow-wrap: anywhere !important;
          word-break: normal !important;
          text-align: center !important;
        }
        .landing-page.wellness-page .wellness-layout--wellness-metric-grid .landing-text--wellness-metric-label {
          width: 100% !important;
          max-width: 100% !important;
          min-width: 0 !important;
          margin: 0 !important;
          color: color-mix(in srgb, var(--wellness-inverse, #fff) 92%, transparent) !important;
          line-height: 1.35 !important;
          overflow-wrap: anywhere !important;
        }
        .landing-page.wellness-page .wellness-layout--wellness-cta-row {
          display: grid !important;
          grid-template-columns: minmax(280px, 0.9fr) minmax(0, 1.1fr) !important;
          align-items: center !important;
          gap: 32px !important;
          padding: clamp(54px, 7vw, 88px) clamp(24px, 8vw, 144px) !important;
          background: var(--wellness-surface, #fff) !important;
        }
        .landing-page.wellness-page .wellness-layout--wellness-cta-row > div:first-child { min-height: 300px !important; }
        .landing-page.wellness-page .wellness-layout--wellness-cta-row > div:last-child { max-width: 680px !important; }
        .landing-page.wellness-page .wellness-layout--wellness-form-row {
          display: grid !important;
          grid-template-columns: minmax(320px, 0.78fr) minmax(0, 1.22fr) !important;
          align-items: start !important;
          gap: clamp(40px, 7vw, 120px) !important;
          padding: clamp(72px, 9vw, 132px) clamp(24px, 8vw, 144px) !important;
          background: var(--wellness-surface-soft, #e8f4ee) !important;
        }
        .landing-page.wellness-page .wellness-layout--wellness-form-row > div:first-child {
          padding: clamp(24px, 3vw, 46px) !important;
          background: var(--wellness-surface, #fff) !important;
          border: 1px solid var(--wellness-border, #cfe3d9) !important;
          border-radius: 28px !important;
          box-shadow: 0 22px 60px color-mix(in srgb, var(--wellness-primary-deep, #126052) 12%, transparent) !important;
        }
        .landing-page.wellness-page .wellness-layout--wellness-form-row > div:only-child { grid-column: 1 / -1 !important; width: min(100%, 760px) !important; max-width: 760px !important; margin: 0 auto !important; }
        .landing-page.wellness-page .wellness-layout--wellness-form-row #lead-form { margin: 0 !important; padding: 0 !important; max-width: none !important; background: transparent !important; border: 0 !important; box-shadow: none !important; }
        .landing-page.wellness-page .wellness-layout--wellness-registration-row {
          display: grid !important;
          grid-template-columns: minmax(320px, 0.78fr) minmax(0, 1.22fr) !important;
          align-items: start !important;
          gap: clamp(40px, 7vw, 120px) !important;
          padding: clamp(72px, 9vw, 132px) clamp(24px, 8vw, 144px) !important;
          background: var(--wellness-surface-soft, #e8f4ee) !important;
        }
        .landing-page.wellness-page .wellness-layout--wellness-registration-row > div { min-width: 0 !important; }
        .landing-page.wellness-page .wellness-layout--wellness-registration-row > div:first-child {
          padding: clamp(24px, 3vw, 46px) !important;
          background: var(--wellness-surface, #fff) !important;
          border: 1px solid var(--wellness-border, #cfe3d9) !important;
          border-radius: 28px !important;
          box-shadow: 0 22px 60px color-mix(in srgb, var(--wellness-primary-deep, #126052) 12%, transparent) !important;
        }
        .landing-page.wellness-page .wellness-layout--wellness-registration-row > div:only-child { grid-column: 1 / -1 !important; width: min(100%, 760px) !important; max-width: 760px !important; margin: 0 auto !important; }
        .landing-page.wellness-page .wellness-layout--wellness-registration-row #lead-form { margin: 0 !important; padding: 0 !important; max-width: none !important; background: transparent !important; border: 0 !important; box-shadow: none !important; }
        .landing-page.wellness-page .wellness-layout--wellness-form-row .wellness-layout--wellness-step-grid { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; margin-top: 28px !important; }
        .landing-page.wellness-page .wellness-layout--wellness-form-row .wellness-layout--wellness-step-grid > div { min-height: 0 !important; padding: 22px !important; }
        .landing-page.wellness-page .wellness-layout--wellness-footer-row {
          display: grid !important;
          grid-template-columns: 1fr 1fr !important;
          align-items: end !important;
          gap: 40px !important;
          padding: 42px clamp(24px, 8vw, 144px) !important;
          background: var(--wellness-ink, #173b35) !important;
          color: var(--wellness-inverse, #fff) !important;
        }
         .landing-page.wellness-page .wellness-layout--wellness-footer-row > div:last-child { text-align: right !important; }
         .landing-page.wellness-page .landing-text--wellness-badge { display: grid !important; place-items: center !important; width: 48px !important; height: 48px !important; margin: 0 0 18px !important; padding: 0 !important; border-radius: 50% !important; background: var(--wellness-accent-soft, #e2f2e5) !important; color: var(--wellness-primary-deep, #126052) !important; font-size: 1.35rem !important; line-height: 1 !important; }
         .landing-page.wellness-page .landing-text--wellness-badge .wellness-icon { width: 20px !important; height: 20px !important; }
         .landing-page.wellness-page .landing-text--wellness-logo-mark { display: inline-grid !important; place-items: center !important; width: 32px !important; height: 32px !important; margin: 0 !important; padding: 0 !important; line-height: 1 !important; }
         .landing-page.wellness-page .landing-text--wellness-logo-mark .wellness-icon { width: 26px !important; height: 26px !important; }
         .landing-page.wellness-page .wellness-layout--wellness-details-strip .landing-text--wellness-detail-label { display: flex !important; align-items: center !important; justify-content: center !important; }
         .landing-page.wellness-page .wellness-detail-label-content { display: inline-flex !important; align-items: center !important; gap: 10px !important; }
         .landing-page.wellness-page .wellness-detail-icon { display: inline-grid !important; place-items: center !important; width: 36px !important; height: 36px !important; flex: 0 0 36px !important; border-radius: 50% !important; background: var(--wellness-accent-soft, #e2f2e5) !important; color: var(--wellness-primary-deep, #126052) !important; }
         .landing-page.wellness-page .wellness-detail-icon .wellness-icon { width: 18px !important; height: 18px !important; }
         .landing-page.wellness-page .wellness-layout a[href="#lead-form"] { border-radius: 999px !important; font-weight: 800 !important; letter-spacing: .06em !important; text-transform: uppercase !important; }

         /* Keep every wellness block on the same palette contract, including
            generated pages whose saved blocks contain older inline colors. */
         .landing-page.wellness-page .wellness-layout--wellness-header-row {
           min-height: 96px !important;
           padding: 24px clamp(24px, 6vw, 104px) !important;
           background: var(--wellness-surface, #fffdf8) !important;
           border-bottom: 1px solid var(--wellness-border, #d7e2d0) !important;
           box-shadow: 0 8px 24px color-mix(in srgb, var(--wellness-primary-deep, #194a37) 8%, transparent) !important;
         }
         .landing-page.wellness-page .wellness-layout--wellness-header-row > div:first-child { flex: 1 1 auto !important; width: auto !important; min-width: 0 !important; }
         .landing-page.wellness-page .wellness-layout--wellness-header-row > div:last-child { flex: 0 0 auto !important; width: auto !important; min-width: 0 !important; }
         .landing-page.wellness-page .wellness-layout--wellness-header-row .landing-heading--wellness-logo { font-size: clamp(1rem, 1.5vw, 1.25rem) !important; line-height: 1.25 !important; white-space: normal !important; overflow-wrap: anywhere !important; }
         .landing-page.wellness-page .wellness-layout--wellness-header-row .landing-heading--wellness-logo,
         .landing-page.wellness-page .wellness-layout--wellness-header-row .landing-text--wellness-logo-mark { color: var(--wellness-primary-deep, #194a37) !important; }
         .landing-page.wellness-page .wellness-layout--wellness-header-row .landing-text--wellness-nav { color: var(--wellness-muted, #63766b) !important; display: block !important; font-size: .82rem !important; line-height: 1.4 !important; letter-spacing: .12em !important; word-spacing: .75rem !important; white-space: nowrap !important; }
         .landing-page.wellness-page .wellness-layout--wellness-header-row .wellness-nav { display:flex !important; align-items:center !important; justify-content:flex-end !important; flex-wrap:nowrap !important; gap:clamp(16px,2.2vw,32px) !important; word-spacing:normal !important; }
         .landing-page.wellness-page .wellness-layout--wellness-header-row .wellness-nav a,
         .landing-page.wellness-page .wellness-layout--wellness-header-row .wellness-nav span { color:inherit !important; text-decoration:none !important; font-weight:700 !important; }
         .landing-page.wellness-page .wellness-layout--wellness-header-row .wellness-nav a:hover,
         .landing-page.wellness-page .wellness-layout--wellness-header-row .wellness-nav a:focus-visible { color:var(--wellness-primary,#2f6b50) !important; text-decoration:none !important; }
         .landing-page.wellness-page [id^="wellness-"] { scroll-margin-top:24px; }
         .landing-page.wellness-page .wellness-layout--wellness-hero-row {
           min-height: min(720px, calc(100vh - 96px)) !important;
           padding: clamp(64px, 7vw, 112px) clamp(24px, 8vw, 144px) !important;
         }
         .landing-page.wellness-page .wellness-layout--wellness-hero-row .landing-heading--wellness-display { color: var(--wellness-ink, #173b2c) !important; }
         .landing-page.wellness-page .wellness-layout--wellness-hero-row .landing-heading--wellness-hero-accent { color: var(--wellness-primary, #2f6b50) !important; }
         .landing-page.wellness-page .wellness-layout--wellness-hero-row .landing-text--wellness-body,
         .landing-page.wellness-page .wellness-layout--wellness-hero-row .landing-text--wellness-note { color: var(--wellness-muted, #63766b) !important; }

         .landing-page.wellness-page .wellness-layout--wellness-details-strip {
           position: relative !important;
           z-index: 2 !important;
           width: min(calc(100% - clamp(48px, 8vw, 240px)), 1816px) !important;
           margin: 0 auto 24px !important;
           padding: 0 !important;
           overflow: visible !important;
           display: grid !important;
           grid-template-columns: repeat(4, minmax(0, 1fr)) !important;
           gap: 0 !important;
           background: var(--wellness-surface, #fffdf8) !important;
           border: 1px solid var(--wellness-border, #d7e2d0) !important;
           border-radius: 18px !important;
           box-shadow: 0 18px 42px color-mix(in srgb, var(--wellness-primary-deep, #194a37) 12%, transparent) !important;
           align-items: stretch !important;
         }
         .landing-page.wellness-page .wellness-layout--wellness-details-strip > div {
           display: grid !important;
           grid-template-columns: 80px minmax(0, 1fr) !important;
           grid-template-rows: auto auto !important;
           column-gap: 18px !important;
           row-gap: 6px !important;
           min-height: 154px !important;
           padding: 30px 34px !important;
           background: transparent !important;
           border: 0 !important;
           border-radius: 0 !important;
           box-shadow: none !important;
           align-items: center !important;
           position: relative !important;
         }
         .landing-page.wellness-page .wellness-layout--wellness-details-strip > div:not(:last-child)::after { content: ''; position: absolute; top: 30px; right: 0; bottom: 30px; width: 1px; background: var(--wellness-border, #d7e2d0); }
         .landing-page.wellness-page .wellness-layout--wellness-details-strip > div > div { display: contents !important; }
         .landing-page.wellness-page .wellness-layout--wellness-details-strip .landing-text--wellness-detail-label { display: contents !important; color: var(--wellness-primary, #2f6b50) !important; font-weight: 800 !important; }
         .landing-page.wellness-page .wellness-layout--wellness-details-strip .wellness-detail-label-content { display: contents !important; }
         .landing-page.wellness-page .wellness-layout--wellness-details-strip .wellness-detail-icon { display: inline-grid !important; grid-column: 1; grid-row: 1 / span 2; align-self: center; justify-self: start; width: 80px !important; height: 80px !important; flex: 0 0 80px !important; background: var(--wellness-accent-soft, #e2f2e5) !important; color: var(--wellness-primary-deep, #126052) !important; }
         .landing-page.wellness-page .wellness-layout--wellness-details-strip .wellness-detail-icon .wellness-icon { width: 38px !important; height: 38px !important; }
         .landing-page.wellness-page .wellness-layout--wellness-details-strip .wellness-detail-label-content > span:last-child { grid-column: 2; grid-row: 1; min-width: 0; margin: 0; color: var(--wellness-primary, #2f6b50); font-size: .78rem; line-height: 1.2; font-weight: 800; letter-spacing: .08em; text-align: left !important; text-transform: uppercase; white-space: nowrap; justify-self: start; }
         .landing-page.wellness-page .wellness-layout--wellness-details-strip .landing-heading--wellness-detail-value { grid-column: 2; grid-row: 2; min-width: 0; margin: 0 !important; color: var(--wellness-ink, #173b2c) !important; font-size: clamp(1rem, 1.1vw, 1.35rem) !important; line-height: 1.3 !important; text-align: left !important; overflow-wrap: anywhere; justify-self: start; }
         .landing-page.wellness-page .wellness-layout--wellness-details-strip > div:not(:has(.wellness-detail-icon)) { grid-template-columns: minmax(0, 1fr) !important; }
         .landing-page.wellness-page .wellness-layout--wellness-details-strip > div:not(:has(.wellness-detail-icon)) .landing-text--wellness-detail-label { display: block !important; grid-column: 1; grid-row: 1; margin: 0 !important; text-align: left !important; }
         .landing-page.wellness-page .wellness-layout--wellness-details-strip > div:not(:has(.wellness-detail-icon)) .landing-heading--wellness-detail-value { grid-column: 1; grid-row: 2; }

         .landing-page.wellness-page .wellness-layout--wellness-benefits-row { background: linear-gradient(180deg, var(--wellness-surface-soft, #e8f1e5), var(--wellness-bg, #f7fbf4)) !important; border-top: 1px solid var(--wellness-border, #d7e2d0) !important; border-bottom: 1px solid var(--wellness-border, #d7e2d0) !important; }
         .landing-page.wellness-page .wellness-layout--wellness-process-row { background: var(--wellness-surface, #fffdf8) !important; }
         .landing-page.wellness-page .wellness-layout--wellness-gallery-row { background: linear-gradient(135deg, color-mix(in srgb, var(--wellness-surface, #fffdf8) 92%, var(--wellness-accent-soft, #fff1d8)), var(--wellness-surface, #fffdf8)) !important; border-bottom: 1px solid var(--wellness-border, #d7e2d0) !important; }
         .landing-page.wellness-page .wellness-layout--wellness-benefits-row { background: linear-gradient(180deg, color-mix(in srgb, var(--wellness-surface-soft, #e8f1e5) 82%, var(--wellness-primary, #2f6b50)), var(--wellness-bg, #f7fbf4)) !important; }
         .landing-page.wellness-page .wellness-layout--wellness-benefits-row,
         .landing-page.wellness-page .wellness-layout--wellness-process-row { align-items: stretch !important; }
         .landing-page.wellness-page .wellness-layout--wellness-benefits-row > div,
         .landing-page.wellness-page .wellness-layout--wellness-process-row > div { align-self: stretch !important; min-width: 0 !important; }
         .landing-page.wellness-page .wellness-layout--wellness-benefits-row > div:first-child,
         .landing-page.wellness-page .wellness-layout--wellness-process-row > div:first-child { padding-top: 0 !important; }
         .landing-page.wellness-page .wellness-layout--wellness-benefits-row > div:last-child,
         .landing-page.wellness-page .wellness-layout--wellness-process-row > div:last-child { padding-top: 0 !important; }
         .landing-page.wellness-page .wellness-layout--wellness-benefits-row > div:last-child > .wellness-layout--wellness-benefit-grid,
         .landing-page.wellness-page .wellness-layout--wellness-process-row > div:last-child > .wellness-layout--wellness-step-grid { margin-top: 0 !important; }
         .landing-page.wellness-page .wellness-layout--wellness-benefit-grid > div,
         .landing-page.wellness-page .wellness-layout--wellness-step-grid > div {
           background: var(--wellness-surface, #fffdf8) !important;
           border: 1px solid var(--wellness-border, #d7e2d0) !important;
           box-shadow: 0 12px 28px color-mix(in srgb, var(--wellness-primary-deep, #194a37) 8%, transparent) !important;
         }
         .landing-page.wellness-page .wellness-layout--wellness-benefit-grid,
         .landing-page.wellness-page .wellness-layout--wellness-step-grid { background: transparent !important; border: 0 !important; border-radius: 0 !important; box-shadow: none !important; }
         .landing-page.wellness-page .landing-heading--wellness-section-title,
         .landing-page.wellness-page .landing-heading--wellness-card-title { color: var(--wellness-ink, #173b2c) !important; }
         .landing-page.wellness-page .landing-text--wellness-body,
         .landing-page.wellness-page .landing-text--wellness-note,
         .landing-page.wellness-page .landing-text--wellness-card-body,
         .landing-page.wellness-page .landing-text--wellness-bullet-list { color: var(--wellness-muted, #63766b) !important; }
         .landing-page.wellness-page .landing-text--wellness-eyebrow,
         .landing-page.wellness-page .landing-text--wellness-badge,
         .landing-page.wellness-page .landing-heading--wellness-hero-accent { color: var(--wellness-primary, #2f6b50) !important; }
         .landing-page.wellness-page a[href="#lead-form"] {
           background: linear-gradient(135deg, var(--wellness-primary, #2f6b50), var(--wellness-primary-deep, #194a37)) !important;
           color: var(--wellness-inverse, #fff) !important;
           border: 0 !important;
         }

         .landing-page.wellness-page .wellness-layout--wellness-registration-row,
         .landing-page.wellness-page .wellness-layout--wellness-form-row { background: var(--wellness-surface-soft, #e8f1e5) !important; }
         .landing-page.wellness-page .wellness-layout--wellness-registration-row > div:first-child,
         .landing-page.wellness-page .wellness-layout--wellness-form-row > div:first-child { background: var(--wellness-surface, #fffdf8) !important; border-color: var(--wellness-border, #d7e2d0) !important; }
         .landing-page.wellness-page .wellness-layout--wellness-registration-row .wellness-layout--wellness-step-grid > div,
         .landing-page.wellness-page .wellness-layout--wellness-form-row .wellness-layout--wellness-step-grid > div { background: var(--wellness-surface, #fffdf8) !important; }
         .landing-page.wellness-page .wellness-layout--wellness-registration-row .wellness-layout--wellness-step-grid,
         .landing-page.wellness-page .wellness-layout--wellness-form-row .wellness-layout--wellness-step-grid { display: grid !important; grid-template-columns: repeat(2, minmax(0, 1fr)) !important; gap: 16px !important; width: 100% !important; margin-top: 24px !important; }
         .landing-page.wellness-page .wellness-layout--wellness-registration-row .wellness-layout--wellness-step-grid > div,
         .landing-page.wellness-page .wellness-layout--wellness-form-row .wellness-layout--wellness-step-grid > div { min-width: 0 !important; min-height: 170px !important; padding: 24px !important; }
         .landing-page.wellness-page .wellness-layout--wellness-registration-row .landing-heading--wellness-section-title,
         .landing-page.wellness-page .wellness-layout--wellness-form-row .landing-heading--wellness-section-title { color: var(--wellness-ink, #173b2c) !important; }

         .landing-page.wellness-page .wellness-layout--wellness-footer-row {
           grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) !important;
           min-height: 180px !important;
           padding: 42px clamp(24px, 8vw, 144px) !important;
           background: var(--wellness-primary-deep, #194a37) !important;
           color: var(--wellness-inverse, #fff) !important;
         }
         .landing-page.wellness-page .wellness-layout--wellness-footer-row .landing-heading,
         .landing-page.wellness-page .wellness-layout--wellness-footer-row .landing-text { color: var(--wellness-inverse, #fff) !important; }
         .landing-page.wellness-page .wellness-layout--wellness-footer-row .landing-text--wellness-footer-links { color: color-mix(in srgb, var(--wellness-inverse, #fff) 82%, transparent) !important; }
         .landing-page.wellness-page .wellness-layout--wellness-footer-row .landing-text--wellness-footer-contact { color: color-mix(in srgb, var(--wellness-inverse, #fff) 92%, transparent) !important; white-space: pre-line !important; }
         .landing-page.wellness-page .wellness-layout--wellness-footer-row .landing-text--wellness-footer-copy { color: color-mix(in srgb, var(--wellness-inverse, #fff) 68%, transparent) !important; }
         .landing-page.wellness-page .wellness-layout--wellness-footer-row > div { min-width: 0 !important; }
         .landing-page.wellness-page .wellness-layout--wellness-footer-row > div:first-child { display: flex !important; flex-direction: column !important; gap: 8px !important; align-items: flex-start !important; }
         .landing-page.wellness-page .wellness-layout--wellness-footer-row > div:last-child { display: flex !important; flex-direction: column !important; gap: 8px !important; align-items: flex-end !important; }
         .landing-page.wellness-page .wellness-layout--wellness-cta-row > div { min-width: 0 !important; }
         .landing-page.wellness-page .wellness-layout--wellness-cta-row > div:last-child { display: flex !important; flex-direction: column !important; align-items: flex-start !important; justify-content: center !important; gap: 10px !important; width: 100% !important; max-width: 680px !important; justify-self: stretch !important; padding: clamp(20px, 4vw, 48px) 0 !important; background: transparent !important; border: 0 !important; border-radius: 0 !important; box-shadow: none !important; }
         .landing-page.wellness-page .wellness-layout--wellness-cta-row .landing-heading,
         .landing-page.wellness-page .wellness-layout--wellness-cta-row .landing-text { max-width: 620px !important; }
         .landing-page.wellness-page .wellness-layout--wellness-cta-row {
           grid-template-columns: minmax(0, 1.04fr) minmax(0, 0.96fr) !important;
           gap: clamp(38px, 6vw, 96px) !important;
           padding: clamp(64px, 8vw, 112px) clamp(24px, 8vw, 144px) !important;
           background: linear-gradient(135deg, var(--wellness-surface, #fffdf8), var(--wellness-surface-soft, #e8f1e5)) !important;
         }
         .landing-page.wellness-page .wellness-layout--wellness-cta-row > div:first-child { min-height: 360px !important; align-self: stretch !important; }
         .landing-page.wellness-page .wellness-layout--wellness-cta-row .wellness-media--cta {
           width: 100% !important;
           height: min(430px, 34vw) !important;
           min-height: 360px !important;
           border-radius: 30px 12px 30px 12px !important;
           border: 1px solid var(--wellness-border, #d7e2d0) !important;
           box-shadow: 0 24px 56px color-mix(in srgb, var(--wellness-primary-deep, #194a37) 16%, transparent) !important;
         }
         .landing-page.wellness-page .wellness-layout--wellness-cta-row > div:last-child { max-width: 620px !important; gap: 16px !important; padding: 18px 0 !important; }
         .landing-page.wellness-page .wellness-layout--wellness-cta-row .landing-heading--wellness-section-title {
           margin: 0 0 4px !important;
           color: var(--wellness-ink, #173b2c) !important;
           font-size: clamp(1.85rem, 3vw, 2.75rem) !important;
           line-height: 1.08 !important;
         }
         .landing-page.wellness-page .wellness-layout--wellness-cta-row .landing-text--wellness-body {
           max-width: 560px !important;
           margin: 0 !important;
           color: var(--wellness-muted, #63766b) !important;
           font-size: 1rem !important;
           line-height: 1.65 !important;
         }
         .landing-page.wellness-page .wellness-layout--wellness-cta-row .landing-text--wellness-note {
           max-width: 560px !important;
           margin: 2px 0 6px !important;
           padding: 12px 16px !important;
           color: var(--wellness-primary-deep, #194a37) !important;
           background: color-mix(in srgb, var(--wellness-accent-soft, #fff1d8) 62%, transparent) !important;
           border-left: 3px solid var(--wellness-accent, #ef9b59) !important;
           border-radius: 0 12px 12px 0 !important;
           font-size: .88rem !important;
           line-height: 1.5 !important;
         }
         .landing-page.wellness-page .wellness-layout--wellness-cta-row a[href="#lead-form"] {
           display: inline-flex !important;
           align-items: center !important;
           justify-content: center !important;
           width: auto !important;
           min-height: 44px !important;
           margin: 2px 0 0 !important;
           padding: 12px 24px !important;
           font-size: .78rem !important;
           line-height: 1 !important;
           letter-spacing: .1em !important;
           box-shadow: 0 12px 24px color-mix(in srgb, var(--wellness-primary-deep, #194a37) 18%, transparent) !important;
         }
         .landing-page.wellness-page .wellness-media:not(:has(img)) { background: linear-gradient(135deg, var(--wellness-surface-soft, #e8f1e5), var(--wellness-accent-soft, #fff1d8)) !important; }
         .landing-page.wellness-page .wellness-media-placeholder { width: 100% !important; height: 100% !important; min-height: inherit !important; box-sizing: border-box !important; color: var(--wellness-primary-deep, #194a37) !important; background: linear-gradient(135deg, var(--wellness-surface-soft, #e8f1e5), var(--wellness-accent-soft, #fff1d8)) !important; }

         /* Alternate wellness compositions selected during campaign generation. */
        .landing-page.wellness-page .wellness-campaign--clinical .wellness-layout--wellness-hero-row {
          grid-template-columns: minmax(0, 0.76fr) minmax(360px, 1.24fr) !important;
          background: var(--wellness-surface, #fff) !important;
        }
        .landing-page.wellness-page .wellness-campaign--clinical .wellness-layout--wellness-hero-row > div:first-child { order: 2; }
        .landing-page.wellness-page .wellness-campaign--clinical .wellness-layout--wellness-hero-row > div:last-child { order: 1; }
        .landing-page.wellness-page .wellness-campaign--clinical .wellness-media--hero { height: min(560px, 42vw) !important; min-height: 380px !important; border-radius: 20px !important; box-shadow: 0 18px 44px color-mix(in srgb, var(--wellness-primary-deep, #126052) 14%, transparent) !important; }
        .landing-page.wellness-page .wellness-campaign--clinical .wellness-layout--wellness-benefit-grid { grid-template-columns: repeat(4, minmax(0, 1fr)) !important; }
        .landing-page.wellness-page .wellness-campaign--clinical .wellness-layout--wellness-benefit-grid > div { min-height: 240px !important; }
        .landing-page.wellness-page .wellness-campaign--clinical .wellness-layout--wellness-impact-band { background: var(--wellness-primary-deep, #126052) !important; }

        .landing-page.wellness-page .wellness-campaign--immersive .wellness-layout--wellness-hero-row {
          position: relative !important;
          display: block !important;
          min-height: min(820px, calc(100vh - 92px)) !important;
          padding: clamp(110px, 14vw, 210px) clamp(24px, 9vw, 160px) !important;
          background: var(--wellness-primary-deep, #126052) !important;
        }
        .landing-page.wellness-page .wellness-campaign--immersive .wellness-layout--wellness-hero-row::before { content: ''; position: absolute; inset: 0; z-index: 1; pointer-events: none; background: linear-gradient(90deg, color-mix(in srgb, var(--wellness-primary-deep, #126052) 96%, transparent) 0%, color-mix(in srgb, var(--wellness-primary-deep, #126052) 62%, transparent) 58%, transparent 100%); }
        .landing-page.wellness-page .wellness-campaign--immersive .wellness-layout--wellness-hero-row > div:first-child { position: relative; z-index: 2; max-width: 720px !important; }
        .landing-page.wellness-page .wellness-campaign--immersive .wellness-layout--wellness-hero-row > div:last-child { position: absolute; inset: 0; z-index: 0; }
        .landing-page.wellness-page .wellness-campaign--immersive .wellness-media--hero { width: 100% !important; height: 100% !important; min-height: 100% !important; border: 0 !important; border-radius: 0 !important; box-shadow: none !important; }
        .landing-page.wellness-page .wellness-campaign--immersive .wellness-layout--wellness-hero-row h1,
        .landing-page.wellness-page .wellness-campaign--immersive .wellness-layout--wellness-hero-row p { color: #fff !important; }
        .landing-page.wellness-page .wellness-campaign--immersive .wellness-layout--wellness-hero-row .wellness-media-placeholder { background: linear-gradient(135deg, var(--wellness-primary-deep, #126052), var(--wellness-primary, #1f8a70)); }
        .landing-page.wellness-page .wellness-campaign--immersive .wellness-layout--wellness-gallery-row { background: var(--wellness-surface, #fff) !important; }

        .landing-page.wellness-page .wellness-campaign--community .wellness-layout--wellness-hero-row { background: linear-gradient(120deg, var(--wellness-surface-soft, #e8f4ee), var(--wellness-bg, #f4fbf7)) !important; }
        .landing-page.wellness-page .wellness-campaign--community .wellness-layout--wellness-hero-row > div:first-child { order: 2; }
        .landing-page.wellness-page .wellness-campaign--community .wellness-layout--wellness-hero-row > div:last-child { order: 1; }
        .landing-page.wellness-page .wellness-campaign--community .wellness-media--hero { border-radius: 50% 50% 24px 24px !important; transform: none !important; }
        .landing-page.wellness-page .wellness-campaign--community .wellness-layout--wellness-benefits-row { background: var(--wellness-surface-soft, #e8f4ee) !important; }
        .landing-page.wellness-page .wellness-campaign--community .wellness-layout--wellness-benefit-grid > div { background: var(--wellness-surface, #fff) !important; border-radius: 28px !important; }


        .landing-page .wellness-form-control,
        .landing-page .wellness-form-control:disabled,
        .landing-page .wellness-form-control:-webkit-autofill,
        .landing-page .wellness-form-control:-webkit-autofill:hover,
        .landing-page .wellness-form-control:-webkit-autofill:focus {
          background: #fffdf7 !important;
          background-color: #fffdf7 !important;
          background-image: none !important;
          color: #1f2937 !important;
          -webkit-text-fill-color: #1f2937 !important;
          opacity: 1 !important;
          color-scheme: light !important;
          box-shadow: inset 0 0 0 9999px #fffdf7 !important;
        }

        .landing-page .wellness-form-control::placeholder {
          color: #7b807a !important;
          opacity: 1 !important;
        }

        .landing-page .landing-page-content {
          max-width: 1160px;
          margin: 0 auto;
          padding: 48px 20px 72px;
          display: grid;
          gap: 28px;
        }

        @media (max-width: 760px) {
          .landing-page .landing-page-content.wellness-content { padding: 0 !important; gap: 0; }
          .landing-page.wellness-page .wellness-shell > div > div { flex: 1 1 100% !important; min-width: 0 !important; }
          .landing-page.wellness-page .wellness-media--hero { min-height: 320px; }
          .landing-page.wellness-page .wellness-media--gallery { min-height: 180px; }
          .landing-page.wellness-page .wellness-layout--wellness-header-row,
          .landing-page.wellness-page .wellness-layout--wellness-hero-row,
          .landing-page.wellness-page .wellness-layout--wellness-benefits-row,
          .landing-page.wellness-page .wellness-layout--wellness-process-row,
          .landing-page.wellness-page .wellness-layout--wellness-impact-band,
          .landing-page.wellness-page .wellness-layout--wellness-form-row,
          .landing-page.wellness-page .wellness-layout--wellness-registration-row { grid-template-columns: 1fr !important; }
          .landing-page.wellness-page .wellness-layout--wellness-header-row > div:first-child,
          .landing-page.wellness-page .wellness-layout--wellness-header-row > div:last-child { justify-content: flex-start !important; flex-wrap: wrap !important; row-gap: 14px !important; }
          .landing-page.wellness-page .wellness-layout--wellness-header-row > div:last-child { justify-content: flex-start !important; flex-wrap: wrap !important; }
          .landing-page.wellness-page .wellness-layout--wellness-header-row .wellness-nav { justify-content: flex-start !important; flex-wrap: wrap !important; gap: 12px 18px !important; white-space: normal !important; }
          .landing-page.wellness-page .wellness-layout--wellness-details-strip { grid-template-columns: 1fr !important; }
          .landing-page.wellness-page .wellness-layout--wellness-details-strip > div { min-height: 104px !important; padding: 20px 22px !important; }
          .landing-page.wellness-page .wellness-layout--wellness-details-strip > div:not(:last-child)::after { top: auto; right: 22px; bottom: 0; left: 22px; width: auto; height: 1px; }
          .landing-page.wellness-page .wellness-layout--wellness-details-strip .wellness-detail-icon { width: 56px !important; height: 56px !important; flex-basis: 56px !important; }
          .landing-page.wellness-page .wellness-layout--wellness-details-strip .wellness-detail-icon .wellness-icon { width: 28px !important; height: 28px !important; }
          .landing-page.wellness-page .wellness-layout--wellness-gallery-row { grid-template-columns: 1fr !important; }
          .landing-page.wellness-page .wellness-layout--wellness-gallery-row > div:first-child .wellness-media--gallery,
          .landing-page.wellness-page .wellness-layout--wellness-gallery-row .wellness-media--gallery { height: 260px !important; min-height: 220px !important; }
          .landing-page.wellness-page .wellness-layout--wellness-benefit-grid,
          .landing-page.wellness-page .wellness-layout--wellness-step-grid,
        .landing-page.wellness-page .wellness-layout--wellness-metric-grid { grid-template-columns: 1fr !important; }
          .landing-page.wellness-page .wellness-layout--wellness-cta-row,
          .landing-page.wellness-page .wellness-layout--wellness-footer-row { display: grid !important; grid-template-columns: 1fr !important; }
          .landing-page.wellness-page .wellness-layout--wellness-cta-row > div:first-child { min-height: 220px !important; }
          .landing-page.wellness-page .wellness-media--cta { height: 260px !important; min-height: 220px !important; border-radius: 24px 10px 24px 10px !important; }
          .landing-page.wellness-page .wellness-layout--wellness-cta-row > div:last-child { gap: 14px !important; padding: 8px 0 0 !important; }
          .landing-page.wellness-page .wellness-layout--wellness-cta-row .landing-heading--wellness-section-title { font-size: 2rem !important; }
          .landing-page.wellness-page .wellness-layout--wellness-cta-row a[href="#lead-form"] { padding: 11px 20px !important; }
          .landing-page.wellness-page .wellness-layout--wellness-registration-row > div:only-child { width: 100% !important; max-width: 760px !important; }
          .landing-page.wellness-page .wellness-layout--wellness-footer-row > div:last-child { text-align: left !important; }
        }

        .landing-page section {
          margin: 0;
          padding: 0;
        }

        .landing-page h1,
        .landing-page h2,
        .landing-page h3,
        .landing-page h4 {
          margin: 0 0 16px 0;
          font-family: Georgia, 'Times New Roman', serif;
          font-weight: 600;
          letter-spacing: -0.02em;
          color: #1f2937;
        }

        .landing-page a {
          color: #8a6428;
          text-decoration: none;
        }

        .landing-page a:hover {
          text-decoration: underline;
        }

        /* Travel page styling */
        .trips-page {
          max-width: 1400px;
          margin: 0 auto;
        }

        .t-wrap {
          max-width: 1200px;
          margin: 0 auto;
          padding: 0 20px;
        }

        .t-section {
          margin: 0;
          padding: 40px 20px;
        }

        .t-center {
          text-align: center;
        }

        .t-muted {
          color: #666;
        }

        .t-tag {
          display: inline-block;
          padding: 4px 10px;
          background: #f0f0f0;
          border-radius: 4px;
          font-size: 12px;
          fontWeight: 600;
          color: #666;
        }
      `}</style>

      <div className={`landing-page-content${isWellnessLandingPage ? ' wellness-content' : ''}`} style={wellnessVars}>
        {blocks.map((block, idx) => (
          <React.Fragment key={idx}>
            {renderBlockWithContext(block)}
          </React.Fragment>
        ))}
      </div>
    </main>
  );
}
