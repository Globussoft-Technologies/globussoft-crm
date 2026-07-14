// Travel CRM — airline web check-in AUTOMATION engine.
//
// PRD_AIRLINE_WEBCHECKIN_AUTOMATION.md FR-1/FR-6/FR-7/FR-9/FR-10/FR-11. This is
// the engine that ACTUALLY performs the check-in — distinct from:
//   - cron/webCheckinScheduler.js  (status lifecycle: pending->reminded, +30min
//                                   stall->fallback-agent, advisor notifications)
//   - cron/webCheckinEngine.js     (customer-facing T-36/24/12h reminder emails)
//
// Every 15 min it picks up `reminded` (and retry-eligible `in-progress`) rows on
// PAID, non-Visa-Sure itineraries whose check-in window has opened and whose
// flight hasn't departed, resolves the per-airline adapter
// (services/airlineAdapters), and drives the check-in:
//
//   adapter ok          -> status 'done' + boardingPassUrl + completedAt
//   adapter captcha     -> status 'fallback-agent' immediately (no retry, FR-7)
//   adapter transient   -> retry up to 3x with 1/5/15-min backoff, then
//                          'fallback-agent' (FR-6)
//   adapter not-implemented / no adapter -> 'fallback-agent' immediately
//                          (human completes via /upload-boarding-pass)
//
// Every attempt writes one WebCheckinAutomationRun row (per-airline health,
// FR-8) + a writeAudit row (FR-10). Rows with automationSkipped=true are never
// picked up (FR-11). Retry state lives in WebCheckin.attemptsJson
// ([{at, result, reason, errorReason}]); a row stays 'in-progress' between
// transient retries so neither the scheduler nor a fresh tick double-runs it.
//
// Adapters are stubbed today (return 'not-implemented') so this engine is a
// no-op-to-fallback in production until an airline adapter goes live. Set
// WEBCHECKIN_AUTOMATION_STUB=1 to drive the full loop with the deterministic
// stub adapter (see services/airlineAdapters/_stub.js).
//
// Travel-only: WebCheckin rows exist only in the travel vertical.

const cronRegistry = require("../lib/cronRegistry");
const prisma = require("../lib/prisma");
const { writeAudit } = require("../lib/audit");
const { resolveAdapter: defaultResolveAdapter } = require("../services/airlineAdapters");

const MAX_ATTEMPTS = 3;
// Minutes to wait before the Nth retry, indexed by prior-failure count:
// after 1 failure wait 1 min, after 2 failures wait 5 min (the 3rd failure
// terminates to fallback-agent, so 15 is the documented-but-unreached tail).
const BACKOFF_MIN = [1, 5, 15];
const ATTEMPT_TIMEOUT_MS = Number(process.env.WEBCHECKIN_ATTEMPT_TIMEOUT_MS || 60000);
const PAID_STATUSES = ["advance_paid", "fully_paid"];
const PICKUP_STATUSES = ["reminded", "in-progress"];
const BATCH_LIMIT = 200;

function parseAttempts(json) {
  if (!json) return [];
  try {
    const a = JSON.parse(json);
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

// Resolve adapter result, enforcing a hard per-attempt timeout. Never throws —
// an adapter throw or timeout becomes a typed transient failure.
async function runAdapterWithTimeout(adapter, input) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, reason: "transient", error: "adapter timeout" }),
      ATTEMPT_TIMEOUT_MS,
    );
  });
  try {
    const result = await Promise.race([
      Promise.resolve()
        .then(() => adapter.performCheckIn(input))
        .catch((e) => ({ ok: false, reason: "transient", error: e && e.message })),
      timeout,
    ]);
    return result || { ok: false, reason: "transient", error: "adapter returned nothing" };
  } finally {
    clearTimeout(timer);
  }
}

// Idempotent ops notification (dedupe on tenant+entity+type, like the scheduler).
async function notifyOnce({ tenantId, entityId, type, title, message, priority }) {
  try {
    const existing = await prisma.notification.findFirst({
      where: { tenantId, entityType: "WebCheckin", entityId, type },
      select: { id: true },
    });
    if (existing) return;
    await prisma.notification.create({
      data: {
        tenantId,
        title,
        message,
        type,
        priority: priority || "normal",
        entityType: "WebCheckin",
        entityId,
      },
    });
  } catch (e) {
    console.error("[WebCheckinAutomation] notify failed:", e.message);
  }
}

