import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ClipboardList,
  Search,
  Loader2,
  RefreshCw,
  X,
  Phone,
  Check,
  Ban,
  PackageCheck,
  Clock,
  ChevronLeft,
  ChevronRight,
  Pill,
  CalendarRange,
  Stethoscope,
  Package,
} from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { formatDate } from '../../utils/date';
import { useNotify } from '../../utils/notify';
import { usePermissions } from '../../hooks/usePermissions';
import CallifiedCallDialog from '../../components/CallifiedCallDialog';
import TopScrollSync from '../../components/TopScrollSync';
import ModalShell from '../../components/wellness/ModalShell';

/**
 * Prescription Requests — the clinic's queue of renewal / medicine requests
 * raised by patients from the Android app.
 *
 * The table is the triage view (who asked, for what, how long, how long ago);
 * the panel is the review view (patient details, the ORIGINAL prescription
 * side by side with what was requested, the request's own history, and the
 * accept / reject / complete actions).
 *
 * Two things here are deliberately borrowed rather than rebuilt:
 *   • Calling the customer reuses <CallifiedCallDialog> pointed at the
 *     existing /api/wellness/callified/patients/:id/* endpoints — the same
 *     component and the same backend the Patients and Appointments pages use,
 *     so a call placed from this screen lands in Call History like any other.
 *   • Status changes go through one PATCH endpoint, so the button row is just
 *     three calls to the same function with a different target status.
 *
 * Deep link: notifications sent to the admin + prescribing doctor point at
 * `/wellness/prescription-requests?request=<id>`, so the panel opens straight
 * from the notification bell.
 */

const STATUS_TABS = [
  { key: 'PENDING', label: 'Pending' },
  { key: 'ACCEPTED', label: 'Accepted' },
  { key: 'COMPLETED', label: 'Completed' },
  { key: 'REJECTED', label: 'Rejected' },
  // `ALL` is a sentinel, not a status. Using an empty key would clear the
  // `?status=` param, which is indistinguishable from a first visit — and a
  // first visit defaults to Pending, so the All tab could never stay
  // selected. The sentinel is stripped when the query is built.
  { key: 'ALL', label: 'All' },
];
const ALL_STATUSES = 'ALL';

// Chip colours come from the SEMANTIC tokens, which are tuned per theme
// (--success-color #059669 light / #10b981 dark, etc). Hard-coded hex pairs
// were legible on dark and washed out on light. The tint is derived from the
// same token via color-mix, so foreground and background always move together.
const tint = (token) => `color-mix(in srgb, var(${token}) 16%, transparent)`;

