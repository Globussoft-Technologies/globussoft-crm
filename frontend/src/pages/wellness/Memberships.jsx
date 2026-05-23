import { useEffect, useState } from 'react';
import { Crown, Plus, Pencil, Trash2, X, Save, IndianRupee, Calendar, Package, AlertCircle, Clock, Download, Upload } from 'lucide-react';
import { fetchApi, getAuthToken } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { formatMoney } from '../../utils/money';
import { AuthContext } from '../../App';
import { useContext } from 'react';

// Empty form. The entitlements field is a non-trivial nested shape:
// an array of { serviceId, quantity } rows. The UI keeps it as a
// simple table — admins add rows by picking a service from the
// catalog and typing a quantity.
const EMPTY_FORM = {
  name: '',
  description: '',
  durationDays: 180,
  price: '',
  currency: 'INR',
  entitlements: [],
};

export default function Memberships() {
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const isAdmin = user?.role === 'ADMIN' || user?.role === 'MANAGER';

  const [plans, setPlans] = useState([]);
  // #816 — Membership-plans CSV import/export. Backend at
  // /api/csv/membership-plans/{export.csv,import.csv} (server.js:679).
  // Mirrors the Services.jsx pattern landed at 41d15f8.
  const [csvBusy, setCsvBusy] = useState(false);
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  // Wave 7D — PRD Gap §4 item 8 — dashboard summary cards. Loaded only when
  // the current user is an admin/manager (the backend gates the endpoint).
  // Set to null on 403 / network error so the cards render gracefully blank.
  const [dashboard, setDashboard] = useState(null);

  const load = () => {
    setLoading(true);
    Promise.all([
      fetchApi('/api/wellness/membership-plans?includeInactive=1').catch(() => []),
      fetchApi('/api/wellness/services').catch(() => []),
      isAdmin
        ? fetchApi('/api/wellness/memberships/dashboard').catch(() => null)
        : Promise.resolve(null),
    ])
      .then(([p, s, d]) => {
        setPlans(Array.isArray(p) ? p : []);
        setServices(Array.isArray(s) ? s : []);
        setDashboard(d && typeof d === 'object' ? d : null);
      })
      .finally(() => setLoading(false));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [isAdmin]);

  const resetForm = () => {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setShowForm(false);
  };

  const startEdit = (plan) => {
    let entitlements = [];
    try {
      entitlements = JSON.parse(plan.entitlements || '[]');
    } catch { entitlements = []; }
    setEditingId(plan.id);
    setForm({
      name: plan.name || '',
      description: plan.description || '',
      durationDays: plan.durationDays || 180,
      price: plan.price ?? '',
      currency: plan.currency || 'INR',
      entitlements,
    });
    setShowForm(true);
  };

  const addEntitlement = () => {
    const used = new Set(form.entitlements.map((e) => e.serviceId));
    const available = services.find((s) => !used.has(s.id) && s.isActive);
    if (!available) {
      notify.error('No more services to add');
      return;
    }
    setForm({ ...form, entitlements: [...form.entitlements, { serviceId: available.id, quantity: 1 }] });
  };

  const removeEntitlement = (idx) => {
    setForm({ ...form, entitlements: form.entitlements.filter((_, i) => i !== idx) });
  };

  const updateEntitlement = (idx, key, value) => {
    const next = [...form.entitlements];
    next[idx] = { ...next[idx], [key]: key === 'quantity' || key === 'serviceId' ? parseInt(value, 10) || 0 : value };
    setForm({ ...form, entitlements: next });
  };

  // #816 — Export membership plans as CSV. fetch+blob trick because plain
  // <a href> can't set the Authorization header. Mirror of Services.jsx
  // pattern (41d15f8).
  const exportCsv = async () => {
    setCsvBusy(true);
    try {
      const token = getAuthToken();
      const res = await fetch('/api/csv/membership-plans/export.csv', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `membership-plans-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      notify.success(`Exported ${plans.length} plan${plans.length === 1 ? '' : 's'}.`);
    } catch (e) {
      notify.error(e.message || 'CSV export failed.');
    } finally {
      setCsvBusy(false);
    }
  };

  const importCsv = async (file) => {
    if (!file) return;
    setCsvBusy(true);
    try {
      const token = getAuthToken();
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/csv/membership-plans/import.csv', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Import failed (${res.status})`);
      const imported = data.imported || 0;
      const skipped = data.skipped || 0;
      const errCount = (data.errors || []).length;
      let msg = `Imported ${imported} plan${imported === 1 ? '' : 's'}`;
      if (skipped) msg += `; skipped ${skipped}`;
      if (errCount) msg += `; ${errCount} row${errCount === 1 ? '' : 's'} with errors (see network response)`;
      notify.success(msg);
      load();
    } catch (e) {
      notify.error(e.message || 'CSV import failed.');
    } finally {
      setCsvBusy(false);
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) {
      notify.error('Plan name is required');
      return;
    }
    if (form.entitlements.length === 0) {
      notify.error('At least one entitlement is required');
      return;
    }
    setSaving(true);
    try {
      const body = {
        name: form.name.trim(),
        description: form.description || null,
        durationDays: parseInt(form.durationDays, 10),
        price: parseFloat(form.price),
        currency: form.currency,
        entitlements: form.entitlements,
      };
      if (editingId) {
        await fetchApi(`/api/wellness/membership-plans/${editingId}`, {
          method: 'PUT',
          body: JSON.stringify(body),
        });
        notify.success(`Updated "${form.name}"`);
      } else {
        await fetchApi('/api/wellness/membership-plans', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        notify.success(`Created "${form.name}"`);
      }
      resetForm();
      load();
    } catch (_err) {
      // fetchApi already toasted the server message
    } finally {
      setSaving(false);
    }
  };

  const softDelete = async (plan) => {
    if (!confirm(`Soft-delete "${plan.name}"? Existing patient memberships keep working until expiry; only new sales are blocked.`)) return;
    try {
      await fetchApi(`/api/wellness/membership-plans/${plan.id}`, { method: 'DELETE' });
      notify.success(`Deactivated "${plan.name}"`);
      load();
    } catch (_err) { /* toasted */ }
  };

  const serviceName = (id) => {
    const s = services.find((x) => x.id === id);
    return s ? s.name : `Service #${id}`;
  };

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Crown size={24} /> Memberships
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            Time-bound packages of services patients buy upfront — track entitlements, redemptions, and revenue.
          </p>
        </div>
        {isAdmin && (
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {/* #816 — CSV Import/Export (mirrors Services.jsx pattern, 41d15f8) */}
            <button
              type="button"
              onClick={exportCsv}
              disabled={csvBusy || plans.length === 0}
              title="Download all membership plans as CSV"
              style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.5rem 0.9rem', background: 'transparent', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: 8, cursor: csvBusy || plans.length === 0 ? 'not-allowed' : 'pointer', opacity: csvBusy || plans.length === 0 ? 0.6 : 1 }}
            >
              <Download size={16} /> Export CSV
            </button>
            <label
              title="Upload membership plans from CSV (same columns as Export)"
              style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.5rem 0.9rem', background: 'transparent', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: 8, cursor: csvBusy ? 'not-allowed' : 'pointer', opacity: csvBusy ? 0.6 : 1 }}
            >
              <Upload size={16} /> Import CSV
              <input
                type="file"
                accept=".csv,text/csv"
                disabled={csvBusy}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) importCsv(file);
                  e.target.value = '';
                }}
                style={{ display: 'none' }}
              />
            </label>
            <button
              onClick={() => (showForm ? resetForm() : setShowForm(true))}
              style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.5rem 1rem', background: 'var(--primary-color, var(--accent-color))', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}
            >
              <Plus size={16} /> {showForm ? 'Cancel' : 'New plan'}
            </button>
          </div>
        )}
      </header>

      {showForm && isAdmin && (
        <form onSubmit={submit} className="glass" style={{ padding: '1.5rem', marginBottom: '1.5rem' }}>
          <h2 style={{ fontSize: '1.1rem', marginBottom: '1rem' }}>{editingId ? 'Edit plan' : 'New membership plan'}</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))', gap: '1rem' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
              <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Name</span>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Gold Facial Pack 10x"
                required
                style={{ padding: '0.5rem', borderRadius: 6, border: '1px solid var(--border-color)', background: 'var(--surface-color)' }}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
              <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Validity (days)</span>
              <input
                type="number"
                value={form.durationDays}
                onChange={(e) => setForm({ ...form, durationDays: e.target.value })}
                min={1}
                max={3650}
                required
                style={{ padding: '0.5rem', borderRadius: 6, border: '1px solid var(--border-color)', background: 'var(--surface-color)' }}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
              <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Price ({form.currency})</span>
              <input
                type="number"
                value={form.price}
                onChange={(e) => setForm({ ...form, price: e.target.value })}
                min={1}
                step="0.01"
                placeholder="15000"
                required
                style={{ padding: '0.5rem', borderRadius: 6, border: '1px solid var(--border-color)', background: 'var(--surface-color)' }}
              />
            </label>
          </div>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', marginTop: '1rem' }}>
            <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Description (optional)</span>
            <textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              rows={2}
              style={{ padding: '0.5rem', borderRadius: 6, border: '1px solid var(--border-color)', background: 'var(--surface-color)' }}
            />
          </label>

          <div style={{ marginTop: '1.5rem' }}>
            <h3 style={{ fontSize: '1rem', marginBottom: '0.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span><Package size={16} style={{ verticalAlign: 'middle', marginRight: 6 }} /> Service entitlements</span>
              <button type="button" onClick={addEntitlement} style={{ padding: '0.3rem 0.75rem', fontSize: '0.85rem', background: 'transparent', border: '1px solid var(--accent-color)', color: 'var(--accent-color)', borderRadius: 6, cursor: 'pointer' }}>
                <Plus size={14} style={{ verticalAlign: 'middle' }} /> Add row
              </button>
            </h3>
            {form.entitlements.length === 0 ? (
              <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', fontStyle: 'italic' }}>Add at least one service + quantity (e.g. Facial × 10).</p>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                    <th style={{ textAlign: 'left', padding: '0.4rem 0' }}>Service</th>
                    <th style={{ textAlign: 'left', padding: '0.4rem 0', width: 120 }}>Quantity</th>
                    <th style={{ width: 60 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {form.entitlements.map((row, idx) => (
                    <tr key={idx} style={{ borderBottom: '1px solid var(--border-color)' }}>
                      <td style={{ padding: '0.4rem 0' }}>
                        <select
                          value={row.serviceId}
                          onChange={(e) => updateEntitlement(idx, 'serviceId', e.target.value)}
                          style={{ width: '100%', padding: '0.4rem', borderRadius: 6, border: '1px solid var(--border-color)', background: 'var(--surface-color)' }}
                        >
                          {services.filter((s) => s.isActive).map((s) => (
                            <option key={s.id} value={s.id}>{s.name}</option>
                          ))}
                        </select>
                      </td>
                      <td style={{ padding: '0.4rem 0' }}>
                        <input
                          type="number"
                          value={row.quantity}
                          onChange={(e) => updateEntitlement(idx, 'quantity', e.target.value)}
                          min={1}
                          style={{ width: 100, padding: '0.4rem', borderRadius: 6, border: '1px solid var(--border-color)', background: 'var(--surface-color)' }}
                        />
                      </td>
                      <td>
                        <button type="button" onClick={() => removeEntitlement(idx)} style={{ background: 'transparent', border: 'none', color: 'var(--danger-color, #ef4444)', cursor: 'pointer' }}>
                          <X size={16} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div style={{ marginTop: '1.5rem', display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
            <button type="button" onClick={resetForm} style={{ padding: '0.5rem 1rem', borderRadius: 6, border: '1px solid var(--border-color)', background: 'transparent', cursor: 'pointer' }}>
              Cancel
            </button>
            <button type="submit" disabled={saving} style={{ padding: '0.5rem 1rem', borderRadius: 6, border: 'none', background: 'var(--primary-color, var(--accent-color))', color: '#fff', cursor: saving ? 'wait' : 'pointer', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
              <Save size={14} /> {saving ? 'Saving…' : 'Save plan'}
            </button>
          </div>
        </form>
      )}

      {/* Wave 7D — dashboard summary cards. Visible to ADMIN/MANAGER only;
          backend already gates /memberships/dashboard so unauthenticated /
          unauthorised callers get null and the cards section short-circuits. */}
      {isAdmin && dashboard && (
        <div
          data-testid="memberships-dashboard-cards"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))',
            gap: '1rem',
            marginBottom: '1.5rem',
          }}
        >
          <div className="glass" style={{ padding: '1.25rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
              <Crown size={16} /> ACTIVE MEMBERSHIPS
            </div>
            <div style={{ fontSize: '1.75rem', fontWeight: 700, marginTop: '0.5rem' }}>{dashboard.active?.count || 0}</div>
            <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
              Deferred revenue: {formatMoney(dashboard.active?.deferredRevenue || 0, 'INR')}
            </div>
          </div>
          <a
            href="/wellness/memberships?expiresWithin=7d"
            className="glass"
            style={{ padding: '1.25rem', textDecoration: 'none', color: 'inherit', display: 'block' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
              <Clock size={16} /> EXPIRING THIS WEEK
            </div>
            <div style={{ fontSize: '1.75rem', fontWeight: 700, marginTop: '0.5rem', color: '#f59e0b' }}>
              {dashboard.expiringThisWeek?.count || 0}
            </div>
            <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
              Active memberships ending in next 7 days
            </div>
          </a>
          <a
            href="/wellness/memberships?status=EXPIRED"
            className="glass"
            style={{ padding: '1.25rem', textDecoration: 'none', color: 'inherit', display: 'block' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
              <AlertCircle size={16} /> EXPIRED
            </div>
            <div style={{ fontSize: '1.75rem', fontWeight: 700, marginTop: '0.5rem', color: '#ef4444' }}>
              {dashboard.expired?.count || 0}
            </div>
            <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
              Memberships past their end date
            </div>
          </a>
        </div>
      )}

      {loading ? (
        <p>Loading membership plans…</p>
      ) : plans.length === 0 ? (
        <div className="glass" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
          No membership plans yet.
          {isAdmin && (
            <span> Click <strong>New plan</strong> above to create one.</span>
          )}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))', gap: '1rem' }}>
          {plans.map((p) => {
            let entitlements = [];
            try { entitlements = JSON.parse(p.entitlements || '[]'); } catch { entitlements = []; }
            return (
              <div key={p.id} className="glass" style={{ padding: '1.25rem', opacity: p.isActive ? 1 : 0.55 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem', marginBottom: '0.5rem' }}>
                  <h3 style={{ fontSize: '1.1rem', fontWeight: 600 }}>{p.name}</h3>
                  {!p.isActive && (
                    <span style={{ fontSize: '0.7rem', padding: '0.15rem 0.4rem', borderRadius: 4, background: '#fee2e2', color: '#991b1b' }}>
                      Inactive
                    </span>
                  )}
                </div>
                {p.description && <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>{p.description}</p>}
                <div style={{ display: 'flex', gap: '1rem', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem' }}>
                    <IndianRupee size={14} /> {formatMoney(p.price, p.currency)}
                  </span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem' }}>
                    <Calendar size={14} /> {p.durationDays} days
                  </span>
                </div>
                <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '0.5rem', fontSize: '0.85rem' }}>
                  <strong style={{ display: 'block', marginBottom: '0.25rem' }}>Includes:</strong>
                  {entitlements.length === 0 ? (
                    <em style={{ color: 'var(--text-secondary)' }}>(no entitlements)</em>
                  ) : (
                    <ul style={{ paddingLeft: '1.2rem', margin: 0 }}>
                      {entitlements.map((e, i) => (
                        <li key={i}>{serviceName(e.serviceId)} × {e.quantity}</li>
                      ))}
                    </ul>
                  )}
                </div>
                {isAdmin && (
                  <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem' }}>
                    <button onClick={() => startEdit(p)} style={{ flex: 1, padding: '0.4rem', borderRadius: 6, border: '1px solid var(--border-color)', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.3rem', fontSize: '0.85rem' }}>
                      <Pencil size={14} /> Edit
                    </button>
                    {p.isActive && (
                      <button onClick={() => softDelete(p)} style={{ padding: '0.4rem 0.75rem', borderRadius: 6, border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--danger-color, #ef4444)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.85rem' }}>
                        <Trash2 size={14} /> Deactivate
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
