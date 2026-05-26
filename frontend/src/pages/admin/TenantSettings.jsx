/**
 * TenantSettings.jsx — ADMIN-only operator UI for per-tenant cap overrides.
 *
 * Consumes /api/tenant-settings (backend route commit 1542b8e, helper at
 * backend/lib/tenantSettings.js KEYS + DEFAULTS). Completes the per-tenant
 * cap pattern end-to-end:
 *   helper (cb0901f) + 4 consumers (llmRouter, adsGptClient, ratehawkClient,
 *   callifiedClient) + backend CRUD (1542b8e) + admin UI (this page).
 *
 * Endpoint shape (from backend/routes/tenant_settings.js):
 *   GET  /api/tenant-settings        → { settings:[{key,value,category}], defaults:{key:cents}, allowedKeys:[...] }
 *   PUT  /api/tenant-settings/:key   { value: "<cents-as-string>", category? } → 200 envelope
 *   DELETE /api/tenant-settings/:key → 204 (override removed → next read falls back to env-default)
 *
 * UX shape — one card per known cap key (4 cards: AdsGPT / AI calling /
 * RateHawk / LLM). Each card shows the current effective value, the env-var
 * default, an "OVERRIDE" badge when a TenantSetting row exists, an input
 * (in dollars; converted × 100 → cents before PUT), Save, and (when
 * overridden) Revert-to-default.
 *
 * Dollar↔cent boundary: the DB / cap helper / consumers all speak cents
 * (Number). This UI is the only place a human sees / types dollars. We
 * round-trip with Math.round(parseFloat(dollarInput) * 100) on save and
 * (cents / 100).toFixed(2) on display so an admin who types "50.00" gets
 * 5000 cents back.
 */

import { useEffect, useMemo, useState } from 'react';
import { DollarSign, Save, RotateCcw, AlertCircle, Check } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';

// Mirror backend/lib/tenantSettings.js KEYS exactly — backend validation
// rejects any key not in the allowlist. Order = render order.
const KNOWN_CAPS = [
  {
    key: 'budgetCap_adsgpt_monthly_usd_cents',
    label: 'AdsGPT monthly cap',
    integration: 'AdsGPT',
    description: 'Maximum monthly spend on AdsGPT lead-generation campaigns. Hard-stop at cap; alert at 80%.',
  },
  {
    key: 'budgetCap_ai_calling_monthly_usd_cents',
    label: 'AI calling monthly cap',
    integration: 'Callified.ai',
    description: 'Maximum monthly spend on Callified.ai voice + WhatsApp AI calls. Hard-stop at cap; 90s per-call ceiling enforced separately.',
  },
  {
    key: 'budgetCap_ratehawk_monthly_usd_cents',
    label: 'RateHawk monthly cap',
    integration: 'RateHawk hotel search',
    description: 'Maximum monthly spend on RateHawk hotel-availability lookups (travel vertical only).',
  },
  {
    key: 'budgetCap_llm_monthly_usd_cents',
    label: 'LLM monthly cap',
    integration: 'LLM router (Claude / GPT-4)',
    description: 'Maximum monthly spend across the LLM router consumers (talking-points / form-vs-call / itinerary-draft / religious-guidance).',
  },
];

function centsToDollarString(cents) {
  const n = Number(cents);
  if (!Number.isFinite(n)) return '0.00';
  return (n / 100).toFixed(2);
}

