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

/**
 * Render a single block based on its type.
 * @param {Object} block - { type, props }
 * @param {string} slug - Landing page slug for form submissions
 * @param {number} pageId - Landing page ID for API submissions
 * @param {Function} renderBlockFn - Recursive render function for nested blocks
 */
function renderBlock(block, slug, pageId, renderBlockFn, submitEndpoint = '') {
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
      return <DestinationHeroBlock key={block.id || Math.random()} props={props} slug={slug} />;
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

function cardFromComponents(components) {
  const title = components.find((child) => child.type === 'heading');
  const copy = components.find((child) => child.type === 'text');
  if (!title && !copy) return null;
  return { components: [title, copy].filter(Boolean) };
}

function extractWellnessCards(block) {
  if (!block || block.type !== 'columns') return [];
  const cards = [];
  (block.props?.columns || []).forEach((col) => {
    const components = col.components || [];
    const nested = components.find((child) => isCardishWellnessBlock(child));
    if (nested) cards.push(...extractWellnessCards(nested));
    const ownCard = cardFromComponents(components.filter((child) => !isCardishWellnessBlock(child)));
    if (ownCard) cards.push(ownCard);
  });
  return cards;
}

function normalizeWellnessCampaignBlocks(blocks) {
  const next = cloneBlocks(blocks);
  const page = next.find((block) => block?.type === 'columns' && block.props?.variant === 'wellness-campaign-page');
  if (!page) return next;
  const extractedCards = [];
  const pageColumns = page.props?.columns || [];
  page.props.columns = pageColumns.filter((col) => {
    const components = col.components || [];
    const isRegistrationHolder = components.some((child) => child?.type === 'columns' && child.props?.variant === 'wellness-registration-row');
    if (isRegistrationHolder) return true;
    const cardBlocks = components.filter(isCardishWellnessBlock);
    cardBlocks.forEach((block) => extractedCards.push(...extractWellnessCards(block)));
    return cardBlocks.length === 0;
  });

  const registration = (page.props.columns || [])
    .flatMap((col) => col.components || [])
    .find((child) => child?.type === 'columns' && child.props?.variant === 'wellness-registration-row');
  if (!registration) return next;

  const regColumns = registration.props.columns || [];
  const rightColumn = regColumns[1] || { components: [] };
  const rightComponents = rightColumn.components || [];
  const existingCardBlock = rightComponents.find(isCardishWellnessBlock);
  const existingCards = existingCardBlock ? extractWellnessCards(existingCardBlock) : [];
  const looseCard = cardFromComponents(rightComponents.filter((child) => !isCardishWellnessBlock(child)));
  const cards = [...(looseCard ? [looseCard] : []), ...existingCards, ...extractedCards]
    .filter((card, index, all) => {
      const title = card.components?.[0]?.props?.text || '';
      return title && all.findIndex((candidate) => candidate.components?.[0]?.props?.text === title) === index;
    })
    .slice(0, 3);

  if (cards.length) {
    registration.props.columns = [
      regColumns[0] || { components: [] },
      {
        components: [
          {
            id: 'wellness-benefit-cards',
            type: 'columns',
            props: { gap: '18px', variant: 'wellness-benefit-cards', columns: cards },
          },
        ],
      },
    ];
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

  // Track analytics (page view)
  React.useEffect(() => {
    if (slug) {
      new Image().src = `/api/pages/${slug}/track?event=VISIT`;
    }
  }, [slug]);

  const renderBlockWithContext = (block) => renderBlock(block, slug, pageId, renderBlockWithContext, submitEndpoint);

  return (
    <main className="landing-page block-renderer">
      <style>{`
        .landing-page {
          margin: 0;
          padding: 0;
          min-height: 100vh;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif;
          color: #243244;
          line-height: 1.6;
          background:
            radial-gradient(circle at top left, rgba(184, 137, 59, 0.08), transparent 34%),
            linear-gradient(180deg, #fbf8f1 0%, #f8f5ed 28%, #ffffff 100%);
        }


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

        .landing-page .landing-page-content.wellness-content {
          max-width: 1400px;
          padding: 48px 32px 80px;
          gap: 32px;
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

      <div className={`landing-page-content${isWellnessLandingPage ? ' wellness-content' : ''}`}>
        {blocks.map((block, idx) => (
          <React.Fragment key={idx}>
            {renderBlockWithContext(block)}
          </React.Fragment>
        ))}
      </div>
    </main>
  );
}
