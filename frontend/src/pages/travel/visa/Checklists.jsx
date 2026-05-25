/**
 * Visa Sure Checklists — Phase 3 scaffolding shell (cluster B3)
 *
 * Placeholder admin-view for visa-document checklists by country + visa
 * type. Real implementation (checklist CRUD, document templates,
 * required-vs-optional flags, attachment validation rules) is gated on
 * product calls in docs/PRD_VISA_SURE_PHASE_3.md §5 + §9.
 *
 * Mirrors QuotesComingSoon.jsx shell shape — placeholder admin surface,
 * not real implementation.
 */
import { Link } from 'react-router-dom';
import { ClipboardList, ArrowLeft } from 'lucide-react';

const VisaChecklists = () => {
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
          maxWidth: 560,
        }}
      >
        <ClipboardList
          size={64}
          color="var(--primary-color, var(--accent-color))"
          style={{
            marginBottom: '1.5rem',
            filter: 'drop-shadow(0 0 10px var(--accent-glow))',
          }}
        />
        <h1 style={{ fontSize: '2rem', marginBottom: '1rem', fontWeight: 'bold' }}>
          Visa Checklists — coming in Phase 3
        </h1>
        <p
          style={{
            color: 'var(--text-secondary)',
            fontSize: '1rem',
            lineHeight: 1.6,
            marginBottom: '0.75rem',
          }}
        >
          The checklist admin (country × visa-type document matrix,
          required-vs-optional flags, validation rules, version history)
          is part of cluster B3 of the Visa Sure rollout.
        </p>
        <p
          style={{
            color: 'var(--text-secondary)',
            fontSize: '0.9rem',
            lineHeight: 1.6,
            marginBottom: '2rem',
            opacity: 0.85,
          }}
        >
          See{' '}
          <strong>
            <code>docs/PRD_VISA_SURE_PHASE_3.md</code>
          </strong>{' '}
          for the design spec and open product questions.
        </p>

        <Link
          to="/travel/visa"
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
          <ArrowLeft size={16} /> Back to Visa Sure
        </Link>
      </div>
    </div>
  );
};

export default VisaChecklists;
