import { Building2, Home, Video, Phone } from 'lucide-react';

// #615: default visible window is 9 AM → 7 PM, but visits scheduled outside
// that window (early/late shifts, walk-ins booked for 8 AM) are NOT clamped
// to the boundary hours — that's the bug that made every off-hours visit
// stack at the top (or bottom) of the day. computeHours() expands the
// visible range to include any actual visit hour on the loaded day so the
// vertical position reflects the booked time. See `hoursForVisits()`.
export const DEFAULT_HOURS = Array.from({ length: 11 }, (_, i) => 9 + i); // 9 AM → 7 PM
export const STATUS_COLOR = {
  // 'pending' is a presentational status — surfaced for visits whose
  // doctorId is null (portal self-bookings with "No preference — admin
  // will assign"). Storage stays as 'booked'; the UI flips the label
  // and styling so admins can spot pending-assignment work at a glance.
  pending:       'rgba(245,158,11,0.18)',
  booked:        'rgba(59,130,246,0.18)',
  confirmed:     'rgba(99,102,241,0.20)',
  arrived:       'rgba(168,85,247,0.20)',
  'in-treatment':'rgba(245,158,11,0.25)',
  completed:     'rgba(16,185,129,0.20)',
  'no-show':     'rgba(239,68,68,0.20)',
  cancelled:     'rgba(100,116,139,0.20)',
};
export const STATUS_BORDER = {
  pending: '#f59e0b',
  booked: '#3b82f6', confirmed: 'var(--primary-color, var(--accent-color, #6366f1))', arrived: '#a855f7',
  'in-treatment': '#f59e0b', completed: '#10b981',
  'no-show': '#ef4444', cancelled: '#64748b',
};

// Visits with no assigned doctor are stored as status='booked' so the
// patient's portal flow stays consistent, but the staff UI surfaces them
// as 'pending' for clarity. Single helper used by every render path so
// the rule can't drift between Calendar / Appointments.
export const displayStatus = (visit) =>
  !visit?.doctorId && visit?.status === 'booked' ? 'pending' : visit?.status;

// #262 / Option B: practitioner roles are now sourced from the per-tenant
// WellnessRoleType catalog (admins maintain the list from Settings →
// Wellness Role Types). The hard-coded fallback below is used when the
// catalog hasn't been fetched yet (or the API errors out) — it matches
// the original whitelist so behaviour is unchanged in the degenerate case.
// The catalog gives roles a canTakeVisits flag + label; the role dropdown
// reads from the live list.
export const FALLBACK_PRACTITIONER_KEYS = new Set(['doctor', 'professional']);
export const ALL_ROLES_KEY = '__all__';

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
export function effectiveWellnessRole(u) {
  if (u?.wellnessRole) return u.wellnessRole;
  const rbacKey = u?.primaryRole?.key;
  if (rbacKey && typeof rbacKey === 'string') return rbacKey.toLowerCase();
  return null;
}

// Wave 7D — PRD Gap §11 item 4 — booking-type meta. Mirrors
// PublicBooking.jsx so the calendar's per-event badge + legend uses the
// same icons the patient saw at booking time. Default falls back to
// CLINIC_VISIT for legacy rows where bookingType is null.
export const BOOKING_TYPE_META = {
  CLINIC_VISIT: { label: 'Clinic visit',  icon: Building2, color: '#0ea5e9' },
  IN_HOME:      { label: 'At home',       icon: Home,      color: '#10b981' },
  VIDEO:        { label: 'Video consult', icon: Video,     color: '#a855f7' },
  PHONE:        { label: 'Phone consult', icon: Phone,     color: '#f59e0b' },
};
export const BOOKING_TYPE_ORDER = ['CLINIC_VISIT', 'IN_HOME', 'VIDEO', 'PHONE'];

// #263: render the IST calendar day, not the UTC day. toISOString() returns
// UTC, so any IST clock time before 05:30 (e.g. 1 AM IST = 19:30 prev-day UTC)
// previously yielded the wrong date string and the calendar fetched a
// different day than the Owner Dashboard's IST-aware startOfDay()/endOfDay()
// helpers in backend/routes/wellness.js — producing different "today" counts.
export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
export const isoDay = (d) => new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
export const fmtHour = (h) => `${String(h).padStart(2, '0')}:00`;
export const UNASSIGNED_KEY = '__unassigned__';

// Local-calendar helpers shared with the From/To inputs. `<input type="date">`
// reads/writes YYYY-MM-DD in the user's local TZ; the existing isoDay() helper
// is IST-anchored (so the visit fetch window aligns with the backend's IST
// startOfDay/endOfDay). Keep both: yyyy-mm-dd for the inputs, Date for the
// grid + the IST-aware visit fetch.
export function todayLocalDate() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
export function parseLocalDate(yyyymmdd) {
  if (!yyyymmdd || typeof yyyymmdd !== 'string') return new Date();
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  if (!y || !m || !d) return new Date();
  return new Date(y, m - 1, d, 12, 0, 0, 0);
}
export function isoLocalDate(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '';
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

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

// Inline label+input pill — matches the height of the All-staff dropdown +
// All-practitioners pill so the header row sits on one baseline.
export const dateField = { display: 'inline-flex', alignItems: 'center', gap: '0.4rem', padding: '0.35rem 0.65rem', borderRadius: 8, border: '1px solid rgba(255,255,255,0.1)', background: 'transparent' };
export const dateInput = { padding: 0, fontSize: '0.8rem', border: 'none', background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer', colorScheme: 'inherit', outline: 'none', font: 'inherit' };
export const colHead = { padding: '0.5rem 0.75rem', fontWeight: 600, fontSize: '0.8rem', borderBottom: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.02)', color: 'var(--text-primary)' };
export const hourLabel = { padding: '0.5rem', fontSize: '0.7rem', color: 'var(--text-secondary)', textAlign: 'right', borderRight: '1px solid rgba(255,255,255,0.05)' };
export const hourCell = { padding: '0.25rem', display: 'flex', flexDirection: 'column', gap: '0.25rem', minHeight: '60px', borderBottom: '1px solid rgba(255,255,255,0.04)' };
export const modalInput = { padding: '0.5rem 0.7rem', borderRadius: 8, border: '1px solid var(--border-color, rgba(0,0,0,0.15))', background: 'var(--input-bg, rgba(0,0,0,0.03))', color: 'var(--text-primary)', fontSize: '0.9rem', outline: 'none' };
// #629: source-toggle pill — primary brand color when active so it reads
// the same on wellness teal (#265855) as on generic blue.
export const sourceBtn = (active) => ({
  padding: '0.4rem 0.85rem',
  background: active ? 'var(--primary-color, var(--accent-color, #6366f1))' : 'transparent',
  color: active ? '#fff' : 'var(--text-primary)',
  border: `1px solid ${active ? 'transparent' : 'var(--border-color, rgba(0,0,0,0.15))'}`,
  borderRadius: 999,
  cursor: 'pointer',
  fontSize: '0.8rem',
  fontWeight: active ? 600 : 400,
});
