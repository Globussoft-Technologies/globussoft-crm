import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const requireCJS = createRequire(import.meta.url);
const { normalizeBookingPayload, assertSchedulingMetadata, splitName } = requireCJS("../../lib/travelMeetingPayload");

describe("travelMeetingPayload", () => {
  it("accepts TMC's exact frontend payload and maps it to the existing booking engine", () => {
    const result = normalizeBookingPayload({ firstName: "Priya", lastName: "Sharma", designation: "Principal", school: "Delhi Public School", city: "Bengaluru", email: "Priya.Sharma@school.edu.in", phone: "9876543210", selectedStartTime: "2026-09-25T10:30:00+05:30", duration: 30, timezone: "Asia/Kolkata", zoomEventId: "untrusted-client-value" });
    expect(result.values).toEqual({ contactName: "Priya Sharma", designation: "Principal", institution: "Delhi Public School", city: "Bengaluru", contactEmail: "priya.sharma@school.edu.in", contactPhone: "9876543210" });
    expect(result.scheduledAtInput).toBe("2026-09-25T10:30:00+05:30");
    expect(result.customFields).toMatchObject({ firstName: "Priya", lastName: "Sharma" });
    expect(result.ignoredClientZoomEventId).toBe("untrusted-client-value");
  });

  it("keeps the embed's legacy field names backward compatible", () => {
    const result = normalizeBookingPayload({ contactName: "Asha Rao", institution: "Example School", contactEmail: "asha@example.edu", contactPhone: "+91 90000", scheduledAt: "2026-09-25T05:00:00Z" });
    expect(result.values).toMatchObject({ contactName: "Asha Rao", institution: "Example School", contactEmail: "asha@example.edu", contactPhone: "+91 90000" });
    expect(result.scheduledAtInput).toBe("2026-09-25T05:00:00Z");
  });

  it("rejects stale duration or timezone metadata", () => {
    const form = { durationMins: 30, timezone: "Asia/Kolkata" };
    expect(() => assertSchedulingMetadata(form, { requestedDuration: 45 })).toThrowError(expect.objectContaining({ code: "DURATION_MISMATCH" }));
    expect(() => assertSchedulingMetadata(form, { requestedTimezone: "UTC" })).toThrowError(expect.objectContaining({ code: "TIMEZONE_MISMATCH" }));
  });

  it("returns first and last names from persisted custom fields", () => {
    expect(splitName("Priya Sharma", { firstName: "Priya", lastName: "Sharma" })).toEqual({ firstName: "Priya", lastName: "Sharma" });
  });
});
