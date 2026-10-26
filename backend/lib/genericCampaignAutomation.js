const prisma = require("./prisma");
const { createSelectionLink } = require("./genericPickupPlotSelection");

function parseFilters(value) {
  if (!value) return null;
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function dueBeforeMinutes(value) {
  const amount = Number(value?.amount);
  const multiplier = { minutes: 1, hours: 60, days: 1440 }[value?.unit];
  return Number.isFinite(amount) && amount > 0 && multiplier ? Math.round(amount * multiplier) : null;
}

function matchesDueBefore(config, emittedMinutes) {
  const configured = dueBeforeMinutes(config);
  if (configured == null) return emittedMinutes == null;
  return configured === Number(emittedMinutes);
}

function normalise(value) {
  if (Array.isArray(value)) return value.map(normalise);
  if (value == null) return "";
  return String(value).trim().toLowerCase();
}

function configuredDelayMinutes(item) {
  const amount = Number(item?.delayAmount ?? item?.delayMinutes ?? 0);
  const multipliers = { minutes: 1, hours: 60, days: 1440 };
  return Math.max(0, Math.round(amount * (multipliers[item?.delayUnit] || 1)));
}

function resolveRuleValue(rule, contact, isCreated) {
  switch (rule.field) {
    case "contact.status":
      // Generic CRM stores a newly created lead as status "Lead". Treat the
      // user-facing "New" value as the creation state for compatibility with
      // campaigns already configured in the wizard.
      if ((Array.isArray(normalise(rule.value)) ? normalise(rule.value).includes("new") : normalise(rule.value) === "new") && isCreated && contact.status === "Lead") return "new";
      return contact.status;
    case "contact.stage": return contact.stage;
    case "contact.source": return contact.source;
    case "contact.owner": return contact.assignedToId;
    case "contact.aiScore": return contact.aiScore;
    case "contact.tag": return contact.tags || contact.tagsJson;
    case "contact.created": return isCreated;
    case "contact.field": return contact[rule.key] ?? contact[rule.value];
    case "email.activity": return contact.__emailActivity?.[rule.value] || contact.__emailActivity?.[rule.key];
    case "external.event": return contact.__externalEvent?.name || contact.__externalEvent?.type;
    default:
      if (typeof rule.field === "string" && rule.field.startsWith("contact.")) {
        return contact[rule.field.slice("contact.".length)];
      }
      return undefined;
  }
}

function matchesRule(rule, contact, isCreated) {
  if (!rule?.field || !rule?.op) return false;
  const actual = resolveRuleValue(rule, contact, isCreated);
  const expected = rule.value;
  const actualValues = Array.isArray(actual) ? actual.map(normalise) : [normalise(actual)];
  const expectedValues = (Array.isArray(expected) ? expected : [expected]).map(normalise);
  const hasValue = actualValues.some(value => value !== "");

  switch (rule.op) {
    case "eq": return actualValues.some(value => expectedValues.includes(value));
    case "neq": return actualValues.every(value => !expectedValues.includes(value));
    case "contains": return actualValues.some(value => expectedValues.some(expectedValue => value.includes(expectedValue)));
    case "notContains": return actualValues.every(value => expectedValues.every(expectedValue => !value.includes(expectedValue)));
    case "gt": return actualValues.some(value => expectedValues.some(expectedValue => Number(value) > Number(expectedValue)));
    case "gte": return actualValues.some(value => expectedValues.some(expectedValue => Number(value) >= Number(expectedValue)));
    case "lt": return actualValues.some(value => expectedValues.some(expectedValue => Number(value) < Number(expectedValue)));
    case "lte": return actualValues.some(value => expectedValues.some(expectedValue => Number(value) <= Number(expectedValue)));
    case "empty": return !hasValue;
    case "notEmpty": return hasValue;
    default: return false;
  }
}

function matchesEventConditions(filters, contact, eventName) {
  const conditions = Array.isArray(filters?.conditions) ? filters.conditions.filter(Boolean) : [];
  if (!conditions.length) return true;
  const results = conditions.map(rule => matchesRule(rule, contact, eventName === "contact.created"));
  return filters.conditionLogic === "OR" ? results.some(Boolean) : results.every(Boolean);
}

function flowPredecessor(campaign, campaigns) {
  const filters = parseFilters(campaign.scheduleFilters);
  if (!filters?.flowId || !Number.isFinite(Number(filters.ruleOrder))) return null;
  const order = Number(filters.ruleOrder);
  return campaigns
    .filter(candidate => {
      if (candidate.id === campaign.id || candidate.channel !== campaign.channel) return false;
      const candidateFilters = parseFilters(candidate.scheduleFilters);
      return candidateFilters?.flowId === filters.flowId && Number(candidateFilters.ruleOrder) < order;
    })
    .sort((left, right) => Number(parseFilters(right.scheduleFilters)?.ruleOrder || 0) - Number(parseFilters(left.scheduleFilters)?.ruleOrder || 0))[0] || null;
}

function orderCampaignRules(campaigns) {
  return [...campaigns].sort((left, right) => {
    const leftFilters = parseFilters(left.scheduleFilters);
    const rightFilters = parseFilters(right.scheduleFilters);
    if (leftFilters?.flowId && leftFilters.flowId === rightFilters?.flowId) {
      return Number(leftFilters.ruleOrder || 0) - Number(rightFilters.ruleOrder || 0);
    }
    return 0;
  });
}

function matchesCampaign(campaign, contact) {
  const filters = parseFilters(campaign.scheduleFilters);
  const rules = Array.isArray(filters?.trigger) ? filters.trigger.filter(Boolean) : [];
  if (!rules.length) return false;
  const isCreated = true;
  const results = rules.map(rule => matchesRule(rule, contact, isCreated));
  return filters.triggerLogic === "OR" ? results.some(Boolean) : results.every(Boolean);
}

async function syncConfiguredCampaignSteps(campaign) {
  const filters = parseFilters(campaign.scheduleFilters);
  const configuredSteps = Array.isArray(filters?.steps) ? filters.steps : [];
  if (!campaign.sequence || !configuredSteps.length) return campaign.sequence;

  // The Generic campaign wizard keeps a backward-compatible copy of its
  // step configuration in scheduleFilters. Materialize any missing rows so
  // campaigns saved by an older frontend still execute every configured level.
  for (const [position, item] of configuredSteps.entries()) {
    await prisma.sequenceStep.upsert({
      where: { sequenceId_position: { sequenceId: campaign.sequence.id, position } },
      update: {
        kind: item.kind || "email",
        name: item.name || null,
        emailTemplateId: item.emailTemplateId ? Number(item.emailTemplateId) : null,
        delayMinutes: configuredDelayMinutes(item),
        conditionJson: item.conditionJson || null,
        trueNextPosition: item.trueNextPosition === "" || item.trueNextPosition == null ? null : Number(item.trueNextPosition),
        falseNextPosition: item.falseNextPosition === "" || item.falseNextPosition == null ? null : Number(item.falseNextPosition),
      },
      create: {
        sequenceId: campaign.sequence.id,
        position,
        kind: item.kind || "email",
        name: item.name || null,
        emailTemplateId: item.emailTemplateId ? Number(item.emailTemplateId) : null,
        delayMinutes: configuredDelayMinutes(item),
        conditionJson: item.conditionJson || null,
        trueNextPosition: item.trueNextPosition === "" || item.trueNextPosition == null ? null : Number(item.trueNextPosition),
        falseNextPosition: item.falseNextPosition === "" || item.falseNextPosition == null ? null : Number(item.falseNextPosition),
      },
    });
  }

  return prisma.sequence.findUnique({
    where: { id: campaign.sequence.id },
    include: { steps: { include: { emailTemplate: true }, orderBy: { position: "asc" } } },
  });
}

async function processContactCreated(contactId, tenantId) {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { vertical: true } });
  if (tenant?.vertical !== "generic") return { enrolled: 0, skipped: "non_generic" };

  const contact = await prisma.contact.findFirst({ where: { id: contactId, tenantId } });
  if (!contact) return { enrolled: 0, skipped: "contact_not_found" };

  // Generic custom-field definitions and values are tenant-scoped. Attach
  // them under their stable custom_<definitionId> keys so campaigns keep
  // working when an admin changes the display label without changing the
  // field definition itself. This is deliberately inside the Generic path;
  // Travel and Wellness never execute this helper.
  const customValues = await prisma.leadCustomFieldValue.findMany({
    where: { contactId, tenantId },
    select: { fieldId: true, valueText: true, valueNumber: true, valueDate: true, valueBool: true },
  }).catch(() => []);
  for (const value of customValues) {
    contact[`custom_${value.fieldId}`] = value.valueText ?? value.valueNumber ?? value.valueDate ?? value.valueBool;
  }

  const campaigns = await prisma.campaign.findMany({
    where: { tenantId, status: "Active", channel: "EMAIL", sequenceId: { not: null } },
    include: { sequence: { include: { steps: { include: { emailTemplate: true }, orderBy: { position: "asc" } } } } },
  });

  let enrolled = 0;
  for (const campaign of campaigns) {
    const filters = parseFilters(campaign.scheduleFilters);
    if (!filters || filters.enrollmentMode === "manual") continue;
    if (!campaign.sequence || !matchesCampaign(campaign, contact)) continue;

    let sequence;
    try {
      sequence = await syncConfiguredCampaignSteps(campaign);
    } catch (error) {
      console.error(`[GenericCampaign] Could not sync configured steps for campaign ${campaign.id}:`, error.message);
      sequence = campaign.sequence;
    }

    const existing = await prisma.sequenceEnrollment.findFirst({
      where: { sequenceId: sequence.id, contactId, tenantId },
    });
    // Campaigns are ordered newest mapping first. Never fall through to an
    // older duplicate when the winning mapping already handled this event.
    if (existing) break;

    await prisma.sequenceEnrollment.create({
      data: { sequenceId: sequence.id, contactId, status: "Active", tenantId },
      include: {
        contact: { include: { customerPickups: { orderBy: { updatedAt: "desc" }, take: 1 } } },
        sequence: { include: { tenant: { select: { vertical: true } }, campaigns: { select: { id: true, status: true, scheduleFilters: true, sequenceId: true } }, steps: { include: { emailTemplate: true }, orderBy: { position: "asc" } } } },
      },
    });
    enrolled++;
    break;

    // Queue only. The next cron tick applies activation/business-hour checks
    // and claims the enrollment lock before ANY delivery, including step 0.
  }
  return { enrolled };
}

