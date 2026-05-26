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
      // #907 slice 5 — per-day margin breakdown from the helper.
      supplierCost: 20500,
      markupTotal: 1300,
      gstTotal: 1730,
      byType: { flight: 9450, hotel: 14080 },
      items: [],
    },
    {
      dayOffset: 1,
      itemCount: 1,
      totalCost: 5500,
      supplierCost: 4500,
      markupTotal: 800,
      gstTotal: 200,
      byType: { activity: 5500 },
      items: [],
    },
  ],
  grandTotal: 29030,
  // #907 slice 5 — grand-total mirror of the margin breakdown.
  grandSupplierCost: 25000,
  grandMarkupTotal: 2100,
  grandGstTotal: 1930,
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

  // ─── #907 slice 5 — per-day margin breakdown ─────────────────────
  //
  // The envelope now carries grandSupplierCost / grandMarkupTotal /
  // grandGstTotal (full-trip margin) plus per-day supplierCost /
  // markupTotal / gstTotal. UI surfaces the grand-totals as 3 extra
  // summary tiles and shows a per-day margin caption beneath each day's
  // totalCost. Tests pin:
  //   - The 3 extra summary tiles render after fetch.
  //   - Each day-row has a margin caption (Supplier · Markup · GST).
  //   - Backwards-compat: if the envelope omits the new fields (older
  //     backend), neither the tiles nor the captions render.
  it("renders the 3 margin summary tiles (Supplier / Markup / GST)", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl(ITIN_WITH_ITEMS));
    renderPage();
    await screen.findByText(/Goa school trip/);

    fireEvent.click(screen.getByRole("button", { name: /Day costs/i }));

    expect(await screen.findByText(/Supplier cost/i)).toBeTruthy();
    // "Markup" / "GST" also appear as field labels in the add/edit item
    // form ("Markup" / "GST amount") — use getAllByText since both labels
    // can be present simultaneously when the form is rendered.
    expect(screen.getAllByText(/^Markup$/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/^GST$/i).length).toBeGreaterThan(0);
  });

  it("renders per-day margin caption beneath each day's total", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl(ITIN_WITH_ITEMS));
    renderPage();
    await screen.findByText(/Goa school trip/);

    fireEvent.click(screen.getByRole("button", { name: /Day costs/i }));
    await screen.findByText("Day 1");

    // Day 1 caption: aria-label exposes the per-day breakdown.
    expect(
      screen.getByLabelText(/Day 1 margin breakdown/i),
    ).toBeTruthy();
    expect(
      screen.getByLabelText(/Day 2 margin breakdown/i),
    ).toBeTruthy();
  });

  it("omits margin tiles + per-day captions when envelope has no margin fields (back-compat)", async () => {
    // Simulate an older backend whose envelope lacks the slice-5 fields.
    const legacyResp = {
      itineraryId: 42,
      days: [
        {
          dayOffset: 0,
          itemCount: 1,
          totalCost: 100,
          byType: { hotel: 100 },
          items: [],
        },
      ],
      grandTotal: 100,
      totalDays: 1,
      averageDailyCost: 100,
    };
    fetchApiMock.mockImplementation(
      makeFetchImpl(ITIN_WITH_ITEMS, { dayCosts: legacyResp }),
    );
    renderPage();
    await screen.findByText(/Goa school trip/);

    fireEvent.click(screen.getByRole("button", { name: /Day costs/i }));
    await screen.findByText("Day 1");

    // The existing tiles + per-day rows still render.
    expect(screen.getByText(/Total days/i)).toBeTruthy();
    expect(screen.getByText(/Grand total/i)).toBeTruthy();
    // The slice-5 tiles must NOT render — `Supplier cost` is the
    // disambiguating label (different from per-day caption text).
    expect(screen.queryByText(/Supplier cost/i)).toBeNull();
    // And the per-day margin caption aria-label is absent.
    expect(screen.queryByLabelText(/Day 1 margin breakdown/i)).toBeNull();
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

// ─── Status transitions + acceptance/rejection flows ──────────────
//
// Pins the Accept/Reject button surface (PRD §4.3 manager workflow).
// Accept calls POST /:id/accept after a window.confirm(); Reject calls
// POST /:id/reject after window.prompt() with the optional reason.
// Terminal status (accepted/rejected) hides the Accept + Reject buttons.
// Non-edit roles (USER) hide ALL canEdit-gated actions (Accept/Reject/
// Regenerate draft/Add item/Edit/Delete icons).
describe("ItineraryDetail — status transitions + acceptance/rejection", () => {
  it("Accept button POSTs to /:id/accept after window.confirm()", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl(ITIN_WITH_ITEMS));
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPage();
    await screen.findByText(/Goa school trip/);

    fireEvent.click(screen.getByRole("button", { name: /Accept itinerary/i }));

    await waitFor(() => {
      const acceptCall = fetchApiMock.mock.calls.find(
        (c) =>
          c[0] === "/api/travel/itineraries/42/accept" &&
          c[1]?.method === "POST",
      );
      expect(acceptCall).toBeTruthy();
    });
    expect(confirmSpy).toHaveBeenCalled();
    expect(notifyObj.success).toHaveBeenCalledWith("Itinerary accepted");
  });

  it("Accept aborts (no POST) when window.confirm() returns false", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl(ITIN_WITH_ITEMS));
    vi.spyOn(window, "confirm").mockReturnValue(false);
    renderPage();
    await screen.findByText(/Goa school trip/);

    fireEvent.click(screen.getByRole("button", { name: /Accept itinerary/i }));

    // Give any pending microtasks a chance to run; then assert no POST.
    await waitFor(() => {
      const gets = fetchApiMock.mock.calls.filter(
        (c) => c[0] === "/api/travel/itineraries/42" && (!c[1] || c[1].method === undefined || c[1].method === "GET"),
      );
      expect(gets.length).toBeGreaterThan(0);
    });
    const acceptCall = fetchApiMock.mock.calls.find(
      (c) => c[0] === "/api/travel/itineraries/42/accept",
    );
    expect(acceptCall).toBeFalsy();
    expect(notifyObj.success).not.toHaveBeenCalledWith("Itinerary accepted");
  });

  it("Reject POSTs to /:id/reject with the reason from window.prompt()", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl(ITIN_WITH_ITEMS));
    vi.spyOn(window, "prompt").mockReturnValue("Budget exceeded");
    renderPage();
    await screen.findByText(/Goa school trip/);

    fireEvent.click(screen.getByRole("button", { name: /Reject itinerary/i }));

    await waitFor(() => {
      const rejectCall = fetchApiMock.mock.calls.find(
        (c) =>
          c[0] === "/api/travel/itineraries/42/reject" &&
          c[1]?.method === "POST",
      );
      expect(rejectCall).toBeTruthy();
      const body = JSON.parse(rejectCall[1].body);
      expect(body.reason).toBe("Budget exceeded");
    });
    expect(notifyObj.success).toHaveBeenCalledWith("Itinerary rejected");
  });

  it("Reject aborts (no POST) when prompt is cancelled (returns null)", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl(ITIN_WITH_ITEMS));
    vi.spyOn(window, "prompt").mockReturnValue(null);
    renderPage();
    await screen.findByText(/Goa school trip/);

    fireEvent.click(screen.getByRole("button", { name: /Reject itinerary/i }));

    // Wait a tick — give the synchronous prompt + early-return path a chance.
    await new Promise((r) => setTimeout(r, 0));
    const rejectCall = fetchApiMock.mock.calls.find(
      (c) => c[0] === "/api/travel/itineraries/42/reject",
    );
    expect(rejectCall).toBeFalsy();
  });

  it("Reject with empty string sends an empty-body POST (no reason field)", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl(ITIN_WITH_ITEMS));
    vi.spyOn(window, "prompt").mockReturnValue("");
    renderPage();
    await screen.findByText(/Goa school trip/);

    fireEvent.click(screen.getByRole("button", { name: /Reject itinerary/i }));

    await waitFor(() => {
      const rejectCall = fetchApiMock.mock.calls.find(
        (c) =>
          c[0] === "/api/travel/itineraries/42/reject" &&
          c[1]?.method === "POST",
      );
      expect(rejectCall).toBeTruthy();
      const body = JSON.parse(rejectCall[1].body);
      // SUT: `reason ? { reason } : {}` — empty string is falsy → {}.
      expect(body.reason).toBeUndefined();
    });
  });

  it("hides Accept + Reject buttons when status is terminal (accepted)", async () => {
    const accepted = { ...ITIN_WITH_ITEMS, status: "accepted" };
    fetchApiMock.mockImplementation(makeFetchImpl(accepted));
    renderPage();
    await screen.findByText(/Goa school trip/);

    expect(screen.queryByRole("button", { name: /Accept itinerary/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Reject itinerary/i })).toBeNull();
    // Regenerate draft is canEdit but NOT gated on isTerminal — still present.
    expect(screen.getByRole("button", { name: /Regenerate draft summary/i })).toBeTruthy();
  });

  it("hides Accept + Reject buttons when status is terminal (rejected)", async () => {
    const rejected = { ...ITIN_WITH_ITEMS, status: "rejected" };
    fetchApiMock.mockImplementation(makeFetchImpl(rejected));
    renderPage();
    await screen.findByText(/Goa school trip/);

    expect(screen.queryByRole("button", { name: /Accept itinerary/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Reject itinerary/i })).toBeNull();
  });

  it("non-edit role (USER) hides Accept / Reject / Regenerate / Add item", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl(ITIN_WITH_ITEMS));
    renderPage({ role: "USER" });
    await screen.findByText(/Goa school trip/);

    expect(screen.queryByRole("button", { name: /Accept itinerary/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Reject itinerary/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Regenerate draft summary/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Add item$/i })).toBeNull();
    // Share link + PDF stay visible (not canEdit-gated).
    expect(screen.getByRole("button", { name: /Generate share link/i })).toBeTruthy();
  });

  it("MANAGER role exposes Accept / Reject just like ADMIN (canEdit gate)", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl(ITIN_WITH_ITEMS));
    renderPage({ role: "MANAGER" });
    await screen.findByText(/Goa school trip/);

    expect(screen.getByRole("button", { name: /Accept itinerary/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Reject itinerary/i })).toBeTruthy();
  });

  it("Accept surfaces error from server response body", async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      const method = (opts?.method || "GET").toUpperCase();
      if (url === "/api/travel/itineraries/42" && method === "GET") {
        return Promise.resolve(ITIN_WITH_ITEMS);
      }
      if (url === "/api/travel/itineraries/42/accept" && method === "POST") {
        return Promise.reject({ status: 409, body: { error: "Already accepted" } });
      }
      return Promise.resolve({});
    });
    renderPage();
    await screen.findByText(/Goa school trip/);

    fireEvent.click(screen.getByRole("button", { name: /Accept itinerary/i }));

    await waitFor(() => {
      expect(notifyObj.error).toHaveBeenCalledWith("Already accepted");
    });
  });
});

