let webpush = null;
let webpushAvailable = false;

try {
  webpush = require("web-push");
  webpushAvailable = true;
} catch (err) {
  console.warn("web-push module not installed. Push notifications will be unavailable. Run: npm install web-push");
}

/**
 * Get VAPID keys from environment variables.
 */
function getVapidKeys() {
  return {
    publicKey: process.env.VAPID_PUBLIC_KEY || "",
    privateKey: process.env.VAPID_PRIVATE_KEY || "",
  };
}

/**
 * Send a web push notification to a single subscription.
 * @param {{ endpoint: string, keys: { p256dh: string, auth: string } }} subscription
 * @param {{ title: string, body: string, icon?: string, url?: string }} payload
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function sendPush(subscription, payload) {
  if (!webpushAvailable) {
    return { success: false, error: "web-push not installed" };
  }

  const { publicKey, privateKey } = getVapidKeys();
  if (!publicKey || !privateKey) {
    return { success: false, error: "VAPID keys not configured" };
  }

  webpush.setVapidDetails("mailto:admin@globussoft.com", publicKey, privateKey);

  const pushSubscription = {
    endpoint: subscription.endpoint,
    keys: {
      p256dh: subscription.keys ? subscription.keys.p256dh : subscription.p256dh,
      auth: subscription.keys ? subscription.keys.auth : subscription.auth,
    },
  };

  try {
    await webpush.sendNotification(pushSubscription, JSON.stringify(payload));
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Send push notification to all active subscriptions for a user.
 * @param {number} userId
 * @param {{ title: string, body: string, icon?: string, url?: string }} payload
 * @param {import("@prisma/client").PrismaClient} prisma
 * @returns {Promise<{ sent: number, failed: number }>}
 */
async function sendToUser(userId, payload, prisma) {
  if (!webpushAvailable) {
    return { sent: 0, failed: 0, error: "web-push not installed" };
  }

  const subscriptions = await prisma.pushSubscription.findMany({
    where: { userId, isActive: true },
  });

  let sent = 0;
  let failed = 0;

  for (const sub of subscriptions) {
    const result = await sendPush(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      payload
    );
    if (result.success) {
      sent++;
    } else {
      failed++;
      // Deactivate subscription if it's gone (410 Gone)
      if (result.error && (result.error.includes("410") || result.error.includes("expired"))) {
        await prisma.pushSubscription.update({
          where: { id: sub.id },
          data: { isActive: false },
        });
      }
    }
  }

  return { sent, failed };
}

module.exports = { getVapidKeys, sendPush, sendToUser };
