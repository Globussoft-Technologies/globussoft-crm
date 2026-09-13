import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthContext } from "../appContexts";
import OnboardingCenter from "../components/OnboardingCenter";
import ContextualEmptyState from "../components/ContextualEmptyState";
import { pendingAnnouncements } from "../onboarding/releaseAnnouncements";
import { fetchApi } from "../utils/api";

vi.mock("../utils/api", () => ({ fetchApi: vi.fn() }));

const permissionState = { isReady: true, hasPermission: vi.fn(() => true) };
vi.mock("../hooks/usePermissions", () => ({ usePermissions: () => permissionState }));

const state = {
  checklist: [
    { key: "first-contact", label: "Create your first contact", path: "/contacts", completedAt: "2026-09-13T10:00:00.000Z" },
    { key: "first-lead", label: "Create your first lead", path: "/leads", completedAt: null },
  ],
  completed: 1,
  total: 2,
  completionPercentage: 50,
  dismissedAnnouncements: [],
};

function renderCenter(role = "USER") {
  return render(
    <AuthContext.Provider value={{ user: { userId: 7, role }, tenant: { id: 3, vertical: "generic" }, token: "token" }}>
      <MemoryRouter><OnboardingCenter /></MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe("onboarding experience", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    permissionState.isReady = true;
    permissionState.hasPermission.mockReturnValue(true);
    fetchApi.mockImplementation((url) => {
      if (url === "/api/onboarding/state") return Promise.resolve(state);
      if (url.includes("/dismiss")) return Promise.resolve({ dismissedAnnouncements: ["3.9.3-guided-onboarding"] });
      if (url === "/api/onboarding/analytics") return Promise.resolve({ tours: { started: 2, completionRate: 50, abandonmentRate: 50 }, skippedSteps: [], missingTargets: [], featuresNotFound: [], privacy: "No CRM data." });
      return Promise.resolve({ recorded: true });
    });
  });

  it("shows only undismissed versioned announcements and permanently dismisses one", async () => {
    renderCenter();
    const launcher = await screen.findByRole("button", { name: /open onboarding/i });
    fireEvent.click(launcher);
    expect(screen.getByText("Version 3.9.3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss permanently" }));
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith(
      "/api/onboarding/announcements/3.9.3-guided-onboarding/dismiss",
      { method: "PUT" },
    ));
    expect(await screen.findByText(/you are caught up/i)).toBeInTheDocument();
  });

  it("renders backend-persisted checklist progress and exposes analytics only to eligible roles", async () => {
    renderCenter("ADMIN");
    fireEvent.click(await screen.findByRole("button", { name: /open onboarding/i }));
    fireEvent.click(screen.getByRole("button", { name: "Checklist" }));
    expect(screen.getByText("1 of 2 complete")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
    fireEvent.click(screen.getByRole("button", { name: "Analytics" }));
    expect(await screen.findByText("50%")).toBeInTheDocument();
  });

  it("filters contextual actions by permissions", () => {
    permissionState.hasPermission.mockImplementation((module) => module === "contacts");
    const create = vi.fn();
    render(<MemoryRouter><ContextualEmptyState featureKey="contacts" title="No contacts yet" description="Add the first one." actions={[
      { label: "Create contact", onClick: create, permission: { module: "contacts", action: "write" } },
      { label: "Connect Gmail", to: "/gmail", permission: { module: "gmail", action: "write" } },
    ]} /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: /create contact/i }));
    expect(create).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: /connect gmail/i })).not.toBeInTheDocument();
  });

  it("filters dismissed announcement IDs without relying on browser storage", () => {
    expect(pendingAnnouncements(["3.9.3-guided-onboarding"])).toEqual([]);
  });
});
