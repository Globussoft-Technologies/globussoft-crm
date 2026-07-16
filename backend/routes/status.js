/**
 * Public status-page API (PRD_STATUS_PAGE.md).
 *
 * Public endpoints (no auth):
 *   GET  /api/status              overall status + component list + active incidents
 *   GET  /api/status/history      daily uptime snapshots for chart
 *   GET  /api/status/incidents    incident history
 *   GET  /api/status/feed.rss     RSS 2.0 feed
 *   GET  /api/status/feed.atom    Atom 1.0 feed
 *
 * Admin endpoints (SUPER_ADMIN):
 *   POST   /api/status/incidents                    create incident
 *   PATCH  /api/status/incidents/:id                update incident meta / resolve
 *   POST   /api/status/incidents/:id/updates        post update
 */

const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");
const { verifyToken, verifyRole } = require("../middleware/auth");
const { writeAudit } = require("../lib/audit");

/* eslint-disable gbscrm/tenant-scope-finder-heuristic --
   All Prisma reads in this file hit the instance-level Status* models
   (StatusComponent, StatusIncident, StatusDailySnapshot). These models are
   intentionally global / not tenant-scoped per PRD_STATUS_PAGE.md §4.1. */

const STATUS_ORDER = {
  operational: 0,
  maintenance: 1,
  degraded: 2,
  partial_outage: 3,
  major_outage: 4,
  no_data: 5,
};

const VALID_IMPACTS = ["none", "minor", "major", "critical", "maintenance"];
const VALID_INCIDENT_STATUSES = ["investigating", "identified", "monitoring", "resolved"];

function sendSuccess(res, data) {
  res.json({ success: true, data });
}

function sendError(res, statusCode, message, code = null) {
  const body = { success: false, error: message };
  if (code) body.code = code;
  res.status(statusCode).json(body);
}

function worstStatus(statuses) {
  let worst = "operational";
  for (const s of statuses) {
    if ((STATUS_ORDER[s] || 0) > (STATUS_ORDER[worst] || 0)) {
      worst = s;
    }
  }
  return worst;
}

function statusBannerText(status) {
  switch (status) {
    case "major_outage":
      return "Major Outage";
    case "partial_outage":
      return "Partial Outage";
    case "degraded":
      return "Degraded Performance";
    case "maintenance":
      return "Maintenance in Progress";
    default:
      return "All Systems Operational";
  }
}

function escapeXml(str) {
  return String(str || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function toRFC822(date) {
  return new Date(date).toUTCString();
}

function toISO(date) {
  return new Date(date).toISOString();
}

function getStatusUrl(req) {
  const host = req.get("host") || "crm.globusdemos.com";
  const proto = (req.get("x-forwarded-proto") || req.protocol || "https").split(",")[0].trim();
  return `${proto}://${host}/status`;
}

// ── Public endpoints ────────────────────────────────────────────────────────

router.get("/", async (_req, res) => {
  try {
    const components = await prisma.statusComponent.findMany({
      where: { isPublic: true },
      orderBy: [{ group: "asc" }, { sortOrder: "asc" }],
      select: {
        id: true,
        name: true,
        group: true,
        description: true,
        status: true,
        updatedAt: true,
      },
    });

    const activeIncidents = await prisma.statusIncident.findMany({
      where: { status: { not: "resolved" } },
      include: {
        components: { select: { name: true } },
        updates: { orderBy: { createdAt: "desc" }, take: 1 },
      },
      orderBy: { createdAt: "desc" },
    });

    const overall = worstStatus(components.map((c) => c.status));

    sendSuccess(res, {
      overall,
      bannerText: statusBannerText(overall),
      updatedAt: new Date().toISOString(),
      components,
      activeIncidents: activeIncidents.map((i) => ({
        id: i.id,
        title: i.title,
        impact: i.impact,
        status: i.status,
        components: i.components.map((c) => c.name),
        lastUpdate: i.updates[0] || null,
        createdAt: i.createdAt,
      })),
    });
  } catch (err) {
    console.error("[status] GET / failed:", err.message);
    sendError(res, 500, "Unable to load status");
  }
});

router.get("/history", async (req, res) => {
  try {
    const days = Math.min(90, Math.max(1, Number.parseInt(req.query.days, 10) || 30));
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - days);
    since.setUTCHours(0, 0, 0, 0);

    const components = await prisma.statusComponent.findMany({
      where: { isPublic: true },
      orderBy: { sortOrder: "asc" },
      select: { id: true, name: true, group: true },
    });

    const snapshots = await prisma.statusDailySnapshot.findMany({
      where: { date: { gte: since } },
      orderBy: { date: "asc" },
    });

    const rows = components.map((c) => ({
      componentId: c.id,
      name: c.name,
      group: c.group,
      days: snapshots
        .filter((s) => s.componentId === c.id)
        .map((s) => ({
          date: s.date.toISOString().slice(0, 10),
          uptimePct: s.uptimePct,
          worstStatus: s.worstStatus,
        })),
    }));

    sendSuccess(res, { days, since: since.toISOString(), rows });
  } catch (err) {
    console.error("[status] GET /history failed:", err.message);
    sendError(res, 500, "Unable to load history");
  }
});

router.get("/incidents", async (req, res) => {
  try {
    const activeOnly = req.query.active === "1" || req.query.active === "true";
    const take = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));

    const where = activeOnly ? { status: { not: "resolved" } } : {};
    const incidents = await prisma.statusIncident.findMany({
      where,
      include: {
        components: { select: { id: true, name: true, group: true } },
        updates: { orderBy: { createdAt: "asc" } },
      },
      orderBy: { createdAt: "desc" },
      take,
    });

    sendSuccess(res, { incidents });
  } catch (err) {
    console.error("[status] GET /incidents failed:", err.message);
    sendError(res, 500, "Unable to load incidents");
  }
});

