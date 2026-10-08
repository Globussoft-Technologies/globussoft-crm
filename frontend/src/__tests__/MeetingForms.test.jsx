import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";

const fetchApi = vi.fn();
const notify = { success: vi.fn(), error: vi.fn() };
vi.mock("../utils/api", () => ({ fetchApi: (...args) => fetchApi(...args) }));
vi.mock("../utils/notify", () => ({ useNotify: () => notify }));

import MeetingForms from "../pages/travel/MeetingForms";

const FORM = {
  id: 7,
  name: "Talk to an Expert",
  slug: "talk-to-an-expert",
  publicKey: "tmcmf_abcdefghijklmnopqrstuvwxyz",
  hostUserId: 3,
  durationMins: 30,
  timezone: "Asia/Kolkata",
  slotIntervalMins: 30,
  bufferBeforeMins: 0,
  bufferAfterMins: 0,
  minimumNoticeMins: 120,
  bookingHorizonDays: 60,
  weeklyHours: { monday: [{ start: "10:00", end: "17:00" }] },
  dateOverrides: {},
  blackoutDates: [],
  fields: [],
  allowedOrigins: ["https://themodernclassroom.in"],
  calendarProvider: "google",
  createZoom: true,
  createCalendarEvent: true,
  sendConfirmationEmail: true,
  embedFontFamily: "Poppins",
  emailSubject: "Your Conversation with TMC is Confirmed",
  emailBody: "Hi {{name}},\n\nJoin here: {{meeting_url}}",
  emailCc: [],
  isActive: true,
  _count: { bookings: 1 },
};

beforeEach(() => {
  fetchApi.mockReset();
  notify.success.mockReset();
  notify.error.mockReset();
  fetchApi.mockImplementation((url) => {
    if (url === "/api/travel/meeting-forms") return Promise.resolve([FORM]);
    if (url === "/api/travel/meeting-forms/hosts") return Promise.resolve([{ id: 3, name: "TMC Host", email: "host@tmc.test", calendarIntegrations: [{ provider: "google" }] }]);
    if (url === "/api/travel/meeting-forms/zoom-config") return Promise.resolve({ configured: true, status: "CONNECTED", accountId: "****1234", clientId: "****abcd", clientSecretConfigured: true, zoomHostUserId: "me", verifiedAt: "2026-09-24T10:00:00Z" });
    if (url === "/api/travel/email-provider") return Promise.resolve({ configured: false, source: "backend" });
    if (url.startsWith("/api/travel/meeting-forms/7/bookings?")) return Promise.resolve({ items: [{ id: 11, contactName: "Teacher", contactEmail: "teacher@school.test", scheduledAt: "2099-01-01T10:00:00Z", status: "CONFIRMED", emailStatus: "SENT", meetingUrl: "https://zoom.us/j/teacher" }], total: 1, page: 1, pageSize: 10, totalPages: 1 });
    return Promise.resolve({});
  });
});

