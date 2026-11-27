import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const html = readFileSync(
  resolve(process.cwd(), "public/embed/web-form.html"),
  "utf8",
);

function loadTrackingHelpers() {
  const start = html.indexOf("function desktopPlatform(");
  const end = html.indexOf("var phoneRules", start);
  if (start < 0 || end < 0) throw new Error("Device tracking helpers not found");

  return Function(
    `${html.slice(start, end)}; return { normalizeOs, normalizeDeviceType };`,
  )();
}

describe("generic web-form device tracking", () => {
  const { normalizeOs, normalizeDeviceType } = loadTrackingHelpers();
  const emulatedAndroidUa =
    "Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 Chrome/145.0.0.0 Mobile Safari/537.36";

  it("keeps a Windows desktop classified as desktop when DevTools supplies an Android UA", () => {
    expect(normalizeOs(emulatedAndroidUa, "Win32")).toBe("Windows 10/11");
    expect(normalizeDeviceType(emulatedAndroidUa, "Win32")).toBe("desktop");
  });

  it("still records a real Android platform as mobile", () => {
    expect(normalizeOs(emulatedAndroidUa, "Linux armv8l")).toBe("Android 16");
    expect(normalizeDeviceType(emulatedAndroidUa, "Linux armv8l")).toBe("mobile");
  });

  it("does not change normal Windows detection", () => {
    const windowsUa =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/145.0.0.0 Safari/537.36";
    expect(normalizeOs(windowsUa, "Win32")).toBe("Windows 10/11");
    expect(normalizeDeviceType(windowsUa, "Win32")).toBe("desktop");
  });
});
