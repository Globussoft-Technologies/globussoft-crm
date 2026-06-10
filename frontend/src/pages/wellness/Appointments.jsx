import { useContext, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Calendar, Search, Filter, RefreshCw, UserPlus } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { AuthContext } from '../../App';
import { useNotify } from '../../utils/notify';
import { AssignDoctorModal, displayStatus } from './Calendar';

/**
 * Appointments — tenant-wide list view.
 *
 * Backend: GET /api/wellness/visits?from=&to=&doctorId=&status=
 *   - For ADMIN / MANAGER: returns all visits in the tenant matching the
 *     query (every practitioner's column).
 *   - For wellnessRole=doctor: the server overrides doctorId to req.user.
 *     userId (PHI scope per #324), so a doctor opening this page sees
 *     ONLY their own appointments — same data the /my-appointments page
 *     shows. That's intentional: a single endpoint, two surfaces, the
 *     server enforces who sees what.
 *
 * The page assumes the visit row is the "appointment" (in this codebase
 * a booking creates a Visit row with status='booked'; status terms are
 * used interchangeably elsewhere — Calendar.jsx, the booking flow, etc.)
 *
 * Status filter is keyed to the real Visit.status values used elsewhere
 * (per Calendar.jsx palette). 'pending' is a CLIENT-SIDE presentational
 * filter only — it maps to `displayStatus(v) === 'pending'` (i.e.
 * status='booked' && doctorId IS NULL) since the server has no notion
 * of pending separate from booked.
 */
