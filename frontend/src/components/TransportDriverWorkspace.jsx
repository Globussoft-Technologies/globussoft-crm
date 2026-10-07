import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  Clock3,
  MapPin,
  Navigation,
  Phone,
  RefreshCw,
  Route,
  Truck,
  UserRound,
} from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
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
  const [tab, setTab] = useState('active');

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
  const visibleAssignments = useMemo(() => assignments.filter((assignment) => (
    tab === 'completed' ? assignment.status === 'COMPLETED' : assignment.status !== 'COMPLETED'
  )), [assignments, tab]);

  const advance = async (assignment) => {
    const index = statusIndex(assignment.status);
    const next = STATUS_STEPS[index + 1];
    if (!next) return;
    setUpdating(assignment.assignmentKey);
    setError('');
    try {
      const result = await fetchApi(
        `/api/pickup-plot-inventory/transport-persons/me/assignments/${encodeURIComponent(assignment.assignmentKey)}/status`,
        { method: 'PATCH', body: JSON.stringify({ status: next.key }) },
      );
      setData((current) => ({
        ...current,
        assignments: current.assignments.map((row) => (
          row.assignmentKey === assignment.assignmentKey
            ? { ...row, status: result.status, statusUpdatedAt: result.statusUpdatedAt }
            : row
        )),
      }));
      if (result.status === 'COMPLETED') {
        const customerName = assignment.customer?.name;
        notify.success(
          customerName
            ? `Drop-off completed for ${customerName}. Trip moved to Completed.`
            : 'Drop-off completed. Trip moved to Completed.',
        );
      }
    } catch (err) {
      setError(err?.message || 'Could not update the trip status.');
    } finally {
      setUpdating('');
    }
  };

  return (
    <main className="transport-workspace" data-testid="transport-driver-workspace">
      <section className="transport-hero">
        <div>
          <span className="transport-eyebrow"><Truck size={15} /> Driver workspace</span>
          <h1>My pickup &amp; drop trips</h1>
          <p>Everything assigned to you is here. Update each trip as you move.</p>
        </div>
        <button type="button" className="transport-refresh" onClick={load} disabled={loading}>
          <RefreshCw size={16} className={loading ? 'is-spinning' : ''} /> Refresh
        </button>
        {data?.transportPerson && (
          <div className="transport-driver-strip">
            <span className="transport-avatar"><UserRound size={19} /></span>
            <span><strong>{data.transportPerson.name}</strong><small>{data.transportPerson.vehicleType || 'Transport vehicle'}</small></span>
            <span className="transport-vehicle-number">{data.transportPerson.vehicleNumber || 'Vehicle number not added'}</span>
          </div>
        )}
      </section>

      <section className="transport-summary" aria-label="Trip summary">
        <div><span className="transport-summary-icon active"><Route size={18} /></span><span><strong>{summary.active}</strong><small>Active trips</small></span></div>
        <div><span className="transport-summary-icon done"><CheckCircle2 size={18} /></span><span><strong>{summary.completed}</strong><small>Completed</small></span></div>
        <div><span className="transport-summary-icon total"><Clock3 size={18} /></span><span><strong>{summary.total}</strong><small>Total assigned</small></span></div>
      </section>

      <div className="transport-toolbar">
        <div className="transport-tabs" role="tablist" aria-label="Trip filters">
          <button type="button" role="tab" aria-selected={tab === 'active'} className={tab === 'active' ? 'active' : ''} onClick={() => setTab('active')}>Active</button>
          <button type="button" role="tab" aria-selected={tab === 'completed'} className={tab === 'completed' ? 'active' : ''} onClick={() => setTab('completed')}>Completed</button>
        </div>
        <span className="transport-trip-count">{visibleAssignments.length} trip{visibleAssignments.length === 1 ? '' : 's'}</span>
      </div>

      {error && <div className="transport-error" role="alert">{error}</div>}
      {loading && !data && <div className="transport-loading" role="status">Loading your assigned trips…</div>}
      {!loading && !error && visibleAssignments.length === 0 && (
        <section className="transport-empty">
          <span><CheckCircle2 size={28} /></span>
          <h2>{tab === 'active' ? 'You’re all caught up' : 'No completed trips yet'}</h2>
          <p>{tab === 'active' ? 'New pickup and drop assignments will appear here automatically.' : 'Finished drop-offs will be kept here for reference.'}</p>
        </section>
      )}

      <section className="transport-trip-list" aria-label={`${tab} trips`}>
        {visibleAssignments.map((assignment, index) => (
          <TripCard
            key={assignment.assignmentKey}
            assignment={assignment}
            featured={tab === 'active' && index === 0}
            updating={updating === assignment.assignmentKey}
            onAdvance={() => advance(assignment)}
          />
        ))}
      </section>
    </main>
  );
}

function TripCard({ assignment, featured, updating, onAdvance }) {
  const index = statusIndex(assignment.status);
  const current = STATUS_STEPS[index];
  const next = STATUS_STEPS[index + 1];
  const mapUrl = directionsUrl(assignment);
  return (
    <article className={`transport-trip-card${featured ? ' featured' : ''}`}>
      <header>
        <div>
          {featured && <span className="transport-next-badge">Next trip</span>}
          <h2>{assignment.customer?.name || 'Assigned transport'}</h2>
          <p>{assignment.customer?.company || assignment.drop?.referenceCode || 'Pickup and drop assignment'}</p>
        </div>
        <span className={`transport-status status-${assignment.status.toLowerCase()}`}>{current.label}</span>
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
        {assignment.customer?.phone && <a href={`tel:${assignment.customer.phone}`} aria-label={`Call ${assignment.customer.name}`}><Phone size={16} /> Call</a>}
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
