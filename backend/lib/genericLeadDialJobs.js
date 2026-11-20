const prisma = require('./prisma');
const client = require('../services/callifiedClient');
const {
  normalizeLeadStatus, classifyLeadStatus, assignQualifiedLeadRoundRobin,
  isManualLeadStatus, leadStatusVersion, preserveRetryStatus, automaticLeadStatusData,
} = require('./callifiedLeadStatus');
const permissions = require('../middleware/requirePermission');
const { getSetting, KEYS, DEFAULTS } = require('./tenantSettings');
const { wasRecentlyDialed } = require('./callifiedRedialGuard');
const { writeAudit } = require('./audit');

const ACTIVE = ['scheduled', 'running'];
const STATUSES = ['yet_to_call', 'dnp', 'pending', 'junk'];
const TERMINAL_CALL = ['COMPLETED', 'MISSED', 'FAILED', 'CANCELLED'];
let timer;
let ticking = false;

function fail(message, code = 'INVALID_DIAL_JOB', status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function parseAudience(body) {
  const ids = (value, name) => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 1000 || value.some((id) => !Number.isSafeInteger(Number(id)) || Number(id) <= 0)) {
      throw fail(`${name} must contain at most 1,000 positive IDs.`);
    }
    return [...new Set(value.map(Number))];
  };
  const contactIds = ids(body.contactIds, 'Lead selection');
  const campaignIds = ids(body.campaignIds, 'Campaign selection');
  const campaignOverrideId = body.campaignOverrideId == null ? null : Number(body.campaignOverrideId);
  if (campaignOverrideId !== null && (!Number.isSafeInteger(campaignOverrideId) || campaignOverrideId <= 0 || !contactIds.length)) throw fail('Invalid selected campaign.');
  const byStatus = body.byStatus === true;
  if (byStatus ? (contactIds.length || campaignIds.length || !body.statuses?.length) : Boolean(contactIds.length) === Boolean(campaignIds.length)) throw fail('Choose leads, campaigns, or lead statuses.');
  const statuses = body.statuses ?? (contactIds.length ? STATUSES : ['yet_to_call', 'dnp', 'pending']);
  if (!Array.isArray(statuses) || !statuses.length || statuses.some((status) => !STATUSES.includes(status))) {
    throw fail('Choose at least one callable status. Qualified and active leads cannot be dialed.');
  }
  const scheduledAt = body.scheduledAt ? new Date(body.scheduledAt) : new Date();
  if (!Number.isFinite(scheduledAt.getTime()) || (body.scheduledAt && scheduledAt.getTime() < Date.now() + 30_000)) {
    throw fail('Choose a date and time at least 30 seconds in the future.');
  }
  return { contactIds, campaignIds, campaignOverrideId, ...(byStatus && { byStatus }), statuses: [...new Set(statuses)], scheduledAt };
}

async function visibility(user) {
  if (['ADMIN', 'MANAGER'].includes(user.role)) return {};
  const mode = await getSetting(user.tenantId, KEYS.GENERIC_LEAD_VISIBILITY, { fallback: 'closed' });
  return mode === 'open' ? {} : { assignedToId: user.id || user.userId };
}

async function liveCalls(user, scope) {
  const tenantId = user.tenantId;
  const { assignedToId } = scope || await visibility(user);
  const { classificationFields, attemptStatus } = require('./callifiedAttemptStatus');
  const statuses = ['INITIATED', 'RINGING', 'CONNECTED'];
  const logs = await prisma.callLog.findMany({
    where: { tenantId, provider: 'callified', status: { in: statuses },
      ...(assignedToId && { contact: { tenantId, assignedToId } }) },
    orderBy: { id: 'desc' },
    select: { id: true, createdAt: true, status: true, calleeNumber: true,
      contact: { select: { ...classificationFields, name: true, phone: true } } },
  });
  return logs.filter(log => statuses.includes(attemptStatus(log))).map(log => ({
    id: log.id, name: log.contact?.name, phone: log.calleeNumber || log.contact?.phone, createdAt: log.createdAt,
  }));
}

