import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

const fetchApiMock = vi.fn();
vi.mock("../utils/api", () => ({ fetchApi: (...args) => fetchApiMock(...args) }));
vi.mock("../components/EditContactModal", () => ({ default: () => null }));

import LeadDetail from "../pages/travel/LeadDetail";

const CONTACT = {
  id: 77,
  name: "Sharada School Trust",
  email: "principal@sharadaschool.in",
  phone: "+91-9876543210",
  company: "Sharada School Trust",
  status: "Lead",
};

const TRIP = {
  id: 1201,
  tripCode: "goa-jan-2026",
  destination: "Goa",
  departDate: "2026-01-15T00:00:00.000Z",
  returnDate: "2026-01-19T00:00:00.000Z",
  status: "confirmed",
  perStudentAmount: 5000,
  totalTripValue: 160000,
  _count: { participants: 32 },
};

function makeFetchImpl({ contact = CONTACT, trips = [TRIP], quotes = [], itineraries = [], activities = [], tripInstalments = null, participants = [] } = {}) {
  return (url, options = {}) => {
    if (typeof url !== "string") return Promise.resolve({});
    if (url === "/api/contacts/77" && options.method === "PUT") {
      return Promise.resolve({ ...contact, status: JSON.parse(options.body).status });
    }
    if (url === "/api/contacts/77") return Promise.resolve(contact);
    if (url.startsWith("/api/travel/trips?")) return Promise.resolve({ trips });
    if (url === `/api/travel/trips/${TRIP.id}/instalments`) return Promise.resolve(tripInstalments || {});
    if (url === `/api/travel/trips/${TRIP.id}/participants`) return Promise.resolve({ participants });
    if (url.startsWith("/api/travel/quotes?")) return Promise.resolve({ quotes });
    if (url.startsWith("/api/travel/itineraries?")) return Promise.resolve({ itineraries });
    if (url.startsWith("/api/contacts/77/activities?")) return Promise.resolve({ data: activities });
    if (url === "/api/contacts/77/activities") return Promise.resolve({});
    return Promise.resolve({});
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/travel/leads/77"]}>
      <Routes>
        <Route path="/travel/leads/:contactId" element={<LeadDetail />} />
        <Route path="/travel/quotes/builder" element={<div>Quote builder</div>} />
        <Route path="/travel/trips" element={<div>Trips page</div>} />
        <Route path="/travel/trips/:id" element={<div>Trip detail page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => fetchApiMock.mockReset());

describe("LeadDetail", () => {
  it("renders the contact profile and linked trip", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl());
    renderPage();

    expect(await screen.findByRole("heading", { name: "Sharada School Trust" })).toBeTruthy();
    expect(screen.getByText("principal@sharadaschool.in")).toBeTruthy();
    expect(screen.getByText("All trips")).toBeTruthy();
    expect(screen.getByText("goa-jan-2026")).toBeTruthy();
    expect(screen.getAllByText("₹5,000").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("confirmed")).toBeTruthy();
  });

  it("shows the recorded paid amount in the All trips table", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl({
      tripInstalments: { instalments: [{ participantId: 901, paidAmount: 3000 }, { participantId: 901, paidAmount: 1250 }] },
      participants: [{ id: 901, parentEmail: CONTACT.email }],
    }));
    renderPage();

    await screen.findByRole("heading", { name: "Sharada School Trust" });
    expect(screen.getByRole("columnheader", { name: "Paid amount" })).toBeTruthy();
    expect(screen.getAllByText("₹4,250").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryAllByText("₹5,000").length).toBeGreaterThanOrEqual(1);
  });

  it("moves the contact through the lifecycle stages", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl());
    renderPage();
    await screen.findByRole("heading", { name: "Sharada School Trust" });

    fireEvent.click(screen.getByRole("button", { name: /Prospect/ }));
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith("/api/contacts/77", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ status: "Prospect" }),
    })));
  });

  it("opens the active trip detail page from the trip hero", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl());
    renderPage();

    await screen.findByRole("heading", { name: "Sharada School Trust" });
    fireEvent.click(screen.getByRole("button", { name: "View trip" }));

    expect(await screen.findByText("Trip detail page")).toBeTruthy();
  });

  it("shows the whole trip amount for a teacher contact", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl({
      trips: [{ ...TRIP, teacherContactId: 77 }],
    }));
    renderPage();

    await screen.findByRole("heading", { name: "Sharada School Trust" });
    expect(screen.getAllByText("₹160,000").length).toBeGreaterThanOrEqual(1);
  });

  it("shows the empty trip state when no trips are linked", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl({ trips: [] }));
    renderPage();
    expect(await screen.findByText(/No active travel trip yet/i)).toBeTruthy();
    expect(screen.getByText(/No travel trips linked to this contact/i)).toBeTruthy();
  });

  it("includes non-TMC quote travel in the All trips table", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl({
      quotes: [{ id: 12, subBrand: "rfu", totalAmount: 145000, currency: "INR", status: "Sent" }],
    }));
    renderPage();

    await screen.findByRole("heading", { name: "Sharada School Trust" });
    expect(screen.getByText("Quote Q-12")).toBeTruthy();
    expect(screen.getByText("RFU")).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Paid amount" })).toBeTruthy();
  });

  it("includes contact-linked itineraries in the All trips table", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl({
      itineraries: [{ id: 33, destination: "Dubai", subBrand: "travelstall", status: "sent", totalAmount: 90000, advancePaidAmount: 12500, currency: "INR", startDate: "2026-12-01", endDate: "2026-12-05" }],
    }));
    renderPage();

    await screen.findByRole("heading", { name: "Sharada School Trust" });
    expect(screen.getByText("Itinerary #33")).toBeTruthy();
    expect(screen.getByText("Dubai")).toBeTruthy();
    expect(screen.getByText("TRAVELSTALL")).toBeTruthy();
    expect(screen.getByText("₹12,500")).toBeTruthy();
  });

  it("renders quotes and activities in their tabs", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl({
      quotes: [{ id: 12, totalAmount: 145000, currency: "INR", status: "sent" }],
      activities: [{ id: 9, type: "Note", description: "School follow-up" }],
    }));
    renderPage();
    await screen.findByRole("heading", { name: "Sharada School Trust" });

    fireEvent.click(screen.getByRole("button", { name: "Quotes" }));
    expect(screen.getByText(/Quote Q-12/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    expect(screen.getByText(/School follow-up/)).toBeTruthy();
  });

  it("posts a note from the Notes tab", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl());
    renderPage();
    await screen.findByRole("heading", { name: "Sharada School Trust" });

    fireEvent.click(screen.getByRole("button", { name: "Notes" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Call tomorrow" } });
    fireEvent.click(screen.getByRole("button", { name: "Add note" }));
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith("/api/contacts/77/activities", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ type: "Note", description: "Call tomorrow" }),
    })));
  });

  it("renders a contact-load error", async () => {
    fetchApiMock.mockImplementation((url) => url === "/api/contacts/77"
      ? Promise.reject({ body: { error: "Contact not found" } })
      : Promise.resolve({ trips: [] }));
    renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent("Contact not found");
    expect(screen.getByRole("link", { name: /Back to Leads/i }).getAttribute("href")).toBe("/leads");
  });
});
