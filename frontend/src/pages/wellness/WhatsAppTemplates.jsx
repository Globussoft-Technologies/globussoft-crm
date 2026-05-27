// WhatsApp Message Templates — submit + manage Meta-approved templates.
//
// Flow:
//   1. List existing templates with status badges (PENDING / APPROVED / REJECTED)
//   2. "Create" opens a modal — name, language, category, body, optional header/footer
//   3. Submit → backend POST /api/whatsapp/templates → backend submits to Meta
//      → on success, row created with status=PENDING (or whatever Meta returned)
//   4. Approval status updates via the `message_template_status_update` webhook
//      (auto-handled in routes/whatsapp_webhook.js)
//
// Click "Sync from Meta" anytime to pull latest statuses without waiting on
// the daily whatsappTemplateSyncEngine cron.

import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  MessageSquare,
  Plus,
  RefreshCw,
  ArrowLeft,
  CheckCircle,
  AlertCircle,
  Clock,
  Trash2,
  X,
  Info,
} from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';

const STATUS_BADGES = {
  APPROVED: { bg: 'rgba(16,185,129,0.15)', fg: '#10b981', icon: CheckCircle, label: 'Approved' },
  PENDING: { bg: 'rgba(245,158,11,0.15)', fg: '#f59e0b', icon: Clock, label: 'Pending' },
  IN_APPEAL: { bg: 'rgba(245,158,11,0.15)', fg: '#f59e0b', icon: Clock, label: 'In appeal' },
  REJECTED: { bg: 'rgba(239,68,68,0.15)', fg: '#dc2626', icon: AlertCircle, label: 'Rejected' },
  DISABLED: { bg: 'rgba(107,114,128,0.15)', fg: '#6b7280', icon: AlertCircle, label: 'Disabled' },
};

const LANGUAGES = [
  { code: 'en_US', label: 'English (US)' },
  { code: 'en_GB', label: 'English (UK)' },
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'Hindi' },
  { code: 'ta', label: 'Tamil' },
  { code: 'te', label: 'Telugu' },
  { code: 'bn', label: 'Bengali' },
  { code: 'mr', label: 'Marathi' },
  { code: 'gu', label: 'Gujarati' },
  { code: 'ar', label: 'Arabic' },
];

const CATEGORIES = [
  { value: 'MARKETING', label: 'Marketing', desc: 'Promotions, offers, announcements' },
  { value: 'UTILITY', label: 'Utility', desc: 'Confirmations, reminders, receipts' },
  { value: 'AUTHENTICATION', label: 'Authentication', desc: 'OTP / verification codes' },
];

function StatusBadge({ status }) {
  const cfg = STATUS_BADGES[status] || STATUS_BADGES.PENDING;
  const Icon = cfg.icon;
  return (
    <span style={{
      background: cfg.bg, color: cfg.fg,
      padding: '3px 9px', borderRadius: 999, fontSize: '0.72rem', fontWeight: 600,
      display: 'inline-flex', alignItems: 'center', gap: 4,
    }}>
      <Icon size={11} /> {cfg.label}
    </span>
  );
}

