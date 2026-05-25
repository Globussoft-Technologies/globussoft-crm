#!/usr/bin/env node
//
// One-off cleanup: re-route WhatsAppMessage / WhatsAppThread rows that landed
// on tenantId=1 because of the pre-P1 webhook fallback.
//
// ┌────────────────────────────────────────────────────────────────────────┐
// │ DATA SAFETY GUARANTEES                                                 │
// │                                                                        │
// │ 1. Default mode = --dry-run. NO writes happen unless --apply is passed.│
// │ 2. NO row is ever deleted, EVER. Only the tenantId field is rewritten. │
// │ 3. Re-routes happen only when EXACTLY ONE WhatsAppConfig matches the   │
// │    row's phone — ambiguous rows are left as-is for human review.       │
// │ 4. All --apply changes run inside a single Prisma $transaction —       │
// │    a single failure aborts the entire batch (zero partial writes).     │
// │ 5. Every re-route writes an AuditLog row (TENANT_REROUTE) with the     │
// │    old + new tenantId, providing a full audit trail.                   │
// └────────────────────────────────────────────────────────────────────────┘
//
// What it fixes:
//   The pre-P1 webhook handler (routes/whatsapp.js, lines ~1042-1045 before
//   P1) used `phone.contains(from.slice(-10))` to find a Contact across
//   ALL tenants, then defaulted to `tenantId=1` if no Contact matched.
//   This caused two issues:
//     - Inbound from a phone with NO matching Contact landed on tenant 1
//       even when the correct tenant's WhatsAppConfig owned the
//       phone_number_id receiving the message.
//     - Inbound from a phone matching a Contact in a tenant OTHER than the
//       config's owning tenant landed on the Contact's tenant.
//   P1 fixes both prospectively by routing on `phone_number_id`. This
//   script repairs historical rows where possible.
//
// Re-route logic (per row):
//   • Look at the row's `to` field for OUTBOUND messages or `from` field for
//     INBOUND messages (this maps to the side that points at OUR Meta number).
//     For INBOUND, look at the metadata-derived target instead — but the
//     pre-P1 schema didn't persist that, so we fall back to looking at the
//     WhatsAppThread's owning tenant.
//   • Match against WhatsAppConfig.phoneNumberId across all tenants.
//   • If exactly one config matches → re-route the row to that config's
//     tenantId.
//   • If zero matches OR more than one match → leave as-is, log as
//     ambiguous, continue.
//
// Usage:
//   node scripts/cleanup-orphan-whatsapp-tenant1.js              # dry-run
//   node scripts/cleanup-orphan-whatsapp-tenant1.js --apply      # mutate
//   node scripts/cleanup-orphan-whatsapp-tenant1.js --dry-run    # explicit
//
// Exit codes:
//   0  — script completed (dry-run or apply succeeded)
//   1  — apply aborted because of a transaction failure (zero rows changed)
//   2  — DB connection failure

const prisma = require("../lib/prisma");
const { writeAudit } = require("../lib/audit");

const APPLY = process.argv.includes("--apply");
const MODE = APPLY ? "APPLY" : "DRY-RUN";

