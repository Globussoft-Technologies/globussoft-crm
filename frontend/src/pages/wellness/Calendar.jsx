import { useEffect, useMemo, useState, useContext } from 'react';
import { Link } from 'react-router-dom';
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight, User as UserIcon, Stethoscope, Plus, X, Building2, Home, Video, Phone, Car } from 'lucide-react';
import React from 'react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { tenantLocale } from '../../utils/date';
// Issue #816: Reusable CSV import/export toolbar — bookings entity.
import CsvImportExportToolbar from '../../components/wellness/CsvImportExportToolbar';
import { AuthContext } from '../../App';

// #615: default visible window is 9 AM → 7 PM, but visits scheduled outside
// that window (early/late shifts, walk-ins booked for 8 AM) are NOT clamped
// to the boundary hours — that's the bug that made every off-hours visit
// stack at the top (or bottom) of the day. computeHours() expands the
// visible range to include any actual visit hour on the loaded day so the
// vertical position reflects the booked time. See `hoursForVisits()`.
const DEFAULT_HOURS = Array.from({ length: 11 }, (_, i) => 9 + i); // 9 AM → 7 PM
const STATUS_COLOR = {
  booked:        'rgba(59,130,246,0.18)',
  confirmed:     'rgba(99,102,241,0.20)',
  arrived:       'rgba(168,85,247,0.20)',
  'in-treatment':'rgba(245,158,11,0.25)',
  completed:     'rgba(16,185,129,0.20)',
  'no-show':     'rgba(239,68,68,0.20)',
  cancelled:     'rgba(100,116,139,0.20)',
};
const STATUS_BORDER = {
  booked: '#3b82f6', confirmed: 'var(--primary-color, var(--accent-color, #6366f1))', arrived: '#a855f7',
  'in-treatment': '#f59e0b', completed: '#10b981',
  'no-show': '#ef4444', cancelled: '#64748b',
};

// #262 / Option B: practitioner roles are now sourced from the per-tenant
// WellnessRoleType catalog (admins maintain the list from Settings →
// Wellness Role Types). The hard-coded fallback below is used when the
// catalog hasn't been fetched yet (or the API errors out) — it matches
// the original whitelist so behaviour is unchanged in the degenerate case.
// The catalog gives roles a canTakeVisits flag + label; the role dropdown
// reads from the live list.
const FALLBACK_PRACTITIONER_KEYS = new Set(['doctor', 'professional']);
const ALL_ROLES_KEY = '__all__';

// Bridge between the two parallel role systems in this codebase:
//   1. User.wellnessRole         — lowercase string, edited from Staff page
//   2. UserRole → Role.key       — uppercase RBAC role assigned from
//                                  Settings → Roles & Permissions (returned
//                                  by /api/staff as `primaryRole.key`).
// A user is treated as belonging to a wellness role if EITHER is set;
// wellnessRole wins when both are present so explicit assignments aren't
// overridden by a coincidentally-named RBAC role. The lowercase
// normalisation lets RBAC "NURSE" match catalog "nurse" without forcing
// admins to maintain both lists separately.
function effectiveWellnessRole(u) {
  if (u?.wellnessRole) return u.wellnessRole;
  const rbacKey = u?.primaryRole?.key;
  if (rbacKey && typeof rbacKey === 'string') return rbacKey.toLowerCase();
  return null;
}

// Wave 7D — PRD Gap §11 item 4 — booking-type meta. Mirrors
// PublicBooking.jsx so the calendar's per-event badge + legend uses the
// same icons the patient saw at booking time. Default falls back to
// CLINIC_VISIT for legacy rows where bookingType is null.
const BOOKING_TYPE_META = {
  CLINIC_VISIT: { label: 'Clinic visit',  icon: Building2, color: '#0ea5e9' },
  IN_HOME:      { label: 'At home',       icon: Home,      color: '#10b981' },
  VIDEO:        { label: 'Video consult', icon: Video,     color: '#a855f7' },
  PHONE:        { label: 'Phone consult', icon: Phone,     color: '#f59e0b' },
};
const BOOKING_TYPE_ORDER = ['CLINIC_VISIT', 'IN_HOME', 'VIDEO', 'PHONE'];

// #263: render the IST calendar day, not the UTC day. toISOString() returns
// UTC, so any IST clock time before 05:30 (e.g. 1 AM IST = 19:30 prev-day UTC)
// previously yielded the wrong date string and the calendar fetched a
// different day than the Owner Dashboard's IST-aware startOfDay()/endOfDay()
// helpers in backend/routes/wellness.js — producing different "today" counts.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const isoDay = (d) => new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
const fmtHour = (h) => `${String(h).padStart(2, '0')}:00`;
const UNASSIGNED_KEY = '__unassigned__';

