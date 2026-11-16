import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import CsvImportExportToolbar from "../components/wellness/CsvImportExportToolbar";
import * as XLSX from "xlsx";

const { fetchApiMock } = vi.hoisted(() => ({
  fetchApiMock: vi.fn(),
}));

const notify = {
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  confirm: vi.fn(),
};

const fetchMock = vi.fn();

vi.mock("../utils/api", () => ({
  fetchApi: fetchApiMock,
  getAuthToken: vi.fn(() => "test-token"),
}));

vi.mock("../utils/notify", () => ({
  useNotify: () => notify,
}));

beforeEach(() => {
  notify.error.mockReset();
  notify.success.mockReset();
  notify.info.mockReset();
  notify.confirm.mockReset();
  fetchMock.mockReset();
  fetchApiMock.mockReset();
  fetchApiMock.mockResolvedValue({
    headers: ["name"],
    thresholds: { rows: 5000, bytes: 5 * 1024 * 1024 },
  });
  vi.stubGlobal("fetch", fetchMock);

  if (typeof URL.createObjectURL !== "function") {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      writable: true,
      value: vi.fn(() => "blob:mock"),
    });
  } else {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock");
  }

  if (typeof URL.revokeObjectURL !== "function") {
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
  } else {
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("CsvImportExportToolbar", () => {
  it("renders default endpoints when no endpoint overrides are supplied", () => {
    render(<CsvImportExportToolbar entity="bookings" label="Bookings" />);

    expect(screen.getByRole("button", { name: /Export Bookings as CSV/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Import Bookings/i })).toBeInTheDocument();
  });

  it("uses endpoint overrides when provided", () => {
    render(
      <CsvImportExportToolbar
        entity="contacts"
        label="Contacts"
        endpoints={{
          export: "/custom/export.csv",
          template: "/custom/template.csv",
          meta: "/custom/meta",
          import: "/custom/import.csv",
          importAsync: "/custom/import-async",
          job: (jobId) => `/custom/jobs/${jobId}`,
        }}
      />,
    );

    expect(screen.getByRole("button", { name: /Export Contacts as CSV/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Import Contacts/i })).toBeInTheDocument();
  });

  it("uses the default label map for the wellness inventory entities", () => {
    render(<CsvImportExportToolbar entity="product-categories" />);

    expect(screen.getByRole("button", { name: /^Export Product Categories as CSV$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Import Product Categories$/i })).toBeInTheDocument();
  });

  it("adds a leading question mark when exporting multi-format CSV and XLSX", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      blob: async () => new Blob(["name\nexample\n"], { type: "text/csv" }),
    });

    render(
      <CsvImportExportToolbar
        entity="product-categories"
        label="Product Categories"
        formats={["csv", "xlsx"]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^Export Product Categories$/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Excel \(XLSX\)$/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/wellness/csv/product-categories/export?format=xlsx",
        expect.objectContaining({
          headers: { Authorization: "Bearer test-token" },
        }),
      );
    });
  });

  it("keeps export and import menus inside a narrow viewport", () => {
    const viewportWidth = Object.getOwnPropertyDescriptor(window, "innerWidth");
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 320 });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      left: 36,
      right: 128,
      top: 40,
      bottom: 72,
      width: 92,
      height: 32,
      x: 36,
      y: 40,
      toJSON: () => ({}),
    });

    try {
      render(
        <CsvImportExportToolbar
          entity="contacts"
          label="Contacts"
          formats={["csv", "xlsx"]}
          genericLeadWizard
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: /^Export Contacts$/i }));
      const exportMenu = screen.getByRole("menu", { name: /Export Contacts format/i });
      expect(exportMenu).toHaveStyle({ position: "fixed" });
      expect(Number.parseFloat(exportMenu.style.left)).toBeGreaterThanOrEqual(8);
      expect(Number.parseFloat(exportMenu.style.left) + Number.parseFloat(exportMenu.style.width)).toBeLessThanOrEqual(312);

      fireEvent.click(screen.getByRole("button", { name: "Import Contacts options" }));
      const importMenu = screen.getByRole("menu", { name: "Import Contacts options" });
      expect(importMenu).toHaveStyle({ position: "fixed" });
      expect(Number.parseFloat(importMenu.style.left) + Number.parseFloat(importMenu.style.width)).toBeLessThanOrEqual(312);
    } finally {
      if (viewportWidth) Object.defineProperty(window, "innerWidth", viewportWidth);
    }
  });

  it("renders export-only when allowImport is false", () => {
    render(
      <CsvImportExportToolbar entity="attendance" label="Attendance" allowImport={false} />,
    );

    expect(screen.getByRole("button", { name: /Export Attendance as CSV/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Import Attendance$/i })).toBeNull();
  });

  it("renders a theme-safe file picker in the import modal", async () => {
    render(
      <CsvImportExportToolbar
        entity="product-categories"
        label="Product Categories"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^Import Product Categories$/i }));

    expect(await screen.findByRole("dialog", { name: /Import Product Categories from CSV/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Choose CSV file/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Download CSV template/i })).toBeInTheDocument();
  });

  it("allows selecting the field type in the Generic lead mapping wizard", async () => {
    render(
      <CsvImportExportToolbar
        entity="contacts"
        label="Contacts"
        genericLeadWizard
        mappingFields={[{ key: "email", fieldKey: "email", label: "Email", fieldType: "text" }]}
        endpoints={{ import: "/api/csv/contacts/import.csv" }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^Import Contacts$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Next$/i }));

    const file = new File(["email\ntest@example.com\n"], "contacts.csv", { type: "text/csv" });
    Object.defineProperty(file, "text", { value: vi.fn().mockResolvedValue("email\ntest@example.com\n") });
    fireEvent.change(screen.getByLabelText("Select CSV file"), { target: { files: [file] } });

    expect(await screen.findByText("Review the mapping of your fields")).toBeInTheDocument();
    expect(screen.getByTestId("import-sample-email")).toHaveTextContent("test@example.com");
    expect(screen.queryByText(/Missing required column\(s\): name/i)).not.toBeInTheDocument();
    const fieldType = screen.getByRole("combobox", { name: "Field type for email" });
    expect(fieldType).toHaveValue("text");
    expect(fieldType).toHaveTextContent("Dropdown");
    fireEvent.change(fieldType, { target: { value: "dropdown" } });
    expect(fieldType).toHaveValue("dropdown");
  });

  it("hides unchecked Generic CRM columns from the mapping preview", async () => {
    render(
      <CsvImportExportToolbar
        entity="contacts"
        label="Contacts"
        genericLeadWizard
        mappingFields={[
          { key: "email", fieldKey: "email", label: "Email", fieldType: "text" },
          { key: "company", fieldKey: "company", label: "Company", fieldType: "text" },
        ]}
        endpoints={{ import: "/api/csv/contacts/import.csv" }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^Import Contacts$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Next$/i }));
    const csv = "email,company\ntest@example.com,Acme\n";
    const file = new File([csv], "contacts.csv", { type: "text/csv" });
    Object.defineProperty(file, "text", { value: vi.fn().mockResolvedValue(csv) });
    fireEvent.change(screen.getByLabelText("Select CSV file"), { target: { files: [file] } });

    expect(await screen.findByRole("checkbox", { name: "Import company" })).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "Import company" }));

    expect(screen.getByRole("checkbox", { name: "Import company" })).not.toBeChecked();
    expect(screen.getByRole("combobox", { name: "CRM field for company" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Go to next page to see preview" }));
    expect(await screen.findByText(/Preview \(first/i)).toBeInTheDocument();
    expect(screen.queryByText("Acme")).not.toBeInTheDocument();
    expect(screen.getByText("test@example.com")).toBeInTheDocument();
  });

  it("expands scientific notation in the mapping sample without changing the uploaded value", async () => {
    render(<CsvImportExportToolbar entity="contacts" label="Contacts" genericLeadWizard skipMeta
      mappingFields={[{ key: "id", fieldKey: "id", label: "Id", fieldType: "text" }]}
      endpoints={{ import: "/api/csv/contacts/import.csv" }} />);

    fireEvent.click(screen.getByRole("button", { name: /^Import Contacts$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Next$/i }));
    const csv = "Id\n4.02196E+11\n";
    const file = new File([csv], "contacts.csv", { type: "text/csv" });
    Object.defineProperty(file, "text", { value: vi.fn().mockResolvedValue(csv) });
    fireEvent.change(screen.getByLabelText("Select CSV file"), { target: { files: [file] } });

    const sample = await screen.findByTestId("import-sample-Id");
    expect(sample).toHaveTextContent("402196000000");
    expect(sample).not.toHaveTextContent("4.02196E+11");
  });

  it("puts Add new field above CRM fields and prefills an editable CSV column name for Generic CRM", async () => {
    render(
      <CsvImportExportToolbar
        entity="contacts"
        label="Contacts"
        genericLeadWizard
        mappingFields={[{ key: "email", fieldKey: "email", label: "Email", fieldType: "text" }]}
        endpoints={{ import: "/api/csv/contacts/import.csv" }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^Import Contacts$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Next$/i }));

    const file = new File(["Department\nSales\n"], "contacts.csv", { type: "text/csv" });
    Object.defineProperty(file, "text", { value: vi.fn().mockResolvedValue("Department\nSales\n") });
    fireEvent.change(screen.getByLabelText("Select CSV file"), { target: { files: [file] } });

    expect(await screen.findByText("Review the mapping of your fields")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Import Department" })).not.toBeChecked();
    const crmFieldDropdown = screen.getByRole("combobox", { name: "CRM field for Department" });
    const options = Array.from(crmFieldDropdown.options).map((option) => option.textContent);
    expect(options.slice(0, 3)).toEqual(["Choose CRM field", "＋ Add new field", "Email"]);
    expect(screen.getByText("＋ Department (new field)").closest("div")).toHaveAttribute("data-proposed-field", "true");

    fireEvent.click(screen.getByRole("button", { name: "Edit proposed CRM field Department" }));
    expect(await screen.findByRole("dialog", { name: "Edit field" })).toBeInTheDocument();
    const labelInput = await screen.findByRole("textbox", { name: "New CRM field label" });
    expect(labelInput).toHaveValue("Department");

    fireEvent.change(labelInput, { target: { value: "Customer department" } });
    expect(labelInput).toHaveValue("Customer department");

    fetchApiMock.mockResolvedValueOnce({
      id: 17,
      fieldKey: "customer_department",
      label: "Customer department",
      fieldType: "text",
    });
    fireEvent.click(screen.getByRole("button", { name: "Save field" }));

    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith("/api/lead-custom-fields", {
        method: "POST",
        body: JSON.stringify({
          label: "Customer department",
          fieldType: "text",
          isRequired: false,
        }),
      });
      expect(screen.getByRole("combobox", { name: "CRM field for Department" })).toHaveValue("customer_department");
    });
    expect(screen.queryByRole("button", { name: "Edit proposed CRM field Department" })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Customer department" })).toBeInTheDocument();
  });

  it("sorts CRM fields alphabetically and filters them with the mapping search", async () => {
    render(<CsvImportExportToolbar entity="contacts" label="Contacts" genericLeadWizard skipMeta
      mappingFields={[
        { key: "zeta", fieldKey: "zeta", label: "Zeta", fieldType: "text" },
        { key: "alpha", fieldKey: "alpha", label: "Alpha", fieldType: "text" },
        { key: "email", fieldKey: "email", label: "Email", fieldType: "text" },
      ]}
      endpoints={{ import: "/api/csv/contacts/import.csv" }} />);

    fireEvent.click(screen.getByRole("button", { name: /^Import Contacts$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Next$/i }));
    const csv = "Email\nsales@example.com\n";
    const file = new File([csv], "contacts.csv", { type: "text/csv" });
    Object.defineProperty(file, "text", { value: vi.fn().mockResolvedValue(csv) });
    fireEvent.change(screen.getByLabelText("Select CSV file"), { target: { files: [file] } });

    const dropdown = await screen.findByRole("combobox", { name: "CRM field for Email" });
    expect(Array.from(dropdown.options).map((option) => option.textContent).slice(0, 4)).toEqual([
      "Select CRM field", "＋ Add new field", "Alpha", "Email",
    ]);
    fireEvent.click(dropdown.parentElement.querySelector("button"));
    const listbox = screen.getByRole("listbox", { name: "CRM field for Email options" });
    fireEvent.change(within(listbox).getByRole("searchbox", { name: "CRM field for Email search" }), { target: { value: "zeta" } });
    expect(within(listbox).getByRole("option", { name: "Zeta" })).toBeInTheDocument();
    expect(within(listbox).queryByRole("option", { name: "Alpha" })).not.toBeInTheDocument();
  });

  it("reuses an existing custom field whose key matches an automatic tracking key", async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === "/api/lead-custom-fields") {
        return Promise.resolve([
          { id: 17, fieldKey: "utm_term", label: "UTM Term", fieldType: "text" },
        ]);
      }
      return Promise.resolve({});
    });

    render(
      <CsvImportExportToolbar
        entity="contacts"
        label="Contacts"
        genericLeadWizard
        mappingFields={[]}
        endpoints={{ import: "/api/csv/contacts/import.csv" }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^Import Contacts$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Next$/i }));

    const file = new File(["UTM Term\nkeyword\n"], "contacts.csv", { type: "text/csv" });
    Object.defineProperty(file, "text", { value: vi.fn().mockResolvedValue("UTM Term\nkeyword\n") });
    fireEvent.change(screen.getByLabelText("Select CSV file"), { target: { files: [file] } });

    expect(await screen.findByText("Review the mapping of your fields")).toBeInTheDocument();
    expect(screen.queryByText("＋ UTM Term (new field)")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "CRM field for UTM Term" })).toHaveValue("utm_term");
  });

  it("opens the existing-field list from the proposed field dropdown without opening the editor", async () => {
    render(
      <CsvImportExportToolbar
        entity="contacts"
        label="Contacts"
        genericLeadWizard
        mappingFields={[{ key: "email", fieldKey: "email", label: "Email", fieldType: "text" }]}
        endpoints={{ import: "/api/csv/contacts/import.csv" }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^Import Contacts$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Next$/i }));
    const file = new File(["Work\nOffice\n"], "contacts.csv", { type: "text/csv" });
    Object.defineProperty(file, "text", { value: vi.fn().mockResolvedValue("Work\nOffice\n") });
    fireEvent.change(screen.getByLabelText("Select CSV file"), { target: { files: [file] } });

    expect(await screen.findByRole("button", { name: "Edit proposed CRM field Work" })).toBeInTheDocument();
    const dropdown = screen.getByRole("combobox", { name: "CRM field for Work" });
    expect(dropdown.parentElement.querySelector("svg")).toBeInTheDocument();
    fireEvent.change(dropdown, { target: { value: "email" } });

    expect(screen.queryByRole("dialog", { name: "Add new field" })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "CRM field for Work" })).toHaveValue("email");
  });

  it("automatically remaps a repeated spreadsheet column when its saved custom field finishes loading", async () => {
    let resolveSavedFields;
    fetchApiMock.mockImplementation((url) => {
      if (url === "/api/lead-custom-fields") {
        return new Promise((resolve) => { resolveSavedFields = resolve; });
      }
      return Promise.resolve({});
    });

    render(
      <CsvImportExportToolbar
        entity="contacts"
        label="Contacts"
        genericLeadWizard
        skipMeta
        mappingFields={[{ key: "name", fieldKey: "name", label: "Name", fieldType: "text" }]}
        endpoints={{ import: "/api/csv/contacts/import.csv" }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^Import Contacts$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Next$/i }));
    const file = new File(["name,,Department\nAsha Patel,ignored,Sales\n"], "contacts.csv", { type: "text/csv" });
    Object.defineProperty(file, "text", { value: vi.fn().mockResolvedValue("name,,Department\nAsha Patel,ignored,Sales\n") });
    fireEvent.change(screen.getByLabelText("Select CSV file"), { target: { files: [file] } });

    expect(await screen.findByRole("button", { name: "Edit proposed CRM field Department" })).toBeInTheDocument();

    await act(async () => {
      resolveSavedFields([{ id: 31, fieldKey: "department", label: "Department", fieldType: "text" }]);
    });

    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "CRM field for Department" })).toHaveValue("department");
    });
    expect(screen.queryByRole("button", { name: "Edit proposed CRM field Department" })).not.toBeInTheDocument();
  });

  it("leaves non-exact Generic CRM headers unmapped and unchecked", async () => {
    render(
      <CsvImportExportToolbar
        entity="contacts"
        label="Contacts"
        genericLeadWizard
        skipMeta
        mappingFields={[{ key: "phone", fieldKey: "phone", label: "Phone", fieldType: "text" }]}
        endpoints={{ import: "/api/csv/contacts/import.csv" }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^Import Contacts$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Next$/i }));
    const file = new File(["Mobile\n+919876543210\n"], "contacts.csv", { type: "text/csv" });
    Object.defineProperty(file, "text", { value: vi.fn().mockResolvedValue("Mobile\n+919876543210\n") });
    fireEvent.change(screen.getByLabelText("Select CSV file"), { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByRole("checkbox", { name: "Import Mobile" })).not.toBeChecked();
      expect(screen.getByLabelText("Unmapped Mobile")).toBeInTheDocument();
    });
    expect(screen.getByRole("combobox", { name: "CRM field for Mobile" })).toHaveValue("");
  });

  it("imports selected Generic CRM columns while skipping unchecked columns", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ imported: 1, errors: [] }) });
    render(
      <CsvImportExportToolbar
        entity="contacts"
        label="Contacts"
        genericLeadWizard
        skipMeta
        mappingFields={[{ key: "name", fieldKey: "name", label: "Name", fieldType: "text" }]}
        endpoints={{ import: "/api/csv/contacts/import.csv" }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^Import Contacts$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Next$/i }));
    const csv = "name,Mobile\nAsha Patel,+919876543210\n";
    const file = new File([csv], "contacts.csv", { type: "text/csv" });
    Object.defineProperty(file, "text", { value: vi.fn().mockResolvedValue(csv) });
    fireEvent.change(screen.getByLabelText("Select CSV file"), { target: { files: [file] } });

    expect(await screen.findByRole("checkbox", { name: "Import Mobile" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Go to next page to see preview" }));
    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/csv/contacts/import.csv",
      expect.objectContaining({ method: "POST" }),
    ));
    const form = fetchMock.mock.calls[0][1].body;
    expect(form.get("mapping")).toBe(JSON.stringify({ name: "name" }));
  });

  it("creates proposed Generic columns in the database before importing their values", async () => {
    fetchApiMock.mockImplementation((url, options) => {
      if (url === "/api/lead-custom-fields" && options?.method === "POST") {
        const payload = JSON.parse(options.body);
        return Promise.resolve({ id: payload.label === "Department" ? 44 : 45, fieldKey: payload.label === "Department" ? "department" : "unnamed_2", label: payload.label, fieldType: "text" });
      }
      if (url === "/api/lead-custom-fields") return Promise.resolve([]);
      return Promise.resolve({});
    });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ imported: 1, updated: 0, skipped: 0, errors: [], importedContacts: [] }),
    });

    render(
      <CsvImportExportToolbar
        entity="contacts"
        label="Contacts"
        genericLeadWizard
        skipMeta
        mappingFields={[{ key: "name", fieldKey: "name", label: "Name", fieldType: "text" }]}
        endpoints={{ import: "/api/csv/contacts/import.csv" }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^Import Contacts$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Next$/i }));
    const file = new File(["name,,Department\nAsha Patel,ignored,Sales\n"], "contacts.csv", { type: "text/csv" });
    Object.defineProperty(file, "text", { value: vi.fn().mockResolvedValue("name,,Department\nAsha Patel,ignored,Sales\n") });
    fireEvent.change(screen.getByLabelText("Select CSV file"), { target: { files: [file] } });

    expect(await screen.findByRole("button", { name: "Edit proposed CRM field Department" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Import Department" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Import Unnamed: 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Go to next page to see preview" }));
    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith("/api/lead-custom-fields", {
        method: "POST",
        body: JSON.stringify({ label: "Department", fieldType: "text", isRequired: false }),
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/csv/contacts/import.csv",
        expect.objectContaining({ method: "POST" }),
      );
    });

    const createFieldCalls = fetchApiMock.mock.calls.filter(
      ([url, options]) => url === "/api/lead-custom-fields" && options?.method === "POST",
    );
    expect(createFieldCalls).toHaveLength(2);

    const importOptions = fetchMock.mock.calls.find(([url]) => url === "/api/csv/contacts/import.csv")[1];
    expect(JSON.parse(importOptions.body.get("mapping"))).toEqual({
      name: "name",
      Department: "department",
      "Unnamed: 2": "unnamed_2",
    });
  });

  it.each(['csv', 'xlsx'])("uses all %s rows and preserves blank-column alignment when creating dropdown options", async (format) => {
    fetchApiMock.mockImplementation((url, options) => {
      if (options?.method === 'POST') {
        const payload = JSON.parse(options.body);
        return Promise.resolve(payload.label === 'Tier'
          ? { id: 44, fieldKey: 'tier', fieldType: 'dropdown' }
          : { id: 45, fieldKey: 'unnamed_2', fieldType: 'text' });
      }
      return Promise.resolve([]);
    });
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ imported: 11, errors: [] }) });
    render(<CsvImportExportToolbar entity="contacts" label="Contacts" genericLeadWizard skipMeta
      mappingFields={[{ fieldKey: 'name', label: 'Name', fieldType: 'text' }]}
      endpoints={{ import: '/api/csv/contacts/import.csv' }} />);
    fireEvent.click(screen.getByRole('button', { name: /^Import Contacts$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Next$/i }));
    const rows = [['name', '', 'Tier'], ...Array.from({ length: 11 }, (_, index) =>
      ['Asha Patel', 'ignored', index === 10 ? 'Silver' : 'Gold'])];
    let file;
    if (format === 'xlsx') {
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Leads');
      const buffer = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
      file = new File([buffer], 'leads.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      Object.defineProperty(file, 'arrayBuffer', { value: async () => buffer });
    } else {
      const csv = rows.map(row => row.join(',')).join('\n');
      file = new File([csv], 'leads.csv', { type: 'text/csv' });
      Object.defineProperty(file, 'text', { value: async () => csv });
    }
    fireEvent.change(screen.getByLabelText('Select CSV file'), { target: { files: [file] } });
    const type = await screen.findByRole('combobox', { name: 'Field type for Tier' });
    expect(screen.getAllByText('ignored').length).toBeGreaterThan(0);
    expect(screen.queryByText('Silver')).not.toBeInTheDocument(); // Outside the preview.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Import Unnamed: 2' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Import Tier' }));
    fireEvent.change(type, { target: { value: 'dropdown' } });
    fireEvent.click(screen.getByRole('button', { name: 'Go to next page to see preview' }));
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith('/api/lead-custom-fields', {
      method: 'POST', body: JSON.stringify({ label: 'Tier', fieldType: 'dropdown', isRequired: false, options: ['Gold', 'Silver'] }),
    }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/csv/contacts/import.csv', expect.anything()));
    const payload = fetchMock.mock.calls.find(([url]) => url === '/api/csv/contacts/import.csv')[1].body;
    expect(JSON.parse(payload.get('mapping'))).toEqual({ name: 'name', 'Unnamed: 2': expect.any(String), Tier: 'tier' });
  });

  it("explains when an XLSX has data in the first row instead of headers", async () => {
    fetchApiMock.mockResolvedValue([]);
    render(<CsvImportExportToolbar entity="contacts" label="Contacts" formats={['csv', 'xlsx']} genericLeadWizard skipMeta
      endpoints={{ import: '/api/csv/contacts/import.csv' }} />);
    fireEvent.click(screen.getByRole('button', { name: /^Import Contacts$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Next$/i }));

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      ['12006225923', 'Abdellah', 'Afif'],
      ['12006225924', 'Dask', 'Kdkaskd'],
    ]), 'Leads');
    const buffer = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
    const file = new File([buffer], 'leads.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    Object.defineProperty(file, 'arrayBuffer', { value: async () => buffer });
    fireEvent.change(screen.getByLabelText('Select CSV or Excel file'), { target: { files: [file] } });

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Import 12006225923' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Go to next page to see preview' }));
    expect(await screen.findByText(/Invalid or missing column headers/)).toBeInTheDocument();
    expect(screen.getByText(/first row must contain column names/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fetchApiMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  });

  it('rejects option sets over the API limit rather than silently dropping values', async () => {
    fetchApiMock.mockResolvedValue([]);
    render(<CsvImportExportToolbar entity="contacts" label="Contacts" genericLeadWizard skipMeta
      endpoints={{ import: '/api/csv/contacts/import.csv' }} />);
    fireEvent.click(screen.getByRole('button', { name: /^Import Contacts$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Next$/i }));
    const csv = 'Tier\n' + Array.from({ length: 51 }, (_, i) => 'Tier ' + i).join('\n');
    const file = new File([csv], 'leads.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: async () => csv });
    fireEvent.change(screen.getByLabelText('Select CSV file'), { target: { files: [file] } });
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Import Tier' }));
    fireEvent.change(await screen.findByRole('combobox', { name: 'Field type for Tier' }), { target: { value: 'dropdown' } });
    fireEvent.click(screen.getByRole('button', { name: 'Go to next page to see preview' }));
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith(expect.stringMatching(/more than 50 options/)));
    expect(fetchApiMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps required-column validation for non-Generic imports", async () => {
    render(
      <CsvImportExportToolbar
        entity="contacts"
        label="Contacts"
        expectedHeaders={["name"]}
        skipMeta
        endpoints={{ import: "/api/csv/contacts/import.csv" }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^Import Contacts$/i }));
    const file = new File(["email\ntest@example.com\n"], "contacts.csv", { type: "text/csv" });
    Object.defineProperty(file, "text", { value: vi.fn().mockResolvedValue("email\ntest@example.com\n") });
    fireEvent.change(screen.getByLabelText("Select CSV file"), { target: { files: [file] } });

    expect(await screen.findByText("Missing required column(s): name")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm import" })).toBeDisabled();
  });
});
