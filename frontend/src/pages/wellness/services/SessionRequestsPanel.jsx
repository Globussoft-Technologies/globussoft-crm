import { useEffect, useState } from 'react';
import { CalendarClock, Check, X, Loader } from 'lucide-react';
import { fetchApi } from '../../../utils/api';
import { useNotify } from '../../../utils/notify';
import { formatDate } from '../../../utils/date';
import SingleSelectDropdown from './SingleSelectDropdown';
import { nowDateTimeInput, isPastDateTimeInput } from './shared';
import SearchableSingleSelect from './SearchableSingleSelect';

/**
 * Stored timestamp → the `YYYY-MM-DDTHH:mm` a datetime-local input wants, in
 * the viewer's own clock. Slicing the ISO string instead would show UTC and
 * quietly move an Indian clinic's slot back by five and a half hours.
 */
function toLocalDateTimeInput(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Patients asking to use a session from a package they bought.
 *
 * A request is a Visit in `requested` status: it is on nobody's calendar until
 * someone here accepts it, assigns a practitioner and confirms the slot. That
 * is the whole point of the queue — the clinic decides who takes the session
 * and when, rather than a customer dropping themselves into a diary.
 *
 * Accepting spends nothing. The session comes off the package only when the
 * visit is completed.
 */
export default function SessionRequestsPanel({ doctors = [], onHandled }) {
  const notify = useNotify();
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  // Per-request choices, so answering one does not disturb the others.
  const [drafts, setDrafts] = useState({});

  const load = () => {
    setLoading(true);
    fetchApi('/api/wellness/packages/session-requests', { silent: true })
      .then((res) => setRequests(Array.isArray(res?.requests) ? res.requests : []))
      .catch(() => setRequests([]))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  // Seeded with what the patient asked for, so accepting their preferred slot
  // is one click rather than retyping a date that is already on the card.
  const draftFor = (req) => drafts[req.id] || { doctorId: '', visitDate: toLocalDateTimeInput(req.visitDate) };
  const setDraft = (req, patch) =>
    setDrafts((d) => ({ ...d, [req.id]: { ...draftFor(req), ...patch } }));

  const accept = async (req) => {
    const draft = draftFor(req);
    if (!draft.doctorId) {
      notify.error('Pick who is taking this session first');
      return;
    }
    // The field is pre-filled with the date the patient asked for, which may
    // have gone by while the request sat in the queue — confirming it would
    // book a session into the past.
    if (isPastDateTimeInput(draft.visitDate)) {
      notify.error('That time has already passed — pick a new slot for this session');
      return;
    }
    setBusyId(req.id);
    try {
      await fetchApi(`/api/wellness/packages/session-requests/${req.id}/accept`, {
        method: 'POST',
        body: JSON.stringify({
          doctorId: draft.doctorId,
          visitDate: draft.visitDate || null,
        }),
      });
      notify.success(`Session confirmed for ${req.patient?.name || 'the patient'}`);
      load();
      onHandled?.();
    } catch (err) {
      notify.error(err?.message || 'Could not accept the request');
    } finally {
      setBusyId(null);
    }
  };

  const decline = async (req) => {
    setBusyId(req.id);
    try {
      await fetchApi(`/api/wellness/packages/session-requests/${req.id}/decline`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      notify.success('Request declined — the session stays on their package');
      load();
      onHandled?.();
    } catch (err) {
      notify.error(err?.message || 'Could not decline the request');
    } finally {
      setBusyId(null);
    }
  };

  // An empty queue is the normal state; a permanent empty box is just clutter.
  if (loading || requests.length === 0) return null;

  const doctorOptions = doctors.map((d) => ({ value: String(d.id), label: d.name }));

  return (
    <section data-testid="session-requests-panel" style={{ marginBottom: '1.75rem' }}>
      <h2 style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
        <CalendarClock size={15} /> Session requests
        <span style={{ fontSize: '0.7rem', fontWeight: 600, padding: '0.1rem 0.4rem', borderRadius: 999, background: 'rgba(245,158,11,0.14)', color: '#f59e0b' }}>
          {requests.length}
        </span>
      </h2>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 320px), 1fr))', gap: '1rem' }}>
        {requests.map((req) => {
          const busy = busyId === req.id;
          const draft = draftFor(req);
          const plan = req.treatmentPlan;
          const left = plan ? Math.max(0, plan.totalSessions - plan.completedSessions) : 0;
          return (
            <div
              key={req.id}
              className="glass"
              data-testid={`session-request-${req.id}`}
              style={{ padding: '1rem', borderRadius: 12, display: 'grid', gap: '0.5rem' }}
            >
              <div style={{ fontWeight: 600 }}>{req.patient?.name || 'Patient'}</div>
              <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                {plan?.name} · {left} of {plan?.totalSessions} sessions left
                {req.service?.name ? ` · ${req.service.name}` : ''}
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                Asked for {formatDate(req.visitDate)}
                {req.patient?.phone ? ` · ${req.patient.phone}` : ''}
              </div>
              {req.reason && (
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontStyle: 'italic' }}>
                  “{req.reason}”
                </div>
              )}

              <div style={{ display: 'grid', gap: '0.4rem', marginTop: '0.25rem' }}>
                <div data-testid={`session-request-doctor-${req.id}`}>
  <SearchableSingleSelect
    value={draft.doctorId}
    onChange={(v) => setDraft(req, { doctorId: v })}
    options={doctorOptions}
    placeholder="Assign a practitioner…"
    aria-label="Practitioner"
  />
</div>
                <input
                  type="datetime-local"
                  min={nowDateTimeInput()}
                  value={draft.visitDate}
                  onChange={(e) => setDraft(req, { visitDate: e.target.value })}
                  data-testid={`session-request-date-${req.id}`}
                  style={{
                    padding: '0.45rem 0.6rem',
                    background: 'var(--subtle-bg-3)',
                    border: '1px solid var(--border-color)',
                    borderRadius: 6,
                    color: 'var(--text-primary)',
                    fontSize: '0.78rem',
                    width: '100%',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.25rem' }}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => accept(req)}
                  data-testid={`session-request-accept-${req.id}`}
                  style={{
                    flex: 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '0.35rem',
                    padding: '0.45rem 0.6rem',
                    background: 'var(--accent-color)',
                    border: 'none',
                    borderRadius: 7,
                    color: '#fff',
                    fontSize: '0.78rem',
                    fontWeight: 600,
                    cursor: busy ? 'not-allowed' : 'pointer',
                  }}
                >
                  {busy ? <Loader size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Check size={13} />}
                  Accept
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => decline(req)}
                  data-testid={`session-request-decline-${req.id}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.35rem',
                    padding: '0.45rem 0.7rem',
                    background: 'transparent',
                    border: '1px solid var(--border-color)',
                    borderRadius: 7,
                    color: 'var(--text-secondary)',
                    fontSize: '0.78rem',
                    cursor: busy ? 'not-allowed' : 'pointer',
                  }}
                >
                  <X size={13} /> Decline
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
