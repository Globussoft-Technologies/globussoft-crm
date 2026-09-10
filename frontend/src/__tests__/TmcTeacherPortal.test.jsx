import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import TmcTeacherPortal from "../pages/travel/TmcTeacherPortal";

describe("TmcTeacherPortal", () => {
  let fetchSpy;

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("tmcTeacherPortalToken", "teacher-token");
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
      if (url === "/api/portal/tmc/teacher/me") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            contact: { name: "Aisha Teacher", email: "aisha@example.com" },
            tenant: { slug: "tmc" },
          }),
        });
      }
      if (url === "/api/portal/tmc/teacher/trips") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            trips: [{
              id: 7,
              tripCode: "TMC-007",
              destination: "Singapore",
              departDate: "2026-12-01T00:00:00.000Z",
              _count: { participants: 2, pendingRegistrations: 1 },
            }],
          }),
        });
      }
      if (url === "/api/portal/tmc/teacher/diagnostics") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ diagnostics: [{ id: 12, createdAt: "2026-09-09T00:00:00.000Z", reportUrl: "/p/tmc/report/12" }] }),
        });
      }
      if (url === "/api/portal/tmc/teacher/trips/7/landing-page") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            landingPage: { id: 88, tripId: 7, title: "Mysore 2 Days", slug: "mysore-oct-26", status: "PUBLISHED" },
            publicUrl: "/trips/88",
          }),
        });
      }
      if (url === "/api/portal/travel/notifications?limit=30") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            notifications: [{ id: 901, title: "New trip assigned to you", message: "Mysore has been assigned to you.", link: "trips", isRead: false }],
            unreadCount: 1,
          }),
        });
      }
      if (url === "/api/portal/tmc/teacher/trips/7/registrations") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            registrations: [{
              id: 101,
              studentName: "Manish",
              parentName: "Arijit",
              status: "CONVERTED",
              convertedToParticipantId: 55,
            }],
            parentLinks: [],
          }),
        });
      }
      if (url === "/api/portal/tmc/teacher/trips/7/participants") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ participants: [{ id: 55, fullName: "Manish", parentName: "Arijit" }] }),
        });
      }
      if (url === "/api/portal/tmc/teacher/trips/7/parent-link") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ link: "https://example.com/parent-registration/7" }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    localStorage.clear();
  });

  it("opens on a teacher dashboard with live overview data", async () => {
    render(<TmcTeacherPortal />);

    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
    expect(await screen.findByText("Welcome, Aisha Teacher!")).toBeInTheDocument();
    expect(screen.getByText("Assigned trips")).toBeInTheDocument();
    expect(screen.getByText("Singapore")).toBeInTheDocument();
    expect(screen.getByText("Readiness report #12")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Parent portal links" })).not.toBeInTheDocument();
  });

  it("filters assigned trips by destination or trip code", async () => {
    render(<TmcTeacherPortal />);

    await screen.findByRole("heading", { name: "Dashboard" });
    fireEvent.click(screen.getByRole("button", { name: "View all" }));
    await screen.findByRole("heading", { name: "Your trips" });

    const search = screen.getByRole("searchbox", { name: "Search assigned trips" });
    fireEvent.change(search, { target: { value: "Mysore" } });
    expect(screen.getByText(/No trips match/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Singapore.*participants/ })).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: "TMC-007" } });
    expect(await screen.findByRole("button", { name: /Singapore.*participants/ })).toBeInTheDocument();
  });

  it("returns to sign-in when the teacher profile is unavailable", async () => {
    fetchSpy.mockImplementation((url) => {
      if (url === "/api/portal/tmc/teacher/me") {
        return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ error: "Portal profile not found" }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ trips: [], diagnostics: [] }) });
    });

    render(<TmcTeacherPortal />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent(/teacher profile is no longer active/i);
  });

  it("does not show a converted registration twice as a participant", async () => {
    render(<TmcTeacherPortal />);

    await screen.findByRole("heading", { name: "Dashboard" });
    fireEvent.click(screen.getByRole("button", { name: "View all" }));
    await screen.findByRole("heading", { name: "Your trips" });
    fireEvent.click(screen.getByRole("button", { name: /Singapore.*participants/ }));

    await screen.findByRole("heading", { name: "Singapore" });
    await waitFor(() => expect(screen.getByText("Participant")).toBeInTheDocument());
    expect(screen.getAllByText("Manish")).toHaveLength(1);
    expect(screen.queryByText("Registrations")).not.toBeInTheDocument();
    expect(screen.queryByText("CONVERTED")).not.toBeInTheDocument();
  });

  it("shows the published landing page in the trip tab", async () => {
    render(<TmcTeacherPortal />);

    await screen.findByRole("heading", { name: "Dashboard" });
    fireEvent.click(screen.getByRole("button", { name: "View all" }));
    await screen.findByRole("heading", { name: "Your trips" });
    fireEvent.click(screen.getByRole("button", { name: /Singapore.*participants/ }));
    await screen.findByRole("heading", { name: "Singapore" });
    fireEvent.click(screen.getByRole("tab", { name: "Landing page" }));

    expect(await screen.findByTitle("Mysore 2 Days landing page")).toBeInTheDocument();
    expect(screen.getByText("Review the trip information that parents will see.")).toBeInTheDocument();
  });

  it("changes the copy button to Copied after the link is copied", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });

    render(<TmcTeacherPortal />);

    await screen.findByRole("heading", { name: "Dashboard" });
    fireEvent.click(screen.getByRole("button", { name: "View all" }));
    await screen.findByRole("heading", { name: "Your trips" });
    fireEvent.click(screen.getByRole("button", { name: /Singapore.*participants/ }));
    await screen.findByRole("heading", { name: "Singapore" });
    fireEvent.click(screen.getByRole("button", { name: "Create parent link" }));

    const copyButton = await screen.findByRole("button", { name: "Copy link" });
    fireEvent.click(copyButton);

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("https://example.com/parent-registration/7");
      expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
    });
  });

  it("opens the trips page when a trip assignment notification is selected", async () => {
    render(<TmcTeacherPortal />);

    await screen.findByRole("heading", { name: "Dashboard" });
    fireEvent.click(await screen.findByRole("button", { name: /Notifications/ }));
    fireEvent.click(await screen.findByRole("button", { name: "New trip assigned to you" }));

    expect(await screen.findByRole("heading", { name: "Your trips" })).toBeInTheDocument();
  });
});
