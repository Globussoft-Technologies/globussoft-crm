/**
 * My Transactions — the signed-in customer's own financial history.
 *
 * Customer-facing: surfaced in the wellness sidebar only for customer-tier
 * roles (USER / CUSTOMER) via the `customerOnly` page-catalog flag, the same
 * gate the Buy Gift Cards storefront uses. Staff / admin / manager don't see
 * it in their nav.
 *
 * Data: GET /api/wellness/my-transactions (routes/wellness.js) — resolves
 * the logged-in user/customer → their own Patient and returns ONE normalised, date-
 * sorted timeline aggregating POS purchases (services / products / memberships
 * / gift cards), online gateway payments, wallet top-ups + spends, membership
 * + treatment-plan purchases, gift cards, and platform subscriptions, plus a
 * summary block (totalPaid, wallet balance, top-ups, count).
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Receipt,
  Wallet as WalletIcon,
  Gift,
  CreditCard,
  Crown,
  HeartPulse,
  ShoppingBag,
  RefreshCw,
  ArrowUpRight,
  ArrowDownLeft,
} from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { formatMoney } from '../../utils/money';

// Per-category visual config — icon + accent colour for the timeline rows
// and the filter chips. Keys match the `category` field the API emits.
const CATEGORY_META = {
  Purchase: { icon: ShoppingBag, color: '#265855', label: 'Purchases' },
  Wallet: { icon: WalletIcon, color: '#2563eb', label: 'Wallet' },
  'Gift Card': { icon: Gift, color: '#c026d3', label: 'Gift Cards' },
  Membership: { icon: Crown, color: '#b45309', label: 'Memberships' },
  Treatment: { icon: HeartPulse, color: '#be123c', label: 'Treatments' },
  'Online Payment': { icon: CreditCard, color: '#0891b2', label: 'Online' },
  Subscription: { icon: RefreshCw, color: '#7c3aed', label: 'Subscriptions' },
};

function metaFor(category) {
  return CATEGORY_META[category] || { icon: Receipt, color: '#64748b', label: category };
}

function StatusBadge({ status }) {
  const s = (status || '').toUpperCase();
  const tone =
    ['COMPLETED', 'SUCCESS', 'PAID', 'ACTIVE'].includes(s)
      ? { bg: 'rgba(22,163,74,0.12)', fg: '#15803d' }
      : ['REFUNDED', 'CANCELLED', 'FAILED', 'EXPIRED', 'VOIDED'].includes(s)
        ? { bg: 'rgba(220,38,38,0.12)', fg: '#b91c1c' }
        : { bg: 'rgba(100,116,139,0.14)', fg: '#475569' };
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 600,
        padding: '2px 8px',
        borderRadius: 999,
        background: tone.bg,
        color: tone.fg,
        textTransform: 'capitalize',
        whiteSpace: 'nowrap',
      }}
    >
      {(status || '').toLowerCase()}
    </span>
  );
}

function SummaryCard({ label, value, sub, accent }) {
  return (
    <div
      className="glass"
      style={{
        padding: '1rem 1.15rem',
        borderRadius: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        minWidth: 0,
      }}
    >
      <span style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600 }}>
        {label}
      </span>
      <span style={{ fontSize: 22, fontWeight: 700, color: accent || 'var(--text-primary)' }}>
        {value}
      </span>
      {sub && <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{sub}</span>}
    </div>
  );
}

export default function MyTransactions() {
  const notify = useNotify();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeFilter, setActiveFilter] = useState('ALL');

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchApi('/api/wellness/my-transactions');
      setData(res || { transactions: [], summary: {} });
    } catch (e) {
      setError(e?.message || 'Failed to load transactions');
      notify.error(e?.message || 'Failed to load transactions');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const currency = data?.currency;
  const transactions = data?.transactions || [];
  const summary = data?.summary || {};

  // Categories actually present in the data, in a stable display order.
  const categoriesPresent = useMemo(() => {
    const order = Object.keys(CATEGORY_META);
    const present = new Set(transactions.map((t) => t.category));
    return order.filter((c) => present.has(c));
  }, [transactions]);

  const visible = useMemo(() => {
    if (activeFilter === 'ALL') return transactions;
    return transactions.filter((t) => t.category === activeFilter);
  }, [transactions, activeFilter]);

  const fmt = (n) => formatMoney(n, currency ? { currency } : {});

  return (
    <div style={{ padding: '1.5rem', maxWidth: 1000, margin: '0 auto' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: '1.25rem',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Receipt size={26} style={{ color: 'var(--primary-color, var(--accent-color))' }} />
          <div>
            <h1 style={{ margin: 0, fontSize: '1.4rem' }}>My Transactions</h1>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)' }}>
              Everything you've paid for — purchases, treatments, gift cards, wallet & subscriptions.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={load}
          className="glass"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '0.5rem 0.9rem',
            borderRadius: 10,
            border: 'none',
            cursor: 'pointer',
            fontWeight: 600,
            fontSize: 13,
            color: 'var(--text-primary)',
          }}
        >
          <RefreshCw size={15} /> Refresh
        </button>
      </div>

      {/* Summary cards */}
      <div
        data-testid="my-transactions-summary"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 200px), 1fr))',
          gap: 12,
          marginBottom: '1.5rem',
        }}
      >
        <SummaryCard
          label="Total Paid"
          value={loading ? '—' : fmt(summary.totalPaid || 0)}
          sub="Purchases + online + subscriptions"
          accent="var(--primary-color, var(--accent-color))"
        />
        <SummaryCard
          label="Wallet Balance"
          value={loading ? '—' : fmt(summary.walletBalance || 0)}
          sub={`Topped up ${loading ? '—' : fmt(summary.walletTopUps || 0)}`}
        />
        <SummaryCard
          label="Subscriptions"
          value={loading ? '—' : fmt(summary.subscriptionsTotal || 0)}
          sub="Recurring plans"
        />
        <SummaryCard
          label="Transactions"
          value={loading ? '—' : summary.transactionCount ?? transactions.length}
          sub="All-time records"
        />
      </div>

      {/* Filter chips */}
      {!loading && transactions.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: '1rem' }}>
          {['ALL', ...categoriesPresent].map((cat) => {
            const active = activeFilter === cat;
            const m = cat === 'ALL' ? { label: 'All', color: 'var(--primary-color, var(--accent-color))' } : metaFor(cat);
            return (
              <button
                key={cat}
                type="button"
                data-testid={`my-transactions-filter-${cat}`}
                onClick={() => setActiveFilter(cat)}
                style={{
                  padding: '5px 12px',
                  borderRadius: 999,
                  fontSize: 12.5,
                  fontWeight: 600,
                  cursor: 'pointer',
                  border: `1px solid ${active ? (m.color || 'var(--accent-color)') : 'var(--border-color, rgba(0,0,0,0.1))'}`,
                  background: active ? (m.color || 'var(--accent-color)') : 'transparent',
                  color: active ? '#fff' : 'var(--text-secondary)',
                }}
              >
                {m.label}
              </button>
            );
          })}
        </div>
      )}

      {/* Timeline */}
      {loading ? (
        <div
          data-testid="my-transactions-loading"
          style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}
        >
          Loading your transactions…
        </div>
      ) : error ? (
        <div
          data-testid="my-transactions-error"
          className="glass"
          style={{ padding: '2rem', textAlign: 'center', borderRadius: 14, color: '#b91c1c' }}
        >
          {error}
          <div style={{ marginTop: 12 }}>
            <button type="button" onClick={load} style={{ cursor: 'pointer' }}>
              Try again
            </button>
          </div>
        </div>
      ) : visible.length === 0 ? (
        <div
          data-testid="my-transactions-empty"
          className="glass"
          style={{
            padding: '3rem 1.5rem',
            textAlign: 'center',
            borderRadius: 14,
            color: 'var(--text-secondary)',
          }}
        >
          <Receipt size={34} style={{ opacity: 0.4, marginBottom: 10 }} />
          <p style={{ margin: 0, fontWeight: 600 }}>No transactions yet</p>
          <p style={{ margin: '4px 0 0', fontSize: 13 }}>
            Your purchases, treatments, gift cards and wallet activity will show up here.
          </p>
        </div>
      ) : (
        <div
          data-testid="my-transactions-list"
          style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
        >
          {visible.map((t) => {
            const m = metaFor(t.category);
            const Icon = m.icon;
            const credit = t.direction === 'credit';
            return (
              <div
                key={t.id}
                data-testid={`my-transactions-row-${t.id}`}
                className="glass"
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 14,
                  padding: '0.9rem 1.05rem',
                  borderRadius: 12,
                }}
              >
                <div
                  style={{
                    flexShrink: 0,
                    width: 40,
                    height: 40,
                    borderRadius: 10,
                    display: 'grid',
                    placeItems: 'center',
                    background: `${m.color}1a`,
                    color: m.color,
                  }}
                >
                  <Icon size={20} />
                </div>

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      flexWrap: 'wrap',
                    }}
                  >
                    <span style={{ fontWeight: 600, fontSize: 14 }}>{t.title}</span>
                    <StatusBadge status={t.status} />
                  </div>
                  {t.description && (
                    <p
                      style={{
                        margin: '3px 0 0',
                        fontSize: 12.5,
                        color: 'var(--text-secondary)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {t.description}
                    </p>
                  )}
                  {/* Line-item breakdown for POS purchases */}
                  {Array.isArray(t.items) && t.items.length > 0 && (
                    <div
                      style={{
                        marginTop: 6,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 2,
                      }}
                    >
                      {t.items.map((it, i) => (
                        <div
                          key={i}
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            fontSize: 12,
                            color: 'var(--text-secondary)',
                          }}
                        >
                          <span>
                            {it.name}
                            {it.quantity > 1 ? ` ×${it.quantity}` : ''}
                          </span>
                          <span>{fmt(it.amount)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  <div style={{ marginTop: 6, fontSize: 11.5, color: 'var(--text-secondary)' }}>
                    {new Date(t.date).toLocaleString()}
                    {t.paymentMethod ? ` · ${t.paymentMethod}` : ''}
                    {t.reference ? ` · ${t.reference}` : ''}
                  </div>
                </div>

                <div
                  style={{
                    flexShrink: 0,
                    textAlign: 'right',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-end',
                    gap: 2,
                  }}
                >
                  <span
                    style={{
                      fontWeight: 700,
                      fontSize: 15,
                      color: credit ? '#15803d' : 'var(--text-primary)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 3,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {credit ? <ArrowDownLeft size={14} /> : <ArrowUpRight size={14} />}
                    {credit ? '+' : '−'}
                    {fmt(t.amount)}
                  </span>
                  {Number.isFinite(t.balanceAfter) && (
                    <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                      Bal {fmt(t.balanceAfter)}
                    </span>
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