// #615: dynamic hour range — start with the default 9..19, then expand to
// include the earliest and latest actual visit on the loaded day. Without
// this every visit at 7 AM clamped to 9 AM and every visit at 8 PM clamped
// to 7 PM, so off-hours visits stacked at the boundary cells with no way to
// distinguish them from on-hours visits. Returns a contiguous integer
// range so the grid stays readable (no gappy hour columns).
export function hoursForVisits(visits) {
  let lo = DEFAULT_HOURS[0];
  let hi = DEFAULT_HOURS[DEFAULT_HOURS.length - 1];
  for (const v of visits || []) {
    if (!v?.visitDate) continue;
    const h = new Date(v.visitDate).getHours();
    if (Number.isFinite(h)) {
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
  }
  // Clamp to a sane 0..23 floor/ceiling — getHours() can't return outside
  // that anyway but defensive in case a malformed string slips in.
  lo = Math.max(0, Math.min(23, lo));
  hi = Math.max(0, Math.min(23, hi));
  if (hi < lo) hi = lo;
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
}

// #807 — per-column holiday matcher. Used by Calendar's column headers
// to decide whether a practitioner column should render the "Holiday — <name>"
// tag + greyed-out style for the selected day. Contract pinned by
// Calendar.test.jsx 'isHolidayForColumn() — #807 per-column holiday matcher'.
//
// Rules (in order):
//   1. Empty/null holidays → null
//   2. Practitioner-specific (h.doctorId set) → matches only column.id === h.doctorId
//   3. Location-scoped (h.locationId set, no doctorId) → matches every NON-Unassigned column
//      (Unassigned synthetic column is spared until per-column-location ships)
//   4. Tenant-wide (no location, no doctor) → matches EVERY column (incl. Unassigned)
// Returns the matching holiday row (truthy) or null.
export function isHolidayForColumn(holidays, column) {
  if (!holidays || !Array.isArray(holidays) || holidays.length === 0) return null;
  for (const h of holidays) {
    if (h.doctorId != null) {
      if (h.doctorId === column.id) return h;
      continue;
    }
    if (h.locationId != null) {
      if (column.isUnassigned) continue;
      return h;
    }
    return h;
  }
  return null;
}

export default function CalendarGrid() {
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  // Only regular users (patients) can book appointments, not staff/admins/doctors
  const canBookAppointment = user?.role === 'USER';
  const [date, setDate] = useState(() => new Date());
  const [visits, setVisits] = useState([]);
  const [allStaff, setAllStaff] = useState([]);
  const [services, setServices] = useState([]);
  const [patients, setPatients] = useState([]);
  // #629: waitlist entries with status='waiting' surface as quick-pick
  // options in the New Visit modal so a receptionist can promote a
  // waitlisted patient straight into a freed slot. Pre-fix the calendar
  // had no waitlist hook at all — the only path was Waitlist page → Mark
  // booked → fallback +24h slot, losing the explicit time the receptionist
  // wanted to give the slot.
  const [waitlist, setWaitlist] = useState([]);
  // Wave 11 Agent GG: resource list (for the New Visit modal) + same-day holidays banner.
  const [resources, setResources] = useState([]);
  const [holidays, setHolidays] = useState([]);
  // Option B: per-tenant role catalog. Drives the role-filter dropdown
  // + the practitioner column set. Empty array until the first fetch
  // resolves — see fallback logic in `practitionerKeys` below.
  const [roleTypes, setRoleTypes] = useState([]);
  // Selected role from the dropdown. ALL_ROLES_KEY shows every staff
  // member whose role has canTakeVisits=true. A specific key narrows to
  // that role only — useful when a clinic wants to see just nurses or
  // just stylists.
  const [selectedRoleKey, setSelectedRoleKey] = useState(ALL_ROLES_KEY);
  const [loading, setLoading] = useState(true);
  const [showAll, setShowAll] = useState(true);
  // #270: empty-slot click opens a "New visit" modal seeded with the chosen
  // (doctorId, hour). Booked visits are status='booked' which doesn't require
  // serviceId or doctorId per visitPOST validators (#109), but we collect
  // both up-front because that's how a receptionist actually books.
  const [newVisit, setNewVisit] = useState(null); // { columnId, hour } | null
  // User appointment booking feature
  const [showBooking, setShowBooking] = useState(false);
  const [availability, setAvailability] = useState([]);
  const [myAppointments, setMyAppointments] = useState([]);
  const [bookingForm, setBookingForm] = useState({
    doctorId: '',
    serviceId: '',
    appointmentDate: new Date().toISOString().split('T')[0],
    appointmentTime: '10:00',
    duration: '30'
  });
  const [bookingSubmitting, setBookingSubmitting] = useState(false);
  const [availLoading, setAvailLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    const dStr = isoDay(date);
    try {
      // #112: pass an explicit IST offset (+05:30) so the backend's `new Date(from)`
      // resolves to the IST calendar day regardless of the server's local TZ
      // (production runs in UTC). Pre-fix the query window was shifted by 5h30,
      // so all genuine IST visits fell outside the requested range and the
      // calendar appeared empty even though the dashboard showed the correct counts.
      const fromQ = `${dStr}T00:00:00+05:30`;
      const toQ = `${dStr}T23:59:59+05:30`;
      const [staff, vs, svc, pts, wl, rs, hs, rts] = await Promise.all([
        fetchApi('/api/staff').catch(() => []),
        fetchApi(`/api/wellness/visits?from=${encodeURIComponent(fromQ)}&to=${encodeURIComponent(toQ)}&limit=500`),
        fetchApi('/api/wellness/services').catch(() => []),
        fetchApi('/api/wellness/patients').catch(() => []),
        // #629: pull waiting waitlist entries so the New Visit modal can
        // surface promote-to-slot options. The list endpoint returns a
        // bare array; defensive Array.isArray check matches patients above.
        fetchApi('/api/wellness/waitlist?status=waiting').catch(() => []),
        fetchApi('/api/wellness/resources?activeOnly=1').catch(() => []),
        fetchApi(`/api/wellness/holidays?from=${dStr}&to=${dStr}`).catch(() => []),
        // Option B: per-tenant role catalog (admins maintain from Settings).
        // activeOnly=1 so deactivated roles don't pollute the dropdown but
        // staff with a now-inactive wellnessRole still render in their column.
        fetchApi('/api/wellness/role-types?activeOnly=1').catch(() => []),
      ]);
      setAllStaff(Array.isArray(staff) ? staff : []);
      setVisits(Array.isArray(vs) ? vs : []);
      setServices(Array.isArray(svc) ? svc.filter((s) => s.isActive !== false) : []);
      // #312: /api/wellness/patients returns { patients, total } not a bare
      // array. Defensive read so a future shape change doesn't silently
      // empty the dropdown again. Same fix as #251 for /converted-leads.
      const patientsArr = Array.isArray(pts)
        ? pts
        : Array.isArray(pts?.patients) ? pts.patients
        : Array.isArray(pts?.data) ? pts.data
        : [];
      setPatients(patientsArr);
      setWaitlist(Array.isArray(wl) ? wl : Array.isArray(wl?.items) ? wl.items : []);
      setResources(Array.isArray(rs) ? rs : []);
      setHolidays(Array.isArray(hs) ? hs : []);
      setRoleTypes(Array.isArray(rts) ? rts : []);
    } catch (_e) { setVisits([]); setAllStaff([]); setWaitlist([]); setResources([]); setHolidays([]); setRoleTypes([]); }
    setLoading(false);
  };
  useEffect(() => { load(); }, [date]);

  // Load doctor availability and user appointments when booking view is shown
  useEffect(() => {
    if (showBooking) {
      loadAvailability();
      loadMyAppointments();
    }
  }, [showBooking, bookingForm.appointmentDate]);

  const loadAvailability = async () => {
    try {
      setAvailLoading(true);
      const data = await fetchApi(`/api/wellness/doctors/availability?date=${bookingForm.appointmentDate}`);
      setAvailability(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('Failed to load availability:', err);
      notify.error('Failed to load doctor availability');
    } finally {
      setAvailLoading(false);
    }
  };

  const loadMyAppointments = async () => {
    try {
      const data = await fetchApi('/api/wellness/appointments/my');
      setMyAppointments(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('Failed to load appointments:', err);
    }
  };

  const handleBookAppointment = async (e) => {
    e.preventDefault();
    setBookingSubmitting(true);
    try {
      const result = await fetchApi('/api/wellness/appointments/book', {
        method: 'POST',
        body: JSON.stringify({
          doctorId: parseInt(bookingForm.doctorId),
          serviceId: bookingForm.serviceId ? parseInt(bookingForm.serviceId) : null,
          appointmentDate: bookingForm.appointmentDate,
          appointmentTime: bookingForm.appointmentTime,
          duration: bookingForm.duration
        })
      });

      if (result.success) {
        notify.success(`Appointment booked with ${result.appointment.doctorName}`);
        setBookingForm({
          doctorId: '',
          serviceId: '',
          appointmentDate: new Date().toISOString().split('T')[0],
          appointmentTime: '10:00',
          duration: '30'
        });
        loadMyAppointments();
      }
    } catch (err) {
      notify.error(err.message || 'Failed to book appointment');
    } finally {
      setBookingSubmitting(false);
    }
  };

  const handleCancelAppointment = async (appointmentId) => {
    if (!await notify.confirm({
      title: 'Cancel Appointment',
      message: 'Are you sure you want to cancel this appointment?',
      confirmText: 'Cancel',
      destructive: true
    })) return;

    try {
      await fetchApi(`/api/wellness/appointments/${appointmentId}/cancel`, { method: 'POST' });
      notify.success('Appointment cancelled');
      loadMyAppointments();
    } catch (err) {
      notify.error(err.message || 'Failed to cancel appointment');
    }
  };

  // Option B: derive the set of practitioner role keys from the catalog.
  // A role is "practitioner" when canTakeVisits=true. Until the catalog
  // fetch resolves, fall back to the original hardcoded set so first-paint
  // matches pre-Option-B behaviour.
  const practitionerKeys = useMemo(() => {
    if (!roleTypes.length) return FALLBACK_PRACTITIONER_KEYS;
    return new Set(roleTypes.filter((r) => r.canTakeVisits).map((r) => r.key));
  }, [roleTypes]);

  // Role dropdown options: each catalog role that's a practitioner +
  // "All staff" sentinel. Empty when the catalog is empty (we just hide
  // the dropdown in that case).
  const practitionerRoleOptions = useMemo(() => {
    if (!roleTypes.length) return [];
    return roleTypes
      .filter((r) => r.canTakeVisits)
      .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || a.label.localeCompare(b.label));
  }, [roleTypes]);

  // #262: build the practitioner list. Default view = practitioners with at
  // least one visit on this day (so the grid stays readable on small clinics).
  // Toggle "Show all" to surface every practitioner for booking empty slots.
  // Option B: also narrow by selectedRoleKey when the dropdown is on a
  // specific role (ALL_ROLES_KEY = no role filter applied).
  const practitioners = useMemo(() => {
    let all = allStaff.filter((u) => practitionerKeys.has(effectiveWellnessRole(u)));
    if (selectedRoleKey !== ALL_ROLES_KEY) {
      all = all.filter((u) => effectiveWellnessRole(u) === selectedRoleKey);
    }
    const doctorIdsToday = new Set(visits.map((v) => v.doctorId).filter(Boolean));
    if (showAll) return all;
    const withVisits = all.filter((u) => doctorIdsToday.has(u.id));
    // Fallback: if no practitioner has visits today, surface everyone so the
    // grid isn't empty and the receptionist can still book.
    return withVisits.length ? withVisits : all;
  }, [allStaff, visits, showAll, practitionerKeys, selectedRoleKey]);

  // #247: include visits without a doctor assignment in an "Unassigned"
  // column instead of silently dropping them. The dashboard counts ALL
  // visits today; the calendar must too. Also clamp visits scheduled
  // before 09:00 / after 19:00 to the boundary hour so they're surfaced.
  const columns = useMemo(() => {
    const cols = practitioners.map((d) => ({
      id: d.id,
      name: d.name,
      // Column-header role badge uses the effective role so RBAC-only
      // staff still display a role label (e.g. "NURSE" → "nurse").
      role: effectiveWellnessRole(d),
      isUnassigned: false,
    }));
    if (visits.some((v) => !v.doctorId)) {
      cols.push({ id: UNASSIGNED_KEY, name: 'Unassigned', role: null, isUnassigned: true });
    }
    return cols;
  }, [visits, practitioners]);

  // #615: hours dynamically expand to cover every booked visit on the loaded
  // day. Pre-fix the vertical position was clamped to the 9..19 window, so
  // an 8 AM walk-in stacked on top of every other 9 AM visit (and an 8 PM
  // late-shift visit stacked on top of every other 7 PM visit) — the
  // receptionist couldn't tell whether two visits were back-to-back or
  // 5 hours apart. See hoursForVisits() above for the contiguous-range
  // expansion logic.
  const HOURS = useMemo(() => hoursForVisits(visits), [visits]);

  const grid = useMemo(() => {
    const out = {};
    for (const c of columns) out[c.id] = {};
    for (const v of visits) {
      const colId = v.doctorId || UNASSIGNED_KEY;
      if (!out[colId]) out[colId] = {};
      // #615: bucket by the visit's actual hour. The HOURS array now spans
      // the full data range so no clamping is needed; visits land in the
      // hour cell that matches their booked time.
      const h = new Date(v.visitDate).getHours();
      if (!out[colId][h]) out[colId][h] = [];
      out[colId][h].push(v);
    }
    return out;
  }, [visits, columns]);

  const shift = (days) => {
    const next = new Date(date); next.setDate(next.getDate() + days); setDate(next);
  };

  // #262 sub-counts for the header chip. Option B: counts honour the
  // selected role filter so the chip reads "5 of 5 nurses" when narrowed.
  const totalPractitionerCount = useMemo(() => {
    const inScope = allStaff.filter((u) => practitionerKeys.has(effectiveWellnessRole(u)));
    if (selectedRoleKey === ALL_ROLES_KEY) return inScope.length;
    return inScope.filter((u) => effectiveWellnessRole(u) === selectedRoleKey).length;
  }, [allStaff, practitionerKeys, selectedRoleKey]);
  const visiblePractitionerCount = practitioners.length;
  const selectedRoleLabel = useMemo(() => {
    if (selectedRoleKey === ALL_ROLES_KEY) return 'practitioners';
    const r = roleTypes.find((rt) => rt.key === selectedRoleKey);
    return r?.label?.toLowerCase() || selectedRoleKey;
  }, [selectedRoleKey, roleTypes]);

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '1.25rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem' }}>
        <div>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <CalendarIcon size={24} /> Calendar
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            Day view by practitioner — {date.toLocaleDateString(tenantLocale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
          {/* Option B: role-filter dropdown. Reads the per-tenant catalog
              (Settings → Wellness Role Types). "All staff" is the default
              and shows every catalog role with canTakeVisits=true. Hidden
              when the catalog is empty (catalog not seeded, generic tenant,
              or API error). */}
          {practitionerRoleOptions.length > 0 && (
            <select
              value={selectedRoleKey}
              onChange={(e) => setSelectedRoleKey(e.target.value)}
              aria-label="Filter by staff role"
              className="glass"
              style={{
                padding: '0.4rem 0.65rem', fontSize: '0.8rem',
                borderRadius: 8, cursor: 'pointer',
                border: '1px solid rgba(255,255,255,0.1)',
                background: 'transparent',
                color: 'var(--text-primary)',
              }}
            >
              <option value={ALL_ROLES_KEY}>All staff</option>
              {practitionerRoleOptions.map((r) => (
                <option key={r.key} value={r.key}>{r.label}</option>
              ))}
            </select>
          )}
          {totalPractitionerCount > 0 && (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="glass"
              style={{
                padding: '0.4rem 0.8rem', fontSize: '0.8rem',
                borderRadius: 8, cursor: 'pointer',
                border: `1px solid ${showAll ? 'rgba(99,102,241,0.5)' : 'rgba(255,255,255,0.1)'}`,
                background: showAll ? 'rgba(99,102,241,0.15)' : 'transparent',
                color: 'var(--text-primary)',
              }}
              title={showAll ? `Showing all ${totalPractitionerCount} ${selectedRoleLabel}` : `Showing ${visiblePractitionerCount} with visits today (click to show all)`}
            >
              {/* #307: pre-fix copy was "1 of 16" with no unit, which sat right
                  next to the date chevrons and was widely misread as
                  "day 1 of 16" — i.e. the chevrons advanced practitioners.
                  Add the explicit noun (practitioners / nurses / stylists)
                  so the chip is unambiguously about the column filter,
                  not navigation. The noun comes from the dropdown's
                  selected label (Option B). */}
              {showAll
                ? `All ${selectedRoleLabel} (${totalPractitionerCount})`
                : `${visiblePractitionerCount} of ${totalPractitionerCount} ${selectedRoleLabel}`}
            </button>
          )}
          <button onClick={() => shift(-1)} className="glass" style={navBtn}><ChevronLeft size={16} /></button>
          <button onClick={() => setDate(new Date())} className="glass" style={{ ...navBtn, padding: '0.4rem 0.9rem', fontSize: '0.85rem', width: 'auto' }}>Today</button>
          <button onClick={() => shift(1)} className="glass" style={navBtn}><ChevronRight size={16} /></button>
          {/* Issue #816: CSV Import / Export of bookings. Export reflects the
              currently-visible day window (server filters on `from`/`to`). */}
          <CsvImportExportToolbar
            entity="bookings"
            label="Bookings"
            filters={{
              from: `${isoDay(date)}T00:00:00+05:30`,
              to: `${isoDay(date)}T23:59:59+05:30`,
            }}
            formats={['csv', 'xlsx']}
            onImported={load}
          />
        </div>
      </header>

      {loading && <div data-testid="calendar-loading">Loading…</div>}

      {/* Wave 11 Agent GG: red banner when the selected day has any holidays. */}
      {!loading && holidays.length > 0 && (
        <div
          data-testid="holiday-banner"
          className="glass"
          style={{
            padding: '0.85rem 1rem',
            marginBottom: '1rem',
            borderLeft: '4px solid #ef4444',
            background: 'rgba(239,68,68,0.08)',
            color: 'var(--text-primary)',
            fontSize: '0.85rem',
          }}
          role="alert"
        >
          <strong style={{ color: '#ef4444' }}>Holiday today:</strong>{' '}
          {holidays.map((h) => h.name).join(', ')}
        </div>
      )}

      {!loading && columns.length === 0 && (
        <div className="glass" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
          No practitioners configured and no visits scheduled. Add staff under Staff or book a visit.
        </div>
      )}

      {!loading && columns.length > 0 && (
        <div className="glass calendar-scroll" style={{ padding: '1rem', overflow: 'auto' }}>
          {/* #615: use minmax(0, 1fr) per the CLAUDE.md ellipsis-on-grid-children
              standing rule. Hard 120px floor at the minmax min would have
              prevented columns from collapsing past 120px and forced the
              whole grid to overflow horizontally instead of letting the
              ellipsis chain on each cell clip — see line 199 column header
              and line 230 hour cell, both have minWidth:0. */}
          <div className="calendar-grid" style={{ display: 'grid', gridTemplateColumns: `80px repeat(${columns.length}, minmax(0, 1fr))`, gap: '4px', minWidth: `${80 + columns.length * 120}px` }}>
            <div style={{ ...colHead, background: 'transparent' }}></div>
            {columns.map((c) => (
              <div key={c.id} style={{ ...colHead, opacity: c.isUnassigned ? 0.7 : 1, minWidth: 0, overflow: 'hidden' }} title={c.role ? `${c.name} · ${c.role}` : c.name}>
                {c.isUnassigned ? (
                  <UserIcon size={14} style={{ verticalAlign: 'middle', marginRight: '0.4rem', opacity: 0.7, flexShrink: 0 }} />
                ) : (
                  <Stethoscope size={14} style={{ verticalAlign: 'middle', marginRight: '0.4rem', opacity: 0.7, flexShrink: 0 }} />
                )}
                {/* #486: name + role row needs explicit overflow:hidden + ellipsis,
                    otherwise "Sandeep Bose" (12 chars) + " DOCTOR" suffix overflows
                    the 120px min column width and clips into the next column. */}
                <span style={{ display: 'inline-block', verticalAlign: 'middle', maxWidth: 'calc(100% - 22px)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {c.name}
                  {c.role && (
                    <span style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', marginLeft: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      {c.role}
                    </span>
                  )}
                </span>
              </div>
            ))}

            {HOURS.map((h) => (
              <React.Fragment key={h}>
                <div style={hourLabel}>{fmtHour(h)}</div>
                {columns.map((c) => {
                  const cell = grid[c.id]?.[h] || [];
                  // #270: empty slots are clickable when the column belongs to a
                  // real practitioner (not the synthetic Unassigned column —
                  // a fresh booking should always be assigned to someone).
                  const isCreatable = !c.isUnassigned && cell.length === 0;
                  return (
                    <div
                      key={`${c.id}-${h}`}
                      style={{
                        ...hourCell,
                        cursor: isCreatable ? 'pointer' : 'default',
                        position: 'relative',
                        minWidth: 0,
                        overflow: 'hidden',
                      }}
                      onClick={isCreatable ? () => setNewVisit({ columnId: c.id, hour: h }) : undefined}
                      title={isCreatable ? `Book ${fmtHour(h)} with ${c.name}` : undefined}
                      onMouseEnter={isCreatable ? (e) => { e.currentTarget.querySelector('[data-empty-affordance]')?.style.setProperty('opacity', '0.8'); } : undefined}
                      onMouseLeave={isCreatable ? (e) => { e.currentTarget.querySelector('[data-empty-affordance]')?.style.setProperty('opacity', '0'); } : undefined}
                    >
                      {cell.map((v) => (
                        <Link
                          to={`/wellness/patients/${v.patient?.id || v.patientId}`}
                          key={v.id}
                          style={{
                            textDecoration: 'none', color: 'var(--text-primary)',
                            background: STATUS_COLOR[v.status] || 'rgba(255,255,255,0.05)',
                            borderLeft: `3px solid ${STATUS_BORDER[v.status] || '#64748b'}`,
                            padding: '0.4rem 0.5rem', borderRadius: '6px',
                            fontSize: '0.75rem', display: 'block',
                            // #486: keep the event chip clamped to its grid-cell width
                            // so long patient names + service titles ellipsis-truncate
                            // instead of overflowing into the next practitioner column.
                            minWidth: 0, maxWidth: '100%', overflow: 'hidden',
                          }}
                          title={`${new Date(v.visitDate).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })} IST · ${v.patient?.name || `#${v.patientId}`}${v.service?.name ? ` — ${v.service.name}` : ''}`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div style={{ fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {/* #361: explicit IST suffix — the wall time on the chip is
                                already IST-localised (toLocaleTimeString w/ en-IN +
                                +05:30 fetch window upstream), but receptionists in
                                shared workspaces couldn't tell at a glance. */}
                            {new Date(v.visitDate).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })} IST · {v.patient?.name || `#${v.patientId}`}
                          </div>
                          <div style={{ color: 'var(--text-secondary)', fontSize: '0.7rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {v.service?.name || '—'}
                          </div>
                          {/* Wave 7D — booking-type badge + travel-time
                              annotation. Both fields land on Visit per
                              Wave 2D; pre-Wave-2D rows have null bookingType,
                              so we treat that as CLINIC_VISIT for the badge
                              icon (matches the column default). Travel time
                              is only surfaced for IN_HOME visits where the
                              field is meaningful — staff dispatch needs to
                              know the buffer to allocate. */}
                          {(() => {
                            const bt = v.bookingType || 'CLINIC_VISIT';
                            const meta = BOOKING_TYPE_META[bt] || BOOKING_TYPE_META.CLINIC_VISIT;
                            const Icon = meta.icon;
                            return (
                              <div style={{
                                display: 'flex', alignItems: 'center', gap: 4,
                                marginTop: 3, fontSize: '0.65rem',
                                color: meta.color,
                                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                              }}>
                                <Icon size={11} aria-hidden="true" />
                                <span data-testid={`booking-type-${bt}`}>{meta.label}</span>
                                {bt === 'IN_HOME' && Number.isFinite(v.travelTimeMinutes) && v.travelTimeMinutes > 0 && (
                                  <span data-testid="travel-time" style={{ color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                                    <Car size={10} aria-hidden="true" /> Travel: {v.travelTimeMinutes} min
                                  </span>
                                )}
                              </div>
                            );
                          })()}
                        </Link>
                      ))}
                      {isCreatable && (
                        <span
                          data-empty-affordance
                          style={{
                            position: 'absolute', inset: 0,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            color: 'var(--accent-color)', opacity: 0,
                            transition: 'opacity 0.12s',
                            pointerEvents: 'none',
                            fontSize: '0.7rem', fontWeight: 500, gap: '0.25rem',
                          }}
                        >
                          <Plus size={12} /> Book
                        </span>
                      )}
                    </div>
                  );
                })}
              </React.Fragment>
            ))}
          </div>
        </div>
      )}

      <div style={{ marginTop: '1rem', display: 'flex', flexWrap: 'wrap', gap: '0.5rem', fontSize: '0.75rem' }}>
        {Object.entries(STATUS_BORDER).map(([s, color]) => (
          <span key={s} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', color: 'var(--text-secondary)' }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: color }} />{s}
          </span>
        ))}
      </div>

      {/* Wave 7D — booking-type legend chip. Same icons used on the
          PublicBooking.jsx widget + on each event card above, so the
          receptionist can match an at-home Home icon to "AT HOME" at a
          glance. Rendered as a separate row below the status legend. */}
      <div
        data-testid="booking-type-legend"
        style={{
          marginTop: '0.5rem',
          display: 'flex', flexWrap: 'wrap', gap: '0.75rem',
          fontSize: '0.75rem',
        }}
      >
        <span style={{ color: 'var(--text-secondary)', fontWeight: 600, marginRight: '0.25rem' }}>Booking type:</span>
        {BOOKING_TYPE_ORDER.map((bt) => {
          const meta = BOOKING_TYPE_META[bt];
          const Icon = meta.icon;
          return (
            <span key={bt} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', color: meta.color }}>
              <Icon size={12} aria-hidden="true" /> {meta.label}
            </span>
          );
        })}
      </div>

      {newVisit && (
        <NewVisitModal
          column={columns.find((c) => c.id === newVisit.columnId)}
          hour={newVisit.hour}
          date={date}
          patients={patients}
          services={services}
          waitlist={waitlist}
          /* Wave 11 Agent GG: pass resources for the dropdown. */
          resources={resources}
          notify={notify}
          onClose={() => setNewVisit(null)}
          onCreated={() => { setNewVisit(null); load(); }}
        />
      )}

      {/* User Appointment Booking Section - Only for regular users */}
      {canBookAppointment && (
        <div style={{ marginTop: '2rem', padding: '1.5rem', borderTop: '1px solid rgba(255,255,255,0.1)' }}>
          <button
            onClick={() => setShowBooking(!showBooking)}
            style={{
              padding: '0.6rem 1.5rem',
              background: showBooking ? 'var(--primary-color, var(--accent-color, #6366f1))' : 'transparent',
              color: showBooking ? '#fff' : 'var(--text-primary)',
              border: `1px solid ${showBooking ? 'transparent' : 'var(--border-color, rgba(0,0,0,0.15))'}`,
              borderRadius: 8,
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: '0.9rem',
              transition: 'all 0.2s'
            }}
          >
            {showBooking ? '✓ Book Appointment' : '+ Book Appointment'}
          </button>

        {showBooking && (
          <div style={{ marginTop: '1.5rem', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2rem' }}>
            {/* Left: Booking Form */}
            <div style={{ padding: '1.5rem', background: 'rgba(255,255,255,0.02)', borderRadius: 12, border: '1px solid rgba(255,255,255,0.08)' }}>
              <h3 style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: '1rem' }}>Book an Appointment</h3>
              <form onSubmit={handleBookAppointment} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <div>
                  <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '0.5rem' }}>Doctor</label>
                  <select
                    value={bookingForm.doctorId}
                    onChange={(e) => setBookingForm({...bookingForm, doctorId: e.target.value})}
                    required
                    style={{...modalInput, width: '100%'}}
                  >
                    <option value="">— Select Doctor —</option>
                    {availability.map(doc => (
                      <option key={doc.id} value={doc.id} disabled={!doc.available}>
                        {doc.name} {!doc.available ? '(On Leave)' : ''}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '0.5rem' }}>Service</label>
                  <select
                    value={bookingForm.serviceId}
                    onChange={(e) => setBookingForm({...bookingForm, serviceId: e.target.value})}
                    style={{...modalInput, width: '100%'}}
                  >
                    <option value="">— Select Service —</option>
                    {services.map(svc => (
                      <option key={svc.id} value={svc.id}>{svc.name}</option>
                    ))}
                  </select>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                  <div>
                    <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '0.5rem' }}>Date</label>
                    <input
                      type="date"
                      value={bookingForm.appointmentDate}
                      onChange={(e) => setBookingForm({...bookingForm, appointmentDate: e.target.value})}
                      required
                      style={{...modalInput, width: '100%'}}
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '0.5rem' }}>Time</label>
                    <input
                      type="time"
                      value={bookingForm.appointmentTime}
                      onChange={(e) => setBookingForm({...bookingForm, appointmentTime: e.target.value})}
                      required
                      style={{...modalInput, width: '100%'}}
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={bookingSubmitting || !bookingForm.doctorId}
                  style={{
                    padding: '0.6rem 1.2rem',
                    background: bookingSubmitting || !bookingForm.doctorId ? '#ccc' : 'var(--primary-color, var(--accent-color, #6366f1))',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 8,
                    cursor: bookingSubmitting || !bookingForm.doctorId ? 'not-allowed' : 'pointer',
                    fontWeight: 600,
                    fontSize: '0.9rem'
                  }}
                >
                  {bookingSubmitting ? 'Booking...' : 'Book Now'}
                </button>
              </form>
            </div>

            {/* Right: My Appointments */}
            <div style={{ padding: '1.5rem', background: 'rgba(255,255,255,0.02)', borderRadius: 12, border: '1px solid rgba(255,255,255,0.08)' }}>
              <h3 style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: '1rem' }}>My Appointments</h3>
              {myAppointments.length === 0 ? (
                <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '2rem 0' }}>No appointments booked yet</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  {myAppointments.map(apt => (
                    <div key={apt.id} style={{ padding: '0.75rem', background: 'rgba(99,102,241,0.1)', borderRadius: 8, border: '1px solid rgba(99,102,241,0.2)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                        <div>
                          <div style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: '0.25rem' }}>
                            Dr. {apt.doctorName}
                          </div>
                          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                            {apt.serviceName} • {new Date(apt.appointmentDate).toLocaleDateString()} at {new Date(apt.appointmentDate).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                          </div>
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
                            Status: <span style={{ textTransform: 'capitalize', fontWeight: 500 }}>{apt.status}</span>
                          </div>
                        </div>
                        {apt.status === 'booked' && (
                          <button
                            onClick={() => handleCancelAppointment(apt.id)}
                            style={{
                              padding: '0.3rem 0.7rem',
                              background: 'rgba(239,68,68,0.1)',
                              color: '#ef4444',
                              border: '1px solid rgba(239,68,68,0.3)',
                              borderRadius: 6,
                              cursor: 'pointer',
                              fontSize: '0.75rem',
                              fontWeight: 500
                            }}
                          >
                            Cancel
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
        </div>
      )}
    </div>
  );
}

// #270: lightweight modal for booking a visit from the calendar grid.
// Only required field is patientId (per the visit POST validator at
// routes/wellness.js:472). status defaults to 'booked' so the receptionist
// doesn't trip the "completed visits need serviceId + doctorId" gate.
function NewVisitModal({ column, hour, date, patients, services, waitlist, resources = [], notify, onClose, onCreated }) {
  const [patientId, setPatientId] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [notes, setNotes] = useState('');
  // Wave 11 Agent GG: optional resource selection. Filtered by service compatibility.
  const [resourceId, setResourceId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // #629: source flag tracks whether this booking is a fresh visit (default)
  // or a promotion from a waitlist entry. When 'waitlist', we PUT
  // /api/wellness/waitlist/:id with status='booked' + visitDate (the backend
  // materialises a Visit row at that slot — see routes/wellness.js:4298+).
  const [source, setSource] = useState('new'); // 'new' | 'waitlist'
  const [waitlistId, setWaitlistId] = useState('');

  const localDate = new Date(date);
  localDate.setHours(hour, 0, 0, 0);

  // #629: only show waitlist entries with status='waiting' (the parent
  // already filters by status, but defensive in case the prop changes).
  // The list is empty array fallback so the dropdown still renders even
  // with no waitlist entries — see test "renders waitlist dropdown options".
  const waitingEntries = Array.isArray(waitlist) ? waitlist.filter((w) => w.status === 'waiting') : [];

  const submit = async (e) => {
    e.preventDefault();
    if (submitting) return;

    // #629: visitDate built as IST wall time; backend stores as UTC, dashboard
    // applies the same +05:30 offset on read so the slot lands at the
    // intended hour for the receptionist's column.
    const istIso = `${date.toISOString().slice(0, 10)}T${String(hour).padStart(2, '0')}:00:00+05:30`;

    if (source === 'waitlist') {
      if (!waitlistId) return;
      setSubmitting(true);
      try {
        // PUT status='booked' triggers Visit creation in the backend handler
        // (see routes/wellness.js:4298) tied to the waitlist entry's
        // patient + service. The visitDate ensures the slot lands where the
        // receptionist clicked, not the +24h fallback.
        await fetchApi(`/api/wellness/waitlist/${parseInt(waitlistId, 10)}`, {
          method: 'PUT',
          body: JSON.stringify({ status: 'booked', visitDate: istIso }),
        });
        const entry = waitingEntries.find((w) => w.id === parseInt(waitlistId, 10));
        const name = entry?.patient?.name || 'patient';
        notify.success(`Promoted ${name} from waitlist to ${String(hour).padStart(2, '0')}:00`);
        onCreated();
      } catch (_err) { /* fetchApi already toasted */ }
      setSubmitting(false);
      return;
    }

    if (!patientId) return;
    setSubmitting(true);
    try {
      await fetchApi('/api/wellness/visits', {
        method: 'POST',
        body: JSON.stringify({
          patientId: parseInt(patientId, 10),
          serviceId: serviceId ? parseInt(serviceId, 10) : null,
          doctorId: column.id,
          // Wave 11 Agent GG: pin resource if selected (gate raises 409 RESOURCE_DOUBLE_BOOKED on overlap).
          resourceId: resourceId ? parseInt(resourceId, 10) : null,
          visitDate: istIso,
          status: 'booked',
          notes: notes || null,
        }),
      });
      const patientName = patients.find((p) => p.id === parseInt(patientId, 10))?.name;
      notify.success(`Booked ${patientName || 'visit'} at ${String(hour).padStart(2, '0')}:00 with ${column.name}`);
      onCreated();
    } catch (_err) { /* fetchApi already toasted */ }
    setSubmitting(false);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-visit-title"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 9000,
        background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '1rem',
      }}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="glass"
        style={{
          background: 'var(--surface-color, #ffffff)', color: 'var(--text-primary)',
          padding: '1.5rem', borderRadius: 12, width: '100%', maxWidth: 480,
          border: '1px solid var(--border-color, rgba(0,0,0,0.08))',
          boxShadow: '0 20px 60px rgba(0,0,0,0.35)',
          display: 'flex', flexDirection: 'column', gap: '0.75rem',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 id="new-visit-title" style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600 }}>
            New visit
          </h3>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}>
            <X size={18} />
          </button>
        </div>
        <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
          {column.name} • {localDate.toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })}
        </p>

        {/* #629: source toggle — pick "Promote from waitlist" when there are
            waiting entries, otherwise stays on the default new-visit path. */}
        {waitingEntries.length > 0 && (
          <div role="radiogroup" aria-label="Booking source" style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button
              type="button"
              role="radio"
              aria-checked={source === 'new'}
              onClick={() => setSource('new')}
              style={sourceBtn(source === 'new')}
            >
              New patient
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={source === 'waitlist'}
              onClick={() => setSource('waitlist')}
              style={sourceBtn(source === 'waitlist')}
            >
              Promote from waitlist ({waitingEntries.length})
            </button>
          </div>
        )}

        {source === 'waitlist' ? (
          <>
            <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Waitlisted patient *</label>
            <select
              required
              value={waitlistId}
              onChange={(e) => setWaitlistId(e.target.value)}
              style={modalInput}
              aria-label="Waitlisted patient"
            >
              <option value="">— select from waitlist —</option>
              {waitingEntries.map((w) => {
                const svcName = w.serviceId
                  ? (services.find((s) => s.id === w.serviceId)?.name || `service #${w.serviceId}`)
                  : 'any service';
                const phone = w.patient?.phone ? ` · ${w.patient.phone}` : '';
                return (
                  <option key={w.id} value={w.id}>
                    {w.patient?.name || `#${w.patientId}`}{phone} — {svcName}
                  </option>
                );
              })}
            </select>
            <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
              Promoting will create a booked visit at this slot and remove the patient from the waiting list.
            </p>
          </>
        ) : (
          <>
            <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Patient *</label>
            <select required value={patientId} onChange={(e) => setPatientId(e.target.value)} style={modalInput}>
              <option value="">— select patient —</option>
              {patients.map((p) => (
                <option key={p.id} value={p.id}>{p.name}{p.phone ? ` · ${p.phone}` : ''}</option>
              ))}
            </select>

            <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Service (optional)</label>
            <select value={serviceId} onChange={(e) => setServiceId(e.target.value)} style={modalInput}>
              <option value="">— pick later —</option>
              {services.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>

            {/* Wave 11 Agent GG: optional resource selection (room/machine). */}
            {resources.length > 0 && (
              <>
                <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Resource (optional)</label>
                <select value={resourceId} onChange={(e) => setResourceId(e.target.value)} style={modalInput}>
                  <option value="">— no resource pinned —</option>
                  {resources
                    .filter((r) => {
                      if (!serviceId) return true;
                      if (!r.serviceIds) return true;
                      try {
                        const allowed = JSON.parse(r.serviceIds);
                        return Array.isArray(allowed) && allowed.includes(parseInt(serviceId, 10));
                      } catch (_e) { return true; }
                    })
                    .map((r) => (
                      <option key={r.id} value={r.id}>{r.name} · {r.type}</option>
                    ))}
                </select>
              </>
            )}

            <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Notes (optional)</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              style={{ ...modalInput, resize: 'vertical', fontFamily: 'inherit' }}
              placeholder="Walk-in confirmed, follow-up consult, etc."
            />
          </>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.5rem' }}>
          <button type="button" onClick={onClose} style={{ padding: '0.5rem 1rem', background: 'transparent', border: '1px solid var(--border-color, rgba(0,0,0,0.15))', borderRadius: 8, cursor: 'pointer', color: 'var(--text-primary)' }}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={(source === 'waitlist' ? !waitlistId : !patientId) || submitting}
            style={{
              padding: '0.5rem 1.25rem',
              background: 'var(--primary-color, var(--accent-color, #6366f1))',
              opacity: ((source === 'waitlist' ? !waitlistId : !patientId) || submitting) ? 0.4 : 1,
              border: 'none', color: '#fff', borderRadius: 8,
              cursor: ((source === 'waitlist' ? !waitlistId : !patientId) || submitting) ? 'not-allowed' : 'pointer',
              fontWeight: 600,
            }}
          >
            {submitting ? 'Booking…' : source === 'waitlist' ? 'Promote from waitlist' : 'Book visit'}
          </button>
        </div>
      </form>
    </div>
  );
}

const navBtn = { width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, border: '1px solid rgba(255,255,255,0.08)', cursor: 'pointer', background: 'transparent', color: 'var(--text-primary)' };
const colHead = { padding: '0.5rem 0.75rem', fontWeight: 600, fontSize: '0.8rem', borderBottom: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.02)', color: 'var(--text-primary)' };
const hourLabel = { padding: '0.5rem', fontSize: '0.7rem', color: 'var(--text-secondary)', textAlign: 'right', borderRight: '1px solid rgba(255,255,255,0.05)' };
const hourCell = { padding: '0.25rem', display: 'flex', flexDirection: 'column', gap: '0.25rem', minHeight: '60px', borderBottom: '1px solid rgba(255,255,255,0.04)' };
const modalInput = { padding: '0.5rem 0.7rem', borderRadius: 8, border: '1px solid var(--border-color, rgba(0,0,0,0.15))', background: 'var(--input-bg, rgba(0,0,0,0.03))', color: 'var(--text-primary)', fontSize: '0.9rem', outline: 'none' };
// #629: source-toggle pill — primary brand color when active so it reads
// the same on wellness teal (#265855) as on generic blue.
const sourceBtn = (active) => ({
  padding: '0.4rem 0.85rem',
  background: active ? 'var(--primary-color, var(--accent-color, #6366f1))' : 'transparent',
  color: active ? '#fff' : 'var(--text-primary)',
  border: `1px solid ${active ? 'transparent' : 'var(--border-color, rgba(0,0,0,0.15))'}`,
  borderRadius: 999,
  cursor: 'pointer',
  fontSize: '0.8rem',
  fontWeight: active ? 600 : 400,
});
