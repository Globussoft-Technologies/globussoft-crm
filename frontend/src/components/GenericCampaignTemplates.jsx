import React, { useContext, useEffect, useRef, useState } from 'react';
import { AlignCenter, AlignLeft, AlignRight, Bold, ChevronDown, Edit, Eye, FileText, Italic, Link, Plus, RefreshCw, Save, Search, Sparkles, Trash2, Underline, X } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import { AuthContext } from '../appContexts';
import GenericWhatsAppTemplates from './GenericWhatsAppTemplates';

const TEMPLATE_CHANNELS = [
  { value: 'EMAIL', label: 'Email' },
  { value: 'SMS', label: 'SMS' },
  { value: 'WHATSAPP', label: 'WhatsApp' },
];
const TEMPLATE_FILTERS = [
  { value: 'ALL', label: 'All' },
  ...TEMPLATE_CHANNELS,
];

const EMPTY_TEMPLATE = { name: '', subject: '', category: 'General', body: '', channel: 'EMAIL' };
const TEMPLATE_DRAFT_PREFIX = 'globuscrm:campaign-template-draft:v1';
const GENERIC_SYSTEM_CATEGORY_PREFIX = 'System: Generic CRM:';

function templateDraftKey(template, tenantId, userId) {
  const owner = `${tenantId || 'tenant'}:${userId || 'user'}`;
  const channel = template?.channel || 'EMAIL';
  const kind = template?.whatsappBusinessTemplate ? 'meta' : 'standard';
  return `${TEMPLATE_DRAFT_PREFIX}:${owner}:${channel}:${kind}:new`;
}

function readTemplateDraft(template, tenantId, userId) {
  try {
    const raw = localStorage.getItem(templateDraftKey(template, tenantId, userId));
    if (!raw) return template;
    const draft = JSON.parse(raw);
    return draft && typeof draft === 'object'
      ? { ...template, ...draft, id: undefined, channel: template.channel, whatsappBusinessTemplate: template.whatsappBusinessTemplate }
      : template;
  } catch {
    return template;
  }
}

function hasTemplateDraftContent(template) {
  return Boolean(
    String(template?.name || '').trim()
    || String(template?.subject || '').trim()
    || String(template?.body || '').trim()
    || String(template?.footer || '').trim()
    || Object.keys(parseWhatsAppVariableMapping(template?.whatsappVariableMapping)).length,
  );
}

function isGenericSystemTemplate(template) {
  return String(template?.category || '').startsWith(GENERIC_SYSTEM_CATEGORY_PREFIX);
}
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
  { key: 'contact.interestedPlotArea', label: 'Interested Plot', group: 'Contact' },
  { key: 'enrollmentId', label: 'Enrollment ID', group: 'Campaign' },
  { key: 'sequenceId', label: 'Sequence ID', group: 'Campaign' },
  { key: 'deal.title', label: 'Deal Title', group: 'Deal' },
  { key: 'invoice.number', label: 'Invoice Number', group: 'Invoice' },
  { key: 'payment.description', label: 'Payment Description', group: 'Payment' },
  { key: 'pickup.address', label: 'Pickup Address', group: 'Pickup' },
  { key: 'plot.name', label: 'Plot Name', group: 'Plot' },
  { key: 'plot.plotNumber', label: 'Plot Number', group: 'Plot' },
  { key: 'booking.bookingNumber', label: 'Booking Number', group: 'Booking' },
  { key: 'booking.status', label: 'Booking Status', group: 'Booking' },
  { key: 'visit.title', label: 'Visit Title', group: 'Visit' },
  { key: 'task.title', label: 'Task Title', group: 'Task' },
  { key: 'activity.description', label: 'Activity Description', group: 'Activity' },
  { key: 'expense.title', label: 'Expense Title', group: 'Expense' },
  { key: 'contract.title', label: 'Contract Title', group: 'Contract' },
  { key: 'estimate.title', label: 'Estimate Title', group: 'Estimate' },
  { key: 'project.name', label: 'Project Name', group: 'Project' },
  { key: 'system.pickupPlotLink', label: 'Pickup / Plot Selection Link', group: 'System' },
];
const DEFAULT_WHATSAPP_VARIABLE_MAPPING = {
  1: 'contact.first_name',
  2: 'contact.company',
  3: 'contact.email',
  4: 'contact.phone',
  5: 'organization.name',
  6: 'form.name',
  7: 'system.pickupPlotLink',
};

function parseWhatsAppVariableMapping(value) {
  if (value && typeof value === 'object') return value;
  try { return value ? JSON.parse(value) : {}; } catch { return {}; }
}

function completeWhatsAppVariableMapping(body, value) {
  const mapping = { ...parseWhatsAppVariableMapping(value) };
  const indexes = [...new Set([...String(body || '').matchAll(/\{\{(\d+)\}\}/g)].map(match => Number(match[1])))];
  indexes.forEach(index => {
    // Templates created before variableMapping was persisted used this same
    // numeric order. Recover it so operators can edit them without deleting
    // and recreating an already-approved Meta template.
    if (!mapping[index] && DEFAULT_WHATSAPP_VARIABLE_MAPPING[index]) {
      mapping[index] = DEFAULT_WHATSAPP_VARIABLE_MAPPING[index];
    }
  });
  return mapping;
}

function whatsappBodyForContactPreview(template) {
  const mapping = completeWhatsAppVariableMapping(template?.body, template?.variableMapping);
  return String(template?.body || '').replace(/\{\{\s*(\d+)\s*\}\}/g, (_match, index) => {
    const path = mapping[index];
    if (path === 'system.pickupPlotLink') return 'https://example.com/select-pickup-plot';
    if (path === 'form.name') return 'Website enquiry form';
    return path ? `{{${path}}}` : `Sample value ${index}`;
  });
}

