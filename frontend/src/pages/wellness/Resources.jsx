import { useEffect, useState } from 'react';
import { Box, Plus, Pencil, Trash2 } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';

// Wave 11 Agent GG — admin Resource CRUD page. Resources are bookable rooms /
// machines / equipment surfaced in the Calendar's New Visit modal so a
// receptionist can pin a visit to "Laser Room 1" instead of leaving the
// resource dimension implicit. The booking-conflict gate at
// backend/lib/bookingAvailability.js raises RESOURCE_DOUBLE_BOOKED when
// a second visit lands in the same hour with the same resource.

const TYPES = ['ROOM', 'MACHINE', 'EQUIPMENT'];
const EMPTY_FORM = { name: '', type: 'ROOM', locationId: '', isActive: true };

export default function Resources() {
  const notify = useNotify();
  const [resources, setResources] = useState([]);
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const load = () => {
    setLoading(true);
    Promise.all([
      fetchApi('/api/wellness/resources').catch(() => []),
      fetchApi('/api/wellness/locations').catch(() => []),
    ])
      .then(([r, l]) => {
        setResources(Array.isArray(r) ? r : []);
        setLocations(Array.isArray(l) ? l : []);
      })
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const resetForm = () => {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setShowAdd(false);
  };

  const startEdit = (r) => {
    setEditingId(r.id);
    setForm({
      name: r.name || '',
      type: r.type || 'ROOM',
      locationId: r.locationId || '',
      isActive: r.isActive !== false,
    });
    setShowAdd(true);
  };

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const body = {
        name: form.name,
        type: form.type,
        locationId: form.locationId ? parseInt(form.locationId, 10) : null,
        isActive: form.isActive,
      };
      if (editingId) {
        await fetchApi(`/api/wellness/resources/${editingId}`, { method: 'PUT', body: JSON.stringify(body) });
        notify.success(`Updated "${form.name}"`);
      } else {
        await fetchApi('/api/wellness/resources', { method: 'POST', body: JSON.stringify(body) });
        notify.success(`Created "${form.name}"`);
      }
      resetForm();
      load();
    } catch (_err) { /* fetchApi already toasted */ }
    setSaving(false);
  };

  const remove = async (r) => {
    const ok = await notify.confirm({
      title: 'Delete resource',
      message: `Delete resource "${r.name}"? Existing visits will keep their slot but lose the resource pointer.`,
      confirmText: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await fetchApi(`/api/wellness/resources/${r.id}`, { method: 'DELETE' });
      notify.success(`Deleted "${r.name}"`);
      load();
    } catch (_err) { /* fetchApi already toasted */ }
  };

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Box size={24} /> Resources
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            Bookable rooms, machines, and equipment ({resources.length}) — the calendar guards against same-hour double-booking.
          </p>
        </div>
        <button
          onClick={() => (showAdd ? resetForm() : setShowAdd(true))}
          style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.5rem 1rem', background: 'var(--primary-color, var(--accent-color))', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}
        >
          <Plus size={16} /> {showAdd ? 'Cancel' : 'New resource'}
        </button>
      </header>

      {showAdd && (
        <form onSubmit={submit} className="glass" style={{ padding: '1.25rem', marginBottom: '1rem', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: '0.5rem' }}>
          {editingId && (
            <div style={{ gridColumn: '1 / -1', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
              Editing <strong>{form.name}</strong>
            </div>
          )}
          <input placeholder="Name — e.g. Laser Room 1" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={inputStyle} />
          <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} style={inputStyle}>
            {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <select value={form.locationId} onChange={(e) => setForm({ ...form, locationId: e.target.value })} style={inputStyle}>
            <option value="">— tenant-wide (any clinic) —</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem' }}>
            <input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
            Active (bookable in calendar)
          </label>
          <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
            <button type="button" onClick={resetForm} style={btnSecondary}>Cancel</button>
            <button type="submit" disabled={saving} style={btnPrimary}>{saving ? 'Saving…' : editingId ? 'Update' : 'Create'}</button>
          </div>
        </form>
      )}

      {loading ? <div>Loading…</div> : (
        resources.length === 0 ? (
          <div className="glass" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
            No resources yet. Add a treatment room or machine to surface it in the Calendar's booking modal.
          </div>
        ) : (
          <div className="glass" style={{ padding: '0.5rem', overflow: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                  <th style={th}>Name</th><th style={th}>Type</th><th style={th}>Location</th><th style={th}>Active</th><th style={th}></th>
                </tr>
              </thead>
              <tbody>
                {resources.map((r) => {
                  const loc = locations.find((l) => l.id === r.locationId);
                  return (
                    <tr key={r.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                      <td style={td}>{r.name}</td>
                      <td style={td}>{r.type}</td>
                      <td style={td}>{loc ? loc.name : <span style={{ color: 'var(--text-secondary)' }}>tenant-wide</span>}</td>
                      <td style={td}>{r.isActive ? 'Yes' : 'No'}</td>
                      <td style={{ ...td, textAlign: 'right' }}>
                        <button onClick={() => startEdit(r)} style={iconBtn} aria-label="Edit"><Pencil size={14} /></button>
                        <button onClick={() => remove(r)} style={iconBtn} aria-label="Delete"><Trash2 size={14} /></button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}

const inputStyle = { padding: '0.55rem 0.7rem', borderRadius: 8, border: '1px solid var(--border-color, rgba(255,255,255,0.1))', background: 'transparent', color: 'var(--text-primary)', fontSize: '0.9rem' };
const btnPrimary = { padding: '0.55rem 1.25rem', background: 'var(--primary-color, var(--accent-color))', border: 'none', color: '#fff', borderRadius: 8, cursor: 'pointer', fontWeight: 600 };
const btnSecondary = { padding: '0.55rem 1.25rem', background: 'transparent', border: '1px solid var(--border-color, rgba(255,255,255,0.15))', color: 'var(--text-primary)', borderRadius: 8, cursor: 'pointer' };
const th = { textAlign: 'left', padding: '0.6rem 0.75rem', fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)' };
const td = { padding: '0.6rem 0.75rem', fontSize: '0.85rem' };
const iconBtn = { background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: '0.3rem', marginLeft: '0.25rem' };
