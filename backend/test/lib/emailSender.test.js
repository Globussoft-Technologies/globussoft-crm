import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createRequire } from "node:module";

const mocks = vi.hoisted(() => {
  const Module = require("node:module");
  const fromBackend = Module.createRequire(process.cwd() + "/");
  const travelSendGridPath = fromBackend.resolve("./services/travelSendGrid");
  const resolveSendGridConfig = vi.fn();
  Module._cache[travelSendGridPath] = {
    id: travelSendGridPath,
    filename: travelSendGridPath,
    loaded: true,
    exports: { resolveSendGridConfig },
    children: [],
    paths: [],
  };
  return { resolveSendGridConfig };
});
const { resolveSendGridConfig } = mocks;

const requireCJS = createRequire(import.meta.url);
const { sendEmail } = requireCJS("../../lib/emailSender");
const prisma = requireCJS("../../lib/prisma");
const originalTenantFindUnique = prisma.tenant.findUnique;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  resolveSendGridConfig.mockReset();
  globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
  prisma.tenant.findUnique = vi.fn();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  prisma.tenant.findUnique = originalTenantFindUnique;
});

describe("emailSender tenant SendGrid selection", () => {
  test("uses tenant credentials and sender identity when tenantId is supplied", async () => {
    resolveSendGridConfig.mockResolvedValue({
      apiKey: "SG.tenant.key",
      fromEmail: "bookings@travel.test",
      fromName: "Acme Travel",
      source: "tenant",
    });

    const result = await sendEmail({ tenantId: 73, to: "guest@example.test", subject: "Booked", text: "Confirmed" });

    expect(resolveSendGridConfig).toHaveBeenCalledWith(73);
    const [url, options] = globalThis.fetch.mock.calls[0];
    expect(url).toBe("https://api.sendgrid.com/v3/mail/send");
    expect(options.headers.Authorization).toBe("Bearer SG.tenant.key");
    expect(JSON.parse(options.body).from).toEqual({ email: "bookings@travel.test", name: "Acme Travel" });
    expect(result).toMatchObject({ sent: true, from: "bookings@travel.test", source: "tenant" });
  });

  test("does not fall back to backend credentials when a saved tenant config is invalid", async () => {
    resolveSendGridConfig.mockRejectedValue(new Error("decrypt failed"));
    const result = await sendEmail({ tenantId: 73, to: "guest@example.test", subject: "Booked", text: "Confirmed" });
    expect(result).toMatchObject({ sent: false, reason: "tenant_sendgrid_config_invalid", source: "tenant" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("keeps platform credentials when no tenant provider is configured", async () => {
    resolveSendGridConfig.mockResolvedValue({
      apiKey: "SG.platform.key",
      fromEmail: "noreply@crm.test",
      fromName: "Globus CRM",
      source: "backend",
    });

    const result = await sendEmail({ tenantId: 12, to: "user@example.test", subject: "Notice", text: "Hello" });

    const payload = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(payload.from).toEqual({ email: "noreply@crm.test", name: "Globus CRM" });
    expect(globalThis.fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer SG.platform.key");
    expect(result).toMatchObject({ sent: true, source: "backend" });
  });

  test("preserves cc, bcc, attachment, and explicit sender-name fields for tenant delivery", async () => {
    resolveSendGridConfig.mockResolvedValue({
      apiKey: "SG.tenant.key",
      fromEmail: "bookings@travel.test",
      fromName: "Stored Name",
      source: "tenant",
    });

    await sendEmail({
      tenantId: 73,
      to: "guest@example.test",
      cc: ["agent@example.test"],
      bcc: "audit@example.test",
      subject: "Voucher",
      text: "Attached",
      fromName: "Travel Desk",
      attachments: [{ filename: "voucher.pdf", content: "cGRm", type: "application/pdf" }],
    });

    const payload = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(payload.personalizations[0]).toEqual({
      to: [{ email: "guest@example.test" }],
      cc: [{ email: "agent@example.test" }],
      bcc: [{ email: "audit@example.test" }],
    });
    expect(payload.from).toEqual({ email: "bookings@travel.test", name: "Travel Desk" });
    expect(payload.attachments).toEqual([{
      content: "cGRm",
      filename: "voucher.pdf",
      type: "application/pdf",
      disposition: "attachment",
    }]);
  });

  test("uses the configured Generic organization name when sender name is missing", async () => {
    resolveSendGridConfig.mockResolvedValue({
      apiKey: "SG.generic.key",
      fromEmail: "verified@generic.test",
      fromName: "",
      source: "tenant",
    });
    prisma.tenant.findUnique.mockResolvedValue({ id: 91, vertical: "generic", name: "Configured Organization" });

    await sendEmail({ tenantId: 91, to: "lead@example.test", subject: "Hello", text: "Body", fromName: "" });

    const payload = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(payload.from).toEqual({ email: "verified@generic.test", name: "Configured Organization" });
    expect(payload.from.name).not.toBe("lead@example.test");
  });

  test("does not use contact data as the sender name", async () => {
    resolveSendGridConfig.mockResolvedValue({
      apiKey: "SG.generic.key",
      fromEmail: "verified@generic.test",
      fromName: "Configured Organization",
      source: "tenant",
    });

    await sendEmail({ tenantId: 91, to: "lead@example.test", subject: "Hello", text: "Body", fromName: "Configured Organization" });

    const payload = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(payload.from.name).toBe("Configured Organization");
    expect(payload.from.name).not.toBe("Lead Person");
  });
});
