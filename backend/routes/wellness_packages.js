/**
 * Wellness service packages — saleable bundles of services.
 *
 * Mounted at /api/wellness (paths below are namespaced under /packages, which
 * routes/wellness.js does not own).
 *
 * WHAT CHANGED
 *   The package builder used to be a pricing calculator that created no
 *   record — it produced a copy-paste sales pitch and nothing else. Admins can
 *   now save named packages, and the customer-facing catalog lists the public
 *   ones.
 *
 * PRICING IS A SNAPSHOT, NOT A DERIVATION
 *   `serviceIds` is a JSON array rather than a join table, and `grossPrice` /
 *   `price` are stored rather than recomputed on read. A service being
 *   renamed, repriced or retired later must not silently change a package
 *   already quoted to a customer. The read path DOES resolve the current
 *   service rows for display, and flags any that have since disappeared, so
 *   staff can see drift without the price moving under them.
 *
 * VISIBILITY
 *   `isActive` = offered at all. `isPublic` = listed on the customer catalog.
 *   A bespoke package negotiated for one client stays active but private.
 */

const express = require("express");
const prisma = require("../lib/prisma");
const { writeAudit, diffFields } = require("../lib/audit");
const { verifyWellnessRole } = require("../middleware/wellnessRole");
const { verifyToken } = require("../middleware/auth");

const router = express.Router();

const tenantWhere = (req, extra = {}) => ({ tenantId: req.user.tenantId, ...extra });

// Packages are commercial config, not PHI. Same gate shape as
// service-categories: admin/manager by wellnessRole, with an escape hatch for
// any custom RBAC role granted `services.write`.
const adminGate = verifyWellnessRole(
  ["admin", "manager"],
  { anyOfPermissions: [{ module: "services", action: "write" }] },
);

const MAX_SESSIONS = 60;
const MAX_SERVICES_PER_PACKAGE = 25;

/**
 * A positive integer id, or null.
 *
 * `Number(null)` and `Number('')` are both 0, which `Number.isFinite` happily
 * accepts — so a corrupt stored value would otherwise resolve to service id 0
 * and silently look like a real lookup. Ids are always positive.
 */