function isExistingMetaTemplateError(error) {
  const message = [error?.message, error?.serverMessage, error?.data?.details]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return error?.code === 'META_TEMPLATE_ALREADY_EXISTS'
    || message.includes('content in this language already exists')
    || message.includes('already english (us) content for this template');
}

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

function fromEditorText(element) {
  const clone = element.cloneNode(true);
  clone.querySelectorAll('[data-template-variable]').forEach(token => {
    token.replaceWith(`{{${token.getAttribute('data-template-variable')}}}`);
  });
  return clone.innerText || clone.textContent || '';
}

function toWhatsAppEditorHtml(value, fields, mapping) {
  let html = String(value || '');
  const byKey = new Map(fields.map(field => [field.key, field.label]));
  Object.entries(mapping || {}).forEach(([index, key]) => {
    const label = key === 'system.pickupPlotLink' ? 'Pickup / plot link' : (byKey.get(key) || key);
    html = html.replace(new RegExp(`\\{\\{\\s*${index}\\s*\\}\\}`, 'g'), `<span data-template-variable="${index}" contenteditable="false">[${label}]</span>`);
  });
  return html;
}

function missingRequiredFieldsMessage(fields) {
  if (fields.length === 1) return `${fields[0]} is required`;
  if (fields.length === 2) return `${fields[0]} and ${fields[1]} are required`;
  return `${fields.slice(0, -1).join(', ')}, and ${fields.at(-1)} are required`;
}

