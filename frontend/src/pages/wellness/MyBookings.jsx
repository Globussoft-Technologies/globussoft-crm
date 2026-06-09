import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Calendar as CalendarIcon,
  Clock,
  Stethoscope,
  Info,
  X,
  RotateCcw,
  CheckCircle2,
  AlertCircle,
  Hourglass,
  Ban,
  Plus,
  UserCircle,
} from 'lucide-react';
import { fetchApi } from '../../utils/api';
import PageHeader from '../../components/PageHeader';
import { useNotify } from '../../utils/notify';
import { AuthContext } from '../../App';

// MyBookings — patient appointment management page.
//
// Used by TWO shells (component reused, route differs):
//   1. Authenticated CUSTOMER session  → /wellness/my-bookings
//      (default fetcher = fetchApi, regular Bearer token from sessionStorage)
//   2. Phone+OTP patient portal        → embedded in PatientPortal.jsx
//      (fetcher prop = wrapper around portalFetch + portal token)
//
// PATIENT DETECTION (Phase 1 — no dedicated PATIENT role)
//
// Detection happens at the BACKEND boundary, not in this component:
//   • verifyPatientToken accepts both cohorts (Path A = phone+OTP,
//     Path B = CUSTOMER session resolved to Patient via userId join /
//     email claim / auto-create).
//   • The SPA route guard treats a user as a "patient session" when
//     user.role === 'CUSTOMER' && tenant.vertical === 'wellness'.
//   • All endpoints under /api/wellness/portal/appointments/* scope by
//     patientId server-side — cross-patient access is structurally
//     impossible even if RBAC misconfigures the grant.
//
// MIGRATION NOTE: if a dedicated PATIENT role is introduced later, the
// only changes needed are (a) the role check above, (b) the CUSTOMER
// system role grants in backend/lib/portalPermissions.js +
// backend/scripts/ensureRbacOnBoot.js. This component stays untouched.

const BUCKETS = [
  { key: 'upcoming',  label: 'Upcoming Appointments', icon: CalendarIcon,   tone: 'rgba(99,102,241,0.18)',  border: '#6366f1' },
  { key: 'pending',   label: 'Pending Assignment',    icon: Hourglass,       tone: 'rgba(245,158,11,0.20)', border: '#f59e0b' },
  { key: 'completed', label: 'Completed Visits',      icon: CheckCircle2,    tone: 'rgba(16,185,129,0.18)', border: '#10b981' },
  { key: 'cancelled', label: 'Cancelled Appointments',icon: Ban,             tone: 'rgba(100,116,139,0.18)',border: '#64748b' },
];

const STATUS_LABEL = {
  booked:        'Booked',
  confirmed:     'Confirmed',
  arrived:       'Arrived',
  'in-treatment':'In treatment',
  completed:     'Completed',
  cancelled:     'Cancelled',
  'no-show':     'No-show',
};

const STATUS_PILL = {
  booked:        { bg: 'rgba(59,130,246,0.18)',  fg: '#3b82f6' },
  confirmed:     { bg: 'rgba(99,102,241,0.20)',  fg: '#6366f1' },
  arrived:       { bg: 'rgba(168,85,247,0.20)',  fg: '#a855f7' },
  'in-treatment':{ bg: 'rgba(245,158,11,0.25)',  fg: '#f59e0b' },
  completed:     { bg: 'rgba(16,185,129,0.20)',  fg: '#10b981' },
  cancelled:     { bg: 'rgba(100,116,139,0.20)', fg: '#64748b' },
  'no-show':     { bg: 'rgba(239,68,68,0.20)',   fg: '#ef4444' },
};

const formatDateTimeIst = (d) => {
  if (!d) return '—';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '—';
  return dt.toLocaleString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }) + ' IST';
};

// Default fetcher — uses the staff/customer auth token from sessionStorage.
// Wrapped so the call shape `fetcher(url, options)` is uniform across
// shells (the phone+OTP shell passes a fetcher that binds its portal
// token).
//
// `silent: true` prevents fetchApi's global 401 handler from clearing the
// auth token and force-redirecting to /login. The portal endpoints below
// reject non-CUSTOMER sessions with 401; without silent, an ADMIN / staff
// user who lands on this page (e.g. via a granted my_bookings permission
// they shouldn't have) would be unceremoniously logged out instead of
// seeing the role-mismatch message rendered below.
const defaultFetcher = (url, options = {}) => fetchApi(url, { silent: true, ...options });

