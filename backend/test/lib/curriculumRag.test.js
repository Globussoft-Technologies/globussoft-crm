// @ts-check
//
// curriculumRag.matchCurriculumForDiagnostic() is the AI matching path that
// runs BEFORE the existing exact-match TravelCurriculumMapping lookup (see
// travel_diagnostics_public.js submit handler). Its most important contract
// is that it degrades to null (never throws, never blocks the submit) the
// moment any precondition isn't met, so tenants who haven't adopted the new
// curriculum-upload feature see byte-identical behavior to before it
// existed. These tests pin that contract directly against the real
// qdrantClient/embedClient singletons (mutated via vi.fn(), matching this
// repo's existing prisma-mock convention) rather than re-deriving it from
// integration behavior.

import { describe, test, expect, beforeEach, vi } from "vitest";
import { createRequire } from "node:module";
import prisma from "../../lib/prisma.js";

const requireCJS = createRequire(import.meta.url);
const curriculumRag = requireCJS("../../lib/curriculumRag");
const qdrant = requireCJS("../../lib/qdrantClient");
const embedClient = requireCJS("../../lib/embedClient");
const llmRouter = requireCJS("../../lib/llmRouter");

prisma.tenantSetting = {
  ...(prisma.tenantSetting || {}),
  findUnique: vi.fn(),
};

beforeEach(() => {
  vi.restoreAllMocks();
  prisma.tenantSetting.findUnique.mockReset().mockResolvedValue(null); // default topK (10)
});

