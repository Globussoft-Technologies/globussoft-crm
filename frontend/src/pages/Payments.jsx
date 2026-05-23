import React, { useContext, useEffect, useMemo, useState } from 'react';
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
import { useNotify } from '../utils/notify';
// Shared date-range picker — DRY follow-up to fabf035 (cron tick #27).
// Centralises preset dropdown + Custom range UX so the three+ consumers
// (Payments / InventoryReceipts / PatientDetail) stay in sync. Imports the
// `rangeFromPreset` + `effectiveRangeFor` helpers used here for the KPI
// pill row + the table-filter effective range.
import DateRangePicker, {
  rangeFromPreset,
  effectiveRangeFor,
} from '../components/DateRangePicker';

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

// #846 — KPI pill control uses single-letter labels (W / 30D / 90D / Y) and is
// intentionally distinct from the table-filter dropdown UX. The shared
// <DateRangePicker> covers the table filter (preset dropdown + Custom range);
// this list is the compact pill row rendered as `rightAccessory` on the Total
// Collected card. `rangeFromPreset` is imported from the shared component so
// the date math is single-sourced across consumers.
const KPI_PRESETS = [
  { value: 'week7',  label: 'W',   title: 'Last 7 days' },
  { value: 'last30', label: '30D', title: 'Last 30 days' },
  { value: 'last90', label: '90D', title: 'Last 90 days' },
  { value: 'year',   label: 'Y',   title: 'Last 12 months' },
];

