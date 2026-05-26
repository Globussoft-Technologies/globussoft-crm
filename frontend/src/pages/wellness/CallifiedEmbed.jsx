/**
 * frontend/src/pages/wellness/CallifiedEmbed.jsx — embedded Callified panel (#832)
 *
 * What this is
 *   Renders the Callified voice / WhatsApp dashboard inside the CRM shell as
 *   an iframe, so users stay inside the CRM (consistent with Unified Inbox /
 *   WhatsApp Threads) instead of being kicked out to a new browser tab.
 *
 * Why
 *   #832 pen-test: sidebar `Callified` link + Owner Dashboard "Open Callified"
 *   card both called `window.open(authUrl, '_blank', ...)` via launchCallifiedSSO.
 *   The new-tab launch reads as second-class compared with the other voice /
 *   messaging surfaces that render in-shell.
 *
 * How it works
 *   1. On mount, fetch a signed SSO auth URL from the CRM backend
 *      (`GET /api/integrations/callified/auth-url`). Same endpoint the
 *      previous new-tab launcher used — we are NOT changing the SSO contract
 *      with Callified, only the surface that renders it.
 *   2. Stuff the returned `authUrl` into an `<iframe src>`. The iframe loads
 *      Callified, which validates the JWT and renders its dashboard inside
 *      the CRM frame.
 *   3. Three render states: idle / loading (spinner), error (with retry CTA),
 *      ready (iframe). Mirrors the pattern used by the AdsGPT and existing
 *      Callified launcher cards in OwnerDashboard.
 *
 * Known follow-ups
 *   - TODO #832 follow-up: if Callified ships a restrictive
 *     `Content-Security-Policy: frame-ancestors` OR
 *     `X-Frame-Options: DENY|SAMEORIGIN`, the iframe load will be blocked
 *     by the browser. The page surfaces a "Couldn't load Callified inline"
 *     error state with a fallback "Open in new tab" CTA so users are not
 *     stranded. Coordinate with the Callified team to allowlist
 *     `crm.globusdemos.com` (and any tenant subdomains) in frame-ancestors
 *     when this is rolled to other tenants.
 *   - TODO #832 follow-up: tenant-aware iframe URL. The backend already
 *     resolves the Callified base URL per-tenant via the Integration row;
 *     this page just consumes whatever URL the backend returns.
 *
 * Auth
 *   The iframe is loaded with a signed JWT in the query string (Callified
 *   spec). The JWT is the SAME shape the new-tab launch used — no new
 *   sensitive surface introduced by switching to iframe.
 */
import { useEffect, useState, useCallback } from 'react';
import { Loader2, AlertTriangle, ExternalLink, RefreshCw, PhoneCall } from 'lucide-react';
import { fetchApi } from '../../utils/api';

export default function CallifiedEmbed() {
  const [state, setState] = useState({ status: 'loading', authUrl: null, error: null });

  const loadAuthUrl = useCallback(() => {
    setState({ status: 'loading', authUrl: null, error: null });
    fetchApi('/api/integrations/callified/auth-url', { silent: true })
      .then((data) => {
        if (!data?.authUrl) {
          setState({ status: 'error', authUrl: null, error: 'Backend did not return an auth URL' });
          return;
        }
        setState({ status: 'ready', authUrl: data.authUrl, error: null });
      })
      .catch((err) => {
        const msg = err?.message?.includes('not yet available')
          ? 'Callified integration is not yet configured for this tenant. Contact your administrator.'
          : err?.message || 'Failed to sign in to Callified';
        setState({ status: 'error', authUrl: null, error: msg });
      });
  }, []);

  useEffect(() => {
    loadAuthUrl();
  }, [loadAuthUrl]);

  const headerHeight = 64;
  const wrapStyle = {
    width: '100%',
    height: `calc(100vh - ${headerHeight}px)`,
    display: 'flex',
    flexDirection: 'column',
  };

  if (state.status === 'loading') {
    return (
      <div style={wrapStyle}>
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: '1rem',
          color: 'var(--text-secondary)',
        }}>
          <Loader2 size={32} className="spin" />
          <div>Signing you into Callified…</div>
        </div>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div style={wrapStyle}>
        <div className="glass" style={{
          margin: '2rem auto', maxWidth: 520, padding: '2rem',
          display: 'flex', flexDirection: 'column', gap: '1rem',
          alignItems: 'center', textAlign: 'center',
        }}>
          <AlertTriangle size={32} color="#f87171" />
          <div style={{ fontSize: '1.1rem', fontWeight: 600 }}>Couldn't open Callified</div>
          <div style={{ color: 'var(--text-secondary)' }}>{state.error}</div>
          <button
            type="button"
            onClick={loadAuthUrl}
            className="btn-primary"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
              padding: '0.6rem 1.1rem', borderRadius: 8,
              background: 'var(--primary-color, var(--accent-color))',
              color: '#fff', border: 'none', cursor: 'pointer',
            }}
          >
            <RefreshCw size={16} /> Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={wrapStyle}>
      {/* Header strip — minimal context so users know what they're looking at,
          plus a fallback to open Callified in a new tab if the iframe ever
          fails to render (e.g. browser-level X-Frame-Options denial that the
          iframe load event doesn't surface back to JS). */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0.5rem 1rem', borderBottom: '1px solid var(--border-color, #e5e7eb)',
        gap: '1rem', flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <PhoneCall size={18} />
          <span style={{ fontSize: '0.95rem', fontWeight: 600 }}>Callified</span>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            Voice & WhatsApp
          </span>
        </div>
        <a
          href={state.authUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: '0.35rem',
            fontSize: '0.85rem', color: 'var(--text-secondary)',
            textDecoration: 'none',
          }}
          aria-label="Open Callified in a new tab"
          title="Open Callified in a new tab (fallback)"
        >
          Open in new tab <ExternalLink size={14} />
        </a>
      </div>
      <iframe
        src={state.authUrl}
        title="Callified Voice and WhatsApp"
        style={{ flex: 1, width: '100%', border: 'none' }}
        // NOTE: deliberately NOT adding sandbox attributes — Callified needs
        // same-origin storage + popups for OAuth-style sub-flows. Revisit if
        // a tighter sandbox is required by security review.
        allow="microphone; camera; clipboard-read; clipboard-write"
      />
    </div>
  );
}
