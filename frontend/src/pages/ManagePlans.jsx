import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Trash2, Save, Loader, ArrowLeft, Eye, Lock } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import { usePermissions } from '../hooks/usePermissions';

// Admin "Manage Subscription Plans" — edits the SubscriptionPlan rows that
// drive the public /pricing page + the Razorpay checkout. ADMIN/OWNER only;
// route is wrapped in <RoleGuard allow={['ADMIN']}> in App.jsx.
//
// One row per plan. Each row is a form whose state mirrors the API response
// shape (see backend/routes/subscriptions.js#formatPlan). Save = PUT, Delete
// = soft DELETE (sets isActive=false), Add Plan = POST.

const C = {
  bg: '#f8fafc', card: '#ffffff', text: '#1e293b', text2: '#334155',
  text3: '#64748b', text4: '#94a3b8', border: '#e2e8f0', borderLight: '#f1f5f9',
  accent: '#4f46e5', accentBg: '#eef2ff', danger: '#dc2626', dangerBg: '#fef2f2',
  green: '#059669', greenBg: '#ecfdf5',
};

const EMPTY_PLAN = {
  id: null,
  planKey: '',
  name: '',
  description: '',
  price: 0,
  currency: 'INR',
  billingIntervalDays: 30,
  features: [],
  pricing: {
    usd: { annual: 0, monthly: 0, yearAnnualLabel: '', yearMonthlyLabel: '' },
    inr: { annual: 0, monthly: 0, yearAnnualLabel: '', yearMonthlyLabel: '' },
  },
  displayOrder: 0,
  popular: false,
  accentColor: '#4f46e5',
  cta: 'Start Free Trial',
  featuresLabel: 'Includes',
  isActive: true,
};

