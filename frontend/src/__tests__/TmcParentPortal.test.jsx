import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import TmcParentPortal from "../pages/travel/TmcParentPortal";

describe("TmcParentPortal", () => {
  let fetchSpy;

  beforeEach(() => {
    window.history.replaceState({}, "", "/tmc/parent-portal");
    localStorage.clear();
    localStorage.setItem("tmcParentPortalToken", "parent-token");
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((url, options = {}) => {
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
      if (url === "/api/portal/tmc/parent/reviews") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            trips: [{
              id: 7,
              tripCode: "DARJ-2026",
              destination: "Darjeeling",
              departDate: "2026-08-01T00:00:00.000Z",
              returnDate: "2026-08-07T00:00:00.000Z",
              status: "completed",
              review: null,
              reviewSubmitted: false,
            }, {
              id: 8,
              tripCode: "MYS-2026",
              destination: "Mysore",
              departDate: "2026-09-17T00:00:00.000Z",
              returnDate: "2026-09-18T00:00:00.000Z",
              status: "completed",
              review: null,
              reviewSubmitted: false,
            }],
          }),
        });
      }
      if (url === "/api/portal/tmc/parent/documents" && options.method === "POST") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            document: {
              id: 22,
              documentType: "School medical clearance",
              documentRequirementId: 102,
              filename: "medical-clearance.docx",
              fileSize: 2048,
              mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              status: "in_review",
              tripId: 7,
            },
          }),
        });
      }
      if (url === "/api/portal/tmc/parent/documents") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            documents: [{
              id: 11,
              documentType: "Travel insurance certificate",
              documentRequirementId: 101,
              filename: "insurance-certificate.pdf",
              fileSize: 4096,
              mimeType: "application/pdf",
              status: "in_review",
              uploadedAt: "2026-08-31T00:00:00.000Z",
              tripId: 7,
              trip: { id: 7, destination: "Darjeeling" },
            }],
            documentRequirements: [
              { id: 101, tripId: 7, docType: "Travel insurance certificate", acceptedFileTypes: ["pdf", "jpg"], required: true },
              { id: 102, tripId: 7, docType: "School medical clearance", acceptedFileTypes: ["pdf", "docx"], required: true },
            ],
          }),
        });
      }
      if (url === "/api/portal/tmc/parent/documents/11/file") {
        return Promise.resolve({
          ok: true,
          blob: () => Promise.resolve(new Blob(["passport"], { type: "application/pdf" })),
        });
      }
      if (url === "/api/portal/tmc/parent/trips/7/review" && options.method === "POST") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, overallRating: 5, externalReview: null }),
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
    const sidebar = document.querySelector('[data-tmc-parent-sidebar="true"]');
    expect(sidebar).not.toHaveTextContent("arijit@example.com");
    expect(sidebar).toHaveStyle({
      position: "fixed",
      top: "0px",
      left: "0px",
      bottom: "0px",
      width: "236px",
      height: "100vh",
      overflowY: "auto",
    });
    expect(document.querySelector('[data-tmc-parent-shell="true"]')).toHaveStyle({ marginLeft: "236px" });
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
    const bookingCard = screen.getByRole("button", { name: /View Darjeeling details/ });
    expect(bookingCard).toHaveAttribute("data-tmc-booking-card", "true");
    expect(bookingCard.querySelector('[data-tmc-booking-content="true"]')).not.toBeNull();
    const bookingActions = bookingCard.querySelector('[data-tmc-booking-actions="true"]');
    expect(bookingActions).not.toBeNull();
    expect(bookingActions).toHaveStyle({ display: "flex", alignItems: "center" });
    expect(screen.getByText("Total trip cost")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /View Darjeeling details/ }));

    expect(await screen.findByRole("heading", { name: "Darjeeling" })).toBeInTheDocument();
    expect(screen.getByText("Payment schedule")).toBeInTheDocument();
    expect(screen.getAllByText("Paid").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: /Pay now/ })).toHaveAttribute("href", "/pay/trip/7/installment/42");
  });

  it("places Travel Documents below My Bookings and keeps Reviews last", async () => {
    render(<TmcParentPortal />);

    await screen.findByRole("heading", { name: "Dashboard" });
    const nav = screen.getByRole("navigation", { name: "Parent portal sections" });
    const labels = [...nav.querySelectorAll("button")].map((button) => button.textContent.replace(/\d+$/, ""));
    expect(labels).toEqual(["Dashboard", "Trips", "My Bookings", "Travel Documents", "Reviews"]);
  });

  it("restores the selected section from the URL after a refresh", async () => {
    window.history.replaceState({}, "", "/tmc/parent-portal?view=documents");
    render(<TmcParentPortal />);

    expect(await screen.findByRole("heading", { name: "Travel Documents", level: 2 })).toBeInTheDocument();
  });

  it("shows trip-specific custom requirements and uploads against the selected requirement", async () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    globalThis.URL.createObjectURL = vi.fn(() => "blob:parent-document");
    globalThis.URL.revokeObjectURL = vi.fn();
    render(<TmcParentPortal />);

    await screen.findByRole("heading", { name: "Dashboard" });
    fireEvent.click(screen.getByRole("button", { name: /Travel Documents/ }));
    expect(await screen.findByText(/insurance-certificate\.pdf/)).toBeInTheDocument();
    expect(screen.getByText("Travel insurance certificate", { exact: true })).toBeInTheDocument();
    expect(screen.getAllByText(/Darjeeling/).length).toBeGreaterThan(0);
    expect(screen.queryByRole("combobox", { name: "Document type" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Aadhaar card|Consent form|Visa documents/)).not.toBeInTheDocument();

    const tripSelect = screen.getByRole("combobox", { name: "Related trip" });
    fireEvent.change(tripSelect, { target: { value: "7" } });
    const uploadedRequirement = screen.getAllByText("Travel insurance certificate", { exact: true })[0].closest("button");
    const pendingRequirement = screen.getByText("School medical clearance", { exact: true }).closest("button");
    expect(uploadedRequirement).toHaveTextContent("Uploaded");
    expect(pendingRequirement).toHaveTextContent("Pending");
    expect(screen.getByLabelText("Accepted file types")).toHaveTextContent(/Travel insurance certificate:\s*PDF, JPG \/ JPEG/);
    expect(screen.getByLabelText("Choose travel document")).toHaveAttribute("accept", expect.stringContaining("application/pdf"));

    fireEvent.click(pendingRequirement);
    const file = new File(["docx"], "medical-clearance.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    fireEvent.change(screen.getByLabelText("Choose travel document"), { target: { files: [file] } });
    fireEvent.click(screen.getByText("Upload document", { exact: true }).closest("button"));

    await waitFor(() => {
      const uploadCall = fetchSpy.mock.calls.find(([url, options]) => url === "/api/portal/tmc/parent/documents" && options.method === "POST");
      expect(uploadCall).toBeTruthy();
      expect(uploadCall[1].body).toBeInstanceOf(FormData);
      expect(uploadCall[1].body.get("tripId")).toBe("7");
      expect(uploadCall[1].body.get("documentRequirementId")).toBe("102");
      expect(uploadCall[1].body.get("documentType")).toBeNull();
      expect(uploadCall[1].body.get("file").name).toBe("medical-clearance.docx");
    });
    expect(await screen.findByText(/School medical clearance uploaded/)).toBeInTheDocument();

    const uploadedDocumentRow = document.querySelector('[data-tmc-parent-document="11"]');
    fireEvent.click(uploadedDocumentRow.querySelector('button[aria-label="View insurance-certificate.pdf"]'));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith(
      "/api/portal/tmc/parent/documents/11/file",
      expect.objectContaining({ headers: { Authorization: "Bearer parent-token" } }),
    ));
    await waitFor(() => expect(openSpy).toHaveBeenCalledWith("blob:parent-document", "_blank", "noopener,noreferrer"));
    openSpy.mockRestore();
  });

  it("renders and submits an enabled digital consent form without a file input", async () => {
    const defaultFetchImplementation = fetchSpy.getMockImplementation();
    fetchSpy.mockImplementation((url, options = {}) => {
      if (url === "/api/portal/tmc/parent/documents" && (!options.method || options.method === "GET")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            documents: [],
            documentRequirements: [
              {
                id: 103,
                tripId: 7,
                docType: "Parent consent form",
                captureMode: "digital_consent",
                consentTerms: "I agree to the Darjeeling trip terms.",
                consentForm: { terms: "I agree to the Darjeeling trip terms." },
                required: true,
              },
            ],
          }),
        });
      }
      if (url === "/api/portal/tmc/parent/consents" && options.method === "POST") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            document: {
              id: 103,
              documentType: "Parent consent form",
              captureMode: "digital_consent",
              status: "in_review",
              tripId: 7,
            },
          }),
        });
      }
      return defaultFetchImplementation(url, options);
    });

    render(<TmcParentPortal />);
    await screen.findByRole("heading", { name: "Dashboard" });
    fireEvent.click(screen.getByRole("button", { name: /Travel Documents/ }));
    fireEvent.change(await screen.findByRole("combobox", { name: "Related trip" }), { target: { value: "7" } });
    fireEvent.click(await screen.findByRole("button", { name: /Parent consent form/ }));

    expect(await screen.findByText("I agree to the Darjeeling trip terms.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Choose travel document")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Student / participant full name"), { target: { value: "Anaya Singh" } });
    fireEvent.change(screen.getByLabelText("Type your full name as your signature"), { target: { value: "Arijit Singh" } });
    fireEvent.click(screen.getByLabelText("I agree to the terms and conditions above."));
    fireEvent.click(screen.getByRole("button", { name: "Submit consent form" }));

    await waitFor(() => {
      const submitCall = fetchSpy.mock.calls.find(([url, options]) => url === "/api/portal/tmc/parent/consents" && options.method === "POST");
      expect(submitCall).toBeTruthy();
      expect(JSON.parse(submitCall[1].body)).toMatchObject({
        tripId: "7",
        documentRequirementId: "103",
        participantName: "Anaya Singh",
        signatureName: "Arijit Singh",
        agreedToTerms: true,
      });
    });
    expect(await screen.findByText(/Parent consent form submitted/)).toBeInTheDocument();
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

  it("shows the parent review option and lists completed trips", async () => {
    render(<TmcParentPortal />);

    await screen.findByRole("heading", { name: "Dashboard" });
    fireEvent.click(screen.getByRole("button", { name: "Reviews" }));

    expect(await screen.findByRole("heading", { name: "Reviews", level: 2 })).toBeInTheDocument();
    expect(screen.getAllByText("Darjeeling").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Mysore").length).toBeGreaterThan(0);
    expect(screen.getByRole("combobox", { name: "Select a trip to review" })).toHaveValue("");
    expect(screen.getAllByRole("option")).toHaveLength(3);
    expect(screen.queryByRole("heading", { name: /Your experience of/i })).not.toBeInTheDocument();
  });

  it("opens the review form and submits a five-star parent experience", async () => {
    render(<TmcParentPortal />);

    await screen.findByRole("heading", { name: "Dashboard" });
    fireEvent.click(screen.getByRole("button", { name: "Reviews" }));
    const tripSelect = await screen.findByRole("combobox", { name: "Select a trip to review" });
    fireEvent.change(tripSelect, { target: { value: "7" } });

    expect(await screen.findByRole("heading", { name: /Your experience of Darjeeling/i })).toBeInTheDocument();
    expect(screen.getByText("Completed")).toBeInTheDocument();
    fireEvent.change(tripSelect, { target: { value: "8" } });
    expect(await screen.findByRole("heading", { name: /Your experience of Mysore/i })).toBeInTheDocument();
    fireEvent.change(tripSelect, { target: { value: "7" } });
    expect(screen.getByText("Overall rating")).toBeInTheDocument();
    expect(screen.getByText("0/500")).toBeInTheDocument();
    expect(screen.queryByText("Positive reviews rated 4 stars or above may be shared on our review page.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Rate 5 out of 5 stars" }));
    expect(screen.getByText("5 out of 5")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Tell us about your experience"), { target: { value: "The trip was excellent and very well organised." } });
    fireEvent.click(screen.getByRole("button", { name: "Submit review" }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith(
      "/api/portal/tmc/parent/trips/7/review",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ answers: { rating: 5, experience: "The trip was excellent and very well organised." } }) }),
    ));
    expect(await screen.findByText("Thank you for your review.")).toBeInTheDocument();
  });
});