export default function MyBookings({
  fetcher,
  // When true, hide the "Book a new appointment" CTA (e.g. the phone+OTP
  // portal handles booking through its own dedicated form).
  hideBookCta = false,
  // Optional override URL for the "Book a new appointment" link. Defaults
  // to the SPA's /wellness/book-appointment route.
  bookHref = '/wellness/book-appointment',
}) {
  const notify = useNotify();
  const auth = useContext(AuthContext) || {};
  const authUser = auth.user || null;
  // Custom fetcher injected by the phone+OTP portal shell. When present
  // we trust the caller — that shell doesn't use AuthContext (its
  // session is the phone-OTP token, not the staff JWT).
  const usingInjectedFetcher = typeof fetcher === 'function';
  const effectiveFetcher = usingInjectedFetcher ? fetcher : defaultFetcher;
  // Patient detection happens at the BACKEND boundary, not here. The
  // /portal/appointments endpoints accept any session whose userId is
  // linked to a Patient row in this tenant — both CUSTOMER and the
  // tenant's USER role (commonly used as a patient pool) work. Real
  // staff (admin/doctor/nurse) have no linked Patient row and get a
  // 403 NO_PATIENT_PROFILE response, which this page renders as a
  // role-mismatch view (no forced logout — silent:true on the fetcher).
  //
  // The frontend doesn't try to classify roles itself: the page catalog
  // permission (`my_bookings.read`) is the sidebar gate, and the
  // backend's Patient.userId join is the data gate. This avoids the
  // tight CUSTOMER-only coupling that broke users whose tenant treats
  // the USER role as patients.
  const [activeBucket, setActiveBucket] = useState('upcoming');
  const [appointmentsByBucket, setAppointmentsByBucket] = useState({});
  const [countsByBucket, setCountsByBucket] = useState({});
  const [loadingBuckets, setLoadingBuckets] = useState({});
  const [error, setError] = useState(null);
  // Backend signals "this account isn't a patient" via 403 with
  // code NO_PATIENT_PROFILE — switch to the role-mismatch view when set.
  const [noPatientProfile, setNoPatientProfile] = useState(false);
  const [selectedAppt, setSelectedAppt] = useState(null);
  const [rescheduleTarget, setRescheduleTarget] = useState(null);
  const [rescheduleForm, setRescheduleForm] = useState({ date: '', time: '' });
  const [rescheduleSubmitting, setRescheduleSubmitting] = useState(false);
  const [cancelSubmitting, setCancelSubmitting] = useState(false);

  const loadBucket = useCallback(async (bucket) => {
    setLoadingBuckets((s) => ({ ...s, [bucket]: true }));
    try {
      const data = await effectiveFetcher(`/api/wellness/portal/appointments?bucket=${bucket}`);
      const appts = Array.isArray(data?.appointments) ? data.appointments : [];
      setAppointmentsByBucket((s) => ({ ...s, [bucket]: appts }));
      setCountsByBucket((s) => ({ ...s, [bucket]: appts.length }));
      setError(null);
      setNoPatientProfile(false);
    } catch (err) {
      // 403 NO_PATIENT_PROFILE from verifyPatientToken means this user
      // (staff role, no linked Patient row) shouldn't be on this page.
      // Flip the role-mismatch view ON and stop further fetches.
      if (err?.status === 403 || /not linked to a patient profile/i.test(err?.message || '')) {
        setNoPatientProfile(true);
        setError(null);
      } else {
        setError(err?.message || 'Failed to load appointments');
      }
    } finally {
      setLoadingBuckets((s) => ({ ...s, [bucket]: false }));
    }
  }, [effectiveFetcher]);

  // Load every bucket on mount so the section counts are populated. Each
  // bucket is independent — UI shows them in parallel. Stop firing once
  // the backend has confirmed this isn't a patient session (so we don't
  // flood the API with 403s on every focus event).
  useEffect(() => {
    if (noPatientProfile) return;
    BUCKETS.forEach((b) => { loadBucket(b.key); });
  }, [loadBucket, noPatientProfile]);

  // Refetch the active bucket whenever the tab regains focus, so visits
  // created / cancelled elsewhere (Calendar, staff override, another
  // patient portal session) appear without a manual reload.
  useEffect(() => {
    if (noPatientProfile) return;
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        loadBucket(activeBucket);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onVisibility);
    };
  }, [activeBucket, loadBucket, noPatientProfile]);

  const handleCancel = useCallback(async (appt) => {
    if (!appt || cancelSubmitting) return;
    const ok = await notify.confirm({
      title: 'Cancel appointment',
      message: `Cancel your ${formatDateTimeIst(appt.appointmentDate)} appointment with ${appt.doctorName}?`,
      confirmText: 'Cancel appointment',
      destructive: true,
    });
    if (!ok) return;
    setCancelSubmitting(true);
    try {
      await effectiveFetcher(`/api/wellness/portal/appointments/${appt.id}/cancel`, { method: 'POST' });
      notify.success('Appointment cancelled');
      setSelectedAppt(null);
      // Refresh affected buckets — the cancelled appointment vanishes from
      // its source bucket and reappears under "Cancelled".
      await Promise.all([loadBucket('upcoming'), loadBucket('pending'), loadBucket('cancelled')]);
    } catch (err) {
      notify.error(err?.message || 'Failed to cancel appointment');
    } finally {
      setCancelSubmitting(false);
    }
  }, [effectiveFetcher, notify, loadBucket, cancelSubmitting]);

  const handleReschedule = useCallback(async () => {
    if (!rescheduleTarget || rescheduleSubmitting) return;
    if (!rescheduleForm.date || !rescheduleForm.time) {
      notify.error('Pick a new date and time');
      return;
    }
    setRescheduleSubmitting(true);
    try {
      await effectiveFetcher(`/api/wellness/portal/appointments/${rescheduleTarget.id}/reschedule`, {
        method: 'PATCH',
        body: JSON.stringify({
          appointmentDate: rescheduleForm.date,
          appointmentTime: rescheduleForm.time,
        }),
      });
      notify.success('Appointment rescheduled');
      setRescheduleTarget(null);
      setRescheduleForm({ date: '', time: '' });
      setSelectedAppt(null);
      await Promise.all([loadBucket('upcoming'), loadBucket('pending')]);
    } catch (err) {
      notify.error(err?.message || 'Failed to reschedule appointment');
    } finally {
      setRescheduleSubmitting(false);
    }
  }, [effectiveFetcher, notify, loadBucket, rescheduleTarget, rescheduleForm, rescheduleSubmitting]);

  const activeAppointments = appointmentsByBucket[activeBucket] || [];
  const activeLoading = !!loadingBuckets[activeBucket];

  const activeBucketMeta = useMemo(
    () => BUCKETS.find((b) => b.key === activeBucket) || BUCKETS[0],
    [activeBucket],
  );

  // Role-mismatch view — fired when the backend reports
  // NO_PATIENT_PROFILE (403). Triggered for real staff (admin / doctor /
  // nurse / manager) who land here via a misgranted `my_bookings.read`
  // permission. The backend's Patient.userId join is the authoritative
  // check; the frontend just renders the friendly fallback.
  if (noPatientProfile) {
    const roleLabel = authUser?.role || 'staff';
    return (
      <div style={{ padding: '1rem', maxWidth: '720px', margin: '0 auto' }}>
        <div className="glass" data-testid="my-bookings-role-mismatch" style={{ padding: '2rem', borderRadius: '12px', textAlign: 'center' }}>
          <UserCircle size={40} style={{ opacity: 0.5, marginBottom: '0.75rem' }} />
          <h2 style={{ margin: '0 0 0.5rem 0' }}>No patient profile linked to this account</h2>
          <p style={{ color: 'var(--text-secondary)', maxWidth: '480px', margin: '0 auto 1rem auto', lineHeight: 1.5 }}>
            You&apos;re signed in as <strong>{roleLabel}</strong>. This page lists appointments belonging to your own patient
            profile, but this account isn&apos;t linked to one. If you take or manage appointments as staff, use the operational
            Calendar or your practitioner schedule below.
          </p>
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center', flexWrap: 'wrap' }}>
            <Link
              to="/wellness/calendar"
              style={{
                padding: '0.55rem 1rem', borderRadius: '8px',
                background: 'var(--primary-color, var(--accent-color, #6366f1))',
                color: '#fff', textDecoration: 'none', fontWeight: 500,
              }}
            >
              Open Calendar
            </Link>
            <Link
              to="/wellness/my-appointments"
              style={{
                padding: '0.55rem 1rem', borderRadius: '8px',
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.12)',
                color: 'var(--text-primary)', textDecoration: 'none',
              }}
            >
              My appointments (practitioner)
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: '1rem', maxWidth: '1100px', margin: '0 auto' }}>
      <PageHeader
        icon={CalendarIcon}
        title="My Bookings"
        description="View, reschedule, or cancel your appointments"
      >
        {!hideBookCta && (
          <Link
            to={bookHref}
            data-testid="my-bookings-book-cta"
            style={{
              padding: '0.6rem 1rem',
              borderRadius: '8px',
              background: 'var(--primary-color, var(--accent-color, #6366f1))',
              color: '#fff',
              textDecoration: 'none',
              fontSize: '0.9rem',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.4rem',
              fontWeight: 500,
            }}
          >
            <Plus size={16} />
            Book a new appointment
          </Link>
        )}
      </PageHeader>

      {/* Bucket tabs */}
      <div
        role="tablist"
        aria-label="Appointment buckets"
        style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: '0.5rem', marginBottom: '1rem' }}
      >
        {BUCKETS.map((b) => {
          const Icon = b.icon;
          const active = b.key === activeBucket;
          const count = countsByBucket[b.key];
          return (
            <button
              key={b.key}
              role="tab"
              aria-selected={active}
              data-testid={`my-bookings-tab-${b.key}`}
              onClick={() => setActiveBucket(b.key)}
              className="glass"
              style={{
                padding: '0.75rem 1rem',
                borderRadius: '10px',
                border: active ? `2px solid ${b.border}` : '2px solid transparent',
                background: active ? b.tone : 'rgba(255,255,255,0.04)',
                color: 'var(--text-primary)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '0.6rem',
                textAlign: 'left',
                minWidth: 0,
              }}
            >
              <Icon size={18} style={{ flexShrink: 0, color: b.border }} />
              <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <span style={{ fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{b.label}</span>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                  {count == null ? '—' : `${count} ${count === 1 ? 'appointment' : 'appointments'}`}
                </span>
              </div>
            </button>
          );
        })}
      </div>

      {/* Bucket body */}
      <div className="glass" style={{ padding: '1rem', borderRadius: '10px' }}>
        {error && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.75rem', borderRadius: '8px', background: 'rgba(239,68,68,0.12)', color: '#ef4444', marginBottom: '0.75rem' }}>
            <AlertCircle size={16} />
            <span>{error}</span>
          </div>
        )}
        {activeLoading ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
            Loading appointments…
          </div>
        ) : activeAppointments.length === 0 ? (
          <div data-testid={`my-bookings-empty-${activeBucket}`} style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
            <activeBucketMeta.icon size={32} style={{ opacity: 0.4, marginBottom: '0.5rem' }} />
            <div>No {activeBucketMeta.label.toLowerCase()}</div>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: '0.6rem' }}>
            {activeAppointments.map((a) => (
              <AppointmentCard
                key={a.id}
                appt={a}
                onViewDetails={() => setSelectedAppt(a)}
                onCancel={() => handleCancel(a)}
                onReschedule={() => {
                  setRescheduleTarget(a);
                  const dt = new Date(a.appointmentDate);
                  if (!Number.isNaN(dt.getTime())) {
                    setRescheduleForm({
                      date: dt.toISOString().slice(0, 10),
                      time: `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`,
                    });
                  }
                }}
              />
            ))}
          </div>
        )}
      </div>

      {selectedAppt && (
        <DetailsModal
          appt={selectedAppt}
          onClose={() => setSelectedAppt(null)}
          onCancel={() => handleCancel(selectedAppt)}
          onReschedule={() => {
            setRescheduleTarget(selectedAppt);
            const dt = new Date(selectedAppt.appointmentDate);
            if (!Number.isNaN(dt.getTime())) {
              setRescheduleForm({
                date: dt.toISOString().slice(0, 10),
                time: `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`,
              });
            }
          }}
          cancelSubmitting={cancelSubmitting}
        />
      )}

      {rescheduleTarget && (
        <RescheduleModal
          appt={rescheduleTarget}
          form={rescheduleForm}
          onChange={setRescheduleForm}
          onClose={() => { setRescheduleTarget(null); setRescheduleForm({ date: '', time: '' }); }}
          onSubmit={handleReschedule}
          submitting={rescheduleSubmitting}
        />
      )}
    </div>
  );
}

