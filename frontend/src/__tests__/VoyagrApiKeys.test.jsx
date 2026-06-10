/**
 * VoyagrApiKeys.test.jsx — vitest + RTL coverage for the Voyagr API key
 * admin UI (frontend/src/pages/admin/VoyagrApiKeys.jsx). Slice C1 of
 * docs/TRAVEL_CODEABLE_BACKLOG.md.
 *
 * The page is the ADMIN-only operator surface for per-Voyagr-site API
 * key provisioning, rotation, and revocation. It talks to the existing
 * /api/developer/apikeys CRUD endpoints (backend/routes/developer.js)
 * and filters the response client-side by `subBrand IN
 * {tmc, rfu, travelstall, visasure}` to surface only voyagr-shaped keys.
 *
 * Backend contracts pinned by this test:
 *   GET    /api/developer/apikeys
 *   POST   /api/developer/apikeys          { name, subBrand } → { rawKey, key }
 *   DELETE /api/developer/apikeys/:id
 *
 * Contracts pinned here (8 cases per slice C1 hard-contract):
 *   1. Initial render: page mounts with heading + subtitle + Provision
 *      button + voyagr keys list (filtered client-side).
 *   2. Empty state: when no voyagr-shaped keys exist, "No Voyagr API keys
 *      provisioned yet. Click Provision to create one." renders.
 *   3. Provision modal: clicking Provision opens a modal with name + sub-
 *      brand fields. Closing returns to the list.
 *   4. Provision validation: submitting empty name shows inline error
 *      "Key name is required." with no POST fired.
 *   5. Provision happy path: typing name + selecting sub-brand + submit
 *      POSTs /api/developer/apikeys with { name, subBrand }; the rawKey
 *      appears in a one-shot reveal modal.
 *   6. Rotate action: clicking Rotate confirms + fires DELETE old key +
 *      POST new key with the SAME name + subBrand; new rawKey surfaces
 *      in reveal modal.
 *   7. Revoke action: clicking Revoke shows confirmation dialog; on
 *      confirm fires DELETE /api/developer/apikeys/:id.
 *   8. Non-ADMIN gate: in production this page is wrapped in <RoleGuard
 *      allow={["ADMIN"]}> at the route level (App.jsx). This test pins
 *      the page-internal contract: the page itself does NOT crash for
 *      non-admins, but assumes the RoleGuard has gated it. We pin this
 *      by rendering the page (the route guard is App.jsx's
 *      responsibility) and confirming it surfaces the same heading
 *      regardless of role — the actual gate is the RoleGuard wrapper.
 *
 * Stable mock pattern (per the 2026-05-12 standing rule): notify object
 * is ONE reference for the whole module so the hook reading it in
 * useCallback deps doesn't trigger re-render loops + per-test timeouts.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const fetchApiMock = vi.fn();
vi.mock("../utils/api", () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyInfo = vi.fn();
const notifyConfirm = vi.fn();
const notifyObj = {
  error: notifyError,
  info: notifyInfo,
  success: notifySuccess,
  confirm: (...args) => notifyConfirm(...args),
};
vi.mock("../utils/notify", () => ({
  useNotify: () => notifyObj,
}));

import VoyagrApiKeys from "../pages/admin/VoyagrApiKeys";

const voyagrKeys = [
  {
    id: 101,
    name: "tmc.in production",
    keySecret: "glbs_tmc12345678abcdef0123",
    subBrand: "tmc",
    createdAt: "2026-05-10T10:00:00Z",
    lastUsed: "2026-06-08T09:00:00Z",
  },
  {
    id: 102,
    name: "rfu-umrah.com staging",
    keySecret: "glbs_rfu98765432fedcba9876",
    subBrand: "rfu",
    createdAt: "2026-05-15T10:00:00Z",
    lastUsed: null,
  },
];

// Mix of voyagr + non-voyagr (tenant-wide) keys — the page filters out
// the non-voyagr ones client-side.
const allKeys = [
  ...voyagrKeys,
  {
    id: 200,
    name: "Zapier (tenant-wide, NOT voyagr)",
    keySecret: "glbs_zapier000000000000000",
    subBrand: null,
    createdAt: "2026-04-01T10:00:00Z",
    lastUsed: null,
  },
];

function defaultFetchMock(url, opts) {
  if (url === "/api/developer/apikeys" && (!opts || !opts.method || opts.method === "GET")) {
    return Promise.resolve(allKeys);
  }
  if (url === "/api/developer/apikeys" && opts?.method === "POST") {
    return Promise.resolve({
      rawKey: "glbs_NEW_RAW_KEY_NEVER_SHOWN_AGAIN_abc123",
      key: { id: 999, name: "new", subBrand: "tmc" },
    });
  }
  if (url.match(/^\/api\/developer\/apikeys\/\d+$/) && opts?.method === "DELETE") {
    return Promise.resolve({ success: true });
  }
  return Promise.resolve(null);
}

describe("<VoyagrApiKeys /> — admin UI for per-Voyagr-site API keys", () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation(defaultFetchMock);
    notifyError.mockReset();
    notifySuccess.mockReset();
    notifyInfo.mockReset();
    notifyConfirm.mockReset();
    notifyConfirm.mockResolvedValue(true);
  });

  it("initial render: heading + subtitle + Provision button + voyagr keys list (filters out tenant-wide)", async () => {
    render(<VoyagrApiKeys />);
    expect(screen.getByRole("heading", { name: /Voyagr API Keys/i })).toBeInTheDocument();
    expect(
      screen.getByText(/Provision API keys for Voyagr CMS sites to POST leads into the CRM/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Provision new Voyagr API key/i }),
    ).toBeInTheDocument();

    // Voyagr keys render.
    expect(await screen.findByText("tmc.in production")).toBeInTheDocument();
    expect(screen.getByText("rfu-umrah.com staging")).toBeInTheDocument();
    // Non-voyagr tenant-wide key is filtered out.
    expect(
      screen.queryByText(/Zapier \(tenant-wide, NOT voyagr\)/i),
    ).not.toBeInTheDocument();
    // Initial GET fired.
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith("/api/developer/apikeys");
    });
  });

  it("empty state: renders 'No Voyagr API keys provisioned yet' when no voyagr keys exist", async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === "/api/developer/apikeys") {
        // Only return the tenant-wide non-voyagr key — page should still
        // see empty state because it filters by subBrand IN voyagr set.
        return Promise.resolve([
          {
            id: 200,
            name: "Zapier",
            keySecret: "glbs_zapier000000000000",
            subBrand: null,
          },
        ]);
      }
      return Promise.resolve(null);
    });
    render(<VoyagrApiKeys />);
    expect(
      await screen.findByText(
        /No Voyagr API keys provisioned yet\. Click Provision to create one\./i,
      ),
    ).toBeInTheDocument();
  });

  it("provision modal: opens on button click and closes via X button", async () => {
    render(<VoyagrApiKeys />);
    await screen.findByText("tmc.in production");

    // Modal not initially present.
    expect(screen.queryByRole("dialog", { name: /Provision Voyagr API Key/i })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Provision new Voyagr API key/i }));

    // Modal is now open.
    const dialog = await screen.findByRole("dialog", { name: /Provision Voyagr API Key/i });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByLabelText(/Key name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Sub-brand/i)).toBeInTheDocument();

    // Close via X button.
    fireEvent.click(screen.getByRole("button", { name: /Close dialog/i }));
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: /Provision Voyagr API Key/i }),
      ).toBeNull();
    });
  });

  it("provision validation: empty name shows inline error + no POST fires", async () => {
    render(<VoyagrApiKeys />);
    await screen.findByText("tmc.in production");

    fireEvent.click(screen.getByRole("button", { name: /Provision new Voyagr API key/i }));
    await screen.findByRole("dialog", { name: /Provision Voyagr API Key/i });

    // Submit without typing a name.
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetchMock);
    const submitBtn = screen.getAllByRole("button", { name: /^Provision$/i })[0];
    fireEvent.click(submitBtn);

    expect(await screen.findByRole("alert")).toHaveTextContent(/Key name is required\./i);
    // No POST fired.
    const postCalls = fetchApiMock.mock.calls.filter(
      ([url, opts]) => url === "/api/developer/apikeys" && opts?.method === "POST",
    );
    expect(postCalls).toHaveLength(0);
  });

  it("provision happy path: POSTs with name + subBrand, surfaces rawKey in reveal modal", async () => {
    render(<VoyagrApiKeys />);
    await screen.findByText("tmc.in production");

    fireEvent.click(screen.getByRole("button", { name: /Provision new Voyagr API key/i }));
    await screen.findByRole("dialog", { name: /Provision Voyagr API Key/i });

    fireEvent.change(screen.getByLabelText(/Key name/i), {
      target: { value: "  travelstall.com prod  " },
    });
    fireEvent.change(screen.getByLabelText(/Sub-brand/i), {
      target: { value: "travelstall" },
    });

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetchMock);
    const submitBtn = screen.getAllByRole("button", { name: /^Provision$/i })[0];
    fireEvent.click(submitBtn);

    // POST fires with trimmed name + selected subBrand.
    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === "/api/developer/apikeys" && opts?.method === "POST",
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.name).toBe("travelstall.com prod");
      expect(body.subBrand).toBe("travelstall");
    });

    // Reveal modal renders with the rawKey.
    expect(
      await screen.findByRole("dialog", { name: /Key provisioned — copy now/i }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("revealed-raw-key")).toHaveTextContent(
      "glbs_NEW_RAW_KEY_NEVER_SHOWN_AGAIN_abc123",
    );
    expect(
      screen.getByText(/This is the ONLY time this key will be shown\./i),
    ).toBeInTheDocument();
  });

  it("rotate action: confirms + DELETEs old + POSTs new + surfaces fresh rawKey in reveal modal", async () => {
    render(<VoyagrApiKeys />);
    await screen.findByText("tmc.in production");

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetchMock);
    notifyConfirm.mockResolvedValue(true);

    // Click Rotate on the first row (tmc.in production, id=101).
    fireEvent.click(screen.getByRole("button", { name: /Rotate tmc\.in production/i }));

    // Confirm dialog fires with WARNING copy.
    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalledWith(
        expect.stringMatching(/WARNING: Rotating "tmc\.in production"/i),
      );
    });

    // DELETE then POST sequence fires.
    await waitFor(() => {
      const deleteCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === "/api/developer/apikeys/101" && opts?.method === "DELETE",
      );
      expect(deleteCall).toBeTruthy();
    });
    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === "/api/developer/apikeys" && opts?.method === "POST",
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      // Same name + sub-brand as the original key.
      expect(body.name).toBe("tmc.in production");
      expect(body.subBrand).toBe("tmc");
    });

    // Reveal modal surfaces the fresh rawKey with action='rotated'.
    expect(
      await screen.findByRole("dialog", { name: /Key rotated — copy now/i }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("revealed-raw-key")).toHaveTextContent(
      "glbs_NEW_RAW_KEY_NEVER_SHOWN_AGAIN_abc123",
    );
  });

  it("revoke action: shows confirmation dialog → on confirm fires DELETE + success notify", async () => {
    render(<VoyagrApiKeys />);
    await screen.findByText("tmc.in production");

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetchMock);
    notifyConfirm.mockResolvedValue(true);

    // Click Revoke on the rfu row (id=102).
    fireEvent.click(screen.getByRole("button", { name: /Revoke rfu-umrah\.com staging/i }));

    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalledWith(
        expect.stringMatching(/WARNING: Revoking "rfu-umrah\.com staging"/i),
      );
    });

    await waitFor(() => {
      const deleteCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === "/api/developer/apikeys/102" && opts?.method === "DELETE",
      );
      expect(deleteCall).toBeTruthy();
    });

    await waitFor(() => {
      expect(notifySuccess).toHaveBeenCalledWith(
        expect.stringMatching(/Revoked "rfu-umrah\.com staging"/i),
      );
    });
  });

  it("revoke cancelled: notify.confirm → false means NO DELETE fires", async () => {
    render(<VoyagrApiKeys />);
    await screen.findByText("tmc.in production");

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetchMock);
    notifyConfirm.mockResolvedValue(false);

    fireEvent.click(screen.getByRole("button", { name: /Revoke tmc\.in production/i }));

    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalled();
    });

    // No DELETE call fires.
    await new Promise((r) => setTimeout(r, 50));
    const deleteCalls = fetchApiMock.mock.calls.filter(
      ([url, opts]) =>
        url === "/api/developer/apikeys/101" && opts?.method === "DELETE",
    );
    expect(deleteCalls).toHaveLength(0);
  });

  it("page-internal contract: renders heading regardless of role (RoleGuard is App.jsx's responsibility)", async () => {
    // The page itself doesn't internally check user.role — the
    // RoleGuard wrapper in App.jsx handles the ADMIN-only gate. This
    // test pins that the page is render-stable + does not crash, so
    // App.jsx's RoleGuard is the single source of truth for the
    // ADMIN-only contract.
    render(<VoyagrApiKeys />);
    expect(screen.getByRole("heading", { name: /Voyagr API Keys/i })).toBeInTheDocument();
    // Page does its own fetch regardless of role — the RoleGuard would
    // have prevented mount entirely for non-ADMINs in production.
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith("/api/developer/apikeys");
    });
  });
});
