import { useEffect, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import SettingsWorkspace, { SettingsSection } from "../components/settings/SettingsWorkspace";

function DraftForm({ onMount, onSave }) {
  const [value, setValue] = useState("");
  useEffect(() => { onMount(); }, [onMount]);
  return <form onSubmit={(event) => { event.preventDefault(); onSave(value); }}><label>Webhook secret<input value={value} onChange={(event) => setValue(event.target.value)} /></label><button type="submit">Save webhook</button></form>;
}

function Fixture({ enabled = true, canManage = true, onMount = () => {}, onSave = () => {} }) {
  return (
    <SettingsWorkspace enabled={enabled}>
      <SettingsSection section="general"><div className="card"><h3>Organization profile</h3><input aria-label="Organization name" defaultValue="Acme" /></div></SettingsSection>
      <SettingsSection section="appearance"><div className="card"><h3>Display theme</h3></div></SettingsSection>
      {canManage && <SettingsSection section="integrations" integration="callified"><div className="card"><h3>Existing Callified form</h3><DraftForm onMount={onMount} onSave={onSave} /></div></SettingsSection>}
      {canManage && <SettingsSection section="integrations" integration="maps"><div className="card"><h3>Existing maps form</h3></div></SettingsSection>}
      {canManage && <SettingsSection section="roles"><div className="card"><h3>Saved role history</h3></div></SettingsSection>}
    </SettingsWorkspace>
  );
}

describe("Generic settings workspace", () => {
  it("navigates through the narrow-screen picker without losing an organization draft", () => {
    render(<Fixture />);
    fireEvent.change(screen.getByLabelText("Organization name"), { target: { value: "Unsaved workspace" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Settings section" }), { target: { value: "appearance" } });
    expect(screen.getByText("Display theme")).toBeVisible();
    fireEvent.change(screen.getByRole("combobox", { name: "Settings section" }), { target: { value: "general" } });
    expect(screen.getByLabelText("Organization name")).toHaveValue("Unsaved workspace");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "calling" } });
    expect(screen.getByRole("combobox", { name: "Settings section" })).toHaveValue("general");
    expect(within(screen.getByRole("combobox", { name: "Settings section" })).getByRole("option", { name: "Integrations" })).toBeInTheDocument();
  });
  it("shows one section at a time and keeps the other controls mounted", () => {
    render(<Fixture />);
    expect(screen.getByRole("heading", { name: "General", level: 2 })).toBeVisible();
    expect(screen.getByLabelText("Organization name")).toBeVisible();
    expect(screen.getByText("Display theme")).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Appearance & tours" }));
    expect(screen.getByText("Display theme")).toBeVisible();
    expect(screen.getByLabelText("Organization name")).not.toBeVisible();
    expect(screen.getByRole("button", { name: "Appearance & tours" })).toHaveAttribute("aria-current", "page");
  });

  it("keeps a chevron slot on unselected items so selection does not squeeze the label", () => {
    render(<Fixture />);
    const appearance = screen.getByRole("button", { name: "Appearance & tours" });
    const chevron = appearance.querySelector(".gs-nav-chevron");
    expect(chevron).not.toBeNull();
    expect(appearance).toHaveAttribute("title", "Appearance & tours");
    fireEvent.click(appearance);
    expect(appearance).toHaveAttribute("aria-current", "page");
    expect(appearance.querySelector(".gs-nav-chevron")).toBe(chevron);
  });

  it("opens the existing integration form and preserves an unsaved draft through navigation", () => {
    const onMount = vi.fn(), onSave = vi.fn();
    render(<Fixture onMount={onMount} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Integrations", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: /Callified.*Manage integration/i }));
    fireEvent.change(screen.getByLabelText("Webhook secret"), { target: { value: "unsaved-example" } });
    fireEvent.click(screen.getByRole("button", { name: "All integrations" }));
    expect(screen.getByLabelText("Webhook secret")).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "General", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Integrations", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: /Callified.*Manage integration/i }));
    expect(screen.getByLabelText("Webhook secret")).toHaveValue("unsaved-example");
    expect(onMount).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.submit(screen.getByLabelText("Webhook secret").closest("form"));
    expect(onSave).toHaveBeenCalledWith("unsaved-example");
  });

  it("searches setting keywords, reports no results, and clears the filter", () => {
    render(<Fixture />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "  calling  " } });
    const navigation = screen.getByRole("navigation", { name: "Settings sections" });
    expect(within(navigation).getByRole("button", { name: "Integrations" })).toBeVisible();
    expect(within(navigation).queryByRole("button", { name: "General" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Organization name")).toBeVisible();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "no-matching-section" } });
    expect(screen.getByRole("status")).toHaveTextContent("No matching settings");
    fireEvent.click(screen.getByRole("button", { name: "Clear settings search" }));
    expect(within(navigation).getByRole("button", { name: "General" })).toBeVisible();
  });

  it("changes sections without scrolling the application horizontally", () => {
    const { container } = render(<div data-testid="page-pane" style={{ overflowY: "auto" }}><Fixture /></div>);
    const pane = screen.getByTestId("page-pane");
    const content = container.querySelector(".gs-content");
    const scroll = container.querySelector(".gs-scroll");
    scroll.scrollTop = 400;
    Object.defineProperties(pane, { scrollHeight: { value: 3000 }, clientHeight: { value: 600 } });
    pane.getBoundingClientRect = () => ({ top: 50 });
    content.getBoundingClientRect = () => ({ top: 250 });
    content.scrollIntoView = vi.fn();
    pane.scrollTop = 80;
    pane.scrollLeft = 37;
    fireEvent.click(screen.getByRole("button", { name: "Appearance & tours" }));
    expect(pane.scrollLeft).toBe(37);
    expect(pane.scrollTop).toBe(80);
    expect(scroll.scrollTop).toBe(0);
    expect(content.scrollIntoView).not.toHaveBeenCalled();
    expect(content).toHaveFocus();
  });

  it("does not advertise sections or integration tiles omitted by the existing permission gates", () => {
    render(<Fixture canManage={false} />);
    expect(screen.queryByRole("button", { name: "Integrations" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Role recovery" })).not.toBeInTheDocument();
    expect(screen.queryByText("Existing Callified form")).not.toBeInTheDocument();
  });

  it("falls back safely when permissions remove the active section", () => {
    const view = render(<Fixture />);
    fireEvent.click(screen.getByRole("button", { name: "Role recovery" }));
    view.rerender(<Fixture canManage={false} />);
    expect(screen.getByLabelText("Organization name")).toBeVisible();
    expect(screen.getByRole("heading", { name: "General", level: 2 })).toBeVisible();
  });

  it("returns to the directory if the selected integration is no longer available", () => {
    const panels = (showMaps) => <SettingsWorkspace enabled><SettingsSection section="integrations" integration="callified"><p>Calling form</p></SettingsSection>{showMaps && <SettingsSection section="integrations" integration="maps"><p>Maps form</p></SettingsSection>}</SettingsWorkspace>;
    const view = render(panels(true));
    fireEvent.click(screen.getByRole("button", { name: /Google Maps.*Manage integration/i }));
    expect(screen.getByText("Maps form")).toBeVisible();
    view.rerender(panels(false));
    expect(screen.getByRole("button", { name: /Callified.*Manage integration/i })).toBeVisible();
    expect(screen.queryByRole("button", { name: "All integrations" })).not.toBeInTheDocument();
  });

  it("leaves disabled and loading-context settings in the original grid without extra wrappers", () => {
    const { container } = render(<Fixture enabled={false} />);
    expect(container.firstElementChild).toHaveClass("settings-grid");
    expect(container.querySelectorAll(".settings-grid > .card")).toHaveLength(5);
    expect(container.querySelector(".gs-section")).toBeNull();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.getByText("Existing Callified form")).toBeVisible();
    expect(screen.getByText("Display theme")).toBeVisible();
  });
});
