import { useCallback, useEffect, useState } from 'react';
import { Edit, FileText, Plus, RefreshCw, Save, Trash2, X } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';

const DEFAULTS = [
  {
    key: 'newLead',
    name: 'generic_new_lead_pickup_plot',
    label: 'New lead — welcome & pickup/plot',
    body: 'Hi {{1}}, thank you for contacting {{5}} through {{6}}. We received your enquiry from {{2}} ({{3}}, {{4}}). Choose your pickup location and interested plot here: {{7}}. Thank you.',
    variableMapping: { 1: 'contact.first_name', 2: 'contact.company', 3: 'contact.email', 4: 'contact.phone', 5: 'organization.name', 6: 'form.name', 7: 'system.pickupPlotLink' },
  },
  {
    key: 'existingLead',
    name: 'generic_lead_details_updated',
    label: 'Lead details updated — pickup/plot',
    body: 'Hi {{1}}, we received your updated details for {{2}} ({{3}}, {{4}}) through {{6}}. Our {{5}} team will review them and contact you if anything else is needed. Thank you.',
    variableMapping: { 1: 'contact.first_name', 2: 'contact.company', 3: 'contact.email', 4: 'contact.phone', 5: 'organization.name', 6: 'form.name' },
  },
  {
    key: 'pickupPlotRequest',
    name: 'generic_pickup_plot_request',
    label: 'Pickup & plot selection request',
    body: 'Hi {{1}}, please submit your preferred pickup location and interested plot here: {{3}}. Your lead details will be updated after submission. Thank you from the {{2}} team.',
    variableMapping: { 1: 'contact.first_name', 2: 'organization.name', 3: 'system.pickupPlotLink' },
  },
];

const META_LANGUAGE = 'en_US';
const GENERIC_SYSTEM_CATEGORY_PREFIX = 'System: Generic CRM:';
const WHATSAPP_PREVIEW_VALUES = {
  'contact.name': 'Rahul Sharma',
  'contact.first_name': 'Rahul',
  'contact.last_name': 'Sharma',
  'contact.email': 'rahul@example.com',
  'contact.phone': '+1 555 0100',
  'contact.whatsappPhone': '+1 555 0100',
  'contact.company': 'Example Company',
  'organization.name': 'NovaCrest Technologies',
  'form.name': 'Website enquiry form',
  'system.pickupPlotLink': 'https://example.com/select-pickup-plot',
};

function whatsappPreviewBody(template) {
  let mapping = template?.variableMapping;
  try { mapping = typeof mapping === 'string' ? JSON.parse(mapping) : (mapping || {}); } catch { mapping = {}; }
  const defaultMapping = DEFAULTS.find(item => item.name === template?.name)?.variableMapping || {};
  const resolvedMapping = { ...defaultMapping, ...mapping };
  return String(template?.body || '')
    .replace(/\{\{\s*(\d+)\s*\}\}/g, (_match, index) => WHATSAPP_PREVIEW_VALUES[resolvedMapping[index]] || `Sample value ${index}`)
    .replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key) => WHATSAPP_PREVIEW_VALUES[key] || key.split('.').at(-1)?.replace(/_/g, ' ') || 'Sample value')
    .replace(/\[Contact Name\]/gi, WHATSAPP_PREVIEW_VALUES['contact.name'])
    .replace(/\[First Name\]/gi, WHATSAPP_PREVIEW_VALUES['contact.first_name'])
    .replace(/\[Last Name\]/gi, WHATSAPP_PREVIEW_VALUES['contact.last_name'])
    .replace(/\[Contact Email\]/gi, WHATSAPP_PREVIEW_VALUES['contact.email'])
    .replace(/\[Contact Phone\]/gi, WHATSAPP_PREVIEW_VALUES['contact.phone']);
}

function isDefaultWhatsAppTemplate(template) {
  return DEFAULTS.some(item => item.name === template?.name);
}

function isGenericSystemTemplate(template) {
  return String(template?.category || '').startsWith(GENERIC_SYSTEM_CATEGORY_PREFIX);
}

