import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SalesTeams from "../pages/SalesTeams";

const fetchApiMock = vi.fn();
const notifyMock = {
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
};

vi.mock("../utils/api", () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

vi.mock("../utils/notify", () => ({
  useNotify: () => notifyMock,
}));

const STAFF = [
  { id: 1, name: "Ava Sales", email: "ava@example.com", role: "USER" },
  { id: 2, name: "Ben Sales", email: "ben@example.com", role: "USER" },
  { id: 3, name: "Jordan Manager", email: "jordan@example.com", role: "MANAGER" },
  { id: 4, name: "Alex Admin", email: "alex@example.com", role: "ADMIN" },
];

const TEAM = {
  id: 7,
  name: "North America Sales",
  managerId: 3,
  manager: { id: 3, name: "Jordan Manager" },
  members: [{ id: 11, user: { id: 1, name: "Ava Sales" } }],
  createdBy: { name: "Admin" },
  updatedBy: { name: "Admin" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

describe("<SalesTeams />", () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyMock.error.mockReset();
    notifyMock.success.mockReset();
    notifyMock.info.mockReset();
  });

  it("loads teams and renders the directory columns and team details", async () => {
    fetchApiMock.mockResolvedValue([TEAM]);

    render(<SalesTeams />);

    expect(fetchApiMock).toHaveBeenCalledWith("/api/sales-teams", { silent: true });
    expect(await screen.findByRole("button", { name: TEAM.name })).toBeInTheDocument();
    expect(screen.getByText("Jordan Manager")).toBeInTheDocument();
    expect(screen.getByText("Ava Sales")).toBeInTheDocument();

    for (const heading of [
      "Team name",
      "Team manager(s)",
      "Team members",
      "Created by",
      "Updated by",
      "Actions",
    ]) {
      expect(screen.getByRole("columnheader", { name: heading })).toBeInTheDocument();
    }
  });

  it("renders the empty state when no teams are returned", async () => {
    fetchApiMock.mockResolvedValue([]);

    render(<SalesTeams />);

    expect(await screen.findByText("No teams found.")).toBeInTheDocument();
    expect(screen.getByText("Showing 0 - 0 of 0")).toBeInTheDocument();
  });

  it("shows None when a team has no manager", async () => {
    fetchApiMock.mockResolvedValue([{ ...TEAM, managerId: null, manager: null }]);

    render(<SalesTeams />);

    expect(await screen.findByRole("button", { name: TEAM.name })).toBeInTheDocument();
    expect(screen.getByText("None")).toBeInTheDocument();
  });

  it("opens the create dialog, loads staff, and POSTs the selected members", async () => {
    fetchApiMock.mockImplementation((url, options = {}) => {
      if (url === "/api/staff?fields=summary") return Promise.resolve(STAFF);
      if (url === "/api/sales-teams" && options.method === "POST") return Promise.resolve({});
      return Promise.resolve([]);
    });

    render(<SalesTeams />);
    await screen.findByText("No teams found.");

    fireEvent.click(screen.getByRole("button", { name: /create team/i }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    const managerSelect = screen.getByRole("combobox", { name: "Team manager" });
    const memberSelect = screen.getByRole("combobox", { name: "Select a member to add" });
    expect(within(managerSelect).getByRole("option", { name: "Jordan Manager" })).toBeInTheDocument();
    expect(within(managerSelect).getByRole("option", { name: "Alex Admin" })).toBeInTheDocument();
    expect(within(managerSelect).queryByRole("option", { name: "Ava Sales" })).not.toBeInTheDocument();
    expect(within(memberSelect).getByRole("option", { name: "Ava Sales" })).toBeInTheDocument();
    expect(within(memberSelect).getByRole("option", { name: "Ben Sales" })).toBeInTheDocument();
    expect(within(memberSelect).queryByRole("option", { name: "Jordan Manager" })).not.toBeInTheDocument();
    expect(within(memberSelect).queryByRole("option", { name: "Alex Admin" })).not.toBeInTheDocument();
    expect(managerSelect).toHaveValue("");

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "  East Coast Sales  " } });
    fireEvent.change(screen.getByRole("combobox", { name: "Team manager" }), { target: { value: "3" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Select a member to add" }), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(
        ([url, options]) => url === "/api/sales-teams" && options?.method === "POST",
      );
      expect(post).toBeTruthy();
      expect(JSON.parse(post[1].body)).toEqual({ name: "East Coast Sales", managerId: 3, memberIds: [2] });
    });
    expect(notifyMock.success).toHaveBeenCalledWith("Team saved successfully");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens an existing team for editing and PUTs the updated membership", async () => {
    fetchApiMock.mockImplementation((url, options = {}) => {
      if (url === "/api/staff?fields=summary") return Promise.resolve(STAFF);
      if (url === "/api/sales-teams/7" && options.method === "PUT") return Promise.resolve(TEAM);
      return Promise.resolve([TEAM]);
    });

    render(<SalesTeams />);
    await screen.findByRole("button", { name: TEAM.name });

    fireEvent.click(screen.getByRole("button", { name: `Edit ${TEAM.name}` }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Team manager" })).toHaveValue("3");
    fireEvent.change(screen.getByRole("combobox", { name: "Team manager" }), { target: { value: "4" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Select a member to add" }), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const put = fetchApiMock.mock.calls.find(
        ([url, options]) => url === "/api/sales-teams/7" && options?.method === "PUT",
      );
      expect(put).toBeTruthy();
      expect(JSON.parse(put[1].body)).toEqual({ name: TEAM.name, managerId: 4, memberIds: [1, 2] });
    });
    expect(notifyMock.success).toHaveBeenCalledWith("Team saved successfully");
  });

  it("deletes a team, reloads the list, and confirms success", async () => {
    let deleted = false;
    fetchApiMock.mockImplementation((url, options = {}) => {
      if (url === "/api/sales-teams/7" && options.method === "DELETE") {
        deleted = true;
        return Promise.resolve({});
      }
      return Promise.resolve(deleted ? [] : [TEAM]);
    });

    render(<SalesTeams />);
    await screen.findByRole("button", { name: TEAM.name });

    fireEvent.click(screen.getByRole("button", { name: `Delete ${TEAM.name}` }));

    await waitFor(() => expect(screen.getByText("No teams found.")).toBeInTheDocument());
    expect(notifyMock.success).toHaveBeenCalledWith("Team deleted");
  });

  it("notifies when the initial team load fails", async () => {
    fetchApiMock.mockRejectedValue(new Error("Teams unavailable"));

    render(<SalesTeams />);

    await waitFor(() => expect(notifyMock.error).toHaveBeenCalledWith("Teams unavailable"));
  });

  it("keeps page scrolling bounded to rendered content and the table horizontal axis", async () => {
    fetchApiMock.mockResolvedValue([TEAM]);

    render(<SalesTeams />);
    await screen.findByRole("button", { name: TEAM.name });

    expect(screen.getByTestId("sales-teams-page")).toHaveStyle({
      alignContent: "start",
      height: "fit-content",
      minHeight: "0",
      overflowY: "visible",
    });
    expect(screen.getByTestId("sales-teams-table")).toHaveClass("sales-teams-table");
    expect(screen.getByTestId("sales-teams-table")).toHaveStyle({
      maxWidth: "100%",
      minWidth: "0",
      overflowX: "hidden",
      overflowY: "hidden",
      width: "100%",
    });
    expect(screen.getByRole("table")).toHaveClass("stable-table");
    expect(screen.getByRole("table")).toHaveStyle({
      maxWidth: "100%",
      minWidth: "0",
      tableLayout: "fixed",
      width: "100%",
    });
  });
});
