import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, Check, Clock3, GitBranch, List, Mail, MessageSquareText, Plus, Save, ShieldCheck, Square, Trash2, Zap } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { GENERIC_WHATSAPP_SEQUENCE_TRIGGERS as TRIGGERS } from '../utils/genericSequenceTriggers';
import { useNotify } from '../utils/notify';
import MultiSelectDropdown from './MultiSelectDropdown';
import { genericConditionFields } from '../utils/genericSequenceConditions';
import GenericSequenceTemplateActions from './GenericSequenceTemplateActions';

function metadataFor(campaign) {
  try { return JSON.parse(campaign?.scheduleFilters || '{}') || {}; } catch { return {}; }
}

function makeId(prefix = 'step') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sendStep(templateId = '') {
  return { id: makeId('send'), type: 'send', templateId: String(templateId || '') };
}

function nextStep(type) {
  if (type === 'wait') return { id: makeId(type), type, amount: 1, unit: 'days' };
  if (type === 'reply') return { id: makeId(type), type, repliedTemplateId: '', noReplyTemplateId: '' };
  if (type === 'field') return { id: makeId(type), type, field: 'contact.lifecycleStageKey', key: '', op: 'eq', value: '', matchedTemplateId: '', unmatchedTemplateId: '' };
  if (type === 'stop') return { id: makeId(type), type };
  return sendStep();
}

function presetSteps(trigger, firstTemplateId = '') {
  if (trigger === 'contact.status_changed') return [nextStep('field')];
  return [sendStep(firstTemplateId)];
}

function normaliseStoredStep(step) {
  return step && typeof step === 'object' ? { ...step, id: step.id || makeId(step.type || 'step') } : sendStep();
}

function delayMinutes(step) {
  return Math.max(0, Math.round(Number(step.amount || 0) * ({ minutes: 1, hours: 60, days: 1440 }[step.unit] || 1)));
}

function actionFor(channel, templateId, branch) {
  return channel === 'SMS'
    ? { type: 'send_sms', smsTemplateId: Number(templateId), branch }
    : { type: 'send_email', emailTemplateId: Number(templateId), branch };
}

function sequenceStepPayload(step, channel, templateById) {
  if (step.type === 'send') {
    const template = templateById.get(String(step.templateId));
    return channel === 'SMS'
      ? {
          kind: 'sms',
          name: template?.name || 'Send SMS',
          // SequenceStep uses the shared EmailTemplate relation for both
          // EMAIL and SMS channel templates. Keep smsBody as a snapshot so
          // legacy rows and deleted templates still have a safe fallback,
          // while the engine resolves the selected SMS template at send time.
          emailTemplateId: Number(step.templateId),
          smsBody: template?.body || '',
          delayMinutes: 0,
        }
      : { kind: 'email', name: template?.name || 'Send Email', emailTemplateId: Number(step.templateId), delayMinutes: 0 };
  }
  if (step.type === 'wait') return { kind: 'wait', name: `Wait ${step.amount} ${step.unit}`, delayMinutes: delayMinutes(step) };
  if (step.type === 'reply') return {
    kind: 'condition', name: `Check ${channel === 'SMS' ? 'SMS' : 'email'} reply`, pauseOnReply: false,
    conditionJson: JSON.stringify({
      version: 2, logic: 'ALL', conditions: [{ type: channel === 'SMS' ? 'sms_activity' : 'email_activity', event: 'replied' }],
      yesAction: actionFor(channel, step.repliedTemplateId, 'replied'),
      noAction: actionFor(channel, step.noReplyTemplateId, 'no_reply'),
    }),
  };
  if (step.type === 'field') return {
    kind: 'condition', name: 'Check CRM column', pauseOnReply: false,
    conditionJson: JSON.stringify({
      version: 2, logic: 'ALL', conditions: [{ type: 'crm_field', field: step.field, key: step.key || undefined, op: step.op, value: step.value }],
      yesAction: actionFor(channel, step.matchedTemplateId, 'matched'),
      noAction: actionFor(channel, step.unmatchedTemplateId, 'unmatched'),
    }),
  };
  return { kind: 'stop', name: 'Stop sequence' };
}

function templateIdsForSteps(steps) {
  const ids = new Set();
  for (const step of steps) {
    for (const key of ['templateId', 'repliedTemplateId', 'noReplyTemplateId', 'matchedTemplateId', 'unmatchedTemplateId']) {
      if (step[key]) ids.add(String(step[key]));
    }
  }
  return [...ids];
}

function completeStep(step) {
  if (step.type === 'send') return Boolean(step.templateId);
  if (step.type === 'wait') return Number(step.amount) > 0;
  if (step.type === 'reply') return Boolean(step.repliedTemplateId && step.noReplyTemplateId);
  if (step.type === 'field') return Boolean(step.field && step.op && String(step.value || '').trim() && step.matchedTemplateId && step.unmatchedTemplateId);
  return step.type === 'stop';
}

function visibleStepNumber(steps, index) {
  const visibleBeforeOrAt = steps
    .slice(0, index + 1)
    .filter(step => step.type !== 'wait').length;
  return visibleBeforeOrAt + (steps[index]?.type === 'wait' ? 1 : 0);
}

