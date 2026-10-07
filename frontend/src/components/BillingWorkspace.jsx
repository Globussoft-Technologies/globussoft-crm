import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  Clock3,
  FileCheck2,
  Mail,
  Phone,
  Receipt,
  RefreshCw,
  UserRound,
  WalletCards,
} from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import './TransportDriverWorkspace.css';

const BILLING_STEPS = [
  { key: 'READY_FOR_BILLING', label: 'Ready for billing', action: 'Verify customer details' },
  { key: 'DETAILS_VERIFIED', label: 'Details verified', action: 'Prepare invoice' },
  { key: 'INVOICE_PREPARED', label: 'Invoice prepared', action: 'Send invoice' },
  { key: 'INVOICE_SENT', label: 'Invoice sent', action: 'Record payment' },
  { key: 'PAYMENT_RECEIVED', label: 'Payment received', action: 'Complete billing' },
  { key: 'BILLING_COMPLETED', label: 'Billing completed', action: null },
];

const stepIndex = (status) => Math.max(0, BILLING_STEPS.findIndex((step) => step.key === status));

export default function BillingWorkspace() {
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
      setData(await fetchApi('/api/pickup-plot-inventory/billing/me', { silent: true }));
    } catch (err) {
      setError(err?.message || 'Could not load the billing queue.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const assignments = useMemo(() => (Array.isArray(data?.assignments) ? data.assignments : []), [data?.assignments]);
  const summary = useMemo(() => ({
    total: assignments.length,
    active: assignments.filter((row) => row.status !== 'BILLING_COMPLETED').length,
    completed: assignments.filter((row) => row.status === 'BILLING_COMPLETED').length,
  }), [assignments]);
  const visibleAssignments = useMemo(() => assignments.filter((row) => (
    tab === 'completed' ? row.status === 'BILLING_COMPLETED' : row.status !== 'BILLING_COMPLETED'
  )), [assignments, tab]);

  const advance = async (assignment) => {
    const current = BILLING_STEPS[stepIndex(assignment.status)];
    const next = BILLING_STEPS[stepIndex(assignment.status) + 1];
    if (!next) return;
    setUpdating(assignment.assignmentKey);
    setError('');
    try {
      const result = await fetchApi(
        `/api/pickup-plot-inventory/billing/me/assignments/${encodeURIComponent(assignment.assignmentKey)}/status`,
        { method: 'PATCH', body: JSON.stringify({ status: next.key }) },
      );
      setData((existing) => ({
        ...existing,
        assignments: existing.assignments.map((row) => (
          row.assignmentKey === assignment.assignmentKey
            ? { ...row, status: result.status, statusUpdatedAt: result.statusUpdatedAt }
            : row
        )),
      }));
      notify.success(`${assignment.customer?.name || 'Customer'}: ${next.label}.`);
    } catch (err) {
      setError(err?.message || `Could not ${current.action.toLowerCase()}.`);
    } finally {
      setUpdating('');
    }
  };

  return (
    <main className="transport-workspace" data-testid="billing-workspace">
      <section className="transport-hero">
        <div>
          <span className="transport-eyebrow"><WalletCards size={15} /> Billing Department</span>
          <h1>Interested customer billing</h1>
          <p>Customers confirmed by brokers arrive here for invoice and payment processing.</p>
        </div>
        <button type="button" className="transport-refresh" onClick={load} disabled={loading}>
          <RefreshCw size={16} className={loading ? 'is-spinning' : ''} /> Refresh
        </button>
        {data?.billingUser && (
          <div className="transport-driver-strip">
            <span className="transport-avatar"><UserRound size={19} /></span>
            <span><strong>{data.billingUser.name}</strong><small>Billing team member</small></span>
            <span className="transport-vehicle-number">Billing Department</span>
          </div>
        )}
      </section>

      <section className="transport-summary" aria-label="Billing summary">
        <div><span className="transport-summary-icon active"><Receipt size={18} /></span><span><strong>{summary.active}</strong><small>Active billing</small></span></div>
        <div><span className="transport-summary-icon done"><CheckCircle2 size={18} /></span><span><strong>{summary.completed}</strong><small>Completed</small></span></div>
        <div><span className="transport-summary-icon total"><Clock3 size={18} /></span><span><strong>{summary.total}</strong><small>Total received</small></span></div>
      </section>

      <div className="transport-toolbar">
        <div className="transport-tabs" role="tablist" aria-label="Billing filters">
          <button type="button" role="tab" aria-selected={tab === 'active'} className={tab === 'active' ? 'active' : ''} onClick={() => setTab('active')}>Active</button>
          <button type="button" role="tab" aria-selected={tab === 'completed'} className={tab === 'completed' ? 'active' : ''} onClick={() => setTab('completed')}>Completed</button>
        </div>
        <span className="transport-trip-count">{visibleAssignments.length} customer{visibleAssignments.length === 1 ? '' : 's'}</span>
      </div>

      {error && <div className="transport-error" role="alert">{error}</div>}
      {loading && !data && <div className="transport-loading" role="status">Loading billing queue…</div>}
      {!loading && !error && visibleAssignments.length === 0 && (
        <section className="transport-empty">
          <span><FileCheck2 size={28} /></span>
          <h2>{tab === 'active' ? 'No customers waiting for billing' : 'No completed billing yet'}</h2>
          <p>Customers appear after a broker confirms that they are interested.</p>
        </section>
      )}

      <section className="transport-trip-list" aria-label={`${tab} billing assignments`}>
        {visibleAssignments.map((assignment) => (
          <BillingCard
            key={assignment.assignmentKey}
            assignment={assignment}
            updating={updating === assignment.assignmentKey}
            onAdvance={() => advance(assignment)}
          />
        ))}
      </section>
    </main>
  );
}

function BillingCard({ assignment, updating, onAdvance }) {
  const index = stepIndex(assignment.status);
  const current = BILLING_STEPS[index];
  const next = BILLING_STEPS[index + 1];
  const price = assignment.plot?.price == null
    ? null
    : new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(Number(assignment.plot.price));
  return (
    <article className="transport-trip-card">
      <header>
        <div>
          <span className="transport-next-badge">From broker {assignment.broker?.name || 'team'}</span>
          <h2>{assignment.customer?.name || 'Interested customer'}</h2>
          <p>{assignment.customer?.company || assignment.customer?.email || 'Customer billing'}</p>
        </div>
        <span className={`transport-status${assignment.status === 'BILLING_COMPLETED' ? ' status-completed' : ''}`}>{current.label}</span>
      </header>

      <div className="transport-passenger" style={{ marginTop: 18 }}>
        <span><Receipt size={17} /></span>
        <div><small>Plot / invoice item</small><strong>{assignment.plot?.name || 'Plot not assigned'}{price ? ` · ${price}` : ''}</strong></div>
      </div>

      <div className="transport-progress" aria-label={`Billing progress: ${current.label}`} style={{ gridTemplateColumns: `repeat(${BILLING_STEPS.length - 1}, 1fr)` }}>
        {BILLING_STEPS.slice(0, -1).map((step, stepNumber) => <span key={step.key} className={stepNumber < index ? 'done' : ''} />)}
      </div>

      <footer>
        {assignment.customer?.email && <a className="transport-map-button" href={`mailto:${assignment.customer.email}`}><Mail size={16} /> Email</a>}
        {assignment.customer?.phone && <a className="transport-map-button" href={`tel:${assignment.customer.phone}`}><Phone size={16} /> Call</a>}
        {next ? (
          <button type="button" className="transport-primary-button" onClick={onAdvance} disabled={updating}>
            {updating ? 'Updating…' : current.action}<ArrowRight size={16} />
          </button>
        ) : <span className="transport-complete-label"><CheckCircle2 size={16} /> Billing completed</span>}
      </footer>
    </article>
  );
}
