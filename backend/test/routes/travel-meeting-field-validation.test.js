const { _internal } = require("../../routes/travel_meeting_forms");

describe("Travel Meeting Form field validation", () => {
  const linkPayload = { firstName: "Priya", lastName: "Sharma", email: "priya@school.edu.in",
    selectedStartTime: "2026-10-09T10:00:00+05:30", zoomEventId: "meeting-123" };
  const linkForm = { id: 7, tenantId: 3, durationMins: 30, timezone: "Asia/Kolkata" };
  test.each([
    "https://zoom.us/j/123?pwd=secret&omn=456",
    "https://us02web.zoom.us/j/123?pwd=secret",
    "https://company.zoom.us/my/expert",
    "https://zoom.com/j/123",
    "https://agency.zoomgov.com/j/123",
  ])("preserves valid Zoom join links: %s", (url) => {
    for (const field of ["zoomJoinUrl", "meetingUrl"]) {
      expect(_internal.externalBookingData(linkForm, { ...linkPayload, [field]: url }).data.meetingUrl).toBe(url);
    }
  });
  test.each([
    "javascript:alert(1)", "data:text/html,test", "http://zoom.us/j/123",
    "https://zoom.us.evil.test/j/123", "https://evilzoom.us/j/123",
    "https://zoom.us@evil.test/j/123", "https://user:password@zoom.us/j/123",
    "https://zoom.us:8443/j/123", "//zoom.us/j/123", "not-a-url",
  ])("rejects unsafe meeting links before booking persistence: %s", (url) => {
    for (const field of ["zoomJoinUrl", "meetingUrl"]) {
      try {
        _internal.externalBookingData(linkForm, { ...linkPayload, [field]: url });
        throw new Error("Expected rejection");
      } catch (error) {
        expect(error).toMatchObject({ status: 400, code: "INVALID_MEETING_URL" });
      }
    }
  });
  test("keeps an absent or empty meeting link optional", () => {
    expect(_internal.externalBookingData(linkForm, linkPayload).data.meetingUrl).toBeNull();
    expect(_internal.externalBookingData(linkForm, { ...linkPayload, zoomJoinUrl: " " }).data.meetingUrl).toBeNull();
  });
  test("accepts, normalizes, and deduplicates confirmation email CC recipients", () => {
    expect(_internal.normalizeEmailCc([" PERSON@EXAMPLE.COM ", "person@example.com", "host@example.com", ""])).toEqual([
      "person@example.com",
      "host@example.com",
    ]);
    expect(() => _internal.normalizeEmailCc(["not-an-email"])).toThrowError(/valid CC email/i);
    expect(_internal.normalizeEmailCc([
      "one@example.com", "two@example.com", "three@example.com", "four@example.com", "five@example.com", "six@example.com",
    ])).toHaveLength(6);
  });

  test("prepares a confirmed storage-only booking without CRM provider work", () => {
    const prepared = _internal.externalBookingData(
      { id: 7, tenantId: 3, durationMins: 30, timezone: "Asia/Kolkata", createCalendarEvent: false },
      {
        firstName: "Priya",
        lastName: "Sharma",
        designation: "Principal",
        school: "Delhi Public School",
        city: "Bengaluru",
        email: "priya@school.edu.in",
        phone: "9876543210",
        selectedStartTime: "2026-10-09T10:00:00+05:30",
        duration: 30,
        timezone: "Asia/Kolkata",
        zoomEventId: "zoom-event-123",
      },
    );

    expect(prepared.unique).toEqual({ tenantId: 3, meetingFormId: 7, idempotencyKey: "zoom:zoom-event-123" });
    expect(prepared.data).toMatchObject({
      contactName: "Priya Sharma",
      contactEmail: "priya@school.edu.in",
      institution: "Delhi Public School",
      zoomMeetingId: "zoom-event-123",
      status: "CONFIRMED",
      emailStatus: "EXTERNAL",
      emailChannel: "external_scheduler",
      calendarProvider: null,
    });
    expect(prepared.data).not.toHaveProperty("contactId");
    expect(JSON.parse(prepared.data.customFieldsJson)).toMatchObject({
      zoomEventId: "zoom-event-123",
      ingestionMode: "EXTERNAL_CONFIRMED_BOOKING",
    });
    expect(prepared.data.endsAt.getTime() - prepared.data.scheduledAt.getTime()).toBe(30 * 60_000);
  });

  test("requires an idempotency key when an external booking has no Zoom identifier", () => {
    expect(() => _internal.externalBookingData(
      { id: 7, tenantId: 3, durationMins: 30, timezone: "Asia/Kolkata" },
      { firstName: "Priya", lastName: "Sharma", email: "priya@school.edu.in", selectedStartTime: "2026-10-09T10:00:00+05:30" },
    )).toThrowError(/Idempotency-Key/i);
    const prepared = _internal.externalBookingData(
      { id: 7, tenantId: 3, durationMins: 30, timezone: "Asia/Kolkata", createCalendarEvent: true },
      { firstName: "Priya", lastName: "Sharma", email: "priya@school.edu.in", selectedStartTime: "2026-10-09T10:00:00+05:30" },
      "external-booking-1",
    );
    expect(prepared.data).toMatchObject({ status: "PROCESSING", zoomMeetingId: null, meetingType: "EXTERNAL" });
  });

  test("marks external bookings for CRM email only when the form enables it", () => {
    const payload = { firstName: "Priya", lastName: "Sharma", email: "priya@school.edu.in", selectedStartTime: "2026-10-09T10:00:00+05:30" };
    const form = { id: 7, tenantId: 3, durationMins: 30, timezone: "Asia/Kolkata", createZoom: false, sendConfirmationEmail: true };
    const prepared = _internal.externalBookingData(form, payload, "external-email-1");
    expect(prepared.data).toMatchObject({ status: "CONFIRMED", emailStatus: "PENDING", emailChannel: null, meetingType: "EXTERNAL" });
    expect(_internal.bookingDeliveryStatus(prepared.data)).toMatchObject({ status: "PENDING", channel: null });
  });

  test("maps provider failures away from proxy-intercepted gateway responses", () => {
    expect(_internal.publicBookingErrorStatus({ status: 502, code: "ZOOM_CREATE_FAILED" })).toBe(424);
    expect(_internal.publicBookingErrorStatus({ status: 503, code: "ZOOM_NOT_CONFIGURED" })).toBe(424);
    expect(_internal.publicBookingErrorStatus({ status: 409, code: "SLOT_UNAVAILABLE" })).toBe(409);
  });
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

  test("upgrades the canonical Designation field to the TMC dropdown contract", () => {
    const fields = _internal.normalizeFields([
      { key: "designation", label: "Designation", type: "text", required: true, enabled: true },
    ]);
    expect(fields[0]).toMatchObject({
      key: "designation",
      type: "select",
      required: true,
      options: [
        "Principal",
        "Vice Principal",
        "Head of School",
        "Academic Coordinator",
        "Teacher / Faculty",
        "School Management",
        "Other",
      ],
    });
  });

  test("validates both names when a customer website uses the split-name API contract", () => {
    expect(_internal.validateSplitNameSubmission(
      { firstName: "Priya", lastName: "Sharma" },
      { aliases: { firstName: "Priya", lastName: "Sharma" } },
    )).toBeNull();
    expect(_internal.validateSplitNameSubmission(
      { firstName: "Priya", lastName: "" },
      { aliases: { firstName: "Priya", lastName: "" } },
    )).toMatchObject({
      code: "INVALID_FIELD_VALUE",
      fields: ["lastName"],
      fieldErrors: { lastName: expect.stringMatching(/required/i) },
    });
    expect(_internal.validateSplitNameSubmission(
      { contactName: "Legacy Visitor" },
      { aliases: { firstName: "", lastName: "" } },
    )).toBeNull();
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

  test("publishes an API field schema and the three-step customer website flow", () => {
    const config = _internal.publicConfig({
      publicKey: "tmcmf_test",
      name: "Conversation",
      subBrand: "tmc",
      durationMins: 30,
      bookingHorizonDays: 60,
      timezone: "Asia/Kolkata",
      embedFontFamily: "Inter",
      fieldsJson: JSON.stringify([
        { key: "designation", label: "Designation", type: "text", required: true, enabled: true, order: 2 },
      ]),
      confirmationMessage: "Confirmed",
    });
    expect(config.fields[0]).toMatchObject({ type: "select", options: expect.arrayContaining(["Principal", "Other"]) });
    expect(config.apiFields).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "firstName", required: true }),
      expect.objectContaining({ key: "lastName", required: true }),
      expect.objectContaining({ key: "designation", type: "select", options: expect.arrayContaining(["Principal", "Other"]) }),
      expect.objectContaining({ key: "school", required: true }),
      expect.objectContaining({ key: "email", type: "email" }),
      expect.objectContaining({ key: "phone", type: "tel", pattern: "[0-9]{7,15}" }),
    ]));
    expect(config.bookingFlow.steps).toEqual([
      expect.objectContaining({ id: "details", fields: ["firstName", "lastName", "designation", "school", "city"] }),
      expect.objectContaining({ id: "time", fields: ["selectedStartTime"] }),
      expect.objectContaining({ id: "contact", fields: ["email", "phone"] }),
    ]);
    expect(config.bookingSubmission).toMatchObject({
      method: "POST",
      endpointSuffix: "/book",
      slotField: "selectedStartTime",
      idempotencyKeyHeader: "Idempotency-Key",
      confirmationTokenPath: "booking.confirmationToken",
    });
  });

  test("publishes date-only booking boundaries for the hosted calendar", () => {
    const config = _internal.publicConfig({
      publicKey: "tmcmf_test",
      name: "Conversation",
      subBrand: "tmc",
      durationMins: 30,
      bookingHorizonDays: 60,
      allowedStartDate: new Date("2026-10-01T00:00:00.000Z"),
      allowedEndDate: new Date("2026-10-01T23:59:59.999Z"),
      timezone: "Asia/Kolkata",
      embedFontFamily: "Inter",
      fieldsJson: "[]",
      confirmationMessage: "Confirmed",
    });
    expect(config).toMatchObject({ allowedStartDate: "2026-10-01", allowedEndDate: "2026-10-01" });
  });

  test("forces Travel Meeting Forms to use Google Calendar", () => {
    const data = _internal.dataFromBody({ name: "Conversation", calendarProvider: "outlook" });
    expect(data.calendarProvider).toBe("google");
  });

  test("rejects an end date earlier than the configured start date", () => {
    let thrown;
    try {
      _internal.dataFromBody({
        name: "Conversation",
        timezone: "Asia/Kolkata",
        allowedStartDate: "2099-02-10",
        allowedEndDate: "2099-02-09",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      message: "End date cannot be earlier than start date",
      code: "INVALID_DATE_RANGE",
      status: 400,
    });
  });

  test("rejects an end date that is already in the past", () => {
    let thrown;
    try {
      _internal.dataFromBody({
        name: "Conversation",
        timezone: "Asia/Kolkata",
        allowedEndDate: "2000-01-01",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      message: "End date cannot be earlier than today",
      code: "END_DATE_IN_PAST",
      status: 400,
    });
  });

  test("keeps valid past blackout dates and removes duplicates when a form is saved", () => {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
    const tomorrow = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
    const data = _internal.dataFromBody({
      name: "Conversation",
      timezone: "UTC",
      blackoutDates: [yesterday, tomorrow, today, tomorrow, "not-a-date"],
    });
    expect(JSON.parse(data.blackoutDatesJson)).toEqual([yesterday, today, tomorrow]);
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
    expect(_internal.validateConfiguredFieldValues([field], { custom_value: value })).toMatchObject({
      error: "Correct the highlighted form fields",
      code: "INVALID_FIELD_VALUE",
      fields: ["custom_value"],
    });
  });

  test("rejects URLs, malformed roles, and oversized phone numbers in canonical fields", () => {
    const fields = [
      { key: "designation", label: "Designation", type: "text", required: true },
      { key: "institution", label: "School / Institution", type: "text", required: true },
      { key: "contactPhone", label: "Phone / WhatsApp", type: "tel", required: true },
    ];
    expect(_internal.validateConfiguredFieldValues(fields, {
      designation: "feafgnrf4w4rt",
      institution: "https://crm.example.com/embed/meeting-form.html",
      contactPhone: "4123445676778876878787",
    })).toMatchObject({
      error: "Correct the highlighted form fields",
      code: "INVALID_FIELD_VALUE",
      fields: ["designation", "institution", "contactPhone"],
      fieldErrors: {
        designation: expect.stringMatching(/valid role or title/i),
        institution: expect.stringMatching(/cannot be a URL/i),
        contactPhone: expect.stringMatching(/7 to 15 digits/i),
      },
    });
  });

  test("accepts international identity values and properly formatted contact details", () => {
    const fields = [
      { key: "contactName", label: "Full Name", type: "text", required: true },
      { key: "designation", label: "Designation", type: "text", required: true },
      { key: "institution", label: "School / Institution", type: "text", required: true },
      { key: "city", label: "City", type: "text", required: true },
      { key: "contactEmail", label: "Work Email", type: "email", required: true },
      { key: "contactPhone", label: "Phone / WhatsApp", type: "tel", required: true },
    ];
    expect(_internal.validateConfiguredFieldValues(fields, {
      contactName: "ನಿಲೇಶ್ ನಾಯಕ್",
      designation: "K-12 Coordinator",
      institution: "St. Joseph's School",
      city: "ಬೆಂಗಳೂರು",
      contactEmail: "teacher@example.edu",
      contactPhone: "919876543210",
    })).toBeNull();
  });

  test("accepts a normal school name and rejects formatted or alphabetic phone input", () => {
    const fields = [
      { key: "institution", label: "School / Institution", type: "text", required: true },
      { key: "contactPhone", label: "Phone / WhatsApp", type: "tel", required: true },
    ];
    expect(_internal.validateConfiguredFieldValues(fields, {
      institution: "Chennai Public School",
      contactPhone: "9876543210",
    })).toBeNull();
    for (const contactPhone of ["98765abc10", "+91 98765 43210", "98765-43210"]) {
      expect(_internal.validateConfiguredFieldValues(fields, {
        institution: "Chennai Public School",
        contactPhone,
      })).toMatchObject({
        code: "INVALID_FIELD_VALUE",
        fields: ["contactPhone"],
        fieldErrors: { contactPhone: expect.stringMatching(/only 7 to 15 digits/i) },
      });
    }
  });
});
