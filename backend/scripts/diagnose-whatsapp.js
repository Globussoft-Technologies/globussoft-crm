//
// One-shot WhatsApp send-path diagnostic.
//
//   node scripts/diagnose-whatsapp.js [tenantId]
//
// Prints everything that can differ between local and staging/prod and cause
// "works on local, fails (or stays QUEUED) elsewhere":
//   • DISABLE_CRONS / WELLNESS_FIELD_KEY / queue-driver / graph-version env
//   • the active WhatsAppConfig row (token presence + decryptability + state)
//   • WaOutboundJob queue stats + the most recent jobs (with lastError)
//   • the most recent WhatsAppMessage rows (status + errorMessage)
//
// Read-only. Safe to run against any environment. Does NOT print secrets —
// only the last 4 chars of the access token after decryption.
//
require("dotenv").config();
const prisma = require("../lib/prisma");
const { isEncrypted } = require("../lib/fieldEncryption");
const { decryptCredential } = require("../lib/credentialMasking");

function line(label, value) {
  console.log(`  ${String(label).padEnd(22)} ${value}`);
}

async function main() {
  const tenantArg = process.argv[2] ? Number(process.argv[2]) : null;

  console.log("\n=== ENV (read once at process boot) ===");
  line("DISABLE_CRONS", process.env.DISABLE_CRONS ?? "(unset)");
  line(
    "WELLNESS_FIELD_KEY",
    process.env.WELLNESS_FIELD_KEY
      ? `set (${process.env.WELLNESS_FIELD_KEY.length} chars) → at-rest encryption ON`
      : "(unset) → tokens stored as PLAINTEXT",
  );
  line("WHATSAPP_QUEUE_DRIVER", process.env.WHATSAPP_QUEUE_DRIVER || "(unset → db)");
  line("META_GRAPH_VERSION", process.env.META_GRAPH_VERSION || "(unset → v22.0 default)");

  console.log("\n=== WhatsAppConfig (active) ===");
  const where = { isActive: true };
  if (tenantArg) where.tenantId = tenantArg;
  const configs = await prisma.whatsAppConfig.findMany({ where });
  if (configs.length === 0) {
    console.log(
      `  (!) No active WhatsAppConfig${tenantArg ? ` for tenant ${tenantArg}` : ""}. ` +
        "Outbound engine will mark every job FAILED with 'No active WhatsAppConfig'.",
    );
  }
  for (const c of configs) {
    console.log(`  — tenant ${c.tenantId} / provider ${c.provider} (config id ${c.id})`);
    line("phoneNumberId", c.phoneNumberId || "(null!)");
    line("businessAccountId", c.businessAccountId || "(null)");
    line("disconnectedAt", c.disconnectedAt ? `${c.disconnectedAt.toISOString()} ← BLOCKS sends` : "null");
    line("businessRestricted", c.businessRestricted ? "true ← BLOCKS sends" : "false");
    line("messagingLimitTier", c.messagingLimitTier || "(null)");
    line("qualityRating", c.qualityRating || "(null)");
    line("tokenExpiresAt", c.tokenExpiresAt ? c.tokenExpiresAt.toISOString() : "null (never / unknown)");
    // Token presence + decryptability — the #1 cross-env failure.
    if (!c.accessToken) {
      line("accessToken", "(null!) ← BLOCKS sends");
    } else {
      const enc = isEncrypted(c.accessToken);
      const plain = decryptCredential(c.accessToken);
      const decryptedOk = plain && !isEncrypted(plain);
      line("accessToken stored", enc ? "ENCRYPTED (ENC:v1:)" : "plaintext");
      if (enc && !decryptedOk) {
        line(
          "accessToken decrypt",
          "FAILED ← wrong/missing WELLNESS_FIELD_KEY → Meta gets garbage token → error 190",
        );
      } else {
        line("accessToken decrypt", `OK (…${String(plain).slice(-4)}, ${String(plain).length} chars)`);
      }
    }
  }

  console.log("\n=== WaOutboundJob queue ===");
  if (!prisma.waOutboundJob?.findMany) {
    console.log("  (!) prisma client has NO waOutboundJob model — run `npx prisma generate` then restart.");
  } else {
    const jobWhere = tenantArg ? { tenantId: tenantArg } : {};
    const grouped = await prisma.waOutboundJob.groupBy({
      by: ["status"],
      where: jobWhere,
      _count: { _all: true },
    });
    if (grouped.length === 0) console.log("  (no jobs)");
    for (const g of grouped) line(g.status, g._count._all);

    const recent = await prisma.waOutboundJob.findMany({
      where: jobWhere,
      orderBy: { id: "desc" },
      take: 5,
      select: { id: true, messageId: true, status: true, attempts: true, runAt: true, lockedBy: true, lastError: true },
    });
    console.log("  recent jobs:");
    for (const j of recent) {
      console.log(
        `    job#${j.id} msg#${j.messageId} ${j.status} attempts=${j.attempts}` +
          ` runAt=${j.runAt?.toISOString?.() || j.runAt}` +
          (j.lockedBy ? ` lockedBy=${j.lockedBy}` : "") +
          (j.lastError ? `\n        lastError: ${j.lastError}` : ""),
      );
    }
  }

  console.log("\n=== Recent WhatsAppMessage (OUTBOUND) ===");
  const msgWhere = { direction: "OUTBOUND" };
  if (tenantArg) msgWhere.tenantId = tenantArg;
  const msgs = await prisma.whatsAppMessage.findMany({
    where: msgWhere,
    orderBy: { id: "desc" },
    take: 5,
    select: { id: true, to: true, status: true, templateName: true, providerMsgId: true, errorMessage: true, createdAt: true },
  });
  for (const m of msgs) {
    console.log(
      `  msg#${m.id} ${m.status} to=${m.to}` +
        (m.templateName ? ` template=${m.templateName}` : " (text)") +
        (m.providerMsgId ? " [accepted by Meta]" : " [no wamid — never reached Meta]") +
        (m.errorMessage ? `\n      error: ${m.errorMessage}` : ""),
    );
  }

  console.log("\nDone.\n");
}

main()
  .catch((e) => {
    console.error("diagnostic failed:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
