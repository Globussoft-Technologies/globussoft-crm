import React, { useState, useEffect } from 'react';
import { Radio, MessageSquare, MessageCircle, Phone, Bell, Plus, Save, Trash2, Copy, CheckCircle2 } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';

const TABS = [
  { key: 'sms', label: 'SMS', icon: MessageSquare, color: '#10b981' },
  { key: 'whatsapp', label: 'WhatsApp', icon: MessageCircle, color: '#25D366' },
  { key: 'telephony', label: 'Telephony', icon: Phone, color: '#f59e0b' },
  { key: 'push', label: 'Push Notifications', icon: Bell, color: '#8b5cf6' },
];

export default function Channels() {
  const notify = useNotify();
  const [activeTab, setActiveTab] = useState('sms');
  const [templates, setTemplates] = useState([]);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({});
  const [configForm, setConfigForm] = useState({});
  const [copied, setCopied] = useState('');

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

  const handleCreateTemplate = async () => {
    try {
      const endpoint = activeTab === 'sms' ? '/api/sms/templates' : activeTab === 'whatsapp' ? '/api/whatsapp/templates' : '/api/push/templates';
      await fetchApi(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
      setShowCreate(false);
      setForm({});
      loadTemplates();
    } catch { notify.error('Failed to create template'); }
  };

  const handleDeleteTemplate = async (id) => {
    const endpoint = activeTab === 'sms' ? `/api/sms/templates/${id}` : activeTab === 'whatsapp' ? `/api/whatsapp/templates/${id}` : `/api/push/templates/${id}`;
    await fetchApi(endpoint, { method: 'DELETE' });
    loadTemplates();
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
          <TemplateSection templates={templates} columns={['name', 'category', 'dltTemplateId']} onDelete={handleDeleteTemplate} onCreate={() => { setForm({ name: '', body: '', category: 'Promotional', dltTemplateId: '' }); setShowCreate(true); }} />
        </div>
      )}

      {/* WhatsApp Config */}
      {activeTab === 'whatsapp' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <ConfigCard provider={{ provider: 'meta_cloud', label: 'Meta Cloud API', fields: [{ key: 'phoneNumberId', label: 'Phone Number ID' }, { key: 'accessToken', label: 'Access Token', type: 'password' }, { key: 'businessAccountId', label: 'Business Account ID' }, { key: 'webhookVerifyToken', label: 'Webhook Verify Token' }] }} configForm={configForm} setConfigForm={setConfigForm} onSave={() => handleSaveConfig('meta_cloud', '/api/whatsapp/config/meta_cloud')} />
          <WebhookInfo label="WhatsApp Webhook" url={`${webhookBase}/api/whatsapp/webhook`} copied={copied} copyText={copyText} />
          <TemplateSection templates={templates} columns={['name', 'status', 'category', 'language']} onDelete={handleDeleteTemplate} onCreate={() => { setForm({ name: '', body: '', category: 'MARKETING', language: 'en', footer: '' }); setShowCreate(true); }} statusColors={{ PENDING: '#f59e0b', APPROVED: '#10b981', REJECTED: '#ef4444' }} />
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
          <TemplateSection templates={templates} columns={['name', 'title', 'category']} onDelete={handleDeleteTemplate} onCreate={() => { setForm({ name: '', title: '', body: '', icon: '', url: '', category: 'General' }); setShowCreate(true); }} />
        </div>
      )}

      {/* Create Template Modal */}
      {showCreate && (
        <div style={{ position: 'fixed', inset: 0, background: 'var(--overlay-bg)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }}>
          <div className="card" style={{ padding: '2rem', width: '500px', maxHeight: '80vh', overflowY: 'auto' }}>
            <h3 style={{ fontWeight: 'bold', marginBottom: '1.5rem' }}>Create Template</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <input className="input-field" placeholder="Template Name" value={form.name || ''} onChange={e => setForm({ ...form, name: e.target.value })} />
              {(activeTab === 'push') && <input className="input-field" placeholder="Notification Title" value={form.title || ''} onChange={e => setForm({ ...form, title: e.target.value })} />}
              <textarea className="input-field" placeholder={activeTab === 'sms' ? 'Message body — use {{name}}, {{company}} variables' : activeTab === 'whatsapp' ? 'Template body — use {{1}}, {{2}} placeholders' : 'Notification body'} value={form.body || ''} onChange={e => setForm({ ...form, body: e.target.value })} rows={4} style={{ resize: 'vertical' }} />
              {activeTab === 'sms' && <>
                <select className="input-field" value={form.category || 'Promotional'} onChange={e => setForm({ ...form, category: e.target.value })}><option>Promotional</option><option>Transactional</option><option>OTP</option></select>
                <input className="input-field" placeholder="DLT Template ID" value={form.dltTemplateId || ''} onChange={e => setForm({ ...form, dltTemplateId: e.target.value })} />
              </>}
              {activeTab === 'whatsapp' && <>
                <select className="input-field" value={form.category || 'MARKETING'} onChange={e => setForm({ ...form, category: e.target.value })}><option>MARKETING</option><option>UTILITY</option><option>AUTHENTICATION</option></select>
                <input className="input-field" placeholder="Language (e.g. en)" value={form.language || 'en'} onChange={e => setForm({ ...form, language: e.target.value })} />
                <input className="input-field" placeholder="Footer text (optional)" value={form.footer || ''} onChange={e => setForm({ ...form, footer: e.target.value })} />
              </>}
              {activeTab === 'push' && <>
                <input className="input-field" placeholder="Icon URL (optional)" value={form.icon || ''} onChange={e => setForm({ ...form, icon: e.target.value })} />
                <input className="input-field" placeholder="Click URL (optional)" value={form.url || ''} onChange={e => setForm({ ...form, url: e.target.value })} />
              </>}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '1.5rem' }}>
              <button onClick={() => setShowCreate(false)} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}>Cancel</button>
              <button className="btn-primary" onClick={handleCreateTemplate}>Create</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
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

function TemplateSection({ templates, columns, onDelete, onCreate, statusColors }) {
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
            <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: '1rem', padding: '0.75rem', borderRadius: '6px', border: '1px solid var(--border-color)' }}>
              <div style={{ flex: 1 }}>
                <span style={{ fontWeight: '500', fontSize: '0.9rem' }}>{t.name || t.title}</span>
                {t.body && <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', marginTop: '0.25rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '400px' }}>{t.body}</p>}
              </div>
              {columns.includes('status') && t.status && (
                <span style={{ padding: '0.2rem 0.5rem', borderRadius: '4px', fontSize: '0.7rem', fontWeight: '600', color: statusColors?.[t.status] || 'var(--text-secondary)', background: `${statusColors?.[t.status] || '#666'}22` }}>{t.status}</span>
              )}
              {columns.includes('category') && t.category && (
                <span style={{ padding: '0.2rem 0.5rem', borderRadius: '4px', fontSize: '0.7rem', background: 'var(--subtle-bg)' }}>{t.category}</span>
              )}
              <button onClick={() => onDelete(t.id)} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
