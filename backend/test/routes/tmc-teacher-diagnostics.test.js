/**
 * TMC teacher diagnostic coverage.
 *
 * Teachers use the dedicated authenticated TMC engine surface. These tests
 * pin that the route does not fall back to the public-form endpoints and that
 * trip interests remain scoped to the logged-in teacher.
 */

import { describe, test, expect, beforeEach, vi } from "vitest";
import prisma from "../../lib/prisma.js";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createRequire } from "node:module";

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || "enterprise_super_secret_key_2026";

prisma.tenant = { ...(prisma.tenant || {}), findUnique: vi.fn() };
prisma.contact = { ...(prisma.contact || {}), findFirst: vi.fn() };
prisma.user = { ...(prisma.user || {}), findMany: vi.fn() };
prisma.tenantSetting = { ...(prisma.tenantSetting || {}), findUnique: vi.fn(), upsert: vi.fn() };
prisma.travelDiagnosticQuestionBank = { ...(prisma.travelDiagnosticQuestionBank || {}), findFirst: vi.fn() };
prisma.travelDiagnostic = { ...(prisma.travelDiagnostic || {}), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() };
prisma.travelDiagnosticRagResult = { ...(prisma.travelDiagnosticRagResult || {}), findUnique: vi.fn() };
prisma.tmcTripCatalogue = { ...(prisma.tmcTripCatalogue || {}), findMany: vi.fn() };
prisma.engineWeights = { ...(prisma.engineWeights || {}), findUnique: vi.fn() };
prisma.travelCurriculumMapping = { ...(prisma.travelCurriculumMapping || {}), findMany: vi.fn() };

const tmcPortalRouter = requireCJS("../../routes/tmc_portal");

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/portal/tmc", tmcPortalRouter);
  return app;
}

function portalToken() {
  return jwt.sign({ type: "PORTAL", tenantId: 1, contactId: 55 }, JWT_SECRET, { expiresIn: "1h" });
}

const bank = {
  id: 8,
  version: 1,
  questionsJson: JSON.stringify({
    questions: [
      {
        id: "q1",
        field: "primary_outcome",
        text: "What outcome matters most?",
        type: "single-choice",
        required: true,
        options: [{ value: "curiosity", label: "Curiosity" }],
      },
      {
        id: "q2",
        field: "secondary_skills",
        text: "Which skills?",
        type: "multi-select",
        required: true,
        minSelections: 2,
        maxSelections: 2,
        options: [
          { value: "Empathy", label: "Empathy" },
          { value: "Mindfulness", label: "Mindfulness" },
        ],
      },
      {
        id: "q5",
        field: "grade_band",
        text: "Which grades?",
        type: "single-choice",
        options: [{ value: "6-8", label: "Grades 6-8" }],
      },
      {
        id: "q6",
        field: "curriculum",
        text: "Which curriculum?",
        type: "single-choice",
        options: [{ value: "CBSE", label: "CBSE" }],
      },
      {
        id: "q8",
        field: "geo_preference",
        text: "Where would you like to travel?",
        type: "single-choice",
        options: [{ value: "domestic", label: "Domestic" }],
      },
      {
        id: "q9",
        field: "budget_band",
        text: "What is your budget?",
        type: "single-choice",
        options: [{ value: "30k-75k", label: "30k-75k" }],
      },
      {
        id: "q12",
        field: "contact",
        text: "Where should we send your profile?",
        type: "group",
        fields: [
          { id: "contact_name", label: "Your name", type: "text", required: true },
          { id: "email", label: "Email", type: "email", required: true },
        ],
      },
    ],
  }),
};

const catalogueTrip = {
  id: 31,
  tripId: "golden-triangle-delhi-agra-jaipur",
  title: "Golden Triangle (Delhi - Agra - Jaipur)",
  tagline: "A structured heritage learning route.",
  tier: "domestic",
  minGradeBand: "6-8",
  maxGradeBand: "11-12",
  minGroupSize: 25,
  priceBand: "30k-75k",
  boardsSupportedJson: JSON.stringify(["CBSE"]),
  primaryOutcomesJson: JSON.stringify(["curiosity"]),
  skillsDevelopedJson: JSON.stringify(["Empathy", "Mindfulness"]),
  curriculumHooksJson: JSON.stringify([]),
  anchorExperiencesJson: JSON.stringify([{ name: "Heritage workshop", what_students_do: "Observe and document historic sites." }]),
};

beforeEach(() => {
  prisma.tenant.findUnique.mockReset().mockResolvedValue({ id: 1, vertical: "travel", slug: "tmc" });
  prisma.contact.findFirst.mockReset().mockResolvedValue({ id: 55, name: "Asha Teacher", email: "asha@example.com", phone: null, subBrand: "tmc", portalRole: "TEACHER" });
  prisma.travelDiagnosticQuestionBank.findFirst.mockReset().mockResolvedValue(bank);
  prisma.travelDiagnostic.findFirst.mockReset().mockResolvedValue({ id: 42, tenantId: 1, contactId: 55, subBrand: "tmc", engineState: "strong_match", createdAt: new Date("2026-09-11T00:00:00.000Z"), engineScoresJson: JSON.stringify({ survivors: [{ trip: catalogueTrip }] }), curriculumFitJson: "[]", reportPdfUrl: null });
  prisma.travelDiagnostic.findMany.mockReset().mockResolvedValue([]);
  prisma.travelDiagnosticRagResult.findUnique.mockReset().mockResolvedValue(null);
  prisma.travelDiagnostic.create.mockReset().mockResolvedValue({ id: 42, createdAt: new Date("2026-09-11T00:00:00.000Z") });
  prisma.user.findMany.mockReset().mockResolvedValue([]);
  prisma.tenantSetting.findUnique.mockReset().mockResolvedValue(null);
  prisma.tenantSetting.upsert.mockReset().mockResolvedValue({});
  prisma.tmcTripCatalogue.findMany.mockReset().mockResolvedValue([catalogueTrip]);
  prisma.engineWeights.findUnique.mockReset().mockResolvedValue(null);
  prisma.travelCurriculumMapping.findMany.mockReset().mockResolvedValue([]);
});

