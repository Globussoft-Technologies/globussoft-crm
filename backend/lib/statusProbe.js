/**
 * Status-page health probe service (PRD_STATUS_PAGE.md).
 *
 * Probes the public/internal health endpoints that back the status page,
 * updates StatusComponent.status, and writes daily uptime snapshots.
 *
 * Design notes:
 *   - All probes are fire-and-forget from the cron's perspective; a probe
 *     exception must NEVER bubble up and crash the cron or server.
 *   - Status is instance-level, not tenant-scoped.
 *   - Probes hit localhost by default so they work in every environment
 *     without extra config. Override with STATUS_PROBE_BASE_URL if needed.
 *   - Two consecutive failures are required before a component is marked
 *     `major_outage`; one failure marks `partial_outage`. This reduces
 *     flapping during transient network hiccups.
 */

const axios = require("axios");
const prisma = require("./prisma");

const DEFAULT_COMPONENTS = [
  {
    name: "CRM API",
    group: "Core",
    description: "Core REST API and web application",
    sortOrder: 1,
    probeUrl: "/api/health",
  },
  {
    name: "Database",
    group: "Core",
    description: "Primary MySQL database",
    sortOrder: 2,
    probeUrl: "/api/health",
  },
  {
    name: "Travel API",
    group: "Travel",
    description: "Travel-vertical API endpoints",
    sortOrder: 3,
    probeUrl: "/api/travel/health",
  },
  {
    name: "WebSocket / Real-time",
    group: "Core",
    description: "Socket.IO real-time events",
    sortOrder: 4,
    probeUrl: "/api/health",
  },
  {
    name: "WhatsApp Gateway",
    group: "Integrations",
    description: "WhatsApp Business API integration",
    sortOrder: 5,
    probeUrl: "/api/whatsapp/onboard/status",
  },
];

const STATUS_ORDER = {
  operational: 0,
  maintenance: 1,
  degraded: 2,
  partial_outage: 3,
  major_outage: 4,
  no_data: 5,
};

function getBaseUrl() {
  if (process.env.STATUS_PROBE_BASE_URL) {
    return process.env.STATUS_PROBE_BASE_URL.replace(/\/$/, "");
  }
  const port = process.env.PORT || 5000;
  return `http://localhost:${port}`;
}

function resolveProbeUrl(component) {
  const base = getBaseUrl();
  const path = component.probeUrl || "/api/health";
  return `${base}${path}`;
}

async function fetchHealth(url, timeoutMs = 10000) {
  const start = Date.now();
  const response = await axios.get(url, {
    timeout: timeoutMs,
    validateStatus: () => true, // don't throw on 4xx/5xx
    headers: { Accept: "application/json" },
  });
  const responseTimeMs = Date.now() - start;
  return { response, responseTimeMs };
}

function deriveStatus(component, { response, responseTimeMs, error }) {
  if (error) {
    const code = error.code || "";
    const isTimeout =
      code === "ECONNABORTED" || code === "ETIMEDOUT" || /timeout/i.test(code);
    return { status: isTimeout ? "partial_outage" : "major_outage", error };
  }

  if (response.status >= 500) {
    return { status: "major_outage", error: `HTTP ${response.status}` };
  }
  if (response.status >= 400) {
    return { status: "partial_outage", error: `HTTP ${response.status}` };
  }

  // CRM API /health returns { status: "healthy" | "degraded", database: ... }
  const body = response.data || {};
  if (body.status === "degraded") {
    return { status: "degraded", error: "health endpoint reported degraded" };
  }

  // Slow responses are treated as degraded if they exceed 2 seconds.
  if (responseTimeMs > 2000) {
    return { status: "degraded", error: `response time ${responseTimeMs}ms` };
  }

  return { status: "operational", error: null };
}

async function seedStatusComponents() {
  for (const def of DEFAULT_COMPONENTS) {
    await prisma.statusComponent.upsert({
      where: { name: def.name },
      update: {},
      create: def,
    });
  }
}

async function probeComponent(component) {
  const url = resolveProbeUrl(component);
  try {
    const { response, responseTimeMs } = await fetchHealth(url);
    return deriveStatus(component, { response, responseTimeMs, error: null });
  } catch (err) {
    return deriveStatus(component, {
      response: null,
      responseTimeMs: null,
      error: err,
    });
  }
}

function applyHysteresis(newStatus, consecutiveFailures) {
  const newOrder = STATUS_ORDER[newStatus] || 0;

  if (newStatus === "operational") {
    return { status: "operational", consecutiveFailures: 0 };
  }

  // Failure path: bump failure counter.
  const failures = consecutiveFailures + 1;
  if (failures >= 2 && newOrder >= STATUS_ORDER.major_outage) {
    return { status: "major_outage", consecutiveFailures: failures };
  }
  if (newOrder >= STATUS_ORDER.partial_outage) {
    return { status: "partial_outage", consecutiveFailures: failures };
  }
  if (newOrder >= STATUS_ORDER.degraded) {
    return { status: "degraded", consecutiveFailures: failures };
  }
  return { status: newStatus, consecutiveFailures: failures };
}

/**
 * Run all probes and update StatusComponent rows.
 * Returns { ok: boolean, results: [{ name, status, error? }], durationMs }.
 */
async function runStatusProbes() {
  const components = await prisma.statusComponent.findMany({
    where: { isPublic: true },
    orderBy: { sortOrder: "asc" },
  });

  const start = Date.now();
  const results = [];

  for (const component of components) {
    const probe = await probeComponent(component);
    const { status, consecutiveFailures } = applyHysteresis(
      probe.status,
      component.consecutiveFailures,
    );

    await prisma.statusComponent.update({
      where: { id: component.id },
      data: {
        status,
        consecutiveFailures,
        lastProbedAt: new Date(),
      },
    });

    results.push({
      name: component.name,
      status,
      previousStatus: component.status,
      error: probe.error ? String(probe.error) : null,
    });
  }

  return { ok: true, results, durationMs: Date.now() - start };
}

/**
 * Write yesterday's daily snapshot rows for every public component.
 * Should be called once per day (e.g. at 00:05 UTC).
 */
async function writeDailySnapshots() {
  const components = await prisma.statusComponent.findMany({
    where: { isPublic: true },
  });

  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  yesterday.setUTCHours(0, 0, 0, 0);

  const written = [];
  for (const component of components) {
    // For v1 we use the current component.status as the day's worst status.
    // In Phase 2 we can aggregate actual probe events for true daily uptime.
    const worstStatus = component.status;
    const uptimePct = worstStatus === "operational" ? 100 : 0;

    const row = await prisma.statusDailySnapshot.upsert({
      where: {
        componentId_date: {
          componentId: component.id,
          date: yesterday,
        },
      },
      update: {
        uptimePct,
        worstStatus,
      },
      create: {
        componentId: component.id,
        date: yesterday,
        uptimePct,
        worstStatus,
        probeCount: 1,
        failCount: worstStatus === "operational" ? 0 : 1,
      },
    });
    written.push(row);
  }

  return { date: yesterday.toISOString(), count: written.length };
}

module.exports = {
  seedStatusComponents,
  runStatusProbes,
  writeDailySnapshots,
  getBaseUrl,
  STATUS_ORDER,
};
