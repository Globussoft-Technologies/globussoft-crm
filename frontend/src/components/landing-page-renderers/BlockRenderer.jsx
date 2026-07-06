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
function renderBlock(block, slug, pageId, renderBlockFn) {
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
      return <FormBlock key={block.id || Math.random()} props={props} slug={slug} pageId={pageId} />;
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
export default function BlockRenderer({ landingPage = {} }) {
  const blocks = Array.isArray(landingPage.content)
    ? landingPage.content
    : [];

  const slug = landingPage.slug || '';
  const pageId = landingPage.id || null;

  // Track analytics (page view)
  React.useEffect(() => {
    if (slug) {
      new Image().src = `/api/pages/${slug}/track?event=VISIT`;
    }
  }, [slug]);

  const renderBlockWithContext = (block) => renderBlock(block, slug, pageId, renderBlockWithContext);

  return (
    <main className="landing-page block-renderer">
      <style>{`
        .landing-page {
          margin: 0;
          padding: 0;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif;
          color: #333;
          line-height: 1.6;
        }

        .landing-page section {
          margin: 0;
          padding: 40px 20px;
        }

        .landing-page h1,
        .landing-page h2,
        .landing-page h3,
        .landing-page h4 {
          margin: 0 0 16px 0;
          font-weight: 600;
        }

        .landing-page a {
          color: #2563eb;
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

      <div className="landing-page-content">
        {blocks.map((block, idx) => (
          <React.Fragment key={idx}>
            {renderBlockWithContext(block)}
          </React.Fragment>
        ))}
      </div>
    </main>
  );
}
