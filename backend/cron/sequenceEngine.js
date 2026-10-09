/**
 * Sequence (drip) engine.
 *
 * Two execution paths coexist:
 *
 *   1. NEW step-list path (#9 rebuild).
 *      Sequence.steps populated with explicit SequenceStep rows referencing
 *      real EmailTemplate rows (for kind='email'), an SMS body (kind='sms'),
 *      a delay in minutes (kind='wait') or a condition clause-list
 *      (kind='condition'). Cursor is enrollment.currentStep (0-based int).
 *
 *   2. LEGACY ReactFlow JSON canvas path.
 *      Sequence.nodes / Sequence.edges are JSON. Cursor is
 *      enrollment.currentNode (string node id). Synthesises a generic email
 *      ("Automated Sequence: <label>") — kept untouched as a fallback so
 *      pre-rebuild sequences keep running.
 *
 * Reply detection (#7):
 *   processInboundReplies() runs on every tick. Scans EmailMessage rows
 *   where direction='INBOUND' AND threadId LIKE 'seq-%' AND
 *   sequenceReplyHandled IS NULL. For each match, parses the enrollmentId
 *   from the threadId, looks up the enrollment, and — if it is Active and
 *   the step it is parked on has pauseOnReply=true — flips status='Paused'
 *   and clears nextRun. Idempotent via the sequenceReplyHandled timestamp.
 */
const crypto = require('crypto');
const cronRegistry = require('../lib/cronRegistry');
const prisma = require('../lib/prisma');
const { getSetting, KEYS } = require('../lib/tenantSettings');
const { evaluateCondition, renderTemplate } = require('../lib/eventBus');
const { normalizeGenericTemplatePlaceholders } = require('../lib/genericCampaignAutomation');
const { renderGenericTemplate } = require('../lib/genericEmailTemplateRenderer');
const flyerRenderEngine = require('../services/flyerRenderEngine');
const shortUrlService = require('../services/shortUrl');
const { sendEmail } = require('../lib/emailSender');
const { writeAudit } = require('../lib/audit');
const { resolveSendGridConfig } = require('../services/travelSendGrid');

// S19 (PRD_TRAVEL_MARKETING_FLYER FR-3.5 / AC-6.5) — render-on-send for
// SequenceStep.attachmentRefsJson entries with kind='flyer'.
//
// Two thin wrappers below (`renderFlyerSafe` + `writeAuditSafe`) exist so
// that unit tests can swap them via the CJS self-mocking-seam pattern
// (CLAUDE.md cron-learnings 2026-05-24 ~01:43 UTC) — inter-function calls
// MUST go through `module.exports.fn(...)` not the local closure binding,
// or `vi.spyOn(engine, 'fn')` cannot intercept them.
function renderFlyerSafe(args) {
  return flyerRenderEngine.renderFlyer(args);
}
function writeAuditSafe(...args) {
  return writeAudit(...args).catch((err) => {
    console.warn(`[sequenceEngine] audit failed: ${err.message}`);
  });
}
// S87 — same CJS self-mocking-seam pattern as renderFlyerSafe. SMS branch
// calls `module.exports.shortenUrlSafe(...)` so tests can reassign it to
// a vi.fn() spy that returns canned short URLs without booting the real
// shortener. Real-mode swap happens in services/shortUrl.js once the
// provider decision lands (Bitly / Cloudflare / internal).
function shortenUrlSafe(args) {
  return shortUrlService.shortenUrl(args);
}

// ── SendGrid (best-effort) ─────────────────────────────────────────────
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || 'noreply@crm.globusdemos.com';

async function resolveSequenceTravelProvider(tenantId) {
  let tenant = null;
  try {
    tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { vertical: true },
    });
  } catch (_error) {
    return null;
  }
  return String(tenant?.vertical || '').toLowerCase() === 'travel'
    ? resolveSendGridConfig(tenantId)
    : null;
}

function sequenceSenderIdentity(provider) {
  if (!provider) return FROM_EMAIL;
  return provider.fromName ? `${provider.fromName} <${provider.fromEmail}>` : provider.fromEmail;
}

async function trySendGridSend(to, subject, body, attachments, provider = null) {
  const apiKey = provider?.apiKey || SENDGRID_API_KEY;
  if (!apiKey || !to) return { sent: false, reason: 'no_api_key_or_to' };
  try {
    const htmlBody = String(body).replace(/\n/g, '<br>');
    const payload = {
      personalizations: [{ to: [{ email: to }] }],
      from: {
        email: provider?.fromEmail || FROM_EMAIL,
        ...(provider?.fromName ? { name: provider.fromName } : {}),
      },
      subject: subject,
      content: [
        { type: 'text/plain', value: body },
        { type: 'text/html', value: htmlBody }
      ]
    };
    // S19 — SendGrid v3 MIME attachments use base64-encoded `content`
    // strings. Only flyer-rendered buffers can be transformed locally;
    // kind='file' refs are URL-only and would need a separate upstream
    // fetch — skipped here, the URL stays in the body if the operator
    // wired one into the template.
    if (Array.isArray(attachments) && attachments.length > 0) {
      const sgAttachments = [];
      for (const att of attachments) {
        if (att && att.kind === 'flyer' && Buffer.isBuffer(att.buffer)) {
          sgAttachments.push({
            content: att.buffer.toString('base64'),
            type: att.mimeType || 'application/octet-stream',
            filename: att.filename || 'attachment',
            disposition: 'attachment',
          });
        }
      }
      if (sgAttachments.length > 0) {
        payload.attachments = sgAttachments;
      }
    }
    const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
    });
    if (response.ok) {
      const messageId = response.headers.get('x-message-id') || 'sent';
      return { sent: true, id: messageId };
    }
    return { sent: false, reason: `sendgrid_${response.status}` };
  } catch (err) {
    return { sent: false, reason: err.message };
  }
}