// Generic Email/SMS trigger mappings are persisted as ordinary Campaign +
// Sequence rows, so deliveries use the existing sequence engine (including
// its provider, retries, and message logging) instead of bypassing it.
async function createEventEnrollment(data) {
  try {
    await prisma.sequenceEnrollment.create({ data: { ...data, automationEventKey: `${data.tenantId}:${data.currentNode}` } });
    return true;
  } catch (error) {
    if (error.code === 'P2002' && String(error.meta?.target || '').includes('automationEventKey')) return false;
    throw error;
  }
}

async function processGenericChannelCampaignEvent(eventName, payload = {}, tenantId) {
  if (![
    'contact.created',
    'contact.assigned',
    'contact.status_changed',
    'appointment.scheduled',
    'appointment.reminder_due',
    'payment.due',
    'whatsapp.customer_replied',
    'custom.trigger',
    'pickup_plot.selection_requested',
    'pickup_point.assigned',
    'contact.updated',
    'pickup_plot.selected',
    'payment.collected',
    'plot.confirmed',
  ].includes(eventName)) return { enrolled: 0, skipped: 'unsupported_event' };
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { vertical: true } });
  if (tenant?.vertical !== 'generic') return { enrolled: 0, skipped: 'non_generic' };

  const hydrated = await hydrateGenericEventPayload(eventName, payload, tenantId);
  if (eventName === 'payment.collected' && hydrated.payment?.status !== 'SUCCESS') return { enrolled: 0, skipped: 'payment_not_successful' };
  const contact = hydrated.contact;
  if (!contact?.id) return { enrolled: 0, skipped: 'contact_not_found' };

  const campaigns = await prisma.campaign.findMany({
    where: { tenantId, status: 'Active', channel: { in: ['EMAIL', 'SMS'] }, sequenceId: { not: null } },
    include: { sequence: { include: { steps: { orderBy: { position: 'asc' } } } } },
    orderBy: [{ scheduledAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
  });
  let enrolled = 0;
  const eventRecordId = genericCampaignEventRecordId(eventName, payload, hydrated, contact);
  if (!eventRecordId) return { enrolled: 0, skipped: 'invalid_event_id' };

  for (const campaign of orderCampaignRules(campaigns)) {
    const filters = parseFilters(campaign.scheduleFilters);
    if (filters?.automationType !== 'generic_channel_event' || filters.triggerEvent !== eventName || filters.channel !== campaign.channel) continue;
    if (eventName === 'payment.due' && !matchesDueBefore(filters.dueBefore, payload.dueBeforeMinutes)) continue;
    if (!matchesEventConditions(filters, contact, eventName)) continue;
    const sequence = campaign.sequence;
    if (!sequence?.isActive || !sequence.steps?.length) continue;
    if (campaign.channel === 'EMAIL' && !contact.email) continue;
    if (campaign.channel === 'SMS' && !contact.phone) continue;
    const firstStep = sequence.steps[0];
    if (!['email', 'sms', 'wait', 'condition'].includes(firstStep.kind)) continue;

    const predecessor = flowPredecessor(campaign, campaigns);
    if (predecessor?.sequenceId) {
      const previousEnrollment = await prisma.sequenceEnrollment.findFirst({
        where: { tenantId, contactId: contact.id, sequenceId: predecessor.sequenceId },
        select: { id: true },
      });
      if (!previousEnrollment) continue;
    }

    const eventKey = `campaign-event:${campaign.id}:${eventName}:${eventRecordId}`;
    const existing = await prisma.sequenceEnrollment.findFirst({
      where: { tenantId, sequenceId: sequence.id, contactId: contact.id, currentNode: eventKey },
      select: { id: true },
    });
    if (existing) continue;
    if (await createEventEnrollment({ tenantId, sequenceId: sequence.id, contactId: contact.id, currentNode: eventKey, currentStep: 0, status: 'Active', nextRun: new Date() })) enrolled++;
  }
  return { enrolled };
}

// Older Generic templates can contain the display labels that were shown in
// the original editor (for example, `[First Name]`) instead of the supported
// merge-tag syntax. Convert only recognised labels to the existing dynamic
// paths; arbitrary square-bracket text remains untouched.
const GENERIC_LEGACY_TEMPLATE_FIELDS = Object.freeze({
  "first name": "contact.first_name",
  "last name": "contact.last_name",
  "contact name": "contact.name",
  "contact company": "contact.company",
  "company": "contact.company",
  "job title": "contact.title",
  "contact email": "contact.email",
  "email": "contact.email",
  "contact phone": "contact.phone",
  "phone": "contact.phone",
  "your name": "contact.name",
  "your company": "contact.company",
  "your phone": "contact.phone",
});

function normalizeGenericTemplatePlaceholders(template) {
  if (template == null) return "";
  return String(template).replace(/\[([^\]]+)\]/g, (match, label) => {
    const path = GENERIC_LEGACY_TEMPLATE_FIELDS[String(label).trim().toLowerCase()];
    return path ? `{{${path}}}` : match;
  });
}