async function getDialQueueSnapshot(user, now = new Date(), { toolbar = false } = {}) {
  const tenantId = user.tenantId;
  const pauseKey = 'feature.callified.dialing_paused';
  const keys = [
    pauseKey, KEYS.CALLIFIED_RETRY_TIMEZONE, KEYS.CALLIFIED_AUTO_DIAL_NEW_LEADS_ENABLED,
    KEYS.CALLIFIED_PENDING_RETRY_ENABLED, KEYS.CALLIFIED_PENDING_RETRY_MAX_RETRIES,
    KEYS.CALLIFIED_DNP_RETRY_ENABLED, KEYS.CALLIFIED_DNP_RETRY_MAX_RETRIES,
  ];
  const [scope, rows] = await Promise.all([
    visibility(user),
    prisma.tenantSetting.findMany({ where: { tenantId, key: { in: keys } }, select: { key: true, value: true, updatedAt: true } }),
  ]);
  const settings = new Map(rows.map(({ key, value }) => [key, value]));
  const read = (key) => settings.get(key) ?? DEFAULTS[key];
  const enabled = (key) => /^(1|true)$/i.test(String(read(key)));
  const stoppedAt = enabled(pauseKey) ? rows.find(row => row.key === pauseKey)?.updatedAt : null;
  const base = { tenantId, ...scope, status: 'Lead', deletedAt: null, phone: { not: null }, callifiedCampaignId: { not: null } };
  const retry = async (status, enabledKey, limitKey) => {
    const maxRetries = Math.max(1, Math.min(Number(read(limitKey)) || 3, 10));
    const criteria = { ...base, callifiedLeadStatus: status, callifiedDnpRetryCount: { lt: maxRetries },
      ...(stoppedAt && { callifiedLeadStatusUpdatedAt: { gt: stoppedAt } }) };
    if (toolbar) {
      return enabled(enabledKey) ? prisma.contact.count({ where: { ...criteria, callifiedDnpNextRetryAt: { not: null } } }) : 0;
    }
    const [due, upcoming, waiting, entries] = await Promise.all([
      prisma.contact.count({ where: { ...criteria, callifiedDnpNextRetryAt: { lte: now } } }),
      prisma.contact.count({ where: { ...criteria, callifiedDnpNextRetryAt: { gt: now } } }),
      prisma.contact.count({ where: { ...criteria, callifiedDnpNextRetryAt: null } }),
      prisma.contact.findMany({
        where: { ...criteria, callifiedDnpNextRetryAt: { not: null } },
        select: { id: true, name: true, callifiedDnpNextRetryAt: true, callifiedDnpRetryCount: true },
        orderBy: [{ callifiedDnpNextRetryAt: 'asc' }, { id: 'asc' }], take: 5,
      }),
    ]);
    return { enabled: enabled(enabledKey), maxRetries, due, upcoming, waiting, entries };
  };
  const [pending, dnp, calls] = await Promise.all([
    retry('pending', KEYS.CALLIFIED_PENDING_RETRY_ENABLED, KEYS.CALLIFIED_PENDING_RETRY_MAX_RETRIES),
    retry('dnp', KEYS.CALLIFIED_DNP_RETRY_ENABLED, KEYS.CALLIFIED_DNP_RETRY_MAX_RETRIES),
    liveCalls(user, scope),
  ]);
  const localQueue = require('./callifiedAutoDialQueue').getNewLeadQueueCounts(tenantId, scope.assignedToId ?? null);
  if (toolbar) return { activeCalls: calls.length, latestCallAt: calls[0]?.createdAt, paused: enabled(pauseKey), stoppedAt,
    upcoming: pending + dnp + localQueue.queued };
  const entries = [...pending.entries, ...dnp.entries];
  if (entries.length) {
    const deferred = await prisma.auditLog.findMany({
      where: { tenantId, entity: 'CallifiedRetry', action: 'DEFERRED', entityId: { in: entries.map(({ id }) => id) } },
      select: { entityId: true, details: true },
      orderBy: { id: 'desc' }, take: 30,
    });
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    for (const { entityId, details } of deferred) {
      try {
        const entry = byId.get(entityId);
        const { code, nextRetryAt, message } = JSON.parse(details);
        if (entry && !entry.retryFailure && Date.parse(nextRetryAt) === new Date(entry.callifiedDnpNextRetryAt).getTime()
            && /^[A-Z][A-Z0-9_]{1,49}$/.test(code)) {
          entry.retryFailure = code;
          if (typeof message === 'string') entry.retryFailureMessage = message.slice(0, 250);
        }
      } catch {
        // An older audit entry may not carry structured retry details.
      }
    }
  }
  return {
    serverTime: now.toISOString(), timezone: read(KEYS.CALLIFIED_RETRY_TIMEZONE) || 'UTC',
    workerEnabled: process.env.DISABLE_CALLIFIED_AUTOMATION !== '1',
    paused: enabled(pauseKey), stoppedAt,
    pending, dnp, activeCalls: calls.length, calls,
    autoDial: { enabled: enabled(KEYS.CALLIFIED_AUTO_DIAL_NEW_LEADS_ENABLED), ...localQueue },
  };
}

