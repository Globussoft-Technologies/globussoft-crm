import { afterEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/dom";
import fs from "node:fs";
import path from "node:path";

const html = fs.readFileSync(
  path.join(process.cwd(), "public", "embed", "meeting-form.html"),
  "utf8",
);

function jsonResponse(body, ok = true) {
  return Promise.resolve({ ok, status: ok ? 200 : 500, text: () => Promise.resolve(JSON.stringify(body)) });
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
            { date: "2099-09-28", available: false, slots: [], displaySlots: [] },
            {
              date: "2099-09-29",
              available: true,
              slots: [
                { start: "2099-09-29T05:30:00.000Z", label: "11:00 AM" },
                { start: "2099-09-29T06:00:00.000Z", label: "11:30 AM" },
              ],
              displaySlots: [
                { start: "2099-09-29T05:30:00.000Z", label: "11:00 AM", available: true },
                { start: "2099-09-29T06:00:00.000Z", label: "11:30 AM", available: true },
                { start: "2099-09-29T06:30:00.000Z", label: "12:00 PM", available: false, unavailableReason: "occupied" },
              ],
            },
            { date: "2099-10-01", available: true, slots: [{ start: "2099-10-01T05:30:00.000Z", label: "11:00 AM" }] },
          ],
        });
      }
      return jsonResponse({
        name: "Talk to a TMC Experiential Learning Expert",
        durationMins: 30,
        bookingHorizonDays: 30000,
        allowedStartDate: "2099-09-01",
        timezone: "Asia/Kolkata",
        embedFontFamily: "Poppins",
        fields: [
          { key: "designation", label: "Designation", type: "select", required: true, options: ["Principal", "Vice Principal", "Other"] },
          { key: "institution", label: "School / Institution", type: "text", required: true },
          { key: "contactPhone", label: "Phone / WhatsApp", type: "tel", required: true },
        ],
      });
    }));

    new Function(script)();

    await waitFor(() => expect(document.querySelector("#calendar-title")).toHaveTextContent(/September 2099/i));
    expect(document.querySelectorAll(".weekdays span")).toHaveLength(7);
    expect(document.querySelector('[data-date="2099-09-29"]')).toHaveClass("available", "active");
    expect(document.querySelector('[data-date="2099-09-28"]')).toBeDisabled();
    expect(document.querySelector('[data-date="2099-09-28"]')).not.toHaveClass("available");
    expect(document.querySelector("#selected-date")).toHaveTextContent(/(?:29 September 2099|September 29, 2099)/i);
    expect(document.querySelector("#slots")).toHaveTextContent("11:00 AM");
    expect(document.querySelector('[aria-label="12:00 PM unavailable"]')).toBeDisabled();
    expect(document.querySelector('[aria-label="12:00 PM unavailable"]')).toHaveClass("unavailable");
    expect(document.querySelector("#next-month")).not.toBeDisabled();
    expect(document.documentElement.style.getPropertyValue("--embed-font")).toContain("Poppins");
    expect(document.querySelector("#meeting-google-font")).toHaveAttribute("href", expect.stringContaining("family=Poppins"));
    const designation = document.querySelector('[name="designation"]');
    expect(designation.tagName).toBe("SELECT");
    expect(Array.from(designation.options).map((option) => option.value)).toEqual(["", "Principal", "Vice Principal", "Other"]);
    const institution = document.querySelector('[name="institution"]');
    institution.setCustomValidity("School / Institution must contain a valid institution name, not a URL");
    institution.value = "Chennai Public School";
    institution.dispatchEvent(new Event("input", { bubbles: true }));
    expect(institution.validationMessage).toBe("");
    const phone = document.querySelector('[name="contactPhone"]');
    phone.value = "98ab 76-543210";
    phone.dispatchEvent(new Event("input", { bubbles: true }));
    expect(phone.value).toBe("9876543210");
    expect(phone).toHaveAttribute("inputmode", "numeric");
    expect(phone).toHaveAttribute("pattern", "[0-9]{7,15}");
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/availability?start="), expect.anything());
    expect(fetch.mock.calls.find(([url]) => String(url).includes("/availability"))[0]).toContain("days=62");
    document.querySelector("#next-month").click();
    await waitFor(() => expect(document.querySelector("#calendar-title")).toHaveTextContent(/October 2099/i));
    document.querySelector("#next-month").click();
    await waitFor(() => expect(document.querySelector("#calendar-title")).toHaveTextContent(/November 2099/i));
    const availabilityCalls = fetch.mock.calls.filter(([url]) => String(url).includes("/availability"));
    expect(availabilityCalls.at(-1)[0]).toContain("start=2099-11-01");
    expect(html).toContain("Confirming your conversation and creating the Zoom link");
    expect(html).not.toContain("creating the Zoom link and calendar");
    expect(html).toContain("button { font-family:inherit; }");
    expect(html).toContain('<form id="booking-form" autocomplete="off">');
    expect(html).toContain('autocomplete="off"');
    expect(html).not.toContain("Add to Calendar");
    expect(html).toContain("Scheduling could not be loaded.");
    expect(html).toContain("must contain only 7 to 15 digits");
    expect(html).toContain("must contain a valid institution name, not a URL");
    expect(html).toContain("INVALID_SERVICE_RESPONSE");
    expect(html).not.toContain("response.json()");
  });

  it("converts an HTML proxy failure into a safe scheduling error", async () => {
    const body = html.match(/<body>([\s\S]*?)<script>/i)?.[1] || "";
    const script = html.match(/<script>([\s\S]*?)<\/script>/i)?.[1] || "";
    document.body.innerHTML = body;
    window.history.replaceState({}, "", "/embed/meeting-form.html?form=tmcmf_test");
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      disconnect() {}
    });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({
      ok: false,
      status: 502,
      text: () => Promise.resolve("<!DOCTYPE html><html><body>Bad Gateway</body></html>"),
    })));

    new Function(script)();

    await waitFor(() => expect(document.querySelector("#app")).toHaveTextContent("The scheduling service could not complete the request (502). Please retry."));
    expect(document.querySelector("#app")).not.toHaveTextContent("Unexpected token");
    expect(document.querySelector("#app")).not.toHaveTextContent("DOCTYPE");
  });
});
