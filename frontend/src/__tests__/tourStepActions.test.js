import { describe, expect, it, vi } from "vitest";
import {
  needsTourPreparation,
  performTourActions,
  waitForTourTarget,
} from "../tours/tourStepActions";

describe("tour step actions", () => {
  it("waits for API-loaded content to enter the DOM", async () => {
    const waiting = waitForTourTarget('[data-testid="loaded"]', {
      timeoutMs: 500,
      requireVisible: false,
    });
    const node = document.createElement("div");
    node.dataset.testid = "loaded";
    document.body.appendChild(node);
    await expect(waiting).resolves.toBe(node);
    node.remove();
  });

  it("opens and restores expandable controls and selected tabs", async () => {
    const group = document.createElement("button");
    group.dataset.tour = "group";
    group.setAttribute("aria-expanded", "false");
    group.addEventListener("click", () => {
      group.setAttribute("aria-expanded", String(group.getAttribute("aria-expanded") !== "true"));
    });
    const tabs = document.createElement("div");
    tabs.setAttribute("role", "tablist");
    const first = document.createElement("button");
    first.setAttribute("role", "tab");
    first.setAttribute("aria-selected", "true");
    const second = document.createElement("button");
    second.dataset.tour = "second-tab";
    second.setAttribute("role", "tab");
    second.setAttribute("aria-selected", "false");
    for (const tab of [first, second]) tab.addEventListener("click", () => {
      first.setAttribute("aria-selected", String(tab === first));
      second.setAttribute("aria-selected", String(tab === second));
    });
    tabs.append(first, second);
    document.body.append(group, tabs);

    const result = await performTourActions([
      { type: "expand", target: '[data-tour="group"]', requireVisible: false },
      { type: "tab", target: '[data-tour="second-tab"]', requireVisible: false },
    ]);
    expect(group).toHaveAttribute("aria-expanded", "true");
    expect(second).toHaveAttribute("aria-selected", "true");
    result.restorers.forEach((restore) => restore());
    expect(group).toHaveAttribute("aria-expanded", "false");
    expect(first).toHaveAttribute("aria-selected", "true");
    group.remove();
    tabs.remove();
  });

  it("supports modal/dropdown clicks, event actions, and required-target failures", async () => {
    const trigger = document.createElement("button");
    trigger.dataset.tour = "open";
    const click = vi.fn();
    trigger.addEventListener("click", click);
    document.body.appendChild(trigger);
    const event = vi.fn();
    window.addEventListener("tour:test", event, { once: true });

    const result = await performTourActions([
      { type: "click", target: '[data-tour="open"]', requireVisible: false },
      { type: "event", name: "tour:test", detail: { ready: true } },
    ]);
    expect(result.ok).toBe(true);
    expect(click).toHaveBeenCalledOnce();
    expect(event).toHaveBeenCalledOnce();
    await expect(performTourActions([
      { type: "click", target: ".missing", required: true, timeoutMs: 5, requireVisible: false },
    ])).resolves.toMatchObject({ ok: false });
    trigger.remove();
  });

  it("marks navigation, async targets, record conditions, and actions for preparation", () => {
    expect(needsTourPreparation({ navigateTo: "/contacts" })).toBe(true);
    expect(needsTourPreparation({ waitFor: "table" })).toBe(true);
    expect(needsTourPreparation({ requiresRecords: "tbody tr" })).toBe(true);
    expect(needsTourPreparation({ actions: [{ type: "click", target: "button" }] })).toBe(true);
    expect(needsTourPreparation({ target: "main" })).toBe(false);
  });
});
