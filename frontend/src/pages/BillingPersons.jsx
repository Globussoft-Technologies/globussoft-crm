import { useCallback, useEffect, useMemo, useState } from 'react';
import { Edit2, MapPin, Phone, Plus, Power, Receipt, X } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import MultiSelectDropdown from '../components/MultiSelectDropdown';
import ResizableTableHeader from '../components/ResizableTableHeader';
import useResizableColumnWidths from '../utils/useResizableColumnWidths';
import { validatePersonName, validatePhoneNumber } from '../utils/pickupPlotValidation';
import { isAssignablePlot } from '../utils/plotAvailability';

const emptyForm = {
  name: '', phone: '', email: '', password: '', notes: '', isActive: true,
  accountMode: 'create', staffUserId: '', customerIds: [], plotSiteIds: [], pickupLocationIds: [], assignments: [],
};
const BILLING_TABLE_COLUMNS = [
  { label: 'S.No.', width: 80, minWidth: 70 },
  { label: 'Name', width: 180, minWidth: 110 },
  { label: 'Phone', width: 170, minWidth: 120 },
  { label: 'Login', width: 220, minWidth: 150 },
  { label: 'Plots / sites', width: 280, minWidth: 180 },
  { label: 'Notes', width: 200, minWidth: 120 },
  { label: 'Status', width: 120, minWidth: 90 },
  { label: 'Actions', width: 120, minWidth: 100 },
];
const billingHeaderStyle = { position: 'sticky', top: 0, zIndex: 2, padding: '.55rem .65rem', borderRight: '1px solid var(--border-color)', borderBottom: '1px solid var(--border-color)', boxShadow: '0 1px 0 var(--border-color)', textAlign: 'left', fontSize: '.74rem', color: 'var(--text-secondary)', overflowWrap: 'anywhere', background: '#f3f4f6' };

function plotOptionLabel(plot) {
  return [plot.name, plot.address].filter(Boolean).join(' · ') || 'Unnamed plot';
}

