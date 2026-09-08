// @ts-check

import { describe, test, expect, beforeEach, vi } from "vitest";
import prisma from "../../lib/prisma.js";
import { createRequire } from "node:module";

const requireCJS = createRequire(import.meta.url);
const {
  buildCurriculumFitForDiagnostic,
  extractLearningProfile,
} = requireCJS("../../lib/travelDiagnosticCurriculumFit");

prisma.travelCurriculumMapping = {
  ...(prisma.travelCurriculumMapping || {}),
  findMany: vi.fn(),
};
prisma.tenantSetting = {
  ...(prisma.tenantSetting || {}),
  findUnique: vi.fn(),
};

beforeEach(() => {
  prisma.travelCurriculumMapping.findMany.mockReset();
  prisma.tenantSetting.findUnique.mockReset().mockResolvedValue(null); // default topK (10)
});

describe("extractLearningProfile", () => {
  test("extracts profile from canonical answer keys", () => {
    expect(
      extractLearningProfile(
        { curriculum: "CBSE", grade: "Grade 8", subject: "Geography" },
        [],
      ),
    ).toEqual({ curriculum: "CBSE", grade: "Grade 8", subject: "Geography", outcomes: null });
  });

  test("extracts profile from question labels when ids are custom", () => {
    expect(
      extractLearningProfile(
        { q1: "IB", q2: "Grade 9", q3: "Science" },
        [
          { id: "q1", text: "School board / curriculum" },
          { id: "q2", text: "Student grade" },
          { id: "q3", text: "Subject focus" },
        ],
      ),
    ).toEqual({ curriculum: "IB", grade: "Grade 9", subject: "Science", outcomes: null });
  });

  test("extracts option labels when submitted answers are option values", () => {
    expect(
      extractLearningProfile(
        { q9: "opt1", q10: "opt4", q11: "opt1" },
        [
          {
            id: "q9",
            text: "Which curriculum / board do you follow?",
            options: [{ value: "opt1", label: "CBSE " }],
          },
          {
            id: "q10",
            text: "Grade",
            options: [{ value: "opt4", label: "8" }],
          },
          {
            id: "q11",
            text: "Which subject should this trip support the most?",
            options: [{ value: "opt1", label: "Geography " }],
          },
        ],
      ),
    ).toEqual({ curriculum: "CBSE", grade: "8", subject: "Geography", outcomes: null });
  });
});

describe("buildCurriculumFitForDiagnostic", () => {
  test("returns ranked curriculum recommendations for TMC", async () => {
    prisma.travelCurriculumMapping.findMany.mockResolvedValue([
      {
        id: 1,
        destinationLabel: "Hampi",
        subject: "Geography",
        learningOutcome: "Terrain and settlement fieldwork",
        fitRationale: "Strong match",
        fitScore: 90,
        brochurePdfUrl: "/api/uploads/travel-curriculum/1/hampi.pdf",
      },
      {
        id: 2,
        destinationLabel: "Hampi",
        subject: "History",
        learningOutcome: "Heritage inquiry",
        fitRationale: "Strong match",
        fitScore: 80,
      },
    ]);

    const fit = await buildCurriculumFitForDiagnostic({
      tenantId: 1,
      subBrand: "tmc",
      answers: { curriculum: "CBSE", grade: "Grade 8", subject: "Geography" },
      questions: [],
    });

    expect(fit).toMatchObject({
      curriculum: "CBSE",
      grade: "Grade 8",
      subject: "Geography",
      recommendations: [{
        destination: "Hampi",
        fitScore: 85,
        mappingIds: [1, 2],
        brochurePdfUrl: "/api/uploads/travel-curriculum/1/hampi.pdf",
      }],
    });
  });

  test("skips non-TMC sub-brands", async () => {
    const fit = await buildCurriculumFitForDiagnostic({
      tenantId: 1,
      subBrand: "travelstall",
      answers: { curriculum: "CBSE", grade: "Grade 8" },
      questions: [],
    });

    expect(fit).toBeNull();
    expect(prisma.travelCurriculumMapping.findMany).not.toHaveBeenCalled();
  });

  test("caps recommendations at the admin-configured topK instead of the hardcoded default", async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue({ value: JSON.stringify({ topK: 3 }) });
    prisma.travelCurriculumMapping.findMany.mockResolvedValue(
      Array.from({ length: 5 }, (_, i) => ({
        id: i + 1,
        destinationLabel: `Destination ${i + 1}`,
        subject: "Geography",
        fitScore: 90 - i,
      })),
    );

    const fit = await buildCurriculumFitForDiagnostic({
      tenantId: 1,
      subBrand: "tmc",
      answers: { curriculum: "CBSE", grade: "Grade 8" },
      questions: [],
    });

    expect(fit.recommendations).toHaveLength(3);
  });

  test("defaults to 10 recommendations when no topK setting is configured", async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue(null);
    prisma.travelCurriculumMapping.findMany.mockResolvedValue(
      Array.from({ length: 15 }, (_, i) => ({
        id: i + 1,
        destinationLabel: `Destination ${i + 1}`,
        subject: "Geography",
        fitScore: 90 - i,
      })),
    );

    const fit = await buildCurriculumFitForDiagnostic({
      tenantId: 1,
      subBrand: "tmc",
      answers: { curriculum: "CBSE", grade: "Grade 8" },
      questions: [],
    });

    expect(fit.recommendations).toHaveLength(10);
  });
});
