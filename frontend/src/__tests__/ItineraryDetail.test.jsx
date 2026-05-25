/**
 * ItineraryDetail.jsx — Travel CRM itinerary detail page (PRD §4.3 + §7).
 *
 * Pins the frontend contract for the detail surface that sits on top of
 * backend/routes/travel_itineraries.js (commits 1babe1b → f02fa5a chain).
 * Verifies:
 *   - Header renders destination + status badge after the GET resolves.
 *   - Items table renders rows for each item; empty list shows the
 *     PRD-correct "No items yet" state.
 *   - draftSummary block renders when present; empty state when null.
 *   - Regenerate draft button POSTs to /draft/regen + surfaces success.
 *   - Add item form POSTs the right shape (itemType + description +
 *     unitCost coerced to number).
 *   - Delete icon confirms + DELETEs the item.
 *   - Day costs panel (#907 slice 4) — collapsible section calls GET
 *     /day-costs lazily on first expand and renders the summary tiles
 *     + per-day breakdown with byType chips. Verifies happy path,
 *     loading + empty + 5xx error states, and that the GET fires only
 *     when the panel opens.
 *
 * Mock stability: useNotify, fetchApi, and AuthContext are stable
 * references per CLAUDE.md feedback rule. AuthContext uses the real
 * Provider wrap pattern (mirrors DiagnosticDetail.test.jsx) — do not
 * mock '../App' or useContext() will break.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

const fetchApiMock = vi.fn();
vi.mock("../utils/api", () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => "test-token",
}));

const notifyObj = {
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  confirm: vi.fn(() => Promise.resolve(true)),
  prompt: () => Promise.resolve(""),
};
vi.mock("../utils/notify", () => ({
  useNotify: () => notifyObj,
}));

import { AuthContext } from "../App";
import ItineraryDetail from "../pages/travel/ItineraryDetail";

const ITIN_WITH_ITEMS = {
  id: 42,
  tenantId: 9,
  subBrand: "tmc",
  destination: "Goa school trip Jan 2026",
  status: "draft",
  startDate: "2026-01-15T00:00:00.000Z",
  endDate: "2026-01-19T00:00:00.000Z",
  totalAmount: 145000,
  currency: "INR",
  productTier: "primary",
  draftSummary: "5-night Goa programme for 32 students of Class 9.",
  updatedAt: "2026-05-22T10:00:00.000Z",
  items: [
    {
      id: 101,
      itineraryId: 42,
      itemType: "flight",
      position: 0,
      description: "IndiGo 6E-237 BLR → GOI",
      unitCost: 8500,
      markup: 500,
      gstAmount: 450,
      totalPrice: 9450,
      detailsJson: null,
      supplierId: null,
    },
    {
      id: 102,
      itineraryId: 42,
      itemType: "hotel",
      position: 1,
      description: "Goa Beach Resort — 4 nights",
      unitCost: 12000,
      markup: 800,
      gstAmount: 1280,
      totalPrice: 14080,
      detailsJson: null,
      supplierId: null,
    },
  ],
};

const ITIN_EMPTY = {
  ...ITIN_WITH_ITEMS,
  id: 43,
  draftSummary: null,
  items: [],
};

// Day-costs envelope from GET /api/travel/itineraries/:id/day-costs
// (slice 2, commit 5ca25585). Shape: { itineraryId, days[], grandTotal,
// totalDays, averageDailyCost } where each day =
// { dayOffset, items[], totalCost, itemCount, byType }.
const DAY_COSTS_RESPONSE = {
  itineraryId: 42,
  days: [
    {
      dayOffset: 0,
      itemCount: 2,
      totalCost: 23530,
      byType: { flight: 9450, hotel: 14080 },
      items: [],
    },
    {
      dayOffset: 1,
      itemCount: 1,
      totalCost: 5500,
      byType: { activity: 5500 },
      items: [],
    },
  ],
  grandTotal: 29030,
  totalDays: 2,
  averageDailyCost: 14515,
};

const DAY_COSTS_EMPTY_RESPONSE = {
  itineraryId: 43,
  days: [],
  grandTotal: 0,
  totalDays: 0,
  averageDailyCost: 0,
};

function makeFetchImpl(getResponse = ITIN_WITH_ITEMS, opts = {}) {
  const dayCostsResp = opts.dayCosts !== undefined ? opts.dayCosts : DAY_COSTS_RESPONSE;
  const dayCostsError = opts.dayCostsError; // truthy → reject with shape { status, body }
  return (url, opts2) => {
    const method = (opts2?.method || "GET").toUpperCase();
    if (url.match(/^\/api\/travel\/itineraries\/\d+\/day-costs$/) && method === "GET") {
      if (dayCostsError) {
        return Promise.reject(dayCostsError);
      }
      return Promise.resolve(dayCostsResp);
    }
    if (url.match(/^\/api\/travel\/itineraries\/\d+$/) && method === "GET") {
      return Promise.resolve(getResponse);
    }
    if (url.match(/\/draft\/regen$/) && method === "POST") {
      return Promise.resolve({
        id: 42,
        draftSummary: "[STUB-BULK-TEXT] Regenerated draft.",
        model: "stub-gemini-flash",
        stub: true,
        generatedAt: "2026-05-22T11:00:00.000Z",
      });
    }
    if (url.match(/\/api\/travel\/itineraries\/\d+\/items$/) && method === "POST") {
      const body = JSON.parse(opts2.body);
      return Promise.resolve({ id: 999, itineraryId: 42, position: 2, ...body });
    }
    if (url.match(/\/api\/travel\/itineraries\/\d+\/items\/\d+$/) && method === "PATCH") {
      return Promise.resolve({ id: 101, ...JSON.parse(opts2.body) });
    }
    if (url.match(/\/api\/travel\/itineraries\/\d+\/items\/\d+$/) && method === "DELETE") {
      return Promise.resolve({ deleted: true, id: 101 });
    }
    if (url.match(/\/api\/travel\/itineraries\/\d+\/accept$/) && method === "POST") {
      return Promise.resolve({ id: 42, status: "accepted" });
    }
    if (url.match(/\/api\/travel\/itineraries\/\d+\/reject$/) && method === "POST") {
      return Promise.resolve({ id: 42, status: "rejected" });
    }
    if (url.match(/\/api\/travel\/itineraries\/\d+\/share$/) && method === "POST") {
      return Promise.resolve({
        shareToken: "abc123",
        shareUrl: "https://crm.globusdemos.com/p/itinerary/abc123",
      });
    }
    return Promise.resolve({});
  };
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyObj.error.mockReset();
  notifyObj.success.mockReset();
  notifyObj.info.mockReset();
  notifyObj.confirm.mockReset();
  notifyObj.confirm.mockImplementation(() => Promise.resolve(true));
  vi.spyOn(window, "confirm").mockImplementation(() => true);
  vi.spyOn(window, "prompt").mockImplementation(() => "test reason");
});

function renderPage({ role = "ADMIN" } = {}) {
  return render(
    <MemoryRouter initialEntries={["/travel/itineraries/42"]}>
      <AuthContext.Provider
        value={{
          user: { userId: 1, role },
          setUser: vi.fn(),
          token: "tk",
          tenant: { id: 1, vertical: "travel" },
          loading: false,
        }}
      >
        <Routes>
          <Route path="/travel/itineraries/:id" element={<ItineraryDetail />} />
        </Routes>
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

describe("ItineraryDetail — page contract", () => {
  it("renders the header with destination + status badge", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl(ITIN_WITH_ITEMS));
    renderPage();
    expect(await screen.findByText(/Goa school trip Jan 2026/)).toBeTruthy();
    // Status badge text "draft" is rendered as the badge label.
    expect(screen.getAllByText("draft").length).toBeGreaterThan(0);
    // Sub-brand badge "tmc"
    expect(screen.getByText("tmc")).toBeTruthy();
  });

  it("renders items table rows for each item", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl(ITIN_WITH_ITEMS));
    renderPage();
    expect(await screen.findByText("IndiGo 6E-237 BLR → GOI")).toBeTruthy();
    expect(screen.getByText("Goa Beach Resort — 4 nights")).toBeTruthy();
    // The two itemTypes — flight + hotel — render as labels.
    expect(screen.getByText("flight")).toBeTruthy();
    expect(screen.getByText("hotel")).toBeTruthy();
  });

  it("renders the empty items state when the list is empty", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl(ITIN_EMPTY));
    renderPage();
    expect(await screen.findByText(/No items yet/i)).toBeTruthy();
  });

  it("renders draftSummary when present, empty state when null", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl(ITIN_WITH_ITEMS));
    const { unmount } = renderPage();
    expect(await screen.findByText(/5-night Goa programme/)).toBeTruthy();
    unmount();

    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation(makeFetchImpl(ITIN_EMPTY));
    renderPage();
    expect(await screen.findByText(/No draft generated yet/i)).toBeTruthy();
  });

  it("Regenerate draft POSTs to /draft/regen and surfaces success", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl(ITIN_WITH_ITEMS));
    renderPage();
    await screen.findByText(/Goa school trip/);

    fireEvent.click(screen.getByRole("button", { name: /Regenerate draft summary/i }));

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        (c) => c[0] === "/api/travel/itineraries/42/draft/regen" && c[1]?.method === "POST",
      );
      expect(postCall).toBeTruthy();
    });
    expect(notifyObj.success).toHaveBeenCalledWith("Draft regenerated");
  });

  it("Add item form POSTs with the right body shape", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl(ITIN_WITH_ITEMS));
    renderPage();
    await screen.findByText(/Goa school trip/);

    fireEvent.click(screen.getByRole("button", { name: /Add item/i }));
    fireEvent.change(screen.getByPlaceholderText(/IndiGo 6E-237/i), {
      target: { value: "Activity — beach cleanup" },
    });
    // Set unit cost to verify Number-coercion happens before POST.
    const unitCostInputs = screen.getAllByLabelText(/Unit cost/i);
    fireEvent.change(unitCostInputs[0], { target: { value: "500" } });

    fireEvent.click(screen.getByRole("button", { name: /Save item/i }));

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        (c) =>
          c[0] === "/api/travel/itineraries/42/items" && c[1]?.method === "POST",
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.itemType).toBe("flight"); // default in EMPTY_ITEM
      expect(body.description).toBe("Activity — beach cleanup");
      expect(body.unitCost).toBe(500); // coerced to Number
    });
    expect(notifyObj.success).toHaveBeenCalledWith("Item added");
  });

  it("Delete icon confirms + DELETEs the item", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl(ITIN_WITH_ITEMS));
    renderPage();
    await screen.findByText(/Goa school trip/);

    fireEvent.click(screen.getByLabelText(/Delete item IndiGo 6E-237/i));

    await waitFor(() => {
      const delCall = fetchApiMock.mock.calls.find(
        (c) =>
          c[0] === "/api/travel/itineraries/42/items/101" &&
          c[1]?.method === "DELETE",
      );
      expect(delCall).toBeTruthy();
    });
    expect(notifyObj.success).toHaveBeenCalledWith("Item deleted");
  });

  it("Edit modal pre-fills + PATCHes with the modified shape", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl(ITIN_WITH_ITEMS));
    renderPage();
    await screen.findByText(/Goa school trip/);

    fireEvent.click(screen.getByLabelText(/Edit item IndiGo 6E-237/i));

    const titleInput = await screen.findByDisplayValue("IndiGo 6E-237 BLR → GOI");
    fireEvent.change(titleInput, { target: { value: "IndiGo 6E-237 — RESCHEDULED" } });

    const dialog = screen.getByRole("dialog", { name: /Edit item/i });
    fireEvent.click(within(dialog).getByRole("button", { name: /^Save$/ }));

    await waitFor(() => {
      const patchCall = fetchApiMock.mock.calls.find(
        (c) =>
          c[0] === "/api/travel/itineraries/42/items/101" &&
          c[1]?.method === "PATCH",
      );
      expect(patchCall).toBeTruthy();
      const body = JSON.parse(patchCall[1].body);
      expect(body.description).toBe("IndiGo 6E-237 — RESCHEDULED");
      expect(body.itemType).toBe("flight");
    });
    expect(notifyObj.success).toHaveBeenCalledWith("Item saved");
  });
});

// ─── Day costs panel (#907 slice 4) ─────────────────────────────────
//
// Consumes GET /api/travel/itineraries/:id/day-costs (slice 2,
// commit 5ca25585). The panel is a collapsible section that fetches
// lazily on first expand. These tests pin:
//   - Section is present in the rendered DOM (Day costs toggle button).
//   - GET fires only AFTER the toggle button is clicked (lazy).
//   - Summary tiles render totalDays / grandTotal / averageDailyCost.
//   - Per-day table shows Day index (1-based for display), itemCount,
//     totalCost, and byType chips for each grouped item type.
//   - Empty envelope (totalDays=0) shows the "No items in this
//     itinerary" empty state.
//   - 5xx from the endpoint fires notify.error.
//   - byType chips render one per type per day.
describe("ItineraryDetail — day costs panel (#907 slice 4)", () => {
  it("renders the Day costs toggle button", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl(ITIN_WITH_ITEMS));
    renderPage();
    await screen.findByText(/Goa school trip/);
    expect(screen.getByRole("button", { name: /Day costs/i })).toBeTruthy();
  });

  it("does NOT call /day-costs until the panel is expanded", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl(ITIN_WITH_ITEMS));
    renderPage();
    await screen.findByText(/Goa school trip/);

    // Before clicking, /day-costs should not have been called.
    const preCalls = fetchApiMock.mock.calls.filter(
      (c) => c[0] === "/api/travel/itineraries/42/day-costs",
    );
    expect(preCalls.length).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: /Day costs/i }));

    await waitFor(() => {
      const postCalls = fetchApiMock.mock.calls.filter(
        (c) => c[0] === "/api/travel/itineraries/42/day-costs",
      );
      expect(postCalls.length).toBe(1);
    });
  });

  it("renders summary tiles + per-day breakdown after fetch resolves", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl(ITIN_WITH_ITEMS));
    renderPage();
    await screen.findByText(/Goa school trip/);

    fireEvent.click(screen.getByRole("button", { name: /Day costs/i }));

    // Summary tiles — labels match (uppercase via CSS, DOM text is mixed-case):
    expect(await screen.findByText(/Total days/i)).toBeTruthy();
    expect(screen.getByText(/Grand total/i)).toBeTruthy();
    expect(screen.getByText(/Avg daily cost/i)).toBeTruthy();

    // Per-day rows: Day 1 + Day 2 (1-based for display, dayOffset 0/1).
    expect(screen.getByText("Day 1")).toBeTruthy();
    expect(screen.getByText("Day 2")).toBeTruthy();
  });

  it("renders byType chips for each day's grouped item types", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl(ITIN_WITH_ITEMS));
    renderPage();
    await screen.findByText(/Goa school trip/);

    fireEvent.click(screen.getByRole("button", { name: /Day costs/i }));

    // Day 0 has flight + hotel; Day 1 has activity. Chips render
    // "<type> · <fmtMoney(amount)>" inside a span — partial regex match.
    await screen.findByText("Day 1");
    expect(screen.getByText(/flight ·/i)).toBeTruthy();
    expect(screen.getByText(/hotel ·/i)).toBeTruthy();
    expect(screen.getByText(/activity ·/i)).toBeTruthy();
  });

  it("shows day count summary in the toggle header once loaded", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl(ITIN_WITH_ITEMS));
    renderPage();
    await screen.findByText(/Goa school trip/);

    fireEvent.click(screen.getByRole("button", { name: /Day costs/i }));

    // Toggle header annotates "<N> days · <grand total>" once loaded.
    await waitFor(() => {
      expect(screen.getByText(/2 days/i)).toBeTruthy();
    });
  });

  it("shows the empty state when totalDays === 0", async () => {
    fetchApiMock.mockImplementation(
      makeFetchImpl(ITIN_EMPTY, { dayCosts: DAY_COSTS_EMPTY_RESPONSE }),
    );
    renderPage();
    await screen.findByText(/Goa school trip/);

    fireEvent.click(screen.getByRole("button", { name: /Day costs/i }));

    expect(
      await screen.findByText(/No items in this itinerary/i),
    ).toBeTruthy();
  });

  it("fires notify.error when the endpoint returns 5xx", async () => {
    const err = { status: 500, body: { error: "Internal server error" } };
    fetchApiMock.mockImplementation(
      makeFetchImpl(ITIN_WITH_ITEMS, { dayCostsError: err }),
    );
    renderPage();
    await screen.findByText(/Goa school trip/);

    fireEvent.click(screen.getByRole("button", { name: /Day costs/i }));

    await waitFor(() => {
      expect(notifyObj.error).toHaveBeenCalledWith("Internal server error");
    });
  });

  it("does NOT re-fetch on a second toggle (lazy + cached)", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl(ITIN_WITH_ITEMS));
    renderPage();
    await screen.findByText(/Goa school trip/);

    // First expand fires the GET.
    fireEvent.click(screen.getByRole("button", { name: /Day costs/i }));
    await screen.findByText("Day 1");
    const afterFirstOpen = fetchApiMock.mock.calls.filter(
      (c) => c[0] === "/api/travel/itineraries/42/day-costs",
    ).length;
    expect(afterFirstOpen).toBe(1);

    // Collapse then re-expand — page should NOT refetch.
    fireEvent.click(screen.getByRole("button", { name: /Day costs/i }));
    fireEvent.click(screen.getByRole("button", { name: /Day costs/i }));
    const afterReopen = fetchApiMock.mock.calls.filter(
      (c) => c[0] === "/api/travel/itineraries/42/day-costs",
    ).length;
    expect(afterReopen).toBe(1);
  });
});
