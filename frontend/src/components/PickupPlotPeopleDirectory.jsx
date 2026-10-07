import { useCallback, useEffect, useMemo, useState } from 'react';
import { Edit2, Eye, Handshake, MapPin, Phone, Plus, Power, Truck, X } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import MultiSelectDropdown from './MultiSelectDropdown';
import { serviceAreasForPlots } from '../utils/plotServiceAreas';
import {
  validateBrokerForm,
  validatePersonName,
  validatePhoneNumber,
  validateTransportPersonForm,
} from '../utils/pickupPlotValidation';

const fieldStyle = { width: '100%', marginTop: 5, boxSizing: 'border-box' };
const invalidFieldStyle = { borderColor: '#dc2626', boxShadow: '0 0 0 1px #dc2626' };
const labelStyle = { display: 'block', fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-secondary)' };

const CONFIG = {
  transport: {
    title: 'Transport Persons',
    description: 'Add drivers and transport contacts, their vehicle details, and plot assignments.',
    addLabel: 'Add Transport Person',
    singular: 'transport person',
    endpoint: '/api/pickup-plot-inventory/transport-persons',
    rowsKey: 'transportPersons',
    optionsKey: 'pickupLocations',
    icon: Truck,
    empty: {
      name: '', phone: '', alternatePhone: '', vehicleType: '', vehicleNumber: '',
      serviceArea: '', pickupLocationId: '', pickupLocationIds: [], plotSiteIds: [],
      customerIds: [], serviceAreas: [], accountMode: 'create', staffUserId: '',
      email: '', password: '', notes: '', isActive: true,
    },
  },
  broker: {
    title: 'Plot Brokers',
    description: 'Maintain broker contacts, commission rates, and the plot or site they currently represent.',
    addLabel: 'Add Plot Broker',
    singular: 'plot broker',
    endpoint: '/api/pickup-plot-inventory/brokers',
    rowsKey: 'brokers',
    optionsKey: 'plots',
    icon: Handshake,
    empty: {
      name: '', phone: '', email: '', agency: '', commissionPercent: '',
      plotSiteId: '', plotSiteIds: [], customerIds: [], serviceAreas: [],
      accountMode: 'create', staffUserId: '', password: '', notes: '', isActive: true,
    },
  },
};

function StatusPill({ active }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', alignSelf: 'flex-start',
      padding: '0.2rem 0.45rem', borderRadius: 6, lineHeight: 1.2,
      fontSize: '0.7rem', fontWeight: 800, whiteSpace: 'nowrap',
      color: active ? '#047857' : '#64748b',
      background: active ? 'rgba(16,185,129,.14)' : 'rgba(100,116,139,.14)',
    }}>
      {active ? 'Active' : 'Inactive'}
    </span>
  );
}

function Field({ label, children, error, errorId, full = false }) {
  return (
    <div style={full ? { gridColumn: '1 / -1' } : undefined}>
      <label style={labelStyle}>{label}{children}</label>
      {error && <div id={errorId} role="alert" style={{ color: '#dc2626', fontSize: '0.74rem', fontWeight: 600, marginTop: 5 }}>{error}</div>}
    </div>
  );
}

