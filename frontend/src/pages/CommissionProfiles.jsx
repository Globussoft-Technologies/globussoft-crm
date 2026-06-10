/**
 * CommissionProfiles admin page — PRD Gap §1.5.
 *
 * Tenant-scoped commission rule sets. Each profile pins:
 *   - basis: PER_SERVICE | PER_PRODUCT | REVENUE_PERCENT | FLAT_PER_INVOICE
 *   - either percentage (0..100) OR flatAmount (currency-neutral)
 *   - optional appliesToCategory (Service category filter)
 *   - isActive flag (soft-disable without deletion)
 *
 * Backend: GET/POST/PUT/DELETE /api/staff/commission-profiles
 *
 * Why a separate page (not a Settings tab):
 *   Payroll rules need their own surface so the operator can see them at
 *   a glance — clinics with 5-10 commission tiers don't fit on a sub-tab.
 *   Staff.jsx assigns one profile per user via the existing Edit modal.
 */
import React, { useState, useEffect } from 'react';
import { Plus, Pencil, Trash2, Award, X } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';

const BASIS_OPTIONS = [
  { value: 'PER_SERVICE', label: 'Per service' },
  { value: 'PER_PRODUCT', label: 'Per product' },
  { value: 'REVENUE_PERCENT', label: 'Revenue percent' },
  { value: 'FLAT_PER_INVOICE', label: 'Flat per invoice' },
];

function emptyForm() {
  return {
    name: '',
    percentage: '',
    flatAmount: '',
    basis: 'REVENUE_PERCENT',
    appliesToCategory: '',
    appliesToProduct: '',
    isActive: true,
  };
}

