import { useEffect, useState } from 'react';
import { MapPin, Plus, Trash2, Pencil, UserPlus, Globe, Users } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import GeofencePicker from './GeofencePicker';
import LocationStaffAssignModal from './LocationStaffAssignModal';

/**
 * frontend/src/components/GeofenceZonesPanel.jsx
 *
 * The "Geofencing" tab on the wellness Locations page — standalone
 * geofenced check-in zones, decoupled from any clinic. Renders alongside
 * (not instead of) the existing "Clinic Locations" tab; see
 * pages/wellness/Locations.jsx for the tab strip that switches between them.
 *
 * Why zones are a separate concept from a clinic's own geofence
 *   A clinic Location owns a full business identity — address, patients,
 *   visits, resources. A geofence for "the warehouse" or a one-off training
 *   camp has no business being any of those things, so it isn't a Location
 *   at all: GeofenceZone (backend/prisma/schema.prisma) is a bare pin +
 *   radius, assignable to staff independent of which clinic (if any) they
 *   work at.
 *
 * The Global zone
 *   At most one zone per tenant can be marked Global. It is the fallback
 *   radius applied to any staff member with NO specific assignment at all —
 *   neither a clinic nor a standalone zone (see routes/attendance.js's
 *   resolveGeofenceContext). The moment someone gets a specific assignment,
 *   the Global zone stops applying to them; that person no longer falls
 *   into the "nothing specific" bucket Global exists to catch. Marking a
 *   NEW zone Global here automatically un-marks whichever zone held that
 *   spot before — the backend enforces "exactly one" in a transaction, this
 *   UI just toggles a switch and shows the result.
 *
 * Bulk staff assignment reuses LocationStaffAssignModal with kind="zone" —
 * same roster/selection/mode UI the clinic cards already use, retargeted at
 * the /geofence-zone-assignments/* endpoints.
 */

const DEFAULT_RADIUS_M = 150;
const EMPTY_FORM = { name: '', latitude: '', longitude: '', geofenceRadiusM: String(DEFAULT_RADIUS_M), isGlobal: false };

function toFormValue(zone) {
  return {
    name: zone.name || '',
    latitude: zone.latitude ?? '',
    longitude: zone.longitude ?? '',
    geofenceRadiusM: zone.radiusM ?? DEFAULT_RADIUS_M,
    isGlobal: !!zone.isGlobal,
  };
}

