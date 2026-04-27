const cron = require('node-cron');
const prisma = require("../lib/prisma");

/**
 * Calculate a lead score (1-99) for a given contact record.
 *
 * #248 — the previous formula relied almost entirely on `status` + a
 * coarse activity-bucket, so on a freshly-seeded tenant ~all rows tied
 * to one of three values (e.g. 25 / 35 / 45). The UI showed only 3
 * distinct AI Scores across 100 leads.
 *
 * The new formula spreads the output across the full 1-99 range by
 * mixing many continuous-ish signals at fine-grained weights:
 *   - status / lifecycle stage
 *   - deal pipeline state (count, stage, total amount, win history)
 *   - email engagement (open + click counts, inbound replies)
 *   - call + activity recency with continuous decay
 *   - sequence enrollment state
 *   - data-enrichment completeness (industry, companySize, linkedin, website)
 *   - source quality (referral / paid / organic / cold)
 *   - touchpoint diversity (channel mix from Touchpoint feed, when fetched)
 *   - account fit (companySize bracket)
 *
 * The contact must be fetched with: deals, activities, sequenceEnrollments,
 * emails (incl. tracking via emailTracking when available), callLogs,
 * and optionally touchpoints.
 */
function computeScore(contact) {
  let score = 10; // base

  // ── Status / lifecycle ───────────────────────────────────────────
  if (contact.status === 'Customer') score += 20;
  else if (contact.status === 'Prospect') score += 12;
  else if (contact.status === 'Lead') score += 5;
  // Churned: no bonus

  // ── Deal factors ─────────────────────────────────────────────────
  const deals = contact.deals || [];
  const activeDeals = deals.filter(d => d.stage !== 'lost' && d.stage !== 'won');
  if (activeDeals.length > 0) score += Math.min(activeDeals.length * 4, 12);

  // Stage progression (each stage advances 0–4 points)
  const stageWeight = { lead: 0, contacted: 2, proposal: 6, negotiation: 9 };
  for (const d of activeDeals) {
    score += stageWeight[d.stage] || 0;
  }

  const wonDeals = deals.filter(d => d.stage === 'won');
  if (wonDeals.length > 0) score += Math.min(10 + wonDeals.length * 2, 18);

  // Pipeline value: log-scaled so 10k vs 1M both register but differently
  const totalActiveAmount = activeDeals.reduce((s, d) => s + (Number(d.amount) || 0), 0);
  if (totalActiveAmount > 0) {
    score += Math.min(Math.round(Math.log10(totalActiveAmount + 1) * 1.5), 9);
  }

  // Probability signal (Deal.probability is 0-100)
  const avgProbability = activeDeals.length
    ? activeDeals.reduce((s, d) => s + (Number(d.probability) || 0), 0) / activeDeals.length
    : 0;
  score += Math.round(avgProbability / 20); // up to +5

  // Lost-deal drag — recently lost without a replacement is a negative signal
  const lostDeals = deals.filter(d => d.stage === 'lost');
  if (lostDeals.length > 0 && activeDeals.length === 0) score -= 4;

  // ── Activity recency with continuous decay ───────────────────────
  const now = Date.now();
  const activities = contact.activities || [];
  // Each activity contributes a decayed weight: e^(-days/45)
  let activityWeight = 0;
  let mostRecentDays = Infinity;
  for (const a of activities) {
    const days = Math.max(0, (now - new Date(a.createdAt).getTime()) / 86400000);
    if (days < mostRecentDays) mostRecentDays = days;
    activityWeight += Math.exp(-days / 45);
  }
  // Cap the cumulative bump but spread it over many integer values
  score += Math.min(Math.round(activityWeight * 2), 14);
  // Cold-lead decay: nothing in 90d
  if (mostRecentDays > 90) score -= 8;
  else if (mostRecentDays > 60) score -= 4;

  // Activity-type variety (calls + meetings are higher intent than notes)
  const callCount = activities.filter(a => a.type === 'Call').length;
  const meetingCount = activities.filter(a => a.type === 'Meeting').length;
  score += Math.min(callCount * 2, 6);
  score += Math.min(meetingCount * 3, 9);

  // ── Sequence enrollment ──────────────────────────────────────────
  const enrollments = contact.sequenceEnrollments || [];
  const activeEnrollments = enrollments.filter(e => e.status === 'Active');
  if (activeEnrollments.length > 0) score += 4;
  // Completed sequences indicate end-to-end engagement
  const completedEnrollments = enrollments.filter(e => e.status === 'Completed').length;
  score += Math.min(completedEnrollments * 2, 6);

  // ── Email engagement ─────────────────────────────────────────────
  const emails = contact.emails || [];
  const inboundReplies = emails.filter(e => e.direction === 'INBOUND').length;
  score += Math.min(inboundReplies * 3, 12); // replies are the strongest digital signal

  // Sentiment of inbound replies (avg score on -1..1 scale)
  const inboundWithSentiment = emails.filter(
    e => e.direction === 'INBOUND' && typeof e.sentimentScore === 'number'
  );
  if (inboundWithSentiment.length > 0) {
    const avgSent = inboundWithSentiment.reduce((s, e) => s + e.sentimentScore, 0) / inboundWithSentiment.length;
    score += Math.round(avgSent * 5); // ±5
  }

  // Email opens/clicks — caller may have included emailTracking on contact
  // (see ai_scoring route) or appended an `emailEngagement` count helper.
  if (Array.isArray(contact.emailTracking)) {
    const opens = contact.emailTracking.filter(t => t.type === 'open').length;
    const clicks = contact.emailTracking.filter(t => t.type === 'click').length;
    score += Math.min(Math.round(Math.log2(opens + 1) * 2), 8);  // log-scale opens
    score += Math.min(clicks * 2, 10);                            // clicks weight more
  } else if (typeof contact.emailEngagement === 'object' && contact.emailEngagement) {
    const opens = Number(contact.emailEngagement.opens) || 0;
    const clicks = Number(contact.emailEngagement.clicks) || 0;
    score += Math.min(Math.round(Math.log2(opens + 1) * 2), 8);
    score += Math.min(clicks * 2, 10);
  }

  // ── Call logs (separate model from Activity) ─────────────────────
  if (Array.isArray(contact.callLogs)) {
    const recentCalls = contact.callLogs.filter(
      c => new Date(c.createdAt || c.startedAt || 0).getTime() > now - 60 * 86400000
    ).length;
    score += Math.min(recentCalls * 2, 8);
  }

  // ── Touchpoint / channel diversity ───────────────────────────────
  if (Array.isArray(contact.touchpoints)) {
    const channels = new Set(contact.touchpoints.map(t => t.channel).filter(Boolean));
    score += Math.min(channels.size * 2, 8); // multi-channel engagement
  }

  // ── Source quality ───────────────────────────────────────────────
  const src = String(contact.source || contact.firstTouchSource || '').toLowerCase();
  if (/referral|customer-referral|partner/.test(src)) score += 8;
  else if (/website-form|inbound|demo-request/.test(src)) score += 5;
  else if (/walk-in/.test(src)) score += 6;
  else if (/paid|google-ads|fb-ads|linkedin-ads/.test(src)) score += 3;
  else if (/cold|purchased-list|scraped/.test(src)) score -= 5;
  // organic / unknown: 0

  // ── Data enrichment completeness (account fit signal) ────────────
  let enrichmentBonus = 0;
  if (contact.industry) enrichmentBonus += 1;
  if (contact.companySize) enrichmentBonus += 1;
  if (contact.linkedin) enrichmentBonus += 2;
  if (contact.website) enrichmentBonus += 1;
  if (contact.title) enrichmentBonus += 1;
  if (contact.company) enrichmentBonus += 1;
  score += enrichmentBonus; // up to +7

  // Company size bracket (string field — common values "1-10", "11-50", etc.)
  const cs = String(contact.companySize || '').toLowerCase();
  if (/1000\+|enterprise|10000/.test(cs)) score += 6;
  else if (/201|500|1000/.test(cs)) score += 4;
  else if (/51|100|200/.test(cs)) score += 2;

  // ── Tenure: older contacts that survived without churn are warmer ─
  if (contact.createdAt) {
    const ageDays = (now - new Date(contact.createdAt).getTime()) / 86400000;
    if (ageDays > 180 && contact.status !== 'Churned') score += 2;
  }

  // SLA-breached leads are less likely to close — small drag.
  if (contact.slaBreached) score -= 3;

  return Math.max(1, Math.min(Math.round(score), 99));
}

