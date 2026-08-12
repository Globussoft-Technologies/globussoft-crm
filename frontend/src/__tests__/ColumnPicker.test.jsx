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
});
