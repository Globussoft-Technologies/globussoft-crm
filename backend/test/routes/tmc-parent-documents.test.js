// TMC parent travel-document API coverage. Parent uploads are stored through
// the private visa document store and every read path is scoped to the portal
// tenant + authenticated parent contact.

import { beforeEach, describe, expect, test, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createRequire } from "node:module";
import prisma from "../../lib/prisma.js";

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || "enterprise_super_secret_key_2026";
const visaDocStore = requireCJS("../../lib/visaDocStore");
const tmcPortalRouter = requireCJS("../../routes/tmc_portal");

prisma.tenant = { ...(prisma.tenant || {}), findUnique: vi.fn() };
prisma.contact = { ...(prisma.contact || {}), findFirst: vi.fn() };
prisma.tmcParentTrip = { ...(prisma.tmcParentTrip || {}), findMany: vi.fn() };
prisma.tripParticipant = { ...(prisma.tripParticipant || {}), findMany: vi.fn() };
prisma.tmcTrip = { ...(prisma.tmcTrip || {}), findMany: vi.fn() };
prisma.tmcParentDocument = {
  ...(prisma.tmcParentDocument || {}),
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
};

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/portal/tmc", tmcPortalRouter);
  return app;
}

function portalToken(overrides = {}) {
  return jwt.sign({ type: "PORTAL", tenantId: 1, contactId: 55, ...overrides }, JWT_SECRET, { expiresIn: "1h" });
}

function parent() {
  return { id: 55, name: "Arijit Singh", email: "arijit@example.com", subBrand: "tmc", portalRole: "PARENT" };
}

function storedDocument(overrides = {}) {
  return {
    id: 11,
    documentType: "passport",
    filename: "passport.pdf",
    fileSize: 4,
    mimeType: "application/pdf",
    status: "in_review",
    notes: null,
    uploadedAt: new Date("2026-08-31T00:00:00.000Z"),
    createdAt: new Date("2026-08-31T00:00:00.000Z"),
    tripId: 7,
    ...overrides,
  };
}

beforeEach(() => {
  prisma.tenant.findUnique.mockReset().mockResolvedValue({ id: 1, vertical: "travel", slug: "tmc" });
  prisma.contact.findFirst.mockReset().mockResolvedValue(parent());
  prisma.tmcParentTrip.findMany.mockReset().mockResolvedValue([{ tripId: 7 }]);
  prisma.tripParticipant.findMany.mockReset().mockResolvedValue([]);
  prisma.tmcTrip.findMany.mockReset().mockResolvedValue([]);
  prisma.tmcParentDocument.findMany.mockReset().mockResolvedValue([]);
  prisma.tmcParentDocument.findFirst.mockReset().mockResolvedValue(null);
  prisma.tmcParentDocument.create.mockReset().mockImplementation(async ({ data }) => ({
    ...storedDocument(),
    ...data,
    id: 11,
  }));
  visaDocStore.storeDoc = vi.fn().mockResolvedValue({
    storage: "disk",
    url: "/api/uploads/visa-docs/parent-document.pdf",
    key: "parent-document.pdf",
  });
  visaDocStore.resolveViewUrl = vi.fn().mockResolvedValue("/api/uploads/visa-docs/parent-document.pdf?t=signed");
  visaDocStore.DEFAULT_VIEW_TTL_SEC = 300;
});

describe("TMC parent travel documents", () => {
  test("lists only the authenticated parent's documents and decorates linked trips", async () => {
    prisma.tmcParentDocument.findMany.mockResolvedValue([storedDocument()]);
    prisma.tmcTrip.findMany.mockResolvedValue([{
      id: 7,
      tripCode: "DARJ-2026",
      destination: "Darjeeling",
      departDate: new Date("2026-11-06T00:00:00.000Z"),
      returnDate: new Date("2026-11-12T00:00:00.000Z"),
    }]);

    const response = await request(makeApp())
      .get("/api/portal/tmc/parent/documents")
      .set("Authorization", `Bearer ${portalToken()}`);

    expect(response.status).toBe(200);
    expect(response.body.documents).toEqual([expect.objectContaining({
      id: 11,
      filename: "passport.pdf",
      trip: expect.objectContaining({ id: 7, destination: "Darjeeling" }),
    })]);
    expect(prisma.tmcParentDocument.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: 1, parentContactId: 55 },
    }));
  });

  test("uploads a supported file only for a trip the parent can access", async () => {
    const response = await request(makeApp())
      .post("/api/portal/tmc/parent/documents")
      .set("Authorization", `Bearer ${portalToken()}`)
      .field("documentType", "consent-form")
      .field("tripId", "7")
      .attach("file", Buffer.from("%PDF-1.7"), { filename: "consent.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(201);
    expect(response.body.document).toMatchObject({ id: 11, documentType: "consent-form", status: "in_review" });
    expect(visaDocStore.storeDoc).toHaveBeenCalledWith(expect.any(Buffer), "application/pdf");
    expect(prisma.tmcParentDocument.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        tenantId: 1,
        parentContactId: 55,
        tripId: 7,
        documentType: "consent-form",
        filename: "consent.pdf",
        status: "in_review",
      }),
    }));
  });

  test("rejects unsupported files and trip ids outside the parent's access", async () => {
    const badType = await request(makeApp())
      .post("/api/portal/tmc/parent/documents")
      .set("Authorization", `Bearer ${portalToken()}`)
      .field("documentType", "passport")
      .attach("file", Buffer.from("text"), { filename: "notes.txt", contentType: "text/plain" });
    expect(badType.status).toBe(400);
    expect(badType.body.code).toBe("UNSUPPORTED_MIME");

    const wrongTrip = await request(makeApp())
      .post("/api/portal/tmc/parent/documents")
      .set("Authorization", `Bearer ${portalToken()}`)
      .field("documentType", "passport")
      .field("tripId", "999")
      .attach("file", Buffer.from("%PDF-1.7"), { filename: "passport.pdf", contentType: "application/pdf" });
    expect(wrongTrip.status).toBe(404);
    expect(wrongTrip.body.code).toBe("TRIP_NOT_FOUND");
    expect(visaDocStore.storeDoc).not.toHaveBeenCalled();
    expect(prisma.tmcParentDocument.create).not.toHaveBeenCalled();
  });

  test("view-url is owner-scoped and resolves a short-lived private link", async () => {
    prisma.tmcParentDocument.findFirst.mockResolvedValue({
      id: 11,
      fileUrl: "/api/uploads/visa-docs/parent-document.pdf",
      storage: "disk",
      storageKey: "parent-document.pdf",
    });

    const response = await request(makeApp())
      .get("/api/portal/tmc/parent/documents/11/view-url")
      .set("Authorization", `Bearer ${portalToken()}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ url: "/api/uploads/visa-docs/parent-document.pdf?t=signed", expiresIn: 300 });
    expect(visaDocStore.resolveViewUrl).toHaveBeenCalledWith({
      attachmentUrl: "/api/uploads/visa-docs/parent-document.pdf",
      attachmentStorage: "disk",
      attachmentKey: "parent-document.pdf",
    });

    prisma.tmcParentDocument.findFirst.mockResolvedValue(null);
    const forbidden = await request(makeApp())
      .get("/api/portal/tmc/parent/documents/11/view-url")
      .set("Authorization", `Bearer ${portalToken({ contactId: 56 })}`);
    expect(forbidden.status).toBe(404);
    expect(forbidden.body.code).toBe("NOT_FOUND");
  });
});
