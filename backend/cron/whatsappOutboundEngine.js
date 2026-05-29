//
// WhatsApp outbound delivery engine (P3, scaffolded in P1 deploy).
//
// Ticks every 30 seconds. Claims PENDING WaOutboundJob rows whose runAt
// has passed, sends them to Meta via services/whatsappProvider.js, and
// updates the WhatsAppMessage status atomically.
//
// Retry policy:
//   • 5xx / network / 429 → exponential backoff, max 5 attempts:
//       1m, 5m, 15m, 1h, 6h  (then DEAD)
//   • 4xx auth (code 190)  → mark FAILED immediately; runtime catch
//                            also triggers the disconnect path in P4
//                            (cron/whatsappTokenRefreshEngine.js).
//   • 4xx other (template/policy) → mark FAILED, no retry.
//
// Pessimistic claim:
//   The engine takes up to OUTBOUND_TICK_BATCH rows per tick. Each is
//   claimed via UPDATE … SET lockedAt = NOW(), lockedBy = <pid> WHERE
//   lockedAt IS NULL — Prisma transactional reads aren't strong enough
//   under concurrent PM2 workers, so we rely on the column-level update
//   to serialise. Stale locks (>60s) get reclaimed at the start of each
//   tick.
//
// Per-phone-number budget:
//   Tier-aware throttling lives in the picker — outbound rows are
//   bucketed by phoneNumberId, and each bucket is capped at
//   `tierBudget(messagingLimitTier)` per tick. One noisy tenant can't
//   starve others.
//
// Degradation when Meta config is missing:
//   If a row's owning WhatsAppConfig is disconnected, businessRestricted,
//   or has no accessToken, the engine marks the row FAILED with a clear
//   `lastError` rather than spinning indefinitely.

const cron = require("node-cron");
const prisma = require("../lib/prisma");
const { decryptCredential } = require("../lib/credentialMasking");
const { sendText, sendTemplate } = require("../services/whatsappProvider");

// Socket.io reference for broadcasting sent/failed events. Set via
// initWhatsappOutboundCron(io). Optional — if unset, broadcasts are
// skipped (the cron still updates DB; frontend can poll).
let socketIo = null;

const TICK_CRON = "*/30 * * * * *"; // every 30 seconds
const BATCH_SIZE = 100;
const STALE_LOCK_MS = 60 * 1000;
const BACKOFF_STEPS_MS = [
  60 * 1000, // 1m
  5 * 60 * 1000, // 5m
  15 * 60 * 1000, // 15m
  60 * 60 * 1000, // 1h
  6 * 60 * 60 * 1000, // 6h
];
const MAX_ATTEMPTS = BACKOFF_STEPS_MS.length;
const WORKER_ID = `pid-${process.pid}`;

// Meta tier → per-tick budget. Conservative defaults so we don't burn
// quality rating in a burst. Real Meta limits are per-24h "unique customer"
// conversations, but per-tick limiting is a cheap proxy.
const TIER_BUDGETS = {
  TIER_50: 5,
  TIER_250: 10,
  TIER_1K: 25,
  TIER_10K: 50,
  TIER_100K: 100,
  UNLIMITED: 100,
};
function tierBudget(tier) {
  return TIER_BUDGETS[tier] || 20; // unknown / null tier → 20 sends/tick
}

async function reclaimStaleLocks() {
  const threshold = new Date(Date.now() - STALE_LOCK_MS);
  await prisma.waOutboundJob.updateMany({
    where: {
      status: "IN_FLIGHT",
      lockedAt: { lt: threshold },
    },
    data: { status: "PENDING", lockedAt: null, lockedBy: null },
  });
}

async function pickJobs() {
  // Step 1: find candidate rows (PENDING + due + unlocked).
  const candidates = await prisma.waOutboundJob.findMany({
    where: {
      status: "PENDING",
      runAt: { lte: new Date() },
      lockedAt: null,
    },
    orderBy: { runAt: "asc" },
    take: BATCH_SIZE,
    select: { id: true, tenantId: true },
  });
  if (candidates.length === 0) return [];

  // Step 2: claim them. updateMany with WHERE lockedAt IS NULL serializes
  // across concurrent workers.
  const ids = candidates.map((c) => c.id);
  await prisma.waOutboundJob.updateMany({
    where: { id: { in: ids }, lockedAt: null, status: "PENDING" },
    data: { status: "IN_FLIGHT", lockedAt: new Date(), lockedBy: WORKER_ID },
  });

  // Step 3: re-fetch only the ones we actually claimed (lockedBy === us).
  return prisma.waOutboundJob.findMany({
    where: { id: { in: ids }, lockedBy: WORKER_ID, status: "IN_FLIGHT" },
    include: { message: true },
  });
}

