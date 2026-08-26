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
 *   `sellByDate` is a third, time-based gate: past it the customer catalog
 *   drops the package, while staff keep seeing it flagged — a seasonal offer
 *   closes itself instead of relying on someone remembering to unpublish it.
 */

const express = require("express");
const prisma = require("../lib/prisma");
const { parseDateTimeLocalInTZ } = require("../lib/datetime");
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

// Handling a session request is scheduling work, not catalog config, so it
// takes the same gate as the rest of the appointment book rather than the
// admin-only gate that guards package pricing.
const schedulingGate = verifyWellnessRole(
  ["clinical", "doctor", "professional", "telecaller", "admin", "manager"],
  {
    anyOfPermissions: [
      { module: "calendar", action: "write" },
      { module: "appointments", action: "write" },
      { module: "visits", action: "write" },
    ],
  },
);

const MAX_SESSIONS = 60;
const MAX_SERVICES_PER_PACKAGE = 25;
// A package sold today can reasonably be valid for a decade; anything beyond
// that is a typo, not a term.
const MAX_VALIDITY_DAYS = 3650;

// #313 convention: an HTML date / datetime-local input arrives with no TZ
// marker ("2026-08-29" or "2026-08-29T10:30"), and `new Date()` reads those as
// UTC — which slides an Indian clinic's 10:30 slot to 16:00. Anything carrying
// its own offset is left to the native constructor.
const WELLNESS_TZ = "Asia/Kolkata";
const TZ_LESS_INPUT_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/;

function parseWallClock(input) {
  if (input == null || input === "") return null;
  if (input instanceof Date) return input;
  const raw = String(input);
  if (TZ_LESS_INPUT_RE.test(raw)) {
    // A bare date means midnight in the clinic's own day, not in UTC.
    const withTime = raw.includes("T") ? raw : `${raw}T00:00:00`;
    return parseDateTimeLocalInTZ(withTime, WELLNESS_TZ);
  }
  return new Date(raw);
}

/**
 * Parse an optional whole-number field. Returns:
 *   undefined - the caller did not send the field (leave it alone)
 *   null      - explicitly cleared
 *   number    - a value
 *   NaN       - unparseable, caller must reject
 */
