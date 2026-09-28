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
prisma.tmcTrip = { ...(prisma.tmcTrip || {}), findMany: vi.fn(), findFirst: vi.fn() };
prisma.tmcConsentTemplate = { ...(prisma.tmcConsentTemplate || {}), findUnique: vi.fn() };
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
  prisma.tmcTrip.findFirst.mockReset().mockResolvedValue({ id: 7, tripType: "international" });
  prisma.tmcConsentTemplate.findUnique.mockReset().mockResolvedValue(null);
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
  visaDocStore.readDocBuffer = vi.fn().mockResolvedValue(Buffer.from("stored document"));
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
      .field("documentType", "passport")
      .field("tripId", "7")
      .attach("file", Buffer.from("%PDF-1.7"), { filename: "passport.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(201);
    expect(response.body.document).toMatchObject({ id: 11, documentType: "passport", status: "in_review" });
    expect(visaDocStore.storeDoc).toHaveBeenCalledWith(expect.any(Buffer), "application/pdf");
    expect(prisma.tmcParentDocument.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        tenantId: 1,
        parentContactId: 55,
        tripId: 7,
        documentType: "passport",
        filename: "passport.pdf",
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

  test("stores a signed consent image in the database and requires a linked trip", async () => {
    const response = await request(makeApp())
      .post("/api/portal/tmc/parent/documents")
      .set("Authorization", `Bearer ${portalToken()}`)
      .field("documentType", "consent-form")
      .field("tripId", "7")
      .attach("file", Buffer.from("png image"), { filename: "signed-consent.png", contentType: "image/png" });

    expect(response.status).toBe(201);
    expect(visaDocStore.storeDoc).not.toHaveBeenCalled();
    expect(prisma.tmcParentDocument.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        documentType: "consent-form",
        storage: "db",
        fileUrl: null,
        fileBlob: expect.any(Buffer),
        mimeType: "image/png",
      }),
    }));

    const missingTrip = await request(makeApp())
      .post("/api/portal/tmc/parent/documents")
      .set("Authorization", `Bearer ${portalToken()}`)
      .field("documentType", "consent-form")
      .attach("file", Buffer.from("png image"), { filename: "signed-consent.png", contentType: "image/png" });
    expect(missingTrip.status).toBe(400);
    expect(missingTrip.body.code).toBe("TRIP_REQUIRED");

    const pdf = await request(makeApp())
      .post("/api/portal/tmc/parent/documents")
      .set("Authorization", `Bearer ${portalToken()}`)
      .field("documentType", "consent-form")
      .field("tripId", "7")
      .attach("file", Buffer.from("%PDF-1.7"), { filename: "signed-consent.pdf", contentType: "application/pdf" });
    expect(pdf.status).toBe(400);
    expect(pdf.body.code).toBe("CONSENT_IMAGE_REQUIRED");
  });

  test("accepts only the four parent document types", async () => {
    const supportedTypes = ["passport", "aadhaar", "visa"];
    for (const documentType of supportedTypes) {
      const response = await request(makeApp())
        .post("/api/portal/tmc/parent/documents")
        .set("Authorization", "Bearer " + portalToken())
        .field("documentType", documentType)
        .field("tripId", "7")
        .attach("file", Buffer.from("%PDF-1.7"), { filename: documentType + ".pdf", contentType: "application/pdf" });

      expect(response.status).toBe(201);
      expect(response.body.document.documentType).toBe(documentType);
    }

    const consent = await request(makeApp())
      .post("/api/portal/tmc/parent/documents")
      .set("Authorization", "Bearer " + portalToken())
      .field("documentType", "consent-form")
      .field("tripId", "7")
      .attach("file", Buffer.from("png image"), { filename: "consent.png", contentType: "image/png" });
    expect(consent.status).toBe(201);
    expect(consent.body.document.documentType).toBe("consent-form");

    const removedType = await request(makeApp())
      .post("/api/portal/tmc/parent/documents")
      .set("Authorization", "Bearer " + portalToken())
      .field("documentType", "school-id")
      .field("tripId", "7")
      .attach("file", Buffer.from("%PDF-1.7"), { filename: "school-id.pdf", contentType: "application/pdf" });

    expect(removedType.status).toBe(400);
    expect(removedType.body.code).toBe("INVALID_DOCUMENT_TYPE");

    const medicalType = await request(makeApp())
      .post("/api/portal/tmc/parent/documents")
      .set("Authorization", "Bearer " + portalToken())
      .field("documentType", "medical-form")
      .field("tripId", "7")
      .attach("file", Buffer.from("%PDF-1.7"), { filename: "medical.pdf", contentType: "application/pdf" });
    expect(medicalType.status).toBe(400);
    expect(medicalType.body.code).toBe("INVALID_DOCUMENT_TYPE");
  });

  test("enforces trip-specific document requirements", async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue({ id: 7, tripType: "domestic" });

    for (const documentType of ["passport", "visa"]) {
      const response = await request(makeApp())
        .post("/api/portal/tmc/parent/documents")
        .set("Authorization", `Bearer ${portalToken()}`)
        .field("documentType", documentType)
        .field("tripId", "7")
        .attach("file", Buffer.from("%PDF-1.7"), { filename: `${documentType}.pdf`, contentType: "application/pdf" });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe("DOCUMENT_NOT_REQUIRED_FOR_TRIP");
    }

    const aadhaar = await request(makeApp())
      .post("/api/portal/tmc/parent/documents")
      .set("Authorization", `Bearer ${portalToken()}`)
      .field("documentType", "aadhaar")
      .field("tripId", "7")
      .attach("file", Buffer.from("%PDF-1.7"), { filename: "aadhaar.pdf", contentType: "application/pdf" });
    expect(aadhaar.status).toBe(201);
  });

  test("loads and streams trip-type-specific consent terms", async () => {
    prisma.tmcParentTrip.findMany.mockResolvedValue([{ tripId: 7 }]);
    prisma.tmcTrip.findFirst.mockResolvedValue({
      id: 7,
      tripCode: "DARJ-2026",
      destination: "Darjeeling",
      tripType: "domestic",
      departDate: new Date("2026-11-06T00:00:00.000Z"),
      returnDate: new Date("2026-11-12T00:00:00.000Z"),
    });
    prisma.tmcConsentTemplate.findUnique.mockResolvedValue({
      id: 31,
      tripType: "domestic",
      filename: "domestic-terms.pdf",
      mimeType: "application/pdf",
      fileSize: 12,
      fileBlob: Buffer.from("%PDF-1.7\nmock consent terms"),
    });
    prisma.tmcParentDocument.findFirst.mockResolvedValue({
      id: 11,
      filename: "signed-consent.png",
      fileSize: 10,
      mimeType: "image/png",
      status: "in_review",
      uploadedAt: new Date("2026-08-31T00:00:00.000Z"),
    });

    const metadata = await request(makeApp())
      .get("/api/portal/tmc/parent/consent-forms/7")
      .set("Authorization", `Bearer ${portalToken()}`);
    expect(metadata.status).toBe(200);
    expect(metadata.body).toMatchObject({
      tripType: "domestic",
      template: { filename: "domestic-terms.pdf", mimeType: "application/pdf" },
      signedDocument: { filename: "signed-consent.png", status: "in_review" },
    });

    const file = await request(makeApp())
      .get("/api/portal/tmc/parent/consent-forms/7/file?download=1")
      .set("Authorization", `Bearer ${portalToken()}`);
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toMatch(/application\/pdf/);
    expect(file.headers["content-disposition"]).toMatch(/attachment/);
    const fileText = file.text || (Buffer.isBuffer(file.body) ? file.body.toString() : "");
    expect(fileText).toContain("%PDF-1.7");
  });

  test("falls back to bundled consent terms when the demo schema/client is behind", async () => {
    prisma.tmcParentTrip.findMany.mockResolvedValue([{ tripId: 7 }]);
    prisma.tmcTrip.findFirst.mockResolvedValue({
      id: 7,
      tripCode: "DARJ-2026",
      destination: "Darjeeling",
      tripType: "domestic",
      departDate: new Date("2026-11-06T00:00:00.000Z"),
      returnDate: new Date("2026-11-12T00:00:00.000Z"),
    });
    prisma.tmcConsentTemplate.findUnique.mockRejectedValue({
      code: "P2021",
      message: "The table `TmcConsentTemplate` does not exist in the current database.",
    });

    const metadata = await request(makeApp())
      .get("/api/portal/tmc/parent/consent-forms/7")
      .set("Authorization", `Bearer ${portalToken()}`);

    expect(metadata.status).toBe(200);
    expect(metadata.body).toMatchObject({
      tripType: "domestic",
      template: {
        filename: "domestic-terms.pdf",
        mimeType: "application/pdf",
      },
    });

    const file = await request(makeApp())
      .get("/api/portal/tmc/parent/consent-forms/7/file")
      .set("Authorization", `Bearer ${portalToken()}`);

    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toMatch(/application\/pdf/);
    const fileBuffer = Buffer.isBuffer(file.body) ? file.body : Buffer.from(file.text || "", "binary");
    expect(fileBuffer.subarray(0, 5).toString()).toBe("%PDF-");
  });

  test("streams an authenticated database-backed parent document", async () => {
    prisma.tmcParentDocument.findFirst.mockResolvedValue({
      id: 11,
      fileBlob: Buffer.from("signed image"),
      fileUrl: null,
      storage: "db",
      storageKey: null,
      mimeType: "image/png",
      filename: "signed-consent.png",
    });

    const response = await request(makeApp())
      .get("/api/portal/tmc/parent/documents/11/file")
      .set("Authorization", `Bearer ${portalToken()}`);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/image\/png/);
    expect(response.body.toString()).toBe("signed image");
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
