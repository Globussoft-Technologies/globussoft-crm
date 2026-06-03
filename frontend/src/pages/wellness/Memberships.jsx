import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useContext } from 'react';
import {
  Crown, Plus, Pencil, Trash2, X, Save, Search, Check, Monitor,
  MoreVertical, Power, HelpCircle, Users, Package, Calendar, IndianRupee,
  ChevronDown, ChevronUp, CreditCard, Sparkles, Mail, RefreshCcw,
  CheckCircle2, XCircle, Clock,
} from 'lucide-react';
import { formatDate } from '../../utils/date';
import { useNavigate } from 'react-router-dom';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { usePermissions } from '../../hooks/usePermissions';
import { formatMoney } from '../../utils/money';
import { AuthContext } from '../../App';
import PageHeader from '../../components/PageHeader';

// Razorpay checkout SDK loader — same pattern as BuyGiftCards.jsx.
// Lazy-loaded on first purchase attempt so the script isn't fetched
// for catalog browsing.
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

// Empty form. The entitlements field is a non-trivial nested shape:
// an array of { serviceId, quantity } rows. The UI keeps it as a
// simple table — admins add rows by picking a service from the
// catalog and typing a quantity.
const EMPTY_FORM = {
  name: '',
  description: '',
  durationDays: 365,
  price: '',
  currency: 'INR',
  entitlements: [],
};

// ── Visual helpers ────────────────────────────────────────────────

