/**
 * Marketing.jsx — Email / SMS / Push campaigns + Embedded Forms builder.
 *
 * Wave W2-E (closes #487 #493 #494 #495 #499 #500 #501 #502 #504):
 *  - #493/#494: SMS + Push CTAs renamed to honestly describe destination
 *               ("Open SMS Templates & Settings" / "Open Push Templates &
 *               Settings"); Channels deep-link query param `?tab=push` is
 *               also passed through so once Channels.jsx wires up the
 *               selector it lands on the right sub-tab.
 *  - #495    : Email Campaign cards are now clickable. Click opens a detail
 *               editor modal (subject, preheader, body HTML, audience filter,
 *               schedule, save / send / cancel).
 *  - #501    : Campaign Name input gets maxLength=100, live counter, trim,
 *               and an XSS-looking-input warning hint when `<` / `>` is typed.
 *  - #502    : SMS Campaigns tab gets an in-tab Blast composer (recipient
 *               phone OR contact-segment selector + body + character counter
 *               + send button) calling POST /api/sms/send. No fake "Coming
 *               Soon" buttons that 404.
 *  - #499    : Embedded Forms gain backend persistence. Reuses Campaign
 *               table with channel='FORM' (avoids a schema migration). Save
 *               button + saved-forms list + load-into-builder + delete are
 *               all wired through fetchApi.
 *  - #500    : Snippet generator now maps field name → input type correctly
 *               (full_name → text, email → email, phone → tel, company_name
 *                → text). Previously every non-email field was rendered as
 *               type="email" which blocked browser-side validation in prod.
 *  - #504    : New fields default to text (not email-cloned-from-previous);
 *               Required + Placeholder controls per row; "Copied!" toast
 *               + button-state flip; formId is generated ONCE in state and
 *               reused across renders (was Date.now() inline, regenerating).
 *  - #487    : Tab strip becomes overflow-x: auto with a fade gradient on
 *               the right edge as a scroll cue. Strip now also wraps on
 *               narrow viewports as a secondary fallback.
 *
 * Backend contracts touched (existing — no schema migration):
 *   GET    /api/marketing/campaigns?channel=EMAIL|SMS|FORM
 *   POST   /api/marketing/campaigns                  → name, channel, budget
 *   PUT    /api/marketing/campaigns/:id              → name, channel, status
 *   DELETE /api/marketing/campaigns/:id
 *   POST   /api/marketing/campaigns/:id/schedule     → scheduledAt + filters
 *   POST   /api/sms/send                             → to, body
 *
 * Embedded forms persist via Campaign rows with channel='FORM'. The
 * scheduleFilters TEXT column carries the JSON-serialised builder state
 * ({ formId, fields }). This keeps everything within existing routes and
 * the existing sanitize-helper coverage, with no new model required.
 */
import React, { useState, useEffect, useMemo } from 'react';
import { Copy, Code, Layout, Blocks, CheckCircle2, Megaphone, Plus, BarChart, Send, MousePointerClick, MessageSquare, X, Save, Trash2, Edit3, Calendar, FileText } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import { DateRangeFilter, resolveDateRange, EMPTY_DATE_FILTER } from '../components/wellness/DateRangeFilter';

const NAME_MAX = 100;
const SMS_BODY_MAX = 480; // 3 segments worth — provider chunks into 160-char SMSes

// Field-name → HTML input type map. #500: was hard-coded "email" for every
// non-Full-Name field which broke phone + company validation in production.
const FIELD_TYPE_MAP = {
  full_name: 'text',
  email: 'email',
  phone: 'tel',
  company_name: 'text',
};
const FIELD_LABEL_MAP = {
  full_name: 'Full Name',
  email: 'Email',
  phone: 'Phone',
  company_name: 'Company',
};