function toServiceId(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Parse the stored JSON id array, tolerating legacy/corrupt values. */
function parseServiceIds(raw) {
  try {
    const parsed = JSON.parse(raw || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.map(toServiceId).filter((id) => id !== null);
  } catch (_e) {
    return [];
  }
}

/**
 * Validate + normalize a create/update body.
 * @returns {{error?: {status:number, body:object}, data?: object}}
 */
function normalizePackageBody(body, { partial = false } = {}) {
  const out = {};

  if (body.name !== undefined || !partial) {
    const name = String(body.name || "").trim();
    if (!name) {
      return { error: { status: 400, body: { error: "Package name is required", code: "MISSING_NAME" } } };
    }
    out.name = name;
  }

  if (body.description !== undefined) {
    out.description = body.description ? String(body.description).trim() : null;
  }

  if (body.serviceIds !== undefined || !partial) {
    const ids = Array.isArray(body.serviceIds)
      ? body.serviceIds.map(toServiceId).filter((id) => id !== null)
      : [];
    const unique = [...new Set(ids)];
    if (unique.length === 0) {
      return {
        error: { status: 400, body: { error: "Select at least one service", code: "NO_SERVICES" } },
      };
    }
    if (unique.length > MAX_SERVICES_PER_PACKAGE) {
      return {
        error: {
          status: 400,
          body: { error: `A package can bundle at most ${MAX_SERVICES_PER_PACKAGE} services`, code: "TOO_MANY_SERVICES" },
        },
      };
    }
    out.serviceIds = unique;
  }

  if (body.sessions !== undefined || !partial) {
    const sessions = Number(body.sessions);
    if (!Number.isFinite(sessions) || sessions < 1 || sessions > MAX_SESSIONS) {
      return {
        error: { status: 400, body: { error: `Sessions must be between 1 and ${MAX_SESSIONS}`, code: "INVALID_SESSIONS" } },
      };
    }
    out.sessions = Math.round(sessions);
  }

  if (body.discountPercent !== undefined || !partial) {
    const discount = Number(body.discountPercent ?? 0);
    if (!Number.isFinite(discount) || discount < 0 || discount > 100) {
      return {
        error: { status: 400, body: { error: "Discount must be between 0 and 100", code: "INVALID_DISCOUNT" } },
      };
    }
    out.discountPercent = Math.round(discount);
  }

  if (body.isActive !== undefined) out.isActive = Boolean(body.isActive);
  if (body.isPublic !== undefined) out.isPublic = Boolean(body.isPublic);

  return { data: out };
}

/**
 * Price a package from the CURRENT service rows.
 *
 * Called only on create/update — never on read — so the stored figures stay a
 * snapshot of what was agreed. Tenant-scoped so a package can never be priced
 * off another tenant's service.
 */
async function priceFromServices(tenantId, serviceIds, sessions, discountPercent) {
  const services = await prisma.service.findMany({
    where: { tenantId, id: { in: serviceIds } },
    select: { id: true, basePrice: true },
  });

  if (services.length !== serviceIds.length) {
    const found = new Set(services.map((s) => s.id));
    const missing = serviceIds.filter((id) => !found.has(id));
    return {
      error: {
        status: 400,
        body: {
          error: `Unknown service id(s): ${missing.join(", ")}`,
          code: "UNKNOWN_SERVICE",
          missing,
        },
      },
    };
  }

  const perSession = services.reduce((sum, s) => sum + (s.basePrice || 0), 0);
  const grossPrice = perSession * sessions;
  const price = Math.round(grossPrice - (grossPrice * discountPercent) / 100);
  return { grossPrice, price };
}

/** Attach the resolved service rows for display, flagging any that vanished. */
async function decorate(tenantId, rows) {
  const allIds = [...new Set(rows.flatMap((r) => parseServiceIds(r.serviceIds)))];
  const services = allIds.length
    ? await prisma.service.findMany({
        where: { tenantId, id: { in: allIds } },
        select: { id: true, name: true, basePrice: true, durationMin: true, isActive: true },
      })
    : [];
  const byId = new Map(services.map((s) => [s.id, s]));

  return rows.map((row) => {
    const ids = parseServiceIds(row.serviceIds);
    const resolved = ids.map((id) => byId.get(id)).filter(Boolean);
    return {
      ...row,
      serviceIds: ids,
      services: resolved,
      // Surfaced so staff can see a package has drifted from the catalog
      // without the stored price silently changing underneath them.
      missingServiceIds: ids.filter((id) => !byId.has(id)),
    };
  });
}

/**
 * GET /api/wellness/packages
 *
 * Any authenticated tenant user may list. Customers see only packages that are
 * both active and public; staff see everything, so an unpublished draft never
 * leaks to the people it is not meant for.
 *
 * `?publicOnly=true` lets a staff user preview the customer-facing list.
 */
router.get("/packages", verifyToken, async (req, res) => {
  try {
    const isCustomer = req.user.userType === "CUSTOMER" || req.user.role === "CUSTOMER";
    const where = tenantWhere(req);

    if (isCustomer || req.query.publicOnly === "true") {
      where.isActive = true;
      where.isPublic = true;
    } else {
      if (req.query.isActive === "true") where.isActive = true;
      if (req.query.isActive === "false") where.isActive = false;
    }

    const rows = await prisma.servicePackage.findMany({
      where,
      orderBy: [{ isActive: "desc" }, { createdAt: "desc" }],
      take: Math.min(parseInt(req.query.limit, 10) || 200, 500),
    });

    res.json({ packages: await decorate(req.user.tenantId, rows) });
  } catch (e) {
    console.error("[wellness-packages] list error:", e.message);
    res.status(500).json({ error: "Failed to load packages", code: "PACKAGE_LIST_FAILED" });
  }
});

/**
 * POST /api/wellness/packages
 * Body: { name, serviceIds[], sessions, discountPercent, description?, isActive?, isPublic? }
 */
router.post("/packages", adminGate, async (req, res) => {
  try {
    const { error, data } = normalizePackageBody(req.body || {});
    if (error) return res.status(error.status).json(error.body);

    const priced = await priceFromServices(
      req.user.tenantId,
      data.serviceIds,
      data.sessions,
      data.discountPercent,
    );
    if (priced.error) return res.status(priced.error.status).json(priced.error.body);

    const created = await prisma.servicePackage.create({
      data: {
        name: data.name,
        description: data.description ?? null,
        serviceIds: JSON.stringify(data.serviceIds),
        sessions: data.sessions,
        discountPercent: data.discountPercent,
        grossPrice: priced.grossPrice,
        price: priced.price,
        isActive: data.isActive ?? true,
        isPublic: data.isPublic ?? false,
        tenantId: req.user.tenantId,
        createdBy: req.user.userId,
      },
    });

    await writeAudit("ServicePackage", "CREATE", created.id, req.user.userId, req.user.tenantId, {
      name: created.name,
      serviceIds: data.serviceIds,
      sessions: created.sessions,
      price: created.price,
    });

    const [decorated] = await decorate(req.user.tenantId, [created]);
    res.status(201).json(decorated);
  } catch (e) {
    console.error("[wellness-packages] create error:", e.message);
    res.status(500).json({ error: "Failed to create package", code: "PACKAGE_CREATE_FAILED" });
  }
});

/**
 * PUT /api/wellness/packages/:id
 *
 * Repricing happens only when the bundle, session count or discount changes —
 * flipping `isPublic` must not silently re-price a package at today's service
 * prices.
 */
router.put("/packages/:id", adminGate, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = await prisma.servicePackage.findFirst({ where: tenantWhere(req, { id }) });
    if (!existing) {
      return res.status(404).json({ error: "Package not found", code: "PACKAGE_NOT_FOUND" });
    }

    const { error, data } = normalizePackageBody(req.body || {}, { partial: true });
    if (error) return res.status(error.status).json(error.body);

    const patch = { ...data };
    const repriceNeeded =
      data.serviceIds !== undefined ||
      data.sessions !== undefined ||
      data.discountPercent !== undefined;

    if (repriceNeeded) {
      const serviceIds = data.serviceIds ?? parseServiceIds(existing.serviceIds);
      const sessions = data.sessions ?? existing.sessions;
      const discountPercent = data.discountPercent ?? existing.discountPercent;

      const priced = await priceFromServices(req.user.tenantId, serviceIds, sessions, discountPercent);
      if (priced.error) return res.status(priced.error.status).json(priced.error.body);

      patch.grossPrice = priced.grossPrice;
      patch.price = priced.price;
    }
    if (data.serviceIds !== undefined) patch.serviceIds = JSON.stringify(data.serviceIds);

    const updated = await prisma.servicePackage.update({ where: { id }, data: patch });

    await writeAudit("ServicePackage", "UPDATE", id, req.user.userId, req.user.tenantId, {
      changed: diffFields(existing, updated),
    });

    const [decorated] = await decorate(req.user.tenantId, [updated]);
    res.json(decorated);
  } catch (e) {
    console.error("[wellness-packages] update error:", e.message);
    res.status(500).json({ error: "Failed to update package", code: "PACKAGE_UPDATE_FAILED" });
  }
});

