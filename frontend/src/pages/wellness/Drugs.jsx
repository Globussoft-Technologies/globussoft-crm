/**
 * Drug catalogue admin page for the wellness vertical.
 *
 * The list is rendered inside one main card. The header is fixed, the rows
 * scroll inside the inner body, and pagination continues as the sentinel
 * enters view.
 */
import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  Boxes,
  ClipboardList,
  IndianRupee,
  Layers3,
  Pill,
  Plus,
  Pencil,
  Search,
  Trash2,
} from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import CsvImportExportToolbar from '../../components/wellness/CsvImportExportToolbar';
import PageHeader from '../../components/PageHeader';
import ModalShell from '../../components/wellness/ModalShell';

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

const HEADER_GRID_TEMPLATE = 'minmax(150px, 1.35fr) minmax(180px, 1.65fr) minmax(90px, 0.9fr) minmax(90px, 0.9fr) minmax(140px, 1.25fr) minmax(110px, 0.95fr) minmax(90px, 0.75fr) minmax(92px, 0.6fr)';
const ROW_GRID_TEMPLATE = HEADER_GRID_TEMPLATE;
/**
 * Show the stock state without exposing a raw quantity. Negative legacy values
 * are treated as out of stock and never rendered to the user.
 */
function StockCell({ drug }) {
  const qty = Number(drug.quantity ?? 0);
  const threshold = Number(drug.lowStockThreshold ?? 0);

  let label = 'Stock not tracked';
  let color = 'var(--text-secondary)';
  let background = 'rgba(148, 163, 184, 0.15)';
  if (!Number.isFinite(qty) || qty <= 0) {
    label = 'Out of stock';
    color = 'var(--danger-color, #dc2626)';
    background = 'rgba(220, 38, 38, 0.1)';
  } else if (threshold > 0 && qty <= threshold) {
    label = 'Low stock';
    color = 'var(--warning-color, #d97706)';
    background = 'rgba(217, 119, 6, 0.12)';
  } else if (threshold > 0) {
    label = 'In stock';
    color = 'var(--success-color, #16a34a)';
    background = 'rgba(34, 197, 94, 0.12)';
  }

  return (
    <span
      style={{
        display: 'inline-block',
        padding: '0.22rem 0.6rem',
        borderRadius: 999,
        background,
        color,
        fontSize: '0.75rem',
        fontWeight: 700,
      }}
    >
      {label}
    </span>
  );
}

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

// Suggested strength units, offered through a <datalist> rather than a
// <select>. A closed dropdown would block legitimate units nobody thought to
// list (mEq, mmol, custom compounding units) and would silently blank the
// field for any catalogue row that already holds one, so this guides input
// without restricting it. The backend does the actual validation — it repairs
// stray punctuation ("-gm" → "gm") and rejects a value with no digit in it,
// which is what let strengthValue "-" / strengthUnit "-gm" into the catalogue
// and print as "--gm" on every prescription surface.
const STRENGTH_UNITS = ['mg', 'g', 'mcg', 'ml', 'l', '%', 'IU', 'mEq', 'mg/ml', 'mcg/ml', 'units'];

const FORM_CONTROL_STYLE = {
  width: '100%',
  minWidth: 0,
  boxSizing: 'border-box',
  padding: '0.72rem 0.8rem',
  borderRadius: 9,
  border: '1px solid var(--border-color, rgba(120, 110, 90, 0.28))',
  background: 'var(--surface-color, rgba(255, 255, 255, 0.72))',
  color: 'var(--text-primary)',
  fontSize: '0.9rem',
  outline: 'none',
  transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
};

const FORM_LABEL_STYLE = {
  display: 'block',
  marginBottom: '0.42rem',
  color: 'var(--text-secondary)',
  fontSize: '0.75rem',
  fontWeight: 700,
  letterSpacing: '0.045em',
  textTransform: 'uppercase',
};

const FORM_SECTION_STYLE = {
  padding: '1rem',
  border: '1px solid var(--border-color, rgba(120, 110, 90, 0.18))',
  borderRadius: 12,
  background: 'rgba(255, 255, 255, 0.08)',
};

