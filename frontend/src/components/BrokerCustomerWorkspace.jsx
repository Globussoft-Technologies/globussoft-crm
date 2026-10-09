import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  Bell,
  Building2,
  CalendarClock,
  CheckCircle2,
  Clock3,
  Handshake,
  Mail,
  MapPin,
  Phone,
  RefreshCw,
  Search,
  UserCheck,
  UserX,
  Users,
} from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import './TransportDriverWorkspace.css';

const BROKER_STEPS = [
  { key: 'READY_TO_SCHEDULE', label: 'Ready to schedule', action: 'Schedule visit' },
  { key: 'VISIT_SCHEDULED', label: 'Visit scheduled', action: 'Confirm visit', next: 'VISIT_CONFIRMED' },
  { key: 'VISIT_CONFIRMED', label: 'Visit confirmed', action: 'Send reminder', next: 'REMINDER_SENT' },
  { key: 'REMINDER_SENT', label: 'Reminder sent', action: null },
  { key: 'ATTENDED', label: 'Attended', action: 'Mark plot shown', next: 'PLOT_SHOWN' },
  { key: 'PLOT_SHOWN', label: 'Plot shown', action: 'Mark plot selected', next: 'PLOT_SELECTED' },
  { key: 'PLOT_SELECTED', label: 'Plot selected', action: null },
];

const SPECIAL_STEPS = {
  NO_SHOW: { key: 'NO_SHOW', label: 'No-show', action: 'Reschedule visit', next: 'VISIT_RESCHEDULED' },
  VISIT_RESCHEDULED: { key: 'VISIT_RESCHEDULED', label: 'Visit rescheduled', action: 'Confirm visit', next: 'VISIT_CONFIRMED' },
};

const workflowIndex = (status) => ['NO_SHOW', 'VISIT_RESCHEDULED'].includes(status)
  ? 3
  : Math.max(0, BROKER_STEPS.findIndex((step) => step.key === status));