function toOptionalInt(value) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : NaN;
}

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

  // GST slab applied ON TOP of `price` when the package is sold — the stored
  // price stays pre-tax, so changing the slab later never rewrites what a
  // customer was already quoted.
  if (body.taxPercent !== undefined && body.taxPercent !== null && body.taxPercent !== "") {
    const tax = Number(body.taxPercent);
    if (!Number.isFinite(tax) || tax < 0 || tax > 100) {
      return {
        error: { status: 400, body: { error: "Tax must be between 0 and 100", code: "INVALID_TAX" } },
      };
    }
    out.taxPercent = tax;
  } else if (body.taxPercent === null || body.taxPercent === "") {
    out.taxPercent = 0;
  }

  // How long the buyer has to use the package. Null = no expiry.
  if (body.validityDays !== undefined) {
    const days = toOptionalInt(body.validityDays);
    if (Number.isNaN(days) || (days !== null && (days < 1 || days > MAX_VALIDITY_DAYS))) {
      return {
        error: {
          status: 400,
          body: { error: `Validity must be between 1 and ${MAX_VALIDITY_DAYS} days`, code: "INVALID_VALIDITY" },
        },
      };
    }
    out.validityDays = days;
  }

  // Last date the package may be sold. A past date is accepted — a clinic
  // recording a season that has already closed is legitimate, and both the
  // card and the customer catalog surface the consequence.
  if (body.sellByDate !== undefined) {
    if (body.sellByDate === null || body.sellByDate === "") {
      out.sellByDate = null;
    } else {
      const when = new Date(body.sellByDate);
      if (Number.isNaN(when.getTime())) {
        return {
          error: { status: 400, body: { error: "Sell-by date is not a valid date", code: "INVALID_SELL_BY" } },
        };
      }
      out.sellByDate = when;
    }
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

/**
 * Is this package on sale right now?
 *
 * The same three conditions the customer catalog filters by, applied to a
 * single row: retired packages, unpublished drafts and anything past its
 * sell-by date cannot be bought, however the buyer arrived at the id.
 */
function saleBlockReason(pkg) {
  if (!pkg.isActive) return { error: "This package is no longer offered", code: "PACKAGE_RETIRED" };
  if (!pkg.isPublic) return { error: "This package is not on sale", code: "PACKAGE_NOT_PUBLIC" };
  if (pkg.sellByDate && new Date(pkg.sellByDate).getTime() < Date.now()) {
    return { error: "This package is past its sell-by date", code: "PACKAGE_PAST_SELL_BY" };
  }
  return null;
}

/**
 * What the customer actually pays: the stored price plus its GST slab.
 *
 * Tax rounds to whole rupees, matching what the builder quoted when the
 * package was priced — a customer who was shown ₹53,543 must not be charged
 * ₹53,542.65 because the two rounded differently.
 */
function priceBreakdown(pkg) {
  const taxPercent = Number(pkg.taxPercent) || 0;
  const baseAmount = Math.round(Number(pkg.price || 0) * 100) / 100;
  const tax = Math.round((baseAmount * taxPercent) / 100);
  const total = Math.round((baseAmount + tax) * 100) / 100;
  return { baseAmount, taxPercent, tax, total };
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
 * Tell the caller which of these packages they have already bought.
 *
 * Only plans that are still usable count as ownership — a finished or
 * cancelled course should read as "buy it again", not as something you hold.
 * A caller with no patient record (most staff) simply gets no ownership data,
 * and the lookup deliberately does NOT create one: viewing a catalog is not
 * a reason to register someone as a patient.
 */
async function attachOwnership(req, packages) {
  if (!packages.length) return packages;
  const { userId, tenantId } = req.user;

  const patient = await prisma.patient.findFirst({
    where: { tenantId, userId, deletedAt: null },
    select: { id: true },
  });
  if (!patient) return packages;

  const plans = await prisma.treatmentPlan.findMany({
    where: {
      tenantId,
      patientId: patient.id,
      servicePackageId: { in: packages.map((p) => p.id) },
      status: { in: ["active", "paused"] },
    },
    orderBy: { startedAt: "desc" },
    select: {
      id: true,
      servicePackageId: true,
      status: true,
      totalSessions: true,
      completedSessions: true,
      startedAt: true,
      nextDueAt: true,
    },
  });

  // Newest purchase wins when someone has bought the same package twice.
  const byPackage = new Map();
  for (const plan of plans) {
    if (!byPackage.has(plan.servicePackageId)) byPackage.set(plan.servicePackageId, plan);
  }

  return packages.map((pkg) => ({ ...pkg, ownedPlan: byPackage.get(pkg.id) || null }));
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
      // A package past its sell-by date stops being offered. Rows with no
      // sell-by date are unaffected.
      where.OR = [{ sellByDate: null }, { sellByDate: { gte: new Date() } }];
    } else {
      if (req.query.isActive === "true") where.isActive = true;
      if (req.query.isActive === "false") where.isActive = false;
    }

    const rows = await prisma.servicePackage.findMany({
      where,
      orderBy: [{ isActive: "desc" }, { createdAt: "desc" }],
      take: Math.min(parseInt(req.query.limit, 10) || 200, 500),
    });

    const decorated = await decorate(req.user.tenantId, rows);
    res.json({ packages: await attachOwnership(req, decorated) });
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
        taxPercent: data.taxPercent ?? 0,
        validityDays: data.validityDays ?? null,
        sellByDate: data.sellByDate ?? null,
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

/**
 * POST /api/wellness/packages/:id/buy
 *
 * Starts a Razorpay checkout for a package. Mirrors the appointment
 * book-and-pay handshake in routes/wellness.js: this call only creates the
 * ORDER plus a PENDING Payment row — nothing is fulfilled until
 * /packages/confirm-payment verifies the signature.
 *
 * The amount is computed here from the stored price, never taken from the
 * client. The package must actually be on sale (see saleBlockReason), so a
 * stale tab or a hand-crafted request cannot buy a retired, unpublished or
 * lapsed package.
 *
 * Customer money runs on the TENANT's own Razorpay keys (BYOK) — the platform
 * keys are for subscription billing only.
 */
router.post("/packages/:id/buy", verifyToken, async (req, res) => {
  try {
    const {
      getTenantRazorpayClient,
      NOT_CONFIGURED_MESSAGE,
    } = require("../lib/tenantPaymentGateway");
    const { resolveSelfBookingPatient } = require("../lib/selfBookingPatient");
    const { ensurePatientContact } = require("../lib/patientContactLink");

    const { userId, tenantId } = req.user;
    const id = Number(req.params.id);
    const pkg = await prisma.servicePackage.findFirst({ where: tenantWhere(req, { id }) });
    if (!pkg) {
      return res.status(404).json({ error: "Package not found", code: "PACKAGE_NOT_FOUND" });
    }

    const blocked = saleBlockReason(pkg);
    if (blocked) return res.status(409).json(blocked);

    const breakdown = priceBreakdown(pkg);
    if (breakdown.total <= 0) {
      return res.status(409).json({
        error: "This package has no price to charge",
        code: "PACKAGE_NOT_PAYABLE",
      });
    }

    // Buying is always for yourself. Staff selling a package at the desk is a
    // POS flow, not this one.
    const patient = await resolveSelfBookingPatient({ userId, tenantId });
    const contact = await ensurePatientContact(patient, tenantId);

    const rp = await getTenantRazorpayClient(tenantId);
    if (!rp) {
      return res.status(503).json({ error: NOT_CONFIGURED_MESSAGE, code: "GATEWAY_NOT_CONFIGURED" });
    }

    let order;
    try {
      order = await rp.client.orders.create({
        amount: Math.round(breakdown.total * 100),
        currency: pkg.currency || "INR",
        receipt: `pkg_${pkg.id}_${userId}_${Date.now()}`,
        notes: {
          tenantId: String(tenantId),
          userId: String(userId),
          packageId: String(pkg.id),
          kind: "package_payment",
        },
      });
    } catch (gatewayErr) {
      console.error("[wellness-packages] buy order failed:", gatewayErr && gatewayErr.message);
      return res.status(502).json({ error: "Failed to create payment order", code: "GATEWAY_ERROR" });
    }

    const payment = await prisma.payment.create({
      data: {
        invoiceId: null,
        contactId: contact.id,
        amount: breakdown.total,
        currency: pkg.currency || "INR",
        gateway: "razorpay",
        gatewayId: order.id,
        status: "PENDING",
        tenantId,
        // The package terms are snapshotted here so fulfilment reads what was
        // agreed at checkout, even if the package is edited mid-payment.
        metadata: JSON.stringify({
          kind: "package_payment",
          userId,
          packageId: pkg.id,
          patientId: patient.id,
          packageName: pkg.name,
          sessions: pkg.sessions,
          validityDays: pkg.validityDays,
          serviceIds: parseServiceIds(pkg.serviceIds),
          breakdown,
        }),
      },
    });

    res.status(201).json({
      orderId: order.id,
      paymentId: payment.id,
      key: rp.keyId,
      amount: Math.round(breakdown.total * 100),
      currency: pkg.currency || "INR",
      breakdown,
      package: { id: pkg.id, name: pkg.name, sessions: pkg.sessions },
    });
  } catch (e) {
    console.error("[wellness-packages] buy error:", e.message);
    res.status(500).json({ error: "Failed to start payment", code: "PACKAGE_BUY_FAILED" });
  }
});

/**
 * POST /api/wellness/packages/confirm-payment
 *
 * Verifies the Razorpay signature and fulfils the purchase by creating the
 * patient's TreatmentPlan — the row the Active Packages tab lists as a package
 * in progress. That is the whole point of the handshake: a bundle in the
 * catalog becomes something a named patient is working through.
 *
 * Idempotent: a repeated call returns the plan already created rather than
 * charging or provisioning twice.
 */
router.post("/packages/confirm-payment", verifyToken, async (req, res) => {
  try {
    const crypto = require("crypto");
    const {
      getTenantRazorpayCreds,
      NOT_CONFIGURED_MESSAGE,
    } = require("../lib/tenantPaymentGateway");

    const { userId, tenantId } = req.user;
    const { paymentId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};

    if (!paymentId || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: "Missing required fields", code: "INVALID_INPUT" });
    }

    const payment = await prisma.payment.findFirst({
      where: { id: parseInt(paymentId, 10), tenantId },
    });
    if (!payment) {
      return res.status(404).json({ error: "Payment not found", code: "PAYMENT_NOT_FOUND" });
    }

    const meta = (() => {
      try { return JSON.parse(payment.metadata || "{}"); } catch { return {}; }
    })();
    if (meta.kind !== "package_payment") {
      return res.status(400).json({ error: "Not a package payment", code: "WRONG_PAYMENT_KIND" });
    }
    if (payment.status === "SUCCESS" && meta.treatmentPlanId) {
      return res.json({ success: true, treatmentPlanId: meta.treatmentPlanId, alreadyConfirmed: true });
    }

    const creds = await getTenantRazorpayCreds(tenantId);
    if (!creds || !creds.keySecret) {
      return res.status(503).json({ error: NOT_CONFIGURED_MESSAGE, code: "GATEWAY_NOT_CONFIGURED" });
    }
    const expected = crypto
      .createHmac("sha256", creds.keySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");
    if (expected !== razorpay_signature) {
      await prisma.payment.update({ where: { id: payment.id }, data: { status: "FAILED" } });
      return res.status(400).json({ error: "Signature verification failed", code: "BAD_SIGNATURE" });
    }

    const startedAt = new Date();
    // validityDays is how long the buyer has to use the sessions. TreatmentPlan
    // has no expiry column of its own, and `nextDueAt` is what the card renders
    // as "Due" — which is the deadline a patient cares about.
    const nextDueAt = meta.validityDays
      ? new Date(startedAt.getTime() + Number(meta.validityDays) * 24 * 60 * 60 * 1000)
      : null;

    let plan;
    try {
      plan = await prisma.treatmentPlan.create({
        data: {
          name: meta.packageName || "Package",
          totalSessions: Number(meta.sessions) || 1,
          completedSessions: 0,
          startedAt,
          nextDueAt,
          status: "active",
          totalPrice: Number(payment.amount) || 0,
          patientId: meta.patientId,
          // The link the customer catalog reads to say "you already own this".
          servicePackageId: meta.packageId ?? null,
          // A plan carries ONE service; a bundle keeps its first. The full
          // bundle stays on the Payment metadata for reference.
          serviceId: Array.isArray(meta.serviceIds) && meta.serviceIds.length ? meta.serviceIds[0] : null,
          tenantId,
        },
      });
    } catch (planErr) {
      // The card has already been charged, so this cannot be rejected. Record
      // the payment as SUCCESS and flag it for someone to finish by hand.
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: "SUCCESS",
          paidAt: new Date(),
          gatewayId: razorpay_payment_id,
          metadata: JSON.stringify({
            ...meta,
            razorpay_order_id,
            razorpay_payment_id,
            fulfilmentError: planErr.message || String(planErr),
            needsManualFulfilment: true,
          }),
        },
      });
      console.error("[wellness-packages] fulfilment failed after payment:", planErr.message);
      return res.status(500).json({
        error: "Payment succeeded but the package could not be activated automatically. Our team will reach out shortly.",
        code: "FULFILMENT_AFTER_PAYMENT_FAILED",
        paymentId: payment.id,
      });
    }

    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: "SUCCESS",
        paidAt: new Date(),
        gatewayId: razorpay_payment_id,
        metadata: JSON.stringify({ ...meta, razorpay_order_id, razorpay_payment_id, treatmentPlanId: plan.id }),
      },
    });

    await writeAudit("ServicePackage", "PURCHASE", meta.packageId ?? null, userId, tenantId, {
      packageName: meta.packageName,
      treatmentPlanId: plan.id,
      paymentId: payment.id,
      amount: Number(payment.amount) || 0,
    });

    res.json({ success: true, treatmentPlanId: plan.id, name: plan.name });
  } catch (e) {
    console.error("[wellness-packages] confirm-payment error:", e.message);
    res.status(500).json({ error: "Failed to confirm payment", code: "PACKAGE_CONFIRM_FAILED" });
  }
});

