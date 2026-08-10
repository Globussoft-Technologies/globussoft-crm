import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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
});
