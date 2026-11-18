import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import SuperAdminOrganizationAuditLog from "../pages/superadmin/SuperAdminOrganizationAuditLog";
import { superAdminFetch } from "../utils/superAdminApi";

vi.mock("../utils/superAdminApi", () => ({
  superAdminFetch: vi.fn(),
}));

const entry = {
  id: 901,
  actor: "ops_alice",
  action: "ORGANIZATION_HARD_DELETE",
  status: "SUCCEEDED",
  organizationId: 42,
  organizationName: "Acme Billing",
  organizationSlug: "acme-billing",
  ownerEmail: "owner@acme.test",
  reason: "Customer requested account closure",
  errorMessage: null,
  deletedRowCount: 3,
  createdAt: "2026-11-17T10:00:00.000Z",
  completedAt: "2026-11-17T10:00:01.000Z",
};

beforeEach(() => {
  superAdminFetch.mockReset();
  superAdminFetch.mockResolvedValue({ entries: [entry], total: 51, limit: 50, offset: 0 });
});

describe("SuperAdminOrganizationAuditLog", () => {
  test("shows the deletion actor, outcome, reason, and retained organization snapshot", async () => {
    render(<SuperAdminOrganizationAuditLog />);

    expect(await screen.findByText("Acme Billing")).toBeInTheDocument();
    expect(screen.getByText("Permanent deletion")).toBeInTheDocument();
    expect(screen.getByText("ops_alice")).toBeInTheDocument();
    expect(screen.getByText("SUCCEEDED")).toBeInTheDocument();
    expect(screen.getByText("Customer requested account closure")).toBeInTheDocument();
    expect(screen.getByText("3", { selector: "td" })).toBeInTheDocument();
  });

  test("filters by search text and deletion outcome", async () => {
    render(<SuperAdminOrganizationAuditLog />);
    await screen.findByText("Acme Billing");

    fireEvent.change(screen.getByRole("textbox", { name: "Search audit log" }), { target: { value: "Acme" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Filter by outcome" }), { target: { value: "FAILED" } });

    await waitFor(() => expect(superAdminFetch).toHaveBeenLastCalledWith(
      expect.stringContaining("q=Acme&status=FAILED"),
    ));
  });

  test("paginates through audit entries", async () => {
    render(<SuperAdminOrganizationAuditLog />);
    await screen.findByText("Acme Billing");

    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => expect(superAdminFetch).toHaveBeenLastCalledWith(
      expect.stringContaining("offset=50"),
    ));
  });
});