function audienceWhere(tenantId, audience) {
  if (audience.byStatus) {
    return {
      tenantId, status: 'Lead', deletedAt: null, callifiedCampaignId: { not: null },
      phone: { not: '' },
      OR: [
        { callifiedLeadStatus: { in: audience.matchingStatuses } },
        ...(audience.statuses.includes('yet_to_call') ? [{ callifiedLeadStatus: null }] : []),
      ],
    };
  }
  return {
    tenantId, status: 'Lead', deletedAt: null,
    ...(audience.contactIds.length ? { id: { in: audience.contactIds } } : { callifiedCampaignId: { in: audience.campaignIds } }),
    // Include legacy aliases; normalize again immediately before dialing.
    OR: [{ callifiedLeadStatus: null }, { callifiedLeadStatus: { notIn: ['qualified', 'hot', 'connected'] } }],
  };
}

async function previewSelection(user, body) {
  const { contactIds, statuses } = parseAudience({ contactIds: body.contactIds, statuses: body.statuses });
  const leads = await prisma.contact.findMany({
    where: { tenantId: user.tenantId, status: 'Lead', deletedAt: null, id: { in: contactIds }, ...await visibility(user) },
    select: { id: true, phone: true, callifiedCampaignId: true, callifiedLeadStatus: true },
  });
  const withPhone = leads.filter((lead) => lead.phone);
  const eligibleIds = withPhone.filter((lead) =>
    lead.callifiedCampaignId && statuses.includes(normalizeLeadStatus(lead.callifiedLeadStatus)),
  ).map((lead) => lead.id);
  return { eligibleIds, withPhone: withPhone.length, missingPhone: leads.length - withPhone.length, unavailable: contactIds.length - leads.length };
}

async function createJob(user, body) {
  const audience = parseAudience(body);
  const { scheduledAt, ...selection } = audience;
  selection.runType = body.scheduledAt ? 'scheduled' : selection.contactIds.length === 1 ? 'single' : 'run';
  if (body.scheduledAt) selection.timezone = await getSetting(user.tenantId, KEYS.CALLIFIED_RETRY_TIMEZONE, { fallback: 'UTC' }) || 'UTC';
  const scope = await visibility(user);
  if (selection.runType === 'single') {
    const lead = await prisma.contact.findFirst({where:{tenantId:user.tenantId,id:selection.contactIds[0],...scope},select:{name:true}});
    selection.title = lead?.name;
  }
  if (selection.byStatus) {
    const groups = await prisma.contact.groupBy({
      by: ['callifiedLeadStatus'], where: { tenantId: user.tenantId, deletedAt: null, status: 'Lead', ...scope },
    });
    selection.matchingStatuses = groups.map(group => group.callifiedLeadStatus)
      .filter(value => value !== null && selection.statuses.includes(normalizeLeadStatus(value)));
  }
  const where = { ...audienceWhere(user.tenantId, selection), ...scope };
  const last = await prisma.contact.findFirst({ where, orderBy: { id: 'desc' }, select: { id: true } });
  if (!last) throw fail('No eligible leads match this selection.');
  const total = await prisma.contact.count({ where: { AND: [where, { id: { lte: last.id } }] } });
  const job = await prisma.$transaction(async (tx) => {
    // A tenant row lock serializes admission across API instances.
    await tx.tenant.update({ where: { id: user.tenantId }, data: { id: user.tenantId } });
    if (await tx.leadDialJob.count({ where: { tenantId: user.tenantId, status: { in: ACTIVE } } }) >= 20) {
      throw fail('There are already 20 queued runs. Finish or cancel one first.', 'DIAL_QUEUE_FULL', 409);
    }
    return tx.leadDialJob.create({ data: {
      tenantId: user.tenantId, userId: user.userId || user.id,
      audience: JSON.stringify({ ...selection, scheduled: Boolean(body.scheduledAt) }), scheduledAt, upperBoundId: last.id, total,
    } });
  });
  await writeAudit('LeadDialJob', 'CREATE', job.id, job.userId, job.tenantId, { total, scheduledAt });
  return job;
}