function AppointmentCard({ appt, onViewDetails, onCancel, onReschedule }) {
  const pill = STATUS_PILL[appt.status] || STATUS_PILL.booked;
  const isPendingAssignment = !appt.doctorAssigned;
  return (
    <div
      className="glass"
      data-testid={`appt-card-${appt.id}`}
      style={{
        padding: '0.9rem 1rem',
        borderRadius: '10px',
        display: 'grid',
        gap: '0.6rem',
        borderLeft: isPendingAssignment ? '3px solid #f59e0b' : '3px solid transparent',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
            <Stethoscope size={14} style={{ opacity: 0.7, flexShrink: 0 }} />
            <span style={{ fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} data-testid={`appt-doctor-${appt.id}`}>
              {appt.doctorName || 'Pending assignment'}
            </span>
          </div>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }} data-testid={`appt-service-${appt.id}`}>
            {appt.serviceName || 'General'}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: '0.4rem', fontSize: '0.85rem' }}>
            <Clock size={13} style={{ opacity: 0.7 }} />
            <span data-testid={`appt-when-${appt.id}`}>{formatDateTimeIst(appt.appointmentDate)}</span>
          </div>
        </div>
        <span
          data-testid={`appt-status-${appt.id}`}
          style={{
            padding: '0.2rem 0.6rem',
            borderRadius: '999px',
            background: pill.bg,
            color: pill.fg,
            fontSize: '0.75rem',
            fontWeight: 500,
            whiteSpace: 'nowrap',
          }}
        >
          {STATUS_LABEL[appt.status] || appt.status}
        </span>
      </div>
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={onViewDetails}
          data-testid={`appt-view-${appt.id}`}
          style={{
            padding: '0.4rem 0.8rem',
            borderRadius: '6px',
            background: 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.1)',
            color: 'var(--text-primary)',
            cursor: 'pointer',
            fontSize: '0.85rem',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.3rem',
          }}
        >
          <Info size={14} />
          View Details
        </button>
        {appt.canReschedule && (
          <button
            type="button"
            onClick={onReschedule}
            data-testid={`appt-reschedule-${appt.id}`}
            style={{
              padding: '0.4rem 0.8rem',
              borderRadius: '6px',
              background: 'rgba(99,102,241,0.18)',
              border: '1px solid rgba(99,102,241,0.4)',
              color: '#6366f1',
              cursor: 'pointer',
              fontSize: '0.85rem',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.3rem',
            }}
          >
            <RotateCcw size={14} />
            Reschedule
          </button>
        )}
        {appt.canCancel && (
          <button
            type="button"
            onClick={onCancel}
            data-testid={`appt-cancel-${appt.id}`}
            style={{
              padding: '0.4rem 0.8rem',
              borderRadius: '6px',
              background: 'rgba(239,68,68,0.15)',
              border: '1px solid rgba(239,68,68,0.4)',
              color: '#ef4444',
              cursor: 'pointer',
              fontSize: '0.85rem',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.3rem',
            }}
          >
            <X size={14} />
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

function DetailsModal({ appt, onClose, onCancel, onReschedule, cancelSubmitting }) {
  const pill = STATUS_PILL[appt.status] || STATUS_PILL.booked;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Appointment details"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem',
      }}
    >
      <div
        className="glass"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: '480px', width: '100%', padding: '1.5rem', borderRadius: '12px' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1rem' }}>
          <h3 style={{ margin: 0 }}>Appointment Details</h3>
          <button
            type="button"
            onClick={onClose}
            data-testid="details-close"
            aria-label="Close"
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}
          >
            <X size={20} />
          </button>
        </div>
        <DetailRow label="Service" value={appt.serviceName || 'General'} />
        <DetailRow label="Practitioner" value={appt.doctorName || 'Pending assignment'} />
        <DetailRow label="Date & time" value={formatDateTimeIst(appt.appointmentDate)} />
        <DetailRow label="Status" value={
          <span style={{
            padding: '0.15rem 0.5rem', borderRadius: '999px',
            background: pill.bg, color: pill.fg, fontSize: '0.8rem',
          }}>
            {STATUS_LABEL[appt.status] || appt.status}
          </span>
        } />
        {appt.reason && <DetailRow label="Reason" value={appt.reason} />}
        {appt.bookingType && appt.bookingType !== 'CLINIC_VISIT' && (
          <DetailRow label="Booking type" value={appt.bookingType.replace(/_/g, ' ').toLowerCase()} />
        )}
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {appt.canReschedule && (
            <button
              type="button"
              onClick={onReschedule}
              data-testid="details-reschedule"
              style={{
                padding: '0.5rem 1rem', borderRadius: '6px',
                background: 'rgba(99,102,241,0.2)',
                border: '1px solid rgba(99,102,241,0.4)',
                color: '#6366f1', cursor: 'pointer',
              }}
            >
              Reschedule
            </button>
          )}
          {appt.canCancel && (
            <button
              type="button"
              onClick={onCancel}
              disabled={cancelSubmitting}
              data-testid="details-cancel"
              style={{
                padding: '0.5rem 1rem', borderRadius: '6px',
                background: 'rgba(239,68,68,0.18)',
                border: '1px solid rgba(239,68,68,0.4)',
                color: '#ef4444',
                cursor: cancelSubmitting ? 'wait' : 'pointer',
                opacity: cancelSubmitting ? 0.6 : 1,
              }}
            >
              {cancelSubmitting ? 'Cancelling…' : 'Cancel appointment'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function DetailRow({ label, value }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '0.5rem', padding: '0.4rem 0', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
      <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>{label}</div>
      <div style={{ fontSize: '0.9rem' }}>{value}</div>
    </div>
  );
}

function RescheduleModal({ appt, form, onChange, onClose, onSubmit, submitting }) {
  // Min date = today (local) so the date input can't pick a past day.
  // The backend ALSO enforces "must be strictly future" so server is the
  // authoritative validator — this is just a UI affordance.
  const todayLocal = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }, []);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Reschedule appointment"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1001,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem',
      }}
    >
      <div
        className="glass"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: '420px', width: '100%', padding: '1.5rem', borderRadius: '12px' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.5rem' }}>
          <h3 style={{ margin: 0 }}>Reschedule appointment</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}
          >
            <X size={20} />
          </button>
        </div>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: 0 }}>
          Currently {formatDateTimeIst(appt.appointmentDate)} with {appt.doctorName || 'Pending assignment'}.
        </p>
        <div style={{ display: 'grid', gap: '0.6rem' }}>
          <label style={{ display: 'grid', gap: '0.3rem' }}>
            <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>New date</span>
            <input
              type="date"
              value={form.date}
              min={todayLocal}
              onChange={(e) => onChange({ ...form, date: e.target.value })}
              data-testid="reschedule-date"
              style={{ padding: '0.5rem', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.06)', color: 'var(--text-primary)' }}
            />
          </label>
          <label style={{ display: 'grid', gap: '0.3rem' }}>
            <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>New time</span>
            <input
              type="time"
              value={form.time}
              onChange={(e) => onChange({ ...form, time: e.target.value })}
              data-testid="reschedule-time"
              style={{ padding: '0.5rem', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.06)', color: 'var(--text-primary)' }}
            />
          </label>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem', justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '0.5rem 1rem', borderRadius: '6px',
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.1)',
              color: 'var(--text-primary)', cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={submitting || !form.date || !form.time}
            data-testid="reschedule-submit"
            style={{
              padding: '0.5rem 1rem', borderRadius: '6px',
              background: 'var(--primary-color, var(--accent-color, #6366f1))',
              color: '#fff', border: 'none',
              cursor: submitting || !form.date || !form.time ? 'not-allowed' : 'pointer',
              opacity: submitting || !form.date || !form.time ? 0.5 : 1,
            }}
          >
            {submitting ? 'Rescheduling…' : 'Reschedule'}
          </button>
        </div>
      </div>
    </div>
  );
}
