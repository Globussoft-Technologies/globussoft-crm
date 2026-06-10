// @ts-check
/**
 * Unit tests for the S94 denorm-hook in POST /api/wellness/visits.
 *
 * What this file pins
 * ───────────────────
 *   1. POST /visits success → prisma.patient.update fires with
 *      `{ where: { id: visit.patientId }, data: { lastVisitDate: visit.visitDate } }`.
 *   2. POST /visits where the denorm-update throws → 201 visit response
 *      still returned (best-effort hook, must not abort the visit insert).
 *   3. Two sequential POSTs for the same patient → each invocation fires
 *      its own denorm-update; the second one writes the newer visitDate.
 *   4. Cross-tenant safety: the hook writes against the visit's patientId
 *      only (which was already tenant-scoped on the visit-create's WHERE).
 *      Asserted by inspecting the update call's WHERE id payload — never
 *      a cross-tenant patient.
 *
 * Pattern mirrors backend/test/routes/wellness-loyalty-rules.test.js — patch
 * the prisma singleton BEFORE require()-ing the router so module-eval
 * resolves to the mocked surface, mount the router under a tiny Express
 * app, inject `req.user` via synthetic middleware.
 *
 * Why these 4 cases (and not more):
 *   - The visit-create handler is a many-branch beast (already covered by
 *     other tests + e2e specs). This file pins ONLY the S94 hook's contract,
 *     so the hook can be refactored / migrated to a Prisma `$transaction`
 *     wrapper / extracted to a service helper without breaking other
 *     unrelated specs.
 *   - The "denorm-update failure → visit still created" branch is the
 *     load-bearing safety property — without it, a single Patient row
 *     write failure would corrupt every clinic's POST /visits flow.
 */

import { describe, test, expect, beforeEach, vi } from "vitest";
import prisma from "../../lib/prisma.js";

// ── Prisma surface required by routes/wellness.js at require-time. ──
// Only the surfaces touched by POST /visits + module-eval need real spies.
prisma.visit = prisma.visit || {};
prisma.visit.create = vi.fn();
prisma.visit.findFirst = prisma.visit.findFirst || vi.fn();
prisma.visit.findMany = prisma.visit.findMany || vi.fn();
prisma.visit.findUnique = prisma.visit.findUnique || vi.fn();
prisma.visit.update = prisma.visit.update || vi.fn();

prisma.patient = prisma.patient || {};
prisma.patient.update = vi.fn();
prisma.patient.findUnique = prisma.patient.findUnique || vi.fn();
prisma.patient.findFirst = prisma.patient.findFirst || vi.fn();
prisma.patient.findMany = prisma.patient.findMany || vi.fn();

prisma.treatmentPlan = prisma.treatmentPlan || {};
prisma.treatmentPlan.update = prisma.treatmentPlan.update || vi.fn();

prisma.loyaltyConfig = prisma.loyaltyConfig || {
  findUnique: vi.fn(),
  upsert: vi.fn(),
};
prisma.loyaltyTransaction = prisma.loyaltyTransaction || {
  findFirst: vi.fn(),
  aggregate: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
};
prisma.referral = prisma.referral || { findMany: vi.fn(), count: vi.fn() };
prisma.auditLog = { create: vi.fn().mockResolvedValue({ id: 1 }) };
prisma.tenant = prisma.tenant || {
  findUnique: vi.fn(),
  findMany: vi.fn(),
};
// assertVisitSlotAvailable (the 4-class booking conflict gate) hits these
// three model methods. Empty defaults → no conflict reported, so the create
// path runs.
prisma.holiday = { findMany: vi.fn().mockResolvedValue([]) };
prisma.workingHours = { findMany: vi.fn().mockResolvedValue([]) };
prisma.visit.findFirst = vi.fn().mockResolvedValue(null);
// AutomationRule + Webhook are touched by the eventBus emit tail.
prisma.automationRule = { findMany: vi.fn().mockResolvedValue([]) };
prisma.webhook = { findMany: vi.fn().mockResolvedValue([]) };

import express from "express";
import request from "supertest";
import { createRequire } from "node:module";
const requireCJS = createRequire(import.meta.url);
const wellnessRouter = requireCJS("../../routes/wellness");

function makeApp({
  tenantId = 1,
  userId = 7,
  role = "ADMIN",
  wellnessRole = "doctor",
  vertical = "wellness",
} = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role, wellnessRole, vertical };
    next();
  });
  app.use("/api/wellness", wellnessRouter);
  return app;
}

