const { _internal } = require("../../routes/travel_meeting_forms");

describe("Travel Meeting Form field validation", () => {
  test("server callers need no API credential while browser origins use the tenant-wide embed allowlist", () => {
    const form = { tenant: { embedAllowlistJson: JSON.stringify(["https://www.themodernclassroom.in", "https://*.partner.test"]) } };
    expect(_internal.authorizeConsumer(form, { headers: {} })).toBe(true);
    expect(_internal.authorizeConsumer(form, { headers: { origin: "https://www.themodernclassroom.in" } })).toBe(true);
    expect(_internal.authorizeConsumer(form, { headers: { origin: "https://school.partner.test" } })).toBe(true);
    expect(_internal.authorizeConsumer(form, { headers: { origin: "https://untrusted.example" } })).toBe(false);
  });

  test("an empty tenant embed allowlist keeps public browser APIs unrestricted", () => {
    expect(_internal.authorizeConsumer({ tenant: { embedAllowlistJson: null } }, { headers: { origin: "https://client.example" } })).toBe(true);
  });

  test("requires options for enabled Select fields", () => {
    expect(() => _internal.normalizeFields([
      { key: "custom_choice", label: "Choose one", type: "select", enabled: true, options: [] },
    ])).toThrowError(/at least one option/i);
  });

  test("normalizes individual Select options and removes duplicates", () => {
    const fields = _internal.normalizeFields([
      { key: "custom_choice", label: "Choose one", type: "select", enabled: true, options: [" First ", "Second", "First", ""] },
    ]);
    expect(fields[0].options).toEqual(["First", "Second"]);
  });

  test("accepts only supported iframe Google Fonts", () => {
    expect(_internal.normalizeEmbedFont("Poppins")).toBe("Poppins");
    expect(() => _internal.normalizeEmbedFont("url(javascript:alert(1))")).toThrowError(/supported Google Font/i);
  });

  test("publishes the configured booking horizon for the hosted calendar", () => {
    const config = _internal.publicConfig({
      publicKey: "tmcmf_test",
      name: "Conversation",
      subBrand: "tmc",
      durationMins: 30,
      bookingHorizonDays: 60,
      timezone: "Asia/Kolkata",
      embedFontFamily: "Inter",
      fieldsJson: "[]",
      confirmationMessage: "Confirmed",
    });
    expect(config.bookingHorizonDays).toBe(60);
  });

  test("forces Travel Meeting Forms to use Google Calendar", () => {
    const data = _internal.dataFromBody({ name: "Conversation", calendarProvider: "outlook" });
    expect(data.calendarProvider).toBe("google");
  });

  test("reports only the branded confirmation as delivered email", () => {
    expect(_internal.bookingDeliveryStatus({ status: "CONFIRMED", calendarEventId: "google-event-1", emailStatus: "FAILED" })).toEqual({
      status: "FAILED",
      channel: null,
    });
    expect(_internal.bookingDeliveryStatus({ status: "CONFIRMED", calendarEventId: null, emailStatus: "FAILED" })).toEqual({
      status: "FAILED",
      channel: null,
    });
    expect(_internal.bookingDeliveryStatus({ status: "CONFIRMED", calendarEventId: "google-event-1", emailStatus: "SENT", emailChannel: "calendar_invite" })).toEqual({
      status: "FAILED",
      channel: null,
    });
  });

  test("serializes slot claims and rejects overlapping meeting ranges", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: 9 }]),
      travelMeetingSlot: {
        findFirst: vi.fn().mockResolvedValue({ id: 42 }),
        count: vi.fn(),
      },
    };
    const start = new Date("2026-10-15T04:30:00Z");
    const end = new Date("2026-10-15T05:30:00Z");
    await expect(_internal.assertSlotClaimAvailable(tx, {
      id: 9,
      tenantId: 2,
      timezone: "Asia/Kolkata",
      bufferBeforeMins: 15,
      bufferAfterMins: 10,
      maxBookingsPerDay: null,
    }, start, end)).rejects.toMatchObject({ code: "SLOT_UNAVAILABLE", status: 409 });
    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    expect(tx.travelMeetingSlot.findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: 2,
        meetingFormId: 9,
        scheduledAt: { lt: new Date("2026-10-15T05:55:00.000Z") },
        endsAt: { gt: new Date("2026-10-15T04:05:00.000Z") },
      },
      select: { id: true },
    });
  });

  test("enforces the per-day limit while holding the form lock", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: 9 }]),
      travelMeetingSlot: {
        findFirst: vi.fn().mockResolvedValue(null),
        count: vi.fn().mockResolvedValue(2),
      },
    };
    await expect(_internal.assertSlotClaimAvailable(tx, {
      id: 9,
      tenantId: 2,
      timezone: "Asia/Kolkata",
      maxBookingsPerDay: 2,
    }, new Date("2026-10-15T04:30:00Z"), new Date("2026-10-15T05:00:00Z"))).rejects.toMatchObject({
      code: "DAILY_LIMIT_REACHED",
      status: 409,
    });
  });

  test("refuses to merge booking identity fields from different CRM contacts", () => {
    expect(() => _internal.chooseBookingContact([
      { id: 11, email: "school@example.com", phone: "+911111111111" },
      { id: 12, email: "other@example.com", phone: "+922222222222" },
    ])).toThrowError(/different CRM contacts/i);
    expect(_internal.chooseBookingContact([{ id: 11 }])).toEqual({ id: 11 });
  });

  test("emits booking notifications only to the authenticated tenant room", () => {
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    _internal.emitTravelMeetingBooked({ to }, { tenantId: 8, id: 14 }, { id: 22 });
    expect(to).toHaveBeenCalledWith("tenant:8");
    expect(emit).toHaveBeenCalledWith("travel_meeting_booked", { formId: 14, bookingId: 22 });
  });

  test("keeps a confirmed booking intact when confirmation delivery fails", async () => {
    const deliver = vi.fn().mockRejectedValue(new Error("mail provider unavailable"));
    const update = vi.fn().mockRejectedValue(new Error("status persistence unavailable"));
    const booking = { id: 22, status: "CONFIRMED", meetingUrl: "https://zoom.us/j/22" };
    const result = await _internal.persistBookingConfirmationDelivery(
      { id: 14 },
      booking,
      { deliver, bookingModel: { update } },
    );
    expect(result).toMatchObject({
      id: 22,
      status: "CONFIRMED",
      meetingUrl: "https://zoom.us/j/22",
      emailStatus: "FAILED",
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: 22 },
      data: { emailStatus: "FAILED", emailChannel: null },
    });
  });

  test.each([
    ["email", "not-an-email"],
    ["tel", "abc"],
    ["select", "Not configured"],
  ])("rejects invalid %s submission values", (type, value) => {
    const field = { key: "custom_value", label: "Value", type, required: true, options: type === "select" ? ["Allowed"] : [] };
    expect(_internal.validateConfiguredFieldValues([field], { custom_value: value })).toEqual({
      error: "One or more form fields contain an invalid value",
      code: "INVALID_FIELD_VALUE",
      fields: ["custom_value"],
    });
  });
});