// Named plan gradients — the design has explicit palette for the four
// canonical tiers. Anything outside this list falls back to a stable
// hash-derived gradient so a freshly-created plan still looks intentional.
const NAMED_PLAN_GRADIENTS = {
  platinum: 'linear-gradient(135deg, #8b34e5 0%, #c45cf5 100%)',
  gold:     'linear-gradient(135deg, #d49b1a 0%, #f0c742 50%, #f4d652 100%)',
  silver:   'linear-gradient(135deg, #6b6f7a 0%, #a3a6ad 100%)',
  diamond:  'linear-gradient(135deg, #1c1f23 0%, #4a4f55 100%)',
};
function planGradient(plan) {
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

// Search box on the non-admin view stays hidden until the active catalog
// has at least this many plans — keeps the toolbar clean when there's
// nothing to search through. Admins always see search.
const SEARCH_MIN_PLANS = 4;

// Derive up to N display benefits from a plan's entitlements JSON. The
// entitlements column holds `[{serviceId, quantity}]`; resolving against
// the services catalog yields a human label like "Facial × 10". When the
// catalog hasn't loaded yet we fall back to a generic "Service #id" so
// cards never render an empty benefits list mid-load. Sorted by quantity
// (highest first) so the most generous entitlement leads the card.
function deriveBenefits(plan, services, limit = 3) {
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
function durationLabel(days) {
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

// ── Main page ─────────────────────────────────────────────────────

export default function Memberships() {
  const notify = useNotify();
  const navigate = useNavigate();
  const { user } = useContext(AuthContext) || {};
  const isAdmin = user?.role === 'ADMIN' || user?.role === 'MANAGER';
  // "View Members" routes to /wellness/patients (since members ARE patients
  // until a dedicated members list ships). Backend gates the /patients
  // endpoints on patients.read via phiReadGate, so showing the button when
  // the user can't reach the destination would just dump them on a page that
  // 403s every API call. Hide it when they don't have read access.
  const { hasPermission, isReady: permsReady } = usePermissions();
  const canViewPatients = permsReady && hasPermission('patients', 'read');

  const [plans, setPlans] = useState([]);
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  // Filter set differs by role — admins see catalog-management filters;
  // users see their own selection state. Default tab is "Active" for both,
  // since that's the most useful first view in either role.
  const [filter, setFilter] = useState('Active');
  const [query, setQuery] = useState('');
  const [openMenuId, setOpenMenuId] = useState(null);
  const [editingPlan, setEditingPlan] = useState(null); // null = closed, {} = new, plan = edit
  const [detailPlan, setDetailPlan] = useState(null);

  // User-side "owned" plans — backed by real Membership rows in the DB
  // now that purchase goes through Razorpay. Was previously a
  // localStorage wishlist; the localStorage path is gone since the
  // payment modal creates a real Membership on successful confirm.
  // Admins don't read this; they use the catalog filters.
  const [myMemberships, setMyMemberships] = useState([]);
  const ownedPlanIds = useMemo(
    () => new Set(myMemberships.map((m) => m.planId).filter(Boolean)),
    [myMemberships],
  );

  // Plan currently in the payment modal (null = closed).
  const [purchasePlan, setPurchasePlan] = useState(null);
  const [paying, setPaying] = useState(false);

  const load = () => {
    setLoading(true);
    // The membership listing call below is admin-only (phiReadGate via
    // /patients/:id/memberships) — for non-admin viewers we fall back to
    // /appointments/my-memberships which is scoped to the caller's own
    // patient row. Admins don't render the "Selected" tab anyway so the
    // null fetch is fine for them.
    const memberCall = isAdmin
      ? Promise.resolve([])
      : fetchApi('/api/wellness/appointments/my-memberships').catch(() => []);
    Promise.all([
      fetchApi('/api/wellness/membership-plans?includeInactive=1').catch(() => []),
      fetchApi('/api/wellness/services').catch(() => []),
      memberCall,
    ])
      .then(([p, s, m]) => {
        setPlans(Array.isArray(p) ? p : []);
        setServices(Array.isArray(s) ? s : []);
        setMyMemberships(Array.isArray(m) ? m : []);
      })
      .finally(() => setLoading(false));
  };
  useEffect(load, [isAdmin]);

  // Razorpay handshake. Opens an order, launches the checkout modal, and
  // on success POSTs the signature back so the backend creates the
  // Membership row. Closing the Razorpay modal without paying just
  // resets state — no Membership is created.
  const startPurchase = async (plan) => {
    if (!plan || paying) return;
    setPaying(true);
    try {
      const order = await fetchApi(
        `/api/wellness/membership-plans/${plan.id}/purchase/order`,
        { method: 'POST' },
      );
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
          name: 'Membership Purchase',
          description: plan.name,
          prefill: {
            name: user?.name || '',
            email: user?.email || '',
          },
          theme: { color: '#265855' },
          handler: async (response) => {
            try {
              const confirm = await fetchApi(
                `/api/wellness/membership-plans/${plan.id}/purchase/confirm`,
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
                notify.success(`${plan.name} activated. You can apply it when booking an appointment.`);
                setPurchasePlan(null);
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

  // Close the per-card three-dot menu when the user clicks outside it.
  useEffect(() => {
    if (!openMenuId) return;
    const onDoc = () => setOpenMenuId(null);
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, [openMenuId]);

  // Filter tabs differ by role:
  //   Admin   → All / Active / Expired / Inactive (catalog-management view)
  //   User    → Active / My memberships ("Active" only surfaces plans the
  //             user doesn't already own, so the tab stays actionable
  //             instead of duplicating the owned tab)
  // The Expired tab on the admin side still always reads 0 because the
  // MembershipPlan model has no expiry — only individual Memberships do. It
  // stays for visual parity with the design.
  const filterTabs = isAdmin
    ? ['All', 'Active', 'Expired', 'Inactive']
    : ['Available Plans', 'My Memberships'];

  const counts = useMemo(() => {
    if (isAdmin) {
      return {
        All: plans.length,
        Active: plans.filter((p) => p.isActive).length,
        Inactive: plans.filter((p) => !p.isActive).length,
        Expired: 0,
      };
    }
    // User-side counts:
    //   Available Plans → ALL active plans the clinic has published,
    //     regardless of whether the user already owns them. Owned plans
    //     stay visible as "Purchased" (disabled CTA) so the user can
    //     still see what they bought without leaving this tab.
    //   My Memberships → the user's purchased rows.
    const availableForUser = plans.filter((p) => p.isActive);
    const owned = plans.filter((p) => ownedPlanIds.has(p.id));
    return { 'Available Plans': availableForUser.length, 'My Memberships': owned.length };
  }, [plans, isAdmin, ownedPlanIds]);

  // Reset to a valid filter if the user role changes mid-session (e.g. an
  // admin demotes themselves) or the current filter doesn't exist for the
  // current role. Without this, a stale "Inactive" filter on a non-admin
  // viewer would render zero rows with no way to recover.
  useEffect(() => {
    if (!filterTabs.includes(filter)) setFilter(filterTabs[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  const visiblePlans = useMemo(() => {
    let rows = plans;
    if (isAdmin) {
      if (filter === 'Active') rows = rows.filter((p) => p.isActive);
      else if (filter === 'Inactive') rows = rows.filter((p) => !p.isActive);
      else if (filter === 'Expired') rows = []; // see counts comment above
    } else {
      // User view: hide INACTIVE plans (admin soft-deletes), but show all
      // active plans on the Available Plans tab — including ones the user
      // has already purchased. Ownership is reflected on the card itself
      // (Purchased badge + disabled CTA for active, Expired badge + Renew
      // CTA for past-tense). The My Memberships tab is the alternate view
      // and still filters to owned-only.
      const activeOnly = rows.filter((p) => p.isActive);
      if (filter === 'My Memberships') {
        rows = activeOnly.filter((p) => ownedPlanIds.has(p.id));
      } else {
        rows = activeOnly;
      }
    }
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      rows = rows.filter((p) =>
        String(p.name || '').toLowerCase().includes(q) ||
        String(p.description || '').toLowerCase().includes(q),
      );
    }
    return rows;
  }, [plans, filter, query, isAdmin, ownedPlanIds]);

  const softDeletePlan = async (plan, label = 'Deactivated') => {
    try {
      await fetchApi(`/api/wellness/membership-plans/${plan.id}`, { method: 'DELETE' });
      notify.success(`${label} "${plan.name}"`);
      load();
    } catch (_err) { /* fetchApi already toasted */ }
  };

  const handleDelete = async (plan) => {
    if (!await notify.confirm({
      message: `Delete "${plan.name}"? Existing patient memberships keep their balance until expiry; only NEW sales are blocked.`,
      destructive: true, confirmText: 'Delete',
    })) return;
    softDeletePlan(plan, 'Deleted');
  };

  const handleDeactivate = async (plan) => {
    if (!plan.isActive) {
      // Re-activate: PUT isActive: true.
      try {
        await fetchApi(`/api/wellness/membership-plans/${plan.id}`, {
          method: 'PUT',
          body: JSON.stringify({ isActive: true }),
        });
        notify.success(`Re-activated "${plan.name}"`);
        load();
      } catch (_err) { /* toasted */ }
      return;
    }
    if (!await notify.confirm({
      message: `Deactivate "${plan.name}"? It won't show in the booking page or new-purchase flow.`,
      destructive: true, confirmText: 'Deactivate',
    })) return;
    softDeletePlan(plan, 'Deactivated');
  };

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out', position: 'relative', minHeight: '100%' }}>
      <PageHeader
        icon={Crown}
        title="Memberships"
        description="Offer membership plans with exclusive benefits for returning clients."
      >
        <button
          type="button"
          onClick={() => notify.info('Reach support via the in-app chat or open a ticket from Help → Contact.')}
          style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', padding: '0.5rem 1rem', background: 'transparent', border: '1px solid var(--border-color, rgba(255,255,255,0.18))', borderRadius: 999, color: 'var(--text-primary)', cursor: 'pointer', fontSize: '0.85rem' }}
        >
          <HelpCircle size={14} /> Need Help?
        </button>
      </PageHeader>

      {/* Toolbar: search + filter pills + View Members link.
          Search is hidden when the visible-to-this-role plan count is below
          SEARCH_MIN — at zero plans the search box adds friction without value;
          for tiny catalogs the threshold avoids dropping the tabs onto a new
          row on narrow viewports. Admins always see search (they manage the
          catalog and may have many soft-deleted rows). */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'center', marginBottom: '1.5rem' }}>
        {(isAdmin || plans.filter((p) => p.isActive).length >= SEARCH_MIN_PLANS) && (
          <div style={{ position: 'relative', flex: '1 1 240px', maxWidth: 360 }}>
            <Search size={15} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }} />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search memberships..."
              aria-label="Search memberships"
              style={{ width: '100%', padding: '0.55rem 0.75rem 0.55rem 2.25rem', borderRadius: 999, border: '1px solid var(--border-color, rgba(255,255,255,0.15))', background: 'var(--surface-color, rgba(255,255,255,0.04))', color: 'var(--text-primary)', fontSize: '0.9rem', outline: 'none' }}
            />
          </div>
        )}
        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
          {filterTabs.map((f) => {
            const active = filter === f;
            return (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
                  padding: '0.45rem 0.95rem',
                  background: active ? 'var(--primary-color, var(--accent-color))' : 'transparent',
                  color: active ? '#fff' : 'var(--text-primary)',
                  border: active ? '1px solid transparent' : '1px solid var(--border-color, rgba(255,255,255,0.18))',
                  borderRadius: 999, cursor: 'pointer', fontSize: '0.85rem', fontWeight: 500,
                }}
              >
                {active && <Check size={13} />} {f}
                <span style={{ fontSize: '0.7rem', opacity: 0.7, marginLeft: '0.15rem' }}>{counts[f] != null ? `(${counts[f]})` : ''}</span>
              </button>
            );
          })}
        </div>
        {canViewPatients && (
          <button
            type="button"
            // A dedicated members list isn't built yet, but members are
            // patients — taking the user to the Patients page is the most
            // useful version of "view members" we can ship today. Only
            // surfaced when the viewer has patients.read; otherwise the
            // destination would just 403 on every API call.
            onClick={() => {
              notify.info("Opening Patients — each member's plan and visits are on their patient page.");
              navigate('/wellness/patients');
            }}
            style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: '0.4rem', padding: '0.5rem 1rem', background: 'transparent', border: '1px solid var(--border-color, rgba(255,255,255,0.18))', borderRadius: 8, color: 'var(--text-primary)', cursor: 'pointer', fontSize: '0.85rem' }}
          >
            <Users size={14} /> View Members
          </button>
        )}
      </div>

      {loading ? (
        <p style={{ color: 'var(--text-secondary)' }} role="status" aria-live="polite">Loading membership plans…</p>
      ) : !isAdmin && filter === 'My Memberships' ? (
        // Owned-memberships tab renders membership rows (purchase / expiry /
        // status / balance) not catalog rows — different shape, different
        // card. We still filter by `query` against the plan name so the
        // search field remains useful on this tab when present.
        myMemberships.length === 0 ? (
          <EmptyState
            icon={Crown}
            title="No Memberships Yet"
            description="Once you join a plan it will appear here with your benefits, expiry date, and renewal options."
            ctaLabel="Browse Plans"
            onCta={() => setFilter('Available Plans')}
          />
        ) : (
          (() => {
            const q = query.trim().toLowerCase();
            const rows = q
              ? myMemberships.filter((m) => String(m.planName || '').toLowerCase().includes(q))
              : myMemberships;
            if (rows.length === 0) {
              return (
                <EmptyState
                  icon={Search}
                  title="No matches"
                  description={`No memberships match "${query}".`}
                  ctaLabel="Clear search"
                  onCta={() => setQuery('')}
                />
              );
            }
            return (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))', gap: '1.25rem' }}>
                {rows.map((m) => (
                  <OwnedMembershipCard
                    key={m.id}
                    membership={m}
                    plan={plans.find((p) => p.id === m.planId)}
                    services={services}
                    onView={() => {
                      const plan = plans.find((p) => p.id === m.planId);
                      if (plan) setDetailPlan(plan);
                    }}
                    onRenew={(mem) => {
                      // Backend membership-purchase already detects prior
                      // memberships and emits membership.renewed (see
                      // wellness.js around "isRenewal"), so routing the
                      // user back through the standard Razorpay handshake
                      // gives them a renewed Membership row without
                      // needing a separate /renew route.
                      const plan = plans.find((p) => p.id === mem.planId);
                      if (plan) {
                        setPurchasePlan(plan);
                      } else {
                        notify.error('Plan no longer available. Please contact your clinic to renew.');
                      }
                    }}
                  />
                ))}
              </div>
            );
          })()
        )
      ) : visiblePlans.length === 0 ? (
        // Empty state — filter-aware so users get a useful next-step instead
        // of the generic "no matches" line.
        query.trim() ? (
          <EmptyState
            icon={Search}
            title="No matches"
            description={`No plans match "${query}".`}
            ctaLabel="Clear search"
            onCta={() => setQuery('')}
          />
        ) : !isAdmin ? (
          <EmptyState
            icon={Crown}
            title="No Membership Plans Available"
            description="Memberships unlock recurring benefits, prepaid services, and exclusive savings on visits. Plans aren't published yet — your clinic will notify you when they go live."
            ctaLabel="Contact Clinic"
            ctaIcon={Mail}
            onCta={() => notify.info('Reach your clinic via the in-app chat or call the front desk for membership details.')}
          />
        ) : (
          <EmptyState
            icon={Crown}
            title="No Plans Yet"
            description={filter === 'Active'
              ? 'No active plans. Tap the + button below to create one.'
              : 'No plans match the current filter.'}
          />
        )
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))', gap: '1.25rem' }}>
          {visiblePlans.map((p) => (
            <PlanCard
              key={p.id}
              plan={p}
              services={services}
              isAdmin={isAdmin}
              isOwned={ownedPlanIds.has(p.id)}
              menuOpen={openMenuId === p.id}
              onToggleMenu={(e) => { e.stopPropagation(); setOpenMenuId(openMenuId === p.id ? null : p.id); }}
              onCloseMenu={() => setOpenMenuId(null)}
              onView={() => setDetailPlan(p)}
              onEdit={() => { setOpenMenuId(null); setEditingPlan(p); }}
              onDelete={() => { setOpenMenuId(null); handleDelete(p); }}
              onDeactivate={() => { setOpenMenuId(null); handleDeactivate(p); }}
              onBuy={() => setPurchasePlan(p)}
            />
          ))}
        </div>
      )}

      {/* Floating "+" — admin-only. Matches the design's bottom-right FAB. */}
      {isAdmin && (
        <button
          type="button"
          aria-label="New membership plan"
          onClick={() => setEditingPlan({})}
          style={{
            position: 'fixed', bottom: '1.5rem', right: '1.5rem',
            width: 52, height: 52, borderRadius: 12,
            background: '#111', color: '#fff',
            border: '1px solid rgba(255,255,255,0.15)',
            boxShadow: '0 10px 25px rgba(0,0,0,0.4)',
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 50,
          }}
        >
          <Plus size={22} />
        </button>
      )}

      {editingPlan && (
        <PlanFormModal
          plan={editingPlan && editingPlan.id ? editingPlan : null}
          services={services}
          onClose={() => setEditingPlan(null)}
          onSaved={() => { setEditingPlan(null); load(); }}
        />
      )}

      {detailPlan && (
        <PlanDetailModal
          plan={detailPlan}
          services={services}
          isAdmin={isAdmin}
          isOwned={ownedPlanIds.has(detailPlan.id)}
          onClose={() => setDetailPlan(null)}
          onEdit={() => { setDetailPlan(null); setEditingPlan(detailPlan); }}
          onBuy={() => {
            setPurchasePlan(detailPlan);
            setDetailPlan(null);
          }}
        />
      )}

      {purchasePlan && (
        <PurchaseModal
          plan={purchasePlan}
          paying={paying}
          onClose={() => { if (!paying) setPurchasePlan(null); }}
          onPay={() => startPurchase(purchasePlan)}
        />
      )}
    </div>
  );
}

