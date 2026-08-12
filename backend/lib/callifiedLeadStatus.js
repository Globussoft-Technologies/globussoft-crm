/**
 * Shared Callified lead-status helpers.
 *
 * Extracted from backend/routes/callified.js so that the classification +
 * round-robin assignment logic can be reused by the new-lead auto-dial queue
 * and by other background processors without requiring an HTTP round-trip.
 */

const prisma = require("./prisma");
const callifiedClient = require("../services/callifiedClient");
const { routeRequest, llmEnabled } = require("./llmRouter");
const { getSetting, KEYS } = require("./tenantSettings");
const { notify } = require("./notificationService");

// Canonical call-outcome statuses for the generic CRM Leads "Call Status" column.
// Legacy values "hot" / "cold" are mapped to "qualified" / "junk" on read so
// existing rows stay compatible without a schema migration.
const CALL_STATUS = {
  YET_TO_CALL: "yet_to_call",
  CONNECTED: "connected",
  DNP: "dnp",
  QUALIFIED: "qualified",
  JUNK: "junk",
};

const VALID_LEAD_STATUSES = [
  CALL_STATUS.YET_TO_CALL,
  CALL_STATUS.CONNECTED,
  CALL_STATUS.DNP,
  CALL_STATUS.QUALIFIED,
  CALL_STATUS.JUNK,
];

function normalizeLeadStatus(raw) {
  if (!raw) return CALL_STATUS.YET_TO_CALL;
  const s = String(raw).toLowerCase().trim().replace(/\s+/g, "_");
  if (s.includes("qualified") || s.includes("hot")) return CALL_STATUS.QUALIFIED;
  if (s.includes("junk") || s.includes("cold")) return CALL_STATUS.JUNK;
  if (s.includes("dnp") || s.includes("not_picked") || s.includes("no_answer") || s.includes("unanswered")) {
    return CALL_STATUS.DNP;
  }
  if (s.includes("connected") || s.includes("in_progress") || s.includes("calling")) {
    return CALL_STATUS.CONNECTED;
  }
  return CALL_STATUS.YET_TO_CALL;
}

function isTruthy(value) {
  if (value === true || value === 1) return true;
  if (typeof value === "string") {
    const s = value.toLowerCase().trim();
    return s === "true" || s === "1" || s === "yes";
  }
  return false;
}