function commitPendingDraftSteps(currentSteps, draftSteps, addTypes) {
  let committed = [...currentSteps];
  for (const [parentId, draftStep] of Object.entries(draftSteps)) {
    const parentIndex = committed.findIndex(step => step.id === parentId);
    if (parentIndex === -1 || !draftStep) continue;
    const type = addTypes[parentId] || 'send';
    const { precedingWait, ...selectedStep } = draftStep;
    const addedStep = { ...selectedStep, id: makeId(type) };
    const parentUsesTemplate = ['send', 'reply', 'field'].includes(committed[parentIndex].type);
    const hasFollowingWait = committed[parentIndex + 1]?.type === 'wait';
    const wait = parentUsesTemplate && !hasFollowingWait
      ? { ...nextStep('wait'), ...(precedingWait || {}) }
      : null;
    const insertAt = parentUsesTemplate && hasFollowingWait ? parentIndex + 2 : parentIndex + 1;
    committed = [
      ...committed.slice(0, insertAt),
      ...(wait ? [wait] : []),
      addedStep,
      ...committed.slice(insertAt),
    ];
  }
  return committed;
}

function stepValidationMessage(step, stepNumber, channelLabel) {
  if (step.type === 'send' && !step.templateId) return `Select an ${channelLabel} template in Step ${stepNumber}.`;
  if (step.type === 'wait' && !(Number(step.amount) > 0)) return `Enter a wait duration greater than 0 in Step ${stepNumber}.`;
  if (step.type === 'reply') {
    if (!step.repliedTemplateId && !step.noReplyTemplateId) return `Select templates for both Reply outcomes in Step ${stepNumber}.`;
    if (!step.repliedTemplateId) return `Select the Replied template in Step ${stepNumber}.`;
    if (!step.noReplyTemplateId) return `Select the No reply template in Step ${stepNumber}.`;
  }
  if (step.type === 'field') {
    if (!step.field) return `Select a CRM column in Step ${stepNumber}.`;
    if (!String(step.value || '').trim()) return `Select a ${step.field === 'contact.lifecycleStageKey' ? 'Lead stage' : 'CRM value'} in Step ${stepNumber}.`;
    if (!step.matchedTemplateId && !step.unmatchedTemplateId) return `Select templates for both condition outcomes in Step ${stepNumber}.`;
    if (!step.matchedTemplateId) return `Select the Matched template in Step ${stepNumber}.`;
    if (!step.unmatchedTemplateId) return `Select the Not matched template in Step ${stepNumber}.`;
  }
  return `Complete Step ${stepNumber} before saving.`;
}

function nextStepHelp(type, channelLabel) {
  if (type === 'wait') return 'Pause each contact here, then continue to the following step.';
  if (type === 'reply') return `Check whether the contact replied by ${channelLabel.toLowerCase()}; add a Wait step before this to set the reply window.`;
  if (type === 'field') return 'Check a standard or custom CRM column and send the matching outcome.';
  if (type === 'stop') return 'End the automation for every contact that reaches this point.';
  return `Send another ${channelLabel} template, then continue to the following step.`;
}

function addStepButtonLabel(type) {
  if (type === 'wait') return 'Add wait';
  if (type === 'reply') return 'Add reply condition';
  if (type === 'field') return 'Add CRM column condition';
  return 'Add next step';
}

function waitSummary(wait) {
  if (!wait) return '';
  const amount = Number(wait.amount) || 1;
  const unit = amount === 1 ? String(wait.unit || 'days').replace(/s$/, '') : (wait.unit || 'days');
  return `wait ${amount} ${unit}, then `;
}

function addedStepMessage(type, channelLabel, wait) {
  const prefix = waitSummary(wait);
  if (type === 'reply') return `Next step added: ${prefix}check for a ${channelLabel.toLowerCase()} reply and send the matching response.`;
  if (type === 'field') return `Next step added: ${prefix}check a CRM column and send the matching response.`;
  if (type === 'stop') return 'Next step added: stop the sequence for contacts that reach this point.';
  return `Next step added: ${prefix}send the next ${channelLabel} message.`;
}

function removedStepMessage(type, channelLabel, removedWait) {
  const label = type === 'reply'
    ? `${channelLabel} reply condition`
    : type === 'field'
      ? 'CRM column condition'
      : type === 'stop'
        ? 'stop action'
        : `${channelLabel} message`;
  return `Step removed: ${label}${removedWait ? ' and its wait condition' : ''}.`;
}

