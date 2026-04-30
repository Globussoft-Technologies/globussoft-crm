import React, { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Sparkles,
  Plus,
  MapPin,
  Clock,
  IndianRupee,
  Package,
  Copy,
  Check,
  Pencil,
  Trash2,
  X,
  Save,
  Activity,
} from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
// #316: NumberInput strips the `<oldValue><newTyped>` concatenation artifact
// users hit when doing Ctrl+A → Delete → retype on number fields.
import { NumberInput } from '../../utils/numberInput';

const tierColor = { high: '#ef4444', medium: '#f59e0b', low: '#64748b' };
const statusColor = { active: '#10b981', completed: '#6366f1', paused: '#f59e0b', cancelled: '#ef4444' };

export default function Services() {
  const notify = useNotify();
  const [searchParams] = useSearchParams();
  const initialTab = searchParams.get('tab') || 'catalog';
  const [tab, setTab] = useState(initialTab); // catalog | packages | activetreatments
  const [services, setServices] = useState([]);
  const [treatments, setTreatments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [treatmentsLoading, setTreatmentsLoading] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [selectedTreatment, setSelectedTreatment] = useState(null);
  // #115: basePrice starts blank (not 0) so the placeholder shows and the
  // validity gate rejects submit until the user enters ≥ ₹1.
  const [form, setForm] = useState({ name: '', category: 'aesthetics', ticketTier: 'medium', basePrice: '', durationMin: 60, targetRadiusKm: 30, description: '' });

  const load = () => {
    setLoading(true);
    fetchApi('/api/wellness/services').then(setServices).catch(() => setServices([])).finally(() => setLoading(false));
  };

  const loadTreatments = () => {
    setTreatmentsLoading(true);
    fetchApi('/api/wellness/activetreatment').then(res => setTreatments(res.data || [])).catch(() => setTreatments([])).finally(() => setTreatmentsLoading(false));
  };

  useEffect(load, []);
  useEffect(() => {
    if (tab === 'activetreatments') {
      loadTreatments();
    }
  }, [tab]);

  const submit = async (e) => {
    e.preventDefault();
    try {
      await fetchApi('/api/wellness/services', { method: 'POST', body: JSON.stringify(form) });
      notify.success(`Service "${form.name}" created`);
      setShowAdd(false);
      setForm({ name: '', category: 'aesthetics', ticketTier: 'medium', basePrice: '', durationMin: 60, targetRadiusKm: 30, description: '' });
      load();
    } catch (_err) { /* fetchApi already toasted */ }
  };

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Sparkles size={24} /> Service catalog
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>Each service has a price, duration, and target marketing radius.</p>
        </div>
        {tab === 'catalog' && (
          <button onClick={() => setShowAdd(!showAdd)} style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.5rem 1rem', background: 'var(--accent-color)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}>
            <Plus size={16} /> {showAdd ? 'Cancel' : 'New service'}
          </button>
        )}
        {/* #365: Packages tab needs its own primary CTA. The package builder is
            already rendered inline below, so this just scrolls to the form
            anchor — no modal needed. */}
        {tab === 'packages' && (
          <button
            onClick={() => {
              const el = document.getElementById('package-builder-anchor');
              if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }}
            style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.5rem 1rem', background: 'var(--accent-color)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}
          >
            <Plus size={16} /> Create Package
          </button>
        )}
      </header>

      {/* Tabs */}
      <div
        style={{
          display: 'flex',
          gap: '0.5rem',
          marginBottom: '1.5rem',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        <TabBtn active={tab === 'catalog'} onClick={() => setTab('catalog')} icon={Sparkles} label="Catalog" />
        <TabBtn active={tab === 'packages'} onClick={() => setTab('packages')} icon={Package} label="Packages" />
        <TabBtn active={tab === 'activetreatments'} onClick={() => setTab('activetreatments')} icon={Activity} label="Active Treatments" />
      </div>

      {tab === 'catalog' && (
        <CatalogTab
          services={services}
          loading={loading}
          showAdd={showAdd}
          form={form}
          setForm={setForm}
          submit={submit}
          onChanged={load}
        />
      )}

      {tab === 'packages' && <PackageBuilder services={services} />}

      {tab === 'activetreatments' && (
        <ActiveTreatmentsTab
          treatments={treatments}
          loading={treatmentsLoading}
          onChanged={loadTreatments}
          onSelectTreatment={setSelectedTreatment}
        />
      )}

      {selectedTreatment && (
        <TreatmentDetailModal
          treatment={selectedTreatment}
          onClose={() => setSelectedTreatment(null)}
          onChanged={() => { loadTreatments(); setSelectedTreatment(null); }}
        />
      )}
    </div>
  );
}

