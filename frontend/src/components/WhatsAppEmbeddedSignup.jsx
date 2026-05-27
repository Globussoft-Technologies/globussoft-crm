// WhatsApp Embedded Signup (Meta) — P2 frontend flow.
//
// Flow:
//   1. Mount → fetch GET /api/whatsapp/onboard/status → render integration badge
//   2. User clicks "Connect WhatsApp Business"
//   3. Lazy-load Meta JS SDK (https://connect.facebook.net/en_US/sdk.js)
//   4. FB.init({ appId: VITE_META_APP_ID, version: VITE_META_GRAPH_VERSION })
//   5. FB.login(callback, { config_id: VITE_META_ES_CONFIG_ID, response_type: 'code', override_default_response_type: true })
//   6. On callback, POST /onboard/exchange with { code, wabaId, phoneNumberId }
//   7. POST /onboard/finalize with { handoffId }
//   8. Re-fetch status; show success
//
// Disconnect: POST /onboard/disconnect (RBAC: admin-only on backend).
//
// Environment:
//   VITE_META_APP_ID         public, safe to bundle
//   VITE_META_ES_CONFIG_ID   public, safe to bundle
//   VITE_META_GRAPH_VERSION  e.g. "v22.0"
//
// If any of these are missing, the component renders a "Setup incomplete"
// banner pointing at the env-var section of docs/whatsapp-saas/SETUP.md.
// If the backend returns EMBEDDED_SIGNUP_NOT_APPROVED (the feature flag is
// off pending App Review), the manual-paste form below remains the working
// onboarding path.

import { useContext, useEffect, useState, useCallback, useRef } from 'react';
import { fetchApi } from '../utils/api';
import { AuthContext } from '../App';

const META_APP_ID = import.meta.env.VITE_META_APP_ID || '';
const META_ES_CONFIG_ID = import.meta.env.VITE_META_ES_CONFIG_ID || '';
const META_GRAPH_VERSION = import.meta.env.VITE_META_GRAPH_VERSION || 'v22.0';

let fbSdkLoadingPromise = null;
function loadFbSdk() {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.FB) return Promise.resolve(window.FB);
  if (fbSdkLoadingPromise) return fbSdkLoadingPromise;
  fbSdkLoadingPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.async = true;
    script.defer = true;
    script.crossOrigin = 'anonymous';
    script.src = 'https://connect.facebook.net/en_US/sdk.js';
    script.onload = () => {
      try {
        window.FB.init({
          appId: META_APP_ID,
          xfbml: false,
          version: META_GRAPH_VERSION,
        });
        resolve(window.FB);
      } catch (err) {
        reject(err);
      }
    };
    script.onerror = () => reject(new Error('Failed to load Meta JS SDK'));
    document.head.appendChild(script);
  });
  return fbSdkLoadingPromise;
}

const SEVERITY_COLORS = {
  ok:    { bg: '#dcfce7', fg: '#15803d', border: '#86efac' },
  info:  { bg: '#dbeafe', fg: '#1e40af', border: '#93c5fd' },
  warn:  { bg: '#fef3c7', fg: '#92400e', border: '#fcd34d' },
  error: { bg: '#fee2e2', fg: '#991b1b', border: '#fca5a5' },
};

/**
 * @param {Object} props
 * @param {boolean} [props.compact] — when true, render a slim status bar
 *   that only expands the full panel on click. Useful for embedding above
 *   an inbox / threads UI where vertical real estate matters.
 */
