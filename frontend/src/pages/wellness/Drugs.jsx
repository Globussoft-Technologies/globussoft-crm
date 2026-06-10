/**
 * Wave 7 Agent A — Drug catalogue admin page (PRD Gap §10 #2).
 *
 * Catalogue management for the prescription writer's typeahead. Manager+
 * gated via App.jsx's RoleGuard wrapper. The catalogue stores name +
 * genericName + dosageForm + strength + sensible defaults the doctor's
 * UI can pre-fill from.
 */
import { useEffect, useState } from 'react';
import { Pill, Plus, Pencil, Trash2, Search } from 'lucide-react';

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
const DANGER_ICON_BTN_STYLE = { ...ICON_BTN_STYLE, color: 'var(--danger-color, #ef4444)' };
const TH_STYLE = { padding: '0.6rem 0.75rem', fontWeight: 600, color: 'var(--text-secondary)', fontSize: '0.85rem' };
const TD_STYLE = { padding: '0.6rem 0.75rem', verticalAlign: 'middle' };
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
// Issue #816: Reusable CSV import/export toolbar.
import CsvImportExportToolbar from '../../components/wellness/CsvImportExportToolbar';
import PageHeader from '../../components/PageHeader';

const DOSAGE_FORMS = ['tablet', 'capsule', 'syrup', 'injection', 'topical', 'drops', 'inhaler', 'other'];

const EMPTY_FORM = {
  name: '', genericName: '', dosageForm: 'tablet',
  strengthValue: '', strengthUnit: '',
  defaultDosage: '', defaultFrequency: '', defaultDuration: '',
  notes: '', isActive: true,
};

