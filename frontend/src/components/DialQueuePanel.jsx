import { useEffect, useState } from 'react';
import { CalendarClock, Clock, Hourglass, List, RotateCcw, Square, User, X, Zap } from 'lucide-react';
import './DialQueuePanel.css';
import { ScheduleAudience } from './DialRunHistory';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';

const types = {
  scheduled: ['Scheduled', CalendarClock], pending: ['Pending retry', Hourglass],
  dnp: ['DNP retry', RotateCcw], single: ['Single call', User],
  auto: ['Auto-dial', Zap], run: ['Dial run', List],
};
const groups = ['Now', 'Due now', 'Coming up', 'Stopped'];
const filters = { all: 'All', scheduled: 'Scheduled', pending: 'Pending retries', dnp: 'DNP retries', single: 'Single calls', auto: 'Auto-dial', run: 'Dial runs', stopped: 'Stopped' };

function buildRows(jobs, queues, campaigns, now) {
  const rows = [];
  for (const job of jobs) {
    const stopped = job.status === 'stopped' || (job.status === 'cancelled' && (job.completed || job.failed || job.activeCallLogId));
    if (!stopped && !['running', 'scheduled', 'paused'].includes(job.status)) continue;
    const type = job.scheduled ? 'scheduled' : job.total === 1 ? 'single' : 'run';
    const names = job.campaignIds?.map(id => campaigns.find(c => String(c.id) === String(id))?.name || `Campaign #${id}`);
    const at = Date.parse(stopped ? job.updatedAt : job.firstDialAt || job.scheduledAt);
    rows.push({ key: 'job-' + job.id, type, job, at, name: names?.join(', ') || (job.scheduled ? `${job.total} ${job.total === 1 ? 'lead' : 'leads'}` : `Dial run #${job.id}`),
      group: stopped ? 'Stopped' : job.status === 'running' ? 'Now' : job.status === 'scheduled' && at <= now ? 'Due now' : 'Coming up',
      label: job.status === 'paused' ? 'Paused' : job.status === 'running' ? 'In progress' : '' });
  }
  for (const call of queues?.calls || []) {
    const linked = rows.find(row => row.job?.activeCallLogId === call.id);
    const name = [call.name, call.phone].filter(Boolean).join(' · ') || `Call #${call.id}`;
    if (linked && linked.group === 'Now') { linked.name = name; continue; }
    const finishing = queues.paused && Date.parse(call.createdAt) <= Date.parse(queues.stoppedAt);
    rows.push({ key: 'call-' + call.id, type: 'single', group: 'Now', name, at: Date.parse(call.createdAt), label: finishing ? 'Finishing in Callified' : 'Submitted' });
  }
  for (const type of ['pending', 'dnp']) {
    const queue = queues?.[type];
    if (!queue?.enabled) continue;
    const entries = queue.entries || [];
    for (const entry of entries) {
      const at = Date.parse(entry.callifiedDnpNextRetryAt);
      rows.push({ key: type + entry.id, type, group: at <= now ? 'Due now' : 'Coming up', at,
        name: entry.name || `Lead #${entry.id}`, warning: entry.retryFailureMessage || entry.retryFailure });
    }
    const seenDue = entries.filter(entry => Date.parse(entry.callifiedDnpNextRetryAt) <= Date.parse(queues.serverTime)).length;
    for (const [group, count] of [['Due now', queue.due - seenDue], ['Coming up', queue.upcoming - entries.length + seenDue]]) {
      if (count > 0) rows.push({ key: type + group, type, group, count, name: `${count} additional retries` });
    }
  }
  for (const [key, group, label] of [['queued', 'Coming up', 'Next free line'], ['submitting', 'Now', 'Submitting']]) {
    const count = queues?.autoDial?.[key];
    if (count) rows.push({ key, type: 'auto', group, count, name: `${count} new ${count === 1 ? 'lead' : 'leads'}`, label });
  }
  return rows.sort((a,b) => groups.indexOf(a.group) - groups.indexOf(b.group) || (a.at || Infinity) - (b.at || Infinity));
}

const size = rows => rows.reduce((sum,row) => sum + (row.count || 1), 0);

export function activeQueueSize(jobs, queues) {
  return size(buildRows(jobs, queues, [], Date.now()).filter(row => row.group !== 'Stopped'));
}

