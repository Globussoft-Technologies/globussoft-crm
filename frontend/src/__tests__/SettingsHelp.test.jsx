import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import SettingsHelp from "../components/settings/SettingsHelp";

describe("Settings field help", () => {
  it("keeps guidance behind an accessible info button and opens on keyboard focus", () => {
    render(<SettingsHelp label="Brand color">Enter a six-digit hex color.</SettingsHelp>);
    const button = screen.getByRole("button", { name: "Brand color help" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    fireEvent.focus(button);
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent("Enter a six-digit hex color.");
    expect(button).toHaveAttribute("aria-describedby", tooltip.id);
    expect(button).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("opens on tap without submitting its surrounding form and dismisses outside", () => {
    const submit = vi.fn();
    render(<form onSubmit={submit}><SettingsHelp label="Phone Number ID">Find this in Meta API Setup.</SettingsHelp></form>);
    fireEvent.click(screen.getByRole("button", { name: "Phone Number ID help" }));
    expect(screen.getByRole("tooltip")).toBeVisible();
    expect(submit).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("opens on hover and closes when the page scrolls", () => {
    render(<SettingsHelp label="Logo">Maximum file size: 20 MB.</SettingsHelp>);
    fireEvent.mouseEnter(screen.getByRole("button", { name: "Logo help" }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("20 MB");
    fireEvent.scroll(window);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
});
