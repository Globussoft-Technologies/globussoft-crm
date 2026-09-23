import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const fetchApiMock = vi.fn();
const geocodeMock = vi.fn();

vi.mock("../utils/api", () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => "test-token",
}));
vi.mock("../utils/notify", () => ({
  useNotify: () => ({
    error: vi.fn(), success: vi.fn(), info: vi.fn(),
    confirm: vi.fn(), prompt: vi.fn(),
  }),
}));
vi.mock("../lib/geocoder", () => ({
  geocode: (...args) => geocodeMock(...args),
}));
vi.mock("../components/MapPreview", () => ({
  default: ({ items }) => (
    <div data-testid="map-items">
      {items.map((item) => `${item.id}:${item.latitude},${item.longitude}`).join("|")}
    </div>
  ),
}));
vi.mock("../components/travel/LocationAutocomplete", () => ({
  default: () => <div data-testid="location-autocomplete" />,
}));

import ItineraryWorkspace from "../pages/travel/ItineraryWorkspace";

const baseItinerary = {
  id: 42,
  title: "Goa trip",
  destination: "Goa",
  subBrand: "tmc",
  status: "draft",
  startDate: "2026-01-15T00:00:00.000Z",
  endDate: "2026-01-15T00:00:00.000Z",
  currency: "INR",
  totalAmount: 0,
  moneyEnabled: false,
  items: [],
};

function renderWorkspace(items) {
  fetchApiMock.mockImplementation(async (url) => {
    if (url === "/api/travel/itineraries/42") return { ...baseItinerary, items };
    if (url.startsWith("/api/travel/itinerary-templates")) return { items: [] };
    if (url.startsWith("/api/travel/item-types")) return { itemTypes: [] };
    if (url.startsWith("/api/travel/cancellation-policies")) return { policies: [] };
    if (url.startsWith("/api/travel/suppliers")) return { items: [] };
    throw new Error(`Unexpected request: ${url}`);
  });
  return render(
    <MemoryRouter initialEntries={["/travel/itineraries/42"]}>
      <Routes>
        <Route path="/travel/itineraries/:id" element={<ItineraryWorkspace />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ItineraryWorkspace route-map repair", () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    geocodeMock.mockReset();
  });

  it("keeps a far-away manual pin visible", async () => {
    geocodeMock.mockResolvedValue({ lat: 15.2993, lng: 74.124 });
    renderWorkspace([{
      id: 1,
      itemType: "transfer",
      description: "Regional transfer",
      dayNumber: 1,
      position: 0,
      latitude: 6.5244,
      longitude: 3.3792,
      draftedByAi: false,
    }]);

    expect(await screen.findByTestId("map-items")).toHaveTextContent("1:6.5244,3.3792");
    await waitFor(() => expect(geocodeMock).toHaveBeenCalledWith("Goa"));
    expect(screen.getByTestId("map-items")).toHaveTextContent("1:6.5244,3.3792");
  });

  it("repairs an AI outlier only in the map and does not PATCH the item", async () => {
    geocodeMock
      .mockResolvedValueOnce({ lat: 15.2993, lng: 74.124 })
      .mockResolvedValueOnce({ lat: 15.5553, lng: 73.7517 });
    renderWorkspace([{
      id: 2,
      itemType: "sightseeing",
      description: "Visit Baga Beach",
      dayNumber: 1,
      position: 0,
      latitude: 6.5244,
      longitude: 3.3792,
      draftedByAi: true,
    }]);

    await waitFor(() => {
      expect(screen.getByTestId("map-items")).toHaveTextContent("2:15.5553,73.7517");
    });
    expect(fetchApiMock.mock.calls.some(([, options]) => options?.method === "PATCH")).toBe(false);
  });
});
