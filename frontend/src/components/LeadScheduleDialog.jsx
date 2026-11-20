import { useEffect, useRef, useState } from 'react';
import { X, ChevronLeft, ChevronRight, ChevronUp, ChevronDown } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { tenantTimezone } from '../utils/date';
import { wallTimeParts, scheduleInstant, useSchedulingClock } from '../utils/workspaceClock';
import './LeadScheduleDialog.css';
import { CrmDialClock } from './LeadDialWorkspace';

export default function LeadScheduleDialog(props) {
  const clock = useSchedulingClock();
  if (clock.now === null) {
    return <div className="lead-schedule-overlay">
      <section role="dialog" aria-modal="true" aria-label="Schedule dialing" className="lead-schedule-dialog" onKeyDown={event => { if (event.key === 'Escape') props.onClose(); }}>
        <div className="lead-schedule-content">
          <p role="status">{clock.failed ? 'Unable to synchronize CRM time. Close and try again.' : 'Synchronizing CRM time…'}</p>
        </div>
        <footer><button autoFocus onClick={props.onClose}>Cancel</button></footer>
      </section>
    </div>;
  }
  return <LeadScheduleForm {...props} clock={clock} />;
}

function LeadScheduleForm({ contactIds, onClose, onScheduled, timezone = tenantTimezone() || 'UTC', clock }) {
  const [initial] = useState(() =>
    wallTimeParts(Math.ceil((clock.now + 60000) / 900000) * 900000, timezone),
  );
  const [date, setDate] = useState(() => new Date(initial.year, initial.month - 1, initial.day));
  const [month, setMonth] = useState(() => new Date(initial.year, initial.month - 1, 1));
  const [hour, setHour] = useState(initial.hour % 12 || 12);
  const [minute, setMinute] = useState(initial.minute);
  const [period, setPeriod] = useState(initial.hour >= 12 ? 'PM' : 'AM');
  const [preview, setPreview] = useState(null), [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const lock = useRef(false), close = useRef(null);
  useEffect(() => {
    let live = true;
    close.current?.focus();
    fetchApi('/api/callified/dial-jobs/preview', {
      method: 'POST',
      silent: true,
      body: JSON.stringify({ contactIds }),
    }).then((result) => {
      if (live) setPreview(result);
    }).catch((err) => {
      if (live) setError(err?.body?.error || 'Unable to check selected leads. Close and try again.');
    });
    return () => { live = false; };
  }, [contactIds]);
  const eligibleIds = preview?.eligibleIds ?? [];
  const missing = preview?.missingPhone ?? 0;
  const otherSkipped = preview ? preview.withPhone - eligibleIds.length + preview.unavailable : 0;
  const instant = scheduleInstant(date, hour, minute, period, timezone);
  const now = clock.now;
  const validTime = Number.isFinite(instant.getTime());
  const future = validTime && instant.getTime() >= now + 30000;
  const todayParts = wallTimeParts(now, timezone);
  const today = new Date(todayParts.year, todayParts.month - 1, todayParts.day);
  const submit = async () => {
    if (lock.current || !future || instant.getTime() < clock.getNow() + 30000 || !eligibleIds.length) return;
    lock.current = true; setSaving(true); setError('');
    try {
      await fetchApi('/api/callified/dial-jobs', { method: 'POST', silent: true, body: JSON.stringify({ contactIds: eligibleIds, scheduledAt: instant.toISOString() }) });
      onScheduled(); onClose();
    } catch (err) { setError(err.message || 'Unable to schedule calls.'); } finally { lock.current = false; setSaving(false); }
  };
  return <div className="lead-schedule-overlay" onKeyDown={event => { if (event.key === 'Escape' && !saving) onClose(); }}>
    <section role="dialog" aria-modal="true" aria-labelledby="lead-schedule-title" className="lead-schedule-dialog">
      <header>
        <div><h2 id="lead-schedule-title">Schedule dialing</h2><p>Calls start on their own at the time you set.</p></div>
        <CrmDialClock timezone={timezone} now={now} />
        <button ref={close} aria-label="Close schedule" onClick={onClose} disabled={saving}><X size={18} /></button>
      </header>
      <div className="lead-schedule-content">
        <div className="lead-schedule-summary"><small>DIALING</small><strong>{preview ? `${preview.withPhone} leads with a phone number` : 'Checking selected leads…'}</strong>{missing > 0 && <p>{missing} selected leads have no phone number and will be skipped.</p>}{otherSkipped > 0 && <p>{otherSkipped} other selected leads are ineligible or unavailable.</p>}</div>
        <div className="lead-schedule-columns"><div className="lead-schedule-calendar"><div className="lead-schedule-month"><button aria-label="Previous month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><ChevronLeft size={16} /></button><strong>{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</strong><button aria-label="Next month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><ChevronRight size={16} /></button></div><div className="lead-schedule-days">{['Su','Mo','Tu','We','Th','Fr','Sa'].map(day => <small key={day}>{day}</small>)}{Array.from({ length: month.getDay() }, (_, i) => <span key={`empty${i}`} />)}{Array.from({ length: new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate() }, (_, i) => { const day = new Date(month.getFullYear(), month.getMonth(), i + 1); return <button key={i} aria-current={day.getTime() === today.getTime() ? "date" : undefined} aria-pressed={day.toDateString() === date.toDateString()} disabled={day < today} onClick={() => setDate(day)}><span className="lead-schedule-day-number">{i + 1}</span></button>; })}</div></div>
          <div className="lead-schedule-clock"><small>TIME</small><div className="lead-schedule-time">{[{ label: 'Hour', value: hour, set: setHour, min: 1, max: 12 }, { label: 'Minute', value: minute, set: setMinute, min: 0, max: 59 }].map((part, index) => <div className="lead-schedule-time-unit" key={part.label}><button aria-label={`Increase ${part.label.toLowerCase()}`} onClick={() => part.set(part.value === part.max ? part.min : part.value + 1)}><ChevronUp size={15} /></button><input aria-label={part.label} inputMode="numeric" value={String(part.value).padStart(2, '0')} onChange={e => { if (/^\d{0,2}$/.test(e.target.value)) part.set(Math.max(part.min, Math.min(part.max, Number(e.target.value)))); }} /><button aria-label={`Decrease ${part.label.toLowerCase()}`} onClick={() => part.set(part.value === part.min ? part.max : part.value - 1)}><ChevronDown size={15} /></button>{index === 0 && <b className="lead-schedule-colon">:</b>}</div>)}<div className="lead-schedule-period">{['AM','PM'].map(value => <button key={value} aria-pressed={period === value} onClick={() => setPeriod(value)}>{value}</button>)}</div></div><small>Minutes</small><div className="lead-schedule-presets">{[0,15,30,45].map(value => <button key={value} aria-pressed={minute === value} onClick={() => setMinute(value)}>:{String(value).padStart(2,'0')}</button>)}</div></div></div>
        <div className="lead-schedule-timezone">Workspace timezone <strong>{timezone === 'Asia/Kolkata' ? 'India (IST)' : timezone}</strong></div>
        <div className="lead-schedule-preview">{future ? <><strong>Starts {instant.toLocaleString(undefined, { timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</strong><p>{timezone} · Starts in {Math.ceil((instant - now) / 60000)} min</p><small>Nothing is dialed before this time. You can cancel the run before it starts.</small></> : !validTime ? 'This time does not exist in the workspace timezone. Choose another time.' : 'Pick a time at least 30 seconds in the future.'}</div>{error && <p role="alert">{error}</p>}
      </div><footer><button onClick={onClose} disabled={saving}>Cancel</button><button className="btn-primary" disabled={!preview || !future || !eligibleIds.length || saving} onClick={submit}>{saving ? 'Scheduling…' : `Schedule ${eligibleIds.length} leads`}</button></footer>
    </section>
  </div>;
}
