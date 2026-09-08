import { useState, useMemo, useEffect } from 'react';
import { X } from 'lucide-react';
import { fetchApi } from '../../../utils/api';
import { isoLocalDate } from './constants';

// AssignDoctorModal — staff-side picker for assigning a doctor to a
// pending appointment (a portal self-booking with no doctor selected).
// Loads the same /doctors/availability list the booking form uses so
// admins on leave + doctors with block-times can't be picked. Hits
// PATCH /visits/:id/assign-doctor which runs the slot-conflict +
// leave guards server-side as the authoritative check.
export default function AssignDoctorModal({ visit, notify, onClose, onAssigned }) {
  const [doctors, setDoctors] = useState([]);
  const [loadingDocs, setLoadingDocs] = useState(true);
  const [selectedDoctorId, setSelectedDoctorId] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const visitDay = useMemo(() => {
    const d = new Date(visit.visitDate);
    if (Number.isNaN(d.getTime())) return null;
    return isoLocalDate(d);
  }, [visit?.visitDate]);

  // The appointment's local clock time. Without it the availability endpoint
  // could only answer day-level questions (leave, block-times), so a doctor who
  // already had an appointment in this very slot was still offered — and the
  // server then rejected the assignment with SLOT_TAKEN after the click.
  const visitTime = useMemo(() => {
    const d = new Date(visit.visitDate);
    if (Number.isNaN(d.getTime())) return null;
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }, [visit?.visitDate]);

  useEffect(() => {
    if (!visitDay) return;
    let cancelled = false;
    setLoadingDocs(true);
    const params = new URLSearchParams({ date: visitDay });
    // Ask about this exact slot, sized by the booked service, and ignore the
    // appointment being assigned so it never counts as its own conflict.
    if (visitTime) params.set('time', visitTime);
    if (visit?.serviceId) params.set('serviceId', String(visit.serviceId));
    if (visit?.id) params.set('excludeVisitId', String(visit.id));
    fetchApi(`/api/wellness/doctors/availability?${params.toString()}`)
      .then((data) => {
        if (cancelled) return;
        setDoctors(Array.isArray(data) ? data : []);
      })
      .catch((err) => {
        if (cancelled) return;
        notify?.error?.(err?.message || 'Failed to load doctor availability');
        setDoctors([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingDocs(false);
      });
    return () => { cancelled = true; };
  }, [visitDay, visitTime, visit?.serviceId, visit?.id, notify]);

  const submit = async () => {
    if (!selectedDoctorId || submitting) return;
    setSubmitting(true);
    try {
      await fetchApi(`/api/wellness/visits/${visit.id}/assign-doctor`, {
        method: 'PATCH',
        body: JSON.stringify({ doctorId: parseInt(selectedDoctorId, 10) }),
      });
      notify?.success?.('Doctor assigned');
      onAssigned?.();
    } catch (err) {
      notify?.error?.(err?.message || 'Failed to assign doctor');
    } finally {
      setSubmitting(false);
    }
  };

  const visitTimeIst = visit?.visitDate
    ? new Date(visit.visitDate).toLocaleString('en-IN', {
        weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: false,
      })
    : '—';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Assign doctor to appointment"
      onClick={onClose}
      data-testid="assign-doctor-modal"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1001,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem',
      }}
    >
      <div
        className="glass"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: '480px', width: '100%', padding: '1.5rem', borderRadius: 12 }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.75rem' }}>
          <div>
            <h3 style={{ margin: 0 }}>Assign doctor</h3>
            <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: '0.25rem' }}>
              {visit.patient?.name || 'Patient'} · {visit.service?.name || 'General'} · {visitTimeIst} IST
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            data-testid="assign-doctor-close"
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}
          >
            <X size={20} />
          </button>
        </div>

        {loadingDocs ? (
          <div style={{ padding: '1rem 0', color: 'var(--text-secondary)' }}>Loading available doctors…</div>
        ) : doctors.length === 0 ? (
          <div style={{ padding: '1rem 0', color: 'var(--text-secondary)' }}>
            No practitioners configured for this tenant.
          </div>
        ) : (
          <div style={{ display: 'grid', gap: '0.4rem', maxHeight: '320px', overflowY: 'auto', marginBottom: '0.75rem' }}>
            {doctors.map((d) => {
              const checked = String(selectedDoctorId) === String(d.id);
              return (
                <label
                  key={d.id}
                  data-testid={`assign-doctor-option-${d.id}`}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '0.6rem',
                    padding: '0.55rem 0.7rem',
                    borderRadius: 8,
                    border: `1px solid ${checked ? 'var(--primary-color, var(--accent-color, #6366f1))' : 'rgba(255,255,255,0.1)'}`,
                    background: checked ? 'rgba(99,102,241,0.1)' : 'transparent',
                    cursor: d.available === false ? 'not-allowed' : 'pointer',
                    opacity: d.available === false ? 0.5 : 1,
                  }}
                >
                  <input
                    type="radio"
                    name="assign-doctor-radio"
                    value={d.id}
                    checked={checked}
                    disabled={d.available === false}
                    onChange={(e) => setSelectedDoctorId(e.target.value)}
                  />
                  <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {d.name}
                      {d.specialty && (
                        <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', fontWeight: 400, marginLeft: '0.4rem' }}>
                          · {d.specialty}
                        </span>
                      )}
                    </div>
                    {d.wellnessRole && (
                      <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                        {d.wellnessRole}
                      </span>
                    )}
                  </div>
                  {d.available === false && (
                    <span
                      // Say WHY. "Unavailable" leaves the operator guessing
                      // whether the doctor is on leave or simply already booked
                      // at this hour — different problems with different fixes.
                      title={d.unavailableReason || 'Unavailable'}
                      style={{
                        fontSize: '0.65rem', padding: '0.1rem 0.4rem', borderRadius: 999,
                        background: 'color-mix(in srgb, var(--danger-color) 15%, transparent)',
                        color: 'var(--danger-color)', fontWeight: 600, whiteSpace: 'nowrap',
                      }}
                    >
                      {d.unavailableReason || 'Unavailable'}
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        )}

        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '0.5rem 1rem', borderRadius: 6,
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.1)',
              color: 'var(--text-primary)', cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!selectedDoctorId || submitting}
            data-testid="assign-doctor-submit"
            style={{
              padding: '0.5rem 1rem', borderRadius: 6,
              background: 'var(--primary-color, var(--accent-color, #6366f1))',
              color: '#fff', border: 'none',
              cursor: !selectedDoctorId || submitting ? 'not-allowed' : 'pointer',
              opacity: !selectedDoctorId || submitting ? 0.5 : 1,
            }}
          >
            {submitting ? 'Assigning…' : 'Assign doctor'}
          </button>
        </div>
      </div>
    </div>
  );
}
