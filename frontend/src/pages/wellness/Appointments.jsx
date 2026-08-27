import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Calendar, Search, Filter, RefreshCw, UserPlus, Phone, Package } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { AuthContext } from '../../App';
import { useNotify } from '../../utils/notify';
import { AssignDoctorModal, displayStatus } from './Calendar';
import CallifiedCallDialog from '../../components/CallifiedCallDialog';

/**
 * Appointments - tenant-wide list view.
 *
 * Backend: GET /api/wellness/visits?from=&to=&doctorId=&status=&limit=&offset=
 * - For ADMIN / MANAGER: returns all visits in the tenant matching the query.
 * - For wellnessRole=doctor: the server overrides doctorId to req.user.userId.
 *
 * The table loads a page at a time and fetches more rows as the user scrolls
 * toward the bottom of the table container.
 */
const STATUS_OPTIONS = [
  { value: '', label: 'Any status' },
  { value: 'booked', label: 'Booked' },
  { value: 'pending', label: 'Pending (unassigned)', clientOnly: true },
  // A patient asking to use a session they already paid for. Waiting on the
  // clinic to accept it — answered from Catalog → Active Packages.
  { value: 'requested', label: 'Requested (package)' },
  // Not a status: everything that came out of a bought package, whatever
  // stage it is at. Same clientOnly trick as "Pending (unassigned)".
  { value: 'package', label: 'From a package', clientOnly: true },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'arrived', label: 'Arrived' },
  { value: 'in-treatment', label: 'In treatment' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'no-show', label: 'No-show' },
];

const CLIENT_ONLY_STATUSES = new Set(
  STATUS_OPTIONS.filter((o) => o.clientOnly).map((o) => o.value),
);

const PAGE_SIZE = 100;