export default function Payments() {
  const { user } = useContext(AuthContext) || {};
  const isAdmin = user?.role === 'ADMIN';
  const notify = useNotify();

  const [payments, setPayments] = useState([]);
  const [config, setConfig] = useState(null);
  const [tab, setTab] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);

  // #846 — date-range filter state for the transactions table. Single
  // state object owned by the parent (controlled <DateRangePicker> input);
  // `preset` drives the dropdown UI; `customFrom`/`customTo` are only
  // meaningful when preset === 'custom'. The effective range used for
  // fetching is computed by `effectiveRange` below and persists across the
  // Stripe / Razorpay tab switches (the tab is gateway-only filtering,
  // applied client-side).
  const [dateRange, setDateRange] = useState({
    preset: 'all',
    customFrom: '',
    customTo: '',
  });

  // #846 — Time-range window for the "Total Collected" KPI card. Independent
  // from the table filter so the operator can keep the KPI on its trailing-
  // 30-day default while drilling into a specific day's transactions in the
  // table below. Pending + Failed cards follow the same window so the three
  // KPIs read as one consistent header (per issue's "follow same range").
  const [kpiWindow, setKpiWindow] = useState('last30');

  // #895 — Record Payment drawer state. Operator-facing /payments previously
  // had no way to capture a cash/UPI/manual receipt — the page was read-only
  // ledger + admin-config. The drawer is opened from a header CTA and posts
  // to /api/v1/invoices/:id/payments (canonical PRD §2 item 7c endpoint).
  const [creating, setCreating] = useState(false);
  const [recording, setRecording] = useState(false);
  const [invoices, setInvoices] = useState([]);
  const [form, setForm] = useState({
    invoiceId: '',
    amount: '',
    method: 'cash',
    reference: '',
  });

  // #846 — compute the effective {from, to} range to send to the backend.
  // Delegates to the shared `effectiveRangeFor()` helper from
  // ../components/DateRangePicker so the resolution logic stays
  // single-sourced across consumers (Payments / InventoryReceipts /
  // PatientDetail).
  const effectiveRange = useMemo(
    () => effectiveRangeFor(dateRange),
    [dateRange],
  );

  useEffect(() => {
    loadAll(effectiveRange);
  }, [effectiveRange.from, effectiveRange.to]); // eslint-disable-line react-hooks/exhaustive-deps

  // #895 — fetch the open-invoice list once for the picker. Kept separate
  // from loadAll() so a Refresh-payments click doesn't re-fetch invoices
  // unnecessarily. Filters client-side to non-PAID/VOIDED rows in the
  // dropdown render below.
  useEffect(() => {
    fetchApi('/api/billing')
      .then((rows) => setInvoices(Array.isArray(rows) ? rows : []))
      .catch(() => setInvoices([]));
  }, []);

  // #895 — close the Record-Payment drawer on Escape. Attached only while
  // the drawer is open so we don't trap key events for users not actively
  // recording.
  useEffect(() => {
    if (!creating) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') setCreating(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [creating]);

  const openCreate = () => setCreating(true);
  const closeCreate = () => {
    setCreating(false);
    setForm({ invoiceId: '', amount: '', method: 'cash', reference: '' });
  };

  async function loadAll(range) {
    setLoading(true);
    setError('');
    try {
      // #846 — build /api/payments query with optional from/to. Omit the
      // params entirely when the range is empty so the backend returns
      // unfiltered (preserves the pre-#846 default behaviour).
      const params = new URLSearchParams();
      if (range && range.from) params.set('from', range.from);
      if (range && range.to) params.set('to', range.to);
      const qs = params.toString();
      const listUrl = qs ? `/api/payments?${qs}` : '/api/payments';
      const [list, cfg] = await Promise.all([
        fetchApi(listUrl).catch(() => []),
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

  // #895 — Record Payment submit. Posts to the canonical /api/v1/invoices/:id/payments
  // endpoint (v1_invoices.js:61), which writes a SUCCESS Payment row and auto-flips
  // the invoice to PAID when sum-of-payments reaches grand_total ±0.01. The
  // server stamps paidAt=now; we don't expose a "received date" field because
  // it would be silently dropped on the server side — operator-honest UI.
  async function handleRecord(e) {
    e.preventDefault();
    if (recording) return;
    const invoiceId = parseInt(form.invoiceId, 10);
    const amount = Number(form.amount);
    if (!Number.isFinite(invoiceId) || invoiceId <= 0) {
      notify.error('Please select an invoice');
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      notify.error('Amount must be greater than 0');
      return;
    }
    if (!form.method) {
      notify.error('Please select a payment method');
      return;
    }
    setRecording(true);
    try {
      await fetchApi(`/api/v1/invoices/${invoiceId}/payments`, {
        method: 'POST',
        body: JSON.stringify({
          method: form.method,
          amount,
          reference: form.reference || undefined,
        }),
      });
      notify.success('Payment recorded');
      closeCreate();
      loadAll(effectiveRange);
    } catch (err) {
      notify.error(err.message || 'Failed to record payment');
    } finally {
      setRecording(false);
    }
  }

  const filtered = useMemo(() => {
    if (tab === 'all') return payments;
    return payments.filter(p => String(p.gateway || '').toLowerCase() === tab);
  }, [payments, tab]);

  // #846 — KPI stats honour the selected `kpiWindow` (W / 30D / 90D / Y).
  // Collected sums SUCCESS amounts whose paidAt (or createdAt fallback)
  // falls within the window; Pending and Failed are row counts within
  // the same window for consistency. When the operator narrows the table
  // by date too, `payments` is already a subset, so the KPIs naturally
  // reflect whichever is more restrictive (window intersect table-range).
  const stats = useMemo(() => {
    const { from, to } = rangeFromPreset(kpiWindow);
    const fromTs = from ? new Date(from).getTime() : -Infinity;
    const toTs = to ? new Date(`${to}T23:59:59.999`).getTime() : Infinity;
    let collected = 0, pending = 0, failed = 0;
    for (const p of payments) {
      const ts = p.paidAt ? new Date(p.paidAt).getTime() : new Date(p.createdAt).getTime();
      if (ts < fromTs || ts > toTs) continue;
      if (p.status === 'SUCCESS') {
        collected += Number(p.amount || 0);
      } else if (p.status === 'PENDING') {
        pending += 1;
      } else if (p.status === 'FAILED') {
        failed += 1;
      }
    }
    return { collected, pending, failed };
  }, [payments, kpiWindow]);

  const kpiWindowLabel = useMemo(() => {
    const found = KPI_PRESETS.find(p => p.value === kpiWindow);
    return found ? found.title : '';
  }, [kpiWindow]);

  // ── Render ─────────────────────────────────────────────────────
  return (
    <div style={{ padding: '2rem', color: 'var(--text-primary)', minHeight: '100vh' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <CreditCard size={28} style={{ color: '#635bff' }} />
          <h1 style={{ margin: 0, fontSize: '1.75rem', fontWeight: 700 }}>Payments</h1>
        </div>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
          {/* #895 — Record Payment CTA (right-aligned, primary). Opens a drawer
              capturing invoice + amount + method + reference for cash/UPI/
              manual receipts. Mirrors the 50ac575 CTA + drawer pattern. */}
          <button
            type="button"
            onClick={openCreate}
            aria-label="Record a payment"
            style={{
              padding: '0.5rem 1rem',
              background: 'rgba(99,91,255,0.18)',
              border: '1px solid rgba(99,91,255,0.4)',
              borderRadius: '8px',
              color: '#a4a0ff',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.4rem',
              fontSize: '0.85rem',
              fontWeight: 600,
            }}
          >
            <Plus size={14} />
            Record Payment
          </button>
          <button
            onClick={() => loadAll(effectiveRange)}
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
              {/* #759 — the env-var NAMES + "restart the backend" ops
                  instructions are server/devops detail. Show the full
                  setup detail only to ADMIN; a non-admin staff user gets a
                  plain "contact your administrator" line with no internal
                  config surface. */}
              <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                {isAdmin
                  ? 'Payment-gateway keys are configured server-side as environment variables (not via this UI). Set the variables below and restart the backend. Activating either gateway will enable the payment table + the per-invoice Pay-Now flow.'
                  : 'Online payments are not available yet. Contact your administrator to enable a payment gateway.'}
              </div>
            </div>
          </div>
          {isAdmin && (
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
          )}
        </div>
      )}

      {/* Stats row — #846: KPI window selector (W/30D/90D/Y pill) on the
          Total Collected card. Pending + Failed follow the same window per
          the issue's "ideally follow same range" note. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
        <StatCard
          icon={<DollarSign size={20} />}
          label={`Total Collected (${kpiWindowLabel})`}
          value={formatMoney(stats.collected)}
          color="#10b981"
          rightAccessory={(
            <div role="group" aria-label="Total Collected window" style={{ display: 'inline-flex', gap: '0.2rem' }}>
              {KPI_PRESETS.map(p => (
                <button
                  key={p.value}
                  type="button"
                  title={p.title}
                  aria-pressed={kpiWindow === p.value}
                  onClick={() => setKpiWindow(p.value)}
                  style={{
                    padding: '0.2rem 0.45rem',
                    borderRadius: '6px',
                    fontSize: '0.7rem',
                    fontWeight: 600,
                    border: kpiWindow === p.value ? '1px solid #10b98180' : '1px solid rgba(255,255,255,0.12)',
                    background: kpiWindow === p.value ? 'rgba(16,185,129,0.18)' : 'rgba(255,255,255,0.04)',
                    color: kpiWindow === p.value ? '#10b981' : 'var(--text-secondary)',
                    cursor: 'pointer',
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
          )}
        />
        <StatCard
          icon={<Clock size={20} />}
          label="Pending"
          value={stats.pending}
          color="#f59e0b"
        />
        <StatCard
          icon={<XCircle size={20} />}
          label="Failed"
          value={stats.failed}
          color="#ef4444"
        />
      </div>

      {/* Tabs + date-range filter — #846: date filter sits next to gateway
          tabs so an operator can narrow by date AND gateway at the same time.
          The date selection persists across All / Stripe / Razorpay clicks
          (the tab filters payments client-side; date filtering is server-
          side and re-fetches on change). */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
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

        <div style={{ marginLeft: 'auto' }}>
          <DateRangePicker
            id="payments-date-preset"
            value={dateRange}
            onChange={setDateRange}
            presets={['all', 'today', 'yesterday', 'week7', 'month', 'custom']}
          />
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

      {/* #895 — Record Payment drawer. Mounted only when `creating` is true.
          Close triggers: X button, ESC keypress (handled by the useEffect
          above), click on the dark overlay backdrop, Cancel button, and
          successful submit. Fields: invoice picker (from /api/billing),
          amount, method (cash/upi/bank-transfer/cheque/card/other),
          reference (optional). Submits to /api/v1/invoices/:id/payments. */}
      {creating && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) closeCreate(); }}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.55)',
            backdropFilter: 'blur(4px)',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'flex-end',
            zIndex: 1000,
          }}
          role="dialog"
          aria-modal="true"
          aria-label="Record Payment"
        >
          <div
            style={{
              background: 'rgba(20,20,30,0.98)',
              color: 'var(--text-primary)',
              width: '100%',
              maxWidth: 460,
              height: '100vh',
              overflowY: 'auto',
              padding: '1.5rem',
              boxShadow: '-8px 0 24px rgba(0,0,0,0.4)',
              borderLeft: '1px solid rgba(255,255,255,0.08)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
              <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600 }}>Record Payment</h3>
              <button
                type="button"
                onClick={closeCreate}
                aria-label="Close"
                style={{ background: 'transparent', border: 'none', color: 'var(--text-primary)', cursor: 'pointer', padding: '0.25rem' }}
              >
                <X size={20} />
              </button>
            </div>

            <p style={{ margin: '0 0 1rem 0', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
              Capture a cash, UPI, bank-transfer, cheque, card, or other manual receipt
              against an open invoice. The invoice auto-flips to PAID when the sum of
              recorded payments reaches its total.
            </p>

            <form onSubmit={handleRecord} style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>Invoice *</span>
                <select
                  required
                  value={form.invoiceId}
                  onChange={(e) => setForm(f => ({ ...f, invoiceId: e.target.value }))}
                  style={{ padding: '0.5rem', borderRadius: '6px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: 'var(--text-primary)' }}
                >
                  <option value="">Select an invoice…</option>
                  {invoices
                    .filter(inv => inv && inv.status !== 'PAID' && inv.status !== 'VOIDED')
                    .map(inv => (
                      <option key={inv.id} value={inv.id}>
                        #{inv.invoiceNum || inv.id} — {formatCurrency(inv.amount, inv.currency)}
                        {inv.contact && (inv.contact.name || inv.contact.email) ? ` (${inv.contact.name || inv.contact.email})` : ''}
                      </option>
                    ))}
                </select>
              </label>

              <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>Amount *</span>
                <input
                  type="number"
                  required
                  min="0.01"
                  step="0.01"
                  value={form.amount}
                  onChange={(e) => setForm(f => ({ ...f, amount: e.target.value }))}
                  placeholder="0.00"
                  style={{ padding: '0.5rem', borderRadius: '6px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: 'var(--text-primary)' }}
                />
              </label>

              <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>Method *</span>
                <select
                  required
                  value={form.method}
                  onChange={(e) => setForm(f => ({ ...f, method: e.target.value }))}
                  style={{ padding: '0.5rem', borderRadius: '6px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: 'var(--text-primary)' }}
                >
                  <option value="cash">Cash</option>
                  <option value="upi">UPI</option>
                  <option value="bank-transfer">Bank transfer</option>
                  <option value="cheque">Cheque</option>
                  <option value="card">Card</option>
                  <option value="other">Other</option>
                </select>
              </label>

              <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>Reference</span>
                <input
                  type="text"
                  maxLength={128}
                  value={form.reference}
                  onChange={(e) => setForm(f => ({ ...f, reference: e.target.value }))}
                  placeholder="UPI txn ID / cheque no. / etc. (optional)"
                  style={{ padding: '0.5rem', borderRadius: '6px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: 'var(--text-primary)' }}
                />
              </label>

              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                <button
                  type="submit"
                  disabled={recording}
                  style={{
                    flex: 1,
                    padding: '0.6rem 1rem',
                    background: 'rgba(99,91,255,0.25)',
                    border: '1px solid rgba(99,91,255,0.5)',
                    borderRadius: '8px',
                    color: '#a4a0ff',
                    cursor: recording ? 'not-allowed' : 'pointer',
                    fontSize: '0.85rem',
                    fontWeight: 600,
                  }}
                >
                  {recording ? 'Recording…' : 'Record Payment'}
                </button>
                <button
                  type="button"
                  onClick={closeCreate}
                  disabled={recording}
                  style={{
                    padding: '0.6rem 1rem',
                    background: 'rgba(255,255,255,0.05)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: '8px',
                    color: 'var(--text-primary)',
                    cursor: recording ? 'not-allowed' : 'pointer',
                    fontSize: '0.85rem',
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

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

function StatCard({ icon, label, value, color, rightAccessory }) {
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
          {rightAccessory && (
            <span style={{ marginLeft: 'auto' }}>{rightAccessory}</span>
          )}
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
          ...GLASS,
          background: 'rgba(20,20,30,0.95)',
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
            background: 'rgba(0,0,0,0.4)',
            padding: '0.75rem',
            borderRadius: '8px',
            fontSize: '0.75rem',
            overflowX: 'auto',
            margin: 0,
            color: '#9ca3af',
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
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.45rem 0', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
      <span style={{ color: 'var(--text-secondary)', fontSize: '0.82rem' }}>{label}</span>
      <span style={{ fontSize: '0.85rem' }}>{children}</span>
    </div>
  );
}
