// Travel CRM — Public diagnostic form routes (v3.9.4) tests.
//
// Covers the admin upsert/list/toggle endpoints and the public no-auth
// GET /submit /report endpoints for the branded diagnostic form feature.

import { describe, test, expect, beforeEach, vi, afterAll } from "vitest";
import prisma from "../../lib/prisma.js";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createRequire } from "node:module";

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || "enterprise_super_secret_key_2026";

function tokenFor(role = "ADMIN", { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: "1h" },
  );
}

// Patch Prisma models used by the new route.
prisma.travelDiagnosticPublicForm = {
  ...(prisma.travelDiagnosticPublicForm || {}),
  findMany: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.travelDiagnosticQuestionBank = {
  ...(prisma.travelDiagnosticQuestionBank || {}),
  findFirst: vi.fn(),
};
prisma.travelDiagnostic = {
  ...(prisma.travelDiagnostic || {}),
  create: vi.fn(),
  findFirst: vi.fn(),
};
prisma.travelCurriculumMapping = {
  ...(prisma.travelCurriculumMapping || {}),
  findMany: vi.fn(),
};
prisma.contact = {
  ...(prisma.contact || {}),
  findMany: vi.fn(),
  create: vi.fn(),
};
prisma.user = {
  ...(prisma.user || {}),
  findUnique: vi.fn(),
};
prisma.brandKit = {
  ...(prisma.brandKit || {}),
  findFirst: vi.fn(),
};
prisma.tenant = {
  ...(prisma.tenant || {}),
  findFirst: vi.fn(),
  findUnique: vi.fn(),
};
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);
// Chosen-interests storage (2026-08-27) — zero-migration TenantSetting-backed
// (see diagnosticChosenInterests.js).
prisma.tenantSetting = {
  ...(prisma.tenantSetting || {}),
  findUnique: vi.fn(),
  upsert: vi.fn(),
};

// Stub out RAG + PDF so tests don't need those modules.
const travelRag = requireCJS("../../lib/travelRag");
travelRag.runRagForDiagnostic = vi.fn().mockResolvedValue(null);
travelRag.getRagResultForDiagnostic = vi.fn().mockResolvedValue(null);

const pdfModule = requireCJS("../../lib/travelDiagnosticPdf");
pdfModule.generateDiagnosticPdfBestEffort = vi.fn().mockResolvedValue("/api/uploads/diagnostics/diag-1-abc.pdf");

const dedup = requireCJS("../../utils/deduplication");
dedup.findDuplicateContactFull = vi.fn().mockResolvedValue(null);

// Self-mocked so these tests exercise the ROUTE's plumbing (does it call
// notifyDiagnosticSubmitted with the right args on submit?) without
// depending on diagnosticNotifications.js's own send logic — that's
// covered in test/lib/diagnosticNotifications.test.js.
const diagnosticNotifications = requireCJS("../../lib/diagnosticNotifications");
diagnosticNotifications.notifyDiagnosticSubmitted = vi.fn().mockResolvedValue(undefined);

const router = requireCJS("../../routes/travel_diagnostics_public");

function makeApp() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api/travel", router);
  return app;
}

const sampleQuestions = JSON.stringify({
  questions: [
    {
      id: "q1",
      text: "How many trips per year?",
      type: "single-choice",
      options: [
        { value: "first", label: "First time", weight: 1 },
        { value: "few", label: "2-4", weight: 3 },
      ],
    },
    {
      id: "q2",
      text: "Interests?",
      type: "multi-select",
      options: [
        { value: "beach", label: "Beach", weight: 2 },
        { value: "mountain", label: "Mountain", weight: 3 },
      ],
    },
  ],
});

const tmcQuestions = JSON.stringify({
  questions: [
    {
      id: "curriculum",
      text: "Which curriculum do you follow?",
      type: "single-choice",
      options: [
        { value: "CBSE", label: "CBSE", weight: 0 },
        { value: "IB", label: "IB", weight: 0 },
      ],
    },
    {
      id: "grade",
      text: "Which grade is travelling?",
      type: "single-choice",
      options: [
        { value: "Grade 8", label: "Grade 8", weight: 0 },
        { value: "Grade 9", label: "Grade 9", weight: 0 },
      ],
    },
    {
      id: "subject",
      text: "Primary subject focus",
      type: "single-choice",
      options: [
        { value: "Geography", label: "Geography", weight: 0 },
        { value: "Science", label: "Science", weight: 0 },
      ],
    },
    {
      id: "q1",
      text: "How many trips per year?",
      type: "single-choice",
      options: [
        { value: "first", label: "First time", weight: 1 },
        { value: "few", label: "2-4", weight: 3 },
      ],
    },
  ],
});

