import { useState } from 'react';
import { X } from 'lucide-react';
import { fetchApi } from '../../../utils/api';
import { modalInput, sourceBtn } from './constants';

// #270: lightweight modal for booking a visit from the calendar grid.
// Only required field is patientId (per the visit POST validator at
// routes/wellness.js:472). status defaults to 'booked' so the receptionist
// doesn't trip the "completed visits need serviceId + doctorId" gate.
export default function NewVisitModal({ column, hour, date, patients, services, waitlist, resources = [], notify, onClose, onCreated }) {
  const [patientId, setPatientId] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [notes, setNotes] = useState('');
  // Wave 11 Agent GG: optional resource selection. Filtered by service compatibility.
  const [resourceId, setResourceId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // #629: source flag tracks whether this booking is a fresh visit (default)
  // or a promotion from a waitlist entry. When 'waitlist', we PUT
  // /api/wellness/waitlist/:id with status='booked' + visitDate (the backend
  // materialises a Visit row at that slot — see routes/wellness.js:4298+).
  const [source, setSource] = useState('new'); // 'new' | 'waitlist'
  const [waitlistId, setWaitlistId] = useState('');

  const localDate = new Date(date);
  localDate.setHours(hour, 0, 0, 0);

  // #629: only show waitlist entries with status='waiting' (the parent
  // already filters by status, but defensive in case the prop changes).
  // The list is empty array fallback so the dropdown still renders even
  // with no waitlist entries — see test "renders waitlist dropdown options".
  const waitingEntries = Array.isArray(waitlist) ? waitlist.filter((w) => w.status === 'waiting') : [];

  const submit = async (e) => {
    e.preventDefault();
    if (submitting) return;

    // #629: visitDate built as IST wall time; backend stores as UTC, dashboard
    // applies the same +05:30 offset on read so the slot lands at the
    // intended hour for the receptionist's column.
    const istIso = `${date.toISOString().slice(0, 10)}T${String(hour).padStart(2, '0')}:00:00+05:30`;

    if (source === 'waitlist') {
      if (!waitlistId) return;
      setSubmitting(true);
      try {
        // PUT status='booked' triggers Visit creation in the backend handler
        // (see routes/wellness.js:4298) tied to the waitlist entry's
        // patient + service. The visitDate ensures the slot lands where the
        // receptionist clicked, not the +24h fallback.
        await fetchApi(`/api/wellness/waitlist/${parseInt(waitlistId, 10)}`, {
          method: 'PUT',
          body: JSON.stringify({ status: 'booked', visitDate: istIso }),
        });
        const entry = waitingEntries.find((w) => w.id === parseInt(waitlistId, 10));
        const name = entry?.patient?.name || 'patient';
        notify.success(`Promoted ${name} from waitlist to ${String(hour).padStart(2, '0')}:00`);
        onCreated();
      } catch (_err) { /* fetchApi already toasted */ }
      setSubmitting(false);
      return;
    }

    if (!patientId) return;
    setSubmitting(true);
    try {
      await fetchApi('/api/wellness/visits', {
        method: 'POST',
        body: JSON.stringify({
          patientId: parseInt(patientId, 10),
          serviceId: serviceId ? parseInt(serviceId, 10) : null,
          doctorId: column.id,
          // Wave 11 Agent GG: pin resource if selected (gate raises 409 RESOURCE_DOUBLE_BOOKED on overlap).
          resourceId: resourceId ? parseInt(resourceId, 10) : null,
          visitDate: istIso,
          status: 'booked',
          notes: notes || null,
        }),
      });
      const patientName = patients.find((p) => p.id === parseInt(patientId, 10))?.name;
      notify.success(`Booked ${patientName || 'visit'} at ${String(hour).padStart(2, '0')}:00 with ${column.name}`);
      onCreated();
    } catch (_err) { /* fetchApi already toasted */ }
    setSubmitting(false);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-visit-title"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 9000,
        background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '1rem',
      }}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="glass"
        style={{
          background: 'var(--surface-color, #ffffff)', color: 'var(--text-primary)',
          padding: '1.5rem', borderRadius: 12, width: '100%', maxWidth: 480,
          border: '1px solid var(--border-color, rgba(0,0,0,0.08))',
          boxShadow: '0 20px 60px rgba(0,0,0,0.35)',
          display: 'flex', flexDirection: 'column', gap: '0.75rem',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 id="new-visit-title" style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600 }}>
            New visit
          </h3>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}>
            <X size={18} />
          </button>
        </div>
        <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
          {column.name} • {localDate.toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })}
        </p>

        {/* #629: source toggle — pick "Promote from waitlist" when there are
            waiting entries, otherwise stays on the default new-visit path. */}
        {waitingEntries.length > 0 && (
          <div role="radiogroup" aria-label="Booking source" style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button
              type="button"
              role="radio"
              aria-checked={source === 'new'}
              onClick={() => setSource('new')}
              style={sourceBtn(source === 'new')}
            >
              New patient
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={source === 'waitlist'}
              onClick={() => setSource('waitlist')}
              style={sourceBtn(source === 'waitlist')}
            >
              Promote from waitlist ({waitingEntries.length})
            </button>
          </div>
        )}

        {source === 'waitlist' ? (
          <>
            <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Waitlisted patient *</label>
            <select
              required
              value={waitlistId}
              onChange={(e) => setWaitlistId(e.target.value)}
              style={modalInput}
              aria-label="Waitlisted patient"
            >
              <option value="">— select from waitlist —</option>
              {waitingEntries.map((w) => {
                const svcName = w.serviceId
                  ? (services.find((s) => s.id === w.serviceId)?.name || `service #${w.serviceId}`)
                  : 'any service';
                const phone = w.patient?.phone ? ` · ${w.patient.phone}` : '';
                return (
                  <option key={w.id} value={w.id}>
                    {w.patient?.name || `#${w.patientId}`}{phone} — {svcName}
                  </option>
                );
              })}
            </select>
            <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
              Promoting will create a booked visit at this slot and remove the patient from the waiting list.
            </p>
          </>
        ) : (
          <>
            <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Patient *</label>
            <select required value={patientId} onChange={(e) => setPatientId(e.target.value)} style={modalInput}>
              <option value="">— select patient —</option>
              {patients.map((p) => (
                <option key={p.id} value={p.id}>{p.name}{p.phone ? ` · ${p.phone}` : ''}</option>
              ))}
            </select>

            <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Service (optional)</label>
            <select value={serviceId} onChange={(e) => setServiceId(e.target.value)} style={modalInput}>
              <option value="">— pick later —</option>
              {services.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>

            {/* Wave 11 Agent GG: optional resource selection (room/machine). */}
            {resources.length > 0 && (
              <>
                <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Resource (optional)</label>
                <select value={resourceId} onChange={(e) => setResourceId(e.target.value)} style={modalInput}>
                  <option value="">— no resource pinned —</option>
                  {resources
                    .filter((r) => {
                      if (!serviceId) return true;
                      if (!r.serviceIds) return true;
                      try {
                        const allowed = JSON.parse(r.serviceIds);
                        return Array.isArray(allowed) && allowed.includes(parseInt(serviceId, 10));
                      } catch (_e) { return true; }
                    })
                    .map((r) => (
                      <option key={r.id} value={r.id}>{r.name} · {r.type}</option>
                    ))}
                </select>
              </>
            )}

            <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Notes (optional)</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              style={{ ...modalInput, resize: 'vertical', fontFamily: 'inherit' }}
              placeholder="Walk-in confirmed, follow-up consult, etc."
            />
          </>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.5rem' }}>
          <button type="button" onClick={onClose} style={{ padding: '0.5rem 1rem', background: 'transparent', border: '1px solid var(--border-color, rgba(0,0,0,0.15))', borderRadius: 8, cursor: 'pointer', color: 'var(--text-primary)' }}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={(source === 'waitlist' ? !waitlistId : !patientId) || submitting}
            style={{
              padding: '0.5rem 1.25rem',
              background: 'var(--primary-color, var(--accent-color, #6366f1))',
              opacity: ((source === 'waitlist' ? !waitlistId : !patientId) || submitting) ? 0.4 : 1,
              border: 'none', color: '#fff', borderRadius: 8,
              cursor: ((source === 'waitlist' ? !waitlistId : !patientId) || submitting) ? 'not-allowed' : 'pointer',
              fontWeight: 600,
            }}
          >
            {submitting ? 'Booking…' : source === 'waitlist' ? 'Promote from waitlist' : 'Book visit'}
          </button>
        </div>
      </form>
    </div>
  );
}