// Real Visit.status set per Calendar.jsx + wellness.js routes. 'pending'
// is presentational only — derived from `booked` + null doctorId via
// displayStatus(). Keep this list in lockstep with Calendar's palette.
const STATUS_OPTIONS = [
  { value: '', label: 'Any status' },
  { value: 'booked', label: 'Booked' },
  { value: 'pending', label: 'Pending (unassigned)', clientOnly: true },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'arrived', label: 'Arrived' },
  { value: 'in-treatment', label: 'In treatment' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'no-show', label: 'No-show' },
];
export default function Appointments() {
  const { user } = useContext(AuthContext) || {};
  const isOrg = user?.role === 'ADMIN' || user?.role === 'MANAGER';
  const notify = useNotify();
  // Pending visit currently being assigned to a doctor. Set when the
  // user clicks the "Assign doctor" action on a pending row.
  const [assignTarget, setAssignTarget] = useState(null);

  // Filter state — default to "this week" so the page is useful without
  // any clicks. Admin can widen / narrow from there.
  const today = useMemo(() => todayLocalDate(), []);
  const oneWeekFromToday = useMemo(() => addDaysLocal(today, 7), [today]);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(oneWeekFromToday);
  const [doctorId, setDoctorId] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [reloadTick, setReloadTick] = useState(0);

  const [visits, setVisits] = useState([]);
  const [doctors, setDoctors] = useState([]); // for the dropdown
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams();
    qs.set('from', `${from}T00:00:00${localTzOffset()}`);
    qs.set('to', `${to}T23:59:59${localTzOffset()}`);
    qs.set('limit', '500');
    if (doctorId) qs.set('doctorId', doctorId);
    // 'pending' is client-side-only — server stores it as 'booked' with
    // null doctorId. Send everything else through as-is.
    if (status && status !== 'pending') qs.set('status', status);
    fetchApi(`/api/wellness/visits?${qs.toString()}`, { silent: true })
      .then((res) => {
        if (cancelled) return;
        setVisits(Array.isArray(res) ? res : Array.isArray(res?.visits) ? res.visits : []);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message || 'Failed to load appointments');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [from, to, doctorId, status, reloadTick]);

  // Doctors dropdown — only needed for admin/manager (doctors see own only).
  // Filter staff to wellnessRole='doctor' OR a primary RBAC role of DOCTOR.
  useEffect(() => {
    if (!isOrg) return;
    let cancelled = false;
    fetchApi('/api/staff', { silent: true })
      .then((res) => {
        if (cancelled) return;
        const all = Array.isArray(res) ? res : [];
        setDoctors(
          all.filter(
            (u) => u.wellnessRole === 'doctor' || u.primaryRole?.key === 'DOCTOR',
          ),
        );
      })
      .catch(() => setDoctors([]));
    return () => {
      cancelled = true;
    };
  }, [isOrg]);

  // Client-side filters: presentational 'pending' status + free-text search.
  // Server already narrows by date / doctor / real status; this layer adds
  // the bits the server can't (pending = booked + no doctor) and per-row
  // search without a round-trip.
  const filtered = useMemo(() => {
    let rows = visits;
    if (status === 'pending') {
      rows = rows.filter((v) => v.status === 'booked' && !v.doctorId);
    }
    const term = search.trim().toLowerCase();
    if (term) {
      rows = rows.filter((v) => {
        const blob = `${v.patient?.name || ''} ${v.service?.name || ''} ${v.doctor?.name || ''}`.toLowerCase();
        return blob.includes(term);
      });
    }
    return rows;
  }, [visits, status, search]);

  // Sort by visitDate ascending so the timeline reads top-to-bottom.
  const sorted = useMemo(
    () => [...filtered].sort((a, b) => new Date(a.visitDate) - new Date(b.visitDate)),
    [filtered],
  );

  return (
    <div style={{ padding: '1.5rem', width: '100%' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: '1rem',
          marginBottom: '1.25rem',
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h1 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Calendar size={22} style={{ color: 'var(--primary-color, var(--accent-color))' }} />
            Appointments
          </h1>
          <p style={{ margin: '0.2rem 0 0', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            {isOrg
              ? 'All clinic appointments. Filter by date, doctor, or status.'
              : 'Your appointments. Date + status filters available.'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setReloadTick((n) => n + 1)}
          className="btn-secondary"
          style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </header>

      {/* Filter bar */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 180px), 1fr))',
          gap: '0.6rem',
          marginBottom: '1rem',
          padding: '0.75rem',
          border: '1px solid var(--border-color)',
          borderRadius: 8,
          background: 'var(--subtle-bg-2)',
        }}
      >
        <label style={fieldLabel}>
          From
          <input
            type="date"
            className="input-field"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            style={{ width: '100%' }}
          />
        </label>
        <label style={fieldLabel}>
          To
          <input
            type="date"
            className="input-field"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            style={{ width: '100%' }}
          />
        </label>
        {isOrg && (
          <label style={fieldLabel}>
            Doctor
            <select
              className="input-field"
              value={doctorId}
              onChange={(e) => setDoctorId(e.target.value)}
              style={{ width: '100%' }}
            >
              <option value="">All doctors</option>
              {doctors.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name || d.email}
                </option>
              ))}
            </select>
          </label>
        )}
        <label style={fieldLabel}>
          Status
          <select
            className="input-field"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            style={{ width: '100%' }}
          >
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt.value || 'any'} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </label>
        <label style={fieldLabel}>
          Search
          <div style={{ position: 'relative' }}>
            <Search
              size={14}
              style={{
                position: 'absolute',
                top: '50%',
                left: 8,
                transform: 'translateY(-50%)',
                color: 'var(--text-secondary)',
                pointerEvents: 'none',
              }}
            />
            <input
              type="search"
              className="input-field"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Patient or service…"
              style={{ width: '100%', paddingLeft: 28 }}
            />
          </div>
        </label>
      </div>

      {error && (
        <div
          role="alert"
          style={{
            background: 'rgba(239,68,68,0.1)',
            color: '#ef4444',
            padding: '0.75rem',
            borderRadius: 8,
            marginBottom: '1rem',
          }}
        >
          {error}
        </div>
      )}

      <div
        style={{
          border: '1px solid var(--border-color)',
          borderRadius: 12,
          overflow: 'auto',
        }}
      >
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: '0.9rem',
            minWidth: 720,
          }}
        >
          <thead>
            <tr style={{ background: 'var(--subtle-bg-3)', textAlign: 'left' }}>
              <Th>When</Th>
              <Th>Patient</Th>
              {isOrg && <Th>Doctor</Th>}
              <Th>Service</Th>
              <Th>Status</Th>
              <Th>Actions</Th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <Td colSpan={isOrg ? 6 : 5} center>
                  Loading appointments…
                </Td>
              </tr>
            )}
            {!loading && sorted.length === 0 && (
              <tr>
                <Td colSpan={isOrg ? 6 : 5} center>
                  <Filter size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                  No appointments match these filters.
                </Td>
              </tr>
            )}
            {!loading &&
              sorted.map((v) => (
                <tr key={v.id} style={{ borderTop: '1px solid var(--border-color)' }}>
                  <Td>
                    <div style={{ fontWeight: 600 }}>
                      {v.visitDate
                        ? new Date(v.visitDate).toLocaleDateString(undefined, {
                            month: 'short',
                            day: 'numeric',
                          })
                        : '—'}
                    </div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                      {v.visitDate
                        ? new Date(v.visitDate).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                          })
                        : ''}
                    </div>
                  </Td>
                  <Td>
                    {v.patient?.id ? (
                      <Link
                        to={`/wellness/patients/${v.patient.id}`}
                        style={{ color: 'inherit', textDecoration: 'none' }}
                      >
                        <strong>{v.patient.name}</strong>
                      </Link>
                    ) : (
                      <span>—</span>
                    )}
                    {v.patient?.phone && (
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                        {v.patient.phone}
                      </div>
                    )}
                  </Td>
                  {isOrg && (
                    <Td>
                      {v.doctor?.name || (
                        <span style={{ color: 'var(--text-secondary)' }}>Unassigned</span>
                      )}
                    </Td>
                  )}
                  <Td>
                    {v.service?.name || (
                      <span style={{ color: 'var(--text-secondary)' }}>—</span>
                    )}
                  </Td>
                  <Td>
                    <StatusBadge status={displayStatus(v)} />
                  </Td>
                  <Td>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', alignItems: 'flex-start' }}>
                      {/* Assign-doctor action — only surfaces for pending
                          visits (doctorId is null and still booked). Org
                          roles only; doctors viewing their own list don't
                          need the action. */}
                      {isOrg && !v.doctorId && v.status === 'booked' && (
                        <button
                          type="button"
                          onClick={() => setAssignTarget(v)}
                          data-testid={`appointments-assign-${v.id}`}
                          style={{
                            display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
                            padding: '0.3rem 0.6rem', borderRadius: 6,
                            fontSize: '0.78rem', fontWeight: 500,
                            background: 'var(--primary-color, var(--accent-color, #6366f1))',
                            color: '#fff', border: 'none', cursor: 'pointer',
                          }}
                        >
                          <UserPlus size={13} /> Assign doctor
                        </button>
                      )}
                      <Link
                        to={`/wellness/calendar?focus=${v.id}${v.visitDate ? `&date=${isoLocalDate(v.visitDate)}` : ''}`}
                        style={{
                          fontSize: '0.8rem',
                          color: 'var(--primary-color, var(--accent-color))',
                          textDecoration: 'none',
                        }}
                      >
                        Open in calendar →
                      </Link>
                    </div>
                  </Td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {!loading && (
        <div
          style={{
            marginTop: '0.75rem',
            fontSize: '0.75rem',
            color: 'var(--text-secondary)',
          }}
        >
          {sorted.length} of {visits.length} appointments shown
        </div>
      )}

      {assignTarget && (
        <AssignDoctorModal
          visit={assignTarget}
          notify={notify}
          onClose={() => setAssignTarget(null)}
          onAssigned={() => {
            setAssignTarget(null);
            // Refetch the list so the just-assigned visit shows its new
            // doctor + drops its Assign button.
            setReloadTick((t) => t + 1);
          }}
        />
      )}
    </div>
  );
}