export default function WhatsAppEmbeddedSignup({ compact = false }) {
  // Manage / Disconnect / Connect actions are tenant-ADMIN only — backend
  // RBAC already gates the POST routes; this hides the UI surface so
  // non-admins see a clean read-only status pill.
  const { user: currentUser } = useContext(AuthContext) || {};
  const isAdmin = currentUser?.role === 'ADMIN';
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState(''); // human progress string
  // In compact mode, default to collapsed when CONNECTED. Auto-expand on
  // any non-OK state so problems are visible.
  const [expanded, setExpanded] = useState(!compact);
  // Track the latest message-listener so we can detach on unmount.
  const messageListenerRef = useRef(null);

  const refreshStatus = useCallback(async () => {
    try {
      const r = await fetchApi('/api/whatsapp/onboard/status');
      setStatus(r);
    } catch (err) {
      setError(err.message || 'Failed to load status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshStatus();
    return () => {
      if (messageListenerRef.current) {
        window.removeEventListener('message', messageListenerRef.current);
      }
    };
  }, [refreshStatus]);

  const handleConnect = useCallback(async () => {
    if (!META_APP_ID || !META_ES_CONFIG_ID) {
      setError(
        'VITE_META_APP_ID and VITE_META_ES_CONFIG_ID must be set in frontend/.env. ' +
        'See docs/whatsapp-saas/SETUP.md.'
      );
      return;
    }
    setError(null);
    setConnecting(true);
    setProgress('Loading Meta SDK…');
    let FB;
    try {
      FB = await loadFbSdk();
    } catch (err) {
      setError('Could not load Meta JS SDK. Check that connect.facebook.net is reachable.');
      setConnecting(false);
      return;
    }

    // Meta's embedded-signup popup posts a window message with the chosen
    // WABA + phone-number-id BEFORE the OAuth callback completes — we listen
    // for it to capture those ids since FB.login's callback only returns the
    // auth code.
    //
    // EVERY postMessage from facebook.com is logged to the browser console
    // AND forwarded to /api/whatsapp/onboard/debug so it shows up in the
    // VS Code terminal. This is how operators verify what Meta is actually
    // sending when the connect flow fails with "no WABA / phone-number-id".
    let pickedWabaId = null;
    let pickedPhoneNumberId = null;
    const debugForward = (tag, payload) => {
      try {
        // eslint-disable-next-line no-console
        console.log(`[whatsapp-connect] ${tag}`, payload);
      } catch (_) { /* ignore */ }
      fetchApi('/api/whatsapp/onboard/debug', {
        method: 'POST',
        body: JSON.stringify({ tag, payload }),
      }).catch(() => { /* terminal-log is best-effort */ });
    };
    const messageListener = (event) => {
      if (event.origin !== 'https://www.facebook.com') return;
      let parsed = event.data;
      let parseError = null;
      if (typeof event.data === 'string') {
        try {
          parsed = JSON.parse(event.data);
        } catch (e) {
          parseError = e.message;
        }
      }
      debugForward('postMessage from facebook.com', {
        origin: event.origin,
        rawType: typeof event.data,
        parsed,
        parseError,
      });
      if (parsed?.type === 'WA_EMBEDDED_SIGNUP') {
        if (parsed?.data?.waba_id)         pickedWabaId        = parsed.data.waba_id;
        if (parsed?.data?.phone_number_id) pickedPhoneNumberId = parsed.data.phone_number_id;
      }
    };
    messageListenerRef.current = messageListener;
    window.addEventListener('message', messageListener);

    setProgress('Opening Meta sign-in…');
    // IMPORTANT: Meta's SDK type-checks the callback and REJECTS async functions
    // with "Expression is of type asyncfunction, not function". Pass a plain
    // (non-async) function that delegates to an inner async IIFE — same
    // behavior, no SDK rejection.
    FB.login(
      function fbLoginCallback(response) {
        // Always detach the listener — even on cancel.
        window.removeEventListener('message', messageListener);
        messageListenerRef.current = null;

        // Forward the full FB.login response (with the OAuth code
        // redacted) so the operator can see exactly what came back from
        // the popup. The `code` field is intentionally redacted here —
        // the backend /exchange route logs the full request when the
        // frontend hands it the code.
        const redactedResponse = response
          ? {
              status: response.status,
              authResponse: response.authResponse
                ? {
                    ...response.authResponse,
                    code: response.authResponse.code
                      ? `***REDACTED(${response.authResponse.code.length})***`
                      : null,
                  }
                : null,
            }
          : null;
        debugForward('FB.login callback', {
          response: redactedResponse,
          pickedWabaId,
          pickedPhoneNumberId,
        });

        if (!response || response.status !== 'connected' || !response.authResponse?.code) {
          setError('Sign-in cancelled or did not return an authorization code.');
          setConnecting(false);
          setProgress('');
          return;
        }
        const code = response.authResponse.code;
        if (!pickedWabaId || !pickedPhoneNumberId) {
          setError(
            'Meta did not return a WABA ID or phone-number-id. ' +
            'Re-run sign-up and pick a WhatsApp Business Account + phone number when prompted.'
          );
          setConnecting(false);
          setProgress('');
          return;
        }

        (async () => {
        try {
          setProgress('Exchanging authorization code…');
          const exch = await fetchApi('/api/whatsapp/onboard/exchange', {
            method: 'POST',
            body: JSON.stringify({ code, wabaId: pickedWabaId, phoneNumberId: pickedPhoneNumberId }),
          });
          if (!exch?.handoffId) {
            setError(exch?.error || 'Exchange failed.');
            setConnecting(false);
            setProgress('');
            return;
          }

          setProgress('Wiring webhook + registering phone number…');
          const fin = await fetchApi('/api/whatsapp/onboard/finalize', {
            method: 'POST',
            body: JSON.stringify({ handoffId: exch.handoffId }),
          });
          if (!fin?.success) {
            setError(fin?.error || 'Finalize failed.');
            setConnecting(false);
            setProgress('');
            return;
          }

          setProgress('Connected. Refreshing status…');
          await refreshStatus();
          setConnecting(false);
          setProgress('');
        } catch (err) {
          setError(err.message || 'Onboarding failed.');
          setConnecting(false);
          setProgress('');
        }
        })();
      },
      {
        config_id: META_ES_CONFIG_ID,
        response_type: 'code',
        override_default_response_type: true,
        // `sessionInfoVersion: '3'` is what tells Meta's SDK to post the
        // `WA_EMBEDDED_SIGNUP` event back to opener (the postMessage that
        // carries waba_id + phone_number_id). Without it the popup falls
        // back to standard OAuth and you only get an authorization code
        // with no WhatsApp picker — exactly the "Meta did not return a
        // WABA ID or phone-number-id" symptom.
        extras: {
          setup: {},
          featureType: '',
          sessionInfoVersion: '3',
        },
      },
    );
  }, [refreshStatus]);

  const handleDisconnect = useCallback(async () => {
    const ok = window.confirm('Disconnect WhatsApp? Sending will stop immediately. Chat history is preserved.');
    if (!ok) return;
    try {
      await fetchApi('/api/whatsapp/onboard/disconnect', {
        method: 'POST',
        body: JSON.stringify({ alsoUnsubscribeFromMeta: true }),
      });
      await refreshStatus();
    } catch (err) {
      setError(err.message || 'Disconnect failed');
    }
  }, [refreshStatus]);

  if (loading) {
    return <div className="glass-card" style={{ padding: '1rem', borderRadius: 12 }}>Loading WhatsApp status…</div>;
  }

  const badge = status ? SEVERITY_COLORS[status.severity] || SEVERITY_COLORS.info : SEVERITY_COLORS.info;
  const setupIncomplete = !META_APP_ID || !META_ES_CONFIG_ID;

  // Compact collapsed bar — only shows when CONNECTED + compact mode + not expanded.
  // Single horizontal row with status pill + "Manage" button on the right.
  if (compact && !expanded && status?.severity === 'ok') {
    return (
      <div className="glass-card" style={{
        padding: '0.55rem 1rem',
        borderRadius: 10,
        border: '1px solid rgba(0,0,0,0.06)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '1rem',
        marginBottom: '0.75rem',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', minWidth: 0 }}>
          <span style={{
            display: 'inline-block', width: 8, height: 8, borderRadius: 999,
            background: badge.fg,
          }} />
          <span style={{ fontSize: '0.85rem', fontWeight: 500 }}>
            WhatsApp: <span style={{ color: badge.fg }}>{status.label}</span>
            {status.phoneNumberId && (
              <span style={{ color: 'var(--text-secondary)', marginLeft: 6, fontWeight: 400 }}>
                · {status.phoneNumberId}
              </span>
            )}
          </span>
        </div>
        {isAdmin && (
          <div style={{ display: 'flex', gap: '0.4rem' }}>
            <button
              onClick={() => setExpanded(true)}
              style={{
                padding: '0.3rem 0.75rem', background: 'transparent',
                color: 'var(--text-primary)', border: '1px solid var(--border-color)',
                borderRadius: 6, fontSize: '0.8rem', cursor: 'pointer',
              }}
            >
              Manage
            </button>
            <button
              onClick={handleDisconnect}
              title="Disconnect WhatsApp Business"
              style={{
                padding: '0.3rem 0.75rem', background: 'transparent',
                color: '#dc2626', border: '1px solid #fca5a5',
                borderRadius: 6, fontSize: '0.8rem', cursor: 'pointer',
                fontWeight: 600,
              }}
            >
              Disconnect
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="glass-card" style={{ padding: '1.25rem', borderRadius: 12, border: '1px solid rgba(0,0,0,0.06)', marginBottom: compact ? '0.75rem' : 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', marginBottom: '1rem' }}>
        <div>
          <h3 style={{ margin: 0, fontSize: '1.1rem' }}>WhatsApp Business — Embedded Signup</h3>
          <p style={{ margin: '0.25rem 0 0', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
            Connect your tenant&apos;s own WhatsApp Business Account directly via Meta. No manual token paste required.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          {status && (
            <div style={{
              background: badge.bg, color: badge.fg, border: `1px solid ${badge.border}`,
              padding: '0.35rem 0.75rem', borderRadius: 999, fontSize: '0.8rem', fontWeight: 600, whiteSpace: 'nowrap',
            }}>
              {status.label}
            </div>
          )}
          {compact && status?.severity === 'ok' && (
            <button
              onClick={() => setExpanded(false)}
              style={{
                padding: '0.3rem 0.6rem', background: 'transparent',
                color: 'var(--text-secondary)', border: '1px solid rgba(0,0,0,0.15)',
                borderRadius: 6, fontSize: '0.75rem', cursor: 'pointer',
              }}
              title="Collapse"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {error && (
        <div style={{ background: SEVERITY_COLORS.error.bg, color: SEVERITY_COLORS.error.fg, padding: '0.75rem 1rem', borderRadius: 8, marginBottom: '1rem', fontSize: '0.875rem' }}>
          {error}
        </div>
      )}

      {setupIncomplete && (
        <div style={{ background: SEVERITY_COLORS.warn.bg, color: SEVERITY_COLORS.warn.fg, padding: '0.75rem 1rem', borderRadius: 8, marginBottom: '1rem', fontSize: '0.875rem' }}>
          <strong>Setup incomplete.</strong> <code>VITE_META_APP_ID</code> and <code>VITE_META_ES_CONFIG_ID</code> must be set in <code>frontend/.env</code> before tenants can use Embedded Signup. See <code>docs/whatsapp-saas/SETUP.md</code>.
        </div>
      )}

      {status?.reason && (
        <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
          {status.reason}
        </div>
      )}

      {status?.configured && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem', fontSize: '0.85rem', marginBottom: '1rem' }}>
          {status.phoneNumberId && <KV k="Phone Number ID" v={status.phoneNumberId} />}
          {status.businessAccountId && <KV k="WABA ID" v={status.businessAccountId} />}
          {status.qualityRating && <KV k="Quality" v={status.qualityRating} />}
          {status.messagingLimitTier && <KV k="Tier" v={status.messagingLimitTier} />}
          {status.tokenExpiresAt && <KV k="Token expires" v={new Date(status.tokenExpiresAt).toLocaleDateString()} />}
          {status.tokenExpiresAt === null && <KV k="Token expiry" v="Never (system user)" />}
        </div>
      )}

      {isAdmin ? (
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          {(!status?.configured || status.status === 'NOT_CONNECTED' || status.status === 'DISCONNECTED' || status.status === 'TOKEN_EXPIRED' || status.status === 'WEBHOOK_FAILED') && (
            <button
              onClick={handleConnect}
              disabled={connecting || setupIncomplete}
              style={{
                padding: '0.65rem 1.25rem',
                background: '#25D366',
                color: 'white',
                border: 'none',
                borderRadius: 8,
                fontWeight: 600,
                cursor: connecting || setupIncomplete ? 'not-allowed' : 'pointer',
                opacity: connecting || setupIncomplete ? 0.6 : 1,
              }}
            >
              {connecting ? (progress || 'Connecting…') : (status?.configured ? 'Reconnect WhatsApp Business' : 'Connect WhatsApp Business')}
            </button>
          )}
          {status?.configured && status.status !== 'NOT_CONNECTED' && status.status !== 'DISCONNECTED' && (
            <button
              onClick={handleDisconnect}
              style={{
                padding: '0.65rem 1.25rem',
                background: 'transparent',
                color: 'var(--text-primary)',
                border: '1px solid var(--border-color)',
                borderRadius: 8,
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              Disconnect
            </button>
          )}
        </div>
      ) : (
        <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', fontStyle: 'italic' }}>
          Only tenant admins can connect, reconnect, or disconnect WhatsApp Business.
        </div>
      )}
    </div>
  );
}

function KV({ k, v }) {
  return (
    <div>
      <div style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 2 }}>{k}</div>
      <div style={{ fontWeight: 500, wordBreak: 'break-all' }}>{v}</div>
    </div>
  );
}