export default function ManagePlans() {
  const notify = useNotify();
  const { isOwner, loading: permsLoading } = usePermissions();
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState(null);
  const [error, setError] = useState(null);

  const load = () => {
    setLoading(true);
    fetchApi('/api/subscriptions/plans/admin')
      .then((data) => {
        // Normalize: every plan needs a pricing object so the form bindings
        // don't blow up on undefined.usd.annual reads.
        const normalized = (data || []).map((p) => ({
          ...EMPTY_PLAN,
          ...p,
          pricing: {
            usd: { ...EMPTY_PLAN.pricing.usd, ...(p.pricing?.usd || {}) },
            inr: { ...EMPTY_PLAN.pricing.inr, ...(p.pricing?.inr || {}) },
          },
          features: Array.isArray(p.features) ? p.features : [],
        }));
        setPlans(normalized);
        setError(null);
      })
      .catch((err) => {
        setError(err?.message || 'Failed to load plans');
        notify.error(`Could not load plans: ${err?.message || 'unknown error'}`);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (!permsLoading && isOwner) load();
  }, [permsLoading, isOwner]);

  // Role gate — only the platform OWNER may edit the catalog. Tenant ADMINs
  // can SEE the public /pricing page and BUY, but cannot edit prices.
  if (permsLoading) {
    return (
      <div style={{ padding: '40px 28px', display: 'flex', alignItems: 'center', gap: 8, color: C.text3, fontFamily: "'Inter', sans-serif" }}>
        <Loader size={16} style={{ animation: 'spin 1s linear infinite' }} /> Checking permissions…
      </div>
    );
  }
  if (!isOwner) {
    return (
      <div style={{ padding: '60px 28px', maxWidth: 600, margin: '0 auto', textAlign: 'center', fontFamily: "'Inter', sans-serif" }}>
        <div style={{ width: 64, height: 64, borderRadius: '50%', background: C.bg, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
          <Lock size={28} color={C.text3} />
        </div>
        <h1 style={{ fontSize: '1.3rem', fontWeight: 700, color: C.text, marginBottom: 8 }}>Owner access required</h1>
        <p style={{ color: C.text3, fontSize: '0.9rem', lineHeight: 1.5 }}>
          Subscription plans are managed at the platform level. Only the Globussoft owner can edit prices and features.
          If you need a plan changed, contact your account team.
        </p>
        <Link to="/settings" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 20, fontSize: '0.85rem', color: C.accent, textDecoration: 'none' }}>
          <ArrowLeft size={14} /> Back to Settings
        </Link>
      </div>
    );
  }

  const updatePlan = (idx, patch) => {
    setPlans((prev) => prev.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  };

  const updatePricing = (idx, currency, field, value) => {
    setPlans((prev) => prev.map((p, i) => {
      if (i !== idx) return p;
      return {
        ...p,
        pricing: {
          ...p.pricing,
          [currency]: { ...p.pricing[currency], [field]: value },
        },
      };
    }));
  };

  const updateFeature = (idx, fIdx, value) => {
    setPlans((prev) => prev.map((p, i) => {
      if (i !== idx) return p;
      const features = [...p.features];
      features[fIdx] = value;
      return { ...p, features };
    }));
  };

  const addFeature = (idx) => {
    setPlans((prev) => prev.map((p, i) => (
      i === idx ? { ...p, features: [...p.features, ''] } : p
    )));
  };

  const removeFeature = (idx, fIdx) => {
    setPlans((prev) => prev.map((p, i) => {
      if (i !== idx) return p;
      return { ...p, features: p.features.filter((_, j) => j !== fIdx) };
    }));
  };

  const savePlan = async (idx) => {
    const plan = plans[idx];
    setSavingId(plan.id ?? `new-${idx}`);
    try {
      const payload = {
        planKey: plan.planKey || null,
        name: plan.name,
        description: plan.description || null,
        price: parseFloat(plan.price) || 0,
        currency: plan.currency || 'INR',
        billingIntervalDays: parseInt(plan.billingIntervalDays) || 30,
        features: plan.features.filter((f) => f && f.trim()),
        pricing: plan.pricing,
        displayOrder: parseInt(plan.displayOrder) || 0,
        popular: !!plan.popular,
        accentColor: plan.accentColor || null,
        cta: plan.cta || null,
        featuresLabel: plan.featuresLabel || null,
        isActive: !!plan.isActive,
      };

      if (plan.id) {
        await fetchApi(`/api/subscriptions/plans/${plan.id}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        notify.success(`Saved "${plan.name}"`);
      } else {
        const created = await fetchApi('/api/subscriptions/plans', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        notify.success(`Created "${created.name}"`);
      }
      load();
    } catch (err) {
      notify.error(`Save failed: ${err?.message || 'unknown error'}`);
    } finally {
      setSavingId(null);
    }
  };

  const deletePlan = async (idx) => {
    const plan = plans[idx];
    if (!plan.id) {
      // Unsaved new plan — just drop the row locally.
      setPlans((prev) => prev.filter((_, i) => i !== idx));
      return;
    }
    notify.confirm(
      `Deactivate "${plan.name}"? Existing subscribers keep access, but the plan won't appear on /pricing.`,
      async () => {
        try {
          await fetchApi(`/api/subscriptions/plans/${plan.id}`, { method: 'DELETE' });
          notify.success(`Deactivated "${plan.name}"`);
          load();
        } catch (err) {
          notify.error(`Delete failed: ${err?.message || 'unknown error'}`);
        }
      }
    );
  };

  const addNewPlan = () => {
    setPlans((prev) => [...prev, { ...EMPTY_PLAN, displayOrder: prev.length }]);
  };

  const inputStyle = { width: '100%', padding: '8px 10px', fontSize: '0.85rem', border: `1px solid ${C.border}`, borderRadius: 6, background: '#fff', color: C.text, fontFamily: 'inherit', boxSizing: 'border-box' };
  const labelStyle = { display: 'block', fontSize: '0.72rem', fontWeight: 600, color: C.text3, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 };
  const fieldGroup = { marginBottom: 12 };
  const sectionTitle = { fontSize: '0.85rem', fontWeight: 700, color: C.text, margin: '20px 0 12px', paddingBottom: 6, borderBottom: `1px solid ${C.borderLight}` };

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1100, margin: '0 auto', fontFamily: "'Inter', sans-serif" }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <Link to="/settings" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.82rem', color: C.text3, textDecoration: 'none' }}>
          <ArrowLeft size={14} /> Back to Settings
        </Link>
        <Link to="/pricing" target="_blank" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.82rem', color: C.accent, textDecoration: 'none' }}>
          <Eye size={14} /> Preview /pricing
        </Link>
      </div>
      <h1 style={{ fontSize: '1.6rem', fontWeight: 800, color: C.text, marginBottom: 4, letterSpacing: '-0.02em' }}>Manage Subscription Plans</h1>
      <p style={{ color: C.text3, fontSize: '0.88rem', marginBottom: 28 }}>
        Edit the plans shown on the public <Link to="/pricing" style={{ color: C.accent }}>/pricing</Link> page. Changes are live immediately — no redeploy needed.
      </p>

      {loading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: C.text3, padding: 24 }}>
          <Loader size={16} style={{ animation: 'spin 1s linear infinite' }} /> Loading plans…
        </div>
      )}

      {error && !loading && (
        <div style={{ background: C.dangerBg, color: C.danger, padding: '12px 16px', borderRadius: 8, marginBottom: 16, fontSize: '0.85rem' }}>
          {error}
        </div>
      )}

      {!loading && plans.map((plan, idx) => (
        <div key={plan.id ?? `new-${idx}`} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 24, marginBottom: 20, boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
            <div>
              <h2 style={{ fontSize: '1.1rem', fontWeight: 700, color: C.text, margin: 0 }}>
                {plan.name || '(unnamed plan)'}
                {plan.popular && <span style={{ marginLeft: 10, fontSize: '0.65rem', fontWeight: 700, background: C.accent, color: '#fff', padding: '3px 9px', borderRadius: 100, letterSpacing: '0.04em' }}>MOST POPULAR</span>}
                {!plan.isActive && <span style={{ marginLeft: 10, fontSize: '0.65rem', fontWeight: 700, background: C.text4, color: '#fff', padding: '3px 9px', borderRadius: 100 }}>INACTIVE</span>}
              </h2>
              <div style={{ fontSize: '0.75rem', color: C.text4, marginTop: 4 }}>
                {plan.id ? `Plan #${plan.id}` : 'New plan (unsaved)'}{plan.planKey ? ` · key: ${plan.planKey}` : ''}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => savePlan(idx)}
                disabled={savingId === (plan.id ?? `new-${idx}`)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', fontSize: '0.82rem', fontWeight: 600, background: C.accent, color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit' }}
              >
                {savingId === (plan.id ?? `new-${idx}`) ? <Loader size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Save size={13} />}
                Save
              </button>
              <button
                onClick={() => deletePlan(idx)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', fontSize: '0.82rem', fontWeight: 600, background: C.dangerBg, color: C.danger, border: `1px solid ${C.danger}`, borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit' }}
              >
                <Trash2 size={13} />
                {plan.id ? 'Deactivate' : 'Discard'}
              </button>
            </div>
          </div>

          {/* Identity */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
            <div style={fieldGroup}>
              <label style={labelStyle}>Name *</label>
              <input style={inputStyle} value={plan.name} onChange={(e) => updatePlan(idx, { name: e.target.value })} placeholder="Starter" />
            </div>
            <div style={fieldGroup}>
              <label style={labelStyle}>Plan key (slug)</label>
              <input style={inputStyle} value={plan.planKey || ''} onChange={(e) => updatePlan(idx, { planKey: e.target.value })} placeholder="starter" />
            </div>
            <div style={fieldGroup}>
              <label style={labelStyle}>Display order</label>
              <input type="number" style={inputStyle} value={plan.displayOrder} onChange={(e) => updatePlan(idx, { displayOrder: e.target.value })} />
            </div>
          </div>
          <div style={fieldGroup}>
            <label style={labelStyle}>Description</label>
            <textarea style={{ ...inputStyle, minHeight: 50, resize: 'vertical' }} value={plan.description || ''} onChange={(e) => updatePlan(idx, { description: e.target.value })} placeholder="For startups & SMBs..." />
          </div>

          {/* Pricing */}
          <h3 style={sectionTitle}>Pricing</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            {['usd', 'inr'].map((cur) => (
              <div key={cur} style={{ background: C.bg, padding: 14, borderRadius: 8, border: `1px solid ${C.borderLight}` }}>
                <div style={{ fontSize: '0.75rem', fontWeight: 700, color: C.text2, marginBottom: 10, textTransform: 'uppercase' }}>{cur === 'usd' ? '$ USD' : '₹ INR'}</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div>
                    <label style={labelStyle}>Annual /user/mo</label>
                    <input style={inputStyle} value={plan.pricing[cur].annual} onChange={(e) => updatePricing(idx, cur, 'annual', e.target.value)} />
                  </div>
                  <div>
                    <label style={labelStyle}>Monthly /user/mo</label>
                    <input style={inputStyle} value={plan.pricing[cur].monthly} onChange={(e) => updatePricing(idx, cur, 'monthly', e.target.value)} />
                  </div>
                  <div>
                    <label style={labelStyle}>Annual year-label</label>
                    <input style={inputStyle} value={plan.pricing[cur].yearAnnualLabel} onChange={(e) => updatePricing(idx, cur, 'yearAnnualLabel', e.target.value)} placeholder={cur === 'usd' ? '$72 /user/year' : '₹5,988 /user/year'} />
                  </div>
                  <div>
                    <label style={labelStyle}>Monthly year-label</label>
                    <input style={inputStyle} value={plan.pricing[cur].yearMonthlyLabel} onChange={(e) => updatePricing(idx, cur, 'yearMonthlyLabel', e.target.value)} placeholder={cur === 'usd' ? '$96 /user/year' : '₹7,788 /user/year'} />
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, marginTop: 12 }}>
            <div style={fieldGroup}>
              <label style={labelStyle}>Legacy charge price</label>
              <input type="number" step="0.01" style={inputStyle} value={plan.price} onChange={(e) => updatePlan(idx, { price: e.target.value })} />
            </div>
            <div style={fieldGroup}>
              <label style={labelStyle}>Legacy currency</label>
              <select style={inputStyle} value={plan.currency} onChange={(e) => updatePlan(idx, { currency: e.target.value })}>
                <option value="INR">INR</option>
                <option value="USD">USD</option>
              </select>
            </div>
            <div style={fieldGroup}>
              <label style={labelStyle}>Billing interval (days)</label>
              <input type="number" style={inputStyle} value={plan.billingIntervalDays} onChange={(e) => updatePlan(idx, { billingIntervalDays: e.target.value })} />
            </div>
          </div>

          {/* Display */}
          <h3 style={sectionTitle}>Display</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
            <div style={fieldGroup}>
              <label style={labelStyle}>CTA label</label>
              <input style={inputStyle} value={plan.cta || ''} onChange={(e) => updatePlan(idx, { cta: e.target.value })} placeholder="Start Free Trial" />
            </div>
            <div style={fieldGroup}>
              <label style={labelStyle}>Features heading</label>
              <input style={inputStyle} value={plan.featuresLabel || ''} onChange={(e) => updatePlan(idx, { featuresLabel: e.target.value })} placeholder="Includes" />
            </div>
            <div style={fieldGroup}>
              <label style={labelStyle}>Accent color</label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input type="color" value={plan.accentColor || '#4f46e5'} onChange={(e) => updatePlan(idx, { accentColor: e.target.value })} style={{ width: 38, height: 32, border: `1px solid ${C.border}`, borderRadius: 4, padding: 2, cursor: 'pointer', background: '#fff' }} />
                <input style={inputStyle} value={plan.accentColor || ''} onChange={(e) => updatePlan(idx, { accentColor: e.target.value })} placeholder="#4f46e5" />
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 24, marginTop: 4 }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: '0.85rem', color: C.text2, cursor: 'pointer' }}>
              <input type="checkbox" checked={!!plan.popular} onChange={(e) => updatePlan(idx, { popular: e.target.checked })} />
              Most Popular badge
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: '0.85rem', color: C.text2, cursor: 'pointer' }}>
              <input type="checkbox" checked={!!plan.isActive} onChange={(e) => updatePlan(idx, { isActive: e.target.checked })} />
              Active (visible on /pricing)
            </label>
          </div>

          {/* Features */}
          <h3 style={sectionTitle}>Feature list</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {plan.features.map((f, fIdx) => (
              <div key={fIdx} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input style={inputStyle} value={f} onChange={(e) => updateFeature(idx, fIdx, e.target.value)} placeholder="Feature description" />
                <button onClick={() => removeFeature(idx, fIdx)} style={{ flexShrink: 0, padding: '8px 10px', background: C.dangerBg, color: C.danger, border: `1px solid ${C.danger}`, borderRadius: 6, cursor: 'pointer' }}>
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            <button onClick={() => addFeature(idx)} style={{ alignSelf: 'flex-start', marginTop: 6, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', fontSize: '0.82rem', fontWeight: 600, background: C.accentBg, color: C.accent, border: `1px solid ${C.accent}`, borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit' }}>
              <Plus size={13} /> Add feature
            </button>
          </div>
        </div>
      ))}

      {!loading && (
        <button onClick={addNewPlan} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '12px 20px', fontSize: '0.88rem', fontWeight: 600, background: C.accent, color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit', marginTop: 8 }}>
          <Plus size={15} /> Add new plan
        </button>
      )}
    </div>
  );
}
