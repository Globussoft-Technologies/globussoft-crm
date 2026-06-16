/**
 * Visa Sure Checklists — document-checklist TEMPLATE admin
 * (PRD_VISA_SURE_PHASE_3 FR-6.1).
 *
 * Manage the canonical per-applicationType × destinationCountry document lists
 * (e.g. "tourist + US" → Passport, Photo, Bank statement, Travel insurance).
 * Backed by the VisaChecklistTemplate model + tenant-scoped CRUD at
 * /api/travel/visa/checklists. The consumer endpoint
 * GET /checklists/template?applicationType=&destinationCountry= returns the
 * canonical list used to seed a new application's checklist items (FR-6).
 *
 * Replaces the former Phase-3 SHELL. Read for ADMIN/MANAGER/USER; create/edit/
 * delete are ADMIN/MANAGER (enforced server-side).
 */
import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { ClipboardList, Plus, Trash2, ArrowLeft, Receipt, X } from 'lucide-react';
import { fetchApi } from '../../../utils/api';
import { useNotify } from '../../../utils/notify';

const APPLICATION_TYPES = [
  { value: 'tourist', label: 'Tourist' },
  { value: 'business', label: 'Business' },
  { value: 'student', label: 'Student' },
  { value: 'work', label: 'Work' },
  { value: 'umrah', label: 'Umrah' },
  { value: 'hajj', label: 'Hajj' },
];
const TYPE_LABEL = Object.fromEntries(APPLICATION_TYPES.map((t) => [t.value, t.label]));

const card = {
  background: 'var(--surface-color)',
  border: '1px solid var(--border-color)',
  borderRadius: 14,
  padding: '1.25rem',
};
const inputStyle = {
  padding: '0.5rem 0.7rem',
  borderRadius: 8,
  border: '1px solid var(--border-color)',
  background: 'var(--input-bg)',
  color: 'var(--text-primary)',
  fontSize: '0.88rem',
};
const primaryBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '0.5rem 1rem',
  borderRadius: 8, border: 'none', background: 'var(--primary-color, var(--accent-color))',
  color: '#fff', fontWeight: 600, fontSize: '0.85rem', cursor: 'pointer',
};

const EMPTY_FORM = { applicationType: 'tourist', destinationCountry: '', docType: '', required: true };

export default function VisaChecklists() {
  const notify = useNotify();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [filterType, setFilterType] = useState('');
  // FR-5.2 — the checklist admin page extends to manage quotation templates
  // too. A tab toggles between the two surfaces.
  const [tab, setTab] = useState('checklists');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchApi('/api/travel/visa/checklists', { silent: true });
      const list = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
      setItems(list);
    } catch (e) {
      notify.error(e?.message || 'Failed to load checklist templates');
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => { load(); }, [load]);

  const addItem = async (e) => {
    e.preventDefault();
    if (!form.destinationCountry.trim() || !form.docType.trim()) {
      notify.error('Destination and document are required');
      return;
    }
    setSaving(true);
    try {
      const created = await fetchApi('/api/travel/visa/checklists', {
        method: 'POST',
        body: JSON.stringify({
          applicationType: form.applicationType,
          destinationCountry: form.destinationCountry.trim(),
          docType: form.docType.trim(),
          required: form.required,
        }),
      });
      setItems((prev) => [...prev, created]);
      setForm((f) => ({ ...f, docType: '' })); // keep type+country for fast multi-add
      notify.success('Document added to checklist');
    } catch (e) {
      notify.error(e?.message || 'Failed to add document');
    } finally {
      setSaving(false);
    }
  };

  const toggleRequired = async (it) => {
    const next = !it.required;
    setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, required: next } : x)));
    try {
      await fetchApi(`/api/travel/visa/checklists/${it.id}`, {
        method: 'PUT',
        body: JSON.stringify({ required: next }),
        silent: true,
      });
    } catch (e) {
      setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, required: it.required } : x))); // revert
      notify.error(e?.message || 'Failed to update');
    }
  };

  const removeItem = async (it) => {
    const snapshot = items;
    setItems((prev) => prev.filter((x) => x.id !== it.id));
    try {
      await fetchApi(`/api/travel/visa/checklists/${it.id}`, { method: 'DELETE', silent: true });
    } catch (e) {
      setItems(snapshot); // revert
      notify.error(e?.message || 'Failed to delete');
    }
  };

  const filtered = filterType ? items.filter((i) => i.applicationType === filterType) : items;
  const groups = {};
  for (const it of filtered) {
    const key = `${it.applicationType}|||${it.destinationCountry}`;
    (groups[key] = groups[key] || []).push(it);
  }
  const groupKeys = Object.keys(groups).sort();

  return (
    <div data-testid="visa-checklists" style={{ padding: 24, maxWidth: 1000, margin: '0 auto', animation: 'fadeIn 0.4s ease-out' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12, marginBottom: 20 }}>
        <div>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 10, margin: 0, fontSize: '1.75rem', fontWeight: 600, color: 'var(--text-primary)' }}>
            <ClipboardList size={26} color="var(--primary-color, var(--accent-color))" aria-hidden /> Visa Checklists
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: 4, fontSize: '0.9rem' }}>
            Canonical document lists per visa type &amp; destination. These seed each new application&rsquo;s checklist.
          </p>
        </div>
        <Link to="/travel/visa" style={{ ...primaryBtn, background: 'var(--surface-color)', color: 'var(--text-primary)', border: '1px solid var(--border-color)' }}>
          <ArrowLeft size={16} /> Back to Visa Sure
        </Link>
      </header>

      {/* Tab toggle — checklists ↔ quotation templates (FR-5.2). */}
      <div role="tablist" style={{ display: 'flex', gap: 6, marginBottom: 16, borderBottom: '1px solid var(--border-color)' }}>
        {[
          { key: 'checklists', label: 'Document checklists', testid: 'tab-checklists' },
          { key: 'quotations', label: 'Quotation templates', testid: 'tab-quotations' },
        ].map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            data-testid={t.testid}
            onClick={() => setTab(t.key)}
            style={{
              padding: '0.5rem 0.9rem',
              border: 'none',
              borderBottom: tab === t.key ? '2px solid var(--primary-color, var(--accent-color))' : '2px solid transparent',
              background: 'transparent',
              color: tab === t.key ? 'var(--text-primary)' : 'var(--text-secondary)',
              fontWeight: tab === t.key ? 600 : 500,
              fontSize: '0.9rem',
              cursor: 'pointer',
              marginBottom: -1,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'checklists' && (
        <>
      {/* Add row */}
      <form onSubmit={addItem} style={{ ...card, marginBottom: 16, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
          Visa type
          <select
            data-testid="checklist-add-type"
            value={form.applicationType}
            onChange={(e) => setForm({ ...form, applicationType: e.target.value })}
            style={inputStyle}
          >
            {APPLICATION_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
          Destination
          <input
            data-testid="checklist-add-country"
            type="text"
            placeholder="e.g. US, United Kingdom"
            value={form.destinationCountry}
            onChange={(e) => setForm({ ...form, destinationCountry: e.target.value })}
            style={{ ...inputStyle, minWidth: 160 }}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: '0.78rem', color: 'var(--text-secondary)', flex: 1, minWidth: 180 }}>
          Document
          <input
            data-testid="checklist-add-doc"
            type="text"
            placeholder="e.g. Passport, Bank statement"
            value={form.docType}
            onChange={(e) => setForm({ ...form, docType: e.target.value })}
            style={inputStyle}
          />
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.82rem', color: 'var(--text-primary)', paddingBottom: 8 }}>
          <input
            data-testid="checklist-add-required"
            type="checkbox"
            checked={form.required}
            onChange={(e) => setForm({ ...form, required: e.target.checked })}
          />
          Required
        </label>
        <button type="submit" disabled={saving} data-testid="checklist-add-submit" style={{ ...primaryBtn, opacity: saving ? 0.6 : 1 }}>
          <Plus size={14} /> {saving ? 'Adding…' : 'Add document'}
        </button>
      </form>

      {/* Filter */}
      <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Filter:</span>
        <select value={filterType} onChange={(e) => setFilterType(e.target.value)} style={inputStyle} aria-label="Filter by visa type">
          <option value="">All visa types</option>
          {APPLICATION_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      </div>

      {loading ? (
        <div style={{ ...card, textAlign: 'center', color: 'var(--text-secondary)', padding: '3rem' }}>Loading checklists…</div>
      ) : groupKeys.length === 0 ? (
        <div style={{ ...card, textAlign: 'center', padding: '3rem' }}>
          <ClipboardList size={44} color="var(--text-secondary)" style={{ marginBottom: 10, opacity: 0.6 }} />
          <h2 style={{ fontSize: '1.1rem', color: 'var(--text-primary)', margin: '0 0 6px' }}>No checklist templates yet</h2>
          <p style={{ color: 'var(--text-secondary)', margin: 0, fontSize: '0.9rem' }}>
            Add the documents required for each visa type &amp; destination above.
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {groupKeys.map((key) => {
            const [type, country] = key.split('|||');
            const rows = groups[key];
            return (
              <div key={key} style={card} data-testid={`checklist-group-${type}-${country}`}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                  <span style={{ padding: '0.2rem 0.6rem', borderRadius: 999, fontSize: '0.78rem', fontWeight: 600, background: 'var(--input-bg)', color: 'var(--primary-color, var(--accent-color))', border: '1px solid var(--border-color)' }}>
                    {TYPE_LABEL[type] || type}
                  </span>
                  <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>→ {country}</span>
                  <span style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', marginLeft: 'auto' }}>{rows.length} document{rows.length === 1 ? '' : 's'}</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {rows.map((it) => (
                    <div key={it.id} data-testid={`checklist-row-${it.id}`} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '0.55rem 0', borderTop: '1px solid var(--border-color)' }}>
                      <span style={{ color: 'var(--text-primary)', fontSize: '0.9rem', flex: 1 }}>{it.docType}</span>
                      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          data-testid={`checklist-required-${it.id}`}
                          checked={!!it.required}
                          onChange={() => toggleRequired(it)}
                        />
                        Required
                      </label>
                      <button
                        type="button"
                        onClick={() => removeItem(it)}
                        data-testid={`checklist-delete-${it.id}`}
                        aria-label={`Delete ${it.docType}`}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '0.3rem 0.6rem', borderRadius: 6, border: '1px solid rgba(239,68,68,0.3)', background: 'rgba(239,68,68,0.12)', color: '#ef4444', cursor: 'pointer', fontSize: '0.78rem' }}
                      >
                        <Trash2 size={13} /> Delete
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
        </>
      )}

      {tab === 'quotations' && <QuotationTemplatesPanel notify={notify} />}
    </div>
  );
}

// ── Quotation templates admin (FR-5.2) ────────────────────────────────
// Curated per-visa-type quotation templates. Each template carries a set of
// { label, amount } line items (amount may be negative for credits, e.g.
// "Credit: free entry diagnostic"). Advisors pick one to auto-fill a quote.
const EMPTY_QUOTE_FORM = {
  name: '',
  applicationType: 'tourist',
  currency: 'INR',
  lines: [{ label: '', amount: '' }],
};

function QuotationTemplatesPanel({ notify }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(EMPTY_QUOTE_FORM);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchApi('/api/travel/visa/quotation-templates', { silent: true });
      setItems(Array.isArray(data?.items) ? data.items : []);
    } catch (e) {
      notify.error(e?.message || 'Failed to load quotation templates');
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => { load(); }, [load]);

  const setLine = (i, patch) =>
    setForm((f) => ({ ...f, lines: f.lines.map((ln, idx) => (idx === i ? { ...ln, ...patch } : ln)) }));
  const addLine = () => setForm((f) => ({ ...f, lines: [...f.lines, { label: '', amount: '' }] }));
  const removeLine = (i) => setForm((f) => ({ ...f, lines: f.lines.filter((_, idx) => idx !== i) }));

  const addTemplate = async (e) => {
    e.preventDefault();
    const cleanLines = form.lines
      .map((ln) => ({ label: ln.label.trim(), amount: Number(ln.amount) }))
      .filter((ln) => ln.label);
    if (!form.name.trim()) { notify.error('Template name is required'); return; }
    if (cleanLines.length === 0) { notify.error('Add at least one line item'); return; }
    if (cleanLines.some((ln) => !Number.isFinite(ln.amount))) {
      notify.error('Every line needs a numeric amount');
      return;
    }
    setSaving(true);
    try {
      const created = await fetchApi('/api/travel/visa/quotation-templates', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name.trim(),
          applicationType: form.applicationType,
          currency: form.currency.trim() || 'INR',
          lines: cleanLines,
        }),
      });
      setItems((prev) => [...prev, created]);
      setForm(EMPTY_QUOTE_FORM);
      notify.success('Quotation template added');
    } catch (e) {
      notify.error(e?.message || 'Failed to add quotation template');
    } finally {
      setSaving(false);
    }
  };

  const removeTemplate = async (it) => {
    const snapshot = items;
    setItems((prev) => prev.filter((x) => x.id !== it.id));
    try {
      await fetchApi(`/api/travel/visa/quotation-templates/${it.id}`, { method: 'DELETE', silent: true });
    } catch (e) {
      setItems(snapshot);
      notify.error(e?.message || 'Failed to delete');
    }
  };

  const toggleActive = async (it) => {
    const next = !it.isActive;
    setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, isActive: next } : x)));
    try {
      await fetchApi(`/api/travel/visa/quotation-templates/${it.id}`, {
        method: 'PUT',
        body: JSON.stringify({ isActive: next }),
        silent: true,
      });
    } catch (e) {
      setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, isActive: it.isActive } : x)));
      notify.error(e?.message || 'Failed to update');
    }
  };

  const templateTotal = (lines) =>
    Array.isArray(lines) ? lines.reduce((s, l) => s + (Number(l.amount) || 0), 0) : 0;
  const formTotal = form.lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);

  const groups = {};
  for (const it of items) (groups[it.applicationType] = groups[it.applicationType] || []).push(it);
  const groupKeys = Object.keys(groups).sort();

  return (
    <div>
      {/* Add form */}
      <form onSubmit={addTemplate} style={{ ...card, marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: '0.78rem', color: 'var(--text-secondary)', flex: 1, minWidth: 200 }}>
            Template name
            <input
              data-testid="quote-add-name"
              type="text"
              placeholder="e.g. Tourist visa — standard"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              style={inputStyle}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
            Visa type
            <select
              data-testid="quote-add-type"
              value={form.applicationType}
              onChange={(e) => setForm({ ...form, applicationType: e.target.value })}
              style={inputStyle}
            >
              {APPLICATION_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: '0.78rem', color: 'var(--text-secondary)', width: 90 }}>
            Currency
            <input
              data-testid="quote-add-currency"
              type="text"
              value={form.currency}
              onChange={(e) => setForm({ ...form, currency: e.target.value })}
              style={inputStyle}
            />
          </label>
        </div>

        {/* Line items editor */}
        <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: 6 }}>Line items</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {form.lines.map((ln, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                data-testid={`quote-line-label-${i}`}
                type="text"
                placeholder="e.g. Service tier base price (use a negative amount to credit)"
                value={ln.label}
                onChange={(e) => setLine(i, { label: e.target.value })}
                style={{ ...inputStyle, flex: 1 }}
              />
              <input
                data-testid={`quote-line-amount-${i}`}
                type="number"
                step="0.01"
                placeholder="amount"
                value={ln.amount}
                onChange={(e) => setLine(i, { amount: e.target.value })}
                style={{ ...inputStyle, width: 120 }}
              />
              <button
                type="button"
                data-testid={`quote-line-remove-${i}`}
                aria-label="Remove line"
                onClick={() => removeLine(i)}
                disabled={form.lines.length === 1}
                style={{ border: '1px solid var(--border-color)', background: 'var(--input-bg)', color: 'var(--text-secondary)', borderRadius: 6, padding: '0.35rem', cursor: form.lines.length === 1 ? 'not-allowed' : 'pointer', opacity: form.lines.length === 1 ? 0.4 : 1 }}
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10 }}>
          <button
            type="button"
            data-testid="quote-add-line"
            onClick={addLine}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '0.35rem 0.7rem', borderRadius: 6, border: '1px dashed var(--border-color)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.8rem' }}
          >
            <Plus size={13} /> Add line
          </button>
          <span style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', marginLeft: 'auto' }}>
            Total: <strong style={{ color: 'var(--text-primary)' }}>{form.currency || 'INR'} {formTotal.toLocaleString()}</strong>
          </span>
          <button type="submit" disabled={saving} data-testid="quote-add-submit" style={{ ...primaryBtn, opacity: saving ? 0.6 : 1 }}>
            <Plus size={14} /> {saving ? 'Adding…' : 'Add template'}
          </button>
        </div>
      </form>

      {loading ? (
        <div style={{ ...card, textAlign: 'center', color: 'var(--text-secondary)', padding: '3rem' }}>Loading quotation templates…</div>
      ) : groupKeys.length === 0 ? (
        <div style={{ ...card, textAlign: 'center', padding: '3rem' }}>
          <Receipt size={44} color="var(--text-secondary)" style={{ marginBottom: 10, opacity: 0.6 }} />
          <h2 style={{ fontSize: '1.1rem', color: 'var(--text-primary)', margin: '0 0 6px' }}>No quotation templates yet</h2>
          <p style={{ color: 'var(--text-secondary)', margin: 0, fontSize: '0.9rem' }}>
            Create a curated quotation per visa type so advisors can auto-fill standard quotes.
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {groupKeys.map((type) => (
            <div key={type} style={card} data-testid={`quote-group-${type}`}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <span style={{ padding: '0.2rem 0.6rem', borderRadius: 999, fontSize: '0.78rem', fontWeight: 600, background: 'var(--input-bg)', color: 'var(--primary-color, var(--accent-color))', border: '1px solid var(--border-color)' }}>
                  {TYPE_LABEL[type] || type}
                </span>
                <span style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', marginLeft: 'auto' }}>
                  {groups[type].length} template{groups[type].length === 1 ? '' : 's'}
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {groups[type].map((it) => (
                  <div key={it.id} data-testid={`quote-row-${it.id}`} style={{ border: '1px solid var(--border-color)', borderRadius: 10, padding: '0.7rem 0.9rem', opacity: it.isActive ? 1 : 0.55 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                      <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{it.name}</span>
                      <span style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', marginLeft: 'auto' }}>
                        {it.currency} {templateTotal(it.lines).toLocaleString()}
                      </span>
                      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: '0.76rem', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                        <input type="checkbox" data-testid={`quote-active-${it.id}`} checked={!!it.isActive} onChange={() => toggleActive(it)} />
                        Active
                      </label>
                      <button
                        type="button"
                        data-testid={`quote-delete-${it.id}`}
                        aria-label={`Delete ${it.name}`}
                        onClick={() => removeTemplate(it)}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '0.3rem 0.6rem', borderRadius: 6, border: '1px solid rgba(239,68,68,0.3)', background: 'rgba(239,68,68,0.12)', color: '#ef4444', cursor: 'pointer', fontSize: '0.76rem' }}
                      >
                        <Trash2 size={13} /> Delete
                      </button>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      {(it.lines || []).map((ln, idx) => (
                        <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
                          <span>{ln.label}</span>
                          <span style={{ color: ln.amount < 0 ? '#16a34a' : 'var(--text-primary)' }}>
                            {it.currency} {Number(ln.amount).toLocaleString()}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
