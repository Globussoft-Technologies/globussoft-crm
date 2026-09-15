import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import TmcTeacherDiagnostics from "../pages/travel/TmcTeacherDiagnostics";

describe("TmcTeacherDiagnostics", () => {
  let fetchSpy;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((url, options = {}) => {
      if (url === "/api/portal/tmc/teacher/diagnostics") {
        if (options.method === "POST") {
          return Promise.resolve({
            ok: true,
            status: 201,
            json: () => Promise.resolve({
              diagnosticId: 42,
              engineState: "strong_match",
              classificationLabel: "Routed by TMC Engine",
              recommendedTier: "engine",
              reportPdfUrl: "/api/travel/diagnostics/public/readiness-report/42-0123456789abcdef.pdf",
              recommendations: [{
                name: "Campus Overnight Adventure",
                category: "domestic",
                summary: "An overnight programme for teamwork and reflection.",
                learnings: ["Build collaboration through shared activities."],
              }],
            }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ diagnostics: [] }) });
      }
      if (url === "/api/portal/tmc/teacher/diagnostic") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            questions: [
              {
                id: "q1",
                field: "primary_outcome",
                text: "Which CRM question should the teacher answer?",
                type: "single",
                required: true,
                options: [{ value: "one", label: "First answer" }],
              },
              {
                id: "q12",
                field: "contact",
                text: "Where should we send your readiness profile?",
                type: "group",
                hardWall: true,
                fields: [
                  { id: "contact_name", label: "Your name", type: "text" },
                  { id: "email", label: "Email", type: "email" },
                ],
              },
              {
                id: "q2",
                field: "secondary_skills",
                text: "Which skills should the trip strengthen?",
                type: "multi",
                required: true,
                min: 1,
                max: 2,
                options: [
                  { value: "empathy", label: "Empathy" },
                  { value: "collaboration", label: "Collaboration" },
                ],
              },
              {
                id: "q3",
                field: "additional_context",
                text: "Anything else the trip should consider?",
                type: "textarea",
                required: false,
              },
            ],
          }),
        });
      }
      if (url === "/api/portal/tmc/teacher/diagnostics/42/interests" && options.method === "POST") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            ok: true,
            interests: [{ name: "Campus Overnight Adventure", driveLink: "" }],
            submittedAt: "2026-09-11T00:00:00.000Z",
          }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("keeps the complete diagnostic and trip selection flow inside the teacher portal", async () => {
    render(
      <TmcTeacherDiagnostics
        token="teacher-token"
        contact={{ name: "Aisha Teacher", email: "aisha@example.com" }}
        onSessionExpired={vi.fn()}
      />,
    );

    expect(await screen.findByRole("button", { name: /Take the diagnostic/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Take the diagnostic/i }));
    expect(await screen.findByText("Which CRM question should the teacher answer?")).toBeTruthy();
    expect(screen.getByText("Where should we send your readiness profile?")).toBeTruthy();
    expect(screen.getByTestId("teacher-diagnostic-question-scroll").style.overflowY).toBe("auto");
    const optionalQuestion = screen.getByRole("heading", { name: "Anything else the trip should consider?" }).closest("section");
    expect(within(optionalQuestion).getByRole("textbox")).toBeTruthy();
    expect(within(optionalQuestion).queryByText(/Choose at least/)).toBeNull();
    fireEvent.click(screen.getByLabelText("First answer"));
    fireEvent.click(screen.getByLabelText("Empathy", { selector: "input" }));
    fireEvent.click(screen.getByRole("button", { name: /Complete diagnostic/i }));

    await waitFor(() => expect(screen.getByText(/Your diagnostic result is ready/i)).toBeTruthy());
    expect(screen.getByText("Recommended trips for your school")).toBeTruthy();
    expect(screen.getByText("Campus Overnight Adventure")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Download report PDF/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /View report/i })).toBeNull();
    expect(screen.queryByText(/diagnostic-form/i)).toBeNull();

    fireEvent.click(screen.getByRole("checkbox", { name: "I'm interested in Campus Overnight Adventure" }));
    fireEvent.click(screen.getByRole("button", { name: /Complete diagnostic \(1\)/i }));

    await waitFor(() => expect(screen.getByText(/Trip choices saved/i)).toBeTruthy());
    expect(screen.getByRole("link", { name: /Download report PDF/i }).getAttribute("href")).toBe("/api/travel/diagnostics/public/readiness-report/42-0123456789abcdef.pdf");

    const submitCall = fetchSpy.mock.calls.find(([url, options]) => url === "/api/portal/tmc/teacher/diagnostics" && options.method === "POST");
    expect(JSON.parse(submitCall[1].body)).toMatchObject({
      answers: {
        primary_outcome: "one",
        secondary_skills: ["empathy"],
        contact: { email: "aisha@example.com" },
      },
    });
    const interestCall = fetchSpy.mock.calls.find(([url]) => url === "/api/portal/tmc/teacher/diagnostics/42/interests");
    expect(JSON.parse(interestCall[1].body)).toEqual({ interests: [{ name: "Campus Overnight Adventure", driveLink: "" }] });
  });
});
