import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import BlockRenderer from '../../components/landing-page-renderers/BlockRenderer';

export default function LandingSiteResolver() {
  const { slug } = useParams();
  const [page, setPage] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/landing-sites/public/${encodeURIComponent(slug || '')}?vertical=generic`, { method: 'GET' });
        if (cancelled) return;
        if (!res.ok) {
          setError('Landing site not found');
          return;
        }
        const data = await res.json();
        if (!cancelled) setPage(data);
      } catch (_err) {
        if (!cancelled) setError('Unable to load landing site');
      }
    })();
    return () => { cancelled = true; };
  }, [slug]);

  if (error) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: '2rem', background: '#f8fafc', color: '#111827' }}>
        <div style={{ maxWidth: 560, textAlign: 'center' }}>
          <h1 style={{ fontSize: '2rem', marginBottom: '0.75rem' }}>Landing site unavailable</h1>
          <p style={{ color: '#475569' }}>{error}</p>
        </div>
      </div>
    );
  }

  if (!page) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: '2rem' }}>
        <p>Loading...</p>
      </div>
    );
  }

  const content = Array.isArray(page.content)
    ? page.content
    : (() => { try { return JSON.parse(page.content || '[]'); } catch { return []; } })();

  return <BlockRenderer landingPage={{ ...page, content, publicSubmit: true }} />;
}
