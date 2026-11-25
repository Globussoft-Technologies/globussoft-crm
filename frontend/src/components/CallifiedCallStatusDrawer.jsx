import { formatTimestamp } from '../utils/date';
import { Fragment, useEffect, useState, useMemo, useRef } from "react";
import { Search, Phone, X, RefreshCw, Clock, AlertCircle, CheckCircle2, PhoneOff } from "lucide-react";
import { fetchApi } from "../utils/api";
import { useNotify } from "../utils/notify";
import { LeadDialRuns } from './LeadDialWorkspace';
import './CallifiedCallStatusDrawer.css';
import CallifiedCallDetailsDrawer from './CallifiedCallDetailsDrawer';

const STATUS_META = {
  INITIATED: { label: "Calling…", color: "var(--warning-color)", bg: "rgba(245, 158, 11, 0.12)", icon: Phone },
  RINGING: { label: "Ringing…", color: "var(--warning-color)", bg: "rgba(245, 158, 11, 0.12)", icon: Phone },
  CONNECTED: { label: "On call", color: "var(--accent-color)", bg: "rgba(59, 130, 246, 0.12)", icon: Phone },
  COMPLETED: { label: "Call completed", color: "var(--success-color)", bg: "rgba(16, 185, 129, 0.12)", icon: CheckCircle2 },
  MISSED: { label: "Lead hung up / did not answer", color: "#ef4444", bg: "rgba(239, 68, 68, 0.12)", icon: PhoneOff },
  FAILED: { label: "Call failed", color: "#ef4444", bg: "rgba(239, 68, 68, 0.12)", icon: AlertCircle },
  CANCELLED: { label: 'Stopped', color: 'var(--text-secondary)', bg: 'var(--subtle-bg)', icon: PhoneOff },
};

