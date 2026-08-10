import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const fetchApiMock = vi.fn();
vi.mock("../utils/api", () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

const notifyObj = {
  success: vi.fn(),
  error: vi.fn(),
};
vi.mock("../utils/notify", () => ({
  useNotify: () => notifyObj,
}));

vi.mock("../App", () => {
  const React = require("react");
  return {
    AuthContext: React.createContext({
      user: { tenant: { id: 1 } },
    }),
  };
});

import LeadSourceAllowlistCard from "../components/LeadSourceAllowlistCard";

function renderCard() {
  return render(<LeadSourceAllowlistCard tenantId={1} />);
}

describe("<LeadSourceAllowlistCard />", () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyObj.success.mockReset();
    notifyObj.error.mockReset();
  });

  it("lists allowed origins and lets an admin deny one before saving", async () => {
    const user = userEvent.setup();
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || "GET";
      if (url === "/api/admin/tenants/1/embed-allowlist" && method === "GET") {
        return Promise.resolve({
          tenantId: 1,
          origins: ["https://mysite.com", "https://*.mysite.com"],
          updatedAt: new Date().toISOString(),
        });
      }
      if (url === "/api/admin/tenants/1/embed-allowlist" && method === "PATCH") {
        const body = JSON.parse(opts.body);
        return Promise.resolve({
          tenantId: 1,
          origins: body.origins,
          updatedAt: new Date().toISOString(),
        });
      }
      return Promise.resolve([]);
    });

    renderCard();
    await waitFor(() =>
      expect(screen.getByText("https://mysite.com")).toBeInTheDocument(),
    );
    expect(screen.getByText("/api/v1/external/leads")).toBeInTheDocument();
    expect(screen.getAllByText("https://*.mysite.com").length).toBeGreaterThan(0);

    await user.click(
      screen.getByRole("button", { name: /Deny https:\/\/mysite\.com/i }),
    );
    await user.click(screen.getByRole("button", { name: /Save domains/i }));

    await waitFor(() => {
      const patchCalls = fetchApiMock.mock.calls.filter(
        ([url, opts]) =>
          url === "/api/admin/tenants/1/embed-allowlist" &&
          opts?.method === "PATCH",
      );
      expect(patchCalls).toHaveLength(1);
      expect(JSON.parse(patchCalls[0][1].body).origins).toEqual([
        "https://*.mysite.com",
      ]);
    });
    expect(notifyObj.success).toHaveBeenCalledWith(
      expect.stringMatching(/allowlist updated/i),
    );
  });

  it("falls back to the authenticated tenant object when no tenantId prop is passed", async () => {
    fetchApiMock.mockResolvedValue({
      tenantId: 1,
      origins: ["https://fallback.example.com"],
      updatedAt: new Date().toISOString(),
    });

    render(<LeadSourceAllowlistCard />);

    await waitFor(() =>
      expect(screen.getByText("https://fallback.example.com")).toBeInTheDocument(),
    );

    expect(fetchApiMock).toHaveBeenCalledWith(
      "/api/admin/tenants/1/embed-allowlist",
      { silent: true },
    );
  });
});