export default function WhatsAppTemplates() {
  const notify = useNotify();
  const navigate = useNavigate();

  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [showCreate, setShowCreate] = useState(false);

  // Create form state
  const [name, setName] = useState('');
  const [language, setLanguage] = useState('en_US');
  const [category, setCategory] = useState('UTILITY');
  const [body, setBody] = useState('');
  const [header, setHeader] = useState('');
  const [footer, setFooter] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchApi('/api/whatsapp/templates');
      const list = Array.isArray(data) ? data : Array.isArray(data?.templates) ? data.templates : [];
      setTemplates(list);
    } catch (err) {
      notify.error(err.message || 'Failed to load templates.');
      setTemplates([]);
    }
    setLoading(false);
  }, [notify]);

  useEffect(() => { load(); }, [load]);

  const syncFromMeta = async () => {
    setSyncing(true);
    try {
      await fetchApi('/api/whatsapp/templates/sync', { method: 'POST', body: JSON.stringify({}) });
      notify.info('Synced from Meta.');
      await load();
    } catch (err) {
      notify.error(err.message || 'Sync failed.');
    }
    setSyncing(false);
  };

  const submitCreate = async () => {
    setCreateError(null);
    if (!name.trim() || !body.trim()) {
      setCreateError('Template name and body are required.');
      return;
    }
    if (!/^[a-z0-9_]+$/.test(name.trim())) {
      setCreateError('Template name must be lowercase letters / digits / underscores only (e.g. appointment_reminder).');
      return;
    }
    setCreating(true);
    try {
      await fetchApi('/api/whatsapp/templates', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          language,
          category,
          body: body.trim(),
          headerType: header.trim() ? 'TEXT' : null,
          headerContent: header.trim() || null,
          footer: footer.trim() || null,
        }),
      });
      notify.info('Template submitted to Meta for review.');
      setShowCreate(false);
      setName(''); setBody(''); setHeader(''); setFooter('');
      await load();
    } catch (err) {
      const msg = err?.message || 'Failed to submit template.';
      if (msg.includes('NOT_CONNECTED')) {
        setCreateError('WhatsApp Business is not connected. Connect first, then submit templates.');
      } else if (msg.includes('META_REJECTED')) {
        setCreateError(msg.replace(/^.*META_REJECTED:?\s*/, '').replace(/\\n/g, ' ') || 'Meta rejected the template.');
      } else {
        setCreateError(msg);
      }
    }
    setCreating(false);
  };

  const deleteTemplate = async (tpl) => {
    if (!window.confirm(`Delete "${tpl.name}"? This removes it from your CRM but does NOT unsubmit from Meta.`)) return;
    try {
      await fetchApi(`/api/whatsapp/templates/${tpl.id}`, { method: 'DELETE' });
      notify.info('Template deleted.');
      await load();
    } catch (err) {
      notify.error(err.message || 'Delete failed.');
    }
  };

  return (
    <div style={{ padding: '1.5rem', animation: 'fadeIn 0.4s ease-out', maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: '1.5rem', flexWrap: 'wrap' }}>
        <div>
          <button
            onClick={() => navigate('/wellness/whatsapp')}
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'var(--text-secondary)', fontSize: '0.85rem',
              display: 'inline-flex', alignItems: 'center', gap: 4, padding: 0, marginBottom: 6,
            }}
          >
            <ArrowLeft size={14} /> Back to Threads
          </button>
          <h1 style={{ fontSize: '1.4rem', fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <MessageSquare size={22} color="var(--primary-color, var(--accent-color))" />
            WhatsApp Templates
          </h1>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: '4px 0 0' }}>
            Submit templates to Meta for approval, then use them to message any number without the 24-hour window restriction.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={syncFromMeta}
            disabled={syncing}
            className="btn-secondary"
            style={{ fontSize: '0.85rem', padding: '0.5rem 1rem', display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <RefreshCw size={14} className={syncing ? 'spin' : ''} />
            {syncing ? 'Syncing…' : 'Sync from Meta'}
          </button>
          <button
            onClick={() => { setShowCreate(true); setCreateError(null); }}
            style={{
              padding: '0.5rem 1rem',
              background: 'var(--primary-color, #25D366)',
              color: '#fff', border: 'none', borderRadius: 6,
              fontSize: '0.85rem', fontWeight: 600, cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            <Plus size={14} /> Create Template
          </button>
        </div>
      </div>

      {/* Info banner */}
      <div style={{
        background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)',
        color: 'var(--text-secondary)',
        padding: '0.75rem 1rem', borderRadius: 8, fontSize: '0.82rem', marginBottom: '1rem',
        display: 'flex', alignItems: 'flex-start', gap: 8, lineHeight: 1.5,
      }}>
        <Info size={14} style={{ flexShrink: 0, marginTop: 2 }} />
        <span>
          Meta typically approves utility/authentication templates in &lt;1 hour and marketing templates in 1-24 hours.
          Use <code>{'{{1}}'}</code>, <code>{'{{2}}'}</code>, etc. as placeholders in the body — they&apos;ll be filled at send time.
        </span>
      </div>

      {/* Templates list */}
      {loading ? (
        <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Loading…</div>
      ) : templates.length === 0 ? (
        <div className="glass-card" style={{ padding: '3rem', textAlign: 'center', borderRadius: 12 }}>
          <MessageSquare size={36} color="var(--text-secondary)" style={{ margin: '0 auto 12px' }} />
          <p style={{ color: 'var(--text-secondary)', margin: 0 }}>No templates yet. Click <strong>Create Template</strong> to submit your first one.</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {templates.map((t) => (
            <div key={t.id} className="glass-card" style={{
              padding: '1rem 1.25rem', borderRadius: 10, border: '1px solid var(--border-color)',
              display: 'flex', flexDirection: 'column', gap: 8,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <strong style={{ fontSize: '0.95rem' }}>{t.name}</strong>
                  <StatusBadge status={t.status} />
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                    {t.category} · {t.language}
                  </span>
                </div>
                <button
                  onClick={() => deleteTemplate(t)}
                  className="btn-secondary"
                  style={{ fontSize: '0.78rem', padding: '0.35rem 0.7rem', display: 'flex', alignItems: 'center', gap: 4, color: '#dc2626' }}
                  title="Delete from CRM (does not unsubmit from Meta)"
                >
                  <Trash2 size={12} />
                </button>
              </div>
              {t.headerContent && (
                <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                  <strong style={{ color: 'var(--text-primary)' }}>Header:</strong> {t.headerContent}
                </div>
              )}
              <div style={{ fontSize: '0.85rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {t.body}
              </div>
              {t.footer && (
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontStyle: 'italic' }}>
                  {t.footer}
                </div>
              )}
              {t.status === 'REJECTED' && (
                <div style={{ background: 'rgba(239,68,68,0.08)', color: '#dc2626', padding: '0.5rem 0.75rem', borderRadius: 6, fontSize: '0.78rem' }}>
                  Meta rejected this template. Common reasons: promotional content in a UTILITY template,
                  policy violations, or formatting issues. Edit name + body and resubmit.
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Create modal */}
      {showCreate && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) setShowCreate(false); }}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 9999, padding: '1rem',
          }}
        >
          <div className="glass-card" style={{
            width: '100%', maxWidth: 560, padding: '1.5rem', borderRadius: 12,
            background: 'var(--surface-color)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)', color: 'var(--text-primary)', border: '1px solid var(--border-color)',
            maxHeight: '90vh', overflowY: 'auto',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 style={{ margin: 0, fontSize: '1.1rem' }}>Create Template</h3>
              <button onClick={() => setShowCreate(false)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: 4, display: 'flex' }}>
                <X size={18} />
              </button>
            </div>

            <label style={{ display: 'block', marginBottom: '0.75rem' }}>
              <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', display: 'block', marginBottom: 4 }}>
                Template Name <span style={{ color: '#dc2626' }}>*</span>
              </span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))}
                placeholder="appointment_reminder"
                className="input-field"
                style={{ width: '100%', fontSize: '0.9rem' }}
                disabled={creating}
              />
              <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
                Lowercase letters, digits, underscores only. Must be unique within your WABA.
              </span>
            </label>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: '0.75rem' }}>
              <label style={{ display: 'block' }}>
                <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', display: 'block', marginBottom: 4 }}>
                  Language
                </span>
                <select value={language} onChange={(e) => setLanguage(e.target.value)} className="input-field" style={{ width: '100%', fontSize: '0.9rem' }} disabled={creating}>
                  {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
                </select>
              </label>
              <label style={{ display: 'block' }}>
                <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', display: 'block', marginBottom: 4 }}>
                  Category
                </span>
                <select value={category} onChange={(e) => setCategory(e.target.value)} className="input-field" style={{ width: '100%', fontSize: '0.9rem' }} disabled={creating}>
                  {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
              </label>
            </div>
            <p style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginTop: '-0.5rem', marginBottom: '0.75rem' }}>
              {CATEGORIES.find(c => c.value === category)?.desc}
            </p>

            <label style={{ display: 'block', marginBottom: '0.75rem' }}>
              <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', display: 'block', marginBottom: 4 }}>
                Header text (optional)
              </span>
              <input
                value={header}
                onChange={(e) => setHeader(e.target.value)}
                placeholder="Welcome to Mohit's Cafe"
                className="input-field"
                style={{ width: '100%', fontSize: '0.9rem' }}
                disabled={creating}
                maxLength={60}
              />
            </label>

            <label style={{ display: 'block', marginBottom: '0.75rem' }}>
              <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', display: 'block', marginBottom: 4 }}>
                Body <span style={{ color: '#dc2626' }}>*</span>
              </span>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={5}
                placeholder={'Hi {{1}},\nYour appointment is confirmed for {{2}}. See you soon!'}
                className="input-field"
                style={{ width: '100%', fontSize: '0.9rem', fontFamily: 'inherit', resize: 'vertical' }}
                disabled={creating}
                maxLength={1024}
              />
              <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
                Use {'{{1}}'}, {'{{2}}'}, etc. for variables filled at send time.
              </span>
            </label>

            <label style={{ display: 'block', marginBottom: '0.75rem' }}>
              <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', display: 'block', marginBottom: 4 }}>
                Footer (optional)
              </span>
              <input
                value={footer}
                onChange={(e) => setFooter(e.target.value)}
                placeholder="Reply STOP to unsubscribe"
                className="input-field"
                style={{ width: '100%', fontSize: '0.9rem' }}
                disabled={creating}
                maxLength={60}
              />
            </label>

            {createError && (
              <div style={{
                background: 'rgba(220,38,38,0.1)', color: '#dc2626',
                border: '1px solid rgba(220,38,38,0.3)',
                padding: '0.6rem 0.8rem', borderRadius: 6,
                fontSize: '0.8rem', marginBottom: '0.75rem', lineHeight: 1.5,
              }}>
                {createError}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={() => setShowCreate(false)} disabled={creating} className="btn-secondary" style={{ padding: '0.5rem 1rem', fontSize: '0.85rem' }}>
                Cancel
              </button>
              <button
                onClick={submitCreate}
                disabled={creating || !name.trim() || !body.trim()}
                style={{
                  padding: '0.5rem 1rem', fontSize: '0.85rem',
                  background: 'var(--primary-color, #25D366)', color: '#fff',
                  border: 'none', borderRadius: 6, fontWeight: 600,
                  cursor: creating ? 'not-allowed' : 'pointer',
                  opacity: creating ? 0.6 : 1,
                  display: 'flex', alignItems: 'center', gap: 6,
                }}
              >
                {creating ? 'Submitting…' : 'Submit to Meta'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