function Modal({ title, saving, onClose, onSave, children }) {
  return (
    <div role="presentation" style={{ position: 'fixed', inset: 0, zIndex: 300, padding: '1rem', background: 'rgba(15,23,42,.62)', display: 'grid', placeItems: 'center' }}>
      <div role="dialog" aria-modal="true" aria-label={title} className="card" style={{ width: 'min(680px, 100%)', maxHeight: '90vh', overflowY: 'auto', padding: '1.5rem', opacity: 1, background: 'var(--popover-bg, #fff)', backdropFilter: 'none', color: 'var(--text-primary)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: '1.25rem' }}>
          <h2 style={{ margin: 0, fontSize: '1.25rem' }}>{title}</h2>
          <button type="button" aria-label="Close dialog" onClick={onClose} style={{ border: 0, background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' }}><X size={21} /></button>
        </div>
        {children}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: '1.4rem' }}>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" className="btn-primary" onClick={onSave} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}

function ServiceAreasDialog({ serviceAreas, onClose }) {
  return (
    <div role="presentation" style={{ position: 'fixed', inset: 0, zIndex: 340, padding: '1rem', background: 'rgba(15,23,42,.68)', display: 'grid', placeItems: 'center' }}>
      <div role="dialog" aria-modal="true" aria-label={`All service areas (${serviceAreas.length})`} className="card" style={{ width: 'min(720px, 100%)', maxHeight: '82vh', display: 'flex', flexDirection: 'column', padding: '1.25rem', opacity: 1, background: 'var(--popover-bg, #fff)', backdropFilter: 'none', color: 'var(--text-primary)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: '1.15rem' }}>Service areas</h2>
            <div style={{ marginTop: 3, color: 'var(--text-secondary)', fontSize: '0.78rem' }}>{serviceAreas.length} selected plot {serviceAreas.length === 1 ? 'area' : 'areas'}</div>
          </div>
          <button type="button" aria-label="Close service areas" onClick={onClose} style={{ border: 0, background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' }}><X size={21} /></button>
        </div>
        <div data-testid="service-areas-list" style={{ minHeight: 0, maxHeight: 'calc(82vh - 80px)', overflowY: 'auto', display: 'grid', gap: 8, paddingRight: 4 }}>
          {serviceAreas.map((serviceArea) => <div key={serviceArea.plotSiteId || serviceArea.plotName} data-testid={`service-area-${serviceArea.plotSiteId}`} style={{ padding: '0.75rem', border: '1px solid var(--border-color)', borderRadius: 9, background: 'var(--subtle-bg, rgba(148,163,184,.08))' }}>
            <div style={{ fontWeight: 800, fontSize: '0.82rem', marginBottom: 4 }}>{serviceArea.plotName || 'Selected plot'}</div>
            <div style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', marginBottom: 8 }}>{serviceArea.address || 'No stored plot address'}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 130px), 1fr))', gap: 8 }}>
              {[['Area', serviceArea.area], ['State', serviceArea.state], ['PIN code', serviceArea.pincode]].map(([label, value]) => <div key={label}>
                <div style={{ color: 'var(--text-secondary)', fontSize: '0.7rem', fontWeight: 700 }}>{label}</div>
                <div style={{ marginTop: 2, fontSize: '0.82rem', overflowWrap: 'anywhere' }}>{value || 'Not available in plot address'}</div>
              </div>)}
            </div>
          </div>)}
        </div>
      </div>
    </div>
  );
}

function SelectedCustomersDialog({ customers, onClose }) {
  return (
    <div role="presentation" style={{ position: 'fixed', inset: 0, zIndex: 340, padding: '1rem', background: 'rgba(15,23,42,.68)', display: 'grid', placeItems: 'center' }}>
      <div role="dialog" aria-modal="true" aria-label={`Selected customers (${customers.length})`} className="card" style={{ width: 'min(620px, 100%)', maxHeight: '82vh', display: 'flex', flexDirection: 'column', padding: '1.25rem', opacity: 1, background: 'var(--popover-bg, #fff)', backdropFilter: 'none', color: 'var(--text-primary)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: '1.15rem' }}>Selected customers</h2>
            <div style={{ marginTop: 3, color: 'var(--text-secondary)', fontSize: '0.78rem' }}>{customers.length} {customers.length === 1 ? 'customer' : 'customers'}</div>
          </div>
          <button type="button" aria-label="Close selected customers" onClick={onClose} style={{ border: 0, background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' }}><X size={21} /></button>
        </div>
        <div style={{ minHeight: 0, maxHeight: 'calc(82vh - 80px)', overflowY: 'auto', display: 'grid', gap: 8, paddingRight: 4 }}>
          {customers.map((customer) => <div key={customer.id} style={{ padding: '0.75rem', border: '1px solid var(--border-color)', borderRadius: 9, background: 'var(--subtle-bg, rgba(148,163,184,.08))' }}>
            <div style={{ fontWeight: 800, fontSize: '0.84rem' }}>{customer.name}</div>
            {customer.company && <div style={{ marginTop: 3, color: 'var(--text-secondary)', fontSize: '0.78rem' }}>{customer.company}</div>}
            <div style={{ marginTop: 5, color: 'var(--text-secondary)', fontSize: '0.76rem', overflowWrap: 'anywhere' }}>{customer.phone || customer.email || 'No contact details'}</div>
          </div>)}
        </div>
      </div>
    </div>
  );
}

function CustomerSelector({ customerOptions, selectedIds, onChange, onView }) {
  return (
    <div>
      <div style={{ ...labelStyle, marginBottom: 5 }}>Customers</div>
      <div style={{ display: 'flex', alignItems: 'stretch', gap: 6, minWidth: 0 }}>
        <div style={{ flex: '1 1 auto', minWidth: 0 }}>
          <MultiSelectDropdown
            ariaLabel="Customers (select multiple)"
            searchable
            options={customerOptions.map((customer) => ({
              value: Number(customer.id),
              label: [customer.name, customer.company, customer.phone || customer.email].filter(Boolean).join(' · '),
            }))}
            selected={selectedIds.map(Number)}
            onChange={onChange}
            placeholder="Select customers"
          />
        </div>
        <button type="button" className="btn-secondary" aria-label={`View selected customers (${selectedIds.length})`} disabled={selectedIds.length === 0} onClick={onView} style={{ flex: '0 0 auto', padding: '0.45rem 0.55rem' }}>
          <Eye size={14} /> View
        </button>
      </div>
    </div>
  );
}

export default function PickupPlotPeopleDirectory({ type }) {
  const config = CONFIG[type];
  const notify = useNotify();
  const Icon = config.icon;
  const [rows, setRows] = useState([]);
  const [plotOptions, setPlotOptions] = useState([]);
  const [customerOptions, setCustomerOptions] = useState([]);
  const [staffUsers, setStaffUsers] = useState([]);
  const [staffRole, setStaffRole] = useState(null);
  const [summary, setSummary] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(config.empty);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [assignmentFilter, setAssignmentFilter] = useState('all');
  const [touchedFields, setTouchedFields] = useState({});
  const [serviceAreasOpen, setServiceAreasOpen] = useState(false);
  const [selectedCustomersOpen, setSelectedCustomersOpen] = useState(false);

  const nameError = touchedFields.name ? validatePersonName(form.name) : null;
  const phoneError = touchedFields.phone ? validatePhoneNumber(form.phone) : null;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetchApi(config.endpoint);
      setRows(Array.isArray(response?.[config.rowsKey]) ? response[config.rowsKey] : []);
      setPlotOptions(Array.isArray(response?.plots) ? response.plots : []);
      setCustomerOptions(Array.isArray(response?.customers) ? response.customers : []);
      setStaffUsers(Array.isArray(response?.staffUsers) ? response.staffUsers : []);
      setStaffRole(type === 'transport' ? response?.transportRole || null : response?.staffRole || null);
      setSummary(response?.summary || {});
    } catch (error) {
      notify.error(error.message || `Could not load ${config.title.toLowerCase()}.`);
    } finally {
      setLoading(false);
    }
  }, [config, notify, type]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const refreshOnFocus = () => load();
    window.addEventListener('focus', refreshOnFocus);
    return () => window.removeEventListener('focus', refreshOnFocus);
  }, [load]);

  const open = (row = null) => {
    setEditing(row || {});
    setServiceAreasOpen(false);
    setSelectedCustomersOpen(false);
    setTouchedFields({});
    if (!row) {
      setForm({ ...config.empty });
      return;
    }
    const nextForm = Object.fromEntries(Object.keys(config.empty).map((key) => [key, row[key] ?? config.empty[key]]));
    nextForm.accountMode = row.user ? 'linked' : 'none';
    nextForm.staffUserId = row.user?.id || '';
    nextForm.email = row.user?.email || row.email || '';
    nextForm.password = '';
    if (type === 'transport') {
      nextForm.pickupLocationIds = [];
      nextForm.plotSiteIds = Array.isArray(row.plotSiteIds) ? row.plotSiteIds : [];
      nextForm.customerIds = Array.isArray(row.customerIds) ? row.customerIds : [];
      // Refresh derived details from the current plot addresses. Older rows
      // may contain serviceAreasJson saved before state inference existed.
      nextForm.serviceAreas = serviceAreasForPlots(plotOptions, nextForm.plotSiteIds);
    } else {
      nextForm.plotSiteIds = Array.isArray(row.plotSiteIds)
        ? row.plotSiteIds
        : row.plotSiteId ? [row.plotSiteId] : [];
      nextForm.customerIds = Array.isArray(row.customerIds) ? row.customerIds : [];
      nextForm.serviceAreas = serviceAreasForPlots(plotOptions, nextForm.plotSiteIds);
    }
    setForm(nextForm);
  };

  const save = async () => {
    setTouchedFields((current) => ({ ...current, name: true, phone: true }));
    const validationError = type === 'transport'
      ? validateTransportPersonForm(form)
      : validateBrokerForm(form);
    if (validationError) {
      notify.error(validationError);
      return;
    }
    if (!editing?.id) {
      if (form.accountMode === 'create') {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((form.email || '').trim())) {
          notify.error('Please enter a valid work email address.');
          return;
        }
        if ((form.password || '').length < 6) {
          notify.error('Password must be at least 6 characters.');
          return;
        }
      } else if (form.accountMode === 'existing' && !form.staffUserId) {
        notify.error(`Select an existing ${type === 'transport' ? 'Transport Person' : 'Broker'} staff member.`);
        return;
      }
    }
    setSaving(true);
    try {
      const isEditing = Boolean(editing?.id);
      const payload = { ...form };
      payload.plotSiteIds = payload.plotSiteIds.map(Number);
      payload.customerIds = payload.customerIds.map(Number);
      if (!isEditing && payload.accountMode === 'create') {
        payload.email = payload.email.trim();
        delete payload.staffUserId;
      } else if (!isEditing && payload.accountMode === 'existing') {
        payload.staffUserId = Number(payload.staffUserId);
        delete payload.email;
        delete payload.password;
      } else {
        delete payload.staffUserId;
        delete payload.password;
        if (type === 'transport') delete payload.email;
      }
      delete payload.accountMode;
      if (type === 'transport') {
        delete payload.pickupLocationId;
        delete payload.serviceArea;
      } else {
        delete payload.plotSiteId;
        delete payload.serviceAreas;
      }
      await fetchApi(`${config.endpoint}${isEditing ? `/${editing.id}` : ''}`, {
        method: isEditing ? 'PUT' : 'POST', body: JSON.stringify(payload),
      });
      notify.success(`${isEditing ? 'Updated' : 'Added'} ${config.singular}.`);
      setEditing(null);
      setServiceAreasOpen(false);
      setSelectedCustomersOpen(false);
      await load();
    } catch (error) {
      notify.error(error.message || `Could not save ${config.singular}.`);
    } finally {
      setSaving(false);
    }
  };

  const toggleStatus = async (row) => {
    try {
      await fetchApi(`${config.endpoint}/${row.id}/status`, {
        method: 'PATCH', body: JSON.stringify({ isActive: !row.isActive }),
      });
      notify.success(`${config.title.slice(0, -1)} ${row.isActive ? 'deactivated' : 'activated'}.`);
      await load();
    } catch (error) {
      notify.error(error.message || `Could not change ${config.singular} status.`);
    }
  };

  const cards = useMemo(() => [
    ['Total records', summary.total || 0],
    ['Active', summary.active || 0],
    ['Assigned to plots', summary.assigned || 0],
  ], [summary]);

  const filteredRows = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    return rows.filter((row) => {
      if (statusFilter === 'active' && !row.isActive) return false;
      if (statusFilter === 'inactive' && row.isActive) return false;

      const isAssigned = type === 'transport'
        ? Boolean(row.plotSiteIds?.length)
        : Boolean(row.plotSiteIds?.length || row.plotSiteId || row.plotSite?.id);
      if (assignmentFilter === 'assigned' && !isAssigned) return false;
      if (assignmentFilter === 'unassigned' && isAssigned) return false;

      if (!query) return true;
      const searchableValues = type === 'transport'
        ? [
          row.name, row.phone, row.alternatePhone, row.vehicleType, row.vehicleNumber,
          row.serviceArea,
          ...(row.plots || []).map((plot) => plot.name),
          ...(row.serviceAreas || []).flatMap((area) => [area.area, area.state, area.pincode]),
          row.notes,
        ]
        : [
          row.name, row.phone, row.email, row.agency, row.commissionPercent,
          row.plotSite?.name, ...(row.plots || []).map((plot) => plot.name), row.notes,
        ];
      return searchableValues.some((value) => String(value ?? '').toLowerCase().includes(query));
    });
  }, [assignmentFilter, rows, searchQuery, statusFilter, type]);

  const selectedCustomers = useMemo(() => {
    const selectedIds = new Set((form.customerIds || []).map(Number));
    return customerOptions.filter((customer) => selectedIds.has(Number(customer.id)));
  }, [customerOptions, form.customerIds]);

  return (
    <div data-testid={`${type}-directory-page`} style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflow: 'hidden', boxSizing: 'border-box', padding: '2rem', animation: 'fadeIn .35s ease-out' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 16, marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}><Icon size={28} /> {config.title}</h1>
          <p style={{ color: 'var(--text-secondary)', margin: '0.4rem 0 0' }}>{config.description}</p>
        </div>
        <div aria-label={`${config.title} filters`} style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8, flex: '1 1 520px', maxWidth: 720 }}>
          <input
            className="input-field"
            type="search"
            aria-label={`Search ${config.title.toLowerCase()}`}
            placeholder={`Search ${config.title.toLowerCase()}...`}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            style={{ flex: '1 1 210px', minWidth: 0 }}
          />
          <select className="input-field" aria-label="Filter by status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} style={{ flex: '0 1 130px' }}>
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
          <select className="input-field" aria-label="Filter by assignment" value={assignmentFilter} onChange={(event) => setAssignmentFilter(event.target.value)} style={{ flex: '0 1 150px' }}>
            <option value="all">All assignments</option>
            <option value="assigned">Assigned</option>
            <option value="unassigned">Unassigned</option>
          </select>
          <button className="btn-primary" onClick={() => open()}><Plus size={16} /> {config.addLabel}</button>
        </div>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 190px), 1fr))', gap: 12, marginBottom: '1.25rem' }}>
        {cards.map(([label, value]) => <div key={label} className="card" style={{ padding: '1rem' }}><div style={{ color: 'var(--text-secondary)', fontSize: '0.76rem', fontWeight: 700 }}>{label}</div><div style={{ fontSize: '1.65rem', fontWeight: 800, marginTop: 4 }}>{value}</div></div>)}
      </div>

      {loading ? <div className="card" style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Loading {config.title.toLowerCase()}…</div> : (
        <div
          className="card"
          data-testid={`${type}-directory-table-scroll`}
          style={{
            flex: '1 1 0', minHeight: 0, width: '100%', maxWidth: '100%',
            overflowX: 'hidden', overflowY: 'auto', padding: 0, boxSizing: 'border-box',
            scrollbarGutter: 'stable', overscrollBehavior: 'contain',
          }}
        >
          <table aria-label={config.title} style={{ width: '100%', minWidth: 0, tableLayout: 'fixed', borderCollapse: 'collapse' }}>
            <thead><tr style={{ background: 'var(--subtle-bg)' }}>
              {(type === 'transport'
                ? ['Name', 'Phone', 'Vehicle', 'Plots / sites', 'Notes', 'Status', 'Actions']
                : ['Name', 'Phone', 'Agency', 'Plots / sites', 'Commission', 'Notes', 'Status', 'Actions'])
                .map((label) => <th key={label} scope="col" style={{ position: 'sticky', top: 0, zIndex: 2, padding: '.55rem .65rem', borderBottom: '1px solid var(--border-color)', boxShadow: '0 1px 0 var(--border-color)', textAlign: 'left', fontSize: '.74rem', color: 'var(--text-secondary)', overflowWrap: 'anywhere', background: 'linear-gradient(var(--table-header-bg, rgba(148,163,184,.08)), var(--table-header-bg, rgba(148,163,184,.08))), var(--popover-bg, #fff)' }}>{label}</th>)}
            </tr></thead>
            <tbody>
              {filteredRows.map((row) => (
                <tr key={row.id} style={{ borderBottom: '1px solid var(--border-color)', opacity: row.isActive ? 1 : 0.68 }}>
                  <td style={{ padding: '.55rem .65rem', fontWeight: 800, overflowWrap: 'anywhere' }}>{row.name}</td>
                  <td style={{ padding: '.55rem .65rem', overflowWrap: 'anywhere' }}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Phone size={14} /> {row.phone}</span></td>
                  {type === 'transport' ? <>
                    <td style={{ padding: '.55rem .65rem', overflowWrap: 'anywhere' }}>{[row.vehicleType, row.vehicleNumber].filter(Boolean).join(' · ') || 'Not specified'}</td>
                    <td style={{ padding: '.55rem .65rem', overflowWrap: 'anywhere' }}>{(row.plots || []).map((plot) => plot.name).join(', ') || 'Not assigned'}</td>
                  </> : <>
                    <td style={{ padding: '.55rem .65rem', overflowWrap: 'anywhere' }}>{row.agency || 'Independent'}</td>
                    <td style={{ padding: '.55rem .65rem', overflowWrap: 'anywhere' }}><span style={{ display: 'inline-flex', alignItems: 'flex-start', gap: 5 }}><MapPin size={14} style={{ marginTop: 2, flex: '0 0 auto' }} />{(row.plots || []).map((plot) => plot.name).join(', ') || row.plotSite?.name || 'Not assigned'}</span></td>
                    <td style={{ padding: '.55rem .65rem' }}>{row.commissionPercent === null || row.commissionPercent === undefined ? 'Not set' : `${Number(row.commissionPercent)}%`}</td>
                  </>}
                  <td style={{ padding: '.55rem .65rem', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{row.notes || '—'}</td>
                  <td style={{ padding: '.55rem .65rem' }}><StatusPill active={row.isActive} /></td>
                  <td style={{ padding: '.55rem .65rem' }}><div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}><button className="btn-secondary" aria-label={`Edit ${row.name}`} title={`Edit ${row.name}`} onClick={() => open(row)} style={{ padding: '.55rem', minWidth: 38, justifyContent: 'center' }}><Edit2 size={14} /></button><button className="btn-secondary" aria-label={`${row.isActive ? 'Deactivate' : 'Activate'} ${row.name}`} title={`${row.isActive ? 'Deactivate' : 'Activate'} ${row.name}`} onClick={() => toggleStatus(row)} style={{ padding: '.55rem', minWidth: 38, justifyContent: 'center' }}><Power size={14} /></button></div></td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={type === 'transport' ? 7 : 8} style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>No {config.title.toLowerCase()} yet.</td></tr>}
              {rows.length > 0 && filteredRows.length === 0 && <tr><td colSpan={type === 'transport' ? 7 : 8} style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>No {config.title.toLowerCase()} match the selected filters.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {editing && <Modal title={`${editing.id ? 'Edit' : 'Add'} ${type === 'transport' ? 'Transport Person' : 'Plot Broker'}`} saving={saving} onClose={() => { setEditing(null); setServiceAreasOpen(false); setSelectedCustomersOpen(false); }} onSave={save}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 14 }}>
          {!editing.id && <Field label="Login account">
            <select
              className="input-field"
              aria-label={`${type === 'transport' ? 'Transport' : 'Broker'} login setup`}
              style={fieldStyle}
              value={form.accountMode}
              onChange={(event) => setForm({
                ...form,
                accountMode: event.target.value,
                staffUserId: '',
                email: '',
                password: '',
              })}
            >
              <option value="create">Create a new {type === 'transport' ? 'transport' : 'broker'} login</option>
              <option value="existing">Assign existing {type === 'transport' ? 'Transport Person' : 'Broker'} staff</option>
            </select>
          </Field>}
          {!editing.id && form.accountMode === 'existing' && <Field label={`Existing ${type === 'transport' ? 'transport' : 'broker'} staff`}>
            <select
              className="input-field"
              aria-label={`Existing ${type === 'transport' ? 'transport' : 'broker'} staff`}
              style={fieldStyle}
              value={form.staffUserId}
              onChange={(event) => {
                const staff = staffUsers.find((user) => String(user.id) === event.target.value);
                setForm({
                  ...form,
                  staffUserId: event.target.value,
                  name: staff?.name || form.name,
                  phone: staff?.phone || form.phone,
                  email: staff?.email || form.email,
                });
              }}
            >
              <option value="">Select staff member</option>
              {staffUsers.map((user) => <option key={user.id} value={user.id}>{user.name} ({user.email})</option>)}
            </select>
            {!staffRole && <span style={{ display: 'block', marginTop: 5, color: '#b45309', fontSize: '0.74rem' }}>No active {type === 'transport' ? 'Transport Person' : 'Broker'} role is configured in Team &amp; Access.</span>}
          </Field>}
          <Field label="Name *" error={nameError} errorId={`${type}-name-error`}>
            <input
              className="input-field"
              required
              minLength="2"
              maxLength="150"
              style={{ ...fieldStyle, ...(nameError ? invalidFieldStyle : {}) }}
              value={form.name}
              aria-invalid={Boolean(nameError)}
              aria-describedby={nameError ? `${type}-name-error` : undefined}
              onBlur={() => setTouchedFields((current) => ({ ...current, name: true }))}
              onChange={(event) => {
                setTouchedFields((current) => ({ ...current, name: true }));
                setForm({ ...form, name: event.target.value });
              }}
            />
          </Field>
          <Field label="Phone *" error={phoneError} errorId={`${type}-phone-error`}>
            <input
              className="input-field"
              required
              type="tel"
              maxLength="25"
              inputMode="tel"
              style={{ ...fieldStyle, ...(phoneError ? invalidFieldStyle : {}) }}
              value={form.phone}
              aria-invalid={Boolean(phoneError)}
              aria-describedby={phoneError ? `${type}-phone-error` : undefined}
              onBlur={() => setTouchedFields((current) => ({ ...current, phone: true }))}
              onChange={(event) => {
                setTouchedFields((current) => ({ ...current, phone: true }));
                setForm({ ...form, phone: event.target.value });
              }}
            />
          </Field>
          {!editing.id && form.accountMode === 'create' && <>
              <Field label="Work email *">
                <input
                  className="input-field"
                  type="email"
                  autoComplete="off"
                  aria-label="Work email *"
                  style={fieldStyle}
                  value={form.email}
                  onChange={(event) => setForm({ ...form, email: event.target.value })}
                />
              </Field>
              <Field label="Password *">
                <input
                  className="input-field"
                  type="password"
                  minLength="6"
                  autoComplete="new-password"
                  aria-label="Password *"
                  style={fieldStyle}
                  value={form.password}
                  onChange={(event) => setForm({ ...form, password: event.target.value })}
                />
              </Field>
          </>}
          {editing.id && form.accountMode === 'linked' && <div style={{ gridColumn: '1 / -1', padding: '0.65rem 0.75rem', border: '1px solid var(--border-color)', borderRadius: 9, background: 'var(--subtle-bg, rgba(148,163,184,.08))', fontSize: '0.82rem' }}>
            <strong>Staff login:</strong> {form.email}. Password changes are managed from Team &amp; Access.
          </div>}
          {type === 'transport' ? <>
            <Field label="Alternate phone"><input className="input-field" type="tel" maxLength="25" inputMode="tel" style={fieldStyle} value={form.alternatePhone} onChange={(event) => setForm({ ...form, alternatePhone: event.target.value })} /></Field>
            <Field label="Vehicle type"><input className="input-field" maxLength="100" placeholder="e.g. Mini truck" style={fieldStyle} value={form.vehicleType} onChange={(event) => setForm({ ...form, vehicleType: event.target.value })} /></Field>
            <Field label="Vehicle number"><input className="input-field" minLength="3" maxLength="30" placeholder="e.g. KA 01 AB 1234" style={fieldStyle} value={form.vehicleNumber} onChange={(event) => setForm({ ...form, vehicleNumber: event.target.value })} /></Field>
            <div>
              <div style={{ ...labelStyle, marginBottom: 5 }}>Customers</div>
              <div style={{ display: 'flex', alignItems: 'stretch', gap: 6, minWidth: 0 }}>
                <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                  <MultiSelectDropdown
                    ariaLabel="Customers (select multiple)"
                    searchable
                    options={customerOptions.map((customer) => ({
                      value: Number(customer.id),
                      label: [customer.name, customer.company, customer.phone || customer.email].filter(Boolean).join(' · '),
                    }))}
                    selected={form.customerIds.map(Number)}
                    onChange={(customerIds) => setForm({ ...form, customerIds })}
                    placeholder="Select customers"
                  />
                </div>
                <button type="button" className="btn-secondary" aria-label={`View selected customers (${selectedCustomers.length})`} disabled={selectedCustomers.length === 0} onClick={() => setSelectedCustomersOpen(true)} style={{ flex: '0 0 auto', padding: '0.45rem 0.55rem' }}>
                  <Eye size={14} /> View
                </button>
              </div>
            </div>
            <div data-testid="plots-field" style={{ minWidth: 0 }}>
              <div style={{ ...labelStyle, marginBottom: 5 }}>Plots / sites</div>
              <MultiSelectDropdown
                ariaLabel="Plots / sites (select multiple)"
                searchable
                options={plotOptions.map((option) => ({ value: Number(option.id), label: `${option.name} (${option.availability})` }))}
                selected={form.plotSiteIds.map(Number)}
                onChange={(plotSiteIds) => setForm({
                  ...form,
                  plotSiteIds,
                  serviceAreas: serviceAreasForPlots(plotOptions, plotSiteIds),
                })}
                placeholder="Select plots or sites"
              />
            </div>
            <div data-testid="service-areas-field" style={{ minWidth: 0 }}>
              <div style={{ ...labelStyle, marginBottom: 7 }}>Service areas from selected plot addresses</div>
              {form.serviceAreas.length > 0 ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '0.6rem 0.7rem', border: '1px solid var(--border-color)', borderRadius: 9, background: 'var(--subtle-bg, rgba(148,163,184,.08))' }}>
                  <span style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>{form.serviceAreas.length} service {form.serviceAreas.length === 1 ? 'area' : 'areas'}</span>
                  <button type="button" className="btn-secondary" aria-label={`View all service areas (${form.serviceAreas.length})`} onClick={() => setServiceAreasOpen(true)} style={{ padding: '0.35rem 0.6rem', fontSize: '0.76rem' }}>
                    View all service areas
                  </button>
                </div>
              ) : <div style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>Select one or more plots to fetch their service areas.</div>}
            </div>
          </> : <>
            {editing.id && form.accountMode !== 'linked' && <Field label="Email"><input className="input-field" type="email" maxLength="320" style={fieldStyle} value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></Field>}
            <Field label="Agency"><input className="input-field" maxLength="150" style={fieldStyle} value={form.agency} onChange={(event) => setForm({ ...form, agency: event.target.value })} /></Field>
            <div data-testid="broker-plots-field" style={{ minWidth: 0 }}>
              <div style={{ ...labelStyle, marginBottom: 5 }}>Plots / sites</div>
              <MultiSelectDropdown
                ariaLabel="Broker plots / sites (select multiple)"
                searchable
                options={plotOptions.map((option) => ({ value: Number(option.id), label: `${option.name} (${option.availability})` }))}
                selected={form.plotSiteIds.map(Number)}
                onChange={(plotSiteIds) => setForm({
                  ...form,
                  plotSiteIds,
                  serviceAreas: serviceAreasForPlots(plotOptions, plotSiteIds),
                })}
                placeholder="Select plots or sites"
              />
            </div>
            <div data-testid="broker-service-areas-field" style={{ minWidth: 0 }}>
              <div style={{ ...labelStyle, marginBottom: 7 }}>Assigned plot areas</div>
              {form.serviceAreas.length > 0 ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, minHeight: 42, boxSizing: 'border-box', padding: '0.45rem 0.55rem', border: '1px solid var(--border-color)', borderRadius: 9, background: 'var(--subtle-bg, rgba(148,163,184,.08))' }}>
                  <span style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>{form.serviceAreas.length} plot {form.serviceAreas.length === 1 ? 'area' : 'areas'}</span>
                  <button type="button" className="btn-secondary" aria-label={`View assigned plot areas (${form.serviceAreas.length})`} onClick={() => setServiceAreasOpen(true)} style={{ padding: '0.35rem 0.6rem', fontSize: '0.76rem' }}>View</button>
                </div>
              ) : <div style={{ minHeight: 42, display: 'flex', alignItems: 'center', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>Select plots to view their areas.</div>}
            </div>
            <Field label="Commission (%)"><input className="input-field" type="number" min="0" max="100" step="0.01" style={fieldStyle} value={form.commissionPercent} onChange={(event) => setForm({ ...form, commissionPercent: event.target.value })} /></Field>
            <CustomerSelector customerOptions={customerOptions} selectedIds={form.customerIds} onChange={(customerIds) => setForm({ ...form, customerIds })} onView={() => setSelectedCustomersOpen(true)} />
          </>}
          <Field label="Notes" full><textarea className="input-field" maxLength="4000" rows="3" style={fieldStyle} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></Field>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', gridColumn: '1 / -1' }}><input type="checkbox" checked={form.isActive} onChange={(event) => setForm({ ...form, isActive: event.target.checked })} /> Active {config.singular}</label>
        </div>
      </Modal>}
      {serviceAreasOpen && <ServiceAreasDialog serviceAreas={form.serviceAreas} onClose={() => setServiceAreasOpen(false)} />}
      {selectedCustomersOpen && <SelectedCustomersDialog customers={selectedCustomers} onClose={() => setSelectedCustomersOpen(false)} />}
    </div>
  );
}
