/**
 * ContactsDetail.jsx — contact-centric detail page (NOT to be confused with
 * ContactDetail.jsx). This file renders the alternate route's drilldown
 * view: a single card with the avatar, name+title+company subtitle, status
 * pill, four meta tiles (email / phone / company / createdAt), and an
 * "Interaction History" section with a Log-activity form + activity list.
 *
 * SUT contract pinned (read-only — there are NO edit/save/delete handlers
 * on this page; the dispatcher's prompt-premise that this page "likely has
 * edit/save/delete handlers" was wrong — verified by reading
 * `frontend/src/pages/ContactsDetail.jsx:1-157` end-to-end).
 *
 * Endpoints consumed:
 *   - GET  /api/contacts/:id              -> contact + nested activities
 *   - POST /api/contacts/:id/activities   -> log a new activity (re-fetches)
 *
 * Contracts pinned:
 *   1. Loading copy renders before the contact GET resolves.
 *   2. "Contact Not Found" empty state + Return-to-Contacts button render
 *      when the GET resolves with `null` (or the catch path runs).
 *   3. Header renders contact name + title-at-company subtitle.
 *   4. Title-at-company subtitle falls back to "Unknown Title at Unknown
 *      Company" when both fields are missing (the SUT does NOT guard the
 *      orphan-preposition like ContactDetail does — this is current
 *      behavior, pinned as-is).
 *   5. Status pill renders contact.status verbatim.
 *   6. Email, phone, company, createdAt tiles render their respective
 *      values; missing phone/company show "Not Provided".
 *   7. Missing createdAt falls back to "Unknown".
 *   8. Empty activities shows the "No recent interactions logged…" copy.
 *   9. Each activity row renders type label + description.
 *  10. Submitting the activity form POSTs to /activities with the typed
 *      payload and re-fetches the contact.
 *  11. Activity-form POST failure surfaces a notify.error toast and does
 *      NOT crash the page.
 *  12. Clicking "Back to Directory" navigates to /contacts via useNavigate.
 *  13. Clicking the not-found "Return to Contacts" button navigates to
 *      /contacts.
 *
 * Mock stability: fetchApi is a stable vi.fn() reference; per-test setup
 * resets and re-implements via mockImplementation so the URL dispatcher
 * can swap branches. notify mock is a stable object reference (the
 * CLAUDE.md feedback rule against per-render object recreation).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";

const fetchApiMock = vi.fn();
vi.mock("../utils/api", () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => "test-token",
}));

const notifyObj = {
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  confirm: vi.fn(() => Promise.resolve(true)),
};
vi.mock("../utils/notify", () => ({
  useNotify: () => notifyObj,
}));

const navigateMock = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

import ContactsDetail from "../pages/ContactsDetail";

const BASE_CONTACT = {
  id: 7,
  name: "Anjali Mehta",
  email: "anjali.mehta@example.com",
  phone: "+91-9000000007",
  title: "Director of Sales",
  company: "Lotus Hospitality",
  status: "Customer",
  createdAt: "2026-05-12T09:00:00.000Z",
  activities: [
    { id: 101, type: "Email", description: "Sent welcome packet", createdAt: "2026-05-15T10:00:00.000Z" },
    { id: 102, type: "Call",  description: "Discovery call",      createdAt: "2026-05-16T14:30:00.000Z" },
  ],
};

function renderPage(id = "7") {
  return render(
    <MemoryRouter initialEntries={[`/contacts/${id}`]}>
      <Routes>
        <Route path="/contacts/:id" element={<ContactsDetail />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("ContactsDetail (alt detail route)", () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyObj.error.mockReset();
    notifyObj.success.mockReset();
    notifyObj.info.mockReset();
    navigateMock.mockReset();
  });

  it("renders loading copy before the contact GET resolves", async () => {
    let resolveGet;
    fetchApiMock.mockImplementation(() => new Promise(resolve => { resolveGet = resolve; }));
    renderPage();
    expect(screen.getByText(/Loading contact record/i)).toBeInTheDocument();
    resolveGet({ ...BASE_CONTACT });
    await waitFor(() => expect(screen.queryByText(/Loading contact record/i)).not.toBeInTheDocument());
  });

  it("shows 'Contact Not Found' empty state when GET resolves null", async () => {
    fetchApiMock.mockResolvedValueOnce(null);
    renderPage();
    await waitFor(() => expect(screen.getByText(/Contact Not Found/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /Return to Contacts/i })).toBeInTheDocument();
  });

  it("shows the not-found state when GET rejects (catch branch)", async () => {
    fetchApiMock.mockRejectedValueOnce(new Error("boom"));
    renderPage();
    // catch path sets loading=false but leaves contact null
    await waitFor(() => expect(screen.getByText(/Contact Not Found/i)).toBeInTheDocument());
  });

  it("renders the contact name + title-at-company subtitle", async () => {
    fetchApiMock.mockResolvedValueOnce({ ...BASE_CONTACT });
    renderPage();
    await waitFor(() => expect(screen.getByRole("heading", { name: /Anjali Mehta/i })).toBeInTheDocument());
    expect(screen.getByText(/Director of Sales at Lotus Hospitality/i)).toBeInTheDocument();
  });

  it("falls back to 'Unknown Title at Unknown Company' when both fields are missing", async () => {
    fetchApiMock.mockResolvedValueOnce({ ...BASE_CONTACT, title: null, company: null });
    renderPage();
    await waitFor(() => expect(screen.getByText(/Unknown Title at Unknown Company/i)).toBeInTheDocument());
  });

  it("renders the status pill verbatim", async () => {
    fetchApiMock.mockResolvedValueOnce({ ...BASE_CONTACT, status: "Lead" });
    renderPage();
    await waitFor(() => expect(screen.getByText("Lead")).toBeInTheDocument());
  });

  it("renders all four meta tiles with their values", async () => {
    fetchApiMock.mockResolvedValueOnce({ ...BASE_CONTACT });
    renderPage();
    await waitFor(() => expect(screen.getByText("anjali.mehta@example.com")).toBeInTheDocument());
    expect(screen.getByText("+91-9000000007")).toBeInTheDocument();
    expect(screen.getByText("Lotus Hospitality")).toBeInTheDocument();
    expect(screen.getByText(/Email Address/i)).toBeInTheDocument();
    expect(screen.getByText(/Phone Number/i)).toBeInTheDocument();
    expect(screen.getByText(/Organization/i)).toBeInTheDocument();
    expect(screen.getByText(/Record Created/i)).toBeInTheDocument();
  });

  it("renders 'Not Provided' fallbacks for missing phone + company", async () => {
    fetchApiMock.mockResolvedValueOnce({ ...BASE_CONTACT, phone: "", company: "" });
    renderPage();
    await waitFor(() => expect(screen.getByText("anjali.mehta@example.com")).toBeInTheDocument());
    // Two tiles render fallback copy
    const fallbacks = screen.getAllByText("Not Provided");
    expect(fallbacks.length).toBeGreaterThanOrEqual(2);
  });

  it("renders 'Unknown' when createdAt is missing", async () => {
    fetchApiMock.mockResolvedValueOnce({ ...BASE_CONTACT, createdAt: null });
    renderPage();
    await waitFor(() => expect(screen.getByText("Unknown")).toBeInTheDocument());
  });

  it("shows the empty-state copy when activities are absent", async () => {
    fetchApiMock.mockResolvedValueOnce({ ...BASE_CONTACT, activities: [] });
    renderPage();
    await waitFor(() => expect(screen.getByText(/No recent interactions logged/i)).toBeInTheDocument());
  });

  it("renders one row per activity with type label + description", async () => {
    fetchApiMock.mockResolvedValueOnce({ ...BASE_CONTACT });
    renderPage();
    await waitFor(() => expect(screen.getByText(/Sent welcome packet/i)).toBeInTheDocument());
    expect(screen.getByText(/Discovery call/i)).toBeInTheDocument();
    // The form select also has an Email + Call option; row labels appear too.
    expect(screen.getAllByText("Email").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Call").length).toBeGreaterThanOrEqual(1);
  });

  it("POSTs a new activity on submit and re-fetches the contact", async () => {
    const user = userEvent.setup();
    // First GET → original; POST → resolved; second GET (re-fetch) → with new activity
    fetchApiMock.mockImplementation((url, opts) => {
      if (opts?.method === "POST") return Promise.resolve({ ok: true });
      // GET path
      return Promise.resolve({
        ...BASE_CONTACT,
        activities: [
          ...BASE_CONTACT.activities,
        ],
      });
    });
    renderPage();
    await waitFor(() => expect(screen.getByPlaceholderText(/Describe the interaction/i)).toBeInTheDocument());

    const input = screen.getByPlaceholderText(/Describe the interaction/i);
    await user.type(input, "Reviewed contract draft");
    const logBtn = screen.getByRole("button", { name: /^Log$/i });
    await user.click(logBtn);

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(c => c[1]?.method === "POST");
      expect(postCall).toBeTruthy();
      expect(postCall[0]).toBe("/api/contacts/7/activities");
      const body = JSON.parse(postCall[1].body);
      expect(body.type).toBe("Note");
      expect(body.description).toBe("Reviewed contract draft");
    });

    // re-fetch fired (>= 2 GETs)
    const getCalls = fetchApiMock.mock.calls.filter(c => !c[1] || c[1].method !== "POST");
    expect(getCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("surfaces notify.error toast when the activity POST fails", async () => {
    const user = userEvent.setup();
    fetchApiMock.mockImplementation((url, opts) => {
      if (opts?.method === "POST") return Promise.reject(new Error("server says no"));
      return Promise.resolve({ ...BASE_CONTACT });
    });
    renderPage();
    await waitFor(() => expect(screen.getByPlaceholderText(/Describe the interaction/i)).toBeInTheDocument());

    await user.type(screen.getByPlaceholderText(/Describe the interaction/i), "Sent revised SOW");
    await user.click(screen.getByRole("button", { name: /^Log$/i }));

    await waitFor(() => expect(notifyObj.error).toHaveBeenCalledWith("Failed to log activity"));
    // Page still rendered (no crash)
    expect(screen.getByRole("heading", { name: /Anjali Mehta/i })).toBeInTheDocument();
  });

  it("supports changing the activity type via the select", async () => {
    const user = userEvent.setup();
    fetchApiMock.mockImplementation((url, opts) => {
      if (opts?.method === "POST") return Promise.resolve({ ok: true });
      return Promise.resolve({ ...BASE_CONTACT });
    });
    renderPage();
    await waitFor(() => expect(screen.getByPlaceholderText(/Describe the interaction/i)).toBeInTheDocument());

    // Select element is the only <select> on the page
    const select = document.querySelector("select.input-field");
    expect(select).toBeTruthy();
    await user.selectOptions(select, "Meeting");
    await user.type(screen.getByPlaceholderText(/Describe the interaction/i), "Quarterly review");
    await user.click(screen.getByRole("button", { name: /^Log$/i }));

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(c => c[1]?.method === "POST");
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.type).toBe("Meeting");
      expect(body.description).toBe("Quarterly review");
    });
  });

  it("clicking 'Back to Directory' navigates to /contacts", async () => {
    const user = userEvent.setup();
    fetchApiMock.mockResolvedValueOnce({ ...BASE_CONTACT });
    renderPage();
    await waitFor(() => expect(screen.getByRole("heading", { name: /Anjali Mehta/i })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /Back to Directory/i }));
    expect(navigateMock).toHaveBeenCalledWith("/contacts");
  });

  it("clicking 'Return to Contacts' on not-found navigates to /contacts", async () => {
    const user = userEvent.setup();
    fetchApiMock.mockResolvedValueOnce(null);
    renderPage();
    await waitFor(() => expect(screen.getByText(/Contact Not Found/i)).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /Return to Contacts/i }));
    expect(navigateMock).toHaveBeenCalledWith("/contacts");
  });
});