// ── Card ──────────────────────────────────────────────────────────

function PlanCard({ plan, services = [], isAdmin, isOwned, menuOpen, onToggleMenu, onCloseMenu, onView, onEdit, onDelete, onDeactivate, onBuy }) {
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

// ── Owned membership card ─────────────────────────────────────────
// Renders a row from the /appointments/my-memberships response, joined
// against the plan catalog so we can derive total entitlements + service
// names. Used on the "My Memberships" tab — distinct from PlanCard which
// renders catalog entries. Status pill colors match the underlying
// status enum (active / expired / cancelled) so the visual matches the
// canonical Membership.status column.
function OwnedMembershipCard({ membership, plan, services = [], onView, onRenew }) {
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

// ── Empty state ───────────────────────────────────────────────────
// Shared empty-state surface. Used by both "no plans" and "no matches"
// branches so the visual is consistent. Optional CTA — pass `onCta` +
// `ctaLabel` to render a button. `icon` is a lucide component (passed
// as the bare reference, not an element).
function EmptyState({ icon: Icon = Crown, title, description, ctaLabel, ctaIcon: CtaIcon, onCta }) {
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

function MenuItem({ icon, label, onClick, danger }) {
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

// ── Detail modal ──────────────────────────────────────────────────

function PlanDetailModal({ plan, services, isAdmin, isOwned, onClose, onEdit, onBuy }) {
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
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Move focus into the modal on open — close button is the safest
    // initial target (always visible, doesn't trigger side-effects on
    // accidental activation by assistive tech).
    setTimeout(() => { initialFocusRef.current?.focus(); }, 0);
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose]);

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

// ── Payment modal ─────────────────────────────────────────────────
// Confirmation step that fronts the Razorpay checkout. The actual
// gateway handshake (order create, SDK load, checkout open, confirm
// POST) lives on the parent so this stays a thin, dismissable surface.

function PurchaseModal({ plan, paying, onClose, onPay }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !paying) onClose(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
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
          You'll pay <strong style={{ color: 'var(--text-primary)' }}>{formatMoney(plan.price, { currency: plan.currency || 'INR' })}</strong> via Razorpay. The membership activates immediately on payment success and can be applied at appointment booking.
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

// ── Create / edit modal ───────────────────────────────────────────

function PlanFormModal({ plan, services, onClose, onSaved }) {
  const notify = useNotify();
  const [form, setForm] = useState(() => {
    if (!plan) return EMPTY_FORM;
    let entitlements = [];
    try {
      const parsed = JSON.parse(plan.entitlements || '[]');
      entitlements = Array.isArray(parsed) ? parsed : [];
    } catch { entitlements = []; }
    return {
      name: plan.name || '',
      description: plan.description || '',
      durationDays: plan.durationDays || 365,
      price: plan.price ?? '',
      currency: plan.currency || 'INR',
      entitlements,
    };
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose]);

  const addEntitlement = () => {
    const used = new Set(form.entitlements.map((e) => e.serviceId));
    const available = services.find((s) => !used.has(s.id) && s.isActive);
    if (!available) {
      notify.error('No more services to add');
      return;
    }
    setForm({ ...form, entitlements: [...form.entitlements, { serviceId: available.id, quantity: 1 }] });
  };
  const removeEntitlement = (idx) => {
    setForm({ ...form, entitlements: form.entitlements.filter((_, i) => i !== idx) });
  };
  const updateEntitlement = (idx, key, value) => {
    const next = [...form.entitlements];
    next[idx] = { ...next[idx], [key]: key === 'quantity' || key === 'serviceId' ? parseInt(value, 10) || 0 : value };
    setForm({ ...form, entitlements: next });
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) return notify.error('Plan name is required');
    if (form.entitlements.length === 0) return notify.error('At least one entitlement is required');
    setSaving(true);
    try {
      const body = {
        name: form.name.trim(),
        description: form.description || null,
        durationDays: parseInt(form.durationDays, 10),
        price: parseFloat(form.price),
        currency: form.currency,
        entitlements: form.entitlements,
      };
      if (plan?.id) {
        await fetchApi(`/api/wellness/membership-plans/${plan.id}`, { method: 'PUT', body: JSON.stringify(body) });
        notify.success(`Updated "${form.name}"`);
      } else {
        await fetchApi('/api/wellness/membership-plans', { method: 'POST', body: JSON.stringify(body) });
        notify.success(`Created "${form.name}"`);
      }
      onSaved();
    } catch (_err) { /* fetchApi toasted */ }
    setSaving(false);
  };

  return createPortal((
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '1rem' }}
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        className="glass"
        style={{ maxWidth: 600, width: '100%', maxHeight: '90vh', overflow: 'auto', padding: '1.5rem', borderRadius: 12, position: 'relative' }}
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" onClick={onClose} aria-label="Close" style={{ position: 'absolute', top: 12, right: 12, background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}>
          <X size={18} />
        </button>
        <h2 style={{ fontSize: '1.1rem', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <Crown size={18} /> {plan?.id ? 'Edit membership plan' : 'New membership plan'}
        </h2>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 200px), 1fr))', gap: '0.9rem' }}>
          <Field label="Name *">
            <input required type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Gold Facial Pack 10x" style={inputStyle} />
          </Field>
          <Field label="Validity (days)">
            <input required type="number" min={1} max={3650} value={form.durationDays} onChange={(e) => setForm({ ...form, durationDays: e.target.value })} style={inputStyle} />
          </Field>
          <Field label={`Price (${form.currency})`}>
            <input required type="number" min={1} step="0.01" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} placeholder="15000" style={inputStyle} />
          </Field>
        </div>

        <Field label="Description (optional)" full>
          <textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} style={{ ...inputStyle, resize: 'vertical' }} />
        </Field>

        <div style={{ marginTop: '1.25rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
            <strong style={{ fontSize: '0.9rem', display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
              <Package size={14} /> Service entitlements
            </strong>
            <button type="button" onClick={addEntitlement} style={{ padding: '0.3rem 0.7rem', fontSize: '0.8rem', background: 'transparent', border: '1px solid var(--accent-color)', color: 'var(--accent-color)', borderRadius: 6, cursor: 'pointer' }}>
              <Plus size={12} style={{ verticalAlign: 'middle' }} /> Add row
            </button>
          </div>
          {form.entitlements.length === 0 ? (
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', fontStyle: 'italic' }}>Add at least one service + quantity (e.g. Facial × 10).</p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                  <th style={{ textAlign: 'left', padding: '0.35rem 0' }}>Service</th>
                  <th style={{ textAlign: 'left', padding: '0.35rem 0', width: 110 }}>Quantity</th>
                  <th style={{ width: 40 }}></th>
                </tr>
              </thead>
              <tbody>
                {form.entitlements.map((row, idx) => (
                  <tr key={idx} style={{ borderBottom: '1px solid var(--border-color)' }}>
                    <td style={{ padding: '0.35rem 0' }}>
                      <select value={row.serviceId} onChange={(e) => updateEntitlement(idx, 'serviceId', e.target.value)} style={{ ...inputStyle, padding: '0.4rem' }}>
                        {services.filter((s) => s.isActive).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                    </td>
                    <td style={{ padding: '0.35rem 0' }}>
                      <input type="number" min={1} value={row.quantity} onChange={(e) => updateEntitlement(idx, 'quantity', e.target.value)} style={{ ...inputStyle, padding: '0.4rem', width: 90 }} />
                    </td>
                    <td>
                      <button type="button" onClick={() => removeEntitlement(idx)} style={{ background: 'transparent', border: 'none', color: '#ef4444', cursor: 'pointer' }}>
                        <X size={15} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div style={{ marginTop: '1.5rem', display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose} style={{ padding: '0.5rem 1rem', borderRadius: 8, border: '1px solid var(--border-color)', background: 'transparent', cursor: 'pointer' }}>
            Cancel
          </button>
          <button type="submit" disabled={saving} style={{ padding: '0.5rem 1rem', borderRadius: 8, border: 'none', background: 'var(--primary-color, var(--accent-color))', color: '#fff', cursor: saving ? 'wait' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: '0.35rem', fontWeight: 600 }}>
            <Save size={14} /> {saving ? 'Saving…' : 'Save plan'}
          </button>
        </div>
      </form>
    </div>
  ), document.body);
}

function Field({ label, full, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', gridColumn: full ? '1 / -1' : undefined, marginTop: full ? '0.9rem' : 0 }}>
      <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{label}</span>
      {children}
    </label>
  );
}

const inputStyle = {
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