export default function DialQueuePanel({ jobs, queues, campaigns, clock, live, isDialing, busy, canWrite, canManage, stopDialing, cancel, onManage, initialConfirm, renderDetails, onStarted }) {
  const notify = useNotify();
  const [starting, setStarting] = useState(null);
  async function start(job) {
    setStarting(job.id);
    try {
      await fetchApi('/api/callified/dial-jobs',{method:'POST',body:JSON.stringify({startStoppedId:job.id})});
      await onStarted?.();
      notify.success('Schedule queued to start now.');
    } catch(error) { notify.error(error.message || 'Unable to start this schedule.'); }
    finally { setStarting(null); }
  }
  const [filter, setFilter] = useState('all');
  const [limit, setLimit] = useState(8);
  const [confirm, setConfirm] = useState(Boolean(initialConfirm));
  const [tick, setTick] = useState(() => performance.now());
  useEffect(() => {
    const timer = setInterval(() => setTick(performance.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const now = clock ? clock.timestamp + Math.max(0, tick - clock.receivedAt) : Date.now();
  const zone = queues?.timezone || 'UTC';
  const rows = buildRows(jobs, queues, campaigns, now);
  const matching = key => rows.filter(row => key === 'stopped'
    ? row.group === 'Stopped'
    : row.group !== 'Stopped' && (key === 'all' || row.type === key));
  const filtered = matching(filter);
  const visible = filtered.slice(0, limit);
  const percent = live.total ? Math.round(live.done * 100 / live.total) : 0;
  const showProgress = isDialing && ['all','scheduled','run'].includes(filter);
  const showQueueStop = canManage && filtered.some(row => ['Due now', 'Coming up'].includes(row.group));
  const options = { timeZone: zone, hour: 'numeric', minute: '2-digit', hour12: true };
  return <div className="dq-panel">
    {queues && <div className="dq-settings">{[['pending','Pending retries'],['dnp','DNP retries'],['autoDial','New-lead auto-dial']].map(([key,title]) =>
      <span key={key} data-enabled={Boolean(queues[key]?.enabled)}>{title} · {queues[key]?.enabled ? 'On' : 'Off'}</span>)}
      {onManage && <button type="button" onClick={onManage}>Manage</button>}</div>}
    {queues && !queues.workerEnabled && <small>Callified automation is disabled on this server.</small>}
    <div className="dq-filters" aria-label="Queue types">{Object.entries(filters).filter(([key]) => key !== 'run' || matching(key).length).map(([key,title]) =>
      <button key={key} type="button" aria-pressed={filter === key} onClick={() => { setFilter(key); setLimit(8); }}>{title} {size(matching(key))}</button>)}</div>
    {(showProgress || showQueueStop) && <section className="dq-progress">
      <header><strong>{showProgress ? 'Dialing now' : 'Queued dialing'}</strong>{showProgress && live.total > 0 && <span>{percent}%</span>}</header>
      {showProgress && (live.total > 0 ? <><p><b>{live.done}</b> of {live.total} calls done</p><progress value={live.done} max={live.total} /></> : <p>{queues?.activeCalls} active</p>)}
      {canManage && (confirm ? <div className="dq-confirm" role="group" aria-label="Confirm stop all dialing"><strong>Stop all dialing?</strong><p>Stop the remaining calls, retries and schedules in this workspace.</p><div>
        <button type="button" disabled={busy} onClick={() => setConfirm(false)}>Keep dialing</button>
        <button type="button" disabled={busy} onClick={async () => { await stopDialing(); setConfirm(false); }}>Stop everything</button></div></div>
        : <button type="button" className="dial-stop-action" onClick={() => setConfirm(true)}><Square size={12} fill="currentColor"/> Stop all dialing</button>)}
      <small>Stopping cancels queued calls. Calls already submitted to Callified finish normally.</small>
    </section>}
    {groups.map(group => {
      const items = visible.filter(row => row.group === group);
      if (!items.length) return null;
      return <section className="dq-group" key={group} aria-label={group}><h4>{group} ({size(filtered.filter(row => row.group === group))})</h4>{items.map(row => {
        const [tag, Icon] = types[row.type];
        const minutes = Math.max(1, Math.ceil((row.at - now) / 60000));
        const when = row.label || (group === 'Coming up' && row.at ? `in ${minutes >= 60 ? Math.floor(minutes/60) + ' h ' : ''}${minutes % 60} m` : group === 'Coming up' ? 'Queued' : group);
        const date = Number.isFinite(row.at) ? new Date(row.at) : null;
        const timeZone = row.job?.timezone || zone;
        const differentDay = date && date.toLocaleDateString('en', { timeZone }) !== new Date(now).toLocaleDateString('en', { timeZone });
        const action = row.job?.status === 'scheduled' ? 'Cancel schedule' : 'Stop run';
        return <article className="dq-row" data-group={group} data-kind={row.type} key={row.key}>
          <span className="dq-tile"><Icon size={17}/></span><div className="dq-identity"><strong title={row.name}>{row.name}</strong><span className="dq-tag">{tag}</span>
          {row.type === 'scheduled' && <small>{row.job.timezone || zone}</small>}{row.warning && <small>{row.warning}</small>}</div>
          <div className="dq-when"><b>{when}</b>{date && <small>{date.toLocaleString('en-US', { ...options, timeZone, ...(differentDay && {month:'short',day:'numeric'}) })}</small>}</div>
          {row.type === 'scheduled' && <ScheduleAudience job={row.job} campaigns={campaigns}/>}
          {canWrite && row.job && group !== 'Stopped' && <button type="button" className={row.job.status === 'scheduled' ? 'dq-cancel-schedule' : ''} disabled={busy} onClick={() => cancel(row.job)} title={action} aria-label={action + ' · ' + row.name}>{row.job.status === 'scheduled' ? 'Cancel schedule' : <X size={16}/>}</button>}
          {row.job?.status === 'stopped' && canWrite && <div className="dh-pages dq-details"><button disabled={starting!==null} onClick={()=>start(row.job)}>Start now</button><button disabled={starting!==null || busy} onClick={()=>cancel(row.job)}>Dismiss</button></div>}
          {row.job && row.job.status !== 'scheduled' && row.job.status !== 'stopped' && renderDetails && <div className="dq-details">{renderDetails(row.job, zone)}</div>}
        </article>;
      })}</section>;
    })}
    {!filtered.length && <div className="dial-run-empty"><Clock size={22}/><strong>{filter === 'all' ? 'Nothing running or scheduled' : 'Nothing here'}</strong><small>{filter === 'all' ? 'Use Bulk dial, or select leads and choose Dial or Schedule.' : 'Choose All to see other dialing activity.'}</small></div>}
    {filtered.length > limit && <button type="button" className="btn-secondary dial-show-more" onClick={() => setLimit(limit + 8)}>Show {Math.min(8, filtered.length-limit)} more · {filtered.length-limit} left</button>}
    {filtered.some(row => row.type === 'scheduled' && row.group === 'Coming up') && <small>Schedules are saved. Calls start at or after their scheduled time.</small>}
  </div>;
}