// Build the variable bag passed to renderTemplate / evaluateCondition.
// Supports `{{contact.name}}`, `{{contact.email}}`, plus a flat fallback
// (renderTemplate already does last-segment fallback when a path doesn't
// resolve nested).
function buildContextForEnrollment(enrollment) {
  const c = enrollment.contact || {};
  const isGeneric = enrollment.sequence?.tenant?.vertical === 'generic';
  const names = String(c.name || '').trim().split(/\s+/).filter(Boolean);
  const customFields = (c.leadCustomFieldValues || []).map(value => ({
    key: value.field?.fieldKey,
    label: value.field?.label,
    value: value.valueText ?? value.valueNumber ?? value.valueDate ?? value.valueBool ?? '',
  })).filter(value => value.key);
  const custom = Object.fromEntries(customFields.map(value => [value.key, value.value]));
  let tags = [];
  try { tags = c.tagsJson ? JSON.parse(c.tagsJson) : []; } catch (_error) { tags = []; }
  const contact = {
    id: c.id,
    name: c.name,
    email: c.email,
    phone: c.phone,
    company: c.company,
    first_name: names[0] || '',
    last_name: names.slice(1).join(' '),
    company_name: enrollment.sequence?.tenant?.name || '',
    status: c.status,
  };
  if (isGeneric) Object.assign(contact, {
    first_name: names[0] || '',
    last_name: names.slice(1).join(' '),
    whatsappPhone: c.whatsappPhone,
    title: c.title,
    source: c.source,
    medium: c.medium,
    industry: c.industry,
    companySize: c.companySize,
    linkedin: c.linkedin,
    website: c.website,
    facebookUrl: c.facebookUrl,
    githubUrl: c.githubUrl,
    twitterUrl: c.twitterUrl,
    firstTouchSource: c.firstTouchSource,
    lastTouchSource: c.lastTouchSource,
    birthDate: c.birthDate,
    anniversary: c.anniversary,
    gst: c.gst,
    stateCode: c.stateCode,
    billingStateCode: c.billingStateCode,
    externalId: c.externalId,
    aiScore: c.aiScore,
    tags,
    custom,
  });
  const context = {
    contact,
    // Flat fallbacks for templates that author `{{name}}` directly:
    name: c.name,
    email: c.email,
    phone: c.phone,
    company: c.company,
    enrollmentId: enrollment.id,
    sequenceId: enrollment.sequenceId,
    organization: { name: enrollment.sequence?.tenant?.name || '' },
    tenant: { name: enrollment.sequence?.tenant?.name || '' },
    companyName: enrollment.sequence?.tenant?.name || '',
    company_name: enrollment.sequence?.tenant?.name || '',
    organizationName: enrollment.sequence?.tenant?.name || '',
    customFields,
  };
  if (isGeneric) {
    const deal = c.deals?.[0] || {};
    Object.assign(context, {
      contact_name: c.name || '',
      sender_name: enrollment.sequence?.tenant?.name || '',
      sender: { name: enrollment.sequence?.tenant?.name || '', email: '', company: enrollment.sequence?.tenant?.name || '' },
    deal_name: deal.name || deal.title || deal.dealName || '',
    deal,
    invoice: c.invoices?.[0] || {},
    task: c.tasks?.[0] || {},
    activity: c.activities?.[0] || {},
    expense: c.expenses?.[0] || {},
    contract: c.contracts?.[0] || {},
    estimate: c.estimates?.[0] || {},
      project: c.projects?.[0] || {},
      pickup: c.customerPickups?.[0]
        ? { ...c.customerPickups[0], address: c.customerPickups[0].pickupAddress, location: c.customerPickups[0].pickupAddress }
        : {},
    });
  }
  return context;
}

// ── Flyer attachment rendering (S19, PRD_TRAVEL_MARKETING_FLYER FR-3.5) ──
//
// SequenceStep.attachmentRefsJson encodes an array of attachment refs:
//   [{kind:'flyer', flyerId:42, format:'pdf-a4'},
//    {kind:'file',  url:'https://…', filename:'brochure.pdf'}]
//
// At send time we resolve every flyer ref into a rendered buffer by looking
// up the TravelFlyerTemplate by id (tenant-scoped) and calling the shared
// `renderFlyer({template,data,format})` engine. Each entry is rendered
// independently — a single failure (template not found / render exception
// / unsupported format) is logged + that attachment is skipped, but the
// surrounding step send continues.
//
// Audit: every SUCCESSFUL flyer render emits a `writeAudit(
//   'SequenceStep', 'sequence.step.flyer-attached', stepId, null, tenantId,
//   { enrollmentId, flyerId, format, channel, engine })` row so an operator
// can later reconstruct which flyers went out via which steps. Failures
// emit `'sequence.step.flyer-attach-failed'` with the error message in the
// details JSON.
//
// Returns: `Promise<Array<{kind, filename, mimeType, buffer, flyerId,
//   format, engine}>>` — an array of attachment descriptors the caller
// embeds into the outbound message. Non-flyer refs (e.g. kind='file') are
// passed through untouched as `{kind:'file', url, filename}` records — the
// transport layer (SendGrid / SMTP / WhatsApp) handles those existing-URL
// references.
async function resolveStepAttachments(step, enrollment, channel) {
  if (!step || typeof step.attachmentRefsJson !== 'string' || step.attachmentRefsJson.length === 0) {
    return [];
  }
  let refs;
  try {
    refs = JSON.parse(step.attachmentRefsJson);
  } catch (parseErr) {
    console.warn(
      `[sequenceEngine] step ${step.id} attachmentRefsJson is malformed; skipping all attachments:`,
      parseErr.message,
    );
    return [];
  }
  if (!Array.isArray(refs) || refs.length === 0) return [];

  const resolved = [];
  for (const ref of refs) {
    if (!ref || typeof ref !== 'object') continue;

    if (ref.kind === 'file' && typeof ref.url === 'string' && ref.url.length > 0) {
      // Pass through — transport layer dereferences the URL.
      resolved.push({
        kind: 'file',
        url: ref.url,
        filename: typeof ref.filename === 'string' ? ref.filename : 'attachment',
      });
      continue;
    }

    if (ref.kind !== 'flyer' || typeof ref.flyerId !== 'number') continue;

    const fmt = typeof ref.format === 'string' && ref.format.length > 0 ? ref.format : 'pdf-a4';
    let flyerRow = null;
    try {
      flyerRow = await prisma.travelFlyerTemplate.findFirst({
        where: { id: ref.flyerId, tenantId: enrollment.tenantId },
      });
    } catch (lookupErr) {
      console.warn(
        `[sequenceEngine] flyer ${ref.flyerId} lookup failed for step ${step.id}:`,
        lookupErr.message,
      );
      try {
        await module.exports.writeAuditSafe(
          'SequenceStep',
          'sequence.step.flyer-attach-failed',
          step.id,
          null,
          enrollment.tenantId,
          {
            enrollmentId: enrollment.id,
            flyerId: ref.flyerId,
            format: fmt,
            channel,
            reason: 'lookup_error',
            message: lookupErr.message,
          },
          { actorType: 'system' },
        );
      } catch (_auditErr) { /* don't let audit failure block send */ }
      continue;
    }

    if (!flyerRow) {
      console.warn(
        `[sequenceEngine] flyer ${ref.flyerId} not found (or wrong tenant) for step ${step.id}`,
      );
      try {
        await module.exports.writeAuditSafe(
          'SequenceStep',
          'sequence.step.flyer-attach-failed',
          step.id,
          null,
          enrollment.tenantId,
          {
            enrollmentId: enrollment.id,
            flyerId: ref.flyerId,
            format: fmt,
            channel,
            reason: 'template_not_found',
          },
          { actorType: 'system' },
        );
      } catch (_auditErr) { /* swallow */ }
      continue;
    }

    // Parse the stored JSON columns into the shape renderFlyer expects.
    let palette = {}, layout = [], assets = {};
    try { palette = flyerRow.paletteJson ? JSON.parse(flyerRow.paletteJson) : {}; } catch (_e) { palette = {}; }
    try { layout = flyerRow.layoutJson ? JSON.parse(flyerRow.layoutJson) : []; } catch (_e) { layout = []; }
    try { assets = flyerRow.assetsJson ? JSON.parse(flyerRow.assetsJson) : {}; } catch (_e) { assets = {}; }
    const template = { palette, layout, assets };

    // Build a render-data overlay from enrollment context. The renderer
    // honours { titleOverride, priceOverride, ctaOverride, dateOverride } —
    // we project contact.name onto titleOverride so personalised flyers
    // render with the recipient's name (or the original template title
    // when the contact has no name). Operators get personalisation for
    // free without authoring per-contact templates.
    const renderData = {};
    if (enrollment.contact?.name && typeof enrollment.contact.name === 'string') {
      renderData.titleOverride = `${flyerRow.name} — for ${enrollment.contact.name}`;
    }

    let rendered;
    try {
      rendered = await module.exports.renderFlyerSafe({ template, data: renderData, format: fmt });
    } catch (renderErr) {
      console.warn(
        `[sequenceEngine] flyer ${ref.flyerId} render failed for step ${step.id}:`,
        renderErr.message,
      );
      try {
        await module.exports.writeAuditSafe(
          'SequenceStep',
          'sequence.step.flyer-attach-failed',
          step.id,
          null,
          enrollment.tenantId,
          {
            enrollmentId: enrollment.id,
            flyerId: ref.flyerId,
            format: fmt,
            channel,
            reason: 'render_error',
            message: renderErr.message,
          },
          { actorType: 'system' },
        );
      } catch (_auditErr) { /* swallow */ }
      continue;
    }

    const filename = `${flyerRow.name || 'flyer'}-${ref.flyerId}.${rendered.extension || 'bin'}`
      .replace(/[^\w.-]+/g, '_');

    resolved.push({
      kind: 'flyer',
      flyerId: ref.flyerId,
      format: fmt,
      filename,
      mimeType: rendered.mimeType,
      buffer: rendered.buffer,
      engine: rendered.engine,
    });

    // Audit success — fire-and-forget so a slow audit write doesn't
    // serialise the send loop.
    try {
      await module.exports.writeAuditSafe(
        'SequenceStep',
        'sequence.step.flyer-attached',
        step.id,
        null,
        enrollment.tenantId,
        {
          enrollmentId: enrollment.id,
          flyerId: ref.flyerId,
          format: fmt,
          channel,
          engine: rendered.engine,
          mimeType: rendered.mimeType,
          byteLength: rendered.buffer ? rendered.buffer.length : 0,
        },
        { actorType: 'system' },
      );
    } catch (_auditErr) { /* swallow — audit is best-effort */ }
  }
  return resolved;
}

