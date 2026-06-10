/**
 * Customer-facing gift-card storefront. Any authenticated tenant user can
 * browse the active catalogue (admin-issued cards with `price` set but
 * no recipient yet) and buy one — the value lands on the chosen
 * patient's wallet via the same Razorpay handshake Invoices.jsx "Pay Now"
 * uses (create-order → checkout modal → confirm).
 *
 * Flow:
 *   1.  GET /api/wellness/giftcards/storefront                     — catalogue
 *   2.  User picks a card → modal opens, asks for patient (phone lookup
 *       against /api/wellness/patients).
 *   3.  POST /api/wellness/giftcards/:id/purchase/order            — creates
 *       Razorpay order + a PENDING Payment row. Returns key + orderId +
 *       paymentId.
 *   4.  Razorpay checkout modal opens.
 *   5.  POST /api/wellness/giftcards/:id/purchase/confirm          — verifies
 *       signature, marks card redeemed, credits the patient's wallet by
 *       the card's `amount` (gift value, distinct from `price` the buyer
 *       paid).
 */

import { useContext, useEffect, useState } from 'react';
import { ShoppingBag, Gift, CreditCard, Search, X, User } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { formatMoney } from '../../utils/money';
import { AuthContext } from '../../App';

const RAZORPAY_SDK_URL = 'https://checkout.razorpay.com/v1/checkout.js';

