// Unit tests for the shared travel search-result cards. The destination-photo
// hooks are mocked so the test never hits Wikipedia — the cards must render
// (with placeholders) and the onAdd handler must fire regardless of imagery.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("../utils/destinationPhotos", () => ({
  useDestinationPhoto: () => null,
  useDestinationGallery: () => [],
}));

import { FlightResultsBoard, HotelResultsGrid, TransferResultsList, SuggestedItinerary } from "../components/TravelSearchResults";

describe("FlightResultsBoard", () => {
  it("renders a timeline row + seats and fires onAdd", () => {
    const onAdd = vi.fn();
    render(
      <FlightResultsBoard
        currency="INR"
        onAdd={onAdd}
        results={[{ airline: "AI", airlineName: "Air India", flightNumber: "AI-302", from: "DEL", to: "JED", fare: 50000, stops: 0, seatsAvailable: 3 }]}
      />,
    );
    expect(screen.getByText("Air India")).toBeInTheDocument();
    expect(screen.getByText("AI-302")).toBeInTheDocument();
    expect(screen.getByText(/3 seats left/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Add/i }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });
});

describe("HotelResultsGrid", () => {
  it("renders a hotel card and fires onAdd", () => {
    const onAdd = vi.fn();
    render(
      <HotelResultsGrid
        currency="INR"
        city="Jeddah"
        onAdd={onAdd}
        results={[{ name: "Jeddah Grand", area: "City centre", starRating: 5, roomType: "Deluxe", board: "Breakfast", ratePerNight: 9000, totalRate: 18000, refundable: true }]}
      />,
    );
    expect(screen.getByText("Jeddah Grand")).toBeInTheDocument();
    expect(screen.getByText(/9,000/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Add to quote/i }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });
});

describe("TransferResultsList", () => {
  it("renders a transfer row and fires onAdd", () => {
    const onAdd = vi.fn();
    render(
      <TransferResultsList
        currency="INR"
        onAdd={onAdd}
        results={[{ vehicle: "Private Sedan", from: "JED", to: "Makkah", durationMinutes: 75, price: 2200 }]}
      />,
    );
    expect(screen.getByText("Private Sedan")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Add/i }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });
});

describe("SuggestedItinerary", () => {
  const suggestion = {
    currency: "INR", pax: 2, adults: 2,
    flights: [{
      fromLabel: "Bangalore", toLabel: "Jeddah", selectedIdx: 0,
      options: [
        { airline: "AI", airlineName: "Air India", flightNumber: "AI-1", from: "BLR", to: "JED", fare: 40000, stops: 0 },
        { airline: "SV", airlineName: "Saudia", flightNumber: "SV-9", from: "BLR", to: "JED", fare: 38000, stops: 0 },
      ],
    }],
    transfers: [],
    stays: [{
      city: "Makkah", nights: 2, selectedIdx: 0,
      options: [
        { name: "Hilton Makkah", starRating: 5, roomType: "Deluxe", totalRate: 18000, ratePerNight: 9000 },
        { name: "Swissotel Makkah", starRating: 5, roomType: "Twin", totalRate: 16000, ratePerNight: 8000 },
      ],
    }],
  };

  it("renders chosen flight + hotel and a price summary", () => {
    render(<SuggestedItinerary suggestion={suggestion} />);
    expect(screen.getByText("Air India")).toBeInTheDocument();
    expect(screen.getByText("Hilton Makkah")).toBeInTheDocument();
    expect(screen.getByText(/Stay in Makkah/)).toBeInTheDocument();
    // Total = 40000 × 2 pax + 18000 stay = 98,000.
    expect(screen.getByText(/98,000/)).toBeInTheDocument();
  });

  it("Change hotel reveals alternatives + Select fires onChangeStay(idx, optIdx)", () => {
    const onChangeStay = vi.fn();
    render(<SuggestedItinerary suggestion={suggestion} onChangeStay={onChangeStay} />);
    fireEvent.click(screen.getByRole("button", { name: /Change hotel/i }));
    expect(screen.getByText("Swissotel Makkah")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Select/i }));
    expect(onChangeStay).toHaveBeenCalledWith(0, 1);
  });

  it("renders nothing when the suggestion is null", () => {
    const { container } = render(<SuggestedItinerary suggestion={null} />);
    expect(container.textContent).toBe("");
  });
});

describe("empty states", () => {
  it("renders nothing when there are no results", () => {
    const { container } = render(
      <>
        <FlightResultsBoard results={[]} />
        <HotelResultsGrid results={[]} />
        <TransferResultsList results={[]} />
      </>,
    );
    expect(container.textContent).toBe("");
  });
});
