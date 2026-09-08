// @ts-check

import { describe, test, expect, beforeEach, vi } from "vitest";
import prisma from "../../lib/prisma.js";
import { createRequire } from "node:module";

const requireCJS = createRequire(import.meta.url);
const curriculumDocuments = requireCJS("../../lib/curriculumDocuments");

prisma.tenantSetting = {
  ...(prisma.tenantSetting || {}),
  findMany: vi.fn(),
  findUnique: vi.fn(),
  upsert: vi.fn(),
  delete: vi.fn(),
};

beforeEach(() => {
  prisma.tenantSetting.findMany.mockReset();
  prisma.tenantSetting.findUnique.mockReset();
  prisma.tenantSetting.upsert.mockReset();
  prisma.tenantSetting.delete.mockReset();
});

describe("curriculumDocuments — generateDocumentId", () => {
  test("generates a 16-char hex id", () => {
    const id = curriculumDocuments.generateDocumentId();
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  test("generates distinct ids across calls", () => {
    const a = curriculumDocuments.generateDocumentId();
    const b = curriculumDocuments.generateDocumentId();
    expect(a).not.toBe(b);
  });
});

describe("curriculumDocuments — saveCurriculumDocument", () => {
  test("upserts by the tenantId+key composite with the document category", async () => {
    prisma.tenantSetting.upsert.mockResolvedValue({});
    const data = { subBrand: "tmc", title: "CBSE Class 9", board: "CBSE" };
    const saved = await curriculumDocuments.saveCurriculumDocument({
      tenantId: 5,
      documentId: "abc123",
      data,
    });

    expect(saved).toMatchObject({ id: "abc123", tenantId: 5, title: "CBSE Class 9" });
    expect(prisma.tenantSetting.upsert).toHaveBeenCalledTimes(1);
    const call = prisma.tenantSetting.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ tenantId_key: { tenantId: 5, key: "travel.curriculum.doc.abc123" } });
    expect(call.create.category).toBe("travel-curriculum-document");
    expect(call.update.category).toBe("travel-curriculum-document");
    expect(JSON.parse(call.create.value)).toMatchObject({ id: "abc123", title: "CBSE Class 9" });
  });
});

describe("curriculumDocuments — getCurriculumDocument", () => {
  test("returns null when no row exists", async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue(null);
    const doc = await curriculumDocuments.getCurriculumDocument({ tenantId: 1, documentId: "missing" });
    expect(doc).toBeNull();
  });

  test("parses the stored JSON value back into a document object", async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue({
      key: "travel.curriculum.doc.xyz",
      value: JSON.stringify({ id: "xyz", title: "ICSE Class 10", status: "indexed" }),
    });
    const doc = await curriculumDocuments.getCurriculumDocument({ tenantId: 1, documentId: "xyz" });
    expect(doc).toMatchObject({ id: "xyz", title: "ICSE Class 10", status: "indexed" });
  });

  test("returns null for a corrupted (non-JSON) row instead of throwing", async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue({ key: "travel.curriculum.doc.bad", value: "not json" });
    const doc = await curriculumDocuments.getCurriculumDocument({ tenantId: 1, documentId: "bad" });
    expect(doc).toBeNull();
  });
});

describe("curriculumDocuments — listCurriculumDocuments", () => {
  test("scopes the query to the document category and tenant", async () => {
    prisma.tenantSetting.findMany.mockResolvedValue([]);
    await curriculumDocuments.listCurriculumDocuments({ tenantId: 9 });
    expect(prisma.tenantSetting.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: 9, category: "travel-curriculum-document" } }),
    );
  });

  test("filters by subBrand client-side when provided", async () => {
    prisma.tenantSetting.findMany.mockResolvedValue([
      { key: "travel.curriculum.doc.a", value: JSON.stringify({ id: "a", subBrand: "tmc" }) },
      { key: "travel.curriculum.doc.b", value: JSON.stringify({ id: "b", subBrand: "rfu" }) },
    ]);
    const docs = await curriculumDocuments.listCurriculumDocuments({ tenantId: 1, subBrand: "tmc" });
    expect(docs).toHaveLength(1);
    expect(docs[0].id).toBe("a");
  });

  test("skips corrupted rows rather than throwing", async () => {
    prisma.tenantSetting.findMany.mockResolvedValue([
      { key: "travel.curriculum.doc.a", value: "not json" },
      { key: "travel.curriculum.doc.b", value: JSON.stringify({ id: "b" }) },
    ]);
    const docs = await curriculumDocuments.listCurriculumDocuments({ tenantId: 1 });
    expect(docs).toHaveLength(1);
    expect(docs[0].id).toBe("b");
  });
});

describe("curriculumDocuments — deleteCurriculumDocument", () => {
  test("returns true on successful delete", async () => {
    prisma.tenantSetting.delete.mockResolvedValue({});
    const ok = await curriculumDocuments.deleteCurriculumDocument({ tenantId: 1, documentId: "abc" });
    expect(ok).toBe(true);
  });

  test("returns false instead of throwing when the row doesn't exist", async () => {
    prisma.tenantSetting.delete.mockRejectedValue(new Error("Record not found"));
    const ok = await curriculumDocuments.deleteCurriculumDocument({ tenantId: 1, documentId: "missing" });
    expect(ok).toBe(false);
  });
});