export default function CallifiedCallStatusDrawer({ onClose, onQueueChanged, onManage, initialConfirm, canWrite = true, canManage = false, connected, campaigns }) {
  const [limit, setLimit] = useState(15);
  const notify = useNotify();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [queueRevision, setQueueRevision] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [history, setHistory] = useState([]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [detailsLead, setDetailsLead] = useState(null);
  const inFlight = useRef(false);

  useEffect(() => {
    const handleEscape = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.repeat) return;
      event.preventDefault();
      if (detailsLead) setDetailsLead(null);
      else onClose();
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [detailsLead, onClose]);

  const syncAndLoad = async ({ silent = false } = {}) => {
    if (inFlight.current || (silent && document.visibilityState === 'hidden')) return;
    inFlight.current = true;
    if (!silent) setSyncing(true);
    try {
      if (canWrite) await fetchApi("/api/callified/leads/sync-call-statuses", { method: "POST", silent: true });
    } catch (err) {
      console.error("[call-status] sync failed:", err?.message);
    } finally {
      if (!silent) setSyncing(false);
    }
    try {
      await loadHistory({ silent });
      setQueueRevision((revision) => revision + 1);
    } finally { inFlight.current = false; }
  };

  const loadHistory = async ({ silent = false } = {}) => {
    if (!silent) setRefreshing(true);
    try {
      const res = await fetchApi("/api/callified/leads/call-status-history", { silent: true });
      setHistory(Array.isArray(res?.history) ? res.history : []);
    } catch (err) {
      if (!silent) notify.error(err?.message || "Failed to load call status history");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    syncAndLoad();
    // Keep statuses fluid while the drawer is open.
    const interval = setInterval(() => syncAndLoad({ silent: true }), 5000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const formatTime = (iso) => {
    if (!iso) return "Unknown";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return formatTimestamp(d, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  };

  const formatDuration = (s) => {
    const seconds = Math.round(Number(s) || 0);
    if (seconds <= 0) return null;
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    const rem = seconds % 60;
    return `${m}m ${rem}s`;
  };

  const formatElapsed = (iso) => {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const elapsed = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
    if (elapsed < 60) return `${elapsed}s ago`;
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    return `${m}m ${s}s ago`;
  };

  const campaignName = (item) => {
    try {
      const notes = typeof item.notes === "object" && item.notes !== null ? item.notes : JSON.parse(item.notes || "{}");
      return notes.campaignName || notes.campaign?.name || (notes.campaignId ? `Campaign #${notes.campaignId}` : null);
    } catch (_) {
      return null;
    }
  };

  const scoreText = (item) => {
    try {
      const notes = typeof item.notes === "object" && item.notes !== null ? item.notes : JSON.parse(item.notes || "{}");
      const review = Array.isArray(notes.reviews) ? notes.reviews.find((r) => r && !r.error) : null;
      if (review && typeof review.quality_score === "number") {
        return `${review.quality_score}/5`;
      }
      return null;
    } catch (_) {
      return null;
    }
  };

  const sortedHistory = useMemo(() => {
    return history.filter((item) => {
      const active = ['INITIATED', 'RINGING', 'CONNECTED'].includes(item.status);
      if (filter === 'active' && !active) return false;
      if (filter === 'completed' && item.status !== 'COMPLETED') return false;
      if (filter === 'missed' && !['MISSED', 'FAILED', 'CANCELLED'].includes(item.status)) return false;
      return `${item.contact?.name || ''} ${item.contact?.email || ''} ${item.contact?.phone || item.calleeNumber || ''} ${campaignName(item) || ''}`.toLowerCase().includes(query.toLowerCase());
    }).sort((a, b) => {
      return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
    });
  }, [history, filter, query]);

  const activeCount = history.filter((h) => ["INITIATED", "RINGING", "CONNECTED"].includes(h.status)).length;
  const completedCount = history.filter((h) => h.status === "COMPLETED").length;
  const missedCount = history.filter((h) => ["MISSED", "FAILED", "CANCELLED"].includes(h.status)).length;

  const rows = sortedHistory.slice(0, limit);
  const day = value => formatTimestamp(value, { year: 'numeric', month: 'short', day: 'numeric' });
  const today = day(new Date());
  const previousDate = new Date();
  // Obtain yesterday's calendar label in the workspace timezone.
  const yesterdayDate = new Date(formatTimestamp(previousDate, { year: 'numeric', month: '2-digit', day: '2-digit' }, 'en-CA') + 'T12:00:00Z');
  yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
  const yesterday = formatTimestamp(yesterdayDate, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
  return <div className="call-status-layer">
    <div className="call-status-backdrop" onClick={onClose} />
    <section className="call-status-panel" role="dialog" aria-modal="true" aria-label="Call Status">
      <header><div><h2>Call status</h2><small>Live calls, updating automatically</small></div>
        <div role="group" aria-label="Call status controls" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button type="button" className="cs-icon" aria-label="Refresh call status" title="Refresh call status" disabled={refreshing || loading || syncing} onClick={() => syncAndLoad()}><RefreshCw size={16}/></button>
          <button type="button" className="cs-icon" aria-label="Close call status" onClick={onClose}><X size={18}/></button>
        </div>
      </header>
      <div className="call-status-body">
        <LeadDialRuns campaigns={campaigns} connected={connected} managedRefresh refreshKey={queueRevision} canWrite={canWrite} canManage={canManage && canWrite} onManage={onManage} initialConfirm={initialConfirm} onChanged={() => { onQueueChanged?.(); loadHistory(); }} />
        <div className="cs-section"><h3>Recent calls</h3><small><i/> Updates automatically</small></div>
        <div className="cs-stats">{[['active','Active',activeCount],['completed','Completed',completedCount],['missed','Missed / failed',missedCount]].map(([key,label,count]) =>
          <button key={key} aria-label={label} aria-pressed={filter === key} onClick={() => { setFilter(filter === key ? 'all' : key); setLimit(15); }}><b>{count}</b>{label}</button>)}</div>
        <label className="cs-search"><Search size={16}/><input type="search" aria-label="Search call history" placeholder="Search name, phone or campaign" value={query} onChange={event => { setQuery(event.target.value); setLimit(15); }}/></label>
        <small role="status">Showing {rows.length} of {history.length} calls</small>
        {loading ? <p>Loading calls…</p> : !rows.length && <p>{history.length ? 'No calls match your filters.' : 'No Callified calls yet.'}</p>}
        {rows.map((item,index) => {
          const name = item.contact?.name || item.contact?.email || `Lead #${item.contactId}`;
          const date = day(item.createdAt);
          const score = scoreText(item);
          const active = ['INITIATED','RINGING','CONNECTED'].includes(item.status);
          const label = { COMPLETED: 'Completed', MISSED: 'No answer', FAILED: 'Failed' }[item.status] || STATUS_META[item.status]?.label || item.status;
          return <Fragment key={item.id}>
            {(!index || day(rows[index-1].createdAt) !== date) && <h4 className="cs-day">{date === today ? 'Today' : date === yesterday ? 'Yesterday' : date}</h4>}
            <article className="cs-card"><div className="cs-person"><span className="cs-avatar">{name.charAt(0).toUpperCase()}</span>
              <div><strong>{name}</strong><small>{[item.calleeNumber || item.contact?.phone, campaignName(item)].filter(Boolean).join(' · ')}</small></div>
              <span className="cs-pill" data-tone={item.status}>{label}</span></div>
              <div className="cs-meta"><Clock size={13}/><time dateTime={item.createdAt} title={formatTime(item.createdAt)}>{formatTimestamp(item.createdAt,{hour:'numeric',minute:'2-digit',hour12:true})}</time>
                {formatDuration(item.duration) && <span>· {formatDuration(item.duration)}</span>}
                {active && <span>· {formatElapsed(item.createdAt)}</span>}
                <div className="cs-tools">{score && <b className="cs-pill" data-tone={parseFloat(score)>=4?'COMPLETED':parseFloat(score)>=3?'MISSED':'FAILED'}>Score {score}</b>}
                {item.contactId && <button aria-label="Transcript & details" onClick={() => setDetailsLead({ id:item.contactId,...item.contact })}>Transcript</button>}</div>
              </div></article>
          </Fragment>;
        })}
        {sortedHistory.length > limit && <button className="btn-secondary cs-more" onClick={() => setLimit(limit+15)}>Show {Math.min(15,sortedHistory.length-limit)} more · {sortedHistory.length-limit} left</button>}
      </div>
    </section>
    {detailsLead && <CallifiedCallDetailsDrawer lead={detailsLead} onClose={() => setDetailsLead(null)} />}
  </div>;
}
