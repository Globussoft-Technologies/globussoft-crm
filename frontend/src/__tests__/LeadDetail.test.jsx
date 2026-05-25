/**
 * LeadDetail.jsx — Travel CRM unified contact-centric lead view (PRD §7).
 *
 * Pins the frontend contract for /travel/leads/:contactId, the travel-
 * specific drilldown that aggregates every artifact attached to a
 * Contact (diagnostic / itineraries / trips / RFU link). Backend
 * endpoints consumed:
 *   - GET /api/contacts/:id
 *   - GET /api/travel/diagnostics?contactId=<id>&limit=5
 *   - GET /api/travel/itineraries?contactId=<id>&limit=20
 *   - GET /api/travel/trips?schoolContactId=<id>&limit=20
 *
 * Mock stability: useNotify, fetchApi, and AuthContext are stable
 * references per CLAUDE.md feedback rule. AuthContext uses the real
 * Provider wrap pattern (mirrors ItineraryDetail.test.jsx) — do not
 * mock '../App' or useContext() will break.
 *
 * Contracts pinned:
 *   1. Page header renders the contact's name + email after the
 *      /api/contacts/:id GET resolves.
 *   2. Diagnostics section renders the most-recent diagnostic with
 *      classification + tier.
 *   3. Diagnostics empty state renders when the list is empty.
 *   4. Itineraries table renders rows for each itinerary; empty state
 *      renders when none.
 *   5. Clicking an itinerary row navigates to /travel/itineraries/:id.
 *   6. Trips section ONLY renders when ≥1 trip exists; with zero trips
 *      the section header is absent.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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
import LeadDetail from "../pages/travel/LeadDetail";

const CONTACT = {
  id: 77,
  name: "Sharada School Trust",
  email: "principal@sharadaschool.in",
  phone: "+91-9876543210",
  company: "Sharada School Trust",
};

const DIAG = {
  id: 501,
  contactId: 77,
  subBrand: "tmc",
  classification: "level_2",
  classificationLabel: "Tier-2 school readiness",
  recommendedTier: "primary",
  score: 72,
  createdAt: "2026-05-20T10:00:00.000Z",
};

const ITIN_A = {
  id: 901,
  contactId: 77,
  subBrand: "tmc",
  destination: "Goa programme Jan 2026",
  status: "draft",
  startDate: "2026-01-15T00:00:00.000Z",
  endDate: "2026-01-19T00:00:00.000Z",
  totalAmount: 145000,
  currency: "INR",
};

const ITIN_B = {
  id: 902,
  contactId: 77,
  subBrand: "tmc",
  destination: "Bali programme Mar 2026",
  status: "sent",
  startDate: "2026-03-10T00:00:00.000Z",
  endDate: "2026-03-15T00:00:00.000Z",
  totalAmount: 220000,
  currency: "INR",
};

const TRIP_A = {
  id: 1201,
  tenantId: 9,
  tripCode: "goa-jan-2026",
  schoolContactId: 77,
  destination: "Goa",
  departDate: "2026-01-15T00:00:00.000Z",
  returnDate: "2026-01-19T00:00:00.000Z",
  status: "confirmed",
  _count: { participants: 32, documentRequirements: 4 },
};

/**
 * Make a fetchApi mock that dispatches per-URL.
 * Pass `overrides` to throw / return empty / custom data per endpoint.
 */
function makeFetchImpl(overrides = {}) {
  const o = {
    contact: { kind: "ok", data: CONTACT },
    diagnostics: { kind: "ok", data: { diagnostics: [DIAG], total: 1, limit: 5, offset: 0 } },
    itineraries: { kind: "ok", data: { itineraries: [ITIN_A, ITIN_B], total: 2, limit: 20, offset: 0 } },
    trips: { kind: "ok", data: { trips: [TRIP_A], total: 1, limit: 20, offset: 0 } },
    ...overrides,
  };
  const handle = (slot) => {
    if (slot.kind === "throw") return Promise.reject(slot.error || { body: { error: "boom" } });
    return Promise.resolve(slot.data);
  };
  return (url) => {
    if (/^\/api\/contacts\/\d+$/.test(url)) return handle(o.contact);
    if (url.startsWith("/api/travel/diagnostics?")) return handle(o.diagnostics);
    if (url.startsWith("/api/travel/itineraries?")) return handle(o.itineraries);
    if (url.startsWith("/api/travel/trips?")) return handle(o.trips);
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
});