export default function GeofenceZonesPanel() {
  const notify = useNotify();
  const [zones, setZones] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [assigningZone, setAssigningZone] = useState(null);

  const load = () => {
    setLoading(true);
    fetchApi('/api/wellness/geofence-zones')
      .then((rows) => setZones(Array.isArray(rows) ? rows : []))
      .catch(() => setZones([]))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const currentGlobal = zones.find((z) => z.isGlobal);

  const resetForm = () => {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setShowAdd(false);
  };

  const startEdit = (zone) => {
    setEditingId(zone.id);
    setForm(toFormValue(zone));
    setShowAdd(true);
  };

  const submit = async (e) => {
    e.preventDefault();
    const name = form.name.trim();
    if (!name) {
      notify.error('Give this zone a name');
      return;
    }
    if (form.latitude === '' || form.longitude === '') {
      notify.error('Search a place or click the map to set a pin — a zone with no pin has nothing to enforce');
      return;
    }

    // A zone about to become Global silently takes over enforcement for
    // every staff member with no specific clinic/zone of their own — worth
    // a confirm, since the backend applies it the instant "Save" lands.
    if (form.isGlobal && !editingId && currentGlobal) {
      const ok = await notify.confirm({
        title: 'Replace the current Global zone?',
        message: `"${currentGlobal.name}" is currently the Global fallback. Saving "${name}" as Global will replace it — anyone with no specific clinic or zone assignment will switch to this radius immediately.`,
        confirmText: 'Yes, replace it',
        cancelText: 'Cancel',
        destructive: true,
      });
      if (!ok) return;
    } else if (form.isGlobal && editingId && currentGlobal && currentGlobal.id !== editingId) {
      const ok = await notify.confirm({
        title: 'Replace the current Global zone?',
        message: `"${currentGlobal.name}" is currently the Global fallback. Marking "${name}" as Global will replace it.`,
        confirmText: 'Yes, replace it',
        cancelText: 'Cancel',
        destructive: true,
      });
      if (!ok) return;
    }

    const payload = {
      name,
      latitude: Number(form.latitude),
      longitude: Number(form.longitude),
      radiusM: form.geofenceRadiusM === '' ? DEFAULT_RADIUS_M : Math.round(Number(form.geofenceRadiusM)),
      isGlobal: !!form.isGlobal,
    };

    setSaving(true);
    try {
      if (editingId) {
        await fetchApi(`/api/wellness/geofence-zones/${editingId}`, { method: 'PUT', body: JSON.stringify(payload) });
        notify.success(`Updated "${name}"`);
      } else {
        await fetchApi('/api/wellness/geofence-zones', { method: 'POST', body: JSON.stringify(payload) });
        notify.success(`Created "${name}"`);
      }
      resetForm();
      load();
    } catch (_err) {
      /* fetchApi already toasted the server message */
    }
    setSaving(false);
  };

  const deleteZone = async (zone) => {
    // These are independent risks, not one conditioned on the other. A
    // Global zone's OWN assignedCount is people explicitly attached to it —
    // usually low or zero, since Global exists precisely to cover people
    // who have NO explicit assignment. Nesting the Global warning inside
    // "assignedCount > 0" (an earlier version of this code did) meant the
    // single most consequential delete — removing the tenant's fallback —
    // was the one MOST likely to render as a bare "This cannot be undone.".
    const parts = [];
    if (zone.assignedCount > 0) {
      parts.push(
        `${zone.assignedCount} staff member${zone.assignedCount === 1 ? ' is' : 's are'} currently assigned to this zone.`,
      );
    }
    if (zone.isGlobal) {
      parts.push(
        "This is also the tenant's Global fallback zone — deleting it un-fences everyone who has no specific clinic or zone of their own, immediately.",
      );
    }
    const ok = await notify.confirm({
      title: `Delete "${zone.name}"?`,
      message: parts.length > 0 ? parts.join(' ') : 'This cannot be undone.',
      confirmText: 'Delete',
      cancelText: 'Cancel',
      destructive: true,
    });
    if (!ok) return;
    try {
      await fetchApi(`/api/wellness/geofence-zones/${zone.id}`, { method: 'DELETE' });
      notify.success(`Deleted "${zone.name}"`);
      load();
    } catch (_err) {
      /* fetchApi already toasted */
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', maxWidth: '54ch', margin: 0 }}>
          A geofence that isn&apos;t tied to any clinic — draw as many as you need, and assign any
          staff member to any of them. Mark one <strong>Global</strong> to cover everyone who has
          no specific clinic or zone of their own.
        </p>
        <button
          onClick={() => (showAdd ? resetForm() : setShowAdd(true))}
          style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.5rem 1rem', background: 'var(--primary-color, var(--accent-color))', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', flexShrink: 0 }}
        >
          <Plus size={16} /> {showAdd ? 'Cancel' : 'New zone'}
        </button>
      </div>

      {showAdd && (
        <form onSubmit={submit} className="glass" style={{ padding: '1.25rem', marginBottom: '1rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {editingId && (
            <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
              Editing <strong>{form.name}</strong>
            </div>
          )}
          <input
            placeholder="Zone name — e.g. Central Warehouse"
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            style={inputStyle}
          />

          <GeofencePicker
            key={editingId ?? 'new'}
            value={form}
            onChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
            defaultRadiusM={DEFAULT_RADIUS_M}
            minRadiusM={25}
            maxRadiusM={1000}
            radiusStepM={25}
          />

          <label
            style={{
              display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer',
              padding: '0.65rem 0.75rem', borderRadius: 8,
              background: form.isGlobal ? 'rgba(99,102,241,0.1)' : 'rgba(255,255,255,0.03)',
              border: `1px solid ${form.isGlobal ? 'rgba(99,102,241,0.3)' : 'rgba(255,255,255,0.08)'}`,
            }}
          >
            <input
              type="checkbox"
              checked={form.isGlobal}
              onChange={(e) => setForm({ ...form, isGlobal: e.target.checked })}
              style={{ width: 15, height: 15, cursor: 'pointer', flexShrink: 0 }}
            />
            <Globe size={14} color="var(--accent-color)" style={{ flexShrink: 0 }} />
            <span style={{ fontSize: '0.85rem' }}>
              <strong>Make this the Global zone</strong>
              <span style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-secondary)', marginTop: '0.1rem' }}>
                Applies to any staff member with no specific clinic or zone assigned to them.
                {currentGlobal && currentGlobal.id !== editingId && ` Replaces "${currentGlobal.name}", which holds that spot today.`}
              </span>
            </span>
          </label>

          <button type="submit" disabled={saving} style={{ alignSelf: 'flex-start', padding: '0.55rem 1rem', background: 'var(--success-color)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}>
            {saving ? 'Saving…' : (editingId ? 'Save changes' : 'Create zone')}
          </button>
        </form>
      )}

      {loading && <div>Loading…</div>}

      {!loading && zones.length === 0 && (
        <div className="glass" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
          No geofence zones yet. Create one for anything that isn&apos;t a clinic — a warehouse, a
          training center, or a tenant-wide default.
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '1rem' }}>
        {zones.map((zone) => (
          <div key={zone.id} className="glass" style={{ padding: '1.25rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.5rem' }}>
              <h3 style={{ fontSize: '1.05rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.4rem', minWidth: 0 }}>
                <MapPin size={15} color="var(--accent-color)" style={{ flexShrink: 0 }} />
                <span style={{ wordBreak: 'break-word' }}>{zone.name}</span>
              </h3>
              <div style={{ display: 'flex', gap: '0.4rem', flexShrink: 0 }}>
                <button
                  onClick={() => setAssigningZone(zone)}
                  title={`Assign staff to ${zone.name}`}
                  aria-label={`Assign staff to ${zone.name}`}
                  style={iconButtonStyle}
                >
                  <UserPlus size={12} />
                </button>
                <button onClick={() => startEdit(zone)} title="Edit zone" style={iconButtonStyle}>
                  <Pencil size={12} />
                </button>
                <button
                  onClick={() => deleteZone(zone)}
                  title="Delete zone"
                  aria-label={`Delete ${zone.name}`}
                  style={{ ...iconButtonStyle, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#ef4444' }}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', marginBottom: '0.5rem' }}>
              {zone.isGlobal && (
                <span style={{ ...pillStyle, color: 'var(--accent-color)', background: 'rgba(99,102,241,0.12)', border: '1px solid rgba(99,102,241,0.3)' }}>
                  <Globe size={11} /> Global fallback
                </span>
              )}
              <span style={{ ...pillStyle, color: 'var(--success-color)', background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.25)' }}>
                {zone.radiusM}m radius
              </span>
              <button
                onClick={() => setAssigningZone(zone)}
                style={{
                  ...pillStyle,
                  cursor: 'pointer',
                  color: zone.assignedCount === 0 && !zone.isGlobal ? 'var(--warning-color, #f59e0b)' : 'var(--accent-color)',
                  background: zone.assignedCount === 0 && !zone.isGlobal ? 'rgba(245,158,11,0.12)' : 'rgba(99,102,241,0.1)',
                  border: `1px solid ${zone.assignedCount === 0 && !zone.isGlobal ? 'rgba(245,158,11,0.3)' : 'rgba(99,102,241,0.25)'}`,
                }}
              >
                <Users size={11} />
                {zone.assignedCount === 0 && !zone.isGlobal
                  ? 'No staff assigned'
                  : `${zone.assignedCount} staff assigned`}
              </button>
            </div>

            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
              {zone.latitude?.toFixed?.(5)}, {zone.longitude?.toFixed?.(5)}
            </div>
          </div>
        ))}
      </div>

      {assigningZone && (
        <LocationStaffAssignModal
          location={{ id: assigningZone.id, name: assigningZone.name, geofenceRadiusM: assigningZone.radiusM }}
          kind="zone"
          onClose={() => setAssigningZone(null)}
          onSaved={load}
        />
      )}
    </div>
  );
}

const inputStyle = {
  padding: '0.55rem 0.75rem',
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 8,
  color: 'var(--text-primary)',
  fontSize: '0.9rem',
  outline: 'none',
  boxSizing: 'border-box',
};

const iconButtonStyle = {
  background: 'rgba(99,102,241,0.1)',
  border: '1px solid rgba(99,102,241,0.3)',
  color: 'var(--accent-color)',
  padding: '0.25rem 0.45rem',
  borderRadius: 6,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
};

const pillStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.3rem',
  fontSize: '0.7rem',
  padding: '0.15rem 0.5rem',
  borderRadius: 999,
  border: 'none',
  fontFamily: 'inherit',
};