// ─── Share link + PDF download ───────────────────────────────────
//
// Pins the share + PDF surface. Generate Share POSTs to /:id/share and
// stores the returned shareUrl in local state, rendering an input box
// + copy button. The copy button writes to navigator.clipboard.
// The PDF link is a plain <a> whose href includes the auth token as
// _t= query string (bearer-via-query for the open-in-tab case).
describe("ItineraryDetail — share link + PDF download", () => {
  it("Generate share link POSTs to /:id/share + renders the URL input", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl(ITIN_WITH_ITEMS));
    renderPage();
    await screen.findByText(/Goa school trip/);

    fireEvent.click(screen.getByRole("button", { name: /Generate share link/i }));

    // Wait directly for the URL input to appear — the SUT renders it
    // conditionally on shareUrl state, and findBy waits for React's render.
    const urlInput = await screen.findByDisplayValue(
      "https://crm.globusdemos.com/p/itinerary/abc123",
    );
    expect(urlInput).toBeTruthy();

    const shareCall = fetchApiMock.mock.calls.find(
      (c) =>
        c[0] === "/api/travel/itineraries/42/share" &&
        c[1]?.method === "POST",
    );
    expect(shareCall).toBeTruthy();
    expect(notifyObj.success).toHaveBeenCalledWith("Share link generated");
  });

  it("Copy share URL writes to navigator.clipboard + surfaces success", async () => {
    const writeText = vi.fn().mockResolvedValue();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });
    fetchApiMock.mockImplementation(makeFetchImpl(ITIN_WITH_ITEMS));
    renderPage();
    await screen.findByText(/Goa school trip/);

    fireEvent.click(screen.getByRole("button", { name: /Generate share link/i }));
    await screen.findByDisplayValue(
      "https://crm.globusdemos.com/p/itinerary/abc123",
    );

    fireEvent.click(screen.getByRole("button", { name: /Copy share URL/i }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        "https://crm.globusdemos.com/p/itinerary/abc123",
      );
    });
    expect(notifyObj.success).toHaveBeenCalledWith("Copied to clipboard");
  });

  it("Copy fires error notification when clipboard write rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });
    fetchApiMock.mockImplementation(makeFetchImpl(ITIN_WITH_ITEMS));
    renderPage();
    await screen.findByText(/Goa school trip/);

    fireEvent.click(screen.getByRole("button", { name: /Generate share link/i }));
    await screen.findByDisplayValue(
      "https://crm.globusdemos.com/p/itinerary/abc123",
    );
    fireEvent.click(screen.getByRole("button", { name: /Copy share URL/i }));

    await waitFor(() => {
      expect(notifyObj.error).toHaveBeenCalledWith(
        expect.stringMatching(/Copy failed/i),
      );
    });
  });

  it("Share endpoint error surfaces notify.error", async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      const method = (opts?.method || "GET").toUpperCase();
      if (url === "/api/travel/itineraries/42" && method === "GET") {
        return Promise.resolve(ITIN_WITH_ITEMS);
      }
      if (url === "/api/travel/itineraries/42/share" && method === "POST") {
        return Promise.reject({ status: 500, body: { error: "Share service down" } });
      }
      return Promise.resolve({});
    });
    renderPage();
    await screen.findByText(/Goa school trip/);

    fireEvent.click(screen.getByRole("button", { name: /Generate share link/i }));

    await waitFor(() => {
      expect(notifyObj.error).toHaveBeenCalledWith("Share service down");
    });
  });

  it("PDF anchor href contains the itinerary id + auth token query string", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl(ITIN_WITH_ITEMS));
    const { container } = renderPage();
    await screen.findByText(/Goa school trip/);

    const pdfLink = container.querySelector('a[href*="/pdf"]');
    expect(pdfLink).toBeTruthy();
    expect(pdfLink.getAttribute("href")).toContain("/api/travel/itineraries/42/pdf");
    expect(pdfLink.getAttribute("href")).toContain("_t=test-token");
    expect(pdfLink.getAttribute("target")).toBe("_blank");
  });
});

