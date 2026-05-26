// @ts-check
/**
 * Unit tests for GET /api/csp/violations/stats — pins the tenant-wide
 * aggregate KPI surface for the CSPViolations admin dashboard
 * (#917 CSP hardening slice 5).
 *
 * Why this file exists (separate from csp-violations.test.js)
 * ───────────────────────────────────────────────────────────
 * The /stats endpoint has its own contract surface (aggregate envelope
 * shape, byDirective + byBlockedUri bucketing, top-N cap, lastReportedAt
 * semantics, INVALID_DATE on bad ?from/?to) distinct from the /violations
 * listing tests. Keeping the test files separate keeps each file's mocks
 * narrow and the cause of a red test obvious from the file path.
 *
 * Contract pinned here
 * ────────────────────
 *  1. 401 without Authorization header (verifyToken fail-closed).
 *  2. 403 RBAC_DENIED for non-ADMIN role.
 *  3. 400 INVALID_DATE on bad ?from.
 *  4. 400 INVALID_DATE on bad ?to.
 *  5. Empty-tenant happy path → total=0, byDirective={}, lastReportedAt=null.
 *  6. Happy path: 5 violations across 3 directives → counts correct.
 *  7. lastReportedAt picks the maximum createdAt.
 *  8. Tenant isolation: callerTenantId narrows the WHERE clause.
 *  9. ?from + ?to narrow the date window.
 * 10. byBlockedUri capped to top-10 (by count desc).
 * 11. NO audit row written.
 * 12. Defensive: null createdAt rows counted in total (lastReportedAt skips them).
 *
 * Pattern mirrors backend/test/routes/csp-violations.test.js:
 *   - patch prisma singleton models with vi.fn() BEFORE requiring the router
 *     (CJS resolves top-level requires synchronously);
 *   - sign real HS256 JWTs with the dev-fallback secret;
 *   - mount the router on a bare express app with supertest.
 */

import { describe, test, expect, beforeAll, beforeEach, vi } from "vitest";

import prisma from "../../lib/prisma.js";

// Patch prisma BEFORE requiring the router. csp.js's /violations/stats
// handler calls prisma.auditLog.findMany + .count; stub both. We also stub
// .create because the same router exposes POST /report which calls it
// (irrelevant to these tests but keeps the singleton symmetric).
prisma.auditLog = {
  findMany: vi.fn().mockResolvedValue([]),
  count: vi.fn().mockResolvedValue(0),
  create: vi.fn().mockResolvedValue({}),
};
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createRequire } from "node:module";

const requireCJS = createRequire(import.meta.url);

// Must match backend/config/secrets.js DEV_FALLBACK_SECRET so verifyToken
// can validate the test-issued tokens.
const JWT_SECRET = process.env.JWT_SECRET || "enterprise_super_secret_key_2026";

const cspRouter = requireCJS("../../routes/csp");

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/csp", cspRouter);
  return app;
}

function tokenFor(role, opts = {}) {
  const tenantId = opts.tenantId != null ? opts.tenantId : 1;
  const userId = opts.userId != null ? opts.userId : 1;
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: "1h" },
  );
}

// Build a synthetic AuditLog row matching slice 2's persist shape.
function fakeAuditRow({ id, at, tenantId = 1, report }) {
  return {
    id,
    action: "REPORT",
    entity: "CSPViolation",
    entityId: null,
    details: typeof report === "string" ? report : JSON.stringify(report),
    createdAt: at !== undefined ? at : new Date("2026-05-20T10:00:00Z"),
    tenantId,
    prevHash: null,
    hash: null,
    userId: null,
  };
}

beforeAll(() => {
  if (!process.env.JWT_SECRET) {
    process.env.JWT_SECRET = JWT_SECRET;
  }
});

beforeEach(() => {
  prisma.auditLog.findMany.mockReset();
  prisma.auditLog.count.mockReset();
  prisma.auditLog.create.mockReset();
  prisma.auditLog.findMany.mockResolvedValue([]);
  prisma.auditLog.count.mockResolvedValue(0);
  prisma.auditLog.create.mockResolvedValue({});
});

