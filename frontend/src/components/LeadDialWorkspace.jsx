import { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarClock, Check, Clock, PhoneCall, Plug, Square, X } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import { tenantTimezone } from '../utils/date';
import { parseWorkspaceDateTime, useSchedulingClock } from '../utils/workspaceClock';
import './LeadDialWorkspace.css';
import DialQueuePanel, { activeQueueSize } from './DialQueuePanel';
import DialRunHistory from './DialRunHistory';

const DIAL_STATUS_OPTIONS = [
  { value: 'yet_to_call', label: 'Yet to call', detail: 'Start fresh conversations' },
  { value: 'dnp', label: 'Did not pick up', detail: 'Try unanswered leads again' },
  { value: 'pending', label: 'Pending', detail: 'Follow up on open conversations' },
  { value: 'junk', label: 'Junk', detail: 'Include only when you intend to revisit' },
];

export function CallifiedConnection({ connected, onConnect }) {
  return <div className="lead-calling-connection" data-state={connected === true ? 'connected' : 'disconnected'}>
    <span className="lead-calling-dot" aria-hidden="true" />
    <span>Callified · {connected === null ? 'Checking…' : connected ? 'Connected' : 'Not connected'}</span>
    {connected === false && <button type="button" onClick={onConnect}><Plug size={13} /> Connect</button>}
  </div>;
}

