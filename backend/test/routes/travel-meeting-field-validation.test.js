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
