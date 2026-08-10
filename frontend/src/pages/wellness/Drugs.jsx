/**
 * Drug catalogue admin page for the wellness vertical.
 *
 * The list is rendered inside one main card. The header is fixed, the rows
 * scroll inside the inner body, and pagination continues as the sentinel
 * enters view.
 */
import { useEffect, useRef, useState } from 'react';
import { Pill, Plus, Pencil, Trash2, Search } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import CsvImportExportToolbar from '../../components/wellness/CsvImportExportToolbar';
import PageHeader from '../../components/PageHeader';

const ICON_BTN_STYLE = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 30,
  height: 30,
  background: 'transparent',
  border: '1px solid var(--border-soft, rgba(255,255,255,0.15))',
  borderRadius: 6,
  color: 'var(--text-primary)',
  cursor: 'pointer',
  transition: 'background 0.15s, border-color 0.15s',
};

const DANGER_ICON_BTN_STYLE = {
  ...ICON_BTN_STYLE,
  color: 'var(--danger-color, #ef4444)',
};

const HEADER_GRID_TEMPLATE = 'minmax(150px, 1.35fr) minmax(180px, 1.65fr) minmax(90px, 0.9fr) minmax(90px, 0.9fr) minmax(140px, 1.25fr) minmax(90px, 0.75fr) minmax(92px, 0.6fr)';
const ROW_GRID_TEMPLATE = HEADER_GRID_TEMPLATE;
const TABLE_CELL_STYLE = {
  padding: '0.75rem 0.75rem',
  minWidth: 0,
  boxSizing: 'border-box',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  lineHeight: 1.25,
};

const TABLE_HEADER_CELL_STYLE = {
  padding: '0 0.75rem 0.55rem',
  minWidth: 0,
  boxSizing: 'border-box',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  lineHeight: 1.15,
};

const DOSAGE_FORMS = ['tablet', 'capsule', 'syrup', 'injection', 'topical', 'drops', 'inhaler', 'other'];

const EMPTY_FORM = {
  name: '',
  genericName: '',
  dosageForm: 'tablet',
  strengthValue: '',
  strengthUnit: '',
  defaultDosage: '',
  defaultFrequency: '',
  defaultDuration: '',
  notes: '',
  isActive: true,
};