describe("TMC teacher diagnostic flow", () => {
  test("loads the TMC bank through the authenticated teacher endpoint", async () => {
    const response = await request(makeApp())
      .get("/api/portal/tmc/teacher/diagnostic")
      .set("Authorization", `Bearer ${portalToken()}`);

    expect(response.status).toBe(200);
    expect(response.body.questions).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "primary_outcome", type: "single" }),
      expect.objectContaining({ field: "secondary_skills", type: "multi", max: 2 }),
      expect.objectContaining({ field: "contact", type: "group" }),
    ]));
    expect(response.body).not.toHaveProperty("publicUrl");
  });

  test("submits through the TMC engine and returns native trip choices", async () => {
    const response = await request(makeApp())
      .post("/api/portal/tmc/teacher/diagnostics")
      .set("Authorization", `Bearer ${portalToken()}`)
      .send({
        answers: {
          primary_outcome: "curiosity",
          secondary_skills: ["Empathy", "Mindfulness"],
          grade_band: "6-8",
          curriculum: ["CBSE"],
          geo_preference: "domestic",
          budget_band: "30k-75k",
          contact: { contact_name: "Asha Teacher", email: "asha@example.com" },
        },
      });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      diagnosticId: 42,
      classificationLabel: "Routed by TMC Engine",
      recommendedTier: "engine",
      reportPdfUrl: "/api/travel/diagnostics/42/readiness-report.pdf",
    });
    expect(response.body.recommendations[0]).toMatchObject({ name: catalogueTrip.title, category: "domestic" });
    expect(prisma.travelDiagnostic.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ tenantId: 1, contactId: 55, source: "tmc_teacher_portal" }),
    }));
  });

  test("enforces the active bank's required selection rules", async () => {
    const response = await request(makeApp())
      .post("/api/portal/tmc/teacher/diagnostics")
      .set("Authorization", `Bearer ${portalToken()}`)
      .send({
        answers: {
          primary_outcome: "curiosity",
          secondary_skills: ["Empathy"],
          contact: { contact_name: "Asha Teacher", email: "asha@example.com" },
        },
      });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: "MIN_SELECTIONS", questionId: "q2" });
    expect(prisma.travelDiagnostic.create).not.toHaveBeenCalled();
  });

  test("does not invent required fields or selection limits absent from the active bank", async () => {
    const parsed = JSON.parse(bank.questionsJson);
    parsed.questions = parsed.questions.map((question) => {
      if (question.field === "secondary_skills") {
        const optionalQuestion = { ...question, required: false };
        delete optionalQuestion.minSelections;
        delete optionalQuestion.maxSelections;
        return optionalQuestion;
      }
      if (question.field === "contact") {
        return { ...question, required: false, fields: question.fields.map((field) => ({ ...field, required: false })) };
      }
      return { ...question, required: false };
    });
    prisma.travelDiagnosticQuestionBank.findFirst.mockResolvedValueOnce({
      ...bank,
      questionsJson: JSON.stringify(parsed),
    });
    prisma.contact.findFirst.mockResolvedValueOnce({ id: 55, name: "Asha Teacher", email: null, phone: null, subBrand: "tmc", portalRole: "TEACHER" });

    const response = await request(makeApp())
      .post("/api/portal/tmc/teacher/diagnostics")
      .set("Authorization", `Bearer ${portalToken()}`)
      .send({ answers: { primary_outcome: "curiosity", contact: { contact_name: "Asha Teacher" } } });

    expect(response.status).toBe(201);
    expect(JSON.parse(prisma.travelDiagnostic.create.mock.calls[0][0].data.answersJson)).toMatchObject({
      primary_outcome: "curiosity",
      contact: { contact_name: "Asha Teacher" },
    });
    expect(JSON.parse(prisma.travelDiagnostic.create.mock.calls[0][0].data.answersJson).contact).not.toHaveProperty("email");
  });

  test("loads a previous report in the authenticated native trip picker", async () => {
    const response = await request(makeApp())
      .get("/api/portal/tmc/teacher/diagnostics/42")
      .set("Authorization", `Bearer ${portalToken()}`);

    expect(response.status).toBe(200);
    expect(response.body.diagnostic).toMatchObject({
      id: 42,
      classificationLabel: "Routed by TMC Engine",
      reportPdfUrl: "/api/travel/diagnostics/42/readiness-report.pdf",
    });
    expect(response.body.diagnostic.recommendations[0]).toMatchObject({ name: catalogueTrip.title });
    expect(prisma.travelDiagnostic.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 42, tenantId: 1, contactId: 55, subBrand: "tmc" },
    }));
  });

  test("saves chosen trips only for the authenticated teacher's report", async () => {
    const response = await request(makeApp())
      .post("/api/portal/tmc/teacher/diagnostics/42/interests")
      .set("Authorization", `Bearer ${portalToken()}`)
      .send({ interests: [{ name: catalogueTrip.title }] });

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(prisma.travelDiagnostic.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 42, tenantId: 1, contactId: 55, subBrand: "tmc" },
    }));
  });
});