export default function GenericCampaignTemplates({ embeddedCreateChannel = '', onEmbeddedClose, onEmbeddedCreated } = {}) {
  const notify = useNotify();
  const { tenant, user } = useContext(AuthContext);
  const tenantId = tenant?.id || user?.tenantId;
  const userId = user?.userId || user?.id || user?.email;
  const [templates, setTemplates] = useState([]);
  const [templatePage, setTemplatePage] = useState(1);
  const [templateChannel, setTemplateChannel] = useState(() => {
    const requestedChannel = new URLSearchParams(window.location.search).get('templateChannel');
    return TEMPLATE_FILTERS.some(channel => channel.value === requestedChannel) ? requestedChannel : 'EMAIL';
  });
  const [templatePagination, setTemplatePagination] = useState({ page: 1, pageSize: 10, total: 0, totalPages: 1 });
  const [loading, setLoading] = useState(true);
  const [templateLoadError, setTemplateLoadError] = useState('');
  const [editor, setEditor] = useState(null);
  const [whatsAppRefreshKey, setWhatsAppRefreshKey] = useState(0);
  const [syncingWhatsAppTemplates, setSyncingWhatsAppTemplates] = useState(false);
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [aiDraftError, setAiDraftError] = useState('');
  const [fields, setFields] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [preview, setPreview] = useState(null);
  const [previewContactId, setPreviewContactId] = useState('');
  const [previewContactOpen, setPreviewContactOpen] = useState(false);
  const [previewContactQuery, setPreviewContactQuery] = useState('');
  const [personalizationOpen, setPersonalizationOpen] = useState(false);
  const [personalizationTarget, setPersonalizationTarget] = useState('body');
  const [personalizationQuery, setPersonalizationQuery] = useState('');
  const [personalizationGroup, setPersonalizationGroup] = useState('');
  const [groupDropdownOpen, setGroupDropdownOpen] = useState(false);
  const editorRef = useRef(null);
  const editorIdentityRef = useRef(null);
  const templateRequest = useRef(0);
  const createFromQueryHandledRef = useRef(false);
  useEffect(() => () => { templateRequest.current += 1; }, []);

  const removeTemplateDraft = (template) => {
    if (!template || template.id) return;
    try { localStorage.removeItem(templateDraftKey(template, tenantId, userId)); } catch { /* storage may be unavailable */ }
  };

  const openNewTemplate = (template) => {
    setEditor(readTemplateDraft(template, tenantId, userId));
  };

  useEffect(() => {
    if (createFromQueryHandledRef.current) return;
    const params = new URLSearchParams(window.location.search);
    const requestedChannel = embeddedCreateChannel || (params.get('createTemplate') === '1' ? params.get('templateChannel') : '');
    if (!TEMPLATE_CHANNELS.some(channel => channel.value === requestedChannel)) return;
    createFromQueryHandledRef.current = true;
    templateRequest.current += 1;
    setTemplatePage(1);
    setTemplateChannel(requestedChannel);
    const template = requestedChannel === 'WHATSAPP'
      ? { name: '', subject: '', category: 'UTILITY', body: '', channel: 'WHATSAPP', whatsappBusinessTemplate: true, language: 'en_US', footer: '', whatsappVariableMapping: {} }
      : { ...EMPTY_TEMPLATE, channel: requestedChannel };
    setEditor(readTemplateDraft(template, tenantId, userId));
  }, [embeddedCreateChannel, tenantId, userId]);

  const clearTemplateDraft = () => {
    if (!editor || editor.id) return;
    removeTemplateDraft(editor);
    const reset = editor.whatsappBusinessTemplate
      ? { name: '', subject: '', category: 'UTILITY', body: '', channel: 'WHATSAPP', whatsappBusinessTemplate: true, language: 'en_US', footer: '', whatsappVariableMapping: {} }
      : { ...EMPTY_TEMPLATE, channel: editor.channel || 'EMAIL' };
    editorIdentityRef.current = null;
    if (editorRef.current) editorRef.current.innerHTML = '';
    setEditor(reset);
    notify.success('Template draft cleared');
  };

  useEffect(() => {
    if (!editor || editor.id) return;
    const key = templateDraftKey(editor, tenantId, userId);
    try {
      if (hasTemplateDraftContent(editor)) {
        localStorage.setItem(key, JSON.stringify({ ...editor, savedAt: new Date().toISOString() }));
      } else {
        localStorage.removeItem(key);
      }
    } catch {
      // Draft recovery is best-effort when browser storage is unavailable.
    }
  }, [editor, tenantId, userId]);

  const loadTemplates = async () => {
    const requestId = ++templateRequest.current;
    setLoading(true);
    setTemplateLoadError('');
    try {
      const channelQuery = templateChannel === 'ALL' ? '' : `&channel=${templateChannel}`;
      const result = await fetchApi(`/api/email-templates?paginate=1&page=${templatePage}&limit=10${channelQuery}`);
      if (requestId !== templateRequest.current) return;
      setTemplates(Array.isArray(result) ? result : (result?.items || []));
      if (result?.pagination) setTemplatePagination(result.pagination);
    } catch (error) {
      if (requestId !== templateRequest.current) return;
      setTemplates([]);
      setTemplateLoadError(error?.message || 'Could not load templates. Please try again.');
    } finally {
      if (requestId === templateRequest.current) setLoading(false);
    }
  };

  useEffect(() => { loadTemplates(); }, [templatePage, templateChannel]);


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
    const templateFields = fields;
    const identity = `${editor.id || 'new'}:${editor.whatsappBusinessTemplate ? 'whatsapp' : 'crm'}:${templateFields.length}`;
    if (editorIdentityRef.current !== identity) {
      editorRef.current.innerHTML = editor.whatsappBusinessTemplate
        ? toWhatsAppEditorHtml(editor.body, templateFields, parseWhatsAppVariableMapping(editor.whatsappVariableMapping))
        : toEditorHtml(editor.body, templateFields);
      editorIdentityRef.current = identity;
    }
  }, [editor, fields]);

  const insertVariable = (field) => {
    let placeholder = `{{${field.key}}}`;
    let variableMapping = null;
    if (editor?.whatsappBusinessTemplate) {
      variableMapping = parseWhatsAppVariableMapping(editor.whatsappVariableMapping);
      let index = Object.entries(variableMapping).find(([, key]) => key === field.key)?.[0];
      if (!index) {
        index = String(Array.from({ length: Object.keys(variableMapping).length + 1 }, (_, offset) => offset + 1).find(candidate => !Object.hasOwn(variableMapping, candidate)) || Object.keys(variableMapping).length + 1);
        variableMapping[index] = field.key;
      }
      placeholder = `{{${index}}}`;
    }
    if (personalizationTarget === 'subject') {
      setEditor(current => ({ ...current, subject: `${current.subject || ''}${placeholder}` }));
    } else if (editorRef.current) {
      editorRef.current.focus();
      const label = editor?.whatsappBusinessTemplate ? field.label : field.label;
      document.execCommand('insertHTML', false, `<span data-template-variable="${editor?.whatsappBusinessTemplate ? placeholder.match(/\d+/)?.[0] : field.key}" contenteditable="false">[${label}]</span>&nbsp;`);
      setEditor(current => ({ ...current, body: fromEditorHtml(editorRef.current), ...(variableMapping ? { whatsappVariableMapping: variableMapping } : {}) }));
    }
    setPersonalizationOpen(false);
  };

  const runCommand = (command, value = null) => {
    if (!editorRef.current) return;
    editorRef.current.focus();
    document.execCommand(command, false, value);
    setEditor(current => ({ ...current, body: fromEditorHtml(editorRef.current) }));
  };

  const openTemplatePreview = async (template, contactId = previewContactId) => {
    if (!template?.body?.trim()) return notify.error('Add template content before previewing');
    try {
      const result = await fetchApi('/api/email-templates/preview', {
        method: 'POST',
        body: JSON.stringify({ subject: template.subject, body: template.body, contactId: contactId || null }),
      });
      const channel = template.channel || 'EMAIL';
      const body = channel === 'WHATSAPP'
        ? `<div style="font-family:Arial,sans-serif;line-height:1.6;white-space:pre-wrap">${String(result.body || '').replace(/\n/g, '<br>')}</div>`
        : result.body;
      setPreview({ ...result, body, source: { subject: template.subject || '', body: template.body || '', channel } });
    } catch (error) {
      notify.error(error?.message || 'Failed to preview template');
    }
  };

  const previewWhatsAppTemplate = (template, contactId = previewContactId) => openTemplatePreview({
    ...template,
    subject: '',
    body: whatsappBodyForContactPreview(template),
    channel: 'WHATSAPP',
  }, contactId);

  const previewTemplate = () => editor?.whatsappBusinessTemplate
    ? previewWhatsAppTemplate(editor)
    : openTemplatePreview(editor);

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
    const isWhatsAppBusinessTemplate = editor?.whatsappBusinessTemplate;
    const missingFields = [
      ...(!editor?.name?.trim() ? ['Template name'] : []),
      ...(!isWhatsAppBusinessTemplate && !editor?.subject?.trim() ? ['Subject'] : []),
      ...(!editor?.body?.trim() ? ['Message'] : []),
    ];
    if (missingFields.length) {
      notify.error(missingRequiredFieldsMessage(missingFields));
      return;
    }
    setBusy(true);
    try {
      if (isWhatsAppBusinessTemplate) {
        const messageBody = String(editorRef.current ? fromEditorText(editorRef.current) : editor.body || '').trim();
        const placeholders = [...messageBody.matchAll(/\{\{(\d+)\}\}/g)].map(match => Number(match[1]));
        const uniquePlaceholders = [...new Set(placeholders)].sort((a, b) => a - b);
        if (uniquePlaceholders.some((value, index) => value !== index + 1)) {
          notify.error('Use WhatsApp placeholders in order, starting with {{1}}.');
          return;
        }
        if (/^\s*\{\{\d+\}\}|\{\{\d+\}\}[^a-z0-9]*$/i.test(messageBody)) {
          notify.error('WhatsApp message format is invalid. A personalization field cannot be the first or last part of the message. Add normal text before and after each field. Example: Hi [Contact Name], thank you for contacting NovaCrest. Our team will call you shortly.');
          return;
        }
        const mapping = completeWhatsAppVariableMapping(messageBody, editor.whatsappVariableMapping);
        if (uniquePlaceholders.some(index => !mapping[index])) {
          notify.error('Use the Personalization panel to insert WhatsApp fields so their values can be filled when sending.');
          return;
        }
        const payload = { name: editor.name.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_'), body: messageBody, category: editor.category || 'UTILITY', language: editor.language || 'en_US', footer: editor.footer || '', variableMapping: mapping };
        if (editor.id) await fetchApi(`/api/whatsapp/templates/${editor.id}`, { method: 'PUT', body: JSON.stringify(payload) });
        else await fetchApi('/api/whatsapp/templates', { method: 'POST', body: JSON.stringify(payload), silent: true });
        removeTemplateDraft(editor);
        setEditor(null);
        setWhatsAppRefreshKey(value => value + 1);
        notify.success(editor.id ? 'WhatsApp template updated' : 'WhatsApp template submitted to Meta for approval');
        onEmbeddedCreated?.();
        return;
      }
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
      removeTemplateDraft(editor);
      setEditor(null);
      await loadTemplates();
      notify.success(editor.id ? 'Template updated' : 'Template created');
      onEmbeddedCreated?.();
    } catch (error) {
      if (editor?.whatsappBusinessTemplate && !editor.id && isExistingMetaTemplateError(error)) {
        try {
          await fetchApi('/api/whatsapp/templates/sync', {
            method: 'POST',
            body: JSON.stringify({}),
            silent: true,
          });
          removeTemplateDraft(editor);
          setEditor(null);
          setWhatsAppRefreshKey(value => value + 1);
          notify.success('This template already existed in Meta, so the Meta version was synced into CRM');
          onEmbeddedCreated?.();
          return;
        } catch (syncError) {
          notify.error(syncError?.message || 'The template already exists in Meta, but CRM could not sync it. Click Sync from Meta and try again.');
          return;
        }
      }
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

  const syncWhatsAppTemplates = async () => {
    setSyncingWhatsAppTemplates(true);
    try {
      const result = await fetchApi('/api/whatsapp/templates/sync', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setWhatsAppRefreshKey(value => value + 1);
      const synced = Number(result?.synced);
      notify.info(Number.isFinite(synced)
        ? `Synced ${synced} WhatsApp template${synced === 1 ? '' : 's'} from Meta`
        : 'WhatsApp templates synced from Meta');
    } catch (error) {
      notify.error(error?.message || 'Failed to sync WhatsApp templates from Meta');
    } finally {
      setSyncingWhatsAppTemplates(false);
    }
  };

  const editorFields = fields;
  const visibleFields = editorFields.filter(field => {
    const query = personalizationQuery.trim().toLowerCase();
    return !query || [field.label, field.key, field.group].some(value => String(value || '').toLowerCase().includes(query));
  });
  const groupedFields = visibleFields.reduce((groups, field) => ({ ...groups, [field.group || 'CRM']: [...(groups[field.group || 'CRM'] || []), field] }), {});
  const personalizationGroups = [...new Set(editorFields.map(field => field.group || 'CRM'))];
  const activePersonalizationGroup = personalizationGroups.includes(personalizationGroup) ? personalizationGroup : (personalizationGroups[0] || '');
  const activePersonalizationFields = visibleFields.filter(field => (field.group || 'CRM') === activePersonalizationGroup);
  const previewChannelLabel = preview?.source?.channel === 'SMS' ? 'SMS' : preview?.source?.channel === 'WHATSAPP' ? 'WhatsApp' : 'Email';
  const selectedPreviewContact = contacts.find(contact => String(contact.id) === String(previewContactId));
  const normalizedPreviewContactQuery = previewContactQuery.trim().toLowerCase();
  const visiblePreviewContacts = [{ id: '', name: 'Sample contact', email: '' }, ...contacts].filter(contact => {
    if (!normalizedPreviewContactQuery) return true;
    return `${contact.name || ''} ${contact.email || ''}`.toLowerCase().includes(normalizedPreviewContactQuery);
  });

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
      {!embeddedCreateChannel && <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', flexWrap: 'wrap', marginBottom: '1.5rem' }}>
        <div>
          <h3 style={{ margin: 0, fontSize: '1.25rem' }}>Templates</h3>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <label style={{ ...fieldLabelStyle, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            Type
            <select className="input-field" value={templateChannel} onChange={event => { templateRequest.current += 1; setTemplatePage(1); setTemplateChannel(event.target.value); }} aria-label="Template type">
              {TEMPLATE_FILTERS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          {templateChannel === 'WHATSAPP' && <button type="button" className="btn-secondary" onClick={syncWhatsAppTemplates} disabled={syncingWhatsAppTemplates} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
            <RefreshCw size={16} className={syncingWhatsAppTemplates ? 'spin' : ''} /> {syncingWhatsAppTemplates ? 'Syncing…' : 'Sync from Meta'}
          </button>}
          <button type="button" className="btn-primary" onClick={() => templateChannel === 'WHATSAPP'
            ? openNewTemplate({ name: '', subject: '', category: 'UTILITY', body: '', channel: 'WHATSAPP', whatsappBusinessTemplate: true, language: 'en_US', footer: '', whatsappVariableMapping: {} })
            : openNewTemplate({ ...EMPTY_TEMPLATE, channel: templateChannel === 'ALL' ? 'EMAIL' : templateChannel })} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
            <Plus size={16} /> Create New Template
          </button>
        </div>
      </div>

      <div
        data-testid={templateChannel === 'ALL' ? 'generic-all-template-grid' : undefined}
        style={templateChannel === 'ALL'
          ? { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '1.25rem', alignItems: 'stretch' }
          : { display: 'contents' }}
      >
      {(templateChannel === 'WHATSAPP' || templateChannel === 'ALL') && <GenericWhatsAppTemplates
        hideCreateButton
        mergeIntoParentGrid={templateChannel === 'ALL'}
        onPreviewWhatsAppTemplate={previewWhatsAppTemplate}
        onCreateWhatsAppTemplate={() => openNewTemplate({ name: '', subject: '', category: 'UTILITY', body: '', channel: 'WHATSAPP', whatsappBusinessTemplate: true, language: 'en_US', footer: '', whatsappVariableMapping: {} })}
        onEditWhatsAppTemplate={template => {
          const defaults = {
            generic_new_lead_pickup_plot: DEFAULT_WHATSAPP_VARIABLE_MAPPING,
            generic_lead_details_updated: {
              1: 'contact.first_name', 2: 'contact.company', 3: 'contact.email', 4: 'contact.phone',
              5: 'organization.name', 6: 'form.name',
            },
          };
          const mapping = completeWhatsAppVariableMapping(
            template.body,
            template.variableMapping ? parseWhatsAppVariableMapping(template.variableMapping) : (defaults[template.name] || {}),
          );
          setEditor({ ...template, subject: '', channel: 'WHATSAPP', whatsappBusinessTemplate: true, language: template.language || 'en_US', whatsappVariableMapping: mapping, whatsappIncludesSelectionLink: Object.values(mapping).includes('system.pickupPlotLink') });
        }}
        refreshKey={whatsAppRefreshKey}
        onCreateSequenceCopy={() => openNewTemplate({ ...EMPTY_TEMPLATE, channel: 'WHATSAPP' })}
        sequenceTemplates={templateChannel === 'WHATSAPP' ? templates : []}
        sequenceLoading={loading}
        sequenceLoadError={templateLoadError}
        onEditSequenceCopy={template => setEditor({ id: template.id, name: template.name || '', subject: template.subject || '', category: template.category || 'General', body: template.body || '', channel: 'WHATSAPP' })}
        onDeleteSequenceCopy={deleteTemplate}
        onRetrySequenceCopies={loadTemplates}
      />}

      {templateChannel === 'WHATSAPP' ? null : loading ? <p style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-secondary)' }}>Loading templates...</p> : templateLoadError ? (
        <div className="card" role="alert" style={{ padding: '3rem', textAlign: 'center' }}>
          <h3 style={{ margin: '0 0 0.5rem' }}>Templates could not be loaded</h3>
          <p style={{ color: 'var(--text-secondary)' }}>{templateLoadError}</p>
          <button type="button" className="btn-secondary" onClick={loadTemplates}>Try again</button>
        </div>
      ) : templates.length === 0 ? (
        <div className="card" style={{ padding: '4rem', textAlign: 'center' }}>
          <FileText size={42} style={{ color: 'var(--text-secondary)', opacity: 0.35, marginBottom: '1rem' }} />
          <h3 style={{ margin: '0 0 0.5rem' }}>No templates yet</h3>
          <p style={{ color: 'var(--text-secondary)' }}>Create a template to use it in your sequence steps.</p>
        </div>
      ) : (
        <div style={templateChannel === 'ALL'
          ? { display: 'contents' }
          : { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '1.25rem' }}>
          {templates.map(template => (
            <div key={template.id} className="card" style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.75rem' }}>
                <div style={{ minWidth: 0 }}>
                  <h3 style={{ margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{template.name}</h3>
                  <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>{template.category || 'General'}</span>
                </div>
                <button type="button" aria-label={`Preview ${template.name}`} title="Preview template" onClick={() => openTemplatePreview(template)} style={cardPreviewIconStyle}><FileText size={20} /></button>
              </div>
              <div style={{ fontSize: '0.85rem' }}><strong>Subject:</strong> {template.subject}</div>
              <div style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', minHeight: '2.4rem', overflow: 'hidden' }}>
                {(template.body || '').replace(/<[^>]+>/g, '').slice(0, 150)}
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: 'auto' }}>
                <button type="button" className="btn-secondary" onClick={() => setEditor({ id: template.id, name: template.name || '', subject: template.subject || '', category: template.category || 'General', body: template.body || '', channel: template.channel || templateChannel })} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}><Edit size={14} /> Edit</button>
                {!isGenericSystemTemplate(template) && <button type="button" className="btn-secondary" onClick={() => deleteTemplate(template)} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', color: '#ef4444' }}><Trash2 size={14} /> Delete</button>}
              </div>
            </div>
          ))}
        </div>
      )}
      </div>

      {templateChannel !== 'WHATSAPP' && !loading && templates.length > 0 && templatePagination.totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap', padding: '1.25rem 0 0.25rem' }}>
          <button type="button" className="btn-secondary" disabled={templatePage <= 1} onClick={() => setTemplatePage(page => Math.max(1, page - 1))}>Previous</button>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Page {templatePage} of {templatePagination.totalPages}</span>
          <button type="button" className="btn-secondary" disabled={templatePage >= templatePagination.totalPages} onClick={() => setTemplatePage(page => Math.min(templatePagination.totalPages, page + 1))}>Next</button>
        </div>
      )}
      </>}

      {editor && <div className="generic-template-backdrop" onClick={() => { setEditor(null); onEmbeddedClose?.(); }} style={modalBackdropStyle}>
        <div role="dialog" aria-label={editor.id ? 'Edit campaign template' : 'Create campaign template'} onClick={event => event.stopPropagation()} className="card modal generic-template-scrollbar generic-template-modal" style={modalStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <h3 style={{ margin: 0 }}>{editor.id ? 'Edit Template' : 'New Template'}</h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>{!editor.id && <button type="button" className="btn-secondary" onClick={clearTemplateDraft}>Clear draft</button>}<button type="button" onClick={() => { setEditor(null); onEmbeddedClose?.(); }} aria-label="Close" style={iconButtonStyle}><X size={20} /></button></div>
          </div>
          <div className="generic-template-modal__layout" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 220px', gap: '1rem', minHeight: '430px' }}>
            <div className="generic-template-modal__editor" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div className="generic-template-modal__fields" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 160px', gap: '0.75rem' }}>
                <label style={fieldLabelStyle}><span>Template Name <span aria-hidden="true" style={requiredMarkStyle}>*</span></span><input aria-label="Template Name" className="input-field" value={editor.name} onChange={e => setEditor({ ...editor, name: e.target.value })} placeholder="Template name" /></label>
                {editor.whatsappBusinessTemplate ? <label style={fieldLabelStyle}>Category<select className="input-field" value={editor.category || 'UTILITY'} onChange={e => setEditor({ ...editor, category: e.target.value })}><option value="UTILITY">Utility</option><option value="MARKETING">Marketing</option><option value="AUTHENTICATION">Authentication</option></select></label> : <label style={fieldLabelStyle}>Category<input className="input-field" value={editor.category} readOnly={String(editor.category || '').startsWith('System: Generic CRM:')} onChange={e => setEditor({ ...editor, category: e.target.value })} placeholder="Category" />{String(editor.category || '').startsWith('System: Generic CRM:') && <small style={{ color: 'var(--text-secondary)' }}>This category keeps the default message connected to its lead event. You can edit the subject and message text.</small>}</label>}
              </div>
              {editor.whatsappBusinessTemplate && <label style={fieldLabelStyle}><span>Template Type <span aria-hidden="true" style={requiredMarkStyle}>*</span></span><select aria-label="Template Type" className="input-field" value="WHATSAPP" disabled><option value="WHATSAPP">WhatsApp</option></select></label>}
              {!editor.whatsappBusinessTemplate && <label style={fieldLabelStyle}><span>Template Type <span aria-hidden="true" style={requiredMarkStyle}>*</span></span><select aria-label="Template Type" className="input-field" value={editor.channel || 'EMAIL'} onChange={e => { removeTemplateDraft(editor); setEditor({ ...editor, channel: e.target.value }); }}>{TEMPLATE_CHANNELS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>}
              {!editor.whatsappBusinessTemplate && <label style={fieldLabelStyle}><span>Subject <span aria-hidden="true" style={requiredMarkStyle}>*</span></span><input aria-label="Subject" className="input-field" value={editor.subject} onFocus={() => setPersonalizationTarget('subject')} onChange={e => setEditor({ ...editor, subject: e.target.value })} placeholder="Subject" /></label>}
              {editor.whatsappBusinessTemplate && <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>Meta approval is required before sending. Use the personalization fields to insert lead values.{editor.whatsappIncludesSelectionLink && <> The pickup/plot link is included in this default template as <code>{'{{7}}'}</code>.</>}</p>}
              {aiDraftError && <div role="alert" style={{ display: 'flex', alignItems: 'flex-start', gap: '0.7rem', padding: '0.9rem 1rem', border: '1px solid #f2b547', borderRadius: 8, background: 'rgba(251, 191, 36, 0.12)', color: 'var(--text-primary)' }}><span aria-hidden="true" style={{ color: '#d97706', fontSize: '1.2rem', lineHeight: 1 }}>×</span><div><strong style={{ display: 'block', marginBottom: '0.25rem' }}>AI access is not configured yet</strong><span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>{aiDraftError}</span></div></div>}
              <div style={{ ...fieldLabelStyle, display: 'block', marginBottom: '-0.4rem' }}>Message <span aria-hidden="true" style={requiredMarkStyle}>*</span></div>
              <div style={toolbarStyle}>
                {!editor.whatsappBusinessTemplate && <button type="button" className="btn-secondary" onClick={writeWithAi} disabled={generating} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}><Sparkles size={15} /> {generating ? 'Writing...' : 'Write with AI'}</button>}
                <button type="button" style={toolbarButtonStyle} onClick={() => runCommand('bold')} aria-label="Bold"><Bold size={15} /></button>
                <button type="button" style={toolbarButtonStyle} onClick={() => runCommand('italic')} aria-label="Italic"><Italic size={15} /></button>
                <button type="button" style={toolbarButtonStyle} onClick={() => runCommand('underline')} aria-label="Underline"><Underline size={15} /></button>
                <button type="button" style={toolbarButtonStyle} onClick={() => runCommand('justifyLeft')} aria-label="Align left"><AlignLeft size={15} /></button>
                <button type="button" style={toolbarButtonStyle} onClick={() => runCommand('justifyCenter')} aria-label="Align center"><AlignCenter size={15} /></button>
                <button type="button" style={toolbarButtonStyle} onClick={() => runCommand('justifyRight')} aria-label="Align right"><AlignRight size={15} /></button>
                <select aria-label="Font size" style={toolbarSelectStyle} defaultValue="3" onChange={e => runCommand('fontSize', e.target.value)}><option value="2">Small</option><option value="3">Normal</option><option value="5">Large</option><option value="7">Huge</option></select>
                <button type="button" style={toolbarButtonStyle} onClick={() => { const url = window.prompt('Enter link URL'); if (url) runCommand('createLink', url); }} aria-label="Insert link"><Link size={15} /></button>
                {!editor.whatsappBusinessTemplate && <button type="button" className="btn-secondary" onClick={() => { setPersonalizationTarget('body'); setPersonalizationOpen(open => !open); }}>Insert Personalization</button>}
              </div>
              {personalizationOpen && <div className="generic-template-modal__picker" style={personalizationMenuStyle}>{Object.entries(groupedFields).map(([group, groupFields]) => <div key={group}><strong style={{ display: 'block', margin: '0.2rem 0 0.3rem' }}>{group}</strong>{groupFields.map(field => <button type="button" key={field.key} onClick={() => insertVariable(field)} style={variableButtonStyle}>{field.label}</button>)}</div>)}</div>}
              <div ref={editorRef} contentEditable role="textbox" aria-label={editor.whatsappBusinessTemplate ? 'WhatsApp message' : 'Email body'} onFocus={() => setPersonalizationTarget('body')} onInput={() => setEditor(current => ({ ...current, body: fromEditorHtml(editorRef.current) }))} data-placeholder={editor.whatsappBusinessTemplate ? 'Write your WhatsApp message here...' : 'Write your email here...'} style={richEditorStyle} />
            </div>
            <aside className="generic-template-scrollbar generic-template-modal__personalization" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border-color)', borderRadius: '10px', padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}><h4 style={{ fontSize: '0.85rem', margin: 0 }}>Personalization</h4><span style={{ color: 'var(--text-secondary)', fontSize: '0.7rem' }}>{editorFields.length} tags</span></div>
              <span style={{ color: 'var(--text-secondary)', fontSize: '0.72rem' }}>{editor.whatsappBusinessTemplate ? 'Choose a CRM field to insert it as a Meta placeholder. Its value is filled when sending.' : 'Fields come from Generic CRM backend metadata.'}</span>
              <label style={{ position: 'relative', display: 'flex', alignItems: 'center' }}><Search size={14} style={{ position: 'absolute', left: 8, color: 'var(--text-secondary)' }} /><input className="input-field" value={personalizationQuery} onChange={event => setPersonalizationQuery(event.target.value)} placeholder="Filter merge fields..." aria-label="Filter merge fields" style={{ paddingLeft: 28 }} /></label>
              {personalizationGroups.length > 0 && <>
                <select className="input-field generic-template-modal__group-select" value={activePersonalizationGroup} onChange={event => setPersonalizationGroup(event.target.value)} aria-label="Personalization field group">{personalizationGroups.map(group => <option key={group} value={group}>{group}</option>)}</select>
                <button type="button" className="input-field generic-template-modal__group-trigger" aria-label="Personalization field group" aria-expanded={groupDropdownOpen} aria-haspopup="listbox" onClick={() => setGroupDropdownOpen(open => !open)}>{activePersonalizationGroup}<ChevronDown size={16} /></button>
                {groupDropdownOpen && <div className="generic-template-modal__group-list" role="listbox" aria-label="Personalization field groups">
                  {personalizationGroups.map(group => <button type="button" role="option" key={group} aria-selected={activePersonalizationGroup === group} onClick={() => { setPersonalizationGroup(group); setGroupDropdownOpen(false); }}>{group}</button>)}
                </div>}
              </>}
              {activePersonalizationGroup && <strong style={{ display: 'block', margin: '0.2rem 0' }}>{activePersonalizationGroup}</strong>}
              {activePersonalizationFields.length > 0 && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>{activePersonalizationFields.map(field => <button type="button" key={field.key} onClick={() => insertVariable(field)} style={variableButtonStyle}>{editor.whatsappBusinessTemplate ? `${field.label} {{${field.key}}}` : field.label}</button>)}</div>}
              {editorFields.length > 0 && !activePersonalizationFields.length && <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>No matching personalization fields.</span>}
              {!editorFields.length && <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>No personalization fields available.</span>}
              {editor.whatsappBusinessTemplate && editor.whatsappIncludesSelectionLink && <p style={{ margin: 'auto 0 0', color: 'var(--text-secondary)', fontSize: '0.75rem' }}>Pickup / plot link <code>{'{{7}}'}</code><br />Included only in this default; system-generated.</p>}
            </aside>
          </div>
          <div className="generic-template-modal__footer" style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', marginTop: '1rem' }}>
            <button type="button" className="btn-secondary" onClick={previewTemplate} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}><Eye size={15} /> Preview</button>
            <div style={{ display: 'flex', gap: '0.5rem' }}><button type="button" className="btn-secondary" onClick={() => { setEditor(null); onEmbeddedClose?.(); }}>Cancel</button><button type="button" className="btn-primary" onClick={saveTemplate} disabled={busy} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}><Save size={15} /> {busy ? 'Saving...' : 'Save Template'}</button></div>
          </div>
        </div>
      </div>}
      {preview && <div onClick={() => { setPreview(null); setPreviewContactOpen(false); setPreviewContactQuery(''); }} style={modalBackdropStyle}>
        <div role="dialog" aria-label={`Preview ${previewChannelLabel} template`} onClick={event => event.stopPropagation()} className="card modal" style={{ ...modalStyle, maxWidth: '760px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><h3 style={{ margin: 0 }}>Preview {previewChannelLabel}</h3><button type="button" onClick={() => { setPreview(null); setPreviewContactOpen(false); setPreviewContactQuery(''); }} aria-label="Close preview" style={iconButtonStyle}><X size={20} /></button></div>
          <label style={{ ...fieldLabelStyle, marginTop: '1rem', marginBottom: '1rem' }}>Preview as
            <div style={{ position: 'relative' }}>
              <button type="button" className="input-field" role="combobox" aria-label="Preview contact" aria-haspopup="listbox" aria-expanded={previewContactOpen} onClick={() => { setPreviewContactOpen(open => !open); setPreviewContactQuery(''); }} style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, textAlign: 'left' }}><span>{selectedPreviewContact ? `${selectedPreviewContact.name}${selectedPreviewContact.email ? ` — ${selectedPreviewContact.email}` : ''}` : 'Sample contact'}</span><ChevronDown size={16} /></button>
              {previewContactOpen && <div style={previewContactPopoverStyle}>
                <div style={previewContactSearchStyle}><Search size={16} aria-hidden="true" /><input type="search" autoFocus aria-label="Search preview contacts" placeholder="Search by name or email" value={previewContactQuery} onChange={event => setPreviewContactQuery(event.target.value)} style={previewContactSearchInputStyle} /></div>
                <div role="listbox" aria-label="Preview contacts" style={previewContactListStyle}>
                  {visiblePreviewContacts.map(contact => <button type="button" role="option" aria-selected={String(previewContactId) === String(contact.id)} key={contact.id || 'sample'} onClick={() => { const contactId = String(contact.id || ''); setPreviewContactId(contactId); setPreviewContactOpen(false); setPreviewContactQuery(''); openTemplatePreview(preview.source, contactId); }} style={previewContactOptionStyle}>{contact.name}{contact.email ? ` — ${contact.email}` : ''}</button>)}
                  {visiblePreviewContacts.length === 0 && <div role="status" style={previewContactEmptyStyle}>No matching contacts</div>}
                </div>
              </div>}
            </div>
          </label>
          {preview.subject && <p style={{ fontWeight: 600, marginBottom: '0.75rem' }}>{preview.subject}</p>}
          <iframe title="Rendered template preview" sandbox="" srcDoc={preview.body || '<p>No content</p>'} style={{ width: '100%', minHeight: '360px', border: '1px solid var(--border-color)', borderRadius: 8, background: 'var(--input-bg, var(--surface-color))' }} />
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1rem' }}><button type="button" className="btn-secondary" onClick={() => { setPreview(null); setPreviewContactOpen(false); }}>Close</button></div>
        </div>
      </div>}
      <style>{`.generic-template-scrollbar { scrollbar-width: thin; scrollbar-color: var(--border-color) transparent; } .generic-template-scrollbar::-webkit-scrollbar { width: 6px; height: 6px; } .generic-template-scrollbar::-webkit-scrollbar-thumb { background: var(--border-color); border-radius: 999px; } .generic-template-scrollbar::-webkit-scrollbar-track { background: transparent; }`}</style>
    </div>
  );
}

