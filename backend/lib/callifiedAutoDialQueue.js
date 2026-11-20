/**
 * Fire-and-forget auto-dial queue for new CRM Leads.
 *
 * Any newly-created Lead that has a Callified campaign and a phone number is
 * enqueued here. The queue drains one lead at a time so that multiple
 * simultaneous arrivals are still dialled sequentially (matching the manual
 * "Dial Campaigns" one-by-one behaviour).
 *
 * After a successful dial the lead is immediately classified
 * (Qualified/Junk/DNP) and, if Qualified, round-robin assigned to active staff.
 * Failures are logged and retried a limited number of times.
 */

const prisma = require("./prisma");
const callifiedClient = require("../services/callifiedClient");
const { writeAudit } = require("./audit");
const { friendlyProviderMessage, mapCallifiedError } = require("./callifiedErrors");
const {
  CALL_STATUS,
  classifyLeadStatus,
  assignQualifiedLeadRoundRobin,
  isManualLeadStatus,
  leadStatusVersion,
  preserveRetryStatus,
  automaticLeadStatusData,
} = require("./callifiedLeadStatus");

/**
 * Lazy accessor for the DNP retry engine to avoid a circular require with the
 * engine, which also needs to enqueue leads back into this queue.
 */
function getDnpRetryEngine() {
  return require("./callifiedDnpRetryEngine");
}

const queue = [];
const inFlight = new Set();
let isProcessing = false;
let processorInterval = null;
let wakeTimeout = null;
let submitting = null;

const PROCESS_INTERVAL_MS = Number(process.env.CALLIFIED_AUTO_DIAL_INTERVAL_MS) || 3000;
const INTER_CALL_DELAY_MS = Number(process.env.CALLIFIED_AUTO_DIAL_DELAY_MS) || 800;
const MAX_RETRY_ATTEMPTS = 3;
const MAX_RETRY_AGE_MS = 10 * 60 * 1000; // 10 minutes
const CLASSIFY_INITIAL_DELAY_MS = Number(process.env.CALLIFIED_AUTO_DIAL_CLASSIFY_DELAY_MS) || 45_000;
const CLASSIFY_POLL_INTERVAL_MS = Number(process.env.CALLIFIED_AUTO_DIAL_CLASSIFY_POLL_MS) || 30_000;
const CLASSIFY_MAX_ATTEMPTS = Number(process.env.CALLIFIED_AUTO_DIAL_CLASSIFY_ATTEMPTS) || 10;

function dialKey(tenantId, contactId) {
  return `${tenantId}:${contactId}`;
}

const DIALABLE_CALL_STATUSES = new Set([
  CALL_STATUS.YET_TO_CALL,
  CALL_STATUS.DNP,
  CALL_STATUS.PENDING,
]);

function isDialable(contact) {
  // A fresh lead (no status yet) is treated as "yet to call". Leads that have
  // already been qualified, junked, or are currently showing as connected must
  // not be auto-redialed by this queue. DNP leads are allowed because they
  // are explicitly re-enqueued by the DNP retry engine.
  const leadStatus = contact?.callifiedLeadStatus || CALL_STATUS.YET_TO_CALL;
  return !!(
    contact &&
    contact.status === "Lead" &&
    contact.callifiedCampaignId != null &&
    contact.phone &&
    DIALABLE_CALL_STATUSES.has(leadStatus)
  );
}

async function wasRecentlyDialed(tenantId, contactId, sinceMs = 60 * 1000) {
  const since = new Date(Date.now() - sinceMs);
  const recent = await prisma.callLog.findFirst({
    where: {
      tenantId,
      contactId: Number(contactId),
      provider: "callified",
      createdAt: { gte: since },
    },
    orderBy: { createdAt: "desc" },
  });
  return Boolean(recent);
}

