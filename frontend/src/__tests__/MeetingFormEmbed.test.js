import { afterEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/dom";
import fs from "node:fs";
import path from "node:path";

const html = fs.readFileSync(
  path.join(process.cwd(), "public", "embed", "meeting-form.html"),
  "utf8",
);

function jsonResponse(body, ok = true) {
  return Promise.resolve({ ok, status: ok ? 200 : 500, json: () => Promise.resolve(body) });
}

describe("Meeting Form embed calendar", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.innerHTML = "<head></head><body></body>";
  });

  it("renders available dates in a month calendar with a separate time panel", async () => {
    const body = html.match(/<body>([\s\S]*?)<script>/i)?.[1] || "";
    const script = html.match(/<script>([\s\S]*?)<\/script>/i)?.[1] || "";
    document.body.innerHTML = body;
    window.history.replaceState({}, "", "/embed/meeting-form.html?form=tmcmf_test");

    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      disconnect() {}
    });
    vi.stubGlobal("fetch", vi.fn((url) => {
      if (String(url).includes("/availability")) {
        return jsonResponse({
          timezone: "Asia/Kolkata",
          durationMins: 30,
          dates: [
            { date: "2026-09-24", available: false, slots: [], displaySlots: [{ start: "2026-09-24T05:30:00.000Z", label: "11:00 AM", available: false, unavailableReason: "notice" }] },
            {
              date: "2026-09-25",
              available: true,
              slots: [
                { start: "2026-09-25T05:30:00.000Z", label: "11:00 AM" },
                { start: "2026-09-25T06:00:00.000Z", label: "11:30 AM" },
              ],
              displaySlots: [
                { start: "2026-09-25T05:30:00.000Z", label: "11:00 AM", available: true },
                { start: "2026-09-25T06:00:00.000Z", label: "11:30 AM", available: true },
                { start: "2026-09-25T06:30:00.000Z", label: "12:00 PM", available: false, unavailableReason: "occupied" },
              ],
            },
            { date: "2026-10-01", available: true, slots: [{ start: "2026-10-01T05:30:00.000Z", label: "11:00 AM" }] },
          ],
        });
      }
      return jsonResponse({
        name: "Talk to a TMC Experiential Learning Expert",
        durationMins: 30,
        bookingHorizonDays: 365,
        timezone: "Asia/Kolkata",
        embedFontFamily: "Poppins",
        fields: [],
      });
    }));

    new Function(script)();

    await waitFor(() => expect(document.querySelector("#calendar-title")).toHaveTextContent(/September 2026/i));
    expect(document.querySelectorAll(".weekdays span")).toHaveLength(7);
    expect(document.querySelector('[data-date="2026-09-25"]')).toHaveClass("available", "active");
    expect(document.querySelector('[data-date="2026-09-24"]')).toBeDisabled();
    expect(document.querySelector("#selected-date")).toHaveTextContent(/Friday, 25 September 2026/i);
    expect(document.querySelector("#slots")).toHaveTextContent("11:00 AM");
    expect(document.querySelector('[aria-label="12:00 PM unavailable"]')).toBeDisabled();
    expect(document.querySelector('[aria-label="12:00 PM unavailable"]')).toHaveClass("unavailable");
    expect(document.querySelector("#next-month")).not.toBeDisabled();
    expect(document.documentElement.style.getPropertyValue("--embed-font")).toContain("Poppins");
    expect(document.querySelector("#meeting-google-font")).toHaveAttribute("href", expect.stringContaining("family=Poppins"));
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/availability?start="), expect.anything());
    expect(fetch.mock.calls.find(([url]) => String(url).includes("/availability"))[0]).toContain("days=62");
    document.querySelector("#next-month").click();
    await waitFor(() => expect(document.querySelector("#calendar-title")).toHaveTextContent(/October 2026/i));
    document.querySelector("#next-month").click();
    await waitFor(() => expect(document.querySelector("#calendar-title")).toHaveTextContent(/November 2026/i));
    const availabilityCalls = fetch.mock.calls.filter(([url]) => String(url).includes("/availability"));
    expect(availabilityCalls.at(-1)[0]).toContain("start=2026-11-01");
    expect(html).toContain("Confirming your conversation and creating the Zoom link");
    expect(html).not.toContain("creating the Zoom link and calendar");
    expect(html).toContain("button { font-family:inherit; }");
    expect(html).toContain('<form id="booking-form" autocomplete="off">');
    expect(html).toContain('autocomplete="off"');
    expect(html).not.toContain("Add to Calendar");
    expect(html).toContain("Scheduling could not be loaded.");
  });
});
