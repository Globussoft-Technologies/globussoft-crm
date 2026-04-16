const prisma = require("./prisma");

/**
 * Deliver outbound HTTP POST to all registered Webhooks matching an event.
 *
 * Supports exact match ("deal.won") and wildcard match ("deal.*").
 */
async function deliverWebhooks(event, payload, tenantId) {
  try {
    const webhooks = await prisma.webhook.findMany({
      where: {
        tenantId,
        event: { in: [event, event.split(".")[0] + ".*"] },
        isActive: true,
      },
    });

    for (const wh of webhooks) {
      await deliverSingle(wh.targetUrl, event, payload, tenantId);
    }
  } catch (e) {
    console.error(`[Webhook] Error querying webhooks for ${event}:`, e.message);
  }
}

/**
 * Fire a single outbound webhook HTTP POST.
 *
 * @param {string} url       Target URL
 * @param {string} event     Event name
 * @param {object} payload   Event data
 * @param {number} tenantId  Tenant scope
 */
async function deliverSingle(url, event, payload, tenantId) {
  if (!url) {
    console.warn("[Webhook] No URL provided, skipping delivery");
    return;
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CRM-Event": event,
        "X-CRM-Tenant": String(tenantId),
      },
      body: JSON.stringify({
        event,
        timestamp: new Date().toISOString(),
        data: payload,
      }),
      signal: AbortSignal.timeout(10000),
    });
    console.log(`[Webhook] ${event} -> ${url}: ${response.status}`);
  } catch (e) {
    console.error(`[Webhook] ${event} -> ${url}: FAILED - ${e.message}`);
  }
}

module.exports = { deliverWebhooks, deliverSingle };