function DrugField({ label, required = false, hint, children, fullWidth = false }) {
  return (
    <div style={{ minWidth: 0, gridColumn: fullWidth ? '1 / -1' : undefined }}>
      <label style={FORM_LABEL_STYLE}>
        {label}
        {required && <span aria-hidden="true" style={{ color: 'var(--danger-color, #dc2626)' }}> *</span>}
      </label>
      {children}
      {hint && (
        <div style={{ marginTop: '0.35rem', color: 'var(--text-secondary)', fontSize: '0.75rem', lineHeight: 1.35 }}>
          {hint}
        </div>
      )}
    </div>
  );
}

/**
 * Render a catalogue strength for display.
 *
 * Guards the rows that predate backend validation: a value with no digit in it
 * ("-", "n/a") is not a strength, and a unit with no value is meaningless on
 * its own, so both render as an em dash instead of the literal junk. Without
 * this, the row that caused the tester's report kept printing "- -gm" here
 * even after the write path was fixed.
 */
export function formatStrength(value, unit) {
  const v = value == null ? '' : String(value).trim();
  const u = unit == null ? '' : String(unit).trim();
  if (!/[0-9]/.test(v)) return '—';
  return u ? `${v} ${u}` : v;
}


const EMPTY_FORM = {
  name: '',
  genericName: '',
  productCode: '',
  salePrice: '',
  unit: '',
  dosageForm: 'tablet',
  strengthValue: '',
  quantity: '',
  lowStockThreshold: '',
  strengthUnit: '',
  defaultDosage: '',
  defaultFrequency: '',
  defaultDuration: '',
  notes: '',
  isActive: true,
};

const STOCK_FIELDS = ['quantity', 'lowStockThreshold'];

function hasInvalidStockValue(value) {
  if (value === '' || value == null) return false;
  const parsed = Number(value);
  return !Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0;
}

