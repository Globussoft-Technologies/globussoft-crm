//
// WhatsApp template sync engine (P4).
//
// Daily tick (03:30 server time). For every active WhatsAppConfig with a
// non-null businessAccountId, calls Meta's /{wabaId}/message_templates
// and upserts each template into WhatsAppTemplate.
//
// This is the safety net for templates whose status changed at Meta but
// whose `message_template_status_update` webhook never reached us (network
// loss, signature mismatch during rotation, etc.).
//
// Also exposed as an on-demand POST /api/whatsapp/templates/sync route in
// routes/whatsapp.js — see the helper `syncTemplatesForTenant` below.

const cronRegistry = require("../lib/cronRegistry");
const prisma = require("../lib/prisma");
const { decryptCredential } = require("../lib/credentialMasking");
const provider = require("../services/whatsappProvider");

const TICK_CRON = "30 3 * * *"; // 03:30 daily server time

/**
 * Sync all templates for a single tenant. Used by the cron tick AND by the
 * manual POST /templates/sync endpoint.
 *
 * @param {number} tenantId
 * @returns {Promise<{ ok, synced?, error?, code? }>}
 */
async function syncTemplatesForTenant(tenantId) {
  const cfg = await prisma.whatsAppConfig.findFirst({
    where: { tenantId, isActive: true, disconnectedAt: null },
  });
  if (!cfg) return { ok: false, code: "NOT_CONNECTED" };
  if (!cfg.businessAccountId || !cfg.accessToken) {
    return { ok: false, code: "INCOMPLETE_CONFIG" };
  }
  const token = decryptCredential(cfg.accessToken);
  if (!token) return { ok: false, code: "NO_TOKEN" };

  const r = await provider.listTemplates({ wabaId: cfg.businessAccountId, accessToken: token, limit: 200 });
  if (!r.ok) {
    return { ok: false, code: "GRAPH_ERROR", error: r.error };
  }
  const list = r.data?.data || [];
  let synced = 0;
  for (const t of list) {
    try {
      const statusMap = { APPROVED: "APPROVED", REJECTED: "REJECTED", PENDING: "PENDING", PAUSED: "PAUSED", FLAGGED: "FLAGGED" };
      const status = statusMap[t.status] || "PENDING";
      const components = Array.isArray(t.components) ? t.components : [];
      const headerComp = components.find((c) => c.type === "HEADER");
      const bodyComp   = components.find((c) => c.type === "BODY");
      const footerComp = components.find((c) => c.type === "FOOTER");
      const buttonsComp = components.find((c) => c.type === "BUTTONS");
      await prisma.whatsAppTemplate.upsert({
        where: { tenantId_name: { tenantId, name: t.name } },
        create: {
          tenantId,
          name: t.name,
          language: t.language || "en_US",
          category: (t.category || "MARKETING").toUpperCase(),
          status,
          headerType: headerComp?.format || null,
          headerContent: headerComp?.text || null,
          body: bodyComp?.text || "",
          footer: footerComp?.text || null,
          buttons: buttonsComp?.buttons ? JSON.stringify(buttonsComp.buttons) : null,
          metaTemplateId: t.id || null,
          qualityScore: t.quality_score?.score ? String(t.quality_score.score).toUpperCase() : null,
          lastSyncedAt: new Date(),
        },
        update: {
          language: t.language || "en_US",
          category: (t.category || "MARKETING").toUpperCase(),
          status,
          headerType: headerComp?.format || null,
          headerContent: headerComp?.text || null,
          body: bodyComp?.text || "",
          footer: footerComp?.text || null,
          buttons: buttonsComp?.buttons ? JSON.stringify(buttonsComp.buttons) : null,
          metaTemplateId: t.id || null,
          qualityScore: t.quality_score?.score ? String(t.quality_score.score).toUpperCase() : null,
          lastSyncedAt: new Date(),
        },
      });
      synced++;
    } catch (err) {
      console.warn(`[templateSync] upsert failed for tenant ${tenantId} template "${t.name}":`, err.message);
    }
  }
  return { ok: true, synced, total: list.length };
}

async function tick() {
  try {
    if (!prisma.whatsAppConfig?.findMany) return;
    const tenants = await prisma.whatsAppConfig.findMany({
      where: { isActive: true, disconnectedAt: null, businessAccountId: { not: null } },
      select: { tenantId: true },
      distinct: ["tenantId"],
    });
    let totalSynced = 0;
    for (const { tenantId } of tenants) {
      const r = await syncTemplatesForTenant(tenantId);
      if (r.ok) totalSynced += r.synced || 0;
    }
    if (tenants.length > 0) {
      console.log(`[whatsappTemplateSyncEngine] synced ${totalSynced} template(s) across ${tenants.length} tenant(s)`);
    }
  } catch (err) {
    console.error("[whatsappTemplateSyncEngine] tick error:", err);
  }
}

function initWhatsappTemplateSyncCron() {
  cronRegistry.register({
    name: "whatsappTemplateSyncEngine",
    description: "Nightly sync of approved WhatsApp templates from Meta (daily 03:30)",
    defaultSchedule: TICK_CRON,
    tickFn: tick,
  }).catch((e) => console.error("[whatsappTemplateSyncEngine] cronRegistry registration failed:", e.message));
}

module.exports = {
  initWhatsappTemplateSyncCron,
  syncTemplatesForTenant,
  _internals: { tick },
};
