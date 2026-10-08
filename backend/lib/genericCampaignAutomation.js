const prisma = require("./prisma");

function parseFilters(value) {
  if (!value) return null;
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch (_error) {
    return null;
  }
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
      if (normalise(rule.value) === "new" && isCreated && contact.status === "Lead") return "new";
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
  const expectedValue = normalise(expected);
  const hasValue = actualValues.some(value => value !== "");

  switch (rule.op) {
    case "eq": return actualValues.some(value => value === expectedValue);
    case "neq": return actualValues.every(value => value !== expectedValue);
    case "contains": return actualValues.some(value => value.includes(expectedValue));
    case "notContains": return actualValues.every(value => !value.includes(expectedValue));
    case "gt": return actualValues.some(value => Number(value) > Number(expected));
    case "gte": return actualValues.some(value => Number(value) >= Number(expected));
    case "lt": return actualValues.some(value => Number(value) < Number(expected));
    case "lte": return actualValues.some(value => Number(value) <= Number(expected));
    case "empty": return !hasValue;
    case "notEmpty": return hasValue;
    default: return false;
  }
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
    if (existing) continue;

    await prisma.sequenceEnrollment.create({
      data: { sequenceId: sequence.id, contactId, status: "Active", tenantId },
      include: {
        contact: { include: { customerPickups: { orderBy: { updatedAt: "desc" }, take: 1 } } },
        sequence: { include: { tenant: { select: { vertical: true } }, campaigns: { select: { id: true, status: true, scheduleFilters: true, sequenceId: true } }, steps: { include: { emailTemplate: true }, orderBy: { position: "asc" } } } },
      },
    });
    enrolled++;

    // Queue only. The next cron tick applies activation/business-hour checks
    // and claims the enrollment lock before ANY delivery, including step 0.
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
      tagsJson: true, industry: true, companySize: true, linkedin: true,
      website: true, facebookUrl: true, githubUrl: true, twitterUrl: true,
      firstTouchSource: true, lastTouchSource: true, birthDate: true,
      anniversary: true, gst: true, stateCode: true, billingStateCode: true,
      externalId: true, aiScore: true,
    },
  });
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

  if (eventName === 'pickup_point.created' || eventName === 'pickup_point.updated') {
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

module.exports = { processContactCreated, matchesCampaign, hydrateGenericEventPayload, normalizeGenericTemplatePlaceholders };