function parseReceiverCondition(conditionJson) {
  if (!conditionJson) return null;
  try {
    const parsed = JSON.parse(conditionJson);
    return parsed && parsed.version === 2 && Array.isArray(parsed.conditions) ? parsed : null;
  } catch (_error) {
    return null;
  }
}

// Generic campaign open conditions must not treat every pixel request as a
// recipient action.  The existing tracking row already captures the request
// user-agent, so use only conservative, obvious automation fingerprints here.
// Unknown or missing user-agents are intentionally not counted as human opens.
const AUTOMATED_OPEN_USER_AGENT_PATTERNS = [
  /bot/i,
  /crawler/i,
  /spider/i,
  /headless/i,
  /phantom/i,
  /selenium/i,
  /puppeteer/i,
  /playwright/i,
  /curl/i,
  /wget/i,
  /python[- ]requests/i,
  /go-http-client/i,
  /googleimageproxy/i,
  /urlscan/i,
  /proofpoint/i,
  /mimecast/i,
  /barracuda/i,
  /safelinks/i,
];

const HUMAN_EMAIL_CLIENT_MARKERS = [
  /mozilla/i,
  /applewebkit/i,
  /chrome/i,
  /safari/i,
  /firefox/i,
  /edg/i,
  /opera/i,
  /android/i,
  /iphone/i,
  /ipad/i,
  /thunderbird/i,
];

function classifyGenericEmailOpen(tracking) {
  const userAgent = String(tracking?.userAgent || '').trim();
  if (!userAgent) return 'unknown';
  if (AUTOMATED_OPEN_USER_AGENT_PATTERNS.some(pattern => pattern.test(userAgent))) return 'automated';
  if (!HUMAN_EMAIL_CLIENT_MARKERS.some(pattern => pattern.test(userAgent))) return 'unknown';
  return 'likely_human';
}

function isLikelyHumanGenericEmailOpen(tracking) {
  return classifyGenericEmailOpen(tracking) === 'likely_human';
}

function genericCampaignAllowsDispatch(sequence) {
  const campaign = (sequence.campaigns || []).find(item => item.status === 'Active') || sequence.campaigns?.[0];
  if (!campaign?.scheduleFilters) return true;
  let filters;
  try { filters = JSON.parse(campaign.scheduleFilters); } catch (_error) { return true; }
  const timezone = typeof filters.timezone === 'string' && filters.timezone ? filters.timezone : 'UTC';
  let parts;
  try {
    parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date()).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  } catch (_error) {
    return true;
  }
  if (filters.businessDaysOnly && ['Sat', 'Sun'].includes(parts.weekday)) return false;
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);
  const current = hour * 60 + minute;
  const startHour = Number.isFinite(Number(filters.startHour)) ? Number(filters.startHour) : 0;
  const endHour = Number.isFinite(Number(filters.endHour)) ? Number(filters.endHour) : 23;
  const start = Math.max(0, Math.min(23, startHour)) * 60;
  const end = Math.max(0, Math.min(23, endHour)) * 60 + 59;
  return current >= start && current <= end;
}

async function recordGenericCampaignDelivery(enrollment, firstSequenceEmail) {
  if (!firstSequenceEmail || enrollment.sequence?.tenant?.vertical !== 'generic') return;
  const campaigns = enrollment.sequence?.campaigns || [];
  if (!campaigns.length) return;

  // The enrolment itself is the existing duplicate guard. Count a campaign
  // recipient only on the first successfully delivered sequence email, and
  // only for the active campaign whose configured trigger still matches this
  // Generic contact. The one-active-campaign fallback preserves valid older
  // campaigns whose trigger fields were subsequently removed.
  const { matchesCampaign } = require('../lib/genericCampaignAutomation');
  const activeCampaigns = campaigns.filter(campaign => campaign.status === 'Active');
  const campaign = activeCampaigns.find(item => matchesCampaign(item, enrollment.contact))
    || (activeCampaigns.length === 1 ? activeCampaigns[0] : null);
  if (!campaign?.id) return;

  await prisma.campaign.updateMany({
    where: {
      id: campaign.id,
      tenantId: enrollment.tenantId,
      sequenceId: enrollment.sequenceId,
      status: 'Active',
    },
    data: { sent: { increment: 1 } },
  }).catch(error => console.error(`[GenericCampaign] Could not update sent count for campaign ${campaign.id}:`, error.message));
}

async function latestSequenceEmail(enrollment) {
  return prisma.emailMessage.findFirst({
    where: {
      tenantId: enrollment.tenantId,
      contactId: enrollment.contactId,
      threadId: `seq-${enrollment.id}`,
      direction: 'OUTBOUND',
    },
    orderBy: { createdAt: 'desc' },
  });
}

