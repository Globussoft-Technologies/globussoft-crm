import { useState } from 'react';
import { Eye, Plus, X } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import GenericCampaignTemplates from './GenericCampaignTemplates';

const DEFAULT_WHATSAPP_VARIABLE_MAPPING = {
  1: 'contact.first_name',
  2: 'contact.company',
  3: 'contact.email',
  4: 'contact.phone',
  5: 'organization.name',
  6: 'form.name',
  7: 'system.pickupPlotLink',
};

function parseMapping(value) {
  if (value && typeof value === 'object') return value;
  try { return value ? JSON.parse(value) : {}; } catch { return {}; }
}

function whatsappPreviewBody(template) {
  const mapping = { ...DEFAULT_WHATSAPP_VARIABLE_MAPPING, ...parseMapping(template?.variableMapping) };
  return String(template?.body || '').replace(/\{\{\s*(\d+)\s*\}\}/g, (_match, index) => {
    const field = mapping[index];
    if (field === 'system.pickupPlotLink') return 'https://example.com/select-pickup-plot';
    if (field === 'form.name') return 'Website enquiry form';
    return field ? `{{${field}}}` : `Sample value ${index}`;
  });
}

function textPreviewHtml(value) {
  const escaped = String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
    .replace(/\n/g, '<br>');
  return `<div style="font-family:Arial,sans-serif;line-height:1.6;white-space:pre-wrap;padding:4px">${escaped}</div>`;
}

export default function GenericSequenceTemplateActions({ channel, templateId, templates }) {
  const notify = useNotify();
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [creatorOpen, setCreatorOpen] = useState(false);
  const channelLabel = channel === 'WHATSAPP' ? 'WhatsApp' : channel === 'SMS' ? 'SMS' : 'Email';

  const openPreview = async () => {
    if (!templateId) return;
    setLoading(true);
    try {
      let template = (templates || []).find(item => String(item.id) === String(templateId));
      if (channel !== 'WHATSAPP') {
        template = await fetchApi(`/api/email-templates/${templateId}`, { silent: true });
      }
      if (!template?.body?.trim()) throw new Error('The selected template content is unavailable');
      const body = channel === 'WHATSAPP' ? whatsappPreviewBody(template) : template.body;
      const rendered = await fetchApi('/api/email-templates/preview', {
        method: 'POST',
        body: JSON.stringify({ subject: template.subject || '', body, contactId: null }),
      });
      setPreview({
        subject: rendered?.subject || template.subject || '',
        body: channel === 'EMAIL' ? rendered?.body : textPreviewHtml(rendered?.body || body),
      });
    } catch (error) {
      notify.error(error?.message || `Failed to preview ${channelLabel.toLowerCase()} template`);
    } finally {
      setLoading(false);
    }
  };

  return <>
    <div style={actionRowStyle}>
      <button type="button" className="btn-secondary" onClick={openPreview} disabled={!templateId || loading} style={actionButtonStyle}>
        <Eye size={14} /> {loading ? 'Loading…' : 'Preview'}
      </button>
      <button type="button" className="btn-secondary" onClick={() => setCreatorOpen(true)} style={actionButtonStyle}>
        <Plus size={14} /> Add template
      </button>
    </div>
    {preview && <div style={backdropStyle} onClick={() => setPreview(null)}>
      <div role="dialog" aria-modal="true" aria-label={`Preview ${channelLabel} template`} className="card modal" style={modalStyle} onClick={event => event.stopPropagation()}>
        <div style={modalHeadStyle}>
          <h3 style={{ margin: 0 }}>Preview {channelLabel}</h3>
          <button type="button" aria-label="Close preview" onClick={() => setPreview(null)} style={iconButtonStyle}><X size={19} /></button>
        </div>
        {preview.subject && <p style={{ margin: '1rem 0 0.75rem', fontWeight: 650 }}>{preview.subject}</p>}
        <iframe title="Rendered sequence template preview" sandbox="" srcDoc={preview.body || '<p>No content</p>'} style={previewFrameStyle} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1rem' }}><button type="button" className="btn-secondary" onClick={() => setPreview(null)}>Close</button></div>
      </div>
    </div>}
    {creatorOpen && <GenericCampaignTemplates
      embeddedCreateChannel={channel}
      onEmbeddedClose={() => setCreatorOpen(false)}
      onEmbeddedCreated={() => {
        setCreatorOpen(false);
        window.dispatchEvent(new CustomEvent('generic-template-created', { detail: { channel } }));
      }}
    />}
  </>;
}

const actionRowStyle = { display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' };
const actionButtonStyle = { display: 'inline-flex', alignItems: 'center', gap: 5, minHeight: 34, padding: '0.38rem 0.62rem', fontSize: '0.72rem' };
const backdropStyle = { position: 'fixed', inset: 0, zIndex: 1400, display: 'grid', placeItems: 'center', padding: '1rem', background: 'rgba(15, 23, 42, 0.56)' };
const modalStyle = { width: 'min(720px, 95vw)', maxHeight: '90vh', overflowY: 'auto', padding: '1.25rem', border: '1px solid var(--border-color)', background: 'var(--modal-bg, var(--surface-color))', boxShadow: '0 24px 70px rgba(15, 23, 42, 0.28)' };
const modalHeadStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 };
const iconButtonStyle = { display: 'inline-grid', placeItems: 'center', width: 34, height: 34, padding: 0, border: 0, background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' };
const previewFrameStyle = { width: '100%', minHeight: 340, border: '1px solid var(--border-color)', borderRadius: 8, background: 'var(--input-bg, var(--surface-color))' };
