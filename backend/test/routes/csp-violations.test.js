// @ts-check
/**
 * Unit tests for GET /api/csp/violations — pins the operator-inspect
 * surface for slice 2's CSP violation-report ingestion (#917 slice 3).
 *
 * Why this file exists (separate from csp.test.js)
 * ────────────────────────────────────────────────
 * `csp.test.js` covers the POST /report ingest contract. The GET
 * /violations endpoint has its own contract surface (auth, RBAC,
 * pagination clamps, directive filter, malformed-JSON resilience,
 * tenant scoping) — separate concerns get separate test files so each
 * test file's mocks stay narrow and the cause of a red test stays
 * obvious from the file path.
 *
 * Contract pinned here
 * ────────────────────
 *  1. 401 without Authorization header (verifyToken fail-closed).
 *  2. 403 RBAC_DENIED for non-ADMIN roles (MANAGER + USER).
 *  3. Happy path: AuditLog rows are parsed and surfaced with the
 *     normalised field shape (directive / blockedUri / documentUri / ...).
 *  4. ?limit query param clamps to MAX_LIMIT (500); negative/missing
 *     defaults to 100.
 *  5. ?directive filter narrows results.
 *  6. Malformed `details` JSON surfaces a {_raw} stub instead of 500.
 *  7. Tenant scoping — the WHERE clause uses the caller's tenantId.
 *  8. Empty AuditLog → {total: 0, violations: []}.
 *
 * Pattern mirrors backend/test/routes/audit-viewer.test.js:
 *   - patch prisma singleton models with vi.fn() BEFORE requiring the
 *     router (CJS resolves top-level requires synchronously);
 *   - sign real HS256 JWTs with the dev-fallback secret;
 *   - mount the router on a bare express app with supertest.
 */

import { describe, test, expect, beforeAll, beforeEach, vi } from "vitest";

import prisma from "../../lib/prisma.js";

// Patch prisma BEFORE requiring the router. csp.js calls
// prisma.auditLog.findMany + .count via the listing handler, and
// prisma.auditLog.create from the POST /report path; mock both so this
// file's tests don't need a live database.
prisma.auditLog = {
  findMany: vi.fn().mockResolvedValue([]),
  count: vi.fn().mockResolvedValue(0),
  create: vi.fn().mockResolvedValue({}),
};
// verifyToken does an optional revoked-token lookup — stub it absent.
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
    createdAt: at || new Date("2026-05-20T10:00:00Z"),
    tenantId,
    prevHash: null,
    hash: null,
    userId: null,
  };
}

