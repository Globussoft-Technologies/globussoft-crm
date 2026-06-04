import { useMemo, useState } from 'react';
import { usePermissions } from '../../../hooks/usePermissions';
import { useNotify } from '../../../utils/notify';
import { currencySymbol } from '../../../utils/money';
// #316: NumberInput strips the `<oldValue><newTyped>` concatenation artifact
// users hit when doing Ctrl+A → Delete → retype on number fields.
import { NumberInput } from '../../../utils/numberInput';
import { inputStyle, srOnly, TICKET_TIER_OPTIONS } from './shared';
import ServiceCard from './ServiceCard';
import MultiSelectDropdown from './MultiSelectDropdown';
import SingleSelectDropdown from './SingleSelectDropdown';
import ImageUploadField from './ImageUploadField';

export default function CatalogTab({ services, loading, categories, categoriesLoading, showAdd, form, setForm, submit, onChanged, onOpenService, editRequestId, clearEditRequest }) {
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