async function cancelJob(tenantId, id) {
  const job = await prisma.leadDialJob.findFirst({ where: { id: Number(id), tenantId } });
  if (!job) throw fail('Dial run not found.', 'JOB_NOT_FOUND', 404);
  // Stop only remaining work. Calls already submitted finish normally.
  await prisma.leadDialJob.updateMany({ where: { id: job.id, tenantId, status: { in: [...ACTIVE, 'paused','stopped'] } }, data: { status: 'cancelled' } });
  return { cancelled: true, currentCallContinues: Boolean(job.activeCallLogId || job.dispatching) };
}

async function claimJob(candidate) {
  return prisma.$transaction(async (tx) => {
    await tx.tenant.update({ where: { id: candidate.tenantId }, data: { id: candidate.tenantId } });
    const busy = await tx.leadDialJob.findFirst({ where: {
      tenantId: candidate.tenantId, status: 'running',
      OR: [{ id: { not: candidate.id } }, { leaseUntil: { gt: new Date() } }],
    } });
    if (busy) return null;
    const claimed = await tx.leadDialJob.updateMany({ where: {
      id: candidate.id, tenantId: candidate.tenantId, status: { in: ACTIVE },
      OR: [{ leaseUntil: null }, { leaseUntil: { lte: new Date() } }],
    }, data: { status: 'running', leaseUntil: new Date(Date.now() + 120_000) } });
    return claimed.count ? tx.leadDialJob.findUnique({ where: { id: candidate.id } }) : null;
  });
}

