import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useScrollLock } from '../../../hooks/useScrollLock';
import { Crown, X, CreditCard } from 'lucide-react';
import { formatMoney } from '../../../utils/money';
import { durationLabel } from './utils';

// Razorpay checkout SDK loader — same pattern as BuyGiftCards.jsx.
// Lazy-loaded on first purchase attempt so the script isn't fetched
// for catalog browsing.
export const RAZORPAY_SDK_URL = 'https://checkout.razorpay.com/v1/checkout.js';

// eslint-disable-next-line react-refresh/only-export-components
export function loadRazorpaySdk() {
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

// Confirmation step that fronts the Razorpay checkout. The actual
// gateway handshake (order create, SDK load, checkout open, confirm
// POST) lives on the parent so this stays a thin, dismissable surface.
export function PurchaseModal({ plan, paying, onClose, onPay }) {
  useScrollLock(true);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !paying) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); };
  }, [onClose, paying]);

  return createPortal((
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Buy membership plan"
      data-testid="membership-purchase-modal"
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '1rem' }}
      onClick={(e) => { if (e.target === e.currentTarget && !paying) onClose(); }}
    >
      <div
        className="glass"
        style={{
          background: 'var(--tooltip-bg, var(--surface-color, #fff))',
          color: 'var(--text-primary, #111)',
          borderRadius: 12,
          border: '1px solid var(--border-color, rgba(0,0,0,0.08))',
          padding: '1.5rem',
          maxWidth: 460,
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          gap: '1rem',
        }}
      >
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ fontSize: '1.15rem', fontWeight: 600, margin: 0, display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
            <Crown size={18} /> Buy {plan.name}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            disabled={paying}
            style={{
              background: 'transparent', border: 'none',
              cursor: paying ? 'not-allowed' : 'pointer',
              color: 'var(--text-secondary)',
              padding: 4,
            }}
          >
            <X size={18} />
          </button>
        </header>

        <div style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          You&apos;ll pay <strong style={{ color: 'var(--text-primary)' }}>{formatMoney(plan.price, { currency: plan.currency || 'INR' })}</strong> via Razorpay. The membership activates immediately on payment success and can be applied at appointment booking.
        </div>

        <div style={{
          padding: '0.85rem 1rem',
          borderRadius: 8,
          background: 'var(--subtle-bg, rgba(0,0,0,0.04))',
          border: '1px solid var(--border-color, rgba(0,0,0,0.08))',
          fontSize: '0.85rem',
          display: 'grid',
          gap: '0.35rem',
        }}>
          <div><strong>{plan.name}</strong> <span style={{ color: 'var(--text-secondary)' }}>· {durationLabel(plan.durationDays)}</span></div>
          <div style={{ fontSize: '1.2rem', fontWeight: 600 }}>{formatMoney(plan.price, { currency: plan.currency || 'INR' })}</div>
        </div>

        <button
          type="button"
          onClick={onPay}
          disabled={paying}
          data-testid="membership-pay-now"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '0.5rem',
            background: paying ? 'rgba(99,102,241,0.4)' : 'var(--primary-color, var(--accent-color))',
            color: '#fff',
            border: 'none',
            borderRadius: 8,
            padding: '0.7rem 1rem',
            fontWeight: 600,
            cursor: paying ? 'not-allowed' : 'pointer',
            fontSize: '0.9rem',
          }}
        >
          <CreditCard size={14} />
          {paying ? 'Opening Razorpay…' : `Pay ${formatMoney(plan.price, { currency: plan.currency || 'INR' })} with Razorpay`}
        </button>
      </div>
    </div>
  ), document.body);
}