function TabBtn({ active, onClick, icon: Icon, label }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.35rem',
        padding: '0.6rem 1rem',
        background: active ? 'rgba(59, 130, 246, 0.15)' : 'transparent',
        border: 'none',
        borderBottom: active ? '2px solid #3b82f6' : '2px solid transparent',
        color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
        cursor: 'pointer',
        fontSize: '0.9rem',
        fontWeight: 500,
      }}
    >
      <Icon size={15} /> {label}
    </button>
  );
}

function CatalogTab({ services, loading, showAdd, form, setForm, submit, onChanged }) {
  const notify = useNotify();
  return (
    <>
      {/* Visually-hidden section heading so screen readers see h1 -> h2 hierarchy
          before the per-service h3 cards (a11y: heading-order). */}
      <h2 style={srOnly}>Available services</h2>
      {showAdd && (() => {
        // #115: visible labels for every field; basePrice must be > 0 before save.
        const fieldLabel = { display: 'block', fontSize: '0.7rem', fontWeight: 500, color: 'var(--text-secondary)', marginBottom: '0.25rem', textTransform: 'uppercase', letterSpacing: '0.04em' };
        // #115: ₹1 minimum is sensible for a clinic; reject 0/blank/negative
        // before the POST so users get a clear inline error instead of a
        // server-side 400 with no explanation.
        const priceNum = Number(form.basePrice);
        const validPrice = Number.isFinite(priceNum) && priceNum >= 1;
        const valid = !!form.name?.trim() && validPrice && Number(form.durationMin) > 0;
        const onSubmit = (e) => {
          if (!valid) {
            e.preventDefault();
            notify.error('Please enter a service name, a base price of at least ₹1, and a positive duration.');
            return;
          }
          submit(e);
        };
        return (
          <form onSubmit={onSubmit} className="glass" style={{ padding: '1rem', marginBottom: '1rem', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem' }}>
            <div>
              <label style={fieldLabel}>Service name <span style={{ color: '#ef4444' }}>*</span></label>
              <input placeholder="e.g. Hair Transplant" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={inputStyle} />
            </div>
            <div>
              <label style={fieldLabel}>Category</label>
              <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} style={inputStyle}>
                {['hair', 'skin', 'aesthetics', 'slimming', 'ayurveda', 'salon'].map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label style={fieldLabel}>Ticket tier</label>
              <select value={form.ticketTier} onChange={(e) => setForm({ ...form, ticketTier: e.target.value })} style={inputStyle}>
                <option value="low">Low tier</option>
                <option value="medium">Medium tier</option>
                <option value="high">High tier</option>
              </select>
              {/* #364: explain tier semantics inline so the dropdown isn't a guessing game. */}
              <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '0.3rem', lineHeight: 1.4 }}>
                LOW = quick consult / under ₹2K · MED = standard treatment / ₹2K-₹10K · HIGH = procedure / ₹10K+
              </div>
            </div>
            <div>
              <label style={fieldLabel}>Base price (₹) <span style={{ color: '#ef4444' }}>*</span></label>
              <input type="number" min="1" step="1" placeholder="e.g. 5000" value={form.basePrice} onChange={(e) => setForm({ ...form, basePrice: parseFloat(e.target.value) || 0 })} style={inputStyle} />
            </div>
            <div>
              <label style={fieldLabel}>Duration (min)</label>
              {/* #316: NumberInput intercepts the Ctrl+A→Delete→retype concat bug.
                  We pass the raw string through to setForm so the input remains
                  fully controlled even mid-edit (no flicker back to the old value). */}
              <NumberInput min="1" placeholder="e.g. 60" value={form.durationMin} onChange={(e) => setForm({ ...form, durationMin: e.target.value === '' ? '' : (parseInt(e.target.value) || 30) })} style={inputStyle} />
            </div>
            <div>
              <label style={fieldLabel}>Marketing radius (km)</label>
              <input type="number" min="0" placeholder="blank = unlimited" value={form.targetRadiusKm || ''} onChange={(e) => setForm({ ...form, targetRadiusKm: e.target.value ? parseInt(e.target.value) : null })} style={inputStyle} />
            </div>
            <div style={{ gridColumn: 'span 2', display: 'flex', alignItems: 'flex-end' }}>
              <button
                type="submit"
                disabled={!valid}
                title={!valid ? 'Name + base price > 0 are required' : ''}
                style={{
                  padding: '0.55rem 1rem',
                  background: valid ? 'var(--success-color)' : 'rgba(107,114,128,0.3)',
                  color: '#fff', border: 'none', borderRadius: 8,
                  cursor: valid ? 'pointer' : 'not-allowed',
                  opacity: valid ? 1 : 0.6,
                  width: '100%',
                }}
              >
                Save
              </button>
            </div>
          </form>
        );
      })()}

      {loading && <div>Loading…</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '1rem' }}>
        {services.map((s) => (
          <ServiceCard key={s.id} service={s} onChanged={onChanged} />
        ))}
      </div>
    </>
  );
}

