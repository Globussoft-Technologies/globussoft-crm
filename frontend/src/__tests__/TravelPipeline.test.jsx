/**
 * TravelPipeline.test.jsx — vitest + RTL coverage for the Travel-vertical
 * Sales Pipeline page (frontend/src/pages/travel/TravelPipeline.jsx).
 *
 * Scope — pins the page-surface invariants:
 *   1. Page chrome: heading "Travel Pipeline" + Plane icon + Export + New Deal buttons
 *   2. Sub-line: "Sales pipeline — Draft / Negotiation / Won / Lost / Achieved. N deals."
 *   3. Filter bar: "All companies" select + "All statuses" select + two text inputs
 *      ("Filter by tour title..." + "Filter by contact name...")
 *   4. KPI tiles: Total pipeline value / Won / In negotiation / Lost
 *   5. Loading state before first GET resolves
 *   6. Table renders rows with correct columns (Tour title, Contact, Company, Package cost,
 *      Travel date, Status, Actions)
 *   7. Empty state: zero itineraries → "No deals yet" copy
 *   8. Sub-brand filter: selecting "TMC" re-fetches with ?subBrand=tmc
 *   9. Status filter: selecting "Accepted" re-fetches with ?status=accepted
 *  10. Text search filters rows client-side by destination
 *  11. Inline status dropdown: changing status PATCHes /api/travel/itineraries/:id
 *  12. KPI tiles compute correctly from itinerary data (won/negotiation/lost buckets)
 *  13. Export CSV button fires without error
 *  14. Delete flow: clicking trash → confirm → DELETE /api/travel/itineraries/:id
 *  15. Create drawer opens on "+ New Deal", validates required fields, POSTs on submit
 *  16. Error handling: GET failure surfaces notify.error
 *
 * Backend contract pinned:
 *   GET  /api/travel/itineraries[?subBrand=&status=&limit=&offset=]
 *        → 200 { itineraries: [...], total: N }
 *   PATCH /api/travel/itineraries/:id body:{ status }
 *        → 200 updated itinerary
 *   DELETE /api/travel/itineraries/:id → 200
 *   POST  /api/travel/itineraries body:{ contactId, subBrand, destination, ... }
 *        → 201 { id, ... }
 *   GET  /api/contacts?limit=200 → 200 [{ id, name, email }]
 */

import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { vi, describe, it, beforeEach, expect } from "vitest";
import React from "react";

// ── Stable notify mock (CLAUDE.md RTL rule: one object reference) ──────────
const notifyObj = {
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  confirm: vi.fn(),
};
vi.mock("../utils/notify", () => ({ useNotify: () => notifyObj }));
vi.mock("../utils/api", () => ({ fetchApi: vi.fn() }));
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return { ...actual, useNavigate: () => navigateMock };
});

const navigateMock = vi.fn();

import { fetchApi } from "../utils/api";
import { AuthContext } from "../App";
import TravelPipeline from "../pages/travel/TravelPipeline";

// ── Test data ────────────────────────────────────────────────────────────────

const ADMIN_USER = {
  userId: 1, name: "Admin", email: "admin@test.com",
  role: "ADMIN",
  tenant: { vertical: "travel", defaultCurrency: "INR" },
  subBrandAccess: ["tmc", "rfu", "travelstall", "visasure"],
};

