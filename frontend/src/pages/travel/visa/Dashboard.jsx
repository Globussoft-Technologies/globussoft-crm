/**
 * Visa Sure Dashboard — Phase 3 scaffolding shell (cluster B3)
 *
 * Landing page for the Visa Sure sub-brand under the Travel vertical.
 * This is a SHELL only — no real diagnostic flow, no application forms,
 * no data fetching. The full Phase 3 module (visa-type pickers,
 * document-checklist workflow, OCR-backed PDF consumer, status timeline,
 * embassy-appointment scheduler) is multi-day work gated on the 4
 * product calls in docs/PRD_VISA_SURE_PHASE_3.md §5 + §9.
 *
 * Mirrors the visual shell of pages/QuotesComingSoon.jsx (the canonical
 * "Coming Soon / cluster B reference" shape) so the visa surface stays
 * visually consistent with other under-construction modules.
 *
 * Routes mounted in App.jsx:
 *   /travel/visa               → this page
 *   /travel/visa/applications  → Applications.jsx placeholder
 *   /travel/visa/checklists    → Checklists.jsx placeholder
 *
 * Sidebar group: "Visa Sure" under renderTravelNav() (admin-only).
 */
import { Link } from 'react-router-dom';
import { Stamp, ArrowRight, FileText } from 'lucide-react';

const VisaDashboard = () => {
  return (
    <div
      className="dashboard-content"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '80vh',
        textAlign: 'center',
        padding: '2rem',
      }}
    >
      <div
        style={{
          padding: '3rem',
          background: 'rgba(255, 255, 255, 0.03)',
          border: '1px solid rgba(255, 255, 255, 0.05)',
          borderRadius: '16px',
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.2)',
          maxWidth: 640,
        }}
      >
        <Stamp
          size={64}
          color="var(--primary-color, var(--accent-color))"
          style={{
            marginBottom: '1.5rem',
            filter: 'drop-shadow(0 0 10px var(--accent-glow))',
          }}
        />
        <h1 style={{ fontSize: '2.25rem', marginBottom: '0.5rem', fontWeight: 'bold' }}>
          Visa Sure
        </h1>
        <div
          style={{
            display: 'inline-block',
            padding: '0.25rem 0.75rem',
            borderRadius: 999,
            background: 'rgba(255, 200, 100, 0.12)',
            border: '1px solid rgba(255, 200, 100, 0.25)',
            color: 'var(--text-secondary)',
            fontSize: '0.8rem',
            marginBottom: '1.5rem',
            letterSpacing: 0.3,
          }}
        >
          Phase 3 — Visa Sure scaffolding
        </div>
        <p
          style={{
            color: 'var(--text-secondary)',
            fontSize: '1.05rem',
            lineHeight: 1.6,
            marginBottom: '0.75rem',
          }}
        >
          The Visa Sure module (visa-type pickers, document checklists,
          OCR-backed PDF consumer, status timeline, embassy-appointment
          scheduling) is under active design.
        </p>
        <p
          style={{
            color: 'var(--text-secondary)',
            fontSize: '0.95rem',
            lineHeight: 1.6,
            marginBottom: '2rem',
            opacity: 0.85,
          }}
        >
          See{' '}
          <strong>
            <code>docs/PRD_VISA_SURE_PHASE_3.md</code>
          </strong>{' '}
          for the design spec, open product questions, and rollout plan.
        </p>

        <div
          style={{
            display: 'flex',
            gap: '0.75rem',
            justifyContent: 'center',
            flexWrap: 'wrap',
          }}
        >
          <Link
            to="/travel/visa/applications"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '0.75rem 1.5rem',
              borderRadius: 8,
              textDecoration: 'none',
              fontWeight: 600,
              background: 'var(--primary-color, var(--accent-color))',
              color: '#fff',
              fontSize: '0.95rem',
            }}
          >
            <FileText size={16} /> Applications <ArrowRight size={16} />
          </Link>
          <Link
            to="/travel/visa/checklists"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '0.75rem 1.5rem',
              borderRadius: 8,
              textDecoration: 'none',
              fontWeight: 600,
              background: 'rgba(255, 255, 255, 0.05)',
              color: 'var(--text-primary, #fff)',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              fontSize: '0.95rem',
            }}
          >
            Checklists <ArrowRight size={16} />
          </Link>
        </div>
      </div>
    </div>
  );
};

export default VisaDashboard;