async function addGenericEmailTracking(emailId, body, tenantId) {
  const baseUrl = process.env.FRONTEND_URL || 'https://crm.globusdemos.com';
  const openTrackingId = crypto.randomUUID();
  await prisma.emailTracking.create({ data: { emailId, trackingId: openTrackingId, type: 'open', tenantId } }).catch(() => {});
  let trackedBody = String(body || '');
  const links = [];
  trackedBody = trackedBody.replace(/href\s*=\s*(["'])(https?:\/\/[^"']+)\1/gi, (match, quote, url) => {
    const trackingId = crypto.randomUUID();
    links.push({ trackingId, url });
    return `href=${quote}${baseUrl}/api/communications/track/${trackingId}/click?url=${encodeURIComponent(url)}${quote}`;
  });
  for (const link of links) {
    await prisma.emailTracking.create({ data: { emailId, trackingId: link.trackingId, type: 'click', url: link.url, tenantId } }).catch(() => {});
  }
  return `${trackedBody}\n\n<img src="${baseUrl}/api/communications/track/${openTrackingId}/open.gif" width="1" height="1" style="display:none" alt="" />`;
}

async function receiverConditionMatches(condition, enrollment) {
  const type = condition?.type;
  const event = condition?.event;
  if (type === 'email_activity') {
    const email = await latestSequenceEmail(enrollment);
    if (!email) return false;
    if (event === 'replied' || event === 'no_reply') {
      const reply = await prisma.emailMessage.findFirst({
        where: { tenantId: enrollment.tenantId, contactId: enrollment.contactId, direction: 'INBOUND', threadId: `seq-${enrollment.id}` },
        select: { id: true },
      });
      return event === 'replied' ? Boolean(reply) : !reply;
    }
    if (event === 'unsubscribed') return String(enrollment.contact?.status || '').toLowerCase() === 'unsubscribed';
    const tracking = await prisma.emailTracking.findMany({ where: { emailId: email.id, tenantId: enrollment.tenantId }, select: { type: true, openedAt: true, clickedAt: true, ipAddress: true, userAgent: true } });
    const opened = tracking.some(item => item.openedAt && isLikelyHumanGenericEmailOpen(item));
    const clicked = tracking.some(item => item.clickedAt);
    const bounced = tracking.some(item => item.type === 'bounce');
    return event === 'opened' ? opened
      : event === 'not_opened' ? !opened
        : event === 'clicked' ? clicked
          : event === 'not_clicked' ? !clicked
            : event === 'bounced' ? bounced
              : false;
  }
  if (type === 'contact_status') {
    return String(enrollment.contact?.status || '') === String(condition.value || '');
  }
  if (type === 'deal_stage') {
    return String(enrollment.contact?.deals?.[0]?.stage || '') === String(condition.value || '');
  }
  if (type === 'payment_status') {
    const payment = await prisma.payment.findFirst({ where: { tenantId: enrollment.tenantId, contactId: enrollment.contactId }, orderBy: { createdAt: 'desc' }, select: { status: true } });
    return String(payment?.status || '') === String(condition.value || '');
  }
  if (type === 'booking_status') {
    const booking = await prisma.booking.findFirst({ where: { tenantId: enrollment.tenantId, contactId: enrollment.contactId }, orderBy: { createdAt: 'desc' }, select: { status: true } });
    return String(booking?.status || '') === String(condition.value || '');
  }
  if (type === 'pickup_booking_status') {
    if (enrollment.sequence?.tenant?.vertical !== 'generic') return false;
    const transportPeople = await prisma.transportPerson.findMany({
      where: { tenantId: enrollment.tenantId },
      select: { customerIdsJson: true, assignmentStatusJson: true, updatedAt: true },
    });
    let latest = null;
    for (const person of transportPeople) {
      let customerIds = [];
      let assignments = {};
      try { customerIds = JSON.parse(person.customerIdsJson || '[]'); } catch (_error) {}
      try { assignments = JSON.parse(person.assignmentStatusJson || '{}'); } catch (_error) {}
      if (!Array.isArray(customerIds) || !customerIds.map(Number).includes(Number(enrollment.contactId))) continue;
      const assignment = assignments?.[`customer-${enrollment.contactId}`];
      const status = typeof assignment?.status === 'string' ? assignment.status.trim() : '';
      if (!status) continue;
      const updatedAt = new Date(assignment.updatedAt || person.updatedAt || 0);
      if (!latest || updatedAt > latest.updatedAt) latest = { status, updatedAt };
    }
    return String(latest?.status || '') === String(condition.value || '');
  }
  if (type === 'site_visit_status') {
    if (enrollment.sequence?.tenant?.vertical !== 'generic') return false;
    const visit = await prisma.task.findFirst({
      where: { tenantId: enrollment.tenantId, contactId: enrollment.contactId, type: 'Site Visit', deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { status: true },
    });
    return String(visit?.status || '') === String(condition.value || '');
  }
  if (type === 'invoice_status') {
    const invoice = await prisma.invoice.findFirst({ where: { tenantId: enrollment.tenantId, contactId: enrollment.contactId }, orderBy: { issuedDate: 'desc' }, select: { status: true } });
    return String(invoice?.status || '') === String(condition.value || '');
  }
  if (type === 'estimate_status') {
    const estimate = await prisma.estimate.findFirst({ where: { tenantId: enrollment.tenantId, contactId: enrollment.contactId }, orderBy: { createdAt: 'desc' }, select: { status: true } });
    return String(estimate?.status || '') === String(condition.value || '');
  }
  if (type === 'contract_status') {
    const contract = await prisma.contract.findFirst({ where: { tenantId: enrollment.tenantId, contactId: enrollment.contactId }, orderBy: { updatedAt: 'desc' }, select: { status: true } });
    return String(contract?.status || '') === String(condition.value || '');
  }
  return false;
}

async function executeReceiverAction(action, enrollment, ctx) {
  const type = action?.type || 'send_email';
  if (type === 'stop_sequence') return { stop: true };
  if (type === 'wait') {
    const minutes = Math.max(Number(action.amount || 0) * ({ minutes: 1, hours: 60, days: 1440 }[action.unit] || 1), 0);
    return { nextRun: new Date(Date.now() + minutes * 60_000) };
  }
  if (type === 'change_contact_status') {
    if (action.value) {
      await prisma.contact.update({ where: { id: enrollment.contactId }, data: { status: String(action.value) } });
    }
    return {};
  }
  if (type !== 'send_email' || !action.emailTemplateId) return {};

  const template = await prisma.emailTemplate.findFirst({ where: { id: Number(action.emailTemplateId), tenantId: enrollment.tenantId } });
  if (!template || !enrollment.contact?.email) return {};
  const subject = renderTemplate(normalizeGenericTemplatePlaceholders(template.subject || 'Follow-up'), ctx);
  const body = renderTemplate(normalizeGenericTemplatePlaceholders(template.body || ''), ctx);
  const outbound = await prisma.emailMessage.create({
    data: { subject, body, from: FROM_EMAIL, to: enrollment.contact.email, direction: 'OUTBOUND', contactId: enrollment.contact.id, tenantId: enrollment.tenantId, threadId: `seq-${enrollment.id}`, read: true },
  });
  const trackedBody = await addGenericEmailTracking(outbound.id, body, enrollment.tenantId);
  const delivery = await sendEmail({ tenantId: enrollment.tenantId, to: enrollment.contact.email, subject, text: body, html: trackedBody });
  if (!delivery.sent && String(delivery.reason || '').startsWith('sendgrid_')) {
    await prisma.emailTracking.updateMany({ where: { emailId: outbound.id, type: 'open' }, data: { type: 'bounce' } }).catch(() => {});
  }
  return {};
}

// ── New step-list dispatcher ──────────────────────────────────────────
async function processStep(step, enrollment) {
  const ctx = buildContextForEnrollment(enrollment);
  if (enrollment.sequence?.tenant?.vertical === 'generic') {
    ctx.payment = await prisma.payment.findFirst({
      where: { tenantId: enrollment.tenantId, contactId: enrollment.contactId },
      orderBy: { createdAt: 'desc' },
    }) || {};
  }

  if (step.kind === 'email') {
    // Render template if linked, otherwise fall back to a sane subject so
    // we never silently drop the step.
    const isGenericSequence = enrollment.sequence?.tenant?.vertical === 'generic';
    let subject = `Sequence: step ${step.position}`;
    let body = '';
    if (step.emailTemplate) {
      const templateSubject = isGenericSequence
        ? normalizeGenericTemplatePlaceholders(step.emailTemplate.subject || subject)
        : step.emailTemplate.subject || subject;
      const templateBody = isGenericSequence
        ? normalizeGenericTemplatePlaceholders(step.emailTemplate.body || '')
        : step.emailTemplate.body || '';
      subject = renderGenericTemplate(templateSubject, ctx);
      body = renderGenericTemplate(templateBody, ctx, { html: true });
    }
    const to = enrollment.contact?.email;
    if (!to) {
      // No address — skip silently rather than crash. Cursor still advances.
      return { advance: true };
    }

    // S19 — render-on-send for SequenceStep.attachmentRefsJson entries with
    // kind='flyer'. Resolves to a list of attachment descriptors. Errors per
    // ref are caught internally — the surrounding step send always proceeds.
    const attachments = await resolveStepAttachments(step, enrollment, 'email');
    const travelProvider = await resolveSequenceTravelProvider(enrollment.tenantId);

    const firstSequenceEmail = isGenericSequence
      ? !(await prisma.emailMessage.findFirst({
        where: { tenantId: enrollment.tenantId, threadId: `seq-${enrollment.id}`, direction: 'OUTBOUND' },
        select: { id: true },
      }))
      : false;

    // Persist the outbound row (engine source of truth) before attempting
    // delivery. threadId convention is `seq-<enrollmentId>` so #7 reply
    // detection can recover the enrollment from an inbound reply.
    const outboundMessage = await prisma.emailMessage.create({
      data: {
        subject,
        body,
        from: sequenceSenderIdentity(travelProvider),
        to,
        direction: 'OUTBOUND',
        contactId: enrollment.contact.id,
        tenantId: enrollment.tenantId,
        threadId: `seq-${enrollment.id}`,
        read: true,
      },
    });
    let trackedBody = body;
    if (isGenericSequence) trackedBody = await addGenericEmailTracking(outboundMessage.id, body, enrollment.tenantId);

    // EmailMessage is the transport log; Generic CRM also exposes automated
    // emails in the contact Activity timeline. Travel/Wellness sequence
    // behavior is unchanged.
    let tenant = null;
    try {
      tenant = await prisma.tenant.findUnique({ where: { id: enrollment.tenantId }, select: { vertical: true } });
    } catch (_error) {
      // Older/unit-test Prisma surfaces may not expose Tenant lookup. Activity
      // logging is additive, so preserve the existing send path if unavailable.
    }
    if (tenant?.vertical === 'generic') {
      await prisma.activity.create({
        data: {
          type: 'Email',
          description: `Automated campaign email: ${subject}`,
          contactId: enrollment.contact.id,
          userId: null,
          tenantId: enrollment.tenantId,
        },
      });
    }

    if (tenant?.vertical === 'generic') {
      // Generic CRM uses the shared sender and awaits the provider response so
      // delivery failures are visible in backend logs instead of being lost.
      const delivery = await sendEmail({
        tenantId: enrollment.tenantId,
        to,
        subject,
        text: body,
        html: trackedBody,
        attachments: attachments
          .filter(attachment => attachment?.kind === 'flyer' && Buffer.isBuffer(attachment.buffer))
          .map(attachment => ({
            content: attachment.buffer.toString('base64'),
            filename: attachment.filename,
            type: attachment.mimeType,
          })),
      });
      if (delivery.sent) await recordGenericCampaignDelivery(enrollment, firstSequenceEmail);
      if (!delivery.sent && String(delivery.reason || '').startsWith('sendgrid_')) {
        console.error(`[GenericCampaign] Email delivery failed for ${to}: ${delivery.reason || 'unknown_error'}`);
        if (outboundMessage?.id) {
          await prisma.emailTracking.updateMany({ where: { emailId: outboundMessage.id, type: 'open' }, data: { type: 'bounce' } }).catch(() => {});
        }
      }
    } else if (travelProvider?.apiKey || SENDGRID_API_KEY) {
      // Preserve the existing Travel/Wellness sequence delivery behavior.
      trySendGridSend(to, subject, body, attachments, travelProvider).catch(() => {});
    }
    return { advance: true };
  }

  if (step.kind === 'sms') {
    if (enrollment.contact?.phone) {
      let body = renderTemplate(step.smsBody || '', ctx);
      // S19 — SMS doesn't natively carry binary attachments but flyer links
      // are commonly sent as a separate URL line.
      // S87 — for each resolved flyer attachment, shorten the rendered
      // buffer via services/shortUrl.shortenUrl and append the link to the
      // SMS body. Short-link fails are fail-soft (audited, SMS still sends
      // without a link) so an unimplemented provider never blocks delivery.
      const attachments = await resolveStepAttachments(step, enrollment, 'sms');
      if (attachments.length > 0) {
        const linkLines = [];
        for (const att of attachments) {
          // File-kind refs already carry a URL — use it verbatim, no
          // shortener call. Only flyer-kind needs the buffer→URL hop.
          if (att.kind === 'file' && typeof att.url === 'string' && att.url.length > 0) {
            linkLines.push(`📎 ${att.url}`);
            continue;
          }
          if (att.kind !== 'flyer' || !Buffer.isBuffer(att.buffer)) continue;
          try {
            const shortened = await module.exports.shortenUrlSafe({
              buffer: att.buffer,
              filename: att.filename,
              mimeType: att.mimeType,
            });
            linkLines.push(`📎 ${shortened.shortUrl}`);
            // Success audit row — operator-visible confirmation that the
            // link landed in the SMS body. Payload mirrors the
            // 'sequence.step.flyer-attached' shape but excludes the raw
            // buffer (links only, never blob content in audit logs).
            try {
              await module.exports.writeAuditSafe(
                'SequenceStep',
                'sequence.step.sms-flyer-shortlinked',
                step.id,
                null,
                enrollment.tenantId,
                {
                  enrollmentId: enrollment.id,
                  flyerId: att.flyerId,
                  format: att.format,
                  filename: shortened.filename,
                  mimeType: shortened.mimeType,
                  shortUrl: shortened.shortUrl,
                  source: shortened.source,
                  channel: 'sms',
                },
                { actorType: 'system' },
              );
            } catch (_auditErr) { /* swallow — audit best-effort */ }
          } catch (shortenErr) {
            // Fail-soft: don't break the SMS send if the shortener trips.
            // Operator-visible signal is the 'shortlink-failed' audit row.
            console.warn(
              `[sequenceEngine] short-URL failed for flyer ${att.flyerId} on step ${step.id}:`,
              shortenErr.message,
            );
            try {
              await module.exports.writeAuditSafe(
                'SequenceStep',
                'sequence.step.sms-flyer-shortlink-failed',
                step.id,
                null,
                enrollment.tenantId,
                {
                  enrollmentId: enrollment.id,
                  flyerId: att.flyerId,
                  format: att.format,
                  channel: 'sms',
                  reason: 'shorten_error',
                  message: shortenErr.message,
                },
                { actorType: 'system' },
              );
            } catch (_auditErr) { /* swallow */ }
          }
        }
        if (linkLines.length > 0) {
          body = `${body.trim()}\n\n${linkLines.join('\n')}`.trim();
        }
      }
      await prisma.smsMessage.create({
        data: {
          to: enrollment.contact.phone,
          body: body || `Automated sequence message`,
          direction: 'OUTBOUND',
          status: 'QUEUED',
          contactId: enrollment.contact.id,
          tenantId: enrollment.tenantId,
        },
      });
    }
    return { advance: true };
  }

  if (step.kind === 'wait') {
    const minutes = Math.max(parseInt(step.delayMinutes, 10) || 0, 0);
    if (minutes > 0) {
      // Park: do not advance the cursor; just set nextRun.
      return {
        advance: true, // we DO advance past the wait so the next tick after
        // nextRun fires the FOLLOWING step (parking semantics: wait step =
        // delay before advancing past it).
        nextRun: new Date(Date.now() + minutes * 60_000),
      };
    }
    return { advance: true };
  }

  if (step.kind === 'stop' && enrollment.sequence?.tenant?.vertical === 'generic') {
    return { stop: true };
  }

  if (step.kind === 'condition') {
    const receiverCondition = parseReceiverCondition(step.conditionJson);
    if (receiverCondition && enrollment.sequence?.tenant?.vertical === 'generic') {
      const checks = [];
      for (const condition of receiverCondition.conditions) checks.push(await receiverConditionMatches(condition, enrollment));
      const matched = receiverCondition.logic === 'ANY' ? checks.some(Boolean) : checks.every(Boolean);
      const branch = matched ? receiverCondition.yesAction : receiverCondition.noAction;
      const actionResult = await executeReceiverAction(branch, enrollment, ctx);
      if (actionResult.stop) return { stop: true };
      const fallback = step.position + 1;
      // Generic v2 conditions own their YES/NO action. Do not fall through
      // into a standalone email step or honor stale legacy branch targets,
      // otherwise the selected branch can send a second message as well.
      if (branch?.type === 'send_email') {
        return { complete: true };
      }
      const target = matched
        ? (step.trueNextPosition != null ? step.trueNextPosition : fallback)
        : (step.falseNextPosition != null ? step.falseNextPosition : fallback);
      return { advance: false, jumpTo: target, nextRun: actionResult.nextRun || null };
    }
    const result = evaluateCondition(step.conditionJson, ctx);
    const fallback = step.position + 1;
    const target = result
      ? (step.trueNextPosition != null ? step.trueNextPosition : fallback)
      : (step.falseNextPosition != null ? step.falseNextPosition : fallback);
    return { advance: false, jumpTo: target };
  }

  // Unknown kind — fail-safe: advance so the enrollment is not stuck.
  return { advance: true };
}

async function processStepListEnrollment(enrollment, steps) {
  const stepsByPos = new Map(steps.map(s => [s.position, s]));
  let cursor = enrollment.currentStep == null ? 0 : enrollment.currentStep;
  let nextRun = null;
  let safety = 0; // condition jumps could in theory loop; guard.

  while (safety++ < 50) {
    const step = stepsByPos.get(cursor);
    if (!step) {
      // Past the last position — sequence complete.
      await prisma.sequenceEnrollment.update({
        where: { id: enrollment.id },
        data: { status: 'Completed', currentStep: cursor, nextRun: null },
      });
      return;
    }

    // Email delays apply BEFORE dispatch, not after delivery. A persisted
    // nextRun for this cursor marks an already-scheduled delay, so resuming
    // the due enrollment does not schedule the same delay forever.
    if (enrollment.sequence?.tenant?.vertical === 'generic' && step.kind === 'email') {
      const minutes = Math.max(Number(step.delayMinutes) || 0, 0);
      const resumed = enrollment.emailDelayStep === cursor && enrollment.nextRun;
      if (resumed && new Date(enrollment.nextRun) > new Date()) return;
      if (minutes > 0 && !resumed) {
        await prisma.sequenceEnrollment.update({
          where: { id: enrollment.id },
          data: { currentStep: cursor, emailDelayStep: cursor, nextRun: new Date(Date.now() + minutes * 60_000) },
        });
        return;
      }
    }

    const result = await processStep(step, enrollment);

    if (result.stop) {
      await prisma.sequenceEnrollment.update({ where: { id: enrollment.id }, data: { status: 'Paused', currentStep: cursor, nextRun: null } });
      return;
    }

    if (result.complete) {
      await prisma.sequenceEnrollment.update({
        where: { id: enrollment.id },
        data: { status: 'Completed', currentStep: cursor + 1, nextRun: null },
      });
      return;
    }

    if (result.nextRun) {
      // Wait step parked the enrollment. Advance the cursor (so the next
      // tick fires the step AFTER the wait), persist nextRun, exit.
      const advanced = result.advance ? cursor + 1 : (result.jumpTo != null ? result.jumpTo : cursor);
      await prisma.sequenceEnrollment.update({
        where: { id: enrollment.id },
        data: { currentStep: advanced, nextRun: result.nextRun },
      });
      return;
    }

    if (result.advance === false && result.jumpTo != null) {
      cursor = result.jumpTo;
      continue;
    }

    cursor += 1;
  }

  // Bailed on safety. Persist whatever cursor we got to and mark Active so
  // the next tick can retry. (Better than silently completing.)
  await prisma.sequenceEnrollment.update({
    where: { id: enrollment.id },
    data: { currentStep: cursor, nextRun },
  });
}

// ── Legacy ReactFlow path (preserved verbatim) ────────────────────────
const findNextNodeId = (currentNodeId, edges) => {
  const outgoingEdge = edges.find(e => e.source === currentNodeId);
  return outgoingEdge ? outgoingEdge.target : null;
};

const processNodeLegacy = async (node, enrollment) => {
  const label = node.data?.label || '';

  if (label.startsWith('ACTION: Send Email')) {
    const fromAddress = await getSetting(enrollment.tenantId, KEYS.EMAIL_FROM_ADDRESS, { fallback: 'system@crm.com' });
    await prisma.emailMessage.create({
      data: {
        subject: `Automated Sequence: ${label}`,
        body: `This is an automated drip email generated by a Sequence Engine action.`,
        from: fromAddress,
        to: enrollment.contact.email,
        direction: 'OUTBOUND',
        contactId: enrollment.contact.id,
        threadId: `seq-${enrollment.id}`,
        read: true,
        tenantId: enrollment.tenantId,
      },
    });
    return { delayMinutes: 0 };
  }

  if (label.startsWith('DELAY:')) {
    const daysMatch = label.match(/(\d+)\s*Days?/i);
    const hoursMatch = label.match(/(\d+)\s*Hours?/i);
    const minsMatch = label.match(/(\d+)\s*Min(?:ute)?s?/i);
    let delayMinutes = 60;
    if (daysMatch) delayMinutes = parseInt(daysMatch[1]) * 1440;
    else if (hoursMatch) delayMinutes = parseInt(hoursMatch[1]) * 60;
    else if (minsMatch) delayMinutes = parseInt(minsMatch[1]);
    return { delayMinutes };
  }

  if (label.startsWith('ACTION: Send SMS')) {
    if (enrollment.contact.phone) {
      await prisma.smsMessage.create({
        data: {
          to: enrollment.contact.phone,
          body: `Automated sequence message for ${enrollment.contact.name}`,
          direction: 'OUTBOUND',
          status: 'QUEUED',
          contactId: enrollment.contact.id,
          tenantId: enrollment.tenantId,
        },
      });
    }
    return { delayMinutes: 0 };
  }

  if (label.startsWith('ACTION: Send WhatsApp')) {
    if (enrollment.contact.phone) {
      // S88 — channel-parity with email (S19) + SMS (S87). The legacy
      // ReactFlow path receives a `node`, not a SequenceStep row; synthesise
      // a step-shaped object so resolveStepAttachments can run unchanged.
      // The synthetic `id` is the node id (string in legacy land — cast to
      // a deterministic string for the audit row).
      const syntheticStep = {
        id: node.id || `legacy-${enrollment.id}`,
        attachmentRefsJson:
          typeof node.data?.attachmentRefsJson === 'string'
            ? node.data.attachmentRefsJson
            : null,
      };

      let attachments = [];
      try {
        attachments = await resolveStepAttachments(
          syntheticStep,
          enrollment,
          'whatsapp',
        );
      } catch (resolveErr) {
        // Fail-soft: WhatsApp message still sends without media. Per-ref
        // failures inside resolveStepAttachments are already swallowed
        // (lookup_error / template_not_found / render_error audited there).
        // This outer catch only fires for unexpected resolver crashes —
        // surface them via a dedicated audit row so the operator sees the
        // signal in the SequenceStep audit trail.
        console.warn(
          `[sequenceEngine] WhatsApp flyer resolution failed for node ${node.id}:`,
          resolveErr.message,
        );
        try {
          await module.exports.writeAuditSafe(
            'SequenceStep',
            'sequence.step.wa-flyer-attach-failed',
            syntheticStep.id,
            null,
            enrollment.tenantId,
            {
              enrollmentId: enrollment.id,
              channel: 'whatsapp',
              reason: 'resolver_error',
              message: resolveErr.message,
            },
            { actorType: 'system' },
          );
        } catch (_auditErr) { /* swallow */ }
        attachments = [];
      }

      // STUB-MODE — real Meta WhatsApp Cloud API media upload is BLOCKED
      // on Q9 (Wati creds). For each resolved flyer/file ref, build a
      // stub-flagged media-ref entry that captures enough provenance
      // (flyerId / format / mimeType) for the real swap point. The
      // single-column WhatsAppMessage.mediaUrl + mediaType pair can only
      // surface ONE attachment; the full list also persists to
      // WhatsAppMessage.mediaRefsJson (S124 — JSON-stringified array of
      // every resolved attachment ref). The audit trail still mirrors the
      // list per-attachment for forensic completeness, but operators no
      // longer need to cross-reference audit rows to see the full list.
      const stubMediaRefs = [];
      for (const att of attachments) {
        if (att.kind === 'flyer' && Buffer.isBuffer(att.buffer)) {
          stubMediaRefs.push({
            kind: 'flyer',
            flyerId: att.flyerId,
            format: att.format,
            mimeType: att.mimeType,
            filename: att.filename,
            stub: true,
            plannedAction: 'upload-when-Q9-lands',
          });
        } else if (att.kind === 'file' && typeof att.url === 'string') {
          // File-kind refs already carry a URL — WhatsApp Cloud API can
          // dereference public URLs directly, so no stub needed.
          stubMediaRefs.push({
            kind: 'file',
            url: att.url,
            filename: att.filename,
          });
        }
      }

      // Pick the first eligible attachment for the single-column mediaUrl
      // / mediaType surface. Stub-mode: synthesise a placeholder URL the
      // real swap point replaces with the Meta media_id once Q9 lands.
      let mediaUrl = null;
      let mediaType = null;
      if (stubMediaRefs.length > 0) {
        const head = stubMediaRefs[0];
        if (head.kind === 'file') {
          mediaUrl = head.url;
          mediaType = null; // unknown for upstream URLs
        } else {
          mediaUrl = `stub://flyer/${head.flyerId}.${head.format || 'pdf-a4'}`;
          mediaType = head.mimeType || null;
        }
      }

      await prisma.whatsAppMessage.create({
        data: {
          to: enrollment.contact.phone,
          body: `Automated WhatsApp sequence message for ${enrollment.contact.name}`,
          direction: 'OUTBOUND',
          status: 'QUEUED',
          contactId: enrollment.contact.id,
          ...(mediaUrl ? { mediaUrl } : {}),
          ...(mediaType ? { mediaType } : {}),
          // S124: multi-attachment full list. Null when no attachments —
          // preserves the existing "no media columns set" shape for the
          // zero-attachment path so unit tests pinning `data.mediaUrl ===
          // undefined` keep passing.
          ...(stubMediaRefs.length > 0
            ? { mediaRefsJson: JSON.stringify(stubMediaRefs) }
            : {}),
        },
      });

      // One success-audit row PER attachment so operators can see exactly
      // which flyers were attached / would be uploaded. Payload omits the
      // raw buffer (mirrors S87's discipline — links / refs only, never
      // blob content in audit logs).
      for (const ref of stubMediaRefs) {
        try {
          await module.exports.writeAuditSafe(
            'SequenceStep',
            'sequence.step.wa-flyer-attached',
            syntheticStep.id,
            null,
            enrollment.tenantId,
            {
              enrollmentId: enrollment.id,
              channel: 'whatsapp',
              ...(ref.kind === 'flyer'
                ? {
                    flyerId: ref.flyerId,
                    format: ref.format,
                    mimeType: ref.mimeType,
                    stub: true,
                    plannedAction: ref.plannedAction,
                  }
                : {
                    fileUrl: ref.url,
                    filename: ref.filename,
                  }),
            },
            { actorType: 'system' },
          );
        } catch (_auditErr) { /* swallow — audit is best-effort */ }
      }
    }
    return { delayMinutes: 0 };
  }

  if (label.startsWith('ACTION: Send Push')) return { delayMinutes: 0 };
  if (label.startsWith('CONDITION:')) return { delayMinutes: 0 };
  return { delayMinutes: 0 };
};

async function processLegacyEnrollment(enrollment) {
  const { sequence } = enrollment;
  if (!sequence.nodes) return;

  let nodes = [];
  let edges = [];
  try {
    nodes = JSON.parse(sequence.nodes);
    edges = JSON.parse(sequence.edges || '[]');
  } catch (_err) {
    console.error(`Error parsing sequence graph for ID: ${sequence.id}`);
    return;
  }

  let currentNodeId = enrollment.currentNode;
  if (!currentNodeId) {
    const triggerNode = nodes.find(n => n.type === 'input');
    currentNodeId = triggerNode ? triggerNode.id : nodes[0]?.id;
  }
  let activeNode = nodes.find(n => n.id === currentNodeId);

  let keepProcessing = true;
  let nextRun = enrollment.nextRun;
  let safety = 0;
  const MAX_STEPS = 50;

  while (activeNode && keepProcessing && safety < MAX_STEPS) {
    safety++;
    const result = await processNodeLegacy(activeNode, enrollment);
    if (result.delayMinutes > 0) {
      nextRun = new Date(Date.now() + result.delayMinutes * 60000);
      currentNodeId = findNextNodeId(activeNode.id, edges);
      keepProcessing = false;
    } else {
      currentNodeId = findNextNodeId(activeNode.id, edges);
      if (!currentNodeId) {
        activeNode = null;
        keepProcessing = false;
      } else {
        activeNode = nodes.find(n => n.id === currentNodeId);
      }
    }
  }

  if (safety >= MAX_STEPS) {
    console.error(`[sequenceEngine] enrollment ${enrollment.id} hit MAX_STEPS (${MAX_STEPS}) — possible cycle in sequence graph. Pausing enrollment.`);
    await prisma.sequenceEnrollment.update({
      where: { id: enrollment.id },
      data: { status: 'Paused', nextRun: null },
    });
    return;
  }

  if (!currentNodeId) {
    await prisma.sequenceEnrollment.update({
      where: { id: enrollment.id },
      data: { status: 'Completed', currentNode: null, nextRun: null },
    });
  } else {
    await prisma.sequenceEnrollment.update({
      where: { id: enrollment.id },
      data: { currentNode: currentNodeId, nextRun },
    });
  }
}

// ── Reply detection (#7) ──────────────────────────────────────────────
async function processInboundReplies() {
  try {
    const replies = await prisma.emailMessage.findMany({
      where: {
        direction: 'INBOUND',
        threadId: { startsWith: 'seq-' },
        sequenceReplyHandled: null,
      },
      take: 200,
      orderBy: { createdAt: 'asc' },
    });

    for (const msg of replies) {
      const m = /^seq-(\d+)$/.exec(msg.threadId || '');
      if (!m) {
        // Mark handled anyway so we don't re-scan this row forever.
        await prisma.emailMessage.update({
          where: { id: msg.id },
          data: { sequenceReplyHandled: new Date() },
        }).catch(() => {});
        continue;
      }
      const enrollmentId = parseInt(m[1], 10);
      const enrollment = await prisma.sequenceEnrollment.findUnique({
        where: { id: enrollmentId },
        include: { sequence: { include: { tenant: { select: { vertical: true } } } } },
      });
      if (!enrollment) {
        await prisma.emailMessage.update({
          where: { id: msg.id },
          data: { sequenceReplyHandled: new Date() },
        }).catch(() => {});
        continue;
      }

      let shouldPause = false;
      if (enrollment.status === 'Active') {
        // Look up the step the enrollment is parked on (step-list path).
        // If pauseOnReply=true, pause. If sequence has no steps (legacy
        // canvas) we pause unconditionally — matching the documented
        // default of "a reply pauses the drip".
        const cursor = enrollment.currentStep == null ? 0 : enrollment.currentStep;
        const step = await prisma.sequenceStep.findFirst({
          where: { sequenceId: enrollment.sequenceId, position: cursor },
        });
        if (step) {
          const isGenericReceiverCondition = enrollment.sequence?.tenant?.vertical === 'generic' && parseReceiverCondition(step.conditionJson);
          shouldPause = isGenericReceiverCondition ? false : !!step.pauseOnReply;
        } else {
          shouldPause = true; // legacy canvas: default-pause on reply.
        }
      }

      if (shouldPause) {
        await prisma.sequenceEnrollment.update({
          where: { id: enrollment.id },
          data: { status: 'Paused', nextRun: null },
        });
      }
      await prisma.emailMessage.update({
        where: { id: msg.id },
        data: { sequenceReplyHandled: new Date() },
      }).catch(() => {});
    }
  } catch (err) {
    console.error('[sequenceEngine] processInboundReplies error:', err.message);
  }
}

// Worker identity for pessimistic locking — mirrors whatsappOutboundEngine.js.
const WORKER_ID = `seq-worker-${process.pid}-${Date.now()}`;

// ── Main tick ─────────────────────────────────────────────────────────
const tickSequenceEngine = async () => {
  // Distinct claims even when two ticks overlap inside the same process.
  const claimId = `${WORKER_ID}-${crypto.randomUUID()}`;
  try {
    // 1. Detect inbound replies first so any pause kicks in BEFORE we
    //    advance an enrollment that just got a reply.
    await processInboundReplies();

    const now = new Date();
    // 2. Fetch candidate enrollment IDs only (lightweight).
    const candidates = await prisma.sequenceEnrollment.findMany({
      where: {
        status: 'Active',
        OR: [{ nextRun: null }, { nextRun: { lte: now } }],
        lockedAt: null,
      },
      select: { id: true },
      take: 100,
    });

    if (candidates.length === 0) return;

    // 3. Lock the batch. updateMany with WHERE lockedAt IS NULL serializes
    //    across concurrent workers (PM2 clusters, horizontal pods, etc.).
    const ids = candidates.map((c) => c.id);
    await prisma.sequenceEnrollment.updateMany({
      where: { id: { in: ids }, lockedAt: null, status: 'Active', OR: [{ nextRun: null }, { nextRun: { lte: now } }] },
      data: { lockedAt: new Date(), lockedBy: claimId },
    });

    // 4. Re-fetch only the rows this worker actually claimed.
    const enrollments = await prisma.sequenceEnrollment.findMany({
      where: { id: { in: ids }, lockedBy: claimId },
      include: {
        sequence: { include: { tenant: { select: { vertical: true, name: true } }, campaigns: { select: { id: true, status: true, scheduleFilters: true, sequenceId: true }, orderBy: { createdAt: 'desc' } }, steps: { include: { emailTemplate: true }, orderBy: { position: 'asc' } } } },
        contact: { include: {
          leadCustomFieldValues: { include: { field: { select: { fieldKey: true, label: true } } } },
          deals: { orderBy: { createdAt: 'desc' }, take: 1 },
          invoices: { orderBy: { issuedDate: 'desc' }, take: 1 },
          tasks: { orderBy: { createdAt: 'desc' }, take: 1 },
          activities: { orderBy: { createdAt: 'desc' }, take: 1 },
          expenses: { orderBy: { createdAt: 'desc' }, take: 1 },
          contracts: { orderBy: { createdAt: 'desc' }, take: 1 },
          estimates: { orderBy: { createdAt: 'desc' }, take: 1 },
          projects: { orderBy: { createdAt: 'desc' }, take: 1 },
          customerPickups: { orderBy: { updatedAt: 'desc' }, take: 1 },
        } },
      },
    });

    for (const enrollment of enrollments) {
      try {
        const { sequence } = enrollment;
        if (!sequence.isActive) {
          // Unlock and skip inactive sequences.
          await prisma.sequenceEnrollment.update({
            where: { id: enrollment.id },
            data: { lockedAt: null, lockedBy: null },
          });
          continue;
        }
        if (sequence.tenant?.vertical === 'generic' && !genericCampaignAllowsDispatch(sequence)) {
          await prisma.sequenceEnrollment.update({
            where: { id: enrollment.id },
            data: { lockedAt: null, lockedBy: null },
          });
          continue;
        }

        const steps = sequence.steps || [];
        if (steps.length > 0) {
          await processStepListEnrollment(enrollment, steps);
        } else if (sequence.nodes) {
          await processLegacyEnrollment(enrollment);
        }

        // Unlock after successful processing.
        await prisma.sequenceEnrollment.update({
          where: { id: enrollment.id },
          data: { lockedAt: null, lockedBy: null },
        });
      } catch (procErr) {
        console.error(`[sequenceEngine] enrollment ${enrollment.id} failed:`, procErr.message);
        // Unlock on error so the next tick can retry.
        await prisma.sequenceEnrollment.update({
          where: { id: enrollment.id },
          data: { lockedAt: null, lockedBy: null },
        }).catch(() => {});
      }
    }
  } catch (error) {
    console.error('Sequence Engine Error:', error);
  }
};

const initSequenceCron = () => {
  cronRegistry.register({
    name: 'sequenceEngine',
    description: 'Drip-sequence step execution — sends due SequenceEnrollment steps (every minute)',
    defaultSchedule: '* * * * *',
    tickFn: tickSequenceEngine,
  }).catch((e) => console.error('[sequenceEngine] cronRegistry registration failed:', e.message));
};

module.exports = {
  initSequenceCron,
  tickSequenceEngine,
  processInboundReplies, // exported for manual / test triggering
  processStep, // #616: exported so unit tests can pin step dispatch shape
  processStepListEnrollment, // #616: exported for wellness trigger unit tests
  processNodeLegacy, // S88: exported for WhatsApp legacy-branch unit tests
  resolveStepAttachments, // S19: exported for flyer-attachment unit tests
  receiverConditionMatches,
  // S19 + S87 — CJS self-mocking seams (cron-learnings 2026-05-24 ~01:43 UTC):
  // tests reassign these to vi.fn() to intercept the SUT's calls without
  // booting pdfkit / prisma.auditLog / shortener providers.
  renderFlyerSafe,
  writeAuditSafe,
  shortenUrlSafe, // S87
  classifyGenericEmailOpen,
  isLikelyHumanGenericEmailOpen,
};