function enqueue({ tenantId, contactId, campaignId, userId, retryAttempt = false, retrySchedule = null }) {
  if (!tenantId || !contactId || !campaignId) {
    console.log("[callifiedAutoDial] enqueue skipped: missing tenantId/contactId/campaignId", {
      tenantId,
      contactId,
      campaignId,
    });
    return false;
  }

  // Deduplicate: only one pending auto-dial per contact (queued or in-flight).
  const key = dialKey(tenantId, contactId);
  const existing = queue.find(
    (item) => item.contactId === Number(contactId) && item.tenantId === Number(tenantId),
  );
  if (existing || inFlight.has(key)) {
    console.log(`[callifiedAutoDial] duplicate enqueue skipped for contact ${contactId}`);
    return false;
  }

  queue.push({
    tenantId: Number(tenantId),
    contactId: Number(contactId),
    campaignId: Number(campaignId),
    userId: userId ? Number(userId) : null,
    retryAttempt: Boolean(retryAttempt),
    retrySchedule,
    enqueuedAt: Date.now(),
    attempts: 0,
  });
  console.log(
    `[callifiedAutoDial] enqueued contact ${contactId} (tenant ${tenantId}, campaign ${campaignId})`,
  );
  wakeProcessor();
  return true;
}

/**
 * Poll the fresh Callified call details for a contact and classify the outcome.
 *
 * The call happens asynchronously after initiateCallForContact returns, so we
 * wait an initial delay and then poll until transcripts/reviews are available
 * or the call reaches a terminal state. This prevents Gemini from classifying
 * an in-progress call as Junk before the person even answers.
 */
async function runDelayedClassification(tenantId, contactId, userId, attempt = 1, callLogId) {
  try {
    const where = { id: contactId, tenantId };
    const contact = await prisma.contact.findUnique({ where });
    if (!contact || isManualLeadStatus(contact)) return;
    const classification = await classifyLeadStatus(tenantId, contactId, { userId });

    // If there is still no review/transcript data, keep polling unless we've
    // exhausted the retry budget.
    const stillPending =
      classification.status === CALL_STATUS.CONNECTED ||
      (classification.status === CALL_STATUS.YET_TO_CALL &&
      classification.source === "score" &&
      /No Callified review data available yet|No Callified call has been made/i.test(
        classification.reason || "",
      ));

    if (stillPending && attempt < CLASSIFY_MAX_ATTEMPTS) {
      setTimeout(
        () => runDelayedClassification(tenantId, contactId, userId, attempt + 1, callLogId),
        CLASSIFY_POLL_INTERVAL_MS,
      );
      console.log(
        `[callifiedAutoDial] classification pending for contact ${contactId}, will retry (attempt ${attempt}/${CLASSIFY_MAX_ATTEMPTS})`,
      );
      return;
    }

    if (preserveRetryStatus(contact.callifiedLeadStatus, classification.status)) return;
    const changed = await prisma.contact.updateMany({
      where: { ...where, ...leadStatusVersion(contact) },
      data: automaticLeadStatusData(contact, classification),
    });
    if (!changed.count) return;
    if (callLogId) await require('./callifiedAttemptStatus').recordStandaloneOutcome(tenantId, contactId, classification.status, userId, new Date(), callLogId);

    if (classification.status === CALL_STATUS.QUALIFIED) {
      await assignQualifiedLeadRoundRobin(tenantId, contactId, classification.status);
    } else if (classification.status === CALL_STATUS.DNP) {
      await getDnpRetryEngine().scheduleDnpRetry(tenantId, contactId).catch((e) => {
        console.error(`[callifiedAutoDial] scheduleDnpRetry failed for contact ${contactId}:`, e.message);
      });
    } else if (classification.status === CALL_STATUS.PENDING) {
      await getDnpRetryEngine().schedulePendingRetry(tenantId, contactId).catch((e) => {
        console.error(`[callifiedAutoDial] schedulePendingRetry failed for contact ${contactId}:`, e.message);
      });
    }

    console.log(
      `[callifiedAutoDial] classified contact ${contactId} as ${classification.status} (attempt ${attempt})`,
    );
  } catch (classifyErr) {
    console.error(
      `[callifiedAutoDial] delayed classification failed for contact ${contactId} (attempt ${attempt}):`,
      classifyErr.message,
    );
  }
}

function scheduleDelayedClassification(tenantId, contactId, userId, callLogId) {
  setTimeout(() => runDelayedClassification(tenantId, contactId, userId, 1, callLogId), CLASSIFY_INITIAL_DELAY_MS);
}

