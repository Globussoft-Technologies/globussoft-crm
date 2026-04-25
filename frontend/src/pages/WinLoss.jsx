import React, { useState, useEffect, useMemo } from 'react';
import {
  PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend,
} from 'recharts';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import {
  BadgePercent, Trophy, X, DollarSign, Calendar, Plus, Trash2,
} from 'lucide-react';

function fmtCurrency(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '$0';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function defaultRange() {
  const to = new Date();
  const from = new Date();
  from.setMonth(from.getMonth() - 3);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { from: fmt(from), to: fmt(to) };
}

export default function WinLoss() {
  const notify = useNotify();
  const initial = useMemo(defaultRange, []);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [analysis, setAnalysis] = useState(null);
  const [reasons, setReasons] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showReasonModal, setShowReasonModal] = useState(false);
  const [newReason, setNewReason] = useState({ type: 'lost', reason: '' });

  const loadAnalysis = async () => {
    setLoading(true);
    try {
      const data = await fetchApi(`/api/win-loss/analysis?from=${from}&to=${to}`);
      setAnalysis(data);
    } catch (e) {
      console.error(e);
      setAnalysis(null);
    } finally {
      setLoading(false);
    }
  };

  const loadReasons = async () => {
    try {
      const data = await fetchApi('/api/win-loss/reasons');
      setReasons(Array.isArray(data) ? data : []);
    } catch {
      setReasons([]);
    }
  };

  useEffect(() => { loadReasons(); }, []);
  useEffect(() => { loadAnalysis(); }, [from, to]);

  const createReason = async (e) => {
    e.preventDefault();
    if (!newReason.reason.trim()) return;
    try {
      await fetchApi('/api/win-loss/reasons', {
        method: 'POST',
        body: JSON.stringify(newReason),
      });
      setNewReason({ type: 'lost', reason: '' });
      setShowReasonModal(false);
      await loadReasons();
    } catch (err) {
      notify.error(err.message || 'Failed to create reason');
    }
  };

  const deleteReason = async (id) => {
    if (!await notify.confirm({
      title: 'Delete reason',
      message: 'Delete this reason?',
      confirmText: 'Delete',
      destructive: true,
    })) return;
    try {
      await fetchApi(`/api/win-loss/reasons/${id}`, { method: 'DELETE' });
      await loadReasons();
    } catch (err) {
      notify.error(err.message || 'Delete failed');
    }
  };

  const wonCount = analysis?.wonCount || 0;
  const lostCount = analysis?.lostCount || 0;
  const winRate = analysis?.winRate || 0;
  const avgWon = analysis?.avgDealSize?.won || 0;
  const avgLost = analysis?.avgDealSize?.lost || 0;
  const byReason = analysis?.byReason || [];
  const closedDeals = analysis?.closedDeals || [];

  const pieData = [
    { name: 'Won', value: wonCount, color: '#22c55e' },
    { name: 'Lost', value: lostCount, color: '#ef4444' },
  ].filter(d => d.value > 0);

  const lossReasons = byReason.filter(r => r.type === 'lost').slice(0, 8);

  return (
    <div style={{ padding: '2rem', height: '100%', overflowY: 'auto', animation: 'fadeIn 0.5s ease-out' }}>
      {/* Header */}
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '2rem', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.75rem', margin: 0 }}>
            <BadgePercent size={28} color="var(--accent-color)" /> Win/Loss Analysis
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            Understand why deals close and what's costing you revenue.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Calendar size={14} color="var(--text-secondary)" />
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="input" />
            <span style={{ color: 'var(--text-secondary)' }}>→</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="input" />
          </div>
          <button onClick={() => setShowReasonModal(true)} className="btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Plus size={16} /> Manage Reasons
          </button>
        </div>
      </header>

      {/* KPI cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1.25rem', marginBottom: '2rem' }}>
        <div className="card" style={kpiCard}>
          <div style={kpiHead}>
            <span style={kpiLabel}>Win Rate</span>
            <BadgePercent size={20} color="#3b82f6" />
          </div>
          <div style={{ ...kpiValue, color: winRate >= 50 ? '#22c55e' : '#f59e0b' }}>{winRate}%</div>
          <div style={kpiSub}>{wonCount} won · {lostCount} lost</div>
        </div>
        <div className="card" style={kpiCard}>
          <div style={kpiHead}>
            <span style={kpiLabel}>Avg Won Deal</span>
            <Trophy size={20} color="#22c55e" />
          </div>
          <div style={{ ...kpiValue, color: '#22c55e' }}>{fmtCurrency(avgWon)}</div>
          <div style={kpiSub}>across {wonCount} closed-won</div>
        </div>
        <div className="card" style={kpiCard}>
          <div style={kpiHead}>
            <span style={kpiLabel}>Avg Lost Deal</span>
            <DollarSign size={20} color="#ef4444" />
          </div>
          <div style={{ ...kpiValue, color: '#ef4444' }}>{fmtCurrency(avgLost)}</div>
          <div style={kpiSub}>across {lostCount} closed-lost</div>
        </div>
      </div>

      {/* Charts row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: '1.25rem', marginBottom: '2rem' }}>
        <div className="card" style={{ padding: '1.5rem' }}>
          <h3 style={chartTitle}>Won vs Lost</h3>
          {pieData.length === 0 ? (
            <div style={emptyState}>No closed deals in this range.</div>
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <PieChart>
                <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={100} label={(p) => `${p.name}: ${p.value}`}>
                  {pieData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                </Pie>
                <Tooltip contentStyle={tooltipStyle} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="card" style={{ padding: '1.5rem' }}>
          <h3 style={chartTitle}>Top Loss Reasons</h3>
          {lossReasons.length === 0 ? (
            <div style={emptyState}>No tracked loss reasons yet.</div>
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={lossReasons} layout="vertical" margin={{ left: 30, right: 24 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis type="number" stroke="var(--text-secondary)" allowDecimals={false} />
                <YAxis type="category" dataKey="reason" stroke="var(--text-secondary)" width={140} />
                <Tooltip contentStyle={tooltipStyle} />
                <Bar dataKey="count" fill="#ef4444" radius={[0, 6, 6, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Recent closed deals */}
      <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: '2rem' }}>
        <div style={{ padding: '1rem 1.5rem', borderBottom: '1px solid var(--glass-border)' }}>
          <h3 style={{ margin: 0 }}>Recent Closed Deals</h3>
        </div>
        {loading ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Loading…</div>
        ) : closedDeals.length === 0 ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>No closed deals in this range.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'rgba(255,255,255,0.04)' }}>
                <th style={th}>Deal</th>
                <th style={th}>Stage</th>
                <th style={th}>Amount</th>
                <th style={th}>Reason</th>
                <th style={th}>Closed</th>
              </tr>
            </thead>
            <tbody>
              {closedDeals.map(d => (
                <tr key={d.id} style={{ borderTop: '1px solid var(--glass-border)' }}>
                  <td style={td}>{d.title}</td>
                  <td style={td}>
                    <span style={{
                      padding: '0.2rem 0.55rem',
                      borderRadius: '999px',
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      background: d.stage === 'won' ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)',
                      color: d.stage === 'won' ? '#22c55e' : '#ef4444',
                    }}>
                      {d.stage.toUpperCase()}
                    </span>
                  </td>
                  <td style={td}>{fmtCurrency(d.amount)}</td>
                  <td style={{ ...td, color: d.reason ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
                    {d.reason || '—'}
                  </td>
                  <td style={td}>{d.createdAt ? new Date(d.createdAt).toLocaleDateString() : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Reasons modal */}
      {showReasonModal && (
        <div onClick={() => setShowReasonModal(false)} style={modalBackdrop}>
          <div onClick={(e) => e.stopPropagation()} className="card" style={modalCard}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 style={{ margin: 0 }}>Manage Win/Loss Reasons</h3>
              <button onClick={() => setShowReasonModal(false)} style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                <X size={18} />
              </button>
            </div>

            <form onSubmit={createReason} style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
              <select
                value={newReason.type}
                onChange={(e) => setNewReason({ ...newReason, type: e.target.value })}
                className="input"
                style={{ width: '110px' }}
              >
                <option value="lost">Lost</option>
                <option value="won">Won</option>
              </select>
              <input
                type="text"
                placeholder="e.g. Price too high"
                value={newReason.reason}
                onChange={(e) => setNewReason({ ...newReason, reason: e.target.value })}
                className="input"
                style={{ flex: 1 }}
                required
              />
              <button type="submit" className="btn-primary"><Plus size={14} /></button>
            </form>

            <div style={{ maxHeight: '320px', overflowY: 'auto' }}>
              {reasons.length === 0 ? (
                <div style={{ padding: '1rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
                  No reasons defined yet.
                </div>
              ) : reasons.map(r => (
                <div key={r.id} style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '0.6rem 0.75rem',
                  borderRadius: '6px',
                  marginBottom: '0.35rem',
                  background: 'rgba(255,255,255,0.03)',
                }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
                    <span style={{
                      padding: '0.15rem 0.5rem',
                      borderRadius: '999px',
                      fontSize: '0.7rem',
                      fontWeight: 600,
                      background: r.type === 'won' ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)',
                      color: r.type === 'won' ? '#22c55e' : '#ef4444',
                    }}>
                      {r.type.toUpperCase()}
                    </span>
                    <span>{r.reason}</span>
                    {r.count > 0 && (
                      <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>· used {r.count}×</span>
                    )}
                  </span>
                  <button onClick={() => deleteReason(r.id)} style={{ background: 'transparent', border: 'none', color: '#ef4444', cursor: 'pointer' }}>
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const th = { padding: '0.85rem 1.5rem', textAlign: 'left', fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-secondary)' };
const td = { padding: '0.85rem 1.5rem', fontSize: '0.9rem' };
const kpiCard = { padding: '1.25rem' };
const kpiHead = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' };
const kpiLabel = { color: 'var(--text-secondary)', fontSize: '0.85rem' };
const kpiValue = { fontSize: '1.75rem', fontWeight: 'bold' };
const kpiSub = { color: 'var(--text-secondary)', fontSize: '0.8rem', marginTop: '0.25rem' };
const chartTitle = { margin: 0, marginBottom: '1rem', fontSize: '1rem' };
const emptyState = { padding: '4rem 1rem', textAlign: 'center', color: 'var(--text-secondary)' };
const tooltipStyle = { background: 'rgba(15,23,42,0.95)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px' };
const modalBackdrop = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
  backdropFilter: 'blur(4px)',
};
const modalCard = { padding: '1.75rem', width: '100%', maxWidth: '520px' };
