import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Eye, MapPin, Pencil, RefreshCw, Search, X } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import ResizableTableHeader from '../components/ResizableTableHeader';
import useResizableColumnWidths from '../utils/useResizableColumnWidths';

const CUSTOMER_TABLE_COLUMNS = [
  { label: 'S.No.', width: 80, minWidth: 70 },
  { label: 'Customer', width: 170, minWidth: 110 },
  { label: 'Contact', width: 190, minWidth: 130 },
  { label: 'Interested plot area', width: 190, minWidth: 145 },
  { label: 'Pickup location', width: 270, minWidth: 180 },
  { label: 'Trip status', width: 180, minWidth: 130 },
  { label: 'Transport person', width: 170, minWidth: 130 },
  { label: 'Overall status', width: 230, minWidth: 160 },
  { label: 'Actions', width: 190, minWidth: 150 },
];
const customerHeaderStyle = { position: 'sticky', top: 0, zIndex: 2, padding: '.55rem .65rem', borderRight: '1px solid var(--border-color)', borderBottom: '1px solid var(--border-color)', boxShadow: '0 1px 0 var(--border-color)', textAlign: 'left', fontSize: '.74rem', color: 'var(--text-secondary)', overflowWrap: 'anywhere', background: '#f3f4f6' };

const STATUS_LABELS = {
  PICKUP_LOCATION_CAPTURED: 'Awaiting transport assignment',
  ASSIGNED: 'Transport assigned',
  ACCEPTED: 'Trip accepted',
  HEADING_TO_PICKUP: 'Heading to pickup',
  ARRIVED_AT_PICKUP: 'Arrived at pickup',
  PICKED_UP: 'Customer picked up',
  EN_ROUTE: 'En route to plot',
  ARRIVED_AT_DROP: 'Arrived at plot',
  COMPLETED: 'Trip completed',
  PENDING: 'Not started',
  AWAITING_BROKER_ASSIGNMENT: 'Awaiting Sales Executive assignment',
  READY_TO_SCHEDULE: 'Ready to schedule site visit',
  VISIT_SCHEDULED: 'Site visit scheduled',
  VISIT_CONFIRMED: 'Site visit confirmed',
  REMINDER_SENT: 'Site visit reminder sent',
  ATTENDED: 'Customer attended',
  NO_SHOW: 'No-show',
  VISIT_RESCHEDULED: 'Site visit rescheduled',
  PLOT_SHOWN: 'Plot shown',
  PLOT_SELECTED: 'Plot selected',
  CLOSED_NO_INTEREST: 'Closed (not interested)',
  PLOT_RESERVED: 'Plot reserved',
  BILLING: 'Billing',
  INVOICE_CREATED: 'Invoice created',
  INVOICE_SENT: 'Invoice sent',
  PAYMENT_PENDING: 'Payment pending',
  PAYMENT_RECEIVED: 'Payment received',
  PAYMENT_VERIFIED: 'Payment verified',
  BOOKING_CONFIRMED: 'Booking confirmed',
  PLOT_SOLD: 'Plot sold',
  TRANSACTION_COMPLETED: 'Transaction completed',
};

const STAGE_LABELS = { pickup: 'Pickup', transport: 'Transport', broker: 'Sales Executive', billing: 'Billing', payment: 'Payment', plot: 'Plot' };

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

const formatStatus = (status) => STATUS_LABELS[status] || String(status || 'PENDING').replaceAll('_', ' ').toLowerCase();
const formatDate = (value) => value ? new Date(value).toLocaleString() : 'No update yet';

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
        if (index === currentIndex) state = ['COMPLETED', 'TRANSACTION_COMPLETED'].includes(currentStatus) ? 'complete' : 'current';
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

const statusColor = (status) => status === 'COMPLETED'
  ? { color: '#047857', background: 'rgba(16,185,129,.14)' }
  : status === 'PICKUP_LOCATION_CAPTURED'
    ? { color: '#a16207', background: 'rgba(245,158,11,.14)' }
    : { color: 'var(--primary-color, var(--accent-color))', background: 'rgba(79,70,229,.12)' };

