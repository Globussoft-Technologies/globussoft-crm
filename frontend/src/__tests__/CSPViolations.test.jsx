/**
 * CSPViolations.test.jsx — vitest + RTL pins for the slice-4 admin page
 * (frontend/src/pages/admin/CSPViolations.jsx) that consumes the slice-3
 * `GET /api/csp/violations` operator-inspect endpoint (commit d7167c72).
 *
 * Scope — pins the page-surface invariants:
 *   1. Smoke render — heading "CSP Violations" + filter bar.
 *   2. Initial mount fires fetchApi with the default ?limit=100.
 *   3. Loaded violations render in a table with the expected columns.
 *   4. Empty state ("No CSP violations recorded") on 0-row payload.
 *   5. Directive filter input debounces 300ms then refetches with
 *      ?directive=<value>.
 *   6. Fetch failure surfaces an error panel + calls notify.error.
 *   7. Pagination "Next" advances offset by 100 and refetches.
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules)
 *   - fetchApi from utils/api (the wrapper), NOT global fetch
 *   - useNotify returns a STABLE notifyObj — single reference for the
 *     whole file. Fresh objects per call cause infinite-render loops in
 *     pages that destructure notify into a useCallback dep array.
 *   - vi.useFakeTimers() inside the debounce test ONLY — the rest of the
 *     suite uses real timers so async waitFor() polling works.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

const fetchApiMock = vi.fn();
vi.mock("../utils/api", () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => "test-token",
}));

// Stable notify object — RTL standing rule.
const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyConfirm = vi.fn(() => Promise.resolve(true));
const notifyObj = {
  error: notifyError,
  info: vi.fn(),
  success: notifySuccess,
  confirm: notifyConfirm,
};
vi.mock("../utils/notify", () => ({
  useNotify: () => notifyObj,
}));

import CSPViolations from "../pages/admin/CSPViolations";

const sampleViolations = [
  {
    at: "2026-05-25T10:30:00.000Z",
    directive: "script-src",
    blockedUri: "https://evil.example.com/x.js",
    documentUri: "https://crm.globusdemos.com/dashboard",
    sourceFile: "https://crm.globusdemos.com/static/js/app.js",
    lineNumber: 142,
    columnNumber: 18,
    tenantId: 1,
    originalPolicy: "default-src 'self'; script-src 'self'",
  },
  {
    at: "2026-05-25T11:00:00.000Z",
    directive: "img-src",
    blockedUri: "data:image/gif;base64,R0lGOD...",
    documentUri: "https://crm.globusdemos.com/wellness",
    sourceFile: null,
    lineNumber: null,
    columnNumber: null,
    tenantId: 1,
    originalPolicy: "default-src 'self'; img-src 'self'",
  },
  {
    at: "2026-05-25T11:15:00.000Z",
    directive: "style-src",
    blockedUri: "inline",
    documentUri: "https://crm.globusdemos.com/contacts",
    sourceFile: "https://crm.globusdemos.com/static/css/main.css",
    lineNumber: 27,
    columnNumber: 4,
    tenantId: 1,
    originalPolicy: "default-src 'self'; style-src 'self'",
  },
];

function defaultFetchMock(url) {
  if (url.startsWith("/api/csp/violations")) {
    return Promise.resolve({
      total: sampleViolations.length,
      violations: sampleViolations,
      limit: 100,
      offset: 0,
    });
  }
  return Promise.resolve(null);
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyError.mockReset();
  notifySuccess.mockReset();
  notifyConfirm.mockReset();
  notifyConfirm.mockResolvedValue(true);
  fetchApiMock.mockImplementation(defaultFetchMock);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("<CSPViolations /> — admin operator-inspect page", () => {
  it("renders the heading + filter bar (smoke)", async () => {
    render(<CSPViolations />);
    expect(screen.getByRole("heading", { name: /CSP Violations/i })).toBeInTheDocument();
    expect(screen.getByTestId("csp-violations-filter-directive")).toBeInTheDocument();
    expect(screen.getByTestId("csp-violations-filter-from")).toBeInTheDocument();
    expect(screen.getByTestId("csp-violations-filter-to")).toBeInTheDocument();
    // Drain the pending fetch so it doesn't leak into the next test.
    await waitFor(() => {
      expect(screen.queryByText(/Loading CSP violations/i)).toBeNull();
    });
  });

  it("fires fetchApi('/api/csp/violations?limit=100') on initial mount", async () => {
    render(<CSPViolations />);
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([url]) =>
        url.startsWith("/api/csp/violations?")
      );
      expect(call).toBeTruthy();
      expect(call[0]).toContain("limit=100");
      // No offset / directive / from / to on initial mount.
      expect(call[0]).not.toContain("offset=");
      expect(call[0]).not.toContain("directive=");
    });
  });

  it("renders one table row per violation with the documented columns", async () => {
    render(<CSPViolations />);
    expect(await screen.findByTestId("csp-violations-table")).toBeInTheDocument();
    // 3 rows from sampleViolations.
    expect(screen.getByTestId("csp-violations-row-0")).toBeInTheDocument();
    expect(screen.getByTestId("csp-violations-row-1")).toBeInTheDocument();
    expect(screen.getByTestId("csp-violations-row-2")).toBeInTheDocument();
    // Directives surface as <code> text.
    const row0 = screen.getByTestId("csp-violations-row-0");
    expect(row0.textContent).toMatch(/script-src/);
    expect(row0.textContent).toMatch(/142:18/);
    // Row with null source-file / line-number renders the muted dash.
    const row1 = screen.getByTestId("csp-violations-row-1");
    expect(row1.textContent).toMatch(/img-src/);
  });

  it("renders the empty state when the payload has 0 violations", async () => {
    fetchApiMock.mockImplementation(() =>
      Promise.resolve({ total: 0, violations: [], limit: 100, offset: 0 })
    );
    render(<CSPViolations />);
    expect(await screen.findByTestId("csp-violations-empty")).toBeInTheDocument();
    expect(screen.getByText(/No CSP violations recorded/i)).toBeInTheDocument();
  });

  it("typing into the directive filter debounces then refetches with ?directive=script-src", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<CSPViolations />);
    // Drain initial mount fetch.
    await waitFor(() => {
      expect(fetchApiMock.mock.calls.length).toBeGreaterThan(0);
    });
    fetchApiMock.mockClear();

    const filter = screen.getByTestId("csp-violations-filter-directive");
    fireEvent.change(filter, { target: { value: "script-src" } });

    // No fetch yet — still inside the 300ms debounce window.
    expect(
      fetchApiMock.mock.calls.find(([url]) => url.includes("directive=script-src"))
    ).toBeUndefined();

    // Advance past the debounce.
    await act(async () => {
      vi.advanceTimersByTime(350);
    });

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([url]) =>
        url.includes("directive=script-src")
      );
      expect(call).toBeTruthy();
    });
  });

  it("on fetch failure surfaces the error panel and calls notify.error", async () => {
    fetchApiMock.mockImplementation(() => {
      const err = new Error("Failed to fetch CSP violations");
      err.status = 500;
      return Promise.reject(err);
    });
    render(<CSPViolations />);
    expect(await screen.findByTestId("csp-violations-error")).toBeInTheDocument();
    expect(screen.getByText(/Failed to load CSP violations/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalled();
    });
  });

  it("renders the 'Access restricted' panel when the GET 403s", async () => {
    fetchApiMock.mockImplementation(() => {
      const err = new Error("Forbidden");
      err.status = 403;
      return Promise.reject(err);
    });
    render(<CSPViolations />);
    expect(await screen.findByText(/Access restricted/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Your role does not have permission to view CSP violations/i)
    ).toBeInTheDocument();
    // 403 should NOT toast — it's a known role-gated state, not an error.
    expect(notifyError).not.toHaveBeenCalled();
  });

  it("clicking Next advances the offset by limit and refetches", async () => {
    // Total of 250 rows so pagination is meaningful (limit=100 → 3 pages).
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith("/api/csp/violations")) {
        return Promise.resolve({
          total: 250,
          violations: sampleViolations,
          limit: 100,
          offset: url.includes("offset=") ? 100 : 0,
        });
      }
      return Promise.resolve(null);
    });
    render(<CSPViolations />);
    const nextBtn = await screen.findByTestId("csp-violations-next");
    expect(nextBtn).not.toBeDisabled();
    fetchApiMock.mockClear();

    fireEvent.click(nextBtn);

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([url]) => url.includes("offset=100"));
      expect(call).toBeTruthy();
    });
  });
});