const tmcQuestionsWithOpaqueValues = JSON.stringify({
  questions: [
    {
      id: "q9",
      text: "Which curriculum / board do you follow?",
      type: "single-choice",
      options: [
        { value: "opt1", label: "CBSE ", weight: 0 },
        { value: "opt2", label: "ICSE", weight: 0 },
      ],
    },
    {
      id: "q10",
      text: "Grade",
      type: "single-choice",
      options: [
        { value: "opt3", label: "7", weight: 0 },
        { value: "opt4", label: "8", weight: 0 },
      ],
    },
    {
      id: "q11",
      text: "Which subject should this trip support the most?",
      type: "single-choice",
      options: [
        { value: "opt1", label: "Geography ", weight: 0 },
        { value: "opt2", label: "History", weight: 0 },
      ],
    },
    {
      id: "q1",
      text: "How many trips per year?",
      type: "single-choice",
      options: [
        { value: "first", label: "First time", weight: 1 },
        { value: "few", label: "2-4", weight: 3 },
      ],
    },
  ],
});

const sampleScoring = JSON.stringify({
  method: "weighted-sum",
  bands: [
    { minScore: 0, maxScore: 3, classification: "level_1", label: "Starter", recommendedTier: "entry" },
    { minScore: 4, maxScore: 10, classification: "level_2", label: "Regular", recommendedTier: "primary" },
  ],
});

function bankRow(overrides = {}) {
  return {
    id: 10,
    tenantId: 1,
    subBrand: "travelstall",
    version: 1,
    questionsJson: sampleQuestions,
    scoringRulesJson: sampleScoring,
    isActive: true,
    ...overrides,
  };
}

function formRow(overrides = {}) {
  return {
    id: 100,
    tenantId: 1,
    subBrand: "travelstall",
    bankId: 10,
    brandKitId: null,
    isActive: true,
    isPublished: false,
    title: "Travel readiness",
    subtitle: "",
    headerHtml: "",
    footerHtml: "",
    thankYouMessage: "Thanks!",
    primaryColor: "#122647",
    bgColor: "#fbf7f0",
    textColor: "#1c2233",
    fontFamily: "",
    logoUrl: "",
    logoPlacement: "top-center",
    coverImageUrl: "",
    stylingConfigJson: "",
    includeName: true,
    includeEmail: true,
    includePhone: true,
    nameRequired: true,
    emailRequired: true,
    phoneRequired: false,
    publicSlug: null,
    ...overrides,
  };
}

beforeEach(() => {
  travelRag.runRagForDiagnostic.mockClear();
  travelRag.getRagResultForDiagnostic.mockClear();
  pdfModule.generateDiagnosticPdfBestEffort.mockClear();
  prisma.travelDiagnosticPublicForm.findMany.mockReset().mockResolvedValue([formRow()]);
  prisma.travelDiagnosticPublicForm.findUnique.mockReset().mockResolvedValue(null);
  prisma.travelDiagnosticPublicForm.create.mockReset().mockImplementation((args) => ({ id: 100, ...args.data }));
  prisma.travelDiagnosticPublicForm.update.mockReset().mockImplementation((args) => ({ id: args.where.id, ...args.data }));
  prisma.travelDiagnosticQuestionBank.findFirst.mockReset().mockResolvedValue(bankRow());
  prisma.travelDiagnostic.create.mockReset().mockImplementation((args) => ({ id: 555, ...args.data, createdAt: new Date() }));
  prisma.travelCurriculumMapping.findMany.mockReset().mockResolvedValue([]);
  prisma.travelDiagnostic.findFirst.mockReset().mockResolvedValue({
    id: 555,
    tenantId: 1,
    subBrand: "travelstall",
    score: 4,
    classification: "level_2",
    classificationLabel: "Regular",
    recommendedTier: "primary",
    reportPdfUrl: "/api/uploads/diagnostics/diag-555-abc.pdf",
    answersJson: JSON.stringify({ q1: "few", q2: ["mountain"] }),
    curriculumFitJson: null,
    reportSlugToken: "abc123abc123abcd",
    createdAt: new Date(),
  });
  prisma.contact.findMany.mockReset().mockResolvedValue([]);
  prisma.contact.create.mockReset().mockImplementation((args) => ({ id: 900, ...args.data }));
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: "ADMIN", subBrandAccess: null });
  prisma.brandKit.findFirst.mockReset().mockResolvedValue(null);
  prisma.tenant.findFirst.mockReset().mockResolvedValue({ id: 1, slug: "travelstall", name: "Travel Stall" });
  prisma.tenant.findUnique.mockReset().mockResolvedValue({ id: 1, slug: "travelstall", name: "Travel Stall", vertical: "travel" });
  prisma.tenantSetting.findUnique.mockReset().mockResolvedValue(null);
  prisma.tenantSetting.upsert.mockReset().mockResolvedValue({});
  diagnosticNotifications.notifyDiagnosticSubmitted.mockReset().mockResolvedValue(undefined);
});

