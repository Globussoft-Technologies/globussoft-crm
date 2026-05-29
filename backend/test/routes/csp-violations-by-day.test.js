// @ts-check
/**
 * Unit tests for GET /api/csp/violations/by-day — pins the daily time-series
 * rollup surface that powers the CSPViolations admin dashboard chart
 * (#917 CSP hardening slice 6).
 *
 * Why this file exists (separate from csp-violations.test.js + -stats.test.js)
 * ──────────────────────────────────────────────────────────────────────────
 * The /by-day endpoint has its own contract surface (UTC YYYY-MM-DD bucketing,
 * per-bucket byDirective breakdown, orderBy day/count asc|desc, ?from/?to
 * INVALID_DATE_FORMAT, "unknown" bucket for null createdAt, post-aggregation
 * pagination) distinct from the slice-3 listing tests and slice-5 stats
 * tests. Keeping the file separate keeps each file's mocks narrow + the cause
 * of a red test obvious from the file path.
 *
 * Contract pinned here
 * ────────────────────
 *  1. 401 without Authorization header (verifyToken fail-closed).
 *  2. 403 RBAC_DENIED for non-ADMIN role.
 *  3. 400 INVALID_DATE_FORMAT on bad ?from.
 *  4. 400 INVALID_DATE_FORMAT on bad ?to.
 *  5. Empty AuditLog → total=0, rows=[].
 *  6. 5 violations across 3 days → 3 day rows, byDirective correct.
 *  7. Default orderBy=day:asc chronological.
 *  8. ?orderBy=count:desc flips the ordering by count.
 *  9. ?from + ?to narrows the bucket array (inclusive lexicographic).
 * 10. Defensive: null createdAt → "unknown" bucket; excluded under ?from/?to.
 * 11. Pagination ?limit=7&offset=2 slices AFTER aggregation.
 * 12. NO audit row written.
 *
 * Pattern mirrors backend/test/routes/csp-violations-stats.test.js:
 *   - patch prisma singleton models with vi.fn() BEFORE requiring the router
 *     (CJS resolves top-level requires synchronously);
 *   - sign real HS256 JWTs with the dev-fallback secret;
 *   - mount the router on a bare express app with supertest.
 */

import { describe, test, expect, beforeAll, beforeEach, vi } from "vitest";

import prisma from "../../lib/prisma.js";

// Patch prisma BEFORE requiring the router. csp.js's /violations/by-day
// handler calls prisma.auditLog.findMany; stub it. We also stub .count +
// .create because sibling handlers on the same router use them and we want
// the singleton to remain symmetric across tests.
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

