import React, { useState, useEffect, useContext } from 'react';
import { fetchApi } from '../utils/api';
import { AuthContext } from '../App';
import { TrendingUp, TrendingDown, Zap, Users, Target, RefreshCw, AlertCircle } from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell
} from 'recharts';

const SCORE_BANDS = [
  { label: '0–20', min: 0, max: 20, color: '#ef4444' },
  { label: '21–40', min: 21, max: 40, color: '#f97316' },
  { label: '41–60', min: 41, max: 60, color: '#f59e0b' },
  { label: '61–80', min: 61, max: 80, color: '#22c55e' },
  { label: '81–100', min: 81, max: 100, color: '#3b82f6' },
];

function ScoreBadge({ score }) {
  const color =
    score >= 70 ? '#22c55e' : score >= 40 ? '#f59e0b' : '#ef4444';
  const bg =
    score >= 70 ? 'rgba(34,197,94,0.1)' : score >= 40 ? 'rgba(245,158,11,0.1)' : 'rgba(239,68,68,0.1)';
  return (
    <span style={{
      padding: '0.25rem 0.75rem', borderRadius: '999px', fontSize: '0.75rem',
      fontWeight: 'bold', backgroundColor: bg, color,
    }}>
      {score}/100
    </span>
  );
}

export default function LeadScoring() {
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [triggering, setTriggering] = useState(false);
  const [lastRun, setLastRun] = useState(null);
  const { token } = useContext(AuthContext);

  const loadContacts = async () => {
    try {
      const data = await fetchApi('/api/contacts');
      setContacts(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadContacts(); }, []);

  const triggerRescore = async () => {
    setTriggering(true);
    try {
      const res = await fetchApi('/api/ai_scoring/trigger', { method: 'POST' });
      if (res.success) {
        setLastRun(new Date().toLocaleTimeString());
        await loadContacts();
      }
    } catch (e) {
      console.error(e);
    } finally {
      setTriggering(false);
    }
  };

  // Histogram data
  const histogramData = SCORE_BANDS.map(band => ({
    label: band.label,
    count: contacts.filter(c => c.aiScore >= band.min && c.aiScore <= band.max).length,
    color: band.color,
  }));

  const sortedContacts = [...contacts].sort((a, b) => b.aiScore - a.aiScore);
  const hotLeads = sortedContacts.filter(c => c.aiScore >= 70).slice(0, 10);
  const coldLeads = sortedContacts.filter(c => c.aiScore < 30).slice(-10).reverse();

  const avgScore = contacts.length
    ? Math.round(contacts.reduce((s, c) => s + c.aiScore, 0) / contacts.length)
    : 0;

  return (
    <div style={{ padding: '2rem', height: '100%', overflowY: 'auto', animation: 'fadeIn 0.5s ease-out' }}>
      {/* Header */}
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '2rem' }}>
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <Target size={28} color="var(--accent-color)" /> Lead Intelligence
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            AI-powered contact scoring — updated every 10 minutes via cron engine.
          </p>
        </div>
        <button
          id="trigger-rescore-btn"
          onClick={triggerRescore}
          disabled={triggering}
          className="btn-primary"
          style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', opacity: triggering ? 0.7 : 1 }}
        >
          <RefreshCw size={16} style={{ animation: triggering ? 'spin 1s linear infinite' : 'none' }} />
          {triggering ? 'Scoring...' : 'Re-score All'}
        </button>
      </header>

      {lastRun && (
        <div style={{ marginBottom: '1.5rem', padding: '0.75rem 1.25rem', background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.2)', borderRadius: '8px', display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--success-color)', fontSize: '0.875rem' }}>
          <Zap size={14} /> Scoring complete — last run at {lastRun}
        </div>
      )}

      {/* KPI Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '1.25rem', marginBottom: '2rem' }}>
        {[
          { label: 'Total Contacts', value: contacts.length, icon: <Users size={20} color="var(--accent-color)" />, color: 'var(--accent-color)' },
          { label: 'Average Score', value: avgScore + '/100', icon: <Target size={20} color="#f59e0b" />, color: '#f59e0b' },
          { label: 'Hot Leads (≥70)', value: hotLeads.length, icon: <TrendingUp size={20} color="var(--success-color)" />, color: 'var(--success-color)' },
          { label: 'Cold Leads (<30)', value: coldLeads.length, icon: <TrendingDown size={20} color="#ef4444" />, color: '#ef4444' },
        ].map(kpi => (
          <div key={kpi.label} className="card" style={{ padding: '1.5rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{kpi.label}</span>
              {kpi.icon}
            </div>
            <div style={{ fontSize: '2rem', fontWeight: 'bold', color: kpi.color }}>{kpi.value}</div>
          </div>
        ))}
      </div>

      {/* Score Distribution Chart */}
      <div className="card" style={{ padding: '2rem', marginBottom: '2rem' }}>
        <h3 style={{ fontSize: '1.1rem', fontWeight: '600', marginBottom: '1.5rem' }}>Score Distribution</h3>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={histogramData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
            <XAxis dataKey="label" tick={{ fontSize: 12, fill: 'var(--text-secondary)' }} />
            <YAxis tick={{ fontSize: 12, fill: 'var(--text-secondary)' }} allowDecimals={false} />
            <Tooltip
              contentStyle={{ background: '#1e293b', border: '1px solid var(--border-color)', borderRadius: '8px', color: '#fff' }}
              formatter={(v) => [`${v} contacts`, 'Count']}
            />
            <Bar dataKey="count" radius={[4, 4, 0, 0]}>
              {histogramData.map((entry, i) => (
                <Cell key={i} fill={entry.color} fillOpacity={0.85} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Hot & Cold Leads Side-by-Side */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>

        {/* Hot Leads */}
        <div className="card" style={{ padding: '1.5rem' }}>
          <h3 style={{ fontSize: '1.1rem', fontWeight: '600', marginBottom: '1.25rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <TrendingUp size={18} color="var(--success-color)" /> Top Hot Leads
          </h3>
          {loading ? (
            <p style={{ color: 'var(--text-secondary)', padding: '1rem 0' }}>Loading...</p>
          ) : hotLeads.length === 0 ? (
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>No hot leads yet. Run the scorer first.</p>
          ) : hotLeads.map((c, i) => (
            <div key={c.id} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '0.75rem 0', borderBottom: i < hotLeads.length - 1 ? '1px solid var(--border-color)' : 'none'
            }}>
              <div>
                <div style={{ fontWeight: '500', fontSize: '0.9rem' }}>{c.name}</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{c.company || c.email}</div>
              </div>
              <ScoreBadge score={c.aiScore} />
            </div>
          ))}
        </div>

        {/* Cold Leads */}
        <div className="card" style={{ padding: '1.5rem' }}>
          <h3 style={{ fontSize: '1.1rem', fontWeight: '600', marginBottom: '1.25rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <AlertCircle size={18} color="#ef4444" /> Cold / Decaying Leads
          </h3>
          {loading ? (
            <p style={{ color: 'var(--text-secondary)', padding: '1rem 0' }}>Loading...</p>
          ) : coldLeads.length === 0 ? (
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>No cold leads — great engagement!</p>
          ) : coldLeads.map((c, i) => (
            <div key={c.id} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '0.75rem 0', borderBottom: i < coldLeads.length - 1 ? '1px solid var(--border-color)' : 'none'
            }}>
              <div>
                <div style={{ fontWeight: '500', fontSize: '0.9rem' }}>{c.name}</div>
                <div style={{ fontSize: '0.75rem', color: '#ef4444' }}>⚠ Low engagement — score {c.aiScore}</div>
              </div>
              <ScoreBadge score={c.aiScore} />
            </div>
          ))}
        </div>
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
      `}</style>
    </div>
  );
}
