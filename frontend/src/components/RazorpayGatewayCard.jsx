import React, { useCallback, useEffect, useState } from 'react';
import { CreditCard, CheckCircle, AlertTriangle, Save, Loader2, Lock, RotateCw, X, Trash2 } from 'lucide-react';
import { fetchApi } from '../utils/api';

// ─────────────────────────────────────────────────────────────────
// Per-tenant Razorpay key configuration (#848 minimal slice).
//
// Lets a tenant ADMIN store THEIR OWN Razorpay merchant keys so their
// customers' payments (invoices, memberships, gift cards) settle into the
// tenant's own account. Distinct from the platform's subscription gateway
// (Globussoft's env-var keys), which this card does NOT touch.
//
// Two modes:
//   • VIEW   — once keys are saved, the card shows ONLY a masked summary
//              (no editable fields, no last-4 of the secret) + a
//              "Reconfigure" button. Entered credentials are never echoed
//              back into editable inputs.
//   • EDIT   — first-time setup, or after clicking Reconfigure. Secrets are
//              blank password fields; leaving a secret blank on save keeps
//              the stored value (masked-sentinel contract on the backend).
// ─────────────────────────────────────────────────────────────────

const GLASS = {
  background: 'var(--surface-color)',
  border: '1px solid var(--border-color)',
  backdropFilter: 'blur(12px)',
  borderRadius: '12px',
};

const inputStyle = {
  width: '100%',
  padding: '0.6rem 0.75rem',
  borderRadius: 8,
  border: '1px solid var(--border-color)',
  background: 'var(--input-bg)',
  color: 'var(--text-primary)',
  fontSize: '0.85rem',
};

const labelStyle = {
  display: 'block',
  fontSize: '0.78rem',
  fontWeight: 600,
  marginBottom: '0.3rem',
  color: 'var(--text-secondary)',
};

// Mask a Razorpay Key ID for the read-only summary: keep the rzp_live_/
// rzp_test_ prefix + last 4, redact the middle. Never show the full id.
function maskKeyId(keyId) {
  if (!keyId) return '—';
  const m = /^(rzp_(?:live|test)_)(.*)$/.exec(keyId);
  if (!m) return `••••${keyId.slice(-4)}`;
  const tail = m[2].length > 4 ? m[2].slice(-4) : m[2];
  return `${m[1]}••••${tail}`;
}

