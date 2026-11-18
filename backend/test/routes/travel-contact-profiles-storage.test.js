import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import prisma from "../../lib/prisma.js";

prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn();
prisma.contact = prisma.contact || {};
prisma.contact.findFirst = vi.fn();
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn();
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn();

const requireCJS = createRequire(import.meta.url);
const router = requireCJS("../../routes/travel_contact_profiles.js");
const s3Service = requireCJS("../../services/s3Service.js");
const JWT_SECRET = process.env.JWT_SECRET || "enterprise_super_secret_key_2026";
const DOCUMENTS_PATH = path.resolve(
  process.cwd(),
  "uploads",
  "travel-contact-profiles",
  "documents.json",
);

function makeApp() {
  const app = express();
  app.use("/api/travel", router);
  return app;
}

function tokenFor() {
  return jwt.sign(
    {
      userId: 7,
      tenantId: 1,
      role: "ADMIN",
      email: "admin@test.local",
    },
    JWT_SECRET,
    { expiresIn: "1h" },
  );
}

describe("travel contact profile document storage", () => {
  let originalDocuments;
  let originalStorageMethods;

  beforeEach(() => {
    originalDocuments = fs.existsSync(DOCUMENTS_PATH)
      ? fs.readFileSync(DOCUMENTS_PATH)
      : null;
    prisma.tenant.findUnique.mockReset().mockResolvedValue({
      id: 1,
      vertical: "travel",
      name: "Test Travel",
      slug: "test-travel",
    });
    prisma.contact.findFirst.mockReset().mockResolvedValue({
      id: 42,
      tenantId: 1,
      name: "Test Traveller",
      email: "traveller@test.local",
      phone: "+919999999999",
      birthDate: null,
      subBrand: "tmc",
      assignedToId: 7,
    });
    prisma.user.findUnique
      .mockReset()
      .mockResolvedValue({ role: "ADMIN", subBrandAccess: null });
    prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
    originalStorageMethods = {
      isConfigured: s3Service.isConfigured,
      uploadFile: s3Service.uploadFile,
      extractKeyFromUrl: s3Service.extractKeyFromUrl,
      isOciUrl: s3Service.isOciUrl,
    };
  });

  afterEach(() => {
    if (originalDocuments === null) {
      try {
        fs.unlinkSync(DOCUMENTS_PATH);
      } catch {
        // The route may not have created an index for an early failure.
      }
    } else {
      fs.writeFileSync(DOCUMENTS_PATH, originalDocuments);
    }
    s3Service.isConfigured = originalStorageMethods.isConfigured;
    s3Service.uploadFile = originalStorageMethods.uploadFile;
    s3Service.extractKeyFromUrl = originalStorageMethods.extractKeyFromUrl;
    s3Service.isOciUrl = originalStorageMethods.isOciUrl;
  });

  test("stores uploaded contact documents in OCI when object storage is configured", async () => {
    const objectUrl =
      "https://objectstorage.ap-mumbai-1.oraclecloud.com/n/ns/b/bucket/o/travel/contact-profiles/1/42/documents/document.pdf";
    const objectKey = "travel/contact-profiles/1/42/documents/document.pdf";
    s3Service.isConfigured = vi.fn(() => true);
    s3Service.uploadFile = vi.fn().mockResolvedValue(objectUrl);
    s3Service.extractKeyFromUrl = vi.fn().mockReturnValue(objectKey);
    s3Service.isOciUrl = vi.fn(() => true);

    const res = await request(makeApp())
      .post("/api/travel/contact-profiles/by-contact/42/documents")
      .set("Authorization", `Bearer ${tokenFor()}`)
      .field("label", "Passport scan")
      .attach("files", Buffer.from("pdf bytes"), {
        filename: "passport.pdf",
        contentType: "application/pdf",
      });

    expect(res.status, `upload: ${res.text}`).toBe(201);
    expect(res.body.documents).toHaveLength(1);
    expect(res.body.documents[0]).toMatchObject({
      fileUrl: objectUrl,
      storage: "ocs",
      storageKey: objectKey,
    });
    expect(s3Service.uploadFile).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.stringMatching(/\.pdf$/),
      "application/pdf",
      "travel/contact-profiles/1/42/documents",
    );
  });
});
