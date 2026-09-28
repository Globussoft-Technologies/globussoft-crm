import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

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
  embedFontFamily: "Poppins",
  emailSubject: "Your Conversation with TMC is Confirmed",
  emailBody: "Hi {{name}},\n\nJoin here: {{meeting_url}}",
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
    if (url === "/api/travel/meeting-forms/7/bookings") return Promise.resolve([{ id: 11, contactName: "Teacher", contactEmail: "teacher@school.test", scheduledAt: "2099-01-01T10:00:00Z", status: "CONFIRMED", emailStatus: "SENT", meetingUrl: "https://zoom.us/j/teacher" }]);
    return Promise.resolve({});
  });
});

describe("MeetingForms", () => {
  it("loads Travel CRM meeting forms and exposes the shared embed/API contract", async () => {
    render(<MeetingForms />);
    expect(await screen.findByText("Talk to an Expert")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Embed & API" }));
    expect(await screen.findByText("API endpoints")).toBeInTheDocument();
    expect(screen.getAllByDisplayValue(/\/embed\/meeting-form\.html\?form=tmcmf_/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByDisplayValue(/&font=Poppins/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/\/availability\?start=YYYY-MM-DD/)).toBeInTheDocument();
    expect(screen.getByText(/No API key is required/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Rotate API key/i })).not.toBeInTheDocument();
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
    const table = screen.getByRole("table");
    expect(table).toHaveStyle({ tableLayout: "fixed", width: "100%" });
    expect(table.style.minWidth).toBe("");
    expect(table.closest("section").style.overflowX).toBe("");
    expect(container.querySelector('td[data-label="When"]').textContent).not.toMatch(/\d{1,2}:\d{2}:\d{2}/);
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith("/api/travel/meeting-forms/7/bookings"));
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
    expect(fetchApi).toHaveBeenCalledWith("/api/travel/meeting-forms/7/bookings");
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

    const addDate = screen.getAllByRole("button", { name: /Add blackout date/i })[0];
    fireEvent.click(addDate);
    expect(container.querySelectorAll(".meeting-date-chip")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Next blackout month" }));
    fireEvent.click(screen.getAllByRole("button", { name: /Add blackout date/i })[0]);
    expect(container.querySelectorAll(".meeting-date-chip")).toHaveLength(2);
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
    const saveButton = screen.getByRole("button", { name: /Save Changes/i });
    expect(saveButton.closest(".meeting-form-toolbar")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Create Zoom meeting" }).closest(".meeting-form-actions")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Active/published" }).closest(".meeting-form-actions")).toBeInTheDocument();
  });

  it("places Zoom Setup after Bookings as the final tab", async () => {
    render(<MeetingForms />);
    await screen.findByText("Talk to an Expert");
    const toolbar = document.querySelector(".meeting-form-toolbar");
    const tabs = [...toolbar.querySelectorAll("button")].map((button) => button.textContent.trim());
    expect(tabs.indexOf("Zoom Setup")).toBeGreaterThan(tabs.indexOf("Bookings"));
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
    expect(popup).toHaveAttribute("aria-modal", "false");
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Zoom" }));
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith("/api/travel/meeting-forms/zoom-config/disconnect", { method: "POST" }));
  });
});
