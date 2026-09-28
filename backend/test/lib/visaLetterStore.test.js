import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const requireCJS = createRequire(import.meta.url);
const s3Service = requireCJS("../../services/s3Service");
const store = requireCJS("../../lib/visaLetterStore");

const original = {
  bucket: s3Service.BUCKET_NAME,
  uploadFile: s3Service.uploadFile,
  extractKeyFromUrl: s3Service.extractKeyFromUrl,
  isOciUrl: s3Service.isOciUrl,
};
const testApplicationId = 900000000 + (process.pid % 1000000);
const testPrefix = `applications-${testApplicationId}`;

beforeEach(() => {
  s3Service.BUCKET_NAME = "configured-bucket";
  s3Service.uploadFile = vi.fn();
  s3Service.extractKeyFromUrl = vi.fn((url) => String(url).replace("https://storage.example/", ""));
  s3Service.isOciUrl = vi.fn(() => false);
});

afterEach(() => {
  s3Service.BUCKET_NAME = original.bucket;
  s3Service.uploadFile = original.uploadFile;
  s3Service.extractKeyFromUrl = original.extractKeyFromUrl;
  s3Service.isOciUrl = original.isOciUrl;
  fs.rmSync(path.join(store.uploadDir, testPrefix), { recursive: true, force: true });
});

describe("visaLetterStore.storeLetterPdf", () => {
  test("falls back to a readable disk file when configured cloud storage rejects the upload", async () => {
    s3Service.uploadFile.mockRejectedValueOnce(new Error("Access denied"));

    const descriptor = await store.storeLetterPdf(Buffer.from("pdf-bytes"), {
      applicationId: testApplicationId,
      participantId: testApplicationId + 1,
      kind: "generated",
      fileName: `cover-letter-application-${testApplicationId}.pdf`,
    });

    expect(descriptor.storage).toBe("disk");
    expect(descriptor.url).toMatch(new RegExp(`^/api/uploads/visa-letters/${testPrefix}/`));
    expect(await store.readLetterBuffer(descriptor)).toEqual(Buffer.from("pdf-bytes"));
  });

  test("keeps the cloud descriptor when the upload succeeds", async () => {
    s3Service.uploadFile.mockResolvedValueOnce("https://storage.example/visa-letters/file.pdf");

    const descriptor = await store.storeLetterPdf(Buffer.from("pdf-bytes"), {
      applicationId: testApplicationId,
      participantId: testApplicationId + 1,
      fileName: `cover-letter-application-${testApplicationId}.pdf`,
    });

    expect(descriptor).toEqual({
      storage: "s3",
      url: "https://storage.example/visa-letters/file.pdf",
      key: "visa-letters/file.pdf",
    });
  });
});
