/**
 * DiagnosticBuilder.jsx — Travel CRM diagnostic-bank authoring page
 * (PRD §4 Q13 / Q16; lands at /travel/diagnostics/banks/new).
 *
 * Pins the frontend contract for the NEW-bank builder. Unlike its
 * sibling DiagnosticDetail (which is a list-and-edit surface for an
 * existing diagnostic), this page is a single-shot create form:
 *   - no GET on mount (no list to fetch — the form starts pre-seeded
 *     with the EXAMPLE constants for questions + scoring bands)
 *   - sub-brand picker (4 brands: tmc / rfu / travelstall / visasure)
 *   - two authoring modes via tabs: Visual (default, form-based) +
 *     JSON (advanced, raw textareas). The JSON string state
 *     (qJson / rJson) is the single source of truth — visual edits
 *     parse → mutate → re-serialize so both tabs ship the same payload
 *   - Add / remove / reorder controls for questions + scoring bands
 *   - Per-question option editing (value / label / weight)
 *   - Local-only Validate button (no network) + Create button that
 *     POSTs to /api/travel/diagnostic-banks
 *   - Export CSV (GET .../export.csv via raw fetch + getAuthToken)
 *   - Import CSV (POST .../import.csv via raw fetch with file body)
 *   - Parse-error panel when JSON tab is hand-edited into invalid JSON
 *
 * Drift pinned vs. prompt:
 *   - SUT does NOT call any GET endpoint on mount. There's no list of
 *     existing banks; the page is purely the create form. The prompt
 *     enumerated "GET on mount" / "empty-state" / "render existing
 *     questions" — adapted to "starts with EXAMPLE constants → Visual
 *     tab shows 2 example questions / 3 example bands".
 *   - SUT has NO drag-reorder; reorder is chevron-up/down IconBtn
 *     instances. Adapted accordingly (no HTML5 drag).
 *   - SUT has NO publish-flow (Q16: existing banks aren't mutated;
 *     create always ships v(N+1)). No publish endpoint.
 *   - SUT has NO RBAC gating in the page chrome itself (admin-only is
 *     enforced by the route, not the page). No USER-role hide test.
 *   - POST shape is { subBrand, questionsJson, scoringRulesJson } —
 *     pinned verbatim against routes/travel_diagnostics.js POST handler.
 *   - Both CSVs use RAW fetch (with Authorization header from
 *     getAuthToken), NOT fetchApi. Mocked via global.fetch.
 *
 * Mock-object stability: useNotify + fetchApi mocks are stable refs
 * (CLAUDE.md feedback rule — fresh refs in useCallback / useEffect
 * deps trigger infinite re-render).
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

import DiagnosticBuilder from '../pages/travel/DiagnosticBuilder';

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/travel/diagnostics/banks/new']}>
      <DiagnosticBuilder />
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

describe('DiagnosticBuilder — Travel diagnostic-bank authoring (PRD §4 Q13 / Q16)', () => {
  it('renders the page header + heading + back link', () => {
    renderPage();
    expect(screen.getByRole('heading', { name: /New Diagnostic Bank/i })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Back to list/i })).toBeTruthy();
  });

  it('renders all 4 sub-brand pickers and defaults to TMC', () => {
    renderPage();
    const tmc = screen.getByRole('button', { name: /TMC \(school trips\)/i });
    const rfu = screen.getByRole('button', { name: /RFU \(Umrah\)/i });
    const travelstall = screen.getByRole('button', { name: /Travel Stall/i });
    const visasure = screen.getByRole('button', { name: /Visa Sure/i });
    expect(tmc.getAttribute('aria-pressed')).toBe('true');
    expect(rfu.getAttribute('aria-pressed')).toBe('false');
    expect(travelstall.getAttribute('aria-pressed')).toBe('false');
    expect(visasure.getAttribute('aria-pressed')).toBe('false');
  });

  it('switches the active sub-brand when a different brand is clicked', () => {
    renderPage();
    const rfu = screen.getByRole('button', { name: /RFU \(Umrah\)/i });
    fireEvent.click(rfu);
    expect(rfu.getAttribute('aria-pressed')).toBe('true');
    const tmc = screen.getByRole('button', { name: /TMC \(school trips\)/i });
    expect(tmc.getAttribute('aria-pressed')).toBe('false');
  });

  it('defaults to Visual tab and shows seeded example questions + bands', () => {
    renderPage();
    const visualTab = screen.getByRole('tab', { name: /Visual builder/i });
    expect(visualTab.getAttribute('aria-selected')).toBe('true');
    // The QUESTIONS_EXAMPLE constant seeds 2 questions.
    expect(screen.getByRole('heading', { name: /Questions \(2\)/i })).toBeTruthy();
    // SCORING_EXAMPLE seeds 3 bands.
    expect(screen.getByRole('heading', { name: /Scoring bands \(3\)/i })).toBeTruthy();
  });

  it('switches to JSON tab and renders both textareas with seeded JSON', () => {
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: /JSON \(advanced\)/i }));
    const qTextarea = screen.getByLabelText(/Questions JSON/i);
    const rTextarea = screen.getByLabelText(/Scoring rules JSON/i);
    expect(qTextarea.value).toMatch(/"questions"/);
    expect(qTextarea.value).toMatch(/How many trips do you organize per year/i);
    expect(rTextarea.value).toMatch(/"method": "weighted-sum"/);
    expect(rTextarea.value).toMatch(/"bands"/);
  });

  it('Add question appends a new question card to the Visual list', () => {
    renderPage();
    expect(screen.getByRole('heading', { name: /Questions \(2\)/i })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Add question/i }));
    expect(screen.getByRole('heading', { name: /Questions \(3\)/i })).toBeTruthy();
  });

  it('Remove question deletes a question card from the Visual list', () => {
    renderPage();
    expect(screen.getByRole('heading', { name: /Questions \(2\)/i })).toBeTruthy();
    const removeBtns = screen.getAllByRole('button', { name: /Remove question/i });
    fireEvent.click(removeBtns[0]);
    expect(screen.getByRole('heading', { name: /Questions \(1\)/i })).toBeTruthy();
  });

  it('Add band appends a new band card to the Scoring list', () => {
    renderPage();
    expect(screen.getByRole('heading', { name: /Scoring bands \(3\)/i })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Add band/i }));
    expect(screen.getByRole('heading', { name: /Scoring bands \(4\)/i })).toBeTruthy();
  });

  it('Validate flags invalid JSON in the JSON tab', () => {
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: /JSON \(advanced\)/i }));
    const qTextarea = screen.getByLabelText(/Questions JSON/i);
    fireEvent.change(qTextarea, { target: { value: '{ broken json' } });
    fireEvent.click(screen.getByRole('button', { name: /Validate JSON locally/i }));
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/Validation errors/i);
    expect(alert.textContent).toMatch(/questionsJson is not valid JSON/i);
  });

  it('Validate confirms a clean payload as ok', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Validate JSON locally/i }));
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/Both JSON payloads parse and have the required shape/i);
  });

  it('Visual tab renders a ParseErrorPanel + "Open JSON tab" CTA when qJson is unparseable', () => {
    renderPage();
    // Break the JSON via the JSON tab, then swap back to Visual.
    fireEvent.click(screen.getByRole('tab', { name: /JSON \(advanced\)/i }));
    const qTextarea = screen.getByLabelText(/Questions JSON/i);
    fireEvent.change(qTextarea, { target: { value: '{ not json' } });
    fireEvent.click(screen.getByRole('tab', { name: /Visual builder/i }));
    expect(screen.getByText(/questionsJson string is not valid JSON/i)).toBeTruthy();
    // Two "Open JSON tab" CTAs (one for questions, one for scoring) — at
    // least one should be present when the questions JSON is broken.
    const ctas = screen.getAllByRole('button', { name: /Open JSON tab/i });
    expect(ctas.length).toBeGreaterThanOrEqual(1);
  });

  it('Create POSTs to /api/travel/diagnostic-banks with the right shape + navigates on success', async () => {
    fetchApiMock.mockResolvedValueOnce({ id: 99, version: 4, subBrand: 'tmc' });
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Create bank/i }));
    await waitFor(() => {
      const createCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/diagnostic-banks' && o?.method === 'POST',
      );
      expect(createCall).toBeTruthy();
      const body = JSON.parse(createCall[1].body);
      expect(body.subBrand).toBe('tmc');
      expect(body.questionsJson).toMatch(/"questions"/);
      expect(body.scoringRulesJson).toMatch(/"weighted-sum"/);
    });
    await waitFor(() => {
      expect(notifyObj.success).toHaveBeenCalled();
      const msg = notifyObj.success.mock.calls[0][0];
      expect(msg).toMatch(/v4 created for TMC/i);
    });
    expect(navigateMock).toHaveBeenCalledWith('/travel/diagnostics');
  });

  it('Create surfaces the backend error message on failure', async () => {
    fetchApiMock.mockRejectedValueOnce({
      status: 400,
      body: { error: 'questionsJson schema invalid: question[0].options is empty' },
    });
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Create bank/i }));
    await waitFor(() => {
      expect(notifyObj.error).toHaveBeenCalled();
      const msg = notifyObj.error.mock.calls[0][0];
      expect(msg).toMatch(/questionsJson schema invalid/i);
    });
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('Export CSV hits /api/travel/diagnostic-banks/export.csv with Bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(['subBrand,version\n'], { type: 'text/csv' })),
    });
    global.fetch = fetchMock;
    // Stub blob URL plumbing so the click handler doesn't trip on jsdom.
    if (!global.URL.createObjectURL) global.URL.createObjectURL = vi.fn(() => 'blob:test');
    else vi.spyOn(global.URL, 'createObjectURL').mockReturnValue('blob:test');
    if (!global.URL.revokeObjectURL) global.URL.revokeObjectURL = vi.fn();
    else vi.spyOn(global.URL, 'revokeObjectURL').mockImplementation(() => {});

    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Export CSV/i }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe('/api/travel/diagnostic-banks/export.csv');
      expect(opts.headers.Authorization).toBe('Bearer test-token');
    });
  });

  it('Export CSV surfaces an error notify when the response is non-ok', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Export CSV/i }));
    await waitFor(() => {
      expect(notifyObj.error).toHaveBeenCalled();
      const msg = notifyObj.error.mock.calls[0][0];
      expect(msg).toMatch(/Export failed/i);
    });
  });
});
