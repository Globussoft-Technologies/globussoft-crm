import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import SuperAdminOrganizationDeletion from "../pages/superadmin/SuperAdminOrganizationDeletion";
import { superAdminFetch } from "../utils/superAdminApi";

vi.mock("../utils/superAdminApi", () => ({
  superAdminFetch: vi.fn(),
}));

const organization = {
  id: 42,
  name: "Acme Billing",
  slug: "acme-billing",
  ownerEmail: "owner@acme.test",
  vertical: "generic",
};

beforeEach(() => {
  superAdminFetch.mockReset();
  superAdminFetch.mockImplementation((path) => {
    if (path.includes("/organizations/search")) return Promise.resolve({ organizations: [organization], total: 1, limit: 25, offset: 0 });
    if (path.includes("/hard-delete")) return Promise.resolve({
      ok: true,
      auditId: 901,
      organization: organization.name,
      deletedRowCount: 3,
    });
    return Promise.resolve({});
  });
});

describe("SuperAdminOrganizationDeletion", () => {
  test("loads the organization list without requiring a search", async () => {
    render(<SuperAdminOrganizationDeletion />);

    expect(await screen.findByRole("button", { name: /Delete permanently/ })).toBeInTheDocument();
    expect(screen.queryByText("All organizations")).not.toBeInTheDocument();
    expect(screen.queryByText("1 organization", { exact: true })).not.toBeInTheDocument();
    expect(screen.getByText("Showing 1 of 1 organizations")).toBeInTheDocument();
    await waitFor(() => expect(superAdminFetch).toHaveBeenCalledWith(
      "/tenant-management/organizations/search?limit=25&offset=0",
    ));
  });

  test("loads the next organization batch on scroll without page controls", async () => {
    const firstBatch = Array.from({ length: 25 }, (_, index) => ({
      ...organization,
      id: index + 2,
      name: `Organization ${String(index + 2).padStart(2, "0")}`,
      slug: `organization-${index + 2}`,
    }));
    const nextOrganization = { ...organization, id: 27, name: "Zeta Health", slug: "zeta-health" };
    superAdminFetch.mockImplementation((path) => {
      if (path.includes("/organizations/search?limit=25&offset=25")) {
        return Promise.resolve({ organizations: [nextOrganization], total: 26, limit: 25, offset: 25 });
      }
      if (path.includes("/organizations/search")) {
        return Promise.resolve({ organizations: firstBatch, total: 26, limit: 25, offset: 0 });
      }
      return Promise.resolve({});
    });
    render(<SuperAdminOrganizationDeletion />);

    expect(await screen.findByText("Organization 26")).toBeInTheDocument();
    expect(screen.queryByText("Zeta Health")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
    const results = screen.getByRole("region", { name: "Organization results" });
    Object.defineProperties(results, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 1000 },
      scrollTop: { configurable: true, writable: true, value: 650 },
    });
    fireEvent.scroll(results);

    expect(await screen.findByText("Zeta Health")).toBeInTheDocument();
    expect(screen.getByText("Showing 26 of 26 organizations")).toBeInTheDocument();
    expect(superAdminFetch).toHaveBeenCalledWith("/tenant-management/organizations/search?limit=25&offset=25");
  });

  test("requires the exact organization name and a reason before deleting", async () => {
    render(<SuperAdminOrganizationDeletion />);

    fireEvent.change(screen.getByLabelText("Find an organization"), { target: { value: "Acme" } });
    fireEvent.click(await screen.findByRole("button", { name: /Delete permanently/ }));

    const dialog = screen.getByRole("dialog", { name: "Confirm permanent deletion" });
    const confirmName = screen.getByLabelText(/Type Acme Billing to confirm/);
    const reason = screen.getByLabelText(/Reason for deletion/);
    const deleteButton = screen.getByRole("button", { name: "Permanently delete organization" });
    expect(deleteButton).toBeDisabled();

    fireEvent.change(confirmName, { target: { value: "Acme Billing" } });
    expect(deleteButton).toBeDisabled();
    fireEvent.change(reason, { target: { value: "Customer requested account closure" } });
    expect(deleteButton).toBeEnabled();
    fireEvent.click(deleteButton);

    await waitFor(() => expect(superAdminFetch).toHaveBeenCalledWith(
      "/tenant-management/organizations/42/hard-delete",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ confirmationName: "Acme Billing", reason: "Customer requested account closure" }),
      }),
    ));
    expect(await screen.findByRole("status")).toHaveTextContent(/Audit entry #901 was saved/);
    expect(dialog).not.toBeInTheDocument();
  });

  test("searches single-digit tenant IDs and marks the default organization protected", async () => {
    superAdminFetch.mockResolvedValue({
      organizations: [{ ...organization, id: 1, name: "Platform Default" }],
      total: 1,
      limit: 25,
      offset: 0,
    });
    render(<SuperAdminOrganizationDeletion />);

    fireEvent.change(screen.getByLabelText("Find an organization"), { target: { value: "1" } });

    expect(await screen.findByText("Protected platform default")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Delete permanently/ })).not.toBeInTheDocument();
    await waitFor(() => expect(superAdminFetch).toHaveBeenCalledWith(
      "/tenant-management/organizations/search?limit=25&offset=0&q=1",
    ));
  });
});