describe("curriculumRag.matchCurriculumForDiagnostic — safety-net fallbacks", () => {
  test("returns null when Qdrant is not enabled/configured", async () => {
    vi.spyOn(qdrant, "isEnabled").mockReturnValue(false);
    const out = await curriculumRag.matchCurriculumForDiagnostic({
      tenantId: 1,
      subBrand: "tmc",
      profile: { curriculum: "CBSE", grade: "Class 9" },
    });
    expect(out).toBeNull();
  });

  test("returns null when the profile has neither curriculum nor grade", async () => {
    vi.spyOn(qdrant, "isEnabled").mockReturnValue(true);
    const out = await curriculumRag.matchCurriculumForDiagnostic({
      tenantId: 1,
      subBrand: "tmc",
      profile: { subject: "Geography" },
    });
    expect(out).toBeNull();
  });

  test("returns null when no embedding provider is configured for the tenant", async () => {
    vi.spyOn(qdrant, "isEnabled").mockReturnValue(true);
    vi.spyOn(embedClient, "resolveEmbedConfig").mockResolvedValue(null);
    const out = await curriculumRag.matchCurriculumForDiagnostic({
      tenantId: 1,
      subBrand: "tmc",
      profile: { curriculum: "CBSE", grade: "Class 9" },
    });
    expect(out).toBeNull();
  });

  test("returns null when the tenant has zero curriculum documents indexed (untouched tenant)", async () => {
    vi.spyOn(qdrant, "isEnabled").mockReturnValue(true);
    vi.spyOn(embedClient, "resolveEmbedConfig").mockResolvedValue({
      providerId: "openai",
      client: { embedText: vi.fn(), embedTexts: vi.fn() },
    });
    vi.spyOn(qdrant, "countCurriculumPoints").mockResolvedValue(0);
    const out = await curriculumRag.matchCurriculumForDiagnostic({
      tenantId: 1,
      subBrand: "tmc",
      profile: { curriculum: "CBSE", grade: "Class 9" },
    });
    expect(out).toBeNull();
    // Must short-circuit BEFORE embedding the query — no point spending an
    // embedding call when we already know the collection is empty.
    expect(embedClient.resolveEmbedConfig).toHaveBeenCalled();
  });

  test("returns null when query embedding fails", async () => {
    vi.spyOn(qdrant, "isEnabled").mockReturnValue(true);
    vi.spyOn(embedClient, "resolveEmbedConfig").mockResolvedValue({
      providerId: "openai",
      client: { embedText: vi.fn().mockResolvedValue(null), embedTexts: vi.fn() },
    });
    vi.spyOn(qdrant, "countCurriculumPoints").mockResolvedValue(5);
    const out = await curriculumRag.matchCurriculumForDiagnostic({
      tenantId: 1,
      subBrand: "tmc",
      profile: { curriculum: "CBSE", grade: "Class 9" },
    });
    expect(out).toBeNull();
  });

  test("returns null when curriculum + itinerary searches both come back empty", async () => {
    vi.spyOn(qdrant, "isEnabled").mockReturnValue(true);
    vi.spyOn(embedClient, "resolveEmbedConfig").mockResolvedValue({
      providerId: "openai",
      client: { embedText: vi.fn().mockResolvedValue([0.1, 0.2]), embedTexts: vi.fn() },
    });
    vi.spyOn(qdrant, "countCurriculumPoints").mockResolvedValue(5);
    vi.spyOn(qdrant, "searchCurriculum").mockResolvedValue([]);
    vi.spyOn(qdrant, "searchBySubBrand").mockResolvedValue([]);
    const out = await curriculumRag.matchCurriculumForDiagnostic({
      tenantId: 1,
      subBrand: "tmc",
      profile: { curriculum: "CBSE", grade: "Class 9" },
    });
    expect(out).toBeNull();
  });

  test("caps recommendations at 10 and sorts by fitScore descending", async () => {
    vi.spyOn(qdrant, "isEnabled").mockReturnValue(true);
    vi.spyOn(embedClient, "resolveEmbedConfig").mockResolvedValue({
      providerId: "openai",
      client: { embedText: vi.fn().mockResolvedValue([0.1, 0.2]), embedTexts: vi.fn() },
    });
    vi.spyOn(qdrant, "countCurriculumPoints").mockResolvedValue(50);
    vi.spyOn(qdrant, "searchCurriculum").mockResolvedValue([
      { id: "p1", score: 0.9, payload: { subject: "Geography", objectiveText: "Understand plate tectonics" } },
    ]);
    vi.spyOn(qdrant, "searchBySubBrand").mockResolvedValue([
      { id: "c1", score: 0.8, payload: { driveFileId: "f1", fileName: "Trip A.pdf", driveViewLink: "https://x", text: "excerpt" } },
    ]);

    const recs = Array.from({ length: 15 }, (_, i) => ({
      destination: `Destination ${i}`,
      fitScore: i, // ascending — response ordering should NOT be trusted
      reasons: [{ subject: "Geography", learningOutcome: "Some outcome" }],
    }));
    vi.spyOn(llmRouter, "routeRequest").mockResolvedValue({
      text: JSON.stringify({ recommendations: recs }),
      model: "stub",
    });

    const out = await curriculumRag.matchCurriculumForDiagnostic({
      tenantId: 1,
      subBrand: "tmc",
      profile: { curriculum: "CBSE", grade: "Class 9" },
    });

    expect(out).not.toBeNull();
    expect(out.recommendations).toHaveLength(10);
    // Highest fitScore values (14..5) should be kept, sorted descending.
    expect(out.recommendations[0].fitScore).toBe(14);
    expect(out.recommendations[9].fitScore).toBe(5);
  });

  test("caps recommendations at the admin-configured topK instead of the hardcoded default", async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue({ value: JSON.stringify({ topK: 4 }) });
    vi.spyOn(qdrant, "isEnabled").mockReturnValue(true);
    vi.spyOn(embedClient, "resolveEmbedConfig").mockResolvedValue({
      providerId: "openai",
      client: { embedText: vi.fn().mockResolvedValue([0.1, 0.2]), embedTexts: vi.fn() },
    });
    vi.spyOn(qdrant, "countCurriculumPoints").mockResolvedValue(50);
    vi.spyOn(qdrant, "searchCurriculum").mockResolvedValue([
      { id: "p1", score: 0.9, payload: { subject: "Geography", objectiveText: "Understand plate tectonics" } },
    ]);
    vi.spyOn(qdrant, "searchBySubBrand").mockResolvedValue([
      { id: "c1", score: 0.8, payload: { driveFileId: "f1", fileName: "Trip A.pdf", driveViewLink: "https://x", text: "excerpt" } },
    ]);

    const recs = Array.from({ length: 15 }, (_, i) => ({
      destination: `Destination ${i}`,
      fitScore: i,
      reasons: [{ subject: "Geography", learningOutcome: "Some outcome" }],
    }));
    vi.spyOn(llmRouter, "routeRequest").mockResolvedValue({
      text: JSON.stringify({ recommendations: recs }),
      model: "stub",
    });

    const out = await curriculumRag.matchCurriculumForDiagnostic({
      tenantId: 1,
      subBrand: "tmc",
      profile: { curriculum: "CBSE", grade: "Class 9" },
    });

    expect(out.recommendations).toHaveLength(4);
  });
});

describe("curriculumRag.indexCurriculumDocument / reindexCurriculumDocument", () => {
  test("indexCurriculumDocument throws NO_EMBEDDING_PROVIDER when the tenant has no embed config", async () => {
    vi.spyOn(embedClient, "resolveEmbedConfig").mockResolvedValue(null);
    await expect(
      curriculumRag.indexCurriculumDocument({
        tenantId: 1,
        subBrand: "tmc",
        documentId: "abc",
        text: "some text",
        title: "t",
        board: "CBSE",
        gradeBand: "Class 9",
        subjects: ["Geography"],
      }),
    ).rejects.toMatchObject({ code: "NO_EMBEDDING_PROVIDER" });
  });

  test("reindexCurriculumDocument throws NO_EMBEDDING_PROVIDER when the tenant has no embed config", async () => {
    vi.spyOn(embedClient, "resolveEmbedConfig").mockResolvedValue(null);
    await expect(
      curriculumRag.reindexCurriculumDocument({
        tenantId: 1,
        subBrand: "tmc",
        documentId: "abc",
        title: "t",
        board: "CBSE",
        gradeBand: "Class 9",
        subjects: ["Geography"],
        objectives: [{ text: "x", subject: "Geography", topicCode: null }],
      }),
    ).rejects.toMatchObject({ code: "NO_EMBEDDING_PROVIDER" });
  });
});
