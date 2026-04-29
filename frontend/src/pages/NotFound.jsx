import React, { useContext } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Home, LogIn, BookOpen, ArrowRight, AlertCircle } from 'lucide-react';
import { AuthContext } from '../App';

/**
 * #341 — Global catch-all 404. Previously, unmapped or wrong-prefix URLs
 * (e.g. /loyalty without the /wellness prefix) rendered an empty <main>
 * with HTTP 200 because the SPA layout was served but no route matched
 * inside it. This page is the fallback `path="*"` element in App.jsx.
 *
 * Behaviour:
 *  - Heading + the URL the user hit (so they know what failed).
 *  - Suggests a corrected URL when the path matches a known wrong-prefix
 *    map (e.g. /loyalty -> /wellness/loyalty for wellness tenants).
 *  - Quick links: Dashboard (or /wellness for wellness tenants),
 *    Login (when logged out), and Help (Knowledge Base).
 */

// Known wrong-prefix → corrected path map. Keep small + intentional;
// blanket fuzzy matching causes more confusion than it solves.
// Add entries when bug reports flag a recurring typo.
const WELLNESS_PREFIX_MAP = {
  '/loyalty': '/wellness/loyalty',
  '/per-location': '/wellness/per-location',
  '/patients': '/wellness/patients',
  '/recommendations': '/wellness/recommendations',
  '/services': '/wellness/services',
  '/locations': '/wellness/locations',
  '/waitlist': '/wellness/waitlist',
  '/inventory': '/wellness/inventory',
};

export default function NotFound() {
  const location = useLocation();
  const { token, tenant } = useContext(AuthContext);
  const path = location.pathname;
  const isWellness = tenant?.vertical === 'wellness';
  const homePath = isWellness ? '/wellness' : '/dashboard';
  const homeLabel = isWellness ? 'Go to Wellness Dashboard' : 'Go to Dashboard';

  // Suggest a corrected path when the user hit a known wrong-prefix URL.
  // Only surface wellness suggestions to wellness tenants — the generic
  // tenant has no /wellness/* pages.
  const suggested = isWellness && WELLNESS_PREFIX_MAP[path] ? WELLNESS_PREFIX_MAP[path] : null;

  const linkBase = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.5rem',
    padding: '0.65rem 1.1rem',
    borderRadius: 8,
    textDecoration: 'none',
    fontWeight: 500,
    fontSize: '0.9rem',
    border: '1px solid var(--border-color)',
    color: 'var(--text-primary)',
    background: 'var(--surface-color)',
  };
  const linkPrimary = {
    ...linkBase,
    background: 'var(--accent-color)',
    color: 'var(--accent-text, #fff)',
    border: '1px solid transparent',
  };

  return (
    <div style={{ maxWidth: 720, margin: '3rem auto', padding: '0 1rem' }}>
      <div className="glass" style={{ padding: '2rem', borderRadius: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
          <AlertCircle size={28} color="var(--accent-color)" />
          <h1 style={{ fontSize: '1.5rem', fontWeight: 600, margin: 0, color: 'var(--text-primary)' }}>
            404 &mdash; Page not found
          </h1>
        </div>

        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: '1.25rem' }}>
          We don't have a page for <code style={{
            background: 'var(--subtle-bg, rgba(0,0,0,0.05))',
            padding: '0.1rem 0.4rem',
            borderRadius: 4,
            fontSize: '0.9em',
          }}>{path}</code>. The link may be out of date, or the URL may be missing a prefix.
        </p>

        {suggested && (
          <div style={{
            padding: '0.85rem 1rem',
            background: 'rgba(38, 88, 85, 0.08)',
            border: '1px solid rgba(38, 88, 85, 0.2)',
            borderRadius: 8,
            marginBottom: '1.5rem',
          }}>
            <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
              Did you mean:
            </div>
            <Link to={suggested} style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.4rem',
              color: 'var(--primary-color, var(--accent-color))',
              fontWeight: 600,
              textDecoration: 'none',
            }}>
              <code>{suggested}</code> <ArrowRight size={14} />
            </Link>
          </div>
        )}

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.6rem', marginTop: '0.5rem' }}>
          {token ? (
            <Link to={homePath} style={linkPrimary}>
              <Home size={16} /> {homeLabel}
            </Link>
          ) : (
            <Link to="/login" style={linkPrimary}>
              <LogIn size={16} /> Go to Login
            </Link>
          )}
          {token && (
            <Link to="/knowledge-base" style={linkBase}>
              <BookOpen size={16} /> Search the help
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
