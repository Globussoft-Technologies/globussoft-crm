import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { LandingPageReactRenderer } from '../../components/landing-page-renderers';

function getPublicLandingPageUrl(tripRef) {
  const normalizedRef = String(tripRef || '').trim();
  if (!normalizedRef) return null;
  return /^\d+$/.test(normalizedRef)
    ? `/api/landing-pages/public/by-id/${encodeURIComponent(normalizedRef)}`
    : `/api/landing-pages/public/by-slug/${encodeURIComponent(normalizedRef)}`;
}

function normalizePublicTripPage(page) {
  const slug = typeof page?.slug === 'string' ? page.slug.trim() : '';
  if (!slug) return null;
  return {
    ...page,
    publicSubmit: true,
  };
}

export default function TripsShareResolver() {
  const { tripRef } = useParams();
  const [landingPage, setLandingPage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    const loadPage = async () => {
      const url = getPublicLandingPageUrl(tripRef);
      if (!url) {
        if (!cancelled) {
          setError('Missing trip reference.');
          setLoading(false);
        }
        return;
      }

      try {
        setLoading(true);
        setError(null);

        const response = await fetch(url, {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) {
          throw new Error(response.status === 404 ? 'Page not found' : `Failed to load trip page (${response.status})`);
        }

        const data = await response.json();
        if (!cancelled) {
          setLandingPage(normalizePublicTripPage(data));
          setLoading(false);
        }
      } catch (err) {
        if (cancelled) return;
        setLandingPage(null);
        setLoading(false);
        setError(err?.message || 'Failed to load trip page');
      }
    };

    loadPage();

    return () => {
      cancelled = true;
    };
  }, [tripRef]);

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>
        Loading trip...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: '2rem' }}>
        <div style={{ maxWidth: '28rem', textAlign: 'center', padding: '1.5rem', border: '1px solid var(--border-color)', borderRadius: '14px', background: 'var(--surface-color)', boxShadow: '0 12px 32px rgba(15, 23, 42, 0.08)' }}>
          <h1 style={{ marginTop: 0 }}>Page not found</h1>
          <p style={{ color: 'var(--text-secondary)', lineHeight: 1.6 }}>{error}</p>
          <a href="/trips" style={{ color: 'var(--primary-color, var(--accent-color))', fontWeight: 600, textDecoration: 'none' }}>
            Back to trips
          </a>
        </div>
      </div>
    );
  }

  if (!landingPage) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: '2rem' }}>
        <div style={{ maxWidth: '28rem', textAlign: 'center', padding: '1.5rem', border: '1px solid var(--border-color)', borderRadius: '14px', background: 'var(--surface-color)' }}>
          <h1 style={{ marginTop: 0 }}>Page not found</h1>
          <p style={{ color: 'var(--text-secondary)', lineHeight: 1.6 }}>The trip you requested could not be loaded.</p>
          <a href="/trips" style={{ color: 'var(--primary-color, var(--accent-color))', fontWeight: 600, textDecoration: 'none' }}>
            Back to trips
          </a>
        </div>
      </div>
    );
  }

  return <LandingPageReactRenderer landingPage={landingPage} />;
}
