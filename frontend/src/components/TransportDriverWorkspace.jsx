import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  Check,
  CheckCircle2,
  Clock3,
  MapPin,
  Navigation,
  Phone,
  Route,
  UserRound,
} from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import CallifiedCallDialog from './CallifiedCallDialog';
import './TransportDriverWorkspace.css';

const STATUS_STEPS = [
  { key: 'ASSIGNED', label: 'Assigned', action: 'Accept trip' },
  { key: 'ACCEPTED', label: 'Accepted', action: 'Start pickup' },
  { key: 'HEADING_TO_PICKUP', label: 'Going to pickup', action: 'Arrived at pickup' },
  { key: 'ARRIVED_AT_PICKUP', label: 'At pickup', action: 'Passenger on board' },
  { key: 'PICKED_UP', label: 'Picked up', action: 'Start trip' },
  { key: 'EN_ROUTE', label: 'On the way', action: 'Arrived at drop' },
  { key: 'ARRIVED_AT_DROP', label: 'At destination', action: 'Complete drop-off' },
  { key: 'COMPLETED', label: 'Completed', action: null },
];

const statusIndex = (status) => Math.max(0, STATUS_STEPS.findIndex((step) => step.key === status));

function formatTripTime(value) {
  if (!value) return 'Pending';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Pending' : date.toLocaleString();
}

function toDateTimeLocal(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const local = new Date(date.getTime() - (date.getTimezoneOffset() * 60_000));
  return local.toISOString().slice(0, 16);
}

