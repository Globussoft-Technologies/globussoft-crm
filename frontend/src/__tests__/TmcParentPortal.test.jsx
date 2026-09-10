import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import TmcParentPortal from "../pages/travel/TmcParentPortal";

describe("TmcParentPortal", () => {
  let fetchSpy;

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("tmcParentPortalToken", "parent-token");
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
      if (url === "/api/portal/tmc/parent/me") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ contact: { name: "Arijit Singh", email: "arijit@example.com" } }),
        });
      }
      if (url === "/api/portal/tmc/parent/trips") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            trips: [{
              id: 5,
              tripId: 7,
              teacher: { name: "Aisha Teacher", email: "aisha@example.com" },
              landingUrl: "/trips/88",
              trip: {
                id: 7,
                tripCode: "DARJ-2026",
                destination: "Darjeeling",
                departDate: "2026-11-06T00:00:00.000Z",
                returnDate: "2026-11-12T00:00:00.000Z",
                status: "confirmed",
              },
            }],
            parentLinks: [],
            registrations: [],
            participants: [],
          }),
        });
      }
      if (url === "/api/portal/travel/bookings") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([{
            id: "registration-participant-55",
            tripId: 7,
            destination: "Darjeeling",
            startDate: "2026-11-06T00:00:00.000Z",
            endDate: "2026-11-12T00:00:00.000Z",
            status: "confirmed",
            currency: "INR",
            totalAmount: 35000,
            instalments: [
              { id: 41, instalmentIndex: 0, amount: 10000, paidAmount: 10000, status: "paid", paidAt: "2026-08-31T00:00:00.000Z" },
              { id: 42, instalmentIndex: 1, amount: 25000, paidAmount: 0, status: "pending", dueDate: "2026-09-30T00:00:00.000Z", paymentLinkUrl: "/pay/trip/7/installment/42" },
            ],
          }]),
        });
      }
      if (url === "/api/portal/travel/notifications?limit=30") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            notifications: [{ id: 1, title: "Trip update", body: "Your Darjeeling trip is ready.", isRead: false, link: "trips" }],
            unreadCount: 1,
          }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    localStorage.clear();
  });

  it("loads the dashboard with the parent portal navigation and summaries", async () => {
    render(<TmcParentPortal />);

    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getByText("Welcome, Arijit!")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Trips" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /My Bookings/ })).toBeInTheDocument();
    expect(screen.getByText("Upcoming trip")).toBeInTheDocument();
  });

  it("shows assigned trips and links parents to the registration landing page", async () => {
    render(<TmcParentPortal />);

    await screen.findByRole("heading", { name: "Dashboard" });
    fireEvent.click(screen.getByRole("button", { name: "Trips" }));

    expect(await screen.findByRole("heading", { name: "Trips", level: 2 })).toBeInTheDocument();
    expect(screen.getByText("Darjeeling")).toBeInTheDocument();
    expect(screen.getByText("Teacher: Aisha Teacher")).toBeInTheDocument();
    expect(screen.queryByText("Confirmed")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /View trip & register/ })).toHaveAttribute("href", "/trips/88");
  });

  it("shows booking details, payment totals, and the outstanding payment action", async () => {
    render(<TmcParentPortal />);

    await screen.findByRole("heading", { name: "Dashboard" });
    fireEvent.click(screen.getByRole("button", { name: /My Bookings/ }));
    expect(await screen.findByRole("heading", { name: "My Bookings", level: 2 })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /View Darjeeling details/ }));

    expect(await screen.findByRole("heading", { name: "Darjeeling" })).toBeInTheDocument();
    expect(screen.getByText("Payment schedule")).toBeInTheDocument();
    expect(screen.getAllByText("Paid").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: /Pay now/ })).toHaveAttribute("href", "/pay/trip/7/installment/42");
  });

  it("supports theme switching and opens the parent profile from the header", async () => {
    render(<TmcParentPortal />);

    await screen.findByRole("heading", { name: "Dashboard" });
    expect(screen.getByRole("button", { name: "Switch to dark mode" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Switch to dark mode" }));
    expect(screen.getByRole("button", { name: "Switch to light mode" })).toBeInTheDocument();
    expect(localStorage.getItem("tmcParentPortalTheme")).toBe("dark");

    fireEvent.click(screen.getByRole("button", { name: "Open profile" }));
    expect(await screen.findByRole("heading", { name: "My Profile" })).toBeInTheDocument();
    expect(screen.getByText("Profile details")).toBeInTheDocument();
  });

  it("loads notifications and marks them all read", async () => {
    render(<TmcParentPortal />);

    await screen.findByRole("heading", { name: "Dashboard" });
    const notificationButton = await screen.findByRole("button", { name: "Notifications (1 unread)" });
    fireEvent.click(notificationButton);

    expect(await screen.findByRole("dialog", { name: "Notifications" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: "Mark all read" })).not.toBeInTheDocument());
    expect(fetchSpy).toHaveBeenCalledWith("/api/portal/travel/notifications/mark-all-read", expect.objectContaining({ method: "POST" }));
  });
});
