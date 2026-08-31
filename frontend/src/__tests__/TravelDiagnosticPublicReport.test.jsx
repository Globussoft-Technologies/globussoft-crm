/**
 * TravelDiagnosticPublicReport.jsx — public branded diagnostic report page.
 *
 * Pins the fix for a real bug found in manual testing (2026-08-20): the
 * backend's public submit/report endpoints always compute + return
 * `curriculumFit` (deterministic curriculum × grade × subject matches from
 * lib/travelDiagnosticCurriculumFit.js), but this page only ever rendered
 * the separate, LLM/RAG-backed `ragResult.recommendations.recommendedTrips`
 * list — `curriculumFit` was silently dropped. A parent picking grade 8 +
 * Geography got a 90%-fit destination match computed server-side that never
 * appeared on screen.
 *
 * Cases:
 *   - Renders curriculumFit.recommendations as a distinct section
 *   - Renders fit score + reasons + brochure link per recommendation
 *   - Doesn't show the "no results" empty state when only curriculumFit
 *     recommendations are present (no RAG trips, no summary, no PDF)
 *   - Still renders normally when curriculumFit is absent (legacy diagnostics)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

import TravelDiagnosticPublicReport from "../pages/public/TravelDiagnosticPublicReport";

function renderAt(slug = "42-abc123abc123abcd") {
  return render(
    <MemoryRouter initialEntries={[`/diagnostic-form/travel-stall/tmc/report/${slug}`]}>
      <Routes>
        <Route
          path="/diagnostic-form/:tenantSlug/:subBrand/report/:slug"
          element={<TravelDiagnosticPublicReport />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

function mockFetchSequence(reportBody, formOk = false) {
  global.fetch = vi.fn((url) => {
    if (String(url).includes("/public/report/")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(reportBody) });
    }
    return Promise.resolve({ ok: formOk, json: () => Promise.resolve({}) });
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("TravelDiagnosticPublicReport — curriculum-fit recommendations", () => {
  it("renders curriculumFit recommendations with fit score, reasons, and brochure link", async () => {
    mockFetchSequence({
      diagnosticId: 42,
      classificationLabel: "Power User",
      curriculumFit: {
        curriculum: "CBSE",
        grade: "8",
        subject: "Geography",
        recommendations: [
          {
            destination: "Mysore heritage and geography trail",
            fitScore: 90,
            mappingIds: [12],
            brochurePdfUrl: "https://example.test/brochure.pdf",
            reasons: [{ rationale: "Good fit for combining geography with local history." }],
          },
        ],
      },
    });

    renderAt();

    expect(
      await screen.findByText(/Recommended destinations for your curriculum/i),
    ).toBeInTheDocument();
    expect(screen.getByText("Mysore heritage and geography trail")).toBeInTheDocument();
    expect(screen.getByText("90% fit")).toBeInTheDocument();
    expect(
      screen.getByText(/Good fit for combining geography with local history/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /View brochure/i })).toHaveAttribute(
      "href",
      "https://example.test/brochure.pdf",
    );
  });

  it("does not show the empty state when only curriculumFit recommendations exist", async () => {
    mockFetchSequence({
      diagnosticId: 42,
      curriculumFit: {
        recommendations: [{ destination: "Somewhere", fitScore: 80, reasons: [] }],
      },
    });

    renderAt();

    await screen.findByText(/Recommended destinations for your curriculum/i);
    expect(
      screen.queryByText(/Your diagnostic has been recorded\. An advisor will reach out soon\./i),
    ).not.toBeInTheDocument();
  });

  it("renders the empty state when there is no curriculumFit, no trips, no summary, and no PDF", async () => {
    mockFetchSequence({ diagnosticId: 42 });

    renderAt();

    expect(
      await screen.findByText(/Your diagnostic has been recorded\. An advisor will reach out soon\./i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Recommended destinations for your curriculum/i),
    ).not.toBeInTheDocument();
  });
});

// ─── Chosen interests (2026-08-27) ─────────────────────────────────────

function mockFetchWithInterests(reportBody, { interestsPostOk = true } = {}) {
  const postCalls = [];
  global.fetch = vi.fn((url, opts) => {
    const u = String(url);
    if (opts?.method === "POST" && u.includes("/interests")) {
      postCalls.push({ url: u, body: opts.body ? JSON.parse(opts.body) : null });
      return Promise.resolve({
        ok: interestsPostOk,
        json: () =>
          Promise.resolve(
            interestsPostOk
              ? { ok: true, submittedAt: "2026-08-27T12:00:00.000Z" }
              : { error: "Failed to submit your chosen interests." },
          ),
      });
    }
    if (u.includes("/public/report/")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(reportBody) });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  });
  return postCalls;
}

describe("TravelDiagnosticPublicReport — chosen interests", () => {
  const baseReport = {
    diagnosticId: 42,
    ragResult: {
      recommendations: {
        recommendedTrips: [
          { name: "Hampi Heritage Trail", summary: "Rock-cut temples", driveLink: "https://drive.example/hampi" },
          { name: "Coorg Nature Camp", summary: "Coffee estates", driveLink: "" },
        ],
      },
    },
  };

  it("renders a checkbox per recommended trip and no submit button until one is checked", async () => {
    mockFetchWithInterests(baseReport);
    renderAt();

    expect(await screen.findByText("Hampi Heritage Trail")).toBeInTheDocument();
    expect(screen.getByText("Coorg Nature Camp")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Submit chosen interests/i })).not.toBeInTheDocument();

    const checkbox = screen.getByLabelText(/I'm interested in Hampi Heritage Trail/i);
    expect(checkbox.checked).toBe(false);
  });

  it("checking a trip reveals the Submit button, and submitting POSTs the selection", async () => {
    const postCalls = mockFetchWithInterests(baseReport);
    renderAt("42-abc123abc123abcd");

    await screen.findByText("Hampi Heritage Trail");
    fireEvent.click(screen.getByLabelText(/I'm interested in Hampi Heritage Trail/i));

    const submitBtn = screen.getByRole("button", { name: /Submit chosen interests \(1\)/i });
    fireEvent.click(submitBtn);

    await waitFor(() => expect(postCalls).toHaveLength(1));
    expect(postCalls[0].url).toContain("/public/report/42-abc123abc123abcd/interests");
    expect(postCalls[0].body).toEqual({
      interests: [{ name: "Hampi Heritage Trail", driveLink: "https://drive.example/hampi" }],
    });

    expect(await screen.findByText(/noted your interests/i)).toBeInTheDocument();
  });

  it("pre-checks trips already submitted, per data.chosenInterests", async () => {
    mockFetchWithInterests({
      ...baseReport,
      chosenInterests: {
        interests: [{ name: "Coorg Nature Camp", driveLink: "" }],
        submittedAt: "2026-08-27T09:00:00.000Z",
      },
    });
    renderAt();

    await screen.findByText("Coorg Nature Camp");
    expect(screen.getByLabelText(/I'm interested in Coorg Nature Camp/i).checked).toBe(true);
    expect(screen.getByLabelText(/I'm interested in Hampi Heritage Trail/i).checked).toBe(false);
    // Already-submitted state shows the confirmation without needing a click.
    expect(screen.getByText(/noted your interests/i)).toBeInTheDocument();
  });

  it("shows an inline error when the submit request fails", async () => {
    mockFetchWithInterests(baseReport, { interestsPostOk: false });
    renderAt();

    await screen.findByText("Hampi Heritage Trail");
    fireEvent.click(screen.getByLabelText(/I'm interested in Hampi Heritage Trail/i));
    fireEvent.click(screen.getByRole("button", { name: /Submit chosen interests \(1\)/i }));

    expect(await screen.findByText(/Failed to submit your chosen interests/i)).toBeInTheDocument();
  });
});
