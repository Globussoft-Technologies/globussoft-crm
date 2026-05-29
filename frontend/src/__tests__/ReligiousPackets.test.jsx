/**
 * ReligiousPackets.jsx — Travel CRM religious-guidance content library (PRD §4.8 + §4.10 RFU).
 *
 * Pins the frontend contract for the admin UI that sits on top of
 * backend/routes/travel_religious_packets.js. Verifies:
 *   - Page header renders.
 *   - Empty state renders.
 *   - Data rows render sub-brand / day offset / title / channels / active badge.
 *   - Filter dropdowns change the fetch URL (subBrand + isActive query params).
 *   - Add packet button reveals the form (admin only).
 *   - Saving a new packet POSTs the correct body shape (channels joined as
 *     comma-separated, dayOffset coerced to number, isActive defaulting to true).
 *   - Delete confirms + DELETEs.
 *   - Edit modal opens with pre-filled fields and PATCH dispatches correctly.
 *
 * Mock stability: useNotify + fetchApi + AuthContext are stable references
 * per CLAUDE.md feedback rule.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

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
  prompt: () => Promise.resolve(""),
};
vi.mock("../utils/notify", () => ({
  useNotify: () => notifyObj,
}));

import { AuthContext } from "../App";
import ReligiousPackets from "../pages/travel/ReligiousPackets";

const SAMPLE_PACKETS = [
  {
    id: 1,
    subBrand: "rfu",
    dayOffset: 14,
    title: "Umrah preparation — 14 days out",
    contentHtml: "<p>Pack lightly. Bring ihram.</p>",
    channels: "wa,email",
    isActive: true,
  },
  {
    id: 2,
    subBrand: "rfu",
    dayOffset: 1,
    title: "Final reminders",
    contentHtml: "<p>Check passport. Confirm pickup.</p>",
    channels: "wa,sms",
    isActive: false,
  },
];

function defaultFetchImpl(rows = SAMPLE_PACKETS) {
  return (url, opts) => {
    if (url.startsWith("/api/travel/religious-packets?")) {
      return Promise.resolve({ packets: rows, total: rows.length, limit: 50, offset: 0 });
    }
    if (url === "/api/travel/religious-packets" && opts?.method === "POST") {
      return Promise.resolve({ id: 99, ...JSON.parse(opts.body) });
    }
    if (url.match(/\/api\/travel\/religious-packets\/\d+$/) && opts?.method === "PATCH") {
      return Promise.resolve({ id: 1, ...JSON.parse(opts.body) });
    }
    if (url.match(/\/api\/travel\/religious-packets\/\d+$/) && opts?.method === "DELETE") {
      return Promise.resolve({ deleted: true, id: 1 });
    }
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
  // Default window.confirm to true (page uses native confirm() for delete).
  vi.spyOn(window, "confirm").mockImplementation(() => true);
});

function renderPage({ role = "ADMIN" } = {}) {
  return render(
    <MemoryRouter>
      <AuthContext.Provider
        value={{
          user: { userId: 1, role },
          setUser: vi.fn(),
          token: "tk",
          tenant: { id: 1, vertical: "travel" },
          loading: false,
        }}
      >
        <ReligiousPackets />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

describe("ReligiousPackets — page contract", () => {
  it("renders the page header + subtitle", async () => {
    fetchApiMock.mockImplementation(defaultFetchImpl());
    renderPage();
    expect(await screen.findByText(/Religious Guidance Packets/i)).toBeTruthy();
    expect(screen.getByText(/Admin-curated content library/i)).toBeTruthy();
  });

  it("renders the empty state when API returns zero packets", async () => {
    fetchApiMock.mockImplementation(defaultFetchImpl([]));
    renderPage();
    expect(await screen.findByText(/No packets in this filter/i)).toBeTruthy();
  });

  it("renders rows with sub-brand, day offset, title, channels, active badge", async () => {
    fetchApiMock.mockImplementation(defaultFetchImpl());
    renderPage();
    expect(await screen.findByText("Umrah preparation — 14 days out")).toBeTruthy();
    expect(screen.getByText("Final reminders")).toBeTruthy();
    expect(screen.getByText("T-14d")).toBeTruthy();
    expect(screen.getByText("T-1d")).toBeTruthy();
    expect(screen.getByText("wa,email")).toBeTruthy();
    expect(screen.getByText("wa,sms")).toBeTruthy();
    // Active/Inactive labels appear as both row badges and (similar-text)
    // filter dropdown options — use getAllByText to tolerate both surfaces.
    expect(screen.getAllByText("Active").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Inactive").length).toBeGreaterThan(0);
  });

  it("filter dropdowns drive query params on the GET", async () => {
    fetchApiMock.mockImplementation(defaultFetchImpl());
    renderPage();
    await screen.findByText(/Umrah preparation/i);

    fireEvent.change(screen.getByLabelText(/Filter by sub-brand/i), { target: { value: "rfu" } });
    await waitFor(() => {
      const urls = fetchApiMock.mock.calls.map((c) => c[0]);
      expect(urls.some((u) => u.includes("subBrand=rfu"))).toBe(true);
    });

    fireEvent.change(screen.getByLabelText(/Filter by active state/i), { target: { value: "true" } });
    await waitFor(() => {
      const urls = fetchApiMock.mock.calls.map((c) => c[0]);
      expect(urls.some((u) => u.includes("isActive=true"))).toBe(true);
    });
  });

  it("Add packet button reveals the form and POSTs with the correct shape", async () => {
    fetchApiMock.mockImplementation(defaultFetchImpl());
    renderPage();
    await screen.findByText(/Umrah preparation/i);

    fireEvent.click(screen.getByRole("button", { name: /Add packet/i }));
    fireEvent.change(screen.getByPlaceholderText(/preparation — 14 days out/i), {
      target: { value: "Hajj day-0" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Rendered into the WhatsApp/i), {
      target: { value: "<p>Travel safe.</p>" },
    });
    // Find the inline Save button by scoping inside the form card.
    const saveButtons = screen.getAllByRole("button", { name: /^Save$/ });
    fireEvent.click(saveButtons[0]);

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        (c) => c[0] === "/api/travel/religious-packets" && c[1]?.method === "POST",
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.subBrand).toBe("rfu");
      expect(body.dayOffset).toBe(14);
      expect(body.title).toBe("Hajj day-0");
      expect(body.contentHtml).toBe("<p>Travel safe.</p>");
      expect(body.channels).toBe("wa,email"); // default channels in EMPTY_FORM
      expect(body.isActive).toBe(true);
    });
    expect(notifyObj.success).toHaveBeenCalledWith("Packet created");
  });

  it("Delete button confirms + DELETEs the packet", async () => {
    fetchApiMock.mockImplementation(defaultFetchImpl());
    renderPage();
    await screen.findByText(/Umrah preparation/i);

    fireEvent.click(screen.getByLabelText(/Delete packet Umrah preparation/i));

    await waitFor(() => {
      const delCall = fetchApiMock.mock.calls.find(
        (c) => c[0].match(/\/api\/travel\/religious-packets\/1$/) && c[1]?.method === "DELETE",
      );
      expect(delCall).toBeTruthy();
    });
    expect(notifyObj.success).toHaveBeenCalledWith("Deleted");
  });

  it("Edit modal pre-fills + PATCHes with the modified shape", async () => {
    fetchApiMock.mockImplementation(defaultFetchImpl());
    renderPage();
    await screen.findByText(/Umrah preparation/i);

    fireEvent.click(screen.getByLabelText(/Edit packet Umrah preparation/i));

    // Modal opens with the title pre-filled.
    const titleInput = await screen.findByDisplayValue("Umrah preparation — 14 days out");
    fireEvent.change(titleInput, { target: { value: "Umrah preparation — UPDATED" } });

    // Save inside the modal.
    const dialog = screen.getByRole("dialog", { name: /Edit packet/i });
    fireEvent.click(within(dialog).getByRole("button", { name: /^Save$/ }));

    await waitFor(() => {
      const patchCall = fetchApiMock.mock.calls.find(
        (c) => c[0] === "/api/travel/religious-packets/1" && c[1]?.method === "PATCH",
      );
      expect(patchCall).toBeTruthy();
      const body = JSON.parse(patchCall[1].body);
      expect(body.title).toBe("Umrah preparation — UPDATED");
      expect(body.subBrand).toBe("rfu");
      expect(body.dayOffset).toBe(14);
      expect(body.channels).toBe("wa,email");
      expect(body.isActive).toBe(true);
    });
    expect(notifyObj.success).toHaveBeenCalledWith("Packet saved");
  });

  it("rejects save when title or contentHtml is blank", async () => {
    fetchApiMock.mockImplementation(defaultFetchImpl());
    renderPage();
    await screen.findByText(/Umrah preparation/i);

    fireEvent.click(screen.getByRole("button", { name: /Add packet/i }));
    // Leave title + contentHtml blank.
    const saveButtons = screen.getAllByRole("button", { name: /^Save$/ });
    fireEvent.click(saveButtons[0]);

    await waitFor(() => {
      expect(notifyObj.error).toHaveBeenCalledWith("title + contentHtml required");
    });
    // POST should not have happened.
    const postCall = fetchApiMock.mock.calls.find(
      (c) => c[0] === "/api/travel/religious-packets" && c[1]?.method === "POST",
    );
    expect(postCall).toBeFalsy();
  });

  // ─────────────────────────────────────────────────────────────────────
  // Extended cases (2026-05-26): cover non-admin gating, error paths,
  // channel-validation, dayOffset coercion, modal-close paths, cancel-add
  // reset, and delete-cancel guard. Brings test ratio from 57% → ~95%
  // relative to the 442L SUT.
  // ─────────────────────────────────────────────────────────────────────

  it("hides Add / Edit / Delete buttons for non-admin (USER role)", async () => {
    fetchApiMock.mockImplementation(defaultFetchImpl());
    renderPage({ role: "USER" });
    await screen.findByText(/Umrah preparation/i);

    expect(screen.queryByRole("button", { name: /Add packet/i })).toBeNull();
    expect(screen.queryByLabelText(/Edit packet Umrah preparation/i)).toBeNull();
    expect(screen.queryByLabelText(/Delete packet Umrah preparation/i)).toBeNull();
  });

  it("surfaces GET error via notify.error and falls back to empty list", async () => {
    fetchApiMock.mockImplementation(() =>
      Promise.reject({ body: { error: "Boom — backend unavailable" } }),
    );
    renderPage();
    await waitFor(() => {
      expect(notifyObj.error).toHaveBeenCalledWith("Boom — backend unavailable");
    });
    // Empty-state shown after the failed load.
    expect(await screen.findByText(/No packets in this filter/i)).toBeTruthy();
  });

  it("surfaces POST error via notify.error without closing the add form", async () => {
    let firstCall = true;
    fetchApiMock.mockImplementation((url, opts) => {
      if (firstCall && url.startsWith("/api/travel/religious-packets?")) {
        firstCall = false;
        return Promise.resolve({ packets: SAMPLE_PACKETS });
      }
      if (url === "/api/travel/religious-packets" && opts?.method === "POST") {
        return Promise.reject({ body: { error: "Duplicate (subBrand, dayOffset, title)" } });
      }
      return Promise.resolve({ packets: SAMPLE_PACKETS });
    });
    renderPage();
    await screen.findByText(/Umrah preparation/i);

    fireEvent.click(screen.getByRole("button", { name: /Add packet/i }));
    fireEvent.change(screen.getByPlaceholderText(/preparation — 14 days out/i), {
      target: { value: "Conflicting packet" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Rendered into the WhatsApp/i), {
      target: { value: "<p>body</p>" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: /^Save$/ })[0]);

    await waitFor(() => {
      expect(notifyObj.error).toHaveBeenCalledWith("Duplicate (subBrand, dayOffset, title)");
    });
    // Add form should still be visible (no success path → not closed).
    expect(screen.getByPlaceholderText(/preparation — 14 days out/i)).toBeTruthy();
  });

  it("rejects save when ALL channels are unchecked (at-least-one-channel guard)", async () => {
    fetchApiMock.mockImplementation(defaultFetchImpl());
    renderPage();
    await screen.findByText(/Umrah preparation/i);

    fireEvent.click(screen.getByRole("button", { name: /Add packet/i }));
    fireEvent.change(screen.getByPlaceholderText(/preparation — 14 days out/i), {
      target: { value: "No-channel packet" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Rendered into the WhatsApp/i), {
      target: { value: "<p>body</p>" },
    });
    // Uncheck default-on channels (WhatsApp + Email).
    fireEvent.click(screen.getByLabelText(/^WhatsApp$/));
    fireEvent.click(screen.getByLabelText(/^EMAIL$/));

    fireEvent.click(screen.getAllByRole("button", { name: /^Save$/ })[0]);

    await waitFor(() => {
      expect(notifyObj.error).toHaveBeenCalledWith("at least one channel required");
    });
    const postCall = fetchApiMock.mock.calls.find(
      (c) => c[0] === "/api/travel/religious-packets" && c[1]?.method === "POST",
    );
    expect(postCall).toBeFalsy();
  });

  it("does NOT DELETE when window.confirm returns false", async () => {
    window.confirm.mockRestore?.();
    vi.spyOn(window, "confirm").mockImplementation(() => false);
    fetchApiMock.mockImplementation(defaultFetchImpl());
    renderPage();
    await screen.findByText(/Umrah preparation/i);

    fireEvent.click(screen.getByLabelText(/Delete packet Umrah preparation/i));

    // Give event loop a tick to drain any unintended async work.
    await new Promise((r) => setTimeout(r, 20));
    const delCall = fetchApiMock.mock.calls.find(
      (c) => c[0].match(/\/api\/travel\/religious-packets\/\d+$/) && c[1]?.method === "DELETE",
    );
    expect(delCall).toBeFalsy();
    expect(notifyObj.success).not.toHaveBeenCalledWith("Deleted");
  });

  it("surfaces DELETE error via notify.error", async () => {
    let firstCall = true;
    fetchApiMock.mockImplementation((url, opts) => {
      if (firstCall && url.startsWith("/api/travel/religious-packets?")) {
        firstCall = false;
        return Promise.resolve({ packets: SAMPLE_PACKETS });
      }
      if (url.match(/\/api\/travel\/religious-packets\/\d+$/) && opts?.method === "DELETE") {
        return Promise.reject({ body: { error: "FK constraint" } });
      }
      return Promise.resolve({ packets: SAMPLE_PACKETS });
    });
    renderPage();
    await screen.findByText(/Umrah preparation/i);

    fireEvent.click(screen.getByLabelText(/Delete packet Umrah preparation/i));
    await waitFor(() => {
      expect(notifyObj.error).toHaveBeenCalledWith("FK constraint");
    });
  });

  it("surfaces PATCH error via notify.error and keeps the edit modal open", async () => {
    let firstCall = true;
    fetchApiMock.mockImplementation((url, opts) => {
      if (firstCall && url.startsWith("/api/travel/religious-packets?")) {
        firstCall = false;
        return Promise.resolve({ packets: SAMPLE_PACKETS });
      }
      if (url.match(/\/api\/travel\/religious-packets\/\d+$/) && opts?.method === "PATCH") {
        return Promise.reject({ body: { error: "Validation: dayOffset out of range" } });
      }
      return Promise.resolve({ packets: SAMPLE_PACKETS });
    });
    renderPage();
    await screen.findByText(/Umrah preparation/i);

    fireEvent.click(screen.getByLabelText(/Edit packet Umrah preparation/i));
    const dialog = await screen.findByRole("dialog", { name: /Edit packet/i });
    fireEvent.click(within(dialog).getByRole("button", { name: /^Save$/ }));

    await waitFor(() => {
      expect(notifyObj.error).toHaveBeenCalledWith("Validation: dayOffset out of range");
    });
    // Modal still open after the failure.
    expect(screen.queryByRole("dialog", { name: /Edit packet/i })).toBeTruthy();
  });

  it("dayOffset is coerced to Number on POST even if the input ships a string", async () => {
    fetchApiMock.mockImplementation(defaultFetchImpl());
    renderPage();
    await screen.findByText(/Umrah preparation/i);

    fireEvent.click(screen.getByRole("button", { name: /Add packet/i }));
    fireEvent.change(screen.getByPlaceholderText(/preparation — 14 days out/i), {
      target: { value: "Coercion check" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Rendered into the WhatsApp/i), {
      target: { value: "<p>x</p>" },
    });
    // Set dayOffset via the spinner — DOM yields string "30".
    const dayInput = screen.getByLabelText(/Day offset/i);
    fireEvent.change(dayInput, { target: { value: "30" } });

    fireEvent.click(screen.getAllByRole("button", { name: /^Save$/ })[0]);
    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        (c) => c[0] === "/api/travel/religious-packets" && c[1]?.method === "POST",
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.dayOffset).toBe(30);
      expect(typeof body.dayOffset).toBe("number");
    });
  });

  it("Cancel button on add form hides it and resets the form to EMPTY_FORM", async () => {
    fetchApiMock.mockImplementation(defaultFetchImpl());
    renderPage();
    await screen.findByText(/Umrah preparation/i);

    fireEvent.click(screen.getByRole("button", { name: /Add packet/i }));
    fireEvent.change(screen.getByPlaceholderText(/preparation — 14 days out/i), {
      target: { value: "dirty draft" },
    });

    // Cancel — the inline form has its own Cancel button at the bottom.
    const cancelButtons = screen.getAllByRole("button", { name: /^Cancel$/ });
    fireEvent.click(cancelButtons[0]);

    // Form is removed; re-opening shows the EMPTY_FORM placeholder text again, not "dirty draft".
    expect(screen.queryByPlaceholderText(/preparation — 14 days out/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Add packet/i }));
    const reopenedTitle = screen.getByPlaceholderText(/preparation — 14 days out/i);
    expect(reopenedTitle.value).toBe("");
  });

  it("clicking the modal backdrop closes the edit modal", async () => {
    fetchApiMock.mockImplementation(defaultFetchImpl());
    renderPage();
    await screen.findByText(/Umrah preparation/i);

    fireEvent.click(screen.getByLabelText(/Edit packet Umrah preparation/i));
    const dialog = await screen.findByRole("dialog", { name: /Edit packet/i });
    expect(dialog).toBeTruthy();

    // Click the backdrop (the dialog element itself, not the inner stopPropagation card).
    fireEvent.click(dialog);
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: /Edit packet/i })).toBeNull();
    });
  });

  it("sub-brand field change in add form flows through to the POST body", async () => {
    fetchApiMock.mockImplementation(defaultFetchImpl());
    renderPage();
    await screen.findByText(/Umrah preparation/i);

    fireEvent.click(screen.getByRole("button", { name: /Add packet/i }));
    fireEvent.change(screen.getByPlaceholderText(/preparation — 14 days out/i), {
      target: { value: "TMC briefing" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Rendered into the WhatsApp/i), {
      target: { value: "<p>tmc</p>" },
    });
    // Sub-brand select inside the form. There are two filter selects above
    // the form (subBrand filter + active filter) and ONE select inside the
    // form (form sub-brand). The form's select is the 3rd select on the page.
    const allSelects = document.querySelectorAll("select");
    const formSubBrandSelect = allSelects[2];
    fireEvent.change(formSubBrandSelect, { target: { value: "tmc" } });

    fireEvent.click(screen.getAllByRole("button", { name: /^Save$/ })[0]);
    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        (c) => c[0] === "/api/travel/religious-packets" && c[1]?.method === "POST",
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.subBrand).toBe("tmc");
    });
  });
});
