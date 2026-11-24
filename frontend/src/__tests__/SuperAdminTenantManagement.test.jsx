import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import SuperAdminTenantManagement from "../pages/superadmin/SuperAdminTenantManagement";
import { superAdminFetch } from "../utils/superAdminApi";

vi.mock("../utils/superAdminApi", () => ({
  superAdminFetch: vi.fn(),
}));

const tenants = Array.from({ length: 25 }, (_, index) => ({
  tenantId: index + 1,
  organization: `Organization ${String(index + 1).padStart(2, "0")}`,
  slug: `organization-${index + 1}`,
  ownerEmail: `owner${index + 1}@example.test`,
  vertical: "generic",
  platformSubscription: null,
  aiAccess: { balanceTokens: 0, resolverAccess: "none" },
  lifetimeRevenue: 0,
}));

beforeEach(() => {
  superAdminFetch.mockReset();
  superAdminFetch.mockResolvedValue({
    tenants,
    summary: { totalTenants: tenants.length, activePlatformSubs: 0, activeAiSubs: 0, totalLifetimeRevenue: 0 },
  });
});

describe("SuperAdminTenantManagement", () => {
  test("loads more organizations as the table scrolls and has no page controls", async () => {
    render(
      <MemoryRouter>
        <SuperAdminTenantManagement />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("row", { name: /Organization 20/ })).toBeInTheDocument();
    expect(screen.queryByRole("row", { name: /Organization 21/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Organization pages" })).not.toBeInTheDocument();

    const scrollArea = screen.getByRole("region", { name: "Organizations" })
      .querySelector(".tenant-management-table-scroll");
    Object.defineProperties(scrollArea, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 900 },
      scrollTop: { configurable: true, writable: true, value: 520 },
    });

    fireEvent.scroll(scrollArea);

    expect(await screen.findByRole("row", { name: /Organization 25/ })).toBeInTheDocument();
    expect(screen.getByText("Showing 25 of 25 organizations")).toBeInTheDocument();
  });

  test("keeps the tenant users list scrollable and reveals the next batch on scroll", async () => {
    const users = Array.from({ length: 23 }, (_, index) => ({
      id: index + 1,
      name: `Staff ${index + 1}`,
      email: `staff${index + 1}@example.test`,
      role: "USER",
      userType: "STAFF",
      subscriptionStatus: "TRIAL",
    }));
    const detail = {
      tenantId: 2,
      organization: "Wellness House",
      slug: "wellness-house",
      ownerEmail: "owner@example.test",
      vertical: "wellness",
      users,
      platformSubscriptions: [],
      aiOrders: [],
      aiState: {
        resolverAccess: "none",
        creditWallet: { balanceTokens: 0, percentRemaining: 100 },
        friendlyMessage: "No AI access",
      },
      revenue: { platformTotal: 0, aiTotal: 0, combinedTotal: 0 },
    };
    superAdminFetch.mockImplementation((path) => (
      path.endsWith("/2") ? Promise.resolve(detail) : Promise.resolve({ plans: [] })
    ));

    render(
      <MemoryRouter initialEntries={["/super-admin/tenant-management/2"]}>
        <Routes>
          <Route path="/super-admin/tenant-management/:tenantId" element={<SuperAdminTenantManagement />} />
        </Routes>
      </MemoryRouter>,
    );

    const usersScrollArea = await screen.findByRole("region", { name: "Wellness House users" });
    expect(screen.getAllByRole("listitem")).toHaveLength(10);
    expect(screen.queryByText(/Staff 11/)).not.toBeInTheDocument();

    Object.defineProperties(usersScrollArea, {
      clientHeight: { configurable: true, value: 250 },
      scrollHeight: { configurable: true, value: 700 },
      scrollTop: { configurable: true, writable: true, value: 400 },
    });
    fireEvent.scroll(usersScrollArea);

    expect(await screen.findByText(/Staff 20/)).toBeInTheDocument();
    fireEvent.scroll(usersScrollArea);
    expect(await screen.findByText(/Staff 23/)).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(23);
  });

  test("shows five subscription records initially and appends more as history scrolls", async () => {
    const platformSubscriptions = Array.from({ length: 12 }, (_, index) => ({
      id: index + 1,
      planName: `Plan ${index + 1}`,
      status: "ACTIVE",
      amount: 499,
      currency: "INR",
      startDate: "2026-01-01T00:00:00.000Z",
      endDate: "2026-02-01T00:00:00.000Z",
      isManualGrant: false,
    }));
    const detail = {
      tenantId: 2,
      organization: "Wellness House",
      slug: "wellness-house",
      ownerEmail: "owner@example.test",
      vertical: "wellness",
      users: [],
      platformSubscriptions,
      aiOrders: [],
      aiState: {
        resolverAccess: "none",
        creditWallet: { balanceTokens: 0, percentRemaining: 100 },
        friendlyMessage: "No AI access",
      },
      revenue: { platformTotal: 0, aiTotal: 0, combinedTotal: 0 },
    };
    superAdminFetch.mockImplementation((path) => (
      path.endsWith("/2") ? Promise.resolve(detail) : Promise.resolve({ plans: [] })
    ));

    render(
      <MemoryRouter initialEntries={["/super-admin/tenant-management/2"]}>
        <Routes>
          <Route path="/super-admin/tenant-management/:tenantId" element={<SuperAdminTenantManagement />} />
        </Routes>
      </MemoryRouter>,
    );

    const historyScrollArea = await screen.findByRole("region", { name: "Wellness House subscription history" });
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
    expect(screen.queryByText("Plan 6")).not.toBeInTheDocument();

    Object.defineProperties(historyScrollArea, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, writable: true, value: 250 },
    });
    fireEvent.scroll(historyScrollArea);

    expect(await screen.findByText("Plan 10")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(10);
  });
});