export default function Appointments() {
  const { user } = useContext(AuthContext) || {};
  const isOrg = user?.role === 'ADMIN' || user?.role === 'MANAGER';
  const notify = useNotify();

  const tableScrollRef = useRef(null);
  const requestSeqRef = useRef(0);
  const requestInFlightRef = useRef(false);
  const hasMoreRef = useRef(true);
  const visitsRef = useRef([]);

  const [assignTarget, setAssignTarget] = useState(null);

  // Callified calling. `null` while we are still asking whether the tenant has
  // the integration configured — the Call action stays hidden until we know,
  // so nobody is offered a button that can only fail.
  const [callifiedReady, setCallifiedReady] = useState(null);
  const [callTarget, setCallTarget] = useState(null);

  const today = useMemo(() => todayLocalDate(), []);
  const oneWeekFromToday = useMemo(() => addDaysLocal(today, 7), [today]);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(oneWeekFromToday);
  const [doctorId, setDoctorId] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [reloadTick, setReloadTick] = useState(0);

  const [visits, setVisits] = useState([]);
  const [doctors, setDoctors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    visitsRef.current = visits;
  }, [visits]);

  useEffect(() => {
    hasMoreRef.current = hasMore;
  }, [hasMore]);

  const loadVisits = useCallback(
    async ({ reset = false } = {}) => {
      if (!reset && (requestInFlightRef.current || !hasMoreRef.current)) return;

      const requestId = ++requestSeqRef.current;
      const nextOffset = reset ? 0 : visitsRef.current.length;
      requestInFlightRef.current = true;

      if (reset) {
        setLoading(true);
        setError(null);
        setVisits([]);
        visitsRef.current = [];
        setHasMore(true);
        hasMoreRef.current = true;
        tableScrollRef.current?.scrollTo({ top: 0 });
      } else {
        setLoadingMore(true);
      }

      try {
        const qs = new URLSearchParams();
        qs.set('from', `${from}T00:00:00${localTzOffset()}`);
        qs.set('to', `${to}T23:59:59${localTzOffset()}`);
        qs.set('limit', String(PAGE_SIZE));
        qs.set('offset', String(nextOffset));
        if (doctorId) qs.set('doctorId', doctorId);
        // clientOnly entries are UI filters, not server statuses — sending
        // one would filter everything away.
        if (status && !CLIENT_ONLY_STATUSES.has(status)) qs.set('status', status);

        const res = await fetchApi(`/api/wellness/visits?${qs.toString()}`, { silent: true });
        const nextRows = Array.isArray(res) ? res : Array.isArray(res?.visits) ? res.visits : [];
        if (requestSeqRef.current !== requestId) return;

        const combined = reset ? nextRows : [...visitsRef.current, ...nextRows];
        const nextHasMore = nextRows.length === PAGE_SIZE;

        visitsRef.current = combined;
        setVisits(combined);
        setHasMore(nextHasMore);
        hasMoreRef.current = nextHasMore;
      } catch (err) {
        if (requestSeqRef.current !== requestId) return;
        setError(err?.message || 'Failed to load appointments');
      } finally {
        if (requestSeqRef.current === requestId) {
          requestInFlightRef.current = false;
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [from, to, doctorId, status],
  );

  useEffect(() => {
    loadVisits({ reset: true });
  }, [loadVisits, reloadTick]);

  useEffect(() => {
    if (!isOrg) {
      setDoctors([]);
      return undefined;
    }

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

  useEffect(() => {
    let cancelled = false;
    fetchApi('/api/wellness/callified/status', { silent: true })
      .then((res) => {
        if (cancelled) return;
        setCallifiedReady(Boolean(res?.configured && res?.enabled));
      })
      // A 403 here just means this role may not place calls; a 503 means the
      // tenant has no Callified credentials. Either way: no call action.
      .catch(() => {
        if (!cancelled) setCallifiedReady(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const visibleRows = useMemo(() => {
    let rows = visits;
    if (status === 'pending') {
      rows = rows.filter((v) => v.status === 'booked' && !v.doctorId);
    }
    if (status === 'package') {
      rows = rows.filter((v) => Boolean(v.treatmentPlan));
    }

    const term = search.trim().toLowerCase();
    if (term) {
      rows = rows.filter((v) => {
        const blob = `${v.patient?.name || ''} ${v.service?.name || ''} ${v.doctor?.name || ''} ${v.treatmentPlan?.name || ''}`.toLowerCase();
        return blob.includes(term);
      });
    }

    return rows;
  }, [visits, status, search]);

  useEffect(() => {
    if (!tableScrollRef.current || loading || loadingMore || !hasMore) return;
    const el = tableScrollRef.current;
    if (el.scrollHeight <= el.clientHeight + 24) {
      loadVisits({ reset: false });
    }
  }, [visibleRows, loading, loadingMore, hasMore, loadVisits]);

  const handleTableScroll = useCallback(
    (e) => {
      const el = e.currentTarget;
      if (!el || requestInFlightRef.current || !hasMoreRef.current) return;
      const threshold = 96;
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - threshold) {
        loadVisits({ reset: false });
      }
    },
    [loadVisits],
  );

  const handleRefresh = () => {
    tableScrollRef.current?.scrollTo({ top: 0 });
    setReloadTick((n) => n + 1);
  };

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
            <Calendar size={22} style={{ color: 'var(--accent-color)' }} />
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
          onClick={handleRefresh}
          className="btn-secondary"
          style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </header>

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
              <option key={opt.value || 'any'} value={opt.value}>
                {opt.label}
              </option>
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
              placeholder="Patient or service..."
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
        ref={tableScrollRef}
        onScroll={handleTableScroll}
        style={{
          border: '1px solid var(--border-color)',
          borderRadius: 12,
          overflow: 'auto',
          maxHeight: 'calc(100vh - 350px)',
          background: 'var(--surface-color)',
        }}
      >
        <table
          style={{
            width: '100%',
            borderCollapse: 'separate',
            borderSpacing: 0,
            fontSize: '0.9rem',
            minWidth: 720,
            background: 'transparent',
          }}
        >
          <thead>
            <tr style={{ textAlign: 'left' }}>
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
                  Loading appointments...
                </Td>
              </tr>
            )}
            {!loading && visibleRows.length === 0 && (
              <tr>
                <Td colSpan={isOrg ? 6 : 5} center>
                  <Filter size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                  No appointments match these filters.
                </Td>
              </tr>
            )}
            {!loading &&
              visibleRows.map((v) => (
                <tr key={v.id} style={{ borderTop: '1px solid var(--border-color)' }}>
                  <Td>
                    <div style={{ fontWeight: 600 }}>
                      {v.visitDate
                        ? new Date(v.visitDate).toLocaleDateString(undefined, {
                            month: 'short',
                            day: 'numeric',
                          })
                        : '-'}
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
                      <span>-</span>
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
                      <span style={{ color: 'var(--text-secondary)' }}>-</span>
                    )}
                    {/* Already paid for as part of a package — say so on the
                        row, next to the service it is being taken against. */}
                    {v.treatmentPlan && (
                      <div
                        data-testid={`appointments-package-${v.id}`}
                        title={`Session from the package "${v.treatmentPlan.name}" — already paid for`}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '0.3rem',
                          marginTop: '0.25rem',
                          padding: '0.1rem 0.45rem',
                          borderRadius: 999,
                          fontSize: '0.68rem',
                          fontWeight: 600,
                          background: 'rgba(16,185,129,0.12)',
                          color: '#10b981',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        <Package size={11} />
                        Package · session {Math.min(v.treatmentPlan.completedSessions + 1, v.treatmentPlan.totalSessions)} of{' '}
                        {v.treatmentPlan.totalSessions}
                      </div>
                    )}
                  </Td>
                  <Td>
                    <StatusBadge status={displayStatus(v)} />
                  </Td>
                  <Td>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', alignItems: 'flex-start' }}>
                      {isOrg && !v.doctorId && v.status === 'booked' && (
                        <button
                          type="button"
                          onClick={() => setAssignTarget(v)}
                          data-testid={`appointments-assign-${v.id}`}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '0.3rem',
                            padding: '0.3rem 0.6rem',
                            borderRadius: 6,
                            fontSize: '0.78rem',
                            fontWeight: 500,
                            background: 'var(--primary-color, var(--accent-color, #6366f1))',
                            color: '#fff',
                            border: 'none',
                            cursor: 'pointer',
                          }}
                        >
                          <UserPlus size={13} /> Assign doctor
                        </button>
                      )}
                      {callifiedReady && (
                        <CallAction
                          visit={v}
                          onCall={() => setCallTarget(v)}
                        />
                      )}
                      {/* Accepting needs a practitioner AND flips the status,
                          which the assign-doctor modal does not do — send
                          staff to the queue that handles both. */}
                      {v.status === 'requested' && (
                        <Link
                          to="/wellness/services?tab=activetreatments"
                          data-testid={`appointments-review-request-${v.id}`}
                          style={{
                            fontSize: '0.8rem',
                            color: 'var(--text-primary)',
                            textDecoration: 'underline',
                            textUnderlineOffset: '2px',
                          }}
                        >
                          Review request
                        </Link>
                      )}
                      <Link
                        to={`/wellness/calendar?focus=${v.id}${v.visitDate ? `&date=${isoLocalDate(v.visitDate)}` : ''}`}
                        style={{
                          fontSize: '0.8rem',
                          // Was --primary-color, which is #1F2220 charcoal in
                          // BOTH wellness modes — 1.2:1 on the dark surface,
                          // i.e. invisible. --accent-color fixes dark (8.7:1)
                          // but drops light to 2.1:1, so for TEXT we use
                          // --text-primary instead: 17:1 dark, 12:1 light.
                          // Underline carries the link affordance that the
                          // colour cue no longer does.
                          color: 'var(--text-primary)',
                          textDecoration: 'underline',
                          textUnderlineOffset: '2px',
                        }}
                      >
                        Open in calendar
                      </Link>
                    </div>
                  </Td>
                </tr>
              ))}
            {loadingMore && (
              <tr>
                <Td colSpan={isOrg ? 6 : 5} center>
                  Loading more appointments...
                </Td>
              </tr>
            )}
            {!loading && !loadingMore && hasMore && visibleRows.length > 0 && (
              <tr>
                <Td colSpan={isOrg ? 6 : 5} center>
                  Scroll to load more appointments.
                </Td>
              </tr>
            )}
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
          {visibleRows.length} shown from {visits.length} loaded appointments
          {hasMore ? ' - more available below' : ''}
        </div>
      )}

      {assignTarget && (
        <AssignDoctorModal
          visit={assignTarget}
          notify={notify}
          onClose={() => setAssignTarget(null)}
          onAssigned={() => {
            setAssignTarget(null);
            setReloadTick((t) => t + 1);
          }}
        />
      )}

      {callTarget && (
        <CallifiedCallDialog
          customer={{
            name: callTarget.patient?.name,
            phone: callTarget.patient?.phone,
            subtitle: callTarget.service?.name || null,
          }}
          endpoints={{
            context: `/api/wellness/callified/visits/${callTarget.id}/context`,
            campaigns: '/api/wellness/callified/campaigns',
            aiCall: `/api/wellness/callified/visits/${callTarget.id}/ai-call`,
            manualCall: `/api/wellness/callified/visits/${callTarget.id}/manual-call`,
          }}
          onClose={() => setCallTarget(null)}
        />
      )}
    </div>
  );
}