/**
 * Sessions out of a package the customer already paid for.
 *
 * A session is a Visit carrying `treatmentPlanId`, which is how the rest of the
 * CRM already models "this appointment belongs to a course of treatment". The
 * only new idea is the `requested` status: the patient asks, and the visit is
 * on nobody's calendar until a practitioner accepts it and picks a slot.
 *
 * The counter moves on COMPLETION, not on booking — see PUT /visits/:id in
 * routes/wellness.js. A request that is declined or a no-show costs the patient
 * nothing.
 */

/**
 * Why this plan cannot have another session asked against it, or null.
 *
 * Pure so the rules can be read (and tested) in one place: a package that is
 * finished, cancelled, fully used or out of time is not bookable, however the
 * request arrives.
 */
function planRequestBlockReason(plan) {
  if (plan.status !== "active") {
    return { status: 409, body: { error: `This package is ${plan.status}`, code: "PLAN_NOT_ACTIVE" } };
  }
  if (plan.completedSessions >= plan.totalSessions) {
    return { status: 409, body: { error: "Every session in this package has been used", code: "PLAN_EXHAUSTED" } };
  }
  if (plan.nextDueAt && new Date(plan.nextDueAt).getTime() < Date.now()) {
    return {
      status: 409,
      body: { error: "The window to use this package has passed — please contact the clinic", code: "PLAN_LAPSED" },
    };
  }
  return null;
}