function loadRazorpaySdk() {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined') return reject(new Error('No window'));
    if (window.Razorpay) return resolve(window.Razorpay);
    const existing = document.querySelector(`script[src="${RAZORPAY_SDK_URL}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve(window.Razorpay));
      existing.addEventListener('error', () => reject(new Error('Razorpay SDK failed to load')));
      return;
    }
    const script = document.createElement('script');
    script.src = RAZORPAY_SDK_URL;
    script.async = true;
    script.onload = () => resolve(window.Razorpay);
    script.onerror = () => reject(new Error('Razorpay SDK failed to load'));
    document.body.appendChild(script);
  });
}

export default function BuyGiftCardsPage() {
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const myName = user?.name || user?.email || 'me';
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null); // gift card chosen for purchase
  // Recipient mode: false = buy for myself (default — credit lands on the
  // signed-in user's own wallet, no patient picker shown); true = gift the
  // card to another patient (reveals the directory typeahead).
  const [giftMode, setGiftMode] = useState(false);
  const [patientQuery, setPatientQuery] = useState('');
  const [patientResults, setPatientResults] = useState([]);
  const [patientSearching, setPatientSearching] = useState(false);
  const [recipient, setRecipient] = useState(null); // resolved patient (gift mode)
  const [paying, setPaying] = useState(false);
  const [successCard, setSuccessCard] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const j = await fetchApi('/api/wellness/giftcards/storefront');
      setList(Array.isArray(j?.giftCards) ? j.giftCards : []);
    } catch (e) {
      notify.error(e?.message || 'Failed to load gift cards');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // Debounced patient lookup — by phone (last-10) or name. Mirrors the
  // typeahead pattern PatientPicker uses elsewhere; kept inline so this
  // page has zero extra imports beyond the shared utilities.
  useEffect(() => {
    if (!selected || !giftMode) return undefined;
    const q = patientQuery.trim();
    if (q.length < 2) {
      setPatientResults([]);
      return undefined;
    }
    let alive = true;
    setPatientSearching(true);
    const handle = setTimeout(async () => {
      try {
        const j = await fetchApi(`/api/wellness/patients?search=${encodeURIComponent(q)}&limit=8`);
        if (!alive) return;
        const rows = Array.isArray(j?.patients) ? j.patients : Array.isArray(j) ? j : [];
        setPatientResults(rows);
      } catch {
        if (alive) setPatientResults([]);
      } finally {
        if (alive) setPatientSearching(false);
      }
    }, 250);
    return () => { alive = false; clearTimeout(handle); };
  }, [patientQuery, selected, giftMode]);

  const openPurchase = (card) => {
    setSelected(card);
    setGiftMode(false);
    setRecipient(null);
    setPatientQuery('');
    setPatientResults([]);
  };

  const closePurchase = () => {
    if (paying) return;
    setSelected(null);
    setGiftMode(false);
    setRecipient(null);
    setPatientQuery('');
    setPatientResults([]);
  };

  const startPayment = async () => {
    // In gift mode a recipient must be chosen; in self mode the backend
    // resolves the signed-in user's own patient, so no recipient is needed.
    if (!selected || paying || (giftMode && !recipient)) return;
    setPaying(true);
    try {
      const order = await fetchApi(
        `/api/wellness/giftcards/${selected.id}/purchase/order`,
        {
          method: 'POST',
          // Omit patientId when buying for myself — the server credits my
          // own wallet. Send it only when gifting to another patient.
          body: JSON.stringify(giftMode ? { patientId: recipient.id } : {}),
        },
      );
      // Who the credit lands on, for the prefill + success copy. Self mode
      // uses the server-resolved patientName (falls back to my display name).
      const recipientName = giftMode
        ? recipient.name
        : order?.patientName || myName;
      const recipientPhone = giftMode ? recipient.phone || '' : user?.phone || '';
      if (!order?.orderId || !order?.paymentId || !order?.key) {
        throw new Error(order?.error || 'Failed to create payment order');
      }

      let Razorpay;
      try {
        Razorpay = await loadRazorpaySdk();
      } catch (sdkErr) {
        throw new Error(sdkErr.message || 'Razorpay SDK failed to load');
      }

      await new Promise((resolve) => {
        const options = {
          key: order.key,
          order_id: order.orderId,
          amount: order.amount,
          currency: order.currency,
          name: 'Gift Card Purchase',
          description: selected.name || `Gift card #${selected.id}`,
          prefill: {
            name: recipientName || '',
            contact: recipientPhone || '',
          },
          theme: { color: selected.color || '#6366f1' },
          handler: async (response) => {
            try {
              const confirm = await fetchApi(
                `/api/wellness/giftcards/${selected.id}/purchase/confirm`,
                {
                  method: 'POST',
                  body: JSON.stringify({
                    paymentId: order.paymentId,
                    razorpay_order_id: response.razorpay_order_id,
                    razorpay_payment_id: response.razorpay_payment_id,
                    razorpay_signature: response.razorpay_signature,
                  }),
                },
              );
              if (confirm?.success) {
                const where = giftMode ? `${recipientName}'s wallet` : 'your wallet';
                notify.success(
                  `Payment successful! ${formatMoney(selected.amount, { currency: selected.currency })} credited to ${where}.`,
                );
                setSuccessCard({ card: selected, recipientName, forSelf: !giftMode });
                setSelected(null);
                setGiftMode(false);
                setRecipient(null);
                setPatientQuery('');
                setPatientResults([]);
                await load();
              } else {
                notify.error(confirm?.error || 'Payment verification failed');
              }
            } catch (err) {
              notify.error(err?.message || 'Payment verification failed');
            } finally {
              setPaying(false);
              resolve();
            }
          },
          modal: {
            ondismiss: () => {
              setPaying(false);
              resolve();
            },
          },
        };
        const rzp = new Razorpay(options);
        rzp.open();
      });
    } catch (err) {
      notify.error(err?.message || 'Failed to start payment');
      setPaying(false);
    }
  };

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ fontSize: '1.75rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <ShoppingBag size={24} /> Buy Gift Cards
        </h1>
        <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
          Browse available gift cards and pay via Razorpay. The gift value is credited to the chosen patient's wallet on payment success.
        </p>
      </header>

      {successCard && (
        <div
          className="glass"
          data-testid="buy-giftcard-success"
          style={{
            padding: '1rem',
            marginBottom: '1rem',
            background: 'rgba(16,185,129,0.12)',
            border: '1px solid rgba(16,185,129,0.35)',
            borderRadius: 8,
            color: 'var(--text-primary)',
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem',
            flexWrap: 'wrap',
          }}
        >
          <strong>Payment received.</strong>
          <span>
            {formatMoney(successCard.card.amount, { currency: successCard.card.currency })} credited to {successCard.forSelf ? 'your wallet' : `${successCard.recipientName}'s wallet`}.
          </span>
          <button
            type="button"
            onClick={() => setSuccessCard(null)}
            aria-label="Dismiss"
            style={{
              marginLeft: 'auto',
              background: 'transparent',
              border: '1px solid var(--border-color)',
              borderRadius: 6,
              padding: '0.3rem 0.5rem',
              cursor: 'pointer',
              color: 'var(--text-primary)',
            }}
          >
            <X size={12} />
          </button>
        </div>
      )}

      {loading ? (
        <div data-testid="buy-giftcard-loading">Loading…</div>
      ) : list.length === 0 ? (
        <div
          data-testid="buy-giftcard-empty"
          style={{ color: 'var(--text-secondary)', padding: '2rem 0' }}
        >
          No gift cards are available for purchase right now. Please check back later.
        </div>
      ) : (
        <div
          data-testid="buy-giftcard-grid"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))',
            gap: '1rem',
          }}
        >
          {list.map((card) => (
            <article
              key={card.id}
              data-testid={`buy-giftcard-card-${card.id}`}
              className="glass"
              style={{
                padding: '1.25rem',
                borderRadius: 12,
                border: '1px solid var(--border-color)',
                background: 'var(--surface-color)',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.5rem',
              }}
            >
              <div
                style={{
                  height: 8,
                  borderRadius: 4,
                  background: card.color || 'var(--primary-color, var(--accent-color))',
                }}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <Gift size={16} aria-hidden="true" />
                <strong style={{ fontSize: '1.05rem' }}>
                  {card.name || 'Gift card'}
                </strong>
              </div>
              <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                Wallet credit:{' '}
                <strong style={{ color: 'var(--text-primary)' }}>
                  {formatMoney(card.amount, { currency: card.currency })}
                </strong>
              </div>
              {card.validityDays && (
                <div style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                  Valid for {card.validityDays} days after redemption.
                </div>
              )}
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 'auto', paddingTop: '0.75rem' }}>
                <div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Price</div>
                  <div style={{ fontSize: '1.25rem', fontWeight: 600 }}>
                    {formatMoney(card.price, { currency: card.currency })}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => openPurchase(card)}
                  data-testid={`buy-giftcard-buy-${card.id}`}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.4rem',
                    background: 'var(--primary-color, var(--accent-color))',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 8,
                    padding: '0.55rem 1rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  <CreditCard size={14} /> Buy
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      {selected && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Buy gift card"
          data-testid="buy-giftcard-modal"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '1rem',
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) closePurchase();
          }}
        >
          <div
            className="glass"
            style={{
              background: 'var(--surface-color)',
              borderRadius: 12,
              border: '1px solid var(--border-color)',
              padding: '1.5rem',
              maxWidth: 480,
              width: '100%',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.85rem',
            }}
          >
            <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2 style={{ fontSize: '1.15rem', fontWeight: 600, margin: 0 }}>
                Buy {selected.name || 'gift card'}
              </h2>
              <button
                type="button"
                onClick={closePurchase}
                aria-label="Close"
                disabled={paying}
                style={{
                  background: 'transparent',
                  border: 'none',
                  cursor: paying ? 'not-allowed' : 'pointer',
                  color: 'var(--text-secondary)',
                  padding: 4,
                }}
              >
                <X size={18} />
              </button>
            </header>

            <div style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
              You'll pay <strong style={{ color: 'var(--text-primary)' }}>
                {formatMoney(selected.price, { currency: selected.currency })}
              </strong>. The wallet credit of{' '}
              <strong style={{ color: 'var(--text-primary)' }}>
                {formatMoney(selected.amount, { currency: selected.currency })}
              </strong>{' '}
              {giftMode
                ? 'lands on the patient you choose below.'
                : 'will be added to your wallet.'}
            </div>

            {/* Recipient mode — buy for myself (default) or gift to someone
                else. Choosing "gift" reveals the patient directory picker. */}
            <div
              role="radiogroup"
              aria-label="Who is this gift card for?"
              style={{ display: 'flex', gap: '0.5rem' }}
            >
              <button
                type="button"
                role="radio"
                aria-checked={!giftMode}
                data-testid="buy-giftcard-recipient-self"
                disabled={paying}
                onClick={() => {
                  setGiftMode(false);
                  setRecipient(null);
                  setPatientQuery('');
                  setPatientResults([]);
                }}
                style={{
                  flex: 1,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '0.4rem',
                  padding: '0.5rem 0.6rem',
                  borderRadius: 8,
                  fontWeight: 600,
                  fontSize: '0.85rem',
                  cursor: paying ? 'not-allowed' : 'pointer',
                  border: `1px solid ${!giftMode ? 'var(--primary-color, var(--accent-color))' : 'var(--border-color)'}`,
                  background: !giftMode ? 'var(--primary-color, var(--accent-color))' : 'transparent',
                  color: !giftMode ? '#fff' : 'var(--text-secondary)',
                }}
              >
                <User size={14} /> For myself
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={giftMode}
                data-testid="buy-giftcard-recipient-gift"
                disabled={paying}
                onClick={() => setGiftMode(true)}
                style={{
                  flex: 1,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '0.4rem',
                  padding: '0.5rem 0.6rem',
                  borderRadius: 8,
                  fontWeight: 600,
                  fontSize: '0.85rem',
                  cursor: paying ? 'not-allowed' : 'pointer',
                  border: `1px solid ${giftMode ? 'var(--primary-color, var(--accent-color))' : 'var(--border-color)'}`,
                  background: giftMode ? 'var(--primary-color, var(--accent-color))' : 'transparent',
                  color: giftMode ? '#fff' : 'var(--text-secondary)',
                }}
              >
                <Gift size={14} /> Gift to someone else
              </button>
            </div>

            {!giftMode && (
              <div
                data-testid="buy-giftcard-self-chip"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  padding: '0.5rem 0.75rem',
                  borderRadius: 8,
                  border: '1px solid var(--border-color)',
                  background: 'rgba(16,185,129,0.10)',
                }}
              >
                <User size={14} aria-hidden="true" />
                <span>
                  Credit goes to <strong>{myName}</strong> (you).
                </span>
              </div>
            )}

            {giftMode && (
            <>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
              <span style={{ fontSize: '0.85rem', fontWeight: 500 }}>Patient (phone or name)</span>
              <div style={{ position: 'relative' }}>
                <Search
                  size={14}
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    left: 10,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    color: 'var(--text-secondary)',
                  }}
                />
                <input
                  type="search"
                  value={patientQuery}
                  onChange={(e) => {
                    setPatientQuery(e.target.value);
                    setRecipient(null);
                  }}
                  placeholder="e.g. 9876543210"
                  data-testid="buy-giftcard-patient-input"
                  autoFocus
                  disabled={paying}
                  style={{
                    width: '100%',
                    padding: '0.55rem 0.6rem 0.55rem 2rem',
                    borderRadius: 8,
                    border: '1px solid var(--border-color)',
                    background: 'var(--bg-color)',
                    color: 'var(--text-primary)',
                  }}
                />
              </div>
            </label>

            {recipient ? (
              <div
                data-testid="buy-giftcard-recipient-chip"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  padding: '0.5rem 0.75rem',
                  borderRadius: 8,
                  border: '1px solid var(--border-color)',
                  background: 'rgba(16,185,129,0.10)',
                }}
              >
                <strong>{recipient.name}</strong>
                <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                  {recipient.phone || recipient.email || `id ${recipient.id}`}
                </span>
                <button
                  type="button"
                  onClick={() => { setRecipient(null); setPatientQuery(''); }}
                  disabled={paying}
                  aria-label="Change patient"
                  style={{
                    marginLeft: 'auto',
                    background: 'transparent',
                    border: '1px solid var(--border-color)',
                    borderRadius: 6,
                    padding: '0.2rem 0.4rem',
                    cursor: paying ? 'not-allowed' : 'pointer',
                    color: 'var(--text-primary)',
                    fontSize: '0.75rem',
                  }}
                >
                  Change
                </button>
              </div>
            ) : patientQuery.trim().length >= 2 ? (
              <div
                data-testid="buy-giftcard-patient-results"
                style={{
                  border: '1px solid var(--border-color)',
                  borderRadius: 8,
                  maxHeight: 180,
                  overflowY: 'auto',
                  background: 'var(--bg-color)',
                }}
              >
                {patientSearching ? (
                  <div style={{ padding: '0.5rem 0.75rem', color: 'var(--text-secondary)' }}>
                    Searching…
                  </div>
                ) : patientResults.length === 0 ? (
                  <div style={{ padding: '0.5rem 0.75rem', color: 'var(--text-secondary)' }}>
                    No patient found.
                  </div>
                ) : (
                  patientResults.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setRecipient(p)}
                      data-testid={`buy-giftcard-patient-option-${p.id}`}
                      style={{
                        display: 'block',
                        width: '100%',
                        textAlign: 'left',
                        padding: '0.55rem 0.75rem',
                        background: 'transparent',
                        border: 'none',
                        borderBottom: '1px solid var(--border-color)',
                        cursor: 'pointer',
                        color: 'var(--text-primary)',
                      }}
                    >
                      <strong>{p.name}</strong>
                      {p.phone && (
                        <span style={{ marginLeft: 8, color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                          {p.phone}
                        </span>
                      )}
                    </button>
                  ))
                )}
              </div>
            ) : null}
            </>
            )}

            <button
              type="button"
              onClick={startPayment}
              disabled={paying || (giftMode && !recipient)}
              data-testid="buy-giftcard-pay-now"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.5rem',
                background: paying || (giftMode && !recipient)
                  ? 'rgba(99,102,241,0.4)'
                  : 'var(--primary-color, var(--accent-color))',
                color: '#fff',
                border: 'none',
                borderRadius: 8,
                padding: '0.7rem 1rem',
                fontWeight: 600,
                cursor: paying || (giftMode && !recipient) ? 'not-allowed' : 'pointer',
              }}
            >
              <CreditCard size={14} />
              {paying
                ? 'Opening Razorpay…'
                : `Pay ${formatMoney(selected.price, { currency: selected.currency })} with Razorpay`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
