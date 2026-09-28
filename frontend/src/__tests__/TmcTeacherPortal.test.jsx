import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import TmcTeacherPortal from "../pages/travel/TmcTeacherPortal";

describe("TmcTeacherPortal", () => {
  let fetchSpy;

  beforeEach(() => {
    window.history.replaceState({}, "", "/tmc/teacher-portal");
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
            json: () => Promise.resolve({ diagnostics: [{ id: 12, createdAt: "2026-09-09T00:00:00.000Z", reportPdfUrl: "/api/travel/diagnostics/12/readiness-report.pdf" }] }),
        });
      }
      if (url === "/api/portal/tmc/teacher/reviews") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            trips: [{
              id: 9,
              tripCode: "TMC-009",
              destination: "Mysore",
              tripType: "day_trip",
              departDate: "2026-09-01T00:00:00.000Z",
              returnDate: "2026-09-01T00:00:00.000Z",
              status: "completed",
              review: null,
              reviewSubmitted: false,
            }, {
              id: 10,
              tripCode: "TMC-010",
              destination: "Bengaluru",
              tripType: "day_trip",
              departDate: "2026-09-15T00:00:00.000Z",
              returnDate: "2026-09-15T00:00:00.000Z",
              status: "completed",
              review: null,
              reviewSubmitted: false,
            }],
          }),
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
              json: () => Promise.resolve({ participants: [{ id: 55, fullName: "Manish", parentName: "Arijit", parentEmail: "arijit@example.com", parentPhone: "+91 90000 00001" }] }),
        });
      }
      if (url === "/api/portal/tmc/teacher/trips/9/review") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            ok: true,
            review: {
              id: 44,
              tripId: 9,
              reportDate: "2026-09-01T00:00:00.000Z",
              institution: "Greenfield School",
              tourDestination: "Mysore",
              coordinator: "Aisha Teacher",
              grade: "7",
              travelRating: "excellent",
              foodRating: "good",
              activitiesRating: "good",
              careSupportRating: "excellent",
              overallRating: "good",
              feedback: "Great trip.",
              studentCount: 30,
              staffCount: 3,
              totalPassengers: 33,
              signature: "Aisha Teacher",
            },
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

  it("opens on a teacher dashboard with live overview data", async () => {
    render(<TmcTeacherPortal />);

    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
    expect(await screen.findByText("Welcome, Aisha Teacher!")).toBeInTheDocument();
    expect(screen.getByText("Assigned trips")).toBeInTheDocument();
    expect(screen.getByText("Singapore")).toBeInTheDocument();
    expect(screen.getByText("Readiness report #12")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Parent portal links" })).not.toBeInTheDocument();
  });

  it("opens the authenticated native diagnostic from a dashboard report", async () => {
    render(<TmcTeacherPortal />);

    await screen.findByRole("heading", { name: "Dashboard" });
    const reportSection = screen.getByRole("heading", { name: "Diagnostic reports" }).closest("section");
    fireEvent.click(within(reportSection).getByRole("button", { name: "Open diagnostic" }));

    expect(await screen.findByRole("heading", { name: "Teacher diagnostic" })).toBeInTheDocument();
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes("/diagnostics/public/form/"))).toBe(false);
    expect(fetchSpy.mock.calls.some(([url]) => url === "/api/portal/tmc/teacher/diagnostic")).toBe(true);
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
    expect(screen.getByText("Child / student")).toBeInTheDocument();
    expect(screen.getByText("Parent / guardian")).toBeInTheDocument();
    expect(screen.getByText("Arijit")).toBeInTheDocument();
    expect(screen.getByText("arijit@example.com")).toBeInTheDocument();
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

  it("does not let a teacher create a parent registration link", async () => {
    render(<TmcTeacherPortal />);

    await screen.findByRole("heading", { name: "Dashboard" });
    fireEvent.click(screen.getByRole("button", { name: "View all" }));
    await screen.findByRole("heading", { name: "Your trips" });
    fireEvent.click(screen.getByRole("button", { name: /Singapore.*participants/ }));
    await screen.findByRole("heading", { name: "Singapore" });
    expect(screen.queryByRole("button", { name: "Create parent link" })).not.toBeInTheDocument();
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes("/teacher/trips/7/parent-link"))).toBe(false);
  });

  it("opens the trips page when a trip assignment notification is selected", async () => {
    render(<TmcTeacherPortal />);

    await screen.findByRole("heading", { name: "Dashboard" });
    fireEvent.click(await screen.findByRole("button", { name: /Notifications/ }));
    fireEvent.click(await screen.findByRole("button", { name: "New trip assigned to you" }));

    expect(await screen.findByRole("heading", { name: "Your trips" })).toBeInTheDocument();
  });

  it("restores the selected section from the URL after a refresh", async () => {
    window.history.replaceState({}, "", "/tmc/teacher-portal?view=trips");
    render(<TmcTeacherPortal />);

    expect(await screen.findByRole("heading", { name: "Your trips" })).toBeInTheDocument();
  });

  it("opens the review page from the trips screen", async () => {
    render(<TmcTeacherPortal />);

    await screen.findByRole("heading", { name: "Dashboard" });
    fireEvent.click(screen.getByRole("button", { name: "View all" }));
    await screen.findByRole("heading", { name: "Your trips" });
    fireEvent.click(screen.getByRole("button", { name: "Review a completed trip" }));

    expect(await screen.findByRole("heading", { name: "Trip review", level: 2 })).toBeInTheDocument();
  });

  it("keeps the review form collapsed until a trip is selected and supports trip search", async () => {
    render(<TmcTeacherPortal />);

    await screen.findByRole("heading", { name: "Dashboard" });
    fireEvent.click(screen.getByRole("button", { name: "Trip review" }));
    expect(await screen.findByRole("heading", { name: "Trip review", level: 2 })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Select completed trip" })).toHaveValue("");
    expect(screen.queryByRole("heading", { name: "Tour details" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search trips" }), { target: { value: "Bengaluru" } });
    expect(screen.getByRole("option", { name: /Bengaluru.*TMC-010/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Mysore.*TMC-009/ })).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Select completed trip" }), { target: { value: "10" } });
    expect(await screen.findByRole("heading", { name: "Tour details" })).toBeInTheDocument();
  });

  it("lets a teacher choose a completed trip and submit the tour report", async () => {
    render(<TmcTeacherPortal />);

    await screen.findByRole("heading", { name: "Dashboard" });
    fireEvent.click(screen.getByRole("button", { name: "Trip review" }));
    expect(await screen.findByRole("heading", { name: "Trip review", level: 2 })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Select completed trip" }), { target: { value: "9" } });

    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-09-01" } });
    fireEvent.change(screen.getByLabelText("Institution"), { target: { value: "Greenfield School" } });
    fireEvent.change(screen.getByLabelText("Tour destination"), { target: { value: "Mysore" } });
    fireEvent.change(screen.getByLabelText("Coordinator"), { target: { value: "Aisha Teacher" } });
    fireEvent.change(screen.getByLabelText("Grade"), { target: { value: "7" } });
    fireEvent.change(screen.getByLabelText("No. of students"), { target: { value: "30" } });
    fireEvent.change(screen.getByLabelText("No. of staff"), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("Total passengers"), { target: { value: "33" } });
    fireEvent.change(screen.getByLabelText("Signature (type your full name)"), { target: { value: "Aisha Teacher" } });
    const rating = (row, option) => fireEvent.click(within(screen.getByRole("group", { name: row })).getByRole("radio", { name: option }));
    rating("Travel", "Excellent");
    rating("Food", "Good");
    rating("Activities", "Good");
    rating("Care & support", "Excellent");
    rating("Overall", "Good");
    fireEvent.click(screen.getByRole("button", { name: "Submit report" }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith(
      "/api/portal/tmc/teacher/trips/9/review",
      expect.objectContaining({ method: "PUT" }),
    ));
    expect(await screen.findByRole("status")).toHaveTextContent("Your trip report has been submitted successfully.");
    expect(JSON.parse(fetchSpy.mock.calls.find(([url]) => url === "/api/portal/tmc/teacher/trips/9/review")[1].body)).toMatchObject({
      institution: "Greenfield School",
      totalPassengers: "33",
      overallRating: "good",
    });

    fireEvent.click(await screen.findByRole("button", { name: "Update report" }));
    await waitFor(() => expect(fetchSpy.mock.calls.filter(([url]) => url === "/api/portal/tmc/teacher/trips/9/review")).toHaveLength(2));
    expect(await screen.findByRole("status")).toHaveTextContent("Your trip report has been updated successfully.");
  });
});
