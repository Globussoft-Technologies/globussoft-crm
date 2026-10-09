import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, Eye, GripVertical, Plus, Save, Trash2, X } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';

const STEPS = ['Details', 'Trigger', 'Sequence', 'Steps', 'Review'];
const DEFAULT_OPERATORS = [
  { value: 'eq', label: 'Equals' },
  { value: 'neq', label: 'Not Equals' },
  { value: 'contains', label: 'Contains' },
  { value: 'notContains', label: 'Does Not Contain' },
  { value: 'empty', label: 'Is Empty' },
  { value: 'notEmpty', label: 'Is Not Empty' },
];
const NUMBER_OPERATORS = [
  { value: 'eq', label: 'Equals' },
  { value: 'neq', label: 'Not Equals' },
  { value: 'gt', label: 'Greater Than' },
  { value: 'gte', label: 'Greater Than or Equal' },
  { value: 'lt', label: 'Less Than' },
  { value: 'lte', label: 'Less Than or Equal' },
  { value: 'empty', label: 'Is Empty' },
  { value: 'notEmpty', label: 'Is Not Empty' },
];
const ACTIONS = [
  { value: 'email', label: 'Send Email' },
  { value: 'wait', label: 'Wait / Delay' },
  { value: 'condition', label: 'Condition' },
  { value: 'stop', label: 'Stop Automation' },
];
const DELAY_UNITS = [
  { value: 'minutes', label: 'Minutes', multiplier: 1 },
  { value: 'hours', label: 'Hours', multiplier: 60 },
  { value: 'days', label: 'Days', multiplier: 1440 },
];
const TIMEZONES = ['UTC', ...(typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [])];
const BROWSER_TIMEZONE = typeof Intl.DateTimeFormat === 'function' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC';
const DEFAULT_TIMEZONE = TIMEZONES.includes(BROWSER_TIMEZONE) ? BROWSER_TIMEZONE : 'UTC';

const inputStyle = { width: '100%', boxSizing: 'border-box', background: 'var(--modal-control-bg, #fff)', color: 'var(--text-primary, #172033)', borderColor: 'var(--modal-border, #d7dee9)' };
const labelStyle = { display: 'block', marginBottom: '0.35rem', fontSize: '0.8rem', color: 'var(--text-secondary)' };

function parseJson(value, fallback) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function emptyCondition() {
  return { field: '', op: 'eq', value: '', key: '' };
}

function emptyReceiverAction() {
  return { type: 'send_email', emailTemplateId: '', amount: 1, unit: 'days', value: '' };
}

function emptyReceiverCondition() {
  return {
    version: 2,
    logic: 'ALL',
    conditions: [{ type: 'email_activity', event: 'opened' }],
    yesAction: emptyReceiverAction(),
    noAction: emptyReceiverAction(),
  };
}

const STEP_CONDITION_OPERATORS = [
  { value: 'eq', label: 'Equals' },
  { value: 'neq', label: 'Not Equals' },
  { value: 'contains', label: 'Contains' },
  { value: 'gt', label: 'Greater Than' },
  { value: 'gte', label: 'Greater Than or Equal' },
  { value: 'lt', label: 'Less Than' },
  { value: 'lte', label: 'Less Than or Equal' },
  { value: 'exists', label: 'Has a value' },
  { value: 'not_exists', label: 'Is empty' },
];

function conditionForStep(item) {
  const parsed = parseJson(item.conditionJson, null);
  return Array.isArray(parsed) && parsed[0] ? parsed[0] : emptyCondition();
}

function conditionClausesForStep(item) {
  const parsed = parseJson(item.conditionJson, null);
  return Array.isArray(parsed) && parsed.length ? parsed : [emptyCondition()];
}

const RECEIVER_CONDITION_TYPES = [
  { value: 'email_activity', label: 'Email Activity', options: [
    { value: 'opened', label: 'Email Opened' }, { value: 'not_opened', label: 'Email Not Opened' },
    { value: 'clicked', label: 'Link Clicked' }, { value: 'not_clicked', label: 'Link Not Clicked' },
    { value: 'replied', label: 'Replied' }, { value: 'no_reply', label: 'No Reply' },
    { value: 'bounced', label: 'Email Bounced' }, { value: 'unsubscribed', label: 'Unsubscribed' },
  ] },
  { value: 'contact_status', label: 'Lead/Contact Status Changed', options: [] },
  { value: 'deal_stage', label: 'Deal Stage Changed', options: [] },
  { value: 'pickup_booking_status', label: 'Pickup Booking Status', options: [] },
  { value: 'site_visit_status', label: 'Site Visit Status', options: [] },
];

const RECEIVER_ACTIONS = [
  { value: 'send_email', label: 'Send Email' }, { value: 'wait', label: 'Wait' },
  { value: 'stop_sequence', label: 'Stop Sequence' }, { value: 'change_contact_status', label: 'Change Lead/Contact Status' },
];

function legacyReceiverCondition(item) {
  const clause = conditionForStep(item);
  if (clause.field === 'email.activity') return { ...emptyReceiverCondition(), conditions: [{ type: 'email_activity', event: clause.value || 'opened' }] };
  if (clause.field === 'contact.status') return { ...emptyReceiverCondition(), conditions: [{ type: 'contact_status', event: 'changed', value: clause.value || '' }] };
  if (clause.field === 'deal.stage') return { ...emptyReceiverCondition(), conditions: [{ type: 'deal_stage', event: 'changed', value: clause.value || '' }] };
  return emptyReceiverCondition();
}

function validStepCondition(value) {
  const parsed = parseJson(value, null);
  if (parsed?.version === 2 && Array.isArray(parsed.conditions)) {
    const validCondition = parsed.conditions.length > 0 && parsed.conditions.every(condition => condition?.type && condition?.event && (condition.type === 'email_activity' || String(condition.value || '').trim()));
    const validAction = action => action?.type === 'stop_sequence'
      || (action?.type === 'send_email' && action.emailTemplateId)
      || (action?.type === 'wait' && Number(action.amount) > 0)
      || (action?.type === 'change_contact_status' && String(action.value || '').trim());
    return validCondition && validAction(parsed.yesAction) && validAction(parsed.noAction);
  }
  const clauses = Array.isArray(parsed) ? parsed : parsed?.groups?.flatMap(group => group?.clauses || []);
  if (!Array.isArray(clauses) || !clauses.length) return false;
  return clauses.every(clause => clause?.field && clause?.op && (['exists', 'not_exists'].includes(clause.op) || String(clause.value ?? '').trim()));
}