beforeEach(() => {
  prisma.visit.create.mockReset();
  prisma.patient.update.mockReset();
  // Default: create succeeds with a representative row.
  prisma.visit.create.mockResolvedValue({
    id: 1001,
    patientId: 42,
    serviceId: 10,
    doctorId: 5,
    visitDate: new Date("2026-06-10T11:00:00Z"),
    status: "completed",
    amountCharged: 1500,
    tenantId: 1,
  });
  prisma.patient.update.mockResolvedValue({ id: 42 });
});

describe("POST /api/wellness/visits — S94 denorm-hook", () => {
  test("success path → prisma.patient.update fires with lastVisitDate from the just-created visit", async () => {
    const visitDate = new Date("2026-06-10T11:00:00Z");
    prisma.visit.create.mockResolvedValueOnce({
      id: 1001,
      patientId: 42,
      visitDate,
      status: "completed",
      tenantId: 1,
    });

    const res = await request(makeApp()).post("/api/wellness/visits").send({
      patientId: 42,
      serviceId: 10,
      doctorId: 5,
      visitDate: "2026-06-10T11:00:00Z",
      status: "completed",
    });

    expect(res.status).toBe(201);
    // The hook must have fired with the just-created visit's patientId + visitDate.
    expect(prisma.patient.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { lastVisitDate: visitDate },
    });
  });

  test("denorm-update throwing → visit insert response still returns 201 (best-effort hook)", async () => {
    prisma.patient.update.mockRejectedValueOnce(
      new Error("simulated denorm failure"),
    );

    const res = await request(makeApp()).post("/api/wellness/visits").send({
      patientId: 42,
      serviceId: 10,
      doctorId: 5,
      visitDate: "2026-06-10T11:00:00Z",
      status: "completed",
    });

    // The load-bearing assertion: a denorm-update DB error MUST NOT bubble
    // up and 500 the visit insert. Visit row exists; cache reconciles on
    // next backfill tick or next visit POST.
    expect(res.status).toBe(201);
    expect(prisma.visit.create).toHaveBeenCalledTimes(1);
    expect(prisma.patient.update).toHaveBeenCalledTimes(1);
  });

  test("two sequential POSTs for the same patient → each fires its own denorm-update with that POST's visitDate", async () => {
    const visit1Date = new Date("2026-06-01T09:00:00Z");
    const visit2Date = new Date("2026-06-10T15:00:00Z");
    prisma.visit.create
      .mockResolvedValueOnce({
        id: 2001,
        patientId: 77,
        visitDate: visit1Date,
        status: "completed",
        tenantId: 1,
      })
      .mockResolvedValueOnce({
        id: 2002,
        patientId: 77,
        visitDate: visit2Date,
        status: "completed",
        tenantId: 1,
      });

    const app = makeApp();
    await request(app).post("/api/wellness/visits").send({
      patientId: 77,
      serviceId: 10,
      doctorId: 5,
      visitDate: "2026-06-01T09:00:00Z",
      status: "completed",
    });
    await request(app).post("/api/wellness/visits").send({
      patientId: 77,
      serviceId: 10,
      doctorId: 5,
      visitDate: "2026-06-10T15:00:00Z",
      status: "completed",
    });

    expect(prisma.patient.update).toHaveBeenCalledTimes(2);
    expect(prisma.patient.update).toHaveBeenNthCalledWith(1, {
      where: { id: 77 },
      data: { lastVisitDate: visit1Date },
    });
    // Second call carries the NEWER visitDate — pinning that the hook
    // writes from the just-created visit's row, not from any cached value.
    expect(prisma.patient.update).toHaveBeenNthCalledWith(2, {
      where: { id: 77 },
      data: { lastVisitDate: visit2Date },
    });
  });

  test("denorm-hook targets the visit's patientId only (no cross-tenant leak)", async () => {
    const visitDate = new Date("2026-06-10T08:00:00Z");
    // Tenant 1 creates a visit for THEIR patientId=99. Hook MUST write to
    // patientId=99 — never to a patient outside this tenant. The route's
    // visit-create already tenant-scopes via req.user.tenantId in the create
    // data; we're pinning that the hook just relays the patientId from the
    // returned visit (which carries the safe tenant-scope).
    prisma.visit.create.mockResolvedValueOnce({
      id: 3001,
      patientId: 99,
      visitDate,
      status: "completed",
      tenantId: 1,
    });

    await request(makeApp({ tenantId: 1 }))
      .post("/api/wellness/visits")
      .send({
        patientId: 99,
        serviceId: 10,
        doctorId: 5,
        visitDate: "2026-06-10T08:00:00Z",
        status: "completed",
      });

    // The where.id MUST equal exactly the just-created visit's patientId.
    // No fabricated id, no cross-tenant injection vector.
    expect(prisma.patient.update).toHaveBeenCalledWith({
      where: { id: 99 },
      data: { lastVisitDate: visitDate },
    });
  });
});