// ───────────────────────────── helpers + cells ───────────────────────

function todayLocalDate() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function addDaysLocal(yyyymmdd, days) {
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function localTzOffset() {
  const off = -new Date().getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

// Local-calendar-day for a Date / ISO string. Used to pin the calendar
// page to the day the receptionist clicked, regardless of the runtime TZ.
function isoLocalDate(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '';
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function StatusBadge({ status }) {
  const palette = {
    // 'pending' is a presentational status — surfaced for visits whose
    // doctorId is null. The Calendar export `displayStatus` flips
    // status='booked' + doctorId=null into 'pending' so the admin UI
    // never displays raw 'booked' for an unassigned appointment.
    pending: { fg: '#f59e0b', bg: 'rgba(245,158,11,0.12)' },
    booked: { fg: '#3b82f6', bg: 'rgba(59,130,246,0.1)' },
    scheduled: { fg: '#3b82f6', bg: 'rgba(59,130,246,0.1)' },
    'checked-in': { fg: '#0ea5e9', bg: 'rgba(14,165,233,0.1)' },
    'in-progress': { fg: '#a855f7', bg: 'rgba(168,85,247,0.1)' },
    'in-treatment': { fg: '#f59e0b', bg: 'rgba(245,158,11,0.12)' },
    arrived: { fg: '#a855f7', bg: 'rgba(168,85,247,0.12)' },
    confirmed: { fg: '#6366f1', bg: 'rgba(99,102,241,0.12)' },
    completed: { fg: '#10b981', bg: 'rgba(16,185,129,0.1)' },
    cancelled: { fg: '#6b7280', bg: 'rgba(107,114,128,0.1)' },
    'no-show': { fg: '#ef4444', bg: 'rgba(239,68,68,0.1)' },
  };
  const cfg = palette[status] || { fg: 'var(--text-secondary)', bg: 'var(--subtle-bg-3)' };
  return (
    <span
      style={{
        padding: '0.2rem 0.55rem',
        borderRadius: 999,
        fontSize: '0.7rem',
        fontWeight: 600,
        background: cfg.bg,
        color: cfg.fg,
        border: `1px solid ${cfg.fg}33`,
        whiteSpace: 'nowrap',
      }}
    >
      {status || '—'}
    </span>
  );
}

const fieldLabel = {
  fontSize: '0.75rem',
  color: 'var(--text-secondary)',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
};

function Th({ children }) {
  return (
    <th
      style={{
        padding: '0.6rem 0.85rem',
        fontWeight: 600,
        fontSize: '0.75rem',
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        color: 'var(--text-secondary)',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </th>
  );
}

function Td({ children, colSpan, center }) {
  return (
    <td
      colSpan={colSpan}
      style={{
        padding: '0.6rem 0.85rem',
        verticalAlign: 'middle',
        textAlign: center ? 'center' : 'left',
        color: center ? 'var(--text-secondary)' : 'inherit',
      }}
    >
      {children}
    </td>
  );
}
