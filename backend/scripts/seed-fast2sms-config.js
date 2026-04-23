/**
 * One-shot seed: activate Fast2SMS as the SMS provider for the
 * Enhanced Wellness tenant (slug: enhanced-wellness) so appointment
 * reminders, patient-portal OTP, telecaller SMS, and NPS surveys can
 * actually deliver.
 *
 * Idempotent — safe to re-run. Requires `FAST2SMS_API_KEY` in env.
 *
 * Usage (on the server):
 *   cd ~/globussoft-crm/backend && node scripts/seed-fast2sms-config.js
 *
 * Or target a specific tenant slug:
 *   TENANT_SLUG=generic-crm node scripts/seed-fast2sms-config.js
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "..", "..", ".env") });
const prisma = require("../lib/prisma");

async function main() {
  const apiKey = process.env.FAST2SMS_API_KEY;
  if (!apiKey) {
    console.error("[seed-fast2sms] FAST2SMS_API_KEY is not set in ../.env — aborting");
    process.exit(1);
  }

  const slug = process.env.TENANT_SLUG || "enhanced-wellness";
  const tenant = await prisma.tenant.findUnique({ where: { slug } });
  if (!tenant) {
    console.error(`[seed-fast2sms] tenant with slug="${slug}" not found`);
    process.exit(1);
  }

  // Deactivate any other active SMS provider for this tenant so the admin
  // /api/sms/send lookup (`findFirst isActive:true`) picks Fast2SMS
  await prisma.smsConfig.updateMany({
    where: { tenantId: tenant.id, NOT: { provider: "fast2sms" } },
    data: { isActive: false },
  });

  // Upsert our row. The schema has @@unique([tenantId, provider]).
  const config = await prisma.smsConfig.upsert({
    where: { tenantId_provider: { tenantId: tenant.id, provider: "fast2sms" } },
    update: {
      apiKey,
      isActive: true,
      senderId: process.env.FAST2SMS_SENDER_ID || "FSTSMS",
      settings: JSON.stringify({ route: "q", language: "english" }),
    },
    create: {
      tenantId: tenant.id,
      provider: "fast2sms",
      apiKey,
      isActive: true,
      senderId: process.env.FAST2SMS_SENDER_ID || "FSTSMS",
      settings: JSON.stringify({ route: "q", language: "english" }),
    },
  });

  console.log(
    `[seed-fast2sms] tenant "${tenant.name}" (id=${tenant.id}, slug=${slug}) — ` +
    `active SmsConfig id=${config.id}, provider=${config.provider}, sender=${config.senderId}`
  );
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
