import React, { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  CreditCard,
  DollarSign,
  CheckCircle,
  XCircle,
  RefreshCw,
  Clock,
  X,
  Settings as SettingsIcon,
  AlertTriangle,
  Plus,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { fetchApi } from '../utils/api';
import { AuthContext } from '../App';
import { formatMoney } from '../utils/money';
import { DateRangeFilter, resolveDateRange, DATE_FILTER_OPTIONS } from '../components/wellness/DateRangeFilter';

// ── Style constants ───────────────────────────────────────────────
const GLASS = {
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid rgba(255,255,255,0.1)',
  backdropFilter: 'blur(12px)',
  borderRadius: '12px',
};

const STATUS_CONFIG = {
  SUCCESS:  { color: '#10b981', bg: 'rgba(16,185,129,0.15)', label: 'Success', Icon: CheckCircle },
  PENDING:  { color: '#f59e0b', bg: 'rgba(245,158,11,0.15)', label: 'Pending', Icon: Clock },
  FAILED:   { color: '#ef4444', bg: 'rgba(239,68,68,0.15)', label: 'Failed',  Icon: XCircle },
  REFUNDED: { color: '#9ca3af', bg: 'rgba(156,163,175,0.15)', label: 'Refunded', Icon: RefreshCw },
};

const GATEWAY_CONFIG = {
  stripe:   { color: '#635bff', bg: 'rgba(99,91,255,0.15)', label: 'Stripe' },
  razorpay: { color: '#3395ff', bg: 'rgba(51,149,255,0.15)', label: 'Razorpay' },
};

function StatusBadge({ status }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.PENDING;
  const Icon = cfg.Icon;
  return (
    <span style={{
      padding: '0.25rem 0.6rem',
      borderRadius: '999px',
      fontSize: '0.72rem',
      fontWeight: 600,
      backgroundColor: cfg.bg,
      color: cfg.color,
      border: `1px solid ${cfg.color}33`,
      display: 'inline-flex',
      alignItems: 'center',
      gap: '0.3rem',
    }}>
      <Icon size={12} />
      {cfg.label}
    </span>
  );
}

function GatewayBadge({ gateway }) {
  const key = String(gateway || '').toLowerCase();
  const cfg = GATEWAY_CONFIG[key] || { color: '#9ca3af', bg: 'rgba(156,163,175,0.15)', label: gateway || 'Unknown' };
  return (
    <span style={{
      padding: '0.2rem 0.6rem',
      borderRadius: '6px',
      fontSize: '0.7rem',
      fontWeight: 600,
      backgroundColor: cfg.bg,
      color: cfg.color,
      border: `1px solid ${cfg.color}33`,
      textTransform: 'capitalize',
    }}>
      {cfg.label}
    </span>
  );
}

// #286: use the canonical formatMoney() helper so wellness (INR) tenants no
// longer see "$" on the dashboard. If the row carries its own currency
// (multi-currency tenants), respect it; otherwise fall back to tenant default.
function formatCurrency(amount, currency) {
  return formatMoney(amount || 0, currency ? { currency } : undefined);
}

function formatDate(value) {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

export default function Payments() {
  const { user } = useContext(AuthContext) || {};
  const isAdmin = user?.role === 'ADMIN';

  const [payments, setPayments] = useState([]);
  const [config, setConfig] = useState(null);
  const [tab, setTab] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  // Default to last30 to preserve the prior "Total Collected (30D)" semantics —
  // user can now switch to today / this week / this month / this year / custom
  // and the KPI label and table follow.
  const [dateFilter, setDateFilter] = useState({ preset: 'last30', start: '', end: '' });
  const [rangeStart, rangeEnd] = resolveDateRange(dateFilter);
  const filterLabel = useMemo(() => {
    const o = DATE_FILTER_OPTIONS.find((x) => x.value === dateFilter.preset);
    return o ? o.label : 'All time';
  }, [dateFilter.preset]);

  useEffect(() => {
    loadAll();
  }, []);

  async function loadAll() {
    setLoading(true);
    setError('');
    try {
      const [list, cfg] = await Promise.all([
        fetchApi('/api/payments').catch(() => []),
        fetchApi('/api/payments/config').catch(() => null),
      ]);
      setPayments(Array.isArray(list) ? list : []);
      setConfig(cfg);
    } catch (err) {
      setError(err.message || 'Failed to load payments');
    } finally {
      setLoading(false);
    }
  }

  // Row date: paidAt when set (SUCCESS / REFUNDED), createdAt otherwise.
  // useCallback so it's stable across renders for the useMemo dep arrays below.
  const inDateRange = useCallback((p) => {
    if (!rangeStart || !rangeEnd) return true;
    const ts = new Date(p.paidAt || p.createdAt).getTime();
    return ts >= rangeStart.getTime() && ts <= rangeEnd.getTime();
  }, [rangeStart, rangeEnd]);

  const filtered = useMemo(() => {
    return payments.filter((p) => {
      if (tab !== 'all' && String(p.gateway || '').toLowerCase() !== tab) return false;
      return inDateRange(p);
    });
  }, [payments, tab, inDateRange]);

  const stats = useMemo(() => {
    let collected = 0, pending = 0, failed = 0;
    for (const p of payments) {
      if (!inDateRange(p)) continue;
      if (p.status === 'SUCCESS') collected += Number(p.amount || 0);
      else if (p.status === 'PENDING') pending += 1;
      else if (p.status === 'FAILED') failed += 1;
    }
    return { collected, pending, failed };
  }, [payments, inDateRange]);

  // ── Render ─────────────────────────────────────────────────────
  return (
    <div style={{ padding: '2rem', color: 'var(--text-primary)', minHeight: '100vh' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <CreditCard size={28} style={{ color: '#635bff' }} />
          <h1 style={{ margin: 0, fontSize: '1.75rem', fontWeight: 700 }}>Payments</h1>
        </div>
        <button
          onClick={loadAll}
          disabled={loading}
          style={{
            ...GLASS,
            padding: '0.5rem 1rem',
            color: 'var(--text-primary)',
            cursor: loading ? 'not-allowed' : 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.4rem',
            fontSize: '0.85rem',
          }}
        >
          <RefreshCw size={14} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
          Refresh
        </button>
      </div>

      <p style={{ margin: '0 0 1.5rem 0', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
        Customer payment UI is implemented at the invoice level (separate page) — this dashboard is for tenants to track received payments.
      </p>

      {error && (
        <div style={{
          ...GLASS,
          padding: '0.8rem 1rem',
          marginBottom: '1rem',
          borderColor: 'rgba(239,68,68,0.3)',
          color: '#ef4444',
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
        }}>
          <AlertTriangle size={16} /> {error}
        </div>
      )}

      {/* #371: surface a clear configuration banner when neither Stripe
          nor Razorpay is wired up. Previously the page rendered a
          "Configure provider →" button that linked to /settings, but
          /settings has no payment-config UI (#560 — pen-test 2026-05-07).
          Key storage is env-var-driven, not DB-backed, so the honest UX
          is to name the env vars + direct admins to ops. The full
          DB-backed provider-config UI is tracked separately. */}
      {!loading && config && !config?.stripe?.configured && !config?.razorpay?.configured && (
        <div style={{
          ...GLASS,
          padding: '1rem 1.25rem',
          marginBottom: '1.5rem',
          borderColor: 'rgba(245,158,11,0.35)',
          background: 'rgba(245,158,11,0.08)',
        }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem', marginBottom: '0.75rem' }}>
            <AlertTriangle size={18} style={{ color: '#f59e0b', flexShrink: 0, marginTop: '0.15rem' }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: '0.95rem', marginBottom: '0.2rem' }}>
                Stripe / Razorpay not configured
              </div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                Payment-gateway keys are configured server-side as environment variables (not via this UI). Ask your administrator to set the variables below and restart the backend. Activating either gateway will enable the payment table + the per-invoice Pay-Now flow.
              </div>
            </div>
          </div>
          <div style={{ marginLeft: '2.5rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <details style={{ background: 'rgba(0,0,0,0.18)', borderRadius: 6, padding: '0.5rem 0.75rem' }}>
              <summary style={{ fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer' }}>Stripe — required env vars</summary>
              <pre style={{ fontSize: '0.75rem', margin: '0.5rem 0 0 0', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>
{`STRIPE_SECRET_KEY=sk_live_...        # from dashboard.stripe.com → Developers → API keys
STRIPE_WEBHOOK_SECRET=whsec_...     # from dashboard.stripe.com → Developers → Webhooks
                                      # endpoint URL: <BASE_URL>/api/payments/webhook/stripe`}</pre>
            </details>
            <details style={{ background: 'rgba(0,0,0,0.18)', borderRadius: 6, padding: '0.5rem 0.75rem' }}>
              <summary style={{ fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer' }}>Razorpay — required env vars</summary>
              <pre style={{ fontSize: '0.75rem', margin: '0.5rem 0 0 0', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>
{`RAZORPAY_KEY_ID=rzp_live_...        # from dashboard.razorpay.com → Settings → API Keys
RAZORPAY_KEY_SECRET=...
RAZORPAY_WEBHOOK_SECRET=...         # from dashboard.razorpay.com → Settings → Webhooks
                                      # endpoint URL: <BASE_URL>/api/payments/webhook/razorpay`}</pre>
            </details>
          </div>
        </div>
      )}

      {/* Stats row — labels are window-aware so the KPI value the user sees
          always matches what the date filter is showing. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
        <StatCard
          icon={<DollarSign size={20} />}
          label={`Total Collected (${filterLabel})`}
          value={formatMoney(stats.collected)}
          color="#10b981"
        />
        <StatCard
          icon={<Clock size={20} />}
          label={`Pending (${filterLabel})`}
          value={stats.pending}
          color="#f59e0b"
        />
        <StatCard
          icon={<XCircle size={20} />}
          label={`Failed (${filterLabel})`}
          value={stats.failed}
          color="#ef4444"
        />
      </div>

      {/* Gateway chips + date filter — share a row, gateway chips on the left,
          date picker right-pinned via marginLeft: auto so they wrap together
          when the viewport narrows. */}
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: '0.5rem',
          marginBottom: '1rem', flexWrap: 'wrap',
        }}
      >
        {['all', 'stripe', 'razorpay'].map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: '0.5rem 1.1rem',
              borderRadius: '8px',
              border: tab === t ? '1px solid rgba(99,91,255,0.5)' : '1px solid rgba(255,255,255,0.1)',
              background: tab === t ? 'rgba(99,91,255,0.18)' : 'rgba(255,255,255,0.04)',
              color: 'var(--text-primary)',
              cursor: 'pointer',
              fontSize: '0.85rem',
              textTransform: 'capitalize',
              fontWeight: tab === t ? 600 : 400,
            }}
          >
            {t === 'all' ? 'All' : t}
          </button>
        ))}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <DateRangeFilter value={dateFilter} onChange={setDateFilter} />
        </div>
      </div>

      {/* Payments table */}
      <div style={{ ...GLASS, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
          <thead>
            <tr style={{ background: 'rgba(255,255,255,0.04)' }}>
              <Th>Invoice #</Th>
              <Th>Amount</Th>
              <Th>Gateway</Th>
              <Th>Status</Th>
              <Th>Paid Date</Th>
              <Th>Created</Th>
              <Th>Actions</Th>
            </tr>
          </thead>
          <tbody>
            {/* #372: empty-state with column headers visible above (the
                <thead> sits outside this conditional) plus an explicit
                "Process your first payment" CTA. Previously the empty
                ledger rendered as a single grey "No payments found."
                line under what looked like a blank box. */}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} style={{ padding: '3rem 2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
                  {loading ? (
                    'Loading payments...'
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.75rem' }}>
                      <CreditCard size={36} style={{ opacity: 0.35, color: '#635bff' }} />
                      <div style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                        No payments yet
                      </div>
                      <div style={{ fontSize: '0.82rem', maxWidth: 380 }}>
                        Once a customer pays an invoice via Stripe or Razorpay, the
                        transaction will appear here with status, amount, and gateway details.
                      </div>
                      <Link
                        to="/invoices"
                        style={{
                          marginTop: '0.4rem',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '0.4rem',
                          padding: '0.5rem 1rem',
                          background: 'rgba(99,91,255,0.18)',
                          border: '1px solid rgba(99,91,255,0.4)',
                          borderRadius: '8px',
                          color: '#a4a0ff',
                          fontSize: '0.85rem',
                          fontWeight: 600,
                          textDecoration: 'none',
                        }}
                      >
                        <Plus size={14} /> Process your first payment
                      </Link>
                    </div>
                  )}
                </td>
              </tr>
            )}
            {filtered.map(p => (
              <tr
                key={p.id}
                onClick={() => setSelected(p)}
                style={{
                  borderTop: '1px solid rgba(255,255,255,0.06)',
                  cursor: 'pointer',
                  transition: 'background 0.15s',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.04)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <Td>{p.invoiceId ? `#${p.invoiceId}` : <span style={{ color: 'var(--text-secondary)' }}>—</span>}</Td>
                <Td><strong>{formatCurrency(p.amount, p.currency)}</strong></Td>
                <Td><GatewayBadge gateway={p.gateway} /></Td>
                <Td><StatusBadge status={p.status} /></Td>
                <Td>{formatDate(p.paidAt)}</Td>
                <Td>{formatDate(p.createdAt)}</Td>
                <Td onClick={e => e.stopPropagation()}>
                  <button
                    onClick={() => setSelected(p)}
                    style={{
                      padding: '0.3rem 0.7rem',
                      background: 'rgba(99,91,255,0.15)',
                      border: '1px solid rgba(99,91,255,0.3)',
                      borderRadius: '6px',
                      color: '#a4a0ff',
                      cursor: 'pointer',
                      fontSize: '0.75rem',
                      marginRight: '0.4rem',
                    }}
                  >
                    View
                  </button>
                  <button
                    disabled
                    title="Refund (coming soon)"
                    style={{
                      padding: '0.3rem 0.7rem',
                      background: 'rgba(156,163,175,0.1)',
                      border: '1px solid rgba(156,163,175,0.2)',
                      borderRadius: '6px',
                      color: '#9ca3af',
                      cursor: 'not-allowed',
                      fontSize: '0.75rem',
                    }}
                  >
                    Refund
                  </button>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Admin configuration section */}
      {isAdmin && (
        <div style={{ ...GLASS, padding: '1.25rem', marginTop: '2rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
            <SettingsIcon size={18} />
            <h3 style={{ margin: 0, fontSize: '1rem' }}>Gateway Configuration</h3>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1rem' }}>
            <ConfigCard
              name="Stripe"
              configured={!!config?.stripe?.configured}
              extras={[
                { label: 'API key (STRIPE_SECRET_KEY)', ok: !!config?.stripe?.configured },
                { label: 'Webhook secret (STRIPE_WEBHOOK_SECRET)', ok: !!config?.stripe?.webhookConfigured },
              ]}
              hint="Get keys from dashboard.stripe.com → Developers → API keys. Configure webhook endpoint at /api/payments/webhook/stripe."
              brandColor="#635bff"
            />
            <ConfigCard
              name="Razorpay"
              configured={!!config?.razorpay?.configured}
              extras={[
                { label: 'Key ID (RAZORPAY_KEY_ID)', ok: !!config?.razorpay?.configured, value: config?.razorpay?.keyId },
                { label: 'Key secret (RAZORPAY_KEY_SECRET)', ok: !!config?.razorpay?.configured },
              ]}
              hint="Get keys from dashboard.razorpay.com → Settings → API Keys. Webhook endpoint: /api/payments/webhook/razorpay."
              brandColor="#3395ff"
            />
          </div>

          <p style={{ marginTop: '1rem', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
            Add the env vars to your root <code>.env</code> file and restart the backend (PM2). Keys are loaded once at startup and never exposed to the frontend.
          </p>
        </div>
      )}

      {/* Detail modal */}
      {selected && <DetailModal payment={selected} onClose={() => setSelected(null)} />}

      <style>{`@keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────
function Th({ children }) {
  return (
    <th style={{
      padding: '0.75rem 1rem',
      textAlign: 'left',
      fontSize: '0.75rem',
      textTransform: 'uppercase',
      letterSpacing: '0.05em',
      color: 'var(--text-secondary)',
      fontWeight: 600,
    }}>{children}</th>
  );
}

function Td({ children, onClick }) {
  return <td onClick={onClick} style={{ padding: '0.75rem 1rem', verticalAlign: 'middle' }}>{children}</td>;
}

function StatCard({ icon, label, value, color }) {
  const bgAlpha = color === '#10b981' ? '0.08' : color === '#f59e0b' ? '0.08' : '0.08';
  const getBgColor = () => {
    if (color === '#10b981') return 'rgba(16,185,129,0.1)';
    if (color === '#f59e0b') return 'rgba(245,158,11,0.1)';
    if (color === '#ef4444') return 'rgba(239,68,68,0.1)';
    return 'rgba(99,91,255,0.1)';
  };

  return (
    <div style={{
      padding: '1.5rem',
      borderRadius: '12px',
      background: getBgColor(),
      border: `1.5px solid ${color}40`,
      boxShadow: `0 0 20px ${color}15`,
      transition: 'all 0.3s ease',
      cursor: 'default',
      position: 'relative',
      overflow: 'hidden',
    }}
    onMouseEnter={e => {
      e.currentTarget.style.background = getBgColor();
      e.currentTarget.style.transform = 'translateY(-2px)';
      e.currentTarget.style.boxShadow = `0 8px 24px ${color}25`;
    }}
    onMouseLeave={e => {
      e.currentTarget.style.background = getBgColor();
      e.currentTarget.style.transform = 'translateY(0)';
      e.currentTarget.style.boxShadow = `0 0 20px ${color}15`;
    }}
    >
      <div style={{ position: 'relative', zIndex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
          <div style={{
            width: '40px',
            height: '40px',
            borderRadius: '10px',
            background: `${color}20`,
            border: `1px solid ${color}60`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color,
          }}>
            {icon}
          </div>
          <span style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-secondary)', fontWeight: 600 }}>{label}</span>
        </div>
        <div style={{ fontSize: '2.2rem', fontWeight: 700, color, lineHeight: 1 }}>{value}</div>
      </div>

      <div style={{
        position: 'absolute',
        top: 0,
        right: -40,
        width: '120px',
        height: '120px',
        borderRadius: '50%',
        background: `${color}10`,
        filter: 'blur(30px)',
      }} />
    </div>
  );
}

function ConfigCard({ name, configured, extras, hint, brandColor }) {
  const borderColor = configured ? `${brandColor}60` : 'rgba(255,255,255,0.1)';
  const bgColor = configured ? `${brandColor}08` : 'rgba(255,255,255,0.02)';

  return (
    <div style={{
      padding: '1.25rem',
      borderRadius: '12px',
      background: bgColor,
      border: `1px solid ${borderColor}`,
      boxShadow: `0 0 16px ${configured ? `${brandColor}12` : 'rgba(0,0,0,0.1)'}`,
      transition: 'all 0.3s ease',
      position: 'relative',
    }}>
      <div style={{ position: 'absolute', top: 0, left: 0, width: '4px', height: '100%', background: brandColor, borderRadius: '12px 0 0 12px', opacity: configured ? 1 : 0.3 }} />

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem', paddingLeft: '0.5rem' }}>
        <div>
          <strong style={{ color: brandColor, fontSize: '0.95rem' }}>{name}</strong>
        </div>
        {configured ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', color: '#10b981', fontSize: '0.78rem', fontWeight: 600, background: 'rgba(16,185,129,0.1)', padding: '0.3rem 0.7rem', borderRadius: '6px', border: '1px solid rgba(16,185,129,0.3)' }}>
            <CheckCircle size={14} /> Configured
          </span>
        ) : (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', color: '#f59e0b', fontSize: '0.78rem', fontWeight: 600, background: 'rgba(245,158,11,0.1)', padding: '0.3rem 0.7rem', borderRadius: '6px', border: '1px solid rgba(245,158,11,0.3)' }}>
            <AlertTriangle size={14} /> Not configured
          </span>
        )}
      </div>

      <ul style={{ listStyle: 'none', padding: '0 0 0 0.5rem', margin: '0 0 1rem 0', fontSize: '0.78rem' }}>
        {extras.map((x, i) => (
          <li key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.45rem', color: 'var(--text-secondary)' }}>
            <div style={{ display: 'flex', alignItems: 'center', width: '16px', justifyContent: 'center' }}>
              {x.ok ? <CheckCircle size={13} color="#10b981" /> : <XCircle size={13} color="#ef4444" />}
            </div>
            <span>{x.label}</span>
            {x.value && <code style={{ marginLeft: 'auto', color: 'var(--text-primary)', fontSize: '0.7rem', background: 'rgba(255,255,255,0.05)', padding: '0.2rem 0.4rem', borderRadius: '4px' }}>{x.value}</code>}
          </li>
        ))}
      </ul>

      <p style={{ margin: 0, fontSize: '0.73rem', color: 'var(--text-secondary)', lineHeight: 1.6, paddingLeft: '0.5rem' }}>{hint}</p>
    </div>
  );
}

function DetailModal({ payment, onClose }) {
  const meta = payment.metadata && typeof payment.metadata === 'object' ? payment.metadata : {};
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
        backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center',
        justifyContent: 'center', zIndex: 1000, padding: '1rem',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--bg-color)',
          border: '1px solid var(--border-color)',
          borderRadius: '12px',
          boxShadow: 'var(--glass-shadow, 0 8px 32px rgba(0,0,0,0.25))',
          padding: '1.5rem',
          maxWidth: '560px',
          width: '100%',
          maxHeight: '85vh',
          overflowY: 'auto',
          color: 'var(--text-primary)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
          <h3 style={{ margin: 0 }}>Payment #{payment.id}</h3>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--text-primary)', cursor: 'pointer' }}>
            <X size={20} />
          </button>
        </div>

        <DetailRow label="Status"><StatusBadge status={payment.status} /></DetailRow>
        <DetailRow label="Gateway"><GatewayBadge gateway={payment.gateway} /></DetailRow>
        <DetailRow label="Amount">{formatCurrency(payment.amount, payment.currency)}</DetailRow>
        <DetailRow label="Currency">{payment.currency}</DetailRow>
        <DetailRow label="Invoice">{payment.invoiceId ? `#${payment.invoiceId}` : '—'}</DetailRow>
        <DetailRow label="Gateway ID"><code style={{ fontSize: '0.78rem' }}>{payment.gatewayId || '—'}</code></DetailRow>
        <DetailRow label="Paid At">{formatDate(payment.paidAt)}</DetailRow>
        <DetailRow label="Created">{formatDate(payment.createdAt)}</DetailRow>

        <div style={{ marginTop: '1rem' }}>
          <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: '0.4rem', textTransform: 'uppercase' }}>
            Metadata
          </div>
          <pre style={{
            background: 'var(--subtle-bg)',
            border: '1px solid var(--border-color)',
            padding: '0.75rem',
            borderRadius: '8px',
            fontSize: '0.75rem',
            overflowX: 'auto',
            margin: 0,
            color: 'var(--text-secondary)',
          }}>
{JSON.stringify(meta, null, 2)}
          </pre>
        </div>
      </div>
    </div>
  );
}

function DetailRow({ label, children }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.45rem 0', borderBottom: '1px solid var(--border-color)' }}>
      <span style={{ color: 'var(--text-secondary)', fontSize: '0.82rem' }}>{label}</span>
      <span style={{ fontSize: '0.85rem' }}>{children}</span>
    </div>
  );
}
