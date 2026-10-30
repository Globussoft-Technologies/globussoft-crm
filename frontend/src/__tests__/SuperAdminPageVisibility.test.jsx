import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    { path: "/quotes", label: "Quotes", category: "Finance", description: "Generic CRM quote builder" },
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
  test("shows each organization's real CRM vertical", async () => {
    superAdminFetch.mockImplementation((path) => {
      if (path.startsWith("/tenant-management/tenants/1/page-visibility")) {
        return Promise.resolve(visibilityResponse);
      }
      return Promise.resolve({
        tenants: [
          ...tenantsResponse.tenants,
          { tenantId: 2, organization: "Enhanced Wellness", vertical: "wellness" },
        ],
      });
    });

    render(<SuperAdminPageVisibility />);

    expect(await screen.findByRole("option", { name: "Enhanced Wellness · Wellness" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Enhanced Wellness · Generic CRM" })).not.toBeInTheDocument();
  });

  test('ignores a late organization response and saves only the selected organization state', async () => {
    let resolveFirst;
    const second = { ...visibilityResponse, tenant: { id: 2, name: 'Second Org' }, hiddenPaths: ['/marketing'] };
    superAdminFetch.mockImplementation((path, options) => {
      if (options?.method === 'PUT') return Promise.resolve(second);
      if (path.endsWith('/1/page-visibility')) return new Promise((resolve) => { resolveFirst = resolve; });
      if (path.endsWith('/2/page-visibility')) return Promise.resolve(second);
      return Promise.resolve({ tenants: [...tenantsResponse.tenants, { tenantId: 2, organization: 'Second Org', vertical: 'generic' }] });
    });
    render(<SuperAdminPageVisibility />);
    await waitFor(() => expect(resolveFirst).toBeTypeOf('function'));
    expect(screen.getByRole('button', { name: /Save visibility/ })).toBeDisabled();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '2' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /Save visibility/ })).not.toBeDisabled());
    await act(async () => { resolveFirst({ ...visibilityResponse, hiddenPaths: ['/contacts'] }); });
    expect(screen.getByRole('button', { name: /Contacts/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Marketing/ })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: /Save visibility/ }));
    await waitFor(() => expect(superAdminFetch).toHaveBeenCalledWith('/tenant-management/tenants/2/page-visibility',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ hiddenPaths: ['/marketing'] }) })));
  });

  test("loads an organization catalog and saves a tenant-specific hidden page", async () => {
    render(<SuperAdminPageVisibility />);

    expect(await screen.findByRole("button", { name: /Contacts/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Quotes/ })).toBeInTheDocument();
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