function makeItin(overrides = {}) {
  return {
    id: 1,
    destination: "Bali Honeymoon Special",
    contactId: 10,
    contact: { id: 10, name: "Sankar Rathod", email: "sankar@test.com" },
    subBrand: "tmc",
    totalAmount: 124300,
    currency: "INR",
    status: "accepted",
    startDate: "2026-08-12T00:00:00.000Z",
    endDate: "2026-08-20T00:00:00.000Z",
    createdAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

const DEFAULT_ITINS = [
  makeItin({ id: 1, destination: "Bali Honeymoon Special", status: "accepted", totalAmount: 124300 }),
  makeItin({ id: 2, destination: "Europe Grand Tour", subBrand: "travelstall", status: "sent", totalAmount: 467000, contact: { id: 11, name: "Meera Iyer", email: "meera@test.com" }, contactId: 11 }),
  makeItin({ id: 3, destination: "Ladakh Adventure Circuit", subBrand: "travelstall", status: "rejected", totalAmount: 210500, contact: { id: 12, name: "Priya Nair", email: "priya@test.com" }, contactId: 12 }),
];

function mockFetch(itins = DEFAULT_ITINS, contacts = []) {
  fetchApi.mockImplementation((url) => {
    if (url.includes("/api/travel/itineraries")) {
      return Promise.resolve({ itineraries: itins, total: itins.length });
    }
    if (url.includes("/api/contacts")) {
      return Promise.resolve(contacts);
    }
    return Promise.resolve({});
  });
}

function renderPage(user = ADMIN_USER) {
  return render(
    <AuthContext.Provider value={{ user }}>
      <MemoryRouter>
        <TravelPipeline />
      </MemoryRouter>
    </AuthContext.Provider>
  );
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("TravelPipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    notifyObj.confirm.mockResolvedValue(true);
    mockFetch();
  });

  // 1. Page chrome
  it("renders heading and action buttons", async () => {
    renderPage();
    expect(await screen.findByText("Travel Pipeline")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /new deal/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /export/i })).toBeInTheDocument();
  });

  // 2. Sub-line
  it("shows sub-line with stage names and deal count", async () => {
    renderPage();
    await screen.findByText("Travel Pipeline");
    // These words appear in the sub-line and also in KPI tiles / status dropdowns —
    // use getAllByText to allow multiple matches.
    expect(screen.getAllByText(/Draft/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Negotiation/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Won/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Lost/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Achieved/).length).toBeGreaterThanOrEqual(1);
    // deal count appears in the sub-line
    expect(screen.getByText(String(DEFAULT_ITINS.length))).toBeInTheDocument();
  });

  // 3. Filter bar
  it("renders filter bar with correct placeholders", async () => {
    renderPage();
    await screen.findByText("Travel Pipeline");
    expect(screen.getByRole("combobox", { name: /filter by sub-brand/i })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /filter by status/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Filter by tour title...")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Filter by contact name...")).toBeInTheDocument();
  });

  // 4. KPI tiles present
  it("renders four KPI tiles", async () => {
    renderPage();
    await screen.findByText("Total pipeline value");
    // "Won" and "Lost" also appear as status options in dropdowns — allow multiple matches
    expect(screen.getAllByText("Won").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("In negotiation")).toBeInTheDocument();
    expect(screen.getAllByText("Lost").length).toBeGreaterThanOrEqual(1);
  });

  // 5. Loading state
  it("shows loading state while fetch is in-flight", () => {
    fetchApi.mockReturnValue(new Promise(() => {})); // never resolves
    renderPage();
    expect(screen.getByText(/loading pipeline/i)).toBeInTheDocument();
  });

  // 6. Table renders rows
  it("renders a row per itinerary with expected columns", async () => {
    renderPage();
    await screen.findByText("Bali Honeymoon Special");
    expect(screen.getByText("Sankar Rathod")).toBeInTheDocument();
    expect(screen.getByText("Europe Grand Tour")).toBeInTheDocument();
    expect(screen.getByText("Meera Iyer")).toBeInTheDocument();
    // table headers
    expect(screen.getByText("Tour title")).toBeInTheDocument();
    expect(screen.getByText("Contact")).toBeInTheDocument();
    expect(screen.getByText("Company")).toBeInTheDocument();
    expect(screen.getByText("Package cost")).toBeInTheDocument();
    expect(screen.getByText("Travel date")).toBeInTheDocument();
    expect(screen.getByText("Status")).toBeInTheDocument();
  });

  // 7. Empty state
  it("shows empty state when no itineraries returned", async () => {
    mockFetch([]);
    renderPage();
    await screen.findByText(/No deals yet/i);
  });

  // 8. Sub-brand filter re-fetches
  it("sub-brand filter triggers re-fetch with ?subBrand=tmc", async () => {
    renderPage();
    await screen.findByText("Bali Honeymoon Special");
    const subBrandSelect = screen.getByRole("combobox", { name: /filter by sub-brand/i });
    fireEvent.change(subBrandSelect, { target: { value: "tmc" } });
    await waitFor(() => {
      const calls = fetchApi.mock.calls.map((c) => c[0]);
      expect(calls.some((url) => url.includes("subBrand=tmc"))).toBe(true);
    });
  });

  // 9. Status filter re-fetches
  it("status filter triggers re-fetch with ?status=accepted", async () => {
    renderPage();
    await screen.findByText("Bali Honeymoon Special");
    const statusSelect = screen.getByRole("combobox", { name: /filter by status/i });
    fireEvent.change(statusSelect, { target: { value: "accepted" } });
    await waitFor(() => {
      const calls = fetchApi.mock.calls.map((c) => c[0]);
      expect(calls.some((url) => url.includes("status=accepted"))).toBe(true);
    });
  });

  // 10. Text search filters client-side
  it("text search hides non-matching rows without re-fetching", async () => {
    renderPage();
    await screen.findByText("Bali Honeymoon Special");
    const prevCallCount = fetchApi.mock.calls.length;
    const searchInput = screen.getByPlaceholderText("Filter by tour title...");
    fireEvent.change(searchInput, { target: { value: "bali" } });
    // Bali row still visible
    expect(screen.getByText("Bali Honeymoon Special")).toBeInTheDocument();
    // Europe row hidden
    expect(screen.queryByText("Europe Grand Tour")).not.toBeInTheDocument();
    // no extra fetch fired
    expect(fetchApi.mock.calls.length).toBe(prevCallCount);
  });

  // 11. Inline status PATCH
  it("inline status dropdown PATCHes the itinerary", async () => {
    fetchApi.mockImplementation((url, opts) => {
      if (opts?.method === "PATCH") return Promise.resolve({ ...DEFAULT_ITINS[0], status: "draft" });
      if (url.includes("/api/travel/itineraries")) return Promise.resolve({ itineraries: DEFAULT_ITINS, total: DEFAULT_ITINS.length });
      return Promise.resolve({});
    });
    renderPage();
    await screen.findByText("Bali Honeymoon Special");
    const statusDropdowns = screen.getAllByRole("combobox", { name: /change status/i });
    fireEvent.change(statusDropdowns[0], { target: { value: "draft" } });
    await waitFor(() => {
      const patchCall = fetchApi.mock.calls.find((c) => c[1]?.method === "PATCH");
      expect(patchCall).toBeTruthy();
      expect(patchCall[0]).toMatch(/\/api\/travel\/itineraries\/1/);
      expect(JSON.parse(patchCall[1].body)).toEqual({ status: "draft" });
    });
  });

  // 12. KPI tile values
  it("computes KPI tiles from itinerary amounts", async () => {
    renderPage();
    await screen.findByText("Total pipeline value");
    // accepted=124300 + sent=467000 + rejected=210500 = 801800
    // fmtMoney(801800, 'INR'): 801800 >= 100000 → ₹8.02L
    expect(screen.getByText("₹8.02L")).toBeInTheDocument();
  });

  // 13. Export CSV
  it("export CSV button fires without throwing", async () => {
    renderPage();
    await screen.findByText("Bali Honeymoon Special");
    // JSDOM doesn't support URL.createObjectURL — mock it
    const createObjectURL = vi.fn(() => "blob:test");
    const revokeObjectURL = vi.fn();
    global.URL.createObjectURL = createObjectURL;
    global.URL.revokeObjectURL = revokeObjectURL;
    const exportBtn = screen.getByRole("button", { name: /export/i });
    fireEvent.click(exportBtn);
    expect(createObjectURL).toHaveBeenCalled();
  });

  // 14. Delete flow
  it("delete fires DELETE request and removes row", async () => {
    fetchApi.mockImplementation((url, opts) => {
      if (opts?.method === "DELETE") return Promise.resolve({ ok: true });
      if (url.includes("/api/travel/itineraries")) return Promise.resolve({ itineraries: DEFAULT_ITINS, total: DEFAULT_ITINS.length });
      return Promise.resolve({});
    });
    renderPage();
    await screen.findByText("Bali Honeymoon Special");
    const deleteBtn = screen.getAllByRole("button", { name: /delete itinerary/i })[0];
    fireEvent.click(deleteBtn);
    await waitFor(() => {
      const delCall = fetchApi.mock.calls.find((c) => c[1]?.method === "DELETE");
      expect(delCall).toBeTruthy();
      expect(delCall[0]).toMatch(/\/api\/travel\/itineraries\/1/);
    });
    expect(notifyObj.success).toHaveBeenCalledWith("Itinerary deleted");
  });

  // 15a. Create drawer opens
  it("+ New Deal opens the create drawer", async () => {
    renderPage();
    await screen.findByText("Travel Pipeline");
    const newBtn = screen.getByRole("button", { name: /new deal/i });
    fireEvent.click(newBtn);
    expect(await screen.findByRole("dialog", { name: /new deal/i })).toBeInTheDocument();
    expect(screen.getByLabelText("Contact")).toBeInTheDocument();
    expect(screen.getByLabelText("Destination / Tour title")).toBeInTheDocument();
  });

  // 15b. Create validation
  it("create form validates required fields", async () => {
    mockFetch(DEFAULT_ITINS, [{ id: 1, name: "Test Contact", email: "t@t.com" }]);
    renderPage();
    await screen.findByText("Travel Pipeline");
    fireEvent.click(screen.getByRole("button", { name: /new deal/i }));
    const dialog = await screen.findByRole("dialog", { name: /new deal/i });
    // no contact selected → fire submit on the form directly → notify.error
    fireEvent.submit(dialog);
    await waitFor(() => {
      expect(notifyObj.error).toHaveBeenCalledWith("Contact is required");
    });
  });

  // 15c. Create happy path
  it("create form POSTs to /api/travel/itineraries on valid submit", async () => {
    const contacts = [{ id: 5, name: "Sankar Rathod", email: "sankar@test.com" }];
    fetchApi.mockImplementation((url, opts) => {
      if (opts?.method === "POST") return Promise.resolve({ id: 99, destination: "New Trip" });
      if (url.includes("/api/travel/itineraries")) return Promise.resolve({ itineraries: DEFAULT_ITINS, total: DEFAULT_ITINS.length });
      if (url.includes("/api/contacts")) return Promise.resolve(contacts);
      return Promise.resolve({});
    });
    renderPage();
    await screen.findByText("Travel Pipeline");
    fireEvent.click(screen.getByRole("button", { name: /new deal/i }));
    await screen.findByRole("dialog", { name: /new deal/i });
    // select contact
    fireEvent.change(screen.getByLabelText("Contact"), { target: { value: "5" } });
    // set destination
    fireEvent.change(screen.getByLabelText("Destination / Tour title"), { target: { value: "New Trip to Goa" } });
    // submit
    fireEvent.click(screen.getByRole("button", { name: /create deal/i }));
    await waitFor(() => {
      const postCall = fetchApi.mock.calls.find((c) => c[1]?.method === "POST");
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.contactId).toBe(5);
      expect(body.destination).toBe("New Trip to Goa");
    });
    expect(notifyObj.success).toHaveBeenCalledWith("Itinerary created");
  });

  // 16. GET error handling
  it("surfaces error when GET fails", async () => {
    fetchApi.mockRejectedValue({ body: { error: "Server error" } });
    renderPage();
    await waitFor(() => {
      expect(notifyObj.error).toHaveBeenCalledWith("Server error");
    });
  });

  // Sub-brand badge renders correct labels
  it("renders sub-brand badges with correct labels", async () => {
    renderPage();
    await screen.findByText("Bali Honeymoon Special");
    // TMC badge
    const tmcBadges = screen.getAllByText("TMC");
    expect(tmcBadges.length).toBeGreaterThanOrEqual(1);
    // TravelStall badge
    const tsLabel = screen.getAllByText("TravelStall");
    expect(tsLabel.length).toBeGreaterThanOrEqual(1);
  });

  // Refresh button re-fetches
  it("refresh button triggers re-fetch", async () => {
    renderPage();
    await screen.findByText("Bali Honeymoon Special");
    const prevCount = fetchApi.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: /refresh pipeline/i }));
    await waitFor(() => {
      expect(fetchApi.mock.calls.length).toBeGreaterThan(prevCount);
    });
  });
});
