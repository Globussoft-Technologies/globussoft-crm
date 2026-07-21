import { useEffect, useState } from 'react';
import { MapPin, Plus, Phone, Mail, Building2, Pencil, Trash2, Crosshair, ShieldCheck } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import PageHeader from '../../components/PageHeader';

const PHONE_RE = /^\+?[\d\s\-().]{7,15}$/;
// Mirrors backend/lib/attendanceGeofence.js DEFAULT_RADIUS_M — shown as a
// placeholder only; leaving the field blank lets the backend default apply.
const DEFAULT_RADIUS_M = 150;
const EMPTY_FORM = { name: '', addressLine: '', city: '', state: '', pincode: '', phone: '', email: '', latitude: '', longitude: '', geofenceRadiusM: '' };

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
      latitude: loc.latitude ?? '',
      longitude: loc.longitude ?? '',
      geofenceRadiusM: loc.geofenceRadiusM ?? '',
    });
    setShowAdd(true);
  };

  // Fills lat/lng from the browser's current position — lets an admin stand
  // at the clinic's front desk and capture exact coordinates instead of
  // looking them up manually.
  const [locating, setLocating] = useState(false);
  const useCurrentLocation = () => {
    if (!('geolocation' in navigator)) {
      notify.error('Geolocation is not supported by this browser');
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setForm((f) => ({ ...f, latitude: pos.coords.latitude.toFixed(6), longitude: pos.coords.longitude.toFixed(6) }));
        notify.success('Coordinates captured');
        setLocating(false);
      },
      () => {
        notify.error('Could not read current location — check browser permissions');
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  const submit = async (e) => {
    e.preventDefault();
    const phone = (form.phone || '').trim();
    if (phone && !PHONE_RE.test(phone)) {
      notify.error('Enter a valid phone number (digits, +, spaces, hyphens only)');
      return;
    }
    if (form.latitude !== '' && (Number.isNaN(Number(form.latitude)) || Number(form.latitude) < -90 || Number(form.latitude) > 90)) {
      notify.error('Latitude must be a number between -90 and 90');
      return;
    }
    if (form.longitude !== '' && (Number.isNaN(Number(form.longitude)) || Number(form.longitude) < -180 || Number(form.longitude) > 180)) {
      notify.error('Longitude must be a number between -180 and 180');
      return;
    }
    if (form.geofenceRadiusM !== '' && (Number.isNaN(Number(form.geofenceRadiusM)) || Number(form.geofenceRadiusM) <= 0)) {
      notify.error('Geofence radius must be a positive number of meters');
      return;
    }
    const payload = {
      ...form,
      latitude: form.latitude === '' ? null : Number(form.latitude),
      longitude: form.longitude === '' ? null : Number(form.longitude),
      geofenceRadiusM: form.geofenceRadiusM === '' ? null : Math.round(Number(form.geofenceRadiusM)),
    };
    setSaving(true);
    try {
      if (editingId) {
        await fetchApi(`/api/wellness/locations/${editingId}`, { method: 'PUT', body: JSON.stringify(payload) });
        notify.success(`Updated "${form.name}"`);
      } else {
        await fetchApi('/api/wellness/locations', { method: 'POST', body: JSON.stringify(payload) });
        notify.success(`Created "${form.name}"`);
      }
      resetForm();
      load();
    } catch (_err) { /* fetchApi already toasted the server message */ }
    setSaving(false);
  };

  const toggleActive = async (loc) => {
    try {
      await fetchApi(`/api/wellness/locations/${loc.id}`, { method: 'PUT', body: JSON.stringify({ isActive: !loc.isActive }) });
      notify.success(loc.isActive ? `Deactivated "${loc.name}"` : `Activated "${loc.name}"`);
      load();
    } catch (_err) { /* fetchApi already toasted */ }
  };

  const deleteLocation = async (loc) => {
    // Use the styled in-app modal (notify.confirm) instead of the native
    // window.confirm — the browser dialog reads "localhost says…" and
    // looks unprofessional. `destructive: true` switches the primary
    // button to the red-themed style so the irreversible action is
    // visually distinct.
    const ok = await notify.confirm({
      title: `Delete "${loc.name}"?`,
      message: 'This cannot be undone. If any patients or visits are linked to this location, the delete will fail — deactivate it instead.',
      confirmText: 'Delete',
      cancelText: 'Cancel',
      destructive: true,
    });
    if (!ok) return;
    try {
      await fetchApi(`/api/wellness/locations/${loc.id}`, { method: 'DELETE' });
      notify.success(`Deleted "${loc.name}"`);
      load();
    } catch (_err) {
      // fetchApi surfaces the server message verbatim, which for 409
      // LOCATION_IN_USE includes the per-relation counts ("3 record(s)
      // still reference it. Deactivate it instead.") — exactly what the
      // operator needs to know.
    }
  };

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <PageHeader
        icon={Building2}
        title="Clinic locations"
        count={locations.length}
        description={`location${locations.length !== 1 ? 's' : ''} — add new ones as you franchise.`}
      >
        <button onClick={() => (showAdd ? resetForm() : setShowAdd(true))} style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.5rem 1rem', background: 'var(--primary-color, var(--accent-color))', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}>
          <Plus size={16} /> {showAdd ? 'Cancel' : 'New location'}
        </button>
      </PageHeader>

      {showAdd && (
        <form onSubmit={submit} className="glass" style={{ padding: '1.25rem', marginBottom: '1rem', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.5rem' }}>
          {editingId && (
            <div style={{ gridColumn: '1 / -1', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>
              Editing <strong>{form.name}</strong>
            </div>
          )}
          <input placeholder="Short name — e.g. Ranchi" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={inputStyle} />
          <input placeholder="Address — e.g. 12, Main Rd, Lalpur" required value={form.addressLine} onChange={(e) => setForm({ ...form, addressLine: e.target.value })} style={{ ...inputStyle, gridColumn: 'span 2' }} />
          <input placeholder="City — e.g. Ranchi" required value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} style={inputStyle} />
          <input placeholder="State — e.g. Jharkhand" value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} style={inputStyle} />
          {/* #385: Indian PIN codes are exactly 6 digits — pattern + maxLength keep
              this field numeric and bounded; backend re-validates with /^\d{6}$/
              so paste-bypasses still 400 with INVALID_PINCODE. */}
          <input placeholder="Pincode — 6 digits" inputMode="numeric" pattern="\d{6}" maxLength={6} title="Indian pincode is exactly 6 digits" value={form.pincode} onChange={(e) => setForm({ ...form, pincode: e.target.value.replace(/\D/g, '').slice(0, 6) })} style={inputStyle} />
          <input
            placeholder="Phone — e.g. +91 98765 43210"
            type="tel"
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value.replace(/[^\d+\s\-().]/g, '') })}
            style={inputStyle}
          />
          <input placeholder="Email — e.g. clinic@brand.in" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} style={inputStyle} />

          <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem', paddingTop: '0.5rem', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
            <ShieldCheck size={15} color="var(--accent-color)" />
            <strong style={{ fontSize: '0.85rem' }}>Geofenced check-in (optional)</strong>
            <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>— staff assigned to this clinic must be physically nearby to clock in/out</span>
          </div>
          <input
            placeholder="Latitude — e.g. 23.3441"
            inputMode="decimal"
            value={form.latitude}
            onChange={(e) => setForm({ ...form, latitude: e.target.value })}
            style={inputStyle}
          />
          <input
            placeholder="Longitude — e.g. 85.3096"
            inputMode="decimal"
            value={form.longitude}
            onChange={(e) => setForm({ ...form, longitude: e.target.value })}
            style={inputStyle}
          />
          <input
            placeholder={`Radius in meters — default ${DEFAULT_RADIUS_M}`}
            inputMode="numeric"
            value={form.geofenceRadiusM}
            onChange={(e) => setForm({ ...form, geofenceRadiusM: e.target.value.replace(/\D/g, '') })}
            style={inputStyle}
          />
          <button
            type="button"
            onClick={useCurrentLocation}
            disabled={locating}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.35rem', padding: '0.55rem 0.75rem', background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.3)', color: 'var(--accent-color)', borderRadius: 8, cursor: locating ? 'wait' : 'pointer', fontSize: '0.85rem' }}
          >
            <Crosshair size={14} /> {locating ? 'Locating…' : 'Use my current location'}
          </button>
          <div style={{ gridColumn: '1 / -1', fontSize: '0.72rem', color: 'var(--text-secondary)', marginTop: '-0.25rem' }}>
            Leave latitude/longitude blank to skip geofencing for this clinic — staff assigned here can clock in/out from anywhere.
          </div>

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
                <button
                  onClick={() => deleteLocation(loc)}
                  title="Delete location"
                  aria-label={`Delete ${loc.name}`}
                  style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#ef4444', padding: '0.25rem 0.45rem', borderRadius: 6, cursor: 'pointer', display: 'flex', alignItems: 'center' }}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.5rem', lineHeight: 1.4 }}>{loc.addressLine}</p>
            <div style={{ marginBottom: '0.5rem' }}>
              {loc.latitude != null && loc.longitude != null ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.7rem', color: 'var(--success-color)', background: 'rgba(16,185,129,0.1)', padding: '0.15rem 0.5rem', borderRadius: 999 }}>
                  <ShieldCheck size={11} /> Geofenced — {loc.geofenceRadiusM ?? DEFAULT_RADIUS_M}m radius
                </span>
              ) : (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.7rem', color: 'var(--text-secondary)', background: 'rgba(100,100,100,0.1)', padding: '0.15rem 0.5rem', borderRadius: 999 }}>
                  No geofence — clock-in allowed from anywhere
                </span>
              )}
            </div>
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