/**
 * Per-row call action.
 *
 * A patient with no dialable number still gets the control, disabled with a
 * reason — silently hiding it reads as a missing feature, and the operator
 * needs to know WHY they cannot call so they can go fix the phone number.
 */
function CallAction({ visit, onCall }) {
  const phone = visit.patient?.phone || '';
  const dialable = phone.replace(/\D/g, '').length >= 10;

  return (
    <button
      type="button"
      // btn-secondary carries the theme-aware pairing: --surface-color fill
      // with --text-primary label, both redefined per light/dark. Only the
      // sizing is overridden here — hand-picking colours is what made this
      // button invisible on dark (see the accent note below).
      className="btn-secondary"
      onClick={onCall}
      disabled={!dialable}
      data-testid={`appointments-call-${visit.id}`}
      title={dialable ? `Call ${visit.patient?.name || 'customer'}` : 'No valid phone number on file'}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.3rem',
        padding: '0.3rem 0.6rem',
        borderRadius: 6,
        fontSize: '0.78rem',
        cursor: dialable ? 'pointer' : 'not-allowed',
        opacity: dialable ? 1 : 0.55,
      }}
    >
      {/* --accent-color, NOT --primary-color: in the wellness theme
          --primary-color is #1F2220 charcoal in BOTH modes (it is the
          sidebar/hero background), so using it as a foreground renders
          charcoal-on-black. --accent-color is a true accent and IS
          redefined per mode (gold #C9A063 light / #D9A468 dark). */}
      <Phone size={13} style={{ color: 'var(--accent-color)' }} /> Call
    </button>
  );
}

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
    pending: { fg: '#f59e0b', bg: 'rgba(245,158,11,0.12)' },
    // A package session a patient has asked for, not yet accepted by the clinic.
    requested: { fg: '#f59e0b', bg: 'rgba(245,158,11,0.12)' },
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
      {status || '-'}
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
        position: 'sticky',
        top: 0,
        zIndex: 4,
        padding: '0.6rem 0.85rem',
        fontWeight: 600,
        fontSize: '0.75rem',
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        color: 'var(--text-secondary)',
        whiteSpace: 'nowrap',
        background: 'var(--bg-color)',
        backgroundClip: 'padding-box',
        boxShadow: 'inset 0 -1px 0 var(--border-color), 0 1px 0 var(--border-color)',
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