/** The caller's own plan, if it can take another session request. */
async function loadRequestablePlan(tenantId, planId, patientId) {
  const plan = await prisma.treatmentPlan.findFirst({
    where: { id: planId, tenantId, patientId },
  });
  if (!plan) {
    return { error: { status: 404, body: { error: "Package not found on your record", code: "PLAN_NOT_FOUND" } } };
  }
  const blocked = planRequestBlockReason(plan);
  if (blocked) return { error: blocked };
  return { plan };
}

/**
 * POST /api/wellness/packages/plans/:planId/request-session
 *
 * The customer asks for one of their remaining sessions. Creates a `requested`
 * visit with no practitioner and no confirmed slot: `preferredDate` is a wish,
 * not a booking, and the clinic decides what it becomes.
 *
 * A doctor is never taken from the client here — the accepting staff member
 * assigns one.
 */
router.post("/packages/plans/:planId/request-session", verifyToken, async (req, res) => {
  try {
    const { userId, tenantId } = req.user;
    const planId = Number(req.params.planId);
    if (!Number.isInteger(planId) || planId <= 0) {
      return res.status(400).json({ error: "Invalid plan id", code: "INVALID_PLAN_ID" });
    }

    // Read-only lookup: viewing or requesting must not conjure a patient row.
    const patient = await prisma.patient.findFirst({
      where: { tenantId, userId, deletedAt: null },
      select: { id: true },
    });
    if (!patient) {
      return res.status(404).json({ error: "No patient record found for your account", code: "PATIENT_NOT_FOUND" });
    }

    const { plan, error } = await loadRequestablePlan(tenantId, planId, patient.id);
    if (error) return res.status(error.status).json(error.body);

    // One open request at a time per package. Otherwise a customer clicking
    // twice queues two sittings the clinic has to untangle by hand.
    const openRequest = await prisma.visit.findFirst({
      where: { tenantId, treatmentPlanId: plan.id, status: { in: ["requested", "booked"] } },
      select: { id: true, status: true },
    });
    if (openRequest) {
      return res.status(409).json({
        error: openRequest.status === "requested"
          ? "You already have a session request waiting on this package"
          : "You already have a session booked from this package",
        code: "SESSION_ALREADY_PENDING",
        visitId: openRequest.id,
      });
    }

    const preferred = parseWallClock(req.body?.preferredDate);
    if (preferred && Number.isNaN(preferred.getTime())) {
      return res.status(400).json({ error: "preferredDate is not a valid date", code: "INVALID_DATE" });
    }

    const note = String(req.body?.note || "").trim().slice(0, 1000);
    const visit = await prisma.visit.create({
      data: {
        patientId: patient.id,
        serviceId: plan.serviceId,
        treatmentPlanId: plan.id,
        doctorId: null,
        // A wish, not a slot. The accepting staff member sets the real one, and
        // the slot-conflict gate runs then rather than now.
        visitDate: preferred || new Date(),
        status: "requested",
        reason: note || `Session from package: ${plan.name}`,
        bookingType: "CLINIC_VISIT",
        tenantId,
      },
    });

    await writeAudit("Visit", "SESSION_REQUESTED", visit.id, userId, tenantId, {
      treatmentPlanId: plan.id,
      planName: plan.name,
      preferredDate: preferred ? preferred.toISOString() : null,
    });

    res.status(201).json({
      id: visit.id,
      status: visit.status,
      preferredDate: visit.visitDate,
      plan: {
        id: plan.id,
        name: plan.name,
        sessionsLeft: plan.totalSessions - plan.completedSessions,
      },
    });
  } catch (e) {
    console.error("[wellness-packages] request-session error:", e.message);
    res.status(500).json({ error: "Could not send your request", code: "SESSION_REQUEST_FAILED" });
  }
});

