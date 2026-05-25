// @ts-check
/**
 * Unit tests for backend/routes/csp.js — pins the CSP violation-report
 * ingestion contract.
 *
 * Why this file exists
 * ────────────────────
 * #917 slice 2 ships POST /api/csp/report — the endpoint browsers POST to
 * when the strict CSP-Report-Only header (slice 1) catches a violation.
 * The route's contract has FOUR load-bearing properties that, if any of
 * them regresses, would silently break the security-telemetry pipeline:
 *
 *   (a) NEVER echoes content back (204 No Content always). Echoing would
 *       create an amplification surface — an attacker could POST 4 KiB
 *       of crafted JSON expecting an echoed body to bypass an outer
 *       length restriction. We don't echo, ever.
 *
 *   (b) Persists with the EXACT shape downstream readers expect:
 *       entity='CSPViolation', action='REPORT', details=JSON.stringify(body).
 *       If the entity/action labels drift, the audit-log UI's filter
 *       chips go red.
 *
 *   (c) Defensive on bad input — empty body, malformed JSON, missing
 *       Content-Type all return 204 (browsers don't retry on errors).
 *
 *   (d) 4 KiB body cap — protects the audit log from a malicious
 *       report-bomb that fills the table. Exceeds → 413.
 *
 * Pattern mirrors backend/test/routes/admin.test.js — Prisma singleton
 * monkey-patch + supertest. No auth-middleware bypass needed because
 * the route is intentionally unauthenticated (browsers can't send
 * Authorization on CSP reports per the W3C spec).
 */
import { describe, test, expect, beforeEach, vi } from "vitest";

import prisma from "../../lib/prisma.js";

// Patch prisma.auditLog.create to a vi.fn() so we can assert what the
// route writes. resolveValue({}) so the fire-and-forget .catch chain
// doesn't log spurious "persist failed" errors during happy paths.
prisma.auditLog = {
  create: vi.fn().mockResolvedValue({}),
};

import express from "express";
import request from "supertest";
import { createRequire } from "node:module";
const requireCJS = createRequire(import.meta.url);
const cspRouter = requireCJS("../../routes/csp");

function makeApp() {
  const app = express();
  app.use("/api/csp", cspRouter);
  return app;
}

beforeEach(() => {
  prisma.auditLog.create.mockReset();
  prisma.auditLog.create.mockResolvedValue({});
});