export default function Drugs() {
  const notify = useNotify();
  const [drugs, setDrugs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');

  const load = (q) => {
    setLoading(true);
    const url = q ? `/api/wellness/drugs?q=${encodeURIComponent(q)}` : '/api/wellness/drugs';
    fetchApi(url)
      .then((rows) => setDrugs(Array.isArray(rows) ? rows : []))
      .catch(() => setDrugs([]))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const resetForm = () => { setForm(EMPTY_FORM); setEditingId(null); setShowAdd(false); };

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
      load(search);
    } catch (_err) { /* fetchApi toasts */ }
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
      load(search);
    } catch (_err) { /* fetchApi toasts */ }
  };

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <PageHeader
        icon={Pill}
        title="Drug catalogue"
        count={drugs.length}
        description={`drug${drugs.length === 1 ? '' : 's'} — used by the prescription writer's typeahead.`}
      >
        {/* Issue #816: drugs CSV. Pass current search as a filter so the
            export reflects what's on screen. */}
        <CsvImportExportToolbar
          entity="products"
          label="Drugs"
          filters={{ q: search }}
          formats={['csv', 'xlsx']}
          onImported={() => load(search)}
        />
        <button onClick={() => (showAdd ? resetForm() : setShowAdd(true))} style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.5rem 1rem', background: 'var(--primary-color, var(--accent-color))', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}>
          <Plus size={16} /> {showAdd ? 'Cancel' : 'New drug'}
        </button>
      </PageHeader>

      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'stretch', marginBottom: '1rem' }}>
        <div style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          padding: '0 0.75rem',
          background: 'var(--bg-elev, rgba(255,255,255,0.04))',
          border: '1px solid var(--border-soft, rgba(255,255,255,0.12))',
          borderRadius: 8,
        }}>
          <Search size={16} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
          <input
            className="naked-input"
            placeholder="Search by name or generic name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') load(search); }}
            style={{
              flex: 1,
              padding: '0.55rem 0',
              color: 'var(--text-primary)',
              fontSize: '0.9rem',
            }}
          />
        </div>
        <button
          onClick={() => load(search)}
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
        <form onSubmit={submit} style={{ background: 'var(--bg-elev)', padding: '1rem', borderRadius: 8, marginBottom: '1.5rem', display: 'grid', gap: '0.75rem', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))' }}>
          <input required placeholder="Brand / trade name (e.g. Crocin)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input placeholder="Generic name (e.g. Acetaminophen)" value={form.genericName} onChange={(e) => setForm({ ...form, genericName: e.target.value })} />
          <select value={form.dosageForm} onChange={(e) => setForm({ ...form, dosageForm: e.target.value })}>
            {DOSAGE_FORMS.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
          <input placeholder="Strength value (e.g. 500)" value={form.strengthValue} onChange={(e) => setForm({ ...form, strengthValue: e.target.value })} />
          <input placeholder="Strength unit (mg, ml, %, IU…)" value={form.strengthUnit} onChange={(e) => setForm({ ...form, strengthUnit: e.target.value })} />
          <input placeholder="Default dosage (e.g. 1 tablet)" value={form.defaultDosage} onChange={(e) => setForm({ ...form, defaultDosage: e.target.value })} />
          <input placeholder="Default frequency (e.g. twice daily)" value={form.defaultFrequency} onChange={(e) => setForm({ ...form, defaultFrequency: e.target.value })} />
          <input placeholder="Default duration (e.g. 5 days)" value={form.defaultDuration} onChange={(e) => setForm({ ...form, defaultDuration: e.target.value })} />
          <textarea placeholder="Admin notes (contraindications, schedule, etc.)" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} style={{ gridColumn: '1 / -1', minHeight: 60 }} />
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
            Active
          </label>
          <button type="submit" disabled={saving} style={{ gridColumn: '1 / -1', padding: '0.6rem', background: 'var(--primary-color, var(--accent-color))', color: '#fff', border: 'none', borderRadius: 6 }}>
            {saving ? 'Saving…' : editingId ? 'Save changes' : 'Add drug'}
          </button>
        </form>
      )}

      {loading ? (
        <p>Loading catalogue…</p>
      ) : drugs.length === 0 ? (
        <p style={{ color: 'var(--text-secondary)' }}>No drugs match.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border-soft)' }}>
              <th style={TH_STYLE}>Name</th>
              <th style={TH_STYLE}>Generic</th>
              <th style={TH_STYLE}>Form</th>
              <th style={TH_STYLE}>Strength</th>
              <th style={TH_STYLE}>Default dosage</th>
              <th style={TH_STYLE}>Status</th>
              <th style={{ ...TH_STYLE, textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {drugs.map((d) => (
              <tr key={d.id} style={{ borderTop: '1px solid var(--border-soft)' }}>
                <td style={TD_STYLE}>{d.name}</td>
                <td style={TD_STYLE}>{d.genericName || '—'}</td>
                <td style={TD_STYLE}>{d.dosageForm}</td>
                <td style={TD_STYLE}>{d.strengthValue ? `${d.strengthValue} ${d.strengthUnit || ''}`.trim() : '—'}</td>
                <td style={TD_STYLE}>{d.defaultDosage || '—'}</td>
                <td style={TD_STYLE}>
                  <span style={{
                    display: 'inline-block',
                    padding: '0.2rem 0.6rem',
                    borderRadius: 999,
                    fontSize: '0.78rem',
                    fontWeight: 500,
                    background: d.isActive ? 'rgba(34, 197, 94, 0.12)' : 'rgba(148, 163, 184, 0.15)',
                    color: d.isActive ? '#22c55e' : 'var(--text-secondary)',
                  }}>
                    {d.isActive ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td style={{ ...TD_STYLE, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <div style={{ display: 'inline-flex', gap: '0.4rem' }}>
                    <button onClick={() => startEdit(d)} title="Edit" aria-label={`Edit ${d.name}`} style={ICON_BTN_STYLE}>
                      <Pencil size={14} />
                    </button>
                    <button onClick={() => remove(d)} title="Delete" aria-label={`Delete ${d.name}`} style={DANGER_ICON_BTN_STYLE}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
