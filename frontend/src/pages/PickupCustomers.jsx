import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Clock3, Eye, MapPin, Pencil, RefreshCw, Search, Truck, Users, X } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';

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
  AWAITING_BROKER_ASSIGNMENT: 'Awaiting broker assignment',
  READY_TO_EXPLAIN: 'Ready for plot explanation',
  EXPLANATION_STARTED: 'Plot explanation started',
  EXPLANATION_COMPLETED: 'Plot explanation completed',
  INTEREST_CONFIRMED: 'Interest confirmed',
  NOT_INTERESTED: 'Not interested',
  READY_FOR_BILLING: 'Ready for billing',
  DETAILS_VERIFIED: 'Billing details verified',
  INVOICE_PREPARED: 'Invoice prepared',
  INVOICE_SENT: 'Invoice sent',
  PAYMENT_RECEIVED: 'Payment received',
  BILLING_COMPLETED: 'Billing completed',
};

const STAGE_LABELS = { transport: 'Transport', broker: 'Broker', billing: 'Billing' };

const WORKFLOW_STEPS = {
  transport: [
    'PICKUP_LOCATION_CAPTURED', 'ASSIGNED', 'ACCEPTED', 'HEADING_TO_PICKUP',
    'ARRIVED_AT_PICKUP', 'PICKED_UP', 'EN_ROUTE', 'ARRIVED_AT_DROP', 'COMPLETED',
  ],
  broker: [
    'AWAITING_BROKER_ASSIGNMENT', 'READY_TO_EXPLAIN', 'EXPLANATION_STARTED',
    'EXPLANATION_COMPLETED', 'INTEREST_CONFIRMED',
  ],
  billing: [
    'READY_FOR_BILLING', 'DETAILS_VERIFIED', 'INVOICE_PREPARED',
    'INVOICE_SENT', 'PAYMENT_RECEIVED', 'BILLING_COMPLETED',
  ],
};

const formatStatus = (status) => STATUS_LABELS[status] || String(status || 'PENDING').replaceAll('_', ' ').toLowerCase();
const formatDate = (value) => value ? new Date(value).toLocaleString() : 'No update yet';