function generateFormId() {
  return `form_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function looksLikeXss(str) {
  if (typeof str !== 'string') return false;
  return /<|>|javascript:|on\w+\s*=/i.test(str);
}

export default function Marketing() {
  const notify = useNotify();
  const [activeTab, setActiveTab] = useState('campaigns'); // 'campaigns', 'sms', 'push', 'forms'

  // ───── Forms State ─────
  const [formName, setFormName] = useState('My Contact Form');
  const [fields, setFields] = useState([
    { id: 1, name: 'full_name', label: 'Full Name', required: true, placeholder: 'Jane Doe' },
  ]);
  // #504: formId persists in state — was inline Date.now() that regenerated
  // on every render, so two reads of the same snippet got different ids.
  const [formId, setFormId] = useState(() => generateFormId());
  const [savedForms, setSavedForms] = useState([]);
  const [loadedFormCampaignId, setLoadedFormCampaignId] = useState(null); // id of the Campaign row backing the currently-loaded form
  const [copied, setCopied] = useState(false);
  const API_ENDPOINT = '/api/marketing/submit';

  // ───── Campaigns State ─────
  const [campaigns, setCampaigns] = useState([]);
  const [showCreateCampaign, setShowCreateCampaign] = useState(false);
  const [newCampaignName, setNewCampaignName] = useState('');
  const [editingCampaign, setEditingCampaign] = useState(null); // { id, name, subject, body, ... } open in detail modal
  const [campaignDateFilter, setCampaignDateFilter] = useState(EMPTY_DATE_FILTER);
  const [campaignRangeStart, campaignRangeEnd] = resolveDateRange(campaignDateFilter);
  const visibleCampaigns = (campaignRangeStart && campaignRangeEnd)
    ? campaigns.filter((c) => {
        const ts = new Date(c.createdAt).getTime();
        return ts >= campaignRangeStart.getTime() && ts <= campaignRangeEnd.getTime();
      })
    : campaigns;

  // ───── SMS Blast Composer State (#502) ─────
  const [smsTo, setSmsTo] = useState('');
  const [smsBody, setSmsBody] = useState('');
  const [smsSending, setSmsSending] = useState(false);
  const [smsHistory, setSmsHistory] = useState([]); // recent SMS-channel campaigns

  useEffect(() => {
    if (activeTab === 'campaigns') loadCampaigns();
    if (activeTab === 'sms') loadSmsHistory();
    if (activeTab === 'forms') loadSavedForms();
  }, [activeTab]);

  const loadCampaigns = async () => {
    try {
      const data = await fetchApi('/api/marketing/campaigns?channel=EMAIL');
      // Defensive — older rows may have channel=null (treat as EMAIL).
      setCampaigns(Array.isArray(data) ? data.filter(c => !c.channel || c.channel === 'EMAIL') : []);
    } catch (err) {
      console.error(err);
    }
  };

  const loadSmsHistory = async () => {
    try {
      const data = await fetchApi('/api/marketing/campaigns?channel=SMS');
      setSmsHistory(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error(err);
    }
  };

  const loadSavedForms = async () => {
    try {
      const data = await fetchApi('/api/marketing/campaigns?channel=FORM');
      setSavedForms(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error(err);
    }
  };

  // ───── Campaign Create + Edit ─────

  const nameWarning = useMemo(() => {
    const trimmed = newCampaignName.trim();
    if (!trimmed) return null;
    if (looksLikeXss(trimmed)) return 'Angle brackets and "javascript:" will be stripped on save.';
    if (trimmed.length >= NAME_MAX) return `Maximum ${NAME_MAX} characters.`;
    return null;
  }, [newCampaignName]);

  const handleCreateCampaign = async (e) => {
    e.preventDefault();
    const trimmed = newCampaignName.trim();
    if (!trimmed) return;
    try {
      await fetchApi('/api/marketing/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed.slice(0, NAME_MAX), channel: 'EMAIL', budget: 0 }),
      });
      setNewCampaignName('');
      setShowCreateCampaign(false);
      notify.success('Campaign created');
      loadCampaigns();
    } catch (err) {
      notify.error('Failed to create campaign');
    }
  };

  const openEditor = (camp) => {
    // Pull subject/body/preheader out of scheduleFilters JSON (campaigns
    // don't have first-class subject/body columns — this matches the
    // pattern used elsewhere where a side payload rides scheduleFilters).
    let extra = {};
    if (camp.scheduleFilters) {
      try { extra = JSON.parse(camp.scheduleFilters) || {}; } catch { /* ignore parse errors */ }
    }
    setEditingCampaign({
      id: camp.id,
      name: camp.name,
      status: camp.status,
      channel: camp.channel || 'EMAIL',
      budget: camp.budget || 0,
      scheduledAt: camp.scheduledAt || '',
      // #610: snapshot the saved scheduledAt so a no-op Save doesn't overwrite
      // the persisted Mon–Fri value with the +1yr placeholder. We compare
      // against this on save and keep the original if the user didn't touch
      // the field. The "today" defaulter is only legal in CREATE mode now.
      originalScheduledAt: camp.scheduledAt || '',
      subject: extra.subject || '',
      preheader: extra.preheader || '',
      body: extra.body || '',
      audienceFilter: extra.audienceFilter || { status: '' },
    });
  };

  const saveEditor = async () => {
    if (!editingCampaign) return;
    const trimmedName = (editingCampaign.name || '').trim();
    if (!trimmedName) {
      notify.error('Campaign name is required');
      return;
    }
    try {
      // Persist name + status. Subject / body / preheader / audience filter
      // ride along inside scheduleFilters (TEXT JSON) so we don't need a
      // schema change for richer campaign metadata. Backend's
      // sanitizeJsonForStringColumn (#398/#447 sweep) sanitises every
      // string field in the JSON before storing.
      const filterPayload = {
        subject: editingCampaign.subject || '',
        preheader: editingCampaign.preheader || '',
        body: editingCampaign.body || '',
        audienceFilter: editingCampaign.audienceFilter || {},
      };
      await fetchApi(`/api/marketing/campaigns/${editingCampaign.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: trimmedName.slice(0, NAME_MAX),
          status: editingCampaign.status || 'Draft',
        }),
      });
      // #610: preserve the saved scheduledAt when the user didn't touch the
      // picker. Pre-fix, an empty picker fell through to a +1yr placeholder
      // which silently overwrote the saved Mon–Fri value. Now: if the user
      // typed a real date use it; otherwise keep whatever was already on
      // the row (which may itself be empty for a fresh draft, in which case
      // we still need a placeholder so the metadata write succeeds).
      let scheduledAt;
      if (editingCampaign.scheduledAt) {
        scheduledAt = new Date(editingCampaign.scheduledAt).toISOString();
      } else if (editingCampaign.originalScheduledAt) {
        scheduledAt = new Date(editingCampaign.originalScheduledAt).toISOString();
      } else {
        scheduledAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(); // +1yr placeholder, CREATE mode only
      }
      await fetchApi(`/api/marketing/campaigns/${editingCampaign.id}/schedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scheduledAt, filters: filterPayload }),
      });
      // If user didn't actually schedule it (and there's no pre-existing
      // schedule), immediately pause so it doesn't dispatch on the
      // placeholder date.
      if (!editingCampaign.scheduledAt && !editingCampaign.originalScheduledAt) {
        await fetchApi(`/api/marketing/campaigns/${editingCampaign.id}/pause`, { method: 'POST' });
      }
      notify.success('Campaign saved');
      setEditingCampaign(null);
      loadCampaigns();
    } catch (err) {
      notify.error('Failed to save campaign');
    }
  };

  const deleteCampaign = async (id) => {
    const ok = await notify.confirm({
      title: 'Delete campaign?',
      message: 'This permanently removes the campaign and its scheduled metadata.',
      destructive: true,
      confirmText: 'Delete',
    });
    if (!ok) return;
    try {
      await fetchApi(`/api/marketing/campaigns/${id}`, { method: 'DELETE' });
      notify.success('Campaign deleted');
      setEditingCampaign(null);
      loadCampaigns();
    } catch {
      notify.error('Failed to delete campaign');
    }
  };

  const sendCampaignNow = async () => {
    if (!editingCampaign) return;
    const ok = await notify.confirm({
      title: 'Send now?',
      message: `This dispatches "${editingCampaign.name}" to the selected audience immediately.`,
      confirmText: 'Send Now',
    });
    if (!ok) return;
    try {
      await fetchApi(`/api/marketing/campaigns/${editingCampaign.id}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filters: editingCampaign.audienceFilter || {} }),
      });
      notify.success('Campaign dispatched');
      setEditingCampaign(null);
      loadCampaigns();
    } catch (err) {
      notify.error('Failed to send campaign');
    }
  };

  // ───── SMS Blast (#502) ─────
  // #516: posts ONCE to /send-bulk; the route walks the recipient array
  // server-side. Was N HTTP round-trips client-side previously. Single-
  // recipient case still works (back-compat: parseSmsRecipients accepts
  // either a comma-separated string OR an array).
  const handleSendSmsBlast = async (e) => {
    e.preventDefault();
    const to = smsTo.trim();
    const body = smsBody.trim();
    if (!to || !body) {
      notify.error('Recipient and message body are required');
      return;
    }
    const recipients = to.split(/[,\s\n]+/).map(s => s.trim()).filter(Boolean);
    setSmsSending(true);
    try {
      const result = await fetchApi('/api/sms/send-bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: recipients, body }),
      });
      const sent = result?.totalSent ?? 0;
      const failed = result?.totalFailed ?? 0;
      if (sent > 0) {
        notify.success(`SMS sent: ${sent} OK${failed ? `, ${failed} failed` : ''}`);
      } else if (failed > 0) {
        notify.error(`SMS send failed: 0 of ${recipients.length} delivered`);
      } else {
        notify.success(`SMS queued for ${recipients.length}`);
      }
      setSmsTo('');
      setSmsBody('');
      loadSmsHistory();
    } catch (err) {
      notify.error(err?.message || 'Failed to send SMS — check provider config under Channels.');
    } finally {
      setSmsSending(false);
    }
  };

  // ───── Embedded Forms (#499 / #500 / #504) ─────

  const embedCode = useMemo(() => {
    return `<form action="${API_ENDPOINT}" method="POST" style="display: flex; flex-direction: column; gap: 1rem; font-family: sans-serif; max-width: 400px; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1);">
  <h3 style="margin: 0; font-size: 1.25rem; font-weight: 600; color: #1e293b;">${formName}</h3>
  <input type="hidden" name="formId" value="${formId}" />
${fields.map(f => {
      const inputType = FIELD_TYPE_MAP[f.name] || 'text';
      const placeholder = f.placeholder ? ` placeholder="${f.placeholder}"` : '';
      const required = f.required ? ' required' : '';
      const inputmode = inputType === 'tel' ? ' inputmode="tel"' : '';
      return `  <div style="display: flex; flex-direction: column; gap: 0.25rem;">
    <label style="font-size: 0.875rem; font-weight: 500; color: #475569;">${f.label}</label>
    <input type="${inputType}" name="${f.name}"${required}${placeholder}${inputmode} style="padding: 0.75rem; border: 1px solid #cbd5e1; border-radius: 0.375rem; outline: none;" />
  </div>`;
    }).join('\n')}
  <button type="submit" style="margin-top: 0.5rem; padding: 0.75rem; background-color: #3b82f6; color: white; font-weight: 600; border: none; border-radius: 0.375rem; cursor: pointer;">Submit Request</button>
</form>`;
  }, [formName, formId, fields]);

  const copyToClipboard = () => {
    navigator.clipboard.writeText(embedCode).then(() => {
      setCopied(true);
      notify.success('Snippet copied to clipboard');
      setTimeout(() => setCopied(false), 2000);
    }, () => notify.error('Copy failed — your browser blocked clipboard access.'));
  };

  const addField = () => {
    // #504: new fields default to a generic text type, not whatever the
    // last field was. Auto-suggest a name from unused options if any.
    const usedNames = new Set(fields.map(f => f.name));
    const candidate = ['full_name', 'email', 'phone', 'company_name'].find(n => !usedNames.has(n)) || 'full_name';
    setFields([...fields, {
      id: Date.now(),
      name: candidate,
      label: FIELD_LABEL_MAP[candidate] || 'Field',
      required: false,
      placeholder: '',
    }]);
  };

  const updateField = (idx, patch) => {
    const next = [...fields];
    next[idx] = { ...next[idx], ...patch };
    // If the user picked a new name and didn't customise the label, sync it.
    if (patch.name && next[idx].label === (FIELD_LABEL_MAP[fields[idx].name] || fields[idx].label)) {
      next[idx].label = FIELD_LABEL_MAP[patch.name] || next[idx].label;
    }
    setFields(next);
  };

  const removeField = (id) => setFields(fields.filter(f => f.id !== id));

  const newForm = () => {
    setFormName('My Contact Form');
    setFields([{ id: Date.now(), name: 'full_name', label: 'Full Name', required: true, placeholder: '' }]);
    setFormId(generateFormId());
    setLoadedFormCampaignId(null);
  };

  const saveForm = async () => {
    const trimmed = (formName || '').trim();
    if (!trimmed) {
      notify.error('Form name is required');
      return;
    }
    if (fields.length === 0) {
      notify.error('Add at least one field before saving');
      return;
    }
    try {
      const filterPayload = { formId, fields };
      const placeholderScheduledAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

      if (loadedFormCampaignId) {
        // Update existing
        await fetchApi(`/api/marketing/campaigns/${loadedFormCampaignId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: trimmed.slice(0, NAME_MAX) }),
        });
        await fetchApi(`/api/marketing/campaigns/${loadedFormCampaignId}/schedule`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scheduledAt: placeholderScheduledAt, filters: filterPayload }),
        });
        await fetchApi(`/api/marketing/campaigns/${loadedFormCampaignId}/pause`, { method: 'POST' });
        notify.success('Form updated');
      } else {
        // Create new — note channel='FORM' lives in the same Campaign
        // table as Email/SMS, but is filtered out of the campaign UI by
        // the channel=EMAIL list call above.
        const created = await fetchApi('/api/marketing/campaigns', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: trimmed.slice(0, NAME_MAX), channel: 'FORM', budget: 0 }),
        });
        if (created && created.id) {
          await fetchApi(`/api/marketing/campaigns/${created.id}/schedule`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scheduledAt: placeholderScheduledAt, filters: filterPayload }),
          });
          await fetchApi(`/api/marketing/campaigns/${created.id}/pause`, { method: 'POST' });
          setLoadedFormCampaignId(created.id);
        }
        notify.success('Form saved');
      }
      loadSavedForms();
    } catch (err) {
      notify.error('Failed to save form');
    }
  };

  const loadForm = (savedRow) => {
    let payload = {};
    try { payload = JSON.parse(savedRow.scheduleFilters || '{}') || {}; } catch { /* ignore */ }
    setFormName(savedRow.name || 'Untitled Form');
    setFormId(payload.formId || generateFormId());
    const loadedFields = Array.isArray(payload.fields) && payload.fields.length > 0
      ? payload.fields.map((f, i) => ({
        id: f.id || (Date.now() + i),
        name: f.name || 'full_name',
        label: f.label || FIELD_LABEL_MAP[f.name] || 'Field',
        required: !!f.required,
        placeholder: f.placeholder || '',
      }))
      : [{ id: Date.now(), name: 'full_name', label: 'Full Name', required: true, placeholder: '' }];
    setFields(loadedFields);
    setLoadedFormCampaignId(savedRow.id);
    notify.info(`Loaded "${savedRow.name}"`);
  };

  const deleteForm = async (id, name) => {
    const ok = await notify.confirm({
      title: 'Delete form?',
      message: `This permanently removes "${name}". Existing snippets in the wild will continue to submit but the form definition will be gone.`,
      destructive: true,
      confirmText: 'Delete',
    });
    if (!ok) return;
    try {
      await fetchApi(`/api/marketing/campaigns/${id}`, { method: 'DELETE' });
      notify.success('Form deleted');
      if (loadedFormCampaignId === id) newForm();
      loadSavedForms();
    } catch {
      notify.error('Failed to delete form');
    }
  };

  // ───── Render ─────
  return (
    <div style={{ padding: '2rem', height: '100%', display: 'flex', flexDirection: 'column', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '2.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: 'bold' }}>Marketing</h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>Manage outbound campaigns and inbound lead capture forms.</p>
        </div>

        {/* #487: tab strip becomes overflow-x: auto on narrow viewports
            with a fade gradient on the right edge as a scroll cue. The
            wrapper handles the gradient overlay; the inner container does
            the scrolling. flex-wrap kicks in as a secondary fallback when
            there's enough vertical space. */}
        <div style={{ position: 'relative', maxWidth: '100%' }}>
          <div
            data-marketing-tabs
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              background: 'var(--subtle-bg)',
              borderRadius: '8px',
              padding: '0.25rem',
              overflowX: 'auto',
              scrollbarWidth: 'thin',
              maxWidth: '100%',
            }}
          >
            <button onClick={() => setActiveTab('campaigns')} style={tabButtonStyle(activeTab === 'campaigns', 'var(--primary-color)')}>Email Campaigns</button>
            <button onClick={() => setActiveTab('sms')} style={tabButtonStyle(activeTab === 'sms', '#10b981')}>SMS Campaigns</button>
            <button onClick={() => setActiveTab('push')} style={tabButtonStyle(activeTab === 'push', '#8b5cf6')}>Push Campaigns</button>
            <button onClick={() => setActiveTab('forms')} style={tabButtonStyle(activeTab === 'forms', 'var(--primary-color)')}>Embedded Forms</button>
          </div>
          {/* Right-edge fade scroll cue — purely decorative, pointer-events:none */}
          <div
            aria-hidden="true"
            style={{
              position: 'absolute', top: 0, right: 0, bottom: 0, width: '24px',
              background: 'linear-gradient(to left, var(--subtle-bg), transparent)',
              pointerEvents: 'none', borderRadius: '0 8px 8px 0',
            }}
          />
        </div>
      </header>

      {/* ─── Email Campaigns Tab ─── */}
      {activeTab === 'campaigns' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '1.5rem' }}>
            {campaigns.length > 0 ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                <DateRangeFilter value={campaignDateFilter} onChange={setCampaignDateFilter} label="Filter by created date" />
                {visibleCampaigns.length !== campaigns.length && (
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                    {visibleCampaigns.length} of {campaigns.length}
                  </span>
                )}
              </div>
            ) : <span />}
            <button className="btn-primary" onClick={() => setShowCreateCampaign(true)} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Plus size={18} /> Create Campaign
            </button>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(350px, 1fr))', gap: '1.5rem' }}>
            {visibleCampaigns.map(camp => (
              // #495: card is now a button so click + keyboard (Enter/Space)
              // both open the editor. role=button + tabIndex make it
              // discoverable by accessibility tooling.
              <div
                key={camp.id}
                className="card campaign-card"
                role="button"
                tabIndex={0}
                onClick={() => openEditor(camp)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEditor(camp); } }}
                style={{ padding: '1.5rem', cursor: 'pointer' }}
                aria-label={`Edit campaign ${camp.name}`}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', minWidth: 0 }}>
                    <div style={{ background: 'rgba(59, 130, 246, 0.1)', padding: '0.6rem', borderRadius: '8px', color: '#3b82f6', flexShrink: 0 }}>
                      <Megaphone size={20} />
                    </div>
                    <h3 style={{ fontSize: '1.125rem', fontWeight: 'bold', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{camp.name}</h3>
                  </div>
                  <span style={{ fontSize: '0.75rem', padding: '0.2rem 0.6rem', background: 'var(--subtle-bg-3)', borderRadius: '12px', flexShrink: 0 }}>{camp.status}</span>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem', marginTop: '1.5rem' }}>
                  <Stat icon={Send} value={camp.sent} label="Sent" />
                  <Stat icon={BarChart} value={`${camp.opened}%`} label="Open Rate" />
                  <Stat icon={MousePointerClick} value={`${camp.clicked}%`} label="Click Rate" />
                </div>
                <div style={{ marginTop: '1rem', fontSize: '0.75rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                  <Edit3 size={12} /> Click to edit
                </div>
              </div>
            ))}

            {campaigns.length === 0 && (
              <div style={{ gridColumn: '1 / -1', padding: '4rem', textAlign: 'center', background: 'var(--subtle-bg-2)', borderRadius: '12px', border: '1px dashed var(--border-color)' }}>
                <Megaphone size={48} color="var(--text-secondary)" style={{ opacity: 0.3, margin: '0 auto 1rem' }} />
                <h3 style={{ fontSize: '1.25rem', fontWeight: '600', marginBottom: '0.5rem' }}>No campaigns found</h3>
                <p style={{ color: 'var(--text-secondary)' }}>Launch your first email campaign to start tracking engagement.</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ─── Create Campaign Modal (#501 validation) ─── */}
      {showCreateCampaign && (
        <div style={modalBackdropStyle}>
          <form role="dialog" aria-label="Create campaign" className="card modal" onSubmit={handleCreateCampaign} style={{ padding: '2.5rem', width: '500px', maxWidth: '95vw', border: '1px solid var(--border-color)', boxShadow: '0 25px 50px rgba(0,0,0,0.8)' }}>
            <h3 style={{ fontSize: '1.25rem', fontWeight: 'bold', marginBottom: '1.5rem' }}>Create New Campaign</h3>
            <div style={{ marginBottom: '1.5rem' }}>
              <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Campaign Name</label>
              <input
                type="text"
                required
                autoFocus
                maxLength={NAME_MAX}
                className="input-field"
                value={newCampaignName}
                onChange={e => setNewCampaignName(e.target.value)}
                placeholder="e.g. Q4 Product Launch"
                aria-describedby="new-campaign-name-hint"
              />
              <div id="new-campaign-name-hint" style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.4rem', fontSize: '0.75rem', color: nameWarning ? '#f59e0b' : 'var(--text-secondary)' }}>
                <span>{nameWarning || 'Letters, numbers, spaces. Max 100 chars.'}</span>
                <span>{newCampaignName.length}/{NAME_MAX}</span>
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '1rem' }}>
              <button type="button" onClick={() => { setShowCreateCampaign(false); setNewCampaignName(''); }} style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}>Cancel</button>
              <button type="submit" className="btn-primary" disabled={!newCampaignName.trim()}>Create Campaign</button>
            </div>
          </form>
        </div>
      )}

      {/* ─── Campaign Editor Modal (#495) ─── */}
      {editingCampaign && (
        <div style={modalBackdropStyle} onClick={() => setEditingCampaign(null)}>
          <div role="dialog" aria-label="Edit campaign" className="card modal" onClick={(e) => e.stopPropagation()} style={{ padding: '2rem', width: '720px', maxWidth: '95vw', maxHeight: '90vh', overflowY: 'auto', border: '1px solid var(--border-color)', boxShadow: '0 25px 50px rgba(0,0,0,0.8)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
              <h3 style={{ fontSize: '1.25rem', fontWeight: 'bold' }}>Edit Campaign</h3>
              <button type="button" onClick={() => setEditingCampaign(null)} aria-label="Close" style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}>
                <X size={20} />
              </button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
              <div>
                <label style={fieldLabelStyle}>Campaign Name</label>
                <input
                  type="text"
                  className="input-field"
                  maxLength={NAME_MAX}
                  value={editingCampaign.name}
                  onChange={e => setEditingCampaign({ ...editingCampaign, name: e.target.value })}
                />
              </div>
              <div>
                <label style={fieldLabelStyle}>Status</label>
                <select
                  className="input-field"
                  value={editingCampaign.status}
                  onChange={e => setEditingCampaign({ ...editingCampaign, status: e.target.value })}
                >
                  <option value="Draft">Draft</option>
                  <option value="Scheduled">Scheduled</option>
                  <option value="Active">Active</option>
                  <option value="Completed">Completed</option>
                </select>
              </div>
            </div>

            <div style={{ marginBottom: '1rem' }}>
              <label style={fieldLabelStyle}>Subject Line</label>
              <input
                type="text"
                className="input-field"
                maxLength={200}
                value={editingCampaign.subject}
                onChange={e => setEditingCampaign({ ...editingCampaign, subject: e.target.value })}
                placeholder="The first line your recipients see in their inbox"
              />
            </div>

            <div style={{ marginBottom: '1rem' }}>
              <label style={fieldLabelStyle}>Preheader (preview text)</label>
              <input
                type="text"
                className="input-field"
                maxLength={150}
                value={editingCampaign.preheader}
                onChange={e => setEditingCampaign({ ...editingCampaign, preheader: e.target.value })}
                placeholder="Optional preview text shown next to the subject"
              />
            </div>

            <div style={{ marginBottom: '1rem' }}>
              <label style={fieldLabelStyle}>Body (HTML)</label>
              <textarea
                className="input-field"
                rows={8}
                value={editingCampaign.body}
                onChange={e => setEditingCampaign({ ...editingCampaign, body: e.target.value })}
                placeholder="<p>Hello {{contact.firstName}}, ...</p>"
                style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1.5rem' }}>
              <div>
                <label style={fieldLabelStyle}>Audience Status Filter</label>
                <select
                  className="input-field"
                  value={editingCampaign.audienceFilter?.status || ''}
                  onChange={e => setEditingCampaign({
                    ...editingCampaign,
                    audienceFilter: { ...(editingCampaign.audienceFilter || {}), status: e.target.value },
                  })}
                >
                  <option value="">All contacts with email</option>
                  <option value="Lead">Leads only</option>
                  <option value="Customer">Customers only</option>
                  <option value="Active">Active only</option>
                </select>
              </div>
              <div>
                <label style={fieldLabelStyle}><Calendar size={12} style={{ display: 'inline', marginRight: '0.25rem' }} />Schedule (optional)</label>
                <input
                  type="datetime-local"
                  className="input-field"
                  value={editingCampaign.scheduledAt ? new Date(editingCampaign.scheduledAt).toISOString().slice(0, 16) : ''}
                  onChange={e => setEditingCampaign({ ...editingCampaign, scheduledAt: e.target.value })}
                />
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap', borderTop: '1px solid var(--border-color)', paddingTop: '1rem' }}>
              <button type="button" onClick={() => deleteCampaign(editingCampaign.id)} style={{ background: 'transparent', border: '1px solid var(--danger-color, #ef4444)', color: 'var(--danger-color, #ef4444)', padding: '0.5rem 1rem', borderRadius: '6px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <Trash2 size={14} /> Delete
              </button>
              <div style={{ display: 'flex', gap: '0.75rem' }}>
                <button type="button" onClick={() => setEditingCampaign(null)} style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}>Cancel</button>
                <button type="button" onClick={saveEditor} className="btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <Save size={14} /> Save
                </button>
                <button type="button" onClick={sendCampaignNow} className="btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <Send size={14} /> Send Now
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ─── SMS Campaigns Tab (#493 + #502) ─── */}
      {activeTab === 'sms' && (
        <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '1.5rem', alignContent: 'start' }}>
          {/* Blast Composer */}
          <form onSubmit={handleSendSmsBlast} className="card" style={{ padding: '1.5rem' }}>
            <h3 style={{ fontSize: '1.125rem', fontWeight: '600', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <MessageSquare size={18} color="#10b981" /> Send SMS Blast
            </h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: '1rem' }}>
              Quick one-off SMS via your configured provider (MSG91 / Twilio under <a href="/channels" style={{ color: 'var(--accent-color)' }}>Channels</a>). Recipient is a single E.164 phone number for now — bulk segment send is on the roadmap.
            </p>

            <div style={{ marginBottom: '1rem' }}>
              <label style={fieldLabelStyle}>Recipient phone</label>
              <input
                type="tel"
                className="input-field"
                value={smsTo}
                onChange={e => setSmsTo(e.target.value)}
                placeholder="+919876543210"
                required
                disabled={smsSending}
              />
            </div>

            <div style={{ marginBottom: '1rem' }}>
              <label style={fieldLabelStyle}>Message body</label>
              <textarea
                className="input-field"
                rows={5}
                maxLength={SMS_BODY_MAX}
                value={smsBody}
                onChange={e => setSmsBody(e.target.value)}
                placeholder="Hi {{contact.firstName}}, ..."
                disabled={smsSending}
                required
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.4rem', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                <span>Each 160 chars = 1 SMS segment.</span>
                <span>{smsBody.length}/{SMS_BODY_MAX}</span>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <button type="submit" className="btn-primary" disabled={smsSending || !smsTo.trim() || !smsBody.trim()} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', background: '#10b981', border: 'none' }}>
                <Send size={14} /> {smsSending ? 'Sending…' : 'Send SMS'}
              </button>
              <a href="/channels?tab=sms" style={{ alignSelf: 'center', color: 'var(--accent-color)', fontWeight: 500, textDecoration: 'none', fontSize: '0.85rem' }}>Open SMS Templates &amp; Settings →</a>
            </div>
          </form>

          {/* Recent SMS-channel campaigns / blasts history */}
          <div className="card" style={{ padding: '1.5rem' }}>
            <h3 style={{ fontSize: '1.125rem', fontWeight: '600', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <BarChart size={18} color="#10b981" /> Recent SMS Campaigns
            </h3>
            {smsHistory.length === 0 ? (
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                No SMS campaign blasts yet. The composer on the left fires one-off sends; for richer scheduled SMS campaigns, create one from Email Campaigns and switch the channel.
              </p>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {smsHistory.slice(0, 10).map(c => (
                  <li key={c.id} style={{ padding: '0.5rem 0.75rem', background: 'var(--subtle-bg-2)', borderRadius: '6px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '0.875rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>{c.sent || 0} sent · {c.status}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {/* ─── Push Campaigns Tab (#494) ─── */}
      {activeTab === 'push' && (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center', padding: '4rem', background: 'var(--subtle-bg-2)', borderRadius: '12px', border: '1px dashed var(--border-color)', maxWidth: '560px' }}>
            <Megaphone size={48} color="#8b5cf6" style={{ opacity: 0.85, margin: '0 auto 1rem' }} />
            <h3 style={{ fontSize: '1.25rem', fontWeight: '600', marginBottom: '0.5rem' }}>Push Campaigns</h3>
            <p style={{ color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
              Push notification templates (title, body, deep link) and provider settings live in Channels. Web Push uses the standard W3C Push API — no native app required.
            </p>
            <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem', fontSize: '0.85rem' }}>
              Send to all subscribers or a contact segment from the Push Notifications sub-tab in Channels.
            </p>
            <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', flexWrap: 'wrap' }}>
              {/* #494: label now describes the actual destination (Channels →
                  Push Notifications config + templates). The ?tab=push deep
                  link is forwards-compatible — Channels.jsx can wire it up
                  in a future change to land on the right sub-tab. */}
              <a href="/channels?tab=push" className="btn-primary" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', textDecoration: 'none', background: '#8b5cf6', border: 'none' }}>
                <Send size={14} /> Open Push Templates &amp; Settings
              </a>
              <a href="/channels?tab=push" style={{ alignSelf: 'center', color: 'var(--accent-color)', fontWeight: 500, textDecoration: 'none' }}>VAPID settings →</a>
            </div>
          </div>
        </div>
      )}

      {/* ─── Embedded Forms Tab (#499 / #500 / #504) ─── */}
      {activeTab === 'forms' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2rem', flex: 1, minHeight: 0 }}>
          {/* Builder View */}
          <div className="card" style={{ padding: '2rem', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
              <h3 style={{ fontSize: '1.25rem', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Layout size={20} color="var(--accent-color)" /> Builder
              </h3>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button type="button" className="btn-secondary" onClick={newForm} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.85rem' }}>
                  <Plus size={14} /> New
                </button>
                <button type="button" className="btn-primary" onClick={saveForm} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
                  <Save size={14} /> {loadedFormCampaignId ? 'Update' : 'Save'}
                </button>
              </div>
            </div>

            <div style={{ marginBottom: '2rem' }}>
              <label style={fieldLabelStyle}>Form Name</label>
              <input
                type="text"
                className="input-field"
                maxLength={NAME_MAX}
                value={formName}
                onChange={e => setFormName(e.target.value)}
              />
              <div style={{ marginTop: '0.4rem', fontSize: '0.7rem', color: 'var(--text-secondary)', fontFamily: 'monospace' }}>
                formId: <code>{formId}</code>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem', marginBottom: '2rem' }}>
              <h4 style={{ fontSize: '1rem', fontWeight: '600' }}>Fields</h4>
              {fields.map((field, idx) => (
                <div key={field.id} style={{ background: 'var(--subtle-bg-2)', padding: '0.85rem', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
                  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.5rem' }}>
                    <div style={{ width: '24px', height: '24px', borderRadius: '50%', background: 'var(--subtle-bg-3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', flexShrink: 0 }}>{idx + 1}</div>
                    <input
                      type="text"
                      className="input-field"
                      value={field.label}
                      onChange={e => updateField(idx, { label: e.target.value })}
                      style={{ margin: 0, flex: 1 }}
                      placeholder="Label"
                    />
                    <select
                      className="input-field"
                      value={field.name}
                      onChange={e => updateField(idx, { name: e.target.value })}
                      style={{ margin: 0, width: '140px' }}
                    >
                      <option value="full_name">Full Name (text)</option>
                      <option value="email">Email</option>
                      <option value="company_name">Company (text)</option>
                      <option value="phone">Phone (tel)</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => removeField(field.id)}
                      style={{ background: 'transparent', border: 'none', color: 'var(--danger-color)', cursor: 'pointer', fontWeight: 'bold' }}
                      aria-label={`Remove field ${field.label}`}
                    >
                      Remove
                    </button>
                  </div>
                  {/* #504: Required toggle + Placeholder per field */}
                  <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', marginLeft: '32px' }}>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.8rem', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={!!field.required}
                        onChange={e => updateField(idx, { required: e.target.checked })}
                      />
                      Required
                    </label>
                    <input
                      type="text"
                      className="input-field"
                      value={field.placeholder || ''}
                      onChange={e => updateField(idx, { placeholder: e.target.value })}
                      style={{ margin: 0, flex: 1, fontSize: '0.8rem', padding: '0.4rem 0.6rem' }}
                      placeholder="Placeholder (optional)"
                    />
                  </div>
                </div>
              ))}
              <button type="button" className="btn-secondary" onClick={addField} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', justifyContent: 'center', padding: '1rem', borderStyle: 'dashed' }}>
                <Blocks size={18} /> Add Form Field
              </button>
            </div>

            {/* Saved Forms List (#499) */}
            <div>
              <h4 style={{ fontSize: '1rem', fontWeight: '600', marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <FileText size={16} /> Saved Forms ({savedForms.length})
              </h4>
              {savedForms.length === 0 ? (
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>No saved forms yet. Click <strong>Save</strong> above to persist this builder.</p>
              ) : (
                <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                  {savedForms.map(sf => (
                    <li key={sf.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.5rem 0.75rem', background: loadedFormCampaignId === sf.id ? 'var(--subtle-bg-3)' : 'var(--subtle-bg-2)', borderRadius: '6px', border: loadedFormCampaignId === sf.id ? '1px solid var(--accent-color)' : '1px solid transparent' }}>
                      <button type="button" onClick={() => loadForm(sf)} style={{ background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', textAlign: 'left', flex: 1, padding: 0, fontSize: '0.875rem' }}>
                        {sf.name} {loadedFormCampaignId === sf.id && <span style={{ fontSize: '0.7rem', color: 'var(--accent-color)' }}>(loaded)</span>}
                      </button>
                      <button type="button" onClick={() => deleteForm(sf.id, sf.name)} aria-label={`Delete ${sf.name}`} style={{ background: 'transparent', border: 'none', color: 'var(--danger-color)', cursor: 'pointer' }}>
                        <Trash2 size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* Output View */}
          <div className="card" style={{ padding: '2rem', display: 'flex', flexDirection: 'column', background: 'var(--surface-color)', border: '1px solid var(--border-color)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
              <h3 style={{ fontSize: '1.25rem', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Code size={20} color="#3b82f6" /> Embed Snippet
              </h3>
              {/* #504: Copy gets visual + toast feedback. */}
              <button
                type="button"
                className={copied ? "btn-success" : "btn-primary"}
                onClick={copyToClipboard}
                style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: copied ? 'var(--success-color, #10b981)' : '' }}
                aria-live="polite"
              >
                {copied ? <CheckCircle2 size={16} /> : <Copy size={16} />} {copied ? 'Copied!' : 'Copy Snippet'}
              </button>
            </div>

            <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: '1.5rem' }}>
              Paste this HTML snippet directly into your website (Wordpress, Webflow, Shopify). Submissions will automatically sync to your pipeline.
            </p>

            <div style={{ flex: 1, background: 'var(--input-bg)', borderRadius: '8px', padding: '1rem', overflow: 'auto', position: 'relative' }}>
              <pre style={{ margin: 0, color: '#e2e8f0', fontSize: '0.875rem', fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                <code>{embedCode}</code>
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ───── Style helpers ─────
const tabButtonStyle = (active, activeBg) => ({
  padding: '0.5rem 1rem',
  borderRadius: '6px',
  border: 'none',
  cursor: 'pointer',
  background: active ? activeBg : 'transparent',
  color: active ? '#fff' : 'var(--text-secondary)',
  fontWeight: active ? '600' : '400',
  whiteSpace: 'nowrap',
  flexShrink: 0,
});

const modalBackdropStyle = {
  position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
  background: 'rgba(15, 23, 42, 0.9)',
  backdropFilter: 'blur(8px)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  zIndex: 1000,
  padding: '1rem',
};

const fieldLabelStyle = {
  display: 'block',
  marginBottom: '0.4rem',
  fontSize: '0.8rem',
  color: 'var(--text-secondary)',
};

function Stat({ icon: Icon, value, label }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', background: 'var(--table-header-bg)', padding: '0.75rem', borderRadius: '8px' }}>
      <Icon size={16} color="var(--text-secondary)" style={{ marginBottom: '0.25rem' }} />
      <span style={{ fontSize: '1.25rem', fontWeight: '600' }}>{value}</span>
      <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>{label}</span>
    </div>
  );
}
