/**
 * AI credit low-balance alert engine — periodic sweep over every tenant
 * with an AiCreditWallet, notifying tenant ADMINs once per threshold
 * crossing (25% / 10% / 5% remaining, per aiCreditLedger.LOW_BALANCE_THRESHOLDS).
 *
 * Idempotent via AiCreditWallet.lastAlertPercent: a wallet only re-alerts
 * when it crosses to a LOWER threshold than the last one it alerted on, or
 * after a top-up resets lastAlertPercent to null (see aiCreditLedger.creditTokens).
 * This avoids re-notifying on every single request once a tenant is sitting
 * below a threshold.
 *
 * Schedule: every 30 minutes — frequent enough that a tenant burning through
 * credits fast still gets a timely warning, cheap enough (one query per
 * tenant with a wallet) to not matter at this frequency.
 */
const cronRegistry = require("../lib/cronRegistry");
const prisma = require("../lib/prisma");
const aiCreditLedger = require("../lib/aiCreditLedger");
const { notify } = require("../lib/notificationService");

const NOTIF_LINK = "/settings/ai-usage";

async function runLowBalanceCheckForWallet(wallet) {
  if (wallet.totalPurchasedTokens <= 0) return null; // never purchased anything — nothing to alert on

  const percentRemaining = Math.max(
    0,
    Math.min(100, Math.round((wallet.balanceTokens / wallet.totalPurchasedTokens) * 100)),
  );
  const threshold = aiCreditLedger.nextAlertThreshold(wallet, percentRemaining);
  if (threshold == null) return null;

  const admins = await prisma.user.findMany({
    where: { tenantId: wallet.tenantId, role: "ADMIN" },
    select: { id: true },
    take: 25,
  });
  if (!admins.length) return null;

  const title = `AI credits running low (${threshold}% remaining)`;
  const message = `Your AI subscription has only ${threshold}% of its credits remaining. Consider upgrading or purchasing additional credits to avoid service interruption.`;

  await Promise.all(
    admins.map((admin) =>
      notify({
        userId: admin.id,
        tenantId: wallet.tenantId,
        title,
        message,
        type: "warning",
        priority: threshold <= 10 ? "high" : "normal",
        link: NOTIF_LINK,
        category: "ai-credits",
      }),
    ),
  );

  await prisma.aiCreditWallet.update({
    where: { id: wallet.id },
    data: { lastAlertPercent: threshold },
  });

  return { tenantId: wallet.tenantId, threshold, admins: admins.length };
}

async function runAiCreditLowBalanceSweep() {
  const wallets = await prisma.aiCreditWallet.findMany({
    where: { totalPurchasedTokens: { gt: 0 } },
  });

  const results = [];
  for (const wallet of wallets) {
    try {
      const result = await runLowBalanceCheckForWallet(wallet);
      if (result) {
        console.log(
          `[AiCreditLowBalance] tenant ${result.tenantId}: alerted at ${result.threshold}% (${result.admins} admin(s))`,
        );
        results.push(result);
      }
    } catch (e) {
      console.error(`[AiCreditLowBalance] tenant ${wallet.tenantId} failed:`, e.message);
    }
  }
  return results;
}

function initAiCreditLowBalanceCron() {
  cronRegistry.register({
    name: "aiCreditLowBalanceEngine",
    description: "AI credit low-balance Notification alerts (25%/10%/5% thresholds)",
    defaultSchedule: "*/30 * * * *",
    tickFn: runAiCreditLowBalanceSweep,
  }).catch((e) => console.error("[AiCreditLowBalance] cronRegistry registration failed:", e.message));
}

module.exports = {
  initAiCreditLowBalanceCron,
  runAiCreditLowBalanceSweep,
  runLowBalanceCheckForWallet,
};
