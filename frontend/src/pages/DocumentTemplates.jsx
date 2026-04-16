import React, { useState, useEffect, useRef, useMemo } from 'react';
import { FileText, Plus, Edit, Eye, Send, Copy, Trash2, X, Save, Code } from 'lucide-react';
import { fetchApi } from '../utils/api';

const TYPES = ['PROPOSAL', 'NDA', 'CONTRACT', 'EMAIL'];

const TYPE_COLORS = {
  PROPOSAL:  { bg: 'rgba(59,130,246,0.12)', color: '#3b82f6' },
  NDA:       { bg: 'rgba(168,85,247,0.12)', color: '#a855f7' },
  CONTRACT:  { bg: 'rgba(16,185,129,0.12)', color: '#10b981' },
  EMAIL:     { bg: 'rgba(245,158,11,0.12)', color: '#f59e0b' },
};

const AVAILABLE_VARS = [
  { key: 'contact.name',    label: 'Contact name' },
  { key: 'contact.email',   label: 'Contact email' },
  { key: 'contact.company', label: 'Contact company' },
  { key: 'contact.phone',   label: 'Contact phone' },
  { key: 'contact.title',   label: 'Contact title' },
  { key: 'deal.title',      label: 'Deal title' },
  { key: 'deal.amount',     label: 'Deal amount' },
  { key: 'deal.stage',      label: 'Deal stage' },
  { key: 'tenant.name',     label: 'Company / tenant' },
  { key: 'user.name',       label: 'Sender name' },
  { key: 'user.email',      label: 'Sender email' },
  { key: 'date.today',      label: "Today's date" },
];

const EMPTY_TMPL = { name: '', type: 'PROPOSAL', content: '' };