beforeAll(() => {
  // Force a stable dev secret so locally-set JWT_SECRET env doesn't desync.
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

describe("GET /api/csp/violations — #917 slice 3", () => {
  // ── 1. 401 without Authorization ─────────────────────────────────────
  test("no Authorization header → 401", async () => {
    const res = await request(makeApp()).get("/api/csp/violations");
    expect(res.status).toBe(401);
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  // ── 2. 403 RBAC_DENIED for non-ADMIN roles ───────────────────────────
  test("MANAGER token → 403 RBAC_DENIED", async () => {
    const res = await request(makeApp())
      .get("/api/csp/violations")
      .set("Authorization", `Bearer ${tokenFor("MANAGER")}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("RBAC_DENIED");
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  test("USER token → 403 RBAC_DENIED", async () => {
    const res = await request(makeApp())
      .get("/api/csp/violations")
      .set("Authorization", `Bearer ${tokenFor("USER")}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("RBAC_DENIED");
  });

  // ── 3. Happy path: 3 audit rows → 3 parsed violations ────────────────
  test("3 W3C csp-report rows → 3 violations with parsed fields", async () => {
    const rows = [
      fakeAuditRow({
        id: 1,
        at: new Date("2026-05-22T08:00:00Z"),
        report: {
          "csp-report": {
            "document-uri": "https://crm.globusdemos.com/dashboard",
            "violated-directive": "script-src 'self'",
            "blocked-uri": "https://evil.example.com/x.js",
            "source-file": "https://crm.globusdemos.com/main.js",
            "line-number": 42,
            "column-number": 7,
            "original-policy": "default-src 'self'; script-src 'self'",
          },
        },
      }),
      fakeAuditRow({
        id: 2,
        at: new Date("2026-05-22T09:00:00Z"),
        report: {
          "csp-report": {
            "violated-directive": "img-src 'self'",
            "blocked-uri": "data:image/svg+xml,...",
            "document-uri": "https://crm.globusdemos.com/patients",
          },
        },
      }),
      fakeAuditRow({
        id: 3,
        at: new Date("2026-05-22T10:00:00Z"),
        report: {
          "csp-report": {
            "violated-directive": "style-src 'self'",
            "blocked-uri": "inline",
            "document-uri": "https://crm.globusdemos.com/billing",
          },
        },
      }),
    ];
    prisma.auditLog.findMany.mockResolvedValue(rows);
    prisma.auditLog.count.mockResolvedValue(3);

    const res = await request(makeApp())
      .get("/api/csp/violations")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.violations).toHaveLength(3);

    expect(res.body.violations[0]).toMatchObject({
      directive: "script-src 'self'",
      blockedUri: "https://evil.example.com/x.js",
      documentUri: "https://crm.globusdemos.com/dashboard",
      sourceFile: "https://crm.globusdemos.com/main.js",
      lineNumber: 42,
      columnNumber: 7,
      tenantId: 1,
    });
    expect(res.body.violations[0].at).toBeTruthy();
    expect(res.body.violations[0].originalPolicy).toBe(
      "default-src 'self'; script-src 'self'",
    );

    // Pagination metadata is echoed.
    expect(res.body.limit).toBe(100);
    expect(res.body.offset).toBe(0);
  });

  // ── 4. limit clamping ────────────────────────────────────────────────
  test("?limit=2 → limit=2 in response; ?limit=999 → clamped to 500", async () => {
    // limit=2
    let res = await request(makeApp())
      .get("/api/csp/violations?limit=2")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`);
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(2);
    // Confirm prisma.findMany was called with `take: 2`.
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 2 }),
    );

    // limit=999 clamps to 500
    prisma.auditLog.findMany.mockClear();
    res = await request(makeApp())
      .get("/api/csp/violations?limit=999")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`);
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(500);
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 500 }),
    );

    // Missing limit defaults to 100
    prisma.auditLog.findMany.mockClear();
    res = await request(makeApp())
      .get("/api/csp/violations")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`);
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(100);
  });

  // ── 5. ?directive filter narrows results ─────────────────────────────
  test("?directive=script-src narrows to only script-src rows", async () => {
    const rows = [
      fakeAuditRow({
        id: 1,
        report: { "csp-report": { "violated-directive": "script-src 'self'" } },
      }),
      fakeAuditRow({
        id: 2,
        report: { "csp-report": { "violated-directive": "img-src 'self'" } },
      }),
      fakeAuditRow({
        id: 3,
        report: { "csp-report": { "violated-directive": "script-src-elem" } },
      }),
    ];
    prisma.auditLog.findMany.mockResolvedValue(rows);
    prisma.auditLog.count.mockResolvedValue(3);

    const res = await request(makeApp())
      .get("/api/csp/violations?directive=script-src")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`);

    expect(res.status).toBe(200);
    // Two rows mention script-src (both 'script-src 'self'' and 'script-src-elem').
    expect(res.body.violations.length).toBe(2);
    for (const v of res.body.violations) {
      expect(v.directive.toLowerCase()).toContain("script-src");
    }
  });

  // ── 6. Malformed details JSON → {_raw} stub, no 500 ──────────────────
  test("row with malformed details JSON → row surfaces {_raw} fallback", async () => {
    const malformed = fakeAuditRow({ id: 1, report: "this is { not valid JSON" });
    const valid = fakeAuditRow({
      id: 2,
      report: { "csp-report": { "violated-directive": "img-src" } },
    });
    prisma.auditLog.findMany.mockResolvedValue([malformed, valid]);
    prisma.auditLog.count.mockResolvedValue(2);

    const res = await request(makeApp())
      .get("/api/csp/violations")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`);

    expect(res.status).toBe(200);
    expect(res.body.violations).toHaveLength(2);
    expect(res.body.violations[0]._raw).toBeTruthy();
    expect(typeof res.body.violations[0]._raw).toBe("string");
    // Truncated <=200 chars
    expect(res.body.violations[0]._raw.length).toBeLessThanOrEqual(200);
    // Second row still parses cleanly.
    expect(res.body.violations[1].directive).toBe("img-src");
  });

  // ── 7. Tenant scoping: where-clause uses caller's tenantId ───────────
  test("tenantId scoping — the WHERE clause is restricted to caller's tenant", async () => {
    const res = await request(makeApp())
      .get("/api/csp/violations")
      .set(
        "Authorization",
        `Bearer ${tokenFor("ADMIN", { tenantId: 42 })}`,
      );
    expect(res.status).toBe(200);
    // The findMany call must scope by the caller's tenantId. An ADMIN in
    // tenant A must NOT see tenant B's violation rows.
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

  // ── 8. Empty AuditLog → {total: 0, violations: []} ───────────────────
  test("zero matching rows → {total: 0, violations: []}", async () => {
    prisma.auditLog.findMany.mockResolvedValue([]);
    prisma.auditLog.count.mockResolvedValue(0);

    const res = await request(makeApp())
      .get("/api/csp/violations")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      total: 0,
      violations: [],
    });
  });

  // ── 9. ISO date bounds (from/to) reach the WHERE clause ──────────────
  test("?from + ?to ISO dates land in createdAt gte/lte", async () => {
    const res = await request(makeApp())
      .get("/api/csp/violations?from=2026-05-01T00:00:00Z&to=2026-05-22T00:00:00Z")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`);
    expect(res.status).toBe(200);

    const call = prisma.auditLog.findMany.mock.calls[0][0];
    expect(call.where.createdAt).toBeTruthy();
    expect(call.where.createdAt.gte).toBeInstanceOf(Date);
    expect(call.where.createdAt.lte).toBeInstanceOf(Date);
    expect(call.where.createdAt.gte.toISOString()).toBe("2026-05-01T00:00:00.000Z");
    expect(call.where.createdAt.lte.toISOString()).toBe("2026-05-22T00:00:00.000Z");
  });

  // ── 10. Reporting-API shape also parses ──────────────────────────────
  test("application/reports+json shape also surfaces normalised fields", async () => {
    const reportsApi = [
      {
        type: "csp-violation",
        body: {
          documentURL: "https://crm.globusdemos.com/dashboard",
          effectiveDirective: "script-src",
          blockedURL: "https://evil.example.com/x.js",
          sourceFile: "https://crm.globusdemos.com/main.js",
          lineNumber: 12,
          columnNumber: 5,
        },
      },
    ];
    const row = fakeAuditRow({ id: 1, report: reportsApi });
    prisma.auditLog.findMany.mockResolvedValue([row]);
    prisma.auditLog.count.mockResolvedValue(1);

    const res = await request(makeApp())
      .get("/api/csp/violations")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`);

    expect(res.status).toBe(200);
    expect(res.body.violations[0]).toMatchObject({
      directive: "script-src",
      blockedUri: "https://evil.example.com/x.js",
      documentUri: "https://crm.globusdemos.com/dashboard",
      sourceFile: "https://crm.globusdemos.com/main.js",
      lineNumber: 12,
      columnNumber: 5,
    });
  });
});
