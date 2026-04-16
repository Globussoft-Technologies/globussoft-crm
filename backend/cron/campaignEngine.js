const cron = require("node-cron");
const prisma = require("../lib/prisma");

/**
 * Campaign Engine — processes scheduled campaigns.
 * Runs every minute, picks up campaigns with status "Scheduled"
 * whose scheduledAt time has passed, and sends them.
 */
function initCampaignCron() {
  // Run every minute
  cron.schedule("* * * * *", async () => {
    try {
      // Find all scheduled campaigns
      const scheduledCampaigns = await prisma.campaign.findMany({
        where: { status: "Scheduled" },
      });

      if (scheduledCampaigns.length === 0) return;

      const now = new Date();
      const scheduleMap = global._campaignSchedules || {};

      for (const campaign of scheduledCampaigns) {
        const schedule = scheduleMap[campaign.id];

        // If no schedule metadata exists, check if it's been scheduled long enough (fallback: send immediately)
        if (!schedule) {
          console.log(`[CampaignEngine] Campaign ${campaign.id} "${campaign.name}" is Scheduled but has no scheduledAt — sending now`);
        } else if (schedule.scheduledAt > now) {
          // Not yet time
          continue;
        }

        console.log(`[CampaignEngine] Processing scheduled campaign ${campaign.id} "${campaign.name}"`);

        try {
          // Lazy-require sendCampaign to avoid circular dependency at module load
          const { sendCampaign } = require("../routes/marketing");

          // Attach audience filter from schedule metadata
          if (schedule && schedule.filters) {
            campaign._audienceFilter = schedule.filters;
          }

          const result = await sendCampaign(campaign, null);
          console.log(`[CampaignEngine] Sent campaign "${campaign.name}" to ${result.sent} recipients`);

          // Clean up schedule metadata
          if (global._campaignSchedules) {
            delete global._campaignSchedules[campaign.id];
          }
        } catch (sendErr) {
          console.error(`[CampaignEngine] Failed to send campaign ${campaign.id}:`, sendErr.message);
          // Mark as Draft so it can be retried
          await prisma.campaign.update({
            where: { id: campaign.id },
            data: { status: "Draft" },
          });
        }
      }
    } catch (err) {
      console.error("[CampaignEngine] Cron error:", err.message);
    }
  });

  console.log("[CampaignEngine] Campaign scheduling cron initialized (runs every minute)");
}

module.exports = { initCampaignCron };
