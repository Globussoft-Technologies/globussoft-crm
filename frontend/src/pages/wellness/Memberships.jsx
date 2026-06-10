import { useEffect, useMemo, useState } from 'react';
import { useContext } from 'react';
import {
  Crown, Plus, Search, Check,
  HelpCircle, Users, Mail,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { usePermissions } from '../../hooks/usePermissions';
import { AuthContext } from '../../App';
import PageHeader from '../../components/PageHeader';

import { SEARCH_MIN_PLANS } from './memberships/utils';
import { PlanCard, EmptyState } from './memberships/PlanCatalog';
import { OwnedMembershipCard } from './memberships/MembershipStatusManager';
import { PlanDetailModal } from './memberships/PlanDetailModal';
import { PurchaseModal } from './memberships/RazorpayCheckout';
import { PlanFormModal } from './memberships/PlanAdminCrud';

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

      const { loadRazorpaySdk } = await import('./memberships/RazorpayCheckout');
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
