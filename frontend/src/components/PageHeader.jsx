import React from 'react';

/**
 * Shared page-header hero panel for wellness list/index pages.
 *
 * Renders a glass-panel container with:
 *   - left: optional teal icon chip + title + optional count pill / description
 *   - right: action area (children)
 *
 * Replaces the bare "floating h1 + sibling <p>" pattern that 20+ wellness
 * list pages copy-pasted. Centralising the markup here means future
 * header polish (typography, spacing, icon-chip palette under a third
 * vertical) touches one file instead of twenty.
 *
 * Pages that need NO icon (personal greetings, breadcrumb-led detail
 * pages) keep their bespoke header — this primitive is for the index /
 * list / catalog surface only.
 *
 * Props:
 *   icon         — lucide-react component (optional). Renders as a 48px
 *                  teal-chip on the left of the title. Omit for pages
 *                  where the icon would be redundant or out of place.
 *   title        — string OR node (so callers can interpolate names,
 *                  greetings, etc.)
 *   description  — string OR node. Rendered as a muted subtitle to the
 *                  right of the count pill (or alone when no count).
 *   count        — number (optional). Renders as a teal-tinted pill
 *                  before the description.
 *   inlineBadge  — node (optional). Renders inside the h1 next to the
 *                  title — used for permission badges like "View only".
 *   children     — right-side actions (buttons, dropdowns, toolbars).
 */
const PageHeader = ({
  icon: Icon,
  title,
  description,
  count,
  inlineBadge,
  children,
}) => {
  const hasCount = typeof count === 'number' && Number.isFinite(count);
  const hasSubtitle = hasCount || description != null;

  return (
    <header
      className="glass"
      style={{
        marginBottom: '1.5rem',
        padding: '1.25rem 1.5rem',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: '1.25rem',
        flexWrap: 'wrap',
        // `.glass` applies backdrop-filter which creates a new stacking
        // context. Without an explicit z-index here, popovers / dropdowns
        // / modals rendered as header children (Export menu, Import panel,
        // Add menu) are trapped inside that stacking context at z-index
        // auto and the search-bar row that follows in DOM order paints
        // over them in the overlap zone, intercepting clicks. (#1120)
        position: 'relative',
        zIndex: 5,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', minWidth: 0 }}>
        {Icon && (
          <div
            aria-hidden="true"
            style={{
              width: 48,
              height: 48,
              borderRadius: 14,
              background: 'var(--primary-color, var(--accent-color))',
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              boxShadow: '0 6px 16px rgba(38, 88, 85, 0.28)',
            }}
          >
            <Icon size={24} />
          </div>
        )}
        <div style={{ minWidth: 0 }}>
          <h1
            style={{
              fontFamily: 'var(--font-family)',
              fontSize: '1.5rem',
              fontWeight: 600,
              margin: 0,
              lineHeight: 1.2,
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              flexWrap: 'wrap',
            }}
          >
            <span>{title}</span>
            {inlineBadge}
          </h1>
          {hasSubtitle && (
            <div
              style={{
                marginTop: '0.4rem',
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                flexWrap: 'wrap',
              }}
            >
              {hasCount && (
                <>
                  <span
                    style={{
                      background: 'rgba(38, 88, 85, 0.14)',
                      color: 'var(--primary-color, var(--accent-color))',
                      padding: '2px 10px',
                      borderRadius: 999,
                      fontSize: '0.72rem',
                      fontWeight: 600,
                      letterSpacing: '0.02em',
                    }}
                  >
                    {count.toLocaleString()}
                  </span>
                  {/* Whitespace text node so textContent reads
                      "${count} ${description}" — flex gap is visual-only and
                      doesn't show up in DOM text aggregation, which a11y
                      tools and RTL `getByText` matchers rely on. */}
                  {description && ' '}
                </>
              )}
              {description && (
                <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                  {description}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
      {children && (
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
          {children}
        </div>
      )}
    </header>
  );
};

export default PageHeader;
