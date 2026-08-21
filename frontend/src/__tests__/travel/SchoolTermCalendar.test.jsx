import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import SchoolTermCalendar from "../../pages/travel/SchoolTermCalendar";

vi.mock("../../utils/api", () => ({
  fetchApi: vi.fn(),
  getAuthToken: vi.fn(() => "fake-token"),
}));

const notify = {
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  confirm: vi.fn(() => Promise.resolve(true)),
  prompt: vi.fn(() => Promise.resolve("")),
};

vi.mock("../../utils/notify", () => ({
  useNotify: () => notify,
}));

import { fetchApi } from "../../utils/api";

const termRows = [
  { id: 2, schoolName: "", board: "ICSE", kind: "exam-blackout", label: "PTM Week", startDate: "2027-03-19", endDate: "2027-03-23" },
  { id: 1, schoolName: "Bulk School 7", board: "CBSE", kind: "holiday", label: "Annual Exams", startDate: "2027-02-17", endDate: "2027-02-27" },
  { id: 3, schoolName: "", board: "CBSE", kind: "exam-blackout", label: "CBSE Board Exams (Class 10/12) - tentative", startDate: "2027-02-15", endDate: "2027-03-25" },
];

function mockListEndpoints() {
  fetchApi.mockImplementation((url) => {
    if (String(url).startsWith("/api/travel-school-terms/uploads")) {
      return Promise.resolve({ uploads: [] });
    }
    if (String(url).startsWith("/api/travel-school-terms?")) {
      return Promise.resolve([...termRows]);
    }
    if (String(url).startsWith("/api/travel-school-terms/check?")) {
      return Promise.resolve({ status: "unknown" });
    }
    return Promise.reject(new Error(`Unexpected fetch: ${String(url)}`));
  });
}

beforeEach(() => {
  fetchApi.mockReset();
  notify.success.mockReset();
  notify.error.mockReset();
  notify.info.mockReset();
  notify.confirm.mockReset();
  notify.confirm.mockImplementation(() => Promise.resolve(true));
  notify.prompt.mockReset();
  notify.prompt.mockImplementation(() => Promise.resolve(""));
  mockListEndpoints();
});

describe("<SchoolTermCalendar />", () => {
  it("sorts the From column newest-first by default and toggles when clicked", async () => {
    const { container } = render(<SchoolTermCalendar />);

    await waitFor(() => expect(fetchApi).toHaveBeenCalled());
    expect(await screen.findByText("PTM Week")).toBeInTheDocument();

    const getLabelOrder = () =>
      Array.from(container.querySelectorAll("tbody tr")).map((row) => row.children[3].textContent);

    expect(getLabelOrder()).toEqual([
      "PTM Week",
      "Annual Exams",
      "CBSE Board Exams (Class 10/12) - tentative",
    ]);

    fireEvent.click(screen.getByRole("button", { name: /sort from/i }));

    expect(getLabelOrder()).toEqual([
      "CBSE Board Exams (Class 10/12) - tentative",
      "Annual Exams",
      "PTM Week",
    ]);

    fireEvent.click(screen.getByRole("button", { name: /sort from/i }));

    expect(getLabelOrder()).toEqual([
      "PTM Week",
      "Annual Exams",
      "CBSE Board Exams (Class 10/12) - tentative",
    ]);
  });

  it("filters rows by type and label", async () => {
    render(<SchoolTermCalendar />);

    await screen.findByText("PTM Week");

    fireEvent.change(screen.getByRole("combobox", { name: /filter school terms by type/i }), {
      target: { value: "holiday" },
    });
    expect(screen.getByText("Annual Exams")).toBeInTheDocument();
    expect(screen.queryByText("PTM Week")).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: /search school terms by label/i }), {
      target: { value: "annual" },
    });
    expect(screen.getByText("Annual Exams")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: /search school terms by label/i }), {
      target: { value: "winter" },
    });
    expect(screen.getByText("No term windows match the selected filters.")).toBeInTheDocument();
  });
});
