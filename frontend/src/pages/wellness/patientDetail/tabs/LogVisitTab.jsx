import { useState } from 'react';
import { Check, Copy, Loader2, RotateCcw, Send } from 'lucide-react';
import { fetchApi } from '../../../../utils/api';
import { useNotify } from '../../../../utils/notify';
import { formatDate } from '../../../../utils/date';

//  Log visit tab 
// Shows booked appointments; clicking one lets you mark it as visited (completed)
// and optionally add notes/amount. Marking as visited triggers auto-consumption.
// When a visit is completed with a charge, a Razorpay payment link is generated
// and surfaced here so staff can copy it and share it with the patient.
export default function LogVisitTab({ patient, services, doctors: _doctors, onSaved }) {
  const notify = useNotify();
  const [amountError, setAmountError] = useState('');
  const [selectedVisitId, setSelectedVisitId] = useState(null);
  const [notes, setNotes] = useState('');
  const [consumptionRules, setConsumptionRules] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [generatingLinkId, setGeneratingLinkId] = useState(null);
  const [paymentLinkAction, setPaymentLinkAction] = useState(null);
  const [copiedId, setCopiedId] = useState(null);
  // Live deployments sometimes reload the patient before the DB replica has
  // caught up with the payment-link write, so the button re-appears even
  // though the POST succeeded. Cache generated URLs locally so the UI reflects
  // the successful creation immediately.
  const [generatedLinks, setGeneratedLinks] = useState({});
  // Billing controls for the post-treatment payment link: staff can override the
  // total bill and apply a coupon.
  const [amountCharged, setAmountCharged] = useState('');
  const [couponCode, setCouponCode] = useState('');
  const [appliedCoupon, setAppliedCoupon] = useState(null);
  const [previewBreakdown, setPreviewBreakdown] = useState(null);
  const [billingBreakdown, setBillingBreakdown] = useState(null);
  const [couponError, setCouponError] = useState('');
  const [applyingCoupon, setApplyingCoupon] = useState(false);

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
    setCouponCode('');
    setAppliedCoupon(null);
    setPreviewBreakdown(null);
    setBillingBreakdown(null);
    setCouponError('');
    // Default the bill to the service price; staff can override it before marking
    // the visit completed. Use the visit's existing amountCharged if already set.
    setAmountCharged(
      apt.amountCharged != null && apt.amountCharged !== ''
        ? String(apt.amountCharged)
        : String(services.find((s) => s.id === apt.serviceId)?.basePrice || ''),
    );
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
      return true;
    } catch (_err) {
      notify.error('Failed to copy link');
      return false;
    }
  };

  const generatePaymentLink = async (visit, options = {}) => {
    if (generatingLinkId) return;
    const isRegenerate = Boolean(options.regenerate);
    setGeneratingLinkId(visit.id);
    setPaymentLinkAction({ id: visit.id, type: isRegenerate ? 'regenerate' : 'generate' });
    try {
      const result = await fetchApi(`/api/wellness/visits/${visit.id}/payment-link`, {
        method: 'POST',
      });
      const linkUrl = result?.url || result?.paymentLinkUrl;
      if (linkUrl) {
        setGeneratedLinks((prev) => ({ ...prev, [visit.id]: linkUrl }));
        onSaved();
        const copied = await copyToClipboard(linkUrl, visit.id);
        notify.success(copied ? 'Payment link generated and copied' : (isRegenerate ? 'Payment link regenerated' : 'Payment link generated'));
      } else {
        notify.error('Payment link could not be generated. Please check the gateway configuration.');
      }
    } catch (_err) {
      // fetchApi already toasted
    } finally {
      setGeneratingLinkId(null);
      setPaymentLinkAction(null);
    }
  };

  const sendPaymentLink = async (visit) => {
    if (generatingLinkId) return;
    setGeneratingLinkId(visit.id);
    setPaymentLinkAction({ id: visit.id, type: 'send' });
    try {
      const result = await fetchApi(`/api/wellness/visits/${visit.id}/payment-link/send`, {
        method: 'POST',
      });
      const linkUrl = result?.url || result?.paymentLinkUrl;
      if (linkUrl) {
        setGeneratedLinks((prev) => ({ ...prev, [visit.id]: linkUrl }));
      }
      onSaved();
      const channel = String(result?.channel || 'none').toLowerCase();
      if (channel === 'none') {
        notify.info('Payment link prepared. Send it manually.');
        return;
      }
      const channels = [];
      if (channel.includes('email')) channels.push('email');
      if (channel.includes('whatsapp')) channels.push('WhatsApp');
      notify.success(`Payment link sent via ${channels.join(' + ')}`);
    } catch (_err) {
      // fetchApi already toasted
    } finally {
      setGeneratingLinkId(null);
      setPaymentLinkAction(null);
    }
  };

  const previewCoupon = async () => {
    if (!selectedVisit || !selectedService) return;
    const code = couponCode.trim();
    if (!code) {
      setCouponError('Enter a coupon code');
      setAppliedCoupon(null);
      setPreviewBreakdown(null);
      return;
    }
    const base = Number(amountCharged);
    if (!Number.isFinite(base) || base <= 0) {
      setCouponError('Enter a valid bill amount before applying a coupon');
      return;
    }
    setApplyingCoupon(true);
    setCouponError('');
    try {
      const result = await fetchApi('/api/wellness/coupons/preview', {
        method: 'POST',
        body: JSON.stringify({ code, baseAmount: base, serviceId: selectedService.id, visitId: selectedVisit.id }),
      });
      if (result?.error) {
        setCouponError(result.error || 'Could not apply coupon');
        setAppliedCoupon(null);
        setPreviewBreakdown(null);
        return;
      }
      if (!result?.applied) {
        setCouponError('Coupon does not apply to this service or cart');
        setAppliedCoupon(null);
        setPreviewBreakdown(null);
        return;
      }
      setAppliedCoupon({ code: result.code, discountType: result.discountType, discountValue: result.discountValue });
      setPreviewBreakdown({
        baseAmount: result.baseAmount,
        discount: result.discount,
        finalAmount: result.finalAmount,
        lockingFee: result.lockingFee || 0,
        balance: result.balance != null ? result.balance : result.finalAmount,
      });
      notify.success(`Coupon ${result.code} applied — discount ₹${result.discount}`);
    } catch (_err) {
      // fetchApi already toasted
      setAppliedCoupon(null);
      setPreviewBreakdown(null);
    } finally {
      setApplyingCoupon(false);
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
      const chargeAmount = Number(amountCharged) || 0;
      const result = await fetchApi(`/api/wellness/visits/${selectedVisit.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          status: 'completed',
          notes,
          amountCharged: chargeAmount,
          couponCode: appliedCoupon ? appliedCoupon.code : couponCode.trim() || undefined,
        }),
      });
      setSelectedVisitId(null);
      setNotes('');
      setConsumptionRules([]);
      setAmountCharged('');
      setCouponCode('');
      setAppliedCoupon(null);
      setPreviewBreakdown(null);
      setBillingBreakdown(result?.billingBreakdown || null);
      onSaved();
      if (result?.billingBreakdown?.couponCode) {
        notify.success(`Coupon ${result.billingBreakdown.couponCode} applied. Total due is now ₹${result.billingBreakdown.balance}.`);
      } else if (result?.paymentLinkUrl) {
        notify.success('Appointment marked as visited. Payment link generated.');
      } else if (chargeAmount > 0) {
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

    const linkUrl = generatedLinks[visit.id] || visit.paymentLinkUrl;
    const isLinkBusy = generatingLinkId === visit.id;
    const linkActionType = paymentLinkAction?.id === visit.id ? paymentLinkAction.type : null;
    const isPaid =
      String(visit.paymentStatus || '').toLowerCase() === 'paid' ||
      String(visit.invoice?.status || '').toUpperCase() === 'PAID';

    const actionRowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: '0.35rem',
      flexWrap: 'wrap',
      justifyContent: 'flex-end',
    };

    const actionButtonStyle = (tone = 'default', busy = false) => ({
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 36,
      height: 36,
      padding: 0,
      borderRadius: 10,
      border: '1px solid rgba(16, 185, 129, 0.28)',
      cursor: busy ? 'not-allowed' : 'pointer',
      background:
        tone === 'active'
          ? 'rgba(16, 185, 129, 0.2)'
          : tone === 'muted'
            ? 'rgba(16, 185, 129, 0.06)'
            : 'rgba(16, 185, 129, 0.1)',
      color: 'var(--success-color)',
      opacity: busy ? 0.72 : 1,
      boxShadow: busy ? 'none' : '0 1px 0 rgba(16, 185, 129, 0.08)',
      transition: 'background 0.18s ease, border-color 0.18s ease, transform 0.18s ease',
    });

    const iconStyle = (busy = false) => ({
      width: 15,
      height: 15,
      flexShrink: 0,
      animation: busy ? 'spin 1s linear infinite' : 'none',
    });

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
              Paid
            </span>
            {linkUrl && (
              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                Payment collected
              </span>
            )}
          </div>
          {linkUrl && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
              <input
                readOnly
                disabled
                value={linkUrl}
                aria-label="Payment link"
                style={{
                  flex: 1,
                  minWidth: 260,
                  fontSize: '0.8rem',
                  padding: '0.45rem 0.65rem',
                  background: 'rgba(16, 185, 129, 0.08)',
                  border: '1px solid rgba(16, 185, 129, 0.3)',
                  borderRadius: 8,
                  color: 'var(--success-color)',
                  outline: 'none',
                  opacity: 0.72,
                  cursor: 'not-allowed',
                }}
              />
              <div style={actionRowStyle}>
                <button
                  type="button"
                  onClick={() => copyToClipboard(linkUrl, visit.id)}
                  aria-label={copiedId === visit.id ? 'Copied payment link' : 'Copy payment link'}
                  title={copiedId === visit.id ? 'Copied' : 'Copy payment link'}
                  style={actionButtonStyle(copiedId === visit.id ? 'active' : 'muted')}
                >
                  {copiedId === visit.id ? (
                    <Check size={15} aria-hidden style={iconStyle(false)} />
                  ) : (
                    <Copy size={15} aria-hidden style={iconStyle(false)} />
                  )}
                </button>
              </div>
            </div>
          )}
        </div>
      );
    }

    if (linkUrl) {
      return (
        <div style={{ marginTop: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <input
            readOnly
            value={linkUrl}
            onClick={(e) => e.target.select()}
            aria-label="Payment link"
            style={{
              flex: 1,
              minWidth: 260,
              fontSize: '0.8rem',
              padding: '0.45rem 0.65rem',
              background: 'rgba(0,0,0,0.2)',
              border: '1px solid rgba(16, 185, 129, 0.3)',
              borderRadius: 8,
              color: 'var(--text-primary)',
              outline: 'none',
            }}
          />
          <div style={actionRowStyle}>
            <button
              type="button"
              onClick={() => copyToClipboard(linkUrl, visit.id)}
              aria-label={copiedId === visit.id ? 'Copied payment link' : 'Copy payment link'}
              title={copiedId === visit.id ? 'Copied' : 'Copy payment link'}
              style={actionButtonStyle(copiedId === visit.id ? 'active' : 'default')}
            >
              {copiedId === visit.id ? <Check size={15} aria-hidden style={iconStyle()} /> : <Copy size={15} aria-hidden style={iconStyle()} />}
            </button>
            <button
              type="button"
              onClick={() => sendPaymentLink(visit)}
              disabled={isLinkBusy}
              aria-label={isLinkBusy && linkActionType === 'send' ? 'Sending payment link' : 'Send payment link'}
              title={isLinkBusy && linkActionType === 'send' ? 'Sending...' : 'Send payment link'}
              style={actionButtonStyle(isLinkBusy && linkActionType === 'send' ? 'active' : 'default', isLinkBusy)}
            >
              {isLinkBusy && linkActionType === 'send' ? (
                <Loader2 size={15} aria-hidden style={iconStyle(true)} />
              ) : (
                <Send size={15} aria-hidden style={iconStyle()} />
              )}
            </button>
            <button
              type="button"
              onClick={() => generatePaymentLink(visit, { regenerate: true })}
              disabled={isLinkBusy}
              aria-label={isLinkBusy && linkActionType === 'regenerate' ? 'Regenerating payment link' : 'Regenerate payment link'}
              title={isLinkBusy && linkActionType === 'regenerate' ? 'Regenerating...' : 'Regenerate payment link'}
              style={actionButtonStyle(isLinkBusy && linkActionType === 'regenerate' ? 'active' : 'default', isLinkBusy)}
            >
              {isLinkBusy && linkActionType === 'regenerate' ? (
                <Loader2 size={15} aria-hidden style={iconStyle(true)} />
              ) : (
                <RotateCcw size={15} aria-hidden style={iconStyle()} />
              )}
            </button>
          </div>
        </div>
      );
    }

    return (
      <div style={{ marginTop: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={() => generatePaymentLink(visit)}
          disabled={generatingLinkId === visit.id}
          aria-label={generatingLinkId === visit.id && paymentLinkAction?.type === 'generate' ? 'Generating payment link' : 'Generate payment link'}
          title={generatingLinkId === visit.id && paymentLinkAction?.type === 'generate' ? 'Generating...' : 'Generate payment link'}
          style={actionButtonStyle(generatingLinkId === visit.id && paymentLinkAction?.type === 'generate' ? 'active' : 'default', generatingLinkId === visit.id)}
        >
          {generatingLinkId === visit.id && paymentLinkAction?.type === 'generate' ? (
            <Loader2 size={15} aria-hidden style={iconStyle(true)} />
          ) : (
            <RotateCcw size={15} aria-hidden style={iconStyle()} />
          )}
        </button>
        <button
          type="button"
          onClick={() => sendPaymentLink(visit)}
          disabled={generatingLinkId === visit.id}
          aria-label={generatingLinkId === visit.id && paymentLinkAction?.type === 'send' ? 'Sending payment link' : 'Send payment link'}
          title={generatingLinkId === visit.id && paymentLinkAction?.type === 'send' ? 'Sending...' : 'Send payment link'}
          style={actionButtonStyle(generatingLinkId === visit.id && paymentLinkAction?.type === 'send' ? 'active' : 'default', generatingLinkId === visit.id)}
        >
          {generatingLinkId === visit.id && paymentLinkAction?.type === 'send' ? (
            <Loader2 size={15} aria-hidden style={iconStyle(true)} />
          ) : (
            <Send size={15} aria-hidden style={iconStyle()} />
          )}
        </button>
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
      {billingBreakdown && (
        <div style={{ width: '100%', padding: '0.85rem 1rem', background: 'rgba(16, 185, 129, 0.1)', border: '1px solid rgba(16, 185, 129, 0.25)', borderRadius: 8, color: 'var(--text-primary)', fontSize: '0.9rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem' }}>
            <div>
              {billingBreakdown.couponCode ? (
                <>
                  Coupon <strong>{billingBreakdown.couponCode}</strong> applied. Total due is now{' '}
                  <strong>₹{billingBreakdown.balance.toLocaleString('en-IN')}</strong>.
                </>
              ) : (
                <>
                  Payment link generated for balance{' '}
                  <strong>₹{billingBreakdown.balance.toLocaleString('en-IN')}</strong>.
                </>
              )}
            </div>
            <button
              type="button"
              onClick={() => setBillingBreakdown(null)}
              style={{ padding: '0.3rem 0.6rem', background: 'transparent', border: '1px solid rgba(16, 185, 129, 0.3)', borderRadius: 6, color: 'var(--success-color)', fontSize: '0.8rem', cursor: 'pointer' }}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
      <div className="glass" style={{ flex: 1, padding: '1.5rem', overflow: 'auto', maxHeight: '600px' }}>
        <div style={{ marginBottom: '1.5rem' }}>
          <h3 style={{ marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            Pending Appointments
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
                    {formatDate(apt.visitDate)} - {apt.service?.name || 'Consultation'}
                  </div>
                  <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                    Doctor: {apt.doctor?.name || '-'} - Status: <span style={{ textTransform: 'capitalize', color: 'var(--accent-color)' }}>{apt.status}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {completedVisits.length > 0 && (
          <div style={{ paddingTop: '1rem', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
            <h3 style={{ marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              Completed Visits
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
                    {formatDate(visit.visitDate)} - {visit.service?.name || 'Consultation'}
                  </div>
                  <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                    Doctor: {visit.doctor?.name || '-'}
                    {visit.amountCharged > 0 && (
                      <>
                        {' - '}
                        {(() => {
                          const breakdown = typeof visit.couponBreakdown === 'string'
                            ? (() => { try { return JSON.parse(visit.couponBreakdown); } catch (_e) { return null; } })()
                            : visit.couponBreakdown;
                          if (breakdown && typeof breakdown === 'object' && Number.isFinite(Number(breakdown.balance))) {
                            return (
                              <>
                                <span style={{ textDecoration: 'line-through', opacity: 0.7 }}>₹{Number(breakdown.baseAmount).toLocaleString('en-IN')}</span>
                                {' — Coupon '}{breakdown.couponCode}{' — ₹'}{Number(breakdown.discount).toLocaleString('en-IN')}{' deducted — '}
                                <span>Balance due: </span>
                                <strong style={{ color: 'var(--success-color)' }}>₹{Number(breakdown.balance).toLocaleString('en-IN')}</strong>
                              </>
                            );
                          }
                          if (visit.invoice?.amount > 0 && visit.invoice.amount !== visit.amountCharged) {
                            return (
                              <>
                                <span style={{ textDecoration: 'line-through', opacity: 0.7 }}>₹{visit.amountCharged.toLocaleString('en-IN')}</span>
                                {' → Balance due: '}
                                <strong style={{ color: 'var(--success-color)' }}>₹{visit.invoice.amount.toLocaleString('en-IN')}</strong>
                              </>
                            );
                          }
                          return <>Amount: <strong>₹{visit.amountCharged.toLocaleString('en-IN')}</strong></>;
                        })()}
                      </>
                    )}
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
                <strong>{selectedService?.basePrice || 0}</strong>
              </div>
              <div>
                <span style={{ color: 'var(--text-secondary)' }}>Duration: </span>
                <strong>{selectedService?.durationMin || 30} min</strong>
              </div>
            </div>
          </div>

          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.3rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Total bill (₹)
            </label>
            <input
              type="number"
              min="0"
              defaultValue=""

              step="1"
              // value={amountCharged}
              onChange={(e) => {
                const value = e.target.value;
                const maxAmount = Number(selectedService?.basePrice || 0);


                if (value !== '' && Number(value) > maxAmount) {
                  setAmountError(`Amount cannot be more than ₹${maxAmount}`);
                } else {
                  setAmountError('');
                  setAmountCharged(value);
                }

                //  setAmountCharged(value);
                setAppliedCoupon(null);
                setPreviewBreakdown(null);
                setCouponError('');
                setBillingBreakdown(null);
              }}
              placeholder="Enter total treatment bill..."
              style={{ width: '100%', padding: '0.55rem 0.75rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, color: 'var(--text-primary)', fontSize: '0.9rem', outline: 'none' }}
            />
            {amountError && (
              <div
                style={{
                  fontSize: '0.75rem',
                  color: '#ef4444',
                  marginTop: '0.3rem'
                }}
              >
                {amountError}
              </div>
            )}

            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.3rem' }}>
              Edit the final bill (add medicines, extra services, etc.). Defaults to the service price.
            </div>
          </div>

          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.3rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Coupon code
            </label>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <input
                type="text"
                value={couponCode}
                onChange={(e) => setCouponCode(e.target.value.toUpperCase())}
                placeholder="Enter coupon code (optional)"
                disabled={applyingCoupon}
                style={{ flex: 1, padding: '0.55rem 0.75rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, color: 'var(--text-primary)', fontSize: '0.9rem', outline: 'none', textTransform: 'uppercase' }}
              />
              <button
                type="button"
                onClick={previewCoupon}
                disabled={applyingCoupon || !couponCode.trim()}
                style={{
                  padding: '0.55rem 1rem',
                  background: applyingCoupon ? 'rgba(107,114,128,0.3)' : 'var(--primary-color, var(--accent-color))',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 8,
                  cursor: applyingCoupon || !couponCode.trim() ? 'not-allowed' : 'pointer',
                  opacity: applyingCoupon || !couponCode.trim() ? 0.6 : 1,
                  fontWeight: 500,
                  whiteSpace: 'nowrap',
                }}
              >
                {applyingCoupon ? 'Applying...' : 'Apply'}
              </button>
            </div>
            {couponError && <div style={{ color: 'var(--danger-color)', fontSize: '0.8rem', marginTop: '0.35rem' }}>{couponError}</div>}
            {appliedCoupon && (
              <div style={{ color: 'var(--success-color)', fontSize: '0.8rem', marginTop: '0.35rem' }}>
                Coupon <strong>{appliedCoupon.code}</strong> applied
                {previewBreakdown && ` — discount ₹${previewBreakdown.discount.toLocaleString('en-IN')}`}
              </div>
            )}
          </div>

          {(previewBreakdown || billingBreakdown) && (
            <div style={{ marginBottom: '1rem', padding: '0.75rem', background: 'rgba(255,255,255,0.03)', borderRadius: 8, border: '1px solid rgba(255,255,255,0.08)', fontSize: '0.85rem' }}>
              <div style={{ fontWeight: 600, marginBottom: '0.5rem', color: 'var(--text-primary)' }}>Billing breakdown</div>
              {(previewBreakdown || billingBreakdown)?.baseAmount != null && (
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.25rem' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>Base amount</span>
                  <span>₹{((previewBreakdown || billingBreakdown).baseAmount).toLocaleString('en-IN')}</span>
                </div>
              )}
              {(previewBreakdown || billingBreakdown)?.discount > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.25rem', color: 'var(--success-color)' }}>
                  <span>Coupon discount</span>
                  <span>-₹{((previewBreakdown || billingBreakdown).discount).toLocaleString('en-IN')}</span>
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.5rem', paddingTop: '0.5rem', borderTop: '1px solid rgba(255,255,255,0.08)', fontWeight: 600 }}>
                <span>Balance due</span>
                <span>
                  ₹{(() => {
                    if (billingBreakdown) return billingBreakdown.balance;
                    const pd = previewBreakdown || {};
                    return pd.balance != null ? pd.balance : pd.finalAmount;
                  })().toLocaleString('en-IN')}
                </span>
              </div>
            </div>
          )}

          {consumptionRules.length > 0 && (
            <div style={{ marginBottom: '1rem', padding: '0.75rem', background: 'rgba(16, 185, 129, 0.08)', borderRadius: 8, border: '1px solid rgba(16, 185, 129, 0.2)' }}>
              <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.5rem', fontWeight: 600 }}>
                Auto-Consumption Preview
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                {consumptionRules.map((rule) => (
                  <div key={rule.id} style={{ fontSize: '0.85rem', padding: '0.4rem 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                    <div style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{rule.product?.name}</div>
                    <div style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                      Will deduct: {rule.quantityPerVisit} {rule.product?.unit || 'units'}
                      {rule.product?.volume && ` (x ${rule.product.volume}ml = ${(rule.quantityPerVisit / rule.product.volume).toFixed(2)} units)`}
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
            {submitting ? 'Marking as visited' : ' Mark as visited & consume products'}
          </button>
        </form>
      )}
    </div>
  );
}