function renderPage({ role = "ADMIN", contactId = 77 } = {}) {
  return render(
    <MemoryRouter initialEntries={[`/travel/leads/${contactId}`]}>
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
          <Route path="/travel/leads/:contactId" element={<LeadDetail />} />
          <Route
            path="/travel/itineraries/:id"
            element={<div data-testid="itinerary-detail-stub">Itinerary detail stub</div>}
          />
        </Routes>
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

describe("LeadDetail — page contract", () => {
  it("renders the header with contact name + email after the contact GET resolves", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl());
    renderPage();
    // The contact name appears twice (H1 + company chip) — use getAllByText.
    await waitFor(() => expect(screen.queryAllByText(/Sharada School Trust/).length).toBeGreaterThan(0));
    expect(await screen.findByText(/principal@sharadaschool\.in/)).toBeTruthy();
  });

  it("renders the most recent diagnostic with classification + tier", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl());
    renderPage();
    // Wait for the contact to load first, then the diagnostic section.
    await waitFor(() => expect(screen.queryAllByText(/Sharada School Trust/).length).toBeGreaterThan(0));
    expect(await screen.findByText(/Tier-2 school readiness/)).toBeTruthy();
    // Tier badge "primary" is uppercased in the badge; query case-insensitive.
    expect(screen.getByText(/primary/i)).toBeTruthy();
    // View-diagnostic link points to the right detail URL.
    const link = screen.getByText(/View diagnostic/i).closest("a");
    expect(link?.getAttribute("href")).toBe("/travel/diagnostics/501");
  });

  it("renders the diagnostics empty state when the list is empty", async () => {
    fetchApiMock.mockImplementation(
      makeFetchImpl({
        diagnostics: { kind: "ok", data: { diagnostics: [], total: 0, limit: 5, offset: 0 } },
      }),
    );
    renderPage();
    await waitFor(() => expect(screen.queryAllByText(/Sharada School Trust/).length).toBeGreaterThan(0));
    expect(await screen.findByText(/No diagnostic on file yet/i)).toBeTruthy();
  });

  it("renders an itineraries table row per itinerary and the empty state when none", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl());
    renderPage();
    await waitFor(() => expect(screen.queryAllByText(/Sharada School Trust/).length).toBeGreaterThan(0));
    expect(await screen.findByText(/Goa programme Jan 2026/)).toBeTruthy();
    expect(screen.getByText(/Bali programme Mar 2026/)).toBeTruthy();

    // Re-render with zero itineraries
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation(
      makeFetchImpl({
        itineraries: { kind: "ok", data: { itineraries: [], total: 0, limit: 20, offset: 0 } },
      }),
    );
    const { unmount } = renderPage();
    expect(await screen.findByText(/No itineraries linked to this contact yet/i)).toBeTruthy();
    unmount();
  });

  it("clicking an itinerary row navigates to /travel/itineraries/:id", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl());
    renderPage();
    await waitFor(() => expect(screen.queryAllByText(/Sharada School Trust/).length).toBeGreaterThan(0));
    const row = (await screen.findByText(/Goa programme Jan 2026/)).closest("tr");
    expect(row).toBeTruthy();
    fireEvent.click(row);
    await waitFor(() => {
      expect(screen.getByTestId("itinerary-detail-stub")).toBeTruthy();
    });
  });

  it("Trips section only renders when ≥1 trip exists", async () => {
    // With one trip: section header IS present.
    fetchApiMock.mockImplementation(makeFetchImpl());
    const { unmount } = renderPage();
    await waitFor(() => expect(screen.queryAllByText(/Sharada School Trust/).length).toBeGreaterThan(0));
    expect(await screen.findByText(/TMC Trips/)).toBeTruthy();
    expect(screen.getByText(/goa-jan-2026/)).toBeTruthy();
    unmount();

    // With zero trips: section header is absent.
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation(
      makeFetchImpl({
        trips: { kind: "ok", data: { trips: [], total: 0, limit: 20, offset: 0 } },
      }),
    );
    renderPage();
    await waitFor(() => expect(screen.queryAllByText(/Sharada School Trust/).length).toBeGreaterThan(0));
    // Give the trips fetch a tick to settle before asserting absence.
    await waitFor(() => {
      expect(screen.queryByText(/TMC Trips/)).toBeNull();
    });
  });
});