function dollarStringToCents(dollarStr) {
  const n = parseFloat(String(dollarStr).replace(/[^0-9.-]/g, ''));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

export default function TenantSettings() {
  const notify = useNotify();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [response, setResponse] = useState({ settings: [], defaults: {}, allowedKeys: [] });
  // per-key local edit state: { [key]: dollarString }
  const [editing, setEditing] = useState({});
  // per-key save-in-flight: { [key]: 'saving'|'reverting'|null }
  const [busy, setBusy] = useState({});

  const load = async () => {
    setLoading(true);
    setLoadError('');
    try {
      const data = await fetchApi('/api/tenant-settings');
      setResponse(data || { settings: [], defaults: {}, allowedKeys: [] });
      // Hydrate editing inputs with current effective values (override or default).
      const seed = {};
      KNOWN_CAPS.forEach(({ key }) => {
        const row = (data?.settings || []).find((s) => s.key === key);
        const effective = row ? Number(row.value) : Number(data?.defaults?.[key] ?? 0);
        seed[key] = centsToDollarString(effective);
      });
      setEditing(seed);
    } catch (e) {
      setLoadError(e.message || 'Failed to load tenant settings');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  // Index settings by key for fast lookup in the render loop.
  const overrideByKey = useMemo(() => {
    const m = {};
    (response.settings || []).forEach((s) => {
      m[s.key] = s;
    });
    return m;
  }, [response.settings]);

  const handleSave = async (key, label) => {
    const dollarStr = editing[key];
    const cents = dollarStringToCents(dollarStr);
    if (cents == null) {
      notify.error(`Invalid amount for ${label}. Enter a non-negative dollar value (e.g. 50.00).`);
      return;
    }
    setBusy((b) => ({ ...b, [key]: 'saving' }));
    try {
      await fetchApi(`/api/tenant-settings/${encodeURIComponent(key)}`, {
        method: 'PUT',
        body: JSON.stringify({ value: String(cents) }),
      });
      notify.success(`Updated ${label} to $${(cents / 100).toFixed(2)}/mo (effective immediately)`);
      await load();
    } catch (e) {
      // fetchApi auto-toasts the server message; nothing more to do here.
      console.error('[tenant-settings] save failed', e);
    } finally {
      setBusy((b) => ({ ...b, [key]: null }));
    }
  };

  const handleRevert = async (key, label) => {
    const ok = await notify.confirm(`Revert ${label} to the environment default? The current override will be deleted.`);
    if (!ok) return;
    setBusy((b) => ({ ...b, [key]: 'reverting' }));
    try {
      await fetchApi(`/api/tenant-settings/${encodeURIComponent(key)}`, { method: 'DELETE' });
      notify.success(`Reverted ${label} to environment default`);
      await load();
    } catch (e) {
      console.error('[tenant-settings] revert failed', e);
    } finally {
      setBusy((b) => ({ ...b, [key]: null }));
    }
  };

  return (
    <div style={{ padding: '2rem', height: '100%', overflowY: 'auto', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '1.5rem' }}>
        <h1
          style={{
            fontSize: '2rem',
            fontWeight: 'bold',
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem',
            margin: 0,
          }}
        >
          <DollarSign size={28} color="var(--primary-color, var(--accent-color))" /> Tenant Settings
        </h1>
        <p style={{ color: 'var(--text-secondary)', marginTop: '0.4rem', maxWidth: '760px' }}>
          Per-tenant overrides for budget caps + feature flags. Override the environment-variable defaults that
          apply across all tenants. Changes take effect immediately on the next API call from a cap-aware consumer.
        </p>
      </header>

      {loadError && (
        <div
          className="card"
          style={{
            padding: '0.9rem 1.1rem',
            marginBottom: '1.25rem',
            borderLeft: '4px solid #ef4444',
            color: '#ef4444',
            fontSize: '0.9rem',
            display: 'flex',
            alignItems: 'center',
            gap: '0.6rem',
          }}
        >
          <AlertCircle size={18} />
          <div style={{ flex: 1 }}>{loadError}</div>
          <button onClick={load} className="btn-primary" style={{ padding: '0.35rem 0.85rem', fontSize: '0.82rem' }}>
            Retry
          </button>
        </div>
      )}

      {loading ? (
        <div className="card" style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
          Loading tenant settings…
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 360px), 1fr))',
            gap: '1.25rem',
          }}
        >
          {KNOWN_CAPS.map(({ key, label, integration, description }) => {
            const defaultCents = Number(response.defaults?.[key] ?? 0);
            const row = overrideByKey[key];
            const isOverride = Boolean(row);
            const effectiveCents = isOverride ? Number(row.value) : defaultCents;
            const currentDollarInput = editing[key] ?? centsToDollarString(effectiveCents);
            const isDirty = dollarStringToCents(currentDollarInput) !== effectiveCents;
            const state = busy[key] || null;

            return (
              <div
                key={key}
                className="card"
                style={{
                  padding: '1.25rem',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.85rem',
                }}
                data-testid={`tenant-setting-card-${key}`}
              >
                {/* Header: label + override badge */}
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '0.5rem' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '1.05rem', fontWeight: 600, color: 'var(--text-primary)' }}>{label}</div>
                    <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: '0.2rem' }}>
                      {integration}
                    </div>
                  </div>
                  {isOverride ? (
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.3rem',
                        padding: '0.22rem 0.55rem',
                        borderRadius: '999px',
                        background: 'rgba(34, 197, 94, 0.15)',
                        border: '1px solid #22c55e',
                        color: '#22c55e',
                        fontSize: '0.7rem',
                        fontWeight: 600,
                        letterSpacing: '0.04em',
                        textTransform: 'uppercase',
                      }}
                    >
                      <Check size={11} /> Override
                    </span>
                  ) : (
                    <span
                      style={{
                        display: 'inline-block',
                        padding: '0.22rem 0.55rem',
                        borderRadius: '999px',
                        background: 'rgba(120, 120, 120, 0.18)',
                        border: '1px solid rgba(160,160,160,0.4)',
                        color: 'var(--text-secondary)',
                        fontSize: '0.7rem',
                        fontWeight: 600,
                        letterSpacing: '0.04em',
                        textTransform: 'uppercase',
                      }}
                    >
                      Default
                    </span>
                  )}
                </div>

                <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
                  {description}
                </p>

                {/* Effective + default summary row */}
                <div
                  style={{
                    display: 'flex',
                    gap: '1.25rem',
                    flexWrap: 'wrap',
                    padding: '0.7rem 0.9rem',
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid var(--border-color, rgba(255,255,255,0.06))',
                    borderRadius: '8px',
                  }}
                >
                  <div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      Current
                    </div>
                    <div style={{ fontSize: '1.15rem', fontWeight: 700, color: 'var(--text-primary)', marginTop: '0.15rem' }}>
                      ${centsToDollarString(effectiveCents)}
                      <span style={{ fontSize: '0.75rem', fontWeight: 400, color: 'var(--text-secondary)', marginLeft: '0.25rem' }}>
                        /mo
                      </span>
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      Default
                    </div>
                    <div style={{ fontSize: '1.05rem', fontWeight: 500, color: 'var(--text-secondary)', marginTop: '0.15rem' }}>
                      ${centsToDollarString(defaultCents)}
                      <span style={{ fontSize: '0.7rem', marginLeft: '0.25rem' }}>/mo</span>
                    </div>
                  </div>
                </div>

                {/* Edit input */}
                <div>
                  <label
                    htmlFor={`input-${key}`}
                    style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '0.3rem' }}
                  >
                    New cap (USD per month)
                  </label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    <div
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        padding: '0.1rem 0.6rem 0.1rem 0.7rem',
                        borderRadius: '8px',
                        border: '1px solid var(--border-color, rgba(255,255,255,0.12))',
                        background: 'var(--surface-color, rgba(255,255,255,0.04))',
                        flex: 1,
                      }}
                    >
                      <span style={{ color: 'var(--text-secondary)', fontSize: '0.95rem', marginRight: '0.25rem' }}>$</span>
                      <input
                        id={`input-${key}`}
                        type="number"
                        min="0"
                        step="0.01"
                        value={currentDollarInput}
                        onChange={(e) => setEditing((prev) => ({ ...prev, [key]: e.target.value }))}
                        disabled={Boolean(state)}
                        data-testid={`tenant-setting-input-${key}`}
                        style={{
                          flex: 1,
                          background: 'transparent',
                          border: 'none',
                          outline: 'none',
                          color: 'var(--text-primary)',
                          fontSize: '0.95rem',
                          padding: '0.5rem 0',
                          width: '100%',
                        }}
                      />
                    </div>
                  </div>
                </div>

                {/* Actions */}
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <button
                    onClick={() => handleSave(key, label)}
                    disabled={!isDirty || Boolean(state)}
                    className="btn-primary"
                    data-testid={`tenant-setting-save-${key}`}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.4rem',
                      opacity: !isDirty || state ? 0.6 : 1,
                      cursor: !isDirty || state ? 'not-allowed' : 'pointer',
                    }}
                  >
                    <Save size={14} />
                    {state === 'saving' ? 'Saving…' : 'Save'}
                  </button>
                  {isOverride && (
                    <button
                      onClick={() => handleRevert(key, label)}
                      disabled={Boolean(state)}
                      data-testid={`tenant-setting-revert-${key}`}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.4rem',
                        padding: '0.5rem 0.9rem',
                        borderRadius: '8px',
                        background: 'transparent',
                        border: '1px solid var(--border-color, rgba(255,255,255,0.12))',
                        color: 'var(--text-secondary)',
                        cursor: state ? 'not-allowed' : 'pointer',
                        fontSize: '0.85rem',
                        opacity: state ? 0.6 : 1,
                      }}
                    >
                      <RotateCcw size={14} />
                      {state === 'reverting' ? 'Reverting…' : 'Revert to default'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
