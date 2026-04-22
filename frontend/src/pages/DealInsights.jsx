import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchApi } from '../utils/api';
import { formatMoney } from '../utils/money';
import {
  Eye, AlertTriangle, Lightbulb, ArrowRight, Check,
  RefreshCw, Sparkles, CheckCircle2,
} from 'lucide-react';

const SEVERITY_COLORS = {
  CRITICAL: { fg: '#ef4444', bg: 'rgba(239,68,68,0.12)', border: 'rgba(239,68,68,0.35)' },
  WARNING:  { fg: '#f59e0b', bg: 'rgba(245,158,11,0.12)', border: 'rgba(245,158,11,0.35)' },
  INFO:     { fg: '#3b82f6', bg: 'rgba(59,130,246,0.12)', border: 'rgba(59,130,246,0.35)' },
};

const TYPE_TABS = ['All', 'RISK', 'OPPORTUNITY', 'NEXT_BEST_ACTION'];

function TypeIcon({ type, size = 16 }) {
  if (type === 'RISK') return <AlertTriangle size={size} color="#ef4444" />;
  if (type === 'OPPORTUNITY') return <Sparkles size={size} color="#22c55e" />;
  return <Lightbulb size={size} color="#3b82f6" />;
}

function timeAgo(dateStr) {
  const d = new Date(dateStr);
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

export default function DealInsights() {
  const navigate = useNavigate();
  const [insights, setInsights] = useState([]);
  const [deals, setDeals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [filter, setFilter] = useState('All');
  const [showResolved, setShowResolved] = useState(false);

  const loadAll = async () => {
    try {
      const [ins, dls] = await Promise.all([
        fetchApi('/api/deal-insights').catch(() => []),
        fetchApi('/api/deals').catch(() => []),
      ]);
      setInsights(Array.isArray(ins) ? ins : []);
      setDeals(Array.isArray(dls) ? dls : []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadAll(); }, []);

  const dealById = useMemo(() => {
    const m = {};
    deals.forEach(d => { m[d.id] = d; });
    return m;
  }, [deals]);

  const openDeals = useMemo(
    () => deals.filter(d => d.stage !== 'won' && d.stage !== 'lost'),
    [deals]
  );

  const filtered = useMemo(() => {
    let list = insights;
    if (!showResolved) list = list.filter(i => !i.isResolved);
    if (filter !== 'All') list = list.filter(i => i.type === filter);
    return list;
  }, [insights, filter, showResolved]);

  const grouped = useMemo(() => {
    const g = {};
    filtered.forEach(ins => {
      if (!g[ins.dealId]) g[ins.dealId] = [];
      g[ins.dealId].push(ins);
    });
    return g;
  }, [filtered]);

  const stats = useMemo(() => {
    const open = insights.filter(i => !i.isResolved);
    return {
      open: open.length,
      critical: open.filter(i => i.severity === 'CRITICAL').length,
      warnings: open.filter(i => i.severity === 'WARNING').length,
      resolved: insights.filter(i => i.isResolved).length,
    };
  }, [insights]);

  const generateForAll = async () => {
    setGenerating(true);
    try {
      const targets = openDeals.slice(0, 50); // safety cap
      for (const d of targets) {
        try {
          await fetchApi(`/api/deal-insights/generate/${d.id}`, { method: 'POST' });
        } catch (e) {
          console.warn(`Generate failed for deal ${d.id}:`, e.message);
        }
      }
      await loadAll();
    } finally {
      setGenerating(false);
    }
  };

  const resolveOne = async (id) => {
    try {
      await fetchApi(`/api/deal-insights/${id}/resolve`, { method: 'POST' });
      setInsights(prev => prev.map(i => i.id === id ? { ...i, isResolved: true } : i));
    } catch (e) {
      console.error(e);
    }
  };

  const KPI_CARDS = [
    { label: 'Open Insights', value: stats.open, color: 'var(--accent-color)', icon: <Eye size={18} color="var(--accent-color)" /> },
    { label: 'Critical',      value: stats.critical, color: '#ef4444', icon: <AlertTriangle size={18} color="#ef4444" /> },
    { label: 'Warnings',      value: stats.warnings, color: '#f59e0b', icon: <AlertTriangle size={18} color="#f59e0b" /> },
    { label: 'Resolved',      value: stats.resolved, color: '#22c55e', icon: <CheckCircle2 size={18} color="#22c55e" /> },
  ];

  return (
    <div style={{ padding: '2rem', height: '100%', overflowY: 'auto', animation: 'fadeIn 0.4s ease-out' }}>
      {/* Header */}
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.75rem', gap: '1rem', flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <Eye size={28} color="var(--accent-color)" /> AI Deal Insights
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            Risk detection, opportunities, and next-best-actions across your open pipeline.
          </p>
        </div>
        <button
          onClick={generateForAll}
          disabled={generating || openDeals.length === 0}
          className="btn-primary"
          style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', opacity: generating ? 0.7 : 1 }}
        >
          <RefreshCw size={16} style={{ animation: generating ? 'spin 1s linear infinite' : 'none' }} />
          {generating ? 'Generating...' : `Generate Insights (${openDeals.length} open)`}
        </button>
      </header>

      {/* KPI Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '1.25rem', marginBottom: '1.75rem' }}>
        {KPI_CARDS.map(k => (
          <div key={k.label} className="card" style={{ padding: '1.5rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{k.label}</span>
              {k.icon}
            </div>
            <div style={{ fontSize: '2rem', fontWeight: 'bold', color: k.color }}>{k.value}</div>
          </div>
        ))}
      </div>

      {/* Filter tabs */}
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.25rem', alignItems: 'center', flexWrap: 'wrap' }}>
        {TYPE_TABS.map(tab => (
          <button
            key={tab}
            onClick={() => setFilter(tab)}
            style={{
              padding: '0.5rem 1rem',
              borderRadius: '999px',
              fontSize: '0.85rem',
              fontWeight: 500,
              border: '1px solid var(--border-color)',
              background: filter === tab ? 'var(--accent-color)' : 'transparent',
              color: filter === tab ? '#fff' : 'var(--text-primary)',
              cursor: 'pointer',
              transition: 'all 0.2s',
            }}
          >
            {tab.replace(/_/g, ' ')}
          </button>
        ))}
        <label style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem', color: 'var(--text-secondary)', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={showResolved}
            onChange={e => setShowResolved(e.target.checked)}
          />
          Show resolved
        </label>
      </div>

      {/* Insights grouped by deal */}
      {loading ? (
        <div className="card" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
          Loading insights...
        </div>
      ) : Object.keys(grouped).length === 0 ? (
        <div className="card" style={{ padding: '2.5rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
          <Lightbulb size={32} color="var(--text-secondary)" style={{ marginBottom: '0.75rem' }} />
          <div style={{ fontSize: '1rem', fontWeight: 500, marginBottom: '0.4rem' }}>No insights yet</div>
          <div style={{ fontSize: '0.85rem' }}>
            Click "Generate Insights" to scan your open deals for risks, opportunities, and next-best-actions.
          </div>
        </div>
      ) : (
        Object.entries(grouped).map(([dealId, items]) => {
          const deal = dealById[dealId];
          return (
            <div key={dealId} className="card" style={{ padding: '1.5rem', marginBottom: '1.25rem' }}>
              <div
                onClick={() => navigate('/pipeline')}
                style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  marginBottom: '1rem', cursor: 'pointer',
                  paddingBottom: '0.75rem', borderBottom: '1px solid var(--border-color)',
                }}
              >
                <div>
                  <div style={{ fontSize: '1.05rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    {deal ? deal.title : `Deal #${dealId}`}
                    <ArrowRight size={14} color="var(--text-secondary)" />
                  </div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.2rem' }}>
                    {deal ? `${deal.stage} · ${formatMoney(deal.amount || 0, { currency: deal.currency })} · ${deal.contact?.name || 'No contact'}` : 'Deal details unavailable'}
                  </div>
                </div>
                <span style={{
                  fontSize: '0.75rem', padding: '0.25rem 0.65rem',
                  background: 'rgba(255,255,255,0.06)', borderRadius: '999px',
                  color: 'var(--text-secondary)',
                }}>
                  {items.length} insight{items.length !== 1 ? 's' : ''}
                </span>
              </div>

              {items.map(ins => {
                const sev = SEVERITY_COLORS[ins.severity] || SEVERITY_COLORS.INFO;
                return (
                  <div
                    key={ins.id}
                    style={{
                      display: 'flex', alignItems: 'flex-start', gap: '0.85rem',
                      padding: '0.85rem 1rem', marginBottom: '0.6rem',
                      background: sev.bg, border: `1px solid ${sev.border}`,
                      borderRadius: '10px',
                      opacity: ins.isResolved ? 0.55 : 1,
                    }}
                  >
                    <div style={{ marginTop: '0.15rem' }}>
                      <TypeIcon type={ins.type} size={18} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.3rem', flexWrap: 'wrap' }}>
                        <span style={{
                          fontSize: '0.7rem', fontWeight: 700, padding: '0.15rem 0.5rem',
                          borderRadius: '4px', background: sev.fg, color: '#fff',
                          letterSpacing: '0.04em',
                        }}>
                          {ins.severity}
                        </span>
                        <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                          {ins.type.replace(/_/g, ' ')}
                        </span>
                        <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginLeft: 'auto' }}>
                          {timeAgo(ins.generatedAt)}
                        </span>
                      </div>
                      <div style={{ fontSize: '0.9rem', color: 'var(--text-primary)', lineHeight: 1.45 }}>
                        {ins.insight}
                      </div>
                    </div>
                    {!ins.isResolved && (
                      <button
                        onClick={() => resolveOne(ins.id)}
                        title="Mark resolved"
                        style={{
                          display: 'flex', alignItems: 'center', gap: '0.3rem',
                          padding: '0.4rem 0.7rem', fontSize: '0.75rem',
                          background: 'rgba(34,197,94,0.12)', color: '#22c55e',
                          border: '1px solid rgba(34,197,94,0.3)',
                          borderRadius: '6px', cursor: 'pointer',
                        }}
                      >
                        <Check size={13} /> Resolve
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })
      )}

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
      `}</style>
    </div>
  );
}