describe("GET /api/csp/violations/stats — #917 slice 5", () => {
  // ── 1. 401 without Authorization ─────────────────────────────────────
  test("no Authorization header → 401", async () => {
    const res = await request(makeApp()).get("/api/csp/violations/stats");
    expect(res.status).toBe(401);
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.count).not.toHaveBeenCalled();
  });

  // ── 2. 403 RBAC_DENIED for non-ADMIN role ────────────────────────────
  test("MANAGER token → 403 RBAC_DENIED", async () => {
    const res = await request(makeApp())
      .get("/api/csp/violations/stats")
      .set("Authorization", `Bearer ${tokenFor("MANAGER")}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("RBAC_DENIED");
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  // ── 3. 400 INVALID_DATE on bad ?from ─────────────────────────────────
  test("?from=not-a-date → 400 INVALID_DATE", async () => {
    const res = await request(makeApp())
      .get("/api/csp/violations/stats?from=not-a-date")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_DATE");
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  // ── 4. 400 INVALID_DATE on bad ?to ───────────────────────────────────
  test("?to=garbage → 400 INVALID_DATE", async () => {
    const res = await request(makeApp())
      .get("/api/csp/violations/stats?to=garbage")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_DATE");
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  // ── 5. Empty-tenant happy path ───────────────────────────────────────
  test("empty AuditLog → total=0, byDirective={}, byBlockedUri={}, lastReportedAt=null", async () => {
    prisma.auditLog.findMany.mockResolvedValue([]);
    prisma.auditLog.count.mockResolvedValue(0);

    const res = await request(makeApp())
      .get("/api/csp/violations/stats")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      total: 0,
      byDirective: {},
      byBlockedUri: {},
      lastReportedAt: null,
    });
  });

  // ── 6. Happy path: 5 violations across 3 directives ──────────────────
  test("5 violations across 3 directives → byDirective counts correct", async () => {
    const rows = [
      fakeAuditRow({
        id: 1,
        at: new Date("2026-05-20T10:00:00Z"),
        report: { "csp-report": { "violated-directive": "script-src 'self'", "blocked-uri": "eval" } },
      }),
      fakeAuditRow({
        id: 2,
        at: new Date("2026-05-21T10:00:00Z"),
        report: { "csp-report": { "violated-directive": "script-src 'self'", "blocked-uri": "eval" } },
      }),
      fakeAuditRow({
        id: 3,
        at: new Date("2026-05-22T10:00:00Z"),
        report: { "csp-report": { "violated-directive": "script-src 'self'", "blocked-uri": "inline" } },
      }),
      fakeAuditRow({
        id: 4,
        at: new Date("2026-05-23T10:00:00Z"),
        report: { "csp-report": { "violated-directive": "img-src 'self'", "blocked-uri": "data:image/svg+xml" } },
      }),
      fakeAuditRow({
        id: 5,
        at: new Date("2026-05-24T10:00:00Z"),
        report: { "csp-report": { "violated-directive": "style-src 'self'", "blocked-uri": "inline" } },
      }),
    ];
    prisma.auditLog.findMany.mockResolvedValue(rows);
    prisma.auditLog.count.mockResolvedValue(5);

    const res = await request(makeApp())
      .get("/api/csp/violations/stats")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(5);
    expect(res.body.byDirective).toEqual({
      "script-src 'self'": 3,
      "img-src 'self'": 1,
      "style-src 'self'": 1,
    });
    expect(res.body.byBlockedUri).toEqual({
      eval: 2,
      inline: 2,
      "data:image/svg+xml": 1,
    });
  });

  // ── 7. lastReportedAt picks the maximum createdAt ────────────────────
  test("lastReportedAt = max(createdAt) across rows", async () => {
    const rows = [
      fakeAuditRow({
        id: 1,
        at: new Date("2026-05-10T10:00:00Z"),
        report: { "csp-report": { "violated-directive": "script-src" } },
      }),
      fakeAuditRow({
        id: 2,
        at: new Date("2026-05-25T15:30:00Z"), // ← max
        report: { "csp-report": { "violated-directive": "img-src" } },
      }),
      fakeAuditRow({
        id: 3,
        at: new Date("2026-05-15T12:00:00Z"),
        report: { "csp-report": { "violated-directive": "style-src" } },
      }),
    ];
    prisma.auditLog.findMany.mockResolvedValue(rows);
    prisma.auditLog.count.mockResolvedValue(3);

    const res = await request(makeApp())
      .get("/api/csp/violations/stats")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`);

    expect(res.status).toBe(200);
    expect(res.body.lastReportedAt).toBe("2026-05-25T15:30:00.000Z");
  });

  // ── 8. Tenant isolation ──────────────────────────────────────────────
  test("WHERE clause scopes by caller's tenantId", async () => {
    const res = await request(makeApp())
      .get("/api/csp/violations/stats")
      .set("Authorization", `Bearer ${tokenFor("ADMIN", { tenantId: 42 })}`);

    expect(res.status).toBe(200);
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 42,
          entity: "CSPViolation",
          action: "REPORT",
        }),
      }),
    );
    expect(prisma.auditLog.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 42 }),
      }),
    );
  });

  // ── 9. ?from / ?to narrow the window ─────────────────────────────────
  test("?from + ?to ISO dates land in createdAt gte/lte", async () => {
    const res = await request(makeApp())
      .get(
        "/api/csp/violations/stats?from=2026-05-01T00:00:00Z&to=2026-05-22T00:00:00Z",
      )
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`);

    expect(res.status).toBe(200);
    const call = prisma.auditLog.findMany.mock.calls[0][0];
    expect(call.where.createdAt).toBeTruthy();
    expect(call.where.createdAt.gte).toBeInstanceOf(Date);
    expect(call.where.createdAt.lte).toBeInstanceOf(Date);
    expect(call.where.createdAt.gte.toISOString()).toBe(
      "2026-05-01T00:00:00.000Z",
    );
    expect(call.where.createdAt.lte.toISOString()).toBe(
      "2026-05-22T00:00:00.000Z",
    );
  });

  // ── 10. byBlockedUri capped to top-10 ────────────────────────────────
  test("byBlockedUri capped to top-10 entries (by count desc)", async () => {
    // 12 distinct blocked URIs with varying counts. Top-10 should be present
    // in the response; the 11th + 12th should be excluded.
    const rows = [];
    // Top counts: blocked-0 has 12 rows, blocked-1 has 11, blocked-2 has 10, etc.
    // blocked-10 has 2 rows, blocked-11 has 1 row — those should be excluded.
    const tiers = [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
    let id = 0;
    for (let i = 0; i < tiers.length; i += 1) {
      for (let j = 0; j < tiers[i]; j += 1) {
        id += 1;
        rows.push(
          fakeAuditRow({
            id,
            at: new Date(`2026-05-${String(10 + i).padStart(2, "0")}T10:00:00Z`),
            report: {
              "csp-report": {
                "violated-directive": "script-src",
                "blocked-uri": `blocked-${i}`,
              },
            },
          }),
        );
      }
    }
    prisma.auditLog.findMany.mockResolvedValue(rows);
    prisma.auditLog.count.mockResolvedValue(rows.length);

    const res = await request(makeApp())
      .get("/api/csp/violations/stats")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`);

    expect(res.status).toBe(200);
    const keys = Object.keys(res.body.byBlockedUri);
    expect(keys.length).toBe(10);
    // The two least-frequent buckets must be absent.
    expect(keys).not.toContain("blocked-10");
    expect(keys).not.toContain("blocked-11");
    // The top bucket is present with the correct count.
    expect(res.body.byBlockedUri["blocked-0"]).toBe(12);
    expect(res.body.byBlockedUri["blocked-9"]).toBe(3);
  });

  // ── 11. NO audit row written ─────────────────────────────────────────
  test("/violations/stats does NOT write an audit row", async () => {
    prisma.auditLog.findMany.mockResolvedValue([
      fakeAuditRow({
        id: 1,
        report: { "csp-report": { "violated-directive": "script-src" } },
      }),
    ]);
    prisma.auditLog.count.mockResolvedValue(1);

    const res = await request(makeApp())
      .get("/api/csp/violations/stats")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`);

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  // ── 12. Defensive: null createdAt rows counted in total ──────────────
  test("rows with null createdAt counted in total; lastReportedAt skips them", async () => {
    const rows = [
      fakeAuditRow({
        id: 1,
        at: new Date("2026-05-20T10:00:00Z"),
        report: { "csp-report": { "violated-directive": "script-src" } },
      }),
      fakeAuditRow({
        id: 2,
        at: null, // defensive null
        report: { "csp-report": { "violated-directive": "img-src" } },
      }),
    ];
    prisma.auditLog.findMany.mockResolvedValue(rows);
    // count() reflects the full population regardless of in-memory parsing.
    prisma.auditLog.count.mockResolvedValue(2);

    const res = await request(makeApp())
      .get("/api/csp/violations/stats")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    // lastReportedAt picks the only valid createdAt — null row is skipped.
    expect(res.body.lastReportedAt).toBe("2026-05-20T10:00:00.000Z");
    // Both directives bucketed despite one having null createdAt.
    expect(res.body.byDirective).toEqual({
      "script-src": 1,
      "img-src": 1,
    });
  });
});
