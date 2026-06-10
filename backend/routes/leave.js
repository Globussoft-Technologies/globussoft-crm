// Wave 2 Agent JJ -- Leave Management (Google Doc audit, 8 May 2026).
//
// Surfaces:
//   GET    /api/leave/policies                  -- list active leave policies (any auth user)
//   POST   /api/leave/policies                  -- admin: create policy
//   PUT    /api/leave/policies/:id              -- admin: edit policy
//   DELETE /api/leave/policies/:id              -- admin: soft-delete (isActive=false)
//   GET    /api/leave/balances/me               -- own balances per policy (current period)
//   GET    /api/leave/balances/:userId          -- manager/admin: another user's balances
//   POST   /api/leave/requests                  -- own request submission
//   GET    /api/leave/requests                  -- own + manager/admin sees all (filter ?status&userId)
//   GET    /api/leave/requests/:id              -- own + manager/admin
//   POST   /api/leave/requests/:id/approve      -- manager/admin
//   POST   /api/leave/requests/:id/reject       -- manager/admin (body { notes })
//   POST   /api/leave/requests/:id/cancel       -- requester only (and only while PENDING)
//
// Tenant scope: every query filters req.user.tenantId.
//
// Half-day leave is NOT in MVP scope. The `days` field is Int-only; sending
// 0.5 returns a 400 with code=HALF_DAY_NOT_SUPPORTED so callers fail fast
// instead of getting silent truncation.
//
// Balance math:
//   - On submit:    LeaveBalance.pending += days; available -= days
//   - On approve:   pending -= days; used += days; available unchanged (already
//                   subtracted on submit)
//   - On reject:    pending -= days; available += days
//   - On cancel:    same as reject (only allowed from PENDING)
//
// All four mutations are wrapped in $transaction to guarantee LeaveBalance
// consistency. If a balance row doesn't exist yet (first request of the year),
// we lazy-create it from the policy's annualEntitlement. The (deferred) accrual
// cron will replace this with a periodic-ledger pattern; the lazy-create stays
// as a fallback so a fresh tenant's first-ever request works.

const express = require("express");
const prisma = require("../lib/prisma");
const { verifyToken, verifyRole } = require("../middleware/auth");
const { writeAudit } = require("../lib/audit");

const router = express.Router();

const tenantWhere = (req, extra = {}) => ({ tenantId: req.user.tenantId, ...extra });

const LEAVE_TYPES = ["CASUAL", "SICK", "EARNED", "UNPAID", "MATERNITY", "PATERNITY", "COMP_OFF"];
const ACCRUAL_PATTERNS = ["UPFRONT", "MONTHLY", "QUARTERLY"];

// Parse YYYY-MM-DD dates. Returns Date at 00:00 UTC of that day, or null.
function parseDay(s) {
  if (!s) return null;
  const dt = new Date(s);
  if (Number.isNaN(dt.getTime())) return null;
  return new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()));
}

// Inclusive day count between two anchored Dates. Returns Int.
function daysBetween(start, end) {
  return Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
}

// Current calendar year as a (start, end) pair.
function currentYearPeriod() {
  const now = new Date();
  return {
    periodStart: new Date(Date.UTC(now.getUTCFullYear(), 0, 1)),
    periodEnd: new Date(Date.UTC(now.getUTCFullYear(), 11, 31)),
  };
}

// Load-or-lazy-create a LeaveBalance row for the (user, policy, current year)
// triple. Returns the row. Creates with entitled=accrued=policy.annualEntitlement
// for UPFRONT pattern, or entitled=annual + accrued=0 for the partial patterns
// (the cron will accrue over time).
async function getOrCreateBalance(tx, tenantId, userId, policy) {
  const { periodStart, periodEnd } = currentYearPeriod();
  let row = await tx.leaveBalance.findUnique({
    where: { tenantId_userId_policyId_periodStart: { tenantId, userId, policyId: policy.id, periodStart } },
  });
  if (row) return row;
  const accrued = policy.accrualPattern === "UPFRONT" ? policy.annualEntitlement : 0;
  row = await tx.leaveBalance.create({
    data: {
      tenantId, userId, policyId: policy.id,
      periodStart, periodEnd,
      entitled: policy.annualEntitlement,
      accrued,
      used: 0,
      pending: 0,
      available: accrued,
    },
  });
  return row;
}

