import { useMemo } from 'react';
import {
  Monitor, CheckCircle2, XCircle, Clock, Calendar, RefreshCcw,
} from 'lucide-react';
import { formatDate } from '../../../utils/date';
import { planGradient, durationLabel } from './utils';

// Renders a row from the /appointments/my-memberships response, joined
// against the plan catalog so we can derive total entitlements + service
// names. Used on the "My Memberships" tab — distinct from PlanCard which
// renders catalog entries. Status pill colors match the underlying
// status enum (active / expired / cancelled) so the visual matches the
// canonical Membership.status column.
export function OwnedMembershipCard({ membership, plan, services = [], onView, onRenew }) {
  const gradient = planGradient(plan || { name: membership.planName });
  const now = Date.now();
  const expired = membership.endDate && new Date(membership.endDate).getTime() < now;
  const status = expired ? 'expired' : (membership.status || 'active');

  const STATUS_TONE = {
    active:    { bg: 'rgba(34,197,94,0.18)',  color: '#16a34a', Icon: CheckCircle2, label: 'Active' },
    expired:   { bg: 'rgba(239,68,68,0.18)',  color: '#dc2626', Icon: XCircle,      label: 'Expired' },
    cancelled: { bg: 'rgba(107,114,128,0.22)', color: '#6b7280', Icon: XCircle,     label: 'Cancelled' },
  };
  const tone = STATUS_TONE[status] || STATUS_TONE.active;
  const StatusIcon = tone.Icon;

  // Usage summary: join membership.balance (remaining per serviceId)
  // against plan.entitlements (original quantity per serviceId) so we can
  // render "Facial: 3 / 10 remaining". When the plan catalog hasn't loaded
  // we skip the original-quantity bit and just show remaining.
  const usage = useMemo(() => {
    const balance = Array.isArray(membership.balance) ? membership.balance : [];
    let planEntitlements = [];
    if (plan) {
      try {
        const parsed = JSON.parse(plan.entitlements || '[]');
        if (Array.isArray(parsed)) planEntitlements = parsed;
      } catch { /* leave as [] */ }
    }
    return balance.slice(0, 3).map((b) => {
      const svc = services.find((s) => s.id === b.serviceId);
      const original = planEntitlements.find((e) => e.serviceId === b.serviceId);
      return {
        name: svc?.name || `Service #${b.serviceId}`,
        remaining: Number(b.remaining) || 0,
        total: original ? Number(original.quantity) || 0 : null,
      };
    });
  }, [membership.balance, plan, services]);

  // Renewal eligibility: within 30 days of expiry OR already expired and
  // not cancelled. The actual renew call is a TODO (no patient-facing
  // route yet); for now the button surfaces a contact-clinic notice so the
  // user knows the path forward.
  const daysUntilExpiry = membership.endDate
    ? Math.ceil((new Date(membership.endDate).getTime() - now) / 86400000)
    : null;
  const canRenew = status !== 'cancelled'
    && daysUntilExpiry != null
    && (expired || daysUntilExpiry <= 30);

  return (
    <div
      role="article"
      aria-label={`Membership: ${membership.planName}, status ${tone.label}`}
      tabIndex={0}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && onView) { e.preventDefault(); onView(); }
      }}
      style={{
        position: 'relative',
        borderRadius: 16,
        padding: '1.25rem 1.25rem 1rem',
        minHeight: 200,
        color: '#fff',
        background: gradient,
        boxShadow: '0 8px 20px rgba(0,0,0,0.25)',
        overflow: 'hidden',
        opacity: status === 'active' ? 1 : 0.85,
        cursor: onView ? 'pointer' : 'default',
        outline: 'none',
      }}
      onClick={onView}
    >
      {/* Status pill — top-right. Uses status-tone tokens so the color
          (green/red/grey) matches the visual rule across the app. */}
      <div
        style={{
          position: 'absolute', top: 10, right: 10, zIndex: 2,
          display: 'inline-flex', alignItems: 'center', gap: '0.25rem',
          padding: '0.2rem 0.55rem',
          background: tone.bg,
          color: tone.color,
          border: `1px solid ${tone.color}`,
          borderRadius: 999,
          fontSize: '0.65rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
        }}
      >
        <StatusIcon size={11} /> {tone.label}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem', opacity: 0.95 }}>
        <Monitor size={14} /> {durationLabel(membership.planDurationDays || (plan && plan.durationDays))}
      </div>

      <div style={{ marginTop: '0.85rem', display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
        <h3 style={{ fontSize: '1.25rem', fontWeight: 600, textTransform: 'capitalize' }}>{membership.planName}</h3>
      </div>

      {/* Dates row — purchase + expiry side by side. formatDate respects
          the user's locale so en-IN gets "dd/mm/yyyy" and en-US gets the
          slash-style equivalent. */}
      <div
        style={{
          marginTop: '0.65rem',
          display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.4rem',
          fontSize: '0.75rem', opacity: 0.92,
        }}
      >
        <div>
          <div style={{ opacity: 0.7, fontSize: '0.65rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Purchased</div>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', marginTop: '0.1rem' }}>
            <Calendar size={11} /> {formatDate(membership.createdAt || membership.startDate)}
          </div>
        </div>
        <div>
          <div style={{ opacity: 0.7, fontSize: '0.65rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Expires</div>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', marginTop: '0.1rem' }}>
            <Clock size={11} /> {formatDate(membership.endDate)}
          </div>
        </div>
      </div>

      {/* Usage summary — up to 3 rows of "Service: remaining / total". */}
      {usage.length > 0 && (
        <ul
          aria-label="Benefit usage"
          style={{
            margin: '0.7rem 0 0', padding: 0, listStyle: 'none',
            display: 'flex', flexDirection: 'column', gap: '0.2rem',
          }}
        >
          {usage.map((u, i) => (
            <li
              key={i}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                gap: '0.5rem', fontSize: '0.78rem', opacity: 0.95,
              }}
            >
              <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {u.name}
              </span>
              <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
                {u.total != null ? `${u.remaining} / ${u.total} left` : `${u.remaining} left`}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div
        style={{ marginTop: '0.75rem', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '0.75rem' }}
        onClick={(e) => e.stopPropagation()}
      >
        {onView && (
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
        )}
        {canRenew && onRenew && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onRenew(membership); }}
            aria-label={`Renew ${membership.planName}`}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '0.35rem',
              padding: '0.4rem 0.85rem',
              background: 'rgba(255,255,255,0.95)',
              color: '#111',
              border: 'none',
              borderRadius: 8,
              cursor: 'pointer', fontSize: '0.8rem', fontWeight: 600,
            }}
          >
            <RefreshCcw size={13} /> Renew
          </button>
        )}
      </div>
    </div>
  );
}