const META_STATUS = {
  APPROVED: { label: 'Approved', color: 'var(--success-color)', background: 'color-mix(in srgb, var(--success-color) 12%, transparent)' },
  PENDING: { label: 'Pending', color: 'var(--warning-color)', background: 'color-mix(in srgb, var(--warning-color) 12%, transparent)' },
  REJECTED: { label: 'Rejected', color: 'var(--danger-color)', background: 'color-mix(in srgb, var(--danger-color) 10%, transparent)' },
};

function MetaStatusBadge({ status }) {
  const normalized = String(status || 'PENDING').toUpperCase();
  const details = META_STATUS[normalized] || { label: normalized, color: 'var(--text-secondary)', background: 'var(--subtle-bg)' };
  return <span aria-label={`Meta approval status: ${details.label}`} style={{ alignSelf: 'flex-start', padding: '0.25rem 0.5rem', borderRadius: 999, color: details.color, background: details.background, fontSize: '0.7rem', fontWeight: 700, lineHeight: 1.2, whiteSpace: 'nowrap', flexShrink: 0 }}>{details.label}</span>;
}

export default function GenericWhatsAppTemplates({ hideCreateButton = false, mergeIntoParentGrid = false, onCreateWhatsAppTemplate, onEditWhatsAppTemplate, onPreviewWhatsAppTemplate, onCreateSequenceCopy, sequenceTemplates = [], sequenceLoading, sequenceLoadError, onEditSequenceCopy, onDeleteSequenceCopy, onRetrySequenceCopies, refreshKey }) {
  const notify = useNotify();
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [editor, setEditor] = useState(null);
  const [preview, setPreview] = useState(null);
  const [saving, setSaving] = useState(false);

  const openPreview = (template) => {
    if (onPreviewWhatsAppTemplate) onPreviewWhatsAppTemplate(template);
    else setPreview(template);
  };

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const rows = await fetchApi('/api/whatsapp/templates');
      setTemplates(Array.isArray(rows) ? rows : []);
    } catch (error) {
      setLoadError(error?.message || 'Could not load WhatsApp templates.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load, refreshKey]);

  const save = async () => {
    if (!editor?.name?.trim() || !editor?.body?.trim()) {
      notify.error('Template name and message are required');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: editor.name.trim(),
        body: editor.body.trim(),
        category: editor.category || 'UTILITY',
        language: editor.language || 'en',
        footer: editor.footer || '',
        variableMapping: editor.variableMapping || {},
      };
      if (editor.id) {
        await fetchApi(`/api/whatsapp/templates/${editor.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      } else {
        await fetchApi('/api/whatsapp/templates', { method: 'POST', body: JSON.stringify(payload) });
      }
      setEditor(null);
      await load();
      notify.success(editor.id ? 'WhatsApp template updated' : 'WhatsApp template submitted to Meta');
    } catch {
      // fetchApi displays the API error.
    } finally {
      setSaving(false);
    }
  };

  const remove = async (template) => {
    if (!await notify.confirm(`Delete WhatsApp template "${template.name}"?`)) return;
    try {
      await fetchApi(`/api/whatsapp/templates/${template.id}`, { method: 'DELETE' });
      await load();
      notify.success('WhatsApp template deleted');
    } catch {
      // fetchApi displays the API error.
    }
  };

  const unsubmittedDefaults = DEFAULTS.filter(item => !templates.some(template => template.name === item.name));

  return (
    <section aria-label="WhatsApp Business templates" style={mergeIntoParentGrid ? { display: 'contents' } : undefined}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap', ...(mergeIntoParentGrid ? { gridColumn: '1 / -1' } : {}) }}>
        <div>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', margin: 0 }}>WhatsApp messages need Meta approval before sending. The pickup/plot request defaults include the system-generated secure selection link.</p>
        </div>
        {!hideCreateButton && <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button type="button" className="btn-primary" onClick={() => onCreateWhatsAppTemplate ? onCreateWhatsAppTemplate() : setEditor({ name: '', body: '', category: 'UTILITY', language: META_LANGUAGE, footer: '' })} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}><Plus size={15} /> Create New Template</button>
        </div>}
      </div>

      <div style={mergeIntoParentGrid
        ? { display: 'contents' }
        : { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))', gap: '1rem', marginTop: '0.9rem' }}>
      {unsubmittedDefaults.length > 0 && <div style={{ display: 'contents' }}>
        <div style={{ display: 'contents' }}>
          {unsubmittedDefaults.map(item => (
            <article key={item.key} className="card" style={{ padding: '1.1rem', display: 'flex', flexDirection: 'column', gap: '0.65rem', minWidth: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}><strong style={{ fontSize: '0.95rem' }}>{item.key === 'existingLead' ? 'Lead details updated' : item.label}</strong><button type="button" aria-label={`Preview ${item.label}`} title="Preview template" onClick={() => openPreview({ ...item, category: 'UTILITY', language: META_LANGUAGE })} style={previewIconButtonStyle}><FileText size={18} /></button></div>
              <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>Generic CRM default · Meta approval required</span>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', lineHeight: 1.5, overflowWrap: 'anywhere', margin: 0 }}>{item.body}</p>
              <button type="button" className="btn-secondary" onClick={() => onEditWhatsAppTemplate ? onEditWhatsAppTemplate({ ...item, category: 'UTILITY', language: META_LANGUAGE, footer: '' }) : setEditor({ ...item, category: 'UTILITY', language: META_LANGUAGE, footer: '' })} style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}><Edit size={14} /> Edit</button>
            </article>
          ))}
        </div>
      </div>}

      <div style={{ display: 'contents' }}>
        {loading ? <p style={{ color: 'var(--text-secondary)' }}>Loading WhatsApp templates…</p> : loadError ? (
          <div role="alert" style={{ marginTop: '0.6rem' }}><p>{loadError}</p><button type="button" className="btn-secondary" onClick={load}><RefreshCw size={14} /> Try again</button></div>
        ) : templates.length === 0 && sequenceTemplates.length === 0 ? <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>No templates yet. Edit a default card above or create a new template.</p> : (
          <div style={{ display: 'contents' }}>
            {templates.map(template => (
              <article key={template.id} className="card" style={{ padding: '1.1rem', display: 'flex', flexDirection: 'column', gap: '0.55rem', minWidth: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
                  <strong style={{ overflowWrap: 'anywhere' }}>{DEFAULTS.find(item => item.name === template.name)?.label || template.name}</strong>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.4rem' }}><MetaStatusBadge status={template.status} /><button type="button" aria-label={`Preview ${template.name}`} title="Preview template" onClick={() => openPreview(template)} style={previewIconButtonStyle}><FileText size={18} /></button></div>
                </div>
                <div style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', marginTop: '0.25rem' }}>{template.category} · {template.language}</div>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', lineHeight: 1.5, overflowWrap: 'anywhere', margin: 0 }}>{template.body}</p>
                <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.6rem' }}>
                  <button type="button" className="btn-secondary" onClick={() => onEditWhatsAppTemplate ? onEditWhatsAppTemplate(template) : setEditor({ ...template })} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}><Edit size={14} /> Edit</button>
                  {!isDefaultWhatsAppTemplate(template) && <button type="button" className="btn-secondary" onClick={() => remove(template)} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', color: '#ef4444' }}><Trash2 size={14} /> Delete</button>}
                </div>
              </article>
            ))}
            {sequenceTemplates.map(template => (
              <article key={`sequence-${template.id}`} className="card" style={{ padding: '1.1rem', display: 'flex', flexDirection: 'column', gap: '0.55rem', minWidth: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem' }}><strong style={{ overflowWrap: 'anywhere' }}>{template.name}</strong><div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}><span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>SEQUENCE</span><button type="button" aria-label={`Preview ${template.name}`} title="Preview template" onClick={() => openPreview(template)} style={previewIconButtonStyle}><FileText size={18} /></button></div></div>
                <div style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>{template.category || 'General'} · Sequence copy</div>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', lineHeight: 1.5, overflowWrap: 'anywhere', margin: 0 }}>{(template.body || '').replace(/<[^>]+>/g, '').slice(0, 180)}</p>
                <div style={{ display: 'flex', gap: '0.4rem', marginTop: 'auto' }}><button type="button" className="btn-secondary" onClick={() => onEditSequenceCopy(template)}><Edit size={14} /> Edit</button>{!isGenericSystemTemplate(template) && <button type="button" className="btn-secondary" onClick={() => onDeleteSequenceCopy(template)} style={{ color: '#ef4444' }}><Trash2 size={14} /> Delete</button>}</div>
              </article>
            ))}
          </div>
        )}
      </div>
      </div>

      {preview && <div role="presentation" onClick={() => setPreview(null)} style={previewBackdropStyle}>
        <div role="dialog" aria-label="Preview WhatsApp template" className="card" onClick={event => event.stopPropagation()} style={previewModalStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.75rem' }}>
            <div><h3 style={{ margin: 0 }}>{DEFAULTS.find(item => item.name === preview.name)?.label || preview.label || preview.name}</h3><p style={{ margin: '0.35rem 0 0', color: 'var(--text-secondary)', fontSize: '0.78rem' }}>{preview.category || 'UTILITY'} · {preview.language || META_LANGUAGE}</p></div>
            <button type="button" onClick={() => setPreview(null)} aria-label="Close preview" style={closeIconButtonStyle}><X size={20} /></button>
          </div>
          <div style={{ marginTop: '1rem', padding: '1rem', border: '1px solid var(--border-color)', borderRadius: 10, background: 'var(--input-bg)', color: 'var(--text-primary)', lineHeight: 1.6, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{whatsappPreviewBody(preview) || 'No message content'}</div>
          {preview.footer && <p style={{ color: 'var(--text-secondary)', fontSize: '0.78rem', margin: '0.75rem 0 0' }}>{preview.footer}</p>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1rem' }}><button type="button" className="btn-secondary" onClick={() => setPreview(null)}>Close</button></div>
        </div>
      </div>}

      {editor && <div role="presentation" onClick={() => setEditor(null)} style={{ position: 'fixed', inset: 0, zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', background: 'var(--overlay-bg, rgba(0,0,0,.55))' }}>
        <div role="dialog" aria-label="WhatsApp template editor" className="card" onClick={event => event.stopPropagation()} style={{ width: 'min(680px, 100%)', maxHeight: '90vh', overflowY: 'auto', padding: '1.25rem' }}>
          <h3>{editor.id ? 'Edit WhatsApp template' : 'Create WhatsApp template'}</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>New templates are submitted to Meta for approval. Pickup/plot request templates receive the secure selection link automatically when sent.</p>
          <div style={{ display: 'grid', gap: '0.75rem' }}>
            <label style={{ display: 'grid', gap: '0.3rem' }}>Template name<input className="input-field" value={editor.name || ''} onChange={event => setEditor(current => ({ ...current, name: event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') }))} /></label>
            <label style={{ display: 'grid', gap: '0.3rem' }}>Message<textarea className="input-field" rows={6} value={editor.body || ''} onChange={event => setEditor(current => ({ ...current, body: event.target.value }))} /></label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
              <label style={{ display: 'grid', gap: '0.3rem' }}>Category<select className="input-field" value={editor.category || 'UTILITY'} onChange={event => setEditor(current => ({ ...current, category: event.target.value }))}><option>UTILITY</option><option>MARKETING</option><option>AUTHENTICATION</option></select></label>
              <label style={{ display: 'grid', gap: '0.3rem' }}>Language<input className="input-field" value={editor.language || 'en'} onChange={event => setEditor(current => ({ ...current, language: event.target.value }))} /></label>
            </div>
            <label style={{ display: 'grid', gap: '0.3rem' }}>Footer (optional)<input className="input-field" value={editor.footer || ''} onChange={event => setEditor(current => ({ ...current, footer: event.target.value }))} /></label>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' }}>
            <button type="button" className="btn-secondary" onClick={() => setEditor(null)}>Cancel</button>
            <button type="button" className="btn-primary" disabled={saving} onClick={save} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}><Save size={15} /> {saving ? 'Saving…' : 'Save Template'}</button>
          </div>
        </div>
      </div>}
    </section>
  );
}

const previewIconButtonStyle = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, padding: 0, border: 0, background: 'transparent', color: 'var(--accent-color)', cursor: 'pointer' };
const closeIconButtonStyle = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0.25rem', border: 0, background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' };
const previewBackdropStyle = { position: 'fixed', inset: 0, zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', background: 'var(--overlay-bg, rgba(0,0,0,.55))' };
const previewModalStyle = { width: 'min(620px, 100%)', maxHeight: '90vh', overflowY: 'auto', padding: '1.25rem', background: 'var(--modal-bg)', opacity: 1 };
