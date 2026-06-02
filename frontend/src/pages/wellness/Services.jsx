import { useEffect, useMemo, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
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
  ChevronDown,
  Upload,
} from 'lucide-react';
import { fetchApi, getAuthToken } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { usePermissions } from '../../hooks/usePermissions';

// Parse Service.imageUrls (Prisma stores a JSON-stringified array of URLs).
// `allImagesOf` returns the full array; `firstImageOf` is a convenience
// wrapper used by the card thumbnail + the inline edit-form preview.
// Tolerates both array and string-encoded shapes — older rows may carry
// either form, and a few legacy rows hold a plain non-JSON URL.
function allImagesOf(service) {
  const raw = service?.imageUrls;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(Boolean);
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter(Boolean);
  } catch {
    if (typeof raw === 'string' && /^https?:\/\//i.test(raw)) return [raw];
  }
  return [];
}
function firstImageOf(service) {
  return allImagesOf(service)[0] || null;
}

// POST a file to /api/wellness/upload/service-image and return the URL.
// Mirrors the multipart pattern used by Products.jsx — same `file` field
// name, same response shape, same backend uploadImage() helper.
async function uploadImageFile(file) {
  const token = getAuthToken();
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch('/api/wellness/upload/service-image', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: fd,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Upload failed (${res.status})`);
  }
  const data = await res.json();
  return data.url;
}
import { formatMoney, currencySymbol } from '../../utils/money';
import { formatDate } from '../../utils/date';
// #316: NumberInput strips the `<oldValue><newTyped>` concatenation artifact
// users hit when doing Ctrl+A → Delete → retype on number fields.
import { NumberInput } from '../../utils/numberInput';
// Issue #816: Reusable CSV import/export toolbar for the Catalog + Packages tabs.
import CsvImportExportToolbar from '../../components/wellness/CsvImportExportToolbar';

const tierColor = { high: '#ef4444', medium: '#f59e0b', low: '#64748b' };
const TICKET_TIER_OPTIONS = [
  { value: 'low', label: 'Low tier' },
  { value: 'medium', label: 'Medium tier' },
  { value: 'high', label: 'High tier' },
];
const statusColor = { active: '#10b981', completed: '#6366f1', paused: '#f59e0b', cancelled: '#ef4444' };

export default function Services() {
  const notify = useNotify();
  // Backend gates POST/PUT/DELETE on adminOrPerm('services', 'write').
  // One flag for everything since this route doesn't split write/update/delete.
  const { hasPermission, isReady: permsReady } = usePermissions();
  const canManageServices = permsReady && hasPermission('services', 'write');
  const [searchParams] = useSearchParams();
  const initialTab = searchParams.get('tab') || 'catalog';
  const [tab, setTab] = useState(initialTab); // catalog | packages | activetreatments
  const [services, setServices] = useState([]);
  const [categories, setCategories] = useState([]);
  const [treatments, setTreatments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [categoriesLoading, setCategoriesLoading] = useState(true);
  const [treatmentsLoading, setTreatmentsLoading] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [selectedTreatment, setSelectedTreatment] = useState(null);
  const [selectedService, setSelectedService] = useState(null);
  // When the modal's "Edit" button fires, we close the modal AND tell the
  // matching ServiceCard to flip into edit mode. The card watches this id
  // via a useEffect + clears it on consumption, so the next modal-edit
  // click works repeatedly.
  const [editRequestId, setEditRequestId] = useState(null);
  // #115: basePrice starts blank (not 0) so the placeholder shows and the
  // validity gate rejects submit until the user enters ≥ ₹1.
  const [form, setForm] = useState({ name: '', categoryIds: [], ticketTier: 'medium', basePrice: '', durationMin: 60, targetRadiusKm: 30, description: '', imageUrl: '' });

  const load = () => {
    setLoading(true);
    fetchApi('/api/wellness/services').then(setServices).catch(() => setServices([])).finally(() => setLoading(false));
  };

  const loadCategories = () => {
    setCategoriesLoading(true);
    fetchApi('/api/wellness/service-categories?limit=1000')
      .then(res => setCategories(res.sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => setCategories([]))
      .finally(() => setCategoriesLoading(false));
  };

  const loadTreatments = () => {
    setTreatmentsLoading(true);
    fetchApi('/api/wellness/activetreatment').then(res => setTreatments(res.data || [])).catch(() => setTreatments([])).finally(() => setTreatmentsLoading(false));
  };

  useEffect(() => {
    load();
    loadCategories();
  }, []);
  useEffect(() => {
    if (tab === 'activetreatments') {
      loadTreatments();
    }
  }, [tab]);

  const submit = async (e) => {
    e.preventDefault();
    try {
      // Use first category as primary categoryId for backend compatibility.
      // imageUrls is a JSON array column — backend stringifies for us when
      // we pass an array.
      const submitData = {
        ...form,
        categoryId: form.categoryIds?.[0] || null,
        imageUrls: form.imageUrl ? [form.imageUrl] : null,
      };
      delete submitData.imageUrl;
      await fetchApi('/api/wellness/services', { method: 'POST', body: JSON.stringify(submitData) });
      notify.success(`Service "${form.name}" created`);
      setShowAdd(false);
      setForm({ name: '', categoryIds: [], ticketTier: 'medium', basePrice: '', durationMin: 60, targetRadiusKm: 30, description: '', imageUrl: '' });
      load();
    } catch (_err) { /* fetchApi already toasted */ }
  };

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <Sparkles size={24} /> Service catalog
            {permsReady && !canManageServices && (
              <span
                title="You can view services but can't make changes."
                style={{ fontSize: '0.7rem', padding: '0.2rem 0.55rem', borderRadius: 999, background: 'var(--subtle-bg)', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', fontWeight: 500 }}
              >
                View only
              </span>
            )}
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>Each service has a price, duration, and target marketing radius.</p>
        </div>
        {tab === 'catalog' && canManageServices && (
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
            {/* Issue #816: services CSV. No active filter, so we pass an empty
                filters object — the export reflects the same all-active view
                as the catalog tab. CsvImportExportToolbar wraps Import POST
                and the destructive backend hits services.write too, so it is
                gated alongside New service. */}
            <CsvImportExportToolbar entity="services" label="Services" formats={['csv', 'xlsx']} onImported={load} />
            <button onClick={() => setShowAdd(!showAdd)} style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.5rem 1rem', background: 'var(--primary-color, var(--accent-color))', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}>
              <Plus size={16} /> {showAdd ? 'Cancel' : 'New service'}
            </button>
          </div>
        )}
        {tab === 'packages' && canManageServices && (
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
            {/* Issue #816: packages CSV. */}
            <CsvImportExportToolbar entity="packages" label="Packages" formats={['csv', 'xlsx']} />
          </div>
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
          categories={categories}
          categoriesLoading={categoriesLoading}
          showAdd={showAdd}
          form={form}
          setForm={setForm}
          submit={submit}
          onChanged={load}
          onOpenService={setSelectedService}
          editRequestId={editRequestId}
          clearEditRequest={() => setEditRequestId(null)}
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

      {selectedService && (
        <ServiceDetailModal
          service={selectedService}
          categories={categories}
          onClose={() => setSelectedService(null)}
          onEdit={(svc) => {
            setSelectedService(null);
            setEditRequestId(svc.id);
          }}
          onChanged={load}
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

function CatalogTab({ services, loading, categories, categoriesLoading, showAdd, form, setForm, submit, onChanged, onOpenService, editRequestId, clearEditRequest }) {
  const { hasPermission, isReady: permsReady } = usePermissions();
  const canManageServices = permsReady && hasPermission('services', 'write');
  const notify = useNotify();
  // Sort selector — backend returns services in its default order (name
  // alphabetical). Users asked for a "newest first" option so the most
  // recently added service is easy to find without scrolling. Sorting
  // happens client-side over the already-fetched list so the toggle is
  // instant (no re-fetch).
  const [sortBy, setSortBy] = useState('default');
  const sortedServices = useMemo(() => {
    if (!Array.isArray(services)) return [];
    if (sortBy === 'default') return services;
    const tsOf = (s) => {
      const t = s?.createdAt ? new Date(s.createdAt).getTime() : 0;
      return Number.isFinite(t) ? t : 0;
    };
    const copy = [...services];
    if (sortBy === 'newest') copy.sort((a, b) => tsOf(b) - tsOf(a));
    if (sortBy === 'oldest') copy.sort((a, b) => tsOf(a) - tsOf(b));
    return copy;
  }, [services, sortBy]);

  return (
    <>
      {/* Visually-hidden section heading so screen readers see h1 -> h2 hierarchy
          before the per-service h3 cards (a11y: heading-order). */}
      <h2 style={srOnly}>Available services</h2>
      {showAdd && canManageServices && (() => {
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
            notify.error(`Please enter a service name, a base price of at least ${currencySymbol()}1, and a positive duration.`);
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
              <MultiSelectDropdown
                categories={categories}
                categoriesLoading={categoriesLoading}
                selectedIds={form.categoryIds}
                onChange={(ids) => setForm({ ...form, categoryIds: ids })}
              />
            </div>
            <div>
              <label style={fieldLabel}>Ticket tier</label>
              <SingleSelectDropdown
                value={form.ticketTier}
                onChange={(v) => setForm({ ...form, ticketTier: v })}
                options={TICKET_TIER_OPTIONS}
              />
              {/* #364: explain tier semantics inline so the dropdown isn't a guessing game. */}
              <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '0.3rem', lineHeight: 1.4 }}>
                LOW = quick consult / under {currencySymbol()}2K · MED = standard treatment / {currencySymbol()}2K-{currencySymbol()}10K · HIGH = procedure / {currencySymbol()}10K+
              </div>
            </div>
            <div>
              <label style={fieldLabel}>Base price ({currencySymbol()}) <span style={{ color: '#ef4444' }}>*</span></label>
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
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={fieldLabel}>Service image</label>
              <ImageUploadField
                imageUrl={form.imageUrl}
                onChange={(url) => setForm({ ...form, imageUrl: url })}
              />
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

      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          alignItems: 'center',
          gap: '0.5rem',
          marginBottom: '0.75rem',
        }}
      >
        <label
          htmlFor="services-sort"
          style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}
        >
          Sort by
        </label>
        <select
          id="services-sort"
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value)}
          aria-label="Sort services"
          style={{
            padding: '0.4rem 0.7rem',
            background: 'var(--surface-color)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border-color)',
            borderRadius: 8,
            fontSize: '0.85rem',
            cursor: 'pointer',
            outline: 'none',
          }}
        >
          <option value="default" style={{ background: 'var(--bg-color)', color: 'var(--text-primary)' }}>Default</option>
          <option value="newest" style={{ background: 'var(--bg-color)', color: 'var(--text-primary)' }}>Newest first</option>
          <option value="oldest" style={{ background: 'var(--bg-color)', color: 'var(--text-primary)' }}>Oldest first</option>
        </select>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '1rem' }}>
        {sortedServices.map((s) => (
          <ServiceCard
            key={s.id}
            service={s}
            onChanged={onChanged}
            onOpen={onOpenService}
            editRequested={editRequestId === s.id}
            onEditConsumed={clearEditRequest}
          />
        ))}
      </div>
    </>
  );
}

function ServiceCard({ service, onChanged, onOpen, editRequested, onEditConsumed }) {
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

function ServiceDetailModal({ service, categories, onClose, onChanged, onEdit }) {
  const notify = useNotify();
  const { hasPermission, isReady: permsReady } = usePermissions();
  const canManageServices = permsReady && hasPermission('services', 'write');
  const images = allImagesOf(service);
  const [activeIdx, setActiveIdx] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const activeImage = images[Math.min(activeIdx, images.length - 1)];
  const categoryName = (() => {
    const cat = (categories || []).find((c) => c.id === service.categoryId);
    return cat?.name || service.category || '—';
  })();

  const handleDelete = async () => {
    if (deleting) return;
    if (!await notify.confirm({ message: `Deactivate "${service.name}"? It won't show in the catalog or booking page.`, destructive: true, confirmText: 'Deactivate' })) return;
    setDeleting(true);
    try {
      await fetchApi(`/api/wellness/services/${service.id}`, {
        method: 'PUT',
        body: JSON.stringify({ isActive: false }),
      });
      notify.success(`Deactivated "${service.name}"`);
      onChanged && onChanged();
      onClose && onClose();
    } catch (_err) { /* fetchApi already surfaced the message */ }
    setDeleting(false);
  };

  // Close on Escape + lock page scroll so the modal is the focus point.
  // A previous version rendered the backdrop inline and a Layout-level
  // transform/animation ancestor was making `position: fixed` resolve
  // relative to the page content instead of the viewport — i.e. the modal
  // would float somewhere near the top of the document and look invisible
  // when the user had scrolled down. Rendering through a portal into
  // document.body bypasses every ancestor containing-block, so `fixed`
  // means "the viewport" and the centered modal lands where the user
  // expects it.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return createPortal((
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '1rem' }}
      onClick={onClose}
    >
      <div className="glass" style={{ maxWidth: 720, width: '100%', maxHeight: '90vh', overflow: 'auto', padding: '1.75rem', position: 'relative' }} onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} aria-label="Close" style={{ position: 'absolute', top: '0.75rem', right: '0.75rem', background: 'transparent', border: 'none', fontSize: '1.4rem', cursor: 'pointer', color: 'var(--text-secondary)', lineHeight: 1 }}>×</button>

        {/* Image gallery — main image + thumbnail strip. If no images are
            attached we render a neutral placeholder rather than empty space. */}
        {images.length > 0 ? (
          <div style={{ marginBottom: '1.25rem' }}>
            <img
              src={activeImage}
              alt={service.name}
              style={{ width: '100%', maxHeight: 320, objectFit: 'cover', borderRadius: 10, background: 'rgba(255,255,255,0.04)' }}
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
            />
            {images.length > 1 && (
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.6rem', flexWrap: 'wrap' }}>
                {images.map((url, i) => (
                  <button
                    key={`${url}-${i}`}
                    type="button"
                    onClick={() => setActiveIdx(i)}
                    aria-label={`Show image ${i + 1}`}
                    style={{
                      padding: 0,
                      width: 60, height: 60,
                      borderRadius: 6,
                      overflow: 'hidden',
                      border: i === activeIdx ? '2px solid var(--accent-color)' : '2px solid transparent',
                      background: 'transparent',
                      cursor: 'pointer',
                    }}
                  >
                    <img src={url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div style={{ marginBottom: '1.25rem', padding: '2rem', textAlign: 'center', background: 'rgba(255,255,255,0.04)', borderRadius: 10, color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
            No images attached to this service.
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: '1rem', marginBottom: '0.75rem' }}>
          <div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {categoryName}
            </div>
            <h2 style={{ fontSize: '1.5rem', fontWeight: 700, marginTop: '0.2rem' }}>{service.name}</h2>
          </div>
          <span style={{ background: tierColor[service.ticketTier] || tierColor.medium, color: '#fff', padding: '0.25rem 0.65rem', borderRadius: 6, fontSize: '0.7rem', textTransform: 'uppercase', fontWeight: 700, whiteSpace: 'nowrap', flexShrink: 0 }}>
            {service.ticketTier}
          </span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 160px), 1fr))', gap: '0.75rem', marginBottom: '1rem' }}>
          <DetailStat icon={<IndianRupee size={14} />} label="Base price" value={service.basePrice != null ? formatMoney(service.basePrice, { maximumFractionDigits: 0 }) : '—'} />
          <DetailStat icon={<Clock size={14} />} label="Duration" value={service.durationMin ? `${service.durationMin} min` : '—'} />
          <DetailStat icon={<MapPin size={14} />} label="Marketing radius" value={service.targetRadiusKm ? `${service.targetRadiusKm} km` : 'Unlimited'} />
          <DetailStat icon={<Activity size={14} />} label="Status" value={service.isActive !== false ? 'Active' : 'Inactive'} />
        </div>

        {service.description && (
          <div style={{ marginBottom: '1rem' }}>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.3rem' }}>Description</div>
            <p style={{ fontSize: '0.9rem', lineHeight: 1.5, color: 'var(--text-primary)', margin: 0 }}>{service.description}</p>
          </div>
        )}

        {canManageServices && (
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
            <button
              type="button"
              onClick={() => onEdit && onEdit(service)}
              disabled={!onEdit}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', padding: '0.55rem 1rem', background: 'var(--primary-color, var(--accent-color))', color: '#fff', border: 'none', borderRadius: 8, cursor: onEdit ? 'pointer' : 'not-allowed', fontWeight: 600, fontSize: '0.85rem' }}
            >
              <Pencil size={14} /> Edit
            </button>
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', padding: '0.55rem 1rem', background: 'rgba(239,68,68,0.15)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.35)', borderRadius: 8, cursor: deleting ? 'wait' : 'pointer', fontWeight: 600, fontSize: '0.85rem' }}
            >
              <Trash2 size={14} /> {deleting ? 'Deactivating…' : 'Deactivate'}
            </button>
          </div>
        )}

        <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '0.75rem', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
          Service ID: {service.id} {service.createdAt && <> · Added {formatDate(service.createdAt)}</>}
        </div>
      </div>
    </div>
  ), document.body);
}

function DetailStat({ icon, label, value }) {
  return (
    <div style={{ background: 'rgba(255,255,255,0.04)', padding: '0.65rem 0.8rem', borderRadius: 8 }}>
      <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'flex', alignItems: 'center', gap: '0.3rem', marginBottom: '0.2rem' }}>
        {icon} {label}
      </div>
      <div style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--text-primary)' }}>{value}</div>
    </div>
  );
}

