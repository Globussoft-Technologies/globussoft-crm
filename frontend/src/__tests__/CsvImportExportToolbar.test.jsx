import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import CsvImportExportToolbar from "../components/wellness/CsvImportExportToolbar";

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
    expect(screen.queryByText(/Missing required column\(s\): name/i)).not.toBeInTheDocument();
    const fieldType = screen.getByRole("combobox", { name: "Field type for email" });
    expect(fieldType).toHaveValue("text");
    expect(fieldType).toHaveTextContent("Dropdown");
    fireEvent.change(fieldType, { target: { value: "dropdown" } });
    expect(fieldType).toHaveValue("dropdown");
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

  it("maps Mobile to the core phone field so repeated imports can update by phone", async () => {
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
      expect(screen.getByRole("combobox", { name: "CRM field for Mobile" })).toHaveValue("phone");
    });
    expect(screen.queryByRole("button", { name: "Edit proposed CRM field Mobile" })).not.toBeInTheDocument();
  });

  it("creates proposed Generic columns in the database before importing their values", async () => {
    fetchApiMock.mockImplementation((url, options) => {
      if (url === "/api/lead-custom-fields" && options?.method === "POST") {
        return Promise.resolve({ id: 44, fieldKey: "department", label: "Department", fieldType: "text" });
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
    fireEvent.click(screen.getByRole("button", { name: "Confirm import" }));

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
    expect(createFieldCalls).toHaveLength(1);

    const importOptions = fetchMock.mock.calls.find(([url]) => url === "/api/csv/contacts/import.csv")[1];
    expect(JSON.parse(importOptions.body.get("mapping"))).toEqual({
      name: "name",
      Department: "department",
    });
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