function genericContactContext(contact) {
  if (!contact) return null;
  const names = String(contact.name || '').trim().split(/\s+/).filter(Boolean);
  let tags = [];
  try { tags = contact.tagsJson ? JSON.parse(contact.tagsJson) : []; } catch (_error) { tags = []; }
  return {
    ...contact,
    first_name: names[0] || '',
    last_name: names.slice(1).join(' '),
    tags,
  };
}

async function loadGenericContact(tenantId, contactId) {
  const id = Number(contactId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const contact = await prisma.contact.findFirst({
    where: { id, tenantId, deletedAt: null },
    select: {
      id: true, name: true, email: true, phone: true, whatsappPhone: true,
      company: true, title: true, status: true, source: true, medium: true,
      interestedPlotArea: true,
      tagsJson: true, industry: true, companySize: true, linkedin: true,
      website: true, facebookUrl: true, githubUrl: true, twitterUrl: true,
      firstTouchSource: true, lastTouchSource: true, birthDate: true,
      anniversary: true, gst: true, stateCode: true, billingStateCode: true,
      externalId: true, aiScore: true,
    },
  });
  if (!contact) return null;
  const customValues = await prisma.leadCustomFieldValue.findMany({
    where: { contactId: id, tenantId },
    select: { fieldId: true, valueText: true, valueNumber: true, valueDate: true, valueBool: true },
  }).catch(() => []);
  for (const value of customValues) {
    contact[`custom_${value.fieldId}`] = value.valueText ?? value.valueNumber ?? value.valueDate ?? value.valueBool;
  }
  return genericContactContext(contact);
}

function withGenericContact(payload, contact) {
  if (!contact) return payload;
  return {
    ...payload,
    contact,
    contact_name: contact.name || '',
    name: contact.name || '',
    email: contact.email || '',
    phone: contact.phone || '',
    company: contact.company || '',
  };
}

async function hydrateGenericEventPayload(eventName, payload = {}, tenantId) {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { vertical: true } });
  if (tenant?.vertical !== 'generic') return payload;

  let next = { ...payload };
  let contactId = Number(payload.contactId);

  if (eventName === 'pickup_point.created' || eventName === 'pickup_point.updated' || eventName === 'pickup_point.assigned') {
    const pickupId = Number(payload.pickupPointId || payload.pickupId);
    if (Number.isInteger(pickupId) && pickupId > 0) {
      const pickup = await prisma.customerPickup.findFirst({
        where: { id: pickupId, tenantId },
        select: {
          id: true, contactId: true, pickupAddress: true, sourceTranscriptId: true,
          sourceExcerpt: true, capturedByUserId: true, createdAt: true, updatedAt: true,
        },
      });
      if (pickup) {
        contactId = pickup.contactId;
        next.pickup = { ...pickup, address: pickup.pickupAddress, location: pickup.pickupAddress };
        next.pickup_point = next.pickup;
        next.pickupPointId = pickup.id;
      }
    }
  }

  if (eventName === 'pickup_plot.selected' || eventName === 'plot.confirmed') {
    const bookingId = Number(payload.bookingId);
    if (Number.isInteger(bookingId) && bookingId > 0) {
      const booking = await prisma.plotBooking.findFirst({ where: { id: bookingId, tenantId } });
      if (booking) {
        contactId = booking.contactId || contactId;
        next.booking = booking;
      }
    }
    const pickupId = Number(payload.pickupPointId || next.booking?.customerPickupId);
    const pickup = Number.isInteger(pickupId) && pickupId > 0
      ? await prisma.customerPickup.findFirst({ where: { id: pickupId, tenantId } })
      : (Number.isInteger(contactId) && contactId > 0
        ? await prisma.customerPickup.findFirst({ where: { contactId, tenantId }, orderBy: { updatedAt: 'desc' } })
        : null);
    if (pickup) {
      contactId = pickup.contactId || contactId;
      next.pickup = { ...pickup, address: pickup.pickupAddress, location: pickup.pickupAddress };
      next.pickup_point = next.pickup;
    }
    const plotSiteId = Number(payload.plotSiteId || next.booking?.plotSiteId);
    if (Number.isInteger(plotSiteId) && plotSiteId > 0) {
      const plot = await prisma.plotSite.findFirst({ where: { id: plotSiteId, tenantId } });
      if (plot) next.plot = plot;
    }
  }

  if (eventName === 'invoice.created' || eventName.startsWith('invoice.') || eventName.startsWith('payment.')) {
    const invoiceId = Number(payload.invoiceId);
    if (Number.isInteger(invoiceId) && invoiceId > 0) {
      const invoice = await prisma.invoice.findFirst({
        where: { id: invoiceId, tenantId },
        include: { contact: true, deal: true },
      });
      if (invoice) {
        contactId = invoice.contactId;
        next.invoice = { ...invoice, number: invoice.invoiceNum };
        if (invoice.deal) next.deal = invoice.deal;
        if (!payload.paymentId) next.payment = payload.payment || undefined;
      }
    }
    const paymentId = Number(payload.paymentId);
    if (Number.isInteger(paymentId) && paymentId > 0) {
      const payment = await prisma.payment.findFirst({ where: { id: paymentId, tenantId } });
      if (payment) {
        next.payment = payment;
        if (!contactId && payment.invoiceId) {
          const invoice = await prisma.invoice.findFirst({ where: { id: payment.invoiceId, tenantId }, select: { contactId: true } });
          contactId = invoice?.contactId;
        }
      }
    }
  }

  if (eventName === 'plot.visited' || eventName === 'task.completed') {
    const taskId = Number(payload.taskId);
    if (Number.isInteger(taskId) && taskId > 0) {
      const task = await prisma.task.findFirst({
        where: { id: taskId, tenantId },
        select: { id: true, title: true, notes: true, type: true, outcome: true, status: true, dueDate: true, contactId: true, userId: true, updatedAt: true },
      });
      if (task) {
        contactId = task.contactId;
        next.visit = {
          id: task.id,
          title: task.title,
          notes: task.notes,
          type: task.type,
          outcome: task.outcome,
          status: task.status,
          dueDate: task.dueDate,
          completedAt: task.updatedAt,
        };
      }
    }
  }

  if (Number.isInteger(contactId) && contactId > 0) {
    const contact = await loadGenericContact(tenantId, contactId);
    next = withGenericContact(next, contact);
  }
  return next;
}

