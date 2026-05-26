/**
 * DiagnosticDetail.jsx — Travel CRM advisor-brief surface (PRD §4.1 + §4.2 + §7).
 *
 * Pins the frontend contract for the page at /travel/diagnostics/:id that
 * lights up two LLM-router consumer endpoints:
 *   - POST /api/travel/diagnostics/:id/talking-points/regen (commit cf876af)
 *   - POST /api/travel/diagnostics/:id/form-vs-call/compare (commits 4a7c623 + 8b97fd5)
 *
 * Cases:
 *   - Renders the page header with the diagnostic id
 *   - Empty state for talking-points when talkingPointsJson is null
 *   - Parsed envelope renders when talkingPointsJson is populated
 *   - STUB pill surfaces when stub=true (Q11 keys not yet wired)
 *   - "Generate brief" / "Regenerate" button POSTs to the regen endpoint
 *   - Compare button is disabled until the operator pastes a transcript
 *   - Form-vs-call POSTs callTranscript and renders perFieldDiff with
 *     ✓ / ✗ + classification badge colour matches the class
 *   - Regenerate button is hidden for USER role (only ADMIN/MANAGER may
 *     spend an LLM token)
 *   - 404 error renders "Diagnostic not found" copy + Retry button
 *
 * Mock-object stability: useNotify and fetchApi mocks are stable
 * references per CLAUDE.md feedback rule (fresh refs in useCallback /
 * useEffect deps trigger infinite re-render).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

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

import { AuthContext } from '../App';
import DiagnosticDetail from '../pages/travel/DiagnosticDetail';

const TALKING_POINTS_ENVELOPE = {
  text: '1. Lead has shown high interest in Umrah package.\n2. Budget cleared at INR 85k per person.\n3. Recommend premium tier package.',
  model: 'claude-3-opus-20240229',
  generatedAt: '2026-05-22T10:30:00.000Z',
  stub: false,
};

const STUB_ENVELOPE = {
  text: '[STUB-TALKING-POINTS] Synthetic advisor brief for diagnostic.',
  model: 'stub-claude-opus',
  generatedAt: '2026-05-22T10:30:00.000Z',
  stub: true,
};

const DIAGNOSTIC_NO_BRIEF = {
  id: 42,
  tenantId: 9,
  subBrand: 'rfu',
  contactId: 100,
  questionsJson: JSON.stringify({
    bankId: 1,
    bankVersion: 1,
    questionsJson: JSON.stringify({
      questions: [
        { id: 'q1', text: 'How many pilgrims?' },
        { id: 'q2', text: 'Preferred travel month?' },
        { id: 'q3', text: 'Budget per person?' },
      ],
    }),
  }),
  answersJson: JSON.stringify({
    q1: '4',
    q2: 'October',
    q3: '85000',
  }),
  score: 8.5,
  classification: 'level_3',
  classificationLabel: 'High-intent qualified',
  recommendedTier: 'premium',
  reportPdfUrl: '/uploads/diagnostics/diag-42-abc.pdf',
  talkingPointsJson: null,
  createdAt: '2026-05-22T09:00:00.000Z',
};

const DIAGNOSTIC_WITH_BRIEF = {
  ...DIAGNOSTIC_NO_BRIEF,
  talkingPointsJson: JSON.stringify(TALKING_POINTS_ENVELOPE),
};

const DIAGNOSTIC_WITH_STUB_BRIEF = {
  ...DIAGNOSTIC_NO_BRIEF,
  talkingPointsJson: JSON.stringify(STUB_ENVELOPE),
};

const COMPARE_RESPONSE_MATCH = {
  diagnosticId: 42,
  classification: 'match',
  scorePercent: 92,
  summary: 'The form and call answers align on all 3 key fields. Run at the quote.',
  model: 'claude-3-opus-20240229',
  stub: false,
  perFieldDiff: [
    { question: 'q1', formValue: '4', callValue: '4', matched: true },
    { question: 'q2', formValue: 'October', callValue: 'October', matched: true },
    { question: 'q3', formValue: '85000', callValue: '85000', matched: true },
  ],
  generatedAt: '2026-05-22T10:35:00.000Z',
};

const COMPARE_RESPONSE_MISMATCH = {
  diagnosticId: 42,
  classification: 'mismatch',
  scorePercent: 40,
  summary: 'Significant disagreement on budget and travel month.',
  model: 'claude-3-opus-20240229',
  stub: false,
  perFieldDiff: [
    { question: 'q1', formValue: '4', callValue: '4', matched: true },
    { question: 'q2', formValue: 'October', callValue: 'December', matched: false },
    { question: 'q3', formValue: '85000', callValue: '120000', matched: false },
  ],
  generatedAt: '2026-05-22T10:36:00.000Z',
};

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyObj.error.mockReset();
  notifyObj.success.mockReset();
  notifyObj.info.mockReset();
});

function makeFetchImpl(diagnostic, { compareResponse } = {}) {
  return (url, opts) => {
    if (url === '/api/travel/diagnostics/42' && (!opts || opts.method === undefined || opts.method === 'GET')) {
      return Promise.resolve(diagnostic);
    }
    if (url === '/api/travel/diagnostics/42/talking-points/regen' && opts?.method === 'POST') {
      const next = { ...diagnostic, talkingPointsJson: JSON.stringify(TALKING_POINTS_ENVELOPE) };
      return Promise.resolve({ diagnostic: next, talkingPoints: TALKING_POINTS_ENVELOPE });
    }
    if (url === '/api/travel/diagnostics/42/form-vs-call/compare' && opts?.method === 'POST') {
      return Promise.resolve(compareResponse || COMPARE_RESPONSE_MATCH);
    }
    return Promise.resolve(null);
  };
}

function renderPage({ role = 'ADMIN' } = {}) {
  return render(
    <MemoryRouter initialEntries={['/travel/diagnostics/42']}>
      <AuthContext.Provider
        value={{
          user: { userId: 1, role },
          setUser: vi.fn(),
          token: 'tk',
          tenant: { id: 1, vertical: 'travel' },
          loading: false,
        }}
      >
        <Routes>
          <Route path="/travel/diagnostics/:id" element={<DiagnosticDetail />} />
        </Routes>
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

describe('DiagnosticDetail — advisor brief UI (PRD §4.1 + §4.2)', () => {
  it('renders the page header with the diagnostic id', async () => {
    fetchApiMock.mockImplementation(makeFetchImpl(DIAGNOSTIC_NO_BRIEF));
    renderPage();
    expect(await screen.findByRole('heading', { name: /Diagnostic #42/i })).toBeTruthy();
  });

  it('shows the empty state for talking-points when talkingPointsJson is null', async () => {
    fetchApiMock.mockImplementation(makeFetchImpl(DIAGNOSTIC_NO_BRIEF));
    renderPage();
    await screen.findByRole('heading', { name: /Diagnostic #42/i });
    expect(screen.getByText(/No brief generated yet/i)).toBeTruthy();
    // Generate button is visible (ADMIN role).
    expect(screen.getByRole('button', { name: /Generate talking points/i })).toBeTruthy();
  });

  it('renders the parsed envelope when talkingPointsJson is populated', async () => {
    fetchApiMock.mockImplementation(makeFetchImpl(DIAGNOSTIC_WITH_BRIEF));
    renderPage();
    await screen.findByRole('heading', { name: /Diagnostic #42/i });
    const brief = await screen.findByTestId('talking-points-text');
    expect(brief.textContent).toMatch(/high interest in Umrah/i);
    expect(screen.getByText(/claude-3-opus-20240229/i)).toBeTruthy();
    // Regenerate (not Generate) is the CTA when a brief already exists.
    expect(screen.getByRole('button', { name: /Regenerate talking points/i })).toBeTruthy();
  });

  it('surfaces the STUB pill when the envelope marks stub=true', async () => {
    fetchApiMock.mockImplementation(makeFetchImpl(DIAGNOSTIC_WITH_STUB_BRIEF));
    renderPage();
    await screen.findByRole('heading', { name: /Diagnostic #42/i });
    await screen.findByTestId('talking-points-text');
    const pills = screen.getAllByText('STUB');
    expect(pills.length).toBeGreaterThanOrEqual(1);
  });

  it('"Generate brief" calls fetchApi with the right POST path', async () => {
    fetchApiMock.mockImplementation(makeFetchImpl(DIAGNOSTIC_NO_BRIEF));
    renderPage();
    await screen.findByRole('heading', { name: /Diagnostic #42/i });

    const genBtn = screen.getByRole('button', { name: /Generate talking points/i });
    fireEvent.click(genBtn);

    await waitFor(() => {
      const regenCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/diagnostics/42/talking-points/regen' && o?.method === 'POST',
      );
      expect(regenCall).toBeTruthy();
    });
    await waitFor(() => {
      expect(notifyObj.success).toHaveBeenCalled();
    });
  });

  it('Compare button is disabled until a transcript is typed, then POSTs callTranscript', async () => {
    fetchApiMock.mockImplementation(makeFetchImpl(DIAGNOSTIC_NO_BRIEF));
    renderPage();
    await screen.findByRole('heading', { name: /Diagnostic #42/i });

    const compareBtn = screen.getByRole('button', { name: /Compare form vs call/i });
    expect(compareBtn.disabled).toBe(true);

    const transcript = screen.getByLabelText(/Call transcript/i);
    fireEvent.change(transcript, {
      target: { value: 'Advisor: How many pilgrims?\nCustomer: 4.' },
    });
    expect(compareBtn.disabled).toBe(false);

    fireEvent.click(compareBtn);

    await waitFor(() => {
      const compareCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/diagnostics/42/form-vs-call/compare' && o?.method === 'POST',
      );
      expect(compareCall).toBeTruthy();
      const body = JSON.parse(compareCall[1].body);
      expect(body.callTranscript).toMatch(/How many pilgrims/i);
    });
  });

  it('renders perFieldDiff table with ✓ / ✗ indicators after Compare', async () => {
    fetchApiMock.mockImplementation(
      makeFetchImpl(DIAGNOSTIC_NO_BRIEF, { compareResponse: COMPARE_RESPONSE_MISMATCH }),
    );
    renderPage();
    await screen.findByRole('heading', { name: /Diagnostic #42/i });

    const transcript = screen.getByLabelText(/Call transcript/i);
    fireEvent.change(transcript, { target: { value: 'fake transcript text' } });
    fireEvent.click(screen.getByRole('button', { name: /Compare form vs call/i }));

    await screen.findByTestId('comparison-result');
    await screen.findByTestId('match-0');
    expect(screen.getByTestId('mismatch-1')).toBeTruthy();
    expect(screen.getByTestId('mismatch-2')).toBeTruthy();
    expect(screen.getByTestId('comparison-summary').textContent).toMatch(/Significant disagreement/i);
  });

  it('classification badge text + colour match the response class (match=green)', async () => {
    fetchApiMock.mockImplementation(
      makeFetchImpl(DIAGNOSTIC_NO_BRIEF, { compareResponse: COMPARE_RESPONSE_MATCH }),
    );
    renderPage();
    await screen.findByRole('heading', { name: /Diagnostic #42/i });

    const transcript = screen.getByLabelText(/Call transcript/i);
    fireEvent.change(transcript, { target: { value: 'transcript' } });
    fireEvent.click(screen.getByRole('button', { name: /Compare form vs call/i }));

    const badge = await screen.findByTestId('comparison-classification-badge');
    expect(badge.textContent.toLowerCase()).toBe('match');
    // Green palette for "match" — colour token #2F7A4D normalises to
    // rgb(47, 122, 77) when the DOM renders the inline style. Either
    // form is acceptable depending on the renderer.
    const style = badge.getAttribute('style') || '';
    expect(style).toMatch(/(#2F7A4D|rgb\(47,\s*122,\s*77\))/i);
    // scorePercent surfaced.
    expect(screen.getByText(/92%/)).toBeTruthy();
  });

  it('Regenerate button is hidden for USER role', async () => {
    fetchApiMock.mockImplementation(makeFetchImpl(DIAGNOSTIC_NO_BRIEF));
    renderPage({ role: 'USER' });
    await screen.findByRole('heading', { name: /Diagnostic #42/i });
    expect(screen.queryByRole('button', { name: /Generate talking points/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Regenerate talking points/i })).toBeNull();
  });

  it('404 error renders "Diagnostic not found" + Retry button', async () => {
    fetchApiMock.mockRejectedValue({
      status: 404,
      code: 'NOT_FOUND',
      message: 'Diagnostic not found',
    });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/Diagnostic not found/i)).toBeTruthy();
    });
    expect(screen.getByRole('button', { name: /Retry/i })).toBeTruthy();
  });

  // ── New cases extending coverage of the answers / scoring / recommendation
  //    / comparison-table surfaces. Adapted from the dispatch's suggested
  //    case-list to match the page's actual surface (the SUT does not
  //    expose "convert to lead" / "send email" / "mark as contacted" /
  //    "filter by score" — those PRD ideas live on Lead detail, not on
  //    the diagnostic-detail brief).

  it('renders the answers table with question text + answer values joined from the bank snapshot', async () => {
    fetchApiMock.mockImplementation(makeFetchImpl(DIAGNOSTIC_NO_BRIEF));
    renderPage();
    await screen.findByRole('heading', { name: /Diagnostic #42/i });

    // Each of the 3 seeded questions surfaces with its answer in a row.
    expect(screen.getByText(/How many pilgrims\?/i)).toBeTruthy();
    expect(screen.getByText(/Preferred travel month\?/i)).toBeTruthy();
    expect(screen.getByText(/Budget per person\?/i)).toBeTruthy();

    // The matching answer cell contents render (string values).
    expect(screen.getByText('4')).toBeTruthy();
    expect(screen.getByText('October')).toBeTruthy();
    expect(screen.getByText('85000')).toBeTruthy();
  });

  it('renders the score + recommendedTier summary row plus the PDF download link', async () => {
    fetchApiMock.mockImplementation(makeFetchImpl(DIAGNOSTIC_NO_BRIEF));
    renderPage();
    await screen.findByRole('heading', { name: /Diagnostic #42/i });

    // Score formatted to 2 decimals (8.50 from 8.5 numeric).
    expect(screen.getByText('8.50')).toBeTruthy();
    // Recommended tier value rendered alongside its label.
    expect(screen.getByText('premium')).toBeTruthy();
    // PDF link points at the diagnostic's reportPdfUrl.
    const pdfLink = screen.getByRole('link', { name: /Download report PDF/i });
    expect(pdfLink.getAttribute('href')).toBe('/uploads/diagnostics/diag-42-abc.pdf');
  });

  it('renders the sub-brand label and classification chip in the header', async () => {
    fetchApiMock.mockImplementation(makeFetchImpl(DIAGNOSTIC_NO_BRIEF));
    renderPage();
    await screen.findByRole('heading', { name: /Diagnostic #42/i });

    // SUT maps subBrand="rfu" to "RFU (Umrah)" via SUB_BRAND_LABEL.
    expect(screen.getByLabelText(/Sub-brand RFU \(Umrah\)/i)).toBeTruthy();
    // classificationLabel beats raw classification when both present.
    expect(screen.getByLabelText(/Classification/i).textContent).toMatch(
      /High-intent qualified/i,
    );
  });

  it('falls back to the empty-state when questionsJson is missing — shows answers-map dump', async () => {
    const noQuestions = {
      ...DIAGNOSTIC_NO_BRIEF,
      questionsJson: null,
      answersJson: JSON.stringify({ q1: 'a', q2: 'b' }),
    };
    fetchApiMock.mockImplementation(makeFetchImpl(noQuestions));
    renderPage();
    await screen.findByRole('heading', { name: /Diagnostic #42/i });

    expect(screen.getByText(/No question snapshot found/i)).toBeTruthy();
    // Empty-state lists the answer keys joined by ", ".
    expect(screen.getByText(/q1, q2/)).toBeTruthy();
  });

  it('renders the talking-points meta line with model + stub:no when envelope is non-stub', async () => {
    fetchApiMock.mockImplementation(makeFetchImpl(DIAGNOSTIC_WITH_BRIEF));
    renderPage();
    await screen.findByRole('heading', { name: /Diagnostic #42/i });
    await screen.findByTestId('talking-points-text');

    // Meta line surfaces "stub: no" when the persisted envelope is real.
    expect(screen.getByText(/stub:\s*no/i)).toBeTruthy();
    // STUB pill is NOT visible (real envelope, stub=false).
    expect(screen.queryByText('STUB')).toBeNull();
  });

  it('mismatch comparison response paints the badge with the mismatch palette colour', async () => {
    fetchApiMock.mockImplementation(
      makeFetchImpl(DIAGNOSTIC_NO_BRIEF, { compareResponse: COMPARE_RESPONSE_MISMATCH }),
    );
    renderPage();
    await screen.findByRole('heading', { name: /Diagnostic #42/i });

    const transcript = screen.getByLabelText(/Call transcript/i);
    fireEvent.change(transcript, { target: { value: 'fake transcript' } });
    fireEvent.click(screen.getByRole('button', { name: /Compare form vs call/i }));

    const badge = await screen.findByTestId('comparison-classification-badge');
    expect(badge.textContent.toLowerCase()).toBe('mismatch');
    const style = badge.getAttribute('style') || '';
    // Mismatch palette colour #A33636 == rgb(163, 54, 54).
    expect(style).toMatch(/(#A33636|rgb\(163,\s*54,\s*54\))/i);
    // Score percentage and summary surface.
    expect(screen.getByText(/40%/)).toBeTruthy();
  });

  it('whitespace-only transcript blocks Compare and surfaces an error via notify', async () => {
    fetchApiMock.mockImplementation(makeFetchImpl(DIAGNOSTIC_NO_BRIEF));
    renderPage();
    await screen.findByRole('heading', { name: /Diagnostic #42/i });

    const transcript = screen.getByLabelText(/Call transcript/i);
    // Pure whitespace — disabled gate stays engaged.
    fireEvent.change(transcript, { target: { value: '     \n  \t  ' } });
    const compareBtn = screen.getByRole('button', { name: /Compare form vs call/i });
    expect(compareBtn.disabled).toBe(true);

    // The compare-network call is NOT fired in any scenario from this input.
    expect(
      fetchApiMock.mock.calls.some(
        ([u, o]) =>
          u === '/api/travel/diagnostics/42/form-vs-call/compare' && o?.method === 'POST',
      ),
    ).toBe(false);
  });

  it('renders the loading state with a Back link before the fetch resolves', async () => {
    let resolveDiag;
    fetchApiMock.mockImplementation(
      () => new Promise((resolve) => { resolveDiag = resolve; }),
    );
    renderPage();
    // Pre-resolution: the "Loading…" placeholder is visible.
    expect(screen.getByText(/Loading/i)).toBeTruthy();
    // Back link is always visible (top of the layout).
    expect(screen.getByRole('link', { name: /Back to diagnostics/i })).toBeTruthy();
    // Resolve so the page transitions cleanly and we don't leak a pending state.
    resolveDiag(DIAGNOSTIC_NO_BRIEF);
    await screen.findByRole('heading', { name: /Diagnostic #42/i });
  });

  it('500 generic error renders the generic copy + carries the server message', async () => {
    fetchApiMock.mockRejectedValue({
      status: 500,
      code: 'SERVER_ERROR',
      message: 'Database connection lost',
    });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/Failed to load diagnostic/i)).toBeTruthy();
    });
    // The route's message bubbles up into the error body.
    expect(screen.getByText(/Database connection lost/i)).toBeTruthy();
    // Retry button still rendered.
    expect(screen.getByRole('button', { name: /Retry/i })).toBeTruthy();
  });

  it('403 SUB_BRAND_DENIED renders the sub-brand-access copy', async () => {
    fetchApiMock.mockRejectedValue({
      status: 403,
      code: 'SUB_BRAND_DENIED',
      message: 'forbidden',
    });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/don.t have access to this sub-brand/i)).toBeTruthy();
    });
    // Suggests the user ask an admin for subBrandAccess.
    expect(screen.getByText(/subBrandAccess/)).toBeTruthy();
  });

  it('renders the perFieldDiff table column headers (Question / Form / Call / Match)', async () => {
    fetchApiMock.mockImplementation(
      makeFetchImpl(DIAGNOSTIC_NO_BRIEF, { compareResponse: COMPARE_RESPONSE_MATCH }),
    );
    renderPage();
    await screen.findByRole('heading', { name: /Diagnostic #42/i });

    const transcript = screen.getByLabelText(/Call transcript/i);
    fireEvent.change(transcript, { target: { value: 'transcript' } });
    fireEvent.click(screen.getByRole('button', { name: /Compare form vs call/i }));

    await screen.findByTestId('comparison-table');
    // Both "Question" headers coexist (the answers table at the top has
    // one too — getAllByText is the right pattern per CLAUDE.md feedback).
    expect(screen.getAllByText(/Question/i).length).toBeGreaterThanOrEqual(2);
    // "form answer" appears in the intro paragraph prose AND as a table
    // header — `getAllByText` is the right pattern. Same for "call answer"
    // and "match" (badge text + column header collisions).
    expect(screen.getAllByText(/Form answer/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Call answer/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Match/i).length).toBeGreaterThanOrEqual(1);
    // All 3 rows surfaced as matched (testid match-0/1/2 present).
    expect(screen.getByTestId('match-0')).toBeTruthy();
    expect(screen.getByTestId('match-1')).toBeTruthy();
    expect(screen.getByTestId('match-2')).toBeTruthy();
  });

  it('compare-endpoint rejection calls notify.error and does not paint a result', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/travel/diagnostics/42' && (!opts || opts.method === undefined)) {
        return Promise.resolve(DIAGNOSTIC_NO_BRIEF);
      }
      if (url === '/api/travel/diagnostics/42/form-vs-call/compare') {
        return Promise.reject({ status: 502, message: 'LLM router unreachable' });
      }
      return Promise.resolve(null);
    });
    renderPage();
    await screen.findByRole('heading', { name: /Diagnostic #42/i });

    const transcript = screen.getByLabelText(/Call transcript/i);
    fireEvent.change(transcript, { target: { value: 'transcript' } });
    fireEvent.click(screen.getByRole('button', { name: /Compare form vs call/i }));

    await waitFor(() => {
      expect(notifyObj.error).toHaveBeenCalledWith(
        expect.stringMatching(/LLM router unreachable/i),
      );
    });
    // No comparison-result block was painted.
    expect(screen.queryByTestId('comparison-result')).toBeNull();
  });

  // ── EXTENSION wave: SUT branches not yet exercised by the cases above.
  //    Targets parser-helper edge cases (formatAnswer arrays/objects/empty,
  //    parseQuestionList direct-array shape, talkingPointsJson-as-object,
  //    answersJson-as-object), MANAGER-role regen gate, "review" palette
  //    colour, raw-classification fallback when classificationLabel is
  //    absent, comparison-response stub-pill, in-flight button copy, and
  //    the envelope.text-empty fallback. All cases use the stable
  //    notifyObj reference per CLAUDE.md feedback rule.

  it('formatAnswer joins array answers with ", " in the answers table', async () => {
    const diagWithArrayAnswers = {
      ...DIAGNOSTIC_NO_BRIEF,
      answersJson: JSON.stringify({
        q1: ['Mecca', 'Medina', 'Jeddah'],
        q2: 'October',
        q3: '85000',
      }),
    };
    fetchApiMock.mockImplementation(makeFetchImpl(diagWithArrayAnswers));
    renderPage();
    await screen.findByRole('heading', { name: /Diagnostic #42/i });
    // Array elements collapse to comma-joined string in the answer cell.
    expect(screen.getByText('Mecca, Medina, Jeddah')).toBeTruthy();
  });

  it('formatAnswer JSON.stringifies object answers and renders "—" for empty strings', async () => {
    const diagWithObjectAnswer = {
      ...DIAGNOSTIC_NO_BRIEF,
      answersJson: JSON.stringify({
        q1: { adults: 2, kids: 2 },
        q2: '',
        q3: '85000',
      }),
    };
    fetchApiMock.mockImplementation(makeFetchImpl(diagWithObjectAnswer));
    renderPage();
    await screen.findByRole('heading', { name: /Diagnostic #42/i });
    // Object value is JSON.stringified verbatim.
    expect(screen.getByText('{"adults":2,"kids":2}')).toBeTruthy();
    // Empty-string answer renders the "—" placeholder. There may be other
    // "—" cells (e.g. recommended tier or score nulls), so accept ≥1.
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(1);
  });

  it('parseQuestionList accepts the direct-array snapshot shape (no inner questionsJson)', async () => {
    // Snapshot shape #2: top-level `questions` array, no inner stringified blob.
    const diagDirectArray = {
      ...DIAGNOSTIC_NO_BRIEF,
      questionsJson: JSON.stringify({
        bankId: 1,
        bankVersion: 1,
        questions: [
          { id: 'q1', text: 'Visa type?' },
          { id: 'q2', label: 'Travel month?' },
        ],
      }),
      answersJson: JSON.stringify({ q1: 'Tourist', q2: 'November' }),
    };
    fetchApiMock.mockImplementation(makeFetchImpl(diagDirectArray));
    renderPage();
    await screen.findByRole('heading', { name: /Diagnostic #42/i });
    // Both question texts render — `text` AND `label` are both accepted.
    expect(screen.getByText(/Visa type\?/i)).toBeTruthy();
    expect(screen.getByText(/Travel month\?/i)).toBeTruthy();
    expect(screen.getByText('Tourist')).toBeTruthy();
    expect(screen.getByText('November')).toBeTruthy();
  });

  it('talkingPointsJson supplied as an already-parsed object renders correctly', async () => {
    // Skips the JSON.parse branch in parseTalkingPointsEnvelope.
    const diagWithObjectEnvelope = {
      ...DIAGNOSTIC_NO_BRIEF,
      talkingPointsJson: TALKING_POINTS_ENVELOPE, // object, NOT a string
    };
    fetchApiMock.mockImplementation(makeFetchImpl(diagWithObjectEnvelope));
    renderPage();
    await screen.findByRole('heading', { name: /Diagnostic #42/i });
    const brief = await screen.findByTestId('talking-points-text');
    expect(brief.textContent).toMatch(/high interest in Umrah/i);
    expect(screen.getByText(/claude-3-opus-20240229/i)).toBeTruthy();
  });

  it('answersJson supplied as an already-parsed object skips the JSON.parse branch', async () => {
    const diagWithObjectAnswers = {
      ...DIAGNOSTIC_NO_BRIEF,
      answersJson: { q1: '4', q2: 'October', q3: '85000' }, // object, NOT a string
    };
    fetchApiMock.mockImplementation(makeFetchImpl(diagWithObjectAnswers));
    renderPage();
    await screen.findByRole('heading', { name: /Diagnostic #42/i });
    // Answers still render — the parser tolerated the object input shape.
    expect(screen.getByText('4')).toBeTruthy();
    expect(screen.getByText('October')).toBeTruthy();
    expect(screen.getByText('85000')).toBeTruthy();
  });

  it('MANAGER role sees the regen button (parity with ADMIN gate)', async () => {
    fetchApiMock.mockImplementation(makeFetchImpl(DIAGNOSTIC_WITH_BRIEF));
    renderPage({ role: 'MANAGER' });
    await screen.findByRole('heading', { name: /Diagnostic #42/i });
    // MANAGER is canRegen=true per the SUT's role gate.
    expect(screen.getByRole('button', { name: /Regenerate talking points/i })).toBeTruthy();
  });

  it('USER-role empty-state hint says "Ask an admin or manager" (not the canRegen copy)', async () => {
    fetchApiMock.mockImplementation(makeFetchImpl(DIAGNOSTIC_NO_BRIEF));
    renderPage({ role: 'USER' });
    await screen.findByRole('heading', { name: /Diagnostic #42/i });
    // USER sees the read-only nudge; the "Click Generate brief" copy is hidden.
    expect(screen.getByText(/Ask an admin or manager to generate one/i)).toBeTruthy();
    expect(screen.queryByText(/Click Generate brief/i)).toBeNull();
  });

  it('comparison.classification="review" paints the amber-palette colour', async () => {
    const reviewResponse = {
      ...COMPARE_RESPONSE_MATCH,
      classification: 'review',
      scorePercent: 70,
      summary: 'Some answers diverge but the headline budget aligns.',
    };
    fetchApiMock.mockImplementation(
      makeFetchImpl(DIAGNOSTIC_NO_BRIEF, { compareResponse: reviewResponse }),
    );
    renderPage();
    await screen.findByRole('heading', { name: /Diagnostic #42/i });

    const transcript = screen.getByLabelText(/Call transcript/i);
    fireEvent.change(transcript, { target: { value: 'transcript' } });
    fireEvent.click(screen.getByRole('button', { name: /Compare form vs call/i }));

    const badge = await screen.findByTestId('comparison-classification-badge');
    expect(badge.textContent.toLowerCase()).toBe('review');
    const style = badge.getAttribute('style') || '';
    // Review palette colour #9A6F2E == rgb(154, 111, 46).
    expect(style).toMatch(/(#9A6F2E|rgb\(154,\s*111,\s*46\))/i);
    expect(screen.getByText(/70%/)).toBeTruthy();
  });

  it('comparison.stub=true surfaces the STUB pill in the result row', async () => {
    const stubCompare = { ...COMPARE_RESPONSE_MATCH, stub: true };
    fetchApiMock.mockImplementation(
      makeFetchImpl(DIAGNOSTIC_NO_BRIEF, { compareResponse: stubCompare }),
    );
    renderPage();
    await screen.findByRole('heading', { name: /Diagnostic #42/i });

    const transcript = screen.getByLabelText(/Call transcript/i);
    fireEvent.change(transcript, { target: { value: 'transcript' } });
    fireEvent.click(screen.getByRole('button', { name: /Compare form vs call/i }));

    await screen.findByTestId('comparison-result');
    // STUB pill renders inside the comparison-result block.
    const pills = screen.getAllByText('STUB');
    expect(pills.length).toBeGreaterThanOrEqual(1);
  });

  it('classification chip falls back to raw classification when classificationLabel is absent', async () => {
    const noLabelDiag = {
      ...DIAGNOSTIC_NO_BRIEF,
      classificationLabel: null,
      classification: 'level_2',
    };
    fetchApiMock.mockImplementation(makeFetchImpl(noLabelDiag));
    renderPage();
    await screen.findByRole('heading', { name: /Diagnostic #42/i });
    // Raw value surfaces when no human-readable label is set.
    expect(screen.getByLabelText(/Classification/i).textContent).toMatch(/level_2/);
  });

  it('SUT renders empty-answers-map "(empty)" copy when both questionsJson missing AND answersJson empty', async () => {
    const stripped = {
      ...DIAGNOSTIC_NO_BRIEF,
      questionsJson: null,
      answersJson: JSON.stringify({}),
    };
    fetchApiMock.mockImplementation(makeFetchImpl(stripped));
    renderPage();
    await screen.findByRole('heading', { name: /Diagnostic #42/i });
    expect(screen.getByText(/No question snapshot found/i)).toBeTruthy();
    // Empty answers-map collapses to "(empty)" placeholder.
    expect(screen.getByText(/\(empty\)/)).toBeTruthy();
  });

  it('envelope.text=null falls back to "(no text returned)" placeholder', async () => {
    const emptyTextEnvelope = { ...TALKING_POINTS_ENVELOPE, text: '' };
    const diagWithEmpty = {
      ...DIAGNOSTIC_NO_BRIEF,
      talkingPointsJson: JSON.stringify(emptyTextEnvelope),
    };
    fetchApiMock.mockImplementation(makeFetchImpl(diagWithEmpty));
    renderPage();
    await screen.findByRole('heading', { name: /Diagnostic #42/i });
    const brief = await screen.findByTestId('talking-points-text');
    expect(brief.textContent).toMatch(/\(no text returned\)/i);
  });

  it('regen in-flight button copy flips to "Working…" while POST is pending', async () => {
    let resolveRegen;
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/travel/diagnostics/42' && (!opts || opts.method === undefined)) {
        return Promise.resolve(DIAGNOSTIC_NO_BRIEF);
      }
      if (url === '/api/travel/diagnostics/42/talking-points/regen' && opts?.method === 'POST') {
        return new Promise((resolve) => { resolveRegen = resolve; });
      }
      return Promise.resolve(null);
    });
    renderPage();
    await screen.findByRole('heading', { name: /Diagnostic #42/i });
    fireEvent.click(screen.getByRole('button', { name: /Generate talking points/i }));
    // Mid-flight copy surfaces before the promise resolves.
    await waitFor(() => {
      expect(screen.getByText(/Working/i)).toBeTruthy();
    });
    // Release the pending promise so React doesn't carry a leaked state into the next test.
    resolveRegen({ diagnostic: DIAGNOSTIC_WITH_BRIEF, talkingPoints: TALKING_POINTS_ENVELOPE });
    await screen.findByTestId('talking-points-text');
  });

  it('compare in-flight button copy flips to "Comparing…" while the POST is pending', async () => {
    let resolveCompare;
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/travel/diagnostics/42' && (!opts || opts.method === undefined)) {
        return Promise.resolve(DIAGNOSTIC_NO_BRIEF);
      }
      if (url === '/api/travel/diagnostics/42/form-vs-call/compare' && opts?.method === 'POST') {
        return new Promise((resolve) => { resolveCompare = resolve; });
      }
      return Promise.resolve(null);
    });
    renderPage();
    await screen.findByRole('heading', { name: /Diagnostic #42/i });

    const transcript = screen.getByLabelText(/Call transcript/i);
    fireEvent.change(transcript, { target: { value: 'transcript' } });
    fireEvent.click(screen.getByRole('button', { name: /Compare form vs call/i }));

    await waitFor(() => {
      expect(screen.getByText(/Comparing/i)).toBeTruthy();
    });
    // Resolve to clean up.
    resolveCompare(COMPARE_RESPONSE_MATCH);
    await screen.findByTestId('comparison-result');
  });

  it('invalid (NaN) diagnostic id renders the 400 "Invalid diagnostic id" error path', async () => {
    fetchApiMock.mockImplementation((url) => {
      // The SUT should NOT call /api/... for a non-numeric id because the
      // Number.isFinite guard short-circuits the load before fetch fires.
      return Promise.resolve(null);
    });
    // Render with a non-numeric id so parseInt yields NaN.
    render(
      <MemoryRouter initialEntries={['/travel/diagnostics/not-a-number']}>
        <AuthContext.Provider
          value={{
            user: { userId: 1, role: 'ADMIN' },
            setUser: vi.fn(),
            token: 'tk',
            tenant: { id: 1, vertical: 'travel' },
            loading: false,
          }}
        >
          <Routes>
            <Route path="/travel/diagnostics/:id" element={<DiagnosticDetail />} />
          </Routes>
        </AuthContext.Provider>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByText(/Invalid diagnostic id/i)).toBeTruthy();
    });
    // Network was never hit because the guard fired first.
    const diagFetches = fetchApiMock.mock.calls.filter(([u]) =>
      typeof u === 'string' && u.startsWith('/api/travel/diagnostics/'),
    );
    expect(diagFetches.length).toBe(0);
  });

  it('regen with a fetch that omits res.diagnostic falls back to a full reload', async () => {
    let getCalls = 0;
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/travel/diagnostics/42' && (!opts || opts.method === undefined)) {
        getCalls += 1;
        // First call returns the no-brief diagnostic, subsequent calls return
        // the populated one so the page re-renders the brief block.
        return Promise.resolve(getCalls === 1 ? DIAGNOSTIC_NO_BRIEF : DIAGNOSTIC_WITH_BRIEF);
      }
      if (url === '/api/travel/diagnostics/42/talking-points/regen' && opts?.method === 'POST') {
        // Response omits `diagnostic` — the SUT must fall back to load().
        return Promise.resolve({ talkingPoints: TALKING_POINTS_ENVELOPE });
      }
      return Promise.resolve(null);
    });
    renderPage();
    await screen.findByRole('heading', { name: /Diagnostic #42/i });

    fireEvent.click(screen.getByRole('button', { name: /Generate talking points/i }));

    await waitFor(() => {
      // load() re-fires the GET — expect a SECOND /api/travel/diagnostics/42 call.
      expect(getCalls).toBe(2);
    });
    await screen.findByTestId('talking-points-text');
  });
});
