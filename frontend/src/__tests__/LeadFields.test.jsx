import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import FieldConfig from "../pages/settings/FieldConfig";

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
let serverFieldConfig = null;

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
  serverFieldConfig = null;
  resolvers.forEach((resolve) => resolve());
}

beforeEach(() => {
  window.localStorage.clear();
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

    if (url === "/api/table-column-prefs/leads" && method === "GET") {
      return Promise.resolve({
        availableColumns: [
          { key: "name", label: "Name", lockedVisible: true },
          { key: "email", label: "Email" },
          { key: "phone", label: "Phone" },
          { key: "company", label: "Company" },
          { key: "title", label: "Job Title" },
          { key: "source", label: "Source" },
          { key: "utm_source", label: "UTM Source" },
          { key: "actions", label: "Actions", lockedVisible: true },
        ],
        visible: ["name", "email", "phone", "company", "source", "actions"],
      });
    }

    if (url === "/api/tenant-settings/generic.fieldConfig" && method === "GET") {
      return Promise.resolve(serverFieldConfig ? { value: JSON.stringify(serverFieldConfig) } : {});
    }

    if (url === "/api/tenant-settings/generic.fieldConfig" && method === "PUT") {
      serverFieldConfig = JSON.parse(JSON.parse(opts.body).value);
      return Promise.resolve({ value: JSON.stringify(serverFieldConfig) });
    }

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

    if (url === "/api/lead-custom-fields" && method === "POST") {
      const body = JSON.parse(opts.body);
      const created = {
        id: Math.max(0, ...serverFields.map((field) => field.id)) + 1,
        fieldKey: body.label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""),
        displayOrder: serverFields.length + 1,
        options: null,
        ...body,
      };
      serverFields.push(created);
      return Promise.resolve(created);
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

    if (/^\/api\/lead-custom-fields\/\d+$/.test(url) && method === "DELETE") {
      const id = Number(url.split("/").pop());
      serverFields = serverFields.filter((field) => field.id !== id);
      return Promise.resolve({ success: true });
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
  it("renders the generic Field Config view with grouped built-in fields and search", async () => {
    authContextValue.tenant = { vertical: "generic" };
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <FieldConfig />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "Field Config" })).toBeInTheDocument();
    await screen.findByText("Alpha");
    expect(screen.getByRole("button", { name: "Basic Information" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Telephone Numbers" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Lead Details" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "UTM Tracker" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Email" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Company" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Account" })).not.toBeInTheDocument();
    await user.type(screen.getByRole("searchbox", { name: "Search fields" }), "phone");
    expect(screen.getByText("Phone")).toBeInTheDocument();
    expect(screen.queryByText("Email")).not.toBeInTheDocument();
    expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
  });

  it("restores collapsed generic groups after leaving and returning to Field Config", async () => {
    authContextValue.tenant = { id: 42, vertical: "generic" };
    const user = userEvent.setup();
    const firstRender = render(
      <MemoryRouter>
        <FieldConfig />
      </MemoryRouter>,
    );

    const basicInformation = await screen.findByRole("button", { name: "Basic Information" });
    await user.click(basicInformation);
    expect(basicInformation).toHaveAttribute("aria-expanded", "false");
    expect(window.localStorage.getItem("generic-field-config.collapsed-groups.v1.42"))
      .toBe('["Basic Information"]');

    firstRender.unmount();
    render(
      <MemoryRouter>
        <FieldConfig />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("button", { name: "Basic Information" }))
      .toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Name" })).not.toBeInTheDocument();
  });

  it("opens the built-in choices viewer in Generic CRM", async () => {
    authContextValue.tenant = { vertical: "generic" };
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <FieldConfig />
      </MemoryRouter>,
    );

    await screen.findByText("Source");
    await user.click(screen.getByRole("button", { name: "View choices" }));

    const dialog = screen.getByRole("dialog", { name: "Choices for Source" });
    expect(within(dialog).getByText("Organic")).toBeInTheDocument();
    expect(within(dialog).getByText("Website")).toBeInTheDocument();
    expect(within(dialog).getByText("Referral")).toBeInTheDocument();
    expect(within(dialog).getByText("Campaign")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Save" })).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Choices for Source" })).not.toBeInTheDocument();
  });

  it("persists built-in controls and new groups for the generic tenant", async () => {
    authContextValue.tenant = { vertical: "generic" };
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <FieldConfig />
      </MemoryRouter>,
    );

    await screen.findByText("Alpha");
    const fullNameRow = screen.getByRole("button", { name: "Name" }).closest(".field-config-row");
    await user.click(within(fullNameRow).getByRole("checkbox", { name: "Required" }));

    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith(
      "/api/tenant-settings/generic.fieldConfig",
      expect.objectContaining({ method: "PUT" }),
    ));

    await user.click(screen.getByRole("button", { name: "Add group" }));
    await user.type(screen.getByLabelText("Group name"), "Qualification");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Qualification" })).toBeInTheDocument());
  });

  it("warns admins to move fields before deleting a non-empty generic group", async () => {
    authContextValue.tenant = { vertical: "generic" };
    serverFieldConfig = {
      fieldOverrides: {},
      groupOrder: ["Basic Information", "Custom Fields", "group-hello"],
      groupNames: {},
      customGroups: [{ id: "group-hello", name: "Hello" }],
      customFieldGroups: { 1: "group-hello" },
      fieldOrder: {},
    };
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <FieldConfig />
      </MemoryRouter>,
    );

    await screen.findByText("Alpha");
    fetchApiMock.mockClear();
    await user.click(screen.getByRole("button", { name: "Delete Hello" }));

    expect(notifyObj.confirm).toHaveBeenCalledWith(expect.objectContaining({
      title: "Move fields before deleting this group",
      message: expect.stringMatching(/contains 1 field.*Move it to another group/i),
      confirmText: "Got it",
      destructive: true,
    }));
    expect(fetchApiMock).not.toHaveBeenCalledWith(
      "/api/tenant-settings/generic.fieldConfig",
      expect.objectContaining({ method: "PUT" }),
    );
    expect(screen.getByRole("region", { name: "Hello" })).toBeInTheDocument();
  });

  it("requires confirmation before deleting an empty generic group", async () => {
    authContextValue.tenant = { vertical: "generic" };
    serverFieldConfig = {
      fieldOverrides: {},
      groupOrder: ["Basic Information", "Custom Fields", "group-empty"],
      groupNames: {},
      customGroups: [{ id: "group-empty", name: "Empty group" }],
      customFieldGroups: {},
      fieldOrder: {},
    };
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <FieldConfig />
      </MemoryRouter>,
    );

    await screen.findByText("Alpha");
    await user.click(screen.getByRole("button", { name: "Delete Empty group" }));

    expect(notifyObj.confirm).toHaveBeenCalledWith(expect.objectContaining({
      title: "Delete this group?",
      message: expect.stringMatching(/Are you sure.*empty "Empty group" group/i),
      confirmText: "Delete group",
      destructive: true,
    }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Empty group" })).not.toBeInTheDocument());
    expect(serverFieldConfig.customGroups).toEqual([]);
    expect(serverFieldConfig.groupOrder).not.toContain("group-empty");
  });

  it("requires confirmation before deleting a generic custom field", async () => {
    authContextValue.tenant = { vertical: "generic" };
    const user = userEvent.setup();
    notifyObj.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    render(
      <MemoryRouter>
        <FieldConfig />
      </MemoryRouter>,
    );

    await screen.findByText("Alpha");
    await user.click(screen.getByRole("button", { name: "Alpha" }));
    const alphaRow = screen.getByRole("button", { name: "Alpha" }).closest(".field-config-row");
    await user.click(within(alphaRow).getByRole("button", { name: "Delete field" }));

    expect(fetchApiMock).not.toHaveBeenCalledWith("/api/lead-custom-fields/1", { method: "DELETE" });
    expect(screen.getByText("Alpha")).toBeInTheDocument();

    await user.click(within(alphaRow).getByRole("button", { name: "Delete field" }));
    expect(notifyObj.confirm).toHaveBeenLastCalledWith(expect.objectContaining({
      title: "Delete this field?",
      message: expect.stringContaining('The "Alpha" field will be removed'),
      confirmText: "Delete",
      destructive: true,
    }));
    await waitFor(() => expect(screen.queryByText("Alpha")).not.toBeInTheDocument());
  });

  it("uses the six-dot handle to persist built-in field order", async () => {
    authContextValue.tenant = { vertical: "generic" };

    render(
      <MemoryRouter>
        <FieldConfig />
      </MemoryRouter>,
    );

    await screen.findByText("Alpha");
    const source = screen.getByRole("button", { name: "Drag Name to move up or down" });
    const targetRow = screen.getByRole("button", { name: "Drag Company to move up or down" }).closest(".field-config-row");
    fireEvent.dragStart(source);
    fireEvent.dragOver(targetRow);
    fireEvent.drop(targetRow);

    await waitFor(() => {
      const saveCall = fetchApiMock.mock.calls.find(([url, options]) => {
        if (url !== "/api/tenant-settings/generic.fieldConfig" || options?.method !== "PUT") return false;
        const saved = JSON.parse(JSON.parse(options.body).value);
        return saved.fieldOrder?.["Basic Information"]?.join(",") === "email,company,name,title";
      });
      expect(saveCall).toBeTruthy();
    });
  });

  it("loads custom fields beyond the first 100", async () => {
    authContextValue.tenant = { vertical: "generic" };
    serverFields = Array.from({ length: 101 }, (_, index) => ({
      id: index + 1,
      label: `Existing Field ${index + 1}`,
      fieldKey: `existing_field_${index + 1}`,
      fieldType: "text",
      options: null,
      isRequired: false,
      displayOrder: index + 1,
    }));
    render(
      <MemoryRouter>
        <FieldConfig />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Existing Field 101")).toBeInTheDocument();
    expect(fetchApiMock).toHaveBeenCalledWith("/api/lead-custom-fields?page=2&offset=100&limit=100");
  });

  it("keeps a newly created field in its selected group", async () => {
    authContextValue.tenant = { vertical: "generic" };
    serverFieldConfig = {
      fieldOverrides: {},
      groupOrder: ["Basic Information", "Custom Fields", "group-hello"],
      groupNames: {},
      customGroups: [{ id: "group-hello", name: "Hello" }],
      customFieldGroups: { 1: "group-hello" },
    };
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <FieldConfig />
      </MemoryRouter>,
    );

    await screen.findByText("Alpha");
    const helloGroup = screen.getByRole("region", { name: "Hello" });
    const search = screen.getByRole("searchbox", { name: "Search fields" });
    await user.type(search, "hello");
    expect(within(helloGroup).getByText("Alpha")).toBeInTheDocument();
    await user.clear(search);
    await user.click(within(helloGroup).getByRole("button", { name: /Add field/i }));
    await user.type(screen.getByLabelText("Label"), "Hello Custom Field");
    await user.click(screen.getByRole("button", { name: "Save field" }));

    await waitFor(() => {
      expect(within(screen.getByRole("region", { name: "Hello" })).getByText("Hello Custom Field")).toBeInTheDocument();
    });
    const created = serverFields.find((field) => field.label === "Hello Custom Field");
    expect(serverFieldConfig.customFieldGroups[created.id]).toBe("group-hello");
  });

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