function mapUrl(plot) {
  return plot.googleMapsLink
    || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(String(plot.address || plot.name || '').trim())}`;
}

function PlotAssignmentsCell({ plots }) {
  if (!Array.isArray(plots) || plots.length === 0) return 'Not assigned';
  return <div style={{ display: 'grid', gap: 6, maxHeight: 112, overflowY: 'auto', paddingRight: 4 }}>{plots.map((plot) => <div key={plot.id} style={{ minWidth: 0 }}>
    <strong style={{ display: 'block', overflowWrap: 'anywhere' }}>{plot.name}</strong>
    {plot.address ? <a
      href={mapUrl(plot)}
      target="_blank"
      rel="noreferrer"
      aria-label={`Open ${plot.name} address in Google Maps`}
      style={{ display: 'inline-flex', alignItems: 'flex-start', gap: 5, marginTop: 2, color: 'var(--text-secondary)', fontSize: '.74rem', lineHeight: 1.35, textDecoration: 'none' }}
    >
      <MapPin size={13} aria-hidden="true" style={{ flex: '0 0 auto', marginTop: 1, color: 'var(--primary-color, var(--accent-color))' }} />
      <span style={{ overflowWrap: 'anywhere' }}>{plot.address}</span>
    </a> : <span style={{ display: 'block', marginTop: 2, color: 'var(--text-secondary)', fontSize: '.74rem' }}>No address added</span>}
  </div>)}</div>;
}

function transportAssignments(customerIds, customerOptions) {
  return customerIds.map(Number).map((customerId) => ({
    customerId,
    plotSiteId: Number(customerOptions.find((row) => Number(row.id) === customerId)?.transportPlotSiteId),
  })).filter((row) => Number.isInteger(row.plotSiteId));
}

export default function BillingPersons() {
  const notify = useNotify();
  const [rows, setRows] = useState([]);
  const [staffUsers, setStaffUsers] = useState([]);
  const [customerOptions, setCustomerOptions] = useState([]);
  const [plotOptions, setPlotOptions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const { columnWidths, resizeColumn, tableMinWidth } = useResizableColumnWidths(
    BILLING_TABLE_COLUMNS,
    'pickup-plot-billing-directory-column-widths',
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetchApi('/api/pickup-plot-inventory/billing-persons');
      setRows(Array.isArray(response?.billingPersons) ? response.billingPersons : []);
      setStaffUsers(Array.isArray(response?.staffUsers) ? response.staffUsers : []);
      setCustomerOptions(Array.isArray(response?.customers) ? response.customers : []);
      setPlotOptions(Array.isArray(response?.plots) ? response.plots : []);
    } catch (error) {
      notify.error(error.message || 'Could not load billing persons.');
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => { load(); }, [load]);

  const open = (row = null) => {
    setEditing(row || {});
    const customerIds = row && Array.isArray(row.customerIds)
      ? row.customerIds.filter((id) => customerOptions.some((customer) => Number(customer.id) === Number(id)))
      : [];
    const plotSiteIds = row && Array.isArray(row.plotSiteIds) ? row.plotSiteIds : [];
    setForm(row ? {
      ...emptyForm,
      name: row.user?.name || row.name || '',
      phone: row.user?.phone || row.phone || '',
      email: row.user?.email || row.email || '',
      notes: row.notes || '',
      isActive: row.isActive,
      accountMode: row.user ? 'linked' : 'none',
      staffUserId: row.user?.id || '',
      customerIds,
      plotSiteIds,
      pickupLocationIds: Array.isArray(row.pickupLocationIds) ? row.pickupLocationIds : [],
      assignments: transportAssignments(customerIds, customerOptions),
    } : { ...emptyForm });
  };

  const save = async () => {
    const validationError = validatePersonName(form.name) || validatePhoneNumber(form.phone);
    if (validationError) return notify.error(validationError);
    if (!editing?.id && form.accountMode === 'create') {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) return notify.error('Please enter a valid work email address.');
      if (form.password.length < 6) return notify.error('Password must be at least 6 characters.');
    }
    if (!editing?.id && form.accountMode === 'existing' && !form.staffUserId) return notify.error('Select an existing Billing staff member.');
    setSaving(true);
    try {
      const payload = {
        name: form.name,
        phone: form.phone,
        email: form.email,
        notes: form.notes,
        isActive: form.isActive,
        customerIds: form.customerIds.map(Number),
        plotSiteIds: form.plotSiteIds.map(Number),
        pickupLocationIds: form.pickupLocationIds.map(Number),
        assignments: transportAssignments(form.customerIds, customerOptions),
      };
      if (!editing?.id && form.accountMode === 'create') payload.password = form.password;
      if (!editing?.id && form.accountMode === 'existing') {
        payload.staffUserId = Number(form.staffUserId);
        delete payload.email;
      }
      await fetchApi(`/api/pickup-plot-inventory/billing-persons${editing?.id ? `/${editing.id}` : ''}`, {
        method: editing?.id ? 'PUT' : 'POST', body: JSON.stringify(payload),
      });
      notify.success(`${editing?.id ? 'Updated' : 'Added'} billing person.`);
      setEditing(null);
      await load();
    } catch (error) {
      notify.error(error.message || 'Could not save billing person.');
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (row) => {
    try {
      await fetchApi(`/api/pickup-plot-inventory/billing-persons/${row.id}/status`, {
        method: 'PATCH', body: JSON.stringify({ isActive: !row.isActive }),
      });
      notify.success(`Billing person ${row.isActive ? 'deactivated' : 'activated'}.`);
      await load();
    } catch (error) {
      notify.error(error.message || 'Could not change billing person status.');
    }
  };

  const visibleRows = useMemo(() => rows.filter((row) => {
    if (status === 'active' && !row.isActive) return false;
    if (status === 'inactive' && row.isActive) return false;
    const needle = search.trim().toLowerCase();
    return !needle || [row.name, row.phone, row.email, row.user?.email, row.notes]
      .some((value) => String(value || '').toLowerCase().includes(needle));
  }), [rows, search, status]);

  return (
    <div data-testid="billing-directory-page" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflow: 'hidden', boxSizing: 'border-box', padding: '2rem' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 16, marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}><Receipt size={28} /> Billing Persons</h1>
          <p style={{ color: 'var(--text-secondary)', margin: '0.4rem 0 0' }}>Create billing logins and manage the people responsible for invoices and payments.</p>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', gap: 8, flex: '1 1 500px', maxWidth: 720 }}>
          <input className="input-field" type="search" aria-label="Search billing persons" placeholder="Search billing persons..." value={search} onChange={(event) => setSearch(event.target.value)} style={{ flex: '1 1 220px', minWidth: 0, height: 44, boxSizing: 'border-box' }} />
          <select className="input-field" aria-label="Filter by status" value={status} onChange={(event) => setStatus(event.target.value)} style={{ flex: '0 0 140px', height: 44, boxSizing: 'border-box' }}>
            <option value="all">All statuses</option><option value="active">Active</option><option value="inactive">Inactive</option>
          </select>
          <button type="button" className="btn-primary" onClick={() => open()} style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, whiteSpace: 'nowrap' }}><Plus size={16} /> Add Billing Person</button>
        </div>
      </header>

      {loading ? <div className="card" style={{ padding: '3rem', textAlign: 'center' }}>Loading billing persons…</div> : (
        <div
          className="card pickup-plot-table-scroll"
          data-testid="billing-directory-table-scroll"
          style={{
            flex: '1 1 0', minHeight: 0, width: '100%', maxWidth: '100%',
            overflowX: 'auto', overflowY: 'auto', padding: 0, boxSizing: 'border-box',
            scrollbarGutter: 'stable', overscrollBehavior: 'contain',
          }}
        >
          <div data-testid="billing-persons-table-width" style={{ width: tableMinWidth, minWidth: '100%' }}>
          <table className="pickup-plot-resizable-table" aria-label="Billing persons" style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse' }}>
            <colgroup>{columnWidths.map((width, index) => <col key={BILLING_TABLE_COLUMNS[index].label} style={{ width }} />)}</colgroup>
            <thead><tr>{BILLING_TABLE_COLUMNS.map((column, index) => <ResizableTableHeader key={column.label} label={column.label} width={columnWidths[index]} minWidth={column.minWidth} onResize={(width) => resizeColumn(index, width)} style={billingHeaderStyle}>{column.label}</ResizableTableHeader>)}</tr></thead>
            <tbody>
              {visibleRows.map((row, index) => <tr key={row.id} style={{ borderBottom: '1px solid var(--border-color)', opacity: row.isActive ? 1 : .68 }}>
                <td style={{ padding: '.55rem .65rem' }}>{index + 1}</td>
                <td style={{ padding: '.55rem .65rem', fontWeight: 800, overflowWrap: 'anywhere' }}>{row.user?.name || row.name}</td>
                <td style={{ padding: '.55rem .65rem', overflowWrap: 'anywhere' }}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Phone size={14} /> {row.user?.phone || row.phone}</span></td>
                <td style={{ padding: '.55rem .65rem', overflowWrap: 'anywhere' }}>{row.user?.email || row.email || 'Not linked'}</td>
                <td style={{ padding: '.55rem .65rem', overflowWrap: 'anywhere' }}><PlotAssignmentsCell plots={row.plots} /></td>
                <td style={{ padding: '.55rem .65rem', color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}>{row.notes || '—'}</td>
                <td style={{ padding: '.55rem .65rem' }}><span style={{ display: 'inline-flex', padding: '.2rem .45rem', borderRadius: 6, fontSize: '.7rem', fontWeight: 800, color: row.isActive ? '#047857' : '#64748b', background: row.isActive ? 'rgba(16,185,129,.14)' : 'rgba(100,116,139,.14)' }}>{row.isActive ? 'Active' : 'Inactive'}</span></td>
                <td style={{ padding: '.55rem .65rem' }}><div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end' }}><button type="button" className="btn-secondary" aria-label={`Edit ${row.name}`} title={`Edit ${row.name}`} onClick={() => open(row)} style={{ padding: '.55rem', minWidth: 38, justifyContent: 'center' }}><Edit2 size={14} /></button><button type="button" className="btn-secondary" aria-label={`${row.isActive ? 'Deactivate' : 'Activate'} ${row.name}`} title={`${row.isActive ? 'Deactivate' : 'Activate'} ${row.name}`} onClick={() => toggle(row)} style={{ padding: '.55rem', minWidth: 38, justifyContent: 'center' }}><Power size={14} /></button></div></td>
              </tr>)}
              {visibleRows.length === 0 && <tr><td colSpan="8" style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>No billing persons found.</td></tr>}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {editing && <BillingPersonModal form={form} setForm={setForm} editing={editing} staffUsers={staffUsers} customerOptions={customerOptions} plotOptions={plotOptions} saving={saving} onClose={() => setEditing(null)} onSave={save} />}
    </div>
  );
}

function BillingPersonModal({ form, setForm, editing, staffUsers, customerOptions, plotOptions, saving, onClose, onSave }) {
  const field = { width: '100%', marginTop: 5, boxSizing: 'border-box' };
  const selectedPlots = new Set(form.plotSiteIds.map(Number));
  const assignablePlotOptions = plotOptions.filter(isAssignablePlot);
  const assignableCustomerOptions = customerOptions.filter((customer) => (
    selectedPlots.has(Number(customer.transportPlotSiteId))
    && (!customer.claimedByPersonId || Number(customer.claimedByPersonId) === Number(editing?.id))
  ));
  return <div role="presentation" style={{ position: 'fixed', inset: 0, zIndex: 300, padding: '1rem', background: 'rgba(15,23,42,.62)', display: 'grid', placeItems: 'center' }}>
    <div role="dialog" aria-modal="true" aria-label={`${editing.id ? 'Edit' : 'Add'} Billing Person`} className="card" style={{ width: 'min(620px,100%)', padding: '1.5rem', opacity: 1, background: 'var(--popover-bg, #fff)', backdropFilter: 'none' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}><h2 style={{ margin: 0 }}>{editing.id ? 'Edit' : 'Add'} Billing Person</h2><button type="button" aria-label="Close dialog" onClick={onClose} style={{ border: 0, background: 'transparent' }}><X size={21} /></button></div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,220px),1fr))', gap: 14, marginTop: 20 }}>
        {!editing.id && <label>Login account<select className="input-field" aria-label="Billing login setup" style={field} value={form.accountMode} onChange={(event) => setForm({ ...form, accountMode: event.target.value, staffUserId: '', email: '', password: '' })}><option value="create">Create a new billing login</option><option value="existing">Assign existing Billing staff</option></select></label>}
        {!editing.id && form.accountMode === 'existing' && <label>Existing Billing staff<select className="input-field" aria-label="Existing billing staff" style={field} value={form.staffUserId} onChange={(event) => { const user = staffUsers.find((row) => String(row.id) === event.target.value); setForm({ ...form, staffUserId: event.target.value, name: user?.name || '', phone: user?.phone || '', email: user?.email || '' }); }}><option value="">Select staff member</option>{staffUsers.map((user) => <option key={user.id} value={user.id}>{user.name} ({user.email})</option>)}</select></label>}
        <label>Name *<input className="input-field" style={field} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
        <label>Phone *<input className="input-field" type="tel" style={field} value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></label>
        {!editing.id && form.accountMode === 'create' && <><label>Work email *<input className="input-field" type="email" style={field} value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></label><label>Password *<input className="input-field" type="password" style={field} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /></label></>}
        {editing.id && <div style={{ gridColumn: '1/-1', padding: '.7rem', background: 'var(--subtle-bg-2)', borderRadius: 9 }}><strong>Staff login:</strong> {form.email || 'Not linked'}</div>}
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: '.78rem', fontWeight: 700, marginBottom: 5 }}>Customers</div>
          <MultiSelectDropdown
            ariaLabel="Billing customers (select multiple)"
            searchable
            options={assignableCustomerOptions.map((customer) => ({
              value: Number(customer.id),
              label: [customer.name, customer.company, customer.phone || customer.email].filter(Boolean).join(' · '),
            }))}
            selected={form.customerIds.map(Number)}
            onChange={(customerIds) => setForm({
              ...form,
              customerIds,
              assignments: transportAssignments(customerIds, customerOptions),
            })}
            placeholder="Select customers"
          />
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: '.78rem', fontWeight: 700, marginBottom: 5 }}>Plots / sites</div>
          <MultiSelectDropdown
            ariaLabel="Billing plots / sites (select multiple)"
            searchable
            options={assignablePlotOptions.map((plot) => ({ value: Number(plot.id), label: plotOptionLabel(plot) }))}
            selected={form.plotSiteIds.map(Number)}
            onChange={(plotSiteIds) => {
              const nextPlots = new Set(plotSiteIds.map(Number));
              const customerIds = form.customerIds.filter((customerId) => {
                const customer = customerOptions.find((row) => Number(row.id) === Number(customerId));
                return nextPlots.has(Number(customer?.transportPlotSiteId));
              });
              setForm({
                ...form,
                plotSiteIds,
                customerIds,
                assignments: transportAssignments(customerIds, customerOptions),
              });
            }}
            placeholder="Select plots or sites"
          />
        </div>
        {form.customerIds.length > 0 && <div style={{ gridColumn: '1/-1', padding: '.8rem', border: '1px solid var(--border-color)', borderRadius: 10 }}>
          <div style={{ fontSize: '.78rem', fontWeight: 700, marginBottom: 10 }}>Connected customer → plot assignments</div>
          {form.assignments.length === 0 ? <div style={{ color: 'var(--text-secondary)', fontSize: '.8rem' }}>Select at least one plot to connect the selected customers.</div> : form.assignments.map((assignment) => {
            const customer = customerOptions.find((row) => Number(row.id) === Number(assignment.customerId));
            if (!customer) return null;
            return <div key={assignment.customerId} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(180px,1fr)', alignItems: 'center', gap: 12, marginTop: 8 }}>
              <strong>{customer.name}</strong>
              <select className="input-field" aria-label={`Billing plot for ${customer.name}`} value={assignment.plotSiteId} disabled title="This plot is assigned by Transport and cannot be changed here.">
                {plotOptions.filter((plot) => form.plotSiteIds.map(Number).includes(Number(plot.id))).map((plot) => <option key={plot.id} value={plot.id}>{plotOptionLabel(plot)}</option>)}
              </select>
            </div>;
          })}
        </div>}
        <label style={{ gridColumn: '1/-1' }}>Notes<textarea className="input-field" rows="3" style={field} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label>
        <label style={{ gridColumn: '1/-1' }}><input type="checkbox" checked={form.isActive} onChange={(event) => setForm({ ...form, isActive: event.target.checked })} /> Active billing person</label>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}><button type="button" className="btn-secondary" onClick={onClose}>Cancel</button><button type="button" className="btn-primary" disabled={saving} onClick={onSave}>{saving ? 'Saving…' : 'Save'}</button></div>
    </div>
  </div>;
}
