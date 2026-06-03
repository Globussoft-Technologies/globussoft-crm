// Wave 11 Agent HH — Inventory Vendor admin page.
// Lets admins/managers maintain the supplier master used by InventoryReceipt.

import { useEffect, useMemo, useState } from 'react';
import { Truck, Plus, Pencil, Trash2, Archive, ArchiveRestore, Search } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import PageHeader from '../../components/PageHeader';

const EMPTY = { name: '', contactPerson: '', phone: '', email: '', gstin: '', addressLine: '', isActive: true };

const FILTERS = [
  { key: 'active', label: 'Active' },
  { key: 'archived', label: 'Archived' },
  { key: 'all', label: 'All' },
];

export default function Vendors() {
  const notify = useNotify();
  const [vendors, setVendors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [statusFilter, setStatusFilter] = useState('active');
  const [searchQuery, setSearchQuery] = useState('');

  const load = () => {
    setLoading(true);
    fetchApi('/api/wellness/vendors')
      .then((data) => setVendors(Array.isArray(data) ? data : []))
      .catch(() => setVendors([]))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const reset = () => { setForm(EMPTY); setEditingId(null); setShowForm(false); };
  const startEdit = (v) => {
    setEditingId(v.id);
    setForm({
      name: v.name || '',
      contactPerson: v.contactPerson || '',
      phone: v.phone || '',
      email: v.email || '',
      gstin: v.gstin || '',
      addressLine: v.addressLine || '',
      isActive: v.isActive !== false,
    });
    setShowForm(true);
  };

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      if (editingId) {
        await fetchApi(`/api/wellness/vendors/${editingId}`, { method: 'PUT', body: JSON.stringify(form) });
        notify.success(`Updated "${form.name}"`);
      } else {
        await fetchApi('/api/wellness/vendors', { method: 'POST', body: JSON.stringify(form) });
        notify.success(`Created "${form.name}"`);
      }
      reset();
      load();
    } catch (_err) { /* toasted */ }
    setSaving(false);
  };

  const setArchived = async (v, archived) => {
    const verb = archived ? 'Archive' : 'Restore';
    const ok = await notify.confirm({
      title: `${verb} vendor`,
      message: `${verb} vendor "${v.name}"?`,
      confirmText: verb,
      destructive: archived,
    });
    if (!ok) return;
    try {
      await fetchApi(`/api/wellness/vendors/${v.id}`, {
        method: 'PUT',
        body: JSON.stringify({ isActive: !archived }),
      });
      notify.success(archived ? `Archived "${v.name}"` : `Restored "${v.name}"`);
      load();
    } catch (_err) { /* toasted */ }
  };

  const remove = async (v) => {
    const ok = await notify.confirm({
      title: 'Delete vendor',
      message: `Delete vendor "${v.name}"? Vendors with prior receipts will be archived instead.`,
      confirmText: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await fetchApi(`/api/wellness/vendors/${v.id}`, { method: 'DELETE' });
      notify.success(`Removed "${v.name}"`);
      load();
    } catch (_err) { /* toasted */ }
  };

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return vendors.filter((v) => {
      if (statusFilter === 'active' && v.isActive === false) return false;
      if (statusFilter === 'archived' && v.isActive !== false) return false;
      if (!q) return true;
      return [v.name, v.contactPerson, v.phone, v.email, v.gstin]
        .some((f) => f && String(f).toLowerCase().includes(q));
    });
  }, [vendors, statusFilter, searchQuery]);

  const counts = useMemo(() => ({
    active: vendors.filter((v) => v.isActive !== false).length,
    archived: vendors.filter((v) => v.isActive === false).length,
    all: vendors.length,
  }), [vendors]);

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <PageHeader
        icon={Truck}
        title="Vendors"
        description={`${counts.active} active${counts.archived > 0 ? `, ${counts.archived} archived` : ''} — used when recording inventory receipts.`}
      >
        <button onClick={() => (showForm ? reset() : setShowForm(true))} style={primaryBtnStyle}>
          <Plus size={16} /> {showForm ? 'Cancel' : 'New vendor'}
        </button>
      </PageHeader>

      {showForm && (
        <form onSubmit={submit} className="glass" style={{ padding: '1.25rem', marginBottom: '1rem', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))', gap: '0.5rem' }}>
          <input placeholder="Name — e.g. Sterile Supplies Pvt Ltd" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={inputStyle} />
          <input placeholder="Contact person" value={form.contactPerson} onChange={(e) => setForm({ ...form, contactPerson: e.target.value })} style={inputStyle} />
          <input placeholder="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} style={inputStyle} />
          <input placeholder="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} style={inputStyle} />
          <input placeholder="GSTIN (15 chars)" maxLength={15} value={form.gstin} onChange={(e) => setForm({ ...form, gstin: e.target.value.toUpperCase() })} style={inputStyle} />
          <input placeholder="Address" value={form.addressLine} onChange={(e) => setForm({ ...form, addressLine: e.target.value })} style={{ ...inputStyle, gridColumn: 'span 2' }} />
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.9rem' }}>
            <input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
            Active
          </label>
          <button type="submit" disabled={saving} style={{ ...primaryBtnStyle, gridColumn: '1 / -1' }}>
            {saving ? 'Saving…' : editingId ? 'Save changes' : 'Create vendor'}
          </button>
        </form>
      )}

      <div className="glass" style={{ padding: '0.85rem 1rem', marginBottom: '1rem', display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ position: 'relative', flex: '1 1 260px', maxWidth: 360 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)', pointerEvents: 'none' }} />
          <input
            type="search"
            placeholder="Search by name, contact, phone, email, GSTIN…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{ ...inputStyle, width: '100%', paddingLeft: 30 }}
          />
        </div>
        <div role="tablist" aria-label="Vendor status filter" style={{ display: 'inline-flex', gap: '0.25rem', padding: 3, border: '1px solid var(--border-color)', borderRadius: 8 }}>
          {FILTERS.map((f) => {
            const selected = statusFilter === f.key;
            return (
              <button
                key={f.key}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => setStatusFilter(f.key)}
                style={selected ? pillActiveStyle : pillStyle}
              >
                {f.label} <span style={{ opacity: 0.7, marginLeft: 4, fontSize: '0.78rem' }}>{counts[f.key]}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="glass" style={{ padding: '0.5rem 0' }}>
        {loading ? (
          <div style={{ padding: '1rem', color: 'var(--text-secondary)' }}>Loading…</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: '1rem', color: 'var(--text-secondary)' }}>
            {vendors.length === 0
              ? 'No vendors yet.'
              : searchQuery
                ? `No vendors match "${searchQuery}" in ${statusFilter === 'all' ? 'any status' : statusFilter}.`
                : `No ${statusFilter} vendors.`}
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border-color)' }}>
                <th style={cellStyle}>Name</th>
                <th style={cellStyle}>Contact</th>
                <th style={cellStyle}>Phone</th>
                <th style={cellStyle}>GSTIN</th>
                <th style={cellStyle}>Status</th>
                <th style={cellStyle}></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((v) => {
                const archived = v.isActive === false;
                return (
                  <tr key={v.id} style={{ borderBottom: '1px solid var(--border-color)', opacity: archived ? 0.65 : 1 }}>
                    <td style={cellStyle}>{v.name}</td>
                    <td style={cellStyle}>{v.contactPerson || '—'}</td>
                    <td style={cellStyle}>{v.phone || '—'}</td>
                    <td style={cellStyle}>{v.gstin || '—'}</td>
                    <td style={cellStyle}>
                      <span style={archived ? archivedBadgeStyle : activeBadgeStyle}>
                        {archived ? 'Archived' : 'Active'}
                      </span>
                    </td>
                    <td style={{ ...cellStyle, textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button onClick={() => startEdit(v)} style={iconBtnStyle} aria-label={`Edit ${v.name}`} title="Edit"><Pencil size={14} /></button>
                      {archived ? (
                        <button onClick={() => setArchived(v, false)} style={iconBtnStyle} aria-label={`Restore ${v.name}`} title="Restore"><ArchiveRestore size={14} /></button>
                      ) : (
                        <button onClick={() => setArchived(v, true)} style={iconBtnStyle} aria-label={`Archive ${v.name}`} title="Archive"><Archive size={14} /></button>
                      )}
                      <button onClick={() => remove(v)} style={iconBtnStyle} aria-label={`Delete ${v.name}`} title="Delete"><Trash2 size={14} /></button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

const inputStyle = { padding: '0.55rem 0.75rem', border: '1px solid var(--border-color)', borderRadius: 6, fontSize: '0.9rem', minWidth: 0, background: 'transparent', color: 'inherit' };
const primaryBtnStyle = { display: 'inline-flex', alignItems: 'center', gap: '0.3rem', padding: '0.55rem 1rem', background: 'var(--primary-color, var(--accent-color))', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' };
const cellStyle = { padding: '0.6rem 0.85rem', fontSize: '0.9rem' };
const iconBtnStyle = { background: 'transparent', border: 'none', cursor: 'pointer', padding: '0.25rem 0.4rem', color: 'var(--text-secondary)' };
const pillStyle = { padding: '0.35rem 0.75rem', background: 'transparent', color: 'var(--text-secondary)', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '0.85rem' };
const pillActiveStyle = { ...pillStyle, background: 'var(--primary-color, var(--accent-color))', color: '#fff' };
const activeBadgeStyle = { display: 'inline-block', padding: '0.15rem 0.55rem', borderRadius: 999, fontSize: '0.75rem', background: 'rgba(34,197,94,0.15)', color: '#22c55e', border: '1px solid rgba(34,197,94,0.35)' };
const archivedBadgeStyle = { display: 'inline-block', padding: '0.15rem 0.55rem', borderRadius: 999, fontSize: '0.75rem', background: 'rgba(148,163,184,0.15)', color: 'var(--text-secondary)', border: '1px solid var(--border-color)' };
