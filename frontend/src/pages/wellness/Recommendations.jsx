import { useEffect, useState } from 'react';
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
  // #359: keep an "all" copy so per-sub-tab counters add up to the total.
  // The list endpoint applies its own filter when status≠'all', so a separate
  // status='all' fetch is the source of truth for the counters at the top.
  const [allItems, setAllItems] = useState([]);
  const [running, setRunning] = useState(false);

  // Manually trigger the orchestrator. Same endpoint the daily 07:00 IST
  // cron uses — gives admin/manager a way to populate the page without
  // waiting for tomorrow's scheduled run. Backend gates this to admin/manager
  // and dedup-suppresses re-emits for cards already created today, so a
  // double-click here cannot duplicate the queue.
  const runOrchestrator = async () => {
    setRunning(true);
    try {
      const result = await fetchApi('/api/wellness/orchestrator/run', { method: 'POST', silent: true });
      const count = (result && typeof result.created === 'number') ? result.created : 0;
      if (count > 0) {
        notify.success(`Generated ${count} new recommendation${count === 1 ? '' : 's'}.`);
      } else {
        notify.info('Orchestrator ran — no new recommendations (today\'s queue is up-to-date).');
      }
      load();
    } catch (err) {
      if (err.status === 403) notify.info('Running the orchestrator requires admin or manager.');
      else notify.error(`Orchestrator failed: ${err?.message || 'unknown error'}`);
    }
    setRunning(false);
  };

  const load = () => {
    setLoading(true);
    fetchApi(`/api/wellness/recommendations?status=${filter}`)
      .then(setItems)
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
    // Always re-pull the unfiltered set so the chip counts reflect the
    // post-action state after approve/reject.
    fetchApi(`/api/wellness/recommendations?status=all`)
      .then((rows) => setAllItems(Array.isArray(rows) ? rows : []))
      .catch(() => { /* non-fatal — counters degrade to current page only */ });
  };

  useEffect(() => { load(); }, [filter]);

  // #359: align the count math with the backend's status string. Backend
  // emits lowercase ('pending' / 'approved' / 'rejected') but defensive
  // toLowerCase() guards against any mixed-case rows leaking in. With this,
  // pending+approved+rejected always sums to allItems.length.
  const statusCount = (s) => allItems.filter((r) => (r.status || '').toLowerCase() === s).length;
  const COUNTS = {
    pending: statusCount('pending'),
    approved: statusCount('approved'),
    rejected: statusCount('rejected'),
    all: allItems.length,
  };

  const handleAction = async (id, action) => {
    const rec = items.find(r => r.id === id);
    const title = rec?.title || `recommendation #${id}`;

    // #129: confirm before reject — recommendations feed campaign-spend decisions,
    // a misclick should never silently drop a proposal from the queue.
    if (action === 'reject') {
      const ok = await notify.confirm({
        message: `Reject "${title}"?\n\nIt will move to the rejected list and stop influencing the queue.`,
        destructive: true,
        confirmText: 'Reject',
      });
      if (!ok) return;
    }

    // High-stakes approve confirm — these dispatcher types fan out to many
    // downstream rows (SMS queued / leads flagged) which take more than one
    // click to undo. Mirrors the reject confirmation pattern so the
    // destructive-side and the bulk-fanout side are symmetric. Lower-impact
    // types (occupancy_alert / schedule_gap / campaign_boost just create a
    // single Task) approve immediately as before.
    if (action === 'approve' && rec) {
      const HIGH_STAKES = {
        send_sms_blast: 'This will queue SMS messages to up to 200 lead-status contacts.',
        mark_leads_for_callback: 'This will flag matching leads for telecaller follow-up (up to 50 leads).',
        lead_followup: 'This will flag matching leads for follow-up activity, and may reassign them to a telecaller.',
      };
      const desc = HIGH_STAKES[rec.type];
      if (desc) {
        const ok = await notify.confirm({
          message: `Approve "${title}"?\n\n${desc}\n\nThis is hard to undo in one click.`,
          confirmText: 'Approve',
        });
        if (!ok) return;
      }
    }

    try {
      // #275 + #276: success path was silent — added explicit confirmation
      // toast. fetchApi auto-toasts errors with the server message; this catch
      // exists only to keep the page from logging an unhandled rejection.
      const result = await fetchApi(`/api/wellness/recommendations/${id}/${action}`, { method: 'POST', silent: true });

      if (action === 'approve') {
        // Surface what the dispatcher actually did, instead of a generic
        // "Recommendation approved". The backend returns `_actionResult`
        // shaped { ok, action, count?, deduped?, reassigned?, note?, reason? }
        // per dispatcher branch in cron/orchestratorEngine.js — was previously
        // discarded by the UI.
        const ar = result && result._actionResult;
        let detail = '';
        if (ar) {
          if (ar.action === 'sms_queued') detail = ` — ${ar.count || 0} SMS queued`;
          else if (ar.action === 'task_created') detail = ' — task created';
          else if (ar.action === 'task_deduped') detail = ' — matching task already exists';
          else if (ar.action === 'leads_flagged') {
            detail = ` — ${ar.count || 0} lead${ar.count === 1 ? '' : 's'} flagged`;
            if (ar.reassigned) detail += `, ${ar.reassigned} reassigned`;
          } else if (ar.ok === false) {
            detail = ` — no action taken (${ar.reason || 'unknown'})`;
          }
        }
        notify.success(`Approved${detail}`);
      } else {
        notify.success('Recommendation rejected');
      }
      load();
    } catch (err) {
      // fetchApi already toasted the underlying message. Page-specific hint:
      if (err.status === 403) notify.info('Approving recommendations requires admin or manager.');
    }
  };

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontFamily: 'var(--font-family)', fontSize: '1.75rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Sparkles size={24} color="#a855f7" /> Agent Recommendations
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            Proposals from the orchestration agent. Review, approve, or reject.
          </p>
        </div>
        <button
          onClick={runOrchestrator}
          disabled={running}
          title="Manually trigger the orchestrator (admin/manager only). Same engine the daily 07:00 IST cron uses."
          style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.55rem 1.05rem', background: running ? 'rgba(168, 85, 247, 0.18)' : 'rgba(168, 85, 247, 0.1)', color: '#a855f7', border: '1px solid rgba(168, 85, 247, 0.35)', borderRadius: 8, cursor: running ? 'wait' : 'pointer', fontSize: '0.85rem', fontWeight: 500, whiteSpace: 'nowrap' }}
        >
          <Play size={14} /> {running ? 'Running…' : 'Run now'}
        </button>
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
            {/* #359: surface the per-stage count next to each chip so the
                operator can verify pending + approved + rejected = all. */}
            {f} <span style={{ opacity: 0.7, fontVariantNumeric: 'tabular-nums' }}>({COUNTS[f] ?? 0})</span>
          </button>
        ))}
      </div>

      {loading && <div>Loading…</div>}

      {!loading && items.length === 0 && (
        <div className="glass" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
          <AlertCircle size={24} style={{ marginBottom: '0.5rem' }} />
          {/* #360: empty stages used to render a blank panel — now they
              tell the operator why the queue is empty (orchestrator runs
              once a day at 7 AM IST, so a fresh-rejected list will stay
              empty until the next batch). */}
          <div>
            No recommendations in this stage yet — the orchestrator runs at 7 AM IST daily.
          </div>
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