export function LeadDialComposer({ selection, onClose, onCreated }) {
  const notify = useNotify();
  const [statuses, setStatuses] = useState(['yet_to_call', 'dnp', 'pending']);
  const [when, setWhen] = useState(selection.schedule ? 'later' : 'now');
  const [dateTime, setDateTime] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const dialogRef = useRef(null);
  const timezone = tenantTimezone() || 'UTC';
  const submit = async (event) => {
    event.preventDefault();
    if (submitting.current) return;
    const date = parseWorkspaceDateTime(dateTime, timezone);
    if (!statuses.length) { setError('Select at least one call status.'); return; }
    if (when === 'later' && (!Number.isFinite(date.getTime()) || date.getTime() < Date.now() + 30_000)) {
      setError('Choose a time at least 30 seconds in the future.'); return;
    }
    submitting.current = true;
    setSaving(true); setError('');
    try {
      await fetchApi('/api/callified/dial-jobs', { method: 'POST', silent: true, body: JSON.stringify({
        ...Object.fromEntries(Object.entries(selection).filter(([key]) => key !== 'schedule')), statuses, ...(when === 'later' ? { scheduledAt: date.toISOString() } : {}),
      }) });
      notify.success(when === 'later' ? 'Dial run scheduled' : 'Dial run queued');
      onCreated?.(); onClose();
    } catch (err) { setError(err.message || 'Could not create the dial run.'); }
    finally { submitting.current = false; setSaving(false); }
  };
  useEffect(() => {
    const previousFocus = document.activeElement;
    dialogRef.current?.querySelector('input, button')?.focus();
    const handle = (event) => {
      if (event.key === 'Escape' && !submitting.current) onClose();
      if (event.key === 'Tab') {
        const focusable = Array.from(dialogRef.current?.querySelectorAll('input:not(:disabled),button:not(:disabled),select:not(:disabled),a[href]') || []);
        const first = focusable[0]; const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', handle);
    return () => { document.removeEventListener('keydown', handle); previousFocus?.focus?.(); };
  }, [onClose]);
  return <div className="lead-dial-backdrop" onClick={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
    <form ref={dialogRef} className="lead-dial-composer" role="dialog" aria-modal="true" aria-labelledby="lead-dial-title" onSubmit={submit}>
      <div className="lead-dial-heading"><span className="lead-dial-icon"><PhoneCall size={22} /></span><div><p className="lead-dial-eyebrow">CALLING WORKSPACE</p><h2 id="lead-dial-title">Plan your dial run</h2></div><button type="button" className="lead-dial-close" aria-label="Close dial planner" disabled={saving} onClick={onClose}><X size={20} /></button></div>
      <p className="lead-dial-muted">{selection.campaignIds?.length ? `${selection.campaignIds.length} campaign(s) · includes leads across every page` : `${selection.contactIds?.length || 0} selected lead(s)`}</p>
      <fieldset><legend>Call leads with these statuses</legend><div className="lead-dial-status-grid">
        {DIAL_STATUS_OPTIONS.map((option) => <label key={option.value} className="lead-dial-status-option" data-selected={statuses.includes(option.value)}><input type="checkbox" checked={statuses.includes(option.value)} onChange={() => setStatuses((current) => current.includes(option.value) ? current.filter((value) => value !== option.value) : [...current, option.value])} /><span><strong>{option.label}</strong><small>{option.detail}</small></span></label>)}
      </div></fieldset>
      <div className="lead-dial-protection"><Check size={16} /><span>Qualified leads are always excluded. Eligibility is checked again before each call.</span></div>
      <fieldset><legend>When should calling begin?</legend><div className="lead-dial-timing"><label><input type="radio" name="dial-when" checked={when === 'now'} onChange={() => setWhen('now')} /> Start when ready</label><label><input type="radio" name="dial-when" checked={when === 'later'} onChange={() => setWhen('later')} /> Pick date & time</label></div>
        {when === 'later' && <label className="lead-dial-date">Scheduled start<input autoFocus type="datetime-local" required value={dateTime} onChange={(event) => setDateTime(event.target.value)} /><small>Timezone: {timezone}. Calls begin after this time as capacity becomes available.</small></label>}
      </fieldset>
      <p className="lead-dial-muted">Calls run one at a time in the background. You can leave this page and stop the run from Call Status.</p>
      {error && <p className="lead-dial-error" role="alert">{error}</p>}
      <footer><button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button><button type="submit" className="btn-primary" disabled={saving || !statuses.length}><CalendarClock size={16} />{saving ? 'Saving…' : when === 'later' ? 'Schedule calls' : 'Start dial run'}</button></footer>
    </form>
  </div>;
}

function makeClockSample(serverTime) {
  const timestamp = Date.parse(serverTime);
  return Number.isFinite(timestamp) ? { timestamp, receivedAt: performance.now() } : null;
}

export function CrmDialClock({ sync = false, ...props }) {
  return sync ? <SyncedDialClock {...props} /> : <DialClock {...props} />;
}

function SyncedDialClock(props) {
  const { now } = useSchedulingClock();
  return <DialClock {...props} now={now} />;
}

function DialClock({ timezone = 'UTC', sample, now: synchronizedTime }) {
  const [tick, setTick] = useState(() => performance.now());
  useEffect(() => {
    if (!sample) return undefined;
    const timer = setInterval(() => setTick(performance.now()), 1000);
    return () => clearInterval(timer);
  }, [sample]);
  const now = new Date(synchronizedTime ?? (sample ? sample.timestamp + Math.max(0, tick - sample.receivedAt) : Date.now()));
  const format = { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true, timeZoneName: 'short' };
  let time;
  try { time = now.toLocaleTimeString('en-US', { ...format, timeZone: timezone }); }
  catch { time = now.toLocaleTimeString('en-US', { ...format, timeZone: 'UTC' }); }
  return <div className="lead-dial-clock"><small>{synchronizedTime != null || sample ? 'CRM time' : 'Device time'}</small><time dateTime={now.toISOString()}>{time}</time></div>;
}

function RetryQueue({ label, queue, timezone, now }) {
  return <section className="lead-dial-queue-summary" aria-label={label}>
    <strong>{label}</strong>
    <span className="lead-dial-muted">{queue.enabled ? 'Enabled' : 'Off'} · Up to {queue.maxRetries} {queue.maxRetries === 1 ? 'retry' : 'retries'} per lead</span>
    <div className="lead-dial-run-counts"><span>{queue.due} due</span><span>{queue.upcoming} upcoming</span><span>{queue.waiting} without a retry time</span></div>
    {queue.entries.length > 0 && <ul>{queue.entries.map((entry) => <li key={entry.id}>
      <span>{entry.name || `Lead #${entry.id}`}</span>
      <small>{Date.parse(entry.callifiedDnpNextRetryAt) <= now ? 'Due · ' : ''}{formatDialTime(entry.callifiedDnpNextRetryAt, timezone, 'medium')} · {entry.callifiedDnpRetryCount}/{queue.maxRetries} used</small>
      {entry.retryFailure && <small className="lead-dial-error">
        {entry.retryFailureMessage || `Previous submission failed (${entry.retryFailure}).`}
      </small>}
    </li>)}</ul>}
    {queue.due + queue.upcoming > queue.entries.length && <small className="lead-dial-muted">Showing the next {queue.entries.length} retries.</small>}
  </section>;
}

function formatDialTime(date, timezone, timeStyle = 'short') {
  const options = { dateStyle: 'medium', timeStyle, hour12: true };
  try { return new Date(date).toLocaleString([], { ...options, timeZone: timezone }); }
  catch { return new Date(date).toLocaleString([], { ...options, timeZone: 'UTC' }); }
}

const outcomeLabels = { qualified: 'Qualified', pending: 'Pending', junk: 'Junk', dnp: 'DNP' };
function RunDetails({ job, timezone, children }) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(0);
  const [data, setData] = useState(null);
  useEffect(() => {
    if (!open) return;
    let current = true;
    setData(null);
    fetchApi(`/api/callified/dial-jobs/${job.id}/details?page=${page}`, { silent: true })
      .then(result => { if (current) setData(result); })
      .catch(() => { if (current) setData({ error: true }); });
    return () => { current = false; };
  }, [open, page, job.id, job.activeCallLogId, job.completed, job.failed, job.status]);
  const outcomes = { MISSED: 'DNP', COMPLETED: 'Completed', FAILED: 'Failed', CANCELLED: 'Cancelled', INITIATED: 'Submitted', RINGING: 'Ringing', CONNECTED: 'Connected' };
  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary aria-label={`View details for run ${job.id}`}>{children}</summary>
    {job.error && <div className="dial-run-notice"><small className="lead-dial-error">{job.error}</small></div>}
    {open && (!data ? <small>Loading details…</small> : data.error ? <small role="alert">Unable to load run details.</small> : <>
      <div className="dial-detail-body"><strong className="dial-detail-title">Leads dialed ({data.dialedCount ?? data.calls?.length ?? 0})</strong>
      {data.calls?.length ? <div className="dial-attempt-list">{data.calls.map(call => <div key={call.id} className="dial-attempt-row">
        <span className="dial-avatar">{(call.name || '?').charAt(0).toUpperCase()}</span><div><strong>{call.name || 'Unknown lead'}</strong>
        <small title={`${formatDialTime(call.at, timezone, 'medium')}${call.duration > 0 ? ` · ${call.duration}s` : ''}`}>{call.phone || 'Number unavailable'}</small></div>
        <span className="dial-outcome" data-outcome={call.outcome || call.status}>{outcomeLabels[call.outcome] || outcomes[call.status] || call.status}</span></div>)}</div>
        : <small>No call attempt recorded for this run on this page.</small>}
      {(page > 0 || data.hasMore) && <div><button disabled={!page} onClick={() => setPage(page - 1)}>Previous</button> <button disabled={!data.hasMore} onClick={() => setPage(page + 1)}>Next</button></div>}
      {!data.calls?.length && data.leads?.length > 0 && <details><summary>Selected leads</summary>{data.leads.map(lead => <small key={lead.id}>{lead.name} · {lead.phone || 'No phone number'}</small>)}</details>}
      </div>
    </>)}
  </details>;
}

function progressOf(runs) {
  return runs.reduce((value, run) => ({
    done: value.done + Math.min(run.total, run.completed + run.failed + run.skipped),
    total: value.total + run.total,
  }), { done: 0, total: 0 });
}

export function DialToolbar({ children, refreshKey, onOpen, onRequestStop, canManage, onChanged }) {
  const [snapshot, setSnapshot] = useState(null);
  const [busy, setBusy] = useState(false);
  const notify = useNotify();
  useEffect(() => {
    let closed = false, timer;
    async function poll() {
      try {
        if (!document.hidden) {
          const result = await fetchApi('/api/callified/dial-jobs?toolbar=1', { silent: true });
          if (!closed) setSnapshot(result);
        }
      } catch { if (!closed) setSnapshot(null); }
      if (!closed) timer = setTimeout(poll, 5000);
    }
    poll();
    return () => { closed = true; clearTimeout(timer); };
  }, [refreshKey]);
  const runs = snapshot?.running || [];
  if (!runs.length && (!snapshot?.activeCalls || (snapshot.paused && !(Date.parse(snapshot.latestCallAt) > Date.parse(snapshot.stoppedAt))))) {
    const badge = snapshot?.upcoming > 0 ? <span className="dial-toolbar-upcoming"><Clock size={12} aria-hidden="true"/>{snapshot.upcoming} upcoming</span> : null;
    return typeof children === 'function' ? children(badge) : children;
  }
  const { done, total } = progressOf(runs);
  async function stop() {
    setBusy(true);
    try {
      await fetchApi('/api/callified/dial-jobs/control', { method: 'PUT', body: JSON.stringify({ paused: true }) });
      setSnapshot(current => ({ ...current, running: [], paused: true, activeCalls: 0 }));
      notify.success('Queue stopped. Any submitted call will finish in Callified.');
      onChanged?.();
      onOpen();
    } catch (error) { notify.error(error.message || 'Unable to stop dialing.'); }
    finally { setBusy(false); }
  }
  return <div className="dial-toolbar-live"><button type="button" onClick={onOpen} aria-label="Open live call status"><i/> Dialing {total ? <>{done} / {total}<progress value={done} max={total}/></> : <>{snapshot.activeCalls} active</>}</button>
    {canManage && <button type="button" className="dial-stop-action" title="Stop all dialing" aria-label="Stop all dialing" disabled={busy} onClick={onRequestStop || stop}><Square size={12} fill="currentColor"/></button>}</div>;
}

function Countdown({ at, clock }) {
  const [tick,setTick] = useState(() => performance.now());
  useEffect(() => { const timer = setInterval(() => setTick(performance.now()),1000); return () => clearInterval(timer); }, []);
  const seconds = Math.max(0, Math.ceil((Date.parse(at) - (clock ? clock.timestamp + Math.max(0,tick-clock.receivedAt) : Date.now()))/1000));
  const minutes = Math.floor(seconds/60), hours = Math.floor(minutes/60);
  return <strong>{seconds ? 'Starts in ' + (hours >= 24 ? Math.floor(hours/24)+' d '+hours%24+' h' : hours ? hours+' h '+minutes%60+' m' : minutes+' m '+seconds%60+' s') : 'Ready to dial'}</strong>;
}

export function LeadDialRuns({ refreshKey = 0, managedRefresh = false, campaigns = [], connected, onChanged, canManage = false, canWrite = true, onManage, initialConfirm }) {
  const notify = useNotify();
  const [jobs, setJobs] = useState([]);
  const [view, setView] = useState('open');
  const [runType, setRunType] = useState('all');
  const [historyLimit, setHistoryLimit] = useState(5);
  const [historyCount, setHistoryCount] = useState(null);
  const [busy, setBusy] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [paused, setPaused] = useState(false);
  const [queues, setQueues] = useState(null);
  const [clock, setClock] = useState(null);
  const requestVersion = useRef(0);
  const load = useCallback(async () => {
    const version = ++requestVersion.current;
    try {
      const result = await fetchApi('/api/callified/dial-jobs?includeQueues=1', { silent: true });
      if (version !== requestVersion.current) return;
      setJobs(result?.jobs || []);
      setQueues(result?.queues || null);
      setClock(makeClockSample(result?.queues?.serverTime));
      setPaused(Boolean(result?.queues?.paused));
      setLoadError('');
    }
    catch { if (version === requestVersion.current) setLoadError('Dial runs are unavailable. Refresh to try again.'); }
  }, []);
  useEffect(() => {
    let disposed = false; let timer;
    const poll = async () => {
      if (!disposed && document.visibilityState !== 'hidden') await load();
      if (!disposed && !managedRefresh) timer = setTimeout(poll, 8000);
    };
    poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [load, refreshKey, managedRefresh]);
  const cancel = async (job) => {
    setBusy(job.id);
    try {
      const result = await fetchApi(`/api/callified/dial-jobs/${job.id}/cancel`, { method: 'POST', silent: true });
      notify.success(result.currentCallContinues ? 'Queue stopped. The current call will finish normally.' : 'Dial run stopped. No further calls will be placed.');
      await load(); onChanged?.();
    } catch (err) { notify.error(err.message || 'Could not stop this run.'); }
    finally { setBusy(null); }
  };
  const openRuns = jobs
    .filter((job) => ['scheduled', 'running', 'paused'].includes(job.status))
    .sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running'));
  const previousRuns = jobs.filter((job) => !openRuns.includes(job));
  const live = progressOf(openRuns.filter(job => job.status === 'running'));
  const queueStopped = paused && !live.total && !queues?.calls?.some(call => Date.parse(call.createdAt) > Date.parse(queues.stoppedAt));
  const isDialing = !queueStopped && (live.total > 0 || queues?.activeCalls > 0);
  const runKind = (job) => job.scheduled ? 'scheduled' : job.campaignCount ? 'campaign' : job.byStatus || job.total !== 1 ? 'bulk' : 'single';
  const visible = (view === 'open' ? openRuns : previousRuns)
    .filter((job) => runType === 'all' || runKind(job) === runType);
  const schedules = visible.filter(job => job.status === 'scheduled');
  const stopDialing = async () => {
    setBusy('control');
    try {
      const result = await fetchApi('/api/callified/dial-jobs/control', { method: 'PUT', silent: true, body: JSON.stringify({ paused: true }) });
      setPaused(Boolean(result.paused));
      notify.success('Queue stopped. Any submitted call will finish in Callified.');
      await load(); onChanged?.();
    } catch (error) { notify.error(error.message || 'Unable to update dialing.'); }
    finally { setBusy(null); }
  };
  const queueCount = queues ? queues.pending.due + queues.pending.upcoming + queues.dnp.due + queues.dnp.upcoming + queues.autoDial.queued + queues.autoDial.submitting + queues.activeCalls : 0;
  return <section className="lead-dial-runs dial-run-workspace" aria-label="Dial runs">
    <div className="lead-dial-runs-heading">
      <strong><CalendarClock size={16} /> Dial runs</strong>
      {managedRefresh && connected != null && <span className="cs-pill" data-tone={connected ? 'COMPLETED' : 'FAILED'}>Callified {connected ? 'connected' : 'disconnected'}</span>}
      {!managedRefresh && <button type="button" aria-label="Refresh dial runs" onClick={load}>Refresh</button>}
    </div>
    <div className="lead-dial-run-filters" aria-label="Filter dial runs">
      <button type="button" className="btn-secondary" aria-pressed={view === 'open'} onClick={() => setView('open')}>Active &amp; upcoming{managedRefresh ? ` (${activeQueueSize(jobs, queues)})` : openRuns.length > 0 && ` (${openRuns.length})`}</button>
      <button type="button" className="btn-secondary" aria-pressed={view === 'previous'} onClick={() => setView('previous')}>Past runs{!managedRefresh || historyCount !== null ? ` (${managedRefresh ? historyCount : previousRuns.length})` : ''}</button>
    </div>
    {managedRefresh && view === 'open' ? <>{loadError && <p role="status">{loadError}</p>}
      <DialQueuePanel jobs={jobs} queues={queues} campaigns={campaigns} clock={clock} live={live} isDialing={isDialing} busy={busy !== null} canWrite={canWrite} canManage={canManage} stopDialing={stopDialing} cancel={cancel} onManage={onManage} initialConfirm={initialConfirm}
        onStarted={async () => { await load(); onChanged?.(); }} renderDetails={(job, zone) => <RunDetails job={job} timezone={zone}>Run details</RunDetails>}/>
    </> : managedRefresh ? <DialRunHistory timezone={queues?.timezone || tenantTimezone() || 'UTC'} refreshKey={refreshKey} onCount={setHistoryCount}/> : <>
    {view === 'open' && (isDialing || (queueStopped && queues?.activeCalls > 0)) && <div className="dial-live-card"><header><strong>{queueStopped ? 'Queue stopped · submitted to Callified' : 'Dialing now'}</strong>{live.total > 0 && <span>{Math.round(100*live.done/live.total)}%</span>}</header>
      {live.total ? <><p><b>{live.done}</b> of {live.total} calls done</p><progress value={live.done} max={live.total}/></> : <p>{queues.activeCalls} active</p>}
      {queues?.calls?.map(call => <p key={call.id}><strong>{call.name || 'Unknown lead'}</strong>{call.phone && <> · {call.phone}</>}</p>)}
      {canManage && isDialing && <button type="button" className="dial-stop-action" disabled={busy !== null} onClick={stopDialing}><Square size={12} fill="currentColor"/> Stop all dialing</button>}
      <small>Stopping cancels queued calls. Calls already submitted to Callified finish normally.</small></div>}
    {view === 'open' && queues && <details className="dial-queue-disclosure">
      <summary>Queues and dialing controls{queueCount > 0 ? ` · ${queueCount}` : ''}</summary>
      {canManage && !isDialing && (openRuns.length > 0 || (!queueStopped && queueCount > 0)) && <button type="button" className="btn-secondary" onClick={stopDialing} disabled={busy === 'control'}><Square size={13} /> Stop all dialing</button>}
      <div className="lead-dial-queue-overview">
        <CrmDialClock timezone={queues.timezone} sample={clock} />
        <span>{queues.activeCalls} active {queues.activeCalls === 1 ? 'Callified call' : 'Callified calls'}</span>
      </div>
      {!queues.workerEnabled && <p className="lead-dial-muted">Callified automation is disabled on this server.</p>}
      <div className="lead-dial-queue-grid">
        <RetryQueue label="Pending retries" queue={queues.pending} timezone={queues.timezone} now={Date.parse(queues.serverTime)} />
        <RetryQueue label="DNP retries" queue={queues.dnp} timezone={queues.timezone} now={Date.parse(queues.serverTime)} />
        <section className="lead-dial-queue-summary" aria-label="New-lead auto-dial">
          <strong>New-lead auto-dial</strong>
          <span className="lead-dial-muted">{queues.autoDial.enabled ? 'Enabled' : 'Off'} · This worker</span>
          <div className="lead-dial-run-counts"><span>{queues.autoDial.queued} queued</span><span>{queues.autoDial.submitting} submitting</span></div>
        </section>
      </div>
    </details>}
    {(visible.length > 5 || runType !== 'all' || !managedRefresh && jobs.length > 0) && <div className="lead-dial-run-list-heading">
      <strong>{view === 'open' ? 'Queued and scheduled runs' : 'Recent run results'}</strong>
      <select className="input-field" aria-label="Filter run type" value={runType} onChange={(event) => setRunType(event.target.value)}>
        <option value="all">All run types</option><option value="scheduled">Scheduled calls</option>
        <option value="bulk">Bulk dial</option><option value="campaign">Campaign calls</option><option value="single">Single lead</option>
      </select>
    </div>}
    {loadError ? <p role="status" className="lead-dial-muted">{loadError}</p> : !visible.length ? (
      <div className="dial-run-empty"><CalendarClock size={22}/><strong>{runType !== 'all' ? 'No runs match this type' : view === 'open' ? (queueCount ? 'No scheduled dial runs' : 'Nothing running or scheduled') : 'No past runs'}</strong>
        {view === 'open' && !queueCount && runType === 'all' && <small>Use Bulk dial, or select leads in the table and choose Dial or Schedule.</small>}</div>
    ) : (view === 'previous' ? visible.slice(0, historyLimit) : visible).map((job) => {
      const upcoming = job.status === 'scheduled' && Date.parse(job.scheduledAt) > (clock?.timestamp ?? Date.now());
      const state = job.status === 'scheduled' ? upcoming ? 'Scheduled' : 'Queued' :
        ({ running: 'In progress', completed: 'Completed', cancelled: job.completed || job.failed || job.activeCallLogId ? 'Stopped' : 'Cancelled', paused: 'Paused' }[job.status] || job.status);
      const label = job.scheduled ? 'Scheduled calls' : `Dial run #${job.id}`;
      const processed = Math.min(job.total, job.completed + job.skipped + job.failed);
      const classified = Object.keys(outcomeLabels).filter(key => job.outcomes?.[key] > 0).map(key => [key, job.outcomes[key]]);
      const other = Math.max(0, job.completed - classified.reduce((sum, [,count]) => sum + count, 0));
      const unconfirmed = Boolean(job.dispatching && !job.activeCallLogId);
      const remaining = Math.max(0, job.total - processed - Number(Boolean(job.activeCallLogId) || unconfirmed));
      if (view === 'open' && job.status === 'scheduled' && job.scheduledAt) {
        const zone = queues?.timezone || tenantTimezone() || 'UTC';
        return <div key={job.id}>{job.id === schedules[0]?.id && <h4 className="dial-detail-title">Upcoming ({schedules.length})</h4>}<article className="dial-scheduled-card" key={job.id}><header><CalendarClock size={18}/><div><strong>{job.campaignIds?.map(id => campaigns.find(c => String(c.id) === String(id))?.name || `Campaign #${id}`).join(', ') || `${job.total} ${job.total === 1 ? 'lead' : 'leads'}`}</strong><small>{formatDialTime(job.scheduledAt, zone)}</small><small>{zone} · {new Intl.DateTimeFormat('en',{timeZone:zone,timeZoneName:'longOffset'}).formatToParts(new Date(job.scheduledAt)).find(part=>part.type==='timeZoneName')?.value}</small></div><span>Scheduled</span></header>
          <footer><Countdown at={job.scheduledAt} clock={clock}/>{canWrite && <button className="dial-stop-action" disabled={busy !== null} onClick={()=>cancel(job)}>Cancel schedule</button>}</footer></article>{job.id === schedules.at(-1)?.id && <small>Schedules are saved. You can leave this page and come back. Calls start at or after their scheduled time.</small>}</div>;
      }
      return <article className="lead-dial-run" key={job.id}>
        <div>
          <RunDetails job={job} timezone={queues?.timezone || tenantTimezone() || 'UTC'}>
          <strong>{label} <span className="lead-dial-run-state" data-status={job.status}>{state}</span></strong>
          {(job.firstDialAt || job.scheduledAt) && <small>{job.firstDialAt ? 'Ran' : upcoming ? 'Starts' : 'Scheduled for'} {new Date(job.firstDialAt || job.scheduledAt).toLocaleString('en-GB', { timeZone: queues?.timezone || tenantTimezone() || 'UTC', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true })}</small>}
          <div className="lead-dial-run-counts">
            {classified.map(([key,count]) => <span key={key}>{count} {outcomeLabels[key]}</span>)}
            {other > 0 && <span>{other} processed</span>}{job.skipped > 0 && <span>{job.skipped} skipped</span>}{job.failed > 0 && <span>{job.failed} failed</span>}
            {view === 'open' && remaining > 0 && <span>{remaining} remaining</span>}
            {job.activeCallLogId && <span>1 call submitted · awaiting outcome</span>}
            {unconfirmed && <span>1 submission awaiting confirmation</span>}
            {job.status === 'cancelled' && remaining > 0 && <span>{remaining} not dialed</span>}
          </div>
          {view === 'open' && !isDialing && <progress aria-label={`Run ${job.id} progress`} value={processed} max={Math.max(1, job.total)} />}
          </RunDetails>
        </div>
        {canWrite && view === 'open' && <button type="button" className="lead-dial-stop" disabled={busy !== null} onClick={() => cancel(job)}>
          <Square size={13} /> {busy === job.id ? 'Stopping?' : job.status === 'scheduled' ? 'Cancel run' : 'Stop dialing'}
        </button>}
      </article>;
    })}
    {view === 'previous' && visible.length > historyLimit && <button className="btn-secondary dial-show-more" onClick={() => setHistoryLimit(n => n + 5)}>Show {Math.min(5, visible.length - historyLimit)} more runs · {visible.length - historyLimit} left</button>}
    </>}
  </section>;
}