/**
 * GET /api/wellness/packages/session-requests
 *
 * The clinic's queue of unanswered requests, oldest first — a queue is worked
 * from the front.
 */
router.get("/packages/session-requests", schedulingGate, async (req, res) => {
  try {
    const rows = await prisma.visit.findMany({
      where: { tenantId: req.user.tenantId, status: "requested", treatmentPlanId: { not: null } },
      orderBy: { visitDate: "asc" },
      take: 200,
      select: {
        id: true,
        visitDate: true,
        reason: true,
        patient: { select: { id: true, name: true, phone: true } },
        service: { select: { id: true, name: true } },
        treatmentPlan: {
          select: { id: true, name: true, totalSessions: true, completedSessions: true, nextDueAt: true },
        },
      },
    });
    res.json({ requests: rows });
  } catch (e) {
    console.error("[wellness-packages] session-requests error:", e.message);
    res.status(500).json({ error: "Failed to load session requests", code: "SESSION_REQUESTS_FAILED" });
  }
});

/**
 * POST /api/wellness/packages/session-requests/:visitId/accept
 *
 * Turns a request into a real booking: a practitioner is assigned and the slot
 * is confirmed. Body: { doctorId, visitDate? }.
 *
 * Accepting does NOT spend a session — completing the visit does.
 */
