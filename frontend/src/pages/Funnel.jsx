import React, { useState, useEffect, useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  FunnelChart, Funnel, LabelList, AreaChart, Area, Legend,
} from 'recharts';
import { fetchApi } from '../utils/api';
import { BarChart3, TrendingDown, Filter, Calendar, DollarSign, Users, Award, X } from 'lucide-react';

const COLORS = ['#3b82f6', '#a855f7', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#6366f1', '#14b8a6'];

const cardStyle = {
  background: 'var(--card-bg, rgba(255,255,255,0.05))',
  backdropFilter: 'blur(12px)',
  WebkitBackdropFilter: 'blur(12px)',
  border: '1px solid var(--border-color, rgba(255,255,255,0.1))',
  borderRadius: '14px',
  padding: '1.25rem',
  boxShadow: '0 4px 24px rgba(0,0,0,0.06)',
};

const fmtMoney = (n) => `$${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const fmtPct = (n) => (n == null || isNaN(n) ? '—' : `${Number(n).toFixed(1)}%`);

export default function FunnelPage() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [pipelineId, setPipelineId] = useState('');
  const [pipelines, setPipelines] = useState([]);

  const [stages, setStages] = useState([]);
  const [bySource, setBySource] = useState([]);
  const [byRep, setByRep] = useState([]);
  const [velocity, setVelocity] = useState([]);
  const [trend, setTrend] = useState([]);
  const [loading, setLoading] = useState(true);

  // Load pipelines (best-effort — endpoint may not exist in all installs)
  useEffect(() => {
    fetchApi('/api/pipelines')
      .then((res) => setPipelines(Array.isArray(res) ? res : []))
      .catch(() => setPipelines([]));
  }, []);

  const dateQs = () => {
    const p = [];
    if (from) p.push(`from=${from}`);
    if (to) p.push(`to=${to}`);
    return p.join('&');
  };

  useEffect(() => {
    setLoading(true);
    const qs = dateQs();
    const stagesQs = [pipelineId && `pipelineId=${pipelineId}`, qs].filter(Boolean).join('&');
    Promise.all([
      fetchApi(`/api/funnel/stages${stagesQs ? '?' + stagesQs : ''}`).catch(() => ({ stages: [] })),
      fetchApi(`/api/funnel/conversion-by-source${qs ? '?' + qs : ''}`).catch(() => []),
      fetchApi(`/api/funnel/by-rep${qs ? '?' + qs : ''}`).catch(() => []),
      fetchApi('/api/funnel/velocity').catch(() => []),
      fetchApi('/api/funnel/trend?months=6').catch(() => []),
    ]).then(([s, src, rep, vel, tr]) => {
      setStages((s && s.stages) || []);
      setBySource(Array.isArray(src) ? src : []);
      setByRep(Array.isArray(rep) ? rep : []);
      setVelocity(Array.isArray(vel) ? vel : []);
      setTrend(Array.isArray(tr) ? tr : []);
      setLoading(false);
    });
  }, [from, to, pipelineId]);

  // KPI computations
  const kpis = useMemo(() => {
    const totalDeals = byRep.reduce((sum, r) => sum + (r.total || 0), 0);
    const won = byRep.reduce((sum, r) => sum + (r.won || 0), 0);
    const lost = byRep.reduce((sum, r) => sum + (r.lost || 0), 0);
    const winRate = totalDeals > 0 ? (won / totalDeals) * 100 : 0;
    const avgCycle = velocity.length
      ? velocity.reduce((s, v) => s + (v.avgDaysInStage || 0), 0)
      : 0;
    return {
      totalDeals,
      won,
      lost,
      winRate: Math.round(winRate * 10) / 10,
      avgCycle: Math.round(avgCycle * 10) / 10,
    };
  }, [byRep, velocity]);

  // Funnel chart data: count + name + fill color
  const funnelData = useMemo(
    () => stages.map((s, i) => ({
      name: s.name,
      value: s.totalEntered || 0,
      current: s.current || 0,
      conversion: s.conversionToNext,
      totalValue: s.totalValue || 0,
      fill: COLORS[i % COLORS.length],
    })),
    [stages],
  );

  return (
    <div style={{ padding: '2rem', display: 'flex', flexDirection: 'column', gap: '1.5rem', animation: 'fadeIn 0.5s ease-out' }}>
      {/* Header */}
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <BarChart3 size={28} color="var(--accent-color, #3b82f6)" />
          <div>
            <h1 style={{ fontSize: '1.75rem', fontWeight: 700, margin: 0 }}>Sales Funnel</h1>
            <p style={{ color: 'var(--text-secondary)', margin: '0.25rem 0 0', fontSize: '0.9rem' }}>
              Stage-by-stage conversion, velocity, and rep performance.
            </p>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Calendar size={16} color="var(--text-secondary)" />
            <input type="date" className="input-field" value={from} onChange={(e) => setFrom(e.target.value)} style={{ padding: '0.45rem', fontSize: '0.85rem' }} />
            <span style={{ color: 'var(--text-secondary)' }}>to</span>
            <input type="date" className="input-field" value={to} onChange={(e) => setTo(e.target.value)} style={{ padding: '0.45rem', fontSize: '0.85rem' }} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Filter size={16} color="var(--text-secondary)" />
            <select className="input-field" value={pipelineId} onChange={(e) => setPipelineId(e.target.value)} style={{ padding: '0.45rem', fontSize: '0.85rem' }}>
              <option value="">All Pipelines</option>
              {pipelines.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          {(from || to || pipelineId) && (
            <button className="btn-secondary" onClick={() => { setFrom(''); setTo(''); setPipelineId(''); }} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.45rem 0.75rem' }}>
              <X size={14} /> Clear
            </button>
          )}
        </div>
      </header>

      {/* KPI Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '1rem' }}>
        <KpiCard icon={<Users size={20} />} label="Total Deals" value={kpis.totalDeals} color={COLORS[0]} />
        <KpiCard icon={<Award size={20} />} label="Won" value={kpis.won} color={COLORS[2]} />
        <KpiCard icon={<TrendingDown size={20} />} label="Lost" value={kpis.lost} color={COLORS[4]} />
        <KpiCard icon={<DollarSign size={20} />} label="Win Rate" value={fmtPct(kpis.winRate)} color={COLORS[3]} />
        <KpiCard icon={<Calendar size={20} />} label="Avg Cycle (days)" value={kpis.avgCycle || '—'} color={COLORS[1]} />
      </div>

      {/* Funnel + Velocity */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: '1.5rem' }}>
        <div style={cardStyle}>
          <h3 style={{ marginTop: 0, marginBottom: '1rem', fontSize: '1.05rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <BarChart3 size={18} /> Funnel by Stage
          </h3>
          {loading ? (
            <p style={{ color: 'var(--text-secondary)' }}>Loading…</p>
          ) : funnelData.length === 0 ? (
            <p style={{ color: 'var(--text-secondary)' }}>No deals yet.</p>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={300}>
                <FunnelChart>
                  <Tooltip
                    contentStyle={{ background: 'rgba(20,20,30,0.92)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, color: '#fff' }}
                    formatter={(value, _n, item) => {
                      const d = item && item.payload;
                      if (!d) return value;
                      return [
                        `${value} entered • ${d.current} now • ${fmtMoney(d.totalValue)}`,
                        d.name,
                      ];
                    }}
                  />
                  <Funnel dataKey="value" data={funnelData} isAnimationActive>
                    <LabelList position="right" fill="var(--text-primary)" stroke="none" dataKey="name" />
                    <LabelList position="center" fill="#fff" stroke="none" dataKey="value" />
                  </Funnel>
                </FunnelChart>
              </ResponsiveContainer>
              {/* Stacked stage breakdown table */}
              <div style={{ marginTop: '1rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                {funnelData.map((s, i) => (
                  <div key={s.name} style={{
                    display: 'grid',
                    gridTemplateColumns: '110px 1fr auto',
                    alignItems: 'center',
                    gap: '0.75rem',
                    padding: '0.5rem 0.75rem',
                    background: 'rgba(255,255,255,0.03)',
                    borderRadius: 8,
                  }}>
                    <span style={{ textTransform: 'capitalize', fontWeight: 600 }}>{s.name}</span>
                    <div style={{ position: 'relative', height: 8, background: 'rgba(255,255,255,0.06)', borderRadius: 4 }}>
                      <div style={{
                        position: 'absolute', left: 0, top: 0, bottom: 0,
                        width: `${funnelData[0].value > 0 ? (s.value / funnelData[0].value) * 100 : 0}%`,
                        background: s.fill, borderRadius: 4,
                      }} />
                    </div>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                      {s.value} • {fmtMoney(s.totalValue)} {s.conversion != null && `• ${fmtPct(s.conversion)} →`}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <div style={cardStyle}>
          <h3 style={{ marginTop: 0, marginBottom: '1rem', fontSize: '1.05rem' }}>Stage Velocity (avg days)</h3>
          {velocity.length === 0 ? (
            <p style={{ color: 'var(--text-secondary)' }}>No velocity data.</p>
          ) : (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={velocity} margin={{ top: 10, right: 20, bottom: 5, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
                <XAxis dataKey="stage" stroke="var(--text-secondary)" />
                <YAxis stroke="var(--text-secondary)" />
                <Tooltip contentStyle={{ background: 'rgba(20,20,30,0.92)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, color: '#fff' }} />
                <Bar dataKey="avgDaysInStage" name="Avg Days" fill={COLORS[1]} radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Trend */}
      <div style={cardStyle}>
        <h3 style={{ marginTop: 0, marginBottom: '1rem', fontSize: '1.05rem' }}>Funnel Trend (last 6 months)</h3>
        {trend.length === 0 ? (
          <p style={{ color: 'var(--text-secondary)' }}>No trend data.</p>
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={trend} margin={{ top: 10, right: 20, bottom: 5, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
              <XAxis dataKey="month" stroke="var(--text-secondary)" />
              <YAxis stroke="var(--text-secondary)" />
              <Tooltip contentStyle={{ background: 'rgba(20,20,30,0.92)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, color: '#fff' }} />
              <Legend />
              {stages.map((s, i) => (
                <Area
                  key={s.name}
                  type="monotone"
                  dataKey={s.name}
                  stackId="1"
                  stroke={COLORS[i % COLORS.length]}
                  fill={COLORS[i % COLORS.length]}
                  fillOpacity={0.35}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Tables */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: '1.5rem' }}>
        <div style={cardStyle}>
          <h3 style={{ marginTop: 0, marginBottom: '1rem', fontSize: '1.05rem' }}>Conversion by Source</h3>
          {bySource.length === 0 ? (
            <p style={{ color: 'var(--text-secondary)' }}>No source data.</p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--text-secondary)' }}>
                  <th style={{ padding: '0.5rem 0.6rem' }}>Source</th>
                  <th style={{ padding: '0.5rem 0.6rem', textAlign: 'right' }}>Leads</th>
                  <th style={{ padding: '0.5rem 0.6rem', textAlign: 'right' }}>Won</th>
                  <th style={{ padding: '0.5rem 0.6rem', textAlign: 'right' }}>Conv %</th>
                </tr>
              </thead>
              <tbody>
                {bySource.map((s) => (
                  <tr key={s.source} style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                    <td style={{ padding: '0.55rem 0.6rem' }}>{s.source}</td>
                    <td style={{ padding: '0.55rem 0.6rem', textAlign: 'right' }}>{s.count}</td>
                    <td style={{ padding: '0.55rem 0.6rem', textAlign: 'right' }}>{s.won}</td>
                    <td style={{ padding: '0.55rem 0.6rem', textAlign: 'right', fontWeight: 600, color: s.conversionRate >= 20 ? COLORS[2] : 'var(--text-primary)' }}>
                      {fmtPct(s.conversionRate)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div style={cardStyle}>
          <h3 style={{ marginTop: 0, marginBottom: '1rem', fontSize: '1.05rem' }}>Rep Performance</h3>
          {byRep.length === 0 ? (
            <p style={{ color: 'var(--text-secondary)' }}>No rep data.</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: 'var(--text-secondary)' }}>
                    <th style={{ padding: '0.5rem 0.6rem' }}>Rep</th>
                    <th style={{ padding: '0.5rem 0.6rem', textAlign: 'right' }}>Total</th>
                    <th style={{ padding: '0.5rem 0.6rem', textAlign: 'right' }}>Open</th>
                    <th style={{ padding: '0.5rem 0.6rem', textAlign: 'right' }}>Won</th>
                    <th style={{ padding: '0.5rem 0.6rem', textAlign: 'right' }}>Lost</th>
                    <th style={{ padding: '0.5rem 0.6rem', textAlign: 'right' }}>Win %</th>
                    <th style={{ padding: '0.5rem 0.6rem', textAlign: 'right' }}>Revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {byRep.map((r) => (
                    <tr key={r.ownerId} style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                      <td style={{ padding: '0.55rem 0.6rem' }}>{r.owner}</td>
                      <td style={{ padding: '0.55rem 0.6rem', textAlign: 'right' }}>{r.total}</td>
                      <td style={{ padding: '0.55rem 0.6rem', textAlign: 'right' }}>{r.open}</td>
                      <td style={{ padding: '0.55rem 0.6rem', textAlign: 'right', color: COLORS[2] }}>{r.won}</td>
                      <td style={{ padding: '0.55rem 0.6rem', textAlign: 'right', color: COLORS[4] }}>{r.lost}</td>
                      <td style={{ padding: '0.55rem 0.6rem', textAlign: 'right', fontWeight: 600 }}>{fmtPct(r.winRate)}</td>
                      <td style={{ padding: '0.55rem 0.6rem', textAlign: 'right' }}>{fmtMoney(r.revenue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function KpiCard({ icon, label, value, color }) {
  return (
    <div style={{ ...cardStyle, padding: '1rem 1.25rem', display: 'flex', alignItems: 'center', gap: '0.9rem' }}>
      <div style={{
        width: 42, height: 42, borderRadius: 10, display: 'flex',
        alignItems: 'center', justifyContent: 'center',
        background: `${color}22`, color,
      }}>{icon}</div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</span>
        <span style={{ fontSize: '1.35rem', fontWeight: 700 }}>{value}</span>
      </div>
    </div>
  );
}
