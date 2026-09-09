import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import ColumnPicker from "../components/ColumnPicker";

const fetchApiMock = vi.fn();
vi.mock("../utils/api", () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

const notifyError = vi.fn();
vi.mock("../utils/notify", () => ({
  useNotify: () => ({
    error: notifyError,
    info: vi.fn(),
    success: vi.fn(),
  }),
}));

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyError.mockReset();
  fetchApiMock.mockImplementation((url, opts) => {
    if (url === "/api/table-column-prefs/leads" && !opts) {
      return Promise.resolve({
        availableColumns: [
          { key: "name", label: "Name" },
          { key: "email", label: "Email" },
          { key: "phone", label: "Phone" },
          { key: "company", label: "Company" },
          { key: "aiScore", label: "Lead Score" },
          { key: "source", label: "Source" },
          { key: "assignedTo", label: "Assigned To" },
          { key: "createdAt", label: "Created" },
          { key: "cf_priority", label: "Priority" },
        ],
        visible: [
          "name",
          "email",
          "phone",
          "company",
          "aiScore",
          "source",
          "assignedTo",
          "createdAt",
        ],
      });
    }
    if (url === "/api/table-column-prefs/leads" && opts?.method === "PUT") {
      return Promise.resolve({ visible: JSON.parse(opts.body).visible });
    }
    return Promise.resolve([]);
  });
});

describe("ColumnPicker reorder", () => {
  it("lets users drag visible columns into a new order and saves that order", async () => {
    const onColumnsChange = vi.fn();
    render(<ColumnPicker tableKey="leads" onColumnsChange={onColumnsChange} />);

    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith("/api/table-column-prefs/leads");
    });

    fireEvent.click(screen.getByRole("button", { name: /Customize table/i }));
    const dialog = await screen.findByRole("dialog", { name: "Customize table columns" });

    expect(
      [...dialog.querySelectorAll("[data-column-row]")].map((node) =>
        node.getAttribute("data-column-row"),
      ),
    ).toEqual([
      "name",
      "email",
      "phone",
      "company",
      "aiScore",
      "source",
      "assignedTo",
      "createdAt",
    ]);

    const dataTransfer = {
      effectAllowed: "all",
      dropEffect: "none",
      setData: vi.fn(),
      getData: vi.fn(),
    };

    fireEvent.dragStart(screen.getByRole("button", { name: "Drag Created column" }), {
      dataTransfer,
    });

    const sourceRow = dialog.querySelector('[data-column-row="source"]');
    fireEvent.dragOver(sourceRow, { dataTransfer });
    fireEvent.drop(sourceRow, { dataTransfer });
    fireEvent.dragEnd(screen.getByRole("button", { name: "Drag Created column" }), {
      dataTransfer,
    });

    expect(
      [...dialog.querySelectorAll("[data-column-row]")].map((node) =>
        node.getAttribute("data-column-row"),
      ),
    ).toEqual([
      "name",
      "email",
      "phone",
      "company",
      "aiScore",
      "createdAt",
      "source",
      "assignedTo",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith(
        "/api/table-column-prefs/leads",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({
            visible: [
              "name",
              "email",
              "phone",
              "company",
              "aiScore",
              "createdAt",
              "source",
              "assignedTo",
            ],
          }),
        }),
      );
    });

    expect(onColumnsChange).toHaveBeenCalledWith([
      "name",
      "email",
      "phone",
      "company",
      "aiScore",
      "createdAt",
      "source",
      "assignedTo",
    ]);
  });

  it("lists a locked Actions column as fixed even when older saved prefs omit it", async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === "/api/table-column-prefs/leads" && !opts) {
        return Promise.resolve({
          availableColumns: [
            { key: "name", label: "Name", lockedVisible: true },
            { key: "email", label: "Email" },
            { key: "actions", label: "Actions", lockedVisible: true },
          ],
          // Saved before the Actions entry existed — no "actions" key.
          visible: ["name", "email"],
        });
      }
      if (url === "/api/table-column-prefs/leads" && opts?.method === "PUT") {
        return Promise.resolve({ visible: JSON.parse(opts.body).visible });
      }
      return Promise.resolve([]);
    });

    render(<ColumnPicker tableKey="leads" />);

    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith("/api/table-column-prefs/leads");
    });

    fireEvent.click(screen.getByRole("button", { name: /Customize table/i }));
    const dialog = await screen.findByRole("dialog", { name: "Customize table columns" });

    // Actions appears under "Shown in table" despite being absent from visible.
    expect(
      [...dialog.querySelectorAll("[data-column-row]")].map((node) =>
        node.getAttribute("data-column-row"),
      ),
    ).toEqual(["name", "email", "actions"]);

    const actionsRow = dialog.querySelector('[data-column-row="actions"]');
    const checkbox = actionsRow.querySelector('input[type="checkbox"]');
    expect(checkbox.checked).toBe(true);
    expect(checkbox.disabled).toBe(true);
  });

  it("resets the generic leads table to the default column set only", async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === "/api/table-column-prefs/leads" && !opts) {
        return Promise.resolve({
          availableColumns: [
            { key: "name", label: "Name", lockedVisible: true },
            { key: "email", label: "Email" },
            { key: "phone", label: "Phone" },
            { key: "company", label: "Company" },
            { key: "aiScore", label: "Lead Score" },
            { key: "source", label: "Source" },
            { key: "webForm", label: "Web Form" },
            { key: "tags", label: "Tags" },
            { key: "assignedTo", label: "Assigned To" },
            { key: "createdAt", label: "Created" },
            { key: "status", label: "Status" },
            { key: "lastUpdated", label: "Last Updated" },
            { key: "companySize", label: "No Of Employee" },
            { key: "cf_priority", label: "Priority" },
            { key: "actions", label: "Actions", lockedVisible: true },
          ],
          visible: [
            "name",
            "email",
            "phone",
            "company",
            "aiScore",
            "source",
            "webForm",
            "tags",
            "assignedTo",
            "createdAt",
            "status",
            "lastUpdated",
            "companySize",
            "cf_priority",
            "actions",
          ],
        });
      }
      if (url === "/api/table-column-prefs/leads" && opts?.method === "PUT") {
        return Promise.resolve({ visible: JSON.parse(opts.body).visible });
      }
      return Promise.resolve([]);
    });

    render(<ColumnPicker tableKey="leads" />);

    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith("/api/table-column-prefs/leads");
    });

    fireEvent.click(screen.getByRole("button", { name: /Customize table/i }));
    await screen.findByRole("dialog", { name: "Customize table columns" });

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith(
        "/api/table-column-prefs/leads",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({
            visible: [
              "name",
              "phone",
              "email",
              "company",
              "source",
              "webForm",
              "createdAt",
              "lastUpdated",
              "companySize",
              "actions",
            ],
          }),
        }),
      );
    });
  });
});
