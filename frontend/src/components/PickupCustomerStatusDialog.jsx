import { CheckCircle2, X } from 'lucide-react';
import {
  PICKUP_STAGE_LABELS,
  formatPickupStatus,
  formatPickupStatusDate,
} from '../utils/pickupCustomerStatus';

const WORKFLOW_STEPS = {
  transport: [
    'PICKUP_LOCATION_CAPTURED', 'ASSIGNED', 'ACCEPTED', 'HEADING_TO_PICKUP',
    'ARRIVED_AT_PICKUP', 'PICKED_UP', 'EN_ROUTE', 'ARRIVED_AT_DROP', 'COMPLETED',
  ],
  broker: [
    'AWAITING_BROKER_ASSIGNMENT', 'READY_TO_SCHEDULE', 'VISIT_SCHEDULED',
    'VISIT_CONFIRMED', 'REMINDER_SENT', 'ATTENDED', 'PLOT_SHOWN', 'PLOT_SELECTED',
  ],
  billing: [
    'PLOT_RESERVED', 'BILLING', 'INVOICE_CREATED', 'INVOICE_SENT', 'PAYMENT_PENDING',
    'PAYMENT_RECEIVED', 'PAYMENT_VERIFIED', 'BOOKING_CONFIRMED',
    'PLOT_SOLD', 'TRANSACTION_COMPLETED',
  ],
};

function workflowTimeline(row) {
  const historyByStep = new Map();
  for (const event of row.workflowHistory || []) {
    const step = event.toStatus || event.eventType;
    if (step) historyByStep.set(step, event);
  }
  const currentStage = row.currentStage || 'transport';
  const stages = ['transport', 'broker', 'billing'];
  return stages.flatMap((stage) => {
    const detail = row.workflow?.[stage] || {};
    const stageIndex = stages.indexOf(stage);
    const currentStageIndex = stages.indexOf(currentStage);
    const currentStatus = detail.status || (stage === 'transport' ? row.status : 'PENDING');
    const steps = stage === 'broker' && ['NO_SHOW', 'VISIT_RESCHEDULED'].includes(currentStatus)
      ? [...WORKFLOW_STEPS.broker.slice(0, 5), 'NO_SHOW', 'VISIT_RESCHEDULED', ...WORKFLOW_STEPS.broker.slice(5)]
      : stage === 'broker' && currentStatus === 'CLOSED_NO_INTEREST'
        ? [...WORKFLOW_STEPS.broker.slice(0, 2), 'CLOSED_NO_INTEREST']
        : WORKFLOW_STEPS[stage];
    const currentIndex = steps.indexOf(currentStatus);

    return steps.map((step, index) => {
      let state = 'upcoming';
      if (stageIndex < currentStageIndex) state = 'complete';
      if (stageIndex === currentStageIndex && currentIndex >= 0) {
        if (index < currentIndex) state = 'complete';
        if (index === currentIndex) {
          state = ['COMPLETED', 'TRANSACTION_COMPLETED'].includes(currentStatus) ? 'complete' : 'current';
        }
      }
      const history = historyByStep.get(step);
      return {
        stage,
        step,
        state,
        eventLabel: history?.label,
        assignee: index === 0 ? detail.assignee : null,
        updatedAt: history?.occurredAt || (index === currentIndex ? detail.updatedAt : null),
      };
    });
  });
}

function StatusDetail({ label, value }) {
  return <div style={{ minWidth: 0 }}>
    <div style={{ color: 'var(--text-secondary)', fontSize: '.7rem', fontWeight: 700 }}>{label}</div>
    <div style={{ marginTop: 3, fontSize: '.82rem', fontWeight: 700, overflowWrap: 'anywhere' }}>{value || 'Not available'}</div>
  </div>;
}