function workflowTimeline(row) {
  const currentStage = row.currentStage || 'transport';
  const stages = ['transport', 'broker', 'billing'];
  return stages.flatMap((stage) => {
    const detail = row.workflow?.[stage] || {};
    const stageIndex = stages.indexOf(stage);
    const currentStageIndex = stages.indexOf(currentStage);
    const currentStatus = detail.status || (stage === 'transport' ? row.status : 'PENDING');
    const steps = stage === 'broker' && currentStatus === 'NOT_INTERESTED'
      ? [...WORKFLOW_STEPS.broker.slice(0, -1), 'NOT_INTERESTED']
      : WORKFLOW_STEPS[stage];
    const currentIndex = steps.indexOf(currentStatus);

    return steps.map((step, index) => {
      let state = 'upcoming';
      if (stageIndex < currentStageIndex) state = 'complete';
      if (stageIndex === currentStageIndex && currentIndex >= 0) {
        if (index < currentIndex) state = 'complete';
        if (index === currentIndex) state = ['COMPLETED', 'BILLING_COMPLETED'].includes(currentStatus) ? 'complete' : 'current';
      }
      return {
        stage,
        step,
        state,
        assignee: index === 0 ? detail.assignee : null,
        updatedAt: index === currentIndex ? detail.updatedAt : null,
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

export default function PickupCustomers() {
  const notify = useNotify();
  const [customers, setCustomers] = useState([]);
  const [summary, setSummary] = useState({});
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [editingCustomer, setEditingCustomer] = useState(null);
  const [viewingCustomer, setViewingCustomer] = useState(null);
  const [editAddress, setEditAddress] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetchApi('/api/pickup-plot-inventory/customer-pickups');
      setCustomers(Array.isArray(response?.customers) ? response.customers : []);
      setSummary(response?.summary || {});
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
    return !needle || [row.contact?.name, row.contact?.phone, row.contact?.email, row.contact?.company, row.pickupAddress, row.transportPerson?.name]
      .some((value) => String(value || '').toLowerCase().includes(needle));
  }), [customers, search, status]);

  return (
    <div data-testid="pickup-customers-page" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflow: 'hidden', boxSizing: 'border-box', padding: '2rem' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 16, marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}><MapPin size={28} /> Customer Status</h1>
          <p style={{ color: 'var(--text-secondary)', margin: '.4rem 0 0' }}>Pickup locations confirmed from Callified transcripts and their live transport status.</p>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 1fr) 190px auto', gap: 8, flex: '1 1 560px', justifyContent: 'flex-end', maxWidth: 720, alignItems: 'center' }}>
          <label style={{ position: 'relative', flex: '1 1 220px' }}><Search size={15} style={{ position: 'absolute', left: 11, top: 11, color: 'var(--text-secondary)' }} /><input className="input-field" aria-label="Search customer status" placeholder="Search customers or locations..." value={search} onChange={(event) => setSearch(event.target.value)} style={{ width: '100%', boxSizing: 'border-box', paddingLeft: 34 }} /></label>
          <select className="input-field" aria-label="Filter customer trip status" value={status} onChange={(event) => setStatus(event.target.value)} style={{ width: '100%', boxSizing: 'border-box' }}><option value="all">All statuses</option><option value="waiting">Awaiting assignment</option><option value="active">Active trips</option><option value="completed">Completed</option></select>
          <button type="button" className="btn-secondary" onClick={load} style={{ whiteSpace: 'nowrap' }}><RefreshCw size={15} /> Refresh</button>
        </div>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,180px),1fr))', gap: 12, marginBottom: '1.25rem' }}>
        {[
          ['Customers', summary.total || 0, Users],
          ['Awaiting assignment', summary.awaitingAssignment || 0, Clock3],
          ['Active trips', summary.activeTrips || 0, Truck],
          ['Completed', summary.completed || 0, CheckCircle2],
        ].map(([label, value, Icon]) => <div key={label} className="card" style={{ padding: '1rem' }}><Icon size={18} /><div style={{ color: 'var(--text-secondary)', fontSize: '.76rem', fontWeight: 700, marginTop: 7 }}>{label}</div><div style={{ fontSize: '1.65rem', fontWeight: 800 }}>{value}</div></div>)}
      </div>

      {loading ? <div className="card" style={{ padding: '3rem', textAlign: 'center' }}>Loading customer statusâ€¦</div> : (
        <div
          className="card"
          data-testid="pickup-customers-table-scroll"
          style={{
            flex: '1 1 0', minHeight: 0, width: '100%', maxWidth: '100%',
            overflowX: 'hidden', overflowY: 'auto', padding: 0, boxSizing: 'border-box',
            scrollbarGutter: 'stable', overscrollBehavior: 'contain',
          }}
        >
          <table aria-label="Customer pickup status" style={{ width: '100%', minWidth: 0, tableLayout: 'fixed', borderCollapse: 'collapse' }}>
            <thead><tr>{['Customer', 'Contact', 'Pickup location', 'Trip status', 'Transport person', 'Overall status', 'Actions'].map((label) => <th key={label} scope="col" style={{ position: 'sticky', top: 0, zIndex: 2, padding: '.55rem .65rem', borderBottom: '1px solid var(--border-color)', boxShadow: '0 1px 0 var(--border-color)', textAlign: 'left', fontSize: '.74rem', color: 'var(--text-secondary)', overflowWrap: 'anywhere', background: 'linear-gradient(var(--table-header-bg, rgba(148,163,184,.08)), var(--table-header-bg, rgba(148,163,184,.08))), var(--popover-bg, #fff)' }}>{label}</th>)}</tr></thead>
            <tbody>
              {visibleCustomers.map((row) => {
                const badge = statusColor(row.status);
                return <tr key={row.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                  <td style={{ padding: '.55rem .65rem', fontWeight: 800, overflowWrap: 'anywhere' }}>{row.contact?.name || 'Customer'}</td>
                  <td style={{ padding: '.55rem .65rem', color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}>{row.contact?.company || row.contact?.phone || row.contact?.email || 'No contact details'}</td>
                  <td style={{ padding: '.55rem .65rem', overflowWrap: 'anywhere' }}><PickupLocationLink address={row.pickupAddress} customerName={row.contact?.name} /></td>
                  <td style={{ padding: '.55rem .65rem' }}><span style={{ ...badge, display: 'inline-flex', padding: '.22rem .45rem', borderRadius: 999, fontSize: '.7rem', fontWeight: 800 }}>{STATUS_LABELS[row.status] || row.status}</span></td>
                  <td style={{ padding: '.55rem .65rem', overflowWrap: 'anywhere' }}>{row.transportPerson?.name || 'Not assigned'}</td>
                  <td style={{ padding: '.55rem .65rem', overflowWrap: 'anywhere' }}>
                    <strong>{STAGE_LABELS[row.currentStage] || 'Transport'}: {formatStatus(row.currentStatus || row.status)}</strong>
                    <div style={{ marginTop: 3, color: 'var(--text-secondary)', fontSize: '.72rem' }}>{formatDate(row.currentStatusUpdatedAt || row.statusUpdatedAt)}</div>
                  </td>
                  <td style={{ padding: '.55rem .65rem' }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      <button type="button" className="btn-secondary" aria-label={`Edit ${row.contact?.name || 'customer'} pickup location`} onClick={() => openEdit(row)} style={{ padding: '.38rem .55rem', fontSize: '.72rem' }}><Pencil size={13} /> Edit</button>
                      <button type="button" className="btn-secondary" aria-label={`View all status for ${row.contact?.name || 'customer'}`} onClick={() => setViewingCustomer(row)} style={{ padding: '.38rem .55rem', fontSize: '.72rem' }}><Eye size={13} /> View status</button>
                    </div>
                  </td>
                </tr>;
              })}
              {visibleCustomers.length === 0 && <tr><td colSpan="7" style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>No customer pickup records found. Save an address from a Callified transcript to add one.</td></tr>}
            </tbody>
          </table>
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
          <section role="dialog" aria-modal="true" aria-labelledby="status-history-title" className="card" style={{ width: 'min(680px, 100%)', maxHeight: '82vh', display: 'flex', flexDirection: 'column', padding: '1.25rem', opacity: 1, background: 'var(--popover-bg, #fff)', backdropFilter: 'none' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div><h2 id="status-history-title" style={{ margin: 0, fontSize: '1.2rem' }}>All customer statuses</h2><div style={{ marginTop: 4, color: 'var(--text-secondary)' }}>{viewingCustomer.contact?.name || 'Customer'}</div></div>
              <button type="button" className="btn-secondary" aria-label="Close customer statuses" onClick={() => setViewingCustomer(null)} style={{ padding: '.4rem' }}><X size={17} /></button>
            </div>
            <div data-testid="workflow-timeline" style={{ overflowY: 'auto', marginTop: 18, padding: '2px 8px 4px 2px' }}>
              {workflowTimeline(viewingCustomer).map((item, index, timeline) => {
                const firstInStage = index === 0 || timeline[index - 1].stage !== item.stage;
                const isLast = index === timeline.length - 1;
                const activeColor = 'var(--primary-color, var(--accent-color))';
                return (
                  <div key={`${item.stage}-${item.step}`} style={{ display: 'grid', gridTemplateColumns: '88px 28px minmax(0, 1fr)', minHeight: 58 }}>
                    <div style={{ paddingTop: 3, color: 'var(--text-primary)', fontSize: '.78rem', fontWeight: 800 }}>{firstInStage ? STAGE_LABELS[item.stage] : ''}</div>
                    <div aria-hidden="true" style={{ position: 'relative', display: 'flex', justifyContent: 'center' }}>
                      {!isLast && <span data-testid="workflow-connector" style={{ position: 'absolute', top: 18, bottom: -18, width: 2, background: item.state === 'complete' ? activeColor : 'var(--border-color)', zIndex: 0 }} />}
                      <span style={{ position: 'relative', zIndex: 1, width: 18, height: 18, boxSizing: 'border-box', borderRadius: '50%', display: 'grid', placeItems: 'center', color: item.state === 'upcoming' ? 'var(--text-secondary)' : '#fff', background: item.state === 'upcoming' ? 'var(--popover-bg, #fff)' : activeColor, border: `2px solid ${item.state === 'upcoming' ? 'var(--border-color)' : activeColor}`, boxShadow: item.state === 'current' ? `0 0 0 4px color-mix(in srgb, ${activeColor} 18%, transparent)` : 'none' }}>
                        {item.state === 'complete' && <CheckCircle2 size={12} />}
                      </span>
                    </div>
                    <div style={{ padding: '1px 0 15px 8px', minWidth: 0 }}>
                      <strong style={{ color: item.state === 'upcoming' ? 'var(--text-secondary)' : 'var(--text-primary)' }}>{formatStatus(item.step)}</strong>
                      {item.state === 'current' && <span style={{ display: 'inline-flex', marginLeft: 8, padding: '.15rem .4rem', borderRadius: 999, color: activeColor, background: 'rgba(79,70,229,.1)', fontSize: '.66rem', fontWeight: 800 }}>Current</span>}
                      {item.assignee?.name && <div style={{ marginTop: 3, color: 'var(--text-secondary)', fontSize: '.75rem' }}>Assigned to {item.assignee.name}</div>}
                      {item.updatedAt && <div style={{ marginTop: 3, color: 'var(--text-secondary)', fontSize: '.72rem' }}>{formatDate(item.updatedAt)}</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