async function recordRun({ tenantId, webCheckinId, airlineCode, outcome, attempt, durationMs, errorReason }) {
  try {
    await prisma.webCheckinAutomationRun.create({
      data: {
        tenantId,
        webCheckinId,
        airlineCode: airlineCode || "??",
        outcome,
        attempt,
        durationMs: durationMs == null ? null : Math.round(durationMs),
        errorReason: errorReason ? String(errorReason).slice(0, 500) : null,
      },
    });
  } catch (e) {
    console.error("[WebCheckinAutomation] run-row create failed:", e.message);
  }
}

function audit(action, row, details) {
  // entity, action, entityId, userId(null=system), tenantId, details
  return writeAudit("WebCheckin", `automation.${action}`, row.id, null, row.tenantId, details).catch(
    (e) => console.error("[WebCheckinAutomation] audit failed:", e && e.message),
  );
}

/**
 * Process a single row. Returns a short action tag for the tick summary:
 *   'done' | 'fallback' | 'retry-scheduled' | 'backoff-wait' | 'skipped'
 * `now` and `resolveAdapter` are injectable for tests.
 */
async function processRow(row, { now, resolveAdapter }) {
  const attempts = parseAttempts(row.attemptsJson);
  const priorFailures = attempts.filter((a) => a && a.result === "failure").length;

  // Backoff gate — wait BACKOFF_MIN[priorFailures-1] minutes between transient
  // retries. Skip this tick if not enough time has elapsed since the last try.
  if (priorFailures > 0) {
    const last = attempts[attempts.length - 1];
    const lastAt = last && last.at ? new Date(last.at).getTime() : 0;
    const waitMin = BACKOFF_MIN[Math.min(priorFailures - 1, BACKOFF_MIN.length - 1)];
    if (lastAt && now.getTime() - lastAt < waitMin * 60 * 1000) {
      return "backoff-wait";
    }
  }

  const attemptNo = attempts.length + 1;
  const adapter = resolveAdapter(row.airlineCode);

  // No Phase-1 adapter for this airline -> human fallback (treated as
  // not-implemented). No 'in-progress' claim, no retry.
  if (!adapter) {
    await prisma.webCheckin
      .update({ where: { id: row.id }, data: { status: "fallback-agent" } })
      .catch(() => {});
    await recordRun({
      tenantId: row.tenantId, webCheckinId: row.id, airlineCode: row.airlineCode,
      outcome: "not-implemented", attempt: attemptNo, durationMs: 0,
      errorReason: `no adapter for airline ${row.airlineCode}`,
    });
    await audit("not-implemented", row, { airlineCode: row.airlineCode, reason: "no-adapter" });
    await notifyOnce({
      tenantId: row.tenantId, entityId: row.id, type: "warning", priority: "high",
      title: `Web check-in needs manual action: ${row.airlineCode} ${row.flightNumber}`,
      message: `${row.passengerName} — PNR ${row.pnr}. No automation adapter for ${row.airlineCode}; please check in manually and upload the boarding pass.`,
    });
    return "fallback";
  }

  // Claim the row so neither the scheduler nor a parallel tick double-runs it.
  await prisma.webCheckin
    .update({ where: { id: row.id }, data: { status: "in-progress" } })
    .catch(() => {});

  const startedAt = now.getTime();
  const result = await runAdapterWithTimeout(adapter, {
    pnr: row.pnr,
    lastName: (row.passengerName || "").trim().split(/\s+/).pop() || row.passengerName,
    passengerName: row.passengerName,
    seatPref: row.seatPref || "aisle",
    airlineCode: row.airlineCode,
    flightNumber: row.flightNumber,
    departureAt: row.departureAt,
  });
  const durationMs = Date.now() - startedAt;

  // ── Success ────────────────────────────────────────────────────────
  if (result && result.ok) {
    const next = [...attempts, { at: now.toISOString(), result: "success" }];
    await prisma.webCheckin.update({
      where: { id: row.id },
      data: {
        status: "done",
        boardingPassUrl: result.boardingPassUrl || row.boardingPassUrl || null,
        completedAt: now,
        attemptsJson: JSON.stringify(next),
      },
    });
    await recordRun({
      tenantId: row.tenantId, webCheckinId: row.id, airlineCode: row.airlineCode,
      outcome: "success", attempt: attemptNo, durationMs,
    });
    await audit("success", row, { airlineCode: row.airlineCode, attempt: attemptNo, boardingPassUrl: result.boardingPassUrl });
    await notifyOnce({
      tenantId: row.tenantId, entityId: row.id, type: "success",
      title: `Web check-in complete: ${row.airlineCode} ${row.flightNumber}`,
      message: `${row.passengerName} — PNR ${row.pnr}. Boarding pass ready; deliver to the passenger from the queue.`,
    });
    // FR-13 delivery hook: the existing POST /webcheckins/:id/deliver flow (or a
    // future internal call) forwards the pass over WhatsApp. Left to the
    // operator/deliver endpoint to keep this engine decoupled from the WA client.
    return "done";
  }

  const reason = (result && result.reason) || "transient";
  const errorReason = (result && result.error) || reason;

  // ── Captcha -> immediate fallback (FR-7, no retry) ──────────────────
  if (reason === "captcha") {
    const next = [...attempts, { at: now.toISOString(), result: "captcha", errorReason }];
    await prisma.webCheckin.update({
      where: { id: row.id },
      data: { status: "fallback-agent", attemptsJson: JSON.stringify(next) },
    });
    await recordRun({
      tenantId: row.tenantId, webCheckinId: row.id, airlineCode: row.airlineCode,
      outcome: "captcha", attempt: attemptNo, durationMs, errorReason,
    });
    await audit("captcha", row, { airlineCode: row.airlineCode, attempt: attemptNo });
    await notifyOnce({
      tenantId: row.tenantId, entityId: row.id, type: "warning", priority: "high",
      title: `Web check-in hit a captcha: ${row.airlineCode} ${row.flightNumber}`,
      message: `${row.passengerName} — PNR ${row.pnr}. Airline served a captcha; please check in manually and upload the boarding pass.`,
    });
    return "fallback";
  }

  // ── not-implemented (adapter scaffold) -> immediate fallback ────────
  if (reason === "not-implemented") {
    await prisma.webCheckin
      .update({ where: { id: row.id }, data: { status: "fallback-agent" } })
      .catch(() => {});
    await recordRun({
      tenantId: row.tenantId, webCheckinId: row.id, airlineCode: row.airlineCode,
      outcome: "not-implemented", attempt: attemptNo, durationMs, errorReason,
    });
    await audit("not-implemented", row, { airlineCode: row.airlineCode });
    await notifyOnce({
      tenantId: row.tenantId, entityId: row.id, type: "warning", priority: "high",
      title: `Web check-in needs manual action: ${row.airlineCode} ${row.flightNumber}`,
      message: `${row.passengerName} — PNR ${row.pnr}. Automation for ${row.airlineCode} isn't live yet; please check in manually and upload the boarding pass.`,
    });
    return "fallback";
  }

  // ── Transient / portal-down -> retry with backoff, then fallback ────
  const next = [...attempts, { at: now.toISOString(), result: "failure", reason, errorReason }];
  const failuresNow = priorFailures + 1;
  await recordRun({
    tenantId: row.tenantId, webCheckinId: row.id, airlineCode: row.airlineCode,
    outcome: "failure", attempt: attemptNo, durationMs, errorReason,
  });

  if (failuresNow >= MAX_ATTEMPTS) {
    await prisma.webCheckin.update({
      where: { id: row.id },
      data: { status: "fallback-agent", attemptsJson: JSON.stringify(next) },
    });
    await audit("fallback", row, { airlineCode: row.airlineCode, attempts: failuresNow, reason, errorReason });
    await notifyOnce({
      tenantId: row.tenantId, entityId: row.id, type: "warning", priority: "high",
      title: `Web check-in failed after ${failuresNow} tries: ${row.airlineCode} ${row.flightNumber}`,
      message: `${row.passengerName} — PNR ${row.pnr}. Automation failed (${reason}); please check in manually and upload the boarding pass.`,
    });
    return "fallback";
  }

  // Keep the row 'in-progress' so the next eligible tick retries after backoff.
  await prisma.webCheckin.update({
    where: { id: row.id },
    data: { status: "in-progress", attemptsJson: JSON.stringify(next) },
  });
  return "retry-scheduled";
}