function valueAtPath(context, path) {
  return String(path || "").split(".").reduce((value, key) => value?.[key], context);
}

function templateParameterValues(template, context) {
  const mapping = parseFilters(template.variableMapping) || {};
  const fallback = {
    1: "contact.first_name",
    2: "contact.company",
    3: "contact.email",
    4: "contact.phone",
    5: "organization.name",
  };
  const indexes = [...new Set([...String(template.body || "").matchAll(/\{\{(\d+)\}\}/g)].map(match => Number(match[1])))]
    .sort((left, right) => left - right);
  return indexes.map(index => {
    const value = valueAtPath(context, mapping[index] || fallback[index]);
    return { type: "text", text: value == null ? "" : String(value) };
  });
}

function renderWhatsAppTemplate(body, parameters) {
  const values = parameters.map(parameter => parameter.text);
  return String(body || "").replace(/\{\{(\d+)\}\}/g, (_match, index) => values[Number(index) - 1] ?? "");
}

async function queueWhatsAppSequenceTemplate({ templateId, enrollment, context = {}, stepId = null, branch = null }) {
  if (enrollment.sequence?.tenant?.vertical !== "generic") return { queued: false, reason: "non_generic" };
  const contact = enrollment.contact;
  const rawPhone = contact?.whatsappPhone || contact?.phone;
  const { normalizeGenericWhatsAppThreadPhone } = require("./phoneFormatting");
  const recipientPhone = normalizeGenericWhatsAppThreadPhone(rawPhone);
  if (!contact?.id || !recipientPhone) return { queued: false, reason: "contact_phone_missing" };

  const [config, optOut, template] = await Promise.all([
    prisma.whatsAppConfig.findFirst({ where: { tenantId: enrollment.tenantId, isActive: true }, select: { phoneNumberId: true } }),
    prisma.whatsAppOptOut.findUnique({ where: { tenantId_contactPhone: { tenantId: enrollment.tenantId, contactPhone: recipientPhone } }, select: { id: true } }),
    prisma.whatsAppTemplate.findFirst({
      where: { id: Number(templateId), tenantId: enrollment.tenantId, status: "APPROVED" },
      select: { id: true, name: true, body: true, variableMapping: true },
    }),
  ]);
  if (!config?.phoneNumberId) return { queued: false, reason: "whatsapp_not_configured" };
  if (optOut) return { queued: false, reason: "contact_opted_out" };
  if (!template) return { queued: false, reason: "template_unavailable" };

  const duplicateKey = `sequence:${enrollment.id}:step:${stepId ?? enrollment.currentStep}:${branch || "main"}`;
  const duplicate = await prisma.whatsAppMessage.findFirst({
    where: { tenantId: enrollment.tenantId, contactId: contact.id, interactiveJson: { contains: `"sequenceKey":"${duplicateKey}"` } },
    select: { id: true },
  });
  if (duplicate) return { queued: false, reason: "duplicate" };

  const tenant = enrollment.sequence.tenant;
  const templateContext = { ...context, contact, organization: tenant };
  const templateMapping = parseFilters(template.variableMapping) || {};
  const pickupPlotFlow = Object.values(templateMapping).includes("system.pickupPlotLink");
  if (pickupPlotFlow) {
    templateContext.system = {
      ...(templateContext.system || {}),
      pickupPlotLink: createSelectionLink({ tenantId: enrollment.tenantId, contactId: contact.id, submissionId: enrollment.id }),
    };
    templateContext.selectionLink = templateContext.system.pickupPlotLink;
    templateContext.form = { ...(templateContext.form || {}), name: "Generic CRM" };
  }
  const parameters = templateParameterValues(template, templateContext);
  const { upsertGenericWhatsAppThread } = require("./genericWebFormWhatsApp");
  const thread = await upsertGenericWhatsAppThread({
    tenantId: enrollment.tenantId,
    phone: recipientPhone,
    data: { contactName: contact.name, contactId: contact.id },
  });
  if (!thread) return { queued: false, reason: "thread_unavailable" };

  const renderedBody = renderWhatsAppTemplate(template.body, parameters);
  // Approved templates must remain template sends, including outside the
  // customer-service window. A local preview limit is not a transport limit.
  // Persist the message and DB-backed queue job together: a queue failure
  // must not leave a duplicate marker that prevents a later retry.
  const message = await prisma.$transaction(async (tx) => {
    const created = await tx.whatsAppMessage.create({
      data: {
        to: recipientPhone.replace(/\D/g, ""),
        from: config.phoneNumberId,
        body: renderedBody,
        direction: "OUTBOUND",
        status: "QUEUED",
        templateName: template.name,
        contactId: contact.id,
        tenantId: enrollment.tenantId,
        threadId: thread.id,
        interactiveJson: JSON.stringify({
          sequenceKey: duplicateKey,
          sequenceEnrollmentId: enrollment.id,
          sequenceId: enrollment.sequenceId,
          sequenceStepId: stepId,
          branch,
          messagePart: 1,
          messagePartCount: 1,
          sourceTemplateName: template.name,
          // Activates the inbound native-list flow only when this exact message
          // came from a sequence step using a pickup/plot template. Manual sends
          // and unrelated sequence templates never receive this marker.
          pickupPlotFlow,
          parameters,
        }),
      },
    });
    await require("./whatsappQueue").getQueue().enqueueSend({ messageId: created.id, tenantId: enrollment.tenantId, db: tx });
    return created;
  });
  const campaign = (enrollment.sequence.campaigns || []).find(item => item.status === "Active" && item.channel === "WHATSAPP");
  if (campaign?.id) {
    await prisma.campaign.updateMany({
      where: { id: campaign.id, tenantId: enrollment.tenantId, sequenceId: enrollment.sequenceId, status: "Active" },
      data: { sent: { increment: 1 } },
    }).catch(() => {});
  }
  return { queued: true, messageId: message.id, messageIds: [message.id], threadId: thread.id };
}

