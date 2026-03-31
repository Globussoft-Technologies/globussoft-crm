const cron = require('node-cron');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

/**
 * Calculate a lead score (0-100) for a given contact record.
 * The contact must be fetched with: deals, activities, sequenceEnrollments.
 */
function computeScore(contact) {
  let score = 10; // base

  // Status factor
  if (contact.status === 'Customer') score += 20;
  else if (contact.status === 'Prospect') score += 10;
  else if (contact.status === 'Lead') score += 5;
  // Churned: no bonus

  // Deal factors
  const activeDeals = (contact.deals || []).filter(d => d.stage !== 'lost');
  if (activeDeals.length > 0) score += 15;

  const proposalDeals = activeDeals.filter(d => d.stage === 'proposal').length;
  score += Math.min(proposalDeals * 10, 20);

  const wonDeals = (contact.deals || []).filter(d => d.stage === 'won').length;
  if (wonDeals > 0) score += 20;

  // Activity recency
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  const recentActivities = (contact.activities || []).filter(
    a => new Date(a.createdAt) > thirtyDaysAgo
  );
  const anyOldActivity = (contact.activities || []).find(
    a => new Date(a.createdAt) > ninetyDaysAgo
  );

  if (recentActivities.length > 5) score += 15;
  else if (recentActivities.length > 0) score += 10;
  else if (!anyOldActivity) score -= 10; // cold lead decay

  // Sequence enrollment bonus
  const activeEnrollments = (contact.sequenceEnrollments || []).filter(
    e => e.status === 'Active'
  );
  if (activeEnrollments.length > 0) score += 5;

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
