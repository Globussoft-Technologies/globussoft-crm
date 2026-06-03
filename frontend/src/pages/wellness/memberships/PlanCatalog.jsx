import { useMemo } from 'react';
import {
  Monitor, MoreVertical, Pencil, Trash2, Power, Check,
  Sparkles, RefreshCcw, CreditCard,
} from 'lucide-react';
import { formatDate } from '../../utils/date';
import { formatMoney } from '../../utils/money';
import { planGradient, deriveBenefits, durationLabel } from './utils';

export function PlanCard({
  plan, services = [], isAdmin, isOwned, menuOpen, onToggleMenu,
  onView, onEdit, onDelete, onDeactivate, onBuy,
}) {
  const gradient = planGradient(plan);
  const isActive = plan.isActive !== false;
  // Top-3 benefits derived from the entitlements JSON. Memoised so the
  // sort+resolve doesn't re-run on every parent re-render (the catalog
  // can have dozens of cards on screen).
  const benefits = useMemo(() => deriveBenefits(plan, services, 3), [plan, services]);
  const isFeatured = plan.featured === true || plan.isFeatured === true;

  // Three-state ownership for the non-admin view. Backend annotates
  // /membership-plans with hasActiveMembership / hasExpiredMembership /
  // activeMembershipEndDate when the caller has a Patient row. Cancelled
  // memberships surface as hasExpiredMembership=true per the 2026-06
  // lifecycle decision (cancelled → re-purchase allowed, same as expired).
  // Fallback to the isOwned flag (driven by /appointments/my-memberships)
  // keeps the rendering sane when an older backend returns the legacy
  // un-annotated shape; in that case we degrade to state 2 (active).
  // Admins always see the catalog view — no per-user state.
  const ownershipState = (() => {
    if (isAdmin) return 'never';
    if (plan.hasActiveMembership === true) return 'active';
    if (plan.hasExpiredMembership === true) return 'expired';
    if (plan.hasActiveMembership === undefined && isOwned) return 'active';
    return 'never';
  })();
  return (
    <div
      role="article"
      aria-label={`Membership plan: ${plan.name}`}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onView(); }
      }}
      style={{
        position: 'relative',
        borderRadius: 16,
        padding: '1.25rem 1.25rem 1rem',
        minHeight: 160,
        color: '#fff',
        background: gradient,
        boxShadow: '0 8px 20px rgba(0,0,0,0.25)',
        overflow: 'hidden',
        opacity: isActive ? 1 : 0.6,
        cursor: 'pointer',
        outline: 'none',
      }}
      onClick={onView}
    >
      {/* Featured badge — top-right, mutually exclusive with the menu so
          only one ornament sits in that corner. Hidden on cards the admin
          can edit (the menu wins). Reads from plan.featured if the column
          exists; harmless when the column hasn't been added yet. */}
      {isFeatured && !isAdmin && (
        <div
          style={{
            position: 'absolute', top: 10, right: 10, zIndex: 2,
            display: 'inline-flex', alignItems: 'center', gap: '0.25rem',
            padding: '0.2rem 0.55rem',
            background: 'rgba(255,255,255,0.95)',
            color: '#9a6b00',
            borderRadius: 999,
            fontSize: '0.65rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
            boxShadow: '0 4px 10px rgba(0,0,0,0.2)',
          }}
        >
          <Sparkles size={11} /> Featured
        </div>
      )}
      {/* Diagonal ribbon — top-left. Label + colour reflect the three-state
          ownership semantics on the non-admin view:
            never  → "Active"     (green) — catalog availability cue
            active → "Purchased"  (primary) — user already owns it
            expired→ "Expired"    (grey)    — user owned previously, can renew
          Admin views always show catalog "Active" since per-user state is
          not meaningful in catalog-management mode. */}
      {(isActive || (!isAdmin && ownershipState !== 'never')) && (
        <div
          style={{
            position: 'absolute', top: 0, left: 0, width: 90, height: 90,
            pointerEvents: 'none', overflow: 'hidden',
          }}
        >
          <div style={{
            position: 'absolute', top: 12, left: -28, width: 110,
            transform: 'rotate(-45deg)', transformOrigin: 'center',
            background:
              (!isAdmin && ownershipState === 'active')  ? 'var(--primary-color, var(--accent-color))'
              : (!isAdmin && ownershipState === 'expired') ? '#6b7280'
              : '#16a34a',
            color: '#fff', fontSize: '0.65rem',
            fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase',
            padding: '3px 0', textAlign: 'center',
            boxShadow: '0 2px 6px rgba(0,0,0,0.2)',
          }}>
            {(!isAdmin && ownershipState === 'active')  ? 'Purchased'
              : (!isAdmin && ownershipState === 'expired') ? 'Expired'
              : 'Active'}
          </div>
        </div>
      )}

      {/* Three-dot menu — admin-only. Stops event propagation so the card's
          onClick (View) doesn't fire when the menu is being operated. */}
      {isAdmin && (
        <div style={{ position: 'absolute', top: 10, right: 10, zIndex: 2 }} onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            aria-label="Plan actions"
            onClick={onToggleMenu}
            style={{ background: 'rgba(0,0,0,0.25)', border: '1px solid rgba(255,255,255,0.22)', color: '#fff', borderRadius: 6, padding: '0.25rem', cursor: 'pointer', display: 'flex' }}
          >
            <MoreVertical size={16} />
          </button>
          {menuOpen && (
            <div
              role="menu"
              style={{
                position: 'absolute', top: '110%', right: 0,
                background: '#fff', color: '#111', minWidth: 160,
                borderRadius: 10, padding: '0.4rem 0',
                boxShadow: '0 14px 32px rgba(0,0,0,0.3)',
                zIndex: 3,
              }}
            >
              <MenuItem icon={<Pencil size={14} />} label="Edit" onClick={onEdit} />
              <MenuItem icon={<Trash2 size={14} />} label="Delete" onClick={onDelete} danger />
              <MenuItem
                icon={<Power size={14} />}
                label={isActive ? 'Deactivate' : 'Activate'}
                onClick={onDeactivate}
                danger={isActive}
              />
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem', opacity: 0.95, marginLeft: isActive ? 64 : 0 }}>
        <Monitor size={14} /> {durationLabel(plan.durationDays)}
      </div>

      <div style={{ marginTop: '2.5rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
        <h3 style={{ fontSize: '1.35rem', fontWeight: 600, textTransform: 'capitalize' }}>{plan.name}</h3>
        <div style={{ fontSize: '0.95rem', fontWeight: 500 }}>{formatMoney(plan.price, { currency: plan.currency || 'INR' })}</div>
        {/* Short description — single line, fade-truncated. Hidden on
            entitlement-only plans so the card stays clean. */}
        {plan.description && (
          <div
            style={{
              fontSize: '0.78rem', opacity: 0.85, marginTop: '0.15rem',
              display: '-webkit-box', WebkitBoxOrient: 'vertical',
              WebkitLineClamp: 1, overflow: 'hidden', textOverflow: 'ellipsis',
            }}
          >
            {plan.description}
          </div>
        )}
      </div>

      {/* Up to 3 derived benefits — "Facial × 10" / "Hair Spa × 5" etc.
          Surfaces the most generous entitlements without forcing the user
          to open the detail modal. Falls back silently when entitlements
          haven't loaded or the services catalog isn't ready. */}
      {benefits.length > 0 && (
        <ul
          aria-label="Plan benefits"
          style={{
            margin: '0.6rem 0 0', padding: 0, listStyle: 'none',
            display: 'flex', flexDirection: 'column', gap: '0.2rem',
          }}
        >
          {benefits.map((b, i) => (
            <li
              key={i}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '0.35rem',
                fontSize: '0.78rem', opacity: 0.92,
              }}
            >
              <Check size={12} aria-hidden="true" />
              <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {b.name}{b.qty > 0 ? ` × ${b.qty}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* Footer action row. Admins only see "View Details" since picking a
          plan isn't meaningful for them. Non-admin viewers see one of three
          CTAs based on the three-state ownership semantics:
            never   → "Join Now"            (existing purchase flow)
            active  → "Active Until <date>" (disabled, with helper text)
            expired → "Renew Membership"    (re-enters purchase flow)
          The Renew CTA uses the same onBuy hook — the backend already
          treats a second purchase against the same plan as a renewal
          (emits `membership.renewed`), so no separate renew endpoint is
          required to wire this up. */}
      <div
        style={{ marginTop: '0.5rem', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '0.75rem' }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onView}
          style={{
            background: 'transparent', border: 'none', color: '#fff',
            fontSize: '0.85rem', cursor: 'pointer',
            textDecoration: 'underline', textUnderlineOffset: '3px', padding: 0,
          }}
        >
          View Details
        </button>
        {!isAdmin && ownershipState === 'active' && (
          <span
            // role=button + aria-disabled communicates the disabled-CTA
            // semantics to screen readers without using a real <button
            // disabled> which would block keyboard focus on the helper
            // text affordance.
            role="button"
            aria-disabled="true"
            title="You already have an active membership for this plan"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '0.35rem',
              padding: '0.4rem 0.85rem',
              background: 'rgba(255,255,255,0.92)',
              color: '#111', borderRadius: 8,
              fontSize: '0.8rem', fontWeight: 600,
              cursor: 'not-allowed',
              opacity: 0.95,
            }}
          >
            <Check size={13} />
            {plan.activeMembershipEndDate
              ? `Active Until ${formatDate(plan.activeMembershipEndDate)}`
              : 'Purchased'}
          </span>
        )}
        {!isAdmin && ownershipState === 'expired' && (
          <button
            type="button"
            onClick={onBuy}
            aria-label={`Renew ${plan.name}`}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '0.35rem',
              padding: '0.4rem 0.85rem',
              background: 'rgba(255,255,255,0.92)',
              color: '#111',
              border: 'none',
              borderRadius: 8,
              cursor: 'pointer', fontSize: '0.8rem', fontWeight: 600,
            }}
          >
            <RefreshCcw size={13} /> Renew Membership
          </button>
        )}
        {!isAdmin && ownershipState === 'never' && (
          <button
            type="button"
            onClick={onBuy}
            aria-label={`Join ${plan.name}`}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '0.35rem',
              padding: '0.4rem 0.85rem',
              background: 'rgba(0,0,0,0.35)',
              color: '#fff',
              border: '1px solid rgba(255,255,255,0.35)',
              borderRadius: 8,
              cursor: 'pointer', fontSize: '0.8rem', fontWeight: 600,
            }}
          >
            <CreditCard size={13} /> Join Now
          </button>
        )}
      </div>

      {/* Helper text — visible only in State 2 (active membership), placed
          below the action row in muted white so users immediately know
          why the CTA is disabled and what to expect at expiry. Kept
          inside the card so the explanation travels with the surface
          (no tooltip / no separate panel). */}
      {!isAdmin && ownershipState === 'active' && (
        <p
          style={{
            margin: '0.55rem 0 0',
            fontSize: '0.72rem',
            lineHeight: 1.4,
            color: 'rgba(255,255,255,0.78)',
          }}
        >
          You already have an active membership for this plan. You can renew
          after your current membership expires.
        </p>
      )}
    </div>
  );
}

export function MenuItem({ icon, label, onClick, danger }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: '0.6rem', width: '100%',
        padding: '0.55rem 0.9rem',
        background: 'transparent', border: 'none',
        color: danger ? '#ef4444' : '#111',
        cursor: 'pointer', fontSize: '0.9rem', textAlign: 'left',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = '#f3f4f6'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
    >
      {icon} {label}
    </button>
  );
}

// Shared empty-state surface. Used by both "no plans" and "no matches"
// branches so the visual is consistent. Optional CTA — pass `onCta` +
// `ctaLabel` to render a button. `icon` is a lucide component (passed
// as the bare reference, not an element).
export function EmptyState({ icon: Icon, title, description, ctaLabel, ctaIcon: CtaIcon, onCta }) {
  return (
    <div
      className="glass"
      role="status"
      aria-live="polite"
      style={{
        padding: '2.5rem 1.5rem',
        textAlign: 'center',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        gap: '0.75rem',
      }}
    >
      <div
        aria-hidden="true"
        style={{
          width: 64, height: 64, borderRadius: '50%',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'var(--primary-color, var(--accent-color))',
          color: '#fff',
          opacity: 0.92,
          boxShadow: '0 8px 20px rgba(0,0,0,0.18)',
        }}
      >
        <Icon size={28} />
      </div>
      <h3 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 600, color: 'var(--text-primary)' }}>{title}</h3>
      {description && (
        <p style={{
          margin: 0, maxWidth: 460, lineHeight: 1.5,
          fontSize: '0.88rem', color: 'var(--text-secondary)',
        }}>
          {description}
        </p>
      )}
      {ctaLabel && onCta && (
        <button
          type="button"
          onClick={onCta}
          style={{
            marginTop: '0.5rem',
            display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
            padding: '0.55rem 1.1rem',
            background: 'var(--primary-color, var(--accent-color))',
            color: '#fff',
            border: 'none',
            borderRadius: 8,
            cursor: 'pointer', fontSize: '0.88rem', fontWeight: 600,
          }}
        >
          {CtaIcon && <CtaIcon size={14} />} {ctaLabel}
        </button>
      )}
    </div>
  );
}
