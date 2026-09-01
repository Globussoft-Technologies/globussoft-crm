// Unit tests for lib/passportFileStore.js - the signed view-link layer used
// by passport images. Covers the disk token sign/verify round-trip and the
// S3-vs-disk resolution branch.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";

const requireCJS = createRequire(import.meta.url);
const s3Service = requireCJS("../../services/s3Service");
const store = requireCJS("../../lib/passportFileStore");

describe("passportFileStore.signDiskUrl + verifyDiskToken", () => {
  it("round-trips a freshly signed URL token for the same file", () => {
    const url = store.signDiskUrl("abc.png", 300);
    expect(url).toMatch(/^\/api\/uploads\/passport-ocr\/abc\.png\?t=/);
    const token = url.split("?t=")[1];
    expect(store.verifyDiskToken("abc.png", token)).toBe(true);
  });

  it("rejects a token minted for a different file", () => {
    const token = store.signDiskUrl("abc.png", 300).split("?t=")[1];
    expect(store.verifyDiskToken("other.png", token)).toBe(false);
  });

  it("rejects a tampered signature", () => {
    const token = store.signDiskUrl("abc.png", 300).split("?t=")[1];
    const [exp, sig] = token.split(".");
    const flipped = `${exp}.${sig.slice(0, -1)}${sig.slice(-1) === "A" ? "B" : "A"}`;
    expect(store.verifyDiskToken("abc.png", flipped)).toBe(false);
  });

  it("rejects missing or malformed tokens", () => {
    expect(store.verifyDiskToken("abc.png", undefined)).toBe(false);
    expect(store.verifyDiskToken("abc.png", "")).toBe(false);
    expect(store.verifyDiskToken("abc.png", "no-dot")).toBe(false);
    expect(store.verifyDiskToken("", "123.abc")).toBe(false);
  });
});

describe("passportFileStore.resolveViewUrl", () => {
  beforeEach(() => {
    s3Service.getSignedUrl = vi.fn(async (key, ttl) => `https://signed.example/${key}?exp=${ttl}`);
    s3Service.extractKeyFromUrl = vi.fn((url) => {
      const normalized = String(url || "").replace(/\/$/, "");
      const file = normalized.split("/").pop();
      return file ? `passport-ocr/${file}` : null;
    });
  });

  it("returns a signed S3 URL for an s3-backed item", async () => {
    const url = await store.resolveViewUrl(
      { storage: "s3", imageKey: "passport-ocr/x.png", imageUrl: "https://b/passport-ocr/x.png" },
      120,
    );
    expect(s3Service.getSignedUrl).toHaveBeenCalledWith("passport-ocr/x.png", 120, { provider: "aws" });
    expect(url).toContain("signed.example");
  });

  it("returns a token-signed disk path for a disk-backed item", async () => {
    const url = await store.resolveViewUrl({
      storage: "disk",
      imageFilename: "y.pdf",
      imageUrl: "/api/uploads/passport-ocr/y.pdf",
    });
    expect(url).toMatch(/^\/api\/uploads\/passport-ocr\/y\.pdf\?t=/);
    expect(s3Service.getSignedUrl).not.toHaveBeenCalled();
  });

  it("infers S3 from an http(s) URL when storage was not stamped", async () => {
    const url = await store.resolveViewUrl({ imageUrl: "https://bucket/passport-ocr/legacy.png" });
    expect(s3Service.extractKeyFromUrl).toHaveBeenCalled();
    expect(url).toContain("signed.example");
  });

  it("returns null when the item has no stored file", async () => {
    expect(await store.resolveViewUrl({ imageUrl: null })).toBe(null);
    expect(await store.resolveViewUrl(null)).toBe(null);
  });
});