// ==============================================================
// Stats — tenant-wide aggregate KPI surface
// ==============================================================
//
// GET /api/leave/stats — HRMS polish.
//
// First /stats endpoint on the LeaveRequest route. Read-only KPI surface
// for the HR dashboard. Mirrors the canonical /stats posture established
// by travel_suppliers.js's /suppliers/stats (#903 slice 23): tenant-scoped,
// admin/manager-gated, no audit row written, ISO date bounds with 400
// INVALID_DATE on invalid input, half-up 2dp rounding for sums.
//
// Aggregates:
//   total              -- count of all LeaveRequest rows (in window)
//   byStatus           -- { PENDING, APPROVED, REJECTED, CANCELLED } counts
//   byType             -- counts grouped by joined LeavePolicy.leaveType
//                         (CASUAL/SICK/EARNED/UNPAID/MATERNITY/PATERNITY/COMP_OFF)
//   totalDaysApproved  -- sum of LeaveRequest.days where status='APPROVED'
//   totalDaysPending   -- sum of LeaveRequest.days where status='PENDING'
//   pendingCount       -- count where status='PENDING'
//   lastRequestedAt    -- max submittedAt ISO string or null
//
// Notes on schema fidelity:
//   - LeaveRequest.status enum is PENDING / APPROVED / REJECTED / CANCELLED
//     (set in routes/leave.js, no DRAFT/SUBMITTED — PENDING is the "freshly
//     submitted, awaiting decision" bucket). totalDaysPending / pendingCount
//     pin against PENDING.
//   - Date window applies to LeaveRequest.submittedAt (the canonical
//     request-creation timestamp). lastRequestedAt mirrors that.
//   - LeaveRequest.days is Int in schema; we still half-up round to 2dp on
//     the response sums for forward-compat with a potential half-day
//     migration (HALF_DAY_NOT_SUPPORTED is enforced at /requests POST).
//   - leaveType lives on the joined LeavePolicy, not on LeaveRequest
//     directly. We fetch with include:{policy:{select:{leaveType:true}}}
//     and bucket in-process. groupBy on Prisma can't follow a relation, so
//     in-process bucketing is the cleanest path.
//
// Auth: verifyToken + verifyRole(['ADMIN','MANAGER']) -- aggregate KPIs
// across all users in the tenant are not USER-readable. Matches
// attendance.js's /summary gate.
//
// Express route ordering: literal-path /stats declared at top of file so
// /policies/:id and /balances/:userId family parses don't see "stats" as
// an :id value.
// ==============================================================
router.get("/stats", verifyToken, verifyRole(["ADMIN", "MANAGER"]), async (req, res) => {
  try {
    const where = { tenantId: req.user.tenantId };

    // Optional ISO date bounds on submittedAt
    const fromRaw = req.query.from ? String(req.query.from) : null;
    const toRaw = req.query.to ? String(req.query.to) : null;
    if (fromRaw) {
      const d = new Date(fromRaw);
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({
          error: "from must be a valid ISO date",
          code: "INVALID_DATE",
        });
      }
      where.submittedAt = Object.assign(where.submittedAt || {}, { gte: d });
    }
    if (toRaw) {
      const d = new Date(toRaw);
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({
          error: "to must be a valid ISO date",
          code: "INVALID_DATE",
        });
      }
      where.submittedAt = Object.assign(where.submittedAt || {}, { lte: d });
    }

    const rows = await prisma.leaveRequest.findMany({
      where,
      select: {
        status: true,
        days: true,
        submittedAt: true,
        policy: { select: { leaveType: true } },
      },
    });

    // Half-up round to 2dp -- matches sibling stats endpoints.
    const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

    const byStatus = {};
    const byType = {};
    let totalDaysApproved = 0;
    let totalDaysPending = 0;
    let pendingCount = 0;
    let lastRequestedAt = null;

    for (const r of rows) {
      const status = r.status || "PENDING";
      byStatus[status] = (byStatus[status] || 0) + 1;

      const leaveType = (r.policy && r.policy.leaveType) || "UNKNOWN";
      byType[leaveType] = (byType[leaveType] || 0) + 1;

      const days = Number(r.days);
      if (Number.isFinite(days)) {
        if (status === "APPROVED") totalDaysApproved += days;
        if (status === "PENDING") {
          totalDaysPending += days;
          pendingCount += 1;
        }
      } else if (status === "PENDING") {
        pendingCount += 1;
      }

      if (r.submittedAt) {
        const ts = r.submittedAt instanceof Date ? r.submittedAt : new Date(r.submittedAt);
        if (!Number.isNaN(ts.getTime())) {
          if (!lastRequestedAt || ts > lastRequestedAt) lastRequestedAt = ts;
        }
      }
    }

    res.json({
      total: rows.length,
      byStatus,
      byType,
      totalDaysApproved: round2(totalDaysApproved),
      totalDaysPending: round2(totalDaysPending),
      pendingCount,
      lastRequestedAt: lastRequestedAt ? lastRequestedAt.toISOString() : null,
    });
  } catch (e) {
    console.error("[leave] stats error:", e.message);
    res.status(500).json({ error: "Failed to summarise leave requests" });
  }
});