async function processJob(job) {
  const where = { id: job.id, tenantId: job.tenantId, status: 'running' };
  try {
    const paused = await prisma.tenantSetting.findUnique({ where: { tenantId_key: { tenantId: job.tenantId, key: 'feature.callified.dialing_paused' } } });
    const restart = JSON.parse(job.audience).restartedAt;
    const requestedAt = restart ? new Date(restart) : job.createdAt;
    if (paused?.value === 'true' && !(requestedAt > paused.updatedAt)) return;
    const user = await prisma.user.findFirst({ where: { id: job.userId, tenantId: job.tenantId, deactivatedAt: null } });
    if (!user || !await permissions.userHasPermission({ ...user, userId: user.id }, 'leads', 'write')) throw fail('The operator no longer has permission to dial.', 'PERMISSION_REVOKED');
    if (job.dispatching && !job.activeCallLogId) throw fail('The previous dial was interrupted before confirmation. Check call history before starting a new run.', 'DIAL_CONFIRMATION_UNKNOWN');
    if (job.activeCallLogId) {
      const { confirmedOutcome, attemptStatus, classificationFields } = require('./callifiedAttemptStatus');
      let call = await prisma.callLog.findFirst({ where: { id: job.activeCallLogId, tenantId: job.tenantId },
        include: { contact: { select: classificationFields } } });
      const classified = call && confirmedOutcome(call);
      const resolvedStatus = call && attemptStatus(call, classified);
      if (classified && call.status !== resolvedStatus) {
        const changed = await prisma.callLog.updateMany({ where: { tenantId: job.tenantId, id: call.id, status: call.status }, data: { status: resolvedStatus } });
        if (!changed.count) return;
        call.status = resolvedStatus;
      }
      if (call && !classified && !['CANCELLED', 'FAILED'].includes(call.status)) {
        const details = await client.fetchAndStoreCallDetails({ tenantId: job.tenantId, callifiedLeadId: call.providerCallId, contactId: call.contactId, initiatedAt: call.createdAt });
        call = await prisma.callLog.findFirst({ where: { id: call.id, tenantId: job.tenantId } });
        // The provider returns the lead's entire transcript history. An older
        // completed attempt is not proof that this run's current call ended.
        const currentAttempt = (details?.transcripts || []).some((transcript) =>
          Date.parse(transcript.created_at || transcript.createdAt) >= new Date(call.createdAt).getTime() - 2000);
        const providerLeadMissing = call.status === 'FAILED' && /\b404\b|lead not found|not found/i.test(details?.fetchError || '');
        if (!currentAttempt && !providerLeadMissing && call.status !== 'CANCELLED') {
          await prisma.callLog.updateMany({ where: { id: call.id, tenantId: job.tenantId, status: { not: 'CANCELLED' } }, data: { status: 'INITIATED' } });
          call.status = 'INITIATED';
        }
        if (!TERMINAL_CALL.includes(call.status)) {
          if (Date.now() - new Date(call.createdAt).getTime() > 10 * 60_000) {
            throw fail('Call completion could not be confirmed. Check the active call before starting another run.', 'CALL_COMPLETION_UNKNOWN');
          }
          return; // Keep one active call per tenant job lane.
        }
      }
      let outcome = classified || (call?.status === 'MISSED' ? 'dnp' : null);
      if (call?.contactId && !classified && !['CANCELLED', 'FAILED'].includes(call.status)) {
        const contact = await prisma.contact.findFirst({ where: { id: call.contactId, tenantId: job.tenantId } });
        if (contact && !isManualLeadStatus(contact) && normalizeLeadStatus(contact.callifiedLeadStatus) !== 'qualified') {
          const result = await classifyLeadStatus(job.tenantId, call.contactId, { userId: job.userId });
          if (!preserveRetryStatus(contact.callifiedLeadStatus, result.status)) {
            const changed = await prisma.contact.updateMany({
              where: { id: call.contactId, tenantId: job.tenantId, ...leadStatusVersion(contact) },
              data: automaticLeadStatusData(contact, result),
            });
            if (changed.count) {
              if (['qualified', 'pending', 'junk', 'dnp'].includes(result.status)) outcome = result.status;
              if (result.status === 'qualified') await assignQualifiedLeadRoundRobin(job.tenantId, call.contactId, result.status);
              if (result.status === 'dnp' || result.status === 'pending') {
                const { scheduleDnpRetry, schedulePendingRetry } = require('./callifiedDnpRetryEngine');
                const scheduleRetry = result.status === 'dnp' ? scheduleDnpRetry : schedulePendingRetry;
                await scheduleRetry(job.tenantId, call.contactId).catch((error) => {
                  console.error(`[callified] unable to schedule retry for contact ${call.contactId}:`, error.message);
                });
              }
            }
          }
        }
      }
      const resultCount = !call || call.status === 'CANCELLED' ? 'skipped' : call.status === 'FAILED' ? 'failed' : 'completed';
      const data = { activeCallLogId: null, [resultCount]: { increment: 1 } };
      if (job.cursorId === job.upperBoundId && job.upperBoundId > 0) data.status = 'completed';
      if (outcome) {
        const audience = JSON.parse(job.audience);
        audience.outcomes ||= {};
        audience.outcomes[outcome] = (audience.outcomes[outcome] || 0) + 1;
        data.audience = JSON.stringify(audience);
      }
      const finished = await prisma.leadDialJob.updateMany({ where: { ...where, activeCallLogId: job.activeCallLogId }, data });
      if (finished.count && outcome) await writeAudit('LeadDialOutcome', outcome, call.id, job.userId, job.tenantId, { runId: job.id });
      return;
    }
    const audience = JSON.parse(job.audience);
    const scope = await visibility(user);
    const filters = audienceWhere(job.tenantId, audience);
    let cursor = job.cursorId;
    let skipped = 0;
    let lead;
    let campaignId;
    // Skip up to ten unsuitable contacts per tick without increasing the
    // number of calls submitted. The cursor keeps the workload bounded.
    const scanLimit = 10;
    const candidates = await prisma.contact.findMany({
      where: { AND: [filters, scope, { id: { gt: cursor, lte: job.upperBoundId } }] },
      orderBy: { id: 'asc' },
      take: scanLimit,
      select: { id: true, name: true, phone: true, callifiedCampaignId: true, callifiedLeadStatus: true, callifiedLeadStatusSource: true, callifiedLeadStatusUpdatedAt: true, callifiedDnpRetryCount: true },
    });
    for (const candidate of candidates) {
      const campaign = audience.campaignOverrideId || candidate.callifiedCampaignId;
      if (candidate.phone && campaign && audience.statuses.includes(normalizeLeadStatus(candidate.callifiedLeadStatus)) &&
          !await wasRecentlyDialed(job.tenantId, candidate.id)) {
        lead = candidate;
        campaignId = campaign;
        break;
      }
      cursor = candidate.id;
      skipped++;
    }
    if (skipped) {
      const advanced = await prisma.leadDialJob.updateMany({ where, data: { cursorId: cursor, skipped: { increment: skipped } } });
      if (!advanced.count) return;
    }
    if (!lead) {
      if (candidates.length < scanLimit) {
        await prisma.leadDialJob.updateMany({ where, data: { status: 'completed' } });
      }
      return;
    }
    // Persist cursor BEFORE external effects: a crash never blindly redials this person.
    const advanced = await prisma.leadDialJob.updateMany({ where, data: { cursorId: lead.id, dispatching: true } });
    if (!advanced.count) return;
    const stillRunning = await prisma.leadDialJob.findFirst({ where });
    if (!stillRunning) return;
    try {
      let usesRetry = false;
      const status = normalizeLeadStatus(lead.callifiedLeadStatus);
      if (audience.byStatus && (status === 'pending' || status === 'dnp')) {
        const engine = require('./callifiedDnpRetryEngine');
        const settings = status === 'pending' ? await engine.getPendingRetrySettings(job.tenantId) : await engine.getDnpRetrySettings(job.tenantId);
        usesRetry = settings.enabled && lead.callifiedDnpRetryCount < settings.maxRetries;
      }
      const result = await client.initiateCallForContact({ tenantId: job.tenantId, contactId: lead.id, campaignId, userId: job.userId, requestedAt, interest: 'Scheduled CRM dial run' });
      await prisma.contact.updateMany({ where: { id: lead.id, tenantId: job.tenantId, ...leadStatusVersion(lead) }, data: {
        callifiedLeadStatus: 'connected', callifiedLeadStatusSource: 'dial_run',
        callifiedLeadStatusReason: 'Dial run call in progress.', callifiedLeadStatusUpdatedAt: new Date(),
        callifiedDnpNextRetryAt: null,
        ...(usesRetry && { callifiedDnpRetryCount: { increment: 1 } }),
      } });
      await prisma.leadDialJob.updateMany({ where: { id: job.id, tenantId: job.tenantId }, data: {
        activeCallLogId: result.callLogId, dispatching: false,
        ...(!audience.firstDialAt && { audience: JSON.stringify({ ...audience, firstDialAt: new Date().toISOString() }) }),
      } });
      await writeAudit('LeadDialJob', 'DIAL', job.id, job.userId, job.tenantId, { contactId: lead.id, callLogId: result.callLogId, name: lead.name, phone: lead.phone });
    } catch (error) {
      if (['CONTACT_NOT_FOUND', 'LEAD_ALREADY_QUALIFIED', 'LEAD_CALL_ACTIVE', 'LEAD_CALL_LOCKED'].includes(error.code)) {
        await prisma.leadDialJob.updateMany({ where, data: { skipped: { increment: 1 }, dispatching: false } });
        return;
      }
      await prisma.leadDialJob.updateMany({ where, data: { failed: { increment: 1 }, status: 'paused', dispatching: false, error: String(error.message || 'Dial failed.').slice(0, 1500) } });
    }
  } catch (error) {
    await prisma.leadDialJob.updateMany({ where, data: { status: 'paused', error: String(error.message || 'Dial processing paused.').slice(0, 1500) } });
  } finally {
    await prisma.leadDialJob.updateMany({ where: { id: job.id, tenantId: job.tenantId, leaseUntil: job.leaseUntil }, data: { leaseUntil: null } });
  }
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const jobs = await prisma.leadDialJob.findMany({
      where: { status: { in: ACTIVE }, scheduledAt: { lte: new Date() } },
      // A running job owns the tenant's lane. Advance it before considering
      // any scheduled job, even if that job has an earlier scheduled time.
      orderBy: [{ status: 'asc' }, { scheduledAt: 'asc' }, { id: 'asc' }],
      take: 40,
    });
    const tenants = new Map();
    for (const candidate of jobs) if (!tenants.has(candidate.tenantId)) tenants.set(candidate.tenantId, candidate);
    // Slow providers in one workspace must not block every other tenant.
    await require('./boundedWork').mapBounded([...tenants.values()], 3, async (candidate) => {
      const job = await claimJob(candidate);
      if (job) await processJob(job);
    });
  } catch (error) { console.error('[lead-dial] worker:', error.message); }
  finally { ticking = false; }
}

function start() {
  if (!timer) { timer = setInterval(tick, 5000); timer.unref?.(); }
}
function stop() { clearInterval(timer); timer = null; }

module.exports = { parseAudience, audienceWhere, visibility, previewSelection, liveCalls, getDialQueueSnapshot, createJob, cancelJob, processJob, claimJob, tick, start, stop };
