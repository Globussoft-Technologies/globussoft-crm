/**
 * ContactDetail.jsx — contact-centric detail page (NOT to be confused with
 * ContactsDetail.jsx, which is a separate similar file used by a different
 * route). This page renders at /contacts/:id and is the generic CRM's
 * contact-drilldown view; it aggregates the contact's overview card,
 * deals snapshot, attachments, and activity timeline.
 *
 * Endpoints consumed:
 *   - GET    /api/contacts/:id              -> contact + nested deals + activities
 *   - GET    /api/contacts/:id/attachments  -> attachment list
 *   - POST   /api/contacts/:id/attachments  -> upload attachment
 *   - DELETE /api/contacts/attachments/:id  -> remove attachment
 *
 * Mock stability: fetchApi is a stable vi.fn() reference; the per-test
 * setup resets and re-implements via mockImplementation so the URL
 * dispatcher can swap branches. Per CLAUDE.md feedback rule, NEVER
 * recreate the mock object per call site.
 *
 * Contracts pinned:
 *   1. Loading state renders before the contact GET resolves.
 *   2. Header + email + phone render after contact load.
 *   3. Status chip + AI score chip render.
 *   4. Title-at-company subtitle renders ONLY when title or company set;
 *      the orphan-preposition guard (#189B) keeps the chip out when both
 *      are empty.
 *   5. Source line renders only when contact.source is set.
 *   6. Deals snapshot renders one row per deal with currency-aware money.
 *   7. Phone fallback "No phone number" renders when phone is empty.
 *   8. "Back to Contacts" link points to /contacts.
 *   9. Empty attachments shows "No files attached." copy.
 *  10. Attachment list renders one row per attachment with delete button.
 *  11. Clicking the Add button opens the upload form; Cancel closes it.
 *  12. Submitting the upload form POSTs to the attachments endpoint with
 *      the JSON body and re-fetches the attachment list.
 *  13. Clicking the trash button DELETEs the attachment and re-fetches.
 *  14. Empty activity timeline renders the "No activities recorded yet." copy.
 *  15. Activity timeline renders one row per activity with type chip.
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

import ContactDetail from "../pages/ContactDetail";

const BASE_CONTACT = {
  id: 42,
  name: "Priya Sharma",
  email: "priya.sharma@example.com",
  phone: "+91-9000000001",
  title: "VP Marketing",
  company: "Acme Retail",
  status: "Customer",
  aiScore: 85,
  source: "Website",
  deals: [
    { id: 11, title: "Q3 Renewal", amount: 145000, currency: "INR", stage: "won" },
    { id: 12, title: "Add-on package", amount: 60000, currency: "INR", stage: "negotiation" },
  ],
  activities: [
    { id: 1, type: "Email", description: "Sent renewal quote", createdAt: "2026-05-20T10:00:00.000Z" },
    { id: 2, type: "Call", description: "Followed up on quote", createdAt: "2026-05-22T11:30:00.000Z" },
  ],
};

const ATTACHMENTS = [
  { id: 501, filename: "renewal-quote.pdf", fileUrl: "https://files.example.com/501", createdAt: "2026-05-20T10:00:00.000Z" },
  { id: 502, filename: "signed-msa.pdf", fileUrl: "https://files.example.com/502", createdAt: "2026-05-21T10:00:00.000Z" },
];

/**
 * Build a fetchApi mock dispatcher. Pass `overrides` to swap branches.
 */
function makeFetchImpl(overrides = {}) {
  const o = {
    contact: { kind: "ok", data: BASE_CONTACT },
    attachments: { kind: "ok", data: ATTACHMENTS },
    upload: { kind: "ok", data: { id: 999 } },
    delete: { kind: "ok", data: { ok: true } },
    ...overrides,
  };
  const handle = (slot) => {
    if (slot.kind === "throw") return Promise.reject(slot.error || new Error("boom"));
    return Promise.resolve(slot.data);
  };
  return (url, opts) => {
    const method = (opts && opts.method) || "GET";
    if (/^\/api\/contacts\/\d+$/.test(url) && method === "GET") return handle(o.contact);
    if (/^\/api\/contacts\/\d+\/attachments$/.test(url) && method === "GET") return handle(o.attachments);
    if (/^\/api\/contacts\/\d+\/attachments$/.test(url) && method === "POST") return handle(o.upload);
    if (/^\/api\/contacts\/attachments\/\d+$/.test(url) && method === "DELETE") return handle(o.delete);
    return Promise.resolve({});
  };
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyObj.error.mockReset();
  notifyObj.success.mockReset();
  notifyObj.info.mockReset();
  notifyObj.confirm.mockReset();
  notifyObj.confirm.mockImplementation(() => Promise.resolve(true));
});

