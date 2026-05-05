/**
 * Channels — Communication channel configuration + template management.
 *
 * Tabs: SMS, WhatsApp, Telephony, Push Notifications.
 * Each tab renders provider config card(s), a webhook info panel, and a
 * Templates section with full CRUD + send/test actions.
 *
 * Closes #496 (SMS template Edit/Send/Test/Preview/Duplicate)
 * Closes #497 (Push template Edit/Send/Test/Preview/Duplicate + send-to-all)
 * Closes #498 (Push card now displays Notification Title prominently)
 * Closes #503 (SMS editor: token picker, live preview, char/segment counter,
 *               DLT length validation, in-modal Send Test action)
 *
 * Backend endpoints used:
 *   /api/sms/templates         GET POST PUT DELETE
 *   /api/sms/send              POST  (test send + blast)
 *   /api/whatsapp/templates    GET POST PUT DELETE
 *   /api/whatsapp/send         POST
 *   /api/push/templates        GET POST PUT DELETE
 *   /api/push/send             POST  (target a specific user — used for "Test")
 *   /api/push/send-campaign    POST  (broadcast to all visitor subscriptions)
 */
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Radio, MessageSquare, MessageCircle, Phone, Bell, Plus, Save, Trash2, Copy,
  CheckCircle2, Edit2, Send, Eye, Megaphone, AlertCircle,
} from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';

// Allow-list of valid tab keys for the ?tab= deep-link param. Anything
// outside this list falls back to the SMS default. Closes #519.
const VALID_TABS = ['sms', 'whatsapp', 'telephony', 'push'];

const TABS = [
  { key: 'sms', label: 'SMS', icon: MessageSquare, color: '#10b981' },
  { key: 'whatsapp', label: 'WhatsApp', icon: MessageCircle, color: '#25D366' },
  { key: 'telephony', label: 'Telephony', icon: Phone, color: '#f59e0b' },
  { key: 'push', label: 'Push Notifications', icon: Bell, color: '#8b5cf6' },
];

// Tokens supported by backend/services/smsProvider.js#substituteVars
const SMS_TOKENS = [
  { token: '{{name}}', label: 'Contact name' },
  { token: '{{company}}', label: 'Company' },
  { token: '{{email}}', label: 'Email' },
  { token: '{{phone}}', label: 'Phone' },
];

// WhatsApp uses positional {{1}}, {{2}}, ... per Meta Cloud spec
const WA_TOKENS = [
  { token: '{{1}}', label: 'Variable 1' },
  { token: '{{2}}', label: 'Variable 2' },
  { token: '{{3}}', label: 'Variable 3' },
];

const SAMPLE_CONTACT = {
  name: 'Priya Sharma',
  company: 'Enhanced Wellness',
  email: 'priya@example.com',
  phone: '+919876543210',
};

