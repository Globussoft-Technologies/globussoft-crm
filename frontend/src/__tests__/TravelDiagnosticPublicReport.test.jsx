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
import { render, screen } from "@testing-library/react";
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
