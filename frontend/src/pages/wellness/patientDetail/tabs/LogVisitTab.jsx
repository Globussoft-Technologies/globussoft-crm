import { useState } from 'react';
import { fetchApi } from '../../../../utils/api';
import { useNotify } from '../../../../utils/notify';
import { formatDate } from '../../../../utils/date';

// ── Log visit tab ──────────────────────────────────────────────────
// Shows booked appointments; clicking one lets you mark it as visited (completed)
// and optionally add notes/amount. Marking as visited triggers auto-consumption.
// When a visit is completed with a charge, a Razorpay payment link is generated
// and surfaced here so staff can copy it and share it with the patient.
export default function LogVisitTab({ patient, services, doctors: _doctors, onSaved }) {
  const notify = useNotify();
  const [selectedVisitId, setSelectedVisitId] = useState(null);
  const [notes, setNotes] = useState('');
  const [consumptionRules, setConsumptionRules] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [generatingLinkId, setGeneratingLinkId] = useState(null);
  const [copiedId, setCopiedId] = useState(null);
  // Live deployments sometimes reload the patient before the DB replica has
  // caught up with the payment-link write, so the button re-appears even
  // though the POST succeeded. Cache generated URLs locally so the UI reflects
  // the successful creation immediately.
  const [generatedLinks, setGeneratedLinks] = useState({});

  const visits = patient.visits || [];
  const bookedAppointments = visits.filter((v) =>
    v.status && ['booked', 'confirmed', 'arrived', 'in-treatment'].includes(v.status)
  );
  const completedVisits = visits.filter((v) => v.status === 'completed');

  const selectedVisit = selectedVisitId ? visits.find((v) => v.id === parseInt(selectedVisitId)) : null;
  const selectedService = selectedVisit ? services.find((s) => s.id === selectedVisit.serviceId) : null;

  const handleSelectVisit = async (apt) => {
    setSelectedVisitId(apt.id);
    setNotes(apt.notes || '');
    try {
      const rules = await fetchApi('/api/wellness/auto-consumption-rules');
      const serviceRules = Array.isArray(rules) ? rules.filter((r) => r.serviceId === apt.serviceId) : [];
      setConsumptionRules(serviceRules);
    } catch (_e) {
      setConsumptionRules([]);
    }
  };

  const copyToClipboard = async (text, id) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch (_err) {
      notify.error('Failed to copy link');
    }
  };

  const generatePaymentLink = async (visit) => {
    if (generatingLinkId) return;
    setGeneratingLinkId(visit.id);
    try {
      const result = await fetchApi(`/api/wellness/visits/${visit.id}/payment-link`, {
        method: 'POST',
      });
      const linkUrl = result?.url || result?.paymentLinkUrl;
      if (linkUrl) {
        setGeneratedLinks((prev) => ({ ...prev, [visit.id]: linkUrl }));
        onSaved();
        notify.success('Payment link generated');
      } else {
        notify.error('Payment link could not be generated. Please check the gateway configuration.');
      }
    } catch (_err) {
      // fetchApi already toasted
    } finally {
      setGeneratingLinkId(null);
    }
  };

  const markAsVisited = async (e) => {
    e.preventDefault();
    if (!selectedVisit || !selectedService) {
      notify.error('Please select an appointment to mark as visited.');
      return;
    }
    if (submitting) return;
    setSubmitting(true);
    try {
      const result = await fetchApi(`/api/wellness/visits/${selectedVisit.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          status: 'completed',
          notes,
          amountCharged: selectedService.basePrice || 0,
        }),
      });
      setSelectedVisitId(null);
      setNotes('');
      setConsumptionRules([]);
      onSaved();
      if (result?.paymentLinkUrl) {
        notify.success('Appointment marked as visited. Payment link generated.');
      } else if (Number(selectedService.basePrice) > 0) {
        notify.success('Appointment marked as visited. A payment link could not be generated; check the payment gateway configuration.');
      } else {
        notify.success('Appointment marked as visited & auto-consumption triggered.');
      }
    } catch (_err) { /* fetchApi already toasted */ } finally {
      setSubmitting(false);
    }
  };

  const renderPaymentLinkBlock = (visit) => {
    if (!visit.amountCharged || visit.amountCharged <= 0) return null;

    const linkUrl = visit.paymentLinkUrl || generatedLinks[visit.id];
    const isPaid =
      String(visit.paymentStatus || '').toLowerCase() === 'paid' ||
      String(visit.invoice?.status || '').toUpperCase() === 'PAID';

    if (isPaid) {
      return (
        <div style={{ marginTop: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span
              style={{
                fontSize: '0.8rem',
                padding: '0.3rem 0.7rem',
                background: 'rgba(16, 185, 129, 0.15)',
                color: 'var(--success-color)',
                border: '1px solid rgba(16, 185, 129, 0.3)',
                borderRadius: 999,
                fontWeight: 600,
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.3rem',
              }}
            >
              ✓ Paid
            </span>
            {linkUrl && (
              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                Payment collected
              </span>
            )}
          </div>
          {linkUrl && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <input
                readOnly
                disabled
                value={linkUrl}
                aria-label="Payment link"
                style={{
                  flex: 1,
                  fontSize: '0.8rem',
                  padding: '0.4rem 0.6rem',
                  background: 'rgba(16, 185, 129, 0.08)',
                  border: '1px solid rgba(16, 185, 129, 0.3)',
                  borderRadius: 6,
                  color: 'var(--success-color)',
                  outline: 'none',
                  opacity: 0.7,
                  cursor: 'not-allowed',
                }}
              />
              <button
                type="button"
                disabled
                aria-disabled="true"
                title="Payment already collected"
                style={{
                  fontSize: '0.8rem',
                  padding: '0.4rem 0.75rem',
                  background: 'rgba(16, 185, 129, 0.1)',
                  color: 'var(--success-color)',
                  border: '1px solid rgba(16, 185, 129, 0.3)',
                  borderRadius: 6,
                  cursor: 'not-allowed',
                  whiteSpace: 'nowrap',
                  fontWeight: 500,
                  opacity: 0.45,
                }}
              >
                Copy
              </button>
            </div>
          )}
        </div>
      );
    }

    if (linkUrl) {
      return (
        <div style={{ marginTop: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <input
            readOnly
            value={linkUrl}
            onClick={(e) => e.target.select()}
            aria-label="Payment link"
            style={{
              flex: 1,
              fontSize: '0.8rem',
              padding: '0.4rem 0.6rem',
              background: 'rgba(0,0,0,0.2)',
              border: '1px solid rgba(16, 185, 129, 0.3)',
              borderRadius: 6,
              color: 'var(--text-primary)',
              outline: 'none',
            }}
          />
          <button
            type="button"
            onClick={() => copyToClipboard(linkUrl, visit.id)}
            style={{
              fontSize: '0.8rem',
              padding: '0.4rem 0.75rem',
              background: copiedId === visit.id ? 'rgba(16, 185, 129, 0.25)' : 'rgba(16, 185, 129, 0.1)',
              color: 'var(--success-color)',
              border: '1px solid rgba(16, 185, 129, 0.3)',
              borderRadius: 6,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              fontWeight: 500,
            }}
          >
            {copiedId === visit.id ? 'Copied!' : 'Copy'}
          </button>
        </div>
      );
    }

    return (
      <div style={{ marginTop: '0.5rem' }}>
        <button
          type="button"
          onClick={() => generatePaymentLink(visit)}
          disabled={generatingLinkId === visit.id}
          style={{
            fontSize: '0.8rem',
            padding: '0.4rem 0.75rem',
            background: generatingLinkId === visit.id ? 'rgba(107,114,128,0.15)' : 'rgba(16, 185, 129, 0.1)',
            color: 'var(--success-color)',
            border: '1px solid rgba(16, 185, 129, 0.3)',
            borderRadius: 6,
            cursor: generatingLinkId === visit.id ? 'not-allowed' : 'pointer',
            opacity: generatingLinkId === visit.id ? 0.7 : 1,
            fontWeight: 500,
          }}
        >
          {generatingLinkId === visit.id ? 'Generating…' : 'Generate payment link'}
        </button>
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', gap: '1.5rem' }}>
      <div className="glass" style={{ flex: 1, padding: '1.5rem', overflow: 'auto', maxHeight: '600px' }}>
        <div style={{ marginBottom: '1.5rem' }}>
          <h3 style={{ marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            📅 Pending Appointments
            {bookedAppointments.length > 0 && <span style={{ fontSize: '0.85rem', color: 'var(--accent-color)', fontWeight: 400 }}>({bookedAppointments.length})</span>}
          </h3>
          {bookedAppointments.length === 0 ? (
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>No pending appointments.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {bookedAppointments.map((apt) => (
                <div
                  key={apt.id}
                  onClick={() => handleSelectVisit(apt)}
                  style={{
                    padding: '0.75rem',
                    border: selectedVisitId === apt.id ? '2px solid var(--accent-color)' : '1px solid var(--border-color)',
                    borderRadius: 8,
                    cursor: 'pointer',
                    background: selectedVisitId === apt.id ? 'rgba(205, 148, 129, 0.1)' : 'rgba(255,255,255,0.02)',
                    transition: 'all 0.2s',
                  }}
                >
                  <div style={{ fontWeight: 500, marginBottom: '0.25rem' }}>
                    {formatDate(apt.visitDate)} · {apt.service?.name || 'Consultation'}
                  </div>
                  <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                    Doctor: {apt.doctor?.name || '—'} · Status: <span style={{ textTransform: 'capitalize', color: 'var(--accent-color)' }}>{apt.status}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {completedVisits.length > 0 && (
          <div style={{ paddingTop: '1rem', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
            <h3 style={{ marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              ✓ Completed Visits
              <span style={{ fontSize: '0.85rem', color: 'var(--success-color)', fontWeight: 400 }}>({completedVisits.length})</span>
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {completedVisits.map((visit) => (
                <div
                  key={visit.id}
                  style={{
                    padding: '0.75rem',
                    border: '1px solid rgba(16, 185, 129, 0.2)',
                    borderRadius: 8,
                    background: 'rgba(16, 185, 129, 0.05)',
                  }}
                >
                  <div style={{ fontWeight: 500, marginBottom: '0.25rem', color: 'var(--text-primary)' }}>
                    {formatDate(visit.visitDate)} · {visit.service?.name || 'Consultation'}
                  </div>
                  <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                    Doctor: {visit.doctor?.name || '—'}
                    {visit.amountCharged > 0 && <> · Amount: ₹{visit.amountCharged.toLocaleString('en-IN')}</>}
                  </div>
                  {renderPaymentLinkBlock(visit)}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {selectedVisit && (
        <form onSubmit={markAsVisited} className="glass" style={{ flex: 1, padding: '1.5rem', overflow: 'auto', maxHeight: '600px' }}>
          <h3 style={{ marginBottom: '1rem' }}>Mark as visited</h3>

          <div style={{ marginBottom: '1rem', padding: '0.75rem', background: 'rgba(255,255,255,0.02)', borderRadius: 8 }}>
            <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>Service:</div>
            <div style={{ fontWeight: 600, marginBottom: '0.5rem' }}>{selectedService?.name}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', fontSize: '0.9rem' }}>
              <div>
                <span style={{ color: 'var(--text-secondary)' }}>Amount: </span>
                <strong>₹{selectedService?.basePrice || 0}</strong>
              </div>
              <div>
                <span style={{ color: 'var(--text-secondary)' }}>Duration: </span>
                <strong>{selectedService?.durationMin || 30} min</strong>
              </div>
            </div>
          </div>

          {consumptionRules.length > 0 && (
            <div style={{ marginBottom: '1rem', padding: '0.75rem', background: 'rgba(16, 185, 129, 0.08)', borderRadius: 8, border: '1px solid rgba(16, 185, 129, 0.2)' }}>
              <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.5rem', fontWeight: 600 }}>
                ✓ Auto-Consumption Preview
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                {consumptionRules.map((rule) => (
                  <div key={rule.id} style={{ fontSize: '0.85rem', padding: '0.4rem 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                    <div style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{rule.product?.name}</div>
                    <div style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                      Will deduct: {rule.quantityPerVisit} {rule.product?.unit || 'units'}
                      {rule.product?.volume && ` (÷ ${rule.product.volume}ml = ${(rule.quantityPerVisit / rule.product.volume).toFixed(2)} units)`}
                    </div>
                    <div style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                      Current stock: {rule.product?.currentStock || 0} units
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {consumptionRules.length === 0 && (
            <div style={{ marginBottom: '1rem', padding: '0.75rem', background: 'rgba(107,114,128,0.1)', borderRadius: 8, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
              No auto-consumption rules configured for this service.
            </div>
          )}

          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.3rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Clinical notes (optional)</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Add any clinical observations..."
              style={{ width: '100%', padding: '0.55rem 0.75rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, color: 'var(--text-primary)', fontSize: '0.9rem', outline: 'none', resize: 'vertical' }}
            />
          </div>

          <button
            type="submit"
            disabled={submitting}
            style={{
              width: '100%',
              padding: '0.55rem 1.25rem',
              background: submitting ? 'rgba(107,114,128,0.3)' : 'var(--success-color)',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              cursor: submitting ? 'not-allowed' : 'pointer',
              opacity: submitting ? 0.6 : 1,
              fontWeight: 500,
            }}
          >
            {submitting ? 'Marking as visited…' : '✓ Mark as visited & consume products'}
          </button>
        </form>
      )}
    </div>
  );
}
