import React, { useEffect, useState } from 'react';
import { BarChart3, TrendingUp, Stethoscope, MapPin, IndianRupee } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { formatMoney } from '../../utils/money';

const TABS = [
  { key: 'pnl', label: 'P&L by Service', icon: BarChart3 },
  { key: 'pro', label: 'Per Professional', icon: Stethoscope },
  { key: 'loc', label: 'Per Location', icon: MapPin },
  { key: 'att', label: 'Marketing Attribution', icon: TrendingUp },
];

const ENDPOINTS = {
  pnl: '/api/wellness/reports/pnl-by-service',
  pro: '/api/wellness/reports/per-professional',
  loc: '/api/wellness/reports/per-location',
  att: '/api/wellness/reports/attribution',
};

const isoDay = (d) => d.toISOString().slice(0, 10);

export default function Reports() {
  const [tab, setTab] = useState('pnl');
  const [from, setFrom] = useState(isoDay(new Date(Date.now() - 30 * 86400000)));
  const [to, setTo] = useState(isoDay(new Date()));
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    const url = `${ENDPOINTS[tab]}?from=${from}T00:00:00&to=${to}T23:59:59`;
    fetchApi(url).then(setData).catch(() => setData(null)).finally(() => setLoading(false));
  };
  useEffect(load, [tab, from, to]);

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '1.25rem' }}>
        <h1 style={{ fontSize: '1.75rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <BarChart3 size={24} /> Reports
        </h1>
        <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
          Profit, contribution, and team performance — filterable by date.
        </p>
      </header>

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button key={t.key} onClick={() => setTab(t.key)}
              style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.5rem 1rem',
                background: tab === t.key ? 'var(--accent-color)' : 'transparent',
                color: tab === t.key ? '#fff' : 'var(--text-primary)',
                border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, cursor: 'pointer', fontSize: '0.85rem' }}>
              <Icon size={14} /> {t.label}
            </button>
          );
        })}
        <div style={{ flex: 1 }} />
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={dateInput} />
        <span style={{ color: 'var(--text-secondary)' }}>→</span>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={dateInput} />
      </div>

      {loading && <div>Loading…</div>}
      {!loading && data && tab === 'pnl' && <PnlTable data={data} />}
      {!loading && data && tab === 'pro' && <ProTable data={data} />}
      {!loading && data && tab === 'loc' && <LocTable data={data} />}
      {!loading && data && tab === 'att' && <AttTable data={data} />}
      {!loading && !data && <div className="glass" style={{ padding: '2rem', textAlign: 'center' }}>No data.</div>}
    </div>
  );
}