const fieldLabelStyle = { color: 'var(--text-secondary)', fontSize: '0.8rem', display: 'grid', gap: '0.35rem' };
const requiredMarkStyle = { color: 'var(--danger-color, #dc2626)', fontWeight: 700 };
const iconButtonStyle = { background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' };
const cardPreviewIconStyle = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, padding: 0, border: 0, background: 'transparent', color: 'var(--accent-color)', cursor: 'pointer' };
const previewContactPopoverStyle = { position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 20, padding: '0.3rem', border: '1px solid var(--border-color)', borderRadius: 8, background: 'var(--popover-bg, var(--modal-bg))', boxShadow: '0 10px 28px rgba(0,0,0,0.22)' };
const previewContactSearchStyle = { display: 'flex', alignItems: 'center', gap: '0.45rem', margin: '0.15rem 0.15rem 0.3rem', padding: '0.5rem 0.65rem', border: '1px solid var(--border-color)', borderRadius: 6, background: 'var(--input-bg, var(--surface-color))', color: 'var(--text-secondary)' };
const previewContactSearchInputStyle = { width: '100%', minWidth: 0, padding: 0, border: 0, outline: 0, background: 'transparent', color: 'var(--text-primary)', font: 'inherit' };
const previewContactListStyle = { maxHeight: '220px', overflowY: 'auto' };
const previewContactOptionStyle = { display: 'block', width: '100%', padding: '0.5rem 0.65rem', border: 0, borderRadius: 6, background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer', textAlign: 'left' };
const previewContactEmptyStyle = { padding: '0.75rem 0.65rem', color: 'var(--text-secondary)', textAlign: 'center' };
const variableButtonStyle = { textAlign: 'left', background: 'transparent', border: '1px solid var(--border-color)', color: 'var(--text-primary)', padding: '0.4rem 0.55rem', borderRadius: '6px', cursor: 'pointer', fontSize: '0.78rem' };
const toolbarStyle = { display: 'flex', alignItems: 'center', gap: '0.25rem', flexWrap: 'wrap', padding: '0.4rem', border: '1px solid var(--border-color)', borderRadius: '8px', background: 'var(--subtle-bg-2)' };
const toolbarButtonStyle = { ...iconButtonStyle, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0.35rem', borderRadius: '5px' };
const toolbarSelectStyle = { border: '1px solid var(--border-color)', borderRadius: '5px', padding: '0.25rem', background: 'var(--surface-color)', color: 'var(--text-primary)' };
const personalizationMenuStyle = { display: 'grid', gap: '0.4rem', padding: '0.6rem', border: '1px solid var(--border-color)', borderRadius: '8px', background: 'var(--surface-color)' };
const richEditorStyle = { flex: 1, minHeight: '320px', padding: '0.75rem', border: '1px solid var(--border-color)', borderRadius: '8px', background: 'var(--surface-color)', color: 'var(--text-primary)', outline: 'none', lineHeight: 1.55, overflowY: 'auto', whiteSpace: 'pre-wrap' };
const modalBackdropStyle = { position: 'fixed', inset: 0, background: 'var(--overlay-bg, rgba(0,0,0,0.55))', backdropFilter: 'blur(6px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1.25rem' };
const modalStyle = { width: '100%', maxWidth: '960px', maxHeight: '90vh', overflow: 'auto', padding: '1.25rem 1.5rem', background: 'var(--modal-bg, var(--surface-color))', border: '1px solid var(--border-color)', borderRadius: '14px' };
