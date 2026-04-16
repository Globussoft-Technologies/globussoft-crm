import React, { useState, useEffect, useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
} from 'recharts';
import { fetchApi } from '../utils/api';
import {
  Award, Plus, Edit2, Trash2, Trophy, Table as TableIcon, BarChart3, Target,
} from 'lucide-react';

function currentQuarterLabel(offset = 0) {
  const now = new Date();
  let q = Math.floor(now.getMonth() / 3) + 1 + offset;
  let y = now.getFullYear();
  while (q > 4) { q -= 4; y += 1; }
  while (q < 1) { q += 4; y -= 1; }
  return `${y}-Q${q}`;
}

function buildPeriodOptions() {
  const now = new Date();
  return [
    { value: currentQuarterLabel(0), label: `Current Quarter (${currentQuarterLabel(0)})` },
    { value: currentQuarterLabel(1), label: `Next Quarter (${currentQuarterLabel(1)})` },
    { value: String(now.getFullYear()), label: `Year ${now.getFullYear()}` },
  ];
}

function fmtCurrency(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '$0';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function attainmentColor(pct) {
  if (pct >= 100) return '#22c55e';
  if (pct >= 75) return '#3b82f6';
  if (pct >= 50) return '#f59e0b';
  return '#ef4444';
}

export default function Quotas() {
  const periodOptions = useMemo(buildPeriodOptions, []);
  const [period, setPeriod] = useState(periodOptions[0].value);
  const [view, setView] = useState('table'); // table | leaderboard
  const [attainment, setAttainment] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ id: null, userId: '', target: '' });
  const [error, setError] = useState('');

  const loadAttainment = async () => {
    setLoading(true);
    try {
      const url = view === 'leaderboard'
        ? `/api/quotas/leaderboard?period=${encodeURIComponent(period)}`
        : `/api/quotas/attainment?period=${encodeURIComponent(period)}`;
      const data = await fetchApi(url);
      setAttainment(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error(e);
      setAttainment([]);
    } finally {
      setLoading(false);
    }
  };

  const loadUsers = async () => {
    try {
      const data = await fetchApi('/api/staff');
      setUsers(Array.isArray(data) ? data : []);
    } catch (e) {
      try {
        const fallback = await fetchApi('/api/users');
        setUsers(Array.isArray(fallback) ? fallback : []);
      } catch {
        setUsers([]);
      }
    }
  };

  useEffect(() => { loadUsers(); }, []);
  useEffect(() => { loadAttainment(); }, [period, view]);

  const openCreate = () => {
    setForm({ id: null, userId: users[0]?.id || '', target: '' });
    setError('');
    setShowModal(true);
  };

  const openEdit = (row) => {
    setForm({ id: row.quotaId, userId: row.userId, target: row.target });
    setError('');
    setShowModal(true);
  };

  const submitForm = async (e) => {
    e.preventDefault();
    setError('');
    try {
      if (form.id) {
        await fetchApi(`/api/quotas/${form.id}`, {
          method: 'PUT',
          body: JSON.stringify({ target: parseFloat(form.target) }),
        });
      } else {
        if (!form.userId) { setError('Select a user'); return; }
        await fetchApi('/api/quotas', {
          method: 'POST',
          body: JSON.stringify({
            userId: parseInt(form.userId, 10),
            period,
            target: parseFloat(form.target),
          }),
        });
      }
      setShowModal(false);
      await loadAttainment();
    } catch (e2) {
      setError(e2.message || 'Save failed');
    }
  };

  const deleteQuota = async (row) => {
    if (!window.confirm(`Delete quota for ${row.name}?`)) return;
    try {
      await fetchApi(`/api/quotas/${row.quotaId}`, { method: 'DELETE' });
      await loadAttainment();
    } catch (e) {
      alert(e.message || 'Delete failed');
    }
  };

  const totalTarget = attainment.reduce((s, r) => s + (r.target || 0), 0);
  const totalAchieved = attainment.reduce((s, r) => s + (r.achieved || 0), 0);
  const teamAttainment = totalTarget > 0
    ? Math.round((totalAchieved / totalTarget) * 1000) / 10
    : 0;

  const leaderboardData = [...attainment]
    .sort((a, b) => b.attainmentPct - a.attainmentPct)
    .map(r => ({ name: r.name, pct: r.attainmentPct, achieved: r.achieved, target: r.target }));

  return (
    <div style={{ padding: '2rem', height: '100%', overflowY: 'auto', animation: 'fadeIn 0.5s ease-out' }}>
      {/* Header */}
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '2rem', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.75rem', margin: 0 }}>
            <Award size={28} color="var(--accent-color)" /> Sales Quotas
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            Set targets per rep, then track attainment as deals close.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <select
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            className="input"
            style={{ minWidth: '200px' }}
          >
            {periodOptions.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
          <div style={{ display: 'inline-flex', background: 'var(--glass-bg)', border: '1px solid var(--glass-border)', borderRadius: '8px', padding: '0.25rem' }}>
            <button
              onClick={() => setView('table')}
              className={view === 'table' ? 'btn-primary' : ''}
              style={{ padding: '0.4rem 0.75rem', borderRadius: '6px', display: 'flex', alignItems: 'center', gap: '0.4rem', background: view === 'table' ? undefined : 'transparent', border: 'none', color: 'var(--text-primary)', cursor: 'pointer' }}
            >
              <TableIcon size={14} /> Table
            </button>
            <button
              onClick={() => setView('leaderboard')}
              className={view === 'leaderboard' ? 'btn-primary' : ''}
              style={{ padding: '0.4rem 0.75rem', borderRadius: '6px', display: 'flex', alignItems: 'center', gap: '0.4rem', background: view === 'leaderboard' ? undefined : 'transparent', border: 'none', color: 'var(--text-primary)', cursor: 'pointer' }}
            >
              <BarChart3 size={14} /> Leaderboard
            </button>
          </div>
          <button onClick={openCreate} className="btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Plus size={16} /> Set Quota
          </button>
        </div>
      </header>

      {/* KPI tiles */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1.25rem', marginBottom: '2rem' }}>
        {[
          { label: 'Reps with Quota', value: attainment.length, icon: <Target size={20} color="var(--accent-color)" /> },
          { label: 'Team Target', value: fmtCurrency(totalTarget), icon: <Award size={20} color="#a855f7" /> },
          { label: 'Team Achieved', value: fmtCurrency(totalAchieved), icon: <Trophy size={20} color="#22c55e" /> },
          { label: 'Team Attainment', value: `${teamAttainment}%`, icon: <BarChart3 size={20} color={attainmentColor(teamAttainment)} /> },
        ].map(k => (
          <div key={k.label} className="card" style={{ padding: '1.25rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
              <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>{k.label}</span>
              {k.icon}
            </div>
            <div style={{ fontSize: '1.6rem', fontWeight: 'bold' }}>{k.value}</div>
          </div>
        ))}
      </div>

      {/* Main view */}
      {loading ? (
        <div className="card" style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
          Loading quotas…
        </div>
      ) : view === 'leaderboard' ? (
        <div className="card" style={{ padding: '1.5rem' }}>
          <h3 style={{ marginTop: 0, marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Trophy size={18} color="#f59e0b" /> Leaderboard — {period}
          </h3>
          {leaderboardData.length === 0 ? (
            <p style={{ color: 'var(--text-secondary)' }}>No quotas set for this period yet.</p>
          ) : (
            <ResponsiveContainer width="100%" height={Math.max(260, leaderboardData.length * 50)}>
              <BarChart data={leaderboardData} layout="vertical" margin={{ left: 80, right: 24 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis type="number" stroke="var(--text-secondary)" tickFormatter={(v) => `${v}%`} />
                <YAxis type="category" dataKey="name" stroke="var(--text-secondary)" width={140} />
                <Tooltip
                  contentStyle={{ background: 'rgba(15,23,42,0.95)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px' }}
                  formatter={(v, n, p) => [`${v}% (${fmtCurrency(p.payload.achieved)} / ${fmtCurrency(p.payload.target)})`, 'Attainment']}
                />
                <Bar dataKey="pct" radius={[0, 6, 6, 0]}>
                  {leaderboardData.map((row, i) => (
                    <Cell key={i} fill={attainmentColor(row.pct)} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'rgba(255,255,255,0.04)' }}>
                <th style={th}>Rep</th>
                <th style={th}>Target</th>
                <th style={th}>Achieved</th>
                <th style={{ ...th, width: '32%' }}>Attainment</th>
                <th style={{ ...th, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {attainment.length === 0 ? (
                <tr><td colSpan={5} style={{ ...td, textAlign: 'center', color: 'var(--text-secondary)', padding: '2rem' }}>
                  No quotas configured for {period}. Click <strong>Set Quota</strong> above.
                </td></tr>
              ) : attainment.map(row => (
                <tr key={row.quotaId} style={{ borderTop: '1px solid var(--glass-border)' }}>
                  <td style={td}>{row.name}</td>
                  <td style={td}>{fmtCurrency(row.target)}</td>
                  <td style={td}>{fmtCurrency(row.achieved)}</td>
                  <td style={td}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                      <div style={{ flex: 1, height: '10px', background: 'rgba(255,255,255,0.06)', borderRadius: '999px', overflow: 'hidden' }}>
                        <div style={{
                          width: `${Math.min(100, row.attainmentPct)}%`,
                          height: '100%',
                          background: attainmentColor(row.attainmentPct),
                          transition: 'width 0.4s ease',
                        }} />
                      </div>
                      <span style={{ minWidth: '52px', textAlign: 'right', fontWeight: 600, color: attainmentColor(row.attainmentPct) }}>
                        {row.attainmentPct}%
                      </span>
                    </div>
                  </td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    <button onClick={() => openEdit(row)} title="Edit target" style={iconBtn}>
                      <Edit2 size={14} />
                    </button>
                    <button onClick={() => deleteQuota(row)} title="Delete quota" style={{ ...iconBtn, color: '#ef4444' }}>
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Modal */}
      {showModal && (
        <div onClick={() => setShowModal(false)} style={modalBackdrop}>
          <div onClick={(e) => e.stopPropagation()} className="card" style={modalCard}>
            <h3 style={{ marginTop: 0 }}>{form.id ? 'Edit Quota' : 'Set Quota'}</h3>
            <form onSubmit={submitForm} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {!form.id && (
                <label style={lbl}>
                  <span>Sales Rep</span>
                  <select
                    value={form.userId}
                    onChange={(e) => setForm(f => ({ ...f, userId: e.target.value }))}
                    className="input"
                    required
                  >
                    <option value="">Select user…</option>
                    {users.map(u => (
                      <option key={u.id} value={u.id}>
                        {u.name || u.email} {u.role ? `(${u.role})` : ''}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label style={lbl}>
                <span>Period</span>
                <input className="input" value={period} disabled />
              </label>
              <label style={lbl}>
                <span>Target Amount (USD)</span>
                <input
                  type="number"
                  min="0"
                  step="100"
                  value={form.target}
                  onChange={(e) => setForm(f => ({ ...f, target: e.target.value }))}
                  className="input"
                  required
                />
              </label>
              {error && <div style={{ color: '#ef4444', fontSize: '0.85rem' }}>{error}</div>}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.5rem' }}>
                <button type="button" onClick={() => setShowModal(false)} style={{ ...iconBtn, padding: '0.5rem 1rem' }}>Cancel</button>
                <button type="submit" className="btn-primary">{form.id ? 'Update' : 'Save'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

const th = { padding: '0.85rem 1rem', textAlign: 'left', fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-secondary)' };
const td = { padding: '0.85rem 1rem', fontSize: '0.9rem' };
const iconBtn = {
  background: 'transparent',
  border: '1px solid var(--glass-border)',
  borderRadius: '6px',
  padding: '0.4rem 0.5rem',
  marginLeft: '0.4rem',
  color: 'var(--text-primary)',
  cursor: 'pointer',
};
const lbl = { display: 'flex', flexDirection: 'column', gap: '0.35rem', fontSize: '0.85rem', color: 'var(--text-secondary)' };
const modalBackdrop = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
  backdropFilter: 'blur(4px)',
};
const modalCard = { padding: '1.75rem', width: '100%', maxWidth: '440px' };
