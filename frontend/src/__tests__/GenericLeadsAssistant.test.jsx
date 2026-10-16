import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import GenericLeadsAssistant from "../components/GenericLeadsAssistant";
import { fetchApi, getAuthToken } from "../utils/api";

vi.mock("../utils/api", () => ({ fetchApi: vi.fn(), getAuthToken: vi.fn() }));

describe("GenericLeadsAssistant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAuthToken.mockReturnValue("test-token");
    window.localStorage.clear();
  });

  it("is not rendered for non-generic tenants", () => {
    render(<GenericLeadsAssistant isGeneric={false} />);
    expect(screen.queryByTestId("generic-leads-assistant-fab")).not.toBeInTheDocument();
  });

  it("answers greetings immediately without showing CRM loading or calling the API", () => {
    render(<GenericLeadsAssistant isGeneric />);
    fireEvent.click(screen.getByTestId("generic-leads-assistant-fab"));
    fireEvent.change(screen.getByTestId("generic-leads-assistant-input"), { target: { value: "hi" } });
    fireEvent.click(screen.getByTestId("generic-leads-assistant-send"));

    expect(screen.getByText("Hi! How can I help you with your leads today?")).toBeInTheDocument();
    expect(screen.queryByText("Checking CRM data…")).not.toBeInTheDocument();
    expect(fetchApi).not.toHaveBeenCalled();
  });

  it.each([
    ["How are you?", "I'm doing well, thank you! How can I help you with your leads, deals, or pipelines today?"],
    ["Who are you?", "I'm your Leads assistant. I can help you find leads, answer questions about records, filter the Leads view, and prepare reports."],
  ])("answers normal conversation locally without CRM loading: %s", (prompt, reply) => {
    render(<GenericLeadsAssistant isGeneric />);
    fireEvent.click(screen.getByTestId("generic-leads-assistant-fab"));
    fireEvent.change(screen.getByTestId("generic-leads-assistant-input"), { target: { value: prompt } });
    fireEvent.click(screen.getByTestId("generic-leads-assistant-send"));

    expect(screen.getByText(reply)).toBeInTheDocument();
    expect(screen.queryByText("Checking CRM dataâ€¦")).not.toBeInTheDocument();
    expect(fetchApi).not.toHaveBeenCalled();
  });

  it("does not offer an empty report when a filter has no matches", async () => {
    fetchApi.mockResolvedValueOnce({
      reply: "I found 0 leads matching your request.",
      filterSpec: { nameStartsWith: "Z" },
      matchCount: 0,
    });
    render(<GenericLeadsAssistant isGeneric />);
    fireEvent.click(screen.getByTestId("generic-leads-assistant-fab"));
    fireEvent.change(screen.getByTestId("generic-leads-assistant-input"), { target: { value: "show leads whose names start with Z" } });
    fireEvent.click(screen.getByTestId("generic-leads-assistant-send"));

    await waitFor(() => expect(screen.getByText("I found 0 leads matching your request.")).toBeInTheDocument());
    expect(screen.queryByText("Matching leads report")).not.toBeInTheDocument();
    expect(screen.queryByTestId("generic-leads-assistant-download-xlsx")).not.toBeInTheDocument();
    expect(screen.queryByTestId("generic-leads-assistant-download-pdf")).not.toBeInTheDocument();
  });

  it("shows a direct lead field answer in chat without turning it into a report", async () => {
    fetchApi.mockResolvedValueOnce({
      reply: "Asha Rao\nEmail: asha@example.com",
      filterSpec: { search: "Asha Rao" },
      matchCount: 1,
      directAnswer: true,
    });
    render(<GenericLeadsAssistant isGeneric />);
    fireEvent.click(screen.getByTestId("generic-leads-assistant-fab"));
    fireEvent.change(screen.getByTestId("generic-leads-assistant-input"), { target: { value: "tell me the email id of Asha Rao" } });
    fireEvent.click(screen.getByTestId("generic-leads-assistant-send"));

    await waitFor(() => expect(screen.getByText(/Email: asha@example.com/)).toBeInTheDocument());
    expect(screen.queryByText("Matching leads report")).not.toBeInTheDocument();
  });

  it("opens, sends the current lead context, and applies CRM filters automatically", async () => {
    fetchApi.mockResolvedValueOnce({
      reply: "I found one unassigned lead.",
      records: [{ id: 42, name: "Asha Rao", email: "asha@example.com" }],
      filterSpec: { unassigned: true },
    });
    const applyFilters = vi.fn();
    render(
      <GenericLeadsAssistant
        isGeneric
        selectedLeadId={42}
        activeFilters={{ search: "asha", assignee: "" }}
        onApplyFilters={applyFilters}
      />,
    );

    fireEvent.click(screen.getByTestId("generic-leads-assistant-fab"));
    expect(screen.getByTestId("generic-leads-assistant-panel")).toHaveStyle({ background: "#ffffff" });
    expect(screen.getByText("Welcome! How can I help you with your leads today?")).toBeInTheDocument();
    expect(screen.getByTestId("generic-leads-assistant-send")).toHaveStyle({ minWidth: "44px", height: "42px" });
    fireEvent.change(screen.getByTestId("generic-leads-assistant-input"), { target: { value: "show unassigned leads" } });
    fireEvent.click(screen.getByTestId("generic-leads-assistant-send"));

    await waitFor(() => expect(screen.getByText("I found one unassigned lead.")).toBeInTheDocument());
    expect(fetchApi).toHaveBeenCalledWith("/api/leads-assistant/message", expect.objectContaining({
      method: "POST",
      body: expect.stringContaining('"selectedLeadId":42'),
    }));
    expect(screen.queryByText("Asha Rao")).not.toBeInTheDocument();
    await waitFor(() => expect(applyFilters).toHaveBeenCalledWith({ unassigned: true }));
    expect(screen.queryByRole("button", { name: /apply to leads view/i })).not.toBeInTheDocument();
  });

  it("clears the Leads table filters when the assistant resets filters", async () => {
    fetchApi.mockResolvedValueOnce({
      reply: "I found 9 leads matching your request.",
      report: { reportType: "summary", filters: {}, totalLeads: 9 },
      filterSpec: { hasCompany: true },
      clearFilters: true,
    });
    const applyFilters = vi.fn();
    render(<GenericLeadsAssistant isGeneric onApplyFilters={applyFilters} />);

    fireEvent.click(screen.getByTestId("generic-leads-assistant-fab"));
    fireEvent.change(screen.getByTestId("generic-leads-assistant-input"), { target: { value: "reset filter" } });
    fireEvent.click(screen.getByTestId("generic-leads-assistant-send"));

    await waitFor(() => expect(screen.getByText("I found 9 leads matching your request.")).toBeInTheDocument());
    expect(applyFilters).toHaveBeenCalledWith({});
  });

  it("restores the conversation after the Leads page is unmounted and mounted again", async () => {
    fetchApi.mockResolvedValueOnce({ reply: "There are 9 leads in the CRM." });
    const sessionStorageKey = "generic-leads-assistant-session.1.7";
    const firstRender = render(<GenericLeadsAssistant isGeneric sessionStorageKey={sessionStorageKey} />);

    fireEvent.click(screen.getByTestId("generic-leads-assistant-fab"));
    fireEvent.change(screen.getByTestId("generic-leads-assistant-input"), { target: { value: "how many leads are there?" } });
    fireEvent.click(screen.getByTestId("generic-leads-assistant-send"));
    await waitFor(() => expect(screen.getByText("There are 9 leads in the CRM.")).toBeInTheDocument());

    firstRender.unmount();
    render(<GenericLeadsAssistant isGeneric sessionStorageKey={sessionStorageKey} />);
    fireEvent.click(screen.getByTestId("generic-leads-assistant-fab"));

    expect(screen.getByText("how many leads are there?")).toBeInTheDocument();
    expect(screen.getByText("There are 9 leads in the CRM.")).toBeInTheDocument();
  });

  it("dismisses and clears the assistant after logout", async () => {
    const sessionStorageKey = "generic-leads-assistant-session.1.7";
    window.localStorage.setItem(sessionStorageKey, JSON.stringify({
      messages: [
        { role: "assistant", content: "Previous account conversation" },
      ],
      pendingAction: null,
    }));
    render(<GenericLeadsAssistant isGeneric sessionStorageKey={sessionStorageKey} />);

    fireEvent.click(screen.getByTestId("generic-leads-assistant-fab"));
    expect(screen.getByText("Previous account conversation")).toBeInTheDocument();

    window.dispatchEvent(new Event("crm:auth-logout"));

    await waitFor(() => expect(screen.queryByTestId("generic-leads-assistant-panel")).not.toBeInTheDocument());
    expect(window.localStorage.getItem(sessionStorageKey)).toBeNull();
  });

  it("clears the conversation and keeps only the welcome message", async () => {
    fetchApi.mockResolvedValueOnce({ reply: "There are 9 leads in the CRM." });
    render(<GenericLeadsAssistant isGeneric sessionStorageKey="generic-leads-assistant-session.1.7" />);

    fireEvent.click(screen.getByTestId("generic-leads-assistant-fab"));
    fireEvent.change(screen.getByTestId("generic-leads-assistant-input"), { target: { value: "how many leads are there?" } });
    fireEvent.click(screen.getByTestId("generic-leads-assistant-send"));
    await waitFor(() => expect(screen.getByText("There are 9 leads in the CRM.")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /clear chat/i }));

    expect(screen.getByText("Welcome! How can I help you with your leads today?")).toBeInTheDocument();
    expect(screen.queryByText("how many leads are there?")).not.toBeInTheDocument();
    expect(screen.queryByText("There are 9 leads in the CRM.")).not.toBeInTheDocument();
  });

  it("shows a confirmation action and refreshes after confirmation", async () => {
    fetchApi
      .mockResolvedValueOnce({
        reply: "I can move the deal after your confirmation.",
        pendingAction: { action: { type: "move_deal_stage", dealId: 9, stage: "negotiation" }, preview: {} },
      })
      .mockResolvedValueOnce({ message: "Moved the deal to negotiation.", refresh: true });
    const refresh = vi.fn();
    render(<GenericLeadsAssistant isGeneric onRefresh={refresh} />);

    fireEvent.click(screen.getByTestId("generic-leads-assistant-fab"));
    fireEvent.change(screen.getByTestId("generic-leads-assistant-input"), { target: { value: "move it to negotiation" } });
    fireEvent.click(screen.getByTestId("generic-leads-assistant-send"));
    await waitFor(() => expect(screen.getByTestId("generic-leads-assistant-confirmation")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /^confirm$/i }));
    await waitFor(() => expect(screen.getByText("Moved the deal to negotiation.")).toBeInTheDocument());
    expect(fetchApi).toHaveBeenLastCalledWith("/api/leads-assistant/confirm", expect.objectContaining({ method: "POST" }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("downloads a generated report in the selected format", async () => {
    fetchApi.mockResolvedValueOnce({
      reply: "Here is the lead report.",
      report: { reportType: "summary", filters: { missingEmail: true }, totalLeads: 4 },
    });
    const reportFetch = vi.fn().mockResolvedValue({ ok: true, blob: vi.fn().mockResolvedValue(new Blob(["report"])) });
    vi.stubGlobal("fetch", reportFetch);
    URL.createObjectURL = vi.fn(() => "blob:lead-report");
    URL.revokeObjectURL = vi.fn();
    render(<GenericLeadsAssistant isGeneric />);

    fireEvent.click(screen.getByTestId("generic-leads-assistant-fab"));
    fireEvent.change(screen.getByTestId("generic-leads-assistant-input"), { target: { value: "prepare a report" } });
    fireEvent.click(screen.getByTestId("generic-leads-assistant-send"));
    await waitFor(() => expect(screen.getByText("Here is the lead report.")).toBeInTheDocument());
    expect(screen.getByText(/I prepared a detailed summary report covering 4 matching leads/i)).toBeInTheDocument();
    expect(screen.getByText(/XLSX for spreadsheet analysis or PDF for a shareable document/i)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("generic-leads-assistant-download-xlsx"));
    await waitFor(() => expect(reportFetch).toHaveBeenCalledWith("/api/leads-assistant/report/export", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Bearer test-token" }),
      body: expect.stringContaining('"format":"xlsx"'),
    })));
  });

  it("can be dragged across the viewport without opening the assistant", async () => {
    render(<GenericLeadsAssistant isGeneric />);
    const fab = screen.getByTestId("generic-leads-assistant-fab");
    const initialLeft = Number.parseFloat(fab.style.left);
    const initialTop = Number.parseFloat(fab.style.top);

    fireEvent.pointerDown(fab, { pointerId: 1, button: 0, clientX: 1000, clientY: 700 });
    fireEvent.pointerMove(fab, { pointerId: 1, clientX: 600, clientY: 400 });
    fireEvent.pointerUp(fab, { pointerId: 1, clientX: 600, clientY: 400 });

    expect(Number.parseFloat(fab.style.left)).toBeLessThan(initialLeft);
    expect(Number.parseFloat(fab.style.top)).toBeLessThan(initialTop);
    expect(screen.queryByTestId("generic-leads-assistant-panel")).not.toBeInTheDocument();
    await waitFor(() => {
      const saved = JSON.parse(window.localStorage.getItem("generic-leads-assistant-position"));
      expect(saved.left).toBe(Number.parseFloat(fab.style.left));
      expect(saved.top).toBe(Number.parseFloat(fab.style.top));
    });
  });
});
