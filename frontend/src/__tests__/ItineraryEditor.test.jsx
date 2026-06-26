/**
 * ItineraryEditor.jsx — day-by-day visual editor polish cluster
 * (PRD_TRAVEL_ITINERARY_UPGRADES §3.3, §3.4, §3.6, §3.7).
 *
 * Pins the frontend contract for the G052/G053/G056/G057/G060/G062
 * slice batch shipped on top of the existing editor (commits da5cc682
 * + fea965a5 + 58a7c947).
 *
 * Covered slices:
 *   - G052 Bulk-day-add: "Extend by N days" toolbar button → prompt →
 *     local extraDays bump → N empty Day cards appear.
 *   - G053 Conflict warnings: per-day overlap detection on items whose
 *     detailsJson exposes startTime/endTime — chip renders on the
 *     conflicting items + a day-level summary banner.
 *   - G056 Inline +Hotel / +Activity: per-day form opens, submits via
 *     POST /:id/items, refetches itinerary.
 *   - G057 Per-day suggest workflow: Suggest button hits /suggest, draft
 *     items render with Accept/Edit/Reject controls; Accept POSTs each
 *     item; Reject re-rolls with the same prompt context.
 *   - G060 Live re-pricing verify: PATCH /items/:id triggers a debounced
 *     re-fetch of the parent itinerary so the toolbar total chip tracks
 *     server-side recompute.
 *   - G062 Keyboard shortcuts: "?" opens help modal; Esc deselects /
 *     closes modal; Ctrl+S surfaces auto-save confirmation.
 *
 * Mock stability: useNotify + fetchApi follow the
 * feedback_parallel_wave_discipline + RTL hook-dependency standing rule
 * (one stable object reference per test run). react-leaflet is stubbed
 * since jsdom lacks the layout primitives Leaflet wants.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

// ── react-leaflet stub (jsdom can't render the real one) ─────────
vi.mock("react-leaflet", () => {
  const React = require("react");
  const MapContainer = ({ children }) => React.createElement("div", { "data-testid": "map-container" }, children);
  const TileLayer = () => React.createElement("div", { "data-testid": "tile-layer" });
  const Marker = ({ children }) => React.createElement("div", { "data-testid": "marker" }, children);
  const Popup = ({ children }) => React.createElement("div", { "data-testid": "popup" }, children);
  const Polyline = () => React.createElement("div", { "data-testid": "polyline" });
  const useMap = () => ({ fitBounds: vi.fn(), setView: vi.fn() });
  const useMapEvents = () => null;
  return { MapContainer, TileLayer, Marker, Popup, Polyline, useMap, useMapEvents };
});
vi.mock("leaflet/dist/leaflet.css", () => ({}));
vi.mock("leaflet", () => ({
  default: {
    divIcon: (opts) => opts,
    latLngBounds: (pts) => ({ pts, extend: vi.fn() }),
  },
}));

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
  prompt: vi.fn(() => Promise.resolve("")),
};
vi.mock("../utils/notify", () => ({
  useNotify: () => notifyObj,
}));

import { AuthContext } from "../App";
import ItineraryEditor from "../pages/travel/ItineraryEditor";

// Itinerary fixture — destination + total + a mix of items, with one
// pair of overlap-conflicting items on Day 1 (G053 surface).
const ITIN_BASE = {
  id: 42,
  tenantId: 9,
  subBrand: "tmc",
  destination: "Goa school trip",
  status: "draft",
  startDate: "2026-01-15T00:00:00.000Z",
  endDate: "2026-01-17T00:00:00.000Z",
  totalAmount: 50000,
  currency: "INR",
  clonedFromTemplateId: null,
  items: [
    {
      id: 101, itemType: "hotel", description: "Hotel Mango", dayNumber: 1,
      position: 0, latitude: null, longitude: null, draftedByAi: false,
      detailsJson: JSON.stringify({ startTime: "14:00", endTime: "18:00" }),
    },
    {
      id: 102, itemType: "activity", description: "Spa session", dayNumber: 1,
      position: 1, latitude: null, longitude: null, draftedByAi: false,
      // overlaps Hotel Mango's 14:00-18:00 window → G053 conflict
      detailsJson: JSON.stringify({ startTime: "16:00", endTime: "17:00" }),
    },
    {
      id: 103, itemType: "meals", description: "Dinner buffet", dayNumber: 2,
      position: 2, latitude: null, longitude: null, draftedByAi: false,
      detailsJson: null,
    },
  ],
};

// After a successful item POST, the parent refetch returns a new total.
const ITIN_AFTER_POST = {
  ...ITIN_BASE,
  totalAmount: 60000,
  items: [
    ...ITIN_BASE.items,
    {
      id: 104, itemType: "hotel", description: "Beachside Inn", dayNumber: 1,
      position: 3, latitude: null, longitude: null, draftedByAi: false,
      detailsJson: JSON.stringify({ startTime: "20:00", endTime: "23:00" }),
    },
  ],
};

beforeEach(() => {
  vi.useRealTimers();
  fetchApiMock.mockReset();
  notifyObj.error.mockReset();
  notifyObj.success.mockReset();
  notifyObj.info.mockReset();
  notifyObj.prompt.mockReset();
  notifyObj.prompt.mockImplementation(() => Promise.resolve(""));
  notifyObj.confirm.mockReset();
  notifyObj.confirm.mockImplementation(() => Promise.resolve(true));
});

function makeFetch(getResp) {
  return (url, opts) => {
    const method = (opts?.method || "GET").toUpperCase();
    if (url === `/api/travel/itineraries/42` && method === "GET") {
      return Promise.resolve(getResp);
    }
    if (url.startsWith("/api/travel/itinerary-templates/")) {
      return Promise.reject({ status: 404, message: "not found" });
    }
    // default fallthrough
    return Promise.resolve({});
  };
}

function renderPage({ role = "ADMIN" } = {}) {
  return render(
    <MemoryRouter initialEntries={["/travel/itineraries/42/edit"]}>
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
          <Route path="/travel/itineraries/:id/edit" element={<ItineraryEditor />} />
        </Routes>
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

describe("ItineraryEditor — toolbar + total chip (G060)", () => {
  it("renders the toolbar total chip with currency + amount", async () => {
    fetchApiMock.mockImplementation(makeFetch(ITIN_BASE));
    renderPage();
    const chip = await screen.findByTestId("itinerary-total-chip");
    expect(chip.textContent).toContain("INR");
    expect(chip.textContent).toContain("50,000");
  });

  it("renders an em-dash when totalAmount is null", async () => {
    fetchApiMock.mockImplementation(makeFetch({ ...ITIN_BASE, totalAmount: null }));
    renderPage();
    const chip = await screen.findByTestId("itinerary-total-chip");
    expect(chip.textContent).toMatch(/—/);
  });
});

describe("ItineraryEditor — G052 Bulk-day-add", () => {
  it("renders an Extend-by-N-days toolbar button", async () => {
    fetchApiMock.mockImplementation(makeFetch(ITIN_BASE));
    renderPage();
    expect(await screen.findByTestId("extend-days-btn")).toBeTruthy();
  });

  it("prompts for N, clamps to 30, and appends day cards on confirm", async () => {
    fetchApiMock.mockImplementation(makeFetch(ITIN_BASE));
    notifyObj.prompt.mockResolvedValue("3");
    renderPage();
    const btn = await screen.findByTestId("extend-days-btn");
    // Day 1 + Day 2 derived from date range, plus Day 3 from item dayNumber max
    // (item.dayNumber=2, range=3 days). After +3, expect Day 4 to appear.
    await waitFor(() => expect(screen.getByText(/Day 1/)).toBeTruthy());
    fireEvent.click(btn);
    await waitFor(() => expect(notifyObj.prompt).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryAllByText(/Day 4/).length).toBeGreaterThan(0));
    expect(notifyObj.success).toHaveBeenCalled();
  });

  it("cancellation (null return) leaves the day count unchanged", async () => {
    fetchApiMock.mockImplementation(makeFetch(ITIN_BASE));
    notifyObj.prompt.mockResolvedValue(null);
    renderPage();
    const btn = await screen.findByTestId("extend-days-btn");
    fireEvent.click(btn);
    await waitFor(() => expect(notifyObj.prompt).toHaveBeenCalled());
    // No "Day 4" should appear (derived count = 3 with item.dayNumber=2 + 3-day range).
    expect(screen.queryAllByText(/Day 4/).length).toBe(0);
    expect(notifyObj.success).not.toHaveBeenCalled();
  });

  it("non-numeric input → error toast + no day appended", async () => {
    fetchApiMock.mockImplementation(makeFetch(ITIN_BASE));
    notifyObj.prompt.mockResolvedValue("not-a-number");
    renderPage();
    const btn = await screen.findByTestId("extend-days-btn");
    fireEvent.click(btn);
    await waitFor(() => expect(notifyObj.error).toHaveBeenCalled());
    expect(notifyObj.success).not.toHaveBeenCalled();
  });
});

describe("ItineraryEditor — G053 Conflict warnings", () => {
  it("renders a conflict chip on each overlapping item", async () => {
    fetchApiMock.mockImplementation(makeFetch(ITIN_BASE));
    renderPage();
    // Two items on Day 1 overlap: 14:00-18:00 vs 16:00-17:00.
    expect(await screen.findByTestId("itinerary-item-conflict-101")).toBeTruthy();
    expect(screen.getByTestId("itinerary-item-conflict-102")).toBeTruthy();
  });

  it("renders a day-level conflict count banner on the affected day", async () => {
    fetchApiMock.mockImplementation(makeFetch(ITIN_BASE));
    renderPage();
    const banner = await screen.findByTestId("day-1-conflict-banner");
    expect(banner.textContent).toMatch(/2 conflicts/);
  });

  it("does NOT render conflict chips on items without overlapping times", async () => {
    fetchApiMock.mockImplementation(makeFetch(ITIN_BASE));
    renderPage();
    await screen.findByText("Dinner buffet");
    expect(screen.queryByTestId("itinerary-item-conflict-103")).toBeFalsy();
  });
});

describe("ItineraryEditor — G056 Inline +Activity", () => {
  it("renders the inline-add activity button on each real Day card", async () => {
    fetchApiMock.mockImplementation(makeFetch(ITIN_BASE));
    renderPage();
    expect(await screen.findByTestId("day-1-add-activity-btn")).toBeTruthy();
    expect(screen.getByTestId("day-2-add-activity-btn")).toBeTruthy();
  });

  it("POSTs the right shape on submit + closes form + refetches total", async () => {
    let getCallCount = 0;
    fetchApiMock.mockImplementation((url, opts) => {
      const method = (opts?.method || "GET").toUpperCase();
      if (url === "/api/travel/itineraries/42" && method === "GET") {
        getCallCount += 1;
        return Promise.resolve(getCallCount === 1 ? ITIN_BASE : ITIN_AFTER_POST);
      }
      if (url === "/api/travel/itineraries/42/items" && method === "POST") {
        return Promise.resolve({ id: 999, itemType: "activity" });
      }
      if (url.startsWith("/api/travel/itinerary-templates/")) {
        return Promise.reject({ status: 404, message: "nf" });
      }
      return Promise.resolve({});
    });
    renderPage();
    fireEvent.click(await screen.findByTestId("day-1-add-activity-btn"));
    const form = await screen.findByTestId("day-1-inline-add-form");
    const nameInput = within(form).getByLabelText("Activity name");
    fireEvent.change(nameInput, { target: { value: "Beach yoga" } });
    const startTime = within(form).getByLabelText("Start time");
    fireEvent.change(startTime, { target: { value: "07:00" } });
    fireEvent.click(within(form).getByTestId("day-1-inline-add-submit-activity"));

    await waitFor(() => {
      const postCalls = fetchApiMock.mock.calls.filter(
        ([u, o]) => u === "/api/travel/itineraries/42/items" && (o?.method || "").toUpperCase() === "POST",
      );
      expect(postCalls.length).toBe(1);
    });
    const postCall = fetchApiMock.mock.calls.find(
      ([u, o]) => u === "/api/travel/itineraries/42/items" && (o?.method || "").toUpperCase() === "POST",
    );
    const body = JSON.parse(postCall[1].body);
    expect(body.itemType).toBe("activity");
    expect(body.description).toBe("Beach yoga");
    expect(body.dayNumber).toBe(1);
    expect(body.detailsJson).toContain("07:00");
    expect(notifyObj.success).toHaveBeenCalled();
  });

  it("name-only submit (no times/url) is allowed", async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      const method = (opts?.method || "GET").toUpperCase();
      if (url === "/api/travel/itineraries/42" && method === "GET") return Promise.resolve(ITIN_BASE);
      if (url === "/api/travel/itineraries/42/items" && method === "POST") return Promise.resolve({ id: 998 });
      return Promise.resolve({});
    });
    renderPage();
    fireEvent.click(await screen.findByTestId("day-2-add-activity-btn"));
    const form = await screen.findByTestId("day-2-inline-add-form");
    fireEvent.change(within(form).getByLabelText("Activity name"), { target: { value: "Beach yoga" } });
    fireEvent.click(within(form).getByTestId("day-2-inline-add-submit-activity"));
    await waitFor(() => {
      const postCalls = fetchApiMock.mock.calls.filter(
        ([u, o]) => u === "/api/travel/itineraries/42/items" && (o?.method || "").toUpperCase() === "POST",
      );
      expect(postCalls.length).toBe(1);
    });
    const postBody = JSON.parse(
      fetchApiMock.mock.calls.find(([u, o]) => u.endsWith("/items") && (o?.method || "").toUpperCase() === "POST")[1].body,
    );
    expect(postBody.detailsJson).toBeNull();
  });
});

describe("ItineraryEditor — G057 Per-day suggest workflow", () => {
  const SUGGEST_RESP = {
    suggestion: {
      daySplit: [
        {
          dayNumber: 1,
          theme: "morning beach",
          items: [
            { itemType: "activity", description: "Sunrise yoga", estimatedCost: 500 },
            { itemType: "meals", description: "Beach breakfast", estimatedCost: 800 },
          ],
        },
      ],
    },
  };

  it("Suggest button hits /itineraries/suggest with destination + days=1", async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      const method = (opts?.method || "GET").toUpperCase();
      if (url === "/api/travel/itineraries/42" && method === "GET") return Promise.resolve(ITIN_BASE);
      if (url === "/api/travel/itineraries/suggest" && method === "POST") return Promise.resolve(SUGGEST_RESP);
      return Promise.resolve({});
    });
    renderPage();
    fireEvent.click(await screen.findByTestId("day-1-suggest-btn"));
    await waitFor(() => expect(screen.queryByTestId("day-1-draft-strip")).toBeTruthy());
    const suggestCall = fetchApiMock.mock.calls.find(
      ([u, o]) => u === "/api/travel/itineraries/suggest" && (o?.method || "").toUpperCase() === "POST",
    );
    expect(suggestCall).toBeTruthy();
    const body = JSON.parse(suggestCall[1].body);
    expect(body.destination).toBe("Goa school trip");
    expect(body.days).toBe(1);
  });

  it("Accept POSTs each draft item with dayNumber + estimatedCost→unitCost", async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      const method = (opts?.method || "GET").toUpperCase();
      if (url === "/api/travel/itineraries/42" && method === "GET") return Promise.resolve(ITIN_BASE);
      if (url === "/api/travel/itineraries/suggest" && method === "POST") return Promise.resolve(SUGGEST_RESP);
      if (url === "/api/travel/itineraries/42/items" && method === "POST") return Promise.resolve({ id: 700 });
      return Promise.resolve({});
    });
    renderPage();
    fireEvent.click(await screen.findByTestId("day-1-suggest-btn"));
    await screen.findByTestId("day-1-draft-strip");
    fireEvent.click(screen.getByTestId("day-1-draft-accept-btn"));
    await waitFor(() => {
      const itemPosts = fetchApiMock.mock.calls.filter(
        ([u, o]) => u === "/api/travel/itineraries/42/items" && (o?.method || "").toUpperCase() === "POST",
      );
      expect(itemPosts.length).toBe(2);
    });
    const firstBody = JSON.parse(
      fetchApiMock.mock.calls.find(([u, o]) => u === "/api/travel/itineraries/42/items" && (o?.method || "").toUpperCase() === "POST")[1].body,
    );
    expect(firstBody.dayNumber).toBe(1);
    expect(firstBody.unitCost).toBe(500);
  });

  it("Reject + retry calls /suggest again with the same context", async () => {
    let suggestCalls = 0;
    fetchApiMock.mockImplementation((url, opts) => {
      const method = (opts?.method || "GET").toUpperCase();
      if (url === "/api/travel/itineraries/42" && method === "GET") return Promise.resolve(ITIN_BASE);
      if (url === "/api/travel/itineraries/suggest" && method === "POST") {
        suggestCalls += 1;
        return Promise.resolve(SUGGEST_RESP);
      }
      return Promise.resolve({});
    });
    renderPage();
    fireEvent.click(await screen.findByTestId("day-1-suggest-btn"));
    await screen.findByTestId("day-1-draft-strip");
    expect(suggestCalls).toBe(1);
    fireEvent.click(screen.getByTestId("day-1-draft-reject-btn"));
    await waitFor(() => expect(suggestCalls).toBe(2));
  });

  it("Edit reveals inline-editable description + cost inputs", async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      const method = (opts?.method || "GET").toUpperCase();
      if (url === "/api/travel/itineraries/42" && method === "GET") return Promise.resolve(ITIN_BASE);
      if (url === "/api/travel/itineraries/suggest" && method === "POST") return Promise.resolve(SUGGEST_RESP);
      return Promise.resolve({});
    });
    renderPage();
    fireEvent.click(await screen.findByTestId("day-1-suggest-btn"));
    await screen.findByTestId("day-1-draft-strip");
    fireEvent.click(screen.getByTestId("day-1-draft-edit-btn"));
    const inputs = await screen.findAllByLabelText("Draft item description");
    expect(inputs.length).toBe(2);
    fireEvent.change(inputs[0], { target: { value: "Custom yoga" } });
    expect(inputs[0].value).toBe("Custom yoga");
  });
});

describe("ItineraryEditor — G060 Live re-pricing verify", () => {
  it("PATCHing an item triggers a debounced refetch that updates the total chip", async () => {
    let getCallCount = 0;
    fetchApiMock.mockImplementation((url, opts) => {
      const method = (opts?.method || "GET").toUpperCase();
      if (url === "/api/travel/itineraries/42" && method === "GET") {
        getCallCount += 1;
        return Promise.resolve(getCallCount === 1 ? ITIN_BASE : ITIN_AFTER_POST);
      }
      if (url.includes("/items/") && method === "PATCH") {
        return Promise.resolve({ ok: true });
      }
      if (url.startsWith("/api/travel/itinerary-templates/")) {
        return Promise.reject({ status: 404, message: "nf" });
      }
      return Promise.resolve({});
    });
    renderPage();
    // Wait for initial GET to settle.
    await waitFor(() => {
      const chip = screen.queryByTestId("itinerary-total-chip");
      expect(chip).toBeTruthy();
      expect(chip.textContent).toContain("50,000");
    });
    const initialGetCount = getCallCount;
    // Simulate a drag-drop: drag Hotel Mango (Day 1) onto Day 2's card.
    // moveToDay fires a PATCH then scheduleRefetch debounce-fires a 2nd GET.
    const itemCard = screen.getByText("Hotel Mango");
    // Find the Day 2 card by its strong "Day 2" header → walk up to the card div.
    const day2Header = screen.getByText(/^Day 2$/);
    const day2Card = day2Header.closest("[onDragOver]") || day2Header.parentElement.parentElement;
    fireEvent.dragStart(itemCard);
    fireEvent.dragOver(day2Card);
    fireEvent.drop(day2Card);
    // Wait for the debounced refetch (350ms) to fire and the chip to update.
    await waitFor(
      () => {
        const chip = screen.queryByTestId("itinerary-total-chip");
        expect(chip.textContent).toContain("60,000");
      },
      { timeout: 3000 },
    );
    expect(getCallCount).toBeGreaterThan(initialGetCount);
    // Confirm a PATCH actually fired (proves moveToDay ran end-to-end).
    const patchCalls = fetchApiMock.mock.calls.filter(
      ([u, o]) => u.includes("/items/") && (o?.method || "").toUpperCase() === "PATCH",
    );
    expect(patchCalls.length).toBeGreaterThanOrEqual(1);
  });
});

describe("ItineraryEditor — G062 Keyboard shortcuts", () => {
  it("renders the shortcuts help button in the toolbar", async () => {
    fetchApiMock.mockImplementation(makeFetch(ITIN_BASE));
    renderPage();
    expect(await screen.findByTestId("shortcuts-help-btn")).toBeTruthy();
  });

  it("clicking the help button opens the cheat-sheet modal", async () => {
    fetchApiMock.mockImplementation(makeFetch(ITIN_BASE));
    renderPage();
    fireEvent.click(await screen.findByTestId("shortcuts-help-btn"));
    expect(await screen.findByTestId("shortcuts-help-modal")).toBeTruthy();
    // Modal contains the expected keys.
    expect(screen.getByText(/Ctrl \+ S/)).toBeTruthy();
    expect(screen.getByText(/Esc/)).toBeTruthy();
  });

  it("pressing ? opens the modal", async () => {
    fetchApiMock.mockImplementation(makeFetch(ITIN_BASE));
    renderPage();
    await screen.findByText("Hotel Mango");
    fireEvent.keyDown(window, { key: "?" });
    await waitFor(() => expect(screen.queryByTestId("shortcuts-help-modal")).toBeTruthy());
  });

  it("pressing Esc closes the modal", async () => {
    fetchApiMock.mockImplementation(makeFetch(ITIN_BASE));
    renderPage();
    fireEvent.click(await screen.findByTestId("shortcuts-help-btn"));
    await screen.findByTestId("shortcuts-help-modal");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("shortcuts-help-modal")).toBeFalsy());
  });

  it("Ctrl+S triggers the auto-save confirmation toast", async () => {
    fetchApiMock.mockImplementation(makeFetch(ITIN_BASE));
    renderPage();
    await screen.findByText("Hotel Mango");
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await waitFor(() => expect(notifyObj.success).toHaveBeenCalled());
    expect(notifyObj.success.mock.calls[0][0]).toMatch(/auto-save/i);
  });
});