export default function GenericChannelTriggerMappings({ channel, campaigns, editCampaignId = null, onEditLoaded, onSaved, onDirty, onViewSequences }) {
  const notify = useNotify();
  const isSms = channel === 'SMS';
  const channelLabel = isSms ? 'SMS' : 'Email';
  const ChannelIcon = isSms ? MessageSquareText : Mail;
  const [templates, setTemplates] = useState([]);
  const [customFields, setCustomFields] = useState([]);
  const [leadStatusOptions, setLeadStatusOptions] = useState([]);
  const [fieldValueOptions, setFieldValueOptions] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [trigger, setTrigger] = useState(TRIGGERS[0].value);
  const [steps, setSteps] = useState([sendStep()]);
  const [dueBefore, setDueBefore] = useState({ amount: 1, unit: 'days' });
  const [addTypes, setAddTypes] = useState({});
  const [openAddCards, setOpenAddCards] = useState({});
  const [draftSteps, setDraftSteps] = useState({});
  const [scrollTargetId, setScrollTargetId] = useState(null);
  const canvasRef = useRef(null);
  const stepRefs = useRef(new Map());
  const loadedValueFields = useRef(new Set());
  const conditionFields = useMemo(() => genericConditionFields(customFields, leadStatusOptions).map(field => ({
    ...field,
    options: field.value === 'contact.status' ? leadStatusOptions : (fieldValueOptions[field.value] ?? field.options ?? []),
  })), [customFields, fieldValueOptions, leadStatusOptions]);
  const loadFieldValues = useCallback(async fieldValue => {
    if (!fieldValue || fieldValue === 'contact.status' || loadedValueFields.current.has(fieldValue)) return;
    loadedValueFields.current.add(fieldValue);
    const rawField = fieldValue.startsWith('contact.') ? fieldValue.slice('contact.'.length) : fieldValue;
    const response = await fetchApi(`/api/contacts/filter-values/${encodeURIComponent(rawField)}`, { silent: true }).catch(() => ({ values: [] }));
    setFieldValueOptions(current => ({ ...current, [fieldValue]: Array.isArray(response) ? response : (response?.values || []) }));
  }, []);

  useEffect(() => {
    setTrigger(TRIGGERS[0].value);
    setSteps([sendStep()]);
    setDueBefore({ amount: 1, unit: 'days' });
    setAddTypes({});
    setOpenAddCards({});
    setDraftSteps({});
  }, [channel]);

  useEffect(() => {
    const refreshTemplates = event => {
      if (event.detail?.channel !== channel) return;
      fetchApi(`/api/email-templates?fields=summary&channel=${channel}`, { silent: true })
        .then(rows => setTemplates(Array.isArray(rows) ? rows : []))
        .catch(() => {});
    };
    window.addEventListener('generic-template-created', refreshTemplates);
    return () => window.removeEventListener('generic-template-created', refreshTemplates);
  }, [channel]);

  useEffect(() => {
    let alive = true;
    Promise.all([
      fetchApi(`/api/email-templates?fields=summary&channel=${channel}`, { silent: true }).catch(() => []),
      fetchApi('/api/lead-custom-fields', { silent: true }).catch(() => []),
      fetchApi('/api/marketing/generic-condition-metadata', { silent: true }).catch(() => ({ statusOptions: [] })),
    ]).then(([rows, fields, metadata]) => {
      if (!alive) return;
      setTemplates(Array.isArray(rows) ? rows : []);
      setCustomFields(Array.isArray(fields) ? fields : (Array.isArray(fields?.data) ? fields.data : []));
      setLeadStatusOptions(Array.isArray(metadata?.statusOptions) ? metadata.statusOptions : []);
    }).finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [channel]);

  useEffect(() => {
    if (!editCampaignId) return;
    const campaign = (campaigns || []).find(item => Number(item.id) === Number(editCampaignId));
    const metadata = metadataFor(campaign);
    if (!campaign || metadata.automationType !== 'generic_channel_event' || metadata.channel !== channel || !metadata.triggerEvent) {
      notify.error(`The selected ${channelLabel.toLowerCase()} sequence configuration is unavailable`);
      onEditLoaded?.();
      return;
    }
    setTrigger(metadata.triggerEvent);
    setSteps(Array.isArray(metadata.steps) && metadata.steps.length ? metadata.steps.map(normaliseStoredStep) : [sendStep(metadata.templateId)]);
    setDueBefore(metadata.dueBefore && Number(metadata.dueBefore.amount) > 0 ? metadata.dueBefore : { amount: 1, unit: 'days' });
    setAddTypes({});
    setOpenAddCards({});
    setDraftSteps({});
    document.getElementById(`generic-${channel.toLowerCase()}-sequence-builder`)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    onEditLoaded?.();
  }, [campaigns, channel, channelLabel, editCampaignId, notify, onEditLoaded]);

  const updateStep = (stepId, patch) => {
    onDirty?.();
    setSteps(current => current.map(step => step.id === stepId ? { ...step, ...patch } : step));
  };
  const selectAddType = (stepId, type) => {
    onDirty?.();
    setOpenAddCards(current => ({ ...current, [stepId]: true }));
    setAddTypes(current => ({ ...current, [stepId]: type }));
    const stepIndex = steps.findIndex(step => step.id === stepId);
    const parentUsesTemplate = ['send', 'reply', 'field'].includes(steps[stepIndex]?.type);
    const needsWait = parentUsesTemplate && steps[stepIndex + 1]?.type !== 'wait';
    setDraftSteps(current => ({ ...current, [stepId]: { ...nextStep(type), precedingWait: needsWait ? { amount: 1, unit: 'days' } : null } }));
  };
  const updateDraftStep = (stepId, patch) => {
    onDirty?.();
    setDraftSteps(current => ({
      ...current,
      [stepId]: { ...current[stepId], ...patch },
    }));
  };
  const updateDraftWait = (stepId, patch) => {
    onDirty?.();
    setDraftSteps(current => ({
      ...current,
      [stepId]: { ...current[stepId], precedingWait: { ...current[stepId].precedingWait, ...patch } },
    }));
  };
  const insertAfter = index => {
    onDirty?.();
    const parentId = steps[index].id;
    const type = addTypes[parentId] || 'send';
    const draftStep = draftSteps[parentId];
    const { precedingWait, ...selectedStep } = draftStep || {};
    const addedStep = draftStep ? { ...selectedStep, id: makeId(type) } : nextStep(type);
    const parentUsesTemplate = ['send', 'reply', 'field'].includes(steps[index].type);
    const hasFollowingWait = steps[index + 1]?.type === 'wait';
    const wait = parentUsesTemplate && !hasFollowingWait ? { ...nextStep('wait'), ...(precedingWait || {}) } : null;
    const insertAt = parentUsesTemplate && hasFollowingWait ? index + 2 : index + 1;
    setSteps(current => [...current.slice(0, insertAt), ...(wait ? [wait] : []), addedStep, ...current.slice(insertAt)]);
    setAddTypes(current => {
      const updated = { ...current };
      delete updated[parentId];
      return updated;
    });
    setOpenAddCards(current => ({ ...current, [parentId]: false }));
    setDraftSteps(current => {
      const updated = { ...current };
      delete updated[parentId];
      return updated;
    });
    setScrollTargetId(addedStep.id);
    notify.success(addedStepMessage(type, channelLabel, wait));
  };
  useEffect(() => {
    if (!scrollTargetId) return;
    const node = stepRefs.current.get(scrollTargetId);
    const canvas = canvasRef.current;
    if (node && canvas) {
      canvas.scrollTo?.({
        top: canvas.scrollHeight,
        behavior: 'smooth',
      });
    }
    setScrollTargetId(null);
  }, [scrollTargetId, steps]);

  const save = async () => {
    let stepsToSave = steps;
    if (Object.keys(draftSteps).length > 0) {
      const pendingChoice = await notify.confirm({
        title: 'Save unfinished step?',
        message: 'You did not save this step. Do you want to add it to the sequence, or discard it and save the other steps?',
        confirmText: 'Save step',
        cancelText: 'Discard & save',
        confirmValue: 'save',
        cancelValue: 'discard',
        dismissValue: null,
        dismissible: true,
      });
      if (!pendingChoice) return;
      if (pendingChoice === 'save') {
        stepsToSave = commitPendingDraftSteps(steps, draftSteps, addTypes);
        setSteps(stepsToSave);
      }
      setDraftSteps({});
      setAddTypes({});
      setOpenAddCards({});
    }

    const validationMessages = stepsToSave
      .map((step, index) => completeStep(step) ? null : stepValidationMessage(
        step,
        visibleStepNumber(stepsToSave, index),
        channelLabel,
      ))
      .filter(Boolean);
    if (validationMessages.length) {
      notify.error(validationMessages.join(' '));
      return;
    }
    notify.info(`Saving ${stepsToSave.length} sequence step${stepsToSave.length === 1 ? '' : 's'} and activating the ${channelLabel} automation…`);
    setSaving(true);
    try {
      const selectedTrigger = TRIGGERS.find(item => item.value === trigger) || TRIGGERS[0];
      const loadedTemplates = await Promise.all(templateIdsForSteps(stepsToSave).map(id => fetchApi(`/api/email-templates/${id}`, { silent: true })));
      if (loadedTemplates.some(template => !template || template.channel !== channel)) throw new Error(`A selected ${channelLabel.toLowerCase()} template is unavailable`);
      const templateById = new Map(loadedTemplates.map(template => [String(template.id), template]));
      const exactCampaign = (campaigns || []).find(item => Number(item.id) === Number(editCampaignId));
      const visibleTriggerCampaign = (campaigns || []).find(item => item.channel === channel && metadataFor(item).triggerEvent === trigger);
      // Email cards are paginated, so the matching trigger may not be in the
      // current `campaigns` prop. Always ask the tenant-scoped API before
      // creating; selecting the same channel + trigger then updates that row.
      const matchingCampaigns = await fetchApi(
        `/api/marketing/campaigns?channel=${channel}&sequenceTrigger=${encodeURIComponent(trigger)}`,
        { silent: true },
      );
      const existing = visibleTriggerCampaign || (Array.isArray(matchingCampaigns) ? matchingCampaigns[0] : null) || exactCampaign;
      let sequenceId = existing?.sequenceId;
      const sequenceName = `${selectedTrigger.label} ${channelLabel}`;
      if (sequenceId) {
        await fetchApi(`/api/sequences/${sequenceId}`, { method: 'PATCH', body: JSON.stringify({ name: sequenceName, isActive: true }) });
        const oldSteps = await fetchApi(`/api/sequences/${sequenceId}/steps`, { silent: true }).catch(() => []);
        for (const oldStep of Array.isArray(oldSteps) ? oldSteps : []) await fetchApi(`/api/sequences/steps/${oldStep.id}`, { method: 'DELETE' });
      } else {
        const created = await fetchApi('/api/sequences', { method: 'POST', body: JSON.stringify({ name: sequenceName, nodes: [], edges: [], isActive: true }) });
        sequenceId = created.id;
      }
      for (const [position, step] of stepsToSave.entries()) {
        await fetchApi(`/api/sequences/${sequenceId}/steps`, { method: 'POST', body: JSON.stringify({ ...sequenceStepPayload(step, channel, templateById), position }) });
      }

      const campaignPayload = { name: sequenceName, channel, status: 'Active', sequenceId };
      let campaignId = existing?.id;
      if (campaignId) await fetchApi(`/api/marketing/campaigns/${campaignId}`, { method: 'PUT', body: JSON.stringify(campaignPayload) });
      else {
        const created = await fetchApi('/api/marketing/campaigns', { method: 'POST', body: JSON.stringify({ ...campaignPayload, budget: 0 }) });
        campaignId = created.id;
      }
      await fetchApi(`/api/marketing/campaigns/${campaignId}/schedule`, {
        method: 'POST',
        body: JSON.stringify({ scheduledAt: new Date(Date.now() + 365 * 86400000).toISOString(), filters: {
          automationType: 'generic_channel_event', channel, triggerEvent: trigger,
          templateId: Number(stepsToSave.find(step => step.type === 'send')?.templateId) || null,
          templateName: templateById.get(String(stepsToSave.find(step => step.type === 'send')?.templateId))?.name || '',
          ...(trigger === 'payment.due' ? { dueBefore } : {}),
          sequenceName, steps: stepsToSave.map(({ id: _id, ...step }) => step),
        } }),
      });
      await fetchApi(`/api/marketing/campaigns/${campaignId}`, { method: 'PUT', body: JSON.stringify({ status: 'Active', sequenceId }) });
      await fetchApi(`/api/sequences/${sequenceId}/toggle`, { method: 'PATCH', body: JSON.stringify({ isActive: true }) });
      notify.success(`${channelLabel} sequence ${existing ? 'updated' : 'saved'} and activated`);
      setTrigger(TRIGGERS[0].value);
      setSteps([sendStep()]);
      setDueBefore({ amount: 1, unit: 'days' });
      onSaved?.();
    } catch (error) {
      notify.error(error?.message || `Failed to save ${channelLabel.toLowerCase()} sequence`);
    } finally {
      setSaving(false);
    }
  };

  return <section id={`generic-${channel.toLowerCase()}-sequence-builder`} style={builderStyle}>
    <header style={toolbarStyle}>
      <div><h2 style={{ margin: 0, color: 'var(--text-primary)', fontSize: '1.15rem' }}>Build a {channelLabel} sequence</h2><p style={subtitleStyle}>Choose one starting event, then add messages, waits, or conditions.</p></div>
      <div style={toolbarActionsStyle}>
        <button type="button" className="btn-secondary" onClick={onViewSequences} style={viewSequencesButtonStyle}><List size={15} /> View sequences</button>
        <button type="button" onClick={save} disabled={saving || loading} style={saveButtonStyle}><Save size={15} /> {saving ? 'Saving…' : 'Save & activate'}</button>
      </div>
    </header>
    <div ref={canvasRef} role="region" aria-label={`${channelLabel} sequence steps`} style={canvasStyle}>
      {!loading && templates.length === 0 && <div style={emptyMessageStyle}>Create {isSms ? 'an SMS' : 'an email'} template before adding an automation action.</div>}
      <div style={flowListStyle}>
        <article style={automationBlockStyle} aria-label={`${channelLabel} sequence trigger`}>
          <div style={nodeHeadingStyle}><span style={stepBadgeStyle}><Zap size={13} /></span><span>WHEN · TRIGGER</span></div>
          <label style={fieldLabelStyle} htmlFor={`${channel}-sequence-trigger`}>Start this sequence when</label>
          <select id={`${channel}-sequence-trigger`} aria-label={`${channelLabel} sequence trigger`} className="input-field" value={trigger} onFocus={() => { if (!editCampaignId && trigger === 'contact.created' && steps.length === 1) { onDirty?.(); setSteps(presetSteps(trigger, steps[0].templateId)); } }} onChange={event => { const value = event.target.value; const selectedTrigger = TRIGGERS.find(item => item.value === value); onDirty?.(); setTrigger(value); setSteps(presetSteps(value)); setAddTypes({}); setOpenAddCards({}); setDraftSteps({}); notify.info(`Starting event updated: ${selectedTrigger?.label || value}. The sequence will begin when this happens.`); }} style={selectStyle}>{TRIGGERS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select>
        </article>
        {trigger === 'payment.due' && <>
          <div style={connectorStyle} aria-hidden="true"><ArrowDown size={17} /></div>
          <article style={automationBlockStyle} aria-label="Payment due timing condition">
            <div style={nodeHeadingStyle}><span style={amberBadgeStyle}><Clock3 size={13} /></span><span>CONDITION · BEFORE PAYMENT DUE</span></div>
            <p style={stepHelpStyle}>Choose how long before the invoice due time the first template should be sent.</p>
            <div style={twoColumnStyle}><label style={fieldLabelStyle}>Send before<input aria-label="Payment due reminder amount" className="input-field" type="number" min="1" value={dueBefore.amount} onChange={event => { onDirty?.(); setDueBefore(current => ({ ...current, amount: event.target.value })); }} style={{ marginTop: 6 }} /></label><label style={fieldLabelStyle}>Unit<select aria-label="Payment due reminder unit" className="input-field" value={dueBefore.unit} onChange={event => { onDirty?.(); setDueBefore(current => ({ ...current, unit: event.target.value })); }} style={{ ...selectStyle, marginTop: 6 }}><option value="minutes">Minutes</option><option value="hours">Hours</option><option value="days">Days</option></select></label></div>
          </article>
        </>}
        {steps.map((step, index) => {
          const nextStepValue = steps[index + 1];
          if (step.type === 'wait' && nextStepValue && ['send', 'reply', 'field'].includes(nextStepValue.type)) return null;
          const precedingWait = index > 0 && steps[index - 1]?.type === 'wait' ? steps[index - 1] : null;
          return <div key={step.id} ref={node => { if (node) stepRefs.current.set(step.id, node); else stepRefs.current.delete(step.id); }} style={stepWrapperStyle}>
          {index > 0 && step.type === 'send' && !precedingWait && <ComplianceGate channelLabel={channelLabel} />}
          <div style={connectorStyle} aria-hidden="true"><ArrowDown size={17} /></div>
          <article style={automationBlockStyle} aria-label={`${channelLabel} sequence step ${index + 1}`}>
            {index > 0 && <button type="button" aria-label={`Remove step ${index + 1}`} onClick={() => { onDirty?.(); setSteps(current => current.filter(item => item.id !== step.id && item.id !== precedingWait?.id)); notify.info(removedStepMessage(step.type, channelLabel, Boolean(precedingWait))); }} style={removeStyle}><Trash2 size={15} /></button>}
            {precedingWait && <div style={combinedWaitStyle}>
              <StepEditor step={precedingWait} index={index - 1} stepNumber={visibleStepNumber(steps, index)} sendNumber={0} templates={templates} fields={conditionFields} loadFieldValues={loadFieldValues} update={patch => updateStep(precedingWait.id, patch)} channel={channel} channelLabel={channelLabel} ChannelIcon={ChannelIcon} />
            </div>}
            {precedingWait && step.type === 'send' && <ComplianceGate channelLabel={channelLabel} embedded />}
            <StepEditor step={step} index={index} stepNumber={precedingWait ? null : visibleStepNumber(steps, index)} sendNumber={steps.slice(0, index + 1).filter(item => item.type === 'send').length} templates={templates} fields={conditionFields} loadFieldValues={loadFieldValues} update={patch => updateStep(step.id, patch)} channel={channel} channelLabel={channelLabel} ChannelIcon={ChannelIcon} lockLeadStage={trigger === 'contact.status_changed' && index === 0} />
          </article>
          {['send', 'reply', 'field'].includes(step.type) && <article style={openAddCards[step.id] ? previewBlockStyle : collapsedAddCardStyle} aria-label={openAddCards[step.id] ? `${channelLabel} selected condition preview` : undefined}>
            {!openAddCards[step.id] && <button type="button" aria-label={`Add step after step ${index + 1}`} title="Add step" onClick={() => selectAddType(step.id, 'send')} style={addStepButtonStyle}><Plus size={19} aria-hidden="true" /></button>}
            <div style={openAddCards[step.id] ? choiceHeaderStyle : visuallyHiddenContainerStyle}>
              <div style={choiceHeadingStyle}>Choose the next step</div>
              <select tabIndex={openAddCards[step.id] ? 0 : -1} aria-label={`Next step type after step ${index + 1}`} className={openAddCards[step.id] ? 'input-field' : undefined} value={addTypes[step.id] || ''} onChange={event => selectAddType(step.id, event.target.value)} style={openAddCards[step.id] ? choiceSelectStyle : visuallyHiddenSelectStyle}><option value="" disabled>Choose next step</option><option value="send">{channelLabel} message</option><option value="reply">Reply condition</option><option value="field">CRM column condition</option></select>
            </div>
          {draftSteps[step.id] && <>
            <button type="button" aria-label={addStepButtonLabel(addTypes[step.id] || 'send')} title={addStepButtonLabel(addTypes[step.id] || 'send')} onClick={() => insertAfter(index)} style={confirmButtonStyle}><Check size={18} aria-hidden="true" /></button>
            <span aria-live="polite" style={addStepHelpStyle}>{nextStepHelp(addTypes[step.id], channelLabel)}</span>
            {draftSteps[step.id].precedingWait && <div style={combinedWaitStyle}>
              <StepEditor step={{ id: `draft-wait-${step.id}`, type: 'wait', ...draftSteps[step.id].precedingWait }} index={index + 1} stepNumber={visibleStepNumber(steps, index) + 1} sendNumber={0} templates={templates} fields={conditionFields} loadFieldValues={loadFieldValues} update={patch => updateDraftWait(step.id, patch)} channel={channel} channelLabel={channelLabel} ChannelIcon={ChannelIcon} />
            </div>}
            <StepEditor step={draftSteps[step.id]} index={index + (draftSteps[step.id].precedingWait ? 2 : 1)} sendNumber={steps.slice(0, index + 1).filter(item => item.type === 'send').length + 1} templates={templates} fields={conditionFields} loadFieldValues={loadFieldValues} update={patch => updateDraftStep(step.id, patch)} channel={channel} channelLabel={channelLabel} ChannelIcon={ChannelIcon} />
          </>}
          </article>}
          {index === steps.length - 1 && !openAddCards[step.id] && <div role="status" style={lastStepStyle}>Last step · the sequence ends here when saved</div>}
        </div>})}
      </div>
    </div>
  </section>;
}

function ComplianceGate({ channelLabel, embedded = false }) {
  if (embedded) return <div style={embeddedComplianceStyle} aria-label={`${channelLabel} DND and opt-out check`}>
    <div style={{ ...nodeHeadingStyle, marginBottom: 4 }}><span style={complianceBadgeStyle}><ShieldCheck size={13} /></span><span>AUTOMATIC Â· DND + OPT-OUT CHECK</span></div>
    <p style={{ ...stepHelpStyle, margin: 0 }}>Stops this contact before the follow-up if they are marked DND, do-not-contact, or opted out.</p>
  </div>;
  return <>
    <div style={connectorStyle} aria-hidden="true"><ArrowDown size={17} /></div>
    <article style={complianceBlockStyle} aria-label={`${channelLabel} DND and opt-out check`}>
      <div style={{ ...nodeHeadingStyle, marginBottom: 4 }}><span style={complianceBadgeStyle}><ShieldCheck size={13} /></span><span>AUTOMATIC · DND + OPT-OUT CHECK</span></div>
      <p style={{ ...stepHelpStyle, margin: 0 }}>Stops this contact before the follow-up if they are marked DND, do-not-contact, or opted out.</p>
    </article>
  </>;
}

function TemplateSelect({ label, value, onChange, templates, ariaLabel, channel }) {
  return <div><label style={fieldLabelStyle}>{label}<select aria-label={ariaLabel || label} className="input-field" value={value} onChange={event => onChange(event.target.value)} style={{ ...selectStyle, marginTop: 6 }}><option value="">Select a template</option>{templates.map(template => <option key={template.id} value={template.id}>{template.name}</option>)}</select></label><GenericSequenceTemplateActions channel={channel} templateId={value} templates={templates} /></div>;
}

function StepEditor({ step, index, stepNumber = null, sendNumber, templates, fields, loadFieldValues, update, channel, channelLabel, ChannelIcon, lockLeadStage = false }) {
  if (step.type === 'send') return <><div style={nodeHeadingStyle}><span style={greenBadgeStyle}><ChannelIcon size={13} /></span><span>STEP {sendNumber} · SEND {channel}</span></div><p style={stepHelpStyle}>Choose the {channelLabel.toLowerCase()} template to send when a contact reaches this step.</p><TemplateSelect label="Choose a template" ariaLabel={`${channelLabel} template for step ${index + 1}`} value={step.templateId} onChange={templateId => update({ templateId })} templates={templates} channel={channel} /></>;
  if (step.type === 'wait') return <>{stepNumber && <div style={stepNumberStyle}>STEP {stepNumber}</div>}<div style={nodeHeadingStyle}><span style={amberBadgeStyle}><Clock3 size={13} /></span><span>CONDITION · WAIT</span></div><p style={stepHelpStyle}>Set how long each contact pauses before the sequence continues.</p><div style={twoColumnStyle}><label style={fieldLabelStyle}>Duration<input aria-label={`Wait duration step ${index + 1}`} className="input-field" type="number" min="1" value={step.amount} onChange={event => update({ amount: event.target.value })} style={{ marginTop: 6 }} /></label><label style={fieldLabelStyle}>Unit<select aria-label={`Wait unit step ${index + 1}`} className="input-field" value={step.unit} onChange={event => update({ unit: event.target.value })} style={{ ...selectStyle, marginTop: 6 }}><option value="minutes">Minutes</option><option value="hours">Hours</option><option value="days">Days</option></select></label></div></>;
  if (step.type === 'reply') return <>{stepNumber && <div style={stepNumberStyle}>STEP {stepNumber}</div>}<div style={nodeHeadingStyle}><span style={purpleBadgeStyle}><GitBranch size={13} /></span><span>CONDITION · CHECK REPLY</span></div><p style={stepHelpStyle}>Checks for a {channelLabel.toLowerCase()} reply. Put a Wait condition before this check to define how long the contact has to respond, then choose both outcome templates.</p><div style={branchGridStyle}><TemplateSelect label="If replied — send" value={step.repliedTemplateId} onChange={repliedTemplateId => update({ repliedTemplateId })} templates={templates} channel={channel} /><TemplateSelect label="If no reply — send" value={step.noReplyTemplateId} onChange={noReplyTemplateId => update({ noReplyTemplateId })} templates={templates} channel={channel} /></div></>;
  if (step.type === 'field') return <>{stepNumber && <div style={stepNumberStyle}>STEP {stepNumber}</div>}<div style={nodeHeadingStyle}><span style={purpleBadgeStyle}><GitBranch size={13} /></span><span>CONDITION · CHECK CRM COLUMN</span></div><p style={stepHelpStyle}>Choose the CRM column, comparison, and value, then choose the template for each outcome.</p><CrmFieldControls step={step} index={index} fields={fields} loadFieldValues={loadFieldValues} update={update} lockLeadStage={lockLeadStage} /><div style={branchGridStyle}><TemplateSelect label="If matched — send" value={step.matchedTemplateId} onChange={matchedTemplateId => update({ matchedTemplateId })} templates={templates} channel={channel} /><TemplateSelect label="If not matched — send" value={step.unmatchedTemplateId} onChange={unmatchedTemplateId => update({ unmatchedTemplateId })} templates={templates} channel={channel} /></div></>;
  return <><div style={nodeHeadingStyle}><span style={redBadgeStyle}><Square size={13} /></span><span>STEP {index + 1} · STOP SEQUENCE</span></div><p style={stepHelpStyle}>Contacts reaching this step exit the automation immediately. No additional configuration is required.</p></>;
}

function CrmFieldControls({ step, index, fields, loadFieldValues, update, lockLeadStage }) {
  const selectedValue = step.key || step.field;
  const selectedField = fields.find(field => field.value === selectedValue);
  const isLeadStatus = selectedValue === 'contact.status';
  const isLeadStage = selectedValue === 'contact.lifecycleStageKey';
  const selectedValues = Array.isArray(step.value) ? step.value : (step.value ? [step.value] : []);
  useEffect(() => { loadFieldValues(selectedValue); }, [loadFieldValues, selectedValue]);
  return <div style={conditionGridStyle}>
    <MultiSelectDropdown ariaLabel={`CRM column step ${index + 1}`} options={lockLeadStage ? fields.filter(field => field.value === 'contact.lifecycleStageKey') : fields} selected={selectedValue ? [selectedValue] : []} searchable={!lockLeadStage} disabled={lockLeadStage} singleSelect menuHeight={260} placeholder="Select CRM column" onChange={values => { const nextValue = values[0]; const selected = fields.find(field => field.value === nextValue); if (!selected) return; loadFieldValues(selected.value); update(selected.custom ? { field: 'contact.field', key: selected.value, op: 'eq', value: [] } : { field: selected.value, key: '', op: 'eq', value: [] }); }} />
    <select aria-label={`CRM operator step ${index + 1}`} className="input-field" value={step.op} onChange={event => update({ op: event.target.value })} style={selectStyle}><option value="eq">Equals</option><option value="neq">Does not equal</option>{!isLeadStatus && !isLeadStage && <><option value="contains">Contains</option><option value="notContains">Does not contain</option></>}</select>
    <MultiSelectDropdown ariaLabel={`CRM value step ${index + 1}`} options={selectedField?.options || []} selected={selectedValues} searchable menuHeight={260} placeholder={isLeadStage ? 'Select lead stage' : isLeadStatus ? 'Select lead status' : 'Select value'} onChange={values => update({ value: values })} />
  </div>;
}

const builderStyle = { marginBottom: '1.25rem' };
const toolbarStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', padding: '0 0 1rem', borderBottom: '1px solid var(--border-color)' };
const toolbarActionsStyle = { display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '0.65rem', flexWrap: 'wrap' };
const viewSequencesButtonStyle = { display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 42, whiteSpace: 'nowrap' };
const subtitleStyle = { margin: '0.35rem 0 0', color: 'var(--text-secondary)', fontSize: '0.78rem' };
const saveButtonStyle = { display: 'inline-flex', alignItems: 'center', gap: 8, padding: '0.62rem 0.9rem', border: 0, borderRadius: 8, background: 'var(--primary-color, var(--accent-color))', color: '#fff', font: 'inherit', fontSize: '0.82rem', fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' };
const canvasStyle = { position: 'relative', height: 'calc(100dvh - 300px)', minHeight: 390, maxHeight: 680, padding: '1.5rem 0', overflowX: 'hidden', overflowY: 'auto', overscrollBehaviorY: 'contain', scrollbarGutter: 'stable', boxSizing: 'border-box' };
const flowListStyle = { display: 'grid', justifyItems: 'center', gap: 0 };
const stepWrapperStyle = { display: 'grid', justifyItems: 'center', width: '100%' };
const automationBlockStyle = { position: 'relative', width: 'min(100%, 520px)', padding: '1rem', border: '1px solid var(--border-color)', borderLeft: '3px solid var(--primary-color, var(--accent-color))', borderRadius: 10, background: 'var(--surface-color)', boxShadow: '0 8px 24px rgba(15, 23, 42, 0.08)', boxSizing: 'border-box' };
const nodeHeadingStyle = { display: 'flex', alignItems: 'center', gap: 8, marginBottom: '0.8rem', color: 'var(--text-primary)', fontSize: '0.67rem', fontWeight: 700, letterSpacing: '0.08em' };
const stepNumberStyle = { marginBottom: '0.65rem', color: 'var(--primary-color, var(--accent-color))', fontSize: '0.72rem', fontWeight: 800, letterSpacing: '0.1em' };
const badgeBase = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 25, height: 25, borderRadius: 7 };
const stepBadgeStyle = { ...badgeBase, background: 'var(--accent-bg)', color: 'var(--primary-color, var(--accent-color))' };
const greenBadgeStyle = { ...badgeBase, background: 'rgba(16, 185, 129, 0.13)', color: '#059669' };
const amberBadgeStyle = { ...badgeBase, background: 'rgba(245, 158, 11, 0.13)', color: '#d97706' };
const purpleBadgeStyle = { ...badgeBase, background: 'rgba(124, 58, 237, 0.12)', color: '#7c3aed' };
const redBadgeStyle = { ...badgeBase, background: 'rgba(239, 68, 68, 0.12)', color: '#dc2626' };
const complianceBadgeStyle = { ...badgeBase, background: 'rgba(14, 116, 144, 0.12)', color: '#0e7490' };
const complianceBlockStyle = { ...automationBlockStyle, borderLeftColor: '#0e7490', background: 'var(--subtle-bg, var(--surface-color))' };
const previewBlockStyle = { ...automationBlockStyle, paddingRight: '3.5rem', borderStyle: 'dashed', boxShadow: 'none', marginTop: '1.25rem', marginBottom: '0.75rem' };
const combinedWaitStyle = { marginBottom: '1rem', paddingBottom: '1rem', borderBottom: '1px solid var(--border-color)' };
const embeddedComplianceStyle = { margin: '0 0 1rem', padding: '0.75rem', borderRadius: 8, background: 'rgba(14, 116, 144, 0.06)', border: '1px solid rgba(14, 116, 144, 0.18)' };
const fieldLabelStyle = { display: 'block', color: 'var(--text-secondary)', fontSize: '0.74rem' };
const selectStyle = { color: 'var(--text-primary)', background: 'var(--input-bg, var(--surface-color))', borderColor: 'var(--border-color)', minHeight: 42 };
const connectorStyle = { display: 'grid', placeItems: 'center', width: 30, height: 30, margin: '-1px 0', border: '1px solid var(--border-color)', borderRadius: '50%', background: 'var(--surface-color)', color: 'var(--text-secondary)', zIndex: 1 };
const removeStyle = { position: 'absolute', top: 10, right: 10, display: 'inline-flex', padding: 6, border: '1px solid var(--border-color)', borderRadius: 7, background: 'var(--surface-color)', color: 'var(--danger-color)', cursor: 'pointer' };
const collapsedAddCardStyle = { position: 'relative', display: 'grid', placeItems: 'center', margin: '0.75rem 0' };
const addStepButtonStyle = { display: 'inline-grid', placeItems: 'center', width: 36, height: 36, padding: 0, border: '1px solid var(--border-color)', borderRadius: '50%', background: 'var(--surface-color)', color: 'var(--primary-color, var(--accent-color))', cursor: 'pointer' };
const visuallyHiddenContainerStyle = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clipPath: 'inset(50%)' };
const visuallyHiddenSelectStyle = { position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap', border: 0 };
const choiceHeaderStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12, paddingRight: 38, flexWrap: 'wrap' };
const choiceHeadingStyle = { color: 'var(--text-primary)', fontSize: '0.75rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' };
const choiceSelectStyle = { ...selectStyle, width: 210, maxWidth: '100%' };
const addStepHelpStyle = { flexBasis: '100%', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.68rem' };
const lastStepStyle = { margin: '-0.15rem 0 0.9rem', color: 'var(--text-secondary)', fontSize: '0.7rem', textAlign: 'center' };
const confirmButtonStyle = { position: 'absolute', top: 12, right: 12, display: 'inline-grid', placeItems: 'center', width: 34, height: 34, padding: 0, border: '1px solid var(--border-color)', borderRadius: 8, background: 'var(--surface-color)', color: 'var(--primary-color, var(--accent-color))', cursor: 'pointer' };
const stepHelpStyle = { margin: '-0.25rem 0 0.75rem', color: 'var(--text-secondary)', fontSize: '0.7rem', lineHeight: 1.45 };
const twoColumnStyle = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 10 };
const branchGridStyle = { ...twoColumnStyle, marginTop: 10 };
const conditionGridStyle = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 0.8fr) minmax(0, 1fr)', gap: 8 };
const emptyMessageStyle = { maxWidth: 520, margin: '0 auto 1rem', padding: '0.8rem', border: '1px solid var(--warn-border)', borderRadius: 8, color: 'var(--text-primary)', background: 'var(--warn-bg)', fontSize: '0.78rem' };
