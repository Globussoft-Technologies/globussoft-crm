import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import WhatsAppMetaConfigCard from "../components/WhatsAppMetaConfigCard";

const fetchApiMock = vi.fn();

vi.mock("../utils/api", () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

const savedState = {
  configured: true,
  status: { status: "DISCONNECTED", label: "Inactive", reason: "Re-validation required" },
  config: {
    phoneNumberId: "1410844745445051",
    businessAccountId: "2570080940085215",
    appId: "1144255987952419",
    appSecret: { configured: true, last4: "****8cd7" },
    accessToken: { configured: true, last4: "****UOan" },
    webhookVerifyToken: { configured: true, last4: "****oken" },
  },
  meta: { metaBusinessId: "1525787951959331" },
  ours: { callbackUrl: "https://crm.example.com/api/whatsapp/webhook", callbackUrlConfigured: true },
};

describe("<WhatsAppMetaConfigCard />", () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation((url, options) => {
      if (url === "/api/whatsapp/config/status") return Promise.resolve(savedState);
      if (url === "/api/whatsapp/config/meta_cloud/connect" && options?.method === "POST") {
        return Promise.resolve({ success: true, meta: { displayPhoneNumber: "+1 555 651 2614" } });
      }
      return Promise.resolve({});
    });
  });

  it("shows every required generic-CRM Meta credential and masks saved secrets", async () => {
    render(<WhatsAppMetaConfigCard />);

    expect(await screen.findByLabelText(/Meta App ID/)).toHaveValue("1144255987952419");
    expect(screen.getByLabelText(/Meta App Secret/)).toHaveValue("****8cd7");
    expect(screen.getByLabelText(/Access token/)).toHaveValue("****UOan");
    expect(screen.getByLabelText(/Webhook verify token/)).toHaveValue("****oken");
    expect(screen.getByText("Meta App ID").parentElement).toHaveTextContent("*");
    expect(screen.getByText("Meta App Secret").parentElement).toHaveTextContent("*");
  });

  it("submits App ID and App Secret through the tenant connect endpoint", async () => {
    const user = userEvent.setup();
    render(<WhatsAppMetaConfigCard />);
    const secret = await screen.findByLabelText(/Meta App Secret/);

    await user.clear(secret);
    await user.type(secret, "replacement-app-secret");
    await user.click(screen.getByRole("button", { name: /Validate & Connect/i }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([url, options]) =>
        url === "/api/whatsapp/config/meta_cloud/connect" && options?.method === "POST");
      const body = JSON.parse(call[1].body);
      expect(body.appId).toBe("1144255987952419");
      expect(body.appSecret).toBe("replacement-app-secret");
    });
  });
});
