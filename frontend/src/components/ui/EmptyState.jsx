import React from 'react';

/**
 * frontend/src/components/ui/EmptyState.jsx
 *
 * Issue #688 — empty states inconsistent across modules (some friendly
 * illustration + CTA, some bare "No requests yet." text, some nothing).
 *
 * Canonical empty-state primitive: icon + heading + optional sub-copy +
 * optional CTA button. Used by list / table / report screens when there
 * are zero rows to show.
 *
 * Distinguish from "loading" (use Spinner/Skeleton) and "error" (use the
 * notify.error toast or an inline error banner). This component is for
 * the legitimate "no data yet" state.
 *
 * Usage:
 *   <EmptyState
 *     icon={<Users size={48} />}
 *     heading="No patients yet"
 *     body="Add your first patient to start scheduling visits."
 *     cta={{ label: 'Add patient', onClick: () => setShowModal(true) }}
 *   />
 *
 * Or with no CTA (for lists where the create-affordance lives elsewhere
 * in the page header):
 *
 *   <EmptyState heading="No leave requests yet" />
 */
export default function EmptyState({ icon, heading, body, cta, style, className }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={className}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '0.75rem',
        padding: '3rem 1.5rem',
        textAlign: 'center',
        color: 'var(--text-secondary)',
        ...style,
      }}
    >
      {icon && (
        <div
          aria-hidden="true"
          style={{ opacity: 0.5, color: 'var(--text-secondary)' }}
        >
          {icon}
        </div>
      )}
      {heading && (
        <h3
          style={{
            margin: 0,
            fontSize: '1rem',
            fontWeight: 600,
            color: 'var(--text-primary)',
          }}
        >
          {heading}
        </h3>
      )}
      {body && (
        <p
          style={{
            margin: 0,
            fontSize: '0.875rem',
            lineHeight: 1.5,
            maxWidth: '32rem',
          }}
        >
          {body}
        </p>
      )}
      {cta && cta.label && (
        <button
          type="button"
          className="btn-primary"
          onClick={cta.onClick}
          style={{ marginTop: '0.5rem' }}
        >
          {cta.label}
        </button>
      )}
    </div>
  );
}
