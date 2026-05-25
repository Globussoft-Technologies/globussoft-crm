/**
 * QuotesComingSoon — tactical stub for /quotes (BUG-T24 / #886)
 *
 * The sidebar's "Quotes" link under FINANCIAL previously rendered the SPA
 * 404 page because no <Route> was registered for /quotes. The full Quotes
 * module (line-items + tax + discount + currency + PDF export + send-via-WA)
 * is multi-day work tracked as cluster B2 in docs/MANUAL_CODING_BACKLOG.md.
 *
 * Until the dedicated module ships, this page resolves the route to a
 * friendly explanation + CTAs to the two existing analogs:
 *   - /estimates — the legacy quote workflow (Draft → Sent → Accepted →
 *     Converted-to-Invoice already implemented in Estimates.jsx)
 *   - /pipeline  — Deals, where quote-grade pricing currently lives for
 *     in-flight opportunities
 *
 * Mirrors the visual shell of frontend/src/pages/Placeholder.jsx so it
 * stays consistent with other under-construction surfaces in the app.
 */
import { Link } from 'react-router-dom';
import { FileText, ArrowRight } from 'lucide-react';

const QuotesComingSoon = () => {
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
        <FileText
          size={64}
          color="var(--primary-color, var(--accent-color))"
          style={{
            marginBottom: '1.5rem',
            filter: 'drop-shadow(0 0 10px var(--accent-glow))',
          }}
        />
        <h1 style={{ fontSize: '2.25rem', marginBottom: '1rem', fontWeight: 'bold' }}>
          Quotes — coming soon
        </h1>
        <p
          style={{
            color: 'var(--text-secondary)',
            fontSize: '1.05rem',
            lineHeight: 1.6,
            marginBottom: '0.75rem',
          }}
        >
          The dedicated Quotes module (line items, tax, discount, PDF export,
          send-via-WhatsApp) is under active development.
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
          In the meantime, use <strong>Estimates</strong> for the same
          draft &rarr; sent &rarr; accepted &rarr; converted-to-invoice flow,
          or attach pricing to a <strong>Deal</strong> in the Pipeline.
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
            to="/estimates"
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
            Go to Estimates <ArrowRight size={16} />
          </Link>
          <Link
            to="/pipeline"
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
            Open Pipeline <ArrowRight size={16} />
          </Link>
        </div>
      </div>
    </div>
  );
};

export default QuotesComingSoon;