function renderPage({ contactId = 42 } = {}) {
  return render(
    <MemoryRouter initialEntries={[`/contacts/${contactId}`]}>
      <Routes>
        <Route path="/contacts/:id" element={<ContactDetail />} />
        <Route path="/contacts" element={<div data-testid="contacts-list-stub">Contacts list stub</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ContactDetail — page contract", () => {
  it("renders the Loading… placeholder before the contact GET resolves", () => {
    // Return a never-resolving promise for contact so the loading branch sticks.
    fetchApiMock.mockImplementation((url) => {
      if (/^\/api\/contacts\/\d+$/.test(url) && !url.includes("attachments")) return new Promise(() => {});
      return Promise.resolve([]);
    });
    renderPage();
    expect(screen.getByText(/Loading\.\.\./)).toBeTruthy();
  });

  it("renders the contact name, email, and phone after the GET resolves", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl());
    renderPage();
    expect(await screen.findByText(/Priya Sharma/)).toBeTruthy();
    expect(screen.getByText(/priya\.sharma@example\.com/)).toBeTruthy();
    expect(screen.getByText(/\+91-9000000001/)).toBeTruthy();
  });

  it("renders the status chip and AI score chip", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl());
    renderPage();
    expect(await screen.findByText(/Customer/)).toBeTruthy();
    expect(screen.getByText(/85\/100/)).toBeTruthy();
  });

  it("renders the title-at-company subtitle when both are set", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl());
    renderPage();
    // The subtitle concatenates "VP Marketing at Acme Retail" — match any
    // node containing both halves (jsx whitespace between spans may split).
    await waitFor(() => {
      const matches = screen.queryAllByText((_, node) => {
        if (!node) return false;
        const txt = node.textContent || "";
        return /VP Marketing/.test(txt) && / at /.test(txt) && /Acme Retail/.test(txt);
      });
      expect(matches.length).toBeGreaterThan(0);
    });
  });

  it("omits the title-at-company subtitle when BOTH title and company are empty (#189B)", async () => {
    fetchApiMock.mockImplementation(
      makeFetchImpl({
        contact: { kind: "ok", data: { ...BASE_CONTACT, title: "", company: "" } },
      }),
    );
    renderPage();
    await screen.findByText(/Priya Sharma/);
    // The orphan-preposition guard: no " at " separator should leak into the DOM.
    // Use a regex that requires the standalone " at " token (with spaces).
    expect(screen.queryByText(/ at /)).toBeNull();
  });

  it("renders the source line only when contact.source is set", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl());
    const { unmount } = renderPage();
    expect(await screen.findByText(/Source: Website/)).toBeTruthy();
    unmount();

    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation(
      makeFetchImpl({ contact: { kind: "ok", data: { ...BASE_CONTACT, source: null } } }),
    );
    renderPage();
    await screen.findByText(/Priya Sharma/);
    expect(screen.queryByText(/Source:/)).toBeNull();
  });

  it("renders the phone fallback when phone is empty", async () => {
    fetchApiMock.mockImplementation(
      makeFetchImpl({ contact: { kind: "ok", data: { ...BASE_CONTACT, phone: "" } } }),
    );
    renderPage();
    expect(await screen.findByText(/No phone number/)).toBeTruthy();
  });

  it("renders the deals snapshot with one row per deal", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl());
    renderPage();
    expect(await screen.findByText(/Q3 Renewal/)).toBeTruthy();
    expect(screen.getByText(/Add-on package/)).toBeTruthy();
    expect(screen.getByText(/Deals \(2\)/)).toBeTruthy();
  });

  it("renders the Back to Contacts link pointing at /contacts", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl());
    renderPage();
    const link = (await screen.findByText(/Back to Contacts/)).closest("a");
    expect(link).toBeTruthy();
    expect(link.getAttribute("href")).toBe("/contacts");
  });

  it("renders the empty attachments copy when none exist", async () => {
    fetchApiMock.mockImplementation(
      makeFetchImpl({ attachments: { kind: "ok", data: [] } }),
    );
    renderPage();
    await screen.findByText(/Priya Sharma/);
    expect(await screen.findByText(/No files attached\./)).toBeTruthy();
    expect(screen.getByText(/Files \(0\)/)).toBeTruthy();
  });

  it("renders an attachment row per attachment with file name link", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl());
    renderPage();
    expect(await screen.findByText(/renewal-quote\.pdf/)).toBeTruthy();
    expect(screen.getByText(/signed-msa\.pdf/)).toBeTruthy();
    expect(screen.getByText(/Files \(2\)/)).toBeTruthy();
    const firstLink = screen.getByText(/renewal-quote\.pdf/).closest("a");
    expect(firstLink.getAttribute("href")).toBe("https://files.example.com/501");
  });

  it("opens the upload form when Add is clicked and closes via Cancel", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl());
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/Priya Sharma/);

    // Form fields are absent before Add is clicked.
    expect(screen.queryByPlaceholderText(/File name/)).toBeNull();

    const addBtn = screen.getByRole("button", { name: /Add/ });
    await user.click(addBtn);

    expect(await screen.findByPlaceholderText(/File name/)).toBeTruthy();
    expect(screen.getByPlaceholderText(/File URL/)).toBeTruthy();

    const cancelBtn = screen.getByRole("button", { name: /Cancel/ });
    await user.click(cancelBtn);

    await waitFor(() => {
      expect(screen.queryByPlaceholderText(/File name/)).toBeNull();
    });
  });

  it("submitting the upload form POSTs to /api/contacts/:id/attachments and re-fetches the list", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl());
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/Priya Sharma/);

    await user.click(screen.getByRole("button", { name: /Add/ }));
    await user.type(await screen.findByPlaceholderText(/File name/), "msa-2026.pdf");
    await user.type(screen.getByPlaceholderText(/File URL/), "https://files.example.com/new");

    const beforeCalls = fetchApiMock.mock.calls.length;
    await user.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        (c) => c[0] === "/api/contacts/42/attachments" && c[1] && c[1].method === "POST",
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.filename).toBe("msa-2026.pdf");
      expect(body.fileUrl).toBe("https://files.example.com/new");
    });

    // Re-fetch should have followed the upload.
    await waitFor(() => {
      const refetch = fetchApiMock.mock.calls
        .slice(beforeCalls)
        .filter((c) => c[0] === "/api/contacts/42/attachments" && (!c[1] || c[1].method === undefined || c[1].method === "GET"));
      expect(refetch.length).toBeGreaterThan(0);
    });
  });

  it("clicking the trash button DELETEs the attachment and re-fetches the list", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl());
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/renewal-quote\.pdf/);

    // Find the row's delete button. The row contains the filename anchor and a trash button.
    const row = screen.getByText(/renewal-quote\.pdf/).closest("div");
    expect(row).toBeTruthy();
    // The trash button is the only <button> in that attachment row.
    const trashBtn = row.parentElement.querySelector("button");
    expect(trashBtn).toBeTruthy();

    const beforeCalls = fetchApiMock.mock.calls.length;
    await user.click(trashBtn);

    await waitFor(() => {
      const delCall = fetchApiMock.mock.calls.find(
        (c) => /^\/api\/contacts\/attachments\/\d+$/.test(c[0]) && c[1] && c[1].method === "DELETE",
      );
      expect(delCall).toBeTruthy();
      expect(delCall[0]).toBe("/api/contacts/attachments/501");
    });
    // Re-fetch should have followed the delete.
    await waitFor(() => {
      const refetch = fetchApiMock.mock.calls
        .slice(beforeCalls)
        .filter((c) => c[0] === "/api/contacts/42/attachments" && (!c[1] || c[1].method === undefined || c[1].method === "GET"));
      expect(refetch.length).toBeGreaterThan(0);
    });
  });

  it("renders the empty activity timeline copy when no activities exist", async () => {
    fetchApiMock.mockImplementation(
      makeFetchImpl({ contact: { kind: "ok", data: { ...BASE_CONTACT, activities: [] } } }),
    );
    renderPage();
    expect(await screen.findByText(/No activities recorded yet\./)).toBeTruthy();
    expect(screen.getByText(/Activity Timeline \(0\)/)).toBeTruthy();
  });

  it("renders an activity timeline row per activity with the type chip", async () => {
    fetchApiMock.mockImplementation(makeFetchImpl());
    renderPage();
    expect(await screen.findByText(/Sent renewal quote/)).toBeTruthy();
    expect(screen.getByText(/Followed up on quote/)).toBeTruthy();
    expect(screen.getByText(/Activity Timeline \(2\)/)).toBeTruthy();
    // Each activity carries a type chip; "Email" + "Call" appear in this fixture.
    expect(screen.getByText(/^Email$/)).toBeTruthy();
    expect(screen.getByText(/^Call$/)).toBeTruthy();
  });

  it("tolerates the attachments GET returning a non-array without crashing", async () => {
    // Source defensively coerces to [] when not array — pin that contract.
    fetchApiMock.mockImplementation(
      makeFetchImpl({ attachments: { kind: "ok", data: { error: "weird shape" } } }),
    );
    renderPage();
    await screen.findByText(/Priya Sharma/);
    // The empty-state copy stands in for the coerced [] outcome.
    expect(await screen.findByText(/No files attached\./)).toBeTruthy();
  });
});