// ==============================================================
// Policies
// ==============================================================

router.get("/policies", verifyToken, async (req, res) => {
  try {
    const where = tenantWhere(req);
    if (req.query.includeInactive !== "1") where.isActive = true;
    const items = await prisma.leavePolicy.findMany({
      where,
      orderBy: [{ leaveType: "asc" }, { name: "asc" }],
    });
    res.json(items);
  } catch (e) {
    console.error("[leave] list policies error:", e.message);
    res.status(500).json({ error: "Failed to list leave policies" });
  }
});

router.post("/policies", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const { name, leaveType, annualEntitlement, accrualPattern, carryForwardCap, encashable, isActive } = req.body;
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "name is required", code: "NAME_REQUIRED" });
    }
    if (!leaveType || !LEAVE_TYPES.includes(leaveType)) {
      return res.status(400).json({
        error: "leaveType must be one of " + LEAVE_TYPES.join(", "),
        code: "INVALID_LEAVE_TYPE",
        allowed: LEAVE_TYPES,
      });
    }
    const annual = parseInt(annualEntitlement);
    if (!Number.isFinite(annual) || annual < 0 || annual > 365) {
      return res.status(400).json({
        error: "annualEntitlement must be a whole number between 0 and 365",
        code: "INVALID_ANNUAL_ENTITLEMENT",
      });
    }
    const pattern = accrualPattern || "UPFRONT";
    if (!ACCRUAL_PATTERNS.includes(pattern)) {
      return res.status(400).json({
        error: "accrualPattern must be one of " + ACCRUAL_PATTERNS.join(", "),
        code: "INVALID_ACCRUAL_PATTERN",
        allowed: ACCRUAL_PATTERNS,
      });
    }

    const policy = await prisma.leavePolicy.create({
      data: {
        tenantId: req.user.tenantId,
        name: name.trim(),
        leaveType,
        annualEntitlement: annual,
        accrualPattern: pattern,
        carryForwardCap: carryForwardCap === null || carryForwardCap === undefined ? null : parseInt(carryForwardCap),
        encashable: !!encashable,
        isActive: isActive !== false,
      },
    });

    await writeAudit("LeavePolicy", "CREATE", policy.id, req.user.userId, req.user.tenantId, {
      name: policy.name, leaveType: policy.leaveType, annualEntitlement: policy.annualEntitlement,
    });
    res.status(201).json(policy);
  } catch (e) {
    console.error("[leave] create policy error:", e.message);
    res.status(500).json({ error: "Failed to create leave policy" });
  }
});

