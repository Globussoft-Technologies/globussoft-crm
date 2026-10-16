import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  Clock3,
  FileCheck2,
  Mail,
  Phone,
  Receipt,
  UserRound,
} from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import './TransportDriverWorkspace.css';

const BILLING_STEPS = [
  { key: 'PLOT_RESERVED', label: 'Plot reserved', action: 'Start billing' },
  { key: 'BILLING', label: 'Billing', action: 'Create invoice' },
  { key: 'INVOICE_CREATED', label: 'Invoice created', action: 'Send invoice' },
  { key: 'INVOICE_SENT', label: 'Invoice sent', action: 'Set payment pending' },
  { key: 'PAYMENT_PENDING', label: 'Payment pending', action: 'Record payment received' },
  { key: 'PAYMENT_RECEIVED', label: 'Payment received', action: 'Verify payment' },
  { key: 'PAYMENT_VERIFIED', label: 'Payment verified', action: 'Confirm booking' },
  { key: 'BOOKING_CONFIRMED', label: 'Booking confirmed', action: 'Mark plot sold' },
  { key: 'PLOT_SOLD', label: 'Plot sold', action: 'Complete transaction' },
  { key: 'TRANSACTION_COMPLETED', label: 'Transaction completed', action: null },
];

const stepIndex = (status) => Math.max(0, BILLING_STEPS.findIndex((step) => step.key === status));

const plotLabel = (plot) => {
  const plotNumber = plot?.plotNumber || plot?.referenceCode;
  if (!plotNumber) return plot?.name || 'Plot not assigned';
  return `${plot.name || 'Plot'} — Plot No. ${plotNumber}`;
};

export default function BillingWorkspace() {
  const notify = useNotify();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [updating, setUpdating] = useState('');
  const [assigning, setAssigning] = useState('');
  const [paymentDetails, setPaymentDetails] = useState({});

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
  const waitingAssignments = useMemo(
    () => (Array.isArray(data?.waitingAssignments) ? data.waitingAssignments : []),
    [data?.waitingAssignments],
  );
  const summary = useMemo(() => ({
    total: assignments.length + waitingAssignments.length,
    waiting: waitingAssignments.length,
    active: assignments.filter((row) => row.status !== 'TRANSACTION_COMPLETED').length,
    completed: assignments.filter((row) => row.status === 'TRANSACTION_COMPLETED').length,
  }), [assignments, waitingAssignments]);
  const visibleAssignments = useMemo(
    () => assignments.filter((row) => row.status !== 'TRANSACTION_COMPLETED'),
    [assignments],
  );

  const advance = async (assignment) => {
    const current = BILLING_STEPS[stepIndex(assignment.status)];
    const next = BILLING_STEPS[stepIndex(assignment.status) + 1];
    if (!next) return;
    setUpdating(assignment.assignmentKey);
    setError('');
    try {
      const details = paymentDetails[assignment.assignmentKey] || {};
      const body = { status: next.key };
      if (next.key === 'PAYMENT_RECEIVED') {
        body.paymentMethod = details.paymentMethod;
        body.transactionRef = details.transactionRef;
        body.amount = Number(details.amount || assignment.balance || assignment.invoiceAmount || assignment.plot?.price);
      }
      const profileQuery = data?.isAdminOverview && assignment.assignedStaff?.profileId
        ? `?assignedProfileId=${encodeURIComponent(assignment.assignedStaff.profileId)}`
        : '';
      const result = await fetchApi(
        `/api/pickup-plot-inventory/billing/me/assignments/${encodeURIComponent(assignment.assignmentKey)}/status${profileQuery}`,
        { method: 'PATCH', body: JSON.stringify(body) },
      );
      setData((existing) => ({
        ...existing,
        assignments: existing.assignments.map((row) => (
          row.assignmentKey === assignment.assignmentKey
            ? {
              ...row,
              status: result.status,
              statusUpdatedAt: result.statusUpdatedAt,
              amountPaid: result.amountPaid ?? row.amountPaid,
              balance: result.balance ?? row.balance,
              paymentId: result.payment?.id ?? row.paymentId,
              transactionRef: result.payment?.transactionRef ?? row.transactionRef,
            }
            : row
        )),
      }));
      notify.success(`${assignment.customer?.name || 'Customer'}: ${result.status === 'PAYMENT_PENDING' ? 'Partial payment recorded' : next.label}.`);
    } catch (err) {
      setError(err?.message || `Could not ${current.action.toLowerCase()}.`);
    } finally {
      setUpdating('');
    }
  };

  const assignBillingStaff = async (assignment, targetProfileId) => {
    if (!data?.isAdminOverview || !targetProfileId) return;
    setAssigning(assignment.assignmentKey);
    setError('');
    try {
      const result = await fetchApi(
        `/api/pickup-plot-inventory/billing/me/assignments/${encodeURIComponent(assignment.assignmentKey)}/assign`,
        { method: 'PATCH', body: JSON.stringify({ targetProfileId: Number(targetProfileId) }) },
      );
      notify.success(`${assignment.customer?.name || 'Customer'} assigned to ${result.assignedStaff?.name || 'Billing staff'}.`);
      await load();
    } catch (err) {
      setError(err?.message || 'Could not assign Billing staff.');
    } finally {
      setAssigning('');
    }
  };

  return (
    <main className="transport-workspace" data-testid="billing-workspace">
      <section className="transport-summary" aria-label="Billing summary">
        <div><span className="transport-summary-icon active"><Receipt size={18} /></span><span><strong>{summary.active}</strong><small>Active billing</small></span></div>
        <div><span className="transport-summary-icon total"><Clock3 size={18} /></span><span><strong>{summary.waiting}</strong><small>Awaiting handoff</small></span></div>
        <div><span className="transport-summary-icon done"><CheckCircle2 size={18} /></span><span><strong>{summary.completed}</strong><small>Completed</small></span></div>
        <div><span className="transport-summary-icon total"><UserRound size={18} /></span><span><strong>{summary.total}</strong><small>Total assigned</small></span></div>
      </section>

      {waitingAssignments.length > 0 && (
        <>
          <div className="transport-toolbar">
            <strong>Awaiting Sales Executive handoff</strong>
            <span className="transport-trip-count">{waitingAssignments.length} customer{waitingAssignments.length === 1 ? '' : 's'}</span>
          </div>
          <section className="transport-trip-list" aria-label="Billing assignments awaiting handoff">
            {waitingAssignments.map((assignment) => (
              <BillingWaitingCard key={assignment.assignmentKey} assignment={assignment} readOnly={Boolean(data?.isAdminOverview)} />
            ))}
          </section>
        </>
      )}

      <div className="transport-toolbar">
        <strong>Active billing</strong>
        <span className="transport-trip-count">{visibleAssignments.length} customer{visibleAssignments.length === 1 ? '' : 's'}</span>
      </div>

      {error && <div className="transport-error" role="alert">{error}</div>}
      {loading && !data && <div className="transport-loading" role="status">Loading billing queue…</div>}
      {!loading && !error && visibleAssignments.length === 0 && waitingAssignments.length === 0 && (
        <section className="transport-empty">
          <span><FileCheck2 size={28} /></span>
          <h2>No customers waiting for billing</h2>
          <p>Customers appear after a Sales Executive marks a plot as selected.</p>
        </section>
      )}

      <section className="transport-trip-list" aria-label="Active billing assignments">
        {visibleAssignments.map((assignment) => (
          <BillingCard
            key={assignment.assignmentKey}
            assignment={assignment}
            updating={updating === assignment.assignmentKey}
            assigning={assigning === assignment.assignmentKey}
            adminOverview={Boolean(data?.isAdminOverview)}
            assignmentOptions={data?.assignmentOptions || []}
            paymentDetails={paymentDetails[assignment.assignmentKey] || {}}
            onPaymentDetailsChange={(details) => setPaymentDetails((current) => ({
              ...current, [assignment.assignmentKey]: { ...current[assignment.assignmentKey], ...details },
            }))}
            onAdvance={() => advance(assignment)}
            onAssign={(targetProfileId) => assignBillingStaff(assignment, targetProfileId)}
          />
        ))}
      </section>
    </main>
  );
}

