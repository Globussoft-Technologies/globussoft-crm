// @ts-check
// Public diagnostic-page embed resolver tests.

import { describe, test, expect, beforeEach, vi, afterAll } from "vitest";
import prisma from "../../lib/prisma.js";
import express from "express";
import request from "supertest";
import { createRequire } from "node:module";

const requireCJS = createRequire(import.meta.url);

prisma.travelDiagnosticPublicForm = {
  ...(prisma.travelDiagnosticPublicForm || {}),
  findFirst: vi.fn(),
};
prisma.travelDiagnosticQuestionBank = {
  ...(prisma.travelDiagnosticQuestionBank || {}),
  findFirst: vi.fn(),
};
prisma.brandKit = {
  ...(prisma.brandKit || {}),
  findFirst: vi.fn(),
};
prisma.tenant = {
  ...(prisma.tenant || {}),
  findFirst: vi.fn(),
};

const router = requireCJS("../../routes/diagnostic_pages_public");

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/diagnostic-pages", router);
  return app;
}

const questionsJson = JSON.stringify({
  questions: [
    {
      id: "curriculum",
      text: "Which curriculum do you follow?",
      type: "single-choice",
      options: [
        { value: "CBSE", label: "CBSE", weight: 1 },
        { value: "IB", label: "IB", weight: 1 },
      ],
    },
  ],
});

function formRow(overrides = {}) {
  return {
    id: 100,
    tenantId: 1,
    tenant: {
      id: 1,
      slug: "travelstall",
      name: "Travel Stall",
      vertical: "travel",
      isActive: true,
    },
    subBrand: "tmc",
    bankId: 10,
    brandKitId: 5,
    isPublished: true,
    title: "TMC readiness",
    subtitle: "School travel diagnostic",
    headerHtml: "",
    footerHtml: "",
    thankYouMessage: "Thanks",
    primaryColor: "#0a68ff",
    bgColor: "#faf6ee",
    textColor: "#1f1b14",
    fontFamily: "",
    logoUrl: "",
    logoPlacement: "top-center",
    coverImageUrl: "",
    stylingConfigJson: JSON.stringify({ formMaxWidth: 760, logoSize: 96 }),
    includeName: true,
    includeEmail: true,
    includePhone: true,
    nameRequired: true,
    emailRequired: true,
    phoneRequired: false,
    updatedAt: new Date("2026-08-18T10:00:00Z"),
    ...overrides,
  };
}

function bankRow(overrides = {}) {
  return {
    id: 10,
    tenantId: 1,
    subBrand: "tmc",
    version: 3,
    questionsJson,
    isActive: true,
    ...overrides,
  };
}

beforeEach(() => {
  prisma.travelDiagnosticPublicForm.findFirst.mockReset().mockResolvedValue(formRow());
  prisma.travelDiagnosticQuestionBank.findFirst.mockReset().mockResolvedValue(bankRow());
  prisma.brandKit.findFirst.mockReset().mockResolvedValue({
    id: 5,
    logoUrl: "https://cdn.example/logo.png",
    primaryColor: "#0a68ff",
    bgColor: "#faf6ee",
    textColor: "#1f1b14",
  });
  prisma.tenant.findFirst.mockReset().mockResolvedValue({ id: 1 });
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe("GET /api/diagnostic-pages/public/featured-full", () => {
  test("returns the published diagnostic page payload by subBrand", async () => {
    const res = await request(makeApp()).get(
      "/api/diagnostic-pages/public/featured-full?subBrand=tmc&tenantSlug=travelstall",
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: 100,
      tenantSlug: "travelstall",
      tenantName: "Travel Stall",
      subBrand: "tmc",
      bankId: 10,
      version: 3,
      status: "PUBLISHED",
      publicUrl: "/diagnostic-form/travelstall/tmc",
      submitUrl: "/api/travel/diagnostics/public/form/travelstall/tmc/submit",
      form: {
        title: "TMC readiness",
        styling: { formMaxWidth: 760, logoSize: 96 },
      },
      questions: [{ id: "curriculum", text: "Which curriculum do you follow?" }],
    });
    expect(res.body.brandKit).toMatchObject({ id: 5, primaryColor: "#0a68ff" });
    expect(prisma.tenant.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { slug: "travelstall", vertical: "travel", isActive: true },
      }),
    );
    expect(prisma.travelDiagnosticPublicForm.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 1,
          subBrand: "tmc",
          isPublished: true,
        }),
      }),
    );
  });

  test("404 when no diagnostic page is published", async () => {
    prisma.travelDiagnosticPublicForm.findFirst.mockResolvedValue(null);

    const res = await request(makeApp()).get(
      "/api/diagnostic-pages/public/featured-full?subBrand=tmc",
    );

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NO_DIAGNOSTIC_PAGE_PUBLISHED");
  });

  test("500 when published styling JSON is malformed", async () => {
    prisma.travelDiagnosticPublicForm.findFirst.mockResolvedValue(
      formRow({ stylingConfigJson: "{bad json" }),
    );

    const res = await request(makeApp()).get(
      "/api/diagnostic-pages/public/featured-full?subBrand=tmc",
    );

    expect(res.status).toBe(500);
    expect(res.body.code).toBe("DIAGNOSTIC_PAGE_MALFORMED");
  });

  test("500 when active bank questions JSON is malformed", async () => {
    prisma.travelDiagnosticQuestionBank.findFirst.mockResolvedValue(
      bankRow({ questionsJson: "{bad json" }),
    );

    const res = await request(makeApp()).get(
      "/api/diagnostic-pages/public/featured-full?subBrand=tmc",
    );

    expect(res.status).toBe(500);
    expect(res.body.code).toBe("BANK_CORRUPTED");
  });
});

describe("GET /api/diagnostic-pages/public/by-id/:id", () => {
  test("returns the exact published diagnostic page payload", async () => {
    const res = await request(makeApp()).get("/api/diagnostic-pages/public/by-id/100");

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(100);
    expect(res.body.publicUrl).toBe("/diagnostic-form/travelstall/tmc");
    expect(prisma.travelDiagnosticPublicForm.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 100, isPublished: true },
      }),
    );
  });

  test("400 for invalid id", async () => {
    const res = await request(makeApp()).get("/api/diagnostic-pages/public/by-id/nope");

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_PAGE_ID");
  });
});
