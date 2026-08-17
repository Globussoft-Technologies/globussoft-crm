import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  buildConfiguredBody,
  deliverConfiguredWebhook,
  validateWebhookUrl,
} = require("../../lib/webhookDelivery");

describe("configured workflow webhook delivery", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders an advanced JSON body and sends configured headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      statusText: "Accepted",
      text: vi.fn().mockResolvedValue("queued"),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await deliverConfiguredWebhook({
      url: "https://hooks.example.com/meta-feedback",
      method: "PATCH",
      encoding: "json",
      bodyMode: "advanced",
      bodyTemplate: JSON.stringify({ lead_id: "{{contactId}}", classification: "{{status}}", tags: "{{tags}}" }),
      headers: [{ key: "X-Webhook-Secret", value: "test-secret", secret: true }],
    }, "contact.updated", { contactId: 42, status: "Junk", tags: ["JUNK"] }, 7, "signing-secret");

    expect(result.status).toBe(202);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe("https://hooks.example.com/meta-feedback");
    expect(request.method).toBe("PATCH");
    expect(request.headers["X-Webhook-Secret"]).toBe("test-secret");
    expect(request.headers["X-Globussoft-Signature"]).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);
    expect(JSON.parse(request.body)).toEqual({ lead_id: 42, classification: "Junk", tags: ["JUNK"] });
  });

  it("builds a simple payload from only selected contact fields", () => {
    expect(buildConfiguredBody(
      { bodyMode: "simple", selectedFields: ["contactId", "status", "missing"] },
      "contact.updated",
      { contactId: 9, status: "Qualified", email: "lead@example.com" },
      1
    )).toEqual({ contactId: 9, status: "Qualified" });
  });

  it("rejects local callback URLs and unsafe transport headers", async () => {
    expect(() => validateWebhookUrl("http://127.0.0.1/internal")).toThrow(/private network/i);
    await expect(deliverConfiguredWebhook({
      url: "https://hooks.example.com/feedback",
      headers: [{ key: "Host", value: "internal" }],
    }, "contact.updated", {}, 1)).rejects.toThrow(/managed by the CRM/i);
  });

  it("surfaces non-success HTTP responses for workflow history", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: vi.fn().mockResolvedValue("bad secret"),
    }));

    await expect(deliverConfiguredWebhook({
      url: "https://hooks.example.com/feedback",
    }, "contact.updated", { contactId: 3 }, 1)).rejects.toMatchObject({
      message: expect.stringContaining("HTTP 401"),
      webhookResult: { ok: false, status: 401, response: "bad secret" },
    });
  });
});