export default function Drugs() {
  const notify = useNotify();
  const [drugs, setDrugs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [pageIndex, setPageIndex] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const scrollContainerRef = useRef(null);
  const sentinelRef = useRef(null);
  const requestSeqRef = useRef(0);
  const PAGE_SIZE = 8;

  const load = async ({ reset = false, nextPage = 1, query = search } = {}) => {
    const requestId = ++requestSeqRef.current;

    if (reset) {
      setLoading(true);
      setLoadingMore(false);
    } else {
      setLoadingMore(true);
    }

    try {
      const params = new URLSearchParams({
        page: String(nextPage),
        limit: String(PAGE_SIZE),
      });
      if (query?.trim()) params.set('q', query.trim());

      const data = await fetchApi(`/api/wellness/drugs?${params.toString()}`);
      if (requestId !== requestSeqRef.current) return;

      const rows = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
      const dedupe = (items) => Array.from(new Map(items.map((item) => [item.id, item])).values());

      setDrugs((current) => (reset ? rows : dedupe([...current, ...rows])));
      setTotalCount(typeof data?.total === 'number' ? data.total : rows.length);
      setHasMore(typeof data?.hasMore === 'boolean' ? data.hasMore : rows.length === PAGE_SIZE);
      setPageIndex(nextPage);
    } catch {
      if (requestId !== requestSeqRef.current) return;
      if (reset) setDrugs([]);
      setHasMore(false);
    } finally {
      if (requestId === requestSeqRef.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  };

  useEffect(() => {
    setDrugs([]);
    setHasMore(true);
    setPageIndex(1);
    setTotalCount(0);
    load({ reset: true, nextPage: 1, query: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!hasMore || loading || loadingMore) return;
    const node = sentinelRef.current;
    const root = scrollContainerRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setPageIndex((currentPage) => {
        const nextPage = currentPage + 1;
        load({ reset: false, nextPage, query: search });
        return nextPage;
      });
    }, { root, rootMargin: '300px 0px' });

    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loading, loadingMore, search]);

  const resetForm = () => {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setShowAdd(false);
  };

  const startEdit = (drug) => {
    setEditingId(drug.id);
    setForm({
      name: drug.name || '',
      genericName: drug.genericName || '',
      dosageForm: drug.dosageForm || 'tablet',
      strengthValue: drug.strengthValue || '',
      strengthUnit: drug.strengthUnit || '',
      defaultDosage: drug.defaultDosage || '',
      defaultFrequency: drug.defaultFrequency || '',
      defaultDuration: drug.defaultDuration || '',
      notes: drug.notes || '',
      isActive: drug.isActive !== false,
    });
    setShowAdd(true);
  };

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      if (editingId) {
        await fetchApi(`/api/wellness/drugs/${editingId}`, { method: 'PUT', body: JSON.stringify(form) });
        notify.success(`Updated "${form.name}"`);
      } else {
        await fetchApi('/api/wellness/drugs', { method: 'POST', body: JSON.stringify(form) });
        notify.success(`Created "${form.name}"`);
      }
      resetForm();
      load({ reset: true, nextPage: 1, query: search });
    } catch (_err) {
      /* fetchApi toasts */
    }
    setSaving(false);
  };

  const remove = async (drug) => {
    const ok = await notify.confirm({
      title: 'Delete drug',
      message: `Delete "${drug.name}" from the catalogue?`,
      confirmText: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await fetchApi(`/api/wellness/drugs/${drug.id}`, { method: 'DELETE' });
      notify.success(`Deleted "${drug.name}"`);
      load({ reset: true, nextPage: 1, query: search });
    } catch (_err) {
      /* fetchApi toasts */
    }
  };

  const runSearch = () => load({ reset: true, nextPage: 1, query: search });

    const bodyRows = drugs.map((d, index) => (
    <div
      key={d.id}
      style={{
        display: 'grid',
        gridTemplateColumns: ROW_GRID_TEMPLATE,
        alignItems: 'center',
        width: '100%',
        borderTop: index === 0 ? 'none' : '1px solid var(--border-soft)',
        background: index % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'transparent',
        boxSizing: 'border-box',
      }}
    >
      <div style={TABLE_CELL_STYLE}>{d.name}</div>
      <div style={TABLE_CELL_STYLE}>{d.genericName || '—'}</div>
      <div style={TABLE_CELL_STYLE}>{d.dosageForm}</div>
      <div style={TABLE_CELL_STYLE}>
        {d.strengthValue ? `${d.strengthValue} ${d.strengthUnit || ''}`.trim() : '—'}
      </div>
      <div style={TABLE_CELL_STYLE}>{d.defaultDosage || '—'}</div>
      <div style={TABLE_CELL_STYLE}>
        <span
          style={{
            display: 'inline-block',
            padding: '0.2rem 0.6rem',
            borderRadius: 999,
            fontSize: '0.78rem',
            fontWeight: 500,
            background: d.isActive ? 'rgba(34, 197, 94, 0.12)' : 'rgba(148, 163, 184, 0.15)',
            color: d.isActive ? '#22c55e' : 'var(--text-secondary)',
          }}
        >
          {d.isActive ? 'Active' : 'Inactive'}
        </span>
      </div>
      <div style={{ ...TABLE_CELL_STYLE, textAlign: 'right', whiteSpace: 'nowrap' }}>
        <div style={{ display: 'inline-flex', gap: '0.4rem' }}>
          <button
            onClick={() => startEdit(d)}
            title="Edit"
            aria-label={`Edit ${d.name}`}
            style={ICON_BTN_STYLE}
          >
            <Pencil size={14} />
          </button>
          <button
            onClick={() => remove(d)}
            title="Delete"
            aria-label={`Delete ${d.name}`}
            style={DANGER_ICON_BTN_STYLE}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
    </div>
  ));

  return (
    <div
      style={{
        padding: '2rem',
        height: '100%',
        minHeight: 0,
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        animation: 'fadeIn 0.5s ease-out',
      }}
    >
      <section
        className="card"
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: '0.9rem',
          padding: '1.25rem',
          borderRadius: 18,
        }}
      >
        <PageHeader
          icon={Pill}
          title="Drug catalogue"
          count={totalCount || drugs.length}
          description={`drug${(totalCount || drugs.length) === 1 ? '' : 's'} — used by the prescription writer's typeahead.`}
        >
          <CsvImportExportToolbar
            entity="products"
            label="Drugs"
            filters={{ q: search }}
            formats={['csv', 'xlsx']}
            onImported={() => load({ reset: true, nextPage: 1, query: search })}
          />
          <button
            onClick={() => (showAdd ? resetForm() : setShowAdd(true))}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.3rem',
              padding: '0.5rem 1rem',
              background: 'var(--primary-color, var(--accent-color))',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              cursor: 'pointer',
            }}
          >
            <Plus size={16} /> {showAdd ? 'Cancel' : 'New drug'}
          </button>
        </PageHeader>

        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'stretch' }}>
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              padding: '0 0.75rem',
              background: 'var(--bg-elev, rgba(255,255,255,0.04))',
              border: '1px solid var(--border-soft, rgba(255,255,255,0.12))',
              borderRadius: 8,
            }}
          >
            <Search size={16} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
            <input
              className="naked-input"
              placeholder="Search by name or generic name..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') runSearch();
              }}
              style={{
                flex: 1,
                padding: '0.55rem 0',
                color: 'var(--text-primary)',
                fontSize: '0.9rem',
              }}
            />
          </div>
          <button
            onClick={runSearch}
            style={{
              padding: '0 1.25rem',
              background: 'var(--primary-color, var(--accent-color))',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              cursor: 'pointer',
              fontWeight: 500,
              fontSize: '0.9rem',
            }}
          >
            Search
          </button>
        </div>

        {showAdd && (
          <form
            onSubmit={submit}
            style={{
              background: 'var(--bg-elev)',
              padding: '1rem',
              borderRadius: 8,
              display: 'grid',
              gap: '0.75rem',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))',
            }}
          >
            <input required placeholder="Brand / trade name (e.g. Crocin)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <input placeholder="Generic name (e.g. Acetaminophen)" value={form.genericName} onChange={(e) => setForm({ ...form, genericName: e.target.value })} />
            <select value={form.dosageForm} onChange={(e) => setForm({ ...form, dosageForm: e.target.value })}>
              {DOSAGE_FORMS.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
            <input placeholder="Strength value (e.g. 500)" value={form.strengthValue} onChange={(e) => setForm({ ...form, strengthValue: e.target.value })} />
            <input placeholder="Strength unit (mg, ml, %, IU...)" value={form.strengthUnit} onChange={(e) => setForm({ ...form, strengthUnit: e.target.value })} />
            <input placeholder="Default dosage (e.g. 1 tablet)" value={form.defaultDosage} onChange={(e) => setForm({ ...form, defaultDosage: e.target.value })} />
            <input placeholder="Default frequency (e.g. twice daily)" value={form.defaultFrequency} onChange={(e) => setForm({ ...form, defaultFrequency: e.target.value })} />
            <input placeholder="Default duration (e.g. 5 days)" value={form.defaultDuration} onChange={(e) => setForm({ ...form, defaultDuration: e.target.value })} />
            <textarea placeholder="Admin notes (contraindications, schedule, etc.)" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} style={{ gridColumn: '1 / -1', minHeight: 60 }} />
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
              Active
            </label>
            <button
              type="submit"
              disabled={saving}
              style={{
                gridColumn: '1 / -1',
                padding: '0.6rem',
                background: 'var(--primary-color, var(--accent-color))',
                color: '#fff',
                border: 'none',
                borderRadius: 6,
              }}
            >
              {saving ? 'Saving...' : editingId ? 'Save changes' : 'Add drug'}
            </button>
          </form>
        )}

        {loading ? (
          <p style={{ textAlign: 'center', padding: '3rem 1rem', color: 'var(--text-secondary)' }}>
            Loading catalogue...
          </p>
        ) : drugs.length === 0 ? (
          <p style={{ color: 'var(--text-secondary)', padding: '1rem 0' }}>
            No drugs match.
          </p>
        ) : (
          <div
            ref={scrollContainerRef}
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: 'auto',
              paddingRight: '0.2rem',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div
              style={{
                position: 'sticky',
                top: 0,
                zIndex: 3,
                display: 'grid',
                gridTemplateColumns: HEADER_GRID_TEMPLATE,
                alignItems: 'center',
                width: '100%',
                padding: '0.7rem 0 0.55rem',
                borderBottom: '1px solid var(--border-color, rgba(120, 110, 90, 0.2))',
                color: 'var(--text-secondary)',
                fontSize: '0.85rem',
                fontWeight: 600,
                background: 'var(--surface-color, rgba(255,255,255,0.98))',
                boxShadow: '0 1px 0 rgba(255,255,255,0.35)',
                backdropFilter: 'blur(8px)',
                boxSizing: 'border-box',
              }}
            >
              <div style={TABLE_HEADER_CELL_STYLE}>Name</div>
              <div style={TABLE_HEADER_CELL_STYLE}>Generic</div>
              <div style={TABLE_HEADER_CELL_STYLE}>Form</div>
              <div style={TABLE_HEADER_CELL_STYLE}>Strength</div>
              <div style={TABLE_HEADER_CELL_STYLE}>Default dosage</div>
              <div style={TABLE_HEADER_CELL_STYLE}>Status</div>
              <div style={{ ...TABLE_HEADER_CELL_STYLE, textAlign: 'right' }}>Actions</div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', width: '100%' }}>
              {bodyRows}
            </div>

            <div ref={sentinelRef} aria-hidden="true" style={{ height: 1 }} />
            {loadingMore && (
              <p style={{ margin: '1rem 0 0', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                Loading more drugs...
              </p>
            )}
            {!hasMore && drugs.length > 0 && (
              <p style={{ margin: '1rem 0 0', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                You have reached the end of the catalogue.
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}






