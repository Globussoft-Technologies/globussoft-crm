/**
 * Low-stock alert engine — daily inventory check for wellness tenants.
 *
 * For every wellness tenant, finds Products where currentStock <= threshold
 * (and threshold > 0 — threshold=0 means "not tracked"), then:
 *   1. Creates a Notification row for every MANAGER+ user in that tenant.
 *   2. Queues an email to tenant.ownerEmail (status=QUEUED so the existing
 *      email worker picks it up).
 *
 * Idempotent within 24h: a Notification's link field encodes the productId,
 * so we check for any existing low-stock notification for that product within
 * the last 24h before creating new ones.
 *
 * Schedule: 09:00 IST daily (cron runs in server local time — use 03:30 UTC
 * if you need strict IST; for now we just say "daily morning" in cron syntax).
 */
const cron = require("node-cron");
const prisma = require("../lib/prisma");
const { getSetting, KEYS } = require("../lib/tenantSettings");

const NOTIF_TYPE = "warning";
const NOTIF_LINK_PREFIX = "/wellness/products?productId=";

async function alreadyAlertedRecently(tenantId, productId) {
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const link = `${NOTIF_LINK_PREFIX}${productId}`;
  const existing = await prisma.notification.findFirst({
    where: { tenantId, link, createdAt: { gte: since } },
    select: { id: true },
  });
  return !!existing;
}

async function runLowStockForTenant(tenant) {
  const products = await prisma.product.findMany({
    where: {
      tenantId: tenant.id,
      threshold: { gt: 0 },
    },
    select: { id: true, name: true, sku: true, currentStock: true, threshold: true },
  });

  const lowProducts = products.filter((p) => p.currentStock <= p.threshold);
  if (lowProducts.length === 0) return { products: 0, notifications: 0, emails: 0 };

  // Per-tenant alert roles (default: MANAGER + ADMIN)
  const alertRolesRaw = await getSetting(tenant.id, KEYS.INVENTORY_ALERT_ROLES, { fallback: JSON.stringify(["MANAGER", "ADMIN"]) });
  let alertRoles = ["MANAGER", "ADMIN"];
  try { alertRoles = JSON.parse(alertRolesRaw); } catch { /* keep default */ }
  if (!Array.isArray(alertRoles) || alertRoles.length === 0) alertRoles = ["MANAGER", "ADMIN"];

  const recipients = await prisma.user.findMany({
    where: { tenantId: tenant.id, role: { in: alertRoles } },
    select: { id: true },
  });

  let notifs = 0;
  let emails = 0;
  let alerted = 0;

  for (const p of lowProducts) {
    const title = `Low stock: ${p.name}`;
    const message = `Stock for ${p.name}${p.sku ? ` (SKU ${p.sku})` : ""} is at ${p.currentStock} (threshold ${p.threshold}). Reorder soon.`;
    const link = `${NOTIF_LINK_PREFIX}${p.id}`;

    let createdNotifs = 0;
    let shouldAlert = false;

    await prisma.$transaction(async (tx) => {
      const since = new Date(Date.now() - 24 * 3600 * 1000);
      const existing = await tx.notification.findFirst({
        where: { tenantId: tenant.id, link, createdAt: { gte: since } },
        select: { id: true },
      });
      if (existing) return;

      shouldAlert = true;

      if (recipients.length > 0) {
        await tx.notification.createMany({
          data: recipients.map((u) => ({
            tenantId: tenant.id,
            userId: u.id,
            title,
            message,
            type: NOTIF_TYPE,
            link,
          })),
        });
        createdNotifs = recipients.length;
      }
    });

    if (!shouldAlert) continue;
    alerted++;
    notifs += createdNotifs;

    if (tenant.ownerEmail) {
      await prisma.emailMessage.create({
        data: {
          tenantId: tenant.id,
          subject: `[Inventory] Low stock alert: ${p.name}`,
          body: `${message}\n\nThreshold: ${p.threshold}\nCurrent stock: ${p.currentStock}\n\n— Globussoft CRM`,
          from: process.env.MAIL_FROM || "no-reply@globusdemos.com",
          to: tenant.ownerEmail,
          direction: "OUTBOUND",
          read: false,
        },
      });
      emails++;
    }
  }

  return { products: alerted, notifications: notifs, emails };
}

async function runLowStockForAllWellnessTenants() {
  const tenants = await prisma.tenant.findMany({
    where: { vertical: "wellness", isActive: true },
    select: { id: true, slug: true, ownerEmail: true },
  });
  const results = [];
  for (const t of tenants) {
    try {
      const r = await runLowStockForTenant(t);
      if (r.products > 0) {
        console.log(
          `[LowStock] tenant ${t.slug}: ${r.products} products alerted, ${r.notifications} notifications, ${r.emails} emails`
        );
      }
      results.push({ tenant: t.slug, ...r });
    } catch (e) {
      console.error("[LowStock] tenant fail:", t.slug, e.message);
      results.push({ tenant: t.slug, error: e.message });
    }
  }
  return results;
}

function initLowStockCron() {
  // 09:00 IST = 03:30 UTC. node-cron uses server time by default; pass an
  // explicit IST timezone so behaviour is consistent across environments.
  cron.schedule(
    "0 9 * * *",
    () => {
      runLowStockForAllWellnessTenants().catch((e) =>
        console.error("[LowStock] cron fail:", e.message)
      );
    },
    { timezone: "Asia/Kolkata" }
  );
  console.log("[LowStock] cron initialized (daily 09:00 IST)");
}

module.exports = {
  initLowStockCron,
  runLowStockForTenant,
  runLowStockForAllWellnessTenants,
};