function BillingWaitingCard({ assignment, readOnly }) {
  return (
    <article className="transport-trip-card">
      <header>
        <div>
          <span className="transport-next-badge">
            {readOnly ? `Assigned to ${assignment.assignedStaff?.name || 'staff'}` : 'Assigned to you'}
          </span>
          <h2>{assignment.customer?.name || 'Assigned customer'}</h2>
          <p>{assignment.customer?.company || assignment.customer?.email || 'Customer billing'}</p>
        </div>
        <span className="transport-status">Awaiting handoff</span>
      </header>

      <div className="transport-passenger" style={{ marginTop: 18 }}>
        <span><Receipt size={17} /></span>
        <div><small>Assigned plot</small><strong>{plotLabel(assignment.plot)}</strong></div>
      </div>

      <footer>
        {assignment.customer?.email && <a className="transport-map-button" href={`mailto:${assignment.customer.email}`}><Mail size={16} /> Email</a>}
        {assignment.customer?.phone && <a className="transport-map-button" href={`tel:${assignment.customer.phone}`}><Phone size={16} /> Call</a>}
        <span className="transport-complete-label"><Clock3 size={16} /> Billing actions unlock after plot selection</span>
      </footer>
    </article>
  );
}

function BillingCard({ assignment, updating, assigning, adminOverview, assignmentOptions, paymentDetails, onPaymentDetailsChange, onAdvance, onAssign }) {
  const [selectedAssigneeId, setSelectedAssigneeId] = useState('');
  const index = stepIndex(assignment.status);
  const current = BILLING_STEPS[index];
  const next = BILLING_STEPS[index + 1];
  const canUpdate = !assignment.awaitingAssignment;
  const price = assignment.plot?.price == null
    ? null
    : new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(Number(assignment.plot.price));
  return (
    <article className="transport-trip-card">
      <header>
        <div>
          <span className="transport-next-badge">From Sales Executive {assignment.broker?.name || 'team'}</span>
          {adminOverview && (
            <span className="transport-next-badge">
              {assignment.awaitingAssignment ? 'Awaiting Billing assignment' : `Assigned to ${assignment.assignedStaff?.name || 'staff'}`}
            </span>
          )}
          <h2>{assignment.customer?.name || 'Interested customer'}</h2>
          <p>{assignment.customer?.company || assignment.customer?.email || 'Customer billing'}</p>
        </div>
        <span className={`transport-status${assignment.status === 'TRANSACTION_COMPLETED' ? ' status-completed' : ''}`}>{current.label}</span>
      </header>

      <div className="transport-passenger" style={{ marginTop: 18 }}>
        <span><Receipt size={17} /></span>
        <div><small>Plot / invoice item</small><strong>{plotLabel(assignment.plot)}{price ? ` · ${price}` : ''}</strong></div>
      </div>

      <div className="transport-progress" aria-label={`Billing progress: ${current.label}`} style={{ gridTemplateColumns: `repeat(${BILLING_STEPS.length - 1}, 1fr)` }}>
        {BILLING_STEPS.slice(0, -1).map((step, stepNumber) => <span key={step.key} className={stepNumber < index ? 'done' : ''} />)}
      </div>

      {assignment.awaitingAssignment && adminOverview && (
        <div style={{ display: 'grid', gap: 8, marginTop: 14 }}>
          <label style={{ display: 'grid', gap: 5, fontSize: '.78rem', fontWeight: 700, color: 'var(--text-secondary)' }}>
            Assign Billing staff
            <select
              className="input-field"
              aria-label={`Assign Billing staff for ${assignment.customer?.name || 'customer'}`}
              value={selectedAssigneeId}
              onChange={(event) => setSelectedAssigneeId(event.target.value)}
            >
              <option value="">Choose Billing staff</option>
              {assignmentOptions.map((person) => <option key={person.profileId} value={person.profileId}>{person.name}</option>)}
            </select>
          </label>
          <button
            type="button"
            className="transport-primary-button"
            onClick={() => onAssign(selectedAssigneeId)}
            disabled={assigning || !selectedAssigneeId}
            style={{ width: '100%' }}
          >
            <UserRound size={16} /> {assigning ? 'Assigningâ€¦' : 'Assign Billing staff'}
          </button>
        </div>
      )}

      {assignment.status === 'PAYMENT_PENDING' && canUpdate && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 180px), 1fr))', gap: 10, marginTop: 14 }}>
          <label style={{ display: 'grid', gap: 5, fontSize: '.78rem', fontWeight: 700 }}>Amount paid
            <input className="input-field" type="number" min="0.01" step="0.01" max={assignment.balance || assignment.invoiceAmount || assignment.plot?.price} aria-label={`Amount paid for ${assignment.customer?.name || 'customer'}`} value={paymentDetails.amount ?? assignment.balance ?? assignment.invoiceAmount ?? assignment.plot?.price ?? ''} onChange={(event) => onPaymentDetailsChange({ amount: event.target.value })} />
          </label>
          <label style={{ display: 'grid', gap: 5, fontSize: '.78rem', fontWeight: 700 }}>Payment method
            <select className="input-field" aria-label={`Payment method for ${assignment.customer?.name || 'customer'}`} value={paymentDetails.paymentMethod || ''} onChange={(event) => onPaymentDetailsChange({ paymentMethod: event.target.value })}>
              <option value="">Select method</option><option value="cash">Cash</option><option value="upi">UPI</option><option value="bank_transfer">Bank transfer</option><option value="card">Card</option><option value="cheque">Cheque</option>
            </select>
          </label>
          <label style={{ display: 'grid', gap: 5, fontSize: '.78rem', fontWeight: 700 }}>Transaction reference
            <input className="input-field" aria-label={`Transaction reference for ${assignment.customer?.name || 'customer'}`} value={paymentDetails.transactionRef || ''} onChange={(event) => onPaymentDetailsChange({ transactionRef: event.target.value })} placeholder="UTR, receipt, or cheque number" />
          </label>
        </div>
      )}

      <footer>
        {assignment.customer?.email && <a className="transport-map-button" href={`mailto:${assignment.customer.email}`}><Mail size={16} /> Email</a>}
        {assignment.customer?.phone && <a className="transport-map-button" href={`tel:${assignment.customer.phone}`}><Phone size={16} /> Call</a>}
        {next && canUpdate ? (
          <button type="button" className="transport-primary-button" onClick={onAdvance} disabled={updating || (assignment.status === 'PAYMENT_PENDING' && (!paymentDetails.paymentMethod || !paymentDetails.transactionRef || Number(paymentDetails.amount ?? assignment.balance ?? assignment.invoiceAmount ?? assignment.plot?.price) <= 0))}>
            {updating ? 'Updating…' : current.action}<ArrowRight size={16} />
          </button>
        ) : next && !adminOverview ? (
          <span className="transport-complete-label"><UserRound size={16} /> Assign Billing staff to continue</span>
        ) : !next ? <span className="transport-complete-label"><CheckCircle2 size={16} /> Transaction completed</span> : null}
      </footer>
    </article>
  );
}
