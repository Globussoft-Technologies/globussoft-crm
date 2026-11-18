import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthContext } from "../appContexts";
import TravelIntegrationTiles from "../components/settings/TravelIntegrationTiles";

const fetchApiMock = vi.hoisted(() => vi.fn());
vi.mock("../utils/api", () => ({ fetchApi: (...args) => fetchApiMock(...args) }));

const connections = [
  ["gmail", "Gmail", "/gmail"],
  ["drive", "Google Drive", "/travel/trip-knowledge"],
  ["calendar", "Google Calendar", "/calendar-sync"],
  ["whatsapp", "WhatsApp Web", "/travel/whatsapp"],
];

function CurrentPath() {
  return <output aria-label="Current route">{useLocation().pathname}</output>;
}

function Harness({ vertical = "travel", tenantId = 77, userId = 8 }) {
  return <MemoryRouter initialEntries={["/settings"]}><AuthContext.Provider value={{ tenant: { id: tenantId, vertical }, user: { id: userId } }}><TravelIntegrationTiles /><CurrentPath /></AuthContext.Provider></MemoryRouter>;
}

describe("Travel settings connection tiles", () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    fetchApiMock.mockResolvedValue({ checks: connections.map(([id]) => ({ id, ready: false })) });
  });

  it("uses the existing readiness API and routes each Connect link to the right page", async () => {
    render(<Harness />);
    expect(await screen.findAllByText("Not connected")).toHaveLength(4);
    expect(fetchApiMock).toHaveBeenCalledTimes(1);
    expect(fetchApiMock).toHaveBeenCalledWith("/api/travel/dashboard/readiness", { silent: true });
    for (const [, label, path] of connections) {
      const tile = screen.getByRole("link", { name: new RegExp(label) });
      expect(tile).toHaveAttribute("href", path);
      expect(within(tile).getByText("Connect")).toBeInTheDocument();
      fireEvent.click(tile);
      expect(screen.getByLabelText("Current route")).toHaveTextContent(path);
    }
  });

  it("shows Manage only for connected accounts without changing their destination", async () => {
    fetchApiMock.mockResolvedValue({ checks: connections.map(([id]) => ({ id, ready: id === "calendar" || id === "drive" })) });
    render(<Harness />);
    expect(await screen.findAllByText("Connected")).toHaveLength(2);
    for (const [id, label, path] of connections) {
      const tile = screen.getByRole("link", { name: new RegExp(label) });
      expect(within(tile).getByText(id === "calendar" || id === "drive" ? "Manage" : "Connect")).toBeInTheDocument();
      expect(tile).toHaveAttribute("href", path);
    }
  });

  it.each(["generic", "wellness"])("renders no tiles and makes no readiness request for %s", (vertical) => {
    render(<Harness vertical={vertical} />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(fetchApiMock).not.toHaveBeenCalled();
  });

  it("keeps setup links available when status cannot be loaded without claiming disconnection", async () => {
    fetchApiMock.mockRejectedValue(new Error("Service unavailable"));
    render(<Harness />);
    expect(await screen.findAllByText("Status unavailable")).toHaveLength(4);
    expect(screen.getAllByText("Open setup")).toHaveLength(4);
    expect(screen.queryByText("Not connected")).not.toBeInTheDocument();
    expect(screen.queryByText("Connect")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: /Google Drive/ }));
    expect(screen.getByLabelText("Current route")).toHaveTextContent("/travel/trip-knowledge");
  });

  it("does not reuse an old tenant's connection status after the account changes", async () => {
    const pending = [];
    fetchApiMock.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    const view = render(<Harness />);
    expect(screen.getAllByText("Checking connection…")).toHaveLength(4);
    view.rerender(<Harness tenantId={78} userId={9} />);
    await act(async () => pending[0]({ checks: connections.map(([id]) => ({ id, ready: true })) }));
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
    expect(screen.getAllByText("Checking connection…")).toHaveLength(4);
    await act(async () => pending[1]({ checks: connections.map(([id]) => ({ id, ready: false })) }));
    expect(screen.getAllByText("Not connected")).toHaveLength(4);
  });

  it("keeps missing readiness checks unknown rather than marking them disconnected", async () => {
    fetchApiMock.mockResolvedValue({ checks: [{ id: "calendar", ready: true }] });
    render(<Harness />);
    expect(await screen.findAllByText("Status unavailable")).toHaveLength(3);
    expect(within(screen.getByRole("link", { name: /Google Calendar/ })).getByText("Manage")).toBeInTheDocument();
    expect(screen.queryByText("Not connected")).not.toBeInTheDocument();
  });
});
