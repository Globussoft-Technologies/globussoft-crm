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

  // ─── Extended cases (round-2) ─────────────────────────────────────
  // These pin uncovered branches the SUT actually has — the page is
  // read-only (no disposition / conversion / timeline / AI-score
  // affordances in the current 419L source) so we target the
  // conditional render paths instead: contact load failure, RFU
  // profile link gating, "+N more" diagnostics link, TMC trip-row
  // navigation, INR lakh currency formatting, trips-error gating,
  // and the cross-tenant 404 surface.

  it("renders the contact-not-found error surface when /api/contacts/:id throws", async () => {
    // Contact endpoint rejects → page shows error message + back-link
    // (not the page header / sections). Notify.error fires once with
    // the same message — pins the dual-surface error contract.
    fetchApiMock.mockImplementation(
      makeFetchImpl({
        contact: { kind: "throw", error: { body: { error: "Contact not found" } } },
      }),
    );
    renderPage();
    expect(await screen.findByText(/Contact not found/i)).toBeTruthy();
    const back = screen.getByText(/Back to leads/i).closest("a");
    expect(back?.getAttribute("href")).toBe("/travel/leads");
    // Section headers should NOT render in the error path.
    expect(screen.queryByText(/Latest diagnostic/i)).toBeNull();
    expect(screen.queryByText(/Itineraries/)).toBeNull();
    await waitFor(() => expect(notifyObj.error).toHaveBeenCalledTimes(1));
    expect(notifyObj.error).toHaveBeenCalledWith("Contact not found");
  });

  it("hides the RFU profile link when no diagnostic OR itinerary has subBrand=rfu", async () => {
    // All current fixtures are subBrand=tmc — the cross-link to
    // /travel/rfu/customers/:id must NOT render. Only the generic
    // CRM contact link is shown.
    fetchApiMock.mockImplementation(makeFetchImpl());
    renderPage();
    await waitFor(() => expect(screen.queryAllByText(/Sharada School Trust/).length).toBeGreaterThan(0));
    expect(screen.getByText(/Open in CRM Contacts/i)).toBeTruthy();
    expect(screen.queryByText(/Open RFU profile/i)).toBeNull();
  });

  it("shows the RFU profile link when ≥1 diagnostic has subBrand=rfu", async () => {
    // Swap the latest diagnostic to subBrand=rfu → the conditional
    // RFU cross-link should render with the right href.
    const RFU_DIAG = { ...DIAG, subBrand: "rfu", classificationLabel: "Umrah-ready" };
    fetchApiMock.mockImplementation(
      makeFetchImpl({
        diagnostics: {
          kind: "ok",
          data: { diagnostics: [RFU_DIAG], total: 1, limit: 5, offset: 0 },
        },
      }),
    );
    renderPage();
    await waitFor(() => expect(screen.queryAllByText(/Sharada School Trust/).length).toBeGreaterThan(0));
    const rfuLink = (await screen.findByText(/Open RFU profile/i)).closest("a");
    expect(rfuLink?.getAttribute("href")).toBe("/travel/rfu/customers/77");
  });

  it("renders the '+N more' diagnostics link only when total > 1", async () => {
    // total=3, list length=1 → "+2 more" link visible with the right
    // querystring back to the diagnostics list view.
    fetchApiMock.mockImplementation(
      makeFetchImpl({
        diagnostics: {
          kind: "ok",
          data: { diagnostics: [DIAG], total: 3, limit: 5, offset: 0 },
        },
      }),
    );
    renderPage();
    await waitFor(() => expect(screen.queryAllByText(/Sharada School Trust/).length).toBeGreaterThan(0));
    const moreLink = (await screen.findByText(/\+2 more/)).closest("a");
    expect(moreLink?.getAttribute("href")).toBe("/travel/diagnostics?contactId=77");
  });

  it("renders TMC trip rows with status badge + pax count, clickable for navigation", async () => {
    // Pin the TMC trips table contract — trip code, status badge,
    // pax count from _count.participants, and row-level role=link
    // aria-label for keyboard / a11y users.
    fetchApiMock.mockImplementation(makeFetchImpl());
    renderPage();
    await waitFor(() => expect(screen.queryAllByText(/Sharada School Trust/).length).toBeGreaterThan(0));
    const tripRow = await screen.findByLabelText(/Open trip goa-jan-2026/i);
    expect(tripRow).toBeTruthy();
    expect(tripRow.getAttribute("role")).toBe("link");
    // Pax count comes from _count.participants
    expect(screen.getByText("32")).toBeTruthy();
    // Status badge "confirmed" rendered (uppercased via CSS, query case-insensitive)
    expect(screen.getByText(/^confirmed$/i)).toBeTruthy();
  });

  it("formats INR amounts ≥1 lakh as compact ₹X.XXL", async () => {
    // ITIN_A.totalAmount = 145000 INR → "₹1.45L"
    // ITIN_B.totalAmount = 220000 INR → "₹2.20L"
    // Pins the fmtMoney() lakh-compaction branch.
    fetchApiMock.mockImplementation(makeFetchImpl());
    renderPage();
    await waitFor(() => expect(screen.queryAllByText(/Sharada School Trust/).length).toBeGreaterThan(0));
    expect(await screen.findByText(/₹1\.45L/)).toBeTruthy();
    expect(screen.getByText(/₹2\.20L/)).toBeTruthy();
  });

  it("hides the trips-unavailable error line when there is no RFU evidence", async () => {
    // Trips endpoint throws but no diagnostic/itinerary is subBrand=rfu
    // → the conditional "Trips unavailable" hint must NOT render to
    // avoid polluting generic contact views. The TMC Trips section
    // also stays hidden because tripsToShow.length === 0.
    fetchApiMock.mockImplementation(
      makeFetchImpl({
        trips: { kind: "throw", error: { body: { error: "forbidden" } } },
      }),
    );
    renderPage();
    await waitFor(() => expect(screen.queryAllByText(/Sharada School Trust/).length).toBeGreaterThan(0));
    // Itineraries section still loads (subBrand=tmc, not rfu).
    expect(await screen.findByText(/Goa programme Jan 2026/)).toBeTruthy();
    // The trips-unavailable hint should be absent: hasRfu === false.
    expect(screen.queryByText(/Trips unavailable/i)).toBeNull();
    expect(screen.queryByText(/TMC Trips/)).toBeNull();
  });

  it("shows the trips-unavailable inline hint when trips error AND user has RFU evidence", async () => {
    // Diagnostic with subBrand=rfu → hasRfu=true. Trips endpoint
    // throws → tripsToShow.length === 0 AND tripsError truthy AND
    // hasRfu === true → the inline hint renders.
    const RFU_DIAG = { ...DIAG, subBrand: "rfu", classificationLabel: "Umrah-ready" };
    fetchApiMock.mockImplementation(
      makeFetchImpl({
        diagnostics: {
          kind: "ok",
          data: { diagnostics: [RFU_DIAG], total: 1, limit: 5, offset: 0 },
        },
        trips: { kind: "throw", error: { body: { error: "forbidden" } } },
      }),
    );
    renderPage();
    await waitFor(() => expect(screen.queryAllByText(/Sharada School Trust/).length).toBeGreaterThan(0));
    expect(await screen.findByText(/Trips unavailable: forbidden/i)).toBeTruthy();
    // TMC Trips header still absent (tripsToShow.length === 0).
    expect(screen.queryByText(/TMC Trips/)).toBeNull();
  });

  it("renders the diagnostics-error surface inline (independent of contact load)", async () => {
    // Diagnostics endpoint throws but contact + itineraries succeed
    // → the page still renders header + itineraries; the diagnostics
    // section shows the inline error string (not the empty state).
    fetchApiMock.mockImplementation(
      makeFetchImpl({
        diagnostics: { kind: "throw", error: { body: { error: "diag service down" } } },
      }),
    );
    renderPage();
    await waitFor(() => expect(screen.queryAllByText(/Sharada School Trust/).length).toBeGreaterThan(0));
    expect(await screen.findByText(/Diagnostics unavailable: diag service down/i)).toBeTruthy();
    // The "No diagnostic on file" empty state should NOT show — error wins.
    expect(screen.queryByText(/No diagnostic on file yet/i)).toBeNull();
    // Itineraries section still loads independently.
    expect(screen.getByText(/Goa programme Jan 2026/)).toBeTruthy();
  });
});
