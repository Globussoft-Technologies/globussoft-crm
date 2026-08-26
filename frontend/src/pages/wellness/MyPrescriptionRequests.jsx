import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Pill,
  RefreshCw,
  Loader2,
  AlertCircle,
  Clock,
  Send,
} from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { formatDate } from '../../utils/date';
import { useNotify } from '../../utils/notify';
import { usePermissions } from '../../hooks/usePermissions';
import PrescriptionRenewalComposer from '../../components/wellness/PrescriptionRenewalComposer';
import { drugLabel, OPEN_STATUSES } from '../../hooks/usePrescriptionRenewals';

/**
 * My Prescription Requests — the PATIENT-side counterpart to the clinic's
 * Prescription Requests queue.
 *
 * Why this page exists: the renewal workflow shipped API-first for the Android
 * app, so granting a CUSTOMER role `my_prescription_requests.read` put a
 * permission in the matrix with no page behind it — the sidebar stayed empty
 * and the grant looked broken. This is the web surface that grant now unlocks,
 * and it doubles as the way to exercise the whole flow without the app.
 *
 * It talks to the SAME `/api/wellness/portal/prescription-requests` pair the
 * Android app uses. Those run behind `verifyPatientToken`, which accepts a
 * regular CUSTOMER session token (Path B) and resolves it to the user's linked
 * Patient row — so the list here and a request raised from the app are the same
 * rows, resolved the same way. Deliberately NOT the staff-authed
 * `/api/wellness/my-prescriptions` self-view: that resolves the Patient by a
 * different path, and the list and the POST must agree on which patient they
 * mean.
 */

const STATUS_STYLE = {
  PENDING: { bg: 'rgba(234, 179, 8, 0.16)', fg: '#b8860b', label: 'Pending' },
  ACCEPTED: { bg: 'rgba(56, 189, 248, 0.16)', fg: '#0284c7', label: 'Accepted' },
  COMPLETED: { bg: 'rgba(34, 197, 94, 0.16)', fg: '#15803d', label: 'Completed' },
  REJECTED: { bg: 'rgba(239, 68, 68, 0.16)', fg: '#b91c1c', label: 'Declined' },
};

function StatusPill({ status }) {
  const s = STATUS_STYLE[status] || {
    bg: 'var(--subtle-bg-3)',
    fg: 'var(--text-secondary)',
    label: status || '—',
  };
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '0.15rem 0.55rem',
        borderRadius: 999,
        background: s.bg,
        color: s.fg,
        fontSize: '0.74rem',
        fontWeight: 700,
        letterSpacing: '0.02em',
        textTransform: 'uppercase',
        whiteSpace: 'nowrap',
      }}
    >
      {s.label}
    </span>
  );
}

