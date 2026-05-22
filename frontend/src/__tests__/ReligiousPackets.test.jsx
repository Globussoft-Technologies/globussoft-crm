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
});
