import { useEffect, useMemo, useState } from 'react';
import { X, Search, Users, ShieldCheck, ShieldAlert, AlertTriangle, Check } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';

/**
 * frontend/src/components/LocationStaffAssignModal.jsx
 *
 * Bulk "who is covered by this geofence" editor, opened from a card on the
 * wellness Locations page — for a clinic (kind='location') or a standalone
 * GeofenceZone (kind='zone').
 *
 * Why this exists
 *   Drawing a geofence is only half the job — a geofence with nobody assigned
 *   to it enforces nothing (see backend/lib/attendanceGeofence.js: a user with
 *   no UserLocation rows is deliberately NOT enforced). Until now the only way
 *   to attach staff was the Staff page's per-person edit modal, one person at
 *   a time, through a form that also edits their role and password. For a
 *   twenty-person clinic that is twenty round trips through the wrong screen.
 *
 * Data
 *   GET  {rosterUrl}   → { location, geofenceActive, staff: [{ ...,
 *                          assignedHere, otherLocationCount }] }
 *   POST {bulkUrl}     → { locationId, userIds, mode }
 *
 *   The roster comes from a dedicated endpoint rather than GET /api/staff on
 *   purpose: the staff route masks numeric ids for some viewers, and a
 *   picker built on masked ids cannot post back a usable userId.
 *
 *   `kind` picks which pair of endpoints this instance talks to:
 *     'location' (default) — /api/wellness/location-assignments/{by-location,bulk}
 *                             clinic Locations, body key `locationId`.
 *     'zone'                — /api/wellness/geofence-zone-assignments/{by-zone,bulk}
 *                             standalone GeofenceZones, body key `zoneId`.
 *   Both endpoint pairs return the identical response envelope on purpose
 *   (see routes/wellness_geofence_zones.js) — that symmetry is what lets one
 *   component drive both without a shape-translation layer.
 *
 * The three modes are genuinely different operations, not a preference:
 *   add     — attach this {clinic|zone}, leave their others alone (default,
 *             and the only non-destructive one).
 *   replace — this becomes their ONLY one of this kind; every other
 *             assignment OF THE SAME KIND for the selected people is
 *             deleted. Guarded by an explicit count of what will be lost.
 *             A "replace" on a zone never touches clinic assignments, and
 *             vice versa — they are independent assignment types.
 *   remove  — detach this one. Anyone left with nothing at all (no clinic
 *             AND no zone) stops being geofenced entirely — unless the
 *             tenant has a Global zone, in which case they fall back to
 *             that. The footer states the un-fencing risk outright because
 *             it is the opposite of what "remove from geofence" sounds like.
 *
 * Props
 *   location: { id, name, city, latitude, longitude, geofenceRadiusM } — the
 *             clinic OR zone being assigned. Kept as `location` (not
 *             renamed to `subject`) so the original clinic call site and its
 *             existing tests need zero changes.
 *   kind:     'location' | 'zone' — default 'location'.
 *   onClose():        dismiss
 *   onSaved():        called after a successful write so the parent can reload
 */

const NOUN = { location: 'clinic', zone: 'zone' };

function buildModes(noun) {
  return [
    {
      key: 'add',
      label: `Add to this ${noun}`,
      hint: `Keeps any other ${noun}s they are already assigned to.`,
      cta: (n) => `Assign ${n} staff`,
    },
    {
      key: 'replace',
      label: `Make this their only ${noun}`,
      hint: `Removes every other ${noun} assignment for the people you select.`,
      cta: (n) => `Set as only ${noun} for ${n}`,
    },
    {
      key: 'remove',
      label: `Remove from this ${noun}`,
      hint: `Detaches this ${noun} only.`,
      cta: (n) => `Remove ${n} from ${noun}`,
    },
  ];
}

