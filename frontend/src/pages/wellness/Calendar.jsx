import { useEffect, useMemo, useState, useContext, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { tenantLocale } from '../../utils/date';
import { AuthContext } from '../../App';
import { usePermissions } from '../../hooks/usePermissions';

import {
  displayStatus,
  hoursForVisits,
  isHolidayForColumn,
  FALLBACK_PRACTITIONER_KEYS,
  ALL_ROLES_KEY,
  effectiveWellnessRole,
  isoDay,
  isoLocalDate,
  parseLocalDate,
  todayLocalDate,
  UNASSIGNED_KEY,
} from './calendar/constants';

import CalendarHeader from './calendar/CalendarHeader';
import HolidayBanner from './calendar/HolidayBanner';
import CalendarDayGrid from './calendar/CalendarDayGrid';
import CalendarLegends from './calendar/CalendarLegends';
import NewVisitModal from './calendar/NewVisitModal';
import AssignDoctorModal from './calendar/AssignDoctorModal';
import UserBookingPanel from './calendar/UserBookingPanel';

// Re-export for backward compatibility (Appointments.jsx, tests).
// eslint-disable-next-line react-refresh/only-export-components
export { displayStatus, hoursForVisits, isHolidayForColumn, AssignDoctorModal };

export default function CalendarGrid() {
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const { hasPermission } = usePermissions();
  // Only regular users (patients) can book appointments, not staff/admins/doctors
  const canBookAppointment = user?.role === 'USER';
  // Assignment/reassignment of practitioners is gated on the appointments.assign
  // permission (or admin/manager). Doctors can see pending visits but cannot
  // assign them to other doctors.
  const canAssignDoctor =
    user?.role === 'ADMIN' ||
    user?.role === 'MANAGER' ||
    hasPermission('appointments', 'assign');
  // Appointments + MyAppointments link here as `?focus=<visitId>&date=<yyyy-mm-dd>`.
  // `date` lets us snap the from/to filter without an extra round-trip; `focus`
  // is the chip we highlight + scroll into view once visits load.
  const [searchParams, setSearchParams] = useSearchParams();
  const focusId = searchParams.get('focus');
  const focusDateParam = searchParams.get('date');
  // Single-day filter. The Calendar is a day-view-by-practitioner layout
  // and previously exposed a FROM/TO dual picker that read as a range
  // filter — users expected a multi-day grid and were confused when only
  // FROM affected the view. Collapsed to ONE `from` input; the `setTo`
  // shim below is preserved for the focus-from-Appointments handshake
  // that still calls both setters in lockstep, and is a no-op.
  const initialDateStr = focusDateParam || todayLocalDate();
  const [from, setFrom] = useState(initialDateStr);
  const setTo = () => {}; // legacy noop — see comment above
  // The day-grid renders ONE day at a time. `date` is the rendered day.
  const [date, setDate] = useState(() => parseLocalDate(initialDateStr));
  const focusedRef = useRef(null);
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
  // Pending visit currently being assigned to a doctor — { id, visitDate, ... }.
  // Set when the user clicks "Assign doctor" on a pending chip.
  const [assignTarget, setAssignTarget] = useState(null);
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
  const [_availLoading, setAvailLoading] = useState(false);

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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [date]);

  // Refresh the calendar grid when the tab regains focus so visits booked
  // from another surface (Book Appointment page, patient portal, another
  // staff workstation) appear without a manual reload. Cheap re-fetch —
  // only fires when the tab becomes visible, not on every render.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        load();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

  // Load doctor availability and user appointments when booking view is shown
  useEffect(() => {
    if (showBooking) {
      loadAvailability();
      loadMyAppointments();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        // Refresh the calendar grid so the new visit appears without manual
        // reload. loadMyAppointments() only refreshes the booker's personal
        // list inside the modal — the grid behind it stays stale otherwise.
        load();
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
  //
  // Hardening: a visit whose doctorId references a staff member NOT in
  // practitionerKeys (deactivated staff, role-config mismatch, legacy
  // seed with no wellnessRole) was previously orphaned — its column
  // never rendered and the visit silently disappeared from the grid.
  // We now force-include any staff id referenced by today's visits so
  // every visit lands in a visible column.
  const practitioners = useMemo(() => {
    const doctorIdsToday = new Set(visits.map((v) => v.doctorId).filter(Boolean));
    let all = allStaff.filter((u) =>
      practitionerKeys.has(effectiveWellnessRole(u)) || doctorIdsToday.has(u.id),
    );
    if (selectedRoleKey !== ALL_ROLES_KEY) {
      // Role-narrowing still respects the orphan-doctor hardening above:
      // a visit's doctor surfaces even if their role doesn't match the
      // narrowing filter, otherwise the role filter could hide visits.
      all = all.filter(
        (u) => effectiveWellnessRole(u) === selectedRoleKey || doctorIdsToday.has(u.id),
      );
    }
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
  //
  // Unassigned is rendered as the FIRST column (leftmost) so portal
  // self-bookings with "No preference — admin will assign" are
  // immediately visible. Pushing it to the end hid pending bookings
  // behind 30+ practitioner columns on large tenants.
  const columns = useMemo(() => {
    const practitionerCols = practitioners.map((d) => ({
      id: d.id,
      name: d.name,
      // Column-header role badge uses the effective role so RBAC-only
      // staff still display a role label (e.g. "NURSE" → "nurse").
      role: effectiveWellnessRole(d),
      isUnassigned: false,
    }));
    // Hardening: synthesise a column for any visit whose doctorId isn't
    // in the practitioners list (staff fully removed from allStaff —
    // e.g. deleted user). Without this, the visit's grid cell never
    // renders and the appointment disappears. Use the embedded
    // visit.doctor relation for the name; flag the column so we can
    // surface "(unavailable)" in the UI.
    const knownIds = new Set(practitionerCols.map((c) => c.id));
    const orphans = new Map();
    for (const v of visits) {
      if (v.doctorId && !knownIds.has(v.doctorId)) {
        if (!orphans.has(v.doctorId)) {
          orphans.set(v.doctorId, {
            id: v.doctorId,
            name: v.doctor?.name ? `${v.doctor.name} (unavailable)` : `Doctor #${v.doctorId} (unavailable)`,
            role: null,
            isUnassigned: false,
            isOrphan: true,
          });
        }
      }
    }
    const orphanCols = Array.from(orphans.values());
    if (visits.some((v) => !v.doctorId)) {
      return [
        { id: UNASSIGNED_KEY, name: 'Unassigned', role: null, isUnassigned: true },
        ...practitionerCols,
        ...orphanCols,
      ];
    }
    return [...practitionerCols, ...orphanCols];
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

  // The grid renders the From date. Keep `date` (the Date object the rest of
  // the component reads) synced to whatever the From input holds. To stays as
  // a filter upper-bound + drives the CSV export window below.
  useEffect(() => {
    if (!from) return;
    const next = parseLocalDate(from);
    if (isoLocalDate(date) !== from) setDate(next);
  }, [from]); // eslint-disable-line react-hooks/exhaustive-deps

  // Focus-from-Appointments handshake. When the URL carries `?focus=<id>` AND
  // no `date=` was provided alongside it (legacy callers), fetch the visit so
  // we can snap to its day. New callers pass both params and skip the fetch.
  useEffect(() => {
    if (!focusId || focusDateParam) return;
    let cancelled = false;
    fetchApi(`/api/wellness/visits/${focusId}`)
      .then((v) => {
        if (cancelled || !v?.visitDate) return;
        const dStr = isoLocalDate(new Date(v.visitDate));
        if (!dStr) return;
        setFrom(dStr);
        setTo(dStr);
        setDate(new Date(v.visitDate));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [focusId, focusDateParam]);

  // After visits load, scroll the focused chip into view + briefly outline it.
  useEffect(() => {
    if (!focusId || !focusedRef.current) return;
    focusedRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [focusId, visits, date]);

  const clearFocus = () => {
    if (!searchParams.has('focus')) return;
    const next = new URLSearchParams(searchParams);
    next.delete('focus');
    next.delete('date');
    setSearchParams(next, { replace: true });
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

  // Single-day picker — the Calendar is a day-view-by-practitioner layout,
  // so the FROM/TO dual-date picker was confusing (users read it as a
  // range filter and expected a multi-day grid). Collapsed into ONE Day
  // input + prev/next arrows. The CSV export filters to this same day;
  // an admin who needs a wider export range can use the staff
  // Appointments page export instead.
  const stepDay = (deltaDays) => {
    const cur = parseLocalDate(from);
    cur.setDate(cur.getDate() + deltaDays);
    const next = isoLocalDate(cur);
    setFrom(next);
    setTo(next);
    clearFocus();
  };
  const dayLabel = date.toLocaleDateString(tenantLocale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <CalendarHeader
        practitionerRoleOptions={practitionerRoleOptions}
        selectedRoleKey={selectedRoleKey}
        onRoleChange={setSelectedRoleKey}
        totalPractitionerCount={totalPractitionerCount}
        visiblePractitionerCount={visiblePractitionerCount}
        selectedRoleLabel={selectedRoleLabel}
        showAll={showAll}
        onToggleShowAll={() => setShowAll((v) => !v)}
        from={from}
        onDateChange={(v) => { setFrom(v); setTo(v); clearFocus(); }}
        onPrevDay={() => stepDay(-1)}
        onNextDay={() => stepDay(1)}
        csvFilters={{
          from: `${from}T00:00:00+05:30`,
          to: `${from}T23:59:59+05:30`,
        }}
        onCsvImported={load}
        dayLabel={dayLabel}
      />

      {loading && <div data-testid="calendar-loading">Loading…</div>}

      {/* Wave 11 Agent GG: red banner when the selected day has any holidays. */}
      {!loading && <HolidayBanner holidays={holidays} />}

      {!loading && columns.length === 0 && (
        <div className="glass" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
          No practitioners configured and no visits scheduled. Add staff under Staff or book a visit.
        </div>
      )}

      {!loading && columns.length > 0 && (
        <CalendarDayGrid
          columns={columns}
          HOURS={HOURS}
          grid={grid}
          focusId={focusId}
          focusedRef={focusedRef}
          canAssignDoctor={canAssignDoctor}
          onEmptyCellClick={(columnId, hour) => setNewVisit({ columnId, hour })}
          onAssignClick={(visit) => setAssignTarget(visit)}
        />
      )}

      {!loading && <CalendarLegends />}

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

      {assignTarget && (
        <AssignDoctorModal
          visit={assignTarget}
          notify={notify}
          onClose={() => setAssignTarget(null)}
          onAssigned={() => { setAssignTarget(null); load(); }}
        />
      )}

      {/* User Appointment Booking Section - Only for regular users */}
      {canBookAppointment && (
        <UserBookingPanel
          showBooking={showBooking}
          onToggleBooking={() => setShowBooking(!showBooking)}
          bookingForm={bookingForm}
          setBookingForm={setBookingForm}
          bookingSubmitting={bookingSubmitting}
          onBookAppointment={handleBookAppointment}
          availability={availability}
          services={services}
          myAppointments={myAppointments}
          onCancelAppointment={handleCancelAppointment}
        />
      )}
    </div>
  );
}
