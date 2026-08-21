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
const {
  CALL_STATUS,
  classifyLeadStatus,
  assignQualifiedLeadRoundRobin,
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

function enqueue({ tenantId, contactId, campaignId, userId }) {
  if (!tenantId || !contactId || !campaignId) {
    console.log("[callifiedAutoDial] enqueue skipped: missing tenantId/contactId/campaignId", {
      tenantId,
      contactId,
      campaignId,
    });
    return;
  }

  // Deduplicate: only one pending auto-dial per contact (queued or in-flight).
  const key = dialKey(tenantId, contactId);
  const existing = queue.find(
    (item) => item.contactId === Number(contactId) && item.tenantId === Number(tenantId),
  );
  if (existing || inFlight.has(key)) {
    console.log(`[callifiedAutoDial] duplicate enqueue skipped for contact ${contactId}`);
    return;
  }

  queue.push({
    tenantId: Number(tenantId),
    contactId: Number(contactId),
    campaignId: Number(campaignId),
    userId: userId ? Number(userId) : null,
    enqueuedAt: Date.now(),
    attempts: 0,
  });
  console.log(
    `[callifiedAutoDial] enqueued contact ${contactId} (tenant ${tenantId}, campaign ${campaignId})`,
  );
  wakeProcessor();
}

/**
 * Poll the fresh Callified call details for a contact and classify the outcome.
 *
 * The call happens asynchronously after initiateCallForContact returns, so we
 * wait an initial delay and then poll until transcripts/reviews are available
 * or the call reaches a terminal state. This prevents Gemini from classifying
 * an in-progress call as Junk before the person even answers.
 */
async function runDelayedClassification(tenantId, contactId, userId, attempt = 1) {
  try {
    const classification = await classifyLeadStatus(tenantId, contactId, { userId });

    // If there is still no review/transcript data, keep polling unless we've
    // exhausted the retry budget.
    const stillPending =
      classification.status === CALL_STATUS.YET_TO_CALL &&
      classification.source === "score" &&
      /No Callified review data available yet|No Callified call has been made/i.test(
        classification.reason || "",
      );

    if (stillPending && attempt < CLASSIFY_MAX_ATTEMPTS) {
      setTimeout(
        () => runDelayedClassification(tenantId, contactId, userId, attempt + 1),
        CLASSIFY_POLL_INTERVAL_MS,
      );
      console.log(
        `[callifiedAutoDial] classification pending for contact ${contactId}, will retry (attempt ${attempt}/${CLASSIFY_MAX_ATTEMPTS})`,
      );
      return;
    }

    await prisma.contact.update({
      where: { id: contactId },
      data: {
        callifiedLeadStatus: classification.status,
        callifiedLeadStatusSource: classification.source,
        callifiedLeadStatusReason: classification.reason,
        callifiedLeadStatusUpdatedAt: new Date(),
      },
    });

    if (classification.status === CALL_STATUS.QUALIFIED) {
      await assignQualifiedLeadRoundRobin(tenantId, contactId, classification.status);
      await getDnpRetryEngine().clearDnpRetryState(contactId).catch(() => {});
    } else if (classification.status === CALL_STATUS.JUNK) {
      await getDnpRetryEngine().clearDnpRetryState(contactId).catch(() => {});
    } else if (classification.status === CALL_STATUS.DNP) {
      await getDnpRetryEngine().scheduleDnpRetry(tenantId, contactId).catch((e) => {
        console.error(`[callifiedAutoDial] scheduleDnpRetry failed for contact ${contactId}:`, e.message);
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

function scheduleDelayedClassification(tenantId, contactId, userId) {
  setTimeout(() => runDelayedClassification(tenantId, contactId, userId, 1), CLASSIFY_INITIAL_DELAY_MS);
}

async function processNext() {
  if (isProcessing || queue.length === 0) return;
  isProcessing = true;

  const item = queue.shift();
  const { tenantId, contactId, campaignId, userId } = item;
  const key = dialKey(tenantId, contactId);
  inFlight.add(key);

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
        assignedToId: true,
      },
    });
    if (!isDialable(contact)) {
      console.log(`[callifiedAutoDial] contact ${contactId} no longer dialable; skipping`);
      return;
    }

    // Cooldown guard: don't redial a lead that was just called (e.g. imported
    // twice in rapid succession).
    if (await wasRecentlyDialed(tenantId, contactId)) {
      console.log(`[callifiedAutoDial] contact ${contactId} was recently dialed; skipping`);
      return;
    }

    // Mark the lead as "connecting" before dialing so the UI doesn't show a
    // stale "Yet to call" or a premature classification while Callified is
    // still ringing the callee.
    const priorStatus = contact.callifiedLeadStatus || CALL_STATUS.YET_TO_CALL;
    item.priorStatus = priorStatus;
    await prisma.contact.update({
      where: { id: contactId },
      data: {
        callifiedLeadStatus: CALL_STATUS.CONNECTED,
        callifiedLeadStatusSource: "auto_dial",
        callifiedLeadStatusReason: "Auto-dial in progress.",
        callifiedLeadStatusUpdatedAt: new Date(),
      },
    });

    console.log(
      `[callifiedAutoDial] dialing contact ${contactId} (campaign ${campaignId}, attempt ${item.attempts})`,
    );
    await callifiedClient.initiateCallForContact({
      tenantId,
      contactId,
      campaignId,
      userId,
      interest: "Auto-dial on lead creation",
    });
    console.log(`[callifiedAutoDial] dialed contact ${contactId} successfully`);

    // Calls complete asynchronously. Poll for transcripts/reviews instead of
    // classifying immediately, which avoids Gemini scoring an empty transcript
    // as Junk before the person answers.
    scheduleDelayedClassification(tenantId, contactId, userId);
  } catch (e) {
    console.error(`[callifiedAutoDial] failed to dial contact ${contactId}:`, e.message);

    // Retry transient failures a few times within the first 10 minutes.
    // Remove from inFlight so the retried item can be re-enqueued cleanly.
    if (
      item.attempts < MAX_RETRY_ATTEMPTS &&
      Date.now() - item.enqueuedAt < MAX_RETRY_AGE_MS
    ) {
      inFlight.delete(key);
      // Restore the previous dialable status so the retry is not rejected by
      // isDialable (which refuses to redial connected/qualified/junk leads).
      try {
        await prisma.contact.update({
          where: { id: contactId },
          data: {
            callifiedLeadStatus: item.priorStatus || CALL_STATUS.YET_TO_CALL,
            callifiedLeadStatusSource: "auto_dial",
            callifiedLeadStatusReason: "Transient dial failure; will retry.",
            callifiedLeadStatusUpdatedAt: new Date(),
          },
        });
      } catch (restoreErr) {
        console.error(`[callifiedAutoDial] failed to restore status for retry contact ${contactId}:`, restoreErr.message);
      }
      queue.push(item);
    }
  } finally {
    isProcessing = false;
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

module.exports = {
  enqueue,
  startProcessor,
  stopProcessor,
  getQueueLength,
  isDialable,
};
