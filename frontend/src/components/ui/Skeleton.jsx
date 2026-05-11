import React from 'react';

/**
 * frontend/src/components/ui/Skeleton.jsx
 *
 * Issue #689 — loading states mix spinners / skeletons / blank screens.
 *
 * Canonical skeleton placeholder. Use for table / card / list loading
 * states where the eventual content's SHAPE is known — the skeleton's
 * dimensions cue the user that "a row is coming here."
 *
 * Variants:
 *   - <Skeleton variant="text" />     — single 0.9rem-tall line.
 *   - <Skeleton variant="text" width="60%" /> — partial-width line (use
 *     in mixed-content blocks to convey heading vs body shape).
 *   - <Skeleton variant="block" height={120} /> — generic block (card,
 *     image placeholder).
 *   - <SkeletonRow columns={5} />     — single row of N table cells.
 *   - <SkeletonTable rows={5} cols={5} /> — full table-body skeleton.
 *
 * Pulses via CSS @keyframes pulse (shared with the index.css definition).
 */
export default function Skeleton({
  variant = 'text',
  width,
  height,
  style,
  className,
}) {
  const baseHeight =
    variant === 'text' ? '0.9rem' : variant === 'block' ? '6rem' : '0.9rem';
  return (
    <span
      aria-hidden="true"
      className={className}
      style={{
        display: 'block',
        width: width ?? '100%',
        height: height ?? baseHeight,
        borderRadius: variant === 'text' ? 4 : 8,
        background: 'var(--subtle-bg, rgba(255,255,255,0.06))',
        animation: 'skeleton-pulse 1.4s ease-in-out infinite',
        ...style,
      }}
    />
  );
}

export function SkeletonRow({ columns = 4, style }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        gap: '1rem',
        padding: '0.75rem 0',
        ...style,
      }}
    >
      {Array.from({ length: columns }).map((_, i) => (
        <Skeleton key={i} variant="text" width={i === 0 ? '80%' : '60%'} />
      ))}
    </div>
  );
}

export function SkeletonTable({ rows = 5, columns = 4 }) {
  return (
    <div role="status" aria-label="Loading" style={{ display: 'flex', flexDirection: 'column' }}>
      {Array.from({ length: rows }).map((_, i) => (
        <SkeletonRow key={i} columns={columns} />
      ))}
    </div>
  );
}