const STATUS_STYLE = {
  PENDING: { bg: tint('--warning-color'), fg: 'var(--warning-color)', label: 'Pending' },
  ACCEPTED: { bg: tint('--accent-color'), fg: 'var(--accent-color)', label: 'Accepted' },
  COMPLETED: { bg: tint('--success-color'), fg: 'var(--success-color)', label: 'Completed' },
  REJECTED: { bg: tint('--danger-color'), fg: 'var(--danger-color)', label: 'Rejected' },
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

/** "Full prescription" or the named medicines, capped so the cell stays one line. */
function summariseRequested(req, max = 2) {
  if (req?.isFullPrescription) return 'Complete prescription';
  const drugs = Array.isArray(req?.requestedDrugs) ? req.requestedDrugs : [];
  if (drugs.length === 0) return 'Complete prescription';
  const names = drugs
    .slice(0, max)
    .map((d) => d?.name || d?.drugName)
    .filter(Boolean);
  const more = drugs.length - names.length;
  return more > 0 ? `${names.join(', ')} +${more} more` : names.join(', ');
}

function describeDuration(req) {
  if (!req) return '—';
  const parts = [];
  if (req.requestedDurationDays) parts.push(`${req.requestedDurationDays} days`);
  if (req.requestedFrom || req.requestedTo) {
    const from = req.requestedFrom ? formatDate(req.requestedFrom) : '…';
    const to = req.requestedTo ? formatDate(req.requestedTo) : '…';
    parts.push(`${from} → ${to}`);
  }
  return parts.length ? parts.join(' · ') : '—';
}

export default function PrescriptionRequests() {
  const notify = useNotify();
  const { hasPermission, isReady: permsReady } = usePermissions();
  // Until the permission set resolves we optimistically enable — the backend
  // is the real gate, and a briefly-disabled button reads as a broken page.
  const canAction = !permsReady || hasPermission('prescription_requests', 'update');
  const canCall =
    !permsReady ||
    hasPermission('appointments', 'write') ||
    hasPermission('calendar', 'write');

  const [searchParams, setSearchParams] = useSearchParams();
  // Absent param = first visit ⇒ land on the queue that needs work. An
  // explicit `ALL` is the operator choosing to see everything.
  const status = searchParams.get('status') ?? 'PENDING';
  const q = searchParams.get('q') ?? '';
  const openId = searchParams.get('request');

  const [searchDraft, setSearchDraft] = useState(q);
  const [items, setItems] = useState([]);
  const [counts, setCounts] = useState({});
  const [total, setTotal] = useState(0);
  const [limit, setLimit] = useState(50);
  const [skip, setSkip] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [reloadTick, setReloadTick] = useState(0);

  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [callTarget, setCallTarget] = useState(null);

  const updateParams = useCallback(
    (patch) => {
      const next = new URLSearchParams(searchParams);
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === undefined || v === '') next.delete(k);
        else next.set(k, String(v));
      }
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  // ── List ────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (status && status !== ALL_STATUSES) params.set('status', status);
    if (q) params.set('q', q);
    params.set('limit', String(limit));
    params.set('skip', String(skip));
    fetchApi(`/api/wellness/prescription-requests?${params.toString()}`, {
      silent: true,
    })
      .then((res) => {
        if (cancelled) return;
        setItems(Array.isArray(res?.items) ? res.items : []);
        setTotal(Number.isFinite(res?.total) ? res.total : 0);
        setCounts(res?.counts || {});
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message || 'Failed to load prescription requests');
        setItems([]);
        setTotal(0);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [status, q, limit, skip, reloadTick]);

  // A filter change strands the operator on a page that may not exist in the
  // new result window, so always fall back to page 1.
  useEffect(() => {
    setSkip(0);
  }, [status, q, limit]);

  // Keep the search box in step when the URL changes underneath us (back
  // button, or a deep link that carries ?q=).
  useEffect(() => {
    setSearchDraft(q);
  }, [q]);

  // ── Detail (also the deep-link target) ──────────────────────────────
  useEffect(() => {
    if (!openId) {
      setDetail(null);
      return undefined;
    }
    let cancelled = false;
    setDetailLoading(true);
    fetchApi(`/api/wellness/prescription-requests/${openId}`, { silent: true })
      .then((res) => {
        if (!cancelled) setDetail(res || null);
      })
      .catch((err) => {
        if (cancelled) return;
        notify.error(err?.message || 'Failed to open the request');
        setDetail(null);
        updateParams({ request: null });
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `notify` and `updateParams` are stable enough for this effect's intent;
    // re-running on every render would re-fetch the panel on each keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId, reloadTick]);

  const [acting, setActing] = useState('');
  const [reviewNote, setReviewNote] = useState('');

  const act = async (nextStatus) => {
    if (!detail || acting) return;
    if (nextStatus === 'REJECTED' && !reviewNote.trim()) {
      notify.error('Add a reason before rejecting — the patient is told the outcome.');
      return;
    }
    setActing(nextStatus);
    try {
      const updated = await fetchApi(
        `/api/wellness/prescription-requests/${detail.id}/status`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            status: nextStatus,
            note: reviewNote.trim() || undefined,
          }),
        },
      );
      setDetail(updated);
      setReviewNote('');
      setReloadTick((t) => t + 1);
      notify.success(`Request ${nextStatus.toLowerCase()}.`);
    } catch (err) {
      notify.error(err?.message || 'Failed to update the request');
    } finally {
      setActing('');
    }
  };

  const pageStart = total === 0 ? 0 : skip + 1;
  const pageEnd = Math.min(skip + items.length, total);
  const canPrev = skip > 0 && !loading;
  const canNext = skip + limit < total && !loading;

  const pendingCount = counts.PENDING || 0;
  const subtitle = useMemo(
    () =>
      pendingCount > 0
        ? `${pendingCount} request${pendingCount === 1 ? '' : 's'} waiting for review.`
        : 'Renewal and medicine requests raised by patients from the app.',
    [pendingCount],
  );

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
          <ClipboardList size={22} /> Prescription Requests
        </h1>
        <button
          type="button"
          onClick={() => setReloadTick((t) => t + 1)}
          title="Refresh"
          style={secondaryButton}
        >
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
        {subtitle}
      </div>

      {/* Status tabs — counts come from the backend over the whole tenant, so
          the badges don't disappear as you move between tabs. */}
      <div
        style={{
          display: 'flex',
          gap: '0.4rem',
          flexWrap: 'wrap',
          marginBottom: '1rem',
        }}
      >
        {STATUS_TABS.map((tab) => {
          const active = status === tab.key;
          const count = tab.key === ALL_STATUSES ? undefined : counts[tab.key];
          return (
            <button
              key={tab.key || 'all'}
              type="button"
              onClick={() => updateParams({ status: tab.key })}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.4rem',
                padding: '0.4rem 0.85rem',
                borderRadius: 999,
                border: '1px solid var(--border-color)',
                background: active
                  ? 'var(--primary-color, var(--accent-color))'
                  : 'var(--input-bg)',
                color: active ? '#fff' : 'inherit',
                cursor: 'pointer',
                fontSize: '0.85rem',
                fontWeight: active ? 600 : 500,
              }}
            >
              {tab.label}
              {count !== undefined && count > 0 && (
                <span
                  style={{
                    fontSize: '0.72rem',
                    padding: '0.05rem 0.4rem',
                    borderRadius: 999,
                    background: active ? 'rgba(255,255,255,0.25)' : 'var(--subtle-bg-3)',
                  }}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Search */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          updateParams({ q: searchDraft.trim() || null });
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          marginBottom: '1rem',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ position: 'relative', flex: '1 1 280px', maxWidth: 360 }}>
          <Search
            size={16}
            style={{
              position: 'absolute',
              left: '0.65rem',
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'var(--text-secondary)',
              pointerEvents: 'none',
            }}
          />
          <input
            type="text"
            placeholder="Search patient name, phone or email…"
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            style={{
              width: '100%',
              padding: '0.5rem 2.1rem 0.5rem 2.1rem',
              borderRadius: 8,
              border: '1px solid var(--border-color)',
              background: 'var(--input-bg)',
              color: 'inherit',
              fontSize: '0.9rem',
            }}
          />
          {q && (
            <button
              type="button"
              onClick={() => {
                setSearchDraft('');
                updateParams({ q: null });
              }}
              title="Clear search"
              style={{
                position: 'absolute',
                right: '0.4rem',
                top: '50%',
                transform: 'translateY(-50%)',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--text-secondary)',
                padding: '0.2rem',
                lineHeight: 0,
              }}
            >
              <X size={14} />
            </button>
          )}
        </div>
        <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
          Show
          <select
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            style={{
              marginLeft: '0.5rem',
              padding: '0.4rem 0.6rem',
              borderRadius: 6,
              border: '1px solid var(--border-color)',
              background: 'var(--input-bg)',
              color: 'inherit',
              fontSize: '0.85rem',
            }}
          >
            <option value={25}>25</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
          </select>
        </label>
      </form>

      {/* Table */}
      <div
        style={{
          border: '1px solid var(--border-color)',
          borderRadius: 10,
          background: 'var(--surface-color)',
        }}
      >
        <TopScrollSync>
          <table
            style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}
          >
            <thead>
              <tr style={{ background: 'var(--subtle-bg-3)' }}>
                <Th>Request</Th>
                <Th>Customer</Th>
                <Th>Prescription</Th>
                <Th>Doctor</Th>
                <Th>Requested</Th>
                <Th>Duration</Th>
                <Th>Raised</Th>
                <Th>Status</Th>
                <Th align="right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={9} style={emptyCell}>
                    <Loader2 size={16} className="spin" /> Loading requests…
                  </td>
                </tr>
              )}
              {!loading && error && (
                <tr>
                  <td
                    colSpan={9}
                    style={{ ...emptyCell, color: 'var(--danger-color)' }}
                  >
                    {error}
                  </td>
                </tr>
              )}
              {!loading && !error && items.length === 0 && (
                <tr>
                  <td colSpan={9} style={emptyCell}>
                    {q
                      ? 'No requests match that search.'
                      : status && status !== ALL_STATUSES
                        ? `No ${status.toLowerCase()} requests.`
                        : 'No renewal requests yet.'}
                  </td>
                </tr>
              )}
              {!loading &&
                !error &&
                items.map((req) => (
                  <tr key={req.id} style={{ borderTop: '1px solid var(--border-color)' }}>
                    <Td>
                      <code style={{ fontSize: '0.82rem' }}>#{req.id}</code>
                    </Td>
                    <Td>
                      <div style={{ fontWeight: 600 }}>{req.patientName || '—'}</div>
                      {req.patientPhone && (
                        <div
                          style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}
                        >
                          {req.patientPhone}
                        </div>
                      )}
                    </Td>
                    <Td>
                      <Link
                        to={`/wellness/prescriptions?q=${encodeURIComponent(req.patientName || '')}`}
                        style={{ color: 'var(--text-primary)' }}
                      >
                        Rx #{req.prescriptionId}
                      </Link>
                    </Td>
                    <Td>
                      {req.doctorName || (
                        <span style={{ color: 'var(--text-secondary)' }}>—</span>
                      )}
                    </Td>
                    <Td>{summariseRequested(req)}</Td>
                    <Td>{describeDuration(req)}</Td>
                    <Td>{formatDate(req.createdAt)}</Td>
                    <Td>
                      <StatusPill status={req.status} />
                    </Td>
                    <Td align="right">
                      <div
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '0.4rem',
                        }}
                      >
                        {/* Call without opening the request first. Triage on
                            this page is often "ring them and ask what they
                            actually need" — making that a two-click detour
                            through the panel is the wrong default. Same
                            endpoints and same dialog the panel uses. */}
                        <CallAction
                          request={req}
                          canCall={canCall}
                          onCall={() =>
                            setCallTarget({
                              id: req.patientId,
                              name: req.patientName,
                              phone: req.patientPhone,
                              subtitle: `Renewal request #${req.id}`,
                            })
                          }
                        />
                        <button
                          type="button"
                          onClick={() => updateParams({ request: req.id })}
                          style={primaryButton}
                        >
                          Review
                        </button>
                      </div>
                    </Td>
                  </tr>
                ))}
            </tbody>
          </table>
        </TopScrollSync>
      </div>

      {!loading && !error && items.length > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '1rem',
            marginTop: '0.85rem',
            fontSize: '0.82rem',
            color: 'var(--text-secondary)',
          }}
        >
          <div>
            Showing {pageStart}–{pageEnd} of {total} request{total === 1 ? '' : 's'}.
          </div>
          {total > limit && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <button
                type="button"
                onClick={() => setSkip((s) => Math.max(0, s - limit))}
                disabled={!canPrev}
                style={pagerButton(!canPrev)}
              >
                <ChevronLeft size={14} /> Previous
              </button>
              <button
                type="button"
                onClick={() => setSkip((s) => s + limit)}
                disabled={!canNext}
                style={pagerButton(!canNext)}
              >
                Next <ChevronRight size={14} />
              </button>
            </div>
          )}
        </div>
      )}

      {openId && (
        <RequestPanel
          request={detail}
          loading={detailLoading}
          acting={acting}
          canAction={canAction}
          canCall={canCall}
          reviewNote={reviewNote}
          onReviewNoteChange={setReviewNote}
          onAct={act}
          onCall={() =>
            setCallTarget({
              id: detail?.patientId,
              name: detail?.patient?.name,
              phone: detail?.patient?.phone,
              subtitle: `Renewal request #${detail?.id}`,
            })
          }
          onClose={() => {
            setReviewNote('');
            updateParams({ request: null });
          }}
        />
      )}

      {callTarget?.id && (
        <CallifiedCallDialog
          customer={{
            name: callTarget.name,
            phone: callTarget.phone,
            subtitle: callTarget.subtitle,
          }}
          endpoints={{
            context: `/api/wellness/callified/patients/${callTarget.id}/context`,
            campaigns: '/api/wellness/callified/campaigns',
            aiCall: `/api/wellness/callified/patients/${callTarget.id}/ai-call`,
            manualCall: `/api/wellness/callified/patients/${callTarget.id}/manual-call`,
          }}
          onClose={() => setCallTarget(null)}
        />
      )}
    </div>
  );
}