function TreatmentDetailModal({ treatment, onClose, onChanged }) {
  const notify = useNotify();
  const statusLabel = treatment.status ? treatment.status.charAt(0).toUpperCase() + treatment.status.slice(1) : 'Active';
  const progressPercent = treatment.totalSessions > 0 ? Math.round((treatment.completedSessions / treatment.totalSessions) * 100) : 0;
  const nextDueDate = treatment.nextDueAt ? formatDate(treatment.nextDueAt) : 'Not scheduled';
  const startDate = formatDate(treatment.startedAt);

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
          <DetailRow label="Date of Birth" value={treatment.patient?.dob ? formatDate(treatment.patient.dob) : 'N/A'} />
          {treatment.patient?.allergies && <DetailRow label="Allergies" value={treatment.patient.allergies} />}
          {treatment.patient?.notes && <DetailRow label="Notes" value={treatment.patient.notes} />}
        </Section>

        {/* Service Information */}
        {treatment.service && (
          <Section title="Service Information">
            <DetailRow label="Service Name" value={treatment.service.name} />
            <DetailRow label="Category" value={treatment.service.category} />
            <DetailRow label="Base Price" value={formatMoney(treatment.service.basePrice, { maximumFractionDigits: 0 })} />
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
          <DetailRow label="Total Price" value={formatMoney(treatment.totalPrice || 0, { maximumFractionDigits: 0 })} />
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

// Theme-adaptive glass backdrop so the Edit / Delete icons stay legible
// across BOTH dark and light themes, AND when they sit on top of a
// service image. --surface-hover resolves to a near-opaque tile in each
// theme (dark slate in dark mode, near-white in light mode) and
// --text-primary contrasts naturally with it.
const iconBtn = {
  background: 'var(--surface-hover)',
  border: '1px solid var(--border-color)',
  color: 'var(--text-primary)',
  padding: '0.3rem',
  borderRadius: 6,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  backdropFilter: 'blur(4px)',
};

// Shared upload control — preview + replace + remove. Used by the Create
// form AND the inline edit form on each service card.
function ImageUploadField({ imageUrl, onChange }) {
  const notify = useNotify();
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef(null);

  const pick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    try {
      const url = await uploadImageFile(file);
      onChange(url);
      notify.success('Image uploaded');
    } catch (err) {
      notify.error(err.message || 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
      <input ref={inputRef} type="file" accept="image/*" onChange={pick} style={{ display: 'none' }} />
      {imageUrl ? (
        <>
          <img src={imageUrl} alt="" style={{ width: 56, height: 56, borderRadius: 6, objectFit: 'cover', border: '1px solid rgba(255,255,255,0.1)' }} />
          <button type="button" onClick={() => inputRef.current?.click()} disabled={uploading} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', padding: '0.4rem 0.7rem', background: 'transparent', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 6, color: 'var(--text-primary)', cursor: 'pointer', fontSize: '0.8rem' }}>
            <Upload size={13} /> {uploading ? 'Uploading…' : 'Replace'}
          </button>
          <button type="button" onClick={() => onChange('')} title="Remove image" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', padding: '0.4rem 0.7rem', background: 'transparent', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 6, color: 'var(--danger-color, #ef4444)', cursor: 'pointer', fontSize: '0.8rem' }}>
            <X size={13} /> Remove
          </button>
        </>
      ) : (
        <button type="button" onClick={() => inputRef.current?.click()} disabled={uploading} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', padding: '0.5rem 0.8rem', background: 'transparent', border: '1px dashed rgba(255,255,255,0.2)', borderRadius: 6, color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.85rem' }}>
          <Upload size={14} /> {uploading ? 'Uploading…' : 'Upload image'}
        </button>
      )}
    </div>
  );
}

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
    ? `${service.name} × ${sessions} sessions = ${formatMoney(net, { maximumFractionDigits: 0 })} (${discount}% off)`
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
  const nextDueDate = treatment.nextDueAt ? formatDate(treatment.nextDueAt) : 'Not scheduled';
  const startDate = formatDate(treatment.startedAt);

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
      <div style={{ position: 'absolute', top: '0.5rem', right: '0.5rem', display: 'flex', gap: '0.25rem', zIndex: 10 }}>
        <button onClick={() => updateStatus(treatment.status === 'active' ? 'paused' : 'active')} title={treatment.status === 'active' ? 'Pause' : 'Resume'} style={iconBtn}>
          <Clock size={12} />
        </button>
        <button onClick={handleCancel} title="Cancel" style={{ ...iconBtn, color: 'var(--danger-color)' }}>
          <Trash2 size={12} />
        </button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '0.5rem' }}>
        <div>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {treatment.patient?.name}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem' }}>
            <h3 style={{ fontSize: '1rem', fontWeight: 600, marginTop: '0.15rem', flex: 1 }}>{treatment.name}</h3>
            <span style={{ background: statusColor[treatment.status] || statusColor.active, color: '#fff', padding: '0.15rem 0.5rem', borderRadius: 4, fontSize: '0.65rem', textTransform: 'uppercase', fontWeight: 600, flexShrink: 0, whiteSpace: 'nowrap' }}>
              {statusLabel}
            </span>
          </div>
        </div>
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

function MultiSelectDropdown({ categories, categoriesLoading, selectedIds, onChange }) {
  const [isOpen, setIsOpen] = useState(false);
  // Portal-rendered menu uses fixed positioning anchored to the button's
  // viewport rect — sidesteps the .glass parent's backdrop-filter, which
  // creates a stacking context that trapped the previous absolute-positioned
  // menu behind the sibling service cards.
  const [menuRect, setMenuRect] = useState({ top: 0, left: 0, width: 0 });
  const buttonRef = useRef(null);

  const selectedNames = categories
    .filter(cat => selectedIds.includes(cat.id))
    .map(cat => cat.name)
    .join(', ');

  const handleToggle = (catId) => {
    if (selectedIds.includes(catId)) {
      onChange(selectedIds.filter(id => id !== catId));
    } else {
      onChange([...selectedIds, catId]);
    }
  };

  const updateRect = () => {
    if (!buttonRef.current) return;
    const r = buttonRef.current.getBoundingClientRect();
    setMenuRect({ top: r.bottom + 8, left: r.left, width: r.width });
  };

  const handleOpen = () => {
    updateRect();
    setIsOpen(true);
  };

  // Re-anchor menu on scroll / resize while open.
  useEffect(() => {
    if (!isOpen) return;
    updateRect();
    window.addEventListener('scroll', updateRect, true);
    window.addEventListener('resize', updateRect);
    return () => {
      window.removeEventListener('scroll', updateRect, true);
      window.removeEventListener('resize', updateRect);
    };
  }, [isOpen]);

  // Close on escape key
  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === 'Escape' && isOpen) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
      return () => document.removeEventListener('keydown', handleEscape);
    }
  }, [isOpen]);

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <button
        ref={buttonRef}
        type="button"
        onClick={handleOpen}
        style={{
          width: '100%',
          padding: '0.6rem 0.75rem',
          // --surface-color matches the adjacent <input> background under each
          // theme (wellness.css force-overrides input bg to white in light mode;
          // buttons need the same treatment to avoid a faint teal-grey tint).
          background: 'var(--surface-color, rgba(255,255,255,0.04))',
          border: isOpen
            ? '1px solid var(--primary-color, var(--accent-color))'
            : '1px solid var(--border-color, rgba(255,255,255,0.1))',
          borderRadius: '6px',
          color: 'var(--text-primary)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          cursor: 'pointer',
          fontSize: '0.9rem',
          transition: 'border-color 0.2s, background 0.2s',
        }}
      >
        <span style={{ textAlign: 'left', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {categoriesLoading ? 'Loading...' : selectedNames || 'Select categories...'}
        </span>
        <ChevronDown size={16} style={{ marginLeft: '0.5rem', flexShrink: 0, transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }} />
      </button>

      {isOpen && createPortal(
        <>
          {/* Backdrop overlay - closes dropdown on click */}
          <div
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 9998,
            }}
            onClick={() => setIsOpen(false)}
          />

          {/* Dropdown menu — themed via CSS vars so light + dark mode both render legibly */}
          <div
            style={{
              position: 'fixed',
              top: menuRect.top,
              left: menuRect.left,
              width: menuRect.width,
              maxHeight: '340px',
              background: 'var(--bg-color)',
              border: '1px solid var(--border-color)',
              borderRadius: '8px',
              overflow: 'hidden',
              boxShadow: 'var(--shadow-lg, 0 20px 25px -5px rgba(0,0,0,0.25), 0 10px 10px -5px rgba(0,0,0,0.15))',
              zIndex: 10000,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            {/* Scrollable content area */}
            <div
              style={{
                overflowY: 'auto',
                overflowX: 'hidden',
                flex: 1,
              }}
            >
              {categoriesLoading ? (
                <div style={{ padding: '1rem', color: 'var(--text-secondary)', textAlign: 'center', fontSize: '0.9rem' }}>
                  Loading categories...
                </div>
              ) : categories.length === 0 ? (
                <div style={{ padding: '1rem', color: 'var(--text-secondary)', textAlign: 'center', fontSize: '0.9rem' }}>
                  No categories available
                </div>
              ) : (
                categories.map((cat, idx) => {
                  const isSelected = selectedIds.includes(cat.id);
                  return (
                    <label
                      key={cat.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.75rem',
                        padding: '0.65rem 1rem',
                        cursor: 'pointer',
                        borderBottom: idx < categories.length - 1 ? '1px solid var(--border-light, var(--border-color))' : 'none',
                        transition: 'background 0.15s ease',
                        backgroundColor: isSelected ? 'var(--subtle-bg-3, var(--accent-bg))' : 'transparent',
                      }}
                      onMouseEnter={(e) => {
                        if (!isSelected) {
                          e.currentTarget.style.backgroundColor = 'var(--hover-bg, var(--subtle-bg))';
                        }
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = isSelected ? 'var(--subtle-bg-3, var(--accent-bg))' : 'transparent';
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => handleToggle(cat.id)}
                        style={{
                          cursor: 'pointer',
                          accentColor: 'var(--primary-color, var(--accent-color))',
                          width: '16px',
                          height: '16px',
                          flexShrink: 0,
                        }}
                      />
                      <span style={{ fontSize: '0.9rem', color: 'var(--text-primary)', fontWeight: isSelected ? 500 : 400 }}>{cat.name}</span>
                    </label>
                  );
                })
              )}
            </div>

            {/* Footer with count */}
            {selectedIds.length > 0 && (
              <div
                style={{
                  padding: '0.65rem 1rem',
                  borderTop: '1px solid var(--border-light, var(--border-color))',
                  fontSize: '0.8rem',
                  color: 'var(--text-secondary)',
                  backgroundColor: 'var(--subtle-bg, var(--hover-bg))',
                  textAlign: 'center',
                }}
              >
                {selectedIds.length} selected
              </div>
            )}
          </div>
        </>,
        document.body
      )}
    </div>
  );
}

