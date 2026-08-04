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

const { setThemeMock } = vi.hoisted(() => ({ setThemeMock: vi.fn() }));
vi.mock("../App", () => {
  const React = require("react");
  return {
    ThemeContext: React.createContext({
      theme: "light",
      setTheme: setThemeMock,
      toggleTheme: () => {},
    }),
    AuthContext: React.createContext({ tenant: null, setTenant: () => {} }),
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
  serverFields = baseFields.map((field) => ({
    ...field,
    options: Array.isArray(field.options) ? [...field.options] : field.options,
  }));
  pendingPuts = [];

  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || "GET";

    if (url === "/api/lead-custom-fields" && method === "GET") {
      return Promise.resolve(
        sortedServerFields().map((field) => ({
          ...field,
          options: Array.isArray(field.options) ? [...field.options] : field.options,
        })),
      );
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

    return Promise.resolve([]);
  });
});

describe("<LeadFields />", () => {
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
});