/**
 * Core scoring tick — called by cron and by the debug endpoint.
 */
async function tickLeadScoringEngine(io) {
  try {
    const contacts = await prisma.contact.findMany({
      include: {
        deals: true,
        activities: true,
        sequenceEnrollments: true,
        // #248 — additional engagement signals so the score uses the full
        // 1-99 range instead of clustering on 3 status-based buckets.
        emails: { select: { direction: true, sentimentScore: true, createdAt: true } },
        callLogs: { select: { createdAt: true } },
      },
    });

    const updates = contacts.map(contact => {
      const newScore = computeScore(contact);
      return prisma.contact.update({
        where: { id: contact.id },
        data: { aiScore: newScore },
      });
    });

    await Promise.all(updates);
    console.log(`[LeadScoring] Scored ${contacts.length} contacts.`);

    // Broadcast real-time update so connected UIs can refresh
    if (io) {
      io.emit('lead_scores_updated', { count: contacts.length, ts: new Date() });
    }

    return { scored: contacts.length };
  } catch (err) {
    console.error('[LeadScoring] Engine error:', err);
    throw err;
  }
}

/**
 * Initialise the cron job (every 10 minutes).
 * Call this from server.js, passing the socket.io `io` instance.
 */
function initLeadScoringCron(io) {
  // Run once at startup to immediately populate scores
  tickLeadScoringEngine(io).catch(console.error);

  cron.schedule('*/10 * * * *', () => {
    console.log('[LeadScoring] Cron tick — rescoring all contacts...');
    tickLeadScoringEngine(io).catch(console.error);
  });

  console.log('[LeadScoring] Cron initialized (every 10 minutes).');
}

module.exports = { initLeadScoringCron, tickLeadScoringEngine, computeScore };