describe("GET /api/csp/violations/by-day — #917 slice 6", () => {
  // ── 1. 401 without Authorization ─────────────────────────────────────
  test("no Authorization header → 401", async () => {
    const res = await request(makeApp()).get("/api/csp/violations/by-day");
    expect(res.status).toBe(401);
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  // ── 2. 403 RBAC_DENIED for non-ADMIN role ────────────────────────────
  test("MANAGER token → 403 RBAC_DENIED", async () => {
    const res = await request(makeApp())
      .get("/api/csp/violations/by-day")
      .set("Authorization", `Bearer ${tokenFor("MANAGER")}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("RBAC_DENIED");
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  // ── 3. 400 INVALID_DATE_FORMAT on bad ?from ──────────────────────────
  test("?from=not-a-date → 400 INVALID_DATE_FORMAT", async () => {
    const res = await request(makeApp())
      .get("/api/csp/violations/by-day?from=not-a-date")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_DATE_FORMAT");
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  // ── 4. 400 INVALID_DATE_FORMAT on bad ?to ────────────────────────────
  test("?to=garbage → 400 INVALID_DATE_FORMAT", async () => {
    const res = await request(makeApp())
      .get("/api/csp/violations/by-day?to=2026/05/20")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_DATE_FORMAT");
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  // ── 5. Empty happy path ──────────────────────────────────────────────
  test("empty AuditLog → total=0, rows=[]", async () => {
    prisma.auditLog.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get("/api/csp/violations/by-day")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      total: 0,
      rows: [],
    });
  });

  // ── 6. Happy path: 5 violations across 3 days → byDirective correct ──
  test("5 violations across 3 days → 3 day rows + byDirective bucketed", async () => {
    const rows = [
      fakeAuditRow({
        id: 1,
        at: new Date("2026-05-20T10:00:00Z"),
        report: { "csp-report": { "violated-directive": "script-src" } },
      }),
      fakeAuditRow({
        id: 2,
        at: new Date("2026-05-20T14:30:00Z"),
        report: { "csp-report": { "violated-directive": "script-src" } },
      }),
      fakeAuditRow({
        id: 3,
        at: new Date("2026-05-20T20:00:00Z"),
        report: { "csp-report": { "violated-directive": "img-src" } },
      }),
      fakeAuditRow({
        id: 4,
        at: new Date("2026-05-21T08:00:00Z"),
        report: { "csp-report": { "violated-directive": "style-src" } },
      }),
      fakeAuditRow({
        id: 5,
        at: new Date("2026-05-22T09:00:00Z"),
        report: { "csp-report": { "violated-directive": "script-src" } },
      }),
    ];
    prisma.auditLog.findMany.mockResolvedValue(rows);

    const res = await request(makeApp())
      .get("/api/csp/violations/by-day")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.rows).toHaveLength(3);

    // Default orderBy=day:asc → chronological.
    expect(res.body.rows[0].day).toBe("2026-05-20");
    expect(res.body.rows[0].count).toBe(3);
    expect(res.body.rows[0].byDirective).toEqual({
      "script-src": 2,
      "img-src": 1,
    });

    expect(res.body.rows[1].day).toBe("2026-05-21");
    expect(res.body.rows[1].count).toBe(1);
    expect(res.body.rows[1].byDirective).toEqual({ "style-src": 1 });

    expect(res.body.rows[2].day).toBe("2026-05-22");
    expect(res.body.rows[2].count).toBe(1);
    expect(res.body.rows[2].byDirective).toEqual({ "script-src": 1 });
  });

  // ── 7. Default orderBy=day:asc ───────────────────────────────────────
  test("default orderBy is day:asc (chronological)", async () => {
    // Provide rows in non-chronological order; response must still come
    // back sorted ascending by day.
    const rows = [
      fakeAuditRow({
        id: 1,
        at: new Date("2026-05-22T10:00:00Z"),
        report: { "csp-report": { "violated-directive": "script-src" } },
      }),
      fakeAuditRow({
        id: 2,
        at: new Date("2026-05-19T10:00:00Z"),
        report: { "csp-report": { "violated-directive": "script-src" } },
      }),
      fakeAuditRow({
        id: 3,
        at: new Date("2026-05-21T10:00:00Z"),
        report: { "csp-report": { "violated-directive": "script-src" } },
      }),
    ];
    prisma.auditLog.findMany.mockResolvedValue(rows);

    const res = await request(makeApp())
      .get("/api/csp/violations/by-day")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`);

    expect(res.status).toBe(200);
    expect(res.body.rows.map((r) => r.day)).toEqual([
      "2026-05-19",
      "2026-05-21",
      "2026-05-22",
    ]);
  });

  // ── 8. ?orderBy=count:desc ───────────────────────────────────────────
  test("?orderBy=count:desc sorts by bucket count descending", async () => {
    const rows = [
      // 2026-05-20 → 1 hit
      fakeAuditRow({
        id: 1,
        at: new Date("2026-05-20T10:00:00Z"),
        report: { "csp-report": { "violated-directive": "script-src" } },
      }),
      // 2026-05-21 → 3 hits
      fakeAuditRow({
        id: 2,
        at: new Date("2026-05-21T10:00:00Z"),
        report: { "csp-report": { "violated-directive": "script-src" } },
      }),
      fakeAuditRow({
        id: 3,
        at: new Date("2026-05-21T11:00:00Z"),
        report: { "csp-report": { "violated-directive": "img-src" } },
      }),
      fakeAuditRow({
        id: 4,
        at: new Date("2026-05-21T12:00:00Z"),
        report: { "csp-report": { "violated-directive": "style-src" } },
      }),
      // 2026-05-22 → 2 hits
      fakeAuditRow({
        id: 5,
        at: new Date("2026-05-22T10:00:00Z"),
        report: { "csp-report": { "violated-directive": "script-src" } },
      }),
      fakeAuditRow({
        id: 6,
        at: new Date("2026-05-22T11:00:00Z"),
        report: { "csp-report": { "violated-directive": "script-src" } },
      }),
    ];
    prisma.auditLog.findMany.mockResolvedValue(rows);

    const res = await request(makeApp())
      .get("/api/csp/violations/by-day?orderBy=count:desc")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`);

    expect(res.status).toBe(200);
    expect(res.body.rows[0]).toMatchObject({ day: "2026-05-21", count: 3 });
    expect(res.body.rows[1]).toMatchObject({ day: "2026-05-22", count: 2 });
    expect(res.body.rows[2]).toMatchObject({ day: "2026-05-20", count: 1 });
  });

  // ── 9. ?from + ?to narrows the bucket array (inclusive) ──────────────
  test("?from + ?to inclusive bounds narrow the bucket array", async () => {
    const rows = [
      fakeAuditRow({
        id: 1,
        at: new Date("2026-05-18T10:00:00Z"), // outside ?from
        report: { "csp-report": { "violated-directive": "script-src" } },
      }),
      fakeAuditRow({
        id: 2,
        at: new Date("2026-05-20T10:00:00Z"), // ← inclusive lower bound
        report: { "csp-report": { "violated-directive": "script-src" } },
      }),
      fakeAuditRow({
        id: 3,
        at: new Date("2026-05-21T10:00:00Z"),
        report: { "csp-report": { "violated-directive": "script-src" } },
      }),
      fakeAuditRow({
        id: 4,
        at: new Date("2026-05-22T10:00:00Z"), // ← inclusive upper bound
        report: { "csp-report": { "violated-directive": "img-src" } },
      }),
      fakeAuditRow({
        id: 5,
        at: new Date("2026-05-24T10:00:00Z"), // outside ?to
        report: { "csp-report": { "violated-directive": "style-src" } },
      }),
    ];
    prisma.auditLog.findMany.mockResolvedValue(rows);

    const res = await request(makeApp())
      .get("/api/csp/violations/by-day?from=2026-05-20&to=2026-05-22")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.rows.map((r) => r.day)).toEqual([
      "2026-05-20",
      "2026-05-21",
      "2026-05-22",
    ]);
  });

  // ── 10. Defensive: null createdAt → "unknown" bucket ─────────────────
  test("null createdAt → 'unknown' bucket; excluded under ?from/?to", async () => {
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

    // No ?from/?to → "unknown" bucket present.
    const noBounds = await request(makeApp())
      .get("/api/csp/violations/by-day")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`);

    expect(noBounds.status).toBe(200);
    expect(noBounds.body.total).toBe(2);
    const dayKeys = noBounds.body.rows.map((r) => r.day);
    expect(dayKeys).toContain("2026-05-20");
    expect(dayKeys).toContain("unknown");

    // With ?from → "unknown" bucket excluded.
    const withFrom = await request(makeApp())
      .get("/api/csp/violations/by-day?from=2026-05-01")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`);

    expect(withFrom.status).toBe(200);
    expect(withFrom.body.total).toBe(1);
    expect(withFrom.body.rows.map((r) => r.day)).toEqual(["2026-05-20"]);
  });

  // ── 11. Pagination ?limit=7&offset=2 ─────────────────────────────────
  test("?limit + ?offset paginates AFTER aggregation + sort", async () => {
    // 10 distinct days, one violation each.
    const rows = [];
    for (let i = 0; i < 10; i += 1) {
      const day = String(10 + i).padStart(2, "0");
      rows.push(
        fakeAuditRow({
          id: i + 1,
          at: new Date(`2026-05-${day}T10:00:00Z`),
          report: { "csp-report": { "violated-directive": "script-src" } },
        }),
      );
    }
    prisma.auditLog.findMany.mockResolvedValue(rows);

    const res = await request(makeApp())
      .get("/api/csp/violations/by-day?limit=7&offset=2")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`);

    expect(res.status).toBe(200);
    // total reflects pre-pagination bucket count (10 days), rows is sliced.
    expect(res.body.total).toBe(10);
    expect(res.body.rows).toHaveLength(7);
    // Default day:asc → offset=2 skips 2026-05-10 + 2026-05-11; limit=7 →
    // takes 2026-05-12 through 2026-05-18.
    expect(res.body.rows[0].day).toBe("2026-05-12");
    expect(res.body.rows[6].day).toBe("2026-05-18");
  });

  // ── 12. NO audit row written ─────────────────────────────────────────
  test("/violations/by-day does NOT write an audit row", async () => {
    prisma.auditLog.findMany.mockResolvedValue([
      fakeAuditRow({
        id: 1,
        report: { "csp-report": { "violated-directive": "script-src" } },
      }),
    ]);

    const res = await request(makeApp())
      .get("/api/csp/violations/by-day")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`);

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