export default function LocationStaffAssignModal({ location, kind = 'location', onClose, onSaved }) {
  const notify = useNotify();
  const noun = NOUN[kind] || NOUN.location;
  const MODES = useMemo(() => buildModes(noun), [noun]);
  const rosterUrl = kind === 'zone'
    ? `/api/wellness/geofence-zone-assignments/by-zone/${location?.id}`
    : `/api/wellness/location-assignments/by-location/${location?.id}`;
  const bulkUrl = kind === 'zone'
    ? '/api/wellness/geofence-zone-assignments/bulk'
    : '/api/wellness/location-assignments/bulk';
  const bulkIdKey = kind === 'zone' ? 'zoneId' : 'locationId';

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [staff, setStaff] = useState([]);
  const [geofenceActive, setGeofenceActive] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState('add');
  const [showInactive, setShowInactive] = useState(false);

  useEffect(() => {
    if (!location?.id) return;
    setLoading(true);
    fetchApi(rosterUrl)
      .then((data) => {
        const rows = Array.isArray(data?.staff) ? data.staff : [];
        setStaff(rows);
        setGeofenceActive(!!data?.geofenceActive);
        // Pre-tick whoever is already here. The modal then reads as "this is
        // the current roster, change it" rather than an empty form that
        // silently hides the existing state.
        setSelected(new Set(rows.filter((r) => r.assignedHere).map((r) => r.id)));
      })
      .catch(() => setStaff([]))
      .finally(() => setLoading(false));
  }, [location?.id, rosterUrl]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return staff.filter((s) => {
      if (!showInactive && s.deactivatedAt) return false;
      if (!q) return true;
      return (
        (s.name || '').toLowerCase().includes(q)
        || (s.email || '').toLowerCase().includes(q)
        || (s.wellnessRole || '').toLowerCase().includes(q)
      );
    });
  }, [staff, query, showInactive]);

  const inactiveCount = useMemo(
    () => staff.filter((s) => s.deactivatedAt).length,
    [staff],
  );

  // For "replace", the number of OTHER assignments about to be deleted. This
  // is the only number that tells an admin what the destructive mode costs.
  const collateral = useMemo(() => {
    if (mode !== 'replace') return 0;
    return staff
      .filter((s) => selected.has(s.id))
      .reduce((sum, s) => sum + (s.otherLocationCount || 0), 0);
  }, [mode, staff, selected]);

  // For "remove", who ends up with NO {clinic|zone} of this kind left at
  // all — i.e. stops being geofenced (barring a tenant Global zone, which
  // this modal has no visibility into). Counter-intuitive enough to deserve
  // its own warning.
  const willBeUnfenced = useMemo(() => {
    if (mode !== 'remove') return 0;
    return staff.filter(
      (s) => selected.has(s.id) && s.assignedHere && (s.otherLocationCount || 0) === 0,
    ).length;
  }, [mode, staff, selected]);

  const toggle = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const allVisibleSelected = visible.length > 0 && visible.every((s) => selected.has(s.id));
  const toggleAllVisible = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      // Operates on the FILTERED list only — "select all" while a search is
      // active must not quietly tick the hundred people scrolled out of view.
      if (allVisibleSelected) visible.forEach((s) => next.delete(s.id));
      else visible.forEach((s) => next.add(s.id));
      return next;
    });
  };

  const submit = async () => {
    const userIds = [...selected];
    if (userIds.length === 0) {
      notify.error('Select at least one staff member');
      return;
    }
    if (mode === 'replace' && collateral > 0) {
      const ok = await notify.confirm({
        title: `Remove their other ${noun}s?`,
        message: `${collateral} other ${noun} assignment${collateral === 1 ? '' : 's'} across the ${userIds.length} selected staff will be deleted. They will only be able to clock in at ${location.name}.`,
        confirmText: `Yes, make this their only ${noun}`,
        cancelText: 'Cancel',
        destructive: true,
      });
      if (!ok) return;
    }
    if (mode === 'remove' && willBeUnfenced > 0) {
      const ok = await notify.confirm({
        title: 'Leave them with no geofence?',
        message: `${willBeUnfenced} of the selected staff have no other ${noun}. Removing this one means they will be able to clock in from anywhere${kind === 'zone' ? ' (unless a tenant-wide Global zone applies)' : ''}, not that they will be blocked.`,
        confirmText: 'Remove anyway',
        cancelText: 'Cancel',
        destructive: true,
      });
      if (!ok) return;
    }

    setSaving(true);
    try {
      const res = await fetchApi(bulkUrl, {
        method: 'POST',
        body: JSON.stringify({ [bulkIdKey]: location.id, userIds, mode }),
      });
      const bits = [];
      if (res.added) bits.push(`${res.added} assigned`);
      if (res.removed) bits.push(`${res.removed} removed`);
      if (res.clearedElsewhere) bits.push(`${res.clearedElsewhere} other assignment${res.clearedElsewhere === 1 ? '' : 's'} cleared`);
      if (res.unchanged) bits.push(`${res.unchanged} already assigned`);
      notify.success(bits.length ? `${location.name}: ${bits.join(', ')}` : 'No changes were needed');

      // Reporting success on a rule that can never fire is worse than
      // silence — a location with no coordinates fails open on every punch.
      // (Zones always have coordinates — see wellness_geofence_zones.js's
      // validateZoneBody — so geofenceActive is only ever false here for a
      // clinic Location, but the guard costs nothing to keep generic.)
      if (!res.geofenceActive && mode !== 'remove') {
        notify.info(`${location.name} has no coordinates yet, so check-in is not actually restricted. Set a pin on it to enforce it.`);
      }
      onSaved?.();
      onClose?.();
    } catch (_err) {
      /* fetchApi already surfaced the server message */
    }
    setSaving(false);
  };

  const activeMode = MODES.find((m) => m.key === mode);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="assign-staff-title"
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: '1rem',
      }}
    >
      <div
        className="glass"
        style={{
          width: 'min(660px, 100%)',
          maxHeight: '86vh',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: 14,
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{ padding: '1rem 1.15rem', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.75rem' }}>
            <div style={{ minWidth: 0 }}>
              <h3 id="assign-staff-title" style={{ fontSize: '1.05rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <Users size={16} color="var(--accent-color)" /> Assign staff to {location?.name}
              </h3>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.2rem' }}>
                Staff assigned here must be inside the geofence to clock in or out.
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: 4 }}
            >
              <X size={18} />
            </button>
          </div>

          {!loading && (
            geofenceActive ? (
              <div style={{ ...bannerStyle, background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.25)', color: 'var(--success-color)' }}>
                <ShieldCheck size={14} style={{ flexShrink: 0 }} />
                <span>
                  Geofence is active — {location?.geofenceRadiusM ?? 150} m around the pin.
                </span>
              </div>
            ) : (
              <div style={{ ...bannerStyle, background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.28)', color: 'var(--warning-color, #f59e0b)' }}>
                <ShieldAlert size={14} style={{ flexShrink: 0 }} />
                <span>
                  This {noun} has no pin yet, so assigning staff will <strong>not</strong> restrict
                  check-in. Set it on the map first, then the assignment starts enforcing.
                </span>
              </div>
            )
          )}
        </div>

        {/* Controls */}
        <div style={{ padding: '0.75rem 1.15rem', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
          <div style={{ position: 'relative' }}>
            <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)', pointerEvents: 'none' }} />
            <input
              type="text"
              placeholder="Filter by name, email or role"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ ...inputStyle, width: '100%', paddingLeft: '2rem' }}
            />
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
            {MODES.map((m) => (
              <button
                key={m.key}
                type="button"
                onClick={() => setMode(m.key)}
                aria-pressed={mode === m.key}
                style={{
                  fontSize: '0.75rem',
                  padding: '0.35rem 0.7rem',
                  borderRadius: 999,
                  cursor: 'pointer',
                  border: `1px solid ${mode === m.key ? 'transparent' : 'rgba(255,255,255,0.14)'}`,
                  background: mode === m.key
                    ? (m.key === 'remove' ? '#ef4444' : 'var(--primary-color, var(--accent-color))')
                    : 'transparent',
                  color: mode === m.key ? '#fff' : 'var(--text-secondary)',
                  fontWeight: mode === m.key ? 600 : 400,
                }}
              >
                {m.label}
              </button>
            ))}
          </div>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>{activeMode?.hint}</div>
        </div>

        {/* Roster */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '0.5rem 0.65rem' }}>
          {loading && <div style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Loading staff…</div>}

          {!loading && visible.length === 0 && (
            <div style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
              {query.trim() ? 'No staff match that filter.' : 'No staff found for this tenant.'}
            </div>
          )}

          {!loading && visible.length > 0 && (
            <>
              <button
                type="button"
                onClick={toggleAllVisible}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '0.45rem 0.6rem',
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--accent-color)',
                  cursor: 'pointer',
                  fontSize: '0.76rem',
                  fontWeight: 600,
                }}
              >
                {allVisibleSelected ? 'Clear' : 'Select'} all {visible.length} shown
              </button>

              {visible.map((s) => {
                const on = selected.has(s.id);
                return (
                  <label
                    key={s.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.6rem',
                      padding: '0.5rem 0.6rem',
                      borderRadius: 8,
                      cursor: 'pointer',
                      background: on ? 'rgba(99,102,241,0.1)' : 'transparent',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => toggle(s.id)}
                      aria-label={`Select ${s.name || s.email}`}
                      style={{ width: 15, height: 15, cursor: 'pointer', flexShrink: 0 }}
                    />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: '0.86rem', display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 500 }}>{s.name || s.email}</span>
                        {s.assignedHere && (
                          <span style={chipStyle('rgba(16,185,129,0.14)', 'var(--success-color)')}>
                            <Check size={10} /> already here
                          </span>
                        )}
                        {s.deactivatedAt && (
                          <span style={chipStyle('rgba(100,100,100,0.16)', 'var(--text-secondary)')}>inactive</span>
                        )}
                      </div>
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', wordBreak: 'break-word' }}>
                        {s.email}
                        {s.wellnessRole ? ` · ${s.wellnessRole}` : ''}
                        {s.otherLocationCount > 0
                          ? ` · also at ${s.otherLocationCount} other ${noun}${s.otherLocationCount === 1 ? '' : 's'}`
                          : ''}
                      </div>
                    </div>
                  </label>
                );
              })}
            </>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: '0.85rem 1.15rem', borderTop: '1px solid rgba(255,255,255,0.08)', display: 'flex', flexDirection: 'column', gap: '0.55rem' }}>
          {collateral > 0 && (
            <div style={{ ...bannerStyle, margin: 0, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.28)', color: '#ef4444' }}>
              <AlertTriangle size={14} style={{ flexShrink: 0 }} />
              <span>{collateral} other {noun} assignment{collateral === 1 ? '' : 's'} will be deleted.</span>
            </div>
          )}
          {willBeUnfenced > 0 && (
            <div style={{ ...bannerStyle, margin: 0, background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.28)', color: 'var(--warning-color, #f59e0b)' }}>
              <AlertTriangle size={14} style={{ flexShrink: 0 }} />
              <span>
                {willBeUnfenced} will be left with no {noun} at all — meaning they can clock in from
                anywhere{kind === 'zone' ? ' (unless a Global zone applies)' : ''}, not that they are blocked.
              </span>
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap' }}>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
              {selected.size} selected
              {inactiveCount > 0 && (
                <button
                  type="button"
                  onClick={() => setShowInactive((v) => !v)}
                  style={{ background: 'none', border: 'none', color: 'var(--accent-color)', cursor: 'pointer', fontSize: '0.72rem', padding: '0 0 0 0.5rem' }}
                >
                  {showInactive ? 'Hide' : 'Show'} {inactiveCount} inactive
                </button>
              )}
            </div>
            <div style={{ display: 'flex', gap: '0.4rem' }}>
              <button type="button" onClick={onClose} style={secondaryButtonStyle}>Cancel</button>
              <button
                type="button"
                onClick={submit}
                disabled={saving || loading || selected.size === 0}
                style={{
                  padding: '0.5rem 1rem',
                  border: 'none',
                  borderRadius: 8,
                  color: '#fff',
                  fontWeight: 600,
                  fontSize: '0.85rem',
                  cursor: saving || selected.size === 0 ? 'not-allowed' : 'pointer',
                  opacity: saving || selected.size === 0 ? 0.6 : 1,
                  background: mode === 'remove' ? '#ef4444' : 'var(--success-color)',
                }}
              >
                {saving ? 'Saving…' : activeMode?.cta(selected.size)}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const bannerStyle = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: '0.4rem',
  marginTop: '0.7rem',
  padding: '0.45rem 0.6rem',
  borderRadius: 8,
  fontSize: '0.73rem',
  lineHeight: 1.4,
};

const inputStyle = {
  padding: '0.5rem 0.75rem',
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 8,
  color: 'var(--text-primary)',
  fontSize: '0.85rem',
  outline: 'none',
  boxSizing: 'border-box',
};

const secondaryButtonStyle = {
  padding: '0.5rem 0.9rem',
  background: 'transparent',
  border: '1px solid rgba(255,255,255,0.15)',
  borderRadius: 8,
  color: 'var(--text-secondary)',
  cursor: 'pointer',
  fontSize: '0.85rem',
};

function chipStyle(background, color) {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.2rem',
    fontSize: '0.63rem',
    padding: '0.1rem 0.4rem',
    borderRadius: 999,
    background,
    color,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.02em',
  };
}
