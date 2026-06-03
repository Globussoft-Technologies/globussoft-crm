import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useScrollLock } from '../../hooks/useScrollLock';
import { useNotify } from '../../utils/notify';
import {
  Crown, X, Save,
} from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { EMPTY_FORM, inputStyle } from './utils';
import { EntitlementEditor } from './EntitlementEditor';

export function PlanFormModal({ plan, services, onClose, onSaved }) {
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

  useScrollLock(true);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); };
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

        <EntitlementEditor
          entitlements={form.entitlements}
          services={services}
          onAdd={addEntitlement}
          onRemove={removeEntitlement}
          onUpdate={updateEntitlement}
        />

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
