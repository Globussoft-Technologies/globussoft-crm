import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useScrollLock } from '../../../hooks/useScrollLock';
import {
  Monitor, ChevronDown, ChevronUp,
  Pencil, Check, CreditCard, X,
} from 'lucide-react';
import { formatMoney } from '../../../utils/money';
import { durationLabel } from './utils';

export function PlanDetailModal({ plan, services, isAdmin, isOwned, onClose, onEdit, onBuy }) {
  // Refs for focus management — initialFocus captures the close button so
  // the modal opens with focus on a known element (screen readers announce
  // the dialog correctly), and dialogRef + the keydown handler below
  // implement a basic Tab/Shift+Tab focus trap so keyboard users can't
  // accidentally tab out of the modal back to the page underneath.
  const dialogRef = useRef(null);
  const initialFocusRef = useRef(null);
  const titleId = useMemo(() => `plan-detail-title-${Math.random().toString(36).slice(2, 9)}`, []);

  const entitlements = useMemo(() => {
    try {
      const parsed = JSON.parse(plan.entitlements || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }, [plan.entitlements]);

  // Group entitlements by service category so the "Categories" accordion
  // renders one row per category (with the summed quantity). When the
  // service catalog hasn't been loaded yet the category is unknown — we
  // bucket those under "Other" rather than dropping them silently.
  const categoryRows = useMemo(() => {
    const buckets = new Map();
    for (const e of entitlements) {
      const svc = services.find((s) => s.id === e.serviceId);
      const cat = (svc?.category || svc?.serviceCategory?.name || 'Other').toString();
      const prev = buckets.get(cat) || 0;
      buckets.set(cat, prev + (Number(e.quantity) || 0));
    }
    return Array.from(buckets.entries()).map(([category, count]) => ({ category, count }));
  }, [entitlements, services]);

  const totalEntitlementCount = entitlements.reduce(
    (sum, e) => sum + (Number(e.quantity) || 0),
    0,
  );

  // "Credit frequency in months" derived from durationDays so the row
  // stays meaningful even though the schema doesn't carry a dedicated
  // column for it. Rounded to 2 decimals like the design.
  const creditFrequencyMonths = plan.durationDays
    ? (plan.durationDays / 30).toFixed(plan.durationDays % 30 === 0 ? 0 : 2)
    : '—';

  const [openSection, setOpenSection] = useState({ services: true, categories: true });
  const toggle = (k) => setOpenSection((s) => ({ ...s, [k]: !s[k] }));

  useEffect(() => {
    const focusable = () => {
      if (!dialogRef.current) return [];
      return Array.from(
        dialogRef.current.querySelectorAll(
          'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key === 'Tab') {
        // Focus trap — wrap Tab/Shift+Tab around the dialog's focusables.
        const els = focusable();
        if (els.length === 0) return;
        const first = els[0];
        const last = els[els.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    // Move focus into the modal on open — close button is the safest
    // initial target (always visible, doesn't trigger side-effects on
    // accidental activation by assistive tech).
    setTimeout(() => { initialFocusRef.current?.focus(); }, 0);
    return () => { document.removeEventListener('keydown', onKey); };
  }, [onClose]);
  useScrollLock(true);

  const serviceName = (id) => services.find((s) => s.id === id)?.name || `Service #${id}`;

  return createPortal((
    <div
      style={{ position: 'fixed', inset: 0, background: 'var(--overlay-bg, rgba(0,0,0,0.45))', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '1rem' }}
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{
          maxWidth: 540, width: '100%', maxHeight: '92vh', overflow: 'auto',
          borderRadius: 14, position: 'relative',
          // Theme-aware surface: --tooltip-bg is the canonical near-solid popover
          // surface (dark navy in dark mode, near-white in light mode), so the
          // modal stays legible against the page underneath in both themes.
          background: 'var(--tooltip-bg, #fff)',
          color: 'var(--text-primary, #111)',
          border: '1px solid var(--border-color, rgba(0,0,0,0.08))',
          boxShadow: '0 25px 50px rgba(0,0,0,0.35)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <button ref={initialFocusRef} onClick={onClose} aria-label="Close membership details" style={{ position: 'absolute', top: 14, right: 14, background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', display: 'flex', zIndex: 2 }}>
          <X size={20} />
        </button>

        <div style={{ padding: '1.5rem 1.5rem 1rem' }}>
          {/* Plan header — monitor pill, name, price */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', color: 'var(--text-secondary)', fontSize: '0.95rem', marginTop: '0.25rem' }}>
            <Monitor size={18} /> {durationLabel(plan.durationDays)}
          </div>
          <h2 id={titleId} style={{ fontSize: '1.45rem', fontWeight: 600, marginTop: '0.75rem', textTransform: 'capitalize' }}>{plan.name}</h2>
          <div style={{ fontSize: '1.25rem', fontWeight: 600, marginTop: '0.35rem' }}>{formatMoney(plan.price, { currency: plan.currency || 'INR' })}</div>
        </div>

        <div style={{ height: 1, background: 'var(--border-color)', margin: '0 1.5rem' }} />

        {/* Prepaid Card section. Fields the schema doesn't have yet are
            derived sensibly — Promotional Money = price, Credit Amount
            blank, Tax static GST 5%. If you want literal columns wire
            them through MembershipPlan + the POST/PUT routes later. */}
        <div style={{ padding: '1.25rem 1.5rem' }}>
          <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.75rem' }}>Prepaid Card</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem' }}>
            <CardRow label="Promotional Money" value={formatMoney(plan.price, { currency: plan.currency || 'INR' })} />
            <CardRow
              label="Credit Amount"
              value={plan.description && /credit[:\s]*[₹]?\s*[\d,]+/i.test(plan.description)
                ? plan.description.match(/credit[:\s]*([₹]?\s*[\d,]+(?:\.\d+)?)/i)[1]
                : '—'}
            />
            <CardRow label="Credit Frequency(Month)" value={creditFrequencyMonths} />
            <CardRow label="Tax" value="GST 5% (included in price)" />
          </div>
        </div>

        {/* Services accordion */}
        <Accordion
          label="Services"
          open={openSection.services}
          onToggle={() => toggle('services')}
        >
          {entitlements.length === 0 ? (
            <RowEmpty>No service entitlements configured.</RowEmpty>
          ) : (
            <>
              <PlanRow
                title="All Services"
                trailingLabel="Total"
                trailingValue={`${totalEntitlementCount} uses`}
              />
              {entitlements.map((e, i) => (
                <PlanRow
                  key={i}
                  title={serviceName(e.serviceId)}
                  trailingLabel="Allotted"
                  trailingValue={`${e.quantity}`}
                />
              ))}
            </>
          )}
        </Accordion>

        {/* Categories accordion */}
        <Accordion
          label="Categories"
          open={openSection.categories}
          onToggle={() => toggle('categories')}
        >
          {categoryRows.length === 0 ? (
            <RowEmpty>No categories configured.</RowEmpty>
          ) : (
            categoryRows.map((c) => (
              <PlanRow
                key={c.category}
                title={c.category}
                trailingLabel="Allotted"
                trailingValue={`${c.count}`}
              />
            ))
          )}
        </Accordion>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', padding: '0 1.5rem 1.25rem' }}>
          <button
            onClick={onClose}
            style={{
              padding: '0.5rem 1rem',
              borderRadius: 8,
              border: '1px solid var(--border-color)',
              background: 'transparent',
              color: 'var(--text-primary)',
              cursor: 'pointer',
              fontSize: '0.85rem',
            }}
          >
            Close
          </button>
          {/* Role-aware primary CTA — admins/managers edit the plan; users
              buy it (Razorpay handshake). The primary button uses theme
              accent colors instead of hardcoded #111/#fff so it renders
              correctly in both light + dark mode. */}
          {isAdmin ? (
            <button
              onClick={onEdit}
              style={{
                padding: '0.5rem 1rem',
                borderRadius: 8,
                border: 'none',
                background: 'var(--primary-color, var(--accent-color))',
                color: '#fff',
                cursor: 'pointer',
                fontSize: '0.85rem',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.35rem',
                fontWeight: 600,
              }}
            >
              <Pencil size={14} /> Edit plan
            </button>
          ) : isOwned ? (
            <span
              title="You own this plan"
              style={{
                padding: '0.5rem 1rem',
                borderRadius: 8,
                border: '1px solid var(--border-color)',
                background: 'var(--subtle-bg)',
                color: 'var(--text-primary)',
                fontSize: '0.85rem',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.35rem',
                fontWeight: 600,
              }}
            >
              <Check size={14} /> Owned
            </span>
          ) : (
            <button
              onClick={onBuy}
              style={{
                padding: '0.5rem 1rem',
                borderRadius: 8,
                border: 'none',
                background: 'var(--primary-color, var(--accent-color))',
                color: '#fff',
                cursor: 'pointer',
                fontSize: '0.85rem',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.35rem',
                fontWeight: 600,
              }}
            >
              <CreditCard size={14} /> Buy plan
            </button>
          )}
        </div>
      </div>
    </div>
  ), document.body);
}

function CardRow({ label, value }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.9rem' }}>
      <span style={{ color: 'var(--text-secondary)' }}>{label} :</span>
      <strong style={{ color: 'var(--text-primary)' }}>{value}</strong>
    </div>
  );
}

function Accordion({ label, open, onToggle, children }) {
  return (
    <div style={{ borderTop: '1px solid var(--border-color)' }}>
      <button
        type="button"
        onClick={onToggle}
        style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.85rem 1.5rem', background: 'transparent', border: 'none', color: 'var(--text-primary)', cursor: 'pointer', fontSize: '0.95rem', fontWeight: 600 }}
      >
        <span>{label}</span>
        {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>
      {open && (
        <div style={{ padding: '0 1rem 0.75rem' }}>
          {children}
        </div>
      )}
    </div>
  );
}

function PlanRow({ title, trailingLabel, trailingValue }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.75rem 0.85rem', borderRadius: 10, background: 'var(--subtle-bg)', marginBottom: '0.5rem' }}>
      <div style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--text-primary)' }}>{title}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.55rem' }}>
        <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{trailingLabel}</span>
        <span style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-primary)' }}>{trailingValue}</span>
      </div>
    </div>
  );
}

function RowEmpty({ children }) {
  return <div style={{ padding: '0.6rem 0.85rem', color: 'var(--text-secondary)', fontSize: '0.85rem', fontStyle: 'italic' }}>{children}</div>;
}