export default function DocumentTemplates() {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterType, setFilterType] = useState('');
  const [editor, setEditor] = useState(null); // { id?, name, type, content }
  const [previewState, setPreviewState] = useState(null); // { template, html, contactId }
  const [contacts, setContacts] = useState([]);
  const [sendForm, setSendForm] = useState(null); // { templateId, contactId, subject }
  const [busy, setBusy] = useState(false);
  const textareaRef = useRef(null);

  const load = () => {
    setLoading(true);
    const url = filterType ? `/api/document-templates?type=${filterType}` : '/api/document-templates';
    fetchApi(url)
      .then(d => { setTemplates(Array.isArray(d) ? d : []); setLoading(false); })
      .catch(() => { setTemplates([]); setLoading(false); });
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [filterType]);
  useEffect(() => {
    fetchApi('/api/contacts').then(d => setContacts(Array.isArray(d) ? d : [])).catch(() => setContacts([]));
  }, []);

  const openCreate = () => setEditor({ ...EMPTY_TMPL });
  const openEdit = (t) => setEditor({ id: t.id, name: t.name, type: t.type, content: t.content || '' });
  const closeEditor = () => setEditor(null);

  const insertVar = (key) => {
    const placeholder = `{{${key}}}`;
    const ta = textareaRef.current;
    if (!ta) {
      setEditor(e => ({ ...e, content: (e.content || '') + placeholder }));
      return;
    }
    const start = ta.selectionStart || 0;
    const end = ta.selectionEnd || 0;
    const next = (editor.content || '').slice(0, start) + placeholder + (editor.content || '').slice(end);
    setEditor(e => ({ ...e, content: next }));
    setTimeout(() => {
      ta.focus();
      ta.selectionStart = ta.selectionEnd = start + placeholder.length;
    }, 0);
  };

  const saveTemplate = async () => {
    if (!editor.name?.trim() || !editor.content?.trim()) {
      alert('Name and content are required'); return;
    }
    setBusy(true);
    try {
      if (editor.id) {
        await fetchApi(`/api/document-templates/${editor.id}`, {
          method: 'PUT', body: JSON.stringify({ name: editor.name, type: editor.type, content: editor.content })
        });
      } else {
        await fetchApi('/api/document-templates', {
          method: 'POST', body: JSON.stringify({ name: editor.name, type: editor.type, content: editor.content })
        });
      }
      closeEditor();
      load();
    } catch (e) { alert('Save failed: ' + e.message); }
    finally { setBusy(false); }
  };

  const duplicateTemplate = async (t) => {
    setBusy(true);
    try {
      await fetchApi('/api/document-templates', {
        method: 'POST',
        body: JSON.stringify({ name: `${t.name} (copy)`, type: t.type, content: t.content })
      });
      load();
    } catch (e) { alert('Duplicate failed'); }
    finally { setBusy(false); }
  };

  const deleteTemplate = async (id) => {
    if (!window.confirm('Delete this template?')) return;
    try {
      await fetchApi(`/api/document-templates/${id}`, { method: 'DELETE' });
      load();
    } catch { alert('Delete failed'); }
  };

  const openPreview = (t) => setPreviewState({ template: t, html: '', contactId: '' });

  const runPreview = async () => {
    if (!previewState) return;
    setBusy(true);
    try {
      const body = previewState.contactId ? { contactId: parseInt(previewState.contactId) } : {};
      const data = await fetchApi(`/api/document-templates/${previewState.template.id}/render`, {
        method: 'POST', body: JSON.stringify(body)
      });
      setPreviewState(p => ({ ...p, html: data.html || '' }));
    } catch (e) { alert('Preview failed: ' + e.message); }
    finally { setBusy(false); }
  };

  const openSend = () => {
    if (!previewState) return;
    setSendForm({
      templateId: previewState.template.id,
      contactId: previewState.contactId || '',
      subject: previewState.template.name,
    });
  };

  const sendEmail = async () => {
    if (!sendForm.contactId) { alert('Select a recipient contact'); return; }
    if (!sendForm.subject?.trim()) { alert('Subject is required'); return; }
    setBusy(true);
    try {
      const result = await fetchApi(`/api/document-templates/${sendForm.templateId}/send-email`, {
        method: 'POST',
        body: JSON.stringify({ contactId: parseInt(sendForm.contactId), subject: sendForm.subject }),
      });
      alert(result.delivered ? 'Email delivered.' : 'Email saved (delivery skipped — Mailgun not configured).');
      setSendForm(null);
    } catch (e) { alert('Send failed: ' + e.message); }
    finally { setBusy(false); }
  };

  const filteredTemplates = useMemo(() => templates, [templates]);

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.3s ease' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem', flexWrap: 'wrap', gap: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <FileText size={24} style={{ color: 'var(--accent-color)' }} />
          <div>
            <h2 style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>Document Templates</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
              Reusable HTML templates with mail-merge variables ({'{{contact.name}}'}, {'{{deal.title}}'}, etc.)
            </p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <select value={filterType} onChange={e => setFilterType(e.target.value)} className="input"
            style={{ padding: '0.5rem 0.75rem', borderRadius: '8px', background: 'var(--card-bg)', color: 'var(--text-primary)', border: '1px solid var(--border-color)' }}>
            <option value="">All types</option>
            {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <button className="btn-primary" onClick={openCreate} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Plus size={18} /> Create Template
          </button>
        </div>
      </header>

      {loading ? (
        <p style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-secondary)' }}>Loading templates...</p>
      ) : filteredTemplates.length === 0 ? (
        <div className="card" style={{ padding: '4rem', textAlign: 'center' }}>
          <FileText size={48} style={{ color: 'var(--text-secondary)', opacity: 0.3, marginBottom: '1rem' }} />
          <h3 style={{ marginBottom: '0.5rem' }}>No templates yet</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: '1.5rem' }}>
            Create reusable proposal, NDA, contract, or email templates with merge variables.
          </p>
          <button className="btn-primary" onClick={openCreate}>
            <Plus size={16} style={{ marginRight: '0.375rem', verticalAlign: 'middle' }} /> Create Template
          </button>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '1.25rem' }}>
          {filteredTemplates.map(t => {
            const tc = TYPE_COLORS[t.type] || TYPE_COLORS.PROPOSAL;
            const preview = (t.content || '').replace(/<[^>]+>/g, '').slice(0, 120);
            return (
              <div key={t.id} className="card" style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
                  <div style={{ minWidth: 0 }}>
                    <h3 style={{ fontSize: '1.05rem', fontWeight: 600, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</h3>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', marginTop: '0.25rem' }}>
                      Updated {new Date(t.updatedAt || t.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <span style={{ background: tc.bg, color: tc.color, padding: '0.25rem 0.6rem', borderRadius: '999px', fontSize: '0.7rem', fontWeight: 600 }}>
                    {t.type}
                  </span>
                </div>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', minHeight: '2.6em', lineHeight: 1.4 }}>
                  {preview || <em>(empty)</em>}{preview.length === 120 ? '…' : ''}
                </p>
                <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginTop: 'auto' }}>
                  <button className="btn-secondary" onClick={() => openPreview(t)} title="Preview" style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.4rem 0.7rem' }}>
                    <Eye size={14} /> Preview
                  </button>
                  <button className="btn-secondary" onClick={() => openEdit(t)} title="Edit" style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.4rem 0.7rem' }}>
                    <Edit size={14} /> Edit
                  </button>
                  <button className="btn-secondary" onClick={() => duplicateTemplate(t)} title="Duplicate" style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.4rem 0.7rem' }}>
                    <Copy size={14} />
                  </button>
                  <button className="btn-secondary" onClick={() => deleteTemplate(t.id)} title="Delete" style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.4rem 0.7rem', color: '#ef4444' }}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Editor Modal ────────────────────────────────────────── */}
      {editor && (
        <Modal onClose={closeEditor} title={editor.id ? 'Edit Template' : 'New Template'} wide>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 240px', gap: '1rem', minHeight: '440px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div style={{ display: 'flex', gap: '0.75rem' }}>
                <input
                  className="input"
                  value={editor.name}
                  onChange={e => setEditor({ ...editor, name: e.target.value })}
                  placeholder="Template name"
                  style={inputStyle}
                />
                <select
                  className="input"
                  value={editor.type}
                  onChange={e => setEditor({ ...editor, type: e.target.value })}
                  style={{ ...inputStyle, width: '160px' }}
                >
                  {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <Code size={14} /> HTML content (use {'{{variable}}'} for merge fields)
              </label>
              <textarea
                ref={textareaRef}
                value={editor.content}
                onChange={e => setEditor({ ...editor, content: e.target.value })}
                placeholder={'<h1>Hello {{contact.name}},</h1>\n<p>Thanks for your interest in {{deal.title}}.</p>'}
                style={{
                  ...inputStyle,
                  flex: 1,
                  minHeight: '320px',
                  fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
                  fontSize: '0.85rem',
                  resize: 'vertical',
                }}
              />
            </div>
            <aside style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border-color)', borderRadius: '10px', padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.4rem', overflow: 'auto' }}>
              <h4 style={{ fontSize: '0.85rem', margin: 0, marginBottom: '0.5rem' }}>Insert variable</h4>
              {AVAILABLE_VARS.map(v => (
                <button
                  key={v.key}
                  type="button"
                  onClick={() => insertVar(v.key)}
                  style={{
                    textAlign: 'left',
                    background: 'transparent',
                    border: '1px solid var(--border-color)',
                    color: 'var(--text-primary)',
                    padding: '0.4rem 0.55rem',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    fontSize: '0.78rem',
                  }}
                >
                  <code style={{ color: 'var(--accent-color)' }}>{`{{${v.key}}}`}</code>
                  <div style={{ color: 'var(--text-secondary)', fontSize: '0.7rem', marginTop: '0.15rem' }}>{v.label}</div>
                </button>
              ))}
            </aside>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' }}>
            <button className="btn-secondary" onClick={closeEditor}>Cancel</button>
            <button className="btn-primary" onClick={saveTemplate} disabled={busy} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <Save size={16} /> {busy ? 'Saving...' : 'Save Template'}
            </button>
          </div>
        </Modal>
      )}

      {/* ── Preview Modal ───────────────────────────────────────── */}
      {previewState && (
        <Modal onClose={() => setPreviewState(null)} title={`Preview — ${previewState.template.name}`} wide>
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <select
              value={previewState.contactId}
              onChange={e => setPreviewState(p => ({ ...p, contactId: e.target.value }))}
              style={{ ...inputStyle, maxWidth: '280px' }}
            >
              <option value="">— Pick a contact for merge data —</option>
              {contacts.map(c => <option key={c.id} value={c.id}>{c.name} ({c.email})</option>)}
            </select>
            <button className="btn-secondary" onClick={runPreview} disabled={busy} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <Eye size={16} /> Render Preview
            </button>
            <button className="btn-primary" onClick={openSend} disabled={!previewState.html} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <Send size={16} /> Send Email
            </button>
          </div>
          <div style={{ border: '1px solid var(--border-color)', borderRadius: '10px', overflow: 'hidden', background: '#fff', minHeight: '400px' }}>
            {previewState.html ? (
              <iframe
                title="template-preview"
                srcDoc={previewState.html}
                style={{ width: '100%', height: '500px', border: 'none', background: '#fff' }}
              />
            ) : (
              <div style={{ padding: '3rem', textAlign: 'center', color: '#888' }}>
                Pick a contact (optional) and click <strong>Render Preview</strong> to see the merged document.
              </div>
            )}
          </div>
        </Modal>
      )}

      {/* ── Send Modal ──────────────────────────────────────────── */}
      {sendForm && (
        <Modal onClose={() => setSendForm(null)} title="Send Templated Email">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Recipient contact</label>
            <select
              value={sendForm.contactId}
              onChange={e => setSendForm({ ...sendForm, contactId: e.target.value })}
              style={inputStyle}
            >
              <option value="">— Choose contact —</option>
              {contacts.map(c => <option key={c.id} value={c.id}>{c.name} ({c.email})</option>)}
            </select>
            <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Subject (variables allowed)</label>
            <input
              value={sendForm.subject}
              onChange={e => setSendForm({ ...sendForm, subject: e.target.value })}
              style={inputStyle}
              placeholder="Hello {{contact.name}}"
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' }}>
            <button className="btn-secondary" onClick={() => setSendForm(null)}>Cancel</button>
            <button className="btn-primary" onClick={sendEmail} disabled={busy} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <Send size={16} /> {busy ? 'Sending...' : 'Send Email'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

const inputStyle = {
  flex: 1,
  padding: '0.55rem 0.75rem',
  borderRadius: '8px',
  border: '1px solid var(--border-color)',
  background: 'var(--card-bg)',
  color: 'var(--text-primary)',
  fontSize: '0.9rem',
};

function Modal({ title, children, onClose, wide }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
        backdropFilter: 'blur(6px)', zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '2rem',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="card"
        style={{
          width: '100%',
          maxWidth: wide ? '960px' : '520px',
          maxHeight: '90vh',
          overflow: 'auto',
          padding: '1.25rem 1.5rem',
          background: 'var(--card-bg)',
          border: '1px solid var(--border-color)',
          borderRadius: '14px',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h3 style={{ margin: 0, fontSize: '1.1rem' }}>{title}</h3>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}>
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