export default function BrokerCustomerWorkspace() {
  const notify = useNotify();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [updating, setUpdating] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await fetchApi('/api/pickup-plot-inventory/brokers/me', { silent: true }));
    } catch (err) {
      setError(err?.message || 'Could not load your assigned customers.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const customers = useMemo(() => (Array.isArray(data?.customers) ? data.customers : []), [data?.customers]);
  const summary = useMemo(() => ({
    total: customers.length,
    completed: customers.filter((customer) => customer.tripCompleted).length,
    waiting: customers.filter((customer) => !customer.tripCompleted).length,
  }), [customers]);
  const visibleCustomers = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return customers.filter((customer) => {
      if (['PLOT_SELECTED', 'CLOSED_NO_INTEREST'].includes(customer.brokerWorkflow?.status)) return false;
      if (filter === 'completed' && !customer.tripCompleted) return false;
      if (filter === 'waiting' && customer.tripCompleted) return false;
      if (!needle) return true;
      return [customer.name, customer.company, customer.phone, customer.email, customer.plot?.name]
        .some((value) => String(value || '').toLowerCase().includes(needle));
    });
  }, [customers, filter, search]);

  const advanceWorkflow = async (customer, requestedStatus, details = {}) => {
    if (!customer.tripCompleted || !customer.brokerWorkflow) return;
    if (!requestedStatus) return;
    setUpdating(customer.assignmentKey);
    setError('');
    try {
      const result = await fetchApi(
        `/api/pickup-plot-inventory/brokers/me/assignments/${encodeURIComponent(customer.assignmentKey)}/workflow`,
        { method: 'PATCH', body: JSON.stringify({ status: requestedStatus, ...details }) },
      );
      setData((current) => ({
        ...current,
        customers: current.customers.map((row) => (
          row.assignmentKey === customer.assignmentKey
            ? { ...row, brokerWorkflow: { status: result.status, updatedAt: result.statusUpdatedAt, visitScheduledAt: result.visitScheduledAt } }
            : row
        )),
      }));
      if (result.status === 'PLOT_SELECTED') {
        notify.success(`${customer.name}'s selected plot was sent to the Billing Department.`);
      } else {
        const completedStep = BROKER_STEPS.find((step) => step.key === result.status) || SPECIAL_STEPS[result.status];
        notify.success(`${customer.name}: ${completedStep?.label || 'Site visit updated'}.`);
      }
    } catch (err) {
      setError(err?.message || 'Could not update the site visit.');
    } finally {
      setUpdating(null);
    }
  };

  return (
    <main className="transport-workspace" data-testid="broker-customer-workspace">
      <section className="transport-hero">
        <div>
          <span className="transport-eyebrow"><Handshake size={15} /> Sales Executive workspace</span>
          <h1>Site Visit Management</h1>
          <p>Schedule and manage customer site visits after transport drop-off is completed.</p>
        </div>
        <button type="button" className="transport-refresh" onClick={load} disabled={loading}>
          <RefreshCw size={16} className={loading ? 'is-spinning' : ''} /> Refresh
        </button>
        {data?.broker && (
          <div className="transport-driver-strip">
            <span className="transport-avatar"><Handshake size={19} /></span>
            <span><strong>{data.broker.name}</strong><small>{data.broker.agency || 'Independent sales executive'}</small></span>
            {data.broker.commissionPercent != null && <span className="transport-vehicle-number">{Number(data.broker.commissionPercent)}% commission</span>}
          </div>
        )}
      </section>

      <section className="transport-summary" aria-label="Customer summary">
        <div><span className="transport-summary-icon total"><Users size={18} /></span><span><strong>{summary.total}</strong><small>All customers</small></span></div>
        <div><span className="transport-summary-icon done"><CheckCircle2 size={18} /></span><span><strong>{summary.completed}</strong><small>Ready for visit</small></span></div>
        <div><span className="transport-summary-icon active"><Clock3 size={18} /></span><span><strong>{summary.waiting}</strong><small>Waiting for trip</small></span></div>
      </section>

      <div className="transport-toolbar" style={{ gap: 12, flexWrap: 'wrap' }}>
        <div className="transport-tabs" role="tablist" aria-label="Customer filters">
          {[
            ['all', 'All'], ['completed', 'Trip completed'], ['waiting', 'Not completed'],
          ].map(([key, label]) => (
            <button key={key} type="button" role="tab" aria-selected={filter === key} className={filter === key ? 'active' : ''} onClick={() => setFilter(key)}>{label}</button>
          ))}
        </div>
        <label style={{ position: 'relative', flex: '1 1 230px', maxWidth: 340 }}>
          <Search size={16} aria-hidden="true" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }} />
          <input aria-label="Search assigned customers" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search customers…" style={{ width: '100%', padding: '10px 12px 10px 36px', borderRadius: 11, border: '1px solid var(--border-color)', background: 'var(--card-bg, var(--subtle-bg-2))', color: 'var(--text-primary)' }} />
        </label>
      </div>

      {error && <div className="transport-error" role="alert">{error}</div>}
      {loading && !data && <div className="transport-loading" role="status">Loading your assigned customers…</div>}
      {!loading && !error && visibleCustomers.length === 0 && (
        <section className="transport-empty">
          <span><Users size={28} /></span>
          <h2>No customers found</h2>
          <p>{customers.length ? 'No assigned customers match this filter.' : 'Customers assigned by your administrator will appear here.'}</p>
        </section>
      )}

      <section aria-label="Assigned customers" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 310px), 1fr))', gap: 14 }}>
        {visibleCustomers.map((customer) => (
          <CustomerCard
            key={customer.assignmentKey}
            customer={customer}
            updating={updating === customer.assignmentKey}
            onAdvance={(status, details) => advanceWorkflow(customer, status, details)}
          />
        ))}
      </section>
    </main>
  );
}

