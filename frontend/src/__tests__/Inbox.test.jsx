import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AuthContext } from "../App";

const fetchApiMock = vi.fn();
vi.mock("../utils/api", () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

const notifyError = vi.fn();
const notifySuccess = vi.fn();
vi.mock("../utils/notify", () => ({
  useNotify: () => ({
    error: notifyError,
    info: vi.fn(),
    success: notifySuccess,
    confirm: () => Promise.resolve(true),
    prompt: () => Promise.resolve(""),
  }),
  NotifyProvider: ({ children }) => children,
}));

import Inbox from "../pages/Inbox";

const sampleSentEmail = {
  id: 100,
  from: "me@globussoft.com",
  to: "client@x.com",
  subject: "sample sent",
  body: "hello there",
  direction: "OUTBOUND",
  read: true,
  createdAt: new Date().toISOString(),
};

const sampleInboxEmail = {
  id: 101,
  from: "client@x.com",
  to: "me@globussoft.com",
  subject: "client itinerary update",
  body: "Please confirm the revised itinerary.",
  direction: "INBOUND",
  read: false,
  createdAt: new Date(Date.now() - 60_000).toISOString(),
};

const sampleLinkedEmail = {
  id: 102,
  from: "shiksha@blondmail.com",
  to: "konica@getairmail.com",
  subject: "Meeting invitation - 2026-08-01 at 14:00",
  body: "Hello,\n\nJoin the meeting here: https://meet.google.com/pfk-ghvu-ubk\n\nThank you.",
  direction: "INBOUND",
  read: false,
  createdAt: new Date(Date.now() - 120_000).toISOString(),
};

const sampleContact = {
  id: "c1",
  name: "Rishu Goyal",
  email: "rishu@x.in",
  phone: "+919876543210",
};

const sampleContactTwo = {
  id: "c2",
  name: "Muralidhar",
  email: "muralidhar@travelstall.in",
};

const samplePatient = {
  id: "p1",
  name: "Konica Sharma",
  email: "konica@getairmail.com",
};

const sampleStaffMembers = [
  {
    id: "staff-1",
    name: "Travel Telecaller",
    email: "telecaller@travelstall.demo",
    role: "USER",
    deactivatedAt: null,
  },
  {
    id: "staff-2",
    name: "RFU Advisor",
    email: "rfu-advisor@travelstall.demo",
    role: "MANAGER",
    deactivatedAt: null,
  },
  {
    id: "staff-3",
    name: "Former Staff",
    email: "former@travelstall.demo",
    role: "USER",
    deactivatedAt: "2026-07-01T00:00:00.000Z",
  },
];

const adminUser = {
  id: "admin-1",
  userId: "admin-1",
  name: "Yasin (Owner)",
  email: "yasin@travelstall.in",
  role: "ADMIN",
};

function defaultFetch(url, opts) {
  if (!opts || !opts.method || opts.method === "GET") {
    if (url === "/api/communications/inbox" || url.startsWith("/api/communications/inbox?")) {
      if (url.includes("folder=sent")) return Promise.resolve([sampleSentEmail]);
      if (url.includes("folder=inbox")) return Promise.resolve([sampleInboxEmail]);
      if (url.includes("folder=all")) return Promise.resolve([sampleSentEmail, sampleInboxEmail]);
      return Promise.resolve([sampleSentEmail, sampleInboxEmail]);
    }
    if (url === "/api/contacts") return Promise.resolve([sampleContact, sampleContactTwo]);
    if (url === "/api/wellness/patients") return Promise.resolve({ patients: [samplePatient] });
    if (url === "/api/staff?fields=summary") return Promise.resolve(sampleStaffMembers);
  }
  if (opts?.method === "POST" && url === "/api/ai/subject-lines") {
    return Promise.resolve({
      subjects: [
        "Travel itinerary ready",
        "Quick follow-up for your trip",
        "Next steps for your booking",
      ],
    });
  }
  if (opts?.method === "POST" && url === "/api/ai/draft") {
    return Promise.resolve({
      draft: "Hello Konica,\n\nThanks for the update. I have shared the revised itinerary below.\n\nBest regards,\nTravel Stall",
    });
  }
  if (opts?.method === "POST" && url === "/api/communications/send-email") {
    return Promise.resolve({ success: true, delivered: true, email: { id: 999 } });
  }
  if (opts?.method === "POST" && url === "/api/calendar/google/events") {
    return Promise.resolve({ id: "cal-1" });
  }
  if (opts?.method === "POST" && url === "/api/calendar/outlook/events") {
    return Promise.resolve({ id: "cal-2" });
  }
  if (opts?.method === "POST" && url === "/api/notifications") {
    return Promise.resolve({
      success: true,
      notification: {
        id: 1000,
      },
    });
  }
  if (opts?.method === "POST" && url === "/api/contacts/c1/activities") {
    return Promise.resolve({ success: true });
  }
  return Promise.resolve([]);
}

function renderInbox({ user = adminUser } = {}) {
  return render(
    <AuthContext.Provider value={{ user }}>
      <Inbox />
    </AuthContext.Provider>,
  );
}

function formatLocalDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatLocalTimeKey(date) {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function setNativeInputValue(input, value) {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  descriptor?.set?.call(input, value);
  fireEvent.input(input, { target: { value } });
  fireEvent.change(input, { target: { value } });
}

describe("<Inbox />", () => {
  let previousTheme;

  beforeEach(() => {
    previousTheme = document.documentElement.getAttribute("data-theme");
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifySuccess.mockReset();
    fetchApiMock.mockImplementation(defaultFetch);
  });

  afterEach(() => {
    if (previousTheme == null) document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", previousTheme);
  });

  it("removes the nonfunctional call, SMS, and WhatsApp affordances from the inbox UI", async () => {
    renderInbox();

    await waitFor(() => expect(screen.getByText("Compose Email")).toBeInTheDocument());

    expect(screen.getByText(/Manage all client emails from one hub/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /call dialer/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /compose sms/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /compose whatsapp/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /call logs/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /^sms$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /whatsapp/i })).not.toBeInTheDocument();
  });

  it("uses the same page shell spacing as the other CRM pages", async () => {
    renderInbox();

    const shell = await screen.findByTestId("inbox-page-shell");
    expect(shell).toHaveStyle({
      padding: "2rem",
      maxWidth: "1480px",
      margin: "0 auto",
    });

    const listCard = screen.getByTestId("inbox-list-card");
    expect(listCard).toHaveStyle({
      width: "100%",
      flex: "0 0 auto",
    });
  });

  it("opens the restored composer with autocomplete, Cc/Bcc, and theme-aware modal surfaces", async () => {
    document.documentElement.setAttribute("data-theme", "dark");
    const user = userEvent.setup();
    renderInbox();

    await waitFor(() => expect(screen.getByText("Compose Email")).toBeInTheDocument());
    await user.click(screen.getByText("Compose Email"));

    const heading = await screen.findByRole("heading", { name: /new message/i });
    const modal = heading.closest(".card.modal");
    expect(modal).toHaveStyle({ background: "var(--modal-bg)", color: "var(--text-primary)" });

    const toggle = screen.getByRole("button", { name: /cc \/ bcc/i });
    expect(screen.queryByLabelText(/^Cc:$/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Bcc:$/)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^Subject:$/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Following up")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Professional")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /ai draft/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /subjects/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send email/i })).toBeInTheDocument();

    const toInput = screen.getByPlaceholderText(/client@company.com/i);
    await user.type(toInput, "rishu");
    const suggestion = await screen.findByRole("option", { name: "rishu@x.in" });
    expect(suggestion).toHaveTextContent("Rishu Goyal");
    await user.click(suggestion);
    expect(toInput).toHaveValue("rishu@x.in");

    await user.click(toggle);
    expect(screen.getByLabelText(/^Cc:$/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Bcc:$/)).toBeInTheDocument();
  });

  it("sends the typed subject through /api/communications/send-email", async () => {
    const user = userEvent.setup();
    renderInbox();

    await waitFor(() => expect(screen.getByText("Compose Email")).toBeInTheDocument());
    await user.click(screen.getByText("Compose Email"));

    await user.type(screen.getByPlaceholderText(/client@company.com/i), "primary@x.com");
    await user.click(screen.getByRole("button", { name: /cc \/ bcc/i }));
    await user.type(screen.getByLabelText(/^Cc:$/), "cc1@x.com, cc2@x.com");
    await user.type(screen.getByLabelText(/^Bcc:$/), "bcc@x.com");
    await user.type(screen.getByLabelText(/^Subject:$/), "subject-here");
    await user.type(screen.getByPlaceholderText(/write your email here/i), "body-here");

    await user.click(screen.getByRole("button", { name: /send email/i }));

    await waitFor(() => {
      const sendCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === "/api/communications/send-email" && opts?.method === "POST",
      );
      expect(sendCall).toBeTruthy();
      const sentBody = JSON.parse(sendCall[1].body);
      expect(sentBody.to).toBe("primary@x.com");
      expect(sentBody.cc).toBe("cc1@x.com, cc2@x.com");
      expect(sentBody.bcc).toBe("bcc@x.com");
      expect(sentBody.subject).toBe("subject-here");
      expect(sentBody.body).toBe("body-here");
    });
  }, 15_000);

  it("loads subject ideas and sends the restored AI draft flow with the selected subject", async () => {
    const user = userEvent.setup();
    renderInbox();

    await waitFor(() => expect(screen.getByText("Compose Email")).toBeInTheDocument());
    await user.click(screen.getByText("Compose Email"));

    const toInput = screen.getByPlaceholderText(/client@company.com/i);
    await user.type(toInput, "primary@x.com");
    await user.click(screen.getByRole("button", { name: /cc \/ bcc/i }));
    await user.type(screen.getByLabelText(/^Cc:$/), "cc1@x.com");
    await user.type(screen.getByLabelText(/^Bcc:$/), "bcc@x.com");
    await user.type(screen.getByPlaceholderText(/write your email here/i), "Draft me");
    await user.click(screen.getByRole("button", { name: /subjects/i }));

    expect(await screen.findByText("Subject ideas")).toBeInTheDocument();
    const subjectButton = await screen.findByRole("button", { name: "Travel itinerary ready" });
    await user.click(subjectButton);
    expect(screen.getByLabelText(/^Subject:$/)).toHaveValue("Travel itinerary ready");

    await user.click(screen.getByRole("button", { name: /ai draft/i }));
    await waitFor(() => {
      expect(
        fetchApiMock.mock.calls.some(
          ([url, opts]) => url === "/api/ai/draft" && opts?.method === "POST",
        ),
      ).toBe(true);
    });

    await waitFor(() =>
      expect(screen.getByPlaceholderText(/write your email here/i)).toHaveDisplayValue(
        /revised itinerary/i,
      ),
    );

    await user.click(screen.getByRole("button", { name: /send email/i }));

    await waitFor(() => {
      const sendCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === "/api/communications/send-email" && opts?.method === "POST",
      );
      expect(sendCall).toBeTruthy();
      const sentBody = JSON.parse(sendCall[1].body);
      expect(sentBody.to).toBe("primary@x.com");
      expect(sentBody.cc).toBe("cc1@x.com");
      expect(sentBody.bcc).toBe("bcc@x.com");
      expect(sentBody.subject).toBe("Travel itinerary ready");
      expect(sentBody.body).toMatch(/revised itinerary/);
    });
  }, 15_000);

  it("keeps Cc/Bcc collapsed until the toggle is clicked", async () => {
    const user = userEvent.setup();
    renderInbox();

    await waitFor(() => expect(screen.getByText("Compose Email")).toBeInTheDocument());
    await user.click(screen.getByText("Compose Email"));

    const toggle = await screen.findByRole("button", { name: /cc \/ bcc/i });
    expect(toggle).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Cc:$/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Bcc:$/)).not.toBeInTheDocument();

    await user.click(toggle);

    expect(screen.getByLabelText(/^Cc:$/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Bcc:$/)).toBeInTheDocument();
  });

  it('renders "All / Inbox / Sent" and switches backend folder filters', async () => {
    const user = userEvent.setup();
    renderInbox();

    await waitFor(() => expect(screen.getByRole("tab", { name: "All" })).toBeInTheDocument());
    expect(screen.getByRole("tab", { name: "Inbox" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Sent" })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Sent" }));
    await waitFor(() => {
      const sentFetch = fetchApiMock.mock.calls.find(
        ([url]) => typeof url === "string" && url === "/api/communications/inbox?folder=sent",
      );
      expect(sentFetch).toBeTruthy();
    });

    await user.click(screen.getByRole("tab", { name: "Inbox" }));
    await waitFor(() => {
      const inboxFetch = fetchApiMock.mock.calls.find(
        ([url]) => typeof url === "string" && url === "/api/communications/inbox?folder=inbox",
      );
      expect(inboxFetch).toBeTruthy();
    });
  });

  it("shows theme-aware surfaces for the email list", async () => {
    document.documentElement.setAttribute("data-theme", "dark");

    renderInbox();
    await waitFor(() => expect(screen.getByRole("tablist", { name: /Email folder/i })).toBeInTheDocument());

    const folderTabs = screen.getByRole("tablist", { name: /Email folder/i });
    expect(folderTabs).toHaveStyle({ background: "var(--subtle-bg-2)" });

    const readRow = screen.getByText("sample sent").closest(".table-row-hover");
    expect(readRow).toHaveStyle({ background: "var(--subtle-bg-4)" });
    expect(readRow.style.background).not.toContain("rgba(0,0,0,0.2)");

    const unreadRow = screen.getByText("client itinerary update").closest(".table-row-hover");
    expect(unreadRow).toHaveStyle({ background: "var(--subtle-bg-3)" });
    expect(unreadRow.style.background).not.toContain("rgba(59, 130, 246, 0.05)");
  });

  it("uses the modal background token for the email detail dialog", async () => {
    const user = userEvent.setup();
    renderInbox();

    await waitFor(() => expect(screen.getByText("sample sent")).toBeInTheDocument());
    await user.click(screen.getByText("sample sent"));

    const emailHeading = await screen.findByRole("heading", { name: /^Email$/i });
    const modal = emailHeading.closest(".card.modal");
    expect(modal).toBeTruthy();
    expect(modal).toHaveStyle({ background: "var(--modal-bg)" });
    expect(modal).toHaveStyle({ color: "var(--text-primary)" });
  });

  it("linkifies URLs in the email detail modal body", async () => {
    const user = userEvent.setup();
    fetchApiMock.mockImplementation((url, opts) => {
      if (!opts || !opts.method || opts.method === "GET") {
        if (url === "/api/communications/inbox" || url.startsWith("/api/communications/inbox?")) {
          return Promise.resolve([sampleLinkedEmail]);
        }
        if (url === "/api/contacts") return Promise.resolve([sampleContact]);
        if (url === "/api/wellness/patients") return Promise.resolve({ patients: [] });
      }
      return Promise.resolve([]);
    });

    renderInbox();
    await waitFor(() => expect(screen.getByText(/Meeting invitation/i)).toBeInTheDocument());

    await user.click(screen.getByText(/Meeting invitation/i));

    const link = await screen.findByRole("link", { name: "https://meet.google.com/pfk-ghvu-ubk" });
    expect(link).toHaveAttribute("href", "https://meet.google.com/pfk-ghvu-ubk");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("submitting Schedule Meeting logs an activity for the selected contact", async () => {
    const user = userEvent.setup();
    renderInbox();

    await waitFor(() => expect(screen.getByRole("button", { name: /schedule meeting/i })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /schedule meeting/i }));

    expect(await screen.findByRole("heading", { name: /Schedule Meeting/i })).toBeInTheDocument();
    expect(screen.getByText("Select Contact:")).toBeInTheDocument();
    expect(screen.getByText("Meeting Date:")).toBeInTheDocument();
    expect(screen.getByText("Meeting Time:")).toBeInTheDocument();
    expect(screen.getByText("Meeting Agenda & Conferencing Links:")).toBeInTheDocument();
    expect(screen.getByText(/Assign Staff Members:/i)).toBeInTheDocument();
    expect(screen.getByText(/Selected staff will receive the invite/i)).toBeInTheDocument();

    const contactSelect = screen.getByRole("combobox");
    await user.selectOptions(contactSelect, "c1");

    const staffPicker = screen.getByRole("button", { name: /no staff selected/i });
    await user.click(staffPicker);
    await user.click(await screen.findByLabelText(/Travel Telecaller/i));
    await user.click(screen.getByLabelText(/RFU Advisor/i));
    expect(screen.getByRole("button", { name: /2 selected/i })).toBeInTheDocument();

    const dateInput = document.querySelector('input[type="date"]');
    const timeInput = document.querySelector('input[type="time"]');
    expect(dateInput).toBeTruthy();
    expect(timeInput).toBeTruthy();

    const datePicker = vi.fn();
    const timePicker = vi.fn();
    Object.defineProperty(dateInput, "showPicker", { value: datePicker, configurable: true });
    Object.defineProperty(timeInput, "showPicker", { value: timePicker, configurable: true });

    await user.click(dateInput);
    await user.click(timeInput);
    expect(datePicker).toHaveBeenCalled();
    expect(timePicker).toHaveBeenCalled();
    expect(fireEvent.keyDown(dateInput, { key: "1", code: "Digit1" })).toBe(false);
    expect(fireEvent.keyDown(timeInput, { key: "1", code: "Digit1" })).toBe(false);

    const start = new Date(Date.now() + 24 * 60 * 60 * 1000);
    setNativeInputValue(dateInput, formatLocalDateKey(start));
    setNativeInputValue(timeInput, formatLocalTimeKey(start));
    expect(dateInput).toHaveValue(formatLocalDateKey(start));
    expect(timeInput).toHaveValue(formatLocalTimeKey(start));
    await user.type(screen.getByPlaceholderText(/Zoom\/Google Meet links/i), "product demo agenda");

    await user.click(screen.getByRole("button", { name: /send invites/i }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => typeof url === "string" && url === "/api/contacts/c1/activities" && opts?.method === "POST",
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body.type).toBe("Meeting");
      expect(body.description).toMatch(/product demo agenda/);
      expect(body.description).toMatch(/Assigned staff: Travel Telecaller, RFU Advisor\./);

      const calendarCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === "/api/calendar/google/events" && opts?.method === "POST",
      );
      expect(calendarCall).toBeTruthy();
      const calendarBody = JSON.parse(calendarCall[1].body);
      expect(calendarBody.title).toBe("Meeting with Rishu Goyal");
      expect(calendarBody.attendees).toEqual(
        expect.arrayContaining([sampleContact.email, "telecaller@travelstall.demo", "rfu-advisor@travelstall.demo"]),
      );

      const contactEmailCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === "/api/communications/send-email" && opts?.method === "POST" && JSON.parse(opts.body).to === sampleContact.email,
      );
      expect(contactEmailCall).toBeTruthy();

      const staffEmailCall = fetchApiMock.mock.calls.find(
        ([url, opts]) =>
          url === "/api/communications/send-email" &&
          opts?.method === "POST" &&
          JSON.parse(opts.body).to === "telecaller@travelstall.demo, rfu-advisor@travelstall.demo",
      );
      expect(staffEmailCall).toBeTruthy();

      const notificationCalls = fetchApiMock.mock.calls.filter(
        ([url, opts]) => url === "/api/notifications" && opts?.method === "POST",
      );
      expect(notificationCalls).toHaveLength(2);
      expect(
        notificationCalls.map(([, opts]) => JSON.parse(opts.body).targetUserId).sort(),
      ).toEqual(["staff-1", "staff-2"]);
    });
  }, 15_000);

  it("blocks meetings scheduled in the past", async () => {
    const user = userEvent.setup();
    renderInbox();

    await waitFor(() => expect(screen.getByRole("button", { name: /schedule meeting/i })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /schedule meeting/i }));

    await user.selectOptions(screen.getByRole("combobox"), "c1");
    await user.type(screen.getByPlaceholderText(/Zoom\/Google Meet links/i), "past agenda");

    const past = new Date(Date.now() - 60 * 60 * 1000);
    const dateInput = document.querySelector('input[type="date"]');
    const timeInput = document.querySelector('input[type="time"]');
    setNativeInputValue(dateInput, formatLocalDateKey(past));
    setNativeInputValue(timeInput, formatLocalTimeKey(past));
    expect(dateInput).toHaveValue(formatLocalDateKey(past));
    expect(timeInput).toHaveValue(formatLocalTimeKey(past));
    dateInput.removeAttribute("min");
    timeInput.removeAttribute("min");

    await user.click(screen.getByRole("button", { name: /send invites/i }));

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith("Meeting start time must be now or in the future.");
      expect(
        fetchApiMock.mock.calls.some(
          ([url, opts]) => typeof url === "string" && url.includes("/activities") && opts?.method === "POST",
        ),
      ).toBe(false);
      expect(
        fetchApiMock.mock.calls.some(
          ([url, opts]) => typeof url === "string" && url.includes("/api/calendar/") && opts?.method === "POST",
        ),
      ).toBe(false);
    });
  }, 15_000);
});
