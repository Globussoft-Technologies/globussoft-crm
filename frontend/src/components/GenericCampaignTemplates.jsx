import React, { useEffect, useRef, useState } from 'react';
import { AlignCenter, AlignLeft, AlignRight, Bold, Edit, Eye, FileText, Italic, Link, Plus, Save, Search, Sparkles, Trash2, Underline, X } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';

const TEMPLATE_CHANNELS = [
  { value: 'EMAIL', label: 'Email' },
  { value: 'SMS', label: 'SMS' },
  { value: 'WHATSAPP', label: 'WhatsApp' },
];

const EMPTY_TEMPLATE = { name: '', subject: '', category: 'General', body: '', channel: 'EMAIL' };
const SENDER_DETAIL_FIELDS = [
  { key: 'sender.name', label: 'Sender Name', group: 'Sender Details' },
  { key: 'sender.email', label: 'Sender Email', group: 'Sender Details' },
  { key: 'sender.company', label: 'Sender Company', group: 'Sender Details' },
];
const DEFAULT_PERSONALIZATION_FIELDS = [
  { key: 'contact.name', label: 'Contact Name', group: 'Contact' },
  { key: 'contact.first_name', label: 'First Name', group: 'Contact' },
  { key: 'contact.last_name', label: 'Last Name', group: 'Contact' },
  { key: 'contact.email', label: 'Contact Email', group: 'Contact' },
  { key: 'contact.phone', label: 'Contact Phone', group: 'Contact' },
  { key: 'contact.company', label: 'Contact Company', group: 'Contact' },
  { key: 'enrollmentId', label: 'Enrollment ID', group: 'Campaign' },
  { key: 'sequenceId', label: 'Sequence ID', group: 'Campaign' },
  { key: 'deal.title', label: 'Deal Title', group: 'Deal' },
  { key: 'invoice.number', label: 'Invoice Number', group: 'Invoice' },
  { key: 'payment.description', label: 'Payment Description', group: 'Payment' },
  { key: 'pickup.address', label: 'Pickup Address', group: 'Pickup' },
  { key: 'visit.title', label: 'Visit Title', group: 'Visit' },
  { key: 'task.title', label: 'Task Title', group: 'Task' },
  { key: 'activity.description', label: 'Activity Description', group: 'Activity' },
  { key: 'expense.title', label: 'Expense Title', group: 'Expense' },
  { key: 'contract.title', label: 'Contract Title', group: 'Contract' },
  { key: 'estimate.title', label: 'Estimate Title', group: 'Estimate' },
  { key: 'project.name', label: 'Project Name', group: 'Project' },
];

function toEditorHtml(value, fields) {
  let html = String(value || '');
  fields.forEach(field => {
    const escapedKey = field.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    html = html.replace(new RegExp(`\\{\\{\\s*${escapedKey}\\s*\\}\\}`, 'g'), `<span data-template-variable="${field.key}" contenteditable="false">[${field.label}]</span>`);
  });
  return html;
}

function fromEditorHtml(element) {
  const clone = element.cloneNode(true);
  clone.querySelectorAll('[data-template-variable]').forEach(token => {
    token.replaceWith(`{{${token.getAttribute('data-template-variable')}}}`);
  });
  return clone.innerHTML;
}