function buildFeedItems() {
  return prisma.statusIncident.findMany({
    where: {
      OR: [{ status: { not: "resolved" } }, { resolvedAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } }],
    },
    include: {
      components: { select: { name: true } },
      updates: { orderBy: { createdAt: "asc" } },
    },
    orderBy: { createdAt: "desc" },
  });
}

router.get("/feed.rss", async (req, res) => {
  try {
    const incidents = await buildFeedItems();
    const statusUrl = getStatusUrl(req);

    let items = "";
    for (const i of incidents) {
      const lastUpdate = i.updates[i.updates.length - 1];
      const pubDate = lastUpdate ? lastUpdate.createdAt : i.createdAt;
      const affected = i.components.map((c) => c.name).join(", ") || "All systems";
      const updateText = lastUpdate ? `: ${lastUpdate.message}` : "";
      const description = escapeXml(
        `${i.title} — ${i.status}${updateText} (Affected: ${affected})`,
      );
      items += `
        <item>
          <title>${escapeXml(i.title)}</title>
          <link>${statusUrl}</link>
          <guid>${statusUrl}#incident-${i.id}</guid>
          <pubDate>${toRFC822(pubDate)}</pubDate>
          <description>${description}</description>
        </item>`;
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Globussoft CRM Status</title>
    <link>${statusUrl}</link>
    <description>Real-time and historical status for the Globussoft CRM platform.</description>
    <language>en</language>
    <lastBuildDate>${toRFC822(new Date())}</lastBuildDate>${items}
  </channel>
</rss>`;

    res.set("Content-Type", "application/rss+xml; charset=utf-8");
    res.send(xml);
  } catch (err) {
    console.error("[status] RSS feed failed:", err.message);
    sendError(res, 500, "Unable to generate feed");
  }
});

router.get("/feed.atom", async (req, res) => {
  try {
    const incidents = await buildFeedItems();
    const statusUrl = getStatusUrl(req);

    let entries = "";
    for (const i of incidents) {
      const lastUpdate = i.updates[i.updates.length - 1];
      const updated = lastUpdate ? lastUpdate.createdAt : i.createdAt;
      const affected = i.components.map((c) => c.name).join(", ") || "All systems";
      const updateText = lastUpdate ? `: ${lastUpdate.message}` : "";
      const summary = escapeXml(
        `${i.title} — ${i.status}${updateText} (Affected: ${affected})`,
      );
      entries += `
    <entry>
      <id>${statusUrl}#incident-${i.id}</id>
      <title>${escapeXml(i.title)}</title>
      <updated>${toISO(updated)}</updated>
      <link href="${statusUrl}" />
      <summary type="html">${summary}</summary>
    </entry>`;
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Globussoft CRM Status</title>
  <link href="${statusUrl}" />
  <updated>${toISO(new Date())}</updated>
  <id>${statusUrl}</id>${entries}
</feed>`;

    res.set("Content-Type", "application/atom+xml; charset=utf-8");
    res.send(xml);
  } catch (err) {
    console.error("[status] Atom feed failed:", err.message);
    sendError(res, 500, "Unable to generate feed");
  }
});

// ── Admin endpoints ─────────────────────────────────────────────────────────

const requireStatusAdmin = [verifyToken, verifyRole(["ADMIN", "SUPER_ADMIN"])];

function validateIncidentBody(body) {
  const { title, impact, status, componentIds, message } = body || {};
  if (!title || typeof title !== "string" || title.length > 200) {
    return "title is required (max 200 chars)";
  }
  if (!VALID_IMPACTS.includes(impact)) {
    return `impact must be one of ${VALID_IMPACTS.join(", ")}`;
  }
  if (!VALID_INCIDENT_STATUSES.includes(status)) {
    return `status must be one of ${VALID_INCIDENT_STATUSES.join(", ")}`;
  }
  if (!Array.isArray(componentIds) || componentIds.some((id) => !Number.isFinite(Number(id)))) {
    return "componentIds must be an array of numeric ids";
  }
  if (!message || typeof message !== "string" || message.length > 2000) {
    return "message is required (max 2000 chars)";
  }
  return null;
}

function buildPatchData(body, incident) {
  const { title, impact, status, componentIds } = body || {};
  const data = {};
  if (title !== undefined) data.title = title;
  if (impact !== undefined) {
    if (!VALID_IMPACTS.includes(impact)) return { error: "Invalid impact" };
    data.impact = impact;
  }
  if (status !== undefined) {
    if (!VALID_INCIDENT_STATUSES.includes(status)) return { error: "Invalid status" };
    data.status = status;
    data.resolvedAt = status === "resolved" && !incident.resolvedAt ? new Date() : null;
  }
  if (componentIds !== undefined) {
    if (!Array.isArray(componentIds) || componentIds.some((x) => !Number.isFinite(Number(x)))) {
      return { error: "componentIds must be an array of numeric ids" };
    }
    data.components = { set: componentIds.map((x) => ({ id: Number(x) })) };
  }
  return { data };
}

router.post("/incidents", requireStatusAdmin, async (req, res) => {
  try {
    const errMsg = validateIncidentBody(req.body);
    if (errMsg) return sendError(res, 400, errMsg, "VALIDATION_ERROR");

    const { title, impact, status, componentIds, message } = req.body;
    const resolvedAt = status === "resolved" ? new Date() : null;

    const incident = await prisma.statusIncident.create({
      data: {
        title,
        impact,
        status,
        resolvedAt,
        components: { connect: componentIds.map((id) => ({ id: Number(id) })) },
        updates: {
          create: { status, message },
        },
      },
      include: {
        components: true,
        updates: { orderBy: { createdAt: "asc" } },
      },
    });

    writeAudit(
      "STATUS_INCIDENT",
      "CREATE",
      incident.id,
      req.user.userId,
      req.user.tenantId,
      JSON.stringify({ title, impact, status, componentIds }),
    );

    sendSuccess(res, incident);
  } catch (err) {
    console.error("[status] POST /incidents failed:", err.message);
    sendError(res, 500, "Unable to create incident");
  }
});

router.patch("/incidents/:id", requireStatusAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return sendError(res, 400, "Invalid incident id");

    const incident = await prisma.statusIncident.findUnique({
      where: { id },
      include: { components: true },
    });
    if (!incident) return sendError(res, 404, "Incident not found");

    const { data, error } = buildPatchData(req.body, incident);
    if (error) return sendError(res, 400, error);

    const updated = await prisma.statusIncident.update({
      where: { id },
      data,
      include: { components: true, updates: { orderBy: { createdAt: "asc" } } },
    });

    const { title, impact, status, componentIds } = req.body || {};
    writeAudit(
      "STATUS_INCIDENT",
      "UPDATE",
      id,
      req.user.userId,
      req.user.tenantId,
      JSON.stringify({ title, impact, status, componentIds }),
    );

    sendSuccess(res, updated);
  } catch (err) {
    console.error("[status] PATCH /incidents/:id failed:", err.message);
    sendError(res, 500, "Unable to update incident");
  }
});

