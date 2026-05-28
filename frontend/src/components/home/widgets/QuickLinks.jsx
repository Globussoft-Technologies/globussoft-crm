import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Layers, ArrowRight } from 'lucide-react';
import WidgetCard from '../WidgetCard.jsx';
import { fetchApi } from '../../../utils/api';

/**
 * QuickLinks — auto-generated launcher of every page the signed-in user
 * has permission to access. Fetched from /api/pages/me, which intersects
 * the static page catalog with the user's effective permissions. New
 * pages added to the catalog appear here for the right roles
 * automatically — no per-role JSX edit needed.
 *
 * Behaves like a mini sitemap for the role: lists clinical pages for a
 * doctor, finance + waitlist for a receptionist, lead queue + comms for
 * a telecaller. Grouped by category for scannability.
 */
export default function QuickLinks({ meta }) {
  const [pages, setPages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchApi('/api/pages/me', { silent: true })
      .then((res) => {
        if (cancelled) return;
        setPages(Array.isArray(res?.pages) ? res.pages : []);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message || 'Failed to load accessible pages');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Filter out /home itself + any pages without a label (defensive). Group
  // by category so the layout reads like a sitemap.
  const visible = pages.filter((p) => p.path !== '/home' && p.label);
  const byCategory = visible.reduce((acc, p) => {
    (acc[p.category || 'Other'] = acc[p.category || 'Other'] || []).push(p);
    return acc;
  }, {});
  const categories = Object.keys(byCategory).sort();

  return (
    <WidgetCard
      title={meta?.title || 'Quick links'}
      description={meta?.description || 'Pages your role can access'}
      icon={Layers}
      loading={loading}
      error={error}
      empty={!loading && !error && visible.length === 0}
      emptyMessage="No additional pages — your widgets above are your only surface."
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {categories.map((cat) => (
          <div key={cat}>
            <div
              style={{
                fontSize: '0.7rem',
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                color: 'var(--text-secondary)',
                marginBottom: '0.3rem',
              }}
            >
              {cat}
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 140px), 1fr))',
                gap: '0.35rem',
              }}
            >
              {byCategory[cat].map((p) => (
                <Link
                  key={p.path}
                  to={p.path}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '0.4rem 0.55rem',
                    borderRadius: 6,
                    border: '1px solid var(--border-color)',
                    background: 'var(--subtle-bg-3)',
                    color: 'inherit',
                    textDecoration: 'none',
                    fontSize: '0.8rem',
                    gap: '0.4rem',
                  }}
                  title={p.description || p.path}
                >
                  <span
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {p.label}
                  </span>
                  <ArrowRight
                    size={12}
                    style={{ color: 'var(--text-secondary)', flexShrink: 0 }}
                  />
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>
    </WidgetCard>
  );
}
