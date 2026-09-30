import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

const fetchApiMock = vi.fn();
vi.mock("../utils/api", () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => "test-token",
}));

const notifyObj = {
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  confirm: vi.fn(() => Promise.resolve(true)),
};
vi.mock("../utils/notify", () => ({
  useNotify: () => notifyObj,
}));

const { authContextValue, setThemeMock } = vi.hoisted(() => ({
  authContextValue: { tenant: null, setTenant: () => {} },
  setThemeMock: vi.fn(),
}));
vi.mock("../App", () => {
  const React = require("react");
  return {
    ThemeContext: React.createContext({
      theme: "light",
      setTheme: setThemeMock,
      toggleTheme: () => {},
    }),
    AuthContext: React.createContext(authContextValue),
  };
});

import LeadFields from "../pages/settings/LeadFields";

function renderLeadFields() {
  return render(
    <MemoryRouter>
      <LeadFields />
    </MemoryRouter>,
  );
}

const baseFields = [
  {
    id: 1,
    label: "Alpha",
    fieldKey: "alpha",
    fieldType: "text",
    options: null,
    isRequired: false,
    displayOrder: 0,
  },
  {
    id: 2,
    label: "Beta",
    fieldKey: "beta",
    fieldType: "dropdown",
    options: ["One", "Two"],
    isRequired: true,
    displayOrder: 1,
  },
];

let serverFields = [];
let pendingPuts = [];

function sortedServerFields() {
  return [...serverFields].sort((a, b) => {
    const orderDelta = (a.displayOrder ?? 0) - (b.displayOrder ?? 0);
    if (orderDelta !== 0) return orderDelta;
    return a.id - b.id;
  });
}

function flushPendingPuts() {
  const resolvers = pendingPuts;
  pendingPuts = [];
  resolvers.forEach((resolve) => resolve());
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyObj.success.mockReset();
  notifyObj.error.mockReset();
  notifyObj.info.mockReset();
  notifyObj.confirm.mockReset();
  notifyObj.confirm.mockImplementation(() => Promise.resolve(true));
  setThemeMock.mockReset();
  authContextValue.tenant = null;
  serverFields = baseFields.map((field) => ({
    ...field,
    options: Array.isArray(field.options) ? [...field.options] : field.options,
  }));
  pendingPuts = [];

  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || "GET";

    if (url.startsWith("/api/lead-custom-fields?") && method === "GET") {
      const params = new URLSearchParams(url.split("?")[1]);
      return Promise.resolve({
        data: sortedServerFields().slice(Number(params.get("offset") || 0), Number(params.get("offset") || 0) + Number(params.get("limit") || 10)).map((field) => ({
          ...field,
          options: Array.isArray(field.options) ? [...field.options] : field.options,
        })),
        total: serverFields.length,
        page: Number(params.get("page") || 1),
        offset: Number(params.get("offset") || 0),
        limit: Number(params.get("limit") || 10),
      });
    }

    if (/^\/api\/lead-custom-fields\/\d+$/.test(url) && method === "PUT") {
      const id = Number(url.split("/").pop());
      const body = JSON.parse(opts.body);
      return new Promise((resolve) => {
        pendingPuts.push(() => {
          serverFields = serverFields.map((field) =>
            field.id === id ? { ...field, ...body } : field,
          );
          const updated = serverFields.find((field) => field.id === id);
          resolve({
            ...updated,
            options: Array.isArray(updated.options) ? [...updated.options] : updated.options,
          });
        });
      });
    }

    if (/^\/api\/lead-custom-fields\/\d+\/move$/.test(url) && method === "POST") {
      const id = Number(url.split("/").at(-2));
      const direction = JSON.parse(opts.body).direction;
      const ordered = sortedServerFields();
      const currentIndex = ordered.findIndex((field) => field.id === id);
      const targetIndex = currentIndex + (direction === "up" ? -1 : 1);
      if (currentIndex >= 0 && targetIndex >= 0 && targetIndex < ordered.length) {
        [ordered[currentIndex], ordered[targetIndex]] = [ordered[targetIndex], ordered[currentIndex]];
        serverFields = ordered.map((field, index) => ({ ...field, displayOrder: index + 1 }));
      }
      return Promise.resolve({ moved: currentIndex >= 0 && targetIndex >= 0 && targetIndex < ordered.length });
    }

    return Promise.resolve([]);
  });
});

describe("<LeadFields />", () => {
  it("keeps Travel CRM lead fields available", async () => {
    authContextValue.tenant = { vertical: "travel" };

    renderLeadFields();

    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument());
    expect(fetchApiMock).toHaveBeenCalledWith(expect.stringContaining("/api/lead-custom-fields?"));
  });

  it("shows a drag handle and reorders without flashing the loading state", async () => {
    const user = userEvent.setup();

    renderLeadFields();

    await waitFor(() => {
      expect(screen.getByText("Alpha")).toBeInTheDocument();
      expect(screen.getByText("Beta")).toBeInTheDocument();
    });

    expect(
      screen.getByRole("button", { name: /Drag Alpha to reorder/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("1-2 of 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: /Move Alpha down/i }));

    await waitFor(() => {
      expect(pendingPuts).toHaveLength(2);
    });

    expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument();

    flushPendingPuts();

    await waitFor(() => {
      const rows = screen.getAllByRole("row").slice(1);
      expect(rows[0]).toHaveTextContent("Beta");
      expect(rows[1]).toHaveTextContent("Alpha");
    });
  });

  it("moves a page-boundary field using the server-side tenant ordering", async () => {
    const user = userEvent.setup();
    serverFields = Array.from({ length: 11 }, (_, index) => ({
      id: index + 1,
      label: `Field ${index + 1}`,
      fieldKey: `field_${index + 1}`,
      fieldType: "text",
      options: null,
      isRequired: false,
      displayOrder: index + 1,
    }));

    renderLeadFields();
    await waitFor(() => expect(screen.getByText("Field 10")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /Move Field 10 down/i }));

    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith("/api/lead-custom-fields/10/move", {
        method: "POST",
        body: JSON.stringify({ direction: "down" }),
      });
    });
    expect(sortedServerFields()[9].id).toBe(11);
    expect(sortedServerFields()[10].id).toBe(10);
  });
});