function conditionReviewSummary(item, templates) {
  const parsed = parseJson(item.conditionJson, null);
  if (parsed?.version === 2) {
    const conditionText = (parsed.conditions || []).map(condition => `${condition.type || 'Condition'}: ${condition.event || condition.value || 'Not configured'}`).join(` ${parsed.logic === 'ANY' ? 'OR' : 'AND'} `);
    const actionText = action => {
      if (!action) return 'Not configured';
      if (action.type === 'send_email') return `Send Email — ${templates.find(template => String(template.id) === String(action.emailTemplateId))?.name || 'No template'}`;
      if (action.type === 'wait') return `Wait ${action.amount || 0} ${action.unit || 'days'}`;
      if (action.type === 'change_contact_status') return `Change status to ${action.value || 'Not configured'}`;
      return action.type === 'stop_sequence' ? 'Stop Sequence' : action.type || 'Not configured';
    };
    return ` — If ${conditionText || 'configured'}; YES: ${actionText(parsed.yesAction)}; NO: ${actionText(parsed.noAction)}`;
  }
  return '';
}

function StepConditionEditor({ item, onChange, conditionFields, conditionValues, loadConditionValues, conditionMetadata, templates, onPreviewTemplate }) {
  const storedCondition = parseJson(item.conditionJson, null);
  const receiver = storedCondition?.version === 2 ? storedCondition : legacyReceiverCondition(item);
  if (receiver) {
    const conditionTypes = conditionMetadata?.conditionTypes?.length ? conditionMetadata.conditionTypes : RECEIVER_CONDITION_TYPES;
    const actions = conditionMetadata?.actions?.length ? conditionMetadata.actions : RECEIVER_ACTIONS;
    const updateReceiver = patch => onChange({ conditionJson: JSON.stringify({ ...receiver, ...patch }), conditionMode: 'receiver' });
    const updateCondition = (index, patch) => updateReceiver({ conditions: receiver.conditions.map((condition, current) => current === index ? { ...condition, ...patch } : condition) });
    const updateAction = (key, patch) => updateReceiver({ [key]: { ...(receiver[key] || emptyReceiverAction()), ...patch } });
    const previewEmailTemplate = async templateId => {
      const selected = templates.find(template => String(template.id) === String(templateId));
      if (!selected) return;
      const full = await fetchApi(`/api/email-templates/${selected.id}`, { silent: true }).catch(() => null);
      onPreviewTemplate(full?.body !== undefined ? full : selected);
    };
    const renderAction = (key, label) => {
      const action = receiver[key] || emptyReceiverAction();
      return <div style={{ border: '1px solid var(--border-color)', borderRadius: 8, padding: 10, display: 'grid', gap: 6, minWidth: 0 }}>
        <strong>{label}</strong>
        <select className="input-field" value={action.type || ''} onChange={event => updateAction(key, { type: event.target.value, emailTemplateId: '', value: '' })}>
          <option value="">Select action</option>
          {actions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        {action.type === 'send_email' && <div style={{ display: 'flex', gap: 5 }}>
          <select className="input-field" style={{ minWidth: 0, flex: 1 }} value={action.emailTemplateId || ''} onChange={event => updateAction(key, { emailTemplateId: event.target.value })}>
            <option value="">Select email template</option>
            {templates.map(template => <option key={template.id} value={template.id}>{template.name}</option>)}
          </select>
          <button type="button" style={iconButtonStyle} disabled={!action.emailTemplateId} onClick={() => previewEmailTemplate(action.emailTemplateId)} aria-label={`Preview ${label} email template`} title="Preview email template"><Eye size={15} /></button>
        </div>}
        {action.type === 'wait' && <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 6 }}>
          <input type="number" min="1" className="input-field" value={action.amount || ''} onChange={event => updateAction(key, { amount: event.target.value })} placeholder="Amount" />
          <select className="input-field" value={action.unit || 'days'} onChange={event => updateAction(key, { unit: event.target.value })}><option value="minutes">Minutes</option><option value="hours">Hours</option><option value="days">Days</option></select>
        </div>}
        {action.type === 'change_contact_status' && <select className="input-field" value={action.value || ''} onChange={event => updateAction(key, { value: event.target.value })}>
          <option value="">Select status</option>
          {(conditionMetadata?.statusOptions || []).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>}
      </div>;
    };
    return <div style={{ display: 'grid', gap: 8, gridColumn: '1 / -1', minWidth: 0 }}>
      <label style={labelStyle}>When the receiver does this</label>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 6, alignItems: 'center' }}>
        <select className="input-field" value={receiver.logic || 'ALL'} onChange={event => updateReceiver({ logic: event.target.value })}><option value="ALL">ALL conditions match</option><option value="ANY">ANY condition matches</option></select>
        <button type="button" className="btn-secondary" onClick={() => updateReceiver({ conditions: [...receiver.conditions, { type: 'email_activity', event: 'opened' }] })}><Plus size={14} /> Add condition</button>
      </div>
      {receiver.conditions.map((condition, index) => {
        const type = conditionTypes.find(option => option.value === condition.type) || conditionTypes[0];
        return <div key={`${condition.type}-${index}`} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) auto', gap: 6, alignItems: 'center' }}>
          <select className="input-field" value={condition.type || ''} onChange={event => { const next = conditionTypes.find(option => option.value === event.target.value); updateCondition(index, { type: event.target.value, event: next?.options?.[0]?.value || '', value: '' }); }}><option value="">Select category</option>{conditionTypes.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
          <select className="input-field" value={condition.type === 'email_activity' ? (condition.event || '') : (condition.value || '')} onChange={event => updateCondition(index, condition.type === 'email_activity' ? { event: event.target.value } : { event: condition.event || 'changed', value: event.target.value })}>
            <option value="">Select condition</option>{(type?.options || []).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <button type="button" style={iconButtonStyle} aria-label="Remove condition" title="Remove condition" disabled={receiver.conditions.length === 1} onClick={() => updateReceiver({ conditions: receiver.conditions.filter((_, current) => current !== index) })}><Trash2 size={15} /></button>
        </div>;
      })}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
        {renderAction('yesAction', 'YES → What should happen?')}
        {renderAction('noAction', 'NO → What should happen?')}
      </div>
    </div>;
  }
  const clause = conditionForStep(item);
  const mode = item.conditionMode || (Array.isArray(parseJson(item.conditionJson, null)) ? 'visual' : 'custom');
  const field = conditionFields.find(option => option.field === clause.field);
  const values = field?.options || conditionValues[conditionFieldKey(field)] || [];
  const operators = field?.kind === 'number' || field?.kind === 'range'
    ? STEP_CONDITION_OPERATORS.filter(option => ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'exists', 'not_exists'].includes(option.value))
    : STEP_CONDITION_OPERATORS;
  const updateClause = patch => onChange({ conditionJson: JSON.stringify(conditionClausesForStep(item).map((entry, index) => index === 0 ? { ...entry, ...patch } : entry)), conditionMode: 'visual' });
  return <div style={{ display: 'grid', gap: 6 }}>
    <label style={labelStyle}>Condition</label>
    <select className="input-field" value={mode} onChange={event => onChange(event.target.value === 'custom' ? { conditionMode: 'custom' } : { conditionMode: 'visual', conditionJson: JSON.stringify([emptyCondition()]) })}>
      <option value="visual">Build condition</option>
      <option value="custom">Custom condition</option>
    </select>
    {mode === 'custom' ? <textarea className="input-field" rows={3} value={item.conditionJson} onChange={event => onChange({ conditionJson: event.target.value, conditionMode: 'custom' })} /> : <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr)', gap: 5 }}>
      <select className="input-field" value={clause.field || ''} onChange={event => { const next = conditionFields.find(option => option.field === event.target.value); updateClause({ field: event.target.value, op: 'eq', value: '' }); if (next) loadConditionValues({ field: next.field }); }}>
        <option value="">Select field</option>
        {conditionFields.map(option => <option key={option.field} value={option.field}>{option.label}</option>)}
      </select>
      <select className="input-field" value={clause.op || 'eq'} disabled={!field} onChange={event => updateClause({ op: event.target.value, value: '' })}>
        {operators.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      {values.length ? <select className="input-field" value={clause.value || ''} disabled={!field || ['exists', 'not_exists'].includes(clause.op)} onFocus={() => loadConditionValues(clause)} onChange={event => updateClause({ value: event.target.value })}><option value="">Select value</option>{values.map(option => <option key={option.value} value={option.value}>{option.label || option.value}</option>)}</select> : <input className="input-field" value={clause.value || ''} disabled={!field || ['exists', 'not_exists'].includes(clause.op)} onFocus={() => loadConditionValues(clause)} onChange={event => updateClause({ value: event.target.value })} />}
    </div>}
    {!validStepCondition(item.conditionJson) && <small style={{ color: 'var(--danger-color, #b42318)' }}>Complete the condition before saving.</small>}
  </div>;
}

