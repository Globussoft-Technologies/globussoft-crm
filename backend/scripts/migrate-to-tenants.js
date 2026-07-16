// Backwards-compat migration: move all existing data into a "Default Org" tenant (id=1).
//
// Run after applying the multi-tenancy schema:
//   node backend/scripts/migrate-to-tenants.js
//
// Idempotent — safe to re-run.

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env"), override: true });

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const DEFAULT_TENANT_ID = 1;

async function main() {
  console.log("[migrate-to-tenants] Starting…");

  // Ensure Default Org tenant exists with id=1
  let tenant = await prisma.tenant.findUnique({ where: { id: DEFAULT_TENANT_ID } });
  if (!tenant) {
    // Try to create with explicit id=1. If id=1 is taken by a different tenant, fall back to slug lookup.
    try {
      tenant = await prisma.tenant.create({
        data: {
          id: DEFAULT_TENANT_ID,
          name: "Default Org",
          slug: "default-org",
          plan: "enterprise",
          ownerEmail: "admin@globussoft.com",
          isActive: true,
        }
      });
      console.log(`[migrate-to-tenants] Created tenant id=${tenant.id} slug=${tenant.slug}`);
    } catch (err) {
      console.error("[migrate-to-tenants] Could not create tenant id=1:", err.message);
      tenant = await prisma.tenant.findFirst({ where: { slug: "default-org" } });
      if (!tenant) throw err;
      console.log(`[migrate-to-tenants] Using existing tenant id=${tenant.id} slug=${tenant.slug}`);
    }
  } else {
    console.log(`[migrate-to-tenants] Default tenant already exists (id=${tenant.id})`);
  }

  const tenantId = tenant.id;

  // List of (model, label) we should backfill. Schema default is already 1, so this just ensures
  // any rows with a different value are reset to default tenant. In a fresh deploy this is a no-op.
  const targets = [
    "user", "contact", "activity", "deal", "ticket", "campaign", "automationRule",
    "emailMessage", "callLog", "attachment", "apiKey", "webhook", "invoice", "integration",
    "customEntity", "customRecord", "sequence", "sequenceEnrollment", "product", "quote",
    "task", "expense", "contract", "estimate", "project", "notification", "auditLog",
    "pipelineStage", "emailTemplate", "reportSchedule", "marketplaceLead", "marketplaceConfig",
    "smsMessage", "smsTemplate", "smsConfig", "whatsAppMessage", "whatsAppTemplate", "whatsAppConfig",
    "telephonyConfig", "pushSubscription", "pushNotification", "pushTemplate",
    "landingPage", "landingPageAnalytics", "contactAttachment", "emailTracking",
  ];

  let totalUpdated = 0;
  for (const model of targets) {
    try {
      if (model === "auditLog") {
        // AuditLog rows carry a #558 tamper-evidence hash chain whose hash
        // embeds tenantId. Reassigning tenantId here without clearing
        // hash/prevHash strands the row with a fingerprint computed for its
        // OLD tenant — the next /verify or backfill call flags it as
        // "tampered" even though only its tenant changed, not its content.
        // Capture the affected row ids first, then null their hash/prevHash
        // in the same pass so the existing repair tooling (Audit Log page's
        // "Repair chain" button / scripts/backfill-audit-chain.js) can
        // cleanly recompute correct hashes under the new tenant on the next
        // run — same tamper-evidence guarantee, just re-anchored.
        const affected = await prisma.auditLog.findMany({
          where: { tenantId: { not: tenantId } },
          select: { id: true },
        });
        const affectedIds = affected.map((r) => r.id);

        const result = await prisma.auditLog.updateMany({
          where: { tenantId: { not: tenantId } },
          data: { tenantId },
        });

        if (affectedIds.length > 0) {
          await prisma.auditLog.updateMany({
            where: { id: { in: affectedIds } },
            data: { hash: null, prevHash: null },
          });
        }
        if (result.count > 0) {
          console.log(`  - auditLog: backfilled ${result.count} rows -> tenantId=${tenantId} (cleared hash/prevHash for hash-chain recompute)`);
          totalUpdated += result.count;
        }
        continue;
      }

      const result = await prisma[model].updateMany({
        where: { tenantId: { not: tenantId } },
        data: { tenantId },
      });
      if (result.count > 0) {
        console.log(`  - ${model}: backfilled ${result.count} rows -> tenantId=${tenantId}`);
        totalUpdated += result.count;
      }
    } catch (err) {
      console.warn(`  - ${model}: skipped (${err.code || err.message})`);
    }
  }

  console.log(`[migrate-to-tenants] Done. ${totalUpdated} total rows reassigned to Default Org.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