async function processNext() {
  if (isProcessing || queue.length === 0) return;
  isProcessing = true;

  const item = queue.shift();
  submitting = item;
  const { tenantId, contactId, campaignId, userId } = item;
  const key = dialKey(tenantId, contactId);
  inFlight.add(key);
  let retryPolicy;

  try {
    item.attempts += 1;

    // Re-read the contact at process time. If it was deleted, converted, or
    // lost its campaign/phone, skip it silently.
    const contact = await prisma.contact.findUnique({
      where: { id: contactId },
      select: {
        id: true,
        tenantId: true,
        status: true,
        phone: true,
        callifiedCampaignId: true,
        callifiedLeadStatus: true,
        callifiedLeadStatusSource: true,
        callifiedLeadStatusUpdatedAt: true,
        callifiedDnpNextRetryAt: true,
        callifiedDnpRetryCount: true,
        assignedToId: true,
      },
    });
    if (!isDialable(contact)) {
      console.log(`[callifiedAutoDial] contact ${contactId} no longer dialable; skipping`);
      return;
    }
    if (!item.retryAttempt && contact.callifiedDnpNextRetryAt) return;

    if (item.retrySchedule) {
      const { status, dueAt } = item.retrySchedule;
      if (contact.tenantId !== tenantId || contact.callifiedLeadStatus !== status ||
          contact.callifiedCampaignId !== campaignId || !contact.callifiedDnpNextRetryAt ||
          new Date(contact.callifiedDnpNextRetryAt).getTime() !== new Date(dueAt).getTime()) return;
      const engine = getDnpRetryEngine();
      retryPolicy = status === CALL_STATUS.PENDING
        ? await engine.getPendingRetrySettings(tenantId)
        : await engine.getDnpRetrySettings(tenantId);
      if (!retryPolicy.enabled || contact.callifiedDnpRetryCount >= retryPolicy.maxRetries) return;
    }

    // Cooldown guard: don't redial a lead that was just called (e.g. imported
    // twice in rapid succession).
    if (await wasRecentlyDialed(tenantId, contactId)) {
      console.log(`[callifiedAutoDial] contact ${contactId} was recently dialed; skipping`);
      return;
    }

    console.log(
      `[callifiedAutoDial] dialing contact ${contactId} (campaign ${campaignId}, attempt ${item.attempts})`,
    );
    const submission = await callifiedClient.initiateCallForContact({
      historyType: item.retrySchedule?.status || (item.retryAttempt ? 'dnp' : 'auto'),
      tenantId,
      contactId,
      campaignId,
      userId,
      interest: item.retrySchedule ? `${item.retrySchedule.status === CALL_STATUS.PENDING ? "Pending" : "DNP"} retry` : "Auto-dial on lead creation",
      requestedAt: item.retrySchedule ? contact.callifiedLeadStatusUpdatedAt : item.enqueuedAt,
    });
    const changed = await prisma.contact.updateMany({
      where: { id: contactId, tenantId, ...leadStatusVersion(contact) },
      data: {
        // Rejected submissions and safety skips do not use a retry.
        ...(item.retryAttempt ? { callifiedDnpRetryCount: { increment: 1 }, callifiedDnpNextRetryAt: null } : {}),
        callifiedLeadStatus: CALL_STATUS.CONNECTED,
        callifiedLeadStatusSource: 'auto_dial',
        callifiedLeadStatusReason: 'Auto-dial in progress.',
        callifiedLeadStatusUpdatedAt: new Date(),
      },
    });
    console.log(`[callifiedAutoDial] dialed contact ${contactId} successfully`);

    // Calls complete asynchronously. Poll for transcripts/reviews instead of
    // classifying immediately, which avoids Gemini scoring an empty transcript
    // as Junk before the person answers.
    if (changed.count) scheduleDelayedClassification(tenantId, contactId, userId, submission?.callLogId);
  } catch (e) {
    console.error(`[callifiedAutoDial] failed to dial contact ${contactId}:`, e.message);

    // Retry transient failures a few times within the first 10 minutes.
    // Remove from inFlight so the retried item can be re-enqueued cleanly.
    const blocked = ['DIALING_PAUSED', 'LEAD_ALREADY_QUALIFIED', 'LEAD_CALL_LOCKED', 'LEAD_CALL_ACTIVE', 'CONTACT_NOT_FOUND'].includes(e.code);
    const unconfirmed = ['TimeoutError', 'AbortError'].includes(e.name);
    const providerConflict = e.status === 409 || e.code === 'CALLIFIED_API_409';
    if (
      !blocked && !unconfirmed && !providerConflict &&
      item.attempts < MAX_RETRY_ATTEMPTS &&
      Date.now() - item.enqueuedAt < MAX_RETRY_AGE_MS
    ) {
      inFlight.delete(key);
      queue.push(item);
    } else if (!blocked && retryPolicy) {
      // Back off after exhausting queue attempts without using a call retry.
      const { status, dueAt } = item.retrySchedule;
      const refusal = friendlyProviderMessage(e.message);
      const stage = ['lead creation', 'campaign enrollment', 'dialing'].includes(e.callifiedStage) ? ` during ${e.callifiedStage}` : '';
      const diagnostic = unconfirmed
        ? { code: 'CALLIFIED_UNCONFIRMED', error: 'Callified did not confirm the previous submission.' }
        : refusal || (providerConflict
          ? { code: 'CALLIFIED_API_409', error: `Callified rejected the previous submission${stage} (HTTP 409 conflict).` }
          : mapCallifiedError(e, 'The previous retry could not be submitted to Callified.').body);
      const plannedRetryAt = getDnpRetryEngine().computeNextRetryAt(retryPolicy);
      const backoff = refusal?.code === 'CALLING_LEAD_ON_DND' ? 24 * 60 * 60_000 :
        refusal?.code === 'CALLING_OUTSIDE_HOURS' ? 30 * 60_000 : 0;
      const nextRetryAt = backoff ? new Date(Math.max(Date.now() + backoff, plannedRetryAt.getTime())) : plannedRetryAt;
      const deferred = await prisma.contact.updateMany({
        where: { id: contactId, tenantId, callifiedLeadStatus: status, callifiedDnpNextRetryAt: dueAt },
        data: { callifiedDnpNextRetryAt: nextRetryAt },
      }).catch((error) => console.error(`[callifiedAutoDial] failed to defer retry for contact ${contactId}:`, error.message));
      if (deferred?.count) {
        // Store known copy or an HTTP-status summary, never a provider response body.
        await writeAudit('CallifiedRetry', 'DEFERRED', contactId, null, tenantId, {
          code: diagnostic.code, status, dueAt, nextRetryAt,
          message: refusal || providerConflict || unconfirmed ? diagnostic.error : undefined,
        });
      }
    }
  } finally {
    isProcessing = false;
    submitting = null;
    inFlight.delete(key);
    // Drain the next item after a short pause so calls stay sequential.
    if (wakeTimeout) clearTimeout(wakeTimeout);
    wakeTimeout = setTimeout(processNext, INTER_CALL_DELAY_MS);
  }
}