function operatorsFor(field) {
  if (field?.kind === 'number' || field?.kind === 'range') return NUMBER_OPERATORS;
  if (field?.kind === 'boolean' || field?.kind === 'date') return DEFAULT_OPERATORS.filter(item => ['eq', 'neq', 'empty', 'notEmpty'].includes(item.value));
  return DEFAULT_OPERATORS;
}

function conditionFieldKey(field) {
  return field?.field?.startsWith('contact.') ? field.field.slice('contact.'.length) : field?.field;
}

function delayParts(delayMinutes) {
  const minutes = Number(delayMinutes) || 0;
  if (minutes > 0 && minutes % 1440 === 0) return { delayAmount: minutes / 1440, delayUnit: 'days' };
  if (minutes > 0 && minutes % 60 === 0) return { delayAmount: minutes / 60, delayUnit: 'hours' };
  return { delayAmount: minutes, delayUnit: 'minutes' };
}

function delayInMinutes(item) {
  const amount = Number(item.delayAmount ?? item.delayMinutes ?? 0);
  const unit = DELAY_UNITS.find(option => option.value === (item.delayUnit || 'minutes')) || DELAY_UNITS[0];
  return Math.max(0, Math.round(amount * unit.multiplier));
}

function emptyStep() {
  return { kind: 'email', name: '', emailTemplateId: '', delayAmount: 0, delayUnit: 'minutes', delayMinutes: 0, conditionJson: JSON.stringify(emptyReceiverCondition()), conditionMode: 'receiver', trueNextPosition: '', falseNextPosition: '' };
}

function normaliseStep(step) {
  const parsedCondition = parseJson(step.conditionJson, null);
  const condition = parsedCondition || [emptyCondition()];
  return {
    id: step.id,
    kind: step.kind === 'stop' ? 'stop' : step.kind,
    name: /^Step\s+\d+$/i.test(String(step.name || '').trim()) ? '' : (step.name || ''),
    emailTemplateId: step.emailTemplateId || '',
    ...delayParts(step.delayMinutes),
    delayMinutes: step.delayMinutes || 0,
    conditionJson: Array.isArray(condition) ? JSON.stringify(condition) : (step.conditionJson || JSON.stringify(condition)),
    conditionMode: parsedCondition?.version === 2 ? 'receiver' : (Array.isArray(condition) ? 'visual' : 'custom'),
    trueNextPosition: step.trueNextPosition ?? '',
    falseNextPosition: step.falseNextPosition ?? '',
  };
}

