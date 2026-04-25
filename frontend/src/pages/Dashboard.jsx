import React, { useState, useEffect } from 'react';
import { Users, DollarSign, Activity, Calendar, TrendingUp } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { formatMoney, formatMoneyCompact } from '../utils/money';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { useNavigate } from 'react-router-dom';

export default function Dashboard() {
  const navigate = useNavigate();
  const [deals, setDeals] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [dateRange, setDateRange] = useState('all');

  useEffect(() => {
    fetchApi('/api/deals').then(d => setDeals(Array.isArray(d) ? d : [])).catch(() => setDeals([]));
    fetchApi('/api/contacts').then(d => setContacts(Array.isArray(d) ? d : [])).catch(() => setContacts([]));
  }, []);

  // Filter deals by date range
  const filterByDate = (items) => {
    if (dateRange === 'all') return items;
    const now = new Date();
    const days = { '7d': 7, '30d': 30, '90d': 90, '365d': 365 }[dateRange];
    const cutoff = new Date(now.getTime() - days * 86400000);
    return items.filter(d => new Date(d.createdAt) >= cutoff);
  };

  // #128: prior-period filter for real period-over-period deltas.
  // Only meaningful when a finite range is selected (not "all").
  const filterByPriorPeriod = (items) => {
    if (dateRange === 'all') return null;
    const now = new Date();
    const days = { '7d': 7, '30d': 30, '90d': 90, '365d': 365 }[dateRange];
    const periodStart = new Date(now.getTime() - days * 86400000);
    const priorStart = new Date(now.getTime() - 2 * days * 86400000);
    return items.filter(d => {
      const t = new Date(d.createdAt);
      return t >= priorStart && t < periodStart;
    });
  };

  const filteredDeals = filterByDate(deals);
  const priorDeals = filterByPriorPeriod(deals);
  const priorContacts = filterByPriorPeriod(contacts);

  const calculateExpectedRevenue = (ds) => {
    const probs = { lead: 0.1, contacted: 0.3, proposal: 0.7, won: 1.0 };
    return ds.reduce((sum, d) => sum + ((d.amount || 0) * (probs[d.stage] || 0)), 0);
  };
  const computeStats = (ds, cs) => {
    const won = ds.filter(d => d.stage === 'won');
    const totalRevenue = won.reduce((sum, d) => sum + (d.amount || 0), 0);
    const expected = calculateExpectedRevenue(ds);
    const contactCount = cs.length;
    const conversion = ds.length > 0 ? Math.round((won.length / ds.length) * 100) : 0;
    const dealCount = ds.length;
    return { totalRevenue, expected, contactCount, conversion, dealCount };
  };

  const cur = computeStats(filteredDeals, contacts);
  const prior = priorDeals ? computeStats(priorDeals, priorContacts || []) : null;
  const totalRevenue = cur.totalRevenue;
  const expectedRevenue = cur.expected;
  const activeLeads = cur.contactCount;
  const conversionRate = cur.conversion;

  // #128: real period-over-period delta. Returns `null` for un-comparable cases
  // (no prior period because range is "all", or prior baseline is 0 so % undefined).
  // Shown as em-dash in the UI rather than a fake "+22%".
  const pctChange = (current, previous) => {
    if (previous == null || previous === 0) return null;
    return Math.round(((current - previous) / previous) * 100);
  };
  
  // Aggregate data for chart (Revenue by Stage)
  const chartData = [
    { name: 'Lead', value: filteredDeals.filter(d=>d.stage==='lead').reduce((s,d)=>s+(d.amount||0),0) },
    { name: 'Contacted', value: filteredDeals.filter(d=>d.stage==='contacted').reduce((s,d)=>s+(d.amount||0),0) },
    { name: 'Proposal', value: filteredDeals.filter(d=>d.stage==='proposal').reduce((s,d)=>s+(d.amount||0),0) },
    { name: 'Won', value: totalRevenue }
  ];

  const stats = [
    { label: 'Closed Revenue',  value: formatMoney(totalRevenue),     deltaPct: prior ? pctChange(cur.totalRevenue, prior.totalRevenue) : null, icon: <DollarSign size={24} />, color: 'var(--accent-color)' },
    { label: 'Expected Revenue',value: formatMoney(expectedRevenue),  deltaPct: prior ? pctChange(cur.expected, prior.expected) : null,         icon: <Activity size={24} />,   color: 'var(--success-color)' },
    { label: 'Total Contacts',  value: activeLeads.toString(),        deltaPct: prior ? pctChange(cur.contactCount, prior.contactCount) : null, icon: <Users size={24} />,      color: '#3b82f6' },
    { label: 'Conversion Rate', value: `${conversionRate}%`,          deltaPct: prior ? pctChange(cur.conversion, prior.conversion) : null,     icon: <TrendingUp size={24} />, color: 'var(--warning-color)' },
    { label: 'Total Deals',     value: filteredDeals.length.toString(), deltaPct: prior ? pctChange(cur.dealCount, prior.dealCount) : null,     icon: <Calendar size={24} />,   color: '#a855f7' }
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
        {stats.map((stat, i) => (
          <div key={i} className="card" style={{ padding: '1.5rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <div style={{ width: '48px', height: '48px', borderRadius: '12px', background: 'var(--subtle-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: stat.color, border: `1px solid ${stat.color}40`, boxShadow: `0 0 15px ${stat.color}40` }}>
              {stat.icon}
            </div>
            <div>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: '0.25rem' }}>{stat.label}</p>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem' }}>
                <h2 style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>{stat.value}</h2>
                {(() => {
                  // #128: real period-over-period delta. Em-dash when not comparable
                  // (range = "all" or prior baseline = 0), green when up, red when down.
                  const d = stat.deltaPct;
                  if (d == null) {
                    return <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>—</span>;
                  }
                  const up = d >= 0;
                  return (
                    <span style={{ color: up ? 'var(--success-color)' : '#ef4444', fontSize: '0.75rem', display: 'flex', alignItems: 'center' }}>
                      <TrendingUp size={12} style={{ marginRight: '2px', transform: up ? 'none' : 'rotate(180deg)' }} />
                      {up ? '+' : ''}{d}%
                    </span>
                  );
                })()}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)', gap: '1.5rem' }}>
        <div className="card" style={{ padding: '2rem', minHeight: '350px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
            <h3 style={{ fontSize: '1.25rem', fontWeight: '500' }}>Pipeline Analytics</h3>
            <select className="input-field" style={{ width: 'auto', padding: '0.5rem' }} value={dateRange} onChange={e => setDateRange(e.target.value)}>
              <option value="all">All Time</option>
              <option value="7d">Last 7 Days</option>
              <option value="30d">Last 30 Days</option>
              <option value="90d">Last 90 Days</option>
              <option value="365d">This Year</option>
            </select>
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
            {filteredDeals.slice(0, 4).map((deal, i) => (
              <div key={i} className="table-row-hover" onClick={() => navigate('/pipeline')} style={{ display: 'flex', alignItems: 'center', gap: '1rem', cursor: 'pointer', padding: '0.5rem', borderRadius: '8px' }}>
                <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: deal.stage === 'won' ? 'var(--success-color)' : 'var(--accent-color)', boxShadow: `0 0 8px ${deal.stage === 'won' ? 'var(--success-color)' : 'var(--accent-color)'}` }} />
                <div>
                  <p style={{ fontSize: '0.875rem', fontWeight: '500' }}>{deal.title}</p>
                  <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Status: {deal.stage.toUpperCase()}</p>
                </div>
              </div>
            ))}
            {filteredDeals.length === 0 && <p style={{ color: 'var(--text-secondary)' }}>No deals in pipeline.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}