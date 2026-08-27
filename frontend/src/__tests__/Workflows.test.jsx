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
  updatedAt: "2026-08-20T00:00:00.000Z",
  lastRunAt: "2026-08-25T09:30:00.000Z",
  sortOrder: 0,
  lastError: null,
  autoDisabledAt: null,
  nextScheduledAt: null,
};

beforeEach(() => {
  fetchApiMock.mockReset();
  notify.error.mockReset();
  notify.success.mockReset();
  notify.info.mockReset();
  // The builder resolves email templates, sequences and assignable users so
  // the action config uses real pickers instead of free-text ID boxes.
  fetchApiMock.mockImplementation((path) => mockApi(path));
});

/**
 * Path-based mock router.
 *
 * These used to be expressed as `mockResolvedValueOnce(...)` chains, which bind
 * a response to a CALL INDEX rather than to a URL. That made every test
 * silently dependent on how many requests the page happens to fire on mount —
 * adding the GET /api/workflows/schema catalogue request shifted every queued
 * value by one and handed the email-template picker an object to `.map` over.
 * Routing on the path keeps the tests honest about what they are stubbing.
 */
function mockApi(path, overrides = {}) {
  if (Object.prototype.hasOwnProperty.call(overrides, path)) {
    return Promise.resolve(overrides[path]);
  }
  // null → the builder keeps its built-in fallback catalogue.
  if (path === "/api/workflows/schema") return Promise.resolve(null);
  if (path === "/api/workflows/email-templates") return Promise.resolve([{ id: 4, name: "Welcome email" }]);
  if (path === "/api/workflows/sequences") return Promise.resolve([{ id: 8, name: "Nurture", isActive: true }]);
  if (path === "/api/workflows/assignees") return Promise.resolve([{ id: 11, name: "Ada" }, { id: 12, name: "Grace" }]);
  if (path === "/api/workflows/stats/actions") return Promise.resolve({});
  return Promise.resolve([existingWorkflow]);
}

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
    fetchApiMock.mockImplementation((path, options) => (path === "/api/workflows" && options?.method === "POST"
      ? Promise.resolve({ id: 8, ...existingWorkflow, isActive: false })
      : mockApi(path, { "/api/workflows": [] })));
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
    fetchApiMock.mockImplementation((path) => mockApi(path, {
      "/api/workflows/7/toggle": { ...existingWorkflow, isActive: false },
    }));
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
    fetchApiMock.mockImplementation((path) => mockApi(path, {
      "/api/workflows/test-webhook": { success: true, result: { status: 202 } },
    }));
    await user.click(screen.getByRole("button", { name: /test this webhook/i }));

    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith("/api/workflows/test-webhook", expect.objectContaining({ method: "POST" })));
    expect(notify.success).toHaveBeenCalledWith("Webhook responded with HTTP 202");
    await user.click(screen.getByRole("button", { name: /save settings/i }));
    expect(screen.queryByRole("dialog", { name: "Webhook settings" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Action 1 webhook URL" })).toHaveValue("https://hooks.example.com/meta-feedback");
  });

  // ── Parity-wave coverage ─────────────────────────────────────────────

  it("shows real last-updated / last-run timestamps instead of 'Not run yet'", async () => {
    // The row rendered `updatedAt || createdAt` against a model that carried
    // NEITHER column, so every workflow permanently read "Not run yet".
    render(<Workflows />);
    await screen.findByRole("button", { name: "Welcome new leads" });
    expect(screen.getByText(/Last updated/)).toBeInTheDocument();
    expect(screen.queryByText(/Last run never/)).not.toBeInTheDocument();
  });

  it("surfaces an auto-disabled workflow in the editor instead of leaving it a mystery", async () => {
    const user = userEvent.setup();
    fetchApiMock.mockImplementation((path) => {
      if (path === "/api/workflows") {
        return Promise.resolve([{
          ...existingWorkflow,
          isActive: false,
          autoDisabledAt: "2026-08-26T00:00:00.000Z",
          consecutiveFailures: 10,
          lastError: "Webhook responded 500",
        }]);
      }
      return Promise.resolve([]);
    });
    render(<Workflows />);
    await user.click(await screen.findByRole("button", { name: "Welcome new leads" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/paused automatically/i);
    expect(alert).toHaveTextContent(/Webhook responded 500/);
  });

  it("offers the operators that were implemented but unreachable from the builder", async () => {
    // `nin` and `exists` worked in the engine and passed API validation but
    // were missing from the operator dropdown, so nobody could select them.
    const user = userEvent.setup();
    render(<Workflows />);
    await user.click(screen.getByRole("button", { name: /create workflow/i }));
    const operators = screen.getByRole("combobox", { name: "Condition 1 operator 1" });
    const values = Array.from(operators.options).map((option) => option.value);
    expect(values).toEqual(expect.arrayContaining([
      "exists", "not_exists", "nin", "changed", "changed_to", "changed_from",
      "date_within_next", "endsWith",
    ]));
  });

  it("hides the value box for operators that take no operand", async () => {
    const user = userEvent.setup();
    render(<Workflows />);
    await user.click(screen.getByRole("button", { name: /create workflow/i }));
    expect(screen.getByRole("textbox", { name: "Condition 1 value 1" })).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "Condition 1 operator 1" }), "not_exists");
    expect(screen.queryByRole("textbox", { name: "Condition 1 value 1" })).not.toBeInTheDocument();
    expect(screen.getByText(/no value needed/i)).toBeInTheDocument();
  });

  it("exposes deal stage-change fields so 'changed from X to Y' is buildable", async () => {
    // fromStage/toStage rode on every deal.stage_changed payload but were
    // absent from the field list, making the condition impossible to express.
    const user = userEvent.setup();
    render(<Workflows />);
    await user.click(screen.getByRole("button", { name: /create workflow/i }));
    await user.click(screen.getByRole("button", { name: "Deals" }));
    const fields = screen.getByRole("combobox", { name: "Condition 1 field 1" });
    const values = Array.from(fields.options).map((option) => option.value);
    expect(values).toEqual(expect.arrayContaining(["fromStage", "toStage"]));
  });

  it("builds a time-based workflow and posts its schedule", async () => {
    // Time-based triggers are the half of the feature that did not exist:
    // every trigger was record-event driven.
    const user = userEvent.setup();
    render(<Workflows />);
    await user.click(screen.getByRole("button", { name: /create workflow/i }));
    await user.click(screen.getByRole("button", { name: "Deals" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Workflow trigger" }), "schedule.date_field");

    expect(screen.getByRole("combobox", { name: "Schedule date field" })).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "Schedule offset direction" }), "before");

    await user.click(screen.getByRole("button", { name: /save as draft/i }));
    await waitFor(() => expect(
      fetchApiMock.mock.calls.some(([path, options]) => path === "/api/workflows" && options?.method === "POST"),
    ).toBe(true));

    const call = fetchApiMock.mock.calls.find(([path, options]) => path === "/api/workflows" && options?.method === "POST");
    const body = JSON.parse(call[1].body);
    expect(body.triggerType).toBe("schedule.date_field");
    expect(body.scheduleConfig).toMatchObject({ mode: "date_field", entity: "deal" });
  });

  it("clears the schedule when a rule is converted back to an event trigger", async () => {
    const user = userEvent.setup();
    render(<Workflows />);
    await user.click(screen.getByRole("button", { name: /create workflow/i }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Workflow trigger" }), "schedule.recurring");
    expect(screen.getByRole("combobox", { name: "Schedule frequency" })).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "Workflow trigger" }), "contact.created");
    expect(screen.queryByRole("combobox", { name: "Schedule frequency" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /save as draft/i }));
    const call = await waitFor(() => {
      const found = fetchApiMock.mock.calls.find(([path, options]) => path === "/api/workflows" && options?.method === "POST");
      expect(found).toBeTruthy();
      return found;
    });
    expect(JSON.parse(call[1].body).scheduleConfig).toBeNull();
  });

  it("offers the new action types with real pickers rather than raw ID boxes", async () => {
    const user = userEvent.setup();
    render(<Workflows />);
    await user.click(screen.getByRole("button", { name: /create workflow/i }));
    const actions = screen.getByRole("combobox", { name: "Action 1" });
    const values = Array.from(actions.options).map((option) => option.value);
    expect(values).toEqual(expect.arrayContaining([
      "add_tag", "remove_tag", "create_appointment", "create_deal",
      "add_to_sequence", "wait", "delete_record",
    ]));

    await user.selectOptions(actions, "add_to_sequence");
    const picker = await screen.findByRole("combobox", { name: "Action 1 sequence" });
    expect(Array.from(picker.options).map((option) => option.textContent)).toContain("Nurture");
  });

  it("offers owner-rotation modes for assign_agent", async () => {
    // Ownership used to be a single hardcoded user ID — no rotation at all.
    const user = userEvent.setup();
    render(<Workflows />);
    await user.click(screen.getByRole("button", { name: /create workflow/i }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Action 1" }), "assign_agent");
    const mode = await screen.findByRole("combobox", { name: "Action 1 assignment mode" });
    const values = Array.from(mode.options).map((option) => option.value);
    expect(values).toEqual(["specific", "round_robin", "least_busy", "record_owner"]);

    await user.selectOptions(mode, "round_robin");
    expect(await screen.findByRole("listbox", { name: "Action 1 assignee pool" })).toBeInTheDocument();
  });

  it("requires a delete_record confirmation before it can do anything", async () => {
    const user = userEvent.setup();
    render(<Workflows />);
    await user.click(screen.getByRole("button", { name: /create workflow/i }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Action 1" }), "delete_record");
    const confirm = await screen.findByRole("checkbox", { name: "Action 1 delete confirmation" });
    expect(confirm).not.toBeChecked();
  });

  it("fetches history server-side, scoped to the workflow", async () => {
    // The old panel pulled the last 50 rows for the WHOLE tenant and filtered
    // client-side, so a real workflow's history often rendered empty.
    const user = userEvent.setup();
    fetchApiMock.mockImplementation((path) => {
      if (String(path).startsWith("/api/workflows/history")) {
        return Promise.resolve({
          total: 1,
          logs: [{
            id: 1, workflowId: 7, actionType: "send_email", triggerType: "contact.created",
            status: "SUCCESS", contactLabel: "Ada Lovelace", durationMs: 12,
            createdAt: "2026-08-26T10:00:00.000Z", error: null, isTest: false,
          }],
        });
      }
      if (path === "/api/workflows") return Promise.resolve([existingWorkflow]);
      return Promise.resolve([]);
    });

    render(<Workflows />);
    await user.click(await screen.findByRole("button", { name: /view history/i }));

    await waitFor(() => expect(
      fetchApiMock.mock.calls.some(([path]) => String(path).includes("workflowId=7")),
    ).toBe(true));
    expect(await screen.findByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("Successful")).toBeInTheDocument();
  });

  it("previews 'apply to existing records' before firing anything", async () => {
    // Nobody should discover the blast radius by emailing 4,000 contacts.
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    fetchApiMock.mockImplementation((path, options) => {
      if (path === "/api/workflows/7/run-now") {
        return Promise.resolve({ matched: 12, message: "12 of 40 existing contact records match.", dryRun: JSON.parse(options.body).dryRun });
      }
      if (path === "/api/workflows") return Promise.resolve([existingWorkflow]);
      return Promise.resolve([]);
    });

    render(<Workflows />);
    await user.click(await screen.findByRole("button", { name: /actions for welcome new leads/i }));
    await user.click(await screen.findByRole("button", { name: /apply to existing records/i }));

    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    const runCalls = fetchApiMock.mock.calls.filter(([path]) => path === "/api/workflows/7/run-now");
    // Declining the confirm must NOT fire a second, non-dry-run call.
    expect(runCalls).toHaveLength(1);
    expect(JSON.parse(runCalls[0][1].body).dryRun).toBe(true);
    confirmSpy.mockRestore();
  });
});
