// Empty form. The entitlements field is a non-trivial nested shape:
// an array of { serviceId, quantity } rows. The UI keeps it as a
// simple table — admins add rows by picking a service from the
// catalog and typing a quantity.
export const EMPTY_FORM = {
  name: '',
  description: '',
  durationDays: 365,
  price: '',
  currency: 'INR',
  entitlements: [],
};

// Search box on the non-admin view stays hidden until the active catalog
// has at least this many plans — keeps the toolbar clean when there's
// nothing to search through. Admins always see search.
export const SEARCH_MIN_PLANS = 4;

// Named plan gradients — the design has explicit palette for the four
// canonical tiers. Anything outside this list falls back to a stable
// hash-derived gradient so a freshly-created plan still looks intentional.
export const NAMED_PLAN_GRADIENTS = {
  platinum: 'linear-gradient(135deg, #8b34e5 0%, #c45cf5 100%)',
  gold:     'linear-gradient(135deg, #d49b1a 0%, #f0c742 50%, #f4d652 100%)',
  silver:   'linear-gradient(135deg, #6b6f7a 0%, #a3a6ad 100%)',
  diamond:  'linear-gradient(135deg, #1c1f23 0%, #4a4f55 100%)',
};

export function planGradient(plan) {
  const key = String(plan?.name || '').trim().toLowerCase();
  for (const k of Object.keys(NAMED_PLAN_GRADIENTS)) {
    if (key.includes(k)) return NAMED_PLAN_GRADIENTS[k];
  }
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  const hue1 = h % 360;
  const hue2 = (hue1 + 35) % 360;
  return `linear-gradient(135deg, hsl(${hue1}, 55%, 45%) 0%, hsl(${hue2}, 65%, 55%) 100%)`;
}

// Derive up to N display benefits from a plan's entitlements JSON. The
// entitlements column holds `[{serviceId, quantity}]`; resolving against
// the services catalog yields a human label like "Facial × 10". When the
// catalog hasn't loaded yet we fall back to a generic "Service #id" so
// cards never render an empty benefits list mid-load. Sorted by quantity
// (highest first) so the most generous entitlement leads the card.
export function deriveBenefits(plan, services, limit = 3) {
  let entitlements = [];
  try {
    const parsed = JSON.parse(plan?.entitlements || '[]');
    if (Array.isArray(parsed)) entitlements = parsed;
  } catch { /* swallow — empty benefits */ }
  return entitlements
    .map((e) => {
      const svc = services.find((s) => s.id === e.serviceId);
      const name = svc?.name || `Service #${e.serviceId}`;
      const qty = Number(e.quantity) || 0;
      return { name, qty };
    })
    .sort((a, b) => b.qty - a.qty)
    .slice(0, limit);
}

// "1 Year plan" / "6 Month plan" / "45 Day plan" — derived from the raw
// durationDays so the design label matches the value the admin entered
// without storing a separate display string.
export function durationLabel(days) {
  const d = Number(days);
  if (!Number.isFinite(d) || d <= 0) return '—';
  if (d % 365 === 0) {
    const y = d / 365;
    return `${y} Year${y > 1 ? 's' : ''} plan`;
  }
  if (d % 30 === 0) {
    const m = d / 30;
    return `${m} Month${m > 1 ? 's' : ''} plan`;
  }
  return `${d} Day${d > 1 ? 's' : ''} plan`;
}

export const inputStyle = {
  padding: '0.55rem 0.75rem',
  borderRadius: 8,
  border: '1px solid var(--border-color, rgba(255,255,255,0.15))',
  background: 'var(--surface-color, rgba(255,255,255,0.04))',
  color: 'var(--text-primary)',
  fontSize: '0.9rem',
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
};
