import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Calendar, Search, Filter, RefreshCw, UserPlus, Phone, Package, ChevronLeft, ChevronRight } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { AuthContext } from '../../App';
import { useNotify } from '../../utils/notify';
import { AssignDoctorModal, displayStatus } from './Calendar';
import CallifiedCallDialog from '../../components/CallifiedCallDialog';

const STATUS_OPTIONS = [
  { value: '', label: 'Any status' },
  { value: 'booked', label: 'Booked' },
  { value: 'pending', label: 'Pending (unassigned)', clientOnly: true },
  { value: 'requested', label: 'Requested (package)' },
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

const PAGE_SIZE = 25;
const EMPTY_PAGINATION = {
  total: 0,
  page: 1,
  limit: PAGE_SIZE,
  offset: 0,
  pages: 1,
  hasPrev: false,
  hasNext: false,
};

export default function Appointments() {
  const { user } = useContext(AuthContext) || {};
  const isOrg = user?.role === 'ADMIN' || user?.role === 'MANAGER';
  const notify = useNotify();
  const requestSeqRef = useRef(0);

  const [assignTarget, setAssignTarget] = useState(null);
  const [callifiedReady, setCallifiedReady] = useState(null);
  const [callTarget, setCallTarget] = useState(null);

  const today = useMemo(() => todayLocalDate(), []);
  const oneWeekFromToday = useMemo(() => addDaysLocal(today, 7), [today]);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(oneWeekFromToday);
  const [doctorId, setDoctorId] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState(
    () => sessionStorage.getItem('appointments-search') || ''
  );
  const [page, setPage] = useState(1);
  const [reloadTick, setReloadTick] = useState(0);

  const [visits, setVisits] = useState([]);
  const [doctors, setDoctors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pagination, setPagination] = useState(EMPTY_PAGINATION);
  const [error, setError] = useState(null);

  const loadVisits = useCallback(async () => {
    const requestId = ++requestSeqRef.current;
    setLoading(true);
    setError(null);

    try {
      const qs = new URLSearchParams();
      // An empty date box means "no bound", not "midnight on nothing".
      // Sending it unconditionally produced `from=T00:00:00+05:30`, which the
      // route fed straight to `new Date()` — an Invalid Date that Prisma threw
      // on, so clearing the filter answered with a 500 instead of the
      // unfiltered list.
      if (from) qs.set('from', `${from}T00:00:00${localTzOffset()}`);
      if (to) qs.set('to', `${to}T23:59:59${localTzOffset()}`);
      qs.set('paginate', 'true');
      qs.set('page', String(page));
      qs.set('limit', String(PAGE_SIZE));
      if (doctorId) qs.set('doctorId', doctorId);
      if (status === 'pending' || status === 'booked') {
        qs.set('displayStatus', status);
      } else if (status === 'package') {
        qs.set('fromPackage', 'true');
      } else if (status && !CLIENT_ONLY_STATUSES.has(status)) {
        qs.set('status', status);
      }
      if (search.trim()) qs.set('q', search.trim());

      const res = await fetchApi(`/api/wellness/visits?${qs.toString()}`, { silent: true });
      if (requestSeqRef.current !== requestId) return;

      const nextRows = Array.isArray(res) ? res : Array.isArray(res?.visits) ? res.visits : [];
      const nextPagination = res?.pagination || {
        total: nextRows.length,
        page,
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
        pages: Math.max(1, Math.ceil(nextRows.length / PAGE_SIZE)),
        hasPrev: page > 1,
        hasNext: nextRows.length === PAGE_SIZE,
      };

      setVisits(nextRows);
      setPagination(nextPagination);
    } catch (err) {
      if (requestSeqRef.current !== requestId) return;
      setError(err?.message || 'Failed to load appointments');
      setVisits([]);
      setPagination(EMPTY_PAGINATION);
    } finally {
      if (requestSeqRef.current === requestId) {
        setLoading(false);
      }
    }
  }, [from, to, doctorId, status, search, page]);

  useEffect(() => {
    loadVisits();
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
      .catch(() => {
        if (!cancelled) setCallifiedReady(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleRefresh = () => {
    setReloadTick((n) => n + 1);
  };

  const totalPages = Math.max(1, pagination.pages || 1);
  const pageStart = pagination.total === 0 ? 0 : ((pagination.page - 1) * pagination.limit) + 1;
  const pageEnd = pagination.total === 0
    ? 0
    : Math.min(pagination.total, ((pagination.page - 1) * pagination.limit) + visits.length);
  const pageButtons = buildPageButtons(pagination.page, totalPages);

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
            onChange={(e) => {
              setFrom(e.target.value);
              setPage(1);
            }}
            style={{ width: '100%' }}
          />
        </label>
        <label style={fieldLabel}>
          To
          <input
            type="date"
            className="input-field"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setPage(1);
            }}
            style={{ width: '100%' }}
          />
        </label>
        {isOrg && (
          <label style={fieldLabel}>
            Doctor
            <select
              className="input-field"
              value={doctorId}
              onChange={(e) => {
                setDoctorId(e.target.value);
                setPage(1);
              }}
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
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
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
              onChange={(e) => {
                const value = e.target.value;
                setSearch(value);
                sessionStorage.setItem('appointments-search', value);
                setPage(1);
              }}
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
            {!loading && visits.length === 0 && (
              <tr>
                <Td colSpan={isOrg ? 6 : 5} center>
                  <Filter size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                  No appointments match these filters.
                </Td>
              </tr>
            )}
            {!loading &&
              visits.map((v) => (
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
          </tbody>
        </table>
      </div>

      {!loading && (
        <div style={paginationBar}>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
            {pageStart}-{pageEnd} of {pagination.total} appointments
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setPage((n) => Math.max(1, n - 1))}
              disabled={!pagination.hasPrev}
              aria-label="Previous page"
              style={pagerBtnStyle}
            >
              <ChevronLeft size={14} /> Previous
            </button>
            {pageButtons.map((token, idx) => (
              token === '…' ? (
                <span key={`ellipsis-${idx}`} style={{ color: 'var(--text-secondary)', padding: '0 0.15rem' }}>…</span>
              ) : (
                <button
                  key={token}
                  type="button"
                  onClick={() => setPage(token)}
                  aria-current={token === pagination.page ? 'page' : undefined}
                  className={token === pagination.page ? '' : 'btn-secondary'}
                  style={{
                    ...pageNumberBtnStyle,
                    ...(token === pagination.page ? activePageBtnStyle : null),
                  }}
                >
                  {token}
                </button>
              )
            ))}
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setPage((n) => Math.min(totalPages, n + 1))}
              disabled={!pagination.hasNext}
              aria-label="Next page"
              style={pagerBtnStyle}
            >
              Next <ChevronRight size={14} />
            </button>
          </div>
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

function CallAction({ visit, onCall }) {
  const phone = visit.patient?.phone || '';
  const dialable = phone.replace(/\D/g, '').length >= 10;

  return (
    <button
      type="button"
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

const paginationBar = {
  marginTop: '0.85rem',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.8rem',
  flexWrap: 'wrap',
};

const pagerBtnStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.35rem',
  padding: '0.42rem 0.75rem',
  fontSize: '0.78rem',
};

const pageNumberBtnStyle = {
  minWidth: 34,
  height: 34,
  borderRadius: 8,
  border: '1px solid var(--border-color)',
  background: 'var(--surface-color)',
  color: 'var(--text-primary)',
  cursor: 'pointer',
  fontSize: '0.78rem',
  fontWeight: 600,
};

const activePageBtnStyle = {
  background: 'var(--accent-color)',
  border: '1px solid var(--accent-color)',
  color: '#fff',
  boxShadow: '0 8px 20px rgba(0,0,0,0.18)',
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

function buildPageButtons(currentPage, totalPages) {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
  if (currentPage <= 4) return [1, 2, 3, 4, 5, '…', totalPages];
  if (currentPage >= totalPages - 3) return [1, '…', totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
  return [1, '…', currentPage - 1, currentPage, currentPage + 1, '…', totalPages];
}