function ServiceCard({ service, onChanged }) {
  const notify = useNotify();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(service);
  const [saving, setSaving] = useState(false);

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
      // #274 #275: fetchApi auto-toasts the server error message (e.g.
      // "Insufficient wellness role" on 403). Page emits the success toast.
      await fetchApi(`/api/wellness/services/${service.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: draft.name, category: draft.category, ticketTier: draft.ticketTier,
          basePrice: price,
          durationMin: duration,
          targetRadiusKm: radius,
          description: draft.description || null,
          isActive: draft.isActive !== false,
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
        <div style={{ display: 'flex', gap: '0.4rem' }}>
          <button onClick={save} disabled={saving} style={{ flex: 1, padding: '0.5rem', background: 'var(--success-color)', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.3rem' }}>
            <Save size={14} /> {saving ? 'Saving…' : 'Save'}
          </button>
          <button onClick={() => { setEditing(false); setDraft(service); }} style={{ padding: '0.5rem 0.75rem', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 6, cursor: 'pointer' }}>
            <X size={14} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="glass" style={{ padding: '1.25rem', position: 'relative' }}>
      <div style={{ position: 'absolute', top: '0.5rem', right: '0.5rem', display: 'flex', gap: '0.25rem' }}>
        <button onClick={() => setEditing(true)} title="Edit" style={iconBtn}><Pencil size={12} /></button>
        <button onClick={remove} title="Deactivate" style={{ ...iconBtn, color: 'var(--danger-color)' }}><Trash2 size={12} /></button>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.5rem', paddingRight: '3rem' }}>
        <div>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{service.category}</div>
          <h3 style={{ fontSize: '1rem', fontWeight: 600, marginTop: '0.15rem' }}>{service.name}</h3>
        </div>
        <span style={{ background: tierColor[service.ticketTier], color: '#fff', padding: '0.15rem 0.5rem', borderRadius: 4, fontSize: '0.65rem', textTransform: 'uppercase', fontWeight: 600 }}>
          {service.ticketTier}
        </span>
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

function TreatmentDetailModal({ treatment, onClose, onChanged }) {
  const notify = useNotify();
  const statusLabel = treatment.status ? treatment.status.charAt(0).toUpperCase() + treatment.status.slice(1) : 'Active';
  const progressPercent = treatment.totalSessions > 0 ? Math.round((treatment.completedSessions / treatment.totalSessions) * 100) : 0;
  const nextDueDate = treatment.nextDueAt ? new Date(treatment.nextDueAt).toLocaleDateString('en-IN') : 'Not scheduled';
  const startDate = new Date(treatment.startedAt).toLocaleDateString('en-IN');

  const updateStatus = async (newStatus) => {
    try {
      await fetchApi(`/api/wellness/treatment-plans/${treatment.id}`, {
        method: 'PUT',
        body: JSON.stringify({ status: newStatus }),
      });
      notify.success(`Treatment plan marked as ${newStatus}`);
      onChanged && onChanged();
    } catch (_err) { /* fetchApi already surfaced the message */ }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
    }} onClick={onClose}>
      <div className="glass" style={{ maxWidth: '600px', width: '90%', maxHeight: '80vh', overflow: 'auto', padding: '2rem', position: 'relative' }} onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} style={{ position: 'absolute', top: '1rem', right: '1rem', background: 'transparent', border: 'none', fontSize: '1.5rem', cursor: 'pointer', color: 'var(--text-secondary)' }}>×</button>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: '1.5rem', gap: '1rem' }}>
          <div>
            <h2 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '0.25rem' }}>{treatment.name}</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>Treatment Plan Details</p>
          </div>
          <span style={{ background: statusColor[treatment.status] || statusColor.active, color: '#fff', padding: '0.4rem 0.8rem', borderRadius: 6, fontSize: '0.8rem', textTransform: 'uppercase', fontWeight: 600, whiteSpace: 'nowrap' }}>
            {statusLabel}
          </span>
        </div>

        {/* Patient Information */}
        <Section title="Patient Information">
          <DetailRow label="Name" value={treatment.patient?.name || 'N/A'} />
          <DetailRow label="Email" value={treatment.patient?.email || 'N/A'} />
          <DetailRow label="Phone" value={treatment.patient?.phone || 'N/A'} />
          <DetailRow label="Gender" value={treatment.patient?.gender || 'N/A'} />
          <DetailRow label="Blood Group" value={treatment.patient?.bloodGroup || 'N/A'} />
          <DetailRow label="Date of Birth" value={treatment.patient?.dob ? new Date(treatment.patient.dob).toLocaleDateString('en-IN') : 'N/A'} />
          {treatment.patient?.allergies && <DetailRow label="Allergies" value={treatment.patient.allergies} />}
          {treatment.patient?.notes && <DetailRow label="Notes" value={treatment.patient.notes} />}
        </Section>

        {/* Service Information */}
        {treatment.service && (
          <Section title="Service Information">
            <DetailRow label="Service Name" value={treatment.service.name} />
            <DetailRow label="Category" value={treatment.service.category} />
            <DetailRow label="Base Price" value={`₹${treatment.service.basePrice.toLocaleString('en-IN')}`} />
            <DetailRow label="Duration" value={`${treatment.service.durationMin} minutes`} />
            <DetailRow label="Target Radius" value={treatment.service.targetRadiusKm ? `${treatment.service.targetRadiusKm} km` : 'Unlimited'} />
            {treatment.service.description && <DetailRow label="Description" value={treatment.service.description} />}
          </Section>
        )}

        {/* Treatment Plan Details */}
        <Section title="Treatment Plan Details">
          <DetailRow label="Total Sessions" value={treatment.totalSessions} />
          <DetailRow label="Completed Sessions" value={treatment.completedSessions} />
          <DetailRow label="Progress" value={`${progressPercent}%`} />
          <DetailRow label="Total Price" value={`₹${treatment.totalPrice?.toLocaleString('en-IN') || '0'}`} />
          <DetailRow label="Start Date" value={startDate} />
          <DetailRow label="Next Due Date" value={nextDueDate} />
        </Section>

        {/* Progress Bar */}
        <div style={{ marginBottom: '1.5rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
            <span style={{ fontSize: '0.9rem', fontWeight: 600 }}>Session Progress</span>
            <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{treatment.completedSessions}/{treatment.totalSessions}</span>
          </div>
          <div style={{ background: 'rgba(255,255,255,0.05)', borderRadius: 8, height: '12px', overflow: 'hidden' }}>
            <div style={{ background: statusColor[treatment.status] || statusColor.active, height: '100%', width: `${progressPercent}%`, transition: 'width 0.3s ease' }} />
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          <button onClick={() => updateStatus(treatment.status === 'active' ? 'paused' : 'active')} style={{ flex: 1, padding: '0.75rem', background: 'var(--accent-color)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600 }}>
            {treatment.status === 'active' ? '⏸ Pause' : '▶ Resume'}
          </button>
          <button onClick={() => updateStatus('completed')} style={{ flex: 1, padding: '0.75rem', background: 'var(--success-color)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600 }}>
            ✓ Mark Complete
          </button>
          <button onClick={() => updateStatus('cancelled')} style={{ flex: 1, padding: '0.75rem', background: 'var(--danger-color)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600 }}>
            ✕ Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: '1.5rem' }}>
      <h3 style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '0.75rem', paddingBottom: '0.5rem', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
        {title}
      </h3>
      <div style={{ display: 'grid', gap: '0.5rem' }}>
        {children}
      </div>
    </div>
  );
}

function DetailRow({ label, value }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '150px 1fr', gap: '1rem', fontSize: '0.9rem', paddingBottom: '0.5rem' }}>
      <span style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>{label}</span>
      <span style={{ color: 'var(--text-primary)', wordBreak: 'break-word' }}>{value}</span>
    </div>
  );
}

const iconBtn = { background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', color: 'var(--text-secondary)', padding: '0.25rem', borderRadius: 4, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' };

function PackageBuilder({ services }) {
  const notify = useNotify();
  // Prefer high-tier services for packages, fall back to all.
  const eligible = useMemo(() => {
    const hi = services.filter((s) => s.ticketTier === 'high');
    return hi.length ? hi : services;
  }, [services]);

  const [serviceId, setServiceId] = useState('');
  const [sessions, setSessions] = useState(6);
  const [discount, setDiscount] = useState(15);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!serviceId && eligible.length) setServiceId(String(eligible[0].id));
  }, [eligible, serviceId]);

  const service = eligible.find((s) => String(s.id) === String(serviceId));
  const gross = service ? service.basePrice * sessions : 0;
  const savings = Math.round((gross * discount) / 100);
  const net = Math.round(gross - savings);

  const pitch = service
    ? `${service.name} × ${sessions} sessions = ₹${net.toLocaleString('en-IN')} (${discount}% off)`
    : '';

  const copyPitch = async () => {
    if (!pitch) return;
    try {
      await navigator.clipboard.writeText(pitch);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Fallback — legacy textarea copy
      const ta = document.createElement('textarea');
      ta.value = pitch;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      } catch {
        notify.error('Could not copy');
      }
      ta.remove();
    }
  };

  return (
    <div id="package-builder-anchor" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '1.25rem' }}>
      <div className="glass" style={{ padding: '1.5rem' }}>
        <h2 style={{ fontSize: '1rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '1rem' }}>
          <Package size={16} /> Build a package
        </h2>

        <label style={labelStyle}>Service</label>
        <select value={serviceId} onChange={(e) => setServiceId(e.target.value)} style={inputStyle}>
          {eligible.length === 0 && <option value="">No services available</option>}
          {eligible.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} — ₹{s.basePrice.toLocaleString('en-IN')} ({s.ticketTier})
            </option>
          ))}
        </select>

        <label style={{ ...labelStyle, marginTop: '1rem' }}>
          Sessions: <strong>{sessions}</strong>
        </label>
        <input
          type="range"
          min={2}
          max={12}
          step={1}
          value={sessions}
          onChange={(e) => setSessions(parseInt(e.target.value, 10))}
          style={{ width: '100%' }}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
          <span>2</span>
          <span>12</span>
        </div>

        <label style={{ ...labelStyle, marginTop: '1rem' }}>
          Discount: <strong>{discount}%</strong>
        </label>
        <input
          type="range"
          min={0}
          max={50}
          step={1}
          value={discount}
          onChange={(e) => setDiscount(parseInt(e.target.value, 10))}
          style={{ width: '100%' }}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
          <span>0%</span>
          <span>50%</span>
        </div>
      </div>

      <div className="glass" style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <h2 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.25rem' }}>Package summary</h2>

        {!service ? (
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>Pick a service to see pricing.</div>
        ) : (
          <>
            <Row label="Per session">₹{service.basePrice.toLocaleString('en-IN')}</Row>
            <Row label="Sessions">{sessions}</Row>
            <Row label="Gross total">₹{gross.toLocaleString('en-IN')}</Row>
            <Row label={`Discount (${discount}%)`} negative>
              − ₹{savings.toLocaleString('en-IN')}
            </Row>
            <div
              style={{
                borderTop: '1px solid rgba(255,255,255,0.08)',
                paddingTop: '0.75rem',
                marginTop: '0.5rem',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
              }}
            >
              <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Package price</div>
              <div style={{ fontSize: '1.6rem', fontWeight: 700, color: 'var(--accent-color)' }}>
                ₹{net.toLocaleString('en-IN')}
              </div>
            </div>

            <div
              style={{
                marginTop: '0.5rem',
                padding: '0.75rem',
                background: 'rgba(255,255,255,0.04)',
                borderRadius: 8,
                fontSize: '0.85rem',
                fontStyle: 'italic',
                color: 'var(--text-secondary)',
              }}
            >
              “{pitch}”
            </div>

            <button
              onClick={copyPitch}
              style={{
                marginTop: '0.25rem',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.4rem',
                padding: '0.6rem 1rem',
                background: copied ? 'var(--success-color)' : 'var(--accent-color)',
                border: 'none',
                borderRadius: 8,
                color: '#fff',
                fontSize: '0.9rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? 'Copied!' : 'Copy pitch'}
            </button>

            <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textAlign: 'center' }}>
              Packages are computed on the fly — no DB record is created.
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Row({ label, children, negative }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.9rem' }}>
      <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <span style={{ color: negative ? '#f59e0b' : 'var(--text-primary)' }}>{children}</span>
    </div>
  );
}

function ActiveTreatmentsTab({ treatments, loading, onChanged, onSelectTreatment }) {
  return (
    <>
      <h2 style={srOnly}>Active treatment plans</h2>
      {loading && <div>Loading treatment plans…</div>}
      {!loading && treatments.length === 0 && (
        <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>
          No active treatment plans yet.
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '1rem' }}>
        {treatments.map((t) => (
          <TreatmentCard key={t.id} treatment={t} onChanged={onChanged} onSelect={onSelectTreatment} />
        ))}
      </div>
    </>
  );
}

function TreatmentCard({ treatment, onChanged, onSelect }) {
  const notify = useNotify();
  const statusLabel = treatment.status ? treatment.status.charAt(0).toUpperCase() + treatment.status.slice(1) : 'Active';
  const progressPercent = treatment.totalSessions > 0 ? Math.round((treatment.completedSessions / treatment.totalSessions) * 100) : 0;
  const nextDueDate = treatment.nextDueAt ? new Date(treatment.nextDueAt).toLocaleDateString('en-IN') : 'Not scheduled';
  const startDate = new Date(treatment.startedAt).toLocaleDateString('en-IN');

  const updateStatus = async (newStatus) => {
    try {
      await fetchApi(`/api/wellness/treatment-plans/${treatment.id}`, {
        method: 'PUT',
        body: JSON.stringify({ status: newStatus }),
      });
      notify.success(`Treatment plan marked as ${newStatus}`);
      onChanged && onChanged();
    } catch (_err) { /* fetchApi already surfaced the message */ }
  };

  const handleCancel = async () => {
    if (!await notify.confirm({
      message: `Cancel this treatment plan for ${treatment.patient?.name}?`,
      destructive: true,
      confirmText: 'Cancel Plan'
    })) return;
    await updateStatus('cancelled');
  };

  return (
    <div className="glass" style={{ padding: '1.25rem', position: 'relative', cursor: 'pointer', transition: 'all 0.3s ease' }} onClick={() => onSelect(treatment)}>
      <div style={{ position: 'absolute', top: '0.5rem', right: '0.5rem', display: 'flex', gap: '0.25rem' }}>
        <button onClick={() => updateStatus(treatment.status === 'active' ? 'paused' : 'active')} title={treatment.status === 'active' ? 'Pause' : 'Resume'} style={iconBtn}>
          <Clock size={12} />
        </button>
        <button onClick={handleCancel} title="Cancel" style={{ ...iconBtn, color: 'var(--danger-color)' }}>
          <Trash2 size={12} />
        </button>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.5rem', paddingRight: '3rem' }}>
        <div>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {treatment.patient?.name}
          </div>
          <h3 style={{ fontSize: '1rem', fontWeight: 600, marginTop: '0.15rem' }}>{treatment.name}</h3>
        </div>
        <span style={{ background: statusColor[treatment.status] || statusColor.active, color: '#fff', padding: '0.15rem 0.5rem', borderRadius: 4, fontSize: '0.65rem', textTransform: 'uppercase', fontWeight: 600 }}>
          {statusLabel}
        </span>
      </div>
      <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
        <span><IndianRupee size={12} style={{ verticalAlign: 'middle' }} /> {treatment.totalPrice?.toLocaleString('en-IN') || '0'}</span>
        <span><Clock size={12} style={{ verticalAlign: 'middle' }} /> {treatment.completedSessions}/{treatment.totalSessions} sessions</span>
        <span><MapPin size={12} style={{ verticalAlign: 'middle' }} /> Due: {nextDueDate}</span>
      </div>

      {/* Progress bar */}
      <div style={{ marginTop: '0.75rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem' }}>
          <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>Progress</span>
          <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', fontWeight: 600 }}>{progressPercent}%</span>
        </div>
        <div style={{ background: 'rgba(255,255,255,0.05)', borderRadius: 4, height: '6px', overflow: 'hidden' }}>
          <div style={{ background: statusColor[treatment.status] || statusColor.active, height: '100%', width: `${progressPercent}%`, transition: 'width 0.3s ease' }} />
        </div>
      </div>

      {treatment.service && (
        <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.5rem' }}>
          <strong>Service:</strong> {treatment.service.name}
        </p>
      )}
    </div>
  );
}

const inputStyle = { padding: '0.5rem 0.75rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, color: 'var(--text-primary)', fontSize: '0.9rem', outline: 'none', width: '100%', boxSizing: 'border-box' };

const labelStyle = {
  display: 'block',
  fontSize: '0.75rem',
  color: 'var(--text-secondary)',
  marginBottom: '0.35rem',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};

// Visually-hidden style for screen-reader-only headings (a11y heading hierarchy).
const srOnly = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  padding: 0,
  margin: '-1px',
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
};