function directionsUrl(assignment) {
  const origin = assignment.pickup?.address || assignment.pickup?.name;
  const destination = assignment.drop?.address || assignment.drop?.name;
  if (!origin && !destination) return null;
  const params = new URLSearchParams({ api: '1' });
  if (origin) params.set('origin', origin);
  if (destination) params.set('destination', destination);
  params.set('travelmode', 'driving');
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

export default function TransportDriverWorkspace() {
  const notify = useNotify();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [updating, setUpdating] = useState('');
  const [filter, setFilter] = useState('active');
  const [callCustomer, setCallCustomer] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await fetchApi('/api/pickup-plot-inventory/transport-persons/me', { silent: true }));
    } catch (err) {
      setError(err?.message || 'Could not load your assigned trips.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const assignments = useMemo(
    () => (Array.isArray(data?.assignments) ? data.assignments : []),
    [data?.assignments],
  );
  const summary = useMemo(() => ({
    total: assignments.length,
    active: assignments.filter((assignment) => assignment.status !== 'COMPLETED').length,
    completed: assignments.filter((assignment) => assignment.status === 'COMPLETED').length,
  }), [assignments]);
  const visibleAssignments = useMemo(
    () => assignments.filter((assignment) => {
      if (filter === 'completed') return assignment.status === 'COMPLETED';
      if (filter === 'active') return assignment.status !== 'COMPLETED';
      return true;
    }),
    [assignments, filter],
  );

  const advance = async (assignment) => {
    const index = statusIndex(assignment.status);
    const next = STATUS_STEPS[index + 1];
    if (!next) return;
    setUpdating(assignment.assignmentKey);
    setError('');
    try {
      const profileQuery = data?.isAdminOverview && assignment.assignedStaff?.profileId
        ? `?assignedProfileId=${encodeURIComponent(assignment.assignedStaff.profileId)}`
        : '';
      const result = await fetchApi(
        `/api/pickup-plot-inventory/transport-persons/me/assignments/${encodeURIComponent(assignment.assignmentKey)}/status${profileQuery}`,
        { method: 'PATCH', body: JSON.stringify({ status: next.key }) },
      );
      setData((current) => ({
        ...current,
        assignments: current.assignments.map((row) => (
          row.assignmentKey === assignment.assignmentKey
            ? {
              ...row,
              status: result.status,
              statusUpdatedAt: result.statusUpdatedAt,
              pickupAt: result.pickupAt,
              dropOffAt: result.dropOffAt,
            }
            : row
        )),
      }));
      if (result.status === 'COMPLETED') {
        const customerName = assignment.customer?.name;
        notify.success(
          customerName
            ? `Drop-off completed for ${customerName}. It was removed from your active trips.`
            : 'Drop-off completed. It was removed from your active trips.',
        );
      }
    } catch (err) {
      setError(err?.message || 'Could not update the trip status.');
    } finally {
      setUpdating('');
    }
  };

  const saveSchedule = async (assignment, schedule) => {
    const currentMinute = new Date();
    currentMinute.setSeconds(0, 0);
    const containsPastTime = Object.values(schedule).some((value) => {
      const candidate = new Date(value);
      return Number.isNaN(candidate.getTime()) || candidate < currentMinute;
    });
    if (containsPastTime) {
      setError('Pickup and drop-off times must be the present time or a future time.');
      return;
    }
    setUpdating(assignment.assignmentKey);
    setError('');
    try {
      const profileQuery = data?.isAdminOverview && assignment.assignedStaff?.profileId
        ? `?assignedProfileId=${encodeURIComponent(assignment.assignedStaff.profileId)}`
        : '';
      const result = await fetchApi(
        `/api/pickup-plot-inventory/transport-persons/me/assignments/${encodeURIComponent(assignment.assignmentKey)}/schedule${profileQuery}`,
        {
          method: 'PATCH',
          body: JSON.stringify(Object.fromEntries(
            Object.entries(schedule).map(([key, value]) => [key, new Date(value).toISOString()]),
          )),
        },
      );
      setData((current) => ({
        ...current,
        assignments: current.assignments.map((row) => (
          row.assignmentKey === assignment.assignmentKey ? { ...row, ...result } : row
        )),
      }));
      const savedLabel = schedule.scheduledPickupAt ? 'Pickup time' : 'Drop-off time';
      notify.success(`${savedLabel} saved for ${assignment.customer?.name || 'this trip'}.`);
    } catch (err) {
      setError(err?.message || 'Could not save the pickup and drop-off times.');
    } finally {
      setUpdating('');
    }
  };

  return (
    <main className="transport-workspace" data-testid="transport-driver-workspace">
      <section className="transport-summary" aria-label="Trip summary">
        <div><span className="transport-summary-icon active"><Route size={18} /></span><span><strong>{summary.active}</strong><small>Active trips</small></span></div>
        <div><span className="transport-summary-icon done"><CheckCircle2 size={18} /></span><span><strong>{summary.completed}</strong><small>Completed</small></span></div>
        <div><span className="transport-summary-icon total"><Clock3 size={18} /></span><span><strong>{summary.total}</strong><small>Total assigned</small></span></div>
      </section>

      <div className="transport-toolbar" style={{ gap: 12, flexWrap: 'wrap' }}>
        <div className="transport-tabs" role="tablist" aria-label="Trip filters">
          {[
            ['all', 'All'], ['active', 'Active'], ['completed', 'Completed'],
          ].map(([key, label]) => (
            <button key={key} type="button" role="tab" aria-selected={filter === key} className={filter === key ? 'active' : ''} onClick={() => setFilter(key)}>{label}</button>
          ))}
        </div>
        <span className="transport-trip-count">{visibleAssignments.length} trip{visibleAssignments.length === 1 ? '' : 's'}</span>
      </div>

      {error && <div className="transport-error" role="alert">{error}</div>}
      {loading && !data && <div className="transport-loading" role="status">Loading your assigned trips…</div>}
      {!loading && !error && visibleAssignments.length === 0 && (
        <section className="transport-empty">
          <span><CheckCircle2 size={28} /></span>
          <h2>You’re all caught up</h2>
          <p>New pickup and drop assignments will appear here automatically.</p>
        </section>
      )}

      <section className="transport-trip-list" aria-label={`${filter === 'all' ? 'All' : filter === 'completed' ? 'Completed' : 'Active'} trips`}>
        {visibleAssignments.map((assignment, index) => (
          <TripCard
            key={assignment.assignmentKey}
            assignment={assignment}
            featured={index === 0 && assignment.status !== 'COMPLETED'}
            updating={updating === assignment.assignmentKey}
            adminOverview={Boolean(data?.isAdminOverview)}
            onAdvance={() => advance(assignment)}
            onSaveSchedule={(schedule) => saveSchedule(assignment, schedule)}
            onCall={() => setCallCustomer(assignment.customer)}
          />
        ))}
      </section>
      {callCustomer && (
        <CallifiedCallDialog
          customer={{ name: callCustomer.name, phone: callCustomer.phone, subtitle: callCustomer.company || null }}
          endpoints={{
            context: `/api/pickup-plot-inventory/calling/customers/${callCustomer.id}/context`,
            campaigns: '/api/pickup-plot-inventory/calling/campaigns',
            aiCall: `/api/pickup-plot-inventory/calling/customers/${callCustomer.id}/ai-call`,
            manualCall: `/api/pickup-plot-inventory/calling/customers/${callCustomer.id}/manual-call`,
          }}
          historyHref="/callified-data"
          onClose={() => setCallCustomer(null)}
        />
      )}
    </main>
  );
}