function genericCampaignEventRecordId(eventName, payload, hydrated, contact) {
  const candidate = eventName === "payment.collected"
    ? payload.paymentId || hydrated.payment?.id
    : payload.eventId || payload.messageId || payload.invoiceId || payload.taskId || payload.bookingId || payload.pickupPointId || payload.contactId || contact?.id;
  const value = String(candidate || "").trim();
  return value && !value.includes(":") ? value : value.replaceAll(":", "-");
}

async function processWhatsAppCampaignEvent(eventName, payload = {}, tenantId) {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true, vertical: true } });
  if (tenant?.vertical !== "generic") return { queued: 0, skipped: "non_generic" };

  const hydrated = await hydrateGenericEventPayload(eventName, payload, tenantId);
  if (eventName === "payment.collected" && hydrated.payment?.status !== "SUCCESS") {
    return { queued: 0, skipped: "payment_not_successful" };
  }
  const contact = hydrated.contact;
  const rawPhone = contact?.whatsappPhone || contact?.phone;
  const { normalizeGenericWhatsAppThreadPhone } = require("./phoneFormatting");
  const recipientPhone = normalizeGenericWhatsAppThreadPhone(rawPhone);
  if (!contact || !recipientPhone) return { queued: 0, skipped: "contact_phone_missing" };

  const [config, optOut, campaigns] = await Promise.all([
    prisma.whatsAppConfig.findFirst({ where: { tenantId, isActive: true }, select: { phoneNumberId: true } }),
    prisma.whatsAppOptOut.findUnique({ where: { tenantId_contactPhone: { tenantId, contactPhone: recipientPhone } }, select: { id: true } }),
    prisma.campaign.findMany({
      // Older builder saves persisted trigger metadata through /schedule,
      // which changed otherwise-active event automations to Scheduled. Keep
      // those existing rows executable; Draft remains the paused state.
      where: { tenantId, status: { in: ["Active", "Scheduled"] }, channel: "WHATSAPP" },
      include: { sequence: { include: { steps: { orderBy: { position: "asc" } } } } },
      // Saving a mapping refreshes scheduledAt. Prefer that over createdAt so
      // editing an older duplicate still makes the operator's latest choice win.
      orderBy: [{ scheduledAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    }),
  ]);
  if (!config?.phoneNumberId) return { queued: 0, skipped: "whatsapp_not_configured" };
  if (optOut) return { queued: 0, skipped: "contact_opted_out" };

  let queued = 0;
  for (const campaign of orderCampaignRules(campaigns)) {
    const filters = parseFilters(campaign.scheduleFilters);
    if (filters?.automationType !== "whatsapp_event" || filters.eventTrigger !== eventName) continue;
    if (eventName === "payment.due" && !matchesDueBefore(filters.dueBefore, payload.dueBeforeMinutes)) continue;
    if (!matchesEventConditions(filters, contact, eventName)) continue;
    if (campaign.sequenceId && campaign.sequence?.isActive && campaign.sequence.steps?.length) {
      const firstStep = campaign.sequence.steps[0];
      if (!["whatsapp", "wait", "condition"].includes(firstStep.kind)) continue;
      const eventRecordId = genericCampaignEventRecordId(eventName, payload, hydrated, contact);
      if (!eventRecordId) continue;
      const eventKey = `campaign-event:${campaign.id}:${eventName}:${eventRecordId}`;
      const existing = await prisma.sequenceEnrollment.findFirst({
        where: { tenantId, sequenceId: campaign.sequenceId, contactId: contact.id, currentNode: eventKey },
        select: { id: true },
      });
      if (existing) continue;
      if (await createEventEnrollment({ tenantId, sequenceId: campaign.sequenceId, contactId: contact.id, currentNode: eventKey, currentStep: 0, status: "Active", nextRun: new Date() })) queued++;
      break;
    }

    const templateId = Number(filters.whatsappTemplateId);
    if (!Number.isInteger(templateId) || templateId <= 0) continue;

    const template = await prisma.whatsAppTemplate.findFirst({
      where: { id: templateId, tenantId, status: "APPROVED" },
      select: { id: true, name: true, body: true, variableMapping: true },
    });
    if (!template) continue;

    const predecessor = flowPredecessor(campaign, campaigns);
    if (predecessor) {
      const previousMessage = await prisma.whatsAppMessage.findFirst({
        where: { tenantId, contactId: contact.id, interactiveJson: { contains: `"campaignId":${predecessor.id}` } },
        select: { id: true },
      });
      if (!previousMessage) continue;
    }

    const eventRecordId = genericCampaignEventRecordId(eventName, payload, hydrated, contact);
    if (!eventRecordId) continue;
    const automationKey = `${campaign.id}:${eventName}:${eventRecordId}`;
    const duplicate = await prisma.whatsAppMessage.findFirst({
      where: { tenantId, contactId: contact.id, interactiveJson: { contains: `"automationKey":"${automationKey}"` } },
      select: { id: true },
    });
    if (duplicate) continue;

    const templateMapping = parseFilters(template.variableMapping) || {};
    const needsPickupPlotLink = eventName === "pickup_plot.selection_requested"
      || Object.values(templateMapping).includes("system.pickupPlotLink");
    const pickupPlotLink = needsPickupPlotLink
      ? createSelectionLink({ tenantId, contactId: contact.id, submissionId: payload.eventId || null })
      : null;
    const context = {
      ...hydrated,
      contact,
      organization: tenant,
      ...(pickupPlotLink ? {
        system: { pickupPlotLink },
        selectionLink: pickupPlotLink,
        form: { name: "Generic CRM" },
      } : {}),
    };
    const parameters = templateParameterValues(template, context);
    const { upsertGenericWhatsAppThread } = require("./genericWebFormWhatsApp");
    const thread = await upsertGenericWhatsAppThread({
      tenantId,
      phone: recipientPhone,
      data: { contactName: contact.name, contactId: contact.id },
    });
    if (!thread) continue;

    const message = await prisma.whatsAppMessage.create({
      data: {
        to: recipientPhone.replace(/\D/g, ""),
        from: config.phoneNumberId,
        body: renderWhatsAppTemplate(template.body, parameters),
        direction: "OUTBOUND",
        status: "QUEUED",
        templateName: template.name,
        contactId: contact.id,
        tenantId,
        threadId: thread.id,
        interactiveJson: JSON.stringify({ automationKey, campaignId: campaign.id, eventName, eventRecordId, parameters }),
      },
    });
    await require("./whatsappQueue").getQueue().enqueueSend({ messageId: message.id, tenantId });
    await prisma.campaign.update({ where: { id: campaign.id }, data: { sent: { increment: 1 } } });
    queued++;
    // A trigger maps to exactly one template. Older duplicate Campaign rows
    // can exist from earlier UI saves; the newest active mapping wins.
    break;
  }
  return { queued };
}

module.exports = {
  processContactCreated,
  processGenericChannelCampaignEvent,
  processWhatsAppCampaignEvent,
  matchesCampaign,
  hydrateGenericEventPayload,
  normalizeGenericTemplatePlaceholders,
  templateParameterValues,
  matchesEventConditions,
  queueWhatsAppSequenceTemplate,
};
