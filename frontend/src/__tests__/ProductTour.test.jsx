import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { AuthContext } from "../appContexts";
import ProductTourProvider from "../tours/TourContext";
import { useProductTour } from "../tours/useProductTour";
import { GENERIC_FEATURE_TOURS, findGenericFeatureForPath } from "../tours/genericFeatureRegistry";
import { GENERIC_TOUR_PROFILE_IDS } from "../tours/genericTourProfiles";
import { GENERIC_SECONDARY_WORKFLOW_TOURS } from "../tours/secondaryWorkflowTours";
import { mergeTourStates, readTourState, tourStorageKeyForTest } from "../tours/tourStorage";
import { ProductTourContext } from "../tours/productTourContext";
import ProductTourSettings from "../components/ProductTourSettings";
import { waitForTourTarget } from "../tours/tourStepActions";

const permissionState = {
  isOwner: false,
  isReady: true,
  hasPermission: () => true,
};

vi.mock("../hooks/usePermissions", () => ({
  usePermissions: () => permissionState,
}));

function Harness() {
  const tour = useProductTour();
  const location = useLocation();
  return (
    <div>
      <button type="button" onClick={tour.startCurrentTour}>Start current tour</button>
      <button type="button" onClick={() => tour.setPreferences({ enabled: false })}>Disable tours</button>
      <output data-testid="tour-enabled">{String(tour.preferences.enabled)}</output>
      <output data-testid="tour-available">{String(tour.isAvailable)}</output>
      <output data-testid="tour-location">{location.pathname}</output>
      <output data-testid="available-tour-ids">{tour.availableTours.map((item) => item.id).join(",")}</output>
      <nav data-tour="welcome-sidebar">
        <a href="/dashboard" data-tour-nav="/dashboard">Dashboard</a>
      </nav>
      <main data-tour="page-content">Contacts content</main>
    </div>
  );
}