router.put("/policies/:id", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.leavePolicy.findFirst({ where: tenantWhere(req, { id }) });
    if (!existing) return res.status(404).json({ error: "Leave policy not found" });

    const data = {};
    if (req.body.name !== undefined) data.name = String(req.body.name).trim();
    if (req.body.leaveType !== undefined) {
      if (!LEAVE_TYPES.includes(req.body.leaveType)) {
        return res.status(400).json({ error: "Invalid leaveType", code: "INVALID_LEAVE_TYPE", allowed: LEAVE_TYPES });
      }
      data.leaveType = req.body.leaveType;
    }
    if (req.body.annualEntitlement !== undefined) {
      const a = parseInt(req.body.annualEntitlement);
      if (!Number.isFinite(a) || a < 0 || a > 365) {
        return res.status(400).json({ error: "annualEntitlement must be 0..365", code: "INVALID_ANNUAL_ENTITLEMENT" });
      }
      data.annualEntitlement = a;
    }
    if (req.body.accrualPattern !== undefined) {
      if (!ACCRUAL_PATTERNS.includes(req.body.accrualPattern)) {
        return res.status(400).json({ error: "Invalid accrualPattern", code: "INVALID_ACCRUAL_PATTERN", allowed: ACCRUAL_PATTERNS });
      }
      data.accrualPattern = req.body.accrualPattern;
    }
    if (req.body.carryForwardCap !== undefined) {
      data.carryForwardCap = req.body.carryForwardCap === null ? null : parseInt(req.body.carryForwardCap);
    }
    if (req.body.encashable !== undefined) data.encashable = !!req.body.encashable;
    if (req.body.isActive !== undefined) data.isActive = !!req.body.isActive;

    const updated = await prisma.leavePolicy.update({ where: { id }, data });
    await writeAudit("LeavePolicy", "UPDATE", id, req.user.userId, req.user.tenantId, { changedFields: Object.keys(data) });
    res.json(updated);
  } catch (e) {
    console.error("[leave] update policy error:", e.message);
    res.status(500).json({ error: "Failed to update leave policy" });
  }
});

router.delete("/policies/:id", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.leavePolicy.findFirst({ where: tenantWhere(req, { id }) });
    if (!existing) return res.status(404).json({ error: "Leave policy not found" });

    // Soft-delete via isActive=false. Hard-delete would orphan LeaveRequest +
    // LeaveBalance rows referencing the policy, and the @relation onDelete
    // policy is Restrict for requests (history-of-record).
    await prisma.leavePolicy.update({ where: { id }, data: { isActive: false } });
    await writeAudit("LeavePolicy", "SOFT_DELETE", id, req.user.userId, req.user.tenantId, { name: existing.name });
    res.status(204).send();
  } catch (e) {
    console.error("[leave] delete policy error:", e.message);
    res.status(500).json({ error: "Failed to delete leave policy" });
  }
});

// ==============================================================
// Balances
// ==============================================================

router.get("/balances/me", verifyToken, async (req, res) => {
  try {
    const policies = await prisma.leavePolicy.findMany({
      where: tenantWhere(req, { isActive: true }),
    });
    const out = [];
    for (const p of policies) {
      const balance = await prisma.$transaction((tx) => getOrCreateBalance(tx, req.user.tenantId, req.user.userId, p));
      out.push({ policy: p, balance });
    }
    res.json(out);
  } catch (e) {
    console.error("[leave] balances me error:", e.message);
    res.status(500).json({ error: "Failed to load balances" });
  }
});

