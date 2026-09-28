import { afterEach, describe, expect, test } from "vitest";
import encryption from "../../lib/travelMeetingCredentialEncryption.js";

const originalKey = process.env.TRAVEL_MEETING_CREDENTIAL_KEY;

afterEach(() => {
  if (originalKey === undefined) delete process.env.TRAVEL_MEETING_CREDENTIAL_KEY;
  else process.env.TRAVEL_MEETING_CREDENTIAL_KEY = originalKey;
});

describe("Travel Meeting credential encryption", () => {
  test("encrypts, decrypts, and authenticates provider credentials", () => {
    process.env.TRAVEL_MEETING_CREDENTIAL_KEY = "e".repeat(64);
    const encrypted = encryption.encryptTravelMeetingCredential("zoom-secret");
    expect(encryption.isEncrypted(encrypted)).toBe(true);
    expect(encrypted).not.toContain("zoom-secret");
    expect(encryption.decryptTravelMeetingCredential(encrypted)).toBe("zoom-secret");
  });

  test("fails closed without the dedicated key", () => {
    delete process.env.TRAVEL_MEETING_CREDENTIAL_KEY;
    expect(() => encryption.encryptTravelMeetingCredential("zoom-secret")).toThrow(/must be configured/i);
  });

  test("rejects plaintext and tampered stored values", () => {
    process.env.TRAVEL_MEETING_CREDENTIAL_KEY = "e".repeat(64);
    expect(() => encryption.decryptTravelMeetingCredential("zoom-secret")).toThrow(/not encrypted/i);
    const encrypted = encryption.encryptTravelMeetingCredential("zoom-secret");
    const tampered = `${encrypted.slice(0, -1)}${encrypted.endsWith("0") ? "1" : "0"}`;
    expect(() => encryption.decryptTravelMeetingCredential(tampered)).toThrow();
  });
});