/**
 * One pass over all eligible rows across all travel tenants.
 * `now` + `resolveAdapter` injectable for tests. Returns an observability summary.
 */
async function runWebCheckinAutomationTick(now = new Date(), deps = {}) {
  const resolveAdapter = deps.resolveAdapter || defaultResolveAdapter;
  const summary = { scanned: 0, done: 0, fallback: 0, retryScheduled: 0, backoffWait: 0, skipped: 0 };

  const rows = await prisma.webCheckin.findMany({
    where: {
      status: { in: PICKUP_STATUSES },
      automationSkipped: false,
      windowOpenAt: { lte: now },
      departureAt: { gt: now },
      itineraryId: { not: null },
    },
    select: {
      id: true, tenantId: true, itineraryId: true, contactId: true,
      pnr: true, airlineCode: true, flightNumber: true, passengerName: true,
      seatPref: true, departureAt: true, status: true, attemptsJson: true,
      boardingPassUrl: true,
    },
    orderBy: { departureAt: "asc" },
    take: BATCH_LIMIT,
  });
  summary.scanned = rows.length;
  if (rows.length === 0) return summary;

  // Gate on PAID + non-Visa-Sure parent itinerary (mirrors webCheckinEngine.js).
  const itinIds = [...new Set(rows.map((r) => r.itineraryId).filter(Boolean))];
  const itins = itinIds.length
    ? await prisma.itinerary.findMany({
        where: { id: { in: itinIds } },
        select: { id: true, status: true, subBrand: true },
      })
    : [];
  const itinById = Object.fromEntries(itins.map((i) => [i.id, i]));

  for (const row of rows) {
    const itin = itinById[row.itineraryId];
    if (!itin || !PAID_STATUSES.includes(itin.status) || itin.subBrand === "visasure") {
      summary.skipped += 1;
      continue;
    }
    try {
      const action = await processRow(row, { now, resolveAdapter });
      if (action === "done") summary.done += 1;
      else if (action === "fallback") summary.fallback += 1;
      else if (action === "retry-scheduled") summary.retryScheduled += 1;
      else if (action === "backoff-wait") summary.backoffWait += 1;
      else summary.skipped += 1;
    } catch (e) {
      console.error(`[WebCheckinAutomation] row ${row.id} failed:`, e.message);
      summary.skipped += 1;
    }
  }

  console.log(
    `[WebCheckinAutomation] tick: scanned=${summary.scanned} done=${summary.done} ` +
      `fallback=${summary.fallback} retry=${summary.retryScheduled} backoff=${summary.backoffWait} skipped=${summary.skipped}`,
  );
  return summary;
}

function initWebCheckinAutomationCron() {
  // Every 15 min, off-cluster (mirrors scheduler's jitter but offset by a few
  // minutes so automation claims `reminded` rows before the scheduler's
  // +30-min stall sweep can flip them to fallback-agent).
  cronRegistry.register({
    name: "webCheckinAutomation",
    description: "Performs airline web check-in for reminded/retry-eligible bookings (every 15 min)",
    defaultSchedule: "8,23,38,53 * * * *",
    tickFn: runWebCheckinAutomationTick,
  }).catch((e) => console.error("[WebCheckinAutomation] cronRegistry registration failed:", e.message));
}

module.exports = {
  runWebCheckinAutomationTick,
  processRow,
  initWebCheckinAutomationCron,
  MAX_ATTEMPTS,
  BACKOFF_MIN,
  PAID_STATUSES,
};
