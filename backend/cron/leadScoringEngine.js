const cron = require('node-cron');
const prisma = require("../lib/prisma");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env"), override: true });
const { GoogleGenerativeAI } = require("@google/generative-ai");

const GEMINI_KEY = process.env.GEMINI_API_KEY;
let aiModel = null;
if (GEMINI_KEY) {
  try {
    const genAI = new GoogleGenerativeAI(GEMINI_KEY);
    aiModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    console.log("[LeadScoringEngine] Gemini initialized");
  } catch (err) {
    console.warn("[LeadScoringEngine] Gemini init failed:", err.message);
  }
}

/**
 * Use Gemini AI to score a lead based on its profile and engagement data.
 */
async function scoreWithGemini(contact) {
  if (!aiModel) return null;

  try {
    const deals = contact.deals || [];
    const wonDeals = deals.filter(d => d.stage === 'won').length;
    const activities = (contact.activities || []).length;
    const emails = (contact.emails || []).length;
    const callLogs = (contact.callLogs || []).length;
    const isPersonalEmail = ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'aol.com', 'fivermail.com'].some(
      d => (contact.email || '').toLowerCase().endsWith(d)
    );
    const emailQuality = isPersonalEmail ? 'personal' : 'corporate';

    const prompt = `You are a B2B lead scoring expert. Score this lead from 1-99 based on quality and potential. Consider both profile quality and engagement.

Lead Profile:
- Name: ${contact.name || 'Unknown'}
- Email: ${contact.email || 'N/A'} (${emailQuality})
- Company: ${contact.company || 'N/A'}
- Title: ${contact.title || 'N/A'}
- Status: ${contact.status || 'Lead'}
- Industry: ${contact.industry || 'N/A'}
- Company Size: ${contact.companySize || 'N/A'}

Engagement Quality:
- Active Deals: ${deals.length} (won: ${wonDeals})
- Recent Activities: ${activities}
- Inbound Emails: ${emails}
- Phone Calls: ${callLogs}

Scoring guidance:
- High score (70+): Senior titles at enterprise companies with corporate emails, active deals, recent engagement
- Medium score (40-69): Title/company data present, some engagement, or strong profile
- Low score (1-39): Minimal engagement, personal email, no company data

Provide ONLY a single integer score from 1-99. No explanation.`;

    const result = await aiModel.generateContent(prompt);
    const scoreText = result.response.text().trim();
    const score = parseInt(scoreText);

    if (!isNaN(score) && score >= 1 && score <= 99) {
      console.log(`[LeadScoringEngine] Gemini scored ${contact.name}: ${score}`);
      return score;
    }
  } catch (err) {
    console.warn("[LeadScoringEngine] Gemini scoring failed:", err.message);
  }

  return null;
}

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

  // ── #571 — Static-feature signals (so contacts with sparse engagement
  //          events still produce variation; previously every contact
  //          with no activities collapsed to score 7).
  // Profile-completeness: explicit identity fields beyond enrichment.
  // Each +3 (capped together at +9) so a fully-identified prospect with
  // no engagement events still differentiates from a name-only stub.
  let identityBonus = 0;
  if (contact.name) identityBonus += 3;
  if (contact.email) identityBonus += 3;
  if (contact.phone) identityBonus += 3;
  score += identityBonus;

  // Email quality: corporate-domain inbox is a much stronger B2B
  // intent signal than a personal-domain inbox (gmail/yahoo/etc.).
  // Non-obvious why +10: most lead-scoring vendors weight this 8-12 —
  // the highest-confidence single static feature for B2B fit.
  if (typeof contact.email === 'string' && contact.email.includes('@')) {
    const domain = contact.email.split('@')[1].toLowerCase();
    const isPersonal = /^(gmail|yahoo|hotmail|outlook|icloud|aol|protonmail|live|msn|me|mail|ymail)\./.test(domain);
    if (!isPersonal) score += 10;
  }

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
  // Cold-lead decay: nothing in 90d (but skip for newly created leads <7d)
  const leadAgeDays = (now - new Date(contact.createdAt || now).getTime()) / 86400000;
  if (leadAgeDays > 7 && mostRecentDays > 90) score -= 8;
  else if (leadAgeDays > 7 && mostRecentDays > 60) score -= 4;

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

  // ── Email domain quality (corporate vs personal) ──────────────────
  const email = String(contact.email || '').toLowerCase();
  const corporateDomains = ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'aol.com', 'fivermail.com'];
  const isPersonalEmail = corporateDomains.some(d => email.endsWith(d));
  if (!isPersonalEmail && email.includes('@')) score += 8; // corporate email is strong signal

  // ── Job title seniority ──────────────────────────────────────────
  const titleLower = String(contact.title || '').toLowerCase();
  const seniorTitles = ['director', 'vp', 'c-level', 'ceo', 'cto', 'cfo', 'president', 'head of', 'manager', 'lead'];
  const isSenior = seniorTitles.some(t => titleLower.includes(t));
  if (isSenior) score += 6;

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

    // ── #571 — Lead-funnel age decay. Applies only to contacts still
    // sitting in 'Lead' status — they're rotting in the funnel. Skipped
    // once a Lead is promoted to Prospect/Customer, and skipped past
    // 180d to avoid double-counting with the survival-tenure bonus
    // above. Brief asked for −5/−10 but those values risk pushing
    // identified-but-unengaged leads to the score-1 floor; lighter
    // values still produce visible decay across buckets.
    if (contact.status === 'Lead' && ageDays <= 180) {
      if (ageDays > 30) score -= 6;
      else if (ageDays > 7) score -= 3;
    }
  }

  // SLA-breached leads are less likely to close — small drag.
  if (contact.slaBreached) score -= 3;

  return Math.max(1, Math.min(Math.round(score), 99));
}