/**
 * DELETE /api/wellness/packages/:id
 *
 * Retires by default (`isActive = false`) so anything already sold or quoted
 * still resolves. `?hard=true` removes the row outright, for a draft created
 * by mistake.
 */
router.delete("/packages/:id", adminGate, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = await prisma.servicePackage.findFirst({ where: tenantWhere(req, { id }) });
    if (!existing) {
      return res.status(404).json({ error: "Package not found", code: "PACKAGE_NOT_FOUND" });
    }

    const hard = req.query.hard === "true";
    if (hard) {
      await prisma.servicePackage.delete({ where: { id } });
    } else {
      await prisma.servicePackage.update({ where: { id }, data: { isActive: false, isPublic: false } });
    }

    await writeAudit(
      "ServicePackage",
      hard ? "DELETE" : "RETIRE",
      id,
      req.user.userId,
      req.user.tenantId,
      { name: existing.name },
    );

    res.json({ deleted: hard, retired: !hard, id });
  } catch (e) {
    console.error("[wellness-packages] delete error:", e.message);
    res.status(500).json({ error: "Failed to delete package", code: "PACKAGE_DELETE_FAILED" });
  }
});

module.exports = router;
module.exports.parseServiceIds = parseServiceIds;
module.exports.normalizePackageBody = normalizePackageBody;