describe("MeetingForms", () => {
  it("loads Travel CRM meeting forms and exposes the shared embed/API contract", async () => {
    render(<MeetingForms />);
    expect(await screen.findByText("Talk to an Expert")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Embed & API" }));
    expect(await screen.findByText("Store an externally confirmed booking")).toBeInTheDocument();
    expect(screen.getAllByDisplayValue(/\/embed\/meeting-form\.html\?form=tmcmf_/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByDisplayValue(/&font=Poppins/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/\/availability\?start=YYYY-MM-DD/)).toBeInTheDocument();
    expect(screen.getByText(/\/external-bookings/)).toBeInTheDocument();
    expect(screen.getByText(/submitted contact, time, timezone, duration/i)).toBeInTheDocument();
    expect(screen.getByText(/No API key is required/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Rotate API key/i })).not.toBeInTheDocument();
  });

  it("keeps a new form open, suggests a unique slug, and creates a second Meeting Form", async () => {
    const secondForm = {
      ...FORM,
      id: 8,
      name: "Talk to a TMC Experiential Learning Expert 2",
      slug: "talk-to-an-expert-2",
      publicKey: "tmcmf_second_form",
      isActive: false,
      _count: { bookings: 0 },
    };
    const regularImplementation = fetchApi.getMockImplementation();
    let created = false;
    fetchApi.mockImplementation((url, options) => {
      if (url === "/api/travel/meeting-forms" && options?.method === "POST") {
        created = true;
        return Promise.resolve(secondForm);
      }
      if (url === "/api/travel/meeting-forms" && created) return Promise.resolve([FORM, secondForm]);
      return regularImplementation(url, options);
    });

    render(<MeetingForms />);
    await screen.findByText("Talk to an Expert");
    fireEvent.click(screen.getByRole("button", { name: "New Meeting Form" }));

    expect(await screen.findByRole("heading", { name: "New Meeting Form settings" })).toBeInTheDocument();
    expect(screen.getByText(/Creating a new Meeting Form/i)).toBeInTheDocument();
    expect(screen.getByDisplayValue("talk-to-an-expert-2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Embed & API" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Bookings" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Create Meeting Form" }));

    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith(
      "/api/travel/meeting-forms",
      expect.objectContaining({ method: "POST" }),
    ));
    const createCall = fetchApi.mock.calls.find(([url, options]) => url === "/api/travel/meeting-forms" && options?.method === "POST");
    expect(JSON.parse(createCall[1].body)).toMatchObject({
      name: "Talk to a TMC Experiential Learning Expert 2",
      slug: "talk-to-an-expert-2",
      hostUserId: 3,
      fields: expect.arrayContaining([
        expect.objectContaining({
          key: "designation",
          type: "select",
          options: ["Principal", "Vice Principal", "Head of School", "Academic Coordinator", "Teacher / Faculty", "School Management", "Other"],
        }),
      ]),
    });
    await waitFor(() => expect(screen.queryByRole("heading", { name: "New Meeting Form settings" })).not.toBeInTheDocument());
    expect(notify.success).toHaveBeenCalledWith("Meeting form created");
    expect(screen.getByDisplayValue("talk-to-an-expert-2")).toBeInTheDocument();
  });

  it("shows confirmed bookings with Unified Inbox email status", async () => {
    const { container } = render(<MeetingForms />);
    await screen.findByText("Talk to an Expert");
    fireEvent.click(screen.getByRole("button", { name: "Bookings" }));
    expect(await screen.findByText("Teacher")).toBeInTheDocument();
    expect(screen.getByText("CONFIRMED")).toBeInTheDocument();
    expect(screen.getByText("SENT")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to Meeting" })).toHaveAttribute("href", "https://zoom.us/j/teacher");
    expect(screen.getByRole("link", { name: "Go to Meeting" })).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("article")).toBeInTheDocument();
    expect(container.querySelector('[data-booking-field="When"]').textContent).not.toMatch(/\d{1,2}:\d{2}:\d{2}/);
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith("/api/travel/meeting-forms/7/bookings?page=1&pageSize=10"));
  });

  it("paginates booking results and lets the operator change page size", async () => {
    const regularImplementation = fetchApi.getMockImplementation();
    const rows = Array.from({ length: 23 }, (_, index) => ({ id: index + 1, contactName: `Teacher ${index + 1}`, contactEmail: `teacher${index + 1}@school.test`, scheduledAt: "2099-01-01T10:00:00Z", status: "CONFIRMED", emailStatus: "SENT" }));
    fetchApi.mockImplementation((url, options) => {
      if (url.startsWith("/api/travel/meeting-forms/7/bookings?")) {
        const params = new URLSearchParams(url.split("?")[1]);
        const page = Number(params.get("page"));
        const pageSize = Number(params.get("pageSize"));
        return Promise.resolve({ items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize, totalPages: Math.ceil(rows.length / pageSize) });
      }
      return regularImplementation(url, options);
    });
    render(<MeetingForms />);
    await screen.findByText("Talk to an Expert");
    fireEvent.click(screen.getByRole("button", { name: "Bookings" }));
    expect(await screen.findByText("Teacher 1")).toBeInTheDocument();
    expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next bookings page" }));
    expect(await screen.findByText("Teacher 11")).toBeInTheDocument();
    expect(screen.queryByText("Teacher 1")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Bookings per page" }), { target: { value: "20" } });
    expect(await screen.findByText("Teacher 20")).toBeInTheDocument();
    expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
    expect(fetchApi).toHaveBeenCalledWith("/api/travel/meeting-forms/7/bookings?page=1&pageSize=20");
  });

  it("saves the host calendar option independently of Zoom", async () => {
    render(<MeetingForms />);
    await screen.findByText("Talk to an Expert");
    fireEvent.click(screen.getByRole("checkbox", { name: "Create Zoom meeting" }));
    expect(screen.getByRole("checkbox", { name: "Send confirmation email" })).toBeEnabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Add to host calendar" }));
    fireEvent.click(screen.getByRole("button", { name: /Save Changes/i }));
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith(
      "/api/travel/meeting-forms/7",
      expect.objectContaining({ method: "PUT", body: expect.stringContaining('"createCalendarEvent":false') }),
    ));
  });

  it("lets an operator turn the calendar option back on even before the host reconnects", async () => {
    const regularImplementation = fetchApi.getMockImplementation();
    fetchApi.mockImplementation((url, options) => {
      if (url === "/api/travel/meeting-forms" && !options) return Promise.resolve([{ ...FORM, createCalendarEvent: false }]);
      if (url === "/api/travel/meeting-forms/hosts") return Promise.resolve([{ id: 3, name: "TMC Host", email: "host@tmc.test", calendarIntegrations: [] }]);
      return regularImplementation(url, options);
    });
    render(<MeetingForms />);
    await screen.findByText("Talk to an Expert");
    const calendarOption = screen.getByRole("checkbox", { name: "Add to host calendar" });
    expect(calendarOption).toBeEnabled();
    expect(calendarOption).not.toBeChecked();
    fireEvent.click(calendarOption);
    expect(calendarOption).toBeChecked();
    expect(screen.getByText(/Connect Google Calendar for the selected host/)).toBeInTheDocument();
  });

  it("deletes a booking after confirming that provider resources remain", async () => {
    const regularImplementation = fetchApi.getMockImplementation();
    let deleted = false;
    fetchApi.mockImplementation((url, options) => {
      if (url === "/api/travel/meeting-forms/7/bookings/11" && options?.method === "DELETE") { deleted = true; return Promise.resolve({ success: true, deletedBookingId: 11 }); }
      if (deleted && url.startsWith("/api/travel/meeting-forms/7/bookings?")) return Promise.resolve({ items: [], total: 0, page: 1, pageSize: 10, totalPages: 1 });
      return regularImplementation(url, options);
    });
    render(<MeetingForms />);
    await screen.findByText("Talk to an Expert");
    fireEvent.click(screen.getByRole("button", { name: "Bookings" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete booking for Teacher" }));
    expect(screen.getByRole("dialog", { name: "Delete booking?" })).toHaveTextContent("calendar event");
    fireEvent.click(screen.getByRole("button", { name: "Delete booking", exact: true }));
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith("/api/travel/meeting-forms/7/bookings/11", { method: "DELETE" }));
    expect(screen.getByText("No bookings have been received for this form.")).toBeInTheDocument();
  });

  it("shows external scheduler fields and allows an explicit CRM email send", async () => {
    const regularImplementation = fetchApi.getMockImplementation();
    fetchApi.mockImplementation((url, options) => {
      if (url.startsWith("/api/travel/meeting-forms/7/bookings?")) return Promise.resolve({ items: [{
        id: 12,
        contactName: "Priya Sharma",
        contactEmail: "priya@school.edu.in",
        scheduledAt: "2026-10-09T04:30:00Z",
        status: "CONFIRMED",
        emailStatus: "EXTERNAL",
        emailChannel: "external_scheduler",
        zoomMeetingId: "zoom-event-123",
        payload: { city: "Bengaluru", zoomEventId: "zoom-event-123" },
      }], total: 1, page: 1, pageSize: 10, totalPages: 1 });
      return regularImplementation(url, options);
    });

    render(<MeetingForms />);
    await screen.findByText("Talk to an Expert");
    fireEvent.click(screen.getByRole("button", { name: "Bookings" }));
    expect(await screen.findByText("Priya Sharma")).toBeInTheDocument();
    expect(screen.getByText("Zoom event zoom-event-123")).toBeInTheDocument();
    expect(screen.getByText("External scheduler")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send via CRM" })).toBeInTheDocument();
    fireEvent.click(screen.getByText("View payload"));
    expect(screen.getByText(/Bengaluru/)).toBeInTheDocument();
  });

  it("provides one animated page-level refresh that reloads every Meeting Form resource", async () => {
    render(<MeetingForms />);
    await screen.findByText("Talk to an Expert");
    fireEvent.click(screen.getByRole("button", { name: "Embed & API" }));

    const regularImplementation = fetchApi.getMockImplementation();
    let resolveForms;
    let deferForms = true;
    fetchApi.mockImplementation((url, options) => {
      if (url === "/api/travel/meeting-forms" && deferForms) {
        deferForms = false;
        return new Promise((resolve) => { resolveForms = resolve; });
      }
      return regularImplementation(url, options);
    });

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    const refreshingButton = await screen.findByRole("button", { name: "Refreshing…" });
    expect(refreshingButton).toBeDisabled();
    expect(refreshingButton.querySelector(".meeting-refresh-spin")).toBeInTheDocument();

    resolveForms([FORM]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled());
    expect(fetchApi).toHaveBeenCalledWith("/api/travel/meeting-forms/hosts");
    expect(fetchApi).toHaveBeenCalledWith("/api/travel/meeting-forms/zoom-config");
    expect(fetchApi).toHaveBeenCalledWith("/api/travel/meeting-forms/7/bookings?page=1&pageSize=10");
    expect(notify.success).toHaveBeenCalledWith("Meeting Form refreshed");
  });

  it("keeps closed weekend scheduling controls in the shared day-row layout", async () => {
    render(<MeetingForms />);
    await screen.findByText("Talk to an Expert");
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));

    expect(screen.getByLabelText("Appointment duration (minutes)")).toHaveValue(30);
    expect(screen.getByLabelText("Time between offered slot starts (minutes)")).toHaveValue(30);

    for (const day of ["saturday", "sunday"]) {
      const button = screen.getByRole("button", { name: `${day} add time window` });
      expect(button.closest(".meeting-schedule-day")).toBeInTheDocument();
    }
  });

  it("offers a searchable Google Font list for iframe rendering only", async () => {
    render(<MeetingForms />);
    await screen.findByText("Talk to an Expert");
    const fontTrigger = screen.getByRole("button", { name: "Embed Google Font" });
    expect(fontTrigger).toHaveTextContent("Poppins");
    fireEvent.click(fontTrigger);
    const fontSearch = screen.getByRole("textbox", { name: "Search Google Fonts" });
    fireEvent.change(fontSearch, { target: { value: "DM" } });
    fireEvent.click(screen.getByRole("option", { name: "DM Sans" }));
    expect(fontTrigger).toHaveTextContent("DM Sans");
    expect(screen.getByText(/hosted iframe only/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Loaded from Google Fonts/i)).toBeInTheDocument();
  });

  it("uses a multi-date blackout calendar and leaves origins to the tenant settings", async () => {
    const { container } = render(<MeetingForms />);
    await screen.findByText("Talk to an Expert");
    expect(screen.queryByText("Allowed website origins")).not.toBeInTheDocument();
    expect(screen.getByText(/CRM Settings.*Embed Allowlist/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous blackout month" })).toBeEnabled();

    const addDate = screen.getAllByRole("button", { name: /Add blackout date/i })[0];
    fireEvent.click(addDate);
    expect(container.querySelectorAll(".meeting-date-chip")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Next blackout month" }));
    fireEvent.click(screen.getAllByRole("button", { name: /Add blackout date/i })[0]);
    expect(container.querySelectorAll(".meeting-date-chip")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Previous blackout month" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous blackout month" }));
    const previousMonthDate = screen.getAllByRole("button", { name: /Add blackout date/i })[0];
    expect(previousMonthDate).toBeEnabled();
    fireEvent.click(previousMonthDate);
    expect(container.querySelectorAll(".meeting-date-chip")).toHaveLength(3);
  });

  it("keeps Travel Meeting Forms Google Calendar-only", async () => {
    render(<MeetingForms />);
    await screen.findByText("Talk to an Expert");
    expect(screen.queryByText("Calendar provider")).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Outlook Calendar" })).not.toBeInTheDocument();
  });

  it("uploads and previews a footer logo beside the shared email template", async () => {
    const saved = { ...FORM, emailLogoUrl: "/api/uploads/travel-meeting-email-logos/tenant-2/form-7/logo.png" };
    const regularImplementation = fetchApi.getMockImplementation();
    fetchApi.mockImplementation((url, options) => {
      if (url === "/api/travel/meeting-forms/7/email-logo" && options?.method === "POST") return Promise.resolve(saved);
      return regularImplementation(url, options);
    });
    const { container } = render(<MeetingForms />);
    await screen.findByText("Talk to an Expert");

    expect(screen.getByText(/Google’s separate fixed-layout invitation email is suppressed/i)).toBeInTheDocument();
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "logo.png", { type: "image/png" });
    fireEvent.change(container.querySelector('input[type="file"]'), { target: { files: [file] } });

    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith(
      "/api/travel/meeting-forms/7/email-logo",
      expect.objectContaining({ method: "POST", body: expect.any(FormData) }),
    ));
    expect(await screen.findByAltText("Current email footer logo")).toHaveAttribute("src", saved.emailLogoUrl);
    expect(notify.success).toHaveBeenCalledWith("Confirmation email logo uploaded");
  });

  it("uses an IANA timezone dropdown with Asia/Kolkata as the default selection", async () => {
    render(<MeetingForms />);
    await screen.findByText("Talk to an Expert");
    const timezone = screen.getByRole("combobox", { name: "Timezone" });
    expect(timezone).toHaveValue("Asia/Kolkata");
    expect(screen.getByRole("option", { name: "Asia/Kolkata — India" })).toBeInTheDocument();
  });

  it("places Save Changes in the top Meeting Form toolbar", async () => {
    render(<MeetingForms />);
    await screen.findByText("Talk to an Expert");
    expect(document.querySelector(".meeting-forms-page")).toHaveStyle({ "--card-bg": "var(--surface-color)" });
    expect(document.querySelector(".meeting-form-surface")).toHaveStyle({ background: "var(--surface-color, #fff)", color: "var(--text-primary, inherit)" });
    const saveButton = screen.getByRole("button", { name: /Save Changes/i });
    expect(saveButton.closest(".meeting-form-toolbar")).toBeInTheDocument();
    expect(saveButton.closest(".meeting-form-actions")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Meeting form · 1 saved/i }));
    expect(screen.getByRole("button", { name: "Delete Talk to an Expert" }).closest("#meeting-form-list")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Create Zoom meeting" }).closest(".meeting-form-actions")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Active/published" }).closest(".meeting-form-actions")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Save Changes/i })).toHaveLength(1);
    for (const tab of ["Schedule", "Fields", "Embed & API", "Bookings", "Zoom Setup"]) {
      fireEvent.click(screen.getByRole("button", { name: tab }));
      expect(screen.getAllByRole("button", { name: /Save Changes/i })).toHaveLength(1);
    }
  });

  it("offers draggable email fields and inserts them at the body cursor without typing template syntax", async () => {
    render(<MeetingForms />);
    await screen.findByText("Talk to an Expert");
    const body = screen.getByRole("textbox", { name: "Confirmation email body" });
    fireEvent.change(body, { target: { value: "Hello " } });
    body.setSelectionRange(6, 6);

    const meetingLink = screen.getByRole("button", { name: "Insert Meeting link" });
    expect(meetingLink).toHaveAttribute("draggable", "true");
    expect(meetingLink).toHaveAttribute("title", expect.stringContaining("clickable link"));
    expect(screen.getByRole("button", { name: "Insert Meeting button" })).toHaveAttribute("title", expect.stringContaining("opens the meeting URL"));
    expect(screen.getByText((_content, element) => element.tagName === "SMALL" && element.textContent.includes("School / Institution is the value entered by the visitor"))).toBeInTheDocument();
    expect(document.querySelector(".meeting-email-settings")).toHaveStyle({ alignItems: "start" });
    expect(screen.getByRole("status", { name: "Email delivery provider" })).toHaveTextContent("Using CRM-managed SendGrid email");
    fireEvent.click(meetingLink);

    await waitFor(() => expect(body).toHaveValue("Hello {{meeting_url}}"));
    fireEvent.click(screen.getByRole("button", { name: /Save Changes/i }));
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith(
      "/api/travel/meeting-forms/7",
      expect.objectContaining({ method: "PUT", body: expect.stringContaining('"emailBody":"Hello {{meeting_url}}"') }),
    ));
  });

  it("adds and removes confirmation email CC recipients without a fixed limit", async () => {
    render(<MeetingForms />);
    await screen.findByText("Talk to an Expert");
    expect(screen.queryByLabelText("CC email 1")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "+ Add CC recipient" }));
    fireEvent.click(screen.getByRole("button", { name: "+ Add CC recipient" }));
    expect(screen.getAllByRole("textbox", { name: /^CC email \d/ })).toHaveLength(2);
    fireEvent.change(screen.getByRole("textbox", { name: "CC email 1" }), { target: { value: "principal@school.edu" } });
    fireEvent.change(screen.getByRole("textbox", { name: "CC email 2" }), { target: { value: "coordinator@school.edu" } });
    fireEvent.click(screen.getByRole("button", { name: /Save Changes/i }));
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith(
      "/api/travel/meeting-forms/7",
      expect.objectContaining({ method: "PUT", body: expect.stringContaining('"emailCc":["principal@school.edu","coordinator@school.edu"') }),
    ));
  });

  it("adds a CC recipient from the Travel CRM staff list", async () => {
    render(<MeetingForms />);
    await screen.findByText("Talk to an Expert");
    const staffSelector = screen.getByRole("combobox", { name: "Add CC from staff list" });
    fireEvent.mouseDown(staffSelector);
    const staffList = await screen.findByRole("listbox", { name: "Add CC from staff list" });
    fireEvent.click(within(staffList).getByRole("option", { name: /TMC Host.*host@tmc\.test/i }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "CC email 1" })).toHaveValue("host@tmc.test"));
    fireEvent.mouseDown(screen.getByRole("combobox", { name: "Add CC from staff list" }));
    const reopenedStaffList = await screen.findByRole("listbox", { name: "Add CC from staff list" });
    expect(within(reopenedStaffList).getByRole("option", { name: /TMC Host.*host@tmc\.test/i })).toBeDisabled();
  });

  it("shows customer-managed delivery when tenant SendGrid BYOK is active", async () => {
    const regularImplementation = fetchApi.getMockImplementation();
    fetchApi.mockImplementation((url, options) => {
      if (url === "/api/travel/email-provider") return Promise.resolve({ configured: true, source: "tenant" });
      return regularImplementation(url, options);
    });

    render(<MeetingForms />);
    expect(await screen.findByRole("status", { name: "Email delivery provider" })).toHaveTextContent("Using customer-managed SendGrid email");
  });

  it("shows an inline error and blocks saving an invalid date range", async () => {
    render(<MeetingForms />);
    await screen.findByText("Talk to an Expert");

    fireEvent.change(screen.getByLabelText("Start date (optional)"), { target: { value: "2099-02-10" } });
    fireEvent.change(screen.getByLabelText("End date (optional)"), { target: { value: "2099-02-09" } });

    expect(screen.getByRole("alert")).toHaveTextContent("End date cannot be earlier than start date.");
    expect(screen.getByLabelText("End date (optional)")).toHaveAttribute("aria-invalid", "true");
    fireEvent.click(screen.getByRole("button", { name: /Save Changes/i }));

    expect(notify.error).toHaveBeenCalledWith("End date cannot be earlier than start date.");
    expect(fetchApi).not.toHaveBeenCalledWith("/api/travel/meeting-forms/7", expect.anything());
  });

  it("blocks an end date that is already in the past", async () => {
    render(<MeetingForms />);
    await screen.findByText("Talk to an Expert");

    fireEvent.change(screen.getByLabelText("End date (optional)"), { target: { value: "2000-01-01" } });

    expect(screen.getByRole("alert")).toHaveTextContent("End date cannot be earlier than today.");
    fireEvent.click(screen.getByRole("button", { name: /Save Changes/i }));
    expect(notify.error).toHaveBeenCalledWith("End date cannot be earlier than today.");
  });

  it("places Zoom Setup after Bookings as the final tab", async () => {
    render(<MeetingForms />);
    await screen.findByText("Talk to an Expert");
    const toolbar = document.querySelector(".meeting-form-toolbar");
    const tabs = [...toolbar.querySelectorAll("button")].map((button) => button.textContent.trim());
    expect(tabs.indexOf("Zoom Setup")).toBeGreaterThan(tabs.indexOf("Bookings"));
  });

  it("deletes a saved Meeting Form with no booking history after confirmation", async () => {
    const unusedForm = { ...FORM, id: 12, name: "Unused Form", publicKey: "tmcmf_unused", _count: { bookings: 0 } };
    const regularImplementation = fetchApi.getMockImplementation();
    fetchApi.mockImplementation((url, options) => {
      if (url === "/api/travel/meeting-forms" && !options) return Promise.resolve([unusedForm]);
      if (url.startsWith("/api/travel/meeting-forms/12/bookings?")) return Promise.resolve({ items: [], total: 0, page: 1, pageSize: 10, totalPages: 1 });
      if (url === "/api/travel/meeting-forms/12" && options?.method === "DELETE") return Promise.resolve({ success: true, id: 12 });
      return regularImplementation(url, options);
    });

    render(<MeetingForms />);
    await screen.findByText("Unused Form");
    fireEvent.click(screen.getByRole("button", { name: /Meeting form · 1 saved/i }));
    fireEvent.click(screen.getByRole("button", { name: "Delete Unused Form" }));

    expect(await screen.findByRole("dialog", { name: "Delete Meeting Form?" })).toBeInTheDocument();
    expect(screen.getByText(/public embed and API URLs will stop working/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete Meeting Form" }));

    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith("/api/travel/meeting-forms/12", { method: "DELETE" }));
    expect(notify.success).toHaveBeenCalledWith("Meeting Form deleted");
    expect(await screen.findByRole("heading", { name: "New Meeting Form settings" })).toBeInTheDocument();
  });

  it("protects Meeting Forms that have booking history from deletion", async () => {
    render(<MeetingForms />);
    await screen.findByText("Talk to an Expert");
    fireEvent.click(screen.getByRole("button", { name: /Meeting form · 1 saved/i }));
    fireEvent.click(screen.getByRole("button", { name: "Delete Talk to an Expert" }));

    expect(await screen.findByRole("dialog", { name: "Meeting Form cannot be deleted" })).toBeInTheDocument();
    expect(screen.getByText(/booking history is protected/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm delete Meeting Form" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("provides a row-based option builder and blocks an enabled Select with no options", async () => {
    render(<MeetingForms />);
    await screen.findByText("Talk to an Expert");
    fireEvent.click(screen.getByRole("button", { name: "Fields" }));
    fireEvent.click(screen.getByRole("button", { name: /Add field/i }));

    fireEvent.change(screen.getByLabelText(/custom_\d+ type/), { target: { value: "select" } });
    expect(screen.getByLabelText("Custom field option 1")).toHaveValue("Option 1");
    expect(screen.getByLabelText("Custom field option 2")).toHaveValue("Option 2");

    fireEvent.click(screen.getByRole("button", { name: /Add option/i }));
    expect(screen.getByLabelText("Custom field option 3")).toHaveValue("Option 3");

    for (let count = 0; count < 3; count += 1) {
      fireEvent.click(screen.getByRole("button", { name: "Remove Custom field option 1" }));
    }
    fireEvent.click(screen.getByRole("button", { name: /Save Changes/i }));

    expect(notify.error).toHaveBeenCalledWith("Add at least one option to “Custom field”.");
    expect(fetchApi).not.toHaveBeenCalledWith("/api/travel/meeting-forms/7", expect.anything());
  });

  it("upgrades a legacy Designation text field to the required dropdown", async () => {
    fetchApi.mockImplementation((url) => {
      if (url === "/api/travel/meeting-forms") return Promise.resolve([{ ...FORM, fields: [{ key: "designation", label: "Designation", type: "text", required: true, enabled: true, order: 2 }] }]);
      if (url.startsWith("/api/travel/meeting-forms/7/bookings?")) return Promise.resolve({ items: [], total: 0, page: 1, pageSize: 10, totalPages: 1 });
      if (url === "/api/travel/meeting-forms/hosts") return Promise.resolve([{ id: 3, name: "TMC Host", email: "host@tmc.test", calendarIntegrations: [{ provider: "google" }] }]);
      if (url === "/api/travel/meeting-forms/zoom-config") return Promise.resolve({ configured: true });
      if (url === "/api/travel/email-provider") return Promise.resolve({ configured: false, source: "backend" });
      return Promise.resolve({});
    });

    render(<MeetingForms />);
    await screen.findByText("Talk to an Expert");
    fireEvent.click(screen.getByRole("button", { name: "Fields" }));

    expect(screen.getByLabelText("designation type")).toHaveValue("select");
    expect(screen.getByLabelText("designation type")).toBeDisabled();
    expect(screen.getByLabelText("Designation option 1")).toHaveValue("Principal");
    expect(screen.getByLabelText("Designation option 7")).toHaveValue("Other");
  });

  it("shows only masked tenant Zoom credentials inside Meeting Forms", async () => {
    render(<MeetingForms />);
    await screen.findByText("Talk to an Expert");
    fireEvent.click(screen.getByRole("button", { name: "Zoom Setup" }));
    expect(await screen.findByText(/Account \*\*\*\*1234/)).toBeInTheDocument();
    expect(screen.getByText(/Client \*\*\*\*abcd/)).toBeInTheDocument();
    expect(screen.getByLabelText("Zoom Client Secret")).toHaveValue("");
    expect(screen.queryByDisplayValue(/secret/i)).not.toBeInTheDocument();
  });

  it("uses a non-blocking CRM popover before deleting Zoom credentials", async () => {
    render(<MeetingForms />);
    await screen.findByText("Talk to an Expert");
    fireEvent.click(screen.getByRole("button", { name: "Zoom Setup" }));
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    const popup = await screen.findByRole("dialog", { name: "Disconnect Zoom?" });
    expect(popup).toHaveAttribute("aria-modal", "true");
    expect(popup.closest(".meeting-disconnect-overlay")).toBe(document.body.lastElementChild);
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Zoom" }));
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith("/api/travel/meeting-forms/zoom-config/disconnect", { method: "POST" }));
  });
});
