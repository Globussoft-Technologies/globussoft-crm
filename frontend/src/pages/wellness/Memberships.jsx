import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useContext } from 'react';
import {
  Crown, Plus, Pencil, Trash2, X, Save, Search, Check, Monitor,
  MoreVertical, Power, HelpCircle, Users, Package, Calendar, IndianRupee,
  ChevronDown, ChevronUp,
} from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { formatMoney } from '../../utils/money';
import { AuthContext } from '../../App';

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
  const { user } = useContext(AuthContext) || {};
  const isAdmin = user?.role === 'ADMIN' || user?.role === 'MANAGER';

  const [plans, setPlans] = useState([]);
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('Active'); // All / Active / Expired / Inactive
  const [query, setQuery] = useState('');
  const [openMenuId, setOpenMenuId] = useState(null);
  const [editingPlan, setEditingPlan] = useState(null); // null = closed, {} = new, plan = edit
  const [detailPlan, setDetailPlan] = useState(null);

  const load = () => {
    setLoading(true);
    Promise.all([
      fetchApi('/api/wellness/membership-plans?includeInactive=1').catch(() => []),
      fetchApi('/api/wellness/services').catch(() => []),
    ])
      .then(([p, s]) => {
        setPlans(Array.isArray(p) ? p : []);
        setServices(Array.isArray(s) ? s : []);
      })
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  // Close the per-card three-dot menu when the user clicks outside it.
  useEffect(() => {
    if (!openMenuId) return;
    const onDoc = () => setOpenMenuId(null);
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, [openMenuId]);

  const counts = useMemo(() => {
    return {
      All: plans.length,
      Active: plans.filter((p) => p.isActive).length,
      Inactive: plans.filter((p) => !p.isActive).length,
      // MembershipPlan has no expiry concept — only individual Memberships do.
      // The Expired filter exists for visual parity with the design; on a
      // pure-plans page it always reads 0 unless we extend the data model.
      Expired: 0,
    };
  }, [plans]);

  const visiblePlans = useMemo(() => {
    let rows = plans;
    if (filter === 'Active') rows = rows.filter((p) => p.isActive);
    else if (filter === 'Inactive') rows = rows.filter((p) => !p.isActive);
    else if (filter === 'Expired') rows = []; // see counts comment above
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      rows = rows.filter((p) =>
        String(p.name || '').toLowerCase().includes(q) ||
        String(p.description || '').toLowerCase().includes(q),
      );
    }
    return rows;
  }, [plans, filter, query]);

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
      <header style={{ marginBottom: '1.25rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Crown size={24} /> Memberships
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            Offer membership plans with exclusive benefits for returning clients.
          </p>
        </div>
        <button
          type="button"
          onClick={() => notify.info('Reach support via the in-app chat or open a ticket from Help → Contact.')}
          style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', padding: '0.5rem 1rem', background: 'transparent', border: '1px solid var(--border-color, rgba(255,255,255,0.18))', borderRadius: 999, color: 'var(--text-primary)', cursor: 'pointer', fontSize: '0.85rem' }}
        >
          <HelpCircle size={14} /> Need Help?
        </button>
      </header>

      {/* Toolbar: search + filter pills + View Members link */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'center', marginBottom: '1.5rem' }}>
        <div style={{ position: 'relative', flex: '1 1 240px', maxWidth: 360 }}>
          <Search size={15} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }} />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search memberships..."
            style={{ width: '100%', padding: '0.55rem 0.75rem 0.55rem 2.25rem', borderRadius: 999, border: '1px solid var(--border-color, rgba(255,255,255,0.15))', background: 'var(--surface-color, rgba(255,255,255,0.04))', color: 'var(--text-primary)', fontSize: '0.9rem', outline: 'none' }}
          />
        </div>
        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
          {['All', 'Active', 'Expired', 'Inactive'].map((f) => {
            const active = filter === f;
            return (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
                  padding: '0.45rem 0.95rem',
                  background: active ? '#111' : 'transparent',
                  color: active ? '#fff' : 'var(--text-primary)',
                  border: active ? '1px solid #111' : '1px solid var(--border-color, rgba(255,255,255,0.18))',
                  borderRadius: 999, cursor: 'pointer', fontSize: '0.85rem', fontWeight: 500,
                }}
              >
                {active && <Check size={13} />} {f}
                <span style={{ fontSize: '0.7rem', opacity: 0.7, marginLeft: '0.15rem' }}>{counts[f] != null ? `(${counts[f]})` : ''}</span>
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => notify.info('Member-level view is coming soon — for now, see /wellness/patients to drill into a member.')}
          style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: '0.4rem', padding: '0.5rem 1rem', background: 'transparent', border: '1px solid var(--border-color, rgba(255,255,255,0.18))', borderRadius: 8, color: 'var(--text-primary)', cursor: 'pointer', fontSize: '0.85rem' }}
        >
          <Users size={14} /> View Members
        </button>
      </div>

      {loading ? (
        <p style={{ color: 'var(--text-secondary)' }}>Loading membership plans…</p>
      ) : visiblePlans.length === 0 ? (
        <div className="glass" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
          {query.trim() || filter !== 'Active'
            ? 'No plans match the current filter.'
            : (
              <>
                No active membership plans yet.
                {isAdmin && <> Tap the <strong>+</strong> button below to create one.</>}
              </>
            )}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))', gap: '1.25rem' }}>
          {visiblePlans.map((p) => (
            <PlanCard
              key={p.id}
              plan={p}
              isAdmin={isAdmin}
              menuOpen={openMenuId === p.id}
              onToggleMenu={(e) => { e.stopPropagation(); setOpenMenuId(openMenuId === p.id ? null : p.id); }}
              onCloseMenu={() => setOpenMenuId(null)}
              onView={() => setDetailPlan(p)}
              onEdit={() => { setOpenMenuId(null); setEditingPlan(p); }}
              onDelete={() => { setOpenMenuId(null); handleDelete(p); }}
              onDeactivate={() => { setOpenMenuId(null); handleDeactivate(p); }}
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
          onClose={() => setDetailPlan(null)}
          onEdit={() => { setDetailPlan(null); setEditingPlan(detailPlan); }}
        />
      )}
    </div>
  );
}

