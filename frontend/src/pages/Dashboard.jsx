/**
 * Dashboard — generic CRM landing page (vertical=generic).
 *
 * KPI tiles (Closed Revenue, Expected Revenue, Total Contacts, Conversion
 * Rate, Total Deals) read from `/api/deals/stats` so the numbers reflect the
 * FULL tenant population, not a paginated window. The "Recent Deals" widget
 * legitimately wants the newest, so it pulls `/api/deals?limit=10`.
 *
 * #567 fix: previously this page computed KPIs client-side by reducing over
 * `/api/deals?limit=100`. On large tenants (5,381 deals / 375 won / $5B
 * aggregate on demo), only 1 won deal sat in the newest-100 window →
 * "Closed Revenue $0" permanently. The split below lets the server compute
 * aggregates correctly while the client only paginates the row-list view
 * that genuinely needs paging.
 */
import React, { useState, useEffect } from 'react';
import { Users, DollarSign, Activity, Calendar, TrendingUp } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { formatMoney, formatMoneyCompact } from '../utils/money';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { useNavigate } from 'react-router-dom';

const DEFAULT_STATS = {
  totalDeals: 0,
  totalValue: 0,
  wonCount: 0,
  wonValue: 0,
  lostCount: 0,
  lostValue: 0,
  expectedValue: 0,
  winRate: 0,
  byStage: [],
};

