import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

/**
 * frontend/src/components/ui/Pagination.jsx
 *
 * Issue #694 — pagination controls mix infinite-scroll + page-numbers +
 * load-more across lists.
 *
 * Canonical pagination control. Renders:
 *   - "Showing 1–50 of 253" range label (left)
 *   - Prev / page-numbers / Next controls (right)
 *
 * Convention (issue #694 canonical pattern):
 *   - Page-numbers + jump-to-prev/next is the chosen pattern.
 *   - Infinite scroll is deprecated for new lists (back-button breaks).
 *   - "Load more" is deprecated (total-count + jump-to-page beats it for
 *     orientation on long lists).
 *
 * Usage:
 *   <Pagination
 *     page={page}
 *     pageSize={50}
 *     total={total}
 *     onChange={(p) => { setPage(p); navigate(`?page=${p}`); }}
 *   />
 *
 * Pages are 1-indexed (so the URL `?page=1` shows the first page). The
 * caller is responsible for URL-syncing — this component just emits the
 * new page number via `onChange`.
 */
export default function Pagination({
  page = 1,
  pageSize = 50,
  total = 0,
  onChange,
  maxNumbers = 7,
  style,
  className,
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  if (total === 0) return null;

  const handle = (p) => {
    if (p < 1 || p > totalPages || p === page) return;
    if (typeof onChange === 'function') onChange(p);
  };

  // Build the visible page-number window — always show first + last,
  // ellipses in the middle when totalPages > maxNumbers.
  const pageNumbers = buildPageWindow(page, totalPages, maxNumbers);

  return (
    <nav
      aria-label="Pagination"
      className={className}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '1rem',
        padding: '0.75rem 0',
        flexWrap: 'wrap',
        ...style,
      }}
    >
      <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
        Showing {from}–{to} of {total}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
        <button
          type="button"
          onClick={() => handle(page - 1)}
          disabled={page <= 1}
          aria-label="Previous page"
          style={pagBtnStyle({ disabled: page <= 1 })}
        >
          <ChevronLeft size={16} />
        </button>
        {pageNumbers.map((p, i) =>
          p === '…' ? (
            <span
              key={`ellipsis-${i}`}
              aria-hidden="true"
              style={{ padding: '0 0.25rem', color: 'var(--text-secondary)' }}
            >
              …
            </span>
          ) : (
            <button
              key={p}
              type="button"
              onClick={() => handle(p)}
              aria-current={p === page ? 'page' : undefined}
              aria-label={`Go to page ${p}`}
              style={pagBtnStyle({ active: p === page })}
            >
              {p}
            </button>
          )
        )}
        <button
          type="button"
          onClick={() => handle(page + 1)}
          disabled={page >= totalPages}
          aria-label="Next page"
          style={pagBtnStyle({ disabled: page >= totalPages })}
        >
          <ChevronRight size={16} />
        </button>
      </div>
    </nav>
  );
}

function buildPageWindow(current, total, max) {
  if (total <= max) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const pages = new Set([1, total, current, current - 1, current + 1]);
  // Pad until we're at `max - 2` slots (reserving 2 for ellipses) of real numbers.
  let i = 2;
  while (pages.size < max - 1 && i < total) {
    pages.add(i);
    i++;
  }
  const sorted = Array.from(pages)
    .filter((p) => p >= 1 && p <= total)
    .sort((a, b) => a - b);
  const out = [];
  for (let k = 0; k < sorted.length; k++) {
    if (k > 0 && sorted[k] !== sorted[k - 1] + 1) out.push('…');
    out.push(sorted[k]);
  }
  return out;
}

function pagBtnStyle({ active = false, disabled = false } = {}) {
  return {
    minWidth: 32,
    height: 32,
    padding: '0 0.5rem',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: active
      ? 'var(--primary-color, var(--accent-color, #3b82f6))'
      : 'transparent',
    color: active ? '#fff' : 'var(--text-primary)',
    border: `1px solid ${active ? 'transparent' : 'var(--border-color)'}`,
    borderRadius: 6,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.4 : 1,
    fontSize: '0.85rem',
    fontWeight: active ? 600 : 400,
  };
}
