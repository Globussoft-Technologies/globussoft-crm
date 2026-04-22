import React, { useEffect, useMemo, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, Legend
} from 'recharts';
import { TrendingUp, DollarSign, Target, Save } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { formatMoney, formatMoneyCompact } from '../utils/money';

// ─── Period helpers ─────────────────────────────────────────────
function currentQuarter() {
  const d = new Date();
  const q = Math.floor(d.getMonth() / 3) + 1;
  return `${d.getFullYear()}-Q${q}`;
}
function nextQuarter() {
  const d = new Date();
  const q = Math.floor(d.getMonth() / 3) + 1;
  if (q === 4) return `${d.getFullYear() + 1}-Q1`;
  return `${d.getFullYear()}-Q${q + 1}`;
}
function thisYear() {
  return `${new Date().getFullYear()}`;
}

const fmt = (v) => formatMoney(Number(v) || 0, { maximumFractionDigits: 0 });

const PERIOD_OPTIONS = [
  { value: currentQuarter(), label: `Current Quarter (${currentQuarter()})` },
  { value: nextQuarter(), label: `Next Quarter (${nextQuarter()})` },
  { value: thisYear(), label: `This Year (${thisYear()})` },
];

const KpiCard = ({ icon: Icon, label, value, accent }) => (
  <div style={{
    background: 'var(--glass-bg, rgba(255,255,255,0.06))',
    backdropFilter: 'blur(20px)',
    border: '1px solid var(--border-color, rgba(255,255,255,0.1))',
    borderRadius: '16px',
    padding: '1.5rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
    boxShadow: '0 4px 30px rgba(0,0,0,0.1)',
  }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', fontWeight: 600 }}>{label}</span>
      <div style={{
        background: `${accent}22`,
        padding: '0.5rem',
        borderRadius: '10px',
        display: 'flex'
      }}>
        <Icon size={18} color={accent} />
      </div>
    </div>
    <div style={{ fontSize: '1.75rem', fontWeight: 700, color: 'var(--text-primary)' }}>
      {value}
    </div>
  </div>
);

export default function Forecasting() {
  const [period, setPeriod] = useState(currentQuarter());
  const [current, setCurrent] = useState({ period, byUser: [], total: { expected: 0, committed: 0, bestCase: 0, closed: 0 } });
  const [trend, setTrend] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      fetchApi(`/api/forecasting/current?period=${encodeURIComponent(period)}`).catch(() => null),
      fetchApi(`/api/forecasting/trend?months=12`).catch(() => null),
    ]).then(([cur, tr]) => {
      if (cancelled) return;
      if (cur) setCurrent(cur);
      if (tr && Array.isArray(tr.trend)) setTrend(tr.trend);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [period]);

  const repBars = useMemo(
    () => (current.byUser || []).map(u => ({
      name: u.name || `User ${u.userId}`,
      Expected: u.expected,
      Committed: u.committed,
      Closed: u.closed,
    })),
    [current]
  );

  const handleSaveSnapshot = async () => {
    setSaving(true);
    setSavedMsg('');
    try {
      await fetchApi('/api/forecasting/save', {
        method: 'POST',
        body: JSON.stringify({
          period,
          expectedRevenue: current.total.expected,
          committedRevenue: current.total.committed,
          bestCaseRevenue: current.total.bestCase,
          closedRevenue: current.total.closed,
        }),
      });
      setSavedMsg('Snapshot saved.');
    } catch (err) {
      setSavedMsg(err.message || 'Save failed.');
    } finally {
      setSaving(false);
      setTimeout(() => setSavedMsg(''), 3500);
    }
  };

  return (
    <div style={{ padding: '2rem', color: 'var(--text-primary)' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem', marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <TrendingUp size={28} color="var(--accent-color, #3b82f6)" />
          <div>
            <h1 style={{ margin: 0, fontSize: '1.75rem', fontWeight: 700 }}>Sales Forecasting</h1>
            <p style={{ margin: '0.25rem 0 0', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
              Pipeline-weighted revenue projections, per-rep breakdown, and 12-month trend.
            </p>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <select
            className="input-field"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            style={{
              padding: '0.6rem 0.9rem',
              background: 'var(--input-bg, rgba(255,255,255,0.05))',
              border: '1px solid var(--border-color, rgba(255,255,255,0.1))',
              borderRadius: '10px',
              color: 'var(--text-primary)',
              outline: 'none',
              minWidth: 220,
            }}
          >
            {PERIOD_OPTIONS.map(p => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>

          <button
            onClick={handleSaveSnapshot}
            disabled={saving || loading}
            style={{
              padding: '0.6rem 1rem',
              background: 'var(--accent-color, #3b82f6)',
              color: '#fff',
              border: 'none',
              borderRadius: '10px',
              cursor: saving ? 'wait' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              fontWeight: 600,
            }}
          >
            <Save size={16} /> {saving ? 'Saving...' : 'Save Snapshot'}
          </button>
        </div>
      </div>

      {savedMsg && (
        <div style={{
          marginBottom: '1rem',
          padding: '0.6rem 1rem',
          borderRadius: '10px',
          background: 'rgba(16,185,129,0.12)',
          border: '1px solid rgba(16,185,129,0.4)',
          color: '#10b981',
          fontSize: '0.875rem',
        }}>{savedMsg}</div>
      )}

      {/* KPI cards */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: '1rem',
        marginBottom: '2rem',
      }}>
        <KpiCard icon={DollarSign} label="Closed" value={fmt(current.total.closed)} accent="#10b981" />
        <KpiCard icon={Target} label="Committed" value={fmt(current.total.committed)} accent="#3b82f6" />
        <KpiCard icon={TrendingUp} label="Expected" value={fmt(current.total.expected)} accent="#a855f7" />
        <KpiCard icon={Target} label="Best Case" value={fmt(current.total.bestCase)} accent="#f59e0b" />
      </div>

      {/* Charts row */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))',
        gap: '1.5rem',
        marginBottom: '2rem',
      }}>
        {/* Revenue by Rep */}
        <div style={{
          background: 'var(--glass-bg, rgba(255,255,255,0.06))',
          backdropFilter: 'blur(20px)',
          border: '1px solid var(--border-color, rgba(255,255,255,0.1))',
          borderRadius: '16px',
          padding: '1.5rem',
        }}>
          <h3 style={{ margin: '0 0 1rem', fontSize: '1.05rem' }}>Revenue by Sales Rep</h3>
          <div style={{ height: 300 }}>
            {repBars.length === 0 ? (
              <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)' }}>
                {loading ? 'Loading...' : 'No deals in this period.'}
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={repBars}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color, rgba(255,255,255,0.1))" vertical={false} />
                  <XAxis dataKey="name" stroke="var(--text-secondary)" tickLine={false} axisLine={false} />
                  <YAxis stroke="var(--text-secondary)" tickLine={false} axisLine={false} tickFormatter={(v) => formatMoneyCompact(v)} />
                  <Tooltip
                    formatter={(v) => fmt(v)}
                    contentStyle={{ background: 'rgba(20,20,30,0.95)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px' }}
                  />
                  <Legend />
                  <Bar dataKey="Closed" fill="#10b981" radius={[6, 6, 0, 0]} />
                  <Bar dataKey="Committed" fill="#3b82f6" radius={[6, 6, 0, 0]} />
                  <Bar dataKey="Expected" fill="#a855f7" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* Trend */}
        <div style={{
          background: 'var(--glass-bg, rgba(255,255,255,0.06))',
          backdropFilter: 'blur(20px)',
          border: '1px solid var(--border-color, rgba(255,255,255,0.1))',
          borderRadius: '16px',
          padding: '1.5rem',
        }}>
          <h3 style={{ margin: '0 0 1rem', fontSize: '1.05rem' }}>Monthly Closed Revenue (Last 12 Months)</h3>
          <div style={{ height: 300 }}>
            {trend.length === 0 ? (
              <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)' }}>
                {loading ? 'Loading...' : 'No data yet.'}
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={trend}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color, rgba(255,255,255,0.1))" vertical={false} />
                  <XAxis dataKey="month" stroke="var(--text-secondary)" tickLine={false} axisLine={false} />
                  <YAxis stroke="var(--text-secondary)" tickLine={false} axisLine={false} tickFormatter={(v) => formatMoneyCompact(v)} />
                  <Tooltip
                    formatter={(v) => fmt(v)}
                    contentStyle={{ background: 'rgba(20,20,30,0.95)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px' }}
                  />
                  <Line type="monotone" dataKey="closed" stroke="#10b981" strokeWidth={2.5} dot={{ r: 3 }} activeDot={{ r: 5 }} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </div>

      {/* Per-Rep Table */}
      <div style={{
        background: 'var(--glass-bg, rgba(255,255,255,0.06))',
        backdropFilter: 'blur(20px)',
        border: '1px solid var(--border-color, rgba(255,255,255,0.1))',
        borderRadius: '16px',
        padding: '1.5rem',
      }}>
        <h3 style={{ margin: '0 0 1rem', fontSize: '1.05rem' }}>Per-Rep Forecast Breakdown</h3>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--text-secondary)', fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                <th style={{ padding: '0.75rem 0.5rem', borderBottom: '1px solid var(--border-color, rgba(255,255,255,0.1))' }}>Sales Rep</th>
                <th style={{ padding: '0.75rem 0.5rem', borderBottom: '1px solid var(--border-color, rgba(255,255,255,0.1))', textAlign: 'right' }}>Closed</th>
                <th style={{ padding: '0.75rem 0.5rem', borderBottom: '1px solid var(--border-color, rgba(255,255,255,0.1))', textAlign: 'right' }}>Committed</th>
                <th style={{ padding: '0.75rem 0.5rem', borderBottom: '1px solid var(--border-color, rgba(255,255,255,0.1))', textAlign: 'right' }}>Expected</th>
                <th style={{ padding: '0.75rem 0.5rem', borderBottom: '1px solid var(--border-color, rgba(255,255,255,0.1))', textAlign: 'right' }}>Best Case</th>
              </tr>
            </thead>
            <tbody>
              {(current.byUser || []).length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
                    {loading ? 'Loading forecast...' : 'No deals match this period.'}
                  </td>
                </tr>
              ) : current.byUser.map(u => (
                <tr key={u.userId}>
                  <td style={{ padding: '0.75rem 0.5rem', borderBottom: '1px solid var(--border-color, rgba(255,255,255,0.05))' }}>{u.name}</td>
                  <td style={{ padding: '0.75rem 0.5rem', borderBottom: '1px solid var(--border-color, rgba(255,255,255,0.05))', textAlign: 'right', color: '#10b981', fontWeight: 600 }}>{fmt(u.closed)}</td>
                  <td style={{ padding: '0.75rem 0.5rem', borderBottom: '1px solid var(--border-color, rgba(255,255,255,0.05))', textAlign: 'right' }}>{fmt(u.committed)}</td>
                  <td style={{ padding: '0.75rem 0.5rem', borderBottom: '1px solid var(--border-color, rgba(255,255,255,0.05))', textAlign: 'right' }}>{fmt(u.expected)}</td>
                  <td style={{ padding: '0.75rem 0.5rem', borderBottom: '1px solid var(--border-color, rgba(255,255,255,0.05))', textAlign: 'right' }}>{fmt(u.bestCase)}</td>
                </tr>
              ))}
            </tbody>
            {current.byUser && current.byUser.length > 0 && (
              <tfoot>
                <tr style={{ fontWeight: 700 }}>
                  <td style={{ padding: '0.75rem 0.5rem' }}>Total</td>
                  <td style={{ padding: '0.75rem 0.5rem', textAlign: 'right', color: '#10b981' }}>{fmt(current.total.closed)}</td>
                  <td style={{ padding: '0.75rem 0.5rem', textAlign: 'right' }}>{fmt(current.total.committed)}</td>
                  <td style={{ padding: '0.75rem 0.5rem', textAlign: 'right' }}>{fmt(current.total.expected)}</td>
                  <td style={{ padding: '0.75rem 0.5rem', textAlign: 'right' }}>{fmt(current.total.bestCase)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}