function CustomerCard({ customer, updating, onAdvance }) {
  const [visitScheduledAt, setVisitScheduledAt] = useState('');
  const initials = String(customer.name || '?').split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
  const workflowStatus = customer.brokerWorkflow?.status;
  const index = workflowIndex(workflowStatus);
  const currentStep = SPECIAL_STEPS[workflowStatus] || BROKER_STEPS[index];
  const needsSchedule = ['READY_TO_SCHEDULE', 'NO_SHOW'].includes(workflowStatus);
  const needsAttendance = workflowStatus === 'REMINDER_SENT';
  const handedToBilling = workflowStatus === 'PLOT_SELECTED';
  const noShow = workflowStatus === 'NO_SHOW';

  const submitSchedule = () => {
    if (!visitScheduledAt) return;
    onAdvance(workflowStatus === 'NO_SHOW' ? 'VISIT_RESCHEDULED' : 'VISIT_SCHEDULED', { visitScheduledAt });
  };
  return (
    <article className="transport-trip-card" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <header style={{ alignItems: 'flex-start' }}>
        <div style={{ display: 'flex', gap: 11, minWidth: 0 }}>
          <span style={{ display: 'grid', placeItems: 'center', width: 42, height: 42, borderRadius: 13, flex: '0 0 auto', background: 'color-mix(in srgb, var(--primary-color, var(--accent-color)) 14%, transparent)', color: 'var(--primary-color, var(--accent-color))', fontWeight: 800 }}>{initials}</span>
          <div style={{ minWidth: 0 }}><h2 style={{ marginTop: 0 }}>{customer.name}</h2><p>{customer.company || 'Individual customer'}</p></div>
        </div>
        <span className={`transport-status${customer.tripCompleted ? ' status-completed' : ''}`} style={customer.tripCompleted ? undefined : { background: '#fef3c7', color: '#92400e' }}>
          {customer.tripMessage}
        </span>
      </header>

      <div style={{ display: 'grid', gap: 9, color: 'var(--text-secondary)', fontSize: '.82rem' }}>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}><MapPin size={15} /> {customer.plot?.name || 'Plot not assigned'}</span>
        {customer.plot?.address && <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Building2 size={15} /> {customer.plot.address}</span>}
        {customer.brokerWorkflow?.visitScheduledAt && <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}><CalendarClock size={15} /> {new Date(customer.brokerWorkflow.visitScheduledAt).toLocaleString()}</span>}
      </div>

      <div style={{ padding: 12, borderRadius: 12, background: customer.tripCompleted ? 'rgba(16,185,129,.10)' : 'var(--subtle-bg-2)', color: customer.tripCompleted ? '#047857' : 'var(--text-secondary)', fontSize: '.8rem', fontWeight: 700 }}>
        {customer.tripCompleted
          ? 'Trip completed — customer is ready for site visit management.'
          : 'Trip not completed. Site visit actions unlock after the customer reaches the plot.'}
      </div>

      {customer.tripCompleted && customer.brokerWorkflow && (
        <section aria-label={`Site visit process for ${customer.name}`} style={{ display: 'grid', gap: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
            <span style={{ fontSize: '.68rem', color: 'var(--text-secondary)', fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase' }}>Site visit process</span>
            <strong style={{ color: noShow ? '#b45309' : handedToBilling ? '#047857' : 'var(--primary-color, var(--accent-color))', fontSize: '.78rem' }}>{currentStep.label}</strong>
          </div>
          <div className="transport-progress" aria-label={`Site visit progress: ${currentStep.label}`} style={{ gridTemplateColumns: `repeat(${BROKER_STEPS.length - 1}, 1fr)`, margin: 0 }}>
            {BROKER_STEPS.slice(0, -1).map((step, stepIndex) => <span key={step.key} className={stepIndex < index ? 'done' : ''} />)}
          </div>
          <small style={{ color: 'var(--text-secondary)', lineHeight: 1.45 }}>
            Schedule the visit, record attendance, show the plot, and send a selected plot to Billing.
          </small>
        </section>
      )}

      {customer.tripCompleted && needsSchedule && (
        <div style={{ display: 'grid', gap: 8 }}>
          <label style={{ display: 'grid', gap: 5, color: 'var(--text-secondary)', fontSize: '.75rem', fontWeight: 700 }}>
            Visit date and time
            <input className="input-field" type="datetime-local" aria-label={`Visit date and time for ${customer.name}`} value={visitScheduledAt} onChange={(event) => setVisitScheduledAt(event.target.value)} />
          </label>
          <button type="button" className="transport-primary-button" onClick={submitSchedule} disabled={updating || !visitScheduledAt} style={{ width: '100%' }}>
            <CalendarClock size={16} /> {updating ? 'Updating…' : currentStep.action}
          </button>
        </div>
      )}
      {customer.tripCompleted && needsAttendance && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <button type="button" className="transport-map-button" onClick={() => onAdvance('NO_SHOW')} disabled={updating}>
            <UserX size={16} /> No-show
          </button>
          <button type="button" className="transport-primary-button" onClick={() => onAdvance('ATTENDED')} disabled={updating}>
            <UserCheck size={16} /> Attendance
          </button>
        </div>
      )}
      {customer.tripCompleted && currentStep?.next && !needsSchedule && !needsAttendance && !handedToBilling && (
        <button type="button" className="transport-primary-button" onClick={() => onAdvance(currentStep.next)} disabled={updating} style={{ width: '100%' }}>
          {workflowStatus === 'VISIT_CONFIRMED' && <Bell size={16} />}
          {updating ? 'Updating…' : currentStep.action}<ArrowRight size={16} />
        </button>
      )}
      {customer.tripCompleted && handedToBilling && (
        <span className="transport-complete-label" style={{ justifyContent: 'center' }}><CheckCircle2 size={16} /> Selected plot sent to Billing Department</span>
      )}

      <footer style={{ marginTop: 'auto' }}>
        {customer.email && <a className="transport-map-button" href={`mailto:${customer.email}`}><Mail size={16} /> Email</a>}
        {customer.phone && <a className="transport-primary-button" href={`tel:${customer.phone}`}><Phone size={16} /> Call customer</a>}
      </footer>
    </article>
  );
}
