import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, Calendar, IndianRupee, Sparkles, TrendingUp, Users, Bell, ArrowRight, Stethoscope } from 'lucide-react';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { fetchApi } from '../../utils/api';

const formatRupees = (n) => `₹${Math.round(n || 0).toLocaleString('en-IN')}`;

const StatCard = ({ icon: Icon, label, value, sub, color }) => (
  <div className="glass" style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
      <Icon size={16} color={color} /> {label}
    </div>
    <div style={{ fontSize: '1.6rem', fontWeight: 600, fontFamily: 'var(--font-family)' }}>{value}</div>
    {sub && <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{sub}</div>}
  </div>
);

export default function OwnerDashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchApi('/api/wellness/dashboard')
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div style={{ padding: '2rem' }}>Loading owner dashboard…</div>;
  if (!data) return <div style={{ padding: '2rem' }}>Could not load dashboard. Make sure your tenant has the Wellness vertical enabled.</div>;

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ fontFamily: 'var(--font-family)', fontSize: '1.75rem', fontWeight: 600 }}>Good morning</h1>
        <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
          Here's the snapshot for today — {new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}
        </p>
      </header>

      {/* KPI grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
        <StatCard icon={Calendar} label="Today's appointments" value={data.today.visits} sub={`${data.today.completed} completed so far`} color="var(--accent-color)" />
        <StatCard icon={IndianRupee} label="Today's expected revenue" value={formatRupees(data.today.expectedRevenue)} sub="based on scheduled services" color="var(--success-color)" />
        <StatCard icon={Activity} label="Occupancy" value={`${data.today.occupancyPct}%`} sub="vs target 100%" color={data.today.occupancyPct >= 60 ? 'var(--success-color)' : 'var(--warning-color)'} />
        <StatCard icon={Users} label="New leads today" value={data.today.newLeads} sub="across all channels" color="#3b82f6" />
        <StatCard icon={Bell} label="Pending approvals" value={data.pendingApprovals} sub="from the AI agent" color="#a855f7" />
        <StatCard icon={Stethoscope} label="Active treatment plans" value={data.activeTreatmentPlans} sub="multi-session bundles in progress" color="#ec4899" />
      </div>

      {/* Yesterday vs Today + Recommendations side by side */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1.5rem' }}>
        <div className="glass" style={{ padding: '1.25rem' }}>
          <h3 style={{ marginBottom: '0.75rem', fontSize: '1rem', fontWeight: 600 }}>Yesterday's actuals</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.75rem' }}>
            <div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Visits</div>
              <div style={{ fontSize: '1.4rem', fontWeight: 600 }}>{data.yesterday.visits}</div>
            </div>
            <div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Completed</div>
              <div style={{ fontSize: '1.4rem', fontWeight: 600 }}>{data.yesterday.completed}</div>
            </div>
            <div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Revenue</div>
              <div style={{ fontSize: '1.4rem', fontWeight: 600 }}>{formatRupees(data.yesterday.revenue)}</div>
            </div>
          </div>
        </div>

        <div className="glass" style={{ padding: '1.25rem' }}>
          <h3 style={{ marginBottom: '0.75rem', fontSize: '1rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Sparkles size={16} color="#a855f7" /> Top recommendation
          </h3>
          {data.pendingRecommendations.length > 0 ? (
            <>
              <div style={{ fontSize: '0.95rem', fontWeight: 500 }}>{data.pendingRecommendations[0].title}</div>
              <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: '0.4rem', lineHeight: 1.4 }}>
                {data.pendingRecommendations[0].body}
              </div>
              <Link to="/wellness/recommendations" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', marginTop: '0.75rem', fontSize: '0.85rem', color: 'var(--accent-color)' }}>
                Review all {data.pendingApprovals} <ArrowRight size={14} />
              </Link>
            </>
          ) : (
            <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>No pending recommendations.</div>
          )}
        </div>
      </div>

      {/* Revenue trend */}
      <div className="glass" style={{ padding: '1.25rem', marginBottom: '1.5rem' }}>
        <h3 style={{ marginBottom: '0.75rem', fontSize: '1rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <TrendingUp size={16} /> Revenue — last 30 days
        </h3>
        <div style={{ height: 220 }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data.revenueTrend}>
              <defs>
                <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--accent-color)" stopOpacity={0.6} />
                  <stop offset="95%" stopColor="var(--accent-color)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="date" stroke="var(--text-secondary)" tick={{ fontSize: 10 }} interval={6} />
              <YAxis stroke="var(--text-secondary)" tick={{ fontSize: 10 }} tickFormatter={(v) => `₹${Math.round(v / 1000)}k`} />
              <Tooltip
                contentStyle={{ background: 'rgba(20, 20, 25, 0.95)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8 }}
                labelStyle={{ color: 'var(--text-secondary)' }}
                formatter={(v) => [formatRupees(v), 'Revenue']}
              />
              <Area type="monotone" dataKey="revenue" stroke="var(--accent-color)" fill="url(#revGrad)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Quick links */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem' }}>
        <Link to="/wellness/patients" className="glass" style={{ padding: '1rem', textDecoration: 'none', color: 'inherit', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span><Users size={18} style={{ verticalAlign: 'middle', marginRight: '0.5rem' }} /> Patients ({data.totals.patients})</span>
          <ArrowRight size={16} />
        </Link>
        <Link to="/wellness/services" className="glass" style={{ padding: '1rem', textDecoration: 'none', color: 'inherit', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span><Sparkles size={18} style={{ verticalAlign: 'middle', marginRight: '0.5rem' }} /> Service catalog ({data.totals.services})</span>
          <ArrowRight size={16} />
        </Link>
        <Link to="/wellness/recommendations" className="glass" style={{ padding: '1rem', textDecoration: 'none', color: 'inherit', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span><Bell size={18} style={{ verticalAlign: 'middle', marginRight: '0.5rem' }} /> Agent inbox ({data.pendingApprovals})</span>
          <ArrowRight size={16} />
        </Link>
      </div>
    </div>
  );
}