export default function PickupCustomerStatusDialog({ customer, onClose }) {
  if (!customer) return null;
  return (
    <div role="presentation" style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(15,23,42,.48)', display: 'grid', placeItems: 'center', padding: 16 }}>
      <section role="dialog" aria-modal="true" aria-labelledby="lead-status-history-title" className="card" style={{ width: 'min(780px, 100%)', maxHeight: '86vh', display: 'flex', flexDirection: 'column', padding: '1.25rem', opacity: 1, background: 'var(--popover-bg, #fff)', backdropFilter: 'none' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div><h2 id="lead-status-history-title" style={{ margin: 0, fontSize: '1.2rem' }}>All customer statuses</h2><div style={{ marginTop: 4, color: 'var(--text-secondary)' }}>{customer.contact?.name || 'Customer'}</div></div>
          <button type="button" className="btn-secondary" aria-label="Close customer statuses" onClick={onClose} style={{ padding: '.4rem' }}><X size={17} /></button>
        </div>
        <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', marginTop: 16, paddingRight: 8 }}>
          <div data-testid="customer-status-details" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 160px), 1fr))', gap: 12, padding: '.85rem', border: '1px solid var(--border-color)', borderRadius: 10, background: 'var(--subtle-bg, rgba(148,163,184,.08))' }}>
            <StatusDetail label="Phone" value={customer.contact?.phone} />
            <StatusDetail label="Email" value={customer.contact?.email} />
            <StatusDetail label="Company" value={customer.contact?.company} />
            <StatusDetail label="CRM status" value={customer.contact?.status} />
            <StatusDetail label="Interested plot area" value={customer.contact?.interestedPlotArea} />
            <StatusDetail label="Pickup location" value={customer.pickupAddress} />
            <StatusDetail label="Assigned plot" value={customer.assignedPlot?.name} />
            <StatusDetail label="Plot address" value={customer.assignedPlot?.address} />
            <StatusDetail label="Transport person" value={customer.workflow?.transport?.assignee?.name || customer.transportPerson?.name} />
            <StatusDetail label="Pickup time" value={formatPickupStatusDate(customer.workflow?.transport?.pickupAt || customer.workflow?.transport?.scheduledPickupAt || customer.pickupAt || customer.scheduledPickupAt)} />
            <StatusDetail label="Site visit / drop-off time" value={formatPickupStatusDate(customer.workflow?.transport?.dropOffAt || customer.workflow?.transport?.scheduledDropOffAt || customer.dropOffAt || customer.scheduledDropOffAt)} />
            <StatusDetail label="Sales Executive" value={customer.workflow?.broker?.assignee?.name} />
            <StatusDetail label="Overall status" value={`${PICKUP_STAGE_LABELS[customer.currentStage] || 'Transport'}: ${formatPickupStatus(customer.currentStatus || customer.status)}`} />
            <StatusDetail label="Last updated" value={formatPickupStatusDate(customer.currentStatusUpdatedAt || customer.statusUpdatedAt)} />
          </div>
          <h3 style={{ margin: '18px 0 12px', fontSize: '1rem' }}>Workflow progress</h3>
          <div data-testid="workflow-timeline" style={{ padding: '2px 0 4px 2px' }}>
            {workflowTimeline(customer).map((item, index, timeline) => {
              const firstInStage = index === 0 || timeline[index - 1].stage !== item.stage;
              const isLast = index === timeline.length - 1;
              const activeColor = 'var(--primary-color, var(--accent-color))';
              return (
                <div key={`${item.stage}-${item.step}`} style={{ display: 'grid', gridTemplateColumns: '88px 28px minmax(0, 1fr)', minHeight: 58 }}>
                  <div style={{ paddingTop: 3, color: 'var(--text-primary)', fontSize: '.78rem', fontWeight: 800 }}>{firstInStage ? (PICKUP_STAGE_LABELS[item.stage] || item.stage.replaceAll('_', ' ')) : ''}</div>
                  <div aria-hidden="true" style={{ position: 'relative', display: 'flex', justifyContent: 'center' }}>
                    {!isLast && <span data-testid="workflow-connector" style={{ position: 'absolute', top: 18, bottom: -18, width: 2, background: item.state === 'complete' ? activeColor : 'var(--border-color)', zIndex: 0 }} />}
                    <span style={{ position: 'relative', zIndex: 1, width: 18, height: 18, boxSizing: 'border-box', borderRadius: '50%', display: 'grid', placeItems: 'center', color: item.state === 'upcoming' ? 'var(--text-secondary)' : '#fff', background: item.state === 'upcoming' ? 'var(--popover-bg, #fff)' : activeColor, border: `2px solid ${item.state === 'upcoming' ? 'var(--border-color)' : activeColor}`, boxShadow: item.state === 'current' ? `0 0 0 4px color-mix(in srgb, ${activeColor} 18%, transparent)` : 'none' }}>
                      {item.state === 'complete' && <CheckCircle2 size={12} />}
                    </span>
                  </div>
                  <div style={{ padding: '1px 0 15px 8px', minWidth: 0 }}>
                    <strong style={{ color: item.state === 'upcoming' ? 'var(--text-secondary)' : 'var(--text-primary)' }}>{formatPickupStatus(item.step)}</strong>
                    {item.state === 'current' && <span style={{ display: 'inline-flex', marginLeft: 8, padding: '.15rem .4rem', borderRadius: 999, color: activeColor, background: 'rgba(79,70,229,.1)', fontSize: '.66rem', fontWeight: 800 }}>Current</span>}
                    {item.eventLabel && item.eventLabel !== formatPickupStatus(item.step) && <div style={{ marginTop: 3, color: 'var(--text-secondary)', fontSize: '.75rem' }}>{item.eventLabel}</div>}
                    {item.assignee?.name && <div style={{ marginTop: 3, color: 'var(--text-secondary)', fontSize: '.75rem' }}>Assigned to {item.assignee.name}</div>}
                    {item.updatedAt && <div style={{ marginTop: 3, color: 'var(--text-secondary)', fontSize: '.72rem' }}>{formatPickupStatusDate(item.updatedAt)}</div>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>
    </div>
  );
}