async function loadConfigsForTenants(tenantIds) {
  if (tenantIds.size === 0) return new Map();
  const rows = await prisma.whatsAppConfig.findMany({
    where: {
      tenantId: { in: [...tenantIds] },
      isActive: true,
    },
  });
  const m = new Map();
  for (const r of rows) m.set(r.tenantId, r);
  return m;
}

function classifyError(err) {
  // Provider returns { success: false, error: <string> }. The string is the
  // best signal we have without re-modelling Meta's full error surface.
  const text = String(err || "").toLowerCase();
  if (
    text.includes('code":190') ||
    text.includes("error code 190") ||
    text.includes("access token")
  ) {
    return { retryable: false, reason: "AUTH" };
  }
  if (
    text.includes("rate") ||
    text.includes("429") ||
    text.includes("too many")
  ) {
    return { retryable: true, reason: "RATE_LIMIT" };
  }
  if (
    text.includes("500") ||
    text.includes("503") ||
    text.includes("network") ||
    text.includes("etimedout")
  ) {
    return { retryable: true, reason: "TRANSIENT" };
  }
  return { retryable: false, reason: "PERMANENT" };
}

async function processJob(job, config) {
  const msg = job.message;

  // Pre-flight: config must exist, not be disconnected, not restricted,
  // and have an access token. Anything else = permanent failure.
  if (!config) {
    return {
      ok: false,
      error: "No active WhatsAppConfig for tenant",
      retryable: false,
    };
  }
  if (config.disconnectedAt) {
    return {
      ok: false,
      error: `Tenant disconnected at ${config.disconnectedAt.toISOString()}`,
      retryable: false,
    };
  }
  if (config.businessRestricted) {
    return {
      ok: false,
      error: "Tenant business restricted by Meta",
      retryable: false,
    };
  }
  if (!config.accessToken || !config.phoneNumberId) {
    return {
      ok: false,
      error: "WhatsAppConfig missing accessToken or phoneNumberId",
      retryable: false,
    };
  }

  const accessToken = decryptCredential(config.accessToken);
  let result;
  try {
    if (msg.templateName) {
      // Look up template for language code; default en_US matches existing provider behaviour.
      const tpl = await prisma.whatsAppTemplate.findFirst({
        where: { tenantId: job.tenantId, name: msg.templateName },
        select: { language: true },
      });
      // Read the template parameters persisted by the /send route (and
      // automations) in interactiveJson. Without this the cron sent
      // parameters:[] → Meta #132000 "Number of parameters does not match"
      // for any template with {{n}} placeholders (e.g. visit_complete_v1).
      let parameters = [];
      if (msg.interactiveJson) {
        try {
          const parsed = JSON.parse(msg.interactiveJson);
          if (Array.isArray(parsed)) parameters = parsed;
          else if (Array.isArray(parsed?.parameters))
            parameters = parsed.parameters;
        } catch (_e) {
          /* malformed → send param-less; Meta surfaces the mismatch */
        }
      }
      result = await sendTemplate({
        to: msg.to,
        templateName: msg.templateName,
        language: tpl?.language || "en_US",
        parameters,
        phoneNumberId: config.phoneNumberId,
        accessToken,
      });
    } else if (msg.body) {
      result = await sendText({
        to: msg.to,
        body: msg.body,
        phoneNumberId: config.phoneNumberId,
        accessToken,
      });
    } else {
      return {
        ok: false,
        error: "Message has no body or templateName",
        retryable: false,
      };
    }
  } catch (err) {
    return { ok: false, error: err.message || String(err), retryable: true };
  }

  if (result.success) {
    return { ok: true, providerMsgId: result.providerMsgId };
  }
  const c = classifyError(result.error);
  return {
    ok: false,
    error: result.error,
    retryable: c.retryable,
    reason: c.reason,
  };
}