export default function MyPrescriptionRequests() {
  const notify = useNotify();
  const { hasPermission, isReady: permsReady } = usePermissions();
  const canRequest =
    !permsReady || hasPermission('my_prescription_requests', 'write');

  const [prescriptions, setPrescriptions] = useState([]);
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [composeFor, setComposeFor] = useState(null); // a prescription row

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [rx, reqs] = await Promise.all([
        fetchApi('/api/wellness/portal/prescriptions', { silent: true }),
        fetchApi('/api/wellness/portal/prescription-requests', { silent: true }),
      ]);
      setPrescriptions(Array.isArray(rx) ? rx : []);
      setRequests(Array.isArray(reqs) ? reqs : []);
    } catch (err) {
      // A customer whose account is not linked to a patient record gets a
      // distinct backend code — say so rather than showing a generic failure.
      if (err?.code === 'NO_PATIENT_PROFILE') {
        setError(
          'Your account is not linked to a patient profile yet. Please ask the clinic to link it.',
        );
      } else {
        setError(err?.message || 'Failed to load your prescriptions');
      }
      setPrescriptions([]);
      setRequests([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // prescriptionId → the open request blocking a re-request, if any.
  const openByPrescription = useMemo(() => {
    const map = new Map();
    for (const r of requests) {
      if (OPEN_STATUSES.includes(r.status)) map.set(r.prescriptionId, r);
    }
    return map;
  }, [requests]);

  return (
    <div style={{ padding: '1.5rem 2rem' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '1rem',
          marginBottom: '0.5rem',
          flexWrap: 'wrap',
        }}
      >
        <h1
          style={{
            fontSize: '1.6rem',
            fontWeight: 700,
            margin: 0,
            display: 'flex',
            alignItems: 'center',
            gap: '0.6rem',
          }}
        >
          <Pill size={22} /> My Prescription Requests
        </h1>
        <button type="button" onClick={load} title="Refresh" style={secondaryButton}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>
      <div
        style={{
          color: 'var(--text-secondary)',
          marginBottom: '1.25rem',
          fontSize: '0.9rem',
        }}
      >
        Ask the clinic to repeat a prescription — all of it, or just the
        medicines you still need.
      </div>

      {loading && (
        <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
          <Loader2 size={18} className="spin" /> Loading…
        </div>
      )}

      {!loading && error && (
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: '0.6rem',
            padding: '1rem',
            borderRadius: 10,
            border: '1px solid var(--border-color)',
            background: 'var(--subtle-bg-2)',
            color: 'var(--danger-color, #e57373)',
            fontSize: '0.9rem',
          }}
        >
          <AlertCircle size={18} /> {error}
        </div>
      )}

      {!loading && !error && (
        <div style={{ display: 'grid', gap: '1.5rem' }}>
          {/* Existing requests first — that's what a returning visitor came
              back to check. */}
          <section>
            <h2 style={sectionHeading}>
              <Clock size={15} /> Your requests
            </h2>
            {requests.length === 0 && (
              <div style={emptyBox}>
                You haven&apos;t asked for a repeat yet. Pick a prescription below
                to get started.
              </div>
            )}
            <div style={{ display: 'grid', gap: '0.75rem' }}>
              {requests.map((r) => (
                <div key={r.id} style={card}>
                  <div style={cardHeader}>
                    <div style={{ fontWeight: 600 }}>
                      {r.isFullPrescription
                        ? 'Complete prescription'
                        : (r.requestedDrugs || [])
                            .map((d) => d?.name || d?.drugName)
                            .filter(Boolean)
                            .join(', ')}
                    </div>
                    <StatusPill status={r.status} />
                  </div>
                  <div style={muted}>
                    Requested {formatDate(r.createdAt)}
                    {r.requestedDurationDays
                      ? ` · for ${r.requestedDurationDays} days`
                      : ''}
                    {r.doctorName ? ` · Dr ${r.doctorName}` : ''}
                  </div>
                  {r.notes && <div style={muted}>Your note: {r.notes}</div>}
                  {/* The clinic's answer. A decline the customer can't
                      understand is worse than no decline, so it is shown
                      inline rather than hidden behind a detail view. */}
                  {r.reviewNote && (
                    <div
                      style={{
                        marginTop: '0.4rem',
                        padding: '0.5rem 0.65rem',
                        borderRadius: 8,
                        background: 'var(--subtle-bg-3)',
                        fontSize: '0.85rem',
                      }}
                    >
                      <strong>From the clinic:</strong> {r.reviewNote}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>

          {/* Then the prescriptions they can request against. */}
          <section>
            <h2 style={sectionHeading}>
              <Pill size={15} /> Your prescriptions
            </h2>
            {prescriptions.length === 0 && (
              <div style={emptyBox}>
                You have no prescriptions on file yet.
              </div>
            )}
            <div style={{ display: 'grid', gap: '0.75rem' }}>
              {prescriptions.map((rx) => {
                const open = openByPrescription.get(rx.id);
                return (
                  <div key={rx.id} style={card}>
                    <div style={cardHeader}>
                      <div style={{ fontWeight: 600 }}>
                        Prescription #{rx.id}
                        {rx.doctor?.name ? ` · Dr ${rx.doctor.name}` : ''}
                      </div>
                      <div style={muted}>{formatDate(rx.createdAt)}</div>
                    </div>
                    <ul style={{ margin: '0.4rem 0 0', paddingLeft: '1.1rem' }}>
                      {(rx.drugs || []).map((d, i) => (
                        <li key={`${d?.name || 'drug'}-${i}`} style={{ fontSize: '0.88rem' }}>
                          {drugLabel(d)}
                        </li>
                      ))}
                      {(rx.drugs || []).length === 0 && (
                        <li style={{ color: 'var(--text-secondary)' }}>
                          No medicines recorded.
                        </li>
                      )}
                    </ul>
                    <div style={{ marginTop: '0.7rem' }}>
                      <button
                        type="button"
                        onClick={() => setComposeFor(rx)}
                        disabled={!canRequest || Boolean(open)}
                        title={
                          open
                            ? 'You already have a request open for this prescription'
                            : !canRequest
                              ? 'You do not have permission to request a renewal'
                              : 'Request a repeat of this prescription'
                        }
                        style={{
                          ...primaryButton,
                          opacity: !canRequest || open ? 0.5 : 1,
                          cursor: !canRequest || open ? 'not-allowed' : 'pointer',
                        }}
                      >
                        <Send size={14} />
                        {open ? `Request ${open.status.toLowerCase()}` : 'Request renewal'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      )}

      {composeFor && (
        <PrescriptionRenewalComposer
          prescription={composeFor}
          onClose={() => setComposeFor(null)}
          onSubmitted={() => {
            setComposeFor(null);
            notify.success('Your renewal request has been sent to the clinic.');
            load();
          }}
          notify={notify}
        />
      )}
    </div>
  );
}

const sectionHeading = {
  margin: '0 0 0.6rem',
  fontSize: '0.78rem',
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--text-secondary)',
  display: 'flex',
  alignItems: 'center',
  gap: '0.4rem',
};

const card = {
  border: '1px solid var(--border-color)',
  borderRadius: 10,
  padding: '0.9rem 1rem',
  background: 'var(--subtle-bg-2)',
};

const cardHeader = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.75rem',
  flexWrap: 'wrap',
};

const muted = { fontSize: '0.82rem', color: 'var(--text-secondary)' };

const emptyBox = {
  padding: '1.25rem',
  borderRadius: 10,
  border: '1px dashed var(--border-color)',
  color: 'var(--text-secondary)',
  fontSize: '0.9rem',
  textAlign: 'center',
};

const secondaryButton = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.4rem',
  padding: '0.45rem 0.85rem',
  borderRadius: 8,
  border: '1px solid var(--border-color)',
  background: 'var(--subtle-bg-2)',
  color: 'inherit',
  cursor: 'pointer',
  fontSize: '0.85rem',
};

const primaryButton = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.4rem',
  padding: '0.45rem 0.9rem',
  borderRadius: 8,
  border: '1px solid var(--border-color)',
  background: 'var(--primary-color, var(--accent-color))',
  color: '#fff',
  cursor: 'pointer',
  fontSize: '0.85rem',
  fontWeight: 600,
};