router.get("/balances/:userId", verifyToken, verifyRole(["ADMIN", "MANAGER"]), async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    if (!Number.isFinite(userId)) {
      return res.status(400).json({ error: "userId must be a number", code: "INVALID_USER_ID" });
    }
    const targetUser = await prisma.user.findFirst({
      where: { id: userId, tenantId: req.user.tenantId },
      select: { id: true, name: true, email: true },
    });
    if (!targetUser) {
      return res.status(404).json({ error: "User not found in this tenant", code: "USER_NOT_FOUND" });
    }
    const policies = await prisma.leavePolicy.findMany({ where: tenantWhere(req, { isActive: true }) });
    const out = [];
    for (const p of policies) {
      const balance = await prisma.$transaction((tx) => getOrCreateBalance(tx, req.user.tenantId, userId, p));
      out.push({ policy: p, balance });
    }
    res.json({ user: targetUser, balances: out });
  } catch (e) {
    console.error("[leave] balances userId error:", e.message);
    res.status(500).json({ error: "Failed to load balances" });
  }
});

// ==============================================================
// Requests: submit / list / approve / reject / cancel
// ==============================================================

router.post("/requests", verifyToken, async (req, res) => {
  try {
    const { policyId, startDate, endDate, reason, days: clientDays } = req.body;
    if (!policyId) return res.status(400).json({ error: "policyId is required", code: "POLICY_REQUIRED" });

    // Reject half-day inputs explicitly so callers don't get silent truncation.
    if (clientDays !== undefined && Number(clientDays) % 1 !== 0) {
      return res.status(400).json({ error: "Half-day leave is not supported in this MVP", code: "HALF_DAY_NOT_SUPPORTED" });
    }

    const start = parseDay(startDate);
    const end = parseDay(endDate);
    if (!start || !end) {
      return res.status(400).json({ error: "startDate and endDate (YYYY-MM-DD) are required", code: "DATE_REQUIRED" });
    }
    if (end < start) {
      return res.status(400).json({ error: "endDate must be on or after startDate", code: "INVERTED_DATE_RANGE" });
    }
    const days = daysBetween(start, end);
    if (days < 1 || days > 365) {
      return res.status(400).json({ error: "request must span 1..365 days", code: "INVALID_DAYS" });
    }

    const policy = await prisma.leavePolicy.findFirst({
      where: tenantWhere(req, { id: parseInt(policyId), isActive: true }),
    });
    if (!policy) {
      return res.status(404).json({ error: "Leave policy not found or inactive", code: "POLICY_NOT_FOUND" });
    }

    // Wrap the balance check + decrement + request creation in one transaction
    // so a parallel submit can't race past the balance gate.
    const result = await prisma.$transaction(async (tx) => {
      const balance = await getOrCreateBalance(tx, req.user.tenantId, req.user.userId, policy);
      // UNPAID leave bypasses balance check (it doesn't decrement entitlement).
      if (policy.leaveType !== "UNPAID" && balance.available < days) {
        const err = new Error("INSUFFICIENT_BALANCE");
        err.code = "INSUFFICIENT_BALANCE";
        err.available = balance.available;
        throw err;
      }
      const request = await tx.leaveRequest.create({
        data: {
          tenantId: req.user.tenantId,
          userId: req.user.userId,
          policyId: policy.id,
          startDate: start,
          endDate: end,
          days,
          reason: reason || null,
          status: "PENDING",
        },
      });
      if (policy.leaveType !== "UNPAID") {
        await tx.leaveBalance.update({
          where: { id: balance.id },
          data: { pending: balance.pending + days, available: balance.available - days },
        });
      }
      return request;
    });

    await writeAudit("LeaveRequest", "CREATE", result.id, req.user.userId, req.user.tenantId, {
      policyId: policy.id, days, startDate: startDate, endDate: endDate,
    });
    res.status(201).json(result);
  } catch (e) {
    if (e && e.code === "INSUFFICIENT_BALANCE") {
      return res.status(409).json({
        error: "Insufficient leave balance",
        code: "INSUFFICIENT_BALANCE",
        available: e.available,
      });
    }
    console.error("[leave] create request error:", e.message);
    res.status(500).json({ error: "Failed to submit leave request" });
  }
});

