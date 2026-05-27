/**
 * Wave 7 Agent A — Drug catalogue admin page (PRD Gap §10 #2).
 *
 * Catalogue management for the prescription writer's typeahead. Manager+
 * gated via App.jsx's RoleGuard wrapper. The catalogue stores name +
 * genericName + dosageForm + strength + sensible defaults the doctor's
 * UI can pre-fill from.
 */
import { useEffect, useState } from 'react';
import { Pill, Plus, Pencil, Search } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
// Issue #816: Reusable CSV import/export toolbar.
import CsvImportExportToolbar from '../../components/wellness/CsvImportExportToolbar';

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
      <header style={{ marginBottom: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Pill size={24} /> Drug catalogue
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            {drugs.length} drug{drugs.length === 1 ? '' : 's'} — used by the prescription writer&apos;s typeahead.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
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
        </div>
      </header>

      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '1rem' }}>
        <Search size={16} />
        <input
          placeholder="Search by name or generic name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') load(search); }}
          style={{ flex: 1, padding: '0.4rem 0.6rem' }}
        />
        <button onClick={() => load(search)}>Search</button>
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
            <tr style={{ textAlign: 'left' }}>
              <th>Name</th>
              <th>Generic</th>
              <th>Form</th>
              <th>Strength</th>
              <th>Default dosage</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {drugs.map((d) => (
              <tr key={d.id} style={{ borderTop: '1px solid var(--border-soft)' }}>
                <td style={{ padding: '0.5rem 0' }}>{d.name}</td>
                <td>{d.genericName || '—'}</td>
                <td>{d.dosageForm}</td>
                <td>{d.strengthValue ? `${d.strengthValue} ${d.strengthUnit || ''}`.trim() : '—'}</td>
                <td>{d.defaultDosage || '—'}</td>
                <td>{d.isActive ? 'Active' : 'Inactive'}</td>
                <td style={{ display: 'flex', gap: '0.5rem' }}>
                  <button onClick={() => startEdit(d)} title="Edit"><Pencil size={14} /></button>
                  <button onClick={() => remove(d)} title="Delete">×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
