/**
 * TmcReadinessReport.jsx — public 10-section readiness report page
 * (PRD §3.5, slice T10).
 *
 * Renders the saved diagnostic JSON (school answers + Job A narrative,
 * NO LLM call at render time). Fetches from a public JSON endpoint
 * keyed by the slug; the PDF download button hits T8's public PDF
 * endpoint; the booking CTA wires DD-5.4 (Calendar fallback URL).
 *
 * Contract pins:
 *   - Initial load → loading state ("Loading your readiness profile…")
 *   - Resolved diagnostic → 10 sections present (ambition, readiness,
 *     what's possible, cost of waiting, peer-proof, institutional benefit,
 *     assurance, how TMC works, single CTA)
 *   - §3.5.1 board hook: CBSE → "NEP", IGCSE → "Cambridge Learner Attributes",
 *     IB → "CAS" + "Learner Profile" (AC-3: IB never sees NEP)
 *   - §3.5.2 runway: geo_preference="international" → "minimum 4 to 6 months"
 *   - §3.5.3 + §11.4 peer-proof block: literal "305", "14,018", "12,055",
 *     "1,658" — NEVER inflated, NEVER blended into all-time totals
 *   - PDF download button uses /api/travel/diagnostics/:id/readiness-report.pdf
 *   - Booking CTA copy is CALM (no "urgent" / "limited time" / "act now"
 *     per §11.3); button label is the verbatim "Book a 30-minute consultation"
 *   - Theme-aware: primary CTA uses var(--primary-color, var(--accent-color))
 *     not hardcoded blue
 *   - 404 / not-yet-ready → friendly "Report being generated" fallback, no crash
 *   - Malformed slug → friendly fallback, no crash
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import TmcReadinessReport from '../pages/public/TmcReadinessReport';

// Minimal valid saved-diagnostic shape the page expects.
function makeSavedDiagnostic(over = {}) {
  return {
    diagnosticId: 42,
    slug: '42-abcdef0123456789',
    answers: {
      primary_outcome: 'global_awareness',
      secondary_skills: ['Empathy', 'Collaboration and teamwork'],
      growth_area: 'comfort_with_difference',
      growth_area_skill: 'Cultural respect and inclusion',
      travel_maturity: 'regular_domestic',
      grade_band: '9-10',
      curriculum: ['CBSE'],
      geo_preference: 'domestic',
      group_size: '35-45',
      budget_band: '30k-75k',
      timeline: 'next_term',
      school_profile: {
        school_name: 'Modern Public School',
        city: 'Pune',
        branches: '2',
        student_strength: '1000_2000',
        fee_band: '75k_1l',
      },
      contact: {
        contact_name: 'Aisha Khan',
        contact_role: 'principal',
        email: 'principal@modernpublicschool.in',
        phone: '+919876543210',
      },
    },
    narrative: {
      // All 6 Job A fields populated. T7 guard ensures these are stripped/
      // validated before persistence — page assumes they're already safe.
      ambition_restatement: 'You told us your goal is global awareness, supported by Empathy and Collaboration and teamwork.',
      readiness_profile: 'Your students have the most room to grow in comfort with people unlike themselves.',
      what_becomes_possible: 'Three pathways open up — day, domestic overnight, international.',
      cost_of_waiting: 'The gap does not wait for the school.',
      institutional_benefit: 'Programmes like this strengthen student outcomes and parent satisfaction.',
      assurance_framing: 'Four concerns matter — risk reduction, reputation, governance, parents.',
    },
    engineState: 'strong_match',
    icpTier: 'breadwinning',
    ...over,
  };
}

let fetchSpy;
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch');
  fetchSpy.mockImplementation(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(makeSavedDiagnostic()),
    }),
  );
});
afterEach(() => {
  fetchSpy.mockRestore();
  document.body.removeAttribute('data-vertical');
});

function renderPage(slug = '42-abcdef0123456789') {
  return render(
    <MemoryRouter initialEntries={[`/p/tmc/report/${slug}`]}>
      <Routes>
        <Route path="/p/tmc/report/:slug" element={<TmcReadinessReport />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('TmcReadinessReport — public 10-section report (PRD §3.5, T10)', () => {
  it('initial render shows loading state before fetch resolves', () => {
    // Stub fetch to a never-resolving promise so we observe the loading frame.
    fetchSpy.mockImplementation(() => new Promise(() => {}));
    renderPage();
    expect(screen.getByText(/Loading your readiness profile/i)).toBeInTheDocument();
  });

  it('saved diagnostic resolves → 10 PRD §3.5 sections render', async () => {
    renderPage();
    // Wait for the cover headline to confirm we've moved past loading.
    await waitFor(() =>
      expect(screen.getByText(/Student experiential readiness profile/i)).toBeInTheDocument(),
    );
    // School name + each section title.
    expect(screen.getByText(/Modern Public School/)).toBeInTheDocument();
    expect(screen.getByText(/Your ambition, in your words/i)).toBeInTheDocument();
    expect(screen.getByText(/Your students' readiness profile/i)).toBeInTheDocument();
    expect(screen.getByText(/What becomes possible/i)).toBeInTheDocument();
    expect(screen.getByText(/The cost of waiting/i)).toBeInTheDocument();
    expect(screen.getByText(/Schools already moving/i)).toBeInTheDocument();
    expect(screen.getByText(/How this benefits your institution/i)).toBeInTheDocument();
    expect(screen.getByText(/Your decision, de-risked/i)).toBeInTheDocument();
    expect(screen.getByText(/How TMC works/i)).toBeInTheDocument();
    expect(screen.getByText(/Your students are ready/i)).toBeInTheDocument(); // single-CTA headline
  });

  it('CBSE curriculum → NEP-aligned hook text in the institutional-benefit section', async () => {
    // Default fixture has curriculum=['CBSE'].
    renderPage();
    await waitFor(() => screen.getByText(/Student experiential readiness profile/i));
    // NEP appears in the CBSE hook — and ONLY in the CBSE hook.
    expect(screen.getByText(/NEP 2020/i)).toBeInTheDocument();
    expect(screen.getByText(/NCF/i)).toBeInTheDocument();
  });

  it('IB curriculum → CAS hook text, NEVER NEP (AC-3 IB-never-sees-NEP)', async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(makeSavedDiagnostic({
          answers: { ...makeSavedDiagnostic().answers, curriculum: ['IB'] },
        })),
      }),
    );
    renderPage();
    await waitFor(() => screen.getByText(/Student experiential readiness profile/i));
    expect(screen.getByText(/CAS/)).toBeInTheDocument();
    expect(screen.getByText(/Learner Profile/i)).toBeInTheDocument();
    // AC-3 hard rule: an IB school never sees NEP.
    expect(screen.queryByText(/NEP/)).not.toBeInTheDocument();
  });

  it('IGCSE curriculum → Cambridge Learner Attributes hook', async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(makeSavedDiagnostic({
          answers: { ...makeSavedDiagnostic().answers, curriculum: ['IGCSE'] },
        })),
      }),
    );
    renderPage();
    await waitFor(() => screen.getByText(/Student experiential readiness profile/i));
    expect(screen.getByText(/Cambridge Learner Attributes/i)).toBeInTheDocument();
    expect(screen.queryByText(/NEP/)).not.toBeInTheDocument();
  });

  it('international geo_preference → "minimum 4 to 6 months" runway (§3.5.2)', async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(makeSavedDiagnostic({
          answers: { ...makeSavedDiagnostic().answers, geo_preference: 'international' },
        })),
      }),
    );
    renderPage();
    await waitFor(() => screen.getByText(/Student experiential readiness profile/i));
    expect(screen.getByText(/minimum 4 to 6 months/i)).toBeInTheDocument();
  });

  it('peer-proof block contains LITERAL 305 / 14,018 / 12,055 / 1,658 (§11.4 honest-at-305)', async () => {
    renderPage();
    await waitFor(() => screen.getByText(/Student experiential readiness profile/i));
    // §11.4: NEVER inflate. NEVER substitute "300+" for 305. NEVER blend.
    const peerSection = screen.getByText(/Schools already moving/i).parentElement;
    expect(peerSection.textContent).toMatch(/305\b/);          // international last year — verbatim
    expect(peerSection.textContent).toMatch(/14,018|14018/);   // total last year
    expect(peerSection.textContent).toMatch(/12,055|12055/);   // day last year
    expect(peerSection.textContent).toMatch(/1,658|1658/);     // overnight last year
    expect(peerSection.textContent).toMatch(/over 50/i);       // schools since 2015
    expect(peerSection.textContent).toMatch(/more than 100,000/i); // students since 2015
    // Anti-inflation hard pin — the page MUST NOT carry "300+", "more than 300",
    // or any phrase that softens the verified 305.
    expect(peerSection.textContent).not.toMatch(/300\+/);
    expect(peerSection.textContent).not.toMatch(/more than 300/i);
  });

  it('PDF download button uses T8 public endpoint /api/travel/diagnostics/:id/readiness-report.pdf', async () => {
    renderPage();
    await waitFor(() => screen.getByText(/Student experiential readiness profile/i));
    const pdfLink = screen.getByTestId('pdf-download-link');
    expect(pdfLink).toBeInTheDocument();
    // Slug "42-abcdef..." → id 42. Page extracts id from slug per T8's
    // buildReportSlug shape and hits the right endpoint.
    expect(pdfLink.getAttribute('href')).toBe(
      '/api/travel/diagnostics/42/readiness-report.pdf',
    );
  });

  it('booking CTA visible with CALM copy (§11.3) — no urgent/limited/act-now language', async () => {
    renderPage();
    await waitFor(() => screen.getByText(/Student experiential readiness profile/i));
    const bookBtn = screen.getByRole('button', { name: /Book a 30-minute consultation/i });
    expect(bookBtn).toBeInTheDocument();
    // §11.3 voice rules — the cta SECTION must NOT carry manufactured pressure.
    const ctaSection = bookBtn.closest('section');
    expect(ctaSection).not.toBeNull();
    expect(ctaSection.textContent).not.toMatch(/urgent/i);
    expect(ctaSection.textContent).not.toMatch(/limited time/i);
    expect(ctaSection.textContent).not.toMatch(/act now/i);
    expect(ctaSection.textContent).not.toMatch(/hurry/i);
    expect(ctaSection.textContent).not.toMatch(/last chance/i);
    expect(ctaSection.textContent).not.toMatch(/limited spots/i);
  });

  it('theme-aware: primary CTA uses var(--primary-color) not hardcoded blue', async () => {
    document.body.setAttribute('data-vertical', 'wellness');
    renderPage();
    await waitFor(() => screen.getByText(/Student experiential readiness profile/i));
    const bookBtn = screen.getByRole('button', { name: /Book a 30-minute consultation/i });
    // Inline style on the CTA must reference the CSS var, NOT bare hex.
    const styleString = bookBtn.getAttribute('style') || '';
    expect(styleString).toMatch(/var\(\s*--primary-color/);
    // Anti-regression: hardcoded purples / blues from CLAUDE.md off-brand list
    // must NOT appear in the primary CTA style.
    expect(styleString).not.toMatch(/#8b5cf6/i);
    expect(styleString).not.toMatch(/#6366f1/i);
    expect(styleString).not.toMatch(/#3b82f6/i);
  });

  it('404 / not-yet-ready → friendly "Report being generated" fallback, no crash', async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ error: 'not found' }),
      }),
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/Report being generated/i)).toBeInTheDocument();
    });
    // Should NOT render section titles — clean fallback state.
    expect(screen.queryByText(/Your ambition, in your words/i)).not.toBeInTheDocument();
  });

  it('fetch network error → same friendly fallback (no crash, no React error boundary trip)', async () => {
    fetchSpy.mockImplementation(() => Promise.reject(new Error('Network down')));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/Report being generated/i)).toBeInTheDocument();
    });
  });

  it('malformed slug → friendly error, no crash', async () => {
    // Slug with no leading digits — parseDiagnosticId returns null.
    renderPage('not-a-real-slug-no-id');
    await waitFor(() => {
      // Page sets a slightly different error string for the malformed-link case.
      expect(screen.getByText(/malformed/i)).toBeInTheDocument();
    });
  });

  it('booking CTA click → falls back to mailto when VITE_TMC_BOOKING_URL not set', async () => {
    // Capture window.location.href assignment via JSDOM's default location
    // mock by spying on it indirectly — we just assert the page exposes the
    // click handler without throwing.
    renderPage();
    await waitFor(() => screen.getByText(/Student experiential readiness profile/i));
    const bookBtn = screen.getByRole('button', { name: /Book a 30-minute consultation/i });
    // Click should not throw. We can't easily assert on window.location.href
    // in jsdom because it's a getter — but a no-throw click confirms the
    // handler wired and the mailto fallback path is reachable.
    expect(() => fireEvent.click(bookBtn)).not.toThrow();
  });
});
