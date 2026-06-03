import { useEffect, useState } from 'react';
import { IndianRupee, Clock, MapPin, Pencil, Trash2, X, Save } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { usePermissions } from '../../hooks/usePermissions';
import { firstImageOf, iconBtn, inputStyle, tierColor } from './shared';
import ImageUploadField from './ImageUploadField';

export default function ServiceCard({ service, onChanged, onOpen, editRequested, onEditConsumed }) {
  const notify = useNotify();
  const { hasPermission, isReady: permsReady } = usePermissions();
  const canManageServices = permsReady && hasPermission('services', 'write');
  const [editing, setEditing] = useState(false);
  // Hydrate the draft with a flat `imageUrl` (first of the JSON array) so
  // the inline ImageUploadField stays controlled.
  const [draft, setDraft] = useState(() => ({ ...service, imageUrl: firstImageOf(service) || '' }));
  const [saving, setSaving] = useState(false);
  const imageSrc = firstImageOf(service);

  // External edit trigger — the detail modal sets editRequestId on the
  // parent; we flip into edit mode then clear the request so a subsequent
  // modal-edit on the same card works again.
  useEffect(() => {
    if (editRequested) {
      setEditing(true);
      setDraft({ ...service, imageUrl: firstImageOf(service) || '' });
      if (onEditConsumed) onEditConsumed();
    }

  }, [editRequested]);

  const save = async () => {
    // #149: validate before submit. Backend rejects basePrice<=0 (batch 1 #115)
    // but the rejection was silently swallowed, AND duration / radius accepted
    // negatives because the backend doesn't check those.
    const price = parseFloat(draft.basePrice);
    const duration = parseInt(draft.durationMin);
    const radius = draft.targetRadiusKm === '' || draft.targetRadiusKm == null
      ? null
      : parseInt(draft.targetRadiusKm);
    if (!Number.isFinite(price) || price <= 0) {
      notify.error('Base price must be greater than 0.');
      return;
    }
    if (!Number.isFinite(duration) || duration <= 0) {
      notify.error('Duration must be greater than 0 minutes.');
      return;
    }
    if (radius !== null && (!Number.isFinite(radius) || radius < 0)) {
      notify.error('Marketing radius cannot be negative. Leave blank for unlimited.');
      return;
    }
    setSaving(true);
    try {
      // #274 #275: fetchApi auto-toasts the server error message on 403
      // (the canonical RBAC denial copy per #590/#591). Page emits the
      // success toast.
      await fetchApi(`/api/wellness/services/${service.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: draft.name, category: draft.category, ticketTier: draft.ticketTier,
          basePrice: price,
          durationMin: duration,
          targetRadiusKm: radius,
          description: draft.description || null,
          isActive: draft.isActive !== false,
          imageUrls: draft.imageUrl ? [draft.imageUrl] : null,
        }),
      });
      notify.success(`Saved "${draft.name}"`);
      setEditing(false);
      onChanged && onChanged();
    } catch (_err) { /* fetchApi already surfaced the message */ }
    setSaving(false);
  };

  const remove = async () => {
    if (!await notify.confirm({ message: `Deactivate "${service.name}"? It won't show in the catalog or booking page.`, destructive: true, confirmText: 'Deactivate' })) return;
    try {
      await fetchApi(`/api/wellness/services/${service.id}`, {
        method: 'PUT', body: JSON.stringify({ isActive: false }),
      });
      notify.success(`Deactivated "${service.name}"`);
      onChanged && onChanged();
    } catch (_err) { /* fetchApi already surfaced the message */ }
  };

  if (editing) {
    return (
      <div className="glass" style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
        <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} style={inputStyle} placeholder="Service name" />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.4rem' }}>
          <select value={draft.category || ''} onChange={(e) => setDraft({ ...draft, category: e.target.value })} style={inputStyle}>
            {['hair', 'hair-transplant', 'hair-restoration', 'hair-concern', 'skin', 'skin-surgery', 'aesthetics', 'anti-ageing', 'pigmentation', 'medifacial', 'under-eye', 'acne', 'laser-hair', 'laser-skin', 'body-contouring', 'slimming', 'ayurveda', 'salon'].map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={draft.ticketTier} onChange={(e) => setDraft({ ...draft, ticketTier: e.target.value })} style={inputStyle}>
            <option value="low">Low tier</option><option value="medium">Medium tier</option><option value="high">High tier</option>
          </select>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.4rem' }}>
          {/* #149: min attrs are HTML5 hints; save() also re-validates so users can't bypass via paste. */}
          <input type="number" min="1" step="1" value={draft.basePrice} onChange={(e) => setDraft({ ...draft, basePrice: e.target.value })} style={inputStyle} placeholder="₹ price" />
          <input type="number" min="1" step="1" value={draft.durationMin} onChange={(e) => setDraft({ ...draft, durationMin: e.target.value })} style={inputStyle} placeholder="min" />
          <input type="number" min="0" step="1" value={draft.targetRadiusKm || ''} onChange={(e) => setDraft({ ...draft, targetRadiusKm: e.target.value })} style={inputStyle} placeholder="km radius" />
        </div>
        <textarea value={draft.description || ''} onChange={(e) => setDraft({ ...draft, description: e.target.value })} rows={2} style={{ ...inputStyle, resize: 'vertical' }} placeholder="Description" />
        <div>
          <label style={{ display: 'block', fontSize: '0.7rem', color: 'var(--text-secondary)', marginBottom: '0.25rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Image</label>
          <ImageUploadField imageUrl={draft.imageUrl || ''} onChange={(url) => setDraft({ ...draft, imageUrl: url })} />
        </div>
        <div style={{ display: 'flex', gap: '0.4rem' }}>
          <button onClick={save} disabled={saving} style={{ flex: 1, padding: '0.5rem', background: 'var(--success-color)', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.3rem' }}>
            <Save size={14} /> {saving ? 'Saving…' : 'Save'}
          </button>
          <button onClick={() => { setEditing(false); setDraft({ ...service, imageUrl: firstImageOf(service) || '' }); }} style={{ padding: '0.5rem 0.75rem', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 6, cursor: 'pointer' }}>
            <X size={14} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="glass"
      style={{ padding: '1.25rem', position: 'relative', cursor: onOpen ? 'pointer' : 'default' }}
      role={onOpen ? 'button' : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onClick={() => onOpen && onOpen(service)}
      onKeyDown={(ev) => { if (onOpen && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); onOpen(service); } }}
      title="Click to view details"
    >
      <div
        style={{ position: 'absolute', top: '0.5rem', right: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.4rem', zIndex: 3 }}
        onClick={(e) => e.stopPropagation()}
      >
        <span style={{ background: tierColor[service.ticketTier], color: '#fff', padding: '0.15rem 0.5rem', borderRadius: 4, fontSize: '0.65rem', textTransform: 'uppercase', fontWeight: 600, lineHeight: 1.4 }}>
          {service.ticketTier}
        </span>
        {canManageServices && (
          <>
            <button onClick={(e) => { e.stopPropagation(); setEditing(true); }} aria-label={`Edit service ${service.name}`} title="Edit" style={iconBtn}><Pencil size={12} /></button>
            <button onClick={(e) => { e.stopPropagation(); remove(); }} aria-label={`Deactivate service ${service.name}`} title="Deactivate" style={{ ...iconBtn, color: 'var(--danger-color)' }}><Trash2 size={12} /></button>
          </>
        )}
      </div>
      {imageSrc && (
        <img
          src={imageSrc}
          alt=""
          style={{ width: '100%', height: 120, objectFit: 'cover', borderRadius: 8, marginBottom: '0.75rem', background: 'rgba(255,255,255,0.04)' }}
          onError={(e) => { e.currentTarget.style.display = 'none'; }}
        />
      )}
      <div style={{ marginBottom: '0.5rem', paddingRight: '6.5rem' }}>
        <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{service.category}</div>
        <h3 style={{ fontSize: '1rem', fontWeight: 600, marginTop: '0.15rem' }}>{service.name}</h3>
      </div>
      <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
        <span><IndianRupee size={12} style={{ verticalAlign: 'middle' }} /> {service.basePrice.toLocaleString('en-IN')}</span>
        <span><Clock size={12} style={{ verticalAlign: 'middle' }} /> {service.durationMin} min</span>
        <span><MapPin size={12} style={{ verticalAlign: 'middle' }} /> {service.targetRadiusKm ? `${service.targetRadiusKm} km` : 'Unlimited'}</span>
      </div>
      {service.description && <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.5rem', lineHeight: 1.4 }}>{service.description}</p>}
    </div>
  );
}