/**
 * The review surface. Everything a doctor or admin needs to decide, on one
 * screen: who is asking, what they were originally prescribed, what subset
 * they want renewed, for how long, and what has already happened to the
 * request.
 */
function RequestPanel({
  request,
  loading,
  acting,
  canAction,
  canCall,
  reviewNote,
  onReviewNoteChange,
  onAct,
  onCall,
  onClose,
}) {
  const closed =
    request?.status === 'REJECTED' || request?.status === 'COMPLETED';
  const phone = request?.patient?.phone;

  return (
    // ModalShell portals to document.body. The app shell's <main> carries
    // `animation: fadeIn ... forwards` ending at `transform: translateY(0)`,
    // and a non-none transform makes an element the containing block for
    // `position: fixed` descendants — so an in-place overlay anchors to the
    // top of main's SCROLLED CONTENT, not the viewport. Open a request from a
    // row far down the queue and the panel would render above the fold with
    // only its bottom edge visible.
    <ModalShell
      title={
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.6rem',
          }}
        >
          <Pill size={18} />
          Renewal request {request ? `#${request.id}` : ''}
          {request && <StatusPill status={request.status} />}
        </span>
      }
      onClose={onClose}
      width={760}
    >
      <>
        {loading && (
          <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
            <Loader2 size={18} className="spin" /> Loading request…
          </div>
        )}

        {!loading && !request && (
          <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
            This request is no longer available.
          </div>
        )}

        {!loading && request && (
          <div style={{ display: 'grid', gap: '1.25rem' }}>
            {/* Customer + call */}
            <Section title="Customer" icon={<Stethoscope size={15} />}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                  gap: '1rem',
                  flexWrap: 'wrap',
                }}
              >
                <div style={{ display: 'grid', gap: '0.2rem' }}>
                  <div style={{ fontWeight: 600, fontSize: '1rem' }}>
                    {request.patient?.name || request.patientName || '—'}
                  </div>
                  <Muted>{phone || 'No phone on file'}</Muted>
                  {request.patient?.email && <Muted>{request.patient.email}</Muted>}
                  {request.patient?.allergies && (
                    <div style={{ fontSize: '0.82rem', color: 'var(--danger-color)', fontWeight: 600 }}>
                      Allergies: {request.patient.allergies}
                    </div>
                  )}
                  {request.patientId && (
                    <Link
                      to={`/wellness/patients/${request.patientId}`}
                      style={{ fontSize: '0.82rem' }}
                    >
                      Open patient chart →
                    </Link>
                  )}
                </div>
                {/* Same dialog, same endpoints, same CallLog as the Patients
                    page — a call from here is not a different kind of call. */}
                <button
                  type="button"
                  onClick={onCall}
                  disabled={!phone || !canCall}
                  title={
                    !phone
                      ? 'This customer has no phone number on file'
                      : !canCall
                        ? 'You don’t have permission to place calls'
                        : 'Call the customer (AI or manual)'
                  }
                  style={{
                    ...primaryButton,
                    padding: '0.5rem 0.9rem',
                    opacity: !phone || !canCall ? 0.5 : 1,
                    cursor: !phone || !canCall ? 'not-allowed' : 'pointer',
                  }}
                >
                  <Phone size={14} /> Call customer
                </button>
              </div>
            </Section>

            {/* What was asked for */}
            <Section title="Requested" icon={<CalendarRange size={15} />}>
              <div style={{ display: 'grid', gap: '0.5rem' }}>
                <Field label="Medicines">
                  {request.isFullPrescription ? (
                    <span>Complete prescription (all medicines)</span>
                  ) : (
                    <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
                      {(request.requestedDrugs || []).map((d, i) => (
                        <li key={`${d?.name || 'drug'}-${i}`}>
                          {d?.name || d?.drugName}
                          {d?.dosage ? ` · ${d.dosage}` : ''}
                          {d?.frequency ? ` × ${d.frequency}/day` : ''}
                        </li>
                      ))}
                    </ul>
                  )}
                </Field>
                <Field label="Duration">{describeDuration(request)}</Field>
                {request.notes && <Field label="Patient note">{request.notes}</Field>}
                <Field label="Raised">{formatDate(request.createdAt)}</Field>
              </div>
            </Section>

            {/* Availability — advisory only. It never gates the buttons below:
                clinic stock counts go stale, and a wrong number must not
                hard-block a legitimate renewal. */}
            {Array.isArray(request.stock) && request.stock.length > 0 && (
              <Section title="Availability" icon={<Package size={15} />}>
                <div style={{ display: 'grid', gap: '0.4rem' }}>
                  {request.stock.map((s, i) => (
                    <div
                      key={`${s.name || 'med'}-${i}`}
                      style={{
                        display: 'flex',
                        alignItems: 'baseline',
                        justifyContent: 'space-between',
                        gap: '0.75rem',
                        flexWrap: 'wrap',
                        fontSize: '0.88rem',
                      }}
                    >
                      <span>{s.name || '—'}</span>
                      <StockChip entry={s} />
                    </div>
                  ))}
                </div>
                {request.stockSummary?.unknown > 0 && (
                  <div
                    style={{
                      marginTop: '0.6rem',
                      fontSize: '0.78rem',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    {request.stockSummary.unknown} of {request.stockSummary.total}{' '}
                    {request.stockSummary.unknown === 1 ? 'medicine is' : 'medicines are'} not in
                    the drug catalogue — availability is unknown, not zero.{' '}
                    <Link to="/wellness/drugs">Add them →</Link>
                  </div>
                )}
              </Section>
            )}

            {/* The original Rx it is asking to renew */}
            <Section title="Original prescription" icon={<Pill size={15} />}>
              <div style={{ display: 'grid', gap: '0.5rem' }}>
                <Field label="Rx">
                  #{request.prescriptionId}
                  {request.prescription?.createdAt
                    ? ` · issued ${formatDate(request.prescription.createdAt)}`
                    : ''}
                </Field>
                <Field label="Prescribed by">
                  {request.doctorName || request.doctor?.name || 'Not recorded'}
                </Field>
                {request.prescription?.serviceName && (
                  <Field label="Visit">
                    {request.prescription.serviceName}
                    {request.prescription.visitDate
                      ? ` · ${formatDate(request.prescription.visitDate)}`
                      : ''}
                  </Field>
                )}
                <Field label="Medicines">
                  <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
                    {(request.prescription?.drugs || []).map((d, i) => (
                      <li key={`${d?.name || 'rx-drug'}-${i}`}>
                        {d?.name || d?.drugName}
                        {d?.dosage ? ` · ${d.dosage}` : ''}
                        {d?.frequency ? ` × ${d.frequency}/day` : ''}
                        {d?.duration ? ` for ${d.duration} days` : ''}
                      </li>
                    ))}
                    {(request.prescription?.drugs || []).length === 0 && (
                      <li style={{ color: 'var(--text-secondary)' }}>
                        No medicines recorded.
                      </li>
                    )}
                  </ul>
                </Field>
                {request.prescription?.instructions && (
                  <Field label="Instructions">{request.prescription.instructions}</Field>
                )}
              </div>
            </Section>

            {/* History */}
            {Array.isArray(request.history) && request.history.length > 0 && (
              <Section title="History" icon={<Clock size={15} />}>
                <ol style={{ margin: 0, paddingLeft: '1.1rem', display: 'grid', gap: '0.35rem' }}>
                  {request.history.map((h) => (
                    <li key={h.id} style={{ fontSize: '0.86rem' }}>
                      <strong>{h.action}</strong>
                      {h.fromStatus ? ` (${h.fromStatus} → ${h.toStatus})` : ''} ·{' '}
                      {formatDate(h.createdAt)} ·{' '}
                      {h.actorType === 'patient' ? 'Patient' : h.actorName || 'Staff'}
                      {h.note && (
                        <div style={{ color: 'var(--text-secondary)' }}>{h.note}</div>
                      )}
                    </li>
                  ))}
                </ol>
              </Section>
            )}

            {/* Decision */}
            {!closed && (
              <Section title="Decision">
                <textarea
                  value={reviewNote}
                  onChange={(e) => onReviewNoteChange(e.target.value)}
                  rows={3}
                  placeholder="Note for the patient (required when rejecting)…"
                  style={{
                    width: '100%',
                    padding: '0.6rem 0.75rem',
                    borderRadius: 8,
                    border: '1px solid var(--border-color)',
                    background: 'var(--input-bg)',
                    color: 'inherit',
                    fontSize: '0.88rem',
                    fontFamily: 'inherit',
                    resize: 'vertical',
                  }}
                />
                <div
                  style={{
                    display: 'flex',
                    gap: '0.5rem',
                    flexWrap: 'wrap',
                    marginTop: '0.6rem',
                  }}
                >
                  {request.status === 'PENDING' && (
                    <ActionButton
                      onClick={() => onAct('ACCEPTED')}
                      disabled={!canAction || Boolean(acting)}
                      busy={acting === 'ACCEPTED'}
                      icon={<Check size={14} />}
                      label="Accept"
                    />
                  )}
                  <ActionButton
                    onClick={() => onAct('COMPLETED')}
                    disabled={!canAction || Boolean(acting)}
                    busy={acting === 'COMPLETED'}
                    icon={<PackageCheck size={14} />}
                    label="Mark completed"
                  />
                  <ActionButton
                    onClick={() => onAct('REJECTED')}
                    disabled={!canAction || Boolean(acting)}
                    busy={acting === 'REJECTED'}
                    icon={<Ban size={14} />}
                    label="Reject"
                    danger
                  />
                </div>
                {!canAction && (
                  <Muted>
                    You can view this request but not action it — that needs the
                    Prescription Requests update permission.
                  </Muted>
                )}
              </Section>
            )}

            {closed && (
              <Section title="Outcome">
                <Field label="Decided by">
                  {request.reviewedByName || 'Staff'}
                  {request.reviewedAt ? ` · ${formatDate(request.reviewedAt)}` : ''}
                </Field>
                {request.reviewNote && <Field label="Note">{request.reviewNote}</Field>}
                {request.fulfilledPrescriptionId && (
                  <Field label="New prescription">
                    Rx #{request.fulfilledPrescriptionId}
                  </Field>
                )}
              </Section>
            )}
          </div>
        )}
      </>
    </ModalShell>
  );
}