function PickupLocationLink({ address, customerName }) {
  const pickupAddress = address?.trim();
  if (!pickupAddress) return <span style={{ color: 'var(--text-secondary)' }}>No pickup location</span>;

  return (
    <a
      href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(pickupAddress)}`}
      target="_blank"
      rel="noreferrer"
      aria-label={`Open pickup location for ${customerName || 'customer'} in Google Maps`}
      title="Open pickup location in Google Maps"
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 7, lineHeight: 1.4,
        color: 'inherit', textDecoration: 'none', borderRadius: 6,
      }}
    >
      <MapPin size={16} aria-hidden="true" style={{ marginTop: 2, flex: '0 0 auto', color: 'var(--primary-color, var(--accent-color))' }} />
      <strong style={{ overflowWrap: 'anywhere' }}>{pickupAddress}</strong>
    </a>
  );
}

function StatusDetail({ label, value }) {
  return <div style={{ minWidth: 0 }}>
    <div style={{ color: 'var(--text-secondary)', fontSize: '.7rem', fontWeight: 700 }}>{label}</div>
    <div style={{ marginTop: 3, fontSize: '.82rem', fontWeight: 700, overflowWrap: 'anywhere' }}>{value || 'Not available'}</div>
  </div>;
}

export default function PickupCustomers() {
  const notify = useNotify();
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [editingCustomer, setEditingCustomer] = useState(null);
  const [viewingCustomer, setViewingCustomer] = useState(null);
  const [editAddress, setEditAddress] = useState('');
  const [saving, setSaving] = useState(false);
  const { columnWidths, resizeColumn, tableMinWidth } = useResizableColumnWidths(
    CUSTOMER_TABLE_COLUMNS,
    'pickup-plot-customer-status-column-widths',
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetchApi('/api/pickup-plot-inventory/customer-pickups');
      setCustomers(Array.isArray(response?.customers) ? response.customers : []);
    } catch (error) {
      notify.error(error.message || 'Could not load customer pickup status.');
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => { load(); }, [load]);

  const openEdit = (row) => {
    setEditingCustomer(row);
    setEditAddress(row.pickupAddress || '');
  };

  const savePickupLocation = async (event) => {
    event.preventDefault();
    setSaving(true);
    try {
      await fetchApi(`/api/pickup-plot-inventory/customer-pickups/${editingCustomer.contact.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          pickupAddress: editAddress,
          sourceTranscriptId: editingCustomer.sourceTranscriptId || null,
          sourceExcerpt: editingCustomer.sourceExcerpt || null,
        }),
      });
      notify.success('Pickup location updated.');
      setEditingCustomer(null);
      await load();
    } catch (error) {
      notify.error(error.message || 'Could not update the pickup location.');
    } finally {
      setSaving(false);
    }
  };

  const visibleCustomers = useMemo(() => customers.filter((row) => {
    if (status === 'waiting' && row.status !== 'PICKUP_LOCATION_CAPTURED') return false;
    if (status === 'active' && ['PICKUP_LOCATION_CAPTURED', 'COMPLETED'].includes(row.status)) return false;
    if (status === 'completed' && row.status !== 'COMPLETED') return false;
    const needle = search.trim().toLowerCase();
    return !needle || [row.contact?.name, row.contact?.phone, row.contact?.email, row.contact?.company, row.pickupAddress, row.contact?.interestedPlotArea, row.transportPerson?.name]
      .some((value) => String(value || '').toLowerCase().includes(needle));
  }), [customers, search, status]);

  return (
    <div data-testid="pickup-customers-page" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflow: 'hidden', boxSizing: 'border-box', padding: '2rem' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 16, marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}><MapPin size={28} /> Customer Status</h1>
          <p style={{ color: 'var(--text-secondary)', margin: '.4rem 0 0' }}>Pickup locations confirmed from Callified transcripts and their live transport status.</p>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, flex: '1 1 620px', justifyContent: 'flex-end', maxWidth: 760 }}>
          <label style={{ position: 'relative', flex: '1 1 260px', minWidth: 220 }}><Search size={15} aria-hidden="true" style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)', pointerEvents: 'none' }} /><input className="input-field" type="search" aria-label="Search customer status" placeholder="Search customers or locations..." value={search} onChange={(event) => setSearch(event.target.value)} style={{ width: '100%', height: 44, boxSizing: 'border-box', paddingLeft: 34 }} /></label>
          <select className="input-field" aria-label="Filter customer trip status" value={status} onChange={(event) => setStatus(event.target.value)} style={{ flex: '0 0 190px', height: 44, boxSizing: 'border-box' }}><option value="all">All statuses</option><option value="waiting">Awaiting assignment</option><option value="active">Active trips</option><option value="completed">Completed</option></select>
          <button type="button" className="btn-secondary" onClick={load} style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, whiteSpace: 'nowrap' }}><RefreshCw size={15} /> Refresh</button>
        </div>
      </header>

      {loading ? <div className="card" style={{ padding: '3rem', textAlign: 'center' }}>Loading customer statusâ€¦</div> : (
        <div
          className="card pickup-plot-table-scroll"
          data-testid="pickup-customers-table-scroll"
          style={{
            flex: '1 1 0', minHeight: 0, width: '100%', maxWidth: '100%',
            overflowX: 'auto', overflowY: 'auto', padding: 0, boxSizing: 'border-box',
            scrollbarGutter: 'stable', overscrollBehavior: 'contain',
          }}
        >
          <div data-testid="pickup-customers-table-width" style={{ width: tableMinWidth, minWidth: '100%' }}>
          <table className="pickup-plot-resizable-table" aria-label="Customer pickup status" style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse' }}>
            <colgroup>{columnWidths.map((width, index) => <col key={CUSTOMER_TABLE_COLUMNS[index].label} style={{ width }} />)}</colgroup>
            <thead><tr>{CUSTOMER_TABLE_COLUMNS.map((column, index) => <ResizableTableHeader key={column.label} label={column.label} width={columnWidths[index]} minWidth={column.minWidth} onResize={(width) => resizeColumn(index, width)} style={customerHeaderStyle}>{column.label}</ResizableTableHeader>)}</tr></thead>
            <tbody>
              {visibleCustomers.map((row, index) => {
                const badge = statusColor(row.status);
                return <tr key={row.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                  <td style={{ padding: '.55rem .65rem' }}>{index + 1}</td>
                  <td style={{ padding: '.55rem .65rem', fontWeight: 800, overflowWrap: 'anywhere' }}>{row.contact?.name || 'Customer'}</td>
                  <td style={{ padding: '.55rem .65rem', color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}>{row.contact?.company || row.contact?.phone || row.contact?.email || 'No contact details'}</td>
                  <td style={{ padding: '.55rem .65rem', overflowWrap: 'anywhere' }}>{row.contact?.interestedPlotArea || <span style={{ color: 'var(--text-secondary)' }}>Not captured</span>}</td>
                  <td style={{ padding: '.55rem .65rem', overflowWrap: 'anywhere' }}><PickupLocationLink address={row.pickupAddress} customerName={row.contact?.name} /></td>
                  <td style={{ padding: '.55rem .65rem' }}><span style={{ ...badge, display: 'inline-flex', padding: '.22rem .45rem', borderRadius: 999, fontSize: '.7rem', fontWeight: 800 }}>{STATUS_LABELS[row.status] || row.status}</span></td>
                  <td style={{ padding: '.55rem .65rem', overflowWrap: 'anywhere' }}>{row.transportPerson?.name || 'Not assigned'}</td>
                  <td style={{ padding: '.55rem .65rem', overflowWrap: 'anywhere' }}>
                    <strong>{STAGE_LABELS[row.currentStage] || 'Transport'}: {formatStatus(row.currentStatus || row.status)}</strong>
                    <div style={{ marginTop: 3, color: 'var(--text-secondary)', fontSize: '.72rem' }}>{formatDate(row.currentStatusUpdatedAt || row.statusUpdatedAt)}</div>
                  </td>
                  <td style={{ padding: '.55rem .65rem' }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end' }}>
                      <button type="button" className="btn-secondary" aria-label={`Edit ${row.contact?.name || 'customer'} pickup location`} onClick={() => openEdit(row)} style={{ padding: '.38rem .55rem', fontSize: '.72rem' }}><Pencil size={13} /> Edit</button>
                      <button type="button" className="btn-secondary" aria-label={`View all status for ${row.contact?.name || 'customer'}`} onClick={() => setViewingCustomer(row)} style={{ padding: '.38rem .55rem', fontSize: '.72rem' }}><Eye size={13} /> View status</button>
                    </div>
                  </td>
                </tr>;
              })}
              {visibleCustomers.length === 0 && <tr><td colSpan="9" style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>No customer pickup records found. Save an address from a Callified transcript to add one.</td></tr>}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {editingCustomer && (
        <div role="presentation" style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(15,23,42,.48)', display: 'grid', placeItems: 'center', padding: 16 }}>
          <form role="dialog" aria-modal="true" aria-labelledby="edit-pickup-title" className="card" onSubmit={savePickupLocation} style={{ width: 'min(520px, 100%)', padding: '1.25rem', opacity: 1, background: 'var(--popover-bg, #fff)', backdropFilter: 'none' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <h2 id="edit-pickup-title" style={{ margin: 0, fontSize: '1.2rem' }}>Edit pickup location</h2>
              <button type="button" className="btn-secondary" aria-label="Close edit pickup location" onClick={() => setEditingCustomer(null)} style={{ padding: '.4rem' }}><X size={17} /></button>
            </div>
            <p style={{ color: 'var(--text-secondary)' }}>{editingCustomer.contact?.name || 'Customer'}</p>
            <label style={{ display: 'grid', gap: 6, fontWeight: 700 }}>Pickup location
              <textarea className="input-field" aria-label="Pickup location" required minLength={5} value={editAddress} onChange={(event) => setEditAddress(event.target.value)} rows={4} style={{ resize: 'vertical' }} />
            </label>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <button type="button" className="btn-secondary" onClick={() => setEditingCustomer(null)}>Cancel</button>
              <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</button>
            </div>
          </form>
        </div>
      )}

      {viewingCustomer && (
        <div role="presentation" style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(15,23,42,.48)', display: 'grid', placeItems: 'center', padding: 16 }}>
          <section role="dialog" aria-modal="true" aria-labelledby="status-history-title" className="card" style={{ width: 'min(780px, 100%)', maxHeight: '86vh', display: 'flex', flexDirection: 'column', padding: '1.25rem', opacity: 1, background: 'var(--popover-bg, #fff)', backdropFilter: 'none' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div><h2 id="status-history-title" style={{ margin: 0, fontSize: '1.2rem' }}>All customer statuses</h2><div style={{ marginTop: 4, color: 'var(--text-secondary)' }}>{viewingCustomer.contact?.name || 'Customer'}</div></div>
              <button type="button" className="btn-secondary" aria-label="Close customer statuses" onClick={() => setViewingCustomer(null)} style={{ padding: '.4rem' }}><X size={17} /></button>
            </div>
            <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', marginTop: 16, paddingRight: 8 }}>
              <div data-testid="customer-status-details" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 160px), 1fr))', gap: 12, padding: '.85rem', border: '1px solid var(--border-color)', borderRadius: 10, background: 'var(--subtle-bg, rgba(148,163,184,.08))' }}>
                <StatusDetail label="Phone" value={viewingCustomer.contact?.phone} />
                <StatusDetail label="Email" value={viewingCustomer.contact?.email} />
                <StatusDetail label="Company" value={viewingCustomer.contact?.company} />
                <StatusDetail label="CRM status" value={viewingCustomer.contact?.status} />
                <StatusDetail label="Interested plot area" value={viewingCustomer.contact?.interestedPlotArea} />
                <StatusDetail label="Pickup location" value={viewingCustomer.pickupAddress} />
                <StatusDetail label="Assigned plot" value={viewingCustomer.assignedPlot?.name} />
                <StatusDetail label="Plot address" value={viewingCustomer.assignedPlot?.address} />
                <StatusDetail label="Transport person" value={viewingCustomer.workflow?.transport?.assignee?.name || viewingCustomer.transportPerson?.name} />
                <StatusDetail label="Sales Executive" value={viewingCustomer.workflow?.broker?.assignee?.name} />
                <StatusDetail label="Overall status" value={`${STAGE_LABELS[viewingCustomer.currentStage] || 'Transport'}: ${formatStatus(viewingCustomer.currentStatus || viewingCustomer.status)}`} />
                <StatusDetail label="Last updated" value={formatDate(viewingCustomer.currentStatusUpdatedAt || viewingCustomer.statusUpdatedAt)} />
              </div>
              <h3 style={{ margin: '18px 0 12px', fontSize: '1rem' }}>Workflow progress</h3>
              <div data-testid="workflow-timeline" style={{ padding: '2px 0 4px 2px' }}>
              {workflowTimeline(viewingCustomer).map((item, index, timeline) => {
                const firstInStage = index === 0 || timeline[index - 1].stage !== item.stage;
                const isLast = index === timeline.length - 1;
                const activeColor = 'var(--primary-color, var(--accent-color))';
                return (
                  <div key={item.id || `${item.stage}-${item.step}`} style={{ display: 'grid', gridTemplateColumns: '88px 28px minmax(0, 1fr)', minHeight: 58 }}>
                    <div style={{ paddingTop: 3, color: 'var(--text-primary)', fontSize: '.78rem', fontWeight: 800 }}>{firstInStage ? (STAGE_LABELS[item.stage] || item.stage.replaceAll('_', ' ')) : ''}</div>
                    <div aria-hidden="true" style={{ position: 'relative', display: 'flex', justifyContent: 'center' }}>
                      {!isLast && <span data-testid="workflow-connector" style={{ position: 'absolute', top: 18, bottom: -18, width: 2, background: item.state === 'complete' ? activeColor : 'var(--border-color)', zIndex: 0 }} />}
                      <span style={{ position: 'relative', zIndex: 1, width: 18, height: 18, boxSizing: 'border-box', borderRadius: '50%', display: 'grid', placeItems: 'center', color: item.state === 'upcoming' ? 'var(--text-secondary)' : '#fff', background: item.state === 'upcoming' ? 'var(--popover-bg, #fff)' : activeColor, border: `2px solid ${item.state === 'upcoming' ? 'var(--border-color)' : activeColor}`, boxShadow: item.state === 'current' ? `0 0 0 4px color-mix(in srgb, ${activeColor} 18%, transparent)` : 'none' }}>
                        {item.state === 'complete' && <CheckCircle2 size={12} />}
                      </span>
                    </div>
                    <div style={{ padding: '1px 0 15px 8px', minWidth: 0 }}>
                      <strong style={{ color: item.state === 'upcoming' ? 'var(--text-secondary)' : 'var(--text-primary)' }}>{formatStatus(item.step)}</strong>
                      {item.state === 'current' && <span style={{ display: 'inline-flex', marginLeft: 8, padding: '.15rem .4rem', borderRadius: 999, color: activeColor, background: 'rgba(79,70,229,.1)', fontSize: '.66rem', fontWeight: 800 }}>Current</span>}
                      {item.eventLabel && item.eventLabel !== formatStatus(item.step) && <div style={{ marginTop: 3, color: 'var(--text-secondary)', fontSize: '.75rem' }}>{item.eventLabel}</div>}
                      {item.assignee?.name && <div style={{ marginTop: 3, color: 'var(--text-secondary)', fontSize: '.75rem' }}>Assigned to {item.assignee.name}</div>}
                      {item.updatedAt && <div style={{ marginTop: 3, color: 'var(--text-secondary)', fontSize: '.72rem' }}>{formatDate(item.updatedAt)}</div>}
                    </div>
                  </div>
                );
              })}
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