export default function GenericCampaignTemplates() {
  const notify = useNotify();
  const [templates, setTemplates] = useState([]);
  const [templatePage, setTemplatePage] = useState(1);
  const [templateChannel, setTemplateChannel] = useState('EMAIL');
  const [templatePagination, setTemplatePagination] = useState({ page: 1, pageSize: 10, total: 0, totalPages: 1 });
  const [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState(null);
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [aiDraftError, setAiDraftError] = useState('');
  const [fields, setFields] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [preview, setPreview] = useState(null);
  const [previewContactId, setPreviewContactId] = useState('');
  const [personalizationOpen, setPersonalizationOpen] = useState(false);
  const [personalizationTarget, setPersonalizationTarget] = useState('body');
  const [personalizationQuery, setPersonalizationQuery] = useState('');
  const [personalizationGroup, setPersonalizationGroup] = useState('');
  const editorRef = useRef(null);
  const editorIdentityRef = useRef(null);

  const loadTemplates = async () => {
    setLoading(true);
    try {
      const result = await fetchApi(`/api/email-templates?paginate=1&page=${templatePage}&limit=10&channel=${templateChannel}`);
      setTemplates(Array.isArray(result) ? result : (result?.items || []));
      if (result?.pagination) setTemplatePagination(result.pagination);
    } catch (_error) {
      setTemplates([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadTemplates(); }, [templatePage, templateChannel]);

  useEffect(() => {
    setTemplatePage(1);
  }, [templateChannel]);

  useEffect(() => {
    Promise.all([
      fetchApi('/api/email-templates/personalization-fields', { silent: true }).catch(() => ({ fields: [] })),
      fetchApi('/api/contacts?fields=summary&limit=100', { silent: true }).catch(() => ({ data: [] })),
    ]).then(([fieldResponse, contactResponse]) => {
      const availableFields = Array.isArray(fieldResponse) ? fieldResponse : (fieldResponse?.fields || []);
      const baseFields = availableFields.length > SENDER_DETAIL_FIELDS.length
        ? availableFields
        : [...DEFAULT_PERSONALIZATION_FIELDS, ...availableFields];
      const existingKeys = new Set(baseFields.map(field => field.key));
      setFields([...baseFields, ...SENDER_DETAIL_FIELDS.filter(field => !existingKeys.has(field.key))]);
      const rows = Array.isArray(contactResponse) ? contactResponse : (contactResponse?.data || []);
      setContacts(rows);
      if (rows[0]?.id) setPreviewContactId(String(rows[0].id));
    });
  }, []);

  useEffect(() => {
    if (!editor || !editorRef.current) {
      editorIdentityRef.current = null;
      return;
    }
    const identity = `${editor.id || 'new'}:${fields.length}`;
    if (editorIdentityRef.current !== identity) {
      editorRef.current.innerHTML = toEditorHtml(editor.body, fields);
      editorIdentityRef.current = identity;
    }
  }, [editor, fields]);

  const insertVariable = (field) => {
    const placeholder = `{{${field.key}}}`;
    if (personalizationTarget === 'subject') {
      setEditor(current => ({ ...current, subject: `${current.subject || ''}${placeholder}` }));
    } else if (editorRef.current) {
      editorRef.current.focus();
      document.execCommand('insertHTML', false, `<span data-template-variable="${field.key}" contenteditable="false">[${field.label}]</span>&nbsp;`);
      setEditor(current => ({ ...current, body: fromEditorHtml(editorRef.current) }));
    }
    setPersonalizationOpen(false);
  };

  const runCommand = (command, value = null) => {
    if (!editorRef.current) return;
    editorRef.current.focus();
    document.execCommand(command, false, value);
    setEditor(current => ({ ...current, body: fromEditorHtml(editorRef.current) }));
  };

  const previewTemplate = async () => {
    if (!editor?.body?.trim()) return notify.error('Add email content before previewing');
    try {
      const result = await fetchApi('/api/email-templates/preview', {
        method: 'POST',
        body: JSON.stringify({ subject: editor.subject, body: editor.body, contactId: previewContactId || null }),
      });
      setPreview(result);
    } catch (error) {
      notify.error(error?.message || 'Failed to preview template');
    }
  };

  const writeWithAi = async () => {
    const subject = editor?.subject?.trim();
    if (!subject) return notify.error('Add a subject before writing with AI');
    setAiDraftError('');
    setGenerating(true);
    try {
      const result = await fetchApi('/api/email-templates/ai-draft', {
        method: 'POST',
        body: JSON.stringify({ subject }),
        silent: true,
      });
      const body = result?.body || '';
      setEditor(current => ({ ...current, body }));
      if (editorRef.current) editorRef.current.innerHTML = toEditorHtml(body, fields);
      notify.success('AI draft added to the email body');
    } catch (error) {
      if (error?.code === 'AI_NOT_CONFIGURED') {
        setAiDraftError('Your organization has not configured an AI provider yet.');
        notify.error('AI access is not configured yet');
      } else {
        notify.error(error?.message || 'AI could not write the email template');
      }
    } finally {
      setGenerating(false);
    }
  };

  const saveTemplate = async () => {
    if (!editor?.name?.trim() || !editor?.subject?.trim() || !editor?.body?.trim()) {
      notify.error('Template name, subject, and email content are required');
      return;
    }
    setBusy(true);
    try {
      const payload = {
        name: editor.name.trim(),
        subject: editor.subject.trim(),
        category: editor.category?.trim() || 'General',
      body: editor.body,
      channel: editor.channel || 'EMAIL',
      };
      if (editor.id) {
        await fetchApi(`/api/email-templates/${editor.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      } else {
        await fetchApi('/api/email-templates', { method: 'POST', body: JSON.stringify(payload) });
      }
      setEditor(null);
      await loadTemplates();
      notify.success(editor.id ? 'Template updated' : 'Template created');
    } catch (error) {
      notify.error(error?.message || 'Failed to save template');
    } finally {
      setBusy(false);
    }
  };

  const deleteTemplate = async (template) => {
    if (!await notify.confirm(`Delete template "${template.name}"?`)) return;
    try {
      await fetchApi(`/api/email-templates/${template.id}`, { method: 'DELETE' });
      setTemplates(current => current.filter(item => item.id !== template.id));
      notify.success('Template deleted');
    } catch (error) {
      notify.error(error?.message || 'Failed to delete template');
    }
  };

  const visibleFields = fields.filter(field => {
    const query = personalizationQuery.trim().toLowerCase();
    return !query || [field.label, field.key, field.group].some(value => String(value || '').toLowerCase().includes(query));
  });
  const groupedFields = visibleFields.reduce((groups, field) => ({ ...groups, [field.group || 'CRM']: [...(groups[field.group || 'CRM'] || []), field] }), {});
  const personalizationGroups = [...new Set(fields.map(field => field.group || 'CRM'))];
  const activePersonalizationGroup = personalizationGroups.includes(personalizationGroup) ? personalizationGroup : (personalizationGroups[0] || '');
  const activePersonalizationFields = visibleFields.filter(field => (field.group || 'CRM') === activePersonalizationGroup);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', flexWrap: 'wrap', marginBottom: '1.5rem' }}>
        <div>
          <h3 style={{ margin: 0, fontSize: '1.25rem' }}>Templates</h3>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <label style={{ ...fieldLabelStyle, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            Type
            <select className="input-field" value={templateChannel} onChange={event => setTemplateChannel(event.target.value)} aria-label="Template type">
              {TEMPLATE_CHANNELS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <button type="button" className="btn-primary" onClick={() => setEditor({ ...EMPTY_TEMPLATE, channel: templateChannel })} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
            <Plus size={16} /> Create New Template
          </button>
        </div>
      </div>

      {loading ? <p style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-secondary)' }}>Loading templates...</p> : templates.length === 0 ? (
        <div className="card" style={{ padding: '4rem', textAlign: 'center' }}>
          <FileText size={42} style={{ color: 'var(--text-secondary)', opacity: 0.35, marginBottom: '1rem' }} />
          <h3 style={{ margin: '0 0 0.5rem' }}>No templates yet</h3>
          <p style={{ color: 'var(--text-secondary)' }}>Create a template to use it in your sequence steps.</p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '1.25rem' }}>
          {templates.map(template => (
            <div key={template.id} className="card" style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.75rem' }}>
                <div style={{ minWidth: 0 }}>
                  <h3 style={{ margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{template.name}</h3>
                  <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>{template.category || 'General'}</span>
                </div>
                <FileText size={20} style={{ color: 'var(--accent-color)', flexShrink: 0 }} />
              </div>
              <div style={{ fontSize: '0.85rem' }}><strong>Subject:</strong> {template.subject}</div>
              <div style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', minHeight: '2.4rem', overflow: 'hidden' }}>
                {(template.body || '').replace(/<[^>]+>/g, '').slice(0, 150)}
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: 'auto' }}>
                <button type="button" className="btn-secondary" onClick={() => setEditor({ id: template.id, name: template.name || '', subject: template.subject || '', category: template.category || 'General', body: template.body || '', channel: template.channel || templateChannel })} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}><Edit size={14} /> Edit</button>
                <button type="button" className="btn-secondary" onClick={() => deleteTemplate(template)} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', color: '#ef4444' }}><Trash2 size={14} /> Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && templates.length > 0 && templatePagination.totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap', padding: '1.25rem 0 0.25rem' }}>
          <button type="button" className="btn-secondary" disabled={templatePage <= 1} onClick={() => setTemplatePage(page => Math.max(1, page - 1))}>Previous</button>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Page {templatePage} of {templatePagination.totalPages}</span>
          <button type="button" className="btn-secondary" disabled={templatePage >= templatePagination.totalPages} onClick={() => setTemplatePage(page => Math.min(templatePagination.totalPages, page + 1))}>Next</button>
        </div>
      )}

      {editor && <div onClick={() => setEditor(null)} style={modalBackdropStyle}>
        <div role="dialog" aria-label={editor.id ? 'Edit campaign template' : 'Create campaign template'} onClick={event => event.stopPropagation()} className="card modal generic-template-scrollbar" style={modalStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <h3 style={{ margin: 0 }}>{editor.id ? 'Edit Template' : 'New Template'}</h3>
            <button type="button" onClick={() => setEditor(null)} aria-label="Close" style={iconButtonStyle}><X size={20} /></button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 220px', gap: '1rem', minHeight: '430px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 160px', gap: '0.75rem' }}>
                <label style={fieldLabelStyle}>Template Name<input className="input-field" value={editor.name} onChange={e => setEditor({ ...editor, name: e.target.value })} placeholder="Template name" /></label>
                <label style={fieldLabelStyle}>Category<input className="input-field" value={editor.category} onChange={e => setEditor({ ...editor, category: e.target.value })} placeholder="Category" /></label>
              </div>
              <label style={fieldLabelStyle}>Template Type<select className="input-field" value={editor.channel || 'EMAIL'} onChange={e => setEditor({ ...editor, channel: e.target.value })}>{TEMPLATE_CHANNELS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
              <label style={fieldLabelStyle}>Subject<input className="input-field" value={editor.subject} onFocus={() => setPersonalizationTarget('subject')} onChange={e => setEditor({ ...editor, subject: e.target.value })} placeholder="Subject" /></label>
              {aiDraftError && <div role="alert" style={{ display: 'flex', alignItems: 'flex-start', gap: '0.7rem', padding: '0.9rem 1rem', border: '1px solid #f2b547', borderRadius: 8, background: 'rgba(251, 191, 36, 0.12)', color: 'var(--text-primary)' }}><span aria-hidden="true" style={{ color: '#d97706', fontSize: '1.2rem', lineHeight: 1 }}>×</span><div><strong style={{ display: 'block', marginBottom: '0.25rem' }}>AI access is not configured yet</strong><span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>{aiDraftError}</span></div></div>}
              <div style={toolbarStyle}>
                <button type="button" className="btn-secondary" onClick={writeWithAi} disabled={generating} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}><Sparkles size={15} /> {generating ? 'Writing...' : 'Write with AI'}</button>
                <button type="button" style={toolbarButtonStyle} onClick={() => runCommand('bold')} aria-label="Bold"><Bold size={15} /></button>
                <button type="button" style={toolbarButtonStyle} onClick={() => runCommand('italic')} aria-label="Italic"><Italic size={15} /></button>
                <button type="button" style={toolbarButtonStyle} onClick={() => runCommand('underline')} aria-label="Underline"><Underline size={15} /></button>
                <button type="button" style={toolbarButtonStyle} onClick={() => runCommand('justifyLeft')} aria-label="Align left"><AlignLeft size={15} /></button>
                <button type="button" style={toolbarButtonStyle} onClick={() => runCommand('justifyCenter')} aria-label="Align center"><AlignCenter size={15} /></button>
                <button type="button" style={toolbarButtonStyle} onClick={() => runCommand('justifyRight')} aria-label="Align right"><AlignRight size={15} /></button>
                <select aria-label="Font size" style={toolbarSelectStyle} defaultValue="3" onChange={e => runCommand('fontSize', e.target.value)}><option value="2">Small</option><option value="3">Normal</option><option value="5">Large</option><option value="7">Huge</option></select>
                <button type="button" style={toolbarButtonStyle} onClick={() => { const url = window.prompt('Enter link URL'); if (url) runCommand('createLink', url); }} aria-label="Insert link"><Link size={15} /></button>
                <button type="button" className="btn-secondary" onClick={() => { setPersonalizationTarget('body'); setPersonalizationOpen(open => !open); }}>Insert Personalization</button>
              </div>
              {personalizationOpen && <div style={personalizationMenuStyle}>{Object.entries(groupedFields).map(([group, groupFields]) => <div key={group}><strong style={{ display: 'block', margin: '0.2rem 0 0.3rem' }}>{group}</strong>{groupFields.map(field => <button type="button" key={field.key} onClick={() => insertVariable(field)} style={variableButtonStyle}>{field.label}</button>)}</div>)}</div>}
              <div ref={editorRef} contentEditable role="textbox" aria-label="Email body" onFocus={() => setPersonalizationTarget('body')} onInput={() => setEditor(current => ({ ...current, body: fromEditorHtml(editorRef.current) }))} data-placeholder="Write your email here..." style={richEditorStyle} />
            </div>
            <aside className="generic-template-scrollbar" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border-color)', borderRadius: '10px', padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}><h4 style={{ fontSize: '0.85rem', margin: 0 }}>Personalization</h4><span style={{ color: 'var(--text-secondary)', fontSize: '0.7rem' }}>{fields.length} tags</span></div>
              <span style={{ color: 'var(--text-secondary)', fontSize: '0.72rem' }}>Fields come from Generic CRM backend metadata.</span>
              <label style={{ position: 'relative', display: 'flex', alignItems: 'center' }}><Search size={14} style={{ position: 'absolute', left: 8, color: 'var(--text-secondary)' }} /><input className="input-field" value={personalizationQuery} onChange={event => setPersonalizationQuery(event.target.value)} placeholder="Filter merge fields..." aria-label="Filter merge fields" style={{ paddingLeft: 28 }} /></label>
              {personalizationGroups.length > 0 && <select className="input-field" value={activePersonalizationGroup} onChange={event => setPersonalizationGroup(event.target.value)} aria-label="Personalization field group">{personalizationGroups.map(group => <option key={group} value={group}>{group}</option>)}</select>}
              {activePersonalizationGroup && <strong style={{ display: 'block', margin: '0.2rem 0' }}>{activePersonalizationGroup}</strong>}
              {activePersonalizationFields.length > 0 && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>{activePersonalizationFields.map(field => <button type="button" key={field.key} onClick={() => insertVariable(field)} style={variableButtonStyle}>{field.label}</button>)}</div>}
              {fields.length > 0 && !activePersonalizationFields.length && <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>No matching personalization fields.</span>}
              {!fields.length && <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>No personalization fields available.</span>}
            </aside>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', marginTop: '1rem' }}>
            <button type="button" className="btn-secondary" onClick={previewTemplate} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}><Eye size={15} /> Preview</button>
            <div style={{ display: 'flex', gap: '0.5rem' }}><button type="button" className="btn-secondary" onClick={() => setEditor(null)}>Cancel</button><button type="button" className="btn-primary" onClick={saveTemplate} disabled={busy} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}><Save size={15} /> {busy ? 'Saving...' : 'Save Template'}</button></div>
          </div>
        </div>
      </div>}
      {preview && <div onClick={() => setPreview(null)} style={modalBackdropStyle}><div role="dialog" aria-label="Preview email template" onClick={event => event.stopPropagation()} className="card modal" style={{ ...modalStyle, maxWidth: '760px' }}><div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><h3 style={{ margin: 0 }}>Preview Email</h3><button type="button" onClick={() => setPreview(null)} aria-label="Close preview" style={iconButtonStyle}><X size={20} /></button></div><label style={{ ...fieldLabelStyle, marginTop: '1rem' }}>Preview as<select className="input-field" value={previewContactId} onChange={async e => { setPreviewContactId(e.target.value); try { const result = await fetchApi('/api/email-templates/preview', { method: 'POST', body: JSON.stringify({ subject: editor.subject, body: editor.body, contactId: e.target.value || null }) }); setPreview(result); } catch (error) { notify.error(error?.message || 'Failed to refresh preview'); } }}><option value="">Sample contact</option>{contacts.map(contact => <option key={contact.id} value={contact.id}>{contact.name}{contact.email ? ` — ${contact.email}` : ''}</option>)}</select></label><p style={{ fontWeight: 600, marginBottom: '0.75rem' }}>{preview.subject || '(No subject)'}</p><iframe title="Rendered email preview" sandbox="" srcDoc={preview.body || '<p>No content</p>'} style={{ width: '100%', minHeight: '360px', border: '1px solid var(--border-color)', borderRadius: 8, background: '#fff' }} /><div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1rem' }}><button type="button" className="btn-secondary" onClick={() => setPreview(null)}>Close</button></div></div></div>}
      <style>{`.generic-template-scrollbar { scrollbar-width: thin; scrollbar-color: var(--border-color) transparent; } .generic-template-scrollbar::-webkit-scrollbar { width: 6px; height: 6px; } .generic-template-scrollbar::-webkit-scrollbar-thumb { background: var(--border-color); border-radius: 999px; } .generic-template-scrollbar::-webkit-scrollbar-track { background: transparent; }`}</style>
    </div>
  );
}

const fieldLabelStyle = { color: 'var(--text-secondary)', fontSize: '0.8rem', display: 'grid', gap: '0.35rem' };
const iconButtonStyle = { background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' };
const variableButtonStyle = { textAlign: 'left', background: 'transparent', border: '1px solid var(--border-color)', color: 'var(--text-primary)', padding: '0.4rem 0.55rem', borderRadius: '6px', cursor: 'pointer', fontSize: '0.78rem' };
const toolbarStyle = { display: 'flex', alignItems: 'center', gap: '0.25rem', flexWrap: 'wrap', padding: '0.4rem', border: '1px solid var(--border-color)', borderRadius: '8px', background: 'var(--subtle-bg-2)' };
const toolbarButtonStyle = { ...iconButtonStyle, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0.35rem', borderRadius: '5px' };
const toolbarSelectStyle = { border: '1px solid var(--border-color)', borderRadius: '5px', padding: '0.25rem', background: 'var(--surface-color)', color: 'var(--text-primary)' };
const personalizationMenuStyle = { display: 'grid', gap: '0.4rem', padding: '0.6rem', border: '1px solid var(--border-color)', borderRadius: '8px', background: 'var(--surface-color)' };
const richEditorStyle = { flex: 1, minHeight: '320px', padding: '0.75rem', border: '1px solid var(--border-color)', borderRadius: '8px', background: 'var(--surface-color)', color: 'var(--text-primary)', outline: 'none', lineHeight: 1.55, overflowY: 'auto', whiteSpace: 'pre-wrap' };
const modalBackdropStyle = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1.25rem' };
const modalStyle = { width: '100%', maxWidth: '960px', maxHeight: '90vh', overflow: 'auto', padding: '1.25rem 1.5rem', background: 'var(--modal-bg, var(--surface-color))', border: '1px solid var(--border-color)', borderRadius: '14px' };
