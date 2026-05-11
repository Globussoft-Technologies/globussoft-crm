import React from 'react';

/**
 * frontend/src/components/ui/Spinner.jsx
 *
 * Issue #689 — loading states mix spinners / skeletons / blank screens.
 *
 * Canonical inline spinner. Use for short ad-hoc loads (e.g. an action
 * button waiting for a network response, an inline refresh). For table /
 * card list loading prefer <Skeleton/> — it gives users a sense of the
 * shape that's about to arrive.
 *
 * Sizes: small (16px) for inline within buttons, medium (24px) default,
 * large (40px) for empty page loads.
 *
 * Animated via CSS @keyframes spin — the keyframes live in index.css so
 * every instance shares the same definition.
 */
export default function Spinner({ size = 'medium', label = 'Loading', style, className }) {
  const px = size === 'small' ? 16 : size === 'large' ? 40 : 24;
  const border = size === 'small' ? 2 : 3;
  return (
    <span
      role="status"
      aria-label={label}
      className={className}
      style={{
        display: 'inline-block',
        width: px,
        height: px,
        border: `${border}px solid var(--border-color, rgba(255,255,255,0.15))`,
        borderTopColor: 'var(--primary-color, var(--accent-color, #3b82f6))',
        borderRadius: '50%',
        animation: 'spin 0.8s linear infinite',
        ...style,
      }}
    />
  );
}