describe("POST /api/csp/report", () => {
  // ── 1. W3C application/csp-report shape ──────────────────────────────
  test("valid W3C csp-report body → 204 No Content", async () => {
    const report = {
      "csp-report": {
        "document-uri": "https://crm.globusdemos.com/dashboard",
        "violated-directive": "script-src 'self'",
        "blocked-uri": "https://evil.example.com/x.js",
        "source-file": "https://crm.globusdemos.com/dashboard",
        "line-number": 42,
        "column-number": 7,
        "original-policy": "default-src 'self'; script-src 'self'",
      },
    };
    const res = await request(makeApp())
      .post("/api/csp/report")
      .set("Content-Type", "application/csp-report")
      .send(JSON.stringify(report));
    expect(res.status).toBe(204);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
  });

  // ── 2. Reporting-API application/reports+json shape ──────────────────
  test("valid application/reports+json array → 204 No Content", async () => {
    const reports = [
      {
        type: "csp-violation",
        age: 100,
        url: "https://crm.globusdemos.com/dashboard",
        body: {
          documentURL: "https://crm.globusdemos.com/dashboard",
          effectiveDirective: "script-src",
          blockedURL: "https://evil.example.com/x.js",
        },
      },
    ];
    const res = await request(makeApp())
      .post("/api/csp/report")
      .set("Content-Type", "application/reports+json")
      .send(JSON.stringify(reports));
    expect(res.status).toBe(204);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
  });

  // ── 3. Persist shape pin ─────────────────────────────────────────────
  test("body persists as AuditLog with entity='CSPViolation', action='REPORT'", async () => {
    const report = {
      "csp-report": {
        "violated-directive": "img-src 'self'",
        "blocked-uri": "data:image/svg+xml,...",
      },
    };
    await request(makeApp())
      .post("/api/csp/report")
      .set("Content-Type", "application/csp-report")
      .send(JSON.stringify(report));

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const callArg = prisma.auditLog.create.mock.calls[0][0];
    expect(callArg).toMatchObject({
      data: {
        tenantId: 1,
        entity: "CSPViolation",
        action: "REPORT",
      },
    });
    // details must be a JSON-stringified copy of the report
    expect(typeof callArg.data.details).toBe("string");
    const parsed = JSON.parse(callArg.data.details);
    expect(parsed).toEqual(report);
  });

  // ── 4. Defensive on empty body ───────────────────────────────────────
  test("empty body → 204 (never errors)", async () => {
    const res = await request(makeApp())
      .post("/api/csp/report")
      .set("Content-Type", "application/csp-report")
      .send("");
    expect(res.status).toBe(204);
    // Even an empty body should be persisted as {} so we have a record
    // that *something* was reported (e.g. heartbeat from a misconfigured
    // browser) — but the spec is lenient: 204 is the contract, the
    // persist call is fire-and-forget. Don't pin the call count here.
  });

  // ── 5. Oversized body → 413 ──────────────────────────────────────────
  test("payload >4 KiB → 413 PAYLOAD_TOO_LARGE", async () => {
    // Build a JSON body well above 4 KiB. ~5000 chars of 'a' wrapped in
    // a JSON string field guarantees the raw bytes exceed the limit.
    const giantBlob = "a".repeat(5000);
    const oversized = JSON.stringify({
      "csp-report": { "blocked-uri": giantBlob },
    });
    expect(Buffer.byteLength(oversized, "utf8")).toBeGreaterThan(4 * 1024);

    const res = await request(makeApp())
      .post("/api/csp/report")
      .set("Content-Type", "application/csp-report")
      .send(oversized);
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
    });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  // ── 6. No auth required ──────────────────────────────────────────────
  test("anonymous POST works — no Authorization header required", async () => {
    // makeApp() does NOT wire any auth middleware. If the route was
    // accidentally gated by verifyToken (a regression), supertest would
    // see a 401 here. This pin would go red.
    const res = await request(makeApp())
      .post("/api/csp/report")
      .set("Content-Type", "application/csp-report")
      .send(JSON.stringify({ "csp-report": { "violated-directive": "img-src" } }));
    expect(res.status).toBe(204);
    // Sanity — no Authorization header should ever be peeked at.
    // (We can't directly assert "verifyToken not called" because the route
    // itself doesn't import verifyToken, but the 204 here is sufficient
    // evidence — verifyToken would have 401'd.)
  });

  // ── 7. Response body is empty (204 No Content contract) ──────────────
  test("response body is empty + content-length is 0", async () => {
    const res = await request(makeApp())
      .post("/api/csp/report")
      .set("Content-Type", "application/csp-report")
      .send(JSON.stringify({ "csp-report": { "violated-directive": "img-src" } }));
    expect(res.status).toBe(204);
    // supertest exposes res.text as empty string for 204
    expect(res.text).toBe("");
    // And res.body is an empty object/string (depending on supertest
    // version). Either way it must not carry any echoed report content.
    const bodyStr = typeof res.body === "string" ? res.body : JSON.stringify(res.body);
    expect(bodyStr.length === 0 || bodyStr === "{}").toBe(true);
  });

  // ── 8. Persist failure does NOT 500 — fire-and-forget telemetry ──────
  test("prisma.auditLog.create rejecting still yields 204 (fire-and-forget)", async () => {
    prisma.auditLog.create.mockRejectedValue(new Error("db down"));
    const res = await request(makeApp())
      .post("/api/csp/report")
      .set("Content-Type", "application/csp-report")
      .send(JSON.stringify({ "csp-report": { "violated-directive": "img-src" } }));
    expect(res.status).toBe(204);
  });

  // ── 9. plain application/json also accepted ──────────────────────────
  test("plain application/json body → 204 (lenient content-type)", async () => {
    const report = { "csp-report": { "violated-directive": "script-src" } };
    const res = await request(makeApp())
      .post("/api/csp/report")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(report));
    expect(res.status).toBe(204);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
  });
});
