import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import SuperAdminRoleManagement from "../pages/superadmin/SuperAdminRoleManagement";
import { superAdminFetch } from "../utils/superAdminApi";

const roleManagementStyles = readFileSync(
  resolve(process.cwd(), "src/pages/superadmin/super-admin.css"),
  "utf8",
);

vi.mock("../utils/superAdminApi", () => ({
  superAdminFetch: vi.fn(),
}));

const OVERVIEW = {
  tenants: [
    {
      tenantId: 1,
      organization: "Acme Generic",
      ownerEmail: "owner@acme.test",
      vertical: "generic",
      status: "active",
      customRoleCount: 3,
      maxCustomRoles: 5,
      remainingCustomRoles: 2,
      roleLimitReached: false,
    },
    {
      tenantId: 2,
      organization: "Wellness House",
      ownerEmail: "owner@wellness.test",
      vertical: "wellness",
      status: "active",
      customRoleCount: 1,
      maxCustomRoles: null,
      remainingCustomRoles: null,
      roleLimitReached: false,
    },
    {
      tenantId: 3,
      organization: "Travel Stall",
      ownerEmail: "owner@travel.test",
      vertical: "travel",
      status: "disabled",
      customRoleCount: 2,
      maxCustomRoles: 2,
      remainingCustomRoles: 0,
      roleLimitReached: true,
    },
  ],
  summary: { totalTenants: 3, cappedTenants: 2, totalCustomRoles: 6, tenantsAtLimit: 1 },
};

beforeEach(() => {
  superAdminFetch.mockReset();
  superAdminFetch.mockResolvedValue(OVERVIEW);
});

describe("SuperAdminRoleManagement", () => {
  test("defines readable theme palettes and responsive filter layouts", () => {
    expect(roleManagementStyles).toContain('[data-theme="light"] .super-admin-role-management');
    expect(roleManagementStyles).toContain('[data-theme="dark"] .super-admin-role-management');
    expect(roleManagementStyles).toContain("--role-limit-surface: #ffffff;");
    expect(roleManagementStyles).toContain("--role-limit-surface: #16181d;");
    expect(roleManagementStyles).toContain("--role-limit-ink: #171b3e;");
    expect(roleManagementStyles).toContain("--role-limit-ink: #f1f5ff;");
    expect(roleManagementStyles).toContain("color-scheme: light;");
    expect(roleManagementStyles).toContain("color-scheme: dark;");
    expect(roleManagementStyles).toContain("@media (max-width: 1120px)");
    expect(roleManagementStyles).toContain("@media (max-width: 1280px)");
    expect(roleManagementStyles).toContain("grid-template-columns: repeat(2, minmax(0, 1fr));");
    expect(roleManagementStyles).toContain(".role-limit-search-control { flex: 1 1 100%; max-width: none; }");
    expect(roleManagementStyles).toContain(".role-limit-summary-item:nth-child(odd)");
  });

  test("loads all verticals and shows custom-role usage and limits", async () => {
    render(<SuperAdminRoleManagement />);

    expect(await screen.findByRole("row", { name: /Acme Generic/ })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /Wellness House/ })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /Travel Stall/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Wellness" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Filter by vertical" }));
    expect(screen.getByRole("button", { name: "Generic CRM" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Wellness" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Travel" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Organization" })).not.toBeInTheDocument();
    expect(screen.getByRole("table")).toHaveClass("super-admin-role-limits-table");
    expect(screen.getByRole("table").parentElement).toHaveClass("role-limit-table-scroll");
    expect(screen.getByRole("table").parentElement.parentElement).toHaveClass("role-limit-table-card");
    expect(screen.getByRole("row", { name: /Acme Generic/ }).textContent).toContain("3 / 5");
    expect(screen.getByRole("row", { name: /Wellness House/ }).textContent).toContain("1 / unlimited");
    expect(screen.getByRole("row", { name: /Travel Stall/ }).textContent).toContain("2 / 2");
  });

  test("updates one organization's custom-role limit", async () => {
    render(<SuperAdminRoleManagement />);
    const input = await screen.findByLabelText("Role limit for Acme Generic");
    fireEvent.change(input, { target: { value: "8" } });
    fireEvent.click(screen.getByRole("button", { name: "Save role limit for Acme Generic" }));

    await waitFor(() => expect(superAdminFetch).toHaveBeenCalledWith(
      "/tenant-management/tenants/1/role-limit",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ maxCustomRoles: 8 }),
      }),
    ));
  });

  test("filters organizations through the reference-style search control", async () => {
    render(<SuperAdminRoleManagement />);
    await screen.findByRole("row", { name: /Acme Generic/ });
    const search = screen.getByRole("textbox", { name: "Search organizations" });
    fireEvent.change(search, { target: { value: "travel" } });
    fireEvent.click(screen.getByRole("button", { name: "Search organizations" }));

    await waitFor(() => expect(screen.queryByRole("row", { name: /Acme Generic/ })).not.toBeInTheDocument());
    expect(screen.getByRole("row", { name: /Travel Stall/ })).toBeInTheDocument();
  });

  test("limits organization suggestions to the selected vertical", async () => {
    render(<SuperAdminRoleManagement />);
    await screen.findByRole("row", { name: /Acme Generic/ });
    fireEvent.click(screen.getByRole("button", { name: "Filter by vertical" }));
    fireEvent.click(screen.getByRole("button", { name: "Wellness" }));

    const search = screen.getByRole("textbox", { name: "Search organizations" });
    fireEvent.focus(search);
    fireEvent.change(search, { target: { value: "owner@" } });

    const suggestions = await screen.findByRole("listbox", { name: "Organization suggestions" });
    expect(within(suggestions).getByRole("option", { name: /Wellness House/ })).toBeInTheDocument();
    expect(within(suggestions).queryByRole("option", { name: /Acme Generic/ })).not.toBeInTheDocument();
    expect(within(suggestions).queryByRole("option", { name: /Travel Stall/ })).not.toBeInTheDocument();
    fireEvent.mouseDown(within(suggestions).getByRole("option", { name: /Wellness House/ }));

    expect(screen.getByRole("row", { name: /Wellness House/ })).toBeInTheDocument();
    expect(screen.queryByRole("row", { name: /Acme Generic/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("row", { name: /Travel Stall/ })).not.toBeInTheDocument();
  });

  test("combines the vertical filter with organization search and filtered totals", async () => {
    render(<SuperAdminRoleManagement />);
    await screen.findByRole("row", { name: /Acme Generic/ });

    fireEvent.click(screen.getByRole("button", { name: "Filter by vertical" }));
    fireEvent.click(screen.getByRole("button", { name: "Wellness" }));
    expect(screen.getByRole("row", { name: /Wellness House/ })).toBeInTheDocument();
    expect(screen.queryByRole("row", { name: /Acme Generic/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("row", { name: /Travel Stall/ })).not.toBeInTheDocument();
    expect(document.querySelector(".role-limit-summary-item strong")).toHaveTextContent("1");

    fireEvent.click(screen.getByRole("button", { name: "Filter by vertical: Wellness" }));
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search organizations" }), { target: { value: "travel" } });
    fireEvent.click(screen.getByRole("button", { name: "Search organizations" }));
    expect(screen.getByRole("row", { name: /Travel Stall/ })).toBeInTheDocument();
    expect(screen.queryByRole("row", { name: /Acme Generic/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("row", { name: /Wellness House/ })).not.toBeInTheDocument();
    expect(document.querySelector(".role-limit-summary-item strong")).toHaveTextContent("1");
  });
});
