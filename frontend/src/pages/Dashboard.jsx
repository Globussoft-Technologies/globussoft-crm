import React, { useState, useEffect } from 'react';
import { Users, DollarSign, Activity, Calendar, TrendingUp } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';

export default function Dashboard() {
  const [deals, setDeals] = useState([]);
  const [contacts, setContacts] = useState([]);

  useEffect(() => {
    fetchApi('/api/deals').then(setDeals);
    fetchApi('/api/contacts').then(setContacts);
  }, []);

  // Compute stats
  const totalRevenue = deals.filter(d => d.stage === 'won').reduce((sum, d) => sum + (d.amount || 0), 0);
  const activeLeads = contacts.length;
  const conversionRate = deals.length > 0 ? Math.round((deals.filter(d => d.stage === 'won').length / deals.length) * 100) : 0;
  
  // Aggregate data for chart (Revenue by Stage)
  const chartData = [
    { name: 'Lead', value: deals.filter(d=>d.stage==='lead').reduce((s,d)=>s+d.amount,0) },
    { name: 'Contacted', value: deals.filter(d=>d.stage==='contacted').reduce((s,d)=>s+d.amount,0) },
    { name: 'Proposal', value: deals.filter(d=>d.stage==='proposal').reduce((s,d)=>s+d.amount,0) },
    { name: 'Won', value: totalRevenue }
  ];

  const stats = [
    { label: 'Closed Revenue', value: `$${totalRevenue.toLocaleString()}`, increase: '+14%', icon: <DollarSign size={24} />, color: 'var(--accent-color)' },
    { label: 'Total Contacts', value: activeLeads.toString(), increase: '+5%', icon: <Users size={24} />, color: 'var(--success-color)' },
    { label: 'Conversion Rate', value: `${conversionRate}%`, increase: '+1.2%', icon: <Activity size={24} />, color: 'var(--warning-color)' },
    { label: 'Total Deals', value: deals.length.toString(), increase: '+22%', icon: <Calendar size={24} />, color: '#a855f7' }
  ];

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '2.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: 'bold', background: 'linear-gradient(to right, #fff, #94a3b8)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
            Enterprise Overview
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>Here's your business at a glance. Press <kbd style={{background:'rgba(255,255,255,0.1)', padding:'2px 6px', borderRadius:'4px', color:'var(--accent-color)'}}>Cmd K</kbd> to search globally.</p>
        </div>
        <button className="btn-primary">Generate Report</button>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '1.5rem', marginBottom: '2.5rem' }}>
        {stats.map((stat, i) => (
          <div key={i} className="card" style={{ padding: '1.5rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <div style={{ width: '48px', height: '48px', borderRadius: '12px', background: `rgba(255,255,255,0.05)`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: stat.color, border: `1px solid ${stat.color}40`, boxShadow: `0 0 15px ${stat.color}40` }}>
              {stat.icon}
            </div>
            <div>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: '0.25rem' }}>{stat.label}</p>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem' }}>
                <h2 style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>{stat.value}</h2>
                <span style={{ color: 'var(--success-color)', fontSize: '0.75rem', display: 'flex', alignItems: 'center' }}>
                  <TrendingUp size={12} style={{ marginRight: '2px' }}/> {stat.increase}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)', gap: '1.5rem' }}>
        <div className="card" style={{ padding: '2rem', minHeight: '350px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
            <h3 style={{ fontSize: '1.25rem', fontWeight: '500' }}>Pipeline Analytics</h3>
            <select className="input-field" style={{ width: 'auto', padding: '0.5rem' }}>
              <option>All Time</option>
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
                <YAxis stroke="var(--text-secondary)" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(value) => `$${value/1000}k`} />
                <Tooltip 
                  contentStyle={{ backgroundColor: 'rgba(11, 12, 16, 0.9)', backdropFilter: 'blur(8px)', borderColor: 'rgba(59, 130, 246, 0.5)', borderRadius: '8px' }}
                  itemStyle={{ color: '#fff' }}
                />
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
                <Area type="monotone" dataKey="value" stroke="#3b82f6" strokeWidth={3} fillOpacity={1} fill="url(#colorValue)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
        
        <div className="card" style={{ padding: '2rem' }}>
          <h3 style={{ fontSize: '1.25rem', fontWeight: '500', marginBottom: '1.5rem' }}>Recent Deals</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            {deals.slice(0, 4).map((deal, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: deal.stage === 'won' ? 'var(--success-color)' : 'var(--accent-color)', boxShadow: `0 0 8px ${deal.stage === 'won' ? 'var(--success-color)' : 'var(--accent-color)'}` }} />
                <div>
                  <p style={{ fontSize: '0.875rem', fontWeight: '500' }}>{deal.title}</p>
                  <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Status: {deal.stage.toUpperCase()}</p>
                </div>
              </div>
            ))}
            {deals.length === 0 && <p style={{ color: 'var(--text-secondary)' }}>No deals in pipeline.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}