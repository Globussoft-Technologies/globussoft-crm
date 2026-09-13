import { beforeEach, describe, expect, test, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createRequire } from "node:module";
import prisma from "../../lib/prisma.js";

for (const model of ["user", "userTourProgress", "contact", "lead", "deal", "calendarIntegration", "gmailIntegration", "integration", "customReport", "onboardingEvent", "revokedToken"]) {
  prisma[model] = prisma[model] || {};
}
prisma.user.findFirst = vi.fn();
prisma.user.count = vi.fn();
prisma.userTourProgress.findUnique = vi.fn();
prisma.userTourProgress.upsert = vi.fn();
for (const model of ["contact", "lead", "deal", "calendarIntegration", "gmailIntegration", "integration", "customReport"]) prisma[model].count = vi.fn();
prisma.onboardingEvent.create = vi.fn();
prisma.onboardingEvent.groupBy = vi.fn();
prisma.revokedToken.findUnique = vi.fn();

const requireCJS = createRequire(import.meta.url);
const router = requireCJS("../../routes/onboarding");
const JWT_SECRET = process.env.JWT_SECRET || "enterprise_super_secret_key_2026";

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use("/api/onboarding", router);
  return instance;
}

function token({ userId = 7, tenantId = 3, role = "USER" } = {}) {
  return jwt.sign({ userId, tenantId, role, email: "onboarding@test.local" }, JWT_SECRET, { expiresIn: "1h" });
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.revokedToken.findUnique.mockResolvedValue(null);
  prisma.user.findFirst.mockResolvedValue({ id: 7, role: "USER" });
  prisma.userTourProgress.findUnique.mockResolvedValue(null);
  prisma.userTourProgress.upsert.mockResolvedValue({ id: 1 });
  for (const model of ["contact", "lead", "deal", "user", "calendarIntegration", "gmailIntegration", "integration", "customReport"]) prisma[model].count.mockResolvedValue(0);
  prisma.onboardingEvent.create.mockResolvedValue({ id: 1 });
  prisma.onboardingEvent.groupBy.mockResolvedValue([]);
});

describe("onboarding routes", () => {
  test("requires authentication", async () => {
    expect((await request(app()).get("/api/onboarding/state")).status).toBe(401);
  });

  test("returns role-filtered milestones and persists achievements with tenant scope", async () => {
    prisma.contact.count.mockResolvedValue(1);
    prisma.deal.count.mockResolvedValue(2);
    const response = await request(app()).get("/api/onboarding/state").set("Authorization", `Bearer ${token()}`);
    expect(response.status).toBe(200);
    expect(response.body.checklist.map((item) => item.key)).toEqual([
      "first-contact", "first-lead", "first-deal", "configure-email-calendar",
    ]);
    expect(response.body.completed).toBe(2);
    expect(response.body.completionPercentage).toBe(50);
    expect(prisma.contact.count).toHaveBeenCalledWith({ where: { tenantId: 3 } });
    expect(prisma.userTourProgress.upsert.mock.calls[0][0].where).toEqual({ tenantId_userId: { tenantId: 3, userId: 7 } });
    expect(JSON.parse(prisma.userTourProgress.upsert.mock.calls[0][0].create.checklistJson)["first-contact"].completedAt).toBeTruthy();
  });

  test("admin checklist includes staff and report milestones", async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 7, role: "ADMIN" });
    const response = await request(app()).get("/api/onboarding/state").set("Authorization", `Bearer ${token({ role: "ADMIN" })}`);
    expect(response.body.checklist.map((item) => item.key)).toEqual(expect.arrayContaining(["invite-staff", "first-report"]));
  });

  test("dismisses an announcement permanently on the tenant/user record", async () => {
    prisma.userTourProgress.findUnique.mockResolvedValue({ checklistJson: "{}", dismissedAnnouncementsJson: '["older-release"]' });
    const response = await request(app()).put("/api/onboarding/announcements/3.9.3-guided-onboarding/dismiss").set("Authorization", `Bearer ${token()}`);
    expect(response.status).toBe(200);
    expect(response.body.dismissedAnnouncements).toEqual(["older-release", "3.9.3-guided-onboarding"]);
    const update = prisma.userTourProgress.upsert.mock.calls[0][0].update;
    expect(JSON.parse(update.dismissedAnnouncementsJson)).toEqual(response.body.dismissedAnnouncements);
  });

  test("records only allowlisted analytics metadata and rejects arbitrary data", async () => {
    const accepted = await request(app()).post("/api/onboarding/events").set("Authorization", `Bearer ${token()}`).send({
      eventType: "TOUR_TARGET_MISSING", tourKey: "contacts", stepKey: "step-2", reason: "not-rendered", sessionId: "session-1", crmRecord: { name: "Sensitive" },
    });
    expect(accepted.status).toBe(201);
    expect(prisma.onboardingEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ tenantId: 3, userId: 7, tourKey: "contacts" }) });
    expect(prisma.onboardingEvent.create.mock.calls[0][0].data).not.toHaveProperty("crmRecord");

    const rejected = await request(app()).post("/api/onboarding/events").set("Authorization", `Bearer ${token()}`).send({
      eventType: "TOUR_STARTED", featureKey: "customer@example.com", crmRecord: { name: "Sensitive" },
    });
    expect(rejected.status).toBe(400);
  });

  test("analytics are tenant-scoped and unavailable to ordinary users", async () => {
    const denied = await request(app()).get("/api/onboarding/analytics").set("Authorization", `Bearer ${token()}`);
    expect(denied.status).toBe(403);

    prisma.onboardingEvent.groupBy
      .mockResolvedValueOnce([
        { eventType: "TOUR_STARTED", _count: { _all: 10 } },
        { eventType: "TOUR_COMPLETED", _count: { _all: 6 } },
        { eventType: "TOUR_ABANDONED", _count: { _all: 2 } },
      ])
      .mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    prisma.user.findFirst.mockResolvedValue({ id: 7, role: "MANAGER" });
    const allowed = await request(app()).get("/api/onboarding/analytics").set("Authorization", `Bearer ${token({ role: "MANAGER" })}`);
    expect(allowed.status).toBe(200);
    expect(allowed.body.tours).toMatchObject({ completionRate: 60, abandonmentRate: 20 });
    expect(prisma.onboardingEvent.groupBy.mock.calls.every(([args]) => args.where.tenantId === 3)).toBe(true);
  });
});