// Single-select variant of MultiSelectDropdown — same portal anchoring + theme
// vars so light/dark and wellness/generic all render consistently. Replaces the
// native <select> which leaks browser-default chrome on the ticket-tier field.
function SingleSelectDropdown({ value, onChange, options }) {
  const [isOpen, setIsOpen] = useState(false);
  const [menuRect, setMenuRect] = useState({ top: 0, left: 0, width: 0 });
  const buttonRef = useRef(null);

  const selected = options.find((o) => o.value === value);
  const selectedLabel = selected ? selected.label : '';

  const updateRect = () => {
    if (!buttonRef.current) return;
    const r = buttonRef.current.getBoundingClientRect();
    setMenuRect({ top: r.bottom + 8, left: r.left, width: r.width });
  };

  const handleOpen = () => {
    updateRect();
    setIsOpen((v) => !v);
  };

  useEffect(() => {
    if (!isOpen) return;
    updateRect();
    window.addEventListener('scroll', updateRect, true);
    window.addEventListener('resize', updateRect);
    return () => {
      window.removeEventListener('scroll', updateRect, true);
      window.removeEventListener('resize', updateRect);
    };
  }, [isOpen]);

  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === 'Escape' && isOpen) setIsOpen(false);
    };
    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
      return () => document.removeEventListener('keydown', handleEscape);
    }
  }, [isOpen]);

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <button
        ref={buttonRef}
        type="button"
        onClick={handleOpen}
        style={{
          width: '100%',
          padding: '0.6rem 0.75rem',
          background: 'var(--surface-color, rgba(255,255,255,0.04))',
          border: isOpen
            ? '1px solid var(--primary-color, var(--accent-color))'
            : '1px solid var(--border-color, rgba(255,255,255,0.1))',
          borderRadius: '6px',
          color: 'var(--text-primary)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          cursor: 'pointer',
          fontSize: '0.9rem',
          transition: 'border-color 0.2s, background 0.2s',
        }}
      >
        <span style={{ textAlign: 'left', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {selectedLabel}
        </span>
        <ChevronDown size={16} style={{ marginLeft: '0.5rem', flexShrink: 0, transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }} />
      </button>

      {isOpen && createPortal(
        <>
          <div
            style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 9998 }}
            onClick={() => setIsOpen(false)}
          />
          <div
            role="listbox"
            style={{
              position: 'fixed',
              top: menuRect.top,
              left: menuRect.left,
              width: menuRect.width,
              maxHeight: '340px',
              background: 'var(--bg-color)',
              border: '1px solid var(--border-color)',
              borderRadius: '8px',
              overflow: 'hidden',
              boxShadow: 'var(--shadow-lg, 0 20px 25px -5px rgba(0,0,0,0.25), 0 10px 10px -5px rgba(0,0,0,0.15))',
              zIndex: 10000,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div style={{ overflowY: 'auto', overflowX: 'hidden', flex: 1 }}>
              {options.map((opt, idx) => {
                const isSelected = opt.value === value;
                return (
                  <div
                    key={opt.value}
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => { onChange(opt.value); setIsOpen(false); }}
                    style={{
                      padding: '0.65rem 1rem',
                      cursor: 'pointer',
                      borderBottom: idx < options.length - 1 ? '1px solid var(--border-light, var(--border-color))' : 'none',
                      transition: 'background 0.15s ease',
                      backgroundColor: isSelected ? 'var(--subtle-bg-3, var(--accent-bg))' : 'transparent',
                      fontSize: '0.9rem',
                      color: 'var(--text-primary)',
                      fontWeight: isSelected ? 500 : 400,
                    }}
                    onMouseEnter={(e) => {
                      if (!isSelected) {
                        e.currentTarget.style.backgroundColor = 'var(--hover-bg, var(--subtle-bg))';
                      }
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = isSelected ? 'var(--subtle-bg-3, var(--accent-bg))' : 'transparent';
                    }}
                  >
                    {opt.label}
                  </div>
                );
              })}
            </div>
          </div>
        </>,
        document.body
      )}
    </div>
  );
}

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
