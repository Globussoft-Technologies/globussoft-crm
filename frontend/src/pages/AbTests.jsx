import React, { useEffect, useMemo, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { PenTool, Play, Trophy, BarChart3, X, Plus, Trash2 } from 'lucide-react';
import { fetchApi } from '../utils/api';

const glassCard = {
  background: 'var(--glass-bg, rgba(255,255,255,0.06))',
  backdropFilter: 'blur(20px)',
  border: '1px solid var(--border-color, rgba(255,255,255,0.1))',
  borderRadius: '16px',
  padding: '1.5rem',
  boxShadow: '0 4px 30px rgba(0,0,0,0.1)',
};

const STATUS_COLORS = {
  DRAFT: { bg: 'rgba(148,163,184,0.2)', fg: '#94a3b8', border: 'rgba(148,163,184,0.4)' },
  RUNNING: { bg: 'rgba(59,130,246,0.2)', fg: '#3b82f6', border: 'rgba(59,130,246,0.4)' },
  COMPLETED: { bg: 'rgba(16,185,129,0.2)', fg: '#10b981', border: 'rgba(16,185,129,0.4)' },
};

function StatusBadge({ status }) {
  const s = STATUS_COLORS[status] || STATUS_COLORS.DRAFT;
  return (
    <span style={{
      padding: '0.25rem 0.625rem',
      borderRadius: '999px',
      background: s.bg,
      color: s.fg,
      border: `1px solid ${s.border}`,
      fontSize: '0.7rem',
      fontWeight: 700,
      letterSpacing: '0.05em',
      textTransform: 'uppercase',
    }}>{status}</span>
  );
}

function ctr(sent, clicked) {
  if (!sent) return 0;
  return Math.round((clicked / sent) * 10000) / 100;
}

function prettyJson(obj) {
  try {
    return JSON.stringify(obj || {}, null, 2);
  } catch (_e) {
    return '{}';
  }
}

// ── Create modal ─────────────────────────────────────────────────
function CreateModal({ onClose, onCreated, campaigns }) {
  const [name, setName] = useState('');
  const [campaignId, setCampaignId] = useState('');
  const [variantA, setVariantA] = useState('{\n  "subject": "Save 20% today",\n  "body": "Hi {{name}}, check out our new offer..."\n}');
  const [variantB, setVariantB] = useState('{\n  "subject": "Your exclusive deal awaits",\n  "body": "Hi {{name}}, unlock special pricing..."\n}');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async () => {
    setError('');
    let parsedA, parsedB;
    try { parsedA = JSON.parse(variantA); } catch { setError('Variant A is not valid JSON'); return; }
    try { parsedB = JSON.parse(variantB); } catch { setError('Variant B is not valid JSON'); return; }
    if (!name.trim()) { setError('Name is required'); return; }

    setSaving(true);
    try {
      const created = await fetchApi('/api/ab-tests', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          campaignId: campaignId ? Number(campaignId) : null,
          variantA: parsedA,
          variantB: parsedB,
        }),
      });
      onCreated(created);
    } catch (err) {
      setError(err.message || 'Failed to create');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '1rem',
    }}>
      <div style={{ ...glassCard, width: 'min(760px, 100%)', maxHeight: '90vh', overflowY: 'auto', background: 'rgba(20,20,30,0.95)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h2 style={{ margin: 0, color: 'var(--text-primary)' }}>Create A/B Test</h2>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}>
            <X size={20} />
          </button>
        </div>

        <div style={{ display: 'grid', gap: '1rem' }}>
          <div>
            <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.35rem' }}>Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Summer Promo – Subject Line Test"
              style={{
                width: '100%', padding: '0.6rem 0.85rem',
                background: 'rgba(255,255,255,0.05)', color: 'var(--text-primary)',
                border: '1px solid rgba(255,255,255,0.1)', borderRadius: '10px', outline: 'none',
              }}
            />
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.35rem' }}>Linked Campaign (optional)</label>
            <select
              value={campaignId}
              onChange={(e) => setCampaignId(e.target.value)}
              style={{
                width: '100%', padding: '0.6rem 0.85rem',
                background: 'rgba(255,255,255,0.05)', color: 'var(--text-primary)',
                border: '1px solid rgba(255,255,255,0.1)', borderRadius: '10px', outline: 'none',
              }}
            >
              <option value="">— None —</option>
              {campaigns.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.35rem' }}>Variant A (JSON)</label>
              <textarea
                value={variantA}
                onChange={(e) => setVariantA(e.target.value)}
                spellCheck={false}
                style={{
                  width: '100%', minHeight: 180, padding: '0.6rem 0.85rem',
                  background: 'rgba(255,255,255,0.05)', color: 'var(--text-primary)',
                  border: '1px solid rgba(255,255,255,0.1)', borderRadius: '10px', outline: 'none',
                  fontFamily: 'monospace', fontSize: '0.85rem', resize: 'vertical',
                }}
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.35rem' }}>Variant B (JSON)</label>
              <textarea
                value={variantB}
                onChange={(e) => setVariantB(e.target.value)}
                spellCheck={false}
                style={{
                  width: '100%', minHeight: 180, padding: '0.6rem 0.85rem',
                  background: 'rgba(255,255,255,0.05)', color: 'var(--text-primary)',
                  border: '1px solid rgba(255,255,255,0.1)', borderRadius: '10px', outline: 'none',
                  fontFamily: 'monospace', fontSize: '0.85rem', resize: 'vertical',
                }}
              />
            </div>
          </div>

          {error && (
            <div style={{ padding: '0.6rem 0.85rem', borderRadius: '10px', background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.4)', color: '#ef4444', fontSize: '0.85rem' }}>
              {error}
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
            <button onClick={onClose} style={{ padding: '0.6rem 1rem', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '10px', cursor: 'pointer' }}>Cancel</button>
            <button
              onClick={handleSubmit}
              disabled={saving}
              style={{ padding: '0.6rem 1rem', background: 'var(--accent-color, #3b82f6)', color: '#fff', border: 'none', borderRadius: '10px', cursor: saving ? 'wait' : 'pointer', fontWeight: 600 }}
            >
              {saving ? 'Creating...' : 'Create Test'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Detail modal ─────────────────────────────────────────────────
function DetailModal({ test, onClose, onAction }) {
  const stats = test.stats || {
    variantA: { sent: 0, clicked: 0, ctr: 0 },
    variantB: { sent: 0, clicked: 0, ctr: 0 },
    significant: false,
    leader: null,
  };

  const chartData = [
    { name: 'Variant A', Sent: stats.variantA.sent, Clicked: stats.variantA.clicked, CTR: stats.variantA.ctr },
    { name: 'Variant B', Sent: stats.variantB.sent, Clicked: stats.variantB.clicked, CTR: stats.variantB.ctr },
  ];

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '1rem',
    }}>
      <div style={{ ...glassCard, width: 'min(900px, 100%)', maxHeight: '90vh', overflowY: 'auto', background: 'rgba(20,20,30,0.95)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1rem', gap: '1rem' }}>
          <div>
            <h2 style={{ margin: 0, color: 'var(--text-primary)' }}>{test.name}</h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.35rem' }}>
              <StatusBadge status={test.status} />
              {test.winningVariant && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', color: '#f59e0b', fontSize: '0.8rem', fontWeight: 600 }}>
                  <Trophy size={14} /> Winner: Variant {test.winningVariant}
                </span>
              )}
              {stats.significant && (
                <span style={{ color: '#10b981', fontSize: '0.75rem', fontWeight: 600 }}>Statistically significant</span>
              )}
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}>
            <X size={20} />
          </button>
        </div>

        {/* Action bar */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '1.25rem' }}>
          {test.status === 'DRAFT' && (
            <button
              onClick={() => onAction('start', test)}
              style={{ padding: '0.55rem 0.9rem', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: '10px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.4rem', fontWeight: 600 }}
            >
              <Play size={14} /> Start Test
            </button>
          )}
          {test.status === 'RUNNING' && (
            <>
              <button
                onClick={() => onAction('declare-winner', { ...test, winner: 'A' })}
                style={{ padding: '0.55rem 0.9rem', background: '#10b981', color: '#fff', border: 'none', borderRadius: '10px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.4rem', fontWeight: 600 }}
              >
                <Trophy size={14} /> Declare A Winner
              </button>
              <button
                onClick={() => onAction('declare-winner', { ...test, winner: 'B' })}
                style={{ padding: '0.55rem 0.9rem', background: '#10b981', color: '#fff', border: 'none', borderRadius: '10px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.4rem', fontWeight: 600 }}
              >
                <Trophy size={14} /> Declare B Winner
              </button>
            </>
          )}
          <button
            onClick={() => onAction('delete', test)}
            style={{ padding: '0.55rem 0.9rem', background: 'transparent', color: '#ef4444', border: '1px solid rgba(239,68,68,0.4)', borderRadius: '10px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.4rem', fontWeight: 600 }}
          >
            <Trash2 size={14} /> Delete
          </button>
        </div>

        {/* Chart */}
        <div style={{ ...glassCard, marginBottom: '1.25rem', background: 'rgba(255,255,255,0.03)' }}>
          <h3 style={{ margin: '0 0 0.75rem', fontSize: '1rem', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <BarChart3 size={16} /> Variant Performance
          </h3>
          <div style={{ height: 260 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" vertical={false} />
                <XAxis dataKey="name" stroke="var(--text-secondary)" tickLine={false} axisLine={false} />
                <YAxis stroke="var(--text-secondary)" tickLine={false} axisLine={false} />
                <Tooltip contentStyle={{ background: 'rgba(20,20,30,0.95)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px' }} />
                <Legend />
                <Bar dataKey="Sent" fill="#3b82f6" radius={[6, 6, 0, 0]} />
                <Bar dataKey="Clicked" fill="#10b981" radius={[6, 6, 0, 0]} />
                <Bar dataKey="CTR" fill="#a855f7" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Variant JSON */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
          <div style={{ ...glassCard, background: 'rgba(255,255,255,0.03)' }}>
            <h4 style={{ margin: '0 0 0.5rem', color: '#3b82f6' }}>Variant A</h4>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
              Sent: <b style={{ color: 'var(--text-primary)' }}>{stats.variantA.sent}</b> &nbsp;·&nbsp;
              Clicked: <b style={{ color: 'var(--text-primary)' }}>{stats.variantA.clicked}</b> &nbsp;·&nbsp;
              CTR: <b style={{ color: 'var(--text-primary)' }}>{stats.variantA.ctr}%</b>
            </div>
            <pre style={{ margin: 0, padding: '0.75rem', background: 'rgba(0,0,0,0.3)', borderRadius: '8px', color: 'var(--text-primary)', fontSize: '0.8rem', overflowX: 'auto' }}>
{prettyJson(test.variantA)}
            </pre>
          </div>
          <div style={{ ...glassCard, background: 'rgba(255,255,255,0.03)' }}>
            <h4 style={{ margin: '0 0 0.5rem', color: '#a855f7' }}>Variant B</h4>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
              Sent: <b style={{ color: 'var(--text-primary)' }}>{stats.variantB.sent}</b> &nbsp;·&nbsp;
              Clicked: <b style={{ color: 'var(--text-primary)' }}>{stats.variantB.clicked}</b> &nbsp;·&nbsp;
              CTR: <b style={{ color: 'var(--text-primary)' }}>{stats.variantB.ctr}%</b>
            </div>
            <pre style={{ margin: 0, padding: '0.75rem', background: 'rgba(0,0,0,0.3)', borderRadius: '8px', color: 'var(--text-primary)', fontSize: '0.8rem', overflowX: 'auto' }}>
{prettyJson(test.variantB)}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Test card ────────────────────────────────────────────────────
function TestCard({ test, onClick }) {
  const stats = test.stats || {
    variantA: { sent: 0, clicked: 0, ctr: 0 },
    variantB: { sent: 0, clicked: 0, ctr: 0 },
    leader: null,
    significant: false,
  };
  return (
    <div
      onClick={() => onClick(test)}
      style={{
        ...glassCard,
        cursor: 'pointer',
        transition: 'transform 0.15s ease, border-color 0.15s ease',
        display: 'flex', flexDirection: 'column', gap: '0.75rem',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.borderColor = 'rgba(59,130,246,0.5)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.borderColor = 'var(--border-color, rgba(255,255,255,0.1))'; }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
        <h3 style={{ margin: 0, fontSize: '1.05rem', color: 'var(--text-primary)' }}>{test.name}</h3>
        <StatusBadge status={test.status} />
      </div>

      {test.winningVariant && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: '#f59e0b', fontSize: '0.85rem', fontWeight: 600 }}>
          <Trophy size={14} /> Winner: Variant {test.winningVariant}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
        <div style={{ padding: '0.6rem', borderRadius: '10px', background: 'rgba(59,130,246,0.1)', border: `1px solid ${stats.leader === 'A' ? 'rgba(59,130,246,0.6)' : 'rgba(59,130,246,0.2)'}` }}>
          <div style={{ fontSize: '0.75rem', color: '#3b82f6', fontWeight: 700, marginBottom: '0.35rem' }}>VARIANT A</div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Sent <b style={{ color: 'var(--text-primary)' }}>{stats.variantA.sent}</b></div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Clicks <b style={{ color: 'var(--text-primary)' }}>{stats.variantA.clicked}</b></div>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-primary)', fontWeight: 700, marginTop: '0.25rem' }}>CTR {stats.variantA.ctr}%</div>
        </div>
        <div style={{ padding: '0.6rem', borderRadius: '10px', background: 'rgba(168,85,247,0.1)', border: `1px solid ${stats.leader === 'B' ? 'rgba(168,85,247,0.6)' : 'rgba(168,85,247,0.2)'}` }}>
          <div style={{ fontSize: '0.75rem', color: '#a855f7', fontWeight: 700, marginBottom: '0.35rem' }}>VARIANT B</div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Sent <b style={{ color: 'var(--text-primary)' }}>{stats.variantB.sent}</b></div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Clicks <b style={{ color: 'var(--text-primary)' }}>{stats.variantB.clicked}</b></div>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-primary)', fontWeight: 700, marginTop: '0.25rem' }}>CTR {stats.variantB.ctr}%</div>
        </div>
      </div>

      {stats.significant && (
        <div style={{ fontSize: '0.75rem', color: '#10b981', fontWeight: 600 }}>Statistically significant</div>
      )}
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────
export default function AbTests() {
  const [tests, setTests] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [detail, setDetail] = useState(null);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const list = await fetchApi('/api/ab-tests');
      setTests(Array.isArray(list) ? list : []);
    } catch (err) {
      setError(err.message || 'Failed to load tests');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    fetchApi('/api/marketing/campaigns').then((c) => {
      setCampaigns(Array.isArray(c) ? c : []);
    }).catch(() => setCampaigns([]));
  }, []);

  const handleCreated = (created) => {
    setShowCreate(false);
    setTests((prev) => [{ ...created, stats: undefined }, ...prev]);
    load();
  };

  const handleAction = async (action, test) => {
    try {
      if (action === 'start') {
        await fetchApi(`/api/ab-tests/${test.id}/start`, { method: 'POST' });
      } else if (action === 'declare-winner') {
        await fetchApi(`/api/ab-tests/${test.id}/declare-winner`, {
          method: 'POST',
          body: JSON.stringify({ winner: test.winner }),
        });
      } else if (action === 'delete') {
        if (!window.confirm('Delete this A/B test?')) return;
        await fetchApi(`/api/ab-tests/${test.id}`, { method: 'DELETE' });
        setDetail(null);
        load();
        return;
      }
      // Refresh and re-open detail from refreshed list
      await load();
      const refreshed = await fetchApi(`/api/ab-tests/${test.id}`).catch(() => null);
      if (refreshed) setDetail(refreshed);
    } catch (err) {
      alert(err.message || 'Action failed');
    }
  };

  const counts = useMemo(() => {
    const c = { DRAFT: 0, RUNNING: 0, COMPLETED: 0 };
    tests.forEach((t) => { c[t.status] = (c[t.status] || 0) + 1; });
    return c;
  }, [tests]);

  return (
    <div style={{ padding: '2rem', color: 'var(--text-primary)' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem', marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <PenTool size={28} color="var(--accent-color, #3b82f6)" />
          <div>
            <h1 style={{ margin: 0, fontSize: '1.75rem', fontWeight: 700 }}>A/B Tests</h1>
            <p style={{ margin: '0.25rem 0 0', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
              Experiment with variants to find the highest-performing messages.
            </p>
          </div>
        </div>

        <button
          onClick={() => setShowCreate(true)}
          style={{
            padding: '0.6rem 1.1rem', background: 'var(--accent-color, #3b82f6)',
            color: '#fff', border: 'none', borderRadius: '10px', cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 600,
          }}
        >
          <Plus size={16} /> Create Test
        </button>
      </div>

      {/* Summary counters */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
        <div style={glassCard}>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>Total Tests</div>
          <div style={{ fontSize: '1.75rem', fontWeight: 700 }}>{tests.length}</div>
        </div>
        <div style={glassCard}>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>Running</div>
          <div style={{ fontSize: '1.75rem', fontWeight: 700, color: '#3b82f6' }}>{counts.RUNNING || 0}</div>
        </div>
        <div style={glassCard}>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>Completed</div>
          <div style={{ fontSize: '1.75rem', fontWeight: 700, color: '#10b981' }}>{counts.COMPLETED || 0}</div>
        </div>
        <div style={glassCard}>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>Drafts</div>
          <div style={{ fontSize: '1.75rem', fontWeight: 700, color: '#94a3b8' }}>{counts.DRAFT || 0}</div>
        </div>
      </div>

      {error && (
        <div style={{ padding: '0.75rem 1rem', borderRadius: '10px', background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.4)', color: '#ef4444', fontSize: '0.9rem', marginBottom: '1rem' }}>
          {error}
        </div>
      )}

      {/* Grid */}
      {loading ? (
        <div style={{ ...glassCard, textAlign: 'center', color: 'var(--text-secondary)' }}>Loading A/B tests...</div>
      ) : tests.length === 0 ? (
        <div style={{ ...glassCard, textAlign: 'center', color: 'var(--text-secondary)', padding: '3rem 1.5rem' }}>
          <PenTool size={40} style={{ opacity: 0.5, marginBottom: '0.75rem' }} />
          <div style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '0.25rem' }}>
            No A/B tests yet
          </div>
          <div style={{ fontSize: '0.875rem' }}>Create your first test to start experimenting with variants.</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '1rem' }}>
          {tests.map((t) => (
            <TestCard key={t.id} test={t} onClick={setDetail} />
          ))}
        </div>
      )}

      {showCreate && (
        <CreateModal
          onClose={() => setShowCreate(false)}
          onCreated={handleCreated}
          campaigns={campaigns}
        />
      )}

      {detail && (
        <DetailModal
          test={detail}
          onClose={() => setDetail(null)}
          onAction={handleAction}
        />
      )}
    </div>
  );
}
