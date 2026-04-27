import React, { useEffect, useState } from 'react';
import { MapPin, Plus, Phone, Mail, Building2, Pencil } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';

const EMPTY_FORM = { name: '', addressLine: '', city: '', state: '', pincode: '', phone: '', email: '' };

export default function Locations() {
  const notify = useNotify();
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const load = () => {
    setLoading(true);
    fetchApi('/api/wellness/locations').then(setLocations).catch(() => setLocations([])).finally(() => setLoading(false));
  };
  useEffect(load, []);

  const resetForm = () => {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setShowAdd(false);
  };

  const startEdit = (loc) => {
    setEditingId(loc.id);
    setForm({
      name: loc.name || '',
      addressLine: loc.addressLine || '',
      city: loc.city || '',
      state: loc.state || '',
      pincode: loc.pincode || '',
      phone: loc.phone || '',
      email: loc.email || '',
    });
    setShowAdd(true);
  };

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      if (editingId) {
        await fetchApi(`/api/wellness/locations/${editingId}`, { method: 'PUT', body: JSON.stringify(form) });
      } else {
        await fetchApi('/api/wellness/locations', { method: 'POST', body: JSON.stringify(form) });
      }
      resetForm();
      load();
    } catch (err) { notify.error(`Failed: ${err.message}`); }
    setSaving(false);
  };

  const toggleActive = async (loc) => {
    try {
      await fetchApi(`/api/wellness/locations/${loc.id}`, { method: 'PUT', body: JSON.stringify({ isActive: !loc.isActive }) });
      load();
    } catch (err) { notify.error(`Failed: ${err.message}`); }
  };

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Building2 size={24} /> Clinic locations
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            {locations.length} location{locations.length !== 1 ? 's' : ''} — add new ones as you franchise.
          </p>
        </div>
        <button onClick={() => (showAdd ? resetForm() : setShowAdd(true))} style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.5rem 1rem', background: 'var(--accent-color)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}>
          <Plus size={16} /> {showAdd ? 'Cancel' : 'New location'}
        </button>
      </header>

      {showAdd && (
        <form onSubmit={submit} className="glass" style={{ padding: '1.25rem', marginBottom: '1rem', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.5rem' }}>
          {editingId && (
            <div style={{ gridColumn: '1 / -1', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>
              Editing <strong>{form.name}</strong>
            </div>
          )}
          <input placeholder="Short name (e.g. Ranchi)" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={inputStyle} />
          <input placeholder="Address" required value={form.addressLine} onChange={(e) => setForm({ ...form, addressLine: e.target.value })} style={{ ...inputStyle, gridColumn: 'span 2' }} />
          <input placeholder="City" required value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} style={inputStyle} />
          <input placeholder="State" value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} style={inputStyle} />
          <input placeholder="Pincode" value={form.pincode} onChange={(e) => setForm({ ...form, pincode: e.target.value })} style={inputStyle} />
          <input placeholder="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} style={inputStyle} />
          <input placeholder="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} style={inputStyle} />
          <button type="submit" disabled={saving} style={{ padding: '0.55rem 1rem', background: 'var(--success-color)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}>
            {saving ? 'Saving…' : (editingId ? 'Save changes' : 'Save location')}
          </button>
        </form>
      )}

      {loading && <div>Loading…</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '1rem' }}>
        {locations.map((loc) => (
          <div key={loc.id} className="glass" style={{ padding: '1.25rem', opacity: loc.isActive ? 1 : 0.55 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.5rem' }}>
              <div>
                <h3 style={{ fontSize: '1.1rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <MapPin size={16} color="var(--accent-color)" /> {loc.name}
                </h3>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '0.15rem' }}>
                  {loc.city}{loc.state ? `, ${loc.state}` : ''} {loc.pincode ? `— ${loc.pincode}` : ''}
                </div>
              </div>
              <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                <button
                  onClick={() => startEdit(loc)}
                  title="Edit location"
                  style={{ background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.3)', color: 'var(--accent-color)', padding: '0.25rem 0.45rem', borderRadius: 6, cursor: 'pointer', display: 'flex', alignItems: 'center' }}
                >
                  <Pencil size={12} />
                </button>
                <button
                  onClick={() => toggleActive(loc)}
                  style={{ background: loc.isActive ? 'rgba(16,185,129,0.1)' : 'rgba(100,100,100,0.1)', border: `1px solid ${loc.isActive ? 'rgba(16,185,129,0.3)' : 'rgba(100,100,100,0.3)'}`, color: loc.isActive ? 'var(--success-color)' : 'var(--text-secondary)', padding: '0.2rem 0.5rem', borderRadius: 6, fontSize: '0.7rem', cursor: 'pointer', textTransform: 'uppercase', fontWeight: 600 }}
                >
                  {loc.isActive ? 'Active' : 'Inactive'}
                </button>
              </div>
            </div>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.5rem', lineHeight: 1.4 }}>{loc.addressLine}</p>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
              {loc.phone && <span><Phone size={12} style={{ verticalAlign: 'middle' }} /> {loc.phone}</span>}
              {loc.email && <span><Mail size={12} style={{ verticalAlign: 'middle' }} /> {loc.email}</span>}
            </div>
          </div>
        ))}

        {!loading && locations.length === 0 && (
          <div className="glass" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)', gridColumn: '1 / -1' }}>
            No locations yet. Add one to start tracking per-clinic metrics.
          </div>
        )}
      </div>
    </div>
  );
}

const inputStyle = { padding: '0.55rem 0.75rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, color: 'var(--text-primary)', fontSize: '0.9rem', outline: 'none' };
