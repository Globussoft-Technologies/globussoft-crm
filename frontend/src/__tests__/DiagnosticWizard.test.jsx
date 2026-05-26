/**
 * DiagnosticWizard.jsx — Travel CRM multi-step diagnostic taker
 * (PRD §4 Q13 / Q16; lands at /travel/diagnostics/new).
 *
 * Pins the frontend contract for the wizard that operators (or visitors
 * via a future public surface) use to actually TAKE a diagnostic — distinct
 * from the sibling pages:
 *   - DiagnosticBuilder.test.jsx  → authoring NEW banks (no GET on mount)
 *   - DiagnosticDetail.test.jsx   → list-and-edit existing diagnostics
 *   - this file                   → multi-step state machine: bank picker
 *                                   → question loop → submit → result card
 *
 * Flow pinned to SUT:
 *   1. Sub-brand picker (4 brands: tmc / rfu / travelstall / visasure;
 *      defaults to "tmc"). Picking a brand re-fires the bank fetch.
 *   2. GET /api/travel/diagnostic-banks?subBrand=<brand>&active=true on
 *      mount + on sub-brand change. Response shape: { banks: [...] }.
 *      Each bank has { id, version, isActive, createdAt, questionsJson }.
 *   3. Bank-row click → parse bank.questionsJson client-side (must be
 *      a JSON string of { questions: [...] }; malformed → notify.error).
 *   4. Question loop: single-choice (q.type !== 'multi-select') sets
 *      answers[qid]=value; multi-select toggles into an array. "Next"
 *      button disabled until current question is answered. "Previous"
 *      rewinds (preserved answers). On last question, "Next" is replaced
 *      by "Submit".
 *   5. POST /api/travel/diagnostics with { bankId, answers } → response
 *      stored in `result` state → ResultCard rendered (score, classification,
 *      classificationLabel, recommendedTier, warnings).
 *
 * Drift pinned vs. prompt:
 *   - Prompt enumerated "route params (likely diagnostic ID + maybe
 *     contactId / leadId)". SUT is at /travel/diagnostics/new and takes
 *     NO route params — contact/lead linkage is omitted in the wizard
 *     entry (the route handler accepts them but the UI doesn't collect
 *     them). No useParams call in SUT.
 *   - Prompt enumerated "step indicator (1 of 5)". SUT renders "Question
 *     N of M" — matches the spirit but verbatim string differs.
 *   - Prompt enumerated "GET on mount loads the question bank". SUT
 *     actually fetches a LIST of banks first (Step 1 of the wizard is
 *     bank selection), then parses the chosen bank's embedded JSON.
 *     No second GET when a bank is picked — the bank row already carries
 *     questionsJson in the list response.
 *   - Prompt enumerated "404 handling for bank-not-found". SUT does NOT
 *     fetch a single bank by id — the bank list could be empty (no active
 *     banks for the brand → empty-state CTA). Adapted to "empty banks list
 *     renders the No active banks CTA".
 *   - Prompt enumerated "completion screen renders a classification badge".
 *     SUT renders score + classificationLabel + classification text +
 *     recommendedTier pill — all four pinned.
 *   - SUT supports optional/multi-select questions; single-choice is the
 *     default branch. Both render paths exercised.
 *   - useNavigate is mocked; ResultCard's "Back to list" click calls
 *     navigate('/travel/diagnostics').
 *
 * Mock-object stability: useNotify + fetchApi mocks are stable refs
 * (CLAUDE.md feedback rule — fresh refs in useCallback / useEffect deps
 * trigger infinite re-render).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

const notifyObj = {
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  confirm: vi.fn(() => Promise.resolve(true)),
  prompt: () => Promise.resolve(''),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

const navigateMock = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

import DiagnosticWizard from '../pages/travel/DiagnosticWizard';

// Realistic 3-question bank: single-choice → multi-select → single-choice.
const QUESTIONS_FIXTURE = {
  questions: [
    {
      id: 'q1',
      type: 'single-choice',
      text: 'How many trips do you organize per year?',
      help: 'Approximate is fine.',
      options: [
        { value: 'low', label: '1-3 trips' },
        { value: 'med', label: '4-10 trips' },
        { value: 'high', label: '11+ trips' },
      ],
    },
    {
      id: 'q2',
      type: 'multi-select',
      text: 'Which destinations have you booked before?',
      options: [
        { value: 'domestic', label: 'Domestic India' },
        { value: 'southeast_asia', label: 'Southeast Asia' },
        { value: 'europe', label: 'Europe' },
      ],
    },
    {
      id: 'q3',
      type: 'single-choice',
      text: 'Preferred booking lead time?',
      options: [
        { value: 'short', label: 'Under 30 days' },
        { value: 'long', label: '30+ days' },
      ],
    },
  ],
};

const BANK_ROW = {
  id: 42,
  version: 3,
  isActive: true,
  createdAt: '2026-05-01T00:00:00Z',
  questionsJson: JSON.stringify(QUESTIONS_FIXTURE),
  scoringRulesJson: JSON.stringify({ method: 'weighted-sum', bands: [] }),
};

const SUBMIT_RESPONSE = {
  score: 72.5,
  classification: 'level_2',
  classificationLabel: 'Established operator',
  recommendedTier: 'pro',
  warnings: [],
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/travel/diagnostics/new']}>
      <DiagnosticWizard />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyObj.error.mockReset();
  notifyObj.success.mockReset();
  notifyObj.info.mockReset();
  navigateMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DiagnosticWizard — Travel multi-step diagnostic taker (PRD §4 Q13 / Q16)', () => {
  it('renders header + back link in the bank-picker step', async () => {
    fetchApiMock.mockResolvedValueOnce({ banks: [] });
    renderPage();
    expect(screen.getByRole('heading', { name: /Take a diagnostic/i })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Back to list/i })).toBeTruthy();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
  });

  it('shows the Loading banks state before the GET resolves', async () => {
    // Hang the promise so the loading state stays visible.
    let resolveBanks;
    fetchApiMock.mockReturnValueOnce(new Promise((r) => { resolveBanks = r; }));
    renderPage();
    expect(screen.getByText(/Loading banks/i)).toBeTruthy();
    resolveBanks({ banks: [] });
    await waitFor(() => expect(screen.queryByText(/Loading banks/i)).toBeNull());
  });

  it('renders all 4 sub-brand pickers and defaults to TMC', async () => {
    fetchApiMock.mockResolvedValueOnce({ banks: [] });
    renderPage();
    const tmc = screen.getByRole('button', { name: /TMC \(school trips\)/i });
    const rfu = screen.getByRole('button', { name: /RFU \(Umrah\)/i });
    const travelstall = screen.getByRole('button', { name: /Travel Stall/i });
    const visasure = screen.getByRole('button', { name: /Visa Sure/i });
    expect(tmc.getAttribute('aria-pressed')).toBe('true');
    expect(rfu.getAttribute('aria-pressed')).toBe('false');
    expect(travelstall.getAttribute('aria-pressed')).toBe('false');
    expect(visasure.getAttribute('aria-pressed')).toBe('false');
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
  });

  it('GETs /api/travel/diagnostic-banks with subBrand=tmc&active=true on mount', async () => {
    fetchApiMock.mockResolvedValueOnce({ banks: [BANK_ROW] });
    renderPage();
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith(
        '/api/travel/diagnostic-banks?subBrand=tmc&active=true',
      );
    });
  });

  it('switching sub-brand re-fires the bank fetch with the new brand', async () => {
    fetchApiMock.mockResolvedValueOnce({ banks: [] });
    renderPage();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledTimes(1));
    fetchApiMock.mockResolvedValueOnce({ banks: [] });
    fireEvent.click(screen.getByRole('button', { name: /RFU \(Umrah\)/i }));
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith(
        '/api/travel/diagnostic-banks?subBrand=rfu&active=true',
      );
    });
  });

  it('renders the empty-state CTA when no active banks exist for the brand', async () => {
    fetchApiMock.mockResolvedValueOnce({ banks: [] });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/No active banks/i)).toBeTruthy();
    });
    expect(screen.getByRole('link', { name: /New bank/i })).toBeTruthy();
  });

  it('renders a bank row with version + active state when banks load', async () => {
    fetchApiMock.mockResolvedValueOnce({ banks: [BANK_ROW] });
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Use bank version 3/i })).toBeTruthy();
    });
    expect(screen.getByText(/Bank v3/i)).toBeTruthy();
  });

  it('picking a bank advances to step 2 + renders the first question', async () => {
    fetchApiMock.mockResolvedValueOnce({ banks: [BANK_ROW] });
    renderPage();
    await waitFor(() => screen.getByRole('button', { name: /Use bank version 3/i }));
    fireEvent.click(screen.getByRole('button', { name: /Use bank version 3/i }));
    expect(screen.getByText(/Question 1 of 3/i)).toBeTruthy();
    expect(
      screen.getByRole('heading', { name: /How many trips do you organize per year/i }),
    ).toBeTruthy();
    // Help text renders too.
    expect(screen.getByText(/Approximate is fine/i)).toBeTruthy();
  });

  it('Next is disabled until the current question is answered, then enables', async () => {
    fetchApiMock.mockResolvedValueOnce({ banks: [BANK_ROW] });
    renderPage();
    await waitFor(() => screen.getByRole('button', { name: /Use bank version 3/i }));
    fireEvent.click(screen.getByRole('button', { name: /Use bank version 3/i }));
    const nextBtn = screen.getByRole('button', { name: /Next question/i });
    expect(nextBtn.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /1-3 trips/i }));
    expect(nextBtn.disabled).toBe(false);
  });

  it('Next advances to the second question + Previous preserves the prior answer', async () => {
    fetchApiMock.mockResolvedValueOnce({ banks: [BANK_ROW] });
    renderPage();
    await waitFor(() => screen.getByRole('button', { name: /Use bank version 3/i }));
    fireEvent.click(screen.getByRole('button', { name: /Use bank version 3/i }));
    fireEvent.click(screen.getByRole('button', { name: /4-10 trips/i }));
    fireEvent.click(screen.getByRole('button', { name: /Next question/i }));
    // Second question (multi-select) is now visible.
    expect(screen.getByText(/Question 2 of 3/i)).toBeTruthy();
    expect(
      screen.getByRole('heading', { name: /Which destinations have you booked before/i }),
    ).toBeTruthy();
    // Rewind via Previous.
    fireEvent.click(screen.getByRole('button', { name: /Previous question/i }));
    expect(screen.getByText(/Question 1 of 3/i)).toBeTruthy();
    // Prior answer is still selected (aria-pressed=true).
    const medOpt = screen.getByRole('button', { name: /4-10 trips/i });
    expect(medOpt.getAttribute('aria-pressed')).toBe('true');
  });

  it('multi-select Q toggles values in an array (answer enables Next)', async () => {
    fetchApiMock.mockResolvedValueOnce({ banks: [BANK_ROW] });
    renderPage();
    await waitFor(() => screen.getByRole('button', { name: /Use bank version 3/i }));
    fireEvent.click(screen.getByRole('button', { name: /Use bank version 3/i }));
    // Advance to multi-select Q2.
    fireEvent.click(screen.getByRole('button', { name: /1-3 trips/i }));
    fireEvent.click(screen.getByRole('button', { name: /Next question/i }));
    const nextBtn = screen.getByRole('button', { name: /Next question/i });
    expect(nextBtn.disabled).toBe(true);
    // Pick two values.
    fireEvent.click(screen.getByRole('button', { name: /Domestic India/i }));
    fireEvent.click(screen.getByRole('button', { name: /Europe/i }));
    expect(nextBtn.disabled).toBe(false);
    // Both selected (aria-pressed=true).
    expect(
      screen.getByRole('button', { name: /Domestic India/i }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      screen.getByRole('button', { name: /Europe/i }).getAttribute('aria-pressed'),
    ).toBe('true');
    // De-toggle one.
    fireEvent.click(screen.getByRole('button', { name: /Domestic India/i }));
    expect(
      screen.getByRole('button', { name: /Domestic India/i }).getAttribute('aria-pressed'),
    ).toBe('false');
  });

  it('on the last question Submit replaces Next + POSTs answers payload + renders the result card', async () => {
    fetchApiMock.mockResolvedValueOnce({ banks: [BANK_ROW] });
    renderPage();
    await waitFor(() => screen.getByRole('button', { name: /Use bank version 3/i }));
    fireEvent.click(screen.getByRole('button', { name: /Use bank version 3/i }));
    fireEvent.click(screen.getByRole('button', { name: /1-3 trips/i }));
    fireEvent.click(screen.getByRole('button', { name: /Next question/i }));
    fireEvent.click(screen.getByRole('button', { name: /Domestic India/i }));
    fireEvent.click(screen.getByRole('button', { name: /Next question/i }));
    // Last question → Submit instead of Next.
    expect(screen.getByText(/Question 3 of 3/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Next question/i })).toBeNull();
    const submitBtn = screen.getByRole('button', { name: /Submit diagnostic/i });
    expect(submitBtn.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /30\+ days/i }));
    expect(submitBtn.disabled).toBe(false);

    fetchApiMock.mockResolvedValueOnce(SUBMIT_RESPONSE);
    fireEvent.click(submitBtn);

    await waitFor(() => {
      const submitCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/diagnostics' && o?.method === 'POST',
      );
      expect(submitCall).toBeTruthy();
      const body = JSON.parse(submitCall[1].body);
      expect(body.bankId).toBe(42);
      expect(body.answers).toEqual({ q1: 'low', q2: ['domestic'], q3: 'long' });
    });

    // Result card renders.
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Diagnostic complete/i })).toBeTruthy();
    });
    expect(screen.getByText(/72\.50/)).toBeTruthy();
    expect(screen.getByText(/Established operator/i)).toBeTruthy();
    expect(screen.getByText(/Classification:\s*level_2/i)).toBeTruthy();
    expect(screen.getByText(/Recommended tier:\s*pro/i)).toBeTruthy();
    expect(notifyObj.success).toHaveBeenCalledWith('Diagnostic submitted.');
  });

  it('result card warnings panel renders + notify.info fires when warnings ship back', async () => {
    fetchApiMock.mockResolvedValueOnce({ banks: [BANK_ROW] });
    renderPage();
    await waitFor(() => screen.getByRole('button', { name: /Use bank version 3/i }));
    fireEvent.click(screen.getByRole('button', { name: /Use bank version 3/i }));
    fireEvent.click(screen.getByRole('button', { name: /1-3 trips/i }));
    fireEvent.click(screen.getByRole('button', { name: /Next question/i }));
    fireEvent.click(screen.getByRole('button', { name: /Europe/i }));
    fireEvent.click(screen.getByRole('button', { name: /Next question/i }));
    fireEvent.click(screen.getByRole('button', { name: /Under 30 days/i }));

    fetchApiMock.mockResolvedValueOnce({
      ...SUBMIT_RESPONSE,
      warnings: ['Unscored answer for q2', 'Band edge case'],
    });
    fireEvent.click(screen.getByRole('button', { name: /Submit diagnostic/i }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Scoring warnings/i })).toBeTruthy();
    });
    expect(screen.getByText(/Unscored answer for q2/i)).toBeTruthy();
    expect(notifyObj.info).toHaveBeenCalled();
    const infoMsg = notifyObj.info.mock.calls[0][0];
    expect(infoMsg).toMatch(/2 warning\(s\)/i);
  });

  it('Change bank rewinds from step 2 back to the bank picker', async () => {
    fetchApiMock.mockResolvedValueOnce({ banks: [BANK_ROW] });
    renderPage();
    await waitFor(() => screen.getByRole('button', { name: /Use bank version 3/i }));
    fireEvent.click(screen.getByRole('button', { name: /Use bank version 3/i }));
    // Now in step 2.
    expect(screen.getByText(/Question 1 of 3/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Change bank/i }));
    // Back to step 1.
    expect(screen.getByRole('heading', { name: /Take a diagnostic/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Use bank version 3/i })).toBeTruthy();
  });

  it('malformed bank JSON surfaces notify.error and stays on the picker step', async () => {
    fetchApiMock.mockResolvedValueOnce({
      banks: [{ ...BANK_ROW, questionsJson: '{ not valid' }],
    });
    renderPage();
    await waitFor(() => screen.getByRole('button', { name: /Use bank version 3/i }));
    fireEvent.click(screen.getByRole('button', { name: /Use bank version 3/i }));
    expect(notifyObj.error).toHaveBeenCalled();
    const msg = notifyObj.error.mock.calls[0][0];
    expect(msg).toMatch(/Bank JSON is malformed/i);
    // Still on the picker step — no question heading rendered.
    expect(screen.queryByText(/Question 1 of/i)).toBeNull();
  });

  it('bank with zero questions surfaces notify.error and stays on the picker step', async () => {
    fetchApiMock.mockResolvedValueOnce({
      banks: [{ ...BANK_ROW, questionsJson: JSON.stringify({ questions: [] }) }],
    });
    renderPage();
    await waitFor(() => screen.getByRole('button', { name: /Use bank version 3/i }));
    fireEvent.click(screen.getByRole('button', { name: /Use bank version 3/i }));
    expect(notifyObj.error).toHaveBeenCalled();
    const msg = notifyObj.error.mock.calls[0][0];
    expect(msg).toMatch(/no questions/i);
    expect(screen.queryByText(/Question 1 of/i)).toBeNull();
  });

  it('GET banks failure surfaces notify.error + leaves the picker empty', async () => {
    fetchApiMock.mockRejectedValueOnce({
      status: 500,
      body: { error: 'Backend exploded' },
    });
    renderPage();
    await waitFor(() => {
      expect(notifyObj.error).toHaveBeenCalled();
    });
    expect(notifyObj.error.mock.calls[0][0]).toMatch(/Backend exploded/i);
    expect(screen.getByText(/No active banks/i)).toBeTruthy();
  });

  it('POST diagnostics failure surfaces notify.error + stays on the question step (no result card)', async () => {
    fetchApiMock.mockResolvedValueOnce({ banks: [BANK_ROW] });
    renderPage();
    await waitFor(() => screen.getByRole('button', { name: /Use bank version 3/i }));
    fireEvent.click(screen.getByRole('button', { name: /Use bank version 3/i }));
    fireEvent.click(screen.getByRole('button', { name: /1-3 trips/i }));
    fireEvent.click(screen.getByRole('button', { name: /Next question/i }));
    fireEvent.click(screen.getByRole('button', { name: /Europe/i }));
    fireEvent.click(screen.getByRole('button', { name: /Next question/i }));
    fireEvent.click(screen.getByRole('button', { name: /Under 30 days/i }));

    fetchApiMock.mockRejectedValueOnce({
      status: 409,
      body: { error: 'Bank is not active' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Submit diagnostic/i }));

    await waitFor(() => {
      expect(notifyObj.error).toHaveBeenCalled();
    });
    expect(notifyObj.error.mock.calls[0][0]).toMatch(/Bank is not active/i);
    // Still on the question step — no result-card heading.
    expect(screen.queryByRole('heading', { name: /Diagnostic complete/i })).toBeNull();
  });

  it('result card "Back to list" navigates to /travel/diagnostics', async () => {
    fetchApiMock.mockResolvedValueOnce({ banks: [BANK_ROW] });
    renderPage();
    await waitFor(() => screen.getByRole('button', { name: /Use bank version 3/i }));
    fireEvent.click(screen.getByRole('button', { name: /Use bank version 3/i }));
    fireEvent.click(screen.getByRole('button', { name: /1-3 trips/i }));
    fireEvent.click(screen.getByRole('button', { name: /Next question/i }));
    fireEvent.click(screen.getByRole('button', { name: /Europe/i }));
    fireEvent.click(screen.getByRole('button', { name: /Next question/i }));
    fireEvent.click(screen.getByRole('button', { name: /Under 30 days/i }));

    fetchApiMock.mockResolvedValueOnce(SUBMIT_RESPONSE);
    fireEvent.click(screen.getByRole('button', { name: /Submit diagnostic/i }));

    await waitFor(() => screen.getByRole('heading', { name: /Diagnostic complete/i }));
    fireEvent.click(screen.getByRole('button', { name: /Back to diagnostics list/i }));
    expect(navigateMock).toHaveBeenCalledWith('/travel/diagnostics');
  });
});