// GSM-7 character set check — anything outside flips us to UCS-2 (70-char segments)
// Spec ref: 3GPP TS 23.038
const GSM7_RE = /^[A-Za-z0-9 \r\n@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞ^{}\\[\]~|€!"#%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà]*$/;
const DLT_MAX_LENGTH = 1024; // India DLT registered template body cap

function isGsm7(text) {
  return GSM7_RE.test(text || '');
}

function smsSegments(text) {
  const len = (text || '').length;
  if (len === 0) return 0;
  if (isGsm7(text)) {
    return len <= 160 ? 1 : Math.ceil(len / 153); // multipart concat header consumes 7 chars/segment
  }
  return len <= 70 ? 1 : Math.ceil(len / 67);
}

function previewSubstitute(template, contact) {
  if (!template) return '';
  return template
    .replace(/\{\{name\}\}/g, contact.name || '')
    .replace(/\{\{company\}\}/g, contact.company || '')
    .replace(/\{\{email\}\}/g, contact.email || '')
    .replace(/\{\{phone\}\}/g, contact.phone || '')
    .replace(/\{\{1\}\}/g, contact.name || '')
    .replace(/\{\{2\}\}/g, contact.company || '')
    .replace(/\{\{3\}\}/g, contact.email || '');
}

// #518: Extract WhatsApp template variables in the Meta Cloud API parameters
// shape. Templates use positional {{1}}, {{2}}, ... placeholders; Meta requires
// a parameters array of {type:'text', text:'<value>'} per placeholder, in
// occurrence order, deduped (each {{N}} maps to one parameters entry even if
// it appears multiple times in the body). For Send Test / Send Blast in
// Channels.jsx, we substitute from SAMPLE_CONTACT so the recipient sees
// realistic preview content. A real per-contact send (e.g. from a sequence
// or campaign) should pass the recipient's actual fields instead.
function extractWhatsappParameters(templateBody, contact) {
  if (!templateBody) return [];
  const ordered = [];
  const seen = new Set();
  const regex = /\{\{(\d+)\}\}/g;
  let m;
  while ((m = regex.exec(templateBody)) !== null) {
    const idx = m[1];
    if (seen.has(idx)) continue;
    seen.add(idx);
    let value = '';
    if (idx === '1') value = contact.name || '';
    else if (idx === '2') value = contact.company || '';
    else if (idx === '3') value = contact.email || '';
    ordered.push({ type: 'text', text: value });
  }
  return ordered;
}

export default function Channels() {
  const notify = useNotify();
  // #519: consume the ?tab= deep-link param from Marketing CTAs (which
  // pass /channels?tab=sms, /channels?tab=push, etc.). Allow-list-guarded
  // so an arbitrary param can't escape into state.
  const [searchParams] = useSearchParams();
  const initialTab = VALID_TABS.includes(searchParams.get('tab'))
    ? searchParams.get('tab')
    : 'sms';
  const [activeTab, setActiveTab] = useState(initialTab);
  const [templates, setTemplates] = useState([]);
  const [showEditor, setShowEditor] = useState(false);
  const [editorMode, setEditorMode] = useState('create'); // 'create' | 'edit'
  const [form, setForm] = useState({});
  const [configForm, setConfigForm] = useState({});
  const [copied, setCopied] = useState('');
  const [showSend, setShowSend] = useState(null); // template object when sending
  const [showPreview, setShowPreview] = useState(null); // template object when previewing

  useEffect(() => { loadTemplates(); }, [activeTab]);

  const loadTemplates = async () => {
    try {
      if (activeTab === 'sms') setTemplates(await fetchApi('/api/sms/templates'));
      else if (activeTab === 'whatsapp') setTemplates(await fetchApi('/api/whatsapp/templates'));
      else if (activeTab === 'push') setTemplates(await fetchApi('/api/push/templates'));
      else setTemplates([]);
    } catch { setTemplates([]); }
  };

  const handleSaveConfig = async (provider, endpoint) => {
    try {
      await fetchApi(endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...configForm, isActive: configForm.isActive ?? false }) });
      notify.success('Configuration saved!');
    } catch { notify.error('Failed to save'); }
  };

  const templateEndpointBase = () =>
    activeTab === 'sms' ? '/api/sms/templates'
      : activeTab === 'whatsapp' ? '/api/whatsapp/templates'
      : '/api/push/templates';

  const handleSaveTemplate = async () => {
    try {
      const base = templateEndpointBase();
      if (editorMode === 'edit' && form.id) {
        await fetchApi(`${base}/${form.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(stripIds(form)) });
        notify.success('Template updated');
      } else {
        await fetchApi(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(stripIds(form)) });
        notify.success('Template created');
      }
      setShowEditor(false);
      setForm({});
      loadTemplates();
    } catch {
      notify.error(editorMode === 'edit' ? 'Failed to update template' : 'Failed to create template');
    }
  };

  const handleDeleteTemplate = async (id) => {
    const base = templateEndpointBase();
    await fetchApi(`${base}/${id}`, { method: 'DELETE' });
    loadTemplates();
  };

  const handleEdit = (t) => {
    setEditorMode('edit');
    setForm({ ...t });
    setShowEditor(true);
  };

  const handleDuplicate = (t) => {
    setEditorMode('create');
    const copy = { ...t };
    delete copy.id;
    delete copy.createdAt;
    delete copy.updatedAt;
    delete copy.tenantId;
    copy.name = `${copy.name || 'Untitled'} (copy)`;
    setForm(copy);
    setShowEditor(true);
  };

  const handleNew = () => {
    setEditorMode('create');
    if (activeTab === 'sms') setForm({ name: '', body: '', category: 'Promotional', dltTemplateId: '' });
    else if (activeTab === 'whatsapp') setForm({ name: '', body: '', category: 'MARKETING', language: 'en', footer: '' });
    else if (activeTab === 'push') setForm({ name: '', title: '', body: '', icon: '', url: '', category: 'General' });
    setShowEditor(true);
  };

  const copyText = (text, key) => { navigator.clipboard.writeText(text); setCopied(key); setTimeout(() => setCopied(''), 2000); };
  const webhookBase = window.location.origin.replace(':5173', ':5000');

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.3s ease' }}>
      <header style={{ marginBottom: '2rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        <Radio size={24} style={{ color: 'var(--accent-color)' }} />
        <div>
          <h2 style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>Communication Channels</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>Configure SMS, WhatsApp, Telephony, and Push Notification providers</p>
        </div>
      </header>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '0.25rem', background: 'var(--subtle-bg)', borderRadius: '8px', padding: '0.25rem', marginBottom: '1.5rem', width: 'fit-content' }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setActiveTab(t.key)} style={{ padding: '0.5rem 1.25rem', borderRadius: '6px', border: 'none', cursor: 'pointer', fontSize: '0.85rem', fontWeight: activeTab === t.key ? '600' : '400', background: activeTab === t.key ? t.color : 'transparent', color: activeTab === t.key ? '#fff' : 'var(--text-secondary)', transition: 'all 0.2s', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <t.icon size={16} /> {t.label}
          </button>
        ))}
      </div>

      {/* SMS Config */}
      {activeTab === 'sms' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>
            {[{ provider: 'msg91', label: 'MSG91', fields: [{ key: 'apiKey', label: 'API Key' }, { key: 'senderId', label: 'Sender ID (6 chars)' }, { key: 'dltEntityId', label: 'DLT Entity ID' }] },
              { provider: 'twilio', label: 'Twilio', fields: [{ key: 'apiKey', label: 'Account SID' }, { key: 'authToken', label: 'Auth Token', type: 'password' }, { key: 'senderId', label: 'Phone Number' }] }
            ].map(p => (
              <ConfigCard key={p.provider} provider={p} configForm={configForm} setConfigForm={setConfigForm} onSave={() => handleSaveConfig(p.provider, `/api/sms/config/${p.provider}`)} />
            ))}
          </div>
          <WebhookInfo label="SMS Delivery" url={`${webhookBase}/api/sms/webhook/msg91`} copied={copied} copyText={copyText} />
          <TemplateSection
            kind="sms"
            templates={templates}
            onDelete={handleDeleteTemplate}
            onCreate={handleNew}
            onEdit={handleEdit}
            onDuplicate={handleDuplicate}
            onSend={(t) => setShowSend({ ...t, mode: 'test' })}
            onBlast={(t) => setShowSend({ ...t, mode: 'blast' })}
            onPreview={(t) => setShowPreview(t)}
          />
        </div>
      )}

      {/* WhatsApp Config */}
      {activeTab === 'whatsapp' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <ConfigCard provider={{ provider: 'meta_cloud', label: 'Meta Cloud API', fields: [{ key: 'phoneNumberId', label: 'Phone Number ID' }, { key: 'accessToken', label: 'Access Token', type: 'password' }, { key: 'businessAccountId', label: 'Business Account ID' }, { key: 'webhookVerifyToken', label: 'Webhook Verify Token' }] }} configForm={configForm} setConfigForm={setConfigForm} onSave={() => handleSaveConfig('meta_cloud', '/api/whatsapp/config/meta_cloud')} />
          <WebhookInfo label="WhatsApp Webhook" url={`${webhookBase}/api/whatsapp/webhook`} copied={copied} copyText={copyText} />
          <TemplateSection
            kind="whatsapp"
            templates={templates}
            onDelete={handleDeleteTemplate}
            onCreate={handleNew}
            onEdit={handleEdit}
            onDuplicate={handleDuplicate}
            onSend={(t) => setShowSend({ ...t, mode: 'test' })}
            onPreview={(t) => setShowPreview(t)}
            statusColors={{ PENDING: '#f59e0b', APPROVED: '#10b981', REJECTED: '#ef4444' }}
          />
        </div>
      )}

      {/* Telephony Config */}
      {activeTab === 'telephony' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>
          {[{ provider: 'myoperator', label: 'MyOperator', fields: [{ key: 'apiKey', label: 'API Token' }, { key: 'virtualNumber', label: 'Virtual Number' }] },
            { provider: 'knowlarity', label: 'Knowlarity', fields: [{ key: 'apiKey', label: 'API Key' }, { key: 'apiSecret', label: 'SR Number' }, { key: 'virtualNumber', label: 'Virtual Number' }] }
          ].map(p => (
            <ConfigCard key={p.provider} provider={p} configForm={configForm} setConfigForm={setConfigForm} onSave={() => handleSaveConfig(p.provider, `/api/telephony/config/${p.provider}`)} />
          ))}
          <div style={{ gridColumn: '1 / -1' }}>
            <WebhookInfo label="MyOperator CDR" url={`${webhookBase}/api/telephony/webhook/myoperator`} copied={copied} copyText={copyText} />
            <WebhookInfo label="Knowlarity CDR" url={`${webhookBase}/api/telephony/webhook/knowlarity`} copied={copied} copyText={copyText} />
          </div>
        </div>
      )}

      {/* Push Config */}
      {activeTab === 'push' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <div className="card" style={{ padding: '1.5rem' }}>
            <h3 style={{ fontWeight: '600', marginBottom: '1rem' }}>VAPID Configuration</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: '1rem' }}>Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY environment variables on the server. Generate with: <code>npx web-push generate-vapid-keys</code></p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div style={{ padding: '0.75rem', background: 'var(--subtle-bg)', borderRadius: '6px', fontSize: '0.8rem' }}>
                <strong>Embeddable Script:</strong> Add this to your website to collect visitor push subscriptions:
                <pre style={{ marginTop: '0.5rem', padding: '0.5rem', background: 'rgba(0,0,0,0.2)', borderRadius: '4px', overflow: 'auto', fontSize: '0.75rem' }}>{`<script src="${webhookBase}/api/push/crm-push.js"></script>`}</pre>
              </div>
            </div>
          </div>
          <TemplateSection
            kind="push"
            templates={templates}
            onDelete={handleDeleteTemplate}
            onCreate={handleNew}
            onEdit={handleEdit}
            onDuplicate={handleDuplicate}
            onSend={(t) => setShowSend({ ...t, mode: 'test' })}
            onBlast={(t) => setShowSend({ ...t, mode: 'blast' })}
            onPreview={(t) => setShowPreview(t)}
          />
        </div>
      )}

      {/* Editor Modal (create + edit, channel-aware) */}
      {showEditor && (
        <TemplateEditor
          kind={activeTab}
          mode={editorMode}
          form={form}
          setForm={setForm}
          onCancel={() => { setShowEditor(false); setForm({}); }}
          onSave={handleSaveTemplate}
          onTestSend={(t) => setShowSend({ ...t, mode: 'test' })}
        />
      )}

      {/* Send / Test / Blast Modal */}
      {showSend && (
        <SendModal
          kind={activeTab}
          template={showSend}
          mode={showSend.mode}
          onClose={() => setShowSend(null)}
          notify={notify}
        />
      )}

      {/* Preview Modal */}
      {showPreview && (
        <PreviewModal
          kind={activeTab}
          template={showPreview}
          onClose={() => setShowPreview(null)}
        />
      )}
    </div>
  );
}

function stripIds(obj) {
  const out = { ...obj };
  delete out.id;
  delete out.createdAt;
  delete out.updatedAt;
  delete out.tenantId;
  delete out.userId;
  return out;
}

function ConfigCard({ provider, configForm, setConfigForm, onSave }) {
  return (
    <div className="card" style={{ padding: '1.5rem' }}>
      <h3 style={{ fontWeight: '600', marginBottom: '1rem' }}>{provider.label}</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {provider.fields.map(f => (
          <div key={f.key}>
            <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>{f.label}</label>
            <input className="input-field" type={f.type || 'text'} placeholder={f.label} onChange={e => setConfigForm(prev => ({ ...prev, provider: provider.provider, [f.key]: e.target.value }))} style={{ width: '100%', padding: '0.5rem 0.75rem', fontSize: '0.85rem' }} />
          </div>
        ))}
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', marginTop: '0.25rem' }}>
          <input type="checkbox" onChange={e => setConfigForm(prev => ({ ...prev, isActive: e.target.checked }))} />
          <span style={{ fontSize: '0.85rem' }}>Enable</span>
        </label>
        <button className="btn-primary" onClick={onSave} style={{ padding: '0.5rem 1rem', fontSize: '0.85rem', marginTop: '0.25rem', width: 'fit-content' }}>
          <Save size={14} style={{ marginRight: '0.375rem', verticalAlign: 'middle' }} /> Save
        </button>
      </div>
    </div>
  );
}

function WebhookInfo({ label, url, copied, copyText }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.75rem', background: 'var(--subtle-bg)', borderRadius: '6px', marginTop: '0.5rem' }}>
      <span style={{ fontWeight: '500', minWidth: '140px', fontSize: '0.85rem' }}>{label}:</span>
      <code style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', flex: 1 }}>{url}</code>
      <button onClick={() => copyText(url, label)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: copied === label ? '#10b981' : 'var(--text-secondary)' }}>
        {copied === label ? <CheckCircle2 size={16} /> : <Copy size={16} />}
      </button>
    </div>
  );
}

function TemplateSection({ kind, templates, onDelete, onCreate, onEdit, onDuplicate, onSend, onBlast, onPreview, statusColors }) {
  const showStatus = kind === 'whatsapp';
  return (
    <div className="card" style={{ padding: '1.5rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <h3 style={{ fontWeight: '600' }}>Templates ({templates.length})</h3>
        <button className="btn-primary" onClick={onCreate} style={{ padding: '0.5rem 1rem', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
          <Plus size={15} /> New Template
        </button>
      </div>
      {templates.length === 0 ? (
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', padding: '1rem 0' }}>No templates yet. Create one to get started.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {templates.map(t => (
            <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.75rem', borderRadius: '6px', border: '1px solid var(--border-color)' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.03em' }}>{t.name}</span>
                  {showStatus && t.status && (
                    <span style={{ padding: '0.15rem 0.45rem', borderRadius: '4px', fontSize: '0.65rem', fontWeight: '600', color: statusColors?.[t.status] || 'var(--text-secondary)', background: `${statusColors?.[t.status] || '#666'}22` }}>{t.status}</span>
                  )}
                  {t.category && (
                    <span style={{ padding: '0.15rem 0.45rem', borderRadius: '4px', fontSize: '0.65rem', background: 'var(--subtle-bg)' }}>{t.category}</span>
                  )}
                </div>
                {kind === 'push' && t.title && (
                  <h4 style={{ fontWeight: '600', fontSize: '0.95rem', margin: '0.25rem 0 0.15rem' }}>{t.title}</h4>
                )}
                {t.body && (
                  <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '500px' }}>{t.body}</p>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                <IconBtn title="Preview" onClick={() => onPreview(t)}><Eye size={15} /></IconBtn>
                <IconBtn title="Edit" onClick={() => onEdit(t)}><Edit2 size={15} /></IconBtn>
                <IconBtn title="Duplicate" onClick={() => onDuplicate(t)}><Copy size={15} /></IconBtn>
                <IconBtn title={kind === 'push' ? 'Send Test (to me)' : 'Send Test'} onClick={() => onSend(t)}><Send size={15} /></IconBtn>
                {onBlast && (
                  <IconBtn title={kind === 'push' ? 'Send to All Subscribers' : 'Send Blast'} onClick={() => onBlast(t)}><Megaphone size={15} /></IconBtn>
                )}
                <IconBtn title="Delete" onClick={() => { if (window.confirm(`Delete template "${t.name}"?`)) onDelete(t.id); }} danger><Trash2 size={15} /></IconBtn>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function IconBtn({ children, onClick, title, danger }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        color: danger ? '#ef4444' : 'var(--text-secondary)',
        padding: '0.35rem',
        borderRadius: '4px',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = 'var(--subtle-bg)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}
    >
      {children}
    </button>
  );
}

/**
 * TemplateEditor — channel-aware modal handling create + edit.
 *
 * For SMS (#503): includes token picker that inserts at cursor, live preview
 * with sample contact substitution, GSM-7 vs UCS-2 detection, character +
 * segment counter (160/153 GSM, 70/67 UCS-2), and DLT 1024-char ceiling.
 */
function TemplateEditor({ kind, mode, form, setForm, onCancel, onSave, onTestSend }) {
  const bodyRef = useRef(null);
  const tokens = kind === 'sms' ? SMS_TOKENS : kind === 'whatsapp' ? WA_TOKENS : [];

  const insertToken = (token) => {
    const ta = bodyRef.current;
    const current = form.body || '';
    if (!ta) {
      setForm({ ...form, body: current + token });
      return;
    }
    const start = ta.selectionStart ?? current.length;
    const end = ta.selectionEnd ?? current.length;
    const next = current.slice(0, start) + token + current.slice(end);
    setForm({ ...form, body: next });
    // restore cursor after the inserted token on next tick
    setTimeout(() => {
      try {
        ta.focus();
        const pos = start + token.length;
        ta.setSelectionRange(pos, pos);
      } catch { /* noop */ }
    }, 0);
  };

  const body = form.body || '';
  const charCount = body.length;
  const segCount = smsSegments(body);
  const isUcs2 = kind === 'sms' && body.length > 0 && !isGsm7(body);
  const dltOver = kind === 'sms' && charCount > DLT_MAX_LENGTH;

  const previewText = useMemo(() => previewSubstitute(body, SAMPLE_CONTACT), [body]);
  const previewTitle = useMemo(
    () => previewSubstitute(form.title || '', SAMPLE_CONTACT),
    [form.title]
  );

  const canSave = (form.name || '').trim().length > 0 && body.trim().length > 0 && !dltOver;

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--overlay-bg)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }}>
      <div className="card" style={{ padding: '2rem', width: '560px', maxHeight: '88vh', overflowY: 'auto' }}>
        <h3 style={{ fontWeight: 'bold', marginBottom: '1.5rem' }}>
          {mode === 'edit' ? 'Edit Template' : 'Create Template'}
        </h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <input className="input-field" placeholder="Template Name" value={form.name || ''} onChange={e => setForm({ ...form, name: e.target.value })} />

          {kind === 'push' && (
            <input className="input-field" placeholder="Notification Title" value={form.title || ''} onChange={e => setForm({ ...form, title: e.target.value })} />
          )}

          {/* Token picker (SMS + WhatsApp) */}
          {tokens.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
              <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Insert token:</label>
              {tokens.map(t => (
                <button
                  key={t.token}
                  type="button"
                  onClick={() => insertToken(t.token)}
                  title={`${t.label} — inserts ${t.token} at cursor`}
                  style={{
                    padding: '0.2rem 0.55rem',
                    fontSize: '0.75rem',
                    border: '1px solid var(--border-color)',
                    background: 'var(--subtle-bg)',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontFamily: 'monospace',
                  }}
                >
                  {t.token}
                </button>
              ))}
            </div>
          )}

          <textarea
            ref={bodyRef}
            className="input-field"
            placeholder={kind === 'sms' ? 'Message body — use {{name}}, {{company}} variables' : kind === 'whatsapp' ? 'Template body — use {{1}}, {{2}} placeholders' : 'Notification body'}
            value={body}
            onChange={e => setForm({ ...form, body: e.target.value })}
            rows={4}
            style={{ resize: 'vertical' }}
          />

          {/* SMS-only: character + segment counter + DLT length validation */}
          {kind === 'sms' && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '-0.5rem' }}>
              <span>
                {charCount} chars / {segCount} segment{segCount === 1 ? '' : 's'}
                {isUcs2 && <span style={{ color: '#f59e0b', marginLeft: '0.5rem' }}>UCS-2 (70 char/seg)</span>}
                {!isUcs2 && body.length > 0 && <span style={{ marginLeft: '0.5rem' }}>GSM-7 (160 char/seg)</span>}
              </span>
              {dltOver && (
                <span style={{ color: '#ef4444', display: 'flex', alignItems: 'center', gap: '0.25rem', fontWeight: '600' }}>
                  <AlertCircle size={12} /> Exceeds DLT max ({charCount}/{DLT_MAX_LENGTH})
                </span>
              )}
              {!dltOver && charCount > DLT_MAX_LENGTH * 0.8 && (
                <span style={{ color: '#f59e0b' }}>Approaching DLT cap ({charCount}/{DLT_MAX_LENGTH})</span>
              )}
            </div>
          )}

          {kind === 'sms' && <>
            <select className="input-field" value={form.category || 'Promotional'} onChange={e => setForm({ ...form, category: e.target.value })}>
              <option>Promotional</option><option>Transactional</option><option>OTP</option>
            </select>
            <input className="input-field" placeholder="DLT Template ID" value={form.dltTemplateId || ''} onChange={e => setForm({ ...form, dltTemplateId: e.target.value })} />
          </>}

          {kind === 'whatsapp' && <>
            <select className="input-field" value={form.category || 'MARKETING'} onChange={e => setForm({ ...form, category: e.target.value })}>
              <option>MARKETING</option><option>UTILITY</option><option>AUTHENTICATION</option>
            </select>
            <input className="input-field" placeholder="Language (e.g. en)" value={form.language || 'en'} onChange={e => setForm({ ...form, language: e.target.value })} />
            <input className="input-field" placeholder="Footer text (optional)" value={form.footer || ''} onChange={e => setForm({ ...form, footer: e.target.value })} />
          </>}

          {kind === 'push' && <>
            <input className="input-field" placeholder="Icon URL (optional)" value={form.icon || ''} onChange={e => setForm({ ...form, icon: e.target.value })} />
            <input className="input-field" placeholder="Click URL (optional)" value={form.url || ''} onChange={e => setForm({ ...form, url: e.target.value })} />
          </>}

          {/* Live preview */}
          {body && (
            <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '0.75rem' }}>
              <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Preview (sample: {SAMPLE_CONTACT.name})
              </label>
              {kind === 'push' ? (
                <PushPreviewCard title={previewTitle || form.title || 'Notification Title'} body={previewText} icon={form.icon} />
              ) : (
                <div style={{ padding: '0.75rem 1rem', background: 'var(--subtle-bg)', borderRadius: '6px', fontSize: '0.85rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {previewText}
                </div>
              )}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem', marginTop: '1.5rem' }}>
          <div>
            {kind === 'sms' && mode === 'edit' && form.id && (
              <button
                onClick={() => onTestSend(form)}
                style={{ background: 'none', border: '1px solid var(--border-color)', padding: '0.4rem 0.85rem', borderRadius: '6px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.8rem' }}
              >
                <Send size={14} /> Send Test SMS
              </button>
            )}
          </div>
          <div style={{ display: 'flex', gap: '0.75rem' }}>
            <button onClick={onCancel} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}>Cancel</button>
            <button className="btn-primary" disabled={!canSave} onClick={onSave} style={{ opacity: canSave ? 1 : 0.5 }}>
              {mode === 'edit' ? 'Save Changes' : 'Create'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Push preview — OS-style notification card */
function PushPreviewCard({ title, body, icon }) {
  return (
    <div style={{ padding: '0.85rem', background: '#1f2937', color: '#f9fafb', borderRadius: '8px', display: 'flex', gap: '0.75rem', alignItems: 'flex-start', boxShadow: '0 4px 12px rgba(0,0,0,0.25)' }}>
      <div style={{ width: 36, height: 36, borderRadius: '6px', background: '#374151', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        {icon ? (
          <img src={icon} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={e => { e.currentTarget.style.display = 'none'; }} />
        ) : (
          <Bell size={18} color="#9ca3af" />
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: '600', fontSize: '0.85rem', marginBottom: '0.15rem' }}>{title}</div>
        <div style={{ fontSize: '0.78rem', color: '#d1d5db', wordBreak: 'break-word' }}>{body}</div>
      </div>
    </div>
  );
}

/**
 * SendModal — handles "Send Test" (single recipient) and "Blast" (broadcast).
 *
 * SMS test  → POST /api/sms/send   { to, body, templateId }
 * SMS blast → POST /api/sms/send   per number (loops the recipient list)
 * WhatsApp  → POST /api/whatsapp/send { to, body }
 * Push test → POST /api/push/send  { userIds:[me], title, body, url, icon }
 * Push blast→ POST /api/push/send-campaign { title, body, url, icon }
 */
function SendModal({ kind, template, mode, onClose, notify }) {
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const isBlast = mode === 'blast';
  const isPush = kind === 'push';

  const send = async () => {
    setBusy(true);
    try {
      if (kind === 'sms') {
        const recipients = isBlast
          ? to.split(/[,\s\n]+/).map(s => s.trim()).filter(Boolean)
          : [to.trim()];
        if (recipients.length === 0 || !recipients[0]) {
          notify.error('Enter at least one phone number');
          setBusy(false);
          return;
        }
        let ok = 0, fail = 0;
        for (const num of recipients) {
          try {
            await fetchApi('/api/sms/send', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              // #518 hygiene: SMS canonical shape is {to, body} (pinned by
              // PR #511 #13 regression spec). templateId was extra noise
              // silently dropped server-side.
              body: JSON.stringify({ to: num, body: template.body }),
            });
            ok++;
          } catch { fail++; }
        }
        notify.success(`SMS sent: ${ok} OK${fail ? `, ${fail} failed` : ''}`);
      } else if (kind === 'whatsapp') {
        const recipients = isBlast
          ? to.split(/[,\s\n]+/).map(s => s.trim()).filter(Boolean)
          : [to.trim()];
        if (recipients.length === 0 || !recipients[0]) {
          notify.error('Enter at least one WhatsApp number');
          setBusy(false);
          return;
        }
        let ok = 0, fail = 0;
        // #518: Meta Cloud API expects {to, templateName, parameters} for
        // template sends, NOT the schema FK templateId. Old shape was
        // {to, body, templateId} → route silently fell into session-text
        // branch (because templateName was undefined), which fails outside
        // Meta's 24h re-engagement window with a non-obvious provider error.
        // New shape passes the template name + extracts {{N}} placeholder
        // values from SAMPLE_CONTACT.
        const params = extractWhatsappParameters(template.body, SAMPLE_CONTACT);
        for (const num of recipients) {
          try {
            await fetchApi('/api/whatsapp/send', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ to: num, templateName: template.name, parameters: params }),
            });
            ok++;
          } catch { fail++; }
        }
        notify.success(`WhatsApp sent: ${ok} OK${fail ? `, ${fail} failed` : ''}`);
      } else if (isPush) {
        if (isBlast) {
          await fetchApi('/api/push/send-campaign', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: template.title, body: template.body, url: template.url, icon: template.icon }),
          });
          notify.success('Push campaign queued for all subscribers');
        } else {
          // Test push — recipient inferred server-side from req.user.userId.
          // Was previously a localStorage.user.id workaround posting to /send;
          // #515 added /send-test as a first-class endpoint so the auth-
          // storage shape is no longer a soft contract.
          const result = await fetchApi('/api/push/send-test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: template.title, body: template.body, url: template.url, icon: template.icon }),
          });
          if (result?.sent === 0) {
            notify.error('No active push subscription for your device — enable browser notifications first');
          } else {
            notify.success('Test push sent to your device');
          }
        }
      }
      onClose();
    } catch (e) {
      notify.error(`Send failed: ${e?.message || 'unknown error'}`);
    } finally {
      setBusy(false);
    }
  };

  const titleText = isBlast
    ? (isPush ? 'Send to All Subscribers' : 'Send Blast')
    : (isPush ? 'Send Test Push (to your device)' : 'Send Test');

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--overlay-bg)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 210 }}>
      <div className="card" style={{ padding: '2rem', width: '460px' }}>
        <h3 style={{ fontWeight: 'bold', marginBottom: '0.4rem' }}>{titleText}</h3>
        <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
          Template: <strong>{template.name}</strong>
        </p>

        {(kind === 'sms' || kind === 'whatsapp') && (
          isBlast ? (
            <textarea
              className="input-field"
              placeholder="Recipient numbers (comma-, space-, or newline-separated)"
              value={to}
              onChange={e => setTo(e.target.value)}
              rows={5}
              style={{ width: '100%', resize: 'vertical', marginBottom: '1rem' }}
            />
          ) : (
            <input
              className="input-field"
              placeholder={kind === 'sms' ? 'Test phone number (e.g. +919876543210)' : 'Test WhatsApp number (e.g. +919876543210)'}
              value={to}
              onChange={e => setTo(e.target.value)}
              style={{ width: '100%', marginBottom: '1rem' }}
            />
          )
        )}

        {isPush && !isBlast && (
          <p style={{ padding: '0.75rem', background: 'var(--subtle-bg)', borderRadius: '6px', fontSize: '0.8rem', marginBottom: '1rem', color: 'var(--text-secondary)' }}>
            Sends a single push to YOUR currently-subscribed device. If you haven't enabled browser notifications yet, this will report 0 sent.
          </p>
        )}

        {isPush && isBlast && (
          <p style={{ padding: '0.75rem', background: 'var(--subtle-bg)', borderRadius: '6px', fontSize: '0.8rem', marginBottom: '1rem', color: 'var(--text-secondary)' }}>
            Broadcasts to every active visitor push subscription in your tenant. This action cannot be undone.
          </p>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
          <button onClick={onClose} disabled={busy} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}>Cancel</button>
          <button className="btn-primary" onClick={send} disabled={busy}>
            {busy ? 'Sending...' : (isBlast ? 'Send Blast' : 'Send Test')}
          </button>
        </div>
      </div>
    </div>
  );
}

function PreviewModal({ kind, template, onClose }) {
  const renderedBody = useMemo(
    () => previewSubstitute(template.body || '', SAMPLE_CONTACT),
    [template.body]
  );
  const renderedTitle = useMemo(
    () => previewSubstitute(template.title || '', SAMPLE_CONTACT),
    [template.title]
  );

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--overlay-bg)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 210 }}>
      <div className="card" style={{ padding: '2rem', width: '440px' }}>
        <h3 style={{ fontWeight: 'bold', marginBottom: '0.4rem' }}>Preview: {template.name}</h3>
        <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
          Sample contact: {SAMPLE_CONTACT.name} ({SAMPLE_CONTACT.company})
        </p>

        {kind === 'push' ? (
          <PushPreviewCard title={renderedTitle || 'Notification Title'} body={renderedBody} icon={template.icon} />
        ) : (
          <div style={{ padding: '1rem', background: 'var(--subtle-bg)', borderRadius: '6px', fontSize: '0.9rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {renderedBody}
          </div>
        )}

        {kind === 'sms' && (
          <p style={{ marginTop: '0.75rem', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
            {(template.body || '').length} chars / {smsSegments(template.body || '')} segment{smsSegments(template.body || '') === 1 ? '' : 's'}
          </p>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1.5rem' }}>
          <button className="btn-primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