afterAll(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// Admin endpoints
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/travel/diagnostic-public-forms", () => {
  test("returns list for tenant", async () => {
    const res = await request(makeApp())
      .get("/api/travel/diagnostic-public-forms")
      .set("Authorization", `Bearer ${tokenFor()}`);
    expect(res.status).toBe(200);
    expect(res.body.forms).toHaveLength(1);
    expect(res.body.forms[0].subBrand).toBe("travelstall");
  });
});

describe("POST /api/travel/diagnostic-public-forms", () => {
  test("creates new public form config", async () => {
    const payload = {
      subBrand: "travelstall",
      title: "New form",
      primaryColor: "#ff0000",
      includePhone: false,
    };
    const res = await request(makeApp())
      .post("/api/travel/diagnostic-public-forms")
      .set("Authorization", `Bearer ${tokenFor()}`)
      .send(payload);
    expect(res.status).toBe(201);
    expect(res.body.form.title).toBe("New form");
    expect(res.body.form.primaryColor).toBe("#ff0000");
    expect(res.body.form.includePhone).toBe(false);
  });

  test("rejects missing subBrand", async () => {
    const res = await request(makeApp())
      .post("/api/travel/diagnostic-public-forms")
      .set("Authorization", `Bearer ${tokenFor()}`)
      .send({ title: "x" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("MISSING_SUB_BRAND");
  });
});

describe("POST /api/travel/diagnostic-public-forms/:subBrand/toggle", () => {
  test("publishes existing form", async () => {
    prisma.travelDiagnosticPublicForm.findUnique.mockResolvedValue(formRow({ isPublished: false }));
    const res = await request(makeApp())
      .post("/api/travel/diagnostic-public-forms/travelstall/toggle")
      .set("Authorization", `Bearer ${tokenFor()}`)
      .send();
    expect(res.status).toBe(200);
    expect(res.body.isPublished).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Public endpoints
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/travel/diagnostics/public/form/:tenantSlug/:subBrand", () => {
  test("returns published form + questions", async () => {
    prisma.travelDiagnosticPublicForm.findUnique.mockResolvedValue(formRow({ isPublished: true }));
    const res = await request(makeApp()).get("/api/travel/diagnostics/public/form/travelstall/travelstall");
    expect(res.status).toBe(200);
    expect(res.body.subBrand).toBe("travelstall");
    expect(res.body.questions).toHaveLength(2);
    expect(res.body.form.isPublished).toBe(true);
  });

  test("404 when form is not published", async () => {
    prisma.travelDiagnosticPublicForm.findUnique.mockResolvedValue(formRow({ isPublished: false }));
    const res = await request(makeApp()).get("/api/travel/diagnostics/public/form/travelstall/travelstall");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("FORM_NOT_FOUND");
  });
});

describe("POST /api/travel/diagnostics/public/form/:tenantSlug/:subBrand/submit", () => {
  test("submits public form and returns report slug", async () => {
    prisma.travelDiagnosticPublicForm.findUnique.mockResolvedValue(formRow({ isPublished: true }));
    const payload = {
      answers: { q1: "few", q2: ["mountain"] },
      name: "Yasin",
      email: "yasin@example.com",
      phone: "+919999999999",
    };
    const res = await request(makeApp())
      .post("/api/travel/diagnostics/public/form/travelstall/travelstall/submit")
      .send(payload);
    expect(res.status).toBe(201);
    expect(res.body.score).toBe(6);
    expect(res.body.classification).toBe("level_2");
    expect(res.body.reportSlug).toMatch(/^\d+-[a-f0-9]+$/);
    expect(res.body.reportPdfUrl).toBeTruthy();
  });

  test("fires notifyDiagnosticSubmitted with the submitter's name + score on a successful submit", async () => {
    prisma.travelDiagnosticPublicForm.findUnique.mockResolvedValue(formRow({ isPublished: true }));
    const res = await request(makeApp())
      .post("/api/travel/diagnostics/public/form/travelstall/travelstall/submit")
      .send({
        answers: { q1: "few", q2: ["mountain"] },
        name: "Yasin",
        email: "yasin@example.com",
        phone: "+919999999999",
      });
    expect(res.status).toBe(201);
    expect(diagnosticNotifications.notifyDiagnosticSubmitted).toHaveBeenCalledWith(
      expect.objectContaining({
        subBrand: "travelstall",
        contactLabel: "Yasin",
        score: 6,
        classificationLabel: "Regular",
      }),
    );
  });

  test("a notification failure never blocks the submit response", async () => {
    prisma.travelDiagnosticPublicForm.findUnique.mockResolvedValue(formRow({ isPublished: true }));
    diagnosticNotifications.notifyDiagnosticSubmitted.mockRejectedValue(new Error("boom"));
    const res = await request(makeApp())
      .post("/api/travel/diagnostics/public/form/travelstall/travelstall/submit")
      .send({ answers: { q1: "few", q2: ["mountain"] }, name: "Yasin", email: "yasin@example.com", phone: "+919999999999" });
    expect(res.status).toBe(201);
  });

  test("TMC public form saves curriculum-fit recommendations before PDF generation", async () => {
    prisma.travelDiagnosticPublicForm.findUnique.mockResolvedValue(
      formRow({ subBrand: "tmc", isPublished: true }),
    );
    prisma.travelDiagnosticQuestionBank.findFirst.mockResolvedValue(
      bankRow({ subBrand: "tmc", questionsJson: tmcQuestions }),
    );
    prisma.travelCurriculumMapping.findMany.mockResolvedValue([
      {
        id: 1,
        subject: "Geography",
        destinationId: 77,
        destinationLabel: "Hampi",
        learningOutcome: "Connect terrain, settlement, and heritage.",
        fitRationale: "Strong fieldwork match.",
        fitScore: 92,
      },
    ]);

    const res = await request(makeApp())
      .post("/api/travel/diagnostics/public/form/travelstall/tmc/submit")
      .send({
        answers: {
          curriculum: "CBSE",
          grade: "Grade 8",
          subject: "Geography",
          q1: "few",
        },
        name: "School Lead",
        email: "lead@example.com",
      });

    expect(res.status).toBe(201);
    expect(res.body.curriculumFit).toMatchObject({
      curriculum: "CBSE",
      grade: "Grade 8",
      subject: "Geography",
      recommendations: [{ destination: "Hampi", fitScore: 92 }],
    });
    const createData = prisma.travelDiagnostic.create.mock.calls[0][0].data;
    expect(JSON.parse(createData.curriculumFitJson)).toMatchObject({
      curriculum: "CBSE",
      grade: "Grade 8",
      subject: "Geography",
    });
    expect(pdfModule.generateDiagnosticPdfBestEffort.mock.calls[0][0].curriculumFitJson).toBeTruthy();
  });

  test("TMC public form resolves curriculum-fit from option labels when answers store option ids", async () => {
    prisma.travelDiagnosticPublicForm.findUnique.mockResolvedValue(
      formRow({ subBrand: "tmc", isPublished: true }),
    );
    prisma.travelDiagnosticQuestionBank.findFirst.mockResolvedValue(
      bankRow({ subBrand: "tmc", questionsJson: tmcQuestionsWithOpaqueValues }),
    );
    prisma.travelCurriculumMapping.findMany.mockResolvedValue([
      {
        id: 12,
        subject: "Geography",
        destinationId: null,
        destinationLabel: "Mysore heritage and geography trail",
        learningOutcome: "Students identify links between natural resources, historic settlements, and regional culture.",
        fitRationale: "Good fit for geography with local history and landscape learning.",
        fitScore: 90,
      },
    ]);

    const res = await request(makeApp())
      .post("/api/travel/diagnostics/public/form/travelstall/tmc/submit")
      .send({
        answers: {
          q9: "opt1",
          q10: "opt4",
          q11: "opt1",
          q1: "few",
        },
        name: "School Lead",
        email: "lead@example.com",
      });

    expect(res.status).toBe(201);
    expect(res.body.curriculumFit).toMatchObject({
      curriculum: "CBSE",
      grade: "8",
      subject: "Geography",
      recommendations: [{ destination: "Mysore heritage and geography trail", fitScore: 90 }],
    });
    expect(prisma.travelCurriculumMapping.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          curriculum: "CBSE",
          grade: "8",
          subject: "Geography",
        }),
      }),
    );
    const createData = prisma.travelDiagnostic.create.mock.calls[0][0].data;
    expect(JSON.parse(createData.curriculumFitJson)).toMatchObject({
      curriculum: "CBSE",
      grade: "8",
      subject: "Geography",
    });
  });

  test("curriculum mapping failure does not block public diagnostic submission", async () => {
    prisma.travelDiagnosticPublicForm.findUnique.mockResolvedValue(
      formRow({ subBrand: "tmc", isPublished: true }),
    );
    prisma.travelDiagnosticQuestionBank.findFirst.mockResolvedValue(
      bankRow({ subBrand: "tmc", questionsJson: tmcQuestions }),
    );
    prisma.travelCurriculumMapping.findMany.mockRejectedValue(new Error("mapping unavailable"));

    const res = await request(makeApp())
      .post("/api/travel/diagnostics/public/form/travelstall/tmc/submit")
      .send({
        answers: {
          curriculum: "CBSE",
          grade: "Grade 8",
          q1: "few",
        },
        name: "School Lead",
        email: "lead@example.com",
      });

    expect(res.status).toBe(201);
    expect(res.body.curriculumFit).toBeNull();
    expect(prisma.travelDiagnostic.create.mock.calls[0][0].data.curriculumFitJson).toBeNull();
    expect(res.body.reportSlug).toMatch(/^\d+-[a-f0-9]+$/);
  });

  test("rejects missing required email", async () => {
    prisma.travelDiagnosticPublicForm.findUnique.mockResolvedValue(formRow({ isPublished: true }));
    const payload = { answers: { q1: "few" }, name: "Yasin" };
    const res = await request(makeApp())
      .post("/api/travel/diagnostics/public/form/travelstall/travelstall/submit")
      .send(payload);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("EMAIL_REQUIRED");
  });

  // Per-question required flag (2026-08-24) — admins can mark individual
  // diagnostic questions as required in the builder; the public submit
  // endpoint must reject a submission that skips one, since the client-side
  // check alone can be bypassed by calling this endpoint directly.
  test("rejects submission when a required question is unanswered", async () => {
    const questionsWithRequired = JSON.stringify({
      questions: [
        {
          id: "q1",
          text: "How many trips per year?",
          type: "single-choice",
          required: true,
          options: [
            { value: "first", label: "First time", weight: 1 },
            { value: "few", label: "2-4", weight: 3 },
          ],
        },
        {
          id: "q2",
          text: "Interests?",
          type: "multi-select",
          options: [
            { value: "beach", label: "Beach", weight: 2 },
            { value: "mountain", label: "Mountain", weight: 3 },
          ],
        },
      ],
    });
    prisma.travelDiagnosticPublicForm.findUnique.mockResolvedValue(formRow({ isPublished: true }));
    prisma.travelDiagnosticQuestionBank.findFirst.mockResolvedValue(
      bankRow({ questionsJson: questionsWithRequired }),
    );

    const res = await request(makeApp())
      .post("/api/travel/diagnostics/public/form/travelstall/travelstall/submit")
      .send({ answers: { q2: ["beach"] }, name: "Yasin", email: "yasin@example.com" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("REQUIRED_QUESTION_MISSING");
    expect(res.body.questionId).toBe("q1");
    expect(prisma.travelDiagnostic.create).not.toHaveBeenCalled();
  });

  test("accepts submission once every required question is answered", async () => {
    const questionsWithRequired = JSON.stringify({
      questions: [
        {
          id: "q1",
          text: "How many trips per year?",
          type: "single-choice",
          required: true,
          options: [
            { value: "first", label: "First time", weight: 1 },
            { value: "few", label: "2-4", weight: 3 },
          ],
        },
      ],
    });
    prisma.travelDiagnosticPublicForm.findUnique.mockResolvedValue(formRow({ isPublished: true }));
    prisma.travelDiagnosticQuestionBank.findFirst.mockResolvedValue(
      bankRow({ questionsJson: questionsWithRequired }),
    );

    const res = await request(makeApp())
      .post("/api/travel/diagnostics/public/form/travelstall/travelstall/submit")
      .send({ answers: { q1: "few" }, name: "Yasin", email: "yasin@example.com" });

    expect(res.status).toBe(201);
  });
});

describe("GET /api/travel/diagnostics/public/report/:slug", () => {
  test("returns report payload when the token matches", async () => {
    const res = await request(makeApp()).get(
      "/api/travel/diagnostics/public/report/555-abc123abc123abcd",
    );
    expect(res.status).toBe(200);
    expect(res.body.diagnosticId).toBe(555);
    expect(res.body.classificationLabel).toBe("Regular");
  });

  test("rejects malformed slug", async () => {
    const res = await request(makeApp()).get("/api/travel/diagnostics/public/report/bad-slug");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_SLUG");
  });

  test("rejects a well-formed slug whose token doesn't match the stored one (IDOR guard)", async () => {
    // Same diagnostic id (555) as the row returned by the findFirst mock,
    // but a different 16-hex-char token — this is what an attacker gets by
    // just incrementing the numeric id and guessing any hex suffix.
    const res = await request(makeApp()).get(
      "/api/travel/diagnostics/public/report/555-0000000000000000",
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  test("rejects a slug with no token suffix at all", async () => {
    const res = await request(makeApp()).get("/api/travel/diagnostics/public/report/555");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_SLUG");
  });

  test("includes null chosenInterests when nothing was ever submitted", async () => {
    const res = await request(makeApp()).get(
      "/api/travel/diagnostics/public/report/555-abc123abc123abcd",
    );
    expect(res.status).toBe(200);
    expect(res.body.chosenInterests).toBeNull();
  });

  test("includes a prior chosen-interests submission", async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue({
      value: JSON.stringify({
        interests: [{ name: "Hampi Heritage Trail", driveLink: "https://drive.example/hampi" }],
        submittedAt: "2026-08-27T10:00:00.000Z",
      }),
    });
    const res = await request(makeApp()).get(
      "/api/travel/diagnostics/public/report/555-abc123abc123abcd",
    );
    expect(res.status).toBe(200);
    expect(res.body.chosenInterests).toEqual({
      interests: [{ name: "Hampi Heritage Trail", driveLink: "https://drive.example/hampi" }],
      submittedAt: "2026-08-27T10:00:00.000Z",
    });
  });
});

describe("POST /api/travel/diagnostics/public/report/:slug/interests", () => {
  test("happy: saves the chosen interests and echoes them back", async () => {
    const res = await request(makeApp())
      .post("/api/travel/diagnostics/public/report/555-abc123abc123abcd/interests")
      .send({ interests: [{ name: "Hampi Heritage Trail", driveLink: "https://drive.example/hampi" }] });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.interests).toEqual([{ name: "Hampi Heritage Trail", driveLink: "https://drive.example/hampi" }]);
    expect(prisma.tenantSetting.upsert.mock.calls[0][0]).toMatchObject({
      where: { tenantId_key: { tenantId: 1, key: "travel.diagnostic.interests.555" } },
    });
  });

  test("rejects a well-formed slug whose token doesn't match the stored one (IDOR guard)", async () => {
    const res = await request(makeApp())
      .post("/api/travel/diagnostics/public/report/555-0000000000000000/interests")
      .send({ interests: [{ name: "Hampi Heritage Trail" }] });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
    expect(prisma.tenantSetting.upsert).not.toHaveBeenCalled();
  });

  test("rejects malformed slug", async () => {
    const res = await request(makeApp())
      .post("/api/travel/diagnostics/public/report/bad-slug/interests")
      .send({ interests: [{ name: "x" }] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_SLUG");
  });

  test("400 MISSING_INTERESTS when the array is empty or every name is blank", async () => {
    const res = await request(makeApp())
      .post("/api/travel/diagnostics/public/report/555-abc123abc123abcd/interests")
      .send({ interests: [] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("MISSING_INTERESTS");
  });
});
