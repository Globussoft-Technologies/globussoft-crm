import { useCallback, useEffect, useMemo, useState } from 'react';
import { Edit2, Phone, Plus, Power, Receipt, UserCheck, Users, X } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import MultiSelectDropdown from '../components/MultiSelectDropdown';
import { validatePersonName, validatePhoneNumber } from '../utils/pickupPlotValidation';

const emptyForm = {
  name: '', phone: '', email: '', password: '', notes: '', isActive: true,
  accountMode: 'create', staffUserId: '', customerIds: [], plotSiteIds: [],
};

export default function BillingPersons() {
  const notify = useNotify();
  const [rows, setRows] = useState([]);
  const [staffUsers, setStaffUsers] = useState([]);
  const [customerOptions, setCustomerOptions] = useState([]);
  const [plotOptions, setPlotOptions] = useState([]);
  const [summary, setSummary] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetchApi('/api/pickup-plot-inventory/billing-persons');
      setRows(Array.isArray(response?.billingPersons) ? response.billingPersons : []);
      setStaffUsers(Array.isArray(response?.staffUsers) ? response.staffUsers : []);
      setCustomerOptions(Array.isArray(response?.customers) ? response.customers : []);
      setPlotOptions(Array.isArray(response?.plots) ? response.plots : []);
      setSummary(response?.summary || {});
    } catch (error) {
      notify.error(error.message || 'Could not load billing persons.');
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => { load(); }, [load]);

  const open = (row = null) => {
    setEditing(row || {});
    setForm(row ? {
      ...emptyForm,
      name: row.user?.name || row.name || '',
      phone: row.user?.phone || row.phone || '',
      email: row.user?.email || row.email || '',
      notes: row.notes || '',
      isActive: row.isActive,
      accountMode: row.user ? 'linked' : 'none',
      staffUserId: row.user?.id || '',
      customerIds: Array.isArray(row.customerIds) ? row.customerIds : [],
      plotSiteIds: Array.isArray(row.plotSiteIds) ? row.plotSiteIds : [],
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
        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8, flex: '1 1 500px', maxWidth: 680 }}>
          <input className="input-field" type="search" aria-label="Search billing persons" placeholder="Search billing persons..." value={search} onChange={(event) => setSearch(event.target.value)} style={{ flex: '1 1 220px' }} />
          <select className="input-field" aria-label="Filter by status" value={status} onChange={(event) => setStatus(event.target.value)} style={{ flex: '0 1 140px' }}>
            <option value="all">All statuses</option><option value="active">Active</option><option value="inactive">Inactive</option>
          </select>
          <button type="button" className="btn-primary" onClick={() => open()}><Plus size={16} /> Add Billing Person</button>
        </div>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 190px), 1fr))', gap: 12, marginBottom: '1.25rem' }}>
        {[
          ['Total records', summary.total || 0, Users],
          ['Active', summary.active || 0, UserCheck],
          ['Linked logins', summary.linked || 0, Receipt],
        ].map(([label, value, Icon]) => <div key={label} className="card" style={{ padding: '1rem' }}><Icon size={18} /><div style={{ color: 'var(--text-secondary)', fontSize: '.76rem', fontWeight: 700, marginTop: 7 }}>{label}</div><div style={{ fontSize: '1.65rem', fontWeight: 800 }}>{value}</div></div>)}
      </div>

      {loading ? <div className="card" style={{ padding: '3rem', textAlign: 'center' }}>Loading billing persons…</div> : (
        <div
          className="card"
          data-testid="billing-directory-table-scroll"
          style={{
            flex: '1 1 0', minHeight: 0, width: '100%', maxWidth: '100%',
            overflowX: 'hidden', overflowY: 'auto', padding: 0, boxSizing: 'border-box',
            scrollbarGutter: 'stable', overscrollBehavior: 'contain',
          }}
        >
          <table aria-label="Billing persons" style={{ width: '100%', minWidth: 0, tableLayout: 'fixed', borderCollapse: 'collapse' }}>
            <thead><tr>{['Name', 'Phone', 'Department', 'Login', 'Notes', 'Status', 'Actions'].map((label) => <th key={label} scope="col" style={{ position: 'sticky', top: 0, zIndex: 2, padding: '.55rem .65rem', borderBottom: '1px solid var(--border-color)', boxShadow: '0 1px 0 var(--border-color)', textAlign: 'left', fontSize: '.74rem', color: 'var(--text-secondary)', overflowWrap: 'anywhere', background: 'linear-gradient(var(--table-header-bg, rgba(148,163,184,.08)), var(--table-header-bg, rgba(148,163,184,.08))), var(--popover-bg, #fff)' }}>{label}</th>)}</tr></thead>
            <tbody>
              {visibleRows.map((row) => <tr key={row.id} style={{ borderBottom: '1px solid var(--border-color)', opacity: row.isActive ? 1 : .68 }}>
                <td style={{ padding: '.55rem .65rem', fontWeight: 800, overflowWrap: 'anywhere' }}>{row.user?.name || row.name}</td>
                <td style={{ padding: '.55rem .65rem', overflowWrap: 'anywhere' }}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Phone size={14} /> {row.user?.phone || row.phone}</span></td>
                <td style={{ padding: '.55rem .65rem' }}>Billing</td>
                <td style={{ padding: '.55rem .65rem', overflowWrap: 'anywhere' }}>{row.user?.email || row.email || 'Not linked'}</td>
                <td style={{ padding: '.55rem .65rem', color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}>{row.notes || '—'}</td>
                <td style={{ padding: '.55rem .65rem' }}><span style={{ display: 'inline-flex', padding: '.2rem .45rem', borderRadius: 6, fontSize: '.7rem', fontWeight: 800, color: row.isActive ? '#047857' : '#64748b', background: row.isActive ? 'rgba(16,185,129,.14)' : 'rgba(100,116,139,.14)' }}>{row.isActive ? 'Active' : 'Inactive'}</span></td>
                <td style={{ padding: '.55rem .65rem' }}><div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}><button type="button" className="btn-secondary" aria-label={`Edit ${row.name}`} title={`Edit ${row.name}`} onClick={() => open(row)} style={{ padding: '.55rem', minWidth: 38, justifyContent: 'center' }}><Edit2 size={14} /></button><button type="button" className="btn-secondary" aria-label={`${row.isActive ? 'Deactivate' : 'Activate'} ${row.name}`} title={`${row.isActive ? 'Deactivate' : 'Activate'} ${row.name}`} onClick={() => toggle(row)} style={{ padding: '.55rem', minWidth: 38, justifyContent: 'center' }}><Power size={14} /></button></div></td>
              </tr>)}
              {visibleRows.length === 0 && <tr><td colSpan="7" style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>No billing persons found.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {editing && <BillingPersonModal form={form} setForm={setForm} editing={editing} staffUsers={staffUsers} customerOptions={customerOptions} plotOptions={plotOptions} saving={saving} onClose={() => setEditing(null)} onSave={save} />}
    </div>
  );
}

function BillingPersonModal({ form, setForm, editing, staffUsers, customerOptions, plotOptions, saving, onClose, onSave }) {
  const field = { width: '100%', marginTop: 5, boxSizing: 'border-box' };
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
            options={customerOptions.map((customer) => ({
              value: Number(customer.id),
              label: [customer.name, customer.company, customer.phone || customer.email].filter(Boolean).join(' · '),
            }))}
            selected={form.customerIds.map(Number)}
            onChange={(customerIds) => setForm({ ...form, customerIds })}
            placeholder="Select customers"
          />
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: '.78rem', fontWeight: 700, marginBottom: 5 }}>Plots / sites</div>
          <MultiSelectDropdown
            ariaLabel="Billing plots / sites (select multiple)"
            searchable
            options={plotOptions.map((plot) => ({ value: Number(plot.id), label: `${plot.name} (${plot.availability})` }))}
            selected={form.plotSiteIds.map(Number)}
            onChange={(plotSiteIds) => setForm({ ...form, plotSiteIds })}
            placeholder="Select plots or sites"
          />
        </div>
        <label style={{ gridColumn: '1/-1' }}>Notes<textarea className="input-field" rows="3" style={field} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label>
        <label style={{ gridColumn: '1/-1' }}><input type="checkbox" checked={form.isActive} onChange={(event) => setForm({ ...form, isActive: event.target.checked })} /> Active billing person</label>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}><button type="button" className="btn-secondary" onClick={onClose}>Cancel</button><button type="button" className="btn-primary" disabled={saving} onClick={onSave}>{saving ? 'Saving…' : 'Save'}</button></div>
    </div>
  </div>;
}