export default function Dashboard() {
  const navigate = useNavigate();
  const [stats, setStats] = useState(DEFAULT_STATS);
  const [recentDeals, setRecentDeals] = useState([]);
  const [contacts, setContacts] = useState([]);

  useEffect(() => {
    // KPI numbers — full-population aggregates from the server.
    fetchApi('/api/deals/stats')
      .then((d) => setStats({ ...DEFAULT_STATS, ...(d || {}) }))
      .catch(() => setStats(DEFAULT_STATS));
    // Row list for the Recent Deals widget — newest 10 only.
    fetchApi('/api/deals?limit=10&orderBy=createdAt:desc')
      .then((d) => setRecentDeals(Array.isArray(d) ? d : []))
      .catch(() => setRecentDeals([]));
    fetchApi('/api/contacts')
      .then((d) => setContacts(Array.isArray(d) ? d : []))
      .catch(() => setContacts([]));
  }, []);

  // KPIs derived purely from `stats` (server aggregates), not from any list.
  const totalRevenue = stats.wonValue || 0;
  const expectedRevenue = stats.expectedValue || 0;
  const activeLeads = contacts.length;
  const conversionRate = stats.totalDeals
    ? Math.round(((stats.wonCount || 0) / stats.totalDeals) * 100)
    : 0;
  const dealCount = stats.totalDeals || 0;

  // Pipeline Analytics chart — fed by the server-side byStage aggregation so
  // the chart reflects the full tenant, not a paginated slice. We map the
  // four headline stages and fall back to 0 when a stage is empty.
  const stageValue = (name) => {
    const row = (stats.byStage || []).find((r) => r.stage === name);
    return row ? row.value : 0;
  };
  const chartData = [
    { name: 'Lead', value: stageValue('lead') },
    { name: 'Contacted', value: stageValue('contacted') },
    { name: 'Proposal', value: stageValue('proposal') },
    { name: 'Won', value: stageValue('won') },
  ];

  const tiles = [
    { label: 'Closed Revenue',  value: formatMoney(totalRevenue),    icon: <DollarSign size={24} />, color: 'var(--accent-color)' },
    { label: 'Expected Revenue',value: formatMoney(expectedRevenue), icon: <Activity size={24} />,   color: 'var(--success-color)' },
    { label: 'Total Contacts',  value: activeLeads.toString(),       icon: <Users size={24} />,      color: '#3b82f6' },
    { label: 'Conversion Rate', value: `${conversionRate}%`,         icon: <TrendingUp size={24} />, color: 'var(--warning-color)' },
    { label: 'Total Deals',     value: dealCount.toString(),         icon: <Calendar size={24} />,   color: '#a855f7' }
  ];

  // #128: Cmd-K is macOS; show Ctrl-K on Windows/Linux. navigator.platform is
  // deprecated but still the most-supported way to detect this client-side.
  const isMac = typeof navigator !== 'undefined' &&
    /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || '');
  const shortcutKey = isMac ? 'Cmd' : 'Ctrl';

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '2.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: 'bold', background: 'linear-gradient(to right, var(--text-primary), var(--text-secondary))', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
            Enterprise Overview
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            Here's your business at a glance. Press <kbd style={{background:'var(--kbd-bg)', padding:'2px 6px', borderRadius:'4px', color:'var(--accent-color)'}}>{shortcutKey} K</kbd> to search globally.
          </p>
        </div>
        {/* #128: this button only navigates — rename so the label matches the action */}
        <button className="btn-primary" onClick={() => navigate('/reports')}>View Reports</button>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '1.5rem', marginBottom: '2.5rem' }}>
        {tiles.map((stat, i) => (
          <div key={i} className="card" style={{ padding: '1.5rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <div style={{ width: '48px', height: '48px', borderRadius: '12px', background: 'var(--subtle-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: stat.color, border: `1px solid ${stat.color}40`, boxShadow: `0 0 15px ${stat.color}40` }}>
              {stat.icon}
            </div>
            <div>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: '0.25rem' }}>{stat.label}</p>
              <h2 style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>{stat.value}</h2>
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)', gap: '1.5rem' }}>
        <div className="card" style={{ padding: '2rem', minHeight: '350px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
            <h3 style={{ fontSize: '1.25rem', fontWeight: '500' }}>Pipeline Analytics</h3>
          </div>
          <div style={{ width: '100%', height: '260px' }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.8}/>
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <XAxis dataKey="name" stroke="var(--text-secondary)" fontSize={12} tickLine={false} axisLine={false} />
                <YAxis stroke="var(--text-secondary)" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(value) => formatMoneyCompact(value)} />
                <Tooltip
                  contentStyle={{ backgroundColor: 'var(--tooltip-bg)', backdropFilter: 'blur(8px)', borderColor: 'rgba(59, 130, 246, 0.5)', borderRadius: '8px' }}
                  itemStyle={{ color: 'var(--text-primary)' }}
                />
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} />
                <Area type="monotone" dataKey="value" stroke="#3b82f6" strokeWidth={3} fillOpacity={1} fill="url(#colorValue)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="card" style={{ padding: '2rem' }}>
          <h3 style={{ fontSize: '1.25rem', fontWeight: '500', marginBottom: '1.5rem' }}>Recent Deals</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            {recentDeals.slice(0, 4).map((deal) => (
              // #466: row was wrapped in a div with onClick → navigate('/pipeline')
              // but reporters experienced it as "not clickable" because the
              // hand-cursor only appeared on the inner text, not on the gap
              // between bullet and label, and the destination was a generic
              // pipeline page with no context for the clicked deal. Switch to a
              // role="button" with explicit cursor:pointer covering the entire
              // row, pass the deal id via ?dealId so Pipeline can scroll/focus.
              <div
                key={deal.id}
                role="button"
                tabIndex={0}
                onClick={() => navigate(`/pipeline?dealId=${deal.id}`)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(`/pipeline?dealId=${deal.id}`); } }}
                className="table-row-hover"
                style={{ display: 'flex', alignItems: 'center', gap: '1rem', cursor: 'pointer', padding: '0.5rem', borderRadius: '8px', userSelect: 'none' }}
                title={`Open ${deal.title} in pipeline`}
              >
                <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: deal.stage === 'won' ? 'var(--success-color)' : 'var(--accent-color)', boxShadow: `0 0 8px ${deal.stage === 'won' ? 'var(--success-color)' : 'var(--accent-color)'}` }} />
                <div>
                  <p style={{ fontSize: '0.875rem', fontWeight: '500' }}>{deal.title}</p>
                  <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Status: {deal.stage.toUpperCase()}</p>
                </div>
              </div>
            ))}
            {recentDeals.length === 0 && <p style={{ color: 'var(--text-secondary)' }}>No deals in pipeline.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