async function fetchLatestCallReviewForContact(tenantId, contactId) {
  const logs = await prisma.callLog.findMany({
    where: { tenantId, contactId: Number(contactId), provider: "callified" },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  if (!logs || logs.length === 0) return { hasCall: false, review: null, transcript: null };

  // Collect every Callified lead id referenced by this contact's call logs.
  const leadIds = [];
  for (const log of logs) {
    let id = log.providerCallId;
    try {
      const parsed = JSON.parse(log.notes || "{}");
      if (parsed.callifiedLeadId) id = String(parsed.callifiedLeadId);
    } catch (_) {
      // ignore malformed notes
    }
    if (id && !leadIds.includes(id)) leadIds.push(id);
  }

  if (leadIds.length === 0) return { hasCall: true, log: logs[0], review: null, transcript: null };

  // For each unique lead id, pick the best transcript + review. We then keep
  // the single best pair across all of them. A transcript without a created_at
  // timestamp is still considered (fallback to the last element in the array),
  // and a review without a matching transcript is still used so that a real
  // answered call does not get misclassified as DNP just because the review
  // metadata is delayed or the transcript ordering is ambiguous.
  function getTranscriptTimestamp(t) {
    if (!t) return 0;
    const d = new Date(t.created_at || t.createdAt || 0);
    return Number.isNaN(d.getTime()) ? 0 : d.getTime();
  }
  function getReviewTimestamp(r) {
    if (!r) return 0;
    const d = new Date(r.created_at || r.createdAt || r.updated_at || r.updatedAt || 0);
    return Number.isNaN(d.getTime()) ? 0 : d.getTime();
  }
  function getLogTimestamp(log) {
    if (!log) return 0;
    const d = new Date(log.createdAt || log.created_at || 0);
    return Number.isNaN(d.getTime()) ? 0 : d.getTime();
  }
  function transcriptHasText(t) {
    return String(t?.transcript_text || t?.transcript || t?.text || "").trim().length > 0;
  }
  function parseLogNotes(log) {
    if (!log?.notes) return { transcripts: [], reviews: [] };
    try {
      const parsed = JSON.parse(log.notes);
      if (parsed && typeof parsed === "object") {
        return {
          transcripts: Array.isArray(parsed.transcripts) ? parsed.transcripts : [],
          reviews: Array.isArray(parsed.reviews) ? parsed.reviews : [],
        };
      }
    } catch (_) { /* ignore malformed notes */ }
    return { transcripts: [], reviews: [] };
  }
  function findLatestReviewForTranscript(details, latestTranscript) {
    if (!Array.isArray(details.reviews)) return null;
    const goodReviews = details.reviews.filter((r) => r && !r.error);
    if (goodReviews.length === 0) return null;
    // If there is only one usable review for this call, trust it. Callified
    // sometimes omits transcript_id on the review or returns it out of sync with
    // the transcript array, and discarding the only review makes the status flap
    // between answered-call and DNP/New on every refresh.
    if (goodReviews.length === 1) return goodReviews[0];
    // When the latest transcript has real conversation text, prefer a review
    // explicitly linked to it. A review tied to a different transcript_id is
    // likely stale and belongs to an earlier call.
    if (latestTranscript && transcriptHasText(latestTranscript)) {
      const match = goodReviews.find((r) =>
        r.transcript_id != null &&
        String(r.transcript_id) === String(latestTranscript.id),
      );
      if (match) return match;
      const orphan = goodReviews.find((r) =>
        r.transcript_id == null || r.transcriptId == null,
      );
      if (orphan) return orphan;
      return null;
    }
    // No usable transcript text: fall back to the best available review.
    return (
      goodReviews.find((r) => typeof r.quality_score === "number" && r.quality_score > 0) ||
      goodReviews[0] ||
      null
    );
  }
  function findLatestTranscript(details) {
    if (!Array.isArray(details.transcripts) || details.transcripts.length === 0) return null;
    const valid = details.transcripts.filter((t) => t && typeof t === "object");
    if (valid.length === 0) return null;
    const withCreatedAt = valid.filter((t) => t.created_at);
    if (withCreatedAt.length > 0) {
      return [...withCreatedAt].sort(
        (a, b) => getTranscriptTimestamp(b) - getTranscriptTimestamp(a),
      )[0];
    }
    // No created_at available: assume the API returned chronological order and
    // use the last transcript as the latest. This mirrors the fallback in
    // fetchAndStoreCallDetails so classification and the UI agree.
    return valid[valid.length - 1];
  }

  let bestCandidate = null;
  for (const callifiedLeadId of leadIds) {
    const logForLead = logs.find((l) => {
      let id = l.providerCallId;
      try {
        const parsed = JSON.parse(l.notes || "{}");
        if (parsed.callifiedLeadId) id = String(parsed.callifiedLeadId);
      } catch (_) { /* ignore */ }
      return id === callifiedLeadId;
    }) || logs[0];

    // Prefer live API details, but merge in the cached CallLog notes as a
    // fallback. Callified's API can return partial/out-of-sync review data on
    // repeated polls, so the notes we already stored in fetchAndStoreCallDetails
    // act as a stable secondary source.
    const notes = parseLogNotes(logForLead);
    const apiDetails = await callifiedClient.getCallDetails(tenantId, callifiedLeadId).catch((e) => {
      console.error(`[callified] getCallDetails failed for lead ${callifiedLeadId}: ${e.message}`);
      return { transcripts: [], reviews: [] };
    });
    const apiReviews = Array.isArray(apiDetails.reviews) ? apiDetails.reviews : [];
    const noteReviews = (Array.isArray(notes.reviews) ? notes.reviews : []).filter(
      (nr) => nr && !nr.error && !apiReviews.some(
        (ar) => ar.transcript_id != null && String(ar.transcript_id) === String(nr.transcript_id),
      ),
    );
    const details = { ...apiDetails, reviews: [...apiReviews, ...noteReviews] };

    const latestTranscript = findLatestTranscript(details);
    const latestReview = findLatestReviewForTranscript(details, latestTranscript);

    const candidate = {
      transcript: latestTranscript,
      review: latestReview,
      log: logForLead,
      timestamp: Math.max(
        getTranscriptTimestamp(latestTranscript),
        getReviewTimestamp(latestReview),
        getLogTimestamp(logForLead),
      ),
    };

    if (!bestCandidate) {
      bestCandidate = candidate;
      continue;
    }

    // The latest call (by log time) should always win, because that is the
    // freshest outcome. If two calls land on the same timestamp, prefer the one
    // with a real review/transcript signal.
    if (candidate.timestamp > bestCandidate.timestamp) {
      bestCandidate = candidate;
    } else if (candidate.timestamp === bestCandidate.timestamp && candidate.review && !bestCandidate.review) {
      bestCandidate = candidate;
    }
  }

  return {
    hasCall: true,
    log: bestCandidate?.log || logs[0],
    review: bestCandidate?.review || null,
    transcript: bestCandidate?.transcript || null,
  };
}

async function updateCallLogNotesWithReview(tenantId, contactId, review) {
  if (!review || !contactId) return;
  try {
    const log = await prisma.callLog.findFirst({
      where: { tenantId, contactId: Number(contactId), provider: "callified" },
      orderBy: { createdAt: "desc" },
    });
    if (!log || !log.notes) return;
    let notes = {};
    try {
      notes = JSON.parse(log.notes);
    } catch (_) {
      notes = { raw: log.notes };
    }
    if (typeof notes !== "object" || notes === null) notes = {};
    notes.reviews = [{
      transcript_id: review.transcript_id || review.transcriptId,
      sentiment: review.sentiment,
      quality_score: review.quality_score,
      summary: review.summary,
      appointment_booked: review.appointment_booked,
      what_went_well: review.what_went_well,
      what_went_wrong: review.what_went_wrong,
      coaching_insight: review.coaching_insight,
    }];
    notes.fetchedAt = new Date().toISOString();
    await prisma.callLog.update({
      where: { id: log.id },
      data: { notes: JSON.stringify(notes) },
    });
  } catch (e) {
    console.error(`[callified] updateCallLogNotesWithReview failed for contact ${contactId}: ${e.message}`);
  }
}

function fallbackClassify(review, transcript) {
  if (!review) {
    const transcriptText = transcript?.transcript_text || transcript?.transcript || transcript?.text || "";
    if (String(transcriptText).trim().length > 10) {
      return { status: CALL_STATUS.QUALIFIED, reason: "Real conversation detected; review pending." };
    }
    return { status: CALL_STATUS.YET_TO_CALL, reason: "No Callified review data available yet." };
  }
  const score = Number(review.quality_score) || 0;
  const appointment = isTruthy(review.appointment_booked);
  if (appointment) {
    return { status: CALL_STATUS.QUALIFIED, reason: `Appointment booked (score ${score}/5).` };
  }
  if (score >= 4) {
    return { status: CALL_STATUS.QUALIFIED, reason: `High Callified score ${score}/5.` };
  }
  if (score <= 2) {
    return { status: CALL_STATUS.JUNK, reason: `Low Callified score ${score}/5.` };
  }
  return { status: CALL_STATUS.JUNK, reason: `Neutral Callified score ${score}/5.` };
}

function isMissedCall(log) {
  if (!log) return false;
  const status = String(log.status || "").toLowerCase();
  return status === "missed" || status === "failed" || status === "no_answer" || status === "busy";
}

function isActiveCall(log) {
  if (!log) return false;
  const status = String(log.status || "").toLowerCase();
  // A live conversation is always active regardless of age.
  if (status === "in_progress" || status === "connected" || status === "in_call" || status === "calling") return true;
  // Ringing/dialing/initiated states are only "connecting" for a short window.
  // After that, the call clearly did not connect and should fall through to DNP.
  if (status === "initiated" || status === "dialing" || status === "ringing") {
    const createdAt = log?.createdAt ? new Date(log.createdAt).getTime() : 0;
    return createdAt > 0 && Date.now() - createdAt < 60 * 1000;
  }
  return false;
}

function hasRealConversation(review, transcript) {
  if (review && Number(review.quality_score) > 0) return true;
  const text = transcript?.transcript_text || transcript?.transcript || transcript?.text || "";
  return String(text).trim().length > 10;
}

async function classifyLeadStatus(tenantId, contactId, { userId = null } = {}) {
  const { hasCall, log, review, transcript } = await fetchLatestCallReviewForContact(tenantId, contactId);

  // "New" means the lead has never been dialed. Everything else is a call
  // outcome: connected (active), DNP (attempted but no conversation), or
  // qualified/junk (conversation happened).
  if (!hasCall) {
    return {
      status: CALL_STATUS.YET_TO_CALL,
      source: "score",
      reason: "No Callified call has been made for this lead yet.",
    };
  }

  // Persist the fresh review back to the cached CallLog notes so the
  // call-summary endpoint (which reads cached notes) serves the latest score
  // without requiring a details-drawer open.
  await updateCallLogNotesWithReview(tenantId, contactId, review);

  // While a call is actively being placed or is in progress, show Connecting.
  if (isActiveCall(log)) {
    return { status: CALL_STATUS.CONNECTED, source: "auto_dial", reason: "Call is currently in progress." };
  }

  // If the call ended (or is marked completed) but there is no transcript or
  // quality review, the person did not pick up / did not speak. Treat it as
  // DNP immediately so retries can be scheduled on the next poll.
  if (!hasRealConversation(review, transcript)) {
    return { status: CALL_STATUS.DNP, source: "score", reason: "Call was not answered / did not connect." };
  }

  // Fallback classification is always computed from the Callified review/score.
  // It acts as the source of truth when Gemini is unavailable, and as a guard
  // rail when Gemini returns a result that contradicts hard signals.
  const fallback = fallbackClassify(review, transcript);

  // If the tenant has disabled AI transcript classification, use the fallback.
  const aiTranscriptEnabled = await getSetting(tenantId, KEYS.CALLIFIED_AI_TRANSCRIPT_ENABLED, {
    coerce: (v) => String(v).toLowerCase() !== "false",
  });
  if (!aiTranscriptEnabled) {
    console.log(`[callified] AI transcript classification disabled for tenant ${tenantId}; using score/appointment fallback for contact ${contactId}.`);
    return { status: fallback.status, source: "score", reason: fallback.reason };
  }

  // If no Gemini key is configured, use the score/appointment fallback directly.
  const geminiReady = await llmEnabled("callified-lead-status", tenantId).catch((e) => {
    console.error(`[callified] llmEnabled check failed for tenant ${tenantId}: ${e.message}`);
    return false;
  });
  if (!geminiReady) {
    console.log(`[callified] No Gemini key available for tenant ${tenantId}; using score/appointment fallback for contact ${contactId}.`);
    return { status: fallback.status, source: "score", reason: fallback.reason };
  }

  const transcriptText = transcript?.transcript_text || transcript?.transcript || transcript?.text || "";
  const reviewPayload = review
    ? {
      sentiment: review.sentiment,
      quality_score: review.quality_score,
      appointment_booked: isTruthy(review.appointment_booked),
      summary: review.summary,
    }
    : null;

  const payload = {
    transcript: transcriptText,
    review: reviewPayload,
    hasTranscript: !!transcriptText,
    hasReview: !!reviewPayload,
    __surface: "leads-callified-transcript",
    __userId: userId,
  };

  try {
    const result = await routeRequest({ task: "callified-lead-status", payload, tenantId });
    let parsed;
    try {
      parsed = JSON.parse(result.text || "{}");
    } catch (_) {
      console.error(`[callified] Gemini returned non-JSON for contact ${contactId}: ${result.text}. Falling back to score.`);
      return { status: fallback.status, source: "score", reason: fallback.reason };
    }
    let status = normalizeLeadStatus(parsed.status);
    let source = "gemini";
    let reason = parsed.reason || "Classified by Gemini";

    // Guard rail: if Gemini contradicts hard Callified signals, trust the data.
    const score = Number(review?.quality_score) || 0;
    const appointmentBooked = isTruthy(review?.appointment_booked);
    if (appointmentBooked || score >= 4) {
      if (status !== CALL_STATUS.QUALIFIED) {
        console.log(`[callified] Gemini returned ${status} but review signals qualified (appointment=${appointmentBooked}, score=${score}); overriding to qualified.`);
        status = CALL_STATUS.QUALIFIED;
        source = "score";
        reason = fallback.reason;
      }
    } else if (score <= 2 && status === CALL_STATUS.QUALIFIED) {
      console.log(`[callified] Gemini returned qualified but review score is low (${score}); overriding to junk.`);
      status = CALL_STATUS.JUNK;
      source = "score";
      reason = fallback.reason;
    }

    console.log(`[callified] classified contact ${contactId} as ${status} (source=${source})`);
    return { status, source, reason };
  } catch (e) {
    console.error(`[callified] Gemini classification failed for contact ${contactId}: ${e.message}`);
    return { status: fallback.status, source: "score", reason: fallback.reason };
  }
}

async function assignQualifiedLead(tenantId, contactId, status, options = {}) {
  if (status !== CALL_STATUS.QUALIFIED) {
    console.log(`[callified] assignQualifiedLead skipped for contact ${contactId}: status is ${status}`);
    return null;
  }
  const { force = false } = options;

  // Respect the admin toggle in Call Settings > Assigning Staff.
  const assignmentEnabled = await getSetting(tenantId, KEYS.CALLIFIED_ASSIGN_STAFF_ENABLED, {
    coerce: (v) => String(v).toLowerCase() !== "false",
  });
  if (!assignmentEnabled) {
    console.log(`[callified] assignQualifiedLead skipped for contact ${contactId}: auto-assignment disabled`);
    return null;
  }

  try {
    const assignmentLogic = await getSetting(tenantId, KEYS.CALLIFIED_ASSIGN_STAFF_LOGIC, {
      coerce: (v) => (String(v).toLowerCase() === "random" ? "random" : "round_robin"),
      fallback: "round_robin",
    });
    const leadsPerUser = await getSetting(tenantId, KEYS.CALLIFIED_ASSIGN_STAFF_LEADS_PER_USER, {
      fallback: 1,
    });
    const normalizedLeadsPerUser = Math.max(1, Math.min(Number(leadsPerUser) || 1, 50));

    // Bump interactive transaction timeout: under load the staff lookup +
    // tenant update can exceed Prisma's 5s default, causing the assignment to
    // roll back and leaving the hot lead unassigned.
    const result = await prisma.$transaction(async (tx) => {
      const contact = await tx.contact.findFirst({
        where: { id: Number(contactId), tenantId },
        select: { id: true, assignedToId: true },
      });
      if (!contact) {
        console.log(`[callified] assignQualifiedLead skipped for contact ${contactId}: contact not found`);
        return { assignedToId: null, reason: "contact_not_found" };
      }

      const staff = await tx.user.findMany({
        where: {
          tenantId,
          deactivatedAt: null,
          role: { in: ["ADMIN", "MANAGER", "USER"] },
        },
        orderBy: { id: "asc" },
        select: { id: true },
      });
      if (staff.length === 0) {
        console.log(`[callified] assignQualifiedLead skipped for contact ${contactId}: no active staff in tenant ${tenantId}`);
        return { assignedToId: null, reason: "no_active_staff" };
      }

      let shouldReassign = force;
      if (!force && contact.assignedToId) {
        const currentActive = staff.some((s) => Number(s.id) === Number(contact.assignedToId));
        if (!currentActive) {
          console.log(`[callified] assignQualifiedLead reassigning contact ${contactId}: current owner ${contact.assignedToId} is inactive/not in staff pool`);
          shouldReassign = true;
        }
      }

      if (!shouldReassign && contact.assignedToId) {
        console.log(`[callified] assignQualifiedLead skipped for contact ${contactId}: already assigned to active user ${contact.assignedToId}`);
        return { assignedToId: null, reason: "already_assigned_active" };
      }

      const tenant = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { callifiedLastHotAssignedUserId: true, callifiedLastHotAssignedCount: true },
      });

      let nextUser = null;
      let nextUserId = null;
      let nextCount = 1;
      if (assignmentLogic === "random") {
        nextUser = staff[Math.floor(Math.random() * staff.length)];
        nextUserId = nextUser.id;
      } else {
        const lastId = tenant?.callifiedLastHotAssignedUserId || null;
        const lastCount = Number(tenant?.callifiedLastHotAssignedCount) || 0;
        let startIndex = 0;
        if (lastId) {
          const idx = staff.findIndex((s) => Number(s.id) === Number(lastId));
          if (idx >= 0) {
            // If the last user has not yet received their cap of leads,
            // keep assigning to them; otherwise advance.
            if (lastCount < normalizedLeadsPerUser) {
              nextUser = staff[idx];
              nextCount = lastCount + 1;
            } else {
              startIndex = (idx + 1) % staff.length;
            }
          }
        }
        if (!nextUser) {
          for (let i = 0; i < staff.length; i += 1) {
            const candidate = staff[(startIndex + i) % staff.length];
            if (Number(candidate.id) !== Number(lastId)) {
              nextUser = candidate;
              break;
            }
          }
          if (!nextUser) nextUser = staff[0];
          nextUserId = nextUser.id;
          nextCount = 1;
        } else {
          nextUserId = nextUser.id;
        }
      }

      await tx.contact.update({
        where: { id: Number(contactId) },
        data: { assignedToId: nextUserId },
      });
      await tx.tenant.update({
        where: { id: tenantId },
        data: {
          callifiedLastHotAssignedUserId: nextUserId,
          callifiedLastHotAssignedCount: nextCount,
        },
      });

      return { assignedToId: nextUserId, reason: "assigned" };
    }, { timeout: 15000 });

    const assignedToId = result.assignedToId;
    if (!assignedToId) return null;

    try {
      await notify({
        userId: assignedToId,
        tenantId,
        title: "Hot lead assigned",
        message: "A hot lead has been auto-assigned to you from Callified AI calls.",
        type: "info",
        category: "lead",
        entityType: "lead",
        entityId: Number(contactId),
        link: `/contacts/${contactId}`,
      });
    } catch (e) {
      console.error("[callified] hot lead assignment notify failed:", e.message);
    }

    console.log(`[callified] assignQualifiedLead assigned contact ${contactId} to user ${assignedToId}`);
    return assignedToId;
  } catch (e) {
    console.error(`[callified] assignQualifiedLead failed for contact ${contactId}:`, e.message);
    return null;
  }
}

// Preserve legacy export name for consumers that already import it.
const assignQualifiedLeadRoundRobin = assignQualifiedLead;

module.exports = {
  CALL_STATUS,
  VALID_LEAD_STATUSES,
  normalizeLeadStatus,
  isTruthy,
  fallbackClassify,
  isMissedCall,
  isActiveCall,
  hasRealConversation,
  fetchLatestCallReviewForContact,
  updateCallLogNotesWithReview,
  classifyLeadStatus,
  assignQualifiedLead,
  assignQualifiedLeadRoundRobin,
};
