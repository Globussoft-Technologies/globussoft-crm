// Unit tests for lib/visaDocStore.js — the short-lived, signed view-link layer
// that gates private visa documents (passport / bank scans). Covers the disk
// token sign→verify round-trip, tamper/expiry rejection, and resolveViewUrl's
// S3-vs-disk branch. s3Service is monkeypatched via the createRequire singleton
// idiom (vi.mock can't reach the SUT's CJS require chain under this setup).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";

const requireCJS = createRequire(import.meta.url);
const s3Service = requireCJS("../../services/s3Service");
const store = requireCJS("../../lib/visaDocStore");

describe("visaDocStore.signDiskUrl + verifyDiskToken", () => {
  it("round-trips: a freshly-signed URL's token verifies for that file", () => {
    const url = store.signDiskUrl("abc.png", 300);
    expect(url).toMatch(/^\/api\/uploads\/visa-docs\/abc\.png\?t=/);
    const token = url.split("?t=")[1];
    expect(store.verifyDiskToken("abc.png", token)).toBe(true);
  });

  it("rejects a token minted for a DIFFERENT file (can't reuse across docs)", () => {
    const token = store.signDiskUrl("abc.png", 300).split("?t=")[1];
    expect(store.verifyDiskToken("other.png", token)).toBe(false);
  });

  it("rejects a tampered signature", () => {
    const token = store.signDiskUrl("abc.png", 300).split("?t=")[1];
    const [exp, sig] = token.split(".");
    const flipped = `${exp}.${sig.slice(0, -1)}${sig.slice(-1) === "A" ? "B" : "A"}`;
    expect(store.verifyDiskToken("abc.png", flipped)).toBe(false);
  });

  it("rejects an expired token", () => {
    // Negative TTL is floored to 30s by signDiskUrl, so forge an expired one.
    const token = store.signDiskUrl("abc.png", 300).split("?t=")[1];
    const sig = token.split(".")[1];
    const pastExp = Math.floor(Date.now() / 1000) - 10;
    expect(store.verifyDiskToken("abc.png", `${pastExp}.${sig}`)).toBe(false);
  });

  it("rejects missing / malformed tokens", () => {
    expect(store.verifyDiskToken("abc.png", undefined)).toBe(false);
    expect(store.verifyDiskToken("abc.png", "")).toBe(false);
    expect(store.verifyDiskToken("abc.png", "no-dot")).toBe(false);
    expect(store.verifyDiskToken("", "123.abc")).toBe(false);
  });
});

describe("visaDocStore.resolveViewUrl", () => {
  beforeEach(() => {
    s3Service.getSignedUrl = vi.fn(async (key, ttl) => `https://signed.example/${key}?exp=${ttl}`);
    s3Service.extractKeyFromUrl = vi.fn((u) => `extracted/${u.split("/").pop()}`);
  });

  it("returns a signed S3 URL for an s3-backed item", async () => {
    const url = await store.resolveViewUrl(
      { attachmentStorage: "s3", attachmentKey: "visa-docs/x.png", attachmentUrl: "https://b/visa-docs/x.png" },
      120,
    );
    expect(s3Service.getSignedUrl).toHaveBeenCalledWith("visa-docs/x.png", 120);
    expect(url).toContain("signed.example");
  });

  it("returns a token-signed disk path for a disk-backed item", async () => {
    const url = await store.resolveViewUrl({ attachmentStorage: "disk", attachmentKey: "y.pdf", attachmentUrl: "/api/uploads/visa-docs/y.pdf" });
    expect(url).toMatch(/^\/api\/uploads\/visa-docs\/y\.pdf\?t=/);
    expect(s3Service.getSignedUrl).not.toHaveBeenCalled();
  });

  it("infers S3 from an http(s) URL when storage wasn't stamped (legacy rows)", async () => {
    const url = await store.resolveViewUrl({ attachmentUrl: "https://bucket/visa-docs/legacy.png" });
    expect(s3Service.extractKeyFromUrl).toHaveBeenCalled();
    expect(url).toContain("signed.example");
  });

  it("returns null when the item has no stored file", async () => {
    expect(await store.resolveViewUrl({ attachmentUrl: null })).toBe(null);
    expect(await store.resolveViewUrl(null)).toBe(null);
  });
});

describe("visaDocStore.readDocBuffer", () => {
  beforeEach(() => {
    s3Service.getObjectStream = vi.fn();
  });

  it("returns null for a null descriptor", async () => {
    expect(await store.readDocBuffer(null)).toBe(null);
  });

  it("returns null when the descriptor has no key", async () => {
    expect(await store.readDocBuffer({})).toBe(null);
    expect(await store.readDocBuffer({ storage: "disk" })).toBe(null);
  });

  it("concatenates S3 stream chunks into a Buffer", async () => {
    const chunk1 = Buffer.from("hello ");
    const chunk2 = Buffer.from("world");
    async function* fakeStream() {
      yield chunk1;
      yield chunk2;
    }
    s3Service.getObjectStream = vi.fn(async () => ({ stream: fakeStream() }));

    const result = await store.readDocBuffer({ storage: "s3", key: "visa-docs/test.pdf" });

    expect(s3Service.getObjectStream).toHaveBeenCalledWith("visa-docs/test.pdf");
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.toString()).toBe("hello world");
  });

  it("returns null when the S3 stream is absent", async () => {
    s3Service.getObjectStream = vi.fn(async () => ({ stream: null }));

    const result = await store.readDocBuffer({ storage: "s3", key: "visa-docs/missing.pdf" });

    expect(result).toBe(null);
  });

  it("returns null for a disk key whose file does not exist", async () => {
    // path.basename("definitely-nonexistent-xyz.pdf") resolves inside uploadDir;
    // fs.existsSync will return false because the file was never created.
    const result = await store.readDocBuffer({ storage: "disk", key: "definitely-nonexistent-xyz.pdf" });

    expect(result).toBe(null);
  });

  it("swallows a thrown error from getObjectStream and returns null", async () => {
    s3Service.getObjectStream = vi.fn(async () => {
      throw new Error("network failure");
    });

    const result = await store.readDocBuffer({ storage: "s3", key: "visa-docs/boom.pdf" });

    expect(result).toBe(null);
  });
});
