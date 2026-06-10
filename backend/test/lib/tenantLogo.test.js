import { describe, it, expect } from "vitest";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import {
  localLogoDiskPath,
  imageDimensions,
  isLogoTooLarge,
  MAX_LOGO_PIXELS,
} from "../../lib/tenantLogo.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "..", "..", "..", "frontend", "public");

// Minimal 24-byte PNG header with a given width/height (enough for our parser).
function pngHeader(w, h) {
  const b = Buffer.alloc(24);
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].forEach((v, i) => (b[i] = v));
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

const BACKEND = "/srv/app/backend";
const j = (...p) => path.join(BACKEND, ...p);

describe("localLogoDiskPath", () => {
  it("maps an /api/uploads/ disk URL to backend/uploads (strips the /api route prefix)", () => {
    // This is the exact regression: uploads are stored as "/api/uploads/..."
    // but the file lives at backend/uploads/... — the "/api" must be dropped.
    expect(
      localLogoDiskPath("/api/uploads/branding/tenant-2/logo-1.png", BACKEND),
    ).toBe(j("uploads", "branding", "tenant-2", "logo-1.png"));
  });

  it("maps a legacy /uploads/ URL to backend/uploads", () => {
    expect(localLogoDiskPath("/uploads/branding/x.png", BACKEND)).toBe(
      j("uploads", "branding", "x.png"),
    );
  });

  it("returns null for a remote S3 https URL (caller fetches those over HTTP)", () => {
    expect(
      localLogoDiskPath("https://bucket.s3.amazonaws.com/branding/x.png", BACKEND),
    ).toBeNull();
    expect(localLogoDiskPath("http://example.com/x.png", BACKEND)).toBeNull();
  });

  it("returns null for blank / non-uploads / non-string inputs", () => {
    expect(localLogoDiskPath(null, BACKEND)).toBeNull();
    expect(localLogoDiskPath(undefined, BACKEND)).toBeNull();
    expect(localLogoDiskPath("", BACKEND)).toBeNull();
    expect(localLogoDiskPath("/some/other/path.png", BACKEND)).toBeNull();
    expect(localLogoDiskPath(123, BACKEND)).toBeNull();
  });

  it("does not escape the uploads dir for a normal upload path", () => {
    const out = localLogoDiskPath("/api/uploads/branding/tenant-9/logo.png", BACKEND);
    expect(out.startsWith(j("uploads"))).toBe(true);
  });
});

describe("imageDimensions / isLogoTooLarge (PDF OOM guard)", () => {
  it("reads PNG dimensions from the header", () => {
    expect(imageDimensions(pngHeader(400, 121))).toEqual({ width: 400, height: 121 });
    expect(imageDimensions(pngHeader(21618, 6558))).toEqual({ width: 21618, height: 6558 });
  });

  it("flags the 21,618×6,558 monster as too large, passes a normal logo", () => {
    // This is the exact OOM source: ~567 MB decoded → nginx 502.
    expect(isLogoTooLarge(pngHeader(21618, 6558))).toBe(true);
    expect(isLogoTooLarge(pngHeader(400, 121))).toBe(false);
    expect(isLogoTooLarge(pngHeader(2000, 2000))).toBe(false); // 4 MP < 5 MP cap
  });

  it("does not over-block unknown / tiny buffers", () => {
    expect(isLogoTooLarge(Buffer.from([1, 2, 3]))).toBe(false);
    expect(isLogoTooLarge(null)).toBe(false);
    expect(imageDimensions(Buffer.alloc(4))).toBeNull();
  });

  it("uses a 5 MP cap", () => {
    expect(MAX_LOGO_PIXELS).toBe(5_000_000);
  });

  // Integration guard against the real bundled assets, so this can't silently
  // regress if someone swaps the files.
  it("the bundled default logos: -pdf is safe, the full-size is correctly rejected", () => {
    const small = fs.readFileSync(path.join(PUBLIC, "globussoft-logo-pdf.png"));
    expect(isLogoTooLarge(small)).toBe(false);

    const bigPath = path.join(PUBLIC, "globussoft-logo.png");
    if (fs.existsSync(bigPath)) {
      const big = fs.readFileSync(bigPath);
      expect(isLogoTooLarge(big)).toBe(true);
    }
  });
});
