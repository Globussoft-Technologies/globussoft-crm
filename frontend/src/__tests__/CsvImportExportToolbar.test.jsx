import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import CsvImportExportToolbar from "../components/wellness/CsvImportExportToolbar";

const notify = {
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  confirm: vi.fn(),
};

vi.mock("../utils/api", () => ({
  fetchApi: vi.fn(),
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
});