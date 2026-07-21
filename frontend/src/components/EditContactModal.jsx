import { useState } from 'react';
import { X } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';

const PHONE_RE = /^\+?[\d\s\-().]{7,15}$/;
const ALLOWED_STATUSES = ['Lead', 'Prospect', 'Customer', 'Churned', 'Junk'];

// ── EditContactModal — full "edit everything at once" entry point ──────
//
// A second way to edit a contact alongside Contacts.jsx's new per-cell
// InlineCellEditor (which only edits ONE custom field at a time, in place).
// This modal edits the built-in fields (name/email/phone/company/title/
// status) plus every custom field, all in one PUT — same pattern as
// ContactDetail.jsx's inline edit form, just lifted into a standalone modal
// component so Contacts.jsx's Actions column can open it without
// navigating to the detail page.
//
// Props: contact (full row, already loaded by the parent — no extra
// fetch), customFieldDefs (already-loaded tenant field definitions),
// onClose(), onSaved(updatedContact).
export default function EditContactModal({ contact, customFieldDefs, onClose, onSaved }) {
  const notify = useNotify();
  const [form, setForm] = useState({
    name: contact.name || '',
    email: contact.email || '',
    phone: contact.phone || '',
    company: contact.company || '',
    title: contact.title || '',
    status: contact.status || 'Lead',
    customFields: { ...(contact.customFields || {}) },
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleCustomFieldChange = (key, value) => {
    setForm(prev => ({ ...prev, customFields: { ...prev.customFields, [key]: value } }));
  };

  const handleSave = async (e) => {
    e.preventDefault();
    const phone = (form.phone || '').trim();
    if (phone && !PHONE_RE.test(phone)) {
      setError('Enter a valid phone number (digits, +, spaces, hyphens only)');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const updated = await fetchApi(`/api/contacts/${contact.id}`, {
        method: 'PUT',
        body: JSON.stringify(form),
      });
      notify.success('Contact updated');
      onSaved?.(updated);
    } catch (err) {
      setError(err?.body?.error || err?.message || 'Could not save changes.');
    } finally {
      setSaving(false);
    }
  };

  const renderCustomFieldInputs = () => {
    if (!customFieldDefs || customFieldDefs.length === 0) return null;
    return customFieldDefs.map((f) => {
      const value = form.customFields?.[f.fieldKey] ?? '';
      const label = <span style={{ fontSize: '0.7rem', fontWeight: '600', color: 'var(--text-secondary)' }}>{f.label}</span>;
      const titleAttr = f.tooltip ? { title: f.tooltip } : {};
      const placeholder = f.placeholder || `${f.label}…`;

      if (f.fieldType === 'checkbox') {
        return (
          <label key={f.id} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem' }} {...titleAttr}>
            <input type="checkbox" checked={Boolean(value)} onChange={e => handleCustomFieldChange(f.fieldKey, e.target.checked)} />
            {f.label}
          </label>
        );
      }
      if (f.fieldType === 'dropdown' || f.fieldType === 'radio') {
        return (
          <label key={f.id} style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }} {...titleAttr}>
            {label}
            <select className="input-field" required={f.isRequired} value={value} onChange={e => handleCustomFieldChange(f.fieldKey, e.target.value)} style={{ padding: '0.45rem', fontSize: '0.85rem' }}>
              <option value="">Select…</option>
              {(f.options || []).map((opt) => <option key={opt} value={opt}>{opt}</option>)}
            </select>
          </label>
        );
      }
      if (f.fieldType === 'multiselect') {
        const selected = Array.isArray(value) ? value : (value ? [value] : []);
        return (
          <div key={f.id} style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }} {...titleAttr}>
            {label}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
              {(f.options || []).map((opt) => (
                <label key={opt} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.8rem', padding: '0.2rem 0.5rem', borderRadius: 6, border: '1px solid var(--border-color)', background: 'var(--surface-color)', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={selected.includes(opt)}
                    onChange={(e) => {
                      const next = e.target.checked ? [...selected, opt] : selected.filter((s) => s !== opt);
                      handleCustomFieldChange(f.fieldKey, next);
                    }}
                  />
                  {opt}
                </label>
              ))}
            </div>
          </div>
        );
      }
      if (f.fieldType === 'textarea') {
        return (
          <label key={f.id} style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }} {...titleAttr}>
            {label}
            <textarea
              className="input-field"
              required={f.isRequired}
              value={value}
              placeholder={placeholder}
              maxLength={2000}
              rows={3}
              onChange={e => handleCustomFieldChange(f.fieldKey, e.target.value)}
              style={{ padding: '0.45rem', fontSize: '0.85rem' }}
            />
          </label>
        );
      }
      const inputType = f.fieldType === 'date' ? 'date' : f.fieldType === 'number' ? 'number' : f.fieldType === 'url' ? 'url' : 'text';
      return (
        <label key={f.id} style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }} {...titleAttr}>
          {label}
          <input
            className="input-field"
            type={inputType}
            required={f.isRequired}
            placeholder={placeholder}
            value={value}
            onChange={e => handleCustomFieldChange(f.fieldKey, e.target.value)}
            style={{ padding: '0.45rem', fontSize: '0.85rem' }}
          />
        </label>
      );
    });
  };

  return (
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'var(--overlay-bg)', backdropFilter: 'blur(5px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1200 }}>
      <div className="card" style={{ padding: '2rem', width: '480px', maxHeight: '85vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
          <h3 style={{ fontSize: '1.25rem', fontWeight: 'bold' }}>Edit Contact</h3>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}>
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <input type="text" placeholder="Name" required className="input-field" value={form.name} onChange={e => setForm(prev => ({ ...prev, name: e.target.value }))} />
          <input type="email" placeholder="Email" required className="input-field" value={form.email} onChange={e => setForm(prev => ({ ...prev, email: e.target.value }))} />
          <input type="tel" placeholder="Phone" className="input-field" value={form.phone} onChange={e => setForm(prev => ({ ...prev, phone: e.target.value }))} />
          <input type="text" placeholder="Company" className="input-field" value={form.company} onChange={e => setForm(prev => ({ ...prev, company: e.target.value }))} />
          <input type="text" placeholder="Job title" className="input-field" value={form.title} onChange={e => setForm(prev => ({ ...prev, title: e.target.value }))} />
          <select className="input-field" value={form.status} onChange={e => setForm(prev => ({ ...prev, status: e.target.value }))}>
            {ALLOWED_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>

          {customFieldDefs?.length > 0 && (
            <>
              <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '0.75rem', fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Custom Fields
              </div>
              {renderCustomFieldInputs()}
            </>
          )}

          {error && <p style={{ color: '#ef4444', fontSize: '0.8rem' }}>{error}</p>}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '1rem', marginTop: '0.5rem' }}>
            <button type="button" onClick={onClose} style={{ background: 'transparent', color: 'var(--text-secondary)', border: 'none', cursor: 'pointer' }}>Cancel</button>
            <button type="submit" disabled={saving} className="btn-primary">{saving ? 'Saving…' : 'Save Changes'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