export default function GenericCampaignWizard({ campaign, onClose, onSaved }) {
  const notify = useNotify();
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [templateEditor, setTemplateEditor] = useState(null);
  const [previewTemplate, setPreviewTemplate] = useState(null);
  const [sequences, setSequences] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [conditionFields, setConditionFields] = useState([]);
  const [conditionMetadata, setConditionMetadata] = useState({ conditionTypes: [], actions: [], statusOptions: [], dealStageOptions: [] });
  const [conditionValues, setConditionValues] = useState({});
  const [sequenceSteps, setSequenceSteps] = useState([]);
  const [draggedStepIndex, setDraggedStepIndex] = useState(null);
  const [draft, setDraft] = useState(() => {
    const metadata = parseJson(campaign?.scheduleFilters, {});
    return {
      name: campaign?.name || '',
      description: metadata.description || '',
      category: metadata.category || '',
      channel: campaign?.channel || 'EMAIL',
      status: campaign?.status || 'Draft',
      lifecycleState: metadata.lifecycleState || (campaign?.status === 'Active' ? 'running' : 'draft'),
      enrollmentMode: metadata.enrollmentMode || 'auto',
      trigger: Array.isArray(metadata.trigger) && metadata.trigger.length ? metadata.trigger : [emptyCondition()],
      triggerLogic: metadata.triggerLogic || 'AND',
      externalEvent: metadata.externalEvent || '',
      sequenceId: campaign?.sequenceId || '',
      sequenceName: metadata.sequenceName || '',
      sequenceDescription: metadata.sequenceDescription || '',
      timezone: TIMEZONES.includes(metadata.timezone) ? metadata.timezone : DEFAULT_TIMEZONE,
      startHour: metadata.startHour ?? 0,
      endHour: metadata.endHour ?? 23,
      businessDaysOnly: metadata.businessDaysOnly === true,
      steps: Array.isArray(metadata.steps) ? metadata.steps.map(normaliseStep) : [],
    };
  });

  useEffect(() => {
    let alive = true;
    Promise.all([
      fetchApi('/api/sequences?fields=summary', { silent: true }).catch(() => []),
      fetchApi('/api/email-templates?fields=summary', { silent: true }).catch(() => []),
      campaign?.sequenceId ? fetchApi(`/api/sequences/${campaign.sequenceId}/steps`, { silent: true }).catch(() => []) : Promise.resolve([]),
    ]).then(([seqs, tmpls, existingSteps]) => {
      if (!alive) return;
      setSequences(Array.isArray(seqs) ? seqs : []);
      setTemplates(Array.isArray(tmpls) ? tmpls : (tmpls?.templates || []));
      const loaded = Array.isArray(existingSteps) ? existingSteps.map(normaliseStep) : [];
      setSequenceSteps(loaded);
      // The database sequence is the source of truth. Metadata is retained
      // for campaign review, but must not replace step rows because it has no
      // persisted SequenceStep IDs for update/delete operations.
      if (loaded.length) setDraft(current => ({ ...current, steps: loaded }));
    }).finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [campaign?.sequenceId]);

  useEffect(() => {
    let alive = true;
    Promise.all([
      fetchApi('/api/contacts/filter-fields', { silent: true }).catch(() => ({ fields: [] })),
      fetchApi('/api/lead-custom-fields', { silent: true }).catch(() => []),
      fetchApi('/api/marketing/generic-condition-metadata', { silent: true }).catch(() => ({ fields: [] })),
    ]).then(([fieldResponse, customDefinitions, metadataResponse]) => {
      if (!alive) return;
      const backendFields = Array.isArray(fieldResponse) ? fieldResponse : (fieldResponse?.fields || []);
      const customByKey = new Map((Array.isArray(customDefinitions) ? customDefinitions : []).map(item => [`custom_${item.id}`, item]));
      const contactFields = backendFields.map(item => {
        const rawKey = item.field;
        const custom = customByKey.get(rawKey);
        return {
          ...item,
          field: `contact.${rawKey}`,
          label: custom?.label || item.label,
          kind: custom?.fieldType === 'number' ? 'number' : (custom?.fieldType === 'date' ? 'date' : (custom?.fieldType === 'checkbox' ? 'boolean' : item.kind)),
          options: custom?.options || null,
          custom: Boolean(custom),
        };
      });
      const supplementalFields = Array.isArray(metadataResponse) ? metadataResponse : (metadataResponse?.fields || []);
      if (metadataResponse && !Array.isArray(metadataResponse)) setConditionMetadata(metadataResponse);
      setConditionFields([...contactFields, ...supplementalFields]);
    });
    return () => { alive = false; };
  }, []);

  const selectedConditionField = (rule) => conditionFields.find(field => field.field === rule.field);
  const loadConditionValues = async (rule) => {
    const field = selectedConditionField(rule);
    if (!field || field.kind === 'event' || field.options?.length) return;
    const rawField = conditionFieldKey(field);
    if (!rawField || conditionValues[rawField]) return;
    const response = await fetchApi(`/api/contacts/filter-values/${encodeURIComponent(rawField)}`, { silent: true }).catch(() => ({ values: [] }));
    setConditionValues(current => ({ ...current, [rawField]: Array.isArray(response) ? response : (response?.values || []) }));
  };

  const selectedSequence = useMemo(() => sequences.find(s => s.id === Number(draft.sequenceId)), [sequences, draft.sequenceId]);
  const steps = draft.steps;
  const update = (patch) => setDraft(current => ({ ...current, ...patch }));
  const updateStep = (index, patch) => update({ steps: steps.map((item, i) => i === index ? { ...item, ...patch } : item) });
  const isStepComplete = currentStep => {
    if (currentStep === 0) return Boolean(draft.name.trim());
    if (currentStep === 1) return Boolean(draft.trigger.length && draft.trigger.every(rule => rule.field && rule.op && (rule.op === 'empty' || rule.op === 'notEmpty' || String(rule.value || '').trim())));
    if (currentStep === 2) return Boolean(draft.sequenceId || draft.sequenceName.trim());
    if (currentStep === 3) return Boolean(steps.length && steps.every(item => item.name?.trim() && (item.kind !== 'email' || item.emailTemplateId) && (item.kind !== 'condition' || validStepCondition(item.conditionJson))));
    return true;
  };
  const goToStep = nextStep => {
    if (nextStep <= step) {
      setStep(nextStep);
      return;
    }
    if (nextStep !== step + 1) {
      notify.error('Complete the previous step before continuing');
      return;
    }
    if (!isStepComplete(step)) {
      notify.error(step === 0 ? 'Campaign name is required' : `Complete step ${step + 1} before continuing`);
      return;
    }
    setStep(nextStep);
  };
  const reorderSteps = (fromIndex, toIndex) => {
    if (fromIndex == null || fromIndex === toIndex || toIndex == null) return;
    setDraft(current => {
      const reordered = [...current.steps];
      const [moved] = reordered.splice(fromIndex, 1);
      reordered.splice(toIndex, 0, moved);
      return { ...current, steps: reordered };
    });
  };
  const addCondition = (target) => update({ [target]: [...draft[target], emptyCondition()] });
  const removeCondition = (target, index) => update({ [target]: draft[target].filter((_, i) => i !== index) });

  const createSequenceIfNeeded = async () => {
    if (draft.sequenceId) return Number(draft.sequenceId);
    if (!draft.sequenceName.trim()) throw new Error('Sequence name is required');
    const created = await fetchApi('/api/sequences', {
      method: 'POST',
      body: JSON.stringify({ name: draft.sequenceName.trim(), nodes: [], edges: [], isActive: false }),
    });
    return created.id;
  };

  const persistSequenceSteps = async (sequenceId) => {
    const retainedIds = new Set(steps.map(item => Number(item.id)).filter(Number.isFinite));
    for (const [position, item] of steps.entries()) {
      const payload = {
        kind: item.kind,
        name: item.name || null,
        position,
        emailTemplateId: item.emailTemplateId || null,
        delayMinutes: delayInMinutes(item),
        conditionJson: item.conditionJson || null,
        trueNextPosition: item.trueNextPosition === '' ? null : Number(item.trueNextPosition),
        falseNextPosition: item.falseNextPosition === '' ? null : Number(item.falseNextPosition),
        pauseOnReply: item.kind !== 'condition' || parseJson(item.conditionJson, null)?.version !== 2,
      };
      if (item.id) {
        await fetchApi(`/api/sequences/steps/${item.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      } else {
        await fetchApi(`/api/sequences/${sequenceId}/steps`, { method: 'POST', body: JSON.stringify(payload) });
      }
    }
    for (const existingStep of sequenceSteps) {
      if (existingStep.id && !retainedIds.has(Number(existingStep.id))) {
        await fetchApi(`/api/sequences/steps/${existingStep.id}`, { method: 'DELETE' });
      }
    }
  };

  const createTemplate = async () => {
    if (!templateEditor?.name?.trim() || !templateEditor?.subject?.trim() || !templateEditor?.body?.trim()) {
      return notify.error('Template name, subject, and body are required');
    }
    try {
      const created = await fetchApi('/api/email-templates', {
        method: 'POST',
        body: JSON.stringify({
          name: templateEditor.name.trim(),
          subject: templateEditor.subject.trim(),
          body: templateEditor.body,
          category: templateEditor.category || 'General',
        }),
      });
      setTemplates(current => [created, ...current]);
      if (templateEditor.stepIndex != null) updateStep(templateEditor.stepIndex, { emailTemplateId: created.id });
      setTemplateEditor(null);
      notify.success('Template created');
    } catch (error) {
      notify.error(error?.message || 'Failed to create template');
    }
  };

  const save = async (activate = false) => {
    if (!draft.name.trim()) return notify.error('Campaign name is required');
    if (!draft.trigger.length || draft.trigger.some(rule => !rule.field || !rule.op || (rule.op !== 'empty' && rule.op !== 'notEmpty' && !String(rule.value || '').trim()))) {
      return notify.error('Complete the trigger conditions before saving');
    }
    if (!draft.sequenceId && !draft.sequenceName.trim()) return notify.error('Select or create a sequence');
    if (!steps.length) return notify.error('Add at least one sequence step');
    if (steps.some(item => !item.name?.trim())) return notify.error('Enter a level name for every step');
    if (steps.some(item => item.kind === 'email' && !item.emailTemplateId)) return notify.error('Select a template for every email step');
    if (steps.some(item => item.kind === 'condition' && !validStepCondition(item.conditionJson))) return notify.error('Complete every condition before saving');
    setSaving(true);
    try {
      const sequenceId = await createSequenceIfNeeded();
      // Persist every Generic campaign step before activating the sequence.
      // This covers both newly-created and selected existing sequences and
      // ensures delayed/follow-up levels are visible to the cron engine.
      await persistSequenceSteps(sequenceId);
      let campaignId = campaign?.id;
      const payload = {
        name: draft.name.trim(),
        channel: draft.channel,
        status: activate ? 'Active' : 'Draft',
        sequenceId,
      };
      if (campaignId) {
        await fetchApi(`/api/marketing/campaigns/${campaignId}`, { method: 'PUT', body: JSON.stringify(payload) });
      } else {
        const created = await fetchApi('/api/marketing/campaigns', { method: 'POST', body: JSON.stringify({ ...payload, budget: 0 }) });
        campaignId = created.id;
      }
      const metadata = {
        description: draft.description,
        category: draft.category,
        lifecycleState: draft.lifecycleState,
        enrollmentMode: draft.enrollmentMode,
        trigger: draft.trigger,
        triggerLogic: draft.triggerLogic,
        externalEvent: draft.externalEvent,
        sequenceName: draft.sequenceName || selectedSequence?.name || '',
        sequenceDescription: draft.sequenceDescription,
        timezone: draft.timezone,
        startHour: Number(draft.startHour),
        endHour: Number(draft.endHour),
        businessDaysOnly: draft.businessDaysOnly,
        steps,
      };
      await fetchApi(`/api/marketing/campaigns/${campaignId}/schedule`, {
        method: 'POST',
        body: JSON.stringify({ scheduledAt: campaign?.scheduledAt || new Date(Date.now() + 365 * 86400000).toISOString(), filters: metadata }),
      });
      // The shared schedule endpoint intentionally stores Scheduled status.
      // Generic CRM activation is a separate workflow, so restore Active
      // after using that endpoint to persist the wizard metadata.
      if (activate) {
        await fetchApi(`/api/marketing/campaigns/${campaignId}`, {
          method: 'PUT',
          body: JSON.stringify({ status: 'Active', sequenceId }),
        });
      }
      if (!campaign?.scheduledAt && !activate) await fetchApi(`/api/marketing/campaigns/${campaignId}/pause`, { method: 'POST' });
      if (activate) {
        await fetchApi(`/api/sequences/${sequenceId}/toggle`, {
          method: 'PATCH',
          body: JSON.stringify({ isActive: true }),
        });
      }
      notify.success(activate ? 'Campaign activated' : 'Campaign draft saved');
      onSaved();
    } catch (error) {
      notify.error(error?.message || 'Failed to save campaign');
    } finally { setSaving(false); }
  };

  if (loading) return <div style={pageShellStyle}><div className="card" style={pageContentStyle}>Loading campaign builder…</div></div>;

  return (
    <div style={pageShellStyle}>
      <div role="main" aria-label={campaign?.id ? 'Edit campaign' : 'Create campaign'} className="card" style={pageContentStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
          <h3 style={{ margin: 0, flex: 1 }}>{campaign?.id ? 'Edit Campaign' : 'Create Email Campaign'}</h3>
          <span style={{ fontSize: '0.72rem', padding: '0.25rem 0.55rem', borderRadius: 6, background: draft.lifecycleState === 'running' ? 'rgba(16, 185, 129, 0.12)' : 'var(--subtle-bg-3)', color: draft.lifecycleState === 'running' ? '#047857' : 'var(--text-secondary)', border: draft.lifecycleState === 'running' ? '1px solid rgba(16, 185, 129, 0.35)' : '1px solid var(--border-color)' }}>
            {draft.lifecycleState === 'running' ? 'Running' : draft.lifecycleState === 'paused' ? 'Paused' : 'Draft'}
          </span>
          <button type="button" onClick={onClose} aria-label="Close" style={iconButtonStyle}><X size={20} /></button>
        </div>
        <div style={{ display: 'flex', gap: 6, margin: '0.85rem 0', flexWrap: 'wrap' }}>
          {STEPS.map((title, index) => <button key={title} type="button" onClick={() => goToStep(index)} style={{ ...progressStyle, ...(step === index ? activeProgressStyle : {}) }}>{index + 1}. {title}</button>)}
        </div>

        {step === 0 && <section>
           <Field label="Campaign Name"><input className="input-field" style={inputStyle} value={draft.name} onChange={e => update({ name: e.target.value })} /></Field>
           <Field label="Description"><textarea className="input-field" style={{ ...inputStyle, minHeight: '72px', resize: 'vertical' }} rows={3} value={draft.description} onChange={e => update({ description: e.target.value })} /></Field>
           <div style={twoCol}><Field label="Campaign Type / Category"><input className="input-field" style={inputStyle} placeholder="Add your own category" value={draft.category} onChange={e => update({ category: e.target.value })} /></Field><Field label="Channel"><select className="input-field" style={inputStyle} value={draft.channel} onChange={e => update({ channel: e.target.value })}><option value="EMAIL">Email</option><option value="SMS">SMS</option><option value="WHATSAPP">WhatsApp</option></select></Field></div>
           <div style={{ ...twoCol, border: '1px solid var(--border-color)', borderRadius: 8, padding: 10, marginTop: 10 }}>
             <div>
               <label style={labelStyle}>Sequence Lifecycle State</label>
               <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                 {[['running', 'Running'], ['paused', 'Paused'], ['draft', 'Draft']].map(([value, label]) => <button key={value} type="button" onClick={() => update({ lifecycleState: value })} style={{ ...progressStyle, ...(draft.lifecycleState === value ? activeProgressStyle : {}), borderRadius: 6, padding: '0.35rem 0.6rem' }}>{label}</button>)}
               </div>
               <small style={{ color: 'var(--text-secondary)' }}>Paused holds all dispatches; queued steps resume safely when running.</small>
             </div>
           </div>
         </section>}

        {step === 1 && <section>
          <p style={{ color: 'var(--text-secondary)' }}>Start the campaign when the configured rules match. Fields, values, and custom fields come from this Generic CRM tenant.</p>
          {draft.trigger.map((rule, index) => {
            const field = selectedConditionField(rule);
            const operators = operatorsFor(field);
            const rawField = conditionFieldKey(field);
            const values = field?.options || conditionValues[rawField] || [];
            const updateRule = (patch) => update({ trigger: draft.trigger.map((item, i) => i === index ? { ...item, ...patch } : item) });
            return <div key={index} style={{ border: '1px solid var(--border-color)', borderRadius: 8, padding: 10, marginBottom: 10 }}>
              <div style={{ ...twoCol, gridTemplateColumns: '1.2fr 1fr 1fr auto' }}>
                <select className="input-field" value={rule.field || ''} onChange={e => { const next = conditionFields.find(item => item.field === e.target.value); updateRule({ field: e.target.value, key: next?.custom ? conditionFieldKey(next) : '', op: 'eq', value: '' }); loadConditionValues({ ...rule, field: e.target.value }); }}>
                  <option value="">Select field</option>
                  {conditionFields.map(item => <option key={item.field} value={item.field}>{item.label}</option>)}
                </select>
                <select className="input-field" value={rule.op || 'eq'} onChange={e => updateRule({ op: e.target.value })}>{operators.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select>
                {field?.options?.length || values.length ? <select className="input-field" value={rule.value || ''} disabled={rule.op === 'empty' || rule.op === 'notEmpty'} onFocus={() => loadConditionValues(rule)} onChange={e => updateRule({ value: e.target.value })}><option value="">Select value</option>{values.map(item => <option key={item.value} value={item.value}>{item.label || item.value}</option>)}</select> : <input className="input-field" type={field?.kind === 'number' ? 'number' : field?.kind === 'date' ? 'date' : 'text'} value={rule.value || ''} disabled={!field || rule.op === 'empty' || rule.op === 'notEmpty'} placeholder={field?.kind === 'event' ? 'Enter event name' : field ? 'Enter or select a value' : 'Select a field first'} onFocus={() => loadConditionValues(rule)} onChange={e => updateRule({ value: e.target.value })} />}
                <button type="button" onClick={() => removeCondition('trigger', index)} style={iconButtonStyle} aria-label="Remove condition"><Trash2 size={15} /></button>
              </div>
              {field?.custom && <small style={{ color: 'var(--text-secondary)' }}>Custom field from this tenant’s Lead Fields configuration.</small>}
            </div>;
          })}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <button type="button" onClick={() => addCondition('trigger')} className="btn-secondary"><Plus size={14} /> Add Condition</button>
            <select className="input-field" style={{ width: 100 }} aria-label="Condition logic" value={draft.triggerLogic} onChange={e => update({ triggerLogic: e.target.value })}><option value="AND">AND</option><option value="OR">OR</option></select>
            <span style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>{draft.triggerLogic === 'AND' ? 'All rules must match' : 'At least one rule must match'}</span>
            <a href="/settings/lead-fields" target="_blank" rel="noreferrer" style={{ fontSize: '0.8rem' }}>Manage custom fields</a>
          </div>
        </section>}

        {step === 2 && <section>
          <Field label="Select Existing Sequence"><select className="input-field" style={inputStyle} value={draft.sequenceId} onChange={async e => { const id = e.target.value; update({ sequenceId: id, steps: [] }); setSequenceSteps([]); if (id) { const loaded = await fetchApi(`/api/sequences/${id}/steps`, { silent: true }).catch(() => []); const normalised = Array.isArray(loaded) ? loaded.map(normaliseStep) : []; setSequenceSteps(normalised); update({ sequenceId: id, steps: normalised }); } }}><option value="">Create a new sequence below</option>{sequences.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
          {!draft.sequenceId && <div style={twoCol}><Field label="New Sequence Name"><input className="input-field" style={inputStyle} value={draft.sequenceName} onChange={e => update({ sequenceName: e.target.value })} /></Field><Field label="Description"><input className="input-field" style={inputStyle} value={draft.sequenceDescription} onChange={e => update({ sequenceDescription: e.target.value })} /></Field></div>}
          {selectedSequence && <p style={{ padding: 12, background: 'var(--subtle-bg)', borderRadius: 8 }}>Selected sequence: <strong>{selectedSequence.name}</strong>{sequenceSteps.length ? ` — ${sequenceSteps.length} existing step(s)` : ''}</p>}
        </section>}

        {step === 3 && <section className="generic-sequence-steps" style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingBottom: 4 }}>
            {steps.map((item, index) => <div key={`compact-${item.id || index}`} draggable onDragStart={() => setDraggedStepIndex(index)} onDragOver={event => event.preventDefault()} onDrop={() => { reorderSteps(draggedStepIndex, index); setDraggedStepIndex(null); }} onDragEnd={() => setDraggedStepIndex(null)} style={{ display: 'grid', gridTemplateColumns: '42px minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1.4fr) minmax(0, 2fr) 28px', gap: 8, alignItems: 'end', border: '1px solid var(--border-color)', borderRadius: 8, padding: 8, position: 'relative', opacity: draggedStepIndex === index ? 0.55 : 1 }}>
              <button type="button" draggable aria-label={`Drag level ${index + 1}`} title="Drag to reorder level" style={{ ...iconButtonStyle, cursor: 'grab', padding: 4, alignSelf: 'center' }}><GripVertical size={16} /></button>
              <div>
                <label style={labelStyle}>Level Name</label>
                <input required className="input-field" style={inputStyle} value={item.name} placeholder="Enter level name" onChange={e => updateStep(index, { name: e.target.value })} />
              </div>
              <div><label style={labelStyle}>Action</label><select className="input-field" value={item.kind} onChange={e => updateStep(index, { kind: e.target.value })}>{ACTIONS.map(action => <option key={action.value} value={action.value}>{action.label}</option>)}</select></div>
              {item.kind === 'email' ? <div><label style={labelStyle}>Template</label><div style={{ display: 'flex', gap: 5 }}><select className="input-field" style={{ minWidth: 0, flex: 1 }} value={item.emailTemplateId} onChange={e => updateStep(index, { emailTemplateId: e.target.value })}><option value="">Select template</option>{templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select><button type="button" style={iconButtonStyle} disabled={!item.emailTemplateId} onClick={async () => { const selected = templates.find(t => String(t.id) === String(item.emailTemplateId)); if (!selected) return; const full = await fetchApi(`/api/email-templates/${selected.id}`, { silent: true }).catch(() => null); setPreviewTemplate(full?.body !== undefined ? full : selected); }} aria-label={`Preview template for level ${index + 1}`} title="Preview email template"><Eye size={15} /></button></div></div> : item.kind === 'condition' ? <StepConditionEditor item={item} onChange={patch => updateStep(index, patch)} conditionFields={conditionFields} conditionValues={conditionValues} loadConditionValues={loadConditionValues} conditionMetadata={conditionMetadata} templates={templates} onPreviewTemplate={setPreviewTemplate} /> : <div><label style={{ ...labelStyle, visibility: 'hidden' }}>Template</label><div style={{ minHeight: 38 }} /></div>}
              {item.kind === 'email' || item.kind === 'wait' ? <div><label style={labelStyle}>{item.kind === 'email' ? 'When to Send' : 'Duration'}</label><div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 5 }}>{item.kind === 'email' && <select className="input-field" value={item.delayAmount > 0 ? 'after' : 'immediate'} onChange={e => updateStep(index, e.target.value === 'immediate' ? { delayAmount: 0, delayUnit: 'minutes' } : { delayAmount: item.delayAmount || 1 })}><option value="immediate">Immediate</option><option value="after">After</option></select>}<input type="number" min="0" className="input-field" value={item.delayAmount} onChange={e => updateStep(index, { delayAmount: e.target.value })} placeholder="Amount" /><select className="input-field" value={item.delayUnit || 'minutes'} onChange={e => updateStep(index, { delayUnit: e.target.value })}>{DELAY_UNITS.map(unit => <option key={unit.value} value={unit.value}>{unit.label}</option>)}</select></div></div> : <div />}
              <button type="button" onClick={() => update({ steps: steps.filter((_, i) => i !== index) })} style={{ ...iconButtonStyle, position: 'absolute', top: 8, right: 8 }} aria-label={`Delete level ${index + 1}`} title="Delete this level"><Trash2 size={15} /></button>
            </div>)}
            <button type="button" className="btn-secondary" style={{ alignSelf: 'flex-start' }} onClick={() => update({ steps: [...steps, emptyStep()] })}><Plus size={14} /> Add Level</button>
            {!steps.length && <p style={{ color: 'var(--text-secondary)' }}>No levels yet. Click Add Level to begin.</p>}
          </div>
          <style>{`.generic-sequence-steps > div:first-of-type { order: 2; } .generic-sequence-steps > div:nth-of-type(2) { order: 1; } .generic-sequence-steps > div:nth-of-type(n+3) { order: 3; } .generic-sequence-steps > div:nth-child(4), .generic-sequence-steps > div:nth-child(n+5) { display: none !important; } .generic-sequence-steps .input-field { min-width: 0; }`}</style>
          <div style={{ border: '1px solid var(--border-color)', borderRadius: 8, padding: 12, marginBottom: 12 }}>
            <strong>Send Window</strong>
            <div style={{ ...twoCol, marginTop: 10 }}>
              <Field label="Timezone"><select className="input-field" style={inputStyle} value={draft.timezone} onChange={e => update({ timezone: e.target.value })}>{['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'Europe/Paris', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney'].map(zone => <option key={zone} value={zone}>{zone}</option>)}</select></Field>
              <div style={twoCol}><Field label="Start time"><input type="time" className="input-field" style={inputStyle} value={`${String(Number(draft.startHour)).padStart(2, '0')}:00`} onChange={e => update({ startHour: Number(e.target.value.split(':')[0]) })} /></Field><Field label="End time"><input type="time" className="input-field" style={inputStyle} value={`${String(Number(draft.endHour)).padStart(2, '0')}:00`} onChange={e => update({ endHour: Number(e.target.value.split(':')[0]) })} /></Field></div>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, color: 'var(--text-primary)' }}>
              <input type="checkbox" checked={draft.businessDaysOnly} onChange={e => update({ businessDaysOnly: e.target.checked })} />
              Business days only (Monday–Friday)
            </label>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><h4 style={{ margin: 0 }}>Sequence Steps</h4><button type="button" className="btn-secondary" onClick={() => update({ steps: [...steps, emptyStep()] })}><Plus size={14} /> Add Step / Level</button></div>
          {steps.map((item, index) => <div key={item.id || index} style={{ border: '1px solid var(--border-color)', borderRadius: 8, padding: 12, marginTop: 12 }}><div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><strong>Level {index + 1}</strong><select className="input-field" style={{ flex: 1 }} value={item.kind} onChange={e => updateStep(index, { kind: e.target.value })}>{ACTIONS.map(action => <option key={action.value} value={action.value}>{action.label}</option>)}</select><button type="button" onClick={() => update({ steps: steps.filter((_, i) => i !== index) })} style={iconButtonStyle} aria-label={`Delete level ${index + 1}`} title="Delete this level"><Trash2 size={15} /></button></div>{item.kind === 'email' && <div style={twoCol}><Field label="Step Name"><input className="input-field" style={inputStyle} value={item.name} onChange={e => updateStep(index, { name: e.target.value })} /></Field><div><label style={labelStyle}>Email Template</label><div style={{ display: 'flex', gap: 6 }}><select className="input-field" style={{ ...inputStyle, flex: 1 }} value={item.emailTemplateId} onChange={e => updateStep(index, { emailTemplateId: e.target.value })}><option value="">Select template</option>{templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select><button type="button" className="btn-secondary" onClick={() => setTemplateEditor({ stepIndex: index, name: '', subject: '', body: '', category: 'General' })}><Plus size={14} /> Create</button></div></div><div><label style={labelStyle}>When to Send</label><div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}><select className="input-field" value={item.delayAmount > 0 ? 'after' : 'immediate'} onChange={e => updateStep(index, e.target.value === 'immediate' ? { delayAmount: 0, delayUnit: 'minutes' } : { delayAmount: item.delayAmount || 1 })}><option value="immediate">Immediately</option><option value="after">After</option></select><input type="number" min="0" className="input-field" disabled={!item.delayAmount && item.delayAmount !== 0} value={item.delayAmount} onChange={e => updateStep(index, { delayAmount: e.target.value })} placeholder="Amount" /><select className="input-field" value={item.delayUnit || 'minutes'} onChange={e => updateStep(index, { delayUnit: e.target.value })}>{DELAY_UNITS.map(unit => <option key={unit.value} value={unit.value}>{unit.label}</option>)}</select></div></div></div>}{item.kind === 'wait' && <div style={twoCol}><Field label="Wait duration"><input type="number" min="0" className="input-field" style={inputStyle} value={item.delayAmount} onChange={e => updateStep(index, { delayAmount: e.target.value })} /></Field><Field label="Unit"><select className="input-field" style={inputStyle} value={item.delayUnit || 'minutes'} onChange={e => updateStep(index, { delayUnit: e.target.value })}>{DELAY_UNITS.map(unit => <option key={unit.value} value={unit.value}>{unit.label}</option>)}</select></Field></div>}{item.kind === 'condition' && <StepConditionEditor item={item} onChange={patch => updateStep(index, patch)} conditionFields={conditionFields} conditionValues={conditionValues} loadConditionValues={loadConditionValues} conditionMetadata={conditionMetadata} templates={templates} onPreviewTemplate={setPreviewTemplate} />}{item.kind === 'stop' && <p style={{ color: 'var(--text-secondary)', marginBottom: 0 }}>This level stops the contact’s automation.</p>}</div>)}
          {!steps.length && <p style={{ color: 'var(--text-secondary)' }}>No steps yet. Click Add Step / Level to begin.</p>}
        </section>}

        {step === 4 && <section>
          <h4 style={{ marginBottom: 10 }}>Review Campaign</h4>
          <div style={{ display: 'grid', gap: 5, fontSize: '0.82rem', marginBottom: 12 }}>
            <div><strong>Campaign:</strong> {draft.name || 'Not configured'}</div>
            <div><strong>Trigger:</strong> {draft.trigger.map(rule => `${rule.field || 'Not configured'} ${rule.op || ''} ${rule.value || ''}`).join(` ${draft.triggerLogic} `)}</div>
            <div><strong>Sequence:</strong> {draft.sequenceName || selectedSequence?.name || 'New sequence'}</div>
            <div><strong>Send window:</strong> {draft.timezone}, {String(Number(draft.startHour)).padStart(2, '0')}:00–{String(Number(draft.endHour)).padStart(2, '0')}{draft.businessDaysOnly ? ' · Business days only' : ''}</div>
          </div>
          {steps.length > 0 && <div style={{ border: '1px solid var(--border-color)', borderRadius: 8, padding: 10, marginBottom: 12, background: 'var(--modal-control-bg, #fff)' }}>
            <ol style={{ margin: 0, paddingLeft: 22, display: 'grid', gap: 7, fontSize: '0.8rem' }}>
              {steps.map((item, index) => <li key={item.id || index}>{ACTIONS.find(action => action.value === item.kind)?.label || item.kind}{item.kind === 'email' && ` — ${templates.find(t => t.id === Number(item.emailTemplateId))?.name || 'No template'}`}{item.kind === 'email' && ` — ${item.delayAmount > 0 ? `After ${item.delayAmount} ${item.delayUnit}` : 'Immediately'}`}{item.kind === 'wait' && ` — Wait ${item.delayAmount} ${item.delayUnit}`}{item.kind === 'condition' && conditionReviewSummary(item, templates)}</li>)}
            </ol>
          </div>}
        </section>}

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '1rem', borderTop: '1px solid var(--border-color)', paddingTop: '0.75rem' }}><button type="button" className="btn-secondary" disabled={step === 0} onClick={() => setStep(value => value - 1)}><ArrowLeft size={14} /> Back</button><div style={{ display: 'flex', gap: 8 }}><button type="button" className="btn-secondary" onClick={() => save(false)} disabled={saving}><Save size={14} /> Save Draft</button>{step < STEPS.length - 1 ? <button type="button" className="btn-primary" onClick={() => goToStep(step + 1)}>Next <ArrowRight size={14} /></button> : <button type="button" className="btn-primary" onClick={() => save(true)} disabled={saving}>Activate Campaign</button>}</div></div>
      </div>
      {previewTemplate && <div style={modalBackdropStyle} onClick={() => setPreviewTemplate(null)}><div role="dialog" aria-label="Preview email template" className="card modal" onClick={event => event.stopPropagation()} style={{ ...modalStyle, width: 680 }}><div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}><h3 style={{ margin: 0, flex: 1 }}>{previewTemplate.name || 'Email Template Preview'}</h3><button type="button" onClick={() => setPreviewTemplate(null)} aria-label="Close preview" style={iconButtonStyle}><X size={18} /></button></div><div style={{ display: 'grid', gap: 8, fontSize: '0.82rem' }}><div><strong>Subject:</strong> {previewTemplate.subject || 'No subject'}</div><iframe title="Email template body" sandbox="" srcDoc={previewTemplate.body || '<em>No template body</em>'} style={{ border: '1px solid var(--border-color)', borderRadius: 8, width: '100%', minHeight: 220, background: 'var(--modal-control-bg, #fff)' }} /></div><div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}><button type="button" className="btn-secondary" onClick={() => setPreviewTemplate(null)}>Close</button></div></div></div>}
      {templateEditor && <div style={modalBackdropStyle} onClick={() => setTemplateEditor(null)}><div role="dialog" aria-label="Create email template" className="card modal" onClick={event => event.stopPropagation()} style={{ ...modalStyle, width: 620 }}><h3 style={{ marginTop: 0 }}>Create Email Template</h3><Field label="Template Name"><input className="input-field" style={inputStyle} value={templateEditor.name} onChange={e => setTemplateEditor({ ...templateEditor, name: e.target.value })} /></Field><Field label="Subject"><input className="input-field" style={inputStyle} value={templateEditor.subject} onChange={e => setTemplateEditor({ ...templateEditor, subject: e.target.value })} /></Field><Field label="Body (HTML)"><textarea className="input-field" style={inputStyle} rows={9} value={templateEditor.body} onChange={e => setTemplateEditor({ ...templateEditor, body: e.target.value })} /></Field><Field label="Category"><input className="input-field" style={inputStyle} value={templateEditor.category} onChange={e => setTemplateEditor({ ...templateEditor, category: e.target.value })} /></Field><div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><button type="button" className="btn-secondary" onClick={() => setTemplateEditor(null)}>Cancel</button><button type="button" className="btn-primary" onClick={createTemplate}>Create Template</button></div></div></div>}
    </div>
  );
}

function Field({ label, children }) { return <div style={{ marginBottom: '1rem' }}><label style={labelStyle}>{label}</label>{children}</div>; }
const twoCol = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' };
const pageShellStyle = { position: 'relative', width: '100%', height: '100%', maxHeight: '100%', overflow: 'hidden', background: 'var(--bg-color, #f0f2f5)', color: 'var(--text-primary, #172033)', padding: '2rem', boxSizing: 'border-box' };
const pageContentStyle = { width: '100%', maxWidth: '1440px', height: '100%', maxHeight: '100%', minHeight: 0, margin: '0 auto', padding: '1.75rem 2rem', boxSizing: 'border-box', overflowY: 'auto', background: 'var(--card-bg, #ffffff)', border: '1px solid color-mix(in srgb, var(--border-color, #d9dee8) 72%, transparent)', borderRadius: 16, boxShadow: '0 10px 26px rgba(15, 23, 42, 0.12)' };
const modalBackdropStyle = { position: 'fixed', inset: 0, background: 'var(--modal-backdrop, rgba(15, 23, 42, 0.75))', backdropFilter: 'blur(5px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '0.75rem' };
const modalStyle = { padding: '1.25rem', width: '560px', maxWidth: '95vw', background: 'var(--modal-body-bg, #eef1f5)', color: 'var(--text-primary, #172033)', border: '1px solid var(--modal-border, #d7dee9)', boxShadow: 'var(--shadow-lg, 0 20px 45px rgba(0,0,0,0.28))' };
const iconButtonStyle = { background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' };
const progressStyle = { border: '1px solid var(--modal-border, #d7dee9)', background: 'var(--modal-muted-bg, #e7edf5)', color: 'var(--text-secondary)', borderRadius: 999, padding: '0.4rem 0.7rem', cursor: 'pointer' };
const activeProgressStyle = { background: 'var(--primary-color, var(--accent-color))', color: '#fff', borderColor: 'var(--primary-color, var(--accent-color))' };