export default function CommissionProfiles() {
  const notify = useNotify();
  const [rows, setRows] = useState([]);
  const [commissionData, setCommissionData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // null | { id?, ...form }
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState('rules'); // 'rules' or 'data'
  const [services, setServices] = useState([]); // services/categories list
  const [products, setProducts] = useState([]); // products list

  const load = async () => {
    setLoading(true);
    try {
      const [profilesData, dataRecords, servicesData, productsData] = await Promise.all([
        fetchApi('/api/staff/commission-profiles'),
        fetchApi('/api/staff/commission-data'),
        fetchApi('/api/wellness/services'), // fetch available services
        fetchApi('/api/wellness/products') // fetch available products
      ]);
      setRows(Array.isArray(profilesData) ? profilesData : []);
      setCommissionData(Array.isArray(dataRecords) ? dataRecords : []);
      setServices(Array.isArray(servicesData) ? servicesData : []);
      setProducts(Array.isArray(productsData) ? productsData : []);
    } catch (err) {
      notify.error(err.message || 'Failed to load commission data.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const openCreate = () => setEditing(emptyForm());
  const openEdit = (row) => setEditing({
    id: row.id,
    name: row.name || '',
    percentage: row.percentage == null ? '' : String(row.percentage),
    flatAmount: row.flatAmount == null ? '' : String(row.flatAmount),
    basis: row.basis || 'REVENUE_PERCENT',
    appliesToCategory: row.appliesToCategory || '',
    appliesToProduct: row.appliesToProduct || '',
    isActive: row.isActive !== false,
  });

  const save = async () => {
    if (!editing) return;
    if (!editing.name.trim()) {
      notify.error('Name is required.');
      return;
    }
    if (!editing.percentage && !editing.flatAmount) {
      notify.error('Either percentage or flat amount must be set.');
      return;
    }
    setSaving(true);
    try {
      const body = {
        name: editing.name.trim(),
        percentage: editing.percentage === '' ? null : Number(editing.percentage),
        flatAmount: editing.flatAmount === '' ? null : Number(editing.flatAmount),
        basis: editing.basis,
        appliesToCategory: editing.appliesToCategory || null,
        appliesToProduct: editing.appliesToProduct || null,
        isActive: editing.isActive,
      };
      if (editing.id) {
        await fetchApi(`/api/staff/commission-profiles/${editing.id}`, {
          method: 'PUT',
          body: JSON.stringify(body),
        });
        notify.success('Commission profile updated.');
      } else {
        await fetchApi('/api/staff/commission-profiles', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        notify.success('Commission profile created.');
      }
      setEditing(null);
      load();
    } catch (err) {
      notify.error(err.message || 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (row) => {
    if (!await notify.confirm({
      title: 'Delete commission profile',
      message: `Delete "${row.name}"? Staff currently assigned to this profile will be unassigned.`,
      confirmText: 'Delete',
      destructive: true,
    })) return;
    try {
      await fetchApi(`/api/staff/commission-profiles/${row.id}`, { method: 'DELETE' });
      notify.success('Profile deleted.');
      load();
    } catch (err) {
      notify.error(err.message || 'Delete failed.');
    }
  };

  return (
    <div style={{ padding: '2rem', height: '100%', overflowY: 'auto' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.75rem', margin: 0 }}>
            <Award size={28} color="var(--primary-color, var(--accent-color))" /> Commission Profiles
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            Per-tenant payroll commission rules. Assign profiles to staff from the Staff Directory.
          </p>
        </div>
        <button
          onClick={openCreate}
          className="btn-primary"
          style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}
        >
          <Plus size={16} /> New profile
        </button>
      </header>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.5rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0' }}>
        <button
          onClick={() => setActiveTab('rules')}
          style={{
            padding: '0.75rem 1rem',
            background: 'transparent',
            border: 'none',
            color: activeTab === 'rules' ? 'var(--primary-color, var(--accent-color))' : 'var(--text-secondary)',
            borderBottom: activeTab === 'rules' ? '2px solid var(--primary-color, var(--accent-color))' : 'none',
            cursor: 'pointer',
            fontWeight: activeTab === 'rules' ? 600 : 400,
            fontSize: '0.95rem',
          }}
        >
          Commission Rules ({rows.length})
        </button>
        <button
          onClick={() => setActiveTab('data')}
          style={{
            padding: '0.75rem 1rem',
            background: 'transparent',
            border: 'none',
            color: activeTab === 'data' ? 'var(--primary-color, var(--accent-color))' : 'var(--text-secondary)',
            borderBottom: activeTab === 'data' ? '2px solid var(--primary-color, var(--accent-color))' : 'none',
            cursor: 'pointer',
            fontWeight: activeTab === 'data' ? 600 : 400,
            fontSize: '0.95rem',
          }}
        >
          Historical Data ({commissionData.length})
        </button>
      </div>

      {/* Rules Tab */}
      {activeTab === 'rules' && (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
            <thead>
              <tr style={{ background: 'rgba(255,255,255,0.04)' }}>
                <th style={th}>Name</th>
                <th style={th}>Basis</th>
                <th style={th}>Percent</th>
                <th style={th}>Flat</th>
                <th style={th}>Category filter</th>
                <th style={th}>Active</th>
                <th style={th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} style={{ ...td, textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>Loading…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={7} style={{ ...td, textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>
                  No commission profiles yet. Click &quot;New profile&quot; to add one.
                </td></tr>
              ) : rows.map((row) => (
                <tr key={row.id} style={{ borderTop: '1px solid var(--border-color)' }} data-testid={`profile-row-${row.id}`}>
                  <td style={{ ...td, fontWeight: 600 }}>{row.name}</td>
                  <td style={td}>{BASIS_OPTIONS.find((b) => b.value === row.basis)?.label || row.basis}</td>
                  <td style={td}>{row.percentage == null ? '—' : `${row.percentage}%`}</td>
                  <td style={td}>{row.flatAmount == null ? '—' : Number(row.flatAmount).toLocaleString()}</td>
                  <td style={td}>{row.appliesToCategory || '—'}</td>
                  <td style={td}>
                    {row.isActive ? (
                      <span style={{ color: '#22c55e', fontWeight: 600 }}>Active</span>
                    ) : (
                      <span style={{ color: 'var(--text-secondary)' }}>Disabled</span>
                    )}
                  </td>
                  <td style={td}>
                    <div style={{ display: 'flex', gap: '0.4rem' }}>
                      <button onClick={() => openEdit(row)} title="Edit" data-testid={`profile-edit-${row.id}`} style={iconBtn('var(--text-primary)')}>
                        <Pencil size={14} />
                      </button>
                      <button onClick={() => remove(row)} title="Delete" data-testid={`profile-delete-${row.id}`} style={iconBtn('#ef4444')}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Data Tab */}
      {activeTab === 'data' && (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
            <thead>
              <tr style={{ background: 'rgba(255,255,255,0.04)' }}>
                <th style={th}>Period</th>
                <th style={th}>Employee</th>
                <th style={th}>Service Revenue</th>
                <th style={th}>Product Revenue</th>
                <th style={th}>Total Sales</th>
                <th style={th}>Discount</th>
                <th style={th}>Net Sales</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} style={{ ...td, textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>Loading…</td></tr>
              ) : commissionData.length === 0 ? (
                <tr><td colSpan={7} style={{ ...td, textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>
                  No commission data available.
                </td></tr>
              ) : commissionData.map((record) => (
                <tr key={record.id} style={{ borderTop: '1px solid var(--border-color)' }}>
                  <td style={{ ...td, fontSize: '0.85rem' }}>
                    {new Date(record.periodStart).toLocaleDateString()} - {new Date(record.periodEnd).toLocaleDateString()}
                  </td>
                  <td style={{ ...td, fontWeight: 500 }}>{record.employeeName}</td>
                  <td style={{ ...td, textAlign: 'right' }}>₹{parseFloat(record.serviceRevenue || 0).toFixed(2)}</td>
                  <td style={{ ...td, textAlign: 'right' }}>₹{parseFloat(record.productRevenue || 0).toFixed(2)}</td>
                  <td style={{ ...td, textAlign: 'right', fontWeight: 600, color: '#fbbf24' }}>₹{parseFloat(record.totalSales || 0).toFixed(2)}</td>
                  <td style={{ ...td, textAlign: 'right', color: '#ef4444' }}>-₹{parseFloat(record.discount || 0).toFixed(2)}</td>
                  <td style={{ ...td, textAlign: 'right', color: '#22c55e' }}>₹{parseFloat(record.netSales || 0).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) setEditing(null); }}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000, padding: '1rem',
          }}
        >
          <div className="card" style={{ width: '100%', maxWidth: 520, padding: '1.5rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600 }}>
                {editing.id ? 'Edit commission profile' : 'New commission profile'}
              </h3>
              <button onClick={() => setEditing(null)} aria-label="Close" style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                <X size={18} />
              </button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <Field label="Name (required)">
                <input
                  type="text"
                  className="input-field"
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  data-testid="profile-form-name"
                  style={{ width: '100%', marginTop: '0.25rem' }}
                />
              </Field>
              <Field label="Basis">
                <select
                  className="input-field"
                  value={editing.basis}
                  onChange={(e) => setEditing({ ...editing, basis: e.target.value })}
                  style={{ width: '100%', marginTop: '0.25rem' }}
                >
                  {BASIS_OPTIONS.map((b) => (
                    <option key={b.value} value={b.value}>{b.label}</option>
                  ))}
                </select>
              </Field>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                <Field label="Percentage (0..100)">
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.001"
                    className="input-field"
                    value={editing.percentage}
                    onChange={(e) => setEditing({ ...editing, percentage: e.target.value })}
                    style={{ width: '100%', marginTop: '0.25rem' }}
                  />
                </Field>
                <Field label="Flat amount">
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    className="input-field"
                    value={editing.flatAmount}
                    onChange={(e) => setEditing({ ...editing, flatAmount: e.target.value })}
                    style={{ width: '100%', marginTop: '0.25rem' }}
                  />
                </Field>
              </div>
              {(editing.basis === 'PER_SERVICE' || editing.basis === 'REVENUE_PERCENT') && (
                <Field label="Service filter (optional)">
                  <select
                    className="input-field"
                    value={editing.appliesToCategory}
                    onChange={(e) => setEditing({ ...editing, appliesToCategory: e.target.value })}
                    style={{ width: '100%', marginTop: '0.25rem' }}
                  >
                    <option value="">All services</option>
                    {services.map((service) => (
                      <option key={service.id} value={service.name}>
                        {service.name}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {(editing.basis === 'PER_PRODUCT' || editing.basis === 'REVENUE_PERCENT') && (
                <Field label="Product filter (optional)">
                  <select
                    className="input-field"
                    value={editing.appliesToProduct}
                    onChange={(e) => setEditing({ ...editing, appliesToProduct: e.target.value })}
                    style={{ width: '100%', marginTop: '0.25rem' }}
                  >
                    <option value="">All products</option>
                    {products.map((product) => (
                      <option key={product.id} value={product.name}>
                        {product.name}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem' }}>
                <input
                  type="checkbox"
                  checked={editing.isActive}
                  onChange={(e) => setEditing({ ...editing, isActive: e.target.checked })}
                />
                Active
              </label>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '1.25rem' }}>
              <button
                onClick={() => setEditing(null)}
                disabled={saving}
                style={{
                  background: 'transparent', color: 'var(--text-secondary)',
                  border: '1px solid var(--border-color)', borderRadius: '6px',
                  padding: '0.4rem 0.9rem', cursor: 'pointer', fontSize: '0.85rem',
                }}
              >
                Cancel
              </button>
              <button
                onClick={save}
                disabled={saving}
                className="btn-primary"
                data-testid="profile-form-save"
                style={{ padding: '0.4rem 0.9rem', fontSize: '0.85rem' }}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
      {label}
      {children}
    </label>
  );
}

function iconBtn(color) {
  return {
    background: 'transparent',
    border: '1px solid var(--border-color)',
    borderRadius: '6px',
    color,
    padding: '0.3rem 0.55rem',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
  };
}

const th = {
  padding: '0.85rem 1rem',
  textAlign: 'left',
  fontSize: '0.78rem',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--text-secondary)',
};
const td = { padding: '0.75rem 1rem', fontSize: '0.875rem' };