router.get("/requests", verifyToken, async (req, res) => {
  try {
    const isManager = req.user.role === "ADMIN" || req.user.role === "MANAGER";
    const where = { tenantId: req.user.tenantId };
    if (req.query.status) where.status = String(req.query.status);
    if (req.query.userId) {
      const uid = parseInt(req.query.userId);
      // Non-managers can only filter on themselves; ignore arbitrary ?userId=
      // values rather than 403'ing (silent narrowing is friendlier for a SPA
      // that always sends the user's own id).
      if (!isManager && uid !== req.user.userId) where.userId = req.user.userId;
      else if (Number.isFinite(uid)) where.userId = uid;
    } else if (!isManager) {
      where.userId = req.user.userId;
    }

    const items = await prisma.leaveRequest.findMany({
      where,
      include: { policy: { select: { id: true, name: true, leaveType: true } } },
      orderBy: { submittedAt: "desc" },
      take: 500,
    });
    res.json(items);
  } catch (e) {
    console.error("[leave] list requests error:", e.message);
    res.status(500).json({ error: "Failed to list leave requests" });
  }
});

router.get("/requests/:id", verifyToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const isManager = req.user.role === "ADMIN" || req.user.role === "MANAGER";
    const r = await prisma.leaveRequest.findFirst({
      where: tenantWhere(req, { id }),
      include: { policy: { select: { id: true, name: true, leaveType: true } } },
    });
    if (!r) return res.status(404).json({ error: "Leave request not found" });
    if (!isManager && r.userId !== req.user.userId) {
      return res.status(403).json({ error: "Cannot view another user's leave request", code: "RBAC_DENIED" });
    }
    res.json(r);
  } catch (e) {
    console.error("[leave] get request error:", e.message);
    res.status(500).json({ error: "Failed to load leave request" });
  }
});

router.post("/requests/:id/approve", verifyToken, verifyRole(["ADMIN", "MANAGER"]), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const result = await prisma.$transaction(async (tx) => {
      const r = await tx.leaveRequest.findFirst({ where: { id, tenantId: req.user.tenantId } });
      if (!r) {
        const err = new Error("NOT_FOUND");
        err.statusCode = 404;
        throw err;
      }
      if (r.status !== "PENDING") {
        const err = new Error("ALREADY_DECIDED");
        err.statusCode = 409;
        err.code = "ALREADY_DECIDED";
        err.status = r.status;
        throw err;
      }
      const policy = await tx.leavePolicy.findUnique({ where: { id: r.policyId } });
      if (policy && policy.leaveType !== "UNPAID") {
        const balance = await getOrCreateBalance(tx, r.tenantId, r.userId, policy);
        // pending -= days; used += days; available unchanged (already decremented on submit).
        await tx.leaveBalance.update({
          where: { id: balance.id },
          data: { pending: Math.max(0, balance.pending - r.days), used: balance.used + r.days },
        });
      }
      const updated = await tx.leaveRequest.update({
        where: { id: r.id },
        data: {
          status: "APPROVED",
          approverId: req.user.userId,
          approverNotes: req.body && req.body.notes ? String(req.body.notes) : null,
          decidedAt: new Date(),
        },
      });
      return updated;
    });
    await writeAudit("LeaveRequest", "APPROVE", result.id, req.user.userId, req.user.tenantId, {
      days: result.days, requesterId: result.userId,
    });
    res.json(result);
  } catch (e) {
    if (e && e.statusCode) {
      return res.status(e.statusCode).json({ error: e.message, code: e.code, status: e.status });
    }
    console.error("[leave] approve error:", e.message);
    res.status(500).json({ error: "Failed to approve leave request" });
  }
});