// ── Card ──────────────────────────────────────────────────────────

function PlanCard({ plan, isAdmin, menuOpen, onToggleMenu, onCloseMenu, onView, onEdit, onDelete, onDeactivate }) {
  const gradient = planGradient(plan);
  const isActive = plan.isActive !== false;
  return (
    <div
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
      }}
      onClick={onView}
    >
      {/* "Active" diagonal ribbon — top-left. Only renders on active rows
          (matches the design where inactive cards just look dimmed). */}
      {isActive && (
        <div
          style={{
            position: 'absolute', top: 0, left: 0, width: 90, height: 90,
            pointerEvents: 'none', overflow: 'hidden',
          }}
        >
          <div style={{
            position: 'absolute', top: 12, left: -28, width: 110,
            transform: 'rotate(-45deg)', transformOrigin: 'center',
            background: '#16a34a', color: '#fff', fontSize: '0.65rem',
            fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase',
            padding: '3px 0', textAlign: 'center',
            boxShadow: '0 2px 6px rgba(0,0,0,0.2)',
          }}>
            Active
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
        <div style={{ fontSize: '0.95rem', fontWeight: 500 }}>{formatMoney(plan.price, plan.currency || 'INR')}</div>
      </div>

      <div style={{ marginTop: '0.5rem', display: 'flex', justifyContent: 'flex-end' }}>
        <span style={{ fontSize: '0.85rem', textDecoration: 'underline', textUnderlineOffset: '3px' }}>
          View Details
        </span>
      </div>
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

function PlanDetailModal({ plan, services, onClose, onEdit }) {
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
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose]);

  const serviceName = (id) => services.find((s) => s.id === id)?.name || `Service #${id}`;

  return createPortal((
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '1rem' }}
      onClick={onClose}
    >
      <div style={{
        maxWidth: 540, width: '100%', maxHeight: '92vh', overflow: 'auto',
        borderRadius: 14, position: 'relative',
        background: '#fff', color: '#111',
        boxShadow: '0 25px 50px rgba(0,0,0,0.35)',
      }} onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} aria-label="Close" style={{ position: 'absolute', top: 14, right: 14, background: 'transparent', border: 'none', color: '#444', cursor: 'pointer', display: 'flex', zIndex: 2 }}>
          <X size={20} />
        </button>

        <div style={{ padding: '1.5rem 1.5rem 1rem' }}>
          {/* Plan header — monitor pill, name, price */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', color: '#444', fontSize: '0.95rem', marginTop: '0.25rem' }}>
            <Monitor size={18} /> {durationLabel(plan.durationDays)}
          </div>
          <h2 style={{ fontSize: '1.45rem', fontWeight: 600, marginTop: '0.75rem', textTransform: 'capitalize' }}>{plan.name}</h2>
          <div style={{ fontSize: '1.25rem', fontWeight: 600, marginTop: '0.35rem' }}>{formatMoney(plan.price, plan.currency || 'INR')}</div>
        </div>

        <div style={{ height: 1, background: '#e5e7eb', margin: '0 1.5rem' }} />

        {/* Prepaid Card section. Fields the schema doesn't have yet are
            derived sensibly — Promotional Money = price, Credit Amount
            blank, Tax static GST 5%. If you want literal columns wire
            them through MembershipPlan + the POST/PUT routes later. */}
        <div style={{ padding: '1.25rem 1.5rem' }}>
          <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.75rem' }}>Prepaid Card</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem' }}>
            <CardRow label="Promotional Money" value={formatMoney(plan.price, plan.currency || 'INR')} />
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
          <button onClick={onClose} style={{ padding: '0.5rem 1rem', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', color: '#111', cursor: 'pointer', fontSize: '0.85rem' }}>Close</button>
          <button onClick={onEdit} style={{ padding: '0.5rem 1rem', borderRadius: 8, border: 'none', background: '#111', color: '#fff', cursor: 'pointer', fontSize: '0.85rem', display: 'inline-flex', alignItems: 'center', gap: '0.35rem', fontWeight: 600 }}>
            <Pencil size={14} /> Edit plan
          </button>
        </div>
      </div>
    </div>
  ), document.body);
}

function CardRow({ label, value }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.9rem' }}>
      <span style={{ color: '#555' }}>{label} :</span>
      <strong style={{ color: '#111' }}>{value}</strong>
    </div>
  );
}

function Accordion({ label, open, onToggle, children }) {
  return (
    <div style={{ borderTop: '1px solid #e5e7eb' }}>
      <button
        type="button"
        onClick={onToggle}
        style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.85rem 1.5rem', background: 'transparent', border: 'none', color: '#111', cursor: 'pointer', fontSize: '0.95rem', fontWeight: 600 }}
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
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.75rem 0.85rem', borderRadius: 10, background: '#f3f4f6', marginBottom: '0.5rem' }}>
      <div style={{ fontSize: '0.95rem', fontWeight: 600, color: '#111' }}>{title}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.55rem' }}>
        <span style={{ fontSize: '0.85rem', color: '#555' }}>{trailingLabel}</span>
        <span style={{ fontSize: '0.85rem', fontWeight: 700, color: '#111' }}>{trailingValue}</span>
      </div>
    </div>
  );
}

function RowEmpty({ children }) {
  return <div style={{ padding: '0.6rem 0.85rem', color: '#555', fontSize: '0.85rem', fontStyle: 'italic' }}>{children}</div>;
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