async function finishJob(job, outcome) {
  const now = new Date();
  if (outcome.ok) {
    await prisma.$transaction([
      prisma.whatsAppMessage.update({
        where: { id: job.messageId },
        data: {
          status: "SENT",
          providerMsgId: outcome.providerMsgId || null,
          errorMessage: null,
        },
      }),
      prisma.waOutboundJob.update({
        where: { id: job.id },
        data: {
          status: "DONE",
          lockedAt: null,
          lockedBy: null,
          lastError: null,
          updatedAt: now,
        },
      }),
    ]);
    if (socketIo) {
      socketIo.emit("whatsapp:sent", {
        messageId: job.messageId,
        providerMsgId: outcome.providerMsgId || null,
        status: "SENT",
        tenantId: job.tenantId,
      });
    }
    return;
  }

  const newAttempts = job.attempts + 1;
  if (!outcome.retryable || newAttempts >= MAX_ATTEMPTS) {
    const finalStatus = !outcome.retryable ? "FAILED" : "DEAD";
    await prisma.$transaction([
      prisma.whatsAppMessage.update({
        where: { id: job.messageId },
        data: {
          status: "FAILED",
          errorMessage: outcome.error || "send failed",
        },
      }),
      prisma.waOutboundJob.update({
        where: { id: job.id },
        data: {
          status: finalStatus,
          attempts: newAttempts,
          lastError: outcome.error || null,
          lockedAt: null,
          lockedBy: null,
        },
      }),
    ]);
    if (socketIo) {
      socketIo.emit("whatsapp:sent", {
        messageId: job.messageId,
        status: "FAILED",
        error: outcome.error || "send failed",
        tenantId: job.tenantId,
      });
    }
    return;
  }

  // Schedule retry.
  const backoff =
    BACKOFF_STEPS_MS[Math.min(newAttempts - 1, BACKOFF_STEPS_MS.length - 1)];
  await prisma.waOutboundJob.update({
    where: { id: job.id },
    data: {
      status: "PENDING",
      attempts: newAttempts,
      lastError: outcome.error || null,
      lockedAt: null,
      lockedBy: null,
      runAt: new Date(Date.now() + backoff),
    },
  });
}

async function tick() {
  try {
    // Defensive: skip if the prisma client doesn't have WaOutboundJob yet
    // (i.e. `prisma generate` hasn't run after the P3 schema additions).
    // Logged once at warn-level so the operator sees the path forward.
    if (!prisma.waOutboundJob?.findMany) {
      if (!tick._warnedMissingModel) {
        console.warn(
          "[whatsappOutboundEngine] prisma client missing waOutboundJob — run `prisma generate` then restart",
        );
        tick._warnedMissingModel = true;
      }
      return;
    }
    await reclaimStaleLocks();
    const jobs = await pickJobs();
    if (jobs.length === 0) return;

    // Bucket by phoneNumberId via tenant→config lookup, then apply tier budgets.
    const tenantIds = new Set(jobs.map((j) => j.tenantId));
    const configsByTenant = await loadConfigsForTenants(tenantIds);
    const buckets = new Map(); // key: phoneNumberId  value: { budget, jobs[] }
    const stalled = []; // jobs without a usable config
    for (const j of jobs) {
      const cfg = configsByTenant.get(j.tenantId);
      if (!cfg || !cfg.phoneNumberId) {
        stalled.push({ job: j, config: cfg });
        continue;
      }
      const key = cfg.phoneNumberId;
      if (!buckets.has(key)) {
        buckets.set(key, {
          budget: tierBudget(cfg.messagingLimitTier),
          jobs: [],
          cfg,
        });
      }
      buckets.get(key).jobs.push(j);
    }

    // Process within budget.
    const processable = [];
    for (const [, b] of buckets) {
      processable.push(
        ...b.jobs.slice(0, b.budget).map((j) => ({ job: j, config: b.cfg })),
      );
      // Anything beyond the budget gets requeued by un-locking — runAt isn't
      // bumped because we want it picked up on the next 30s tick.
      for (const j of b.jobs.slice(b.budget)) {
        await prisma.waOutboundJob.update({
          where: { id: j.id },
          data: { status: "PENDING", lockedAt: null, lockedBy: null },
        });
      }
    }

    for (const item of [...processable, ...stalled]) {
      try {
        const outcome = await processJob(item.job, item.config);
        await finishJob(item.job, outcome);
      } catch (err) {
        await finishJob(item.job, {
          ok: false,
          error: err.message || String(err),
          retryable: true,
        });
      }
    }

    if (processable.length > 0) {
      console.log(
        `[whatsappOutboundEngine] processed ${processable.length} job(s) across ${buckets.size} phone-number-id(s)`,
      );
    }
  } catch (err) {
    console.error("[whatsappOutboundEngine] tick error:", err);
  }
}

function initWhatsappOutboundCron(io) {
  if (io) socketIo = io;
  cron.schedule(TICK_CRON, () => {
    tick();
  });
  console.log(`[whatsappOutboundEngine] initialized (cron: ${TICK_CRON})`);
}

module.exports = {
  initWhatsappOutboundCron,
  // Exported for tests
  _internals: {
    tick,
    pickJobs,
    processJob,
    finishJob,
    reclaimStaleLocks,
    tierBudget,
    classifyError,
    BACKOFF_STEPS_MS,
    MAX_ATTEMPTS,
  },
};
