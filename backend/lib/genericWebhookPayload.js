const prisma = require("./prisma");

const CONTACT_WEBHOOK_FIELDS = [
  "name", "email", "phone", "whatsappPhone", "company", "aiScore", "source",
  "medium", "assignedToId", "createdAt", "callifiedCampaignId",
  "callifiedLeadStatus", "status", "title", "website", "linkedin", "industry",
  "companySize", "subBrand", "note", "stateCode", "updatedAt",
  "firstTouchSource", "lastTouchSource", "treatmentOfInterest", "birthDate",
  "anniversary", "gst", "billingStateCode",
];

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch (_error) { return fallback; }
}

function splitName(value) {
  const parts = String(value || "").trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] || null, lastName: parts.slice(1).join(" ") || null };
}

function parseTags(value) {
  const parsed = parseJson(value, null);
  if (Array.isArray(parsed)) return parsed;
  return value ? String(value).split(",").map((tag) => tag.trim()).filter(Boolean) : [];
}

function customFieldValue(definition, value) {
  if (!value) return null;
  if (definition.fieldType === "number") return value.valueNumber;
  if (definition.fieldType === "date") return value.valueDate;
  if (definition.fieldType === "checkbox") return value.valueBool;
  if (definition.fieldType === "multiselect") return parseJson(value.valueText, value.valueText);
  return value.valueText;
}

function qualityScore(notes) {
  const parsed = parseJson(notes, null);
  const visit = (value) => {
    if (!value || typeof value !== "object") return null;
    if (Number.isFinite(Number(value.quality_score))) return Math.round(Number(value.quality_score));
    for (const child of Object.values(value)) {
      const found = visit(child);
      if (found != null) return found;
    }
    return null;
  };
  return visit(parsed);
}

async function safely(run, fallback = null) {
  try { return await run(); } catch (_error) { return fallback; }
}

/**
 * Hydrate a Generic CRM contact event for a configured workflow webhook.
 *
 * Workflow events intentionally carry a small snapshot. The webhook field
 * picker, however, mirrors the much richer Generic Leads table. Resolve the
 * current tenant-scoped record here, immediately before delivery, so choosing
 * a built-in or tenant-defined field actually sends its stored value. Other
 * actions and non-generic tenants continue to receive the original payload.
 */
async function hydrateGenericWebhookPayload(payload, tenantId) {
  const contactId = Number(payload?.contactId);
  if (!Number.isInteger(contactId) || contactId < 1) return payload;

  const tenant = await safely(() => prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { vertical: true },
  }));
  if (tenant?.vertical !== "generic") return payload;

  const select = Object.fromEntries(["id", "tagsJson", ...CONTACT_WEBHOOK_FIELDS].map((field) => [field, true]));
  const contact = await safely(() => prisma.contact.findFirst({
    where: { id: contactId, tenantId, deletedAt: null },
    select,
  }));
  if (!contact) return payload;

  const [submission, touchpoint, definitions, values, callLogs, pickup, booking] = await Promise.all([
    safely(() => prisma.webFormSubmission.findFirst({
      where: { contactId, tenantId, scope: "generic" },
      orderBy: [{ submittedAt: "desc" }, { id: "desc" }],
      select: { payloadJson: true, sourceUrl: true, submittedAt: true, webForm: { select: { id: true, name: true } } },
    })),
    safely(() => prisma.touchpoint.findFirst({
      where: { contactId, tenantId },
      orderBy: [{ timestamp: "desc" }, { id: "desc" }],
      select: { source: true, medium: true, utmCampaign: true, utmTerm: true, utmContent: true, url: true, landingPage: true, timestamp: true },
    })),
    safely(() => prisma.leadCustomFieldDefinition.findMany({ where: { tenantId }, select: { id: true, fieldKey: true, fieldType: true } }), []),
    safely(() => prisma.leadCustomFieldValue.findMany({ where: { tenantId, contactId }, select: { fieldId: true, valueText: true, valueNumber: true, valueDate: true, valueBool: true } }), []),
    safely(() => prisma.callLog.findMany({
      where: { tenantId, contactId, provider: "callified" },
      orderBy: { createdAt: "desc" },
      select: { notes: true },
    }), []),
    safely(() => prisma.customerPickup.findFirst({ where: { tenantId, contactId }, select: { pickupAddress: true } })),
    safely(() => prisma.plotBooking.findFirst({
      where: { tenantId, contactId },
      orderBy: { updatedAt: "desc" },
      select: { plotSiteId: true, status: true, paymentStatus: true },
    })),
  ]);

  const storedPayload = parseJson(submission?.payloadJson, {});
  const tracking = storedPayload?._meta?.tracking || {};
  const byFieldId = new Map((values || []).map((value) => [value.fieldId, value]));
  const customFields = Object.fromEntries((definitions || []).map((definition) => [
    definition.fieldKey,
    customFieldValue(definition, byFieldId.get(definition.id)),
  ]));
  const names = splitName(contact.name);
  const latestScore = (callLogs || []).map((log) => qualityScore(log.notes)).find((score) => score != null) ?? null;
  const formName = submission?.webForm?.name || null;

  const hydrated = {
    // Start with the raw form/tracking snapshot, then let the current Contact
    // row and canonical derived values win. A lead may have been edited after
    // its last form submission; the callback must receive the current CRM
    // value rather than a stale submitted name, phone, source, or status.
    ...Object.fromEntries(Object.entries(tracking).filter(([, value]) => value != null && value !== "")),
    ...Object.fromEntries(Object.entries(storedPayload).filter(([key, value]) => key !== "_meta" && value != null)),
    ...Object.fromEntries(CONTACT_WEBHOOK_FIELDS.map((field) => [field, contact[field]])),
    contactId: contact.id,
    tags: parseTags(contact.tagsJson),
    ...names,
    webForm: formName,
    formName,
    webFormId: submission?.webForm?.id || null,
    location: tracking.location || storedPayload.location || null,
    pickupLocation: pickup?.pickupAddress || null,
    plotAssign: booking?.plotSiteId || null,
    overallPickupStatus: booking?.status || booking?.paymentStatus || null,
    pageUrl: tracking.pageUrl || touchpoint?.url || submission?.sourceUrl || null,
    pageTitle: tracking.pageTitle || null,
    pageSource: tracking.pageSource || null,
    referrerUrl: tracking.referrerUrl || tracking.referrer || submission?.sourceUrl || null,
    landingPageUrl: tracking.landingPageUrl || tracking.landing_page || touchpoint?.landingPage || null,
    currentDomain: tracking.currentDomain || null,
    utm_source: tracking.utm_source || touchpoint?.source || null,
    utm_medium: tracking.utm_medium || touchpoint?.medium || null,
    utm_campaign: tracking.utm_campaign || touchpoint?.utmCampaign || null,
    utm_id: tracking.utm_id || storedPayload.utm_id || null,
    utm_term: tracking.utm_term || touchpoint?.utmTerm || null,
    utm_content: tracking.utm_content || touchpoint?.utmContent || null,
    submittedAt: submission?.submittedAt || touchpoint?.timestamp || null,
    browser: tracking.browser || null,
    operatingSystem: tracking.operatingSystem || null,
    deviceType: tracking.deviceType || null,
    callifiedAi: callLogs?.length || 0,
    callifiedScore: latestScore,
    ...customFields,
  };

  // Preserve event-only values (previous, changedFields, etc.), while the
  // database snapshot wins for fields represented by the picker.
  return { ...payload, ...hydrated };
}

module.exports = { hydrateGenericWebhookPayload };
