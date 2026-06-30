/**
 * TravelStallQuiz.jsx — public Family Travel Quiz wizard (PRD §4.7).
 *
 * The page calls the unauthenticated endpoints landed in commit 1260caa:
 *   GET  /api/travel/diagnostics/public/banks?tenantSlug=…&subBrand=…
 *   POST /api/travel/diagnostics/public/submit
 *
 * Both go through raw `fetch()` (not utils/api.fetchApi) because the
 * page renders outside the AuthContext shell — so we mock global.fetch
 * with vi.spyOn(globalThis, 'fetch'). One stable mock-fn-set per test
 * file per CLAUDE.md feedback rule.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TravelStallQuiz from '../pages/public/TravelStallQuiz';

const BANK_RESPONSE = {
  tenantSlug: 'travel-stall',
  tenantName: 'Travel Stall Demo',
  subBrand: 'travelstall',
  bankId: 99,
  version: 1,
  questions: [
    {
      id: 'q1',
      text: "Who's travelling?",
      type: 'single-choice',
      options: [
        { value: 'solo', label: 'Solo or couple' },
        { value: 'multigen', label: 'Multi-generational' },
      ],
    },
    {
      id: 'q2',
      text: 'Pace?',
      type: 'single-choice',
      options: [
        { value: 'relaxed', label: 'Relaxed' },
        { value: 'packed', label: 'Packed' },
      ],
    },
  ],
};

const SUBMIT_RESPONSE = {
  tenantSlug: 'travel-stall',
  subBrand: 'travelstall',
  classification: 'level_3',
  classificationLabel: 'Premium Family Concierge',
  recommendedTier: 'premium',
  reportPdfUrl: '/api/uploads/diagnostics/diag-1-abc.pdf',
  message: "Thanks Aisha — our advisor will reach out to you on +919876543210 shortly.",
};

let fetchSpy;
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});
afterEach(() => {
  fetchSpy.mockRestore();
});

function mockOk(body) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
}
function mockFail(status, body) {
  return Promise.resolve({ ok: false, status, json: () => Promise.resolve(body) });
}

function renderQuiz(path = '/travel-stall/quiz') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <TravelStallQuiz />
    </MemoryRouter>,
  );
}

describe('TravelStallQuiz — public wizard (PRD §4.7)', () => {
  it('renders the bank questions after fetching on mount', async () => {
    fetchSpy.mockImplementation((url) => {
      if (url.startsWith('/api/travel/diagnostics/public/banks')) return mockOk(BANK_RESPONSE);
      return mockOk({});
    });
    renderQuiz();
    await screen.findByText(/Who's travelling\?/);
    expect(screen.getByText(/Pace\?/)).toBeTruthy();
    expect(screen.getByText(/Travel Stall Demo/)).toBeTruthy();
  });

  it('passes ?tenant= query through to the bank fetch', async () => {
    fetchSpy.mockImplementation((url) => {
      if (url.startsWith('/api/travel/diagnostics/public/banks')) return mockOk(BANK_RESPONSE);
      return mockOk({});
    });
    renderQuiz('/travel-stall/quiz?tenant=franchise-pune');
    await screen.findByText(/Who's travelling\?/);
    const calledWith = fetchSpy.mock.calls[0][0];
    expect(calledWith).toContain('tenantSlug=franchise-pune');
    expect(calledWith).toContain('subBrand=travelstall');
  });

  it('shows a friendly error when the bank fetch fails', async () => {
    fetchSpy.mockImplementation((url) => {
      if (url.startsWith('/api/travel/diagnostics/public/banks')) return mockFail(500, {});
      return mockOk({});
    });
    renderQuiz();
    await screen.findByText(/unavailable right now/i);
  });

  it('disables submit until all questions answered AND lead fields valid', async () => {
    fetchSpy.mockImplementation((url) => {
      if (url.startsWith('/api/travel/diagnostics/public/banks')) return mockOk(BANK_RESPONSE);
      return mockOk({});
    });
    renderQuiz();
    await screen.findByText(/Who's travelling\?/);
    const submitBtn = screen.getByRole('button', { name: /See my recommendation/i });
    expect(submitBtn).toBeDisabled();

    // Answer q1 only — still disabled.
    fireEvent.click(screen.getByLabelText('Solo or couple'));
    expect(submitBtn).toBeDisabled();

    // Answer q2 too — still disabled because no name/phone yet.
    fireEvent.click(screen.getByLabelText('Relaxed'));
    expect(submitBtn).toBeDisabled();

    // Add name + valid phone — now enabled.
    fireEvent.change(screen.getByPlaceholderText(/Your name/i), { target: { value: 'Aisha Khan' } });
    fireEvent.change(screen.getByPlaceholderText(/Phone/i), { target: { value: '+919876543210' } });
    await waitFor(() => expect(submitBtn).not.toBeDisabled());

    // Invalid phone re-disables.
    fireEvent.change(screen.getByPlaceholderText(/Phone/i), { target: { value: 'abc' } });
    await waitFor(() => expect(submitBtn).toBeDisabled());
  });

  it('submits the quiz and shows the persona result screen', async () => {
    fetchSpy.mockImplementation((url, opts) => {
      if (url.startsWith('/api/travel/diagnostics/public/banks')) return mockOk(BANK_RESPONSE);
      if (url === '/api/travel/diagnostics/public/submit' && opts?.method === 'POST') {
        return mockOk(SUBMIT_RESPONSE);
      }
      return mockOk({});
    });
    renderQuiz();
    await screen.findByText(/Who's travelling\?/);
    fireEvent.click(screen.getByLabelText('Multi-generational'));
    fireEvent.click(screen.getByLabelText('Packed'));
    fireEvent.change(screen.getByPlaceholderText(/Your name/i), { target: { value: 'Aisha Khan' } });
    fireEvent.change(screen.getByPlaceholderText(/Phone/i), { target: { value: '+919876543210' } });
    fireEvent.click(screen.getByRole('button', { name: /See my recommendation/i }));

    // Result screen appears.
    await screen.findByText(/Premium Family Concierge/);
    expect(screen.getByText(/Recommended tier:/)).toBeTruthy();
    // "Premium" appears in both the persona heading AND the tier line;
    // getAllByText length>=2 captures the duplicate without coupling
    // to a specific element. CLAUDE.md feedback rule on shared labels.
    expect(screen.getAllByText(/Premium/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/advisor will reach out/i)).toBeTruthy();
    expect(screen.getByRole('link', { name: /personalised report/i })).toHaveAttribute(
      'href',
      '/api/uploads/diagnostics/diag-1-abc.pdf',
    );

    // Verify the submit body shape.
    const submitCall = fetchSpy.mock.calls.find((c) => c[0] === '/api/travel/diagnostics/public/submit');
    const body = JSON.parse(submitCall[1].body);
    expect(body.bankId).toBe(99);
    expect(body.answers).toEqual({ q1: 'multigen', q2: 'packed' });
    expect(body.name).toBe('Aisha Khan');
    expect(body.phone).toBe('+919876543210');
    expect(body.email).toBeUndefined(); // empty string → omitted
  });

  it('shows a submit-time error and stays on the form when POST fails', async () => {
    fetchSpy.mockImplementation((url, opts) => {
      if (url.startsWith('/api/travel/diagnostics/public/banks')) return mockOk(BANK_RESPONSE);
      if (url === '/api/travel/diagnostics/public/submit' && opts?.method === 'POST') {
        return mockFail(500, { error: 'Server is taking a nap.' });
      }
      return mockOk({});
    });
    renderQuiz();
    await screen.findByText(/Who's travelling\?/);
    fireEvent.click(screen.getByLabelText('Multi-generational'));
    fireEvent.click(screen.getByLabelText('Packed'));
    fireEvent.change(screen.getByPlaceholderText(/Your name/i), { target: { value: 'Aisha Khan' } });
    fireEvent.change(screen.getByPlaceholderText(/Phone/i), { target: { value: '+919876543210' } });
    fireEvent.click(screen.getByRole('button', { name: /See my recommendation/i }));

    await screen.findByRole('alert');
    expect(screen.getByText(/Server is taking a nap/)).toBeTruthy();
    // Still on the form (no result screen).
    expect(screen.queryByText(/Premium Family Concierge/)).toBeNull();
  });

  it('retake-the-quiz button returns to the empty form', async () => {
    fetchSpy.mockImplementation((url, opts) => {
      if (url.startsWith('/api/travel/diagnostics/public/banks')) return mockOk(BANK_RESPONSE);
      if (url === '/api/travel/diagnostics/public/submit' && opts?.method === 'POST') {
        return mockOk(SUBMIT_RESPONSE);
      }
      return mockOk({});
    });
    renderQuiz();
    await screen.findByText(/Who's travelling\?/);
    fireEvent.click(screen.getByLabelText('Multi-generational'));
    fireEvent.click(screen.getByLabelText('Packed'));
    fireEvent.change(screen.getByPlaceholderText(/Your name/i), { target: { value: 'Aisha' } });
    fireEvent.change(screen.getByPlaceholderText(/Phone/i), { target: { value: '+919876543210' } });
    fireEvent.click(screen.getByRole('button', { name: /See my recommendation/i }));

    await screen.findByText(/Premium Family Concierge/);
    fireEvent.click(screen.getByRole('button', { name: /Retake the quiz/i }));
    // Form re-appears, and the radio for q1 is no longer checked.
    await screen.findByText(/Who's travelling\?/);
    expect(screen.getByLabelText('Multi-generational').checked).toBe(false);
  });
});
