/**
 * TmcReadiness.jsx — public TMC 12-question readiness diagnostic
 * (PRD §3.1, slice T9).
 *
 * Posts to POST /api/travel/diagnostics/public/submit-tmc (T8 endpoint).
 * Renders outside the AuthContext shell — uses raw `fetch()`, mocked via
 * vi.spyOn(globalThis, 'fetch'). Follows the sibling TravelStallQuiz
 * test pattern + CLAUDE.md "stable mock object reference" rule by
 * letting vitest restore the spy per test (no closures held by
 * useCallback deps in this page).
 *
 * Contract pins:
 *  - Q1 is rendered first with progress "1/12"
 *  - Forward/back nav preserves per-question state
 *  - Q12 email is the ONLY hard wall — empty + invalid both block POST
 *  - Valid email at Q12 triggers POST with the full answers shape
 *  - 201 success navigates to /p/tmc/report/:reportSlug (T10 target)
 *  - 500 failure renders inline error, no navigation
 *  - Skipped non-Q12 questions are OMITTED from the POSTed answers
 *  - Progress bar advances N/12 as user clicks Next
 *  - Theme-variable CTA renders under data-vertical="wellness"
 *  - Multi-select Q2 (secondary_skills) caps at exactly 2 picks
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import TmcReadiness from '../pages/public/TmcReadiness';

const SUBMIT_OK = {
  diagnosticId: 42,
  reportSlug: 'r-0000000042-abcde',
  tenantSlug: 'tmc',
  engineState: 'strong_match',
  message: 'Thanks, Aisha — your readiness profile is ready.',
};

let fetchSpy;
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch');
  // Default: any unmatched call returns ok-empty so we don't get
  // unhandled rejections in tests that don't care about the POST body.
  fetchSpy.mockImplementation(() =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }),
  );
});
afterEach(() => {
  fetchSpy.mockRestore();
  document.body.removeAttribute('data-vertical');
});

// Inline route-watcher so tests can assert on navigation.
function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="probe-path">{loc.pathname}</div>;
}

function renderForm(path = '/p/tmc/readiness') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/p/tmc/readiness" element={<TmcReadiness />} />
        <Route path="/p/tmc/report/:slug" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

// Helper: click Next until we land on a target question text. Each call
// to Next advances one screen; we cap at TOTAL (12) iterations to avoid
// infinite loops on test bugs.
async function clickNextUntil(matcher, max = 12) {
  for (let i = 0; i < max; i++) {
    if (screen.queryByText(matcher)) return;
    const next = screen.getByRole('button', { name: /Next/i });
    fireEvent.click(next);
  }
  throw new Error(`Did not reach screen matching ${matcher}`);
}

describe('TmcReadiness — public 12-Q form (PRD §3.1, T9)', () => {
  it('Q1 is rendered first with progress 1/12', () => {
    renderForm();
    expect(screen.getByText(/one outcome you most want this trip to produce/i)).toBeTruthy();
    // Progress label '1/12'
    expect(screen.getByText('1/12')).toBeTruthy();
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('1');
    expect(bar.getAttribute('aria-valuemax')).toBe('12');
  });

  it('Q1 selection persists when navigating forward then back', () => {
    renderForm();
    // Pick "Confidence" on Q1
    fireEvent.click(screen.getByLabelText('Confidence'));
    expect(screen.getByLabelText('Confidence').checked).toBe(true);
    // Forward → Q2
    fireEvent.click(screen.getByRole('button', { name: /Next/i }));
    expect(screen.getByText(/Which two skills/i)).toBeTruthy();
    // Back → Q1 should be checked still
    fireEvent.click(screen.getByRole('button', { name: /Back/i }));
    expect(screen.getByLabelText('Confidence').checked).toBe(true);
  });

  it('progress label advances N/12 as user clicks Next', () => {
    renderForm();
    expect(screen.getByText('1/12')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Next/i }));
    expect(screen.getByText('2/12')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Next/i }));
    expect(screen.getByText('3/12')).toBeTruthy();
  });

  it('Q12 empty email → inline error → no POST fired', async () => {
    renderForm();
    // Skip all the way to Q12 (no answers).
    for (let i = 0; i < 11; i++) {
      fireEvent.click(screen.getByRole('button', { name: /Next/i }));
    }
    expect(screen.getByText(/Where should we send your readiness profile/i)).toBeTruthy();
    // Don't fill anything. Submit.
    fireEvent.click(screen.getByRole('button', { name: /See my readiness report/i }));
    // The Q12 helper text also includes "Email is required" — assert on
    // the role=alert error specifically so we don't match helper copy.
    await screen.findByRole('alert');
    expect(screen.getByText(/Email is required to generate your readiness report/i)).toBeTruthy();
    // No POST should have fired
    const postCalls = fetchSpy.mock.calls.filter(
      (c) => c[1]?.method === 'POST',
    );
    expect(postCalls.length).toBe(0);
  });

  it('Q12 invalid email format → inline error → no POST fired', async () => {
    renderForm();
    // Skip to Q12
    for (let i = 0; i < 11; i++) {
      fireEvent.click(screen.getByRole('button', { name: /Next/i }));
    }
    const emailInput = screen.getByLabelText('Email');
    fireEvent.change(emailInput, { target: { value: 'not-an-email' } });
    fireEvent.click(screen.getByRole('button', { name: /See my readiness report/i }));
    await screen.findByText(/valid email/i);
    const postCalls = fetchSpy.mock.calls.filter((c) => c[1]?.method === 'POST');
    expect(postCalls.length).toBe(0);
  });

  it('valid Q12 email → POST fires with the full answers shape', async () => {
    fetchSpy.mockImplementation((url, opts) => {
      if (url === '/api/travel/diagnostics/public/submit-tmc' && opts?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          status: 201,
          json: () => Promise.resolve(SUBMIT_OK),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
    renderForm();
    // Q1 → Confidence
    fireEvent.click(screen.getByLabelText('Confidence'));
    fireEvent.click(screen.getByRole('button', { name: /Next/i }));
    // Q2 → pick TWO skills
    fireEvent.click(screen.getByLabelText('Empathy'));
    fireEvent.click(screen.getByLabelText('Self-awareness'));
    fireEvent.click(screen.getByRole('button', { name: /Next/i }));
    // Skip Q3-Q11
    for (let i = 0; i < 9; i++) {
      fireEvent.click(screen.getByRole('button', { name: /Next/i }));
    }
    // Q12 — email valid
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'principal@example-school.in' },
    });
    fireEvent.click(screen.getByRole('button', { name: /See my readiness report/i }));

    await waitFor(() => {
      const calls = fetchSpy.mock.calls.filter((c) => c[1]?.method === 'POST');
      expect(calls.length).toBe(1);
    });
    const postCall = fetchSpy.mock.calls.find((c) => c[1]?.method === 'POST');
    expect(postCall[0]).toBe('/api/travel/diagnostics/public/submit-tmc');
    const body = JSON.parse(postCall[1].body);
    expect(body.tenantSlug).toBe('tmc');
    expect(body.answers.primary_outcome).toBe('confidence');
    expect(body.answers.secondary_skills).toEqual(['Empathy', 'Self-awareness']);
    expect(body.answers.contact.email).toBe('principal@example-school.in');
    // Skipped questions omitted (not nulled)
    expect(body.answers.growth_area).toBeUndefined();
    expect(body.answers.travel_maturity).toBeUndefined();
  });

  it('POST success → navigates to /p/tmc/report/:reportSlug', async () => {
    fetchSpy.mockImplementation((url, opts) => {
      if (url === '/api/travel/diagnostics/public/submit-tmc' && opts?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          status: 201,
          json: () => Promise.resolve(SUBMIT_OK),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
    renderForm();
    // Skip to Q12
    for (let i = 0; i < 11; i++) {
      fireEvent.click(screen.getByRole('button', { name: /Next/i }));
    }
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'sumit@globussoft.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /See my readiness report/i }));

    await waitFor(() => {
      expect(screen.getByTestId('probe-path').textContent).toBe(
        '/p/tmc/report/r-0000000042-abcde',
      );
    });
  });

  it('POST error → inline error, no navigation', async () => {
    fetchSpy.mockImplementation((url, opts) => {
      if (url === '/api/travel/diagnostics/public/submit-tmc' && opts?.method === 'POST') {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({ error: 'Engine had a hiccup. Please retry.' }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
    renderForm();
    for (let i = 0; i < 11; i++) {
      fireEvent.click(screen.getByRole('button', { name: /Next/i }));
    }
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'principal@example.in' },
    });
    fireEvent.click(screen.getByRole('button', { name: /See my readiness report/i }));

    await screen.findByText(/Engine had a hiccup/i);
    // Did NOT navigate
    expect(screen.queryByTestId('probe-path')).toBeNull();
  });

  it('skipped non-Q12 questions are omitted from POST body (not nulled)', async () => {
    fetchSpy.mockImplementation((url, opts) => {
      if (url === '/api/travel/diagnostics/public/submit-tmc' && opts?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          status: 201,
          json: () => Promise.resolve(SUBMIT_OK),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
    renderForm();
    // Skip every question. At Q12, only fill email.
    for (let i = 0; i < 11; i++) {
      fireEvent.click(screen.getByRole('button', { name: /Next/i }));
    }
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'aisha@school.edu' },
    });
    fireEvent.click(screen.getByRole('button', { name: /See my readiness report/i }));

    await waitFor(() => {
      const calls = fetchSpy.mock.calls.filter((c) => c[1]?.method === 'POST');
      expect(calls.length).toBe(1);
    });
    const postCall = fetchSpy.mock.calls.find((c) => c[1]?.method === 'POST');
    const body = JSON.parse(postCall[1].body);
    // Only `contact.email` should be present in answers.
    expect(body.answers.primary_outcome).toBeUndefined();
    expect(body.answers.secondary_skills).toBeUndefined();
    expect(body.answers.grade_band).toBeUndefined();
    expect(body.answers.contact.email).toBe('aisha@school.edu');
    // No null poisoning of skipped fields.
    expect(JSON.stringify(body.answers)).not.toContain(':null');
  });

  it('Q2 multi-select caps at exactly 2 picks (third click is blocked)', () => {
    renderForm();
    // Forward to Q2
    fireEvent.click(screen.getByLabelText('Confidence'));
    fireEvent.click(screen.getByRole('button', { name: /Next/i }));
    expect(screen.getByText(/Which two skills/i)).toBeTruthy();

    // Pick two — both check.
    fireEvent.click(screen.getByLabelText('Empathy'));
    fireEvent.click(screen.getByLabelText('Mindfulness'));
    expect(screen.getByLabelText('Empathy').checked).toBe(true);
    expect(screen.getByLabelText('Mindfulness').checked).toBe(true);

    // Third click is blocked (cap=2).
    fireEvent.click(screen.getByLabelText('Self-awareness'));
    expect(screen.getByLabelText('Self-awareness').checked).toBe(false);

    // Counter shows 2/2
    expect(screen.getByText(/Selected:\s*2\s*\/\s*2/)).toBeTruthy();
  });

  it('Q3 single-mapped persists both value and mappedSkill on POST', async () => {
    fetchSpy.mockImplementation((url, opts) => {
      if (url === '/api/travel/diagnostics/public/submit-tmc' && opts?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          status: 201,
          json: () => Promise.resolve(SUBMIT_OK),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
    renderForm();
    // Q1 skip
    fireEvent.click(screen.getByRole('button', { name: /Next/i }));
    // Q2 skip
    fireEvent.click(screen.getByRole('button', { name: /Next/i }));
    // Q3 — pick the "Comfort with people unlike themselves" option whose
    // mappedSkill is "Cultural respect and inclusion" (per seed-travel.js).
    fireEvent.click(screen.getByLabelText(/Comfort with people unlike themselves/));
    // Skip the rest
    for (let i = 0; i < 9; i++) {
      fireEvent.click(screen.getByRole('button', { name: /Next/i }));
    }
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'p@example.in' },
    });
    fireEvent.click(screen.getByRole('button', { name: /See my readiness report/i }));

    await waitFor(() => {
      const calls = fetchSpy.mock.calls.filter((c) => c[1]?.method === 'POST');
      expect(calls.length).toBe(1);
    });
    const body = JSON.parse(
      fetchSpy.mock.calls.find((c) => c[1]?.method === 'POST')[1].body,
    );
    expect(body.answers.growth_area).toBe('comfort_with_difference');
    expect(body.answers.growth_area_skill).toBe('Cultural respect and inclusion');
  });

  it('tenant query param ?tenant=foo flows into POST tenantSlug', async () => {
    fetchSpy.mockImplementation((url, opts) => {
      if (url === '/api/travel/diagnostics/public/submit-tmc' && opts?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          status: 201,
          json: () => Promise.resolve(SUBMIT_OK),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
    renderForm('/p/tmc/readiness?tenant=delhi-public');
    for (let i = 0; i < 11; i++) {
      fireEvent.click(screen.getByRole('button', { name: /Next/i }));
    }
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'p@example.in' },
    });
    fireEvent.click(screen.getByRole('button', { name: /See my readiness report/i }));

    await waitFor(() => {
      const calls = fetchSpy.mock.calls.filter((c) => c[1]?.method === 'POST');
      expect(calls.length).toBe(1);
    });
    const body = JSON.parse(
      fetchSpy.mock.calls.find((c) => c[1]?.method === 'POST')[1].body,
    );
    expect(body.tenantSlug).toBe('delhi-public');
  });

  it('theme-variable CTA is used (no hardcoded blue) under data-vertical="wellness"', () => {
    document.body.setAttribute('data-vertical', 'wellness');
    renderForm();
    // The primary CTA on Q1 is "Next". Inline style background should be
    // a var(--primary-color, ...) reference, NOT a hardcoded hex.
    const next = screen.getByRole('button', { name: /Next/i });
    const bg = next.style.background;
    // jsdom returns the inline style verbatim. Match the var() form.
    expect(bg).toMatch(/var\(--primary-color/);
    expect(bg).not.toMatch(/#3b82f6/);
    expect(bg).not.toMatch(/#8b5cf6/);
  });
});