function wakeProcessor() {
  if (!processorInterval) {
    // If the processor was stopped (shouldn't happen in normal runtime),
    // just process the item we have now.
    processNext();
    return;
  }
  if (!isProcessing && queue.length > 0) {
    processNext();
  }
}

function startProcessor() {
  if (processorInterval) return;
  processorInterval = setInterval(() => {
    if (!isProcessing && queue.length > 0) processNext();
  }, PROCESS_INTERVAL_MS);
  // Ensure the first enqueued item triggers immediately rather than waiting
  // for the interval tick.
  if (!isProcessing && queue.length > 0) processNext();
  console.log("[callifiedAutoDial] processor started");
}

function stopProcessor() {
  if (processorInterval) {
    clearInterval(processorInterval);
    processorInterval = null;
  }
  if (wakeTimeout) {
    clearTimeout(wakeTimeout);
    wakeTimeout = null;
  }
  inFlight.clear();
  queue.length = 0;
}

function getQueueLength() {
  return queue.length;
}

function getNewLeadQueueCounts(tenantId, userId = null) {
  const matches = (item) => item && !item.retryAttempt && item.tenantId === tenantId &&
    (userId === null || item.userId === userId);
  return { queued: queue.filter(matches).length, submitting: Number(matches(submitting) || false) };
}

function cancelTenant(tenantId) {
  for (let index = queue.length - 1; index >= 0; index--) {
    if (queue[index].tenantId === Number(tenantId)) queue.splice(index, 1);
  }
}

module.exports = {
  enqueue,
  startProcessor,
  stopProcessor,
  getQueueLength,
  getNewLeadQueueCounts,
  isDialable,
  cancelTenant,
};
