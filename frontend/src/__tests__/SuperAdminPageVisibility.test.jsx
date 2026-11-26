import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import SuperAdminPageVisibility from "../pages/superadmin/SuperAdminPageVisibility";
import { superAdminFetch } from "../utils/superAdminApi";

const superAdminStyles = readFileSync(
  resolve(process.cwd(), "src/pages/superadmin/super-admin.css"),
  "utf8",
);

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
    { path: "/workflows", label: "Workflows", category: "Automation", description: "Automation builder" },
    { path: "/sequences", label: "Sequences", category: "Automation", description: "Drip sequences" },
    { path: "/web-visitors", label: "Web Visitors", category: "Analytics", description: "Visitor tracking" },
    { path: "/ab-tests", label: "A/B Tests", category: "Marketing", description: "Experiments" },
    { path: "/chatbots", label: "Chatbots", category: "Support", description: "Bots" },
    { path: "/social", label: "Social Media", category: "Marketing", description: "Social" },
    { path: "/playbooks", label: "Playbooks", category: "Sales", description: "Playbooks" },
    { path: "/sla", label: "SLA Policies", category: "Support", description: "SLA" },
    { path: "/contracts", label: "Contracts", category: "Documents", description: "Contracts" },
    { path: "/admin/csp-violations", label: "CSP Violations", category: "Admin", description: "CSP" },
    { path: "/admin/status", label: "Status", category: "Admin", description: "Status" },
    { path: "/commission-profiles", label: "Commission Profiles", category: "Admin", description: "Profiles" },
    { path: "/commission-data", label: "Commission Data", category: "Admin", description: "Data" },
    { path: "/channels", label: "Channels", category: "Admin", description: "Channels" },
    { path: "/industry-templates", label: "Industry Templates", category: "Admin", description: "Templates" },
    { path: "/signatures", label: "E-Signatures", category: "Documents", description: "Signatures" },
    { path: "/document-templates", label: "Doc Templates", category: "Documents", description: "Templates" },
    { path: "/projects", label: "Projects", category: "Documents", description: "Projects" },
    { path: "/quotes", label: "Quotes", category: "Finance", description: "Generic CRM quote builder" },
    { path: "/commissions", label: "Commissions", category: "Finance", description: "Plot commissions and payout workflows" },
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
  test("stacks organization controls and wraps the summary at constrained widths", () => {
    expect(superAdminStyles).toMatch(
      /@media \(max-width: 1120px\)\s*\{[\s\S]*?\.super-admin-page-visibility__controls\s*\{\s*grid-template-columns: minmax\(0, 1fr\);/,
    );
    expect(superAdminStyles).toMatch(
      /\.super-admin-page-visibility__count\s*\{[^}]*white-space: normal;[^}]*overflow-wrap: anywhere;/,
    );
  });

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
    expect(screen.queryByRole('button', { name: /Contacts/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Workflows/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Sequences/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Web Visitors/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Marketing/ })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: /Save visibility/ }));
    await waitFor(() => expect(superAdminFetch).toHaveBeenCalledWith('/tenant-management/tenants/2/page-visibility',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ hiddenPaths: ['/marketing'] }) })));
  });

  test("loads an organization catalog and saves a tenant-specific hidden page", async () => {
    render(<SuperAdminPageVisibility />);

    expect(await screen.findByRole("button", { name: /Quotes/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Contacts/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Workflows/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Sequences/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Web Visitors/ })).not.toBeInTheDocument();
    for (const label of [
      "A/B Tests", "Chatbots", "Social Media", "Playbooks", "SLA Policies", "Contracts",
      "CSP Violations", "Status", "Commission Profiles", "Commission Data", "Channels",
      "Industry Templates",
      "E-Signatures", "Doc Templates", "Projects",
    ]) {
      expect(screen.queryByRole("button", { name: new RegExp(label) })).not.toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: /Commissions/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Home/ })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /Marketing/ }));
    fireEvent.click(screen.getByRole("button", { name: /Save visibility/ }));

    await waitFor(() => expect(superAdminFetch).toHaveBeenCalledWith(
      "/tenant-management/tenants/1/page-visibility",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ hiddenPaths: ["/marketing"] }),
      }),
    ));
  });
});