router.post("/requests/:id/reject", verifyToken, verifyRole(["ADMIN", "MANAGER"]), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const result = await prisma.$transaction(async (tx) => {
      const r = await tx.leaveRequest.findFirst({ where: { id, tenantId: req.user.tenantId } });
      if (!r) {
        const err = new Error("NOT_FOUND");
        err.statusCode = 404;
        throw err;
      }
      if (r.status !== "PENDING") {
        const err = new Error("ALREADY_DECIDED");
        err.statusCode = 409;
        err.code = "ALREADY_DECIDED";
        err.status = r.status;
        throw err;
      }
      const policy = await tx.leavePolicy.findUnique({ where: { id: r.policyId } });
      if (policy && policy.leaveType !== "UNPAID") {
        const balance = await getOrCreateBalance(tx, r.tenantId, r.userId, policy);
        // pending -= days; available += days (return reservation).
        await tx.leaveBalance.update({
          where: { id: balance.id },
          data: { pending: Math.max(0, balance.pending - r.days), available: balance.available + r.days },
        });
      }
      const updated = await tx.leaveRequest.update({
        where: { id: r.id },
        data: {
          status: "REJECTED",
          approverId: req.user.userId,
          approverNotes: req.body && req.body.notes ? String(req.body.notes) : null,
          decidedAt: new Date(),
        },
      });
      return updated;
    });
    await writeAudit("LeaveRequest", "REJECT", result.id, req.user.userId, req.user.tenantId, {
      days: result.days, requesterId: result.userId,
    });
    res.json(result);
  } catch (e) {
    if (e && e.statusCode) {
      return res.status(e.statusCode).json({ error: e.message, code: e.code, status: e.status });
    }
    console.error("[leave] reject error:", e.message);
    res.status(500).json({ error: "Failed to reject leave request" });
  }
});

router.post("/requests/:id/cancel", verifyToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const result = await prisma.$transaction(async (tx) => {
      const r = await tx.leaveRequest.findFirst({ where: { id, tenantId: req.user.tenantId } });
      if (!r) {
        const err = new Error("NOT_FOUND");
        err.statusCode = 404;
        throw err;
      }
      // Only the requester can cancel (managers reject instead).
      if (r.userId !== req.user.userId) {
        const err = new Error("Only the requester may cancel their own request");
        err.statusCode = 403;
        err.code = "RBAC_DENIED";
        throw err;
      }
      if (r.status !== "PENDING") {
        const err = new Error("ALREADY_DECIDED");
        err.statusCode = 409;
        err.code = "ALREADY_DECIDED";
        err.status = r.status;
        throw err;
      }
      const policy = await tx.leavePolicy.findUnique({ where: { id: r.policyId } });
      if (policy && policy.leaveType !== "UNPAID") {
        const balance = await getOrCreateBalance(tx, r.tenantId, r.userId, policy);
        await tx.leaveBalance.update({
          where: { id: balance.id },
          data: { pending: Math.max(0, balance.pending - r.days), available: balance.available + r.days },
        });
      }
      const updated = await tx.leaveRequest.update({
        where: { id: r.id },
        data: { status: "CANCELLED", decidedAt: new Date() },
      });
      return updated;
    });
    await writeAudit("LeaveRequest", "CANCEL", result.id, req.user.userId, req.user.tenantId, {
      days: result.days,
    });
    res.json(result);
  } catch (e) {
    if (e && e.statusCode) {
      return res.status(e.statusCode).json({ error: e.message, code: e.code, status: e.status });
    }
    console.error("[leave] cancel error:", e.message);
    res.status(500).json({ error: "Failed to cancel leave request" });
  }
});

// POST /api/leave/policy-carry-forward/run — admin-gated manual trigger for
// cron/leavePolicyEngine.js. Wave 8b's engine fires only on fiscal-year-end
// (31 March wellness, 31 December generic) so demo / QA can't otherwise
// validate carry-forward + encashment behaviour without waiting nine months.
//
// Mirror of /api/forecasting/snapshot/run + /api/billing/recurring/run +
// /api/email/scheduled/run (admin-gated, per-tenant scope, predictable
// envelope). Calls the engine's per-tenant function with the requesting
// admin's tenantId so cron + manual paths can never drift on dedup
// semantics.
//
// Optional body field `now` (ISO string) lets QA force the engine to act
// AS IF a specific date were the fiscal-year-end. Without it, the engine
// uses the actual server clock and is a no-op on non-FY-end days.
const { runForTenant: runLeavePolicyForTenant } = require("../cron/leavePolicyEngine");