router.post("/packages/session-requests/:visitId/accept", schedulingGate, async (req, res) => {
  try {
    const { userId, tenantId } = req.user;
    const visitId = Number(req.params.visitId);
    const visit = await prisma.visit.findFirst({
      where: { id: visitId, tenantId, status: "requested" },
    });
    if (!visit) {
      return res.status(404).json({ error: "Request not found or already handled", code: "REQUEST_NOT_FOUND" });
    }

    const doctorId = req.body?.doctorId ? Number(req.body.doctorId) : null;
    if (!doctorId) {
      return res.status(400).json({ error: "Pick who is taking this session", code: "DOCTOR_REQUIRED" });
    }
    const doctor = await prisma.user.findFirst({
      where: { id: doctorId, tenantId },
      select: { id: true, name: true },
    });
    if (!doctor) {
      return res.status(404).json({ error: "Practitioner not found", code: "DOCTOR_NOT_FOUND" });
    }

    let visitDate = visit.visitDate;
    if (req.body?.visitDate) {
      const when = parseWallClock(req.body.visitDate);
      if (!when || Number.isNaN(when.getTime())) {
        return res.status(400).json({ error: "visitDate is not a valid date", code: "INVALID_DATE" });
      }
      visitDate = when;
    }

    const updated = await prisma.visit.update({
      where: { id: visit.id },
      data: { doctorId: doctor.id, visitDate, status: "booked" },
    });

    await writeAudit("Visit", "SESSION_ACCEPTED", visit.id, userId, tenantId, {
      treatmentPlanId: visit.treatmentPlanId,
      doctorId: doctor.id,
      visitDate: visitDate.toISOString(),
    });

    res.json({ id: updated.id, status: updated.status, visitDate: updated.visitDate, doctor });
  } catch (e) {
    console.error("[wellness-packages] accept session error:", e.message);
    res.status(500).json({ error: "Could not accept the request", code: "SESSION_ACCEPT_FAILED" });
  }
});

/**
 * POST /api/wellness/packages/session-requests/:visitId/decline
 *
 * Cancels the request. The session is untouched — nothing was spent — so the
 * patient can ask again.
 */
router.post("/packages/session-requests/:visitId/decline", schedulingGate, async (req, res) => {
  try {
    const { userId, tenantId } = req.user;
    const visitId = Number(req.params.visitId);
    const visit = await prisma.visit.findFirst({
      where: { id: visitId, tenantId, status: "requested" },
    });
    if (!visit) {
      return res.status(404).json({ error: "Request not found or already handled", code: "REQUEST_NOT_FOUND" });
    }

    const reason = String(req.body?.reason || "").trim().slice(0, 500);
    await prisma.visit.update({
      where: { id: visit.id },
      data: {
        status: "cancelled",
        notes: reason ? `Session request declined: ${reason}` : "Session request declined",
      },
    });

    await writeAudit("Visit", "SESSION_DECLINED", visit.id, userId, tenantId, {
      treatmentPlanId: visit.treatmentPlanId,
      reason: reason || null,
    });

    res.json({ id: visit.id, status: "cancelled" });
  } catch (e) {
    console.error("[wellness-packages] decline session error:", e.message);
    res.status(500).json({ error: "Could not decline the request", code: "SESSION_DECLINE_FAILED" });
  }
});

module.exports = router;
module.exports.parseServiceIds = parseServiceIds;
module.exports.normalizePackageBody = normalizePackageBody;
// Exported for unit tests: the two functions that decide whether a package can
// be sold and what it costs, without booting prisma or the gateway.
module.exports.saleBlockReason = saleBlockReason;
module.exports.priceBreakdown = priceBreakdown;
module.exports.planRequestBlockReason = planRequestBlockReason;
module.exports.parseWallClock = parseWallClock;
