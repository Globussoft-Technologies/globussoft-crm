import { render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import Users from "../pages/Users";

const fetchApi = vi.fn();
vi.mock("../utils/api", () => ({ fetchApi: (...args) => fetchApi(...args) }));
vi.mock("../utils/notify", () => ({ useNotify: () => ({ info: vi.fn(), error: vi.fn() }) }));

beforeEach(() => { fetchApi.mockResolvedValue([{ id: 1, name: "Priya Patel", email: "priya@example.com", role: "MANAGER", createdAt: "2026-01-01" }]); });

test("renders the independent Users directory with reference columns", async () => {
  render(<Users />);
  expect(await screen.findByText("Priya Patel")).toBeInTheDocument();
  for (const heading of ["Name", "Email", "Reporting Manager", "Role", "Last Login", "Territories", "Teams", "Default Pipeline", "Joined At", "Action"]) {
    expect(screen.getByRole("columnheader", { name: heading })).toBeInTheDocument();
  }
  expect(fetchApi).toHaveBeenCalledWith("/api/staff");
});