export default function RazorpayGatewayCard() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [editMode, setEditMode] = useState(false);

  // Stored state (masked) from the backend.
  const [stored, setStored] = useState(null); // { keyId, keySecret:{configured,last4}, webhookSecret:{...}, isActive, lastRotatedAt }

  // Editable form fields. Secrets ALWAYS start blank — typing rotates, blank keeps.
  const [keyId, setKeyId] = useState('');
  const [keySecret, setKeySecret] = useState('');
  const [isActive, setIsActive] = useState(false);

  // A row counts as "configured" once it has a key id + a stored secret.
  const hasConfig = !!stored && !!stored.keyId && !!stored.keySecret?.configured;

  const applyStored = useCallback((row) => {
    setStored(row || null);
    setKeyId(row?.keyId || '');
    setIsActive(!!row?.isActive);
    // The secret is NEVER pre-filled into the input.
    setKeySecret('');
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await fetchApi('/api/payment-gateways');
      const row = Array.isArray(rows)
        ? rows.find((r) => r.provider === 'razorpay')
        : null;
      applyStored(row);
      // First-time setup (no config) opens the form directly; an existing
      // config stays locked in view mode until the admin clicks Reconfigure.
      setEditMode(!(row && row.keyId && row.keySecret?.configured));
    } catch (err) {
      setError(err.message || 'Failed to fetch payment gateway config');
    } finally {
      setLoading(false);
    }
  }, [applyStored]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const body = { keyId, isActive };
      // Only send the secret the operator actually typed — blank means "keep".
      if (keySecret) body.keySecret = keySecret;
      const res = await fetchApi('/api/payment-gateways/razorpay', {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      applyStored(res.config || null);
      setNotice('Razorpay configuration saved.');
      // Lock back to the masked summary once a usable config exists.
      const saved = res.config;
      if (saved && saved.keyId && saved.keySecret?.configured) setEditMode(false);
    } catch (err) {
      setError(err.message || 'Failed to save Razorpay configuration');
    } finally {
      setSaving(false);
    }
  }, [keyId, keySecret, isActive, applyStored]);

  const startReconfigure = useCallback(() => {
    setNotice(null);
    setError(null);
    // Reset editable fields to a clean slate — keyId is non-secret so we
    // prefill it for convenience; secrets stay blank (keep-unless-typed).
    setKeyId(stored?.keyId || '');
    setKeySecret('');
    setIsActive(!!stored?.isActive);
    setEditMode(true);
  }, [stored]);

  const cancelReconfigure = useCallback(() => {
    applyStored(stored);
    setEditMode(false);
    setError(null);
  }, [stored, applyStored]);

  const handleDelete = useCallback(async () => {
    if (!window.confirm(
      'Remove your Razorpay configuration? Customer payments (invoices, memberships, gift cards) will stop working until you add keys again. Your past payment history is preserved.'
    )) return;
    setDeleting(true);
    setError(null);
    setNotice(null);
    try {
      await fetchApi('/api/payment-gateways/razorpay', { method: 'DELETE' });
      applyStored(null);
      setEditMode(true); // back to the empty first-time form
      setNotice('Razorpay configuration removed.');
    } catch (err) {
      setError(err.message || 'Failed to remove Razorpay configuration');
    } finally {
      setDeleting(false);
    }
  }, [applyStored]);

  const Header = (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem', marginBottom: '1rem' }}>
      <CreditCard size={20} style={{ color: '#3395ff', flexShrink: 0, marginTop: '0.15rem' }} />
      <div style={{ flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600, fontSize: '0.98rem' }}>
            Customer Payments — Your Razorpay Account
          </span>
          {hasConfig && stored.isActive ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.72rem', fontWeight: 600, color: '#10b981', background: 'rgba(16,185,129,0.15)', border: '1px solid #10b98133', padding: '0.15rem 0.5rem', borderRadius: 999 }}>
              <CheckCircle size={12} /> Active
            </span>
          ) : hasConfig ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.72rem', fontWeight: 600, color: '#9ca3af', background: 'rgba(156,163,175,0.15)', border: '1px solid #9ca3af33', padding: '0.15rem 0.5rem', borderRadius: 999 }}>
              Disabled
            </span>
          ) : (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.72rem', fontWeight: 600, color: '#f59e0b', background: 'rgba(245,158,11,0.12)', border: '1px solid #f59e0b33', padding: '0.15rem 0.5rem', borderRadius: 999 }}>
              <AlertTriangle size={12} /> Not configured
            </span>
          )}
        </div>
        <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.3rem' }}>
          Enter your own Razorpay merchant keys so payments from your customers (invoices, memberships, gift cards) settle directly into <strong>your</strong> account. This is separate from your Globussoft subscription billing.
        </div>
      </div>
    </div>
  );

  return (
    <div style={{ ...GLASS, padding: '1.25rem', marginBottom: '1.5rem' }}>
      {Header}

      {error && (
        <div style={{ background: 'rgba(239,68,68,0.12)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)', padding: '0.6rem 0.8rem', borderRadius: 8, marginBottom: '0.9rem', fontSize: '0.82rem' }}>
          {error}
        </div>
      )}
      {notice && (
        <div style={{ background: 'rgba(16,185,129,0.12)', color: '#10b981', border: '1px solid rgba(16,185,129,0.3)', padding: '0.6rem 0.8rem', borderRadius: 8, marginBottom: '0.9rem', fontSize: '0.82rem' }}>
          {notice}
        </div>
      )}

      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
          <Loader2 size={16} className="spin" /> Loading…
        </div>
      ) : !editMode && hasConfig ? (
        // ── VIEW MODE: masked summary, no editable fields ──────────────
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.75rem' }}>
            <SummaryItem label="Key ID" value={maskKeyId(stored.keyId)} />
            <SummaryItem
              label="Key Secret"
              value={stored.keySecret?.configured ? 'Configured · hidden' : 'Not set'}
              ok={stored.keySecret?.configured}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
            <Lock size={13} /> Your secret keys are encrypted and never displayed again. Click Reconfigure to replace them.
          </div>
          <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
            <button
              onClick={startReconfigure}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '0.45rem',
                padding: '0.55rem 1.1rem', background: 'transparent',
                color: 'var(--text-primary)', border: '1px solid var(--border-color, rgba(255,255,255,0.2))',
                borderRadius: 8, fontWeight: 600, fontSize: '0.83rem', cursor: 'pointer',
              }}
            >
              <RotateCw size={15} /> Reconfigure
            </button>
            <button
              onClick={handleDelete}
              disabled={deleting}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '0.45rem',
                padding: '0.55rem 1.1rem', background: 'transparent',
                color: '#ef4444', border: '1px solid rgba(239,68,68,0.4)',
                borderRadius: 8, fontWeight: 600, fontSize: '0.83rem',
                cursor: deleting ? 'not-allowed' : 'pointer', opacity: deleting ? 0.6 : 1,
              }}
            >
              {deleting ? <Loader2 size={15} className="spin" /> : <Trash2 size={15} />}
              {deleting ? 'Removing…' : 'Remove'}
            </button>
          </div>
        </div>
      ) : (
        // ── EDIT MODE: the form ────────────────────────────────────────
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
          <div>
            <label style={labelStyle}>Razorpay Key ID</label>
            <input
              style={inputStyle}
              type="text"
              placeholder="rzp_live_xxxxxxxxxxxx"
              value={keyId}
              onChange={(e) => setKeyId(e.target.value)}
              autoComplete="off"
            />
            <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
              From dashboard.razorpay.com → Settings → API Keys.
            </div>
          </div>

          <div>
            <label style={labelStyle}>
              Key Secret{' '}
              {stored?.keySecret?.configured && (
                <span style={{ fontWeight: 400, color: '#10b981' }}>· already set — leave blank to keep</span>
              )}
            </label>
            <input
              style={inputStyle}
              type="password"
              placeholder={stored?.keySecret?.configured ? '•••••••• (unchanged)' : 'Enter Key Secret'}
              value={keySecret}
              onChange={(e) => setKeySecret(e.target.value)}
              autoComplete="new-password"
            />
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
            />
            Enable Razorpay for customer payments
          </label>

          <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
            <button
              onClick={handleSave}
              disabled={saving}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '0.45rem',
                padding: '0.6rem 1.2rem',
                background: 'var(--primary-color, var(--accent-color))',
                color: 'white', border: 'none', borderRadius: 8,
                fontWeight: 600, fontSize: '0.85rem',
                cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.6 : 1,
              }}
            >
              {saving ? <Loader2 size={15} className="spin" /> : <Save size={15} />}
              {saving ? 'Saving…' : 'Save Razorpay keys'}
            </button>
            {hasConfig && (
              <button
                onClick={cancelReconfigure}
                disabled={saving}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: '0.45rem',
                  padding: '0.6rem 1.1rem', background: 'transparent',
                  color: 'var(--text-secondary)', border: '1px solid var(--border-color, rgba(255,255,255,0.2))',
                  borderRadius: 8, fontWeight: 600, fontSize: '0.83rem', cursor: 'pointer',
                }}
              >
                <X size={15} /> Cancel
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryItem({ label, value, ok }) {
  return (
    <div>
      <div style={{ color: 'var(--text-secondary)', fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 3 }}>{label}</div>
      <div style={{ fontWeight: 500, fontSize: '0.86rem', color: ok ? '#10b981' : 'var(--text-primary)', wordBreak: 'break-all' }}>{value}</div>
    </div>
  );
}
