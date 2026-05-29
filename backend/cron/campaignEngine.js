const cron = require("node-cron");
const prisma = require("../lib/prisma");

/**
 * Campaign Engine — processes scheduled campaigns.
 *
 * Closes #412: schedule metadata now lives on the Campaign row itself
 * (Campaign.scheduledAt + Campaign.scheduleStatus + Campaign.scheduleFilters)
 * instead of an in-memory `global._campaignSchedules` map. The old map was
 * silently wiped on backend restart and could not survive a multi-instance
 * deploy (PM2 cluster, k8s replicas would each hold a divergent copy).
 *
 * Runs every minute, picks up Campaign rows whose `scheduledAt` is in the
 * past and `scheduleStatus='PENDING'`, calls sendCampaign(), and flips
 * scheduleStatus to 'SENT' on success (or clears it on failure so the next
 * tick can retry via the legacy 'Scheduled-but-no-schedule-meta' fallback
 * path that sendCampaign owns).
 */

/**
 * Single tick of the campaign engine — exported so unit tests + the manual
 * /api/marketing/campaigns/run trigger can drive the same code path.
 *
 * Runs ACROSS ALL TENANTS by default. Pass `{ tenantId }` to scope to one
 * tenant (used by routes/marketing.js's POST /campaigns/run, which mirrors
 * the engine but for the requesting admin's tenant only).
 *
 * @param {object}   [options]
 * @param {number}   [options.tenantId] — optional tenant scope filter
 * @param {Date}     [options.now]      — clock injection for tests
 * @param {Function} [options.sendCampaignFn] — DI hook for tests; defaults
 *   to the lazy-require'd routes/marketing.js export to dodge the circular
 *   import at module load time.
 * @returns {Promise<{processed:number, dispatched:number, skipped:number, errors:Array<{id:number, error:string}>}>}
 */
async function processDueCampaigns(options = {}) {
  const now = options.now || new Date();
  const tenantId = options.tenantId;

  // sendCampaign DI: tests pass a stub; runtime lazy-requires the route
  // module to avoid the circular dep (routes/marketing.js requires this
  // engine indirectly via server.js bootstrap).
  const sendCampaign =
    options.sendCampaignFn ||
     
    require("../routes/marketing").sendCampaign;

  // Query DB-backed schedule metadata. Match scheduleStatus='PENDING' so
  // we never re-dispatch a row that already flipped to SENT (idempotency
  // across ticks lives here, not in an in-memory map).
  //
  // Engine ALSO catches legacy 'Scheduled' rows that have no scheduledAt
  // at all — same fallback the original engine had at line 27 ("scheduled
  // but no metadata → send now"). This keeps any pre-#412 rows from being
  // stranded after the migration.
  const where = {
    OR: [
      // DB-backed schedule (post-#412)
      {
        scheduleStatus: "PENDING",
        scheduledAt: { lte: now },
      },
      // Legacy fallback: status='Scheduled' but no schedule metadata at
      // all (e.g. rows seeded before this migration, or a row whose status
      // was forced to 'Scheduled' via PUT without going through /schedule).
      {
        status: "Scheduled",
        scheduleStatus: null,
        scheduledAt: null,
      },
    ],
  };
  if (tenantId) where.tenantId = tenantId;

  const due = await prisma.campaign.findMany({ where });

  const result = { processed: due.length, dispatched: 0, skipped: 0, errors: [] };
  if (due.length === 0) return result;

  for (const campaign of due) {
    try {
      // Hydrate audience filter from the persisted JSON column. Mirrors
      // the old shape: routes/marketing.js's sendCampaign reads
      // campaign._audienceFilter, that contract is unchanged.
      if (campaign.scheduleFilters) {
        try {
          campaign._audienceFilter = JSON.parse(campaign.scheduleFilters);
        } catch (parseErr) {
          console.error(
            `[CampaignEngine] Could not parse scheduleFilters for campaign ${campaign.id}:`,
            parseErr.message,
          );
          campaign._audienceFilter = null;
        }
      }

      await sendCampaign(campaign, null);
      result.dispatched++;

      // Mark schedule as terminal so a subsequent tick sees scheduleStatus!='PENDING'
      // and skips the row. sendCampaign already flipped status='Completed' (or
      // 'Sending'/'Completed' — see routes/marketing.js:101+196), so this is
      // a defence-in-depth guard against double-dispatch.
      await prisma.campaign.update({
        where: { id: campaign.id },
        data: { scheduleStatus: "SENT" },
      }).catch((err) => {
        console.error(
          `[CampaignEngine] Could not mark campaign ${campaign.id} scheduleStatus=SENT:`,
          err.message,
        );
      });
    } catch (sendErr) {
      console.error(`[CampaignEngine] Failed to send campaign ${campaign.id}:`, sendErr.message);
      result.errors.push({ id: campaign.id, error: sendErr.message });
      // Mirror old engine: flip status back to Draft so it's no longer
      // 'Scheduled' (operator must re-schedule via the route). Clear
      // scheduleStatus so the next tick doesn't pick it up via the
      // PENDING filter — the operator must explicitly re-schedule.
      await prisma.campaign.update({
        where: { id: campaign.id },
        data: { status: "Draft", scheduleStatus: null },
      }).catch(() => { /* best-effort */ });
    }
  }

  return result;
}

function initCampaignCron() {
  // Run every minute
  cron.schedule("* * * * *", async () => {
    try {
      const r = await processDueCampaigns();
      if (r.processed > 0) {
        console.log(
          `[CampaignEngine] tick: processed=${r.processed} dispatched=${r.dispatched} errors=${r.errors.length}`,
        );
      }
    } catch (err) {
      console.error("[CampaignEngine] Cron error:", err.message);
    }
  });

  console.log("[CampaignEngine] Campaign scheduling cron initialized (runs every minute)");
}

module.exports = { initCampaignCron, processDueCampaigns };
