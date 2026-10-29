const router = require("express").Router();
const prisma = require("../lib/prisma");
const { verifyToken, verifyRole } = require("../middleware/auth");
const { computeHash, backfillTenantChain } = require("../lib/audit");

// GET / — list audit logs with optional filtering. ADMIN-only — audit
// rows include the `details` JSON column which carries PII for several
// entity classes (Contact name+email on SOFT_DELETE, wellness Patient
// writes carry richer attributes, etc.). Closes #408.
router.get("/", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const { entity, action } = req.query;
    const where = { tenantId: req.user.tenantId };

    if (entity) where.entity = entity;
    if (action) where.action = action;

    const logs = await prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        user: { select: { id: true, name: true, email: true } },
      },
    });
    res.json(logs);
  } catch (err) {
    console.error("[AuditLog] List error:", err);
    res.status(500).json({ error: "Failed to fetch audit logs" });
  }
});

// GET /verify — strict tamper-evidence walk for the requesting tenant.
//
// Spec (#558, Option A): every row for the tenant must have a non-null
// hash, the prevHash must match the prior row's hash (or the GENESIS
// sentinel for the first row), and the recomputed sha256 must equal the
// stored hash. ANY break — including a null hash on a legacy row — is
// surfaced with `integrityVerified: false` + `brokenAt: <id>` + a
// human-readable `reason`. `chainLength` reports the rows scanned
// (not just hashed rows) so it's always === totalRows. The UI uses the
// gap between totalRows and chainLength to decide whether to show the
// "Backfill required" banner.
//
// The earlier permissive walker silently skipped null-hash rows and
// reported `chainLength: 0, integrityVerified: true` against a freshly-
// minted tenant — a false-green that masked the chain having never run.
router.get("/verify", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    // Do not materialize a tenant's entire audit history in one Prisma
    // response. Generic tenants can have many thousands of rows with large
    // details payloads; the single unbounded query could time out upstream
    // and turn a healthy chain into an HTTP 500. Cursor batches keep the
    // verifier's memory and response time per DB round-trip bounded while
    // preserving the same deterministic [createdAt, id] walk.
    const batchSize = 1000;
    const rowSelect = {
      id: true,
      action: true,
      entity: true,
      entityId: true,
      userId: true,
      details: true,
      createdAt: true,
      prevHash: true,
      hash: true,
    };

    let chainLength = 0;
    let brokenAt = null;
    let reason = null;
    let lastHash = null;
    let unhashedRows = 0;

    let cursor = null;
    while (true) {
      const query = {
        where: { tenantId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: batchSize,
        select: rowSelect,
      };
      if (cursor != null) {
        query.cursor = { id: cursor };
        query.skip = 1;
      }

      const rows = await prisma.auditLog.findMany(query);
      if (rows.length === 0) break;

      for (const row of rows) {
        chainLength += 1;

        if (row.hash == null) {
          unhashedRows += 1;
          if (brokenAt === null) {
            brokenAt = row.id;
            reason = "null hash — row was never chained (run backfill)";
          }
          continue;
        }

        // Keep walking after the first failure so totalRows/unhashedRows are
        // accurate, but don't let a known-broken prefix affect diagnostics
        // for later rows.
        if (brokenAt !== null) continue;

        const expectedPrev = lastHash == null ? `GENESIS_${tenantId}` : lastHash;
        if (row.prevHash !== expectedPrev) {
          brokenAt = row.id;
          reason = `prevHash mismatch (expected ${expectedPrev}, got ${row.prevHash || "null"})`;
          continue;
        }

        const recomputed = computeHash(row.prevHash, {
          tenantId,
          entity: row.entity,
          action: row.action,
          entityId: row.entityId,
          userId: row.userId,
          details: row.details,
          createdAt: row.createdAt.toISOString(),
        });

        if (recomputed !== row.hash) {
          brokenAt = row.id;
          reason = "hash mismatch (row content tampered)";
          continue;
        }

        lastHash = row.hash;
      }

      cursor = rows[rows.length - 1].id;
      if (rows.length < batchSize) break;
    }

    const totalRows = chainLength;
    res.json({
      chainLength,
      totalRows,
      unhashedRows,
      brokenAt,
      reason,
      integrityVerified: brokenAt === null,
      lastVerifiedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[AuditLog] Verify error:", err);
    res.status(500).json({ error: "Failed to verify audit chain" });
  }
});

// POST /backfill — retroactively compute and persist `prevHash` + `hash`
// for every row in the requester's tenant that's missing a hash. Walks
// rows in [createdAt asc, id asc] order — the same order the verifier
// uses — so backfilled rows form a valid chain when /verify is run next.
//
// Idempotent: if a row already has a non-null hash, the backfill
// recomputes its expected value with the same canonical payload and
// aborts with `409 conflict` + the row id if the recomputed value
// disagrees with what's stored (= someone tampered with a chained row
// AFTER it was hashed). Never silently overwrites a stored hash.
//
// Tenant-scoped: only the caller's tenant. The cross-tenant equivalent
// for ops use is `backend/scripts/backfill-audit-chain.js`.
//
// ADMIN-only. #558.
router.post(
  "/backfill",
  verifyToken,
  verifyRole(["ADMIN"]),
  async (req, res) => {
    try {
      const tenantId = req.user.tenantId;
      // Run the backfill. Under concurrent writeAudit traffic from other
      // requests, new rows may land between findMany() and the loop's last
      // update — those rows may fork off a row whose hash gets re-stamped
      // mid-walk. To converge, re-run the backfill up to 2 more times whenever
      // the previous pass made writes. By pass 2, any racey concurrent write
      // has either finished (with a prevHash that anchors on the stable
      // post-pass-1 chain tail) or itself triggers the inline-repair in
      // writeAudit. Pass 3 is a defensive ceiling — beyond that the system
      // is under enough write pressure that the next caller can run /backfill
      // again. The response reports the chain size + clean count from the
      // FIRST pass (the canonical "what existed when the operator asked"),
      // the total updates across all passes, and the head from the last pass.
      const first = await backfillTenantChain(tenantId);
      let totalUpdated = first.updatedRows;
      let lastHead = first.head;
      let lastResult = first;
      for (let pass = 1; pass < 3 && lastResult.updatedRows > 0; pass++) {
        const next = await backfillTenantChain(tenantId);
        totalUpdated += next.updatedRows;
        lastHead = next.head;
        lastResult = next;
      }
      res.json({
        tenantId,
        walkedRows: first.walkedRows,
        updatedRows: totalUpdated,
        skippedRows: first.skippedRows,
        head: lastHead,
        backfilledAt: new Date().toISOString(),
      });
    } catch (err) {
      // backfillTenantChain throws a tagged error with .conflictRowId when
      // it detects post-hash tampering. Surface it as 409 so the UI can
      // route the operator to incident-response instead of retrying.
      if (err && err.conflictRowId != null) {
        console.error(
          `[AuditLog] Backfill conflict at row ${err.conflictRowId}:`,
          err.message,
        );
        return res.status(409).json({
          error:
            "Backfill aborted — existing hash conflict (tampering suspected)",
          conflictRowId: err.conflictRowId,
          reason: err.message,
        });
      }
      console.error("[AuditLog] Backfill error:", err);
      res.status(500).json({ error: "Failed to backfill audit chain" });
    }
  },
);

module.exports = router;
