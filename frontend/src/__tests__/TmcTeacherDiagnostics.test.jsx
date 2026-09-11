import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import TmcTeacherDiagnostics from "../pages/travel/TmcTeacherDiagnostics";

describe("TmcTeacherDiagnostics", () => {
  let fetchSpy;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((url, options = {}) => {
      if (url === "/api/portal/tmc/teacher/diagnostics") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ diagnostics: [] }) });
      }
      if (url === "/api/travel/diagnostics/public/form/tmc/tmc") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            form: {
              title: "CRM school diagnostic",
              subtitle: "Questions managed by the travel CRM",
              includeName: true,
              includeEmail: true,
              nameRequired: true,
              emailRequired: true,
            },
            questions: [{
              id: "crm-q1",
              text: "Which CRM question should the teacher answer?",
              type: "single-choice",
              required: true,
              options: [
                { value: "one", label: "First answer" },
                { value: "two", label: "Second answer" },
              ],
            }],
          }),
        });
      }
      if (url === "/api/travel/diagnostics/public/form/tmc/tmc/submit" && options.method === "POST") {
        return Promise.resolve({
          ok: true,
          status: 201,
          json: () => Promise.resolve({ diagnosticId: 42, reportSlug: "42-0123456789abcdef", classification: "strong_match" }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("renders CRM-provided questions and submits through the dynamic diagnostic flow", async () => {
    render(
      <TmcTeacherDiagnostics
        token="teacher-token"
        tenantSlug="tmc"
        contact={{ name: "Aisha Teacher", email: "aisha@example.com" }}
        onSessionExpired={vi.fn()}
      />,
    );

    expect(await screen.findByRole("button", { name: /Take the diagnostic/i })).toBeTruthy();
    expect(screen.queryByText("Which CRM question should the teacher answer?")).toBeNull();
    expect(screen.queryByText(/What's the one outcome/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Take the diagnostic/i }));
    expect(await screen.findByText("Which CRM question should the teacher answer?")).toBeTruthy();
    expect(screen.getByDisplayValue("aisha@example.com")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("First answer"));

    fireEvent.click(screen.getByRole("button", { name: /Submit and view report/i }));

    await waitFor(() => {
      expect(screen.getByText(/Your latest report is ready/i)).toBeTruthy();
    });
    expect(screen.getByRole("link", { name: /View report/i }).getAttribute("href")).toBe("/diagnostic-form/tmc/tmc/report/42-0123456789abcdef");

    const submitCall = fetchSpy.mock.calls.find((call) => call[0] === "/api/travel/diagnostics/public/form/tmc/tmc/submit");
    const submitBody = JSON.parse(submitCall[1].body);
    expect(submitBody.email).toBe("aisha@example.com");
    expect(submitBody.answers["crm-q1"]).toBe("one");
  });
});
