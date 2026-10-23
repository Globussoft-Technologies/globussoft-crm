import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TwilioSettingsCard from "../components/TwilioSettingsCard";

const fetchApiMock = vi.fn();
const notifySuccess = vi.fn();

vi.mock("../utils/api", () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

vi.mock("../utils/notify", () => ({
  useNotify: () => ({ success: notifySuccess }),
}));

const savedConfig = {
  provider: "twilio",
  apiKey: { configured: true, last4: "acc0" },
  authToken: { configured: true, last4: "656b" },
  senderId: "+17372508034",
  isActive: true,
};

describe("<TwilioSettingsCard />", () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifySuccess.mockReset();
    fetchApiMock.mockImplementation((url, options) => {
      if (url === "/api/sms/config" && !options) return Promise.resolve([savedConfig]);
      if (url === "/api/sms/config/twilio" && options?.method === "PUT") {
        return Promise.resolve({ success: true, config: savedConfig });
      }
      return Promise.resolve([]);
    });
  });

  it("loads the existing Twilio record without exposing credentials", async () => {
    render(<TwilioSettingsCard />);

    expect(await screen.findByDisplayValue("+17372508034")).toBeInTheDocument();
    expect(screen.getByText("acc0")).toBeInTheDocument();
    expect(screen.getByText("656b")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Enable" })).toBeChecked();
  });

  it("saves the phone and enabled state through the existing Twilio endpoint", async () => {
    const user = userEvent.setup();
    render(<TwilioSettingsCard />);
    const phone = await screen.findByDisplayValue("+17372508034");

    await user.clear(phone);
    await user.type(phone, "+15551234567");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const put = fetchApiMock.mock.calls.find(([url, options]) =>
        url === "/api/sms/config/twilio" && options?.method === "PUT");
      expect(JSON.parse(put[1].body)).toEqual({
        provider: "twilio",
        senderId: "+15551234567",
        isActive: true,
      });
    });
  });

  it("rotates only the selected secret credential", async () => {
    const user = userEvent.setup();
    render(<TwilioSettingsCard />);
    await screen.findByDisplayValue("+17372508034");

    await user.click(screen.getByRole("button", { name: "Rotate Auth Token" }));
    await user.type(screen.getByLabelText("New Auth Token"), "replacement-token");
    await user.click(screen.getByRole("button", { name: "Save Auth Token" }));

    await waitFor(() => {
      const put = fetchApiMock.mock.calls.find(([url, options]) => {
        if (url !== "/api/sms/config/twilio" || options?.method !== "PUT") return false;
        return JSON.parse(options.body).authToken === "replacement-token";
      });
      expect(JSON.parse(put[1].body)).toEqual({
        provider: "twilio",
        isActive: true,
        authToken: "replacement-token",
      });
    });
  });
});
