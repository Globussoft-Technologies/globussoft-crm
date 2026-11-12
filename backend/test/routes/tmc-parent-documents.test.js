// TMC parent travel-document API coverage. Parent uploads are stored through
// the private document store and every read path is scoped to the portal
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
prisma.tripParticipant = { ...(prisma.tripParticipant || {}), findMany: vi.fn(), updateMany: vi.fn() };
prisma.tmcTrip = { ...(prisma.tmcTrip || {}), findMany: vi.fn(), findFirst: vi.fn() };
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
    documentType: "Travel insurance certificate",
    documentRequirementId: 101,
    filename: "insurance.pdf",
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
  prisma.tripParticipant.updateMany.mockReset().mockResolvedValue({ count: 0 });
  prisma.tmcTrip.findMany.mockReset().mockResolvedValue([]);
  prisma.tmcTrip.findFirst.mockReset().mockResolvedValue({
    id: 7,
    tripType: "international",
    documentRequirements: [
      { id: 101, tripId: 7, docType: "Travel insurance certificate", acceptedFileTypes: ["pdf", "jpg", "png"], required: true },
      { id: 102, tripId: 7, docType: "School medical clearance", acceptedFileTypes: ["pdf", "docx"], required: true },
    ],
  });
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
  visaDocStore.readDocBuffer = vi.fn().mockResolvedValue(Buffer.from("stored document"));
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
      documentRequirements: [
        { id: 101, tripId: 7, docType: "Travel insurance certificate", acceptedFileTypes: JSON.stringify(["pdf", "jpg"]), required: true },
        { id: 102, tripId: 7, docType: "School medical clearance", acceptedFileTypes: JSON.stringify(["pdf", "docx"]), required: true },
      ],
    }]);

    const response = await request(makeApp())
      .get("/api/portal/tmc/parent/documents")
      .set("Authorization", `Bearer ${portalToken()}`);

    expect(response.status).toBe(200);
    expect(response.body.documents).toEqual([expect.objectContaining({
      id: 11,
      filename: "insurance.pdf",
      trip: expect.objectContaining({ id: 7, destination: "Darjeeling" }),
    })]);
    expect(response.body.documentRequirements).toEqual([
      expect.objectContaining({ id: 101, tripId: 7, docType: "Travel insurance certificate", acceptedFileTypes: ["pdf", "jpg"] }),
      expect.objectContaining({ id: 102, tripId: 7, docType: "School medical clearance", acceptedFileTypes: ["pdf", "docx"] }),
    ]);
    expect(prisma.tmcParentDocument.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: 1, parentContactId: 55 },
    }));
  });

  test("uploads a supported file against the selected trip requirement", async () => {
    const response = await request(makeApp())
      .post("/api/portal/tmc/parent/documents")
      .set("Authorization", `Bearer ${portalToken()}`)
      .field("documentRequirementId", "101")
      .field("tripId", "7")
      .attach("file", Buffer.from("%PDF-1.7"), { filename: "insurance.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(201);
    expect(response.body.document).toMatchObject({ id: 11, documentType: "Travel insurance certificate", documentRequirementId: 101, status: "in_review" });
    expect(visaDocStore.storeDoc).toHaveBeenCalledWith(expect.any(Buffer), "application/pdf");
    expect(prisma.tmcParentDocument.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        tenantId: 1,
        parentContactId: 55,
        tripId: 7,
        documentRequirementId: 101,
        documentType: "Travel insurance certificate",
        filename: "insurance.pdf",
        status: "in_review",
      }),
    }));
  });

  test("rejects unsupported files and trip ids outside the parent's access", async () => {
    const badType = await request(makeApp())
      .post("/api/portal/tmc/parent/documents")
      .set("Authorization", `Bearer ${portalToken()}`)
      .field("documentRequirementId", "101")
      .attach("file", Buffer.from("text"), { filename: "notes.txt", contentType: "text/plain" });
    expect(badType.status).toBe(400);
    expect(badType.body.code).toBe("UNSUPPORTED_MIME");

    const wrongTrip = await request(makeApp())
      .post("/api/portal/tmc/parent/documents")
      .set("Authorization", `Bearer ${portalToken()}`)
      .field("documentRequirementId", "101")
      .field("tripId", "999")
      .attach("file", Buffer.from("%PDF-1.7"), { filename: "insurance.pdf", contentType: "application/pdf" });
    expect(wrongTrip.status).toBe(404);
    expect(wrongTrip.body.code).toBe("TRIP_NOT_FOUND");
    expect(visaDocStore.storeDoc).not.toHaveBeenCalled();
    expect(prisma.tmcParentDocument.create).not.toHaveBeenCalled();
  });

  test("requires a configured requirement and enforces its accepted file types", async () => {
    const missingRequirement = await request(makeApp())
      .post("/api/portal/tmc/parent/documents")
      .set("Authorization", `Bearer ${portalToken()}`)
      .field("tripId", "7")
      .attach("file", Buffer.from("%PDF-1.7"), { filename: "clearance.pdf", contentType: "application/pdf" });
    expect(missingRequirement.status).toBe(400);
    expect(missingRequirement.body.code).toBe("DOCUMENT_REQUIREMENT_REQUIRED");

    const wrongFileType = await request(makeApp())
      .post("/api/portal/tmc/parent/documents")
      .set("Authorization", `Bearer ${portalToken()}`)
      .field("tripId", "7")
      .field("documentRequirementId", "102")
      .attach("file", Buffer.from("png image"), { filename: "clearance.png", contentType: "image/png" });
    expect(wrongFileType.status).toBe(400);
    expect(wrongFileType.body).toMatchObject({
      code: "UNSUPPORTED_FILE_TYPE_FOR_DOCUMENT",
      acceptedFileTypes: ["pdf", "docx"],
    });
    expect(visaDocStore.storeDoc).not.toHaveBeenCalled();
    expect(prisma.tmcParentDocument.create).not.toHaveBeenCalled();
  });

  test("uses the admin-defined document name and accepts configured file types", async () => {
    for (const [filename, contentType, requirementId, expectedName] of [
      ["medical-clearance.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "102", "School medical clearance"],
      ["insurance-certificate.jpg", "image/jpeg", "101", "Travel insurance certificate"],
    ]) {
      const response = await request(makeApp())
        .post("/api/portal/tmc/parent/documents")
        .set("Authorization", "Bearer " + portalToken())
        .field("documentRequirementId", requirementId)
        .field("tripId", "7")
        .attach("file", Buffer.from("document"), { filename, contentType });

      expect(response.status).toBe(201);
      expect(response.body.document).toMatchObject({
        documentType: expectedName,
        documentRequirementId: Number(requirementId),
      });
    }

    const arbitraryName = await request(makeApp())
      .post("/api/portal/tmc/parent/documents")
      .set("Authorization", "Bearer " + portalToken())
      .field("documentType", "This client value is ignored")
      .field("documentRequirementId", "101")
      .field("tripId", "7")
      .attach("file", Buffer.from("%PDF-1.7"), { filename: "custom-name.pdf", contentType: "application/pdf" });
    expect(arbitraryName.status).toBe(201);
    expect(arbitraryName.body.document.documentType).toBe("Travel insurance certificate");
  });

  test("does not apply trip-type document restrictions", async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue({
      id: 7,
      tripType: "domestic",
      documentRequirements: [{ id: 101, tripId: 7, docType: "Student emergency authorization", acceptedFileTypes: ["pdf"], required: true }],
    });
    const response = await request(makeApp())
      .post("/api/portal/tmc/parent/documents")
      .set("Authorization", `Bearer ${portalToken()}`)
      .field("documentRequirementId", "101")
      .field("tripId", "7")
      .attach("file", Buffer.from("%PDF-1.7"), { filename: "authorization.pdf", contentType: "application/pdf" });
    expect(response.status).toBe(201);
    expect(response.body.document.documentType).toBe("Student emergency authorization");
  });

  test("submits a digital consent form without creating a file upload", async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue({
      id: 7,
      destination: "Darjeeling",
      tripType: "international",
      documentRequirements: [{
        id: 103,
        tripId: 7,
        docType: "Parent consent form",
        acceptedFileTypes: [],
        required: true,
        captureMode: "digital_consent",
        consentTerms: "I agree to the Darjeeling trip terms.",
      }],
    });

    const response = await request(makeApp())
      .post("/api/portal/tmc/parent/consents")
      .set("Authorization", `Bearer ${portalToken()}`)
      .send({
        tripId: 7,
        documentRequirementId: 103,
        parentName: "Arijit Singh",
        participantName: "Anaya Singh",
        relationship: "Parent",
        signatureName: "Arijit Singh",
        notes: "No medical restrictions.",
        agreedToTerms: true,
      });

    expect(response.status).toBe(201);
    expect(response.body.document).toMatchObject({
      documentType: "Parent consent form",
      captureMode: "digital_consent",
      signatureName: "Arijit Singh",
      status: "in_review",
    });
    expect(prisma.tmcParentDocument.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        captureMode: "digital_consent",
        mimeType: "application/json",
        fileBlob: null,
        termsSnapshot: expect.stringContaining("TERMS AND CONDITIONS FOR INTERNATIONAL EDUCATIONAL TRAVEL PROGRAMMES"),
        answersJson: expect.stringContaining("Anaya Singh"),
      }),
    }));
    expect(visaDocStore.storeDoc).not.toHaveBeenCalled();
    expect(prisma.tripParticipant.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tripId: 7, parentEmail: "arijit@example.com" }),
    }));
  });

  test("does not accept a file upload for a digital consent requirement", async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue({
      id: 7,
      tripType: "domestic",
      documentRequirements: [{
        id: 104,
        tripId: 7,
        docType: "Consent form",
        acceptedFileTypes: ["pdf"],
        required: true,
        captureMode: "digital_consent",
      }],
    });

    const response = await request(makeApp())
      .post("/api/portal/tmc/parent/documents")
      .set("Authorization", `Bearer ${portalToken()}`)
      .field("documentRequirementId", "104")
      .field("tripId", "7")
      .attach("file", Buffer.from("%PDF-1.7"), { filename: "consent.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("DIGITAL_CONSENT_USE_FORM");
    expect(visaDocStore.storeDoc).not.toHaveBeenCalled();
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

  test("streams an OCI-backed parent document with the canonical storage descriptor", async () => {
    prisma.tmcParentDocument.findFirst.mockResolvedValue({
      id: 11,
      fileBlob: null,
      fileUrl: "https://objectstorage.ap-mumbai-1.oraclecloud.com/n/test/b/globus/o/visa-docs/parent.pdf",
      storage: "ocs",
      storageKey: "visa-docs/parent.pdf",
      mimeType: "application/pdf",
      filename: "parent.pdf",
    });
    visaDocStore.readDocBuffer.mockResolvedValue(Buffer.from("oci document"));

    const response = await request(makeApp())
      .get("/api/portal/tmc/parent/documents/11/file")
      .set("Authorization", `Bearer ${portalToken()}`);

    expect(response.status).toBe(200);
    expect(response.body.toString()).toBe("oci document");
    expect(visaDocStore.readDocBuffer).toHaveBeenCalledWith({
      url: "https://objectstorage.ap-mumbai-1.oraclecloud.com/n/test/b/globus/o/visa-docs/parent.pdf",
      storage: "ocs",
      key: "visa-docs/parent.pdf",
    });
  });

});