function DrugFormModal({ editingId, form, saving, onClose, onSubmit, onChange }) {
  const control = (field) => ({
    value: form[field],
    onChange: (event) => onChange(field, event.target.value),
    style: FORM_CONTROL_STYLE,
  });

  return (
    <ModalShell
      title={editingId ? 'Edit drug' : 'Add new drug'}
      onClose={onClose}
      width={860}
      footer={(
        <>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '0.65rem 1.15rem',
              border: '1px solid var(--border-color, rgba(120, 110, 90, 0.3))',
              borderRadius: 9,
              background: 'transparent',
              color: 'var(--text-primary)',
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            form="drug-form"
            disabled={saving}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.45rem',
              minWidth: 140,
              padding: '0.65rem 1.2rem',
              border: 'none',
              borderRadius: 9,
              background: 'var(--primary-color, var(--accent-color))',
              color: '#fff',
              cursor: saving ? 'wait' : 'pointer',
              fontWeight: 700,
              opacity: saving ? 0.7 : 1,
            }}
          >
            <Plus size={16} />
            {saving ? 'Saving...' : editingId ? 'Save changes' : 'Add drug'}
          </button>
        </>
      )}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.8rem', marginBottom: '1.15rem' }}>
        <div
          aria-hidden="true"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 42,
            height: 42,
            flexShrink: 0,
            borderRadius: 12,
            background: 'rgba(38, 88, 85, 0.12)',
            color: 'var(--primary-color, var(--accent-color))',
          }}
        >
          <Pill size={22} />
        </div>
        <div>
          <div style={{ color: 'var(--text-primary)', fontSize: '0.98rem', fontWeight: 700 }}>
            {editingId ? 'Update catalogue information' : 'Create a prescription-ready drug'}
          </div>
          <div style={{ marginTop: '0.25rem', color: 'var(--text-secondary)', fontSize: '0.82rem', lineHeight: 1.45 }}>
            Keep clinical defaults and stock details consistent for the prescription team.
          </div>
        </div>
      </div>

      <form id="drug-form" onSubmit={onSubmit} style={{ display: 'grid', gap: '0.9rem' }}>
        <section style={FORM_SECTION_STYLE} aria-labelledby="drug-core-details">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.9rem' }}>
            <ClipboardList size={17} style={{ color: 'var(--primary-color, var(--accent-color))' }} />
            <h3 id="drug-core-details" style={{ margin: 0, color: 'var(--text-primary)', fontSize: '0.9rem' }}>Core details</h3>
          </div>
          <div style={{ display: 'grid', gap: '0.85rem', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 235px), 1fr))' }}>
            <DrugField label="Brand / trade name" required hint="The name shown in the prescription writer.">
              <input required autoFocus placeholder="Brand / trade name (e.g. Crocin)" {...control('name')} />
            </DrugField>
            <DrugField label="Generic name">
              <input placeholder="Generic name (e.g. Acetaminophen)" {...control('genericName')} />
            </DrugField>
            <DrugField label="Product code" hint="Optional internal or supplier reference.">
              <input placeholder="Product code (optional)" {...control('productCode')} />
            </DrugField>
            <DrugField label="Dosage form">
              <select {...control('dosageForm')}>
                {DOSAGE_FORMS.map((formType) => <option key={formType} value={formType}>{formType}</option>)}
              </select>
            </DrugField>
          </div>
        </section>

        <section style={FORM_SECTION_STYLE} aria-labelledby="drug-stock-details">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.9rem' }}>
            <Boxes size={17} style={{ color: 'var(--primary-color, var(--accent-color))' }} />
            <h3 id="drug-stock-details" style={{ margin: 0, color: 'var(--text-primary)', fontSize: '0.9rem' }}>Pricing &amp; inventory</h3>
          </div>
          <div style={{ display: 'grid', gap: '0.85rem', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 235px), 1fr))' }}>
            <DrugField label="Sale price per unit" hint="Used for billing and inventory calculations.">
              <div style={{ position: 'relative' }}>
                <IndianRupee size={15} aria-hidden="true" style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }} />
                <input type="number" min="0" step="0.01" placeholder="Sale price per unit (₹)" {...control('salePrice')} style={{ ...FORM_CONTROL_STYLE, paddingLeft: '2rem' }} />
              </div>
            </DrugField>
            <DrugField label="Inventory unit">
              <input placeholder="Inventory unit (e.g. tablet, bottle)" {...control('unit')} />
            </DrugField>
            <DrugField label="Quantity in stock">
              <input type="number" min="0" step="1" placeholder="Quantity in stock (e.g. 40)" {...control('quantity')} />
            </DrugField>
            <DrugField label="Low-stock threshold" hint="Set to 0 when stock alerts are not needed.">
              <input type="number" min="0" step="1" placeholder="Low-stock threshold (0 = no alert)" {...control('lowStockThreshold')} />
            </DrugField>
          </div>
        </section>

        <section style={FORM_SECTION_STYLE} aria-labelledby="drug-prescription-defaults">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.9rem' }}>
            <Activity size={17} style={{ color: 'var(--primary-color, var(--accent-color))' }} />
            <h3 id="drug-prescription-defaults" style={{ margin: 0, color: 'var(--text-primary)', fontSize: '0.9rem' }}>Prescription defaults</h3>
          </div>
          <div style={{ display: 'grid', gap: '0.85rem', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 235px), 1fr))' }}>
            <DrugField label="Strength value" hint="Examples: 500, 2.5, or 5/10.">
              <input
                placeholder="Strength value (e.g. 500)"
                title="Must contain a number - e.g. 500, 2.5, or 5/10 for a combination"
                pattern="[^0-9]*[0-9][\s\S]*"
                {...control('strengthValue')}
              />
            </DrugField>
            <DrugField label="Strength unit">
              <input placeholder="Strength unit (mg, ml, %, IU...)" list="drug-strength-units" {...control('strengthUnit')} />
              <datalist id="drug-strength-units">
                {STRENGTH_UNITS.map((unit) => <option key={unit} value={unit} />)}
              </datalist>
            </DrugField>
            <DrugField label="Default dosage">
              <input placeholder="Default dosage (e.g. 1 tablet)" {...control('defaultDosage')} />
            </DrugField>
            <DrugField label="Default frequency">
              <input placeholder="Default frequency (e.g. twice daily)" {...control('defaultFrequency')} />
            </DrugField>
            <DrugField label="Default duration">
              <input placeholder="Default duration (e.g. 5 days)" {...control('defaultDuration')} />
            </DrugField>
          </div>
        </section>

        <section style={FORM_SECTION_STYLE} aria-labelledby="drug-notes-status">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.9rem' }}>
            <Layers3 size={17} style={{ color: 'var(--primary-color, var(--accent-color))' }} />
            <h3 id="drug-notes-status" style={{ margin: 0, color: 'var(--text-primary)', fontSize: '0.9rem' }}>Notes &amp; status</h3>
          </div>
          <DrugField label="Admin notes" fullWidth hint="Add contraindications, scheduling guidance, or internal handling notes.">
            <textarea placeholder="Admin notes (contraindications, schedule, etc.)" {...control('notes')} style={{ ...FORM_CONTROL_STYLE, minHeight: 92, resize: 'vertical', lineHeight: 1.45 }} />
          </DrugField>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', marginTop: '0.9rem', padding: '0.75rem 0.85rem', borderRadius: 9, background: 'rgba(34, 197, 94, 0.08)', color: 'var(--text-primary)', cursor: 'pointer', fontSize: '0.88rem', fontWeight: 600 }}>
            <input type="checkbox" checked={form.isActive} onChange={(event) => onChange('isActive', event.target.checked)} style={{ width: 17, height: 17, accentColor: '#16a34a' }} />
            <span>
              Active in prescription writer
              <span style={{ display: 'block', marginTop: 2, color: 'var(--text-secondary)', fontSize: '0.75rem', fontWeight: 400 }}>
                Inactive drugs remain in the catalogue but are hidden from new prescriptions.
              </span>
            </span>
          </label>
        </section>
      </form>
    </ModalShell>
  );
}

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
  // The pending auto-search timer, and the term the list is currently showing.
  // `lastQueryRef` is what stops a debounce firing a second, identical request
  // straight after Enter or the Search button already ran it.
  const searchTimerRef = useRef(null);
  const lastQueryRef = useRef('');
  const PAGE_SIZE = 8;
  // Long enough that typing a word is one request, not one per letter; short
  // enough that the list feels like it is keeping up.
  const SEARCH_DEBOUNCE_MS = 350;

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

  const updateFormField = (field, value) => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  const openCreateModal = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setShowAdd(true);
  };

  const startEdit = (drug) => {
    setEditingId(drug.id);
    setForm({
      name: drug.name || '',
      genericName: drug.genericName || '',
      productCode: drug.productCode || '',
      salePrice: drug.salePrice ?? '',
      unit: drug.unit || '',
      dosageForm: drug.dosageForm || 'tablet',
      strengthValue: drug.strengthValue || '',
      quantity: drug.quantity ?? '',
      lowStockThreshold: drug.lowStockThreshold ?? '',
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
    if (STOCK_FIELDS.some((field) => hasInvalidStockValue(form[field]))) {
      notify.error('Stock quantity and low-stock threshold must be whole numbers of 0 or more.');
      return;
    }
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

  // Run the search now. Enter and the Search button call this to skip the
  // wait; the debounce below calls it when typing stops.
  const runSearch = (query = search) => {
    clearTimeout(searchTimerRef.current);
    lastQueryRef.current = query;
    return load({ reset: true, nextPage: 1, query });
  };

  // Auto-search: typing runs the search on its own. Enter and the button stay
  // as they were — they just skip the wait — so nothing that relied on them
  // changes behaviour.
  //
  // The early return covers two cases at once: the initial mount (both are '',
  // and the mount effect above has already loaded page 1) and the moment right
  // after an explicit search (runSearch has set lastQueryRef to this term), so
  // neither fires a duplicate request. Out-of-order responses were already
  // handled by requestSeqRef, which matters more now that a request can be in
  // flight for every pause in typing.
  useEffect(() => {
    if (search === lastQueryRef.current) return undefined;
    searchTimerRef.current = setTimeout(() => runSearch(search), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(searchTimerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

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
      <div style={TABLE_CELL_STYLE}>{formatStrength(d.strengthValue, d.strengthUnit)}</div>
      <div style={TABLE_CELL_STYLE}>{d.defaultDosage || '—'}</div>
      <div style={TABLE_CELL_STYLE}><StockCell drug={d} /></div>
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
          background: 'transparent',
          border: 'none',
          boxShadow: 'none',
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
            onClick={() => (showAdd ? resetForm() : openCreateModal())}
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
              border: '1px solid rgba(68, 62, 62, 0.35)',
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
                if (e.key === 'Enter') runSearch(search);
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
            onClick={() => runSearch(search)}
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
          <DrugFormModal
            editingId={editingId}
            form={form}
            saving={saving}
            onClose={resetForm}
            onSubmit={submit}
            onChange={updateFormField}
          />
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
              background: 'var(--bg-elev, rgba(255, 255, 255, 0.035))',
              border: '1px solid rgba(128, 128, 128, 0.22)',
              borderRadius: '12px',
              boxShadow: '0 4px 16px rgba(0, 0, 0, 0.06)',
              overflowX: 'auto',
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
              <div style={TABLE_HEADER_CELL_STYLE}>Stock</div>
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