router.post("/incidents/:id/updates", requireStatusAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return sendError(res, 400, "Invalid incident id");

    const { status, message } = req.body || {};
    if (!VALID_INCIDENT_STATUSES.includes(status)) {
      return sendError(res, 400, `status must be one of ${VALID_INCIDENT_STATUSES.join(", ")}`);
    }
    if (!message || typeof message !== "string" || message.length > 2000) {
      return sendError(res, 400, "message is required (max 2000 chars)");
    }

    const incident = await prisma.statusIncident.findUnique({ where: { id } });
    if (!incident) return sendError(res, 404, "Incident not found");

    const updateData = { status, message };
    const incidentUpdateData = { status };
    if (status === "resolved" && !incident.resolvedAt) incidentUpdateData.resolvedAt = new Date();
    if (status !== "resolved") incidentUpdateData.resolvedAt = null;

    const [updatedIncident, update] = await prisma.$transaction([
      prisma.statusIncident.update({
        where: { id },
        data: incidentUpdateData,
        include: { components: true },
      }),
      prisma.statusIncidentUpdate.create({
        data: { incidentId: id, ...updateData },
      }),
    ]);

    writeAudit(
      "STATUS_INCIDENT",
      "UPDATE_POSTED",
      id,
      req.user.userId,
      req.user.tenantId,
      JSON.stringify({ status, message }),
    );

    sendSuccess(res, { incident: updatedIncident, update });
  } catch (err) {
    console.error("[status] POST /incidents/:id/updates failed:", err.message);
    sendError(res, 500, "Unable to post update");
  }
});

module.exports = router;
