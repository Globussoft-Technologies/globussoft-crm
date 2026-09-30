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
const originalFetch = globalThis.fetch;

beforeEach(() => {
  resolveSendGridConfig.mockReset();
  globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
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
});
