import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const fetchApiMock = vi.fn();
vi.mock("../utils/api", () => ({ fetchApi: (...args) => fetchApiMock(...args) }));

const notify = { error: vi.fn(), info: vi.fn(), success: vi.fn(), confirm: vi.fn() };
vi.mock("../utils/notify", () => ({ useNotify: () => notify }));

import Workflows from "../pages/Workflows";

const existingWorkflow = {
  id: 7,
  name: "Welcome new leads",
  triggerType: "contact.created",
  actionType: "send_email",
  targetState: JSON.stringify({ module: "contact", actions: [{ type: "send_email", config: {} }] }),
  condition: null,
  isActive: true,
  createdAt: "2026-08-01T00:00:00.000Z",
};

beforeEach(() => {
  fetchApiMock.mockReset();
  notify.error.mockReset();
  notify.success.mockReset();
  fetchApiMock.mockResolvedValue([existingWorkflow]);
});

describe("Workflows page", () => {
  it("loads the workflow directory and exposes status controls", async () => {
    render(<Workflows />);
    expect(await screen.findByRole("heading", { name: "All workflows" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Welcome new leads" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /disable welcome new leads/i })).toBeInTheDocument();
    expect(fetchApiMock).toHaveBeenCalledWith("/api/workflows");
  });

  it("opens the Freshsales-style builder with modules, conditions, and actions", async () => {
    const user = userEvent.setup();
    render(<Workflows />);
    await user.click(screen.getByRole("button", { name: /create workflow/i }));
    expect(screen.getByRole("textbox", { name: "Workflow name" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Contacts" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /what conditions should be met/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /what actions should be executed/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add group/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add action/i })).toBeInTheDocument();
  });

  it("supports template categories and opens a template in the builder", async () => {
    const user = userEvent.setup();
    render(<Workflows />);
    await user.click(screen.getByRole("button", { name: /qualify leads/i }));
    expect(await screen.findByRole("heading", { name: /selecting a workflow template/i })).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: /use template/i })[0]);
    expect(screen.getByRole("textbox", { name: "Workflow name" })).toHaveValue("Change contact status to Interested");
  });

  it("saves a new workflow as an inactive draft and enables it explicitly", async () => {
    const user = userEvent.setup();
    fetchApiMock.mockResolvedValueOnce([]).mockResolvedValueOnce({ id: 8, ...existingWorkflow, isActive: false });
    render(<Workflows />);
    await user.click(screen.getByRole("button", { name: /create workflow/i }));
    const name = screen.getByRole("textbox", { name: "Workflow name" });
    await user.clear(name);
    await user.type(name, "Notify new leads");
    await user.click(screen.getByRole("button", { name: /save as draft/i }));
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith("/api/workflows", expect.objectContaining({ method: "POST" })));
    const draftCall = fetchApiMock.mock.calls.find(([path, options]) => path === "/api/workflows" && options?.method === "POST");
    const body = JSON.parse(draftCall[1].body);
    expect(body.name).toBe("Notify new leads");
    expect(body.isActive).toBe(false);
    expect(JSON.parse(body.condition).groups).toHaveLength(1);
    expect(notify.success).toHaveBeenCalledWith("Workflow saved as draft");
  });

  it("calls the existing tenant-scoped toggle endpoint", async () => {
    const user = userEvent.setup();
    fetchApiMock.mockResolvedValueOnce([existingWorkflow]).mockResolvedValueOnce({ ...existingWorkflow, isActive: false });
    render(<Workflows />);
    await user.click(await screen.findByRole("button", { name: /disable welcome new leads/i }));
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith("/api/workflows/7/toggle", { method: "PUT" }));
  });

  it("configures and tests a webhook action", async () => {
    const user = userEvent.setup();
    render(<Workflows />);
    await user.click(screen.getByRole("button", { name: /create workflow/i }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Action 1" }), "send_webhook");
    await user.click(screen.getByRole("button", { name: /edit webhook settings/i }));

    expect(screen.getByRole("dialog", { name: "Webhook settings" })).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Webhook callback URL" }), "https://hooks.example.com/meta-feedback");
    await user.click(screen.getByRole("button", { name: /add custom header/i }));
    await user.type(screen.getByRole("textbox", { name: "Webhook header 1 name" }), "X-Webhook-Secret");
    await user.type(screen.getByLabelText("Webhook header 1 value"), "secret-value");
    fetchApiMock.mockResolvedValueOnce({ success: true, result: { status: 202 } });
    await user.click(screen.getByRole("button", { name: /test this webhook/i }));

    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith("/api/workflows/test-webhook", expect.objectContaining({ method: "POST" })));
    expect(notify.success).toHaveBeenCalledWith("Webhook responded with HTTP 202");
    await user.click(screen.getByRole("button", { name: /save settings/i }));
    expect(screen.queryByRole("dialog", { name: "Webhook settings" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Action 1 webhook URL" })).toHaveValue("https://hooks.example.com/meta-feedback");
  });
});
