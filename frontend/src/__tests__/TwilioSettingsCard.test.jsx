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

  it("opens the generic settings dialog outside the narrow content pane without saving on cancel", async () => {
    const user = userEvent.setup();
    const { container } = render(<TwilioSettingsCard portalDialogs />);
    await screen.findByDisplayValue("+17372508034");
    await user.click(screen.getByRole("button", { name: "Rotate Auth Token" }));
    const dialog = screen.getByRole("dialog");
    expect(document.body).toContainElement(dialog);
    expect(container).not.toContainElement(dialog);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(fetchApiMock.mock.calls.some(([, options]) => options?.method === "PUT")).toBe(false);
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

  it("reports saved Twilio state without treating draft changes as disconnected", async () => {
    const user = userEvent.setup();
    const onConnectionStatusChange = vi.fn();
    let stored = { ...savedConfig };
    fetchApiMock.mockImplementation((url, options) => {
      if (url === "/api/sms/config") return Promise.resolve([stored]);
      if (url === "/api/sms/config/twilio" && options?.method === "PUT") stored = { ...stored, ...JSON.parse(options.body) };
      return Promise.resolve({});
    });
    render(<TwilioSettingsCard onConnectionStatusChange={onConnectionStatusChange} />);
    await waitFor(() => expect(onConnectionStatusChange).toHaveBeenLastCalledWith({ ready: true, loading: false }));
    await user.click(screen.getByRole("checkbox", { name: "Enable" }));
    expect(onConnectionStatusChange).toHaveBeenLastCalledWith({ ready: true, loading: false });
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onConnectionStatusChange).toHaveBeenLastCalledWith({ ready: false, loading: false }));
  });

  it("reports unknown status when the Twilio configuration cannot be loaded", async () => {
    const onConnectionStatusChange = vi.fn();
    fetchApiMock.mockRejectedValue(new Error("Unavailable"));
    render(<TwilioSettingsCard onConnectionStatusChange={onConnectionStatusChange} />);
    await waitFor(() => expect(onConnectionStatusChange).toHaveBeenLastCalledWith({ ready: null, loading: false }));
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