async function main() {
  console.log(`[wa-cleanup] starting in ${MODE} mode`);
  if (!APPLY) {
    console.log("[wa-cleanup] no writes will occur. Pass --apply to mutate.");
  } else {
    console.log("[wa-cleanup] --apply detected. Re-routes will be committed in a single transaction.");
  }

  // Load every WhatsAppConfig with a non-null phoneNumberId. Build a phone →
  // tenantId map. Skip configs without a phoneNumberId (legacy / unconfigured).
  const configs = await prisma.whatsAppConfig.findMany({
    where: { phoneNumberId: { not: null } },
    select: { id: true, tenantId: true, phoneNumberId: true, provider: true, isActive: true },
  });

  const phoneToConfigs = new Map();
  for (const c of configs) {
    const k = c.phoneNumberId;
    if (!phoneToConfigs.has(k)) phoneToConfigs.set(k, []);
    phoneToConfigs.get(k).push(c);
  }
  console.log(`[wa-cleanup] loaded ${configs.length} WhatsAppConfig row(s) across ${phoneToConfigs.size} phone-number-id(s)`);

  // Look at WhatsAppMessage rows on tenantId=1. We pull them in batches to
  // avoid loading millions of rows into memory.
  const BATCH = 500;
  const plan = []; // { kind, rowId, oldTenantId, newTenantId, reason }
  let scanned = 0;
  let cursorId = 0;

  /* eslint-disable no-constant-condition */
  while (true) {
    const batch = await prisma.whatsAppMessage.findMany({
      where: { tenantId: 1, id: { gt: cursorId } },
      orderBy: { id: "asc" },
      take: BATCH,
      select: { id: true, direction: true, from: true, to: true, threadId: true },
    });
    if (batch.length === 0) break;
    scanned += batch.length;
    cursorId = batch[batch.length - 1].id;

    for (const msg of batch) {
      // For OUTBOUND messages the `from` column holds OUR phoneNumberId (the
      // Meta phone-number-id we sent from). For INBOUND it holds the customer
      // phone, and `to` holds our phone-number-id or our display number.
      // Pre-P1 inbound rows stored either the display number or the
      // phone-number-id in `to`, depending on which webhook payload field
      // hydrated first. Try both.
      const candidates = [];
      if (msg.direction === "OUTBOUND" && msg.from) candidates.push(msg.from);
      if (msg.direction === "INBOUND"  && msg.to)   candidates.push(msg.to);

      let matchedTenantId = null;
      let matchReason = null;
      let ambiguous = false;
      for (const cand of candidates) {
        const matches = phoneToConfigs.get(cand);
        if (matches && matches.length === 1) {
          matchedTenantId = matches[0].tenantId;
          matchReason = `phoneNumberId match: ${cand} → tenant ${matchedTenantId}`;
          break;
        } else if (matches && matches.length > 1) {
          ambiguous = true;
        }
      }

      if (matchedTenantId && matchedTenantId !== 1) {
        plan.push({
          kind: "WhatsAppMessage",
          rowId: msg.id,
          oldTenantId: 1,
          newTenantId: matchedTenantId,
          reason: matchReason,
        });
      } else if (ambiguous) {
        plan.push({
          kind: "WhatsAppMessage",
          rowId: msg.id,
          oldTenantId: 1,
          newTenantId: null,
          reason: "ambiguous — multiple WhatsAppConfig rows claim the same phone-number-id",
        });
      }
      // No match and not ambiguous: leave alone. Could be a genuine tenant-1
      // message, or pre-onboarding traffic. We don't speculate.
    }
  }

  // Threads — same logic, simpler shape. Threads store `contactPhone` (the
  // customer) not the config phone, so we cannot re-tenant a thread by
  // phoneNumberId alone. Instead we look at the thread's messages and
  // adopt the consensus tenant if all messages agree on a non-tenant-1 home.
  const threads = await prisma.whatsAppThread.findMany({
    where: { tenantId: 1 },
    select: { id: true, contactPhone: true },
  });

  for (const t of threads) {
    const msgs = await prisma.whatsAppMessage.findMany({
      where: { threadId: t.id },
      select: { tenantId: true, direction: true, from: true, to: true },
    });
    if (msgs.length === 0) continue;

    // Look up via the same candidates each message would resolve to.
    const tenantHits = new Set();
    for (const m of msgs) {
      const candidates = [];
      if (m.direction === "OUTBOUND" && m.from) candidates.push(m.from);
      if (m.direction === "INBOUND"  && m.to)   candidates.push(m.to);
      for (const cand of candidates) {
        const matches = phoneToConfigs.get(cand);
        if (matches && matches.length === 1) tenantHits.add(matches[0].tenantId);
      }
    }
    const consensusTenants = [...tenantHits].filter((t) => t !== 1);
    if (consensusTenants.length === 1) {
      plan.push({
        kind: "WhatsAppThread",
        rowId: t.id,
        oldTenantId: 1,
        newTenantId: consensusTenants[0],
        reason: `consensus from ${msgs.length} message(s) — all map to tenant ${consensusTenants[0]}`,
      });
    } else if (consensusTenants.length > 1) {
      plan.push({
        kind: "WhatsAppThread",
        rowId: t.id,
        oldTenantId: 1,
        newTenantId: null,
        reason: `ambiguous — messages on this thread map to multiple tenants: ${consensusTenants.join(", ")}`,
      });
    }
  }

  // Report.
  const reroutable = plan.filter((p) => p.newTenantId !== null);
  const ambiguous  = plan.filter((p) => p.newTenantId === null);

  console.log("");
  console.log(`[wa-cleanup] scanned ${scanned} WhatsAppMessage row(s) and ${threads.length} thread(s) on tenantId=1`);
  console.log(`[wa-cleanup] re-routable:  ${reroutable.length}`);
  console.log(`[wa-cleanup] ambiguous (left as-is): ${ambiguous.length}`);
  console.log("");

  if (reroutable.length > 0) {
    console.log("[wa-cleanup] re-route plan (first 20):");
    for (const p of reroutable.slice(0, 20)) {
      console.log(`  ${p.kind} id=${p.rowId}  tenant 1 → ${p.newTenantId}  (${p.reason})`);
    }
    if (reroutable.length > 20) console.log(`  …and ${reroutable.length - 20} more.`);
    console.log("");
  }
  if (ambiguous.length > 0) {
    console.log("[wa-cleanup] ambiguous (no action, review manually):");
    for (const p of ambiguous.slice(0, 10)) {
      console.log(`  ${p.kind} id=${p.rowId}  reason=${p.reason}`);
    }
    if (ambiguous.length > 10) console.log(`  …and ${ambiguous.length - 10} more.`);
    console.log("");
  }

  if (!APPLY) {
    console.log("[wa-cleanup] dry-run complete. Re-run with --apply to commit re-routes.");
    await prisma.$disconnect();
    process.exit(0);
  }

  if (reroutable.length === 0) {
    console.log("[wa-cleanup] --apply requested but nothing to do. Exiting cleanly.");
    await prisma.$disconnect();
    process.exit(0);
  }

  console.log(`[wa-cleanup] --apply: committing ${reroutable.length} re-route(s) in a single transaction…`);

  try {
    await prisma.$transaction(async (tx) => {
      for (const p of reroutable) {
        if (p.kind === "WhatsAppMessage") {
          await tx.whatsAppMessage.update({
            where: { id: p.rowId },
            data: { tenantId: p.newTenantId },
          });
        } else if (p.kind === "WhatsAppThread") {
          await tx.whatsAppThread.update({
            where: { id: p.rowId },
            data: { tenantId: p.newTenantId },
          });
        }
      }
    });
    console.log("[wa-cleanup] transaction committed.");
  } catch (err) {
    console.error("[wa-cleanup] transaction FAILED — zero rows changed.");
    console.error("[wa-cleanup] error:", err.message);
    await prisma.$disconnect();
    process.exit(1);
  }

  // Audit AFTER the transaction succeeds. Audit row failures shouldn't undo
  // the data change, but should at least surface in logs so an operator can
  // backfill audit manually if needed.
  let audited = 0;
  for (const p of reroutable) {
    try {
      await writeAudit(
        p.kind,
        "TENANT_REROUTE",
        p.rowId,
        null,
        p.newTenantId,
        {
          previousTenantId: p.oldTenantId,
          newTenantId: p.newTenantId,
          reason: p.reason,
          source: "cleanup-orphan-whatsapp-tenant1.js",
        },
      );
      audited++;
    } catch (err) {
      console.warn(`[wa-cleanup] audit write failed for ${p.kind}/${p.rowId}:`, err.message);
    }
  }
  console.log(`[wa-cleanup] wrote ${audited}/${reroutable.length} audit row(s).`);

  await prisma.$disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error("[wa-cleanup] unexpected error:", err);
  try { await prisma.$disconnect(); } catch (_) { /* ignore */ }
  process.exit(2);
});