function Totals({ items }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${items.length}, 1fr)`, gap: '0.75rem', marginBottom: '1rem' }}>
      {items.map((it) => (
        <div key={it.label} className="glass" style={{ padding: '1rem' }}>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{it.label}</div>
          <div style={{ fontSize: '1.5rem', fontWeight: 600, marginTop: '0.25rem' }}>{it.value}</div>
        </div>
      ))}
    </div>
  );
}

function PnlTable({ data }) {
  return (
    <>
      <Totals items={[
        { label: 'Visits', value: data.totals.visits.toLocaleString('en-IN') },
        { label: 'Revenue', value: formatMoney(data.totals.revenue) },
        { label: 'Product cost', value: formatMoney(data.totals.productCost) },
        { label: 'Contribution', value: formatMoney(data.totals.contribution) },
      ]} />
      <div className="glass" style={{ padding: 0, overflow: 'hidden' }}>
        <table style={tableStyle}>
          <thead><tr>{['Service', 'Category', 'Tier', 'Visits', 'Revenue', 'Product cost', 'Contribution'].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.id}>
                <td style={td}>{r.name}</td>
                <td style={td}>{r.category}</td>
                <td style={td}>
                  <span style={{ background: tierBg(r.ticketTier), padding: '0.15rem 0.45rem', borderRadius: 4, fontSize: '0.7rem', textTransform: 'uppercase', fontWeight: 600 }}>
                    {r.ticketTier}
                  </span>
                </td>
                <td style={tdR}>{r.count}</td>
                <td style={tdR}>{formatMoney(r.revenue)}</td>
                <td style={tdR}>{formatMoney(r.productCost)}</td>
                <td style={{ ...tdR, color: r.contribution > 0 ? 'var(--success-color)' : 'var(--danger-color)', fontWeight: 600 }}>
                  {formatMoney(r.contribution)}
                </td>
              </tr>
            ))}
            {data.rows.length === 0 && <tr><td colSpan={7} style={{ ...td, textAlign: 'center', color: 'var(--text-secondary)' }}>No services with revenue in this window.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

function ProTable({ data }) {
  return (
    <>
      <Totals items={[
        { label: 'Visits', value: data.totals.visits.toLocaleString('en-IN') },
        { label: 'Revenue', value: formatMoney(data.totals.revenue) },
      ]} />
      <div className="glass" style={{ padding: 0, overflow: 'hidden' }}>
        <table style={tableStyle}>
          <thead><tr>{['Staff', 'Role', 'Specialty', 'Visits', 'Revenue'].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.id}>
                <td style={td}>{r.name}</td>
                <td style={td}>{r.role}</td>
                <td style={td}>{r.wellnessRole || '—'}</td>
                <td style={tdR}>{r.visits}</td>
                <td style={tdR}>{formatMoney(r.revenue)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function LocTable({ data }) {
  return (
    <>
      <Totals items={[
        { label: 'Visits', value: data.totals.visits.toLocaleString('en-IN') },
        { label: 'Revenue', value: formatMoney(data.totals.revenue) },
      ]} />
      <div className="glass" style={{ padding: 0, overflow: 'hidden' }}>
        <table style={tableStyle}>
          <thead><tr>{['Location', 'City', 'Patients', 'Visits', 'Revenue', 'Status'].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.id}>
                <td style={td}>{r.name}</td>
                <td style={td}>{r.city}{r.state ? `, ${r.state}` : ''}</td>
                <td style={tdR}>{r.patients}</td>
                <td style={tdR}>{r.visits}</td>
                <td style={tdR}>{formatMoney(r.revenue)}</td>
                <td style={td}>{r.isActive ? '🟢 Active' : '⚪ Inactive'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function AttTable({ data }) {
  return (
    <>
      <Totals items={[
        { label: 'Total leads', value: data.totals.leads.toLocaleString('en-IN') },
        { label: 'Junk', value: data.totals.junk.toLocaleString('en-IN') },
        { label: 'Qualified', value: data.totals.qualified.toLocaleString('en-IN') },
        { label: 'Revenue', value: formatMoney(data.totals.revenue) },
      ]} />
      <div className="glass" style={{ padding: 0, overflow: 'hidden' }}>
        <table style={tableStyle}>
          <thead><tr>{['Source', 'Leads', 'Junk %', 'Conv %', 'Revenue', 'Rev / Lead'].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.source}>
                <td style={td}><strong>{r.source}</strong></td>
                <td style={tdR}>{r.leads}</td>
                <td style={{ ...tdR, color: r.junkRate > 70 ? 'var(--danger-color)' : 'var(--text-secondary)' }}>{r.junkRate}%</td>
                <td style={{ ...tdR, color: r.conversionRate > 10 ? 'var(--success-color)' : 'var(--text-secondary)', fontWeight: r.conversionRate > 10 ? 600 : 400 }}>{r.conversionRate}%</td>
                <td style={tdR}>{formatMoney(r.revenue)}</td>
                <td style={tdR}>{formatMoney(r.revenuePerLead)}</td>
              </tr>
            ))}
            {data.rows.length === 0 && <tr><td colSpan={6} style={{ ...td, textAlign: 'center', color: 'var(--text-secondary)' }}>No leads in this window.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

const tierBg = (t) => ({ high: 'rgba(239,68,68,0.2)', medium: 'rgba(245,158,11,0.2)', low: 'rgba(100,116,139,0.2)' }[t] || 'rgba(100,116,139,0.2)');
const tableStyle = { width: '100%', borderCollapse: 'collapse' };
const th = { textAlign: 'left', padding: '0.65rem 1rem', fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid rgba(255,255,255,0.06)' };
const td = { padding: '0.65rem 1rem', fontSize: '0.85rem', borderBottom: '1px solid rgba(255,255,255,0.04)' };
const tdR = { ...td, textAlign: 'right' };
const dateInput = { padding: '0.45rem 0.6rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, color: 'var(--text-primary)', fontSize: '0.85rem' };
