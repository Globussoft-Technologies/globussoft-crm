import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import SuperAdminPageVisibility from "../pages/superadmin/SuperAdminPageVisibility";
import { superAdminFetch } from "../utils/superAdminApi";

vi.mock("../utils/superAdminApi", () => ({
  superAdminFetch: vi.fn(),
}));

const tenantsResponse = {
  tenants: [{ tenantId: 1, organization: "Acme Generic", vertical: "generic" }],
};

const visibilityResponse = {
  tenant: { id: 1, name: "Acme Generic", vertical: "generic" },
  vertical: "generic",
  hiddenPaths: [],
  pages: [
    { path: "/home", label: "Home", category: "Core", description: "Landing" },
    { path: "/contacts", label: "Contacts", category: "CRM", description: "Contact directory" },
    { path: "/marketing", label: "Marketing", category: "CRM", description: "Campaigns" },
  ],
};

beforeEach(() => {
  superAdminFetch.mockReset();
  superAdminFetch.mockImplementation((path, options) => {
    if (options?.method === "PUT") return Promise.resolve(visibilityResponse);
    if (path.startsWith("/tenant-management/tenants/1/page-visibility")) {
      return Promise.resolve(visibilityResponse);
    }
    return Promise.resolve(tenantsResponse);
  });
});

describe("SuperAdminPageVisibility", () => {
  test("loads an organization catalog and saves a tenant-specific hidden page", async () => {
    render(<SuperAdminPageVisibility />);

    expect(await screen.findByRole("button", { name: /Contacts/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Home/ })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /Contacts/ }));
    fireEvent.click(screen.getByRole("button", { name: /Save visibility/ }));

    await waitFor(() => expect(superAdminFetch).toHaveBeenCalledWith(
      "/tenant-management/tenants/1/page-visibility",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ hiddenPaths: ["/contacts"] }),
      }),
    ));
  });
});