/**
 * Availability chip for one requested medicine.
 *
 * `not_linked` is deliberately neutral-grey and reads "not linked", never
 * "0" — the drug simply has no inventory item mapped to it, and rendering
 * that as out-of-stock is exactly the wrong-decision failure the backend
 * resolver is built to avoid.
 */
function StockChip({ entry }) {
  const qty =
    entry.quantity === null || entry.quantity === undefined ? null : `${entry.quantity}`;

  const LOOK = {
    in_stock:    { bg: tint('--success-color'), fg: 'var(--success-color)', label: qty ? `${qty} in stock` : 'In stock' },
    low:         { bg: tint('--warning-color'), fg: 'var(--warning-color)', label: qty ? `${qty} left — low` : 'Low stock' },
    out:         { bg: tint('--danger-color'),  fg: 'var(--danger-color)',  label: 'Out of stock' },
    // Neutral on purpose — "unknown" must never borrow a danger colour.
    not_tracked: { bg: 'var(--subtle-bg-3)', fg: 'var(--text-secondary)', label: qty ? `${qty} · not tracked` : 'Not tracked' },
    not_in_catalogue: { bg: 'var(--subtle-bg-3)', fg: 'var(--text-secondary)', label: 'Not in drug catalogue' },
  };
  const look = LOOK[entry.state] || LOOK.not_in_catalogue;

  const title = entry.drugName
    ? `${entry.drugName}${entry.lowStockThreshold ? ` · reorder at ${entry.lowStockThreshold}` : ''}${entry.drugInactive ? ' · drug is inactive' : ''}`
    : 'This medicine is not in the drug catalogue, so its stock is unknown';

  return (
    <span
      title={title}
      data-testid={`stock-${entry.state}`}
      style={{
        display: 'inline-block',
        padding: '0.12rem 0.5rem',
        borderRadius: 999,
        background: look.bg,
        color: look.fg,
        fontSize: '0.75rem',
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      {look.label}
    </span>
  );
}

/**
 * Per-row call action.
 *
 * A customer with no dialable number still gets the control, disabled with a
 * reason — silently hiding it reads as a missing feature, and the operator
 * needs to know WHY they cannot call so they can go fix the phone number.
 * Same rule the Appointments and Patients rows use, so every surface behaves
 * alike.
 *
 * The row already carries patientId / patientName / patientPhone from
 * `toPublicRequest`, so calling from here costs no extra fetch — it opens the
 * exact same <CallifiedCallDialog> against the exact same patient endpoints
 * the review panel uses.
 */
function CallAction({ request, canCall, onCall }) {
  const phone = request?.patientPhone || '';
  const dialable = phone.replace(/\D/g, '').length >= 10;
  const allowed = dialable && canCall;
  const name = request?.patientName || 'customer';

  return (
    <button
      type="button"
      // btn-secondary carries the theme-aware surface/text pairing; only the
      // sizing is overridden. Hand-picking colours here is what made this
      // button invisible on dark on other surfaces.
      className="btn-secondary"
      onClick={onCall}
      disabled={!allowed}
      data-testid={`prescription-request-call-${request?.id}`}
      title={
        !dialable
          ? 'No valid phone number on file'
          : !canCall
            ? 'You don’t have permission to place calls'
            : `Call ${name}`
      }
      aria-label={`Call ${name}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.3rem',
        padding: '0.3rem 0.6rem',
        borderRadius: 6,
        fontSize: '0.78rem',
        cursor: allowed ? 'pointer' : 'not-allowed',
        opacity: allowed ? 1 : 0.55,
      }}
    >
      {/* --accent-color, NOT --primary-color: in the wellness theme
          --primary-color is charcoal in BOTH modes (it is the sidebar/hero
          background), so using it as a foreground renders charcoal-on-black. */}
      <Phone size={13} style={{ color: 'var(--accent-color)' }} /> Call
    </button>
  );
}

function ActionButton({ onClick, disabled, busy, icon, label, danger }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.4rem',
        padding: '0.5rem 0.9rem',
        borderRadius: 8,
        border: '1px solid var(--border-color)',
        background: danger
          ? 'transparent'
          : 'var(--primary-color, var(--accent-color))',
        color: danger ? 'var(--danger-color)' : '#fff',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        fontSize: '0.86rem',
        fontWeight: 600,
      }}
    >
      {busy ? <Loader2 size={14} className="spin" /> : icon}
      {label}
    </button>
  );
}

function Section({ title, icon, children }) {
  return (
    <section
      style={{
        border: '1px solid var(--border-color)',
        borderRadius: 10,
        padding: '0.9rem 1rem',
        background: 'var(--surface-color)',
      }}
    >
      <h2
        style={{
          margin: '0 0 0.6rem',
          fontSize: '0.78rem',
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          color: 'var(--text-secondary)',
          display: 'flex',
          alignItems: 'center',
          gap: '0.4rem',
        }}
      >
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '9rem 1fr', gap: '0.6rem' }}>
      <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>{label}</div>
      <div style={{ fontSize: '0.88rem' }}>{children}</div>
    </div>
  );
}

function Muted({ children }) {
  return (
    <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>{children}</div>
  );
}

const secondaryButton = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.4rem',
  padding: '0.4rem 0.75rem',
  borderRadius: 8,
  border: '1px solid var(--border-color)',
  background: 'var(--input-bg)',
  color: 'inherit',
  cursor: 'pointer',
  fontSize: '0.85rem',
};

const primaryButton = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.35rem',
  padding: '0.35rem 0.7rem',
  borderRadius: 6,
  border: '1px solid var(--border-color)',
  background: 'var(--primary-color, var(--accent-color))',
  color: '#fff',
  cursor: 'pointer',
  fontSize: '0.82rem',
  fontWeight: 600,
};

const pagerButton = (disabled) => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.25rem',
  padding: '0.4rem 0.75rem',
  borderRadius: 8,
  border: '1px solid var(--border-color)',
  background: disabled ? 'transparent' : 'var(--input-bg)',
  color: 'inherit',
  cursor: disabled ? 'not-allowed' : 'pointer',
  opacity: disabled ? 0.5 : 1,
  fontSize: '0.82rem',
});

const thStyle = {
  textAlign: 'left',
  padding: '0.65rem 0.85rem',
  fontWeight: 600,
  fontSize: '0.78rem',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  color: 'var(--text-secondary)',
  whiteSpace: 'nowrap',
};
const tdStyle = { padding: '0.7rem 0.85rem', verticalAlign: 'top' };
const emptyCell = {
  padding: '1.5rem 0.85rem',
  textAlign: 'center',
  color: 'var(--text-secondary)',
};

function Th({ children, align = 'left' }) {
  return <th style={{ ...thStyle, textAlign: align }}>{children}</th>;
}
function Td({ children, align = 'left' }) {
  return <td style={{ ...tdStyle, textAlign: align }}>{children}</td>;
}