function TripCard({ assignment, featured, updating, adminOverview, onAdvance, onSaveSchedule, onCall }) {
  const index = statusIndex(assignment.status);
  const current = STATUS_STEPS[index];
  const next = STATUS_STEPS[index + 1];
  const mapUrl = directionsUrl(assignment);
  const [pickupTime, setPickupTime] = useState(toDateTimeLocal(assignment.pickupAt || assignment.scheduledPickupAt));
  const [dropOffTime, setDropOffTime] = useState(toDateTimeLocal(assignment.dropOffAt || assignment.scheduledDropOffAt));
  const [pickupTimeError, setPickupTimeError] = useState('');
  const [dropOffTimeError, setDropOffTimeError] = useState('');
  const [earliestTime, setEarliestTime] = useState(() => toDateTimeLocal(new Date()));
  const savedPickupTime = toDateTimeLocal(assignment.pickupAt || assignment.scheduledPickupAt);
  const savedDropOffTime = toDateTimeLocal(assignment.dropOffAt || assignment.scheduledDropOffAt);
  const pickupIsPast = Boolean(pickupTime && pickupTime < earliestTime);
  const dropOffIsPast = Boolean(dropOffTime && dropOffTime < earliestTime);
  const updateScheduleTime = (value, setValue, setFieldError) => {
    const latestAllowedTime = toDateTimeLocal(new Date());
    setEarliestTime(latestAllowedTime);
    if (value && value < latestAllowedTime) {
      setValue('');
      setFieldError('Choose the present time or a future time');
      return;
    }
    setFieldError('');
    setValue(value);
  };
  useEffect(() => {
    const timer = window.setInterval(
      () => setEarliestTime(toDateTimeLocal(new Date())),
      30_000,
    );
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    setPickupTime(toDateTimeLocal(assignment.pickupAt || assignment.scheduledPickupAt));
  }, [assignment.pickupAt, assignment.scheduledPickupAt]);
  useEffect(() => {
    setDropOffTime(toDateTimeLocal(assignment.dropOffAt || assignment.scheduledDropOffAt));
  }, [assignment.dropOffAt, assignment.scheduledDropOffAt]);
  return (
    <article className={`transport-trip-card${featured ? ' featured' : ''}`}>
      <header>
        <div>
          {featured && <span className="transport-next-badge">Next trip</span>}
          {adminOverview && <span className="transport-next-badge">Assigned to {assignment.assignedStaff?.name || 'staff'}</span>}
          <h2>{assignment.customer?.name || 'Assigned transport'}</h2>
          <p>{assignment.customer?.company || assignment.drop?.referenceCode || 'Pickup and drop assignment'}</p>
        </div>
        <div className="transport-trip-header-right">
          <span className={`transport-status status-${assignment.status.toLowerCase()}`}>{current.label}</span>
          <div className="transport-trip-times" aria-label={`Pickup and drop-off times for ${assignment.customer?.name || 'assigned transport'}`}>
            <div className="transport-time-field"><Clock3 size={16} /><span><small>Pickup time</small><input type="datetime-local" min={earliestTime} aria-label={`Pickup time for ${assignment.customer?.name || 'assigned transport'}`} aria-invalid={Boolean(pickupTimeError || pickupIsPast)} value={pickupTime} disabled={Boolean(assignment.pickupAt) || assignment.status === 'COMPLETED'} onChange={(event) => updateScheduleTime(event.target.value, setPickupTime, setPickupTimeError)} /><em className={pickupTimeError || pickupIsPast ? 'invalid' : ''}>{pickupTimeError || (pickupIsPast ? 'Choose the present time or a future time' : 'Present or future time only')}</em></span>{assignment.status !== 'COMPLETED' && <button type="button" className="transport-save-time-check" aria-label="Save pickup time" title="Save pickup time" disabled={updating || !pickupTime || pickupIsPast || pickupTime === savedPickupTime} onClick={() => onSaveSchedule({ scheduledPickupAt: pickupTime })}><Check size={18} strokeWidth={2.5} /></button>}</div>
            <div className="transport-time-field"><Clock3 size={16} /><span><small>Drop-off / site visit time</small><input type="datetime-local" min={earliestTime} aria-label={`Drop-off time for ${assignment.customer?.name || 'assigned transport'}`} aria-invalid={Boolean(dropOffTimeError || dropOffIsPast)} value={dropOffTime} disabled={Boolean(assignment.dropOffAt) || assignment.status === 'COMPLETED'} onChange={(event) => updateScheduleTime(event.target.value, setDropOffTime, setDropOffTimeError)} /><em className={dropOffTimeError || dropOffIsPast ? 'invalid' : ''}>{dropOffTimeError || (dropOffIsPast ? 'Choose the present time or a future time' : 'Present or future time only')}</em></span>{assignment.status !== 'COMPLETED' && <button type="button" className="transport-save-time-check" aria-label="Save drop-off time" title="Save drop-off time" disabled={updating || !dropOffTime || dropOffIsPast || dropOffTime === savedDropOffTime} onClick={() => onSaveSchedule({ scheduledDropOffAt: dropOffTime })}><Check size={18} strokeWidth={2.5} /></button>}</div>
            {(assignment.pickupAt || assignment.dropOffAt) && <small className="transport-actual-time-note">Recorded from trip progress: {assignment.pickupAt ? `pickup ${formatTripTime(assignment.pickupAt)}` : ''}{assignment.pickupAt && assignment.dropOffAt ? ', ' : ''}{assignment.dropOffAt ? `drop-off ${formatTripTime(assignment.dropOffAt)}` : ''}</small>}
          </div>
        </div>
      </header>

      <div className="transport-route">
        <div className="transport-route-markers" aria-hidden="true"><span /><i /><b><MapPin size={15} /></b></div>
        <div className="transport-route-copy">
          <div><small>Pickup</small><strong>{assignment.pickup?.name || 'Pickup location pending'}</strong><p>{assignment.pickup?.address || 'Ask the administrator to add the pickup address.'}</p></div>
          <div><small>Drop</small><strong>{assignment.drop?.name || 'Drop location pending'}</strong><p>{assignment.drop?.address || assignment.drop?.referenceCode || 'Ask the administrator to add the destination.'}</p></div>
        </div>
      </div>

      <div className="transport-passenger">
        <span><UserRound size={17} /></span>
        <div><small>Customer</small><strong>{assignment.customer?.name || 'Not assigned'}</strong></div>
        {assignment.customer?.phone && <button type="button" onClick={onCall} aria-label={`Call ${assignment.customer.name}`}><Phone size={16} /> Call</button>}
      </div>

      <div className="transport-progress" aria-label={`Trip progress: ${current.label}`}>
        {STATUS_STEPS.slice(0, -1).map((step, stepIndex) => <span key={step.key} className={stepIndex <= index ? 'done' : ''} />)}
      </div>

      <footer>
        {mapUrl && <a className="transport-map-button" href={mapUrl} target="_blank" rel="noreferrer"><Navigation size={16} /> Open route</a>}
        {next ? (
          <button type="button" className="transport-primary-button" onClick={onAdvance} disabled={updating}>
            {updating ? 'Updating…' : current.action}<ArrowRight size={17} />
          </button>
        ) : <span className="transport-complete-label"><CheckCircle2 size={17} /> Drop-off completed</span>}
      </footer>
    </article>
  );
}