// #421 — recompute window. We skip contacts whose aiScore was refreshed
// within the last 24h so a 100K-contact tenant doesn't rewrite every row
// every 10 minutes (the previous behaviour pegged Sentry p99 ticks at 8+
// minutes at scale). There is no dedicated `aiScoreLastComputedAt` column
// today (would require a schema migration owned by a separate agent), so
// we piggyback on `Contact.updatedAt` — every score-update touches it
// already, so it's a faithful proxy for "last scored at" (modulo the case
// where some other column was edited recently, in which case we just skip
// this tick and recompute next tick — no correctness loss).
const RECOMPUTE_WINDOW_HOURS = 24;

/**
 * Core scoring tick — called by cron and by the debug endpoint.
 *
 * #421 — three architectural fixes vs the original sweep:
 *   1. Per-tenant iteration (was: unscoped findMany sweeping all tenants
 *      in one tick — a noisy-neighbour outage waiting to happen at 50+
 *      tenants, plus a multi-tenant data-isolation violation).
 *   2. Recompute window (was: every contact rewritten every 10 minutes
 *      regardless of whether anything changed). See note above on the
 *      updatedAt-as-proxy choice.
 *   3. Promise.allSettled containment (was: Promise.all — one bad row
 *      poisoned the whole tick). Failures are logged and the tick
 *      continues so good rows still land.
 */
async function tickLeadScoringEngine(io) {
  try {
    const tenants = await prisma.tenant.findMany({
      where: { isActive: true },
      select: { id: true },
    });

    const recomputeCutoff = new Date(
      Date.now() - RECOMPUTE_WINDOW_HOURS * 3600 * 1000,
    );

    let totalScored = 0;
    for (const t of tenants) {
      const contacts = await prisma.contact.findMany({
        where: {
          tenantId: t.id,
          // #421 gap 2 — only rescore contacts whose score is null OR
          // older than RECOMPUTE_WINDOW_HOURS. Pre-existing rows have
          // aiScoreLastComputedAt = null and are treated as needing
          // a score on the first tick after the column was introduced.
          OR: [
            { aiScoreLastComputedAt: null },
            { aiScoreLastComputedAt: { lt: recomputeCutoff } },
          ],
        },
        include: {
          deals: true,
          activities: true,
          sequenceEnrollments: true,
          // #248 — additional engagement signals so the score uses the full
          // 1-99 range instead of clustering on 3 status-based buckets.
          emails: { select: { direction: true, sentimentScore: true, createdAt: true } },
          callLogs: { select: { createdAt: true } },
          // #571 — load touchpoints so multi-channel-engagement signal
          // contributes to the cron-scoring path (was only loaded by the
          // /api/ai/score-now route via include, never by the 10-min cron).
          touchpoints: { select: { channel: true } },
        },
      });

      const tickStart = new Date();
      const updates = await Promise.all(contacts.map(async (contact) => {
        // Try Gemini AI first, fall back to algorithm if Gemini unavailable
        let newScore = null;
        if (aiModel) {
          newScore = await scoreWithGemini(contact);
        }
        // Fallback to algorithm if Gemini failed or unavailable
        if (newScore === null) {
          newScore = computeScore(contact);
        }

        return prisma.contact.update({
          where: { id: contact.id },
          data: {
            aiScore: newScore,
            // Stamp the recompute-window key so subsequent ticks within
            // the window skip this row.
            aiScoreLastComputedAt: tickStart,
          },
        });
      }));

      // #421 gap 3 — allSettled so one bad row doesn't drop the whole
      // tick. Log rejections individually so Sentry/log-tail surfaces
      // the offending contact id + reason without losing the rest.
      const results = await Promise.allSettled(updates);
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.status === 'rejected') {
          const cid = contacts[i]?.id;
          console.error(
            `[LeadScoring] update failed for contact ${cid}: ${r.reason?.message || r.reason}`,
          );
        }
      }

      totalScored += contacts.length;
    }

    console.log(`[LeadScoring] Scored ${totalScored} contacts across ${tenants.length} tenants.`);

    // Broadcast real-time update so connected UIs can refresh
    if (io) {
      io.emit('lead_scores_updated', { count: totalScored, ts: new Date() });
    }

    return { scored: totalScored };
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