function renderProvider({ vertical = "generic", role = "USER" } = {}) {
  return render(
    <AuthContext.Provider
      value={{
        user: { userId: 9, email: "agent@example.test", role },
        tenant: { id: 14, vertical },
        token: "test-token",
      }}
    >
      <MemoryRouter initialEntries={["/contacts"]}>
        <ProductTourProvider>
          <Harness />
        </ProductTourProvider>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

function TaskHarness() {
  return (
    <main data-tour="page-content">
      <header><h1>Task Queue</h1></header>
      <button type="button">Create task</button>
      <label>Search <input aria-label="Search tasks" /></label>
      <button type="button">Export CSV</button>
      <table><tbody><tr><td>Follow up</td></tr></tbody></table>
      <p>No tasks found</p>
    </main>
  );
}

function GmailHarness() {
  return (
    <main data-tour="page-content">
      <h1>Gmail</h1>
      <button type="button">Connect Gmail</button>
      <input aria-label="Search mail" />
    </main>
  );
}

function storedState() {
  return JSON.parse(
    localStorage.getItem(tourStorageKeyForTest(14, 9)) || "null",
  );
}

describe("generic product tours", () => {
  beforeEach(() => {
    localStorage.clear();
    permissionState.isOwner = false;
    permissionState.isReady = true;
    permissionState.hasPermission = () => true;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("registers every generic sidebar destination, including hard-coded omissions", () => {
    expect(GENERIC_FEATURE_TOURS).toHaveLength(91);
    expect(GENERIC_FEATURE_TOURS.map((tour) => tour.id)).toEqual(
      expect.arrayContaining(["adsgpt", "callified", "whatsapp", "lead-reports", "workflows"]),
    );
  });

  it("has a detailed capability profile for every module beyond the four hand-authored tours", () => {
    expect(GENERIC_TOUR_PROFILE_IDS).toHaveLength(71);
    const detailedTours = GENERIC_FEATURE_TOURS.filter(
      (tour) => !tour.secondary && !["dashboard", "contacts", "leads", "pipeline"].includes(tour.id),
    );
    expect(detailedTours.every((tour) => tour.steps.length >= 6)).toBe(true);
    expect(detailedTours.every((tour) => tour.steps.some((step) => step.title.startsWith("When ")))).toBe(true);
  });

  it("registers all dedicated secondary workflows and matches them before parent pages", () => {
    expect(GENERIC_SECONDARY_WORKFLOW_TOURS).toHaveLength(16);
    expect(GENERIC_SECONDARY_WORKFLOW_TOURS.map((tour) => tour.id)).toEqual(expect.arrayContaining([
      "contact-detail", "landing-site-builder", "sequence-builder", "custom-object-records",
      "staff-permissions", "profile", "profile-2fa", "lead-capture-settings",
      "lead-fields-settings", "gmail", "callified-data", "marketplace-leads",
      "shared-inbox", "subscription-management", "ai-subscription", "ai-usage",
    ]));
    expect(findGenericFeatureForPath("/contacts/42")?.id).toBe("contact-detail");
    expect(findGenericFeatureForPath("/contacts")?.id).toBe("contacts");
    expect(findGenericFeatureForPath("/landing-sites/builder/8")?.id).toBe("landing-site-builder");
    expect(findGenericFeatureForPath("/sequences/9/builder")?.id).toBe("sequence-builder");
    expect(findGenericFeatureForPath("/profile/2fa")?.id).toBe("profile-2fa");
    expect(findGenericFeatureForPath("/profile/permissions")).toBeNull();
  });

  it("generates workflow-specific anchors for secondary pages", async () => {
    render(
      <AuthContext.Provider value={{ user: { userId: 9, role: "USER" }, tenant: { id: 14, vertical: "generic" } }}>
        <MemoryRouter initialEntries={["/gmail"]}>
          <ProductTourProvider><GmailHarness /></ProductTourProvider>
        </MemoryRouter>
      </AuthContext.Provider>,
    );

    await waitFor(() => expect(screen.getByRole("button", { name: "Connect Gmail" }))
      .toHaveAttribute("data-tour", "gmail-connect"));
    expect(screen.getByLabelText("Search mail")).toHaveAttribute("data-tour", "gmail-search");
  });

  it("generates stable semantic anchors for legacy pages", async () => {
    render(
      <AuthContext.Provider value={{ user: { userId: 9, role: "USER" }, tenant: { id: 14, vertical: "generic" } }}>
        <MemoryRouter initialEntries={["/tasks"]}>
          <ProductTourProvider><TaskHarness /></ProductTourProvider>
        </MemoryRouter>
      </AuthContext.Provider>,
    );

    await waitFor(() => expect(screen.getByRole("heading", { name: "Task Queue" }).closest("header"))
      .toHaveAttribute("data-tour", "tasks-header"));
    expect(screen.getByRole("button", { name: "Create task" })).toHaveAttribute("data-tour", "tasks-primary");
    expect(screen.getByRole("button", { name: "Export CSV" })).toHaveAttribute("data-tour", "tasks-export");
    expect(screen.getByRole("table")).toHaveAttribute("data-tour", "tasks-records");
    expect(screen.getByText("No tasks found")).toHaveAttribute("data-tour", "tasks-empty");
  });

  it("starts the current page tour and records completion", () => {
    renderProvider();
    fireEvent.click(screen.getByRole("button", { name: "Start current tour" }));

    expect(screen.getByRole("dialog", { name: "Add a contact" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("dialog", { name: "Find the right contact" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("dialog", { name: "Manage contacts" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Finish" }));

    expect(screen.queryByTestId("product-tour-overlay")).not.toBeInTheDocument();
    expect(storedState().progress["contacts:1"].status).toBe("COMPLETED");
  });

  it("makes the background inert, announces step changes, and restores launcher focus", async () => {
    const view = renderProvider();
    const launcher = screen.getByRole("button", { name: "Start current tour" });
    launcher.focus();
    fireEvent.click(launcher);

    expect(view.container).toHaveAttribute("inert");
    expect(view.container).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Step 1 of 3: Add a contact");
    expect(screen.getByRole("dialog")).toHaveAttribute("data-tour-surface", "true");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("status")).toHaveTextContent("Step 2 of 3: Find the right contact");
    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(launcher).toHaveFocus());
    expect(view.container).not.toHaveAttribute("inert");
    expect(view.container).not.toHaveAttribute("aria-hidden");
  });

  it("waits long enough for an API-delayed tour target", async () => {
    const targetPromise = waitForTourTarget('[data-testid="delayed-tour-target"]');
    window.setTimeout(() => {
      const target = document.createElement("button");
      target.dataset.testid = "delayed-tour-target";
      target.getClientRects = () => [{ width: 10, height: 10 }];
      document.body.appendChild(target);
    }, 650);

    const target = await targetPromise;
    expect(target).not.toBeNull();
    target.remove();
  });

  it("uses reduced motion and keeps the card inside a high-zoom mobile viewport", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(320);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(360);
    renderProvider();
    fireEvent.click(screen.getByRole("button", { name: "Start current tour" }));

    const overlay = screen.getByTestId("product-tour-overlay");
    const dialog = screen.getByRole("dialog");
    expect(overlay).toHaveAttribute("data-tour-layout", "mobile");
    expect(dialog).toHaveStyle({ width: "288px", left: "16px", maxHeight: "calc(100vh - 32px)", transition: "none" });
    expect(Number.parseFloat(dialog.style.top)).toBeGreaterThanOrEqual(16);
  });

  it("dismisses only the active tour when Skip tour is selected", () => {
    renderProvider();
    fireEvent.click(screen.getByRole("button", { name: "Start current tour" }));
    fireEvent.click(screen.getByRole("button", { name: "Skip tour" }));

    expect(storedState().preferences.enabled).toBe(true);
    expect(storedState().progress["contacts:1"].status).toBe("DISMISSED");
  });

  it("closes a tour as resumable instead of marking it complete", () => {
    renderProvider();
    fireEvent.click(screen.getByRole("button", { name: "Start current tour" }));
    fireEvent.click(screen.getByRole("button", { name: "Close tour" }));

    expect(screen.queryByTestId("product-tour-overlay")).not.toBeInTheDocument();
    expect(storedState().progress["contacts:1"]).toMatchObject({
      status: "IN_PROGRESS",
      currentStep: 0,
    });
  });

  it("disables future tours when Skip all is selected", () => {
    renderProvider();
    fireEvent.click(screen.getByRole("button", { name: "Start current tour" }));
    fireEvent.click(screen.getByRole("button", { name: "Skip all" }));

    expect(screen.getByTestId("tour-enabled")).toHaveTextContent("false");
    expect(storedState().preferences.enabled).toBe(false);
    expect(screen.queryByTestId("product-tour-overlay")).not.toBeInTheDocument();
  });

  it("does not expose generic tours to another vertical", () => {
    renderProvider({ vertical: "travel" });
    expect(screen.getByTestId("tour-available")).toHaveTextContent("false");
    fireEvent.click(screen.getByRole("button", { name: "Start current tour" }));
    expect(screen.queryByTestId("product-tour-overlay")).not.toBeInTheDocument();
  });

  it("filters tours by role and resolved permissions", () => {
    permissionState.hasPermission = () => false;
    renderProvider({ role: "USER" });
    const ids = screen.getByTestId("available-tour-ids").textContent.split(",");
    expect(ids).toContain("tasks");
    expect(ids).not.toContain("settings");
    expect(ids).not.toContain("data-import-export");
    expect(ids).not.toContain("invoices");
  });

  it("recovers defaults from corrupt tenant/user storage", () => {
    localStorage.setItem(tourStorageKeyForTest(14, 9), "{not-json");
    expect(readTourState(14, 9)).toMatchObject({
      preferences: { enabled: true, autoStart: true },
      progress: {},
      organizationEnabled: true,
    });
  });

  it("hydrates cross-device preferences from the backend", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        preferences: { enabled: false, autoStart: false, updatedAt: "2026-09-12T12:00:00.000Z" },
        progress: {},
        progressResetAt: null,
        organizationEnabled: true,
        updatedAt: "2026-09-12T12:00:00.000Z",
      }),
    }));
    renderProvider();
    await waitFor(() => expect(screen.getByTestId("tour-enabled")).toHaveTextContent("false"));
    expect(fetch).toHaveBeenCalledWith("/api/tours/state", expect.objectContaining({ credentials: "include" }));
    expect(storedState().preferences.autoStart).toBe(false);
  });

  it("runs the short welcome tour once and does not immediately chain a module tour", async () => {
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
      { top: 0, left: 0, right: 100, bottom: 20, width: 100, height: 20, x: 0, y: 0, toJSON: () => ({}) },
    ]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        preferences: { enabled: true, autoStart: true, updatedAt: "2026-09-12T12:00:00.000Z" },
        progress: {},
        progressResetAt: null,
        organizationEnabled: true,
      }),
    }));
    renderProvider();
    expect(await screen.findByRole("dialog", { name: "Your workspace navigation" }, { timeout: 1500 })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByRole("dialog", { name: "Return to your dashboard" })).toBeInTheDocument();
    expect(screen.getByTestId("tour-location")).toHaveTextContent("/dashboard");
    for (let step = 0; step < 3; step += 1) fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Finish" }));
    expect(storedState().progress["welcome:1"].status).toBe("COMPLETED");
    expect(screen.getByTestId("tour-location")).toHaveTextContent("/contacts");
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(screen.queryByTestId("product-tour-overlay")).not.toBeInTheDocument();
  });

  it("automatically starts an unvisited page tour after welcome is complete", async () => {
    const updatedAt = "2026-09-12T12:00:00.000Z";
    const remote = {
      preferences: { enabled: true, autoStart: true, updatedAt },
      progress: { "welcome:1": { status: "COMPLETED", currentStep: 5, updatedAt } },
      progressResetAt: null,
      organizationEnabled: true,
    };
    localStorage.setItem(tourStorageKeyForTest(14, 9), JSON.stringify(remote));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => remote }));
    renderProvider();
    expect(await screen.findByRole("dialog", { name: "Add a contact" }, { timeout: 1800 })).toBeInTheDocument();
  });

  it("combines organization and personal settings for effective availability", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        preferences: { enabled: true, autoStart: true, updatedAt: "2026-09-12T12:00:00.000Z" },
        progress: {},
        progressResetAt: null,
        organizationEnabled: false,
      }),
    }));
    renderProvider();
    await waitFor(() => expect(storedState().organizationEnabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Start current tour" }));
    expect(screen.queryByTestId("product-tour-overlay")).not.toBeInTheDocument();
  });

  it("merges offline and server progress by timestamp and honours reset markers", () => {
    const merged = mergeTourStates(
      {
        preferences: { enabled: false, autoStart: true, updatedAt: "2026-09-12T11:00:00.000Z" },
        progress: { "contacts:1": { status: "IN_PROGRESS", currentStep: 1, updatedAt: "2026-09-12T11:01:00.000Z" } },
        progressResetAt: null,
      },
      {
        preferences: { enabled: true, autoStart: false, updatedAt: "2026-09-12T10:00:00.000Z" },
        progress: {
          "contacts:1": { status: "COMPLETED", currentStep: 2, updatedAt: "2026-09-12T10:30:00.000Z" },
          "leads:1": { status: "COMPLETED", currentStep: 2, updatedAt: "2026-09-12T09:00:00.000Z" },
        },
        progressResetAt: "2026-09-12T09:30:00.000Z",
      },
    );
    expect(merged.preferences.enabled).toBe(false);
    expect(merged.progress["contacts:1"].status).toBe("IN_PROGRESS");
    expect(merged.progress["leads:1"]).toBeUndefined();
  });

  it("shows grouped catalogue statuses, completion, and restart actions", () => {
    const startTour = vi.fn(() => true);
    const tours = [
      { id: "contacts", version: 1, label: "Contacts", path: "/contacts" },
      { id: "campaigns", version: 1, label: "Campaigns", path: "/campaigns" },
      { id: "invoices", version: 1, label: "Invoices", path: "/invoices" },
      { id: "tickets", version: 1, label: "Tickets", path: "/tickets" },
      { id: "reports", version: 1, label: "Reports", path: "/reports" },
      { id: "staff", version: 1, label: "Staff", path: "/staff" },
    ];
    render(
      <MemoryRouter initialEntries={["/settings"]}>
        <ProductTourContext.Provider value={{
          isAvailable: true,
          effectiveEnabled: true,
          organizationEnabled: true,
          canManageOrganization: false,
          preferences: { enabled: true, autoStart: true },
          progress: {
            "contacts:1": { status: "COMPLETED" },
            "campaigns:1": { status: "IN_PROGRESS" },
            "invoices:1": { status: "DISMISSED" },
          },
          availableTours: tours,
          currentFeature: null,
          setPreferences: vi.fn(),
          restartAllTours: vi.fn(),
          startCurrentTour: vi.fn(),
          startTour,
        }}>
          <ProductTourSettings />
        </ProductTourContext.Provider>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: /browse all tours/i }));
    expect(screen.getByRole("dialog", { name: "Tour catalogue" })).toBeInTheDocument();
    for (const category of ["Sales", "Marketing", "Finance", "Support", "Analytics", "Administration"]) {
      expect(screen.getByRole("heading", { name: category })).toBeInTheDocument();
    }
    expect(screen.getByText("17% · 1/6")).toBeInTheDocument();
    expect(screen.getAllByText("In progress").length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole("button", { name: "Restart" })[0]);
    expect(startTour).toHaveBeenCalledWith(expect.any(String), { restart: true });
  });

  it("shows the organization-wide switch only to tour administrators", () => {
    const setOrganizationEnabled = vi.fn();
    render(
      <MemoryRouter>
        <ProductTourContext.Provider value={{
          isAvailable: true,
          effectiveEnabled: true,
          organizationEnabled: true,
          canManageOrganization: true,
          preferences: { enabled: true, autoStart: true },
          progress: {},
          availableTours: [],
          currentFeature: null,
          setPreferences: vi.fn(),
          setOrganizationEnabled,
          restartAllTours: vi.fn(),
        }}>
          <ProductTourSettings />
        </ProductTourContext.Provider>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: /Enable product tours for this organization/ }));
    expect(setOrganizationEnabled).toHaveBeenCalledWith(false);
  });

  it("wires personal settings controls and disables restart when organization tours are off", () => {
    const setPreferences = vi.fn();
    render(
      <MemoryRouter>
        <ProductTourContext.Provider value={{
          isAvailable: true,
          effectiveEnabled: false,
          organizationEnabled: false,
          canManageOrganization: false,
          preferences: { enabled: true, autoStart: true },
          progress: {},
          availableTours: [],
          currentFeature: null,
          setPreferences,
          restartAllTours: vi.fn(),
        }}>
          <ProductTourSettings />
        </ProductTourContext.Provider>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: /Enable guided tours/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Automatically start new tours/ }));
    expect(setPreferences).toHaveBeenNthCalledWith(1, { enabled: false });
    expect(setPreferences).toHaveBeenNthCalledWith(2, { autoStart: false });
    expect(screen.getByRole("button", { name: /Restart all tours/ })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("disabled for this organization");
  });
});
