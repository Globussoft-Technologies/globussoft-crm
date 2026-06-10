import { useState, useEffect } from 'react';
import { ShieldCheck, RotateCw, Plus, Trash2, Copy, Check, X, AlertTriangle } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';

// Per-tenant HMAC signing credential management — generate / rotate / revoke
// the secret used to sign every outbound webhook (the lead-sync stream
// GlobusPhone consumes). Replaces the old single global WEBHOOK_HMAC_SECRET.
//
// Self-contained: loads its own credential state and renders nothing when the
// API 403s (non-admins) so it can be dropped into any admin surface. Lives in
// the Settings page; the secret is shown ONCE on generate/rotate (Stripe/
// GitHub/AWS show-once model — no reveal). The one-time secret is presented in
// a centered modal (NOT a toast) so the full 64-char value is fully visible +
// copyable. Generation/rotation are gated on an active subscription/trial
// server-side (402 → surfaced as a toast).
const API = '/api/settings/webhook-credential';

export default function WebhookSigningCredential() {
  const notify = useNotify();
  // GET /api/settings/webhook-credential response. null until loaded / when the
  // endpoint 403s (non-admin) — the panel then renders nothing.
  const [cred, setCred] = useState(null);
  // The one-time secret reveal modal: { secret, verb } | null.
  const [revealed, setRevealed] = useState(null);
  const [copied, setCopied] = useState(false);

  const load = async () => {
    try {
      const c = await fetchApi(API, { silent: true });
      setCred(c);
    } catch (_err) {
      setCred(null);
    }
  };

  useEffect(() => { load(); }, []);

  // Open the one-time reveal modal (best-effort clipboard copy too). This is
  // the ONLY place the raw secret is ever surfaced.
  const announceSecret = (secret, verb) => {
    try { navigator.clipboard.writeText(secret); } catch { /* clipboard may be blocked */ }
    setCopied(false);
    setRevealed({ secret, verb });
  };

  const copySecret = () => {
    if (!revealed) return;
    try { navigator.clipboard.writeText(revealed.secret); } catch { /* ignore */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const generate = async () => {
    try {
      const r = await fetchApi(API, { method: 'POST' });
      if (r?.secret) announceSecret(r.secret, 'generated');
      load();
    } catch (_err) {
      /* fetchApi already toasted the 402 / 409 / 500 message */
    }
  };

  const rotate = async () => {
    if (!(await notify.confirm('Rotate the webhook signing secret? The current secret stops working immediately — you must update GlobusPhone (or any receiver) with the new value.'))) return;
    try {
      const r = await fetchApi(`${API}/rotate`, { method: 'POST' });
      if (r?.secret) announceSecret(r.secret, 'rotated');
      load();
    } catch (_err) {
      /* fetchApi already toasted */
    }
  };

  const revoke = async () => {
    if (!(await notify.confirm('Revoke the webhook signing secret? All outbound webhook delivery for this account stops until you generate a new secret.'))) return;
    try {
      await fetchApi(API, { method: 'DELETE' });
      load();
    } catch (_err) {
      /* fetchApi already toasted */
    }
  };

  if (!cred) return null;

  return (
    <>
      <div className="card" style={{ padding: 'clamp(1.25rem, 3vw, 2rem)' }}>
        <h3 style={{ fontSize: '1.25rem', fontWeight: '600', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <ShieldCheck size={20} color="var(--primary-color, var(--accent-color))" /> Webhook Signing Credential
        </h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: '1.5rem' }}>
          One HMAC secret signs every outbound webhook for your account. Configure it in GlobusPhone (or any receiver)
          so it can verify each delivery. The secret is shown only once — rotate if you lose it.
        </p>

        {/* Not entitled → disable generation, point to /pricing. */}
        {!cred.entitled && !cred.exists && (
          <div style={{ padding: '1rem 1.25rem', background: 'var(--subtle-bg)', border: '1px solid var(--border-color)', borderRadius: '8px', marginBottom: '1.5rem' }}>
            <p style={{ fontSize: '0.9rem', margin: 0 }}>
              Webhook signing is available on an active subscription.{' '}
              <a href="/pricing" style={{ color: 'var(--primary-color, var(--accent-color))', fontWeight: 600 }}>Upgrade to enable →</a>
            </p>
          </div>
        )}

        {/* No credential yet → generate (disabled when not entitled). */}
        {!cred.exists && (
          <button
            className="btn-primary"
            onClick={generate}
            disabled={!cred.entitled}
            title={cred.entitled ? 'Generate a signing secret' : 'Requires an active subscription'}
            style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', opacity: cred.entitled ? 1 : 0.5, cursor: cred.entitled ? 'pointer' : 'not-allowed' }}
          >
            <Plus size={18} /> Generate signing secret
          </button>
        )}

        {/* Credential exists → status, metadata, GlobusPhone config, actions. */}
        {cred.exists && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem', padding: '1.25rem', background: 'var(--subtle-bg)', border: '1px solid var(--border-color)', borderLeft: '3px solid var(--primary-color, var(--accent-color))', borderRadius: '10px' }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
                  <span style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: '1rem', color: 'var(--text-primary)' }}>{cred.signingId}</span>
                  <span style={{
                    fontSize: '0.7rem', padding: '0.2rem 0.65rem', borderRadius: 20, fontWeight: 700, letterSpacing: '0.03em',
                    border: `1px solid ${cred.status === 'ACTIVE' ? 'var(--success-color, #10b981)' : 'var(--danger-color, #ef4444)'}`,
                    background: cred.status === 'ACTIVE' ? 'rgba(16,185,129,0.18)' : 'rgba(239,68,68,0.18)',
                    color: cred.status === 'ACTIVE' ? 'var(--success-color, #10b981)' : 'var(--danger-color, #ef4444)',
                  }}>{cred.status}</span>
                </div>
                <p style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', marginTop: '0.5rem', fontFamily: 'monospace' }}>
                  {cred.secretMasked} <span style={{ opacity: 0.8 }}>· secret hidden — shown once at creation</span>
                </p>
                {cred.lastRotatedAt && (
                  <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.3rem' }}>
                    Last rotated {new Date(cred.lastRotatedAt).toLocaleString()}
                  </p>
                )}
              </div>
              <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
                <button
                  className="btn-secondary"
                  onClick={rotate}
                  disabled={!cred.entitled}
                  title={cred.entitled ? 'Rotate (replace) the secret' : 'Requires an active subscription'}
                  style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.5rem 0.9rem', fontWeight: 600, opacity: cred.entitled ? 1 : 0.5, cursor: cred.entitled ? 'pointer' : 'not-allowed' }}
                >
                  <RotateCw size={16} /> Rotate
                </button>
                <button onClick={revoke} title="Revoke (stops all webhook delivery)" style={{ background: 'rgba(239,68,68,0.12)', border: '1px solid var(--danger-color, #ef4444)', color: 'var(--danger-color, #ef4444)', cursor: 'pointer', borderRadius: 8, padding: '0.5rem 0.9rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <Trash2 size={16} /> Revoke
                </button>
              </div>
            </div>

            {!cred.entitled && (
              <div style={{ padding: '0.75rem 1rem', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '8px', fontSize: '0.85rem', color: 'var(--text-primary)' }}>
                Subscription inactive — outbound webhook delivery is paused until the subscription is renewed.{' '}
                <a href="/pricing" style={{ color: 'var(--primary-color, var(--accent-color))', fontWeight: 600 }}>Renew →</a>
              </div>
            )}

            {/* Receiver-side config block (e.g. GlobusPhone). */}
            {cred.signing && (
              <div style={{ background: 'var(--subtle-bg)', border: '1px solid var(--border-color)', borderRadius: '10px', padding: '1.1rem 1.25rem' }}>
                <p style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: '0.75rem', fontSize: '0.9rem' }}>Receiver configuration (e.g. GlobusPhone)</p>
                <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.4rem 1rem', fontSize: '0.82rem', alignItems: 'baseline' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>Signature header</span>
                  <code style={{ color: 'var(--text-primary)', fontFamily: 'monospace', wordBreak: 'break-all' }}>{cred.signing.header}</code>
                  <span style={{ color: 'var(--text-secondary)' }}>Algorithm</span>
                  <code style={{ color: 'var(--text-primary)', fontFamily: 'monospace' }}>{cred.signing.algorithm}</code>
                  <span style={{ color: 'var(--text-secondary)' }}>Signed payload</span>
                  <code style={{ color: 'var(--text-primary)', fontFamily: 'monospace' }}>{cred.signing.signedPayload}</code>
                  <span style={{ color: 'var(--text-secondary)' }}>Receiver secret env</span>
                  <code style={{ color: 'var(--text-primary)', fontFamily: 'monospace', wordBreak: 'break-all' }}>{cred.signing.receiverEnvVar}</code>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* One-time secret reveal — centered modal so the full 64-char key is
          visible + copyable (replaces the old clipped corner toast). */}
      {revealed && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Webhook signing secret"
          onClick={() => setRevealed(null)}
          style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1.5rem', animation: 'fadeIn 0.2s ease-out' }}
        >
          <div
            className="card"
            onClick={(e) => e.stopPropagation()}
            style={{ width: '100%', maxWidth: 560, padding: '2rem', boxShadow: '0 25px 50px -12px rgba(0,0,0,0.6)', border: '1px solid var(--border-color)' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.5rem' }}>
              <ShieldCheck size={22} color="var(--primary-color, var(--accent-color))" />
              <h3 style={{ fontSize: '1.2rem', fontWeight: 700, margin: 0 }}>
                Webhook signing secret {revealed.verb}
              </h3>
            </div>

            <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-start', padding: '0.75rem 1rem', background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.4)', borderRadius: '8px', margin: '0.75rem 0 1.25rem' }}>
              <AlertTriangle size={18} color="#f59e0b" style={{ flexShrink: 0, marginTop: 2 }} />
              <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-primary)' }}>
                This is the <strong>only time</strong> this secret will be shown. Copy it now and store it securely — if you lose it, rotate the credential and it will not be shown again.
              </p>
            </div>

            <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.4rem' }}>
              Signing secret
            </label>
            <div style={{ position: 'relative', marginBottom: '1.25rem' }}>
              <code
                style={{
                  display: 'block', userSelect: 'all', wordBreak: 'break-all', fontFamily: 'monospace',
                  fontSize: '0.9rem', lineHeight: 1.5, color: 'var(--text-primary)',
                  background: 'var(--subtle-bg)', border: '1px solid var(--border-color)', borderRadius: '8px',
                  padding: '0.85rem 1rem',
                }}
              >
                {revealed.secret}
              </code>
            </div>

            <p style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', margin: '0 0 1.25rem' }}>
              Paste this into GlobusPhone (or any receiver) as <code style={{ fontFamily: 'monospace', color: 'var(--text-primary)' }}>WEBHOOK_HMAC_SECRET_CRM</code>.
            </p>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
              <button
                className="btn-secondary"
                onClick={copySecret}
                style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.55rem 1rem', fontWeight: 600 }}
              >
                {copied ? <Check size={16} /> : <Copy size={16} />} {copied ? 'Copied!' : 'Copy secret'}
              </button>
              <button
                className="btn-primary"
                onClick={() => setRevealed(null)}
                style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.55rem 1.1rem', fontWeight: 600 }}
              >
                <X size={16} /> Done
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
