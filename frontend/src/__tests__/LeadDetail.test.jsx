import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

const fetchApiMock = vi.fn();
vi.mock("../utils/api", () => ({ fetchApi: (...args) => fetchApiMock(...args) }));
const confirmMock = vi.fn(() => Promise.resolve(true));
vi.mock("../utils/notify", () => ({ useNotify: () => ({ confirm: confirmMock }) }));
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

function renderPage({ state, search = '' } = {}) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: "/travel/leads/77", search, state }]}>
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

  it("uses Contacts as the back destination when opened from Contacts", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl());
    renderPage({ state: { backTo: "/contacts", backLabel: "Back to Contacts" } });

    expect(await screen.findByRole("link", { name: /Back to Contacts/i })).toHaveAttribute("href", "/contacts");
  });

  it("preserves the Leads query string in the fallback Back link", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl());
    renderPage({ search: "?page=3&limit=25&q=school&sortBy=name&sortDirection=desc" });

    expect(await screen.findByRole("link", { name: /Back to Leads/i })).toHaveAttribute(
      "href",
      "/leads?page=3&limit=25&q=school&sortBy=name&sortDirection=desc",
    );
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

  it.each(["Churned", "Junk"])("asks for a reason before moving the lead to %s", async (stage) => {
    fetchApiMock.mockImplementation(makeFetchImpl());
    renderPage();
    await screen.findByRole("heading", { name: "Sharada School Trust" });

    fireEvent.click(screen.getByRole("button", { name: stage }));

    expect(screen.getByRole("dialog", { name: `Move lead to ${stage}` })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Reason" })).toBeTruthy();
    expect(fetchApiMock).not.toHaveBeenCalledWith("/api/contacts/77", expect.objectContaining({ method: "PUT" }));
  });

  it("records the Churned reason and shows the authored entry in Activity", async () => {
    const lifecycleActivity = {
      id: 101,
      type: "Lead Status updated",
      description: "Updated from Lead to Churned. Reason: Customer cancelled the trip",
      createdAt: "2026-11-16T08:30:00.000Z",
      user: { id: 7, name: "Yasin" },
    };
    fetchApiMock.mockImplementation((url, options = {}) => {
      if (url === "/api/contacts/77" && options.method === "PUT") {
        return Promise.resolve({ ...CONTACT, status: "Churned", lifecycleActivity });
      }
      return makeFetchImpl()(url, options);
    });
    renderPage();
    await screen.findByRole("heading", { name: "Sharada School Trust" });

    fireEvent.click(screen.getByRole("button", { name: "Churned" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Reason" }), { target: { value: "Customer cancelled the trip" } });
    fireEvent.click(screen.getByRole("button", { name: "Mark as Churned" }));

    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith("/api/contacts/77", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ status: "Churned", lifecycleTransitionReason: "Customer cancelled the trip" }),
    })));
    expect(await screen.findByText("Yasin")).toBeTruthy();
    expect(screen.getByText(/Reason: Customer cancelled the trip/)).toBeTruthy();
    expect(screen.getByText(/Nov 16, 2026/)).toBeTruthy();
  });

  it("does not submit a terminal status without a non-empty reason", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl());
    renderPage();
    await screen.findByRole("heading", { name: "Sharada School Trust" });

    fireEvent.click(screen.getByRole("button", { name: "Junk" }));
    fireEvent.click(screen.getByRole("button", { name: "Mark as Junk" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Please enter a reason");
    expect(fetchApiMock).not.toHaveBeenCalledWith("/api/contacts/77", expect.objectContaining({ method: "PUT" }));
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
    const wholeTripAmount = screen.getAllByText(
      (content) => content.includes("₹") && content.replace(/\D/g, "") === "160000",
    );
    expect(wholeTripAmount.length).toBeGreaterThanOrEqual(1);
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
    fireEvent.click(screen.getByRole("button", { name: "Add Note" }));
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith("/api/contacts/77/activities", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ type: "Note", description: "Call tomorrow" }),
    })));
    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    expect(screen.getByText("Note")).toBeTruthy();
    expect(screen.getByText("Call tomorrow")).toBeTruthy();
  });

  it("loads an existing note into the highlighted edit composer", async () => {
    const existing = { id: 21, type: "Note", description: "Existing school note", createdAt: "2026-11-03T10:24:00.000Z" };
    fetchApiMock.mockImplementation(makeFetchImpl({ activities: [existing] }));
    renderPage();
    await screen.findByRole("heading", { name: "Sharada School Trust" });
    fireEvent.click(screen.getByRole("button", { name: "Notes" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit note Existing school note" }));
    const input = screen.getByRole("textbox", { name: "Edit note" });
    expect(input).toHaveValue("Existing school note");
    expect(input).toHaveClass("is-editing");
    await waitFor(() => expect(input).toHaveFocus());
    expect(screen.getByRole("button", { name: "Save Note" })).toBeTruthy();
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