router.post("/policy-carry-forward/run", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const overrideNow = req.body?.now ? new Date(req.body.now) : new Date();
    if (Number.isNaN(overrideNow.getTime())) {
      return res.status(400).json({
        success: false,
        tenantId: req.user.tenantId,
        error: "body.now must be a valid ISO date string when provided",
        code: "INVALID_INPUT",
      });
    }
    const result = await runLeavePolicyForTenant(req.user.tenantId, { now: overrideNow });
    res.json({
      success: true,
      tenantId: req.user.tenantId,
      ...result,
    });
  } catch (err) {
    console.error("[leave] manual carry-forward trigger failed:", err);
    res.status(500).json({
      success: false,
      tenantId: req.user.tenantId,
      error: err.message,
      code: "LEAVE_POLICY_RUN_FAILED",
    });
  }
});

// Get staff availability based on approved leaves
// ADMIN/MANAGER can see all staff availability; others see their own
router.get('/availability', verifyToken, async (req, res) => {
  try {
    const isAdminOrManager = ['ADMIN', 'MANAGER'].includes(req.user.role);

    // Parse date parameter or default to today
    const dateParam = req.query.date || new Date().toISOString().split('T')[0];
    const targetDate = new Date(dateParam + 'T00:00:00Z');

    if (isNaN(targetDate.getTime())) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
    }

    // Build day range for query
    const startOfDay = new Date(targetDate);
    startOfDay.setUTCHours(0, 0, 0, 0);
    const endOfDay = new Date(targetDate);
    endOfDay.setUTCHours(23, 59, 59, 999);

    // Fetch approved leave requests overlapping this date
    const approvedLeaves = await prisma.leaveRequest.findMany({
      where: {
        tenantId: req.user.tenantId,
        status: 'APPROVED',
        startDate: { lte: endOfDay },
        endDate: { gte: startOfDay }
      },
      select: {
        id: true,
        userId: true,
        startDate: true,
        endDate: true,
        days: true,
        policy: { select: { leaveType: true } }
      }
    });

    // Fetch active staff based on user role
    // ADMIN/MANAGER sees all staff; others see only their own record
    const staffWhere = {
      tenantId: req.user.tenantId,
      deactivatedAt: null
    };

    if (!isAdminOrManager) {
      staffWhere.id = req.user.userId;
    }

    const allStaff = await prisma.user.findMany({
      where: staffWhere,
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        wellnessRole: true,
        // Mirror the userRoles join from routes/staff.js so the availability
        // widget can surface the assigned RBAC role (Doctor / Nurse / custom)
        // instead of falling through to the access tier ("USER") when the
        // legacy wellnessRole column is null — happens for staff created
        // before deriveWellnessRole existed or when the picked role's key
        // doesn't match a wellness-catalog entry on this tenant.
        userRoles: {
          take: 1,
          orderBy: { assignedAt: 'desc' },
          select: {
            role: { select: { id: true, key: true, name: true } }
          }
        }
      },
      orderBy: { name: 'asc' }
    });

    // Build leave lookup map by userId
    const leaveMap = {};
    approvedLeaves.forEach(leave => {
      leaveMap[leave.userId] = {
        leaveType: leave.policy.leaveType,
        startDate: leave.startDate,
        endDate: leave.endDate,
        days: leave.days
      };
    });

    // Merge staff data with availability status
    const availability = allStaff.map(staff => {
      const assigned = staff.userRoles?.[0]?.role || null;
      return {
        id: staff.id,
        name: staff.name,
        email: staff.email,
        role: staff.role,
        wellnessRole: staff.wellnessRole,
        primaryRole: assigned
          ? { id: assigned.id, key: assigned.key, name: assigned.name }
          : null,
        available: !leaveMap[staff.id],
        leave: leaveMap[staff.id] || null
      };
    });

    res.json(availability);
  } catch (err) {
    console.error('[leave] availability query failed:', err);
    res.status(500).json({
      error: 'Failed to fetch availability',
      code: 'AVAILABILITY_FETCH_FAILED'
    });
  }
});

module.exports = router;
