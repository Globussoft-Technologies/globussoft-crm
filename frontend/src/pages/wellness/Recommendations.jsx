import React, { useEffect, useState } from 'react';
import { Sparkles, Check, X, Clock, AlertCircle } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';

const priorityColor = { high: '#ef4444', medium: '#f59e0b', low: '#64748b' };
const typeLabel = {
  campaign_boost: 'Ad campaign',
  occupancy_alert: 'Occupancy',
  lead_followup: 'Lead follow-up',
  schedule_gap: 'Schedule gap',
};

export default function Recommendations() {
  const notify = useNotify();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('pending');

  const load = () => {
    setLoading(true);
    fetchApi(`/api/wellness/recommendations?status=${filter}`)
      .then(setItems)
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [filter]);

  const handleAction = async (id, action) => {
    // #129: confirm before reject — recommendations feed campaign-spend decisions,
    // a misclick should never silently drop a proposal from the queue.
    if (action === 'reject') {
      const rec = items.find(r => r.id === id);
      const title = rec?.title || `recommendation #${id}`;
      const ok = await notify.confirm({
        message: `Reject "${title}"?\n\nIt will move to the rejected list and stop influencing the queue.`,
        destructive: true,
        confirmText: 'Reject',
      });
      if (!ok) return;
    }
    try {
      await fetchApi(`/api/wellness/recommendations/${id}/${action}`, { method: 'POST' });
      load();
    } catch (e) {
      notify.error(`Failed to ${action}: ${e.message}`);
    }
  };

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ fontFamily: 'var(--font-family)', fontSize: '1.75rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Sparkles size={24} color="#a855f7" /> Agent Recommendations
        </h1>
        <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
          Proposals from the orchestration agent. Review, approve, or reject.
        </p>
      </header>

      <div style={{ marginBottom: '1rem', display: 'flex', gap: '0.5rem' }}>
        {['pending', 'approved', 'rejected', 'all'].map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className="glass"
            style={{
              padding: '0.4rem 0.9rem', fontSize: '0.85rem',
              background: filter === f ? 'var(--accent-color)' : 'transparent',
              color: filter === f ? '#fff' : 'var(--text-primary)',
              border: '1px solid rgba(255,255,255,0.08)', cursor: 'pointer', borderRadius: 8, textTransform: 'capitalize',
            }}
          >
            {f}
          </button>
        ))}
      </div>

      {loading && <div>Loading…</div>}

      {!loading && items.length === 0 && (
        <div className="glass" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
          <AlertCircle size={24} style={{ marginBottom: '0.5rem' }} />
          <div>No {filter === 'all' ? '' : filter} recommendations.</div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {items.map((r) => (
          <div key={r.id} className="glass" style={{ padding: '1.25rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.5rem' }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                  <span style={{ background: priorityColor[r.priority] || priorityColor.medium, color: '#fff', padding: '0.15rem 0.5rem', borderRadius: 4, fontSize: '0.7rem', textTransform: 'uppercase', fontWeight: 600 }}>
                    {r.priority}
                  </span>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                    {typeLabel[r.type] || r.type}
                  </span>
                  {r.goalContext && (
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                      • Goal: {r.goalContext}
                    </span>
                  )}
                </div>
                <h3 style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: '0.4rem' }}>{r.title}</h3>
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                <Clock size={12} /> {new Date(r.createdAt).toLocaleString('en-IN')}
              </div>
            </div>

            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.5, marginBottom: '0.75rem' }}>{r.body}</p>

            {r.expectedImpact && (
              <div style={{ fontSize: '0.85rem', padding: '0.5rem 0.75rem', background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)', borderRadius: 8, color: 'var(--success-color)', marginBottom: '1rem' }}>
                <strong>Expected impact:</strong> {r.expectedImpact}
              </div>
            )}

            {r.status === 'pending' ? (
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button
                  onClick={() => handleAction(r.id, 'approve')}
                  style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.5rem 1rem', background: 'var(--success-color)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: '0.85rem' }}
                >
                  <Check size={14} /> Approve
                </button>
                <button
                  onClick={() => handleAction(r.id, 'reject')}
                  style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.5rem 1rem', background: 'transparent', color: 'var(--text-primary)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 8, cursor: 'pointer', fontSize: '0.85rem' }}
                >
                  <X size={14} /> Reject
                </button>
              </div>
            ) : (
              <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', textTransform: 'capitalize' }}>
                Status: {r.status}
                {r.resolvedAt && ` • resolved ${new Date(r.resolvedAt).toLocaleString('en-IN')}`}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