// ─── Regen stub model label + draft empty + add item validation ──
describe("ItineraryDetail — regen stub label + form validation", () => {
  it("renders the LLM model label + (stub) annotation after regen", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl(ITIN_WITH_ITEMS));
    renderPage();
    await screen.findByText(/Goa school trip/);

    fireEvent.click(screen.getByRole("button", { name: /Regenerate draft summary/i }));

    // Label format: "LLM: <model> (stub)"
    await waitFor(() => {
      expect(screen.getByText(/LLM:/i)).toBeTruthy();
    });
    expect(screen.getByText(/stub-gemini-flash/i)).toBeTruthy();
    expect(screen.getByText(/\(stub\)/i)).toBeTruthy();
  });

  it("Add item with no description fires notify.error (no POST)", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl(ITIN_WITH_ITEMS));
    renderPage();
    await screen.findByText(/Goa school trip/);

    fireEvent.click(screen.getByRole("button", { name: /^Add item$/i }));
    // Leave description empty; click Save item.
    fireEvent.click(screen.getByRole("button", { name: /Save item/i }));

    await waitFor(() => {
      expect(notifyObj.error).toHaveBeenCalledWith(
        expect.stringMatching(/description required/i),
      );
    });
    // No POST to /items happened.
    const postCall = fetchApiMock.mock.calls.find(
      (c) =>
        c[0] === "/api/travel/itineraries/42/items" && c[1]?.method === "POST",
    );
    expect(postCall).toBeFalsy();
  });

  it("Cancel Add item resets the form (clicking Add item again shows fresh fields)", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl(ITIN_WITH_ITEMS));
    renderPage();
    await screen.findByText(/Goa school trip/);

    fireEvent.click(screen.getByRole("button", { name: /^Add item$/i }));
    const descInput = screen.getByPlaceholderText(/IndiGo 6E-237/i);
    fireEvent.change(descInput, { target: { value: "Scratch description" } });
    expect(descInput.value).toBe("Scratch description");

    // Cancel — collapses the form.
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));
    expect(screen.queryByPlaceholderText(/IndiGo 6E-237/i)).toBeNull();

    // Re-open — should show an empty description (reset to EMPTY_ITEM).
    fireEvent.click(screen.getByRole("button", { name: /^Add item$/i }));
    const reopened = screen.getByPlaceholderText(/IndiGo 6E-237/i);
    expect(reopened.value).toBe("");
  });

  it("renders 'Itinerary not found' when GET resolves with null", async () => {
    fetchApiMock.mockImplementation(() => Promise.resolve(null));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/Itinerary not found/i)).toBeTruthy();
    });
  });

  it("surfaces error notification when initial GET rejects", async () => {
    fetchApiMock.mockImplementation(() =>
      Promise.reject({ status: 500, body: { error: "Boom" } }),
    );
    renderPage();
    await waitFor(() => {
      expect(notifyObj.error).toHaveBeenCalledWith("Boom");
    });
    // Page falls into the "not found" state when load rejects.
    expect(screen.getByText(/Itinerary not found/i)).toBeTruthy();
  });
});
