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

import { AuthContext } from '../App';
import DiagnosticBuilder from '../pages/travel/DiagnosticBuilder';

function renderPage({ role = 'ADMIN' } = {}) {
  return render(
    <MemoryRouter initialEntries={['/travel/diagnostics/banks/new']}>
      <AuthContext.Provider
        value={{
          user: { userId: 1, role },
          setUser: vi.fn(),
          token: 'tk',
          tenant: { id: 1, vertical: 'travel' },
          loading: false,
        }}
      >
        <DiagnosticBuilder />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchApiMock.mockReset();
  // The builder loads the selected sub-brand's current active bank on mount /
  // brand-switch. Default: no existing bank → the editors keep their template
  // seed. Tests that exercise the POST override this with a routing impl.
  fetchApiMock.mockImplementation((url) =>
    typeof url === 'string' && url.includes('/diagnostic-banks?')
      ? Promise.resolve({ banks: [] })
      : Promise.resolve({ id: 1, version: 1, subBrand: 'tmc' }),
  );
  notifyObj.error.mockReset();
  notifyObj.success.mockReset();
  notifyObj.info.mockReset();
  navigateMock.mockReset();
});

// Helper: route the mount GET to "no existing bank" and the POST to a given
// resolver/rejecter, so the *Once timing no longer collides with mount.
function routePost(postHandler) {
  fetchApiMock.mockImplementation((url, opts) => {
    if (typeof url === 'string' && url.includes('/diagnostic-banks?')) {
      return Promise.resolve({ banks: [] });
    }
    return postHandler(url, opts);
  });
}

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
    routePost(() => Promise.resolve({ id: 99, version: 4, subBrand: 'tmc' }));
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
    routePost(() => Promise.reject({
      status: 400,
      body: { error: 'questionsJson schema invalid: question[0].options is empty' },
    }));
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

  // ─── Extension cases (2026-05-26) ──────────────────────────────────
  // Cover the Visual editor's per-question and per-band edit/reorder/
  // option surfaces, scoring-method validation, save-state UX, generic
  // error fallback, and the Import-CSV happy + per-row error paths.

  it('Editing a question text via the Visual editor mutates the qJson string', () => {
    renderPage();
    // The pre-seeded first question's text is "How many trips do you organize per year?"
    // The first matching <input> with that value is the question-text field.
    const inputs = screen.getAllByRole('textbox');
    const qTextInput = inputs.find((el) => el.value === 'How many trips do you organize per year?');
    expect(qTextInput).toBeTruthy();
    fireEvent.change(qTextInput, { target: { value: 'How many trips do you organize per quarter?' } });
    // Swap to JSON tab and confirm the new text rode through into qJson.
    fireEvent.click(screen.getByRole('tab', { name: /JSON \(advanced\)/i }));
    const qTextarea = screen.getByLabelText(/Questions JSON/i);
    expect(qTextarea.value).toMatch(/How many trips do you organize per quarter/);
  });

  it('Add option button appends a new option row to a question card', () => {
    renderPage();
    // First question has 3 seeded options ("Options (3)" header).
    const optionsHeaders = screen.getAllByText(/Options \(3\)/i);
    expect(optionsHeaders.length).toBeGreaterThanOrEqual(1);
    // Click the first "Add option" button (Q1's).
    const addOptionBtns = screen.getAllByRole('button', { name: /Add option/i });
    fireEvent.click(addOptionBtns[0]);
    expect(screen.getAllByText(/Options \(4\)/i).length).toBeGreaterThanOrEqual(1);
  });

  it('Editing an option weight propagates into the qJson', () => {
    renderPage();
    // Both Q1 and Q2 have an "Option 1 weight" aria-label — disambiguate
    // by taking the first match (Q1's first option).
    const weightInputs = screen.getAllByLabelText(/Option 1 weight$/i);
    fireEvent.change(weightInputs[0], { target: { value: '42' } });
    fireEvent.click(screen.getByRole('tab', { name: /JSON \(advanced\)/i }));
    const qTextarea = screen.getByLabelText(/Questions JSON/i);
    expect(qTextarea.value).toMatch(/"weight": 42/);
  });

  it('Remove option button drops the matching option row from a question', () => {
    renderPage();
    // Confirm 3 options on Q1 to start (Q2 also has 3, hence the dup-text check).
    expect(screen.getAllByText(/Options \(3\)/i).length).toBeGreaterThanOrEqual(1);
    // "Remove option 1" matches the first option's aria-label on Q1 AND Q2 —
    // disambiguate by taking the first match (Q1's).
    const removeOpt1Buttons = screen.getAllByLabelText(/Remove option 1$/i);
    fireEvent.click(removeOpt1Buttons[0]);
    expect(screen.getAllByText(/Options \(2\)/i).length).toBeGreaterThanOrEqual(1);
  });

  it('Move-question-down reorders questions in the JSON', () => {
    renderPage();
    // Find Q1's "Move question down" — the first such button is Q1's.
    const moveDownBtns = screen.getAllByRole('button', { name: /Move question down/i });
    fireEvent.click(moveDownBtns[0]);
    fireEvent.click(screen.getByRole('tab', { name: /JSON \(advanced\)/i }));
    const qTextarea = screen.getByLabelText(/Questions JSON/i);
    // After moving Q1 down, "Average group size?" (originally Q2) should
    // serialize before "How many trips do you organize per year?".
    const groupIdx = qTextarea.value.indexOf('Average group size');
    const tripsIdx = qTextarea.value.indexOf('How many trips do you organize per year');
    expect(groupIdx).toBeGreaterThan(0);
    expect(tripsIdx).toBeGreaterThan(groupIdx);
  });

  it('Editing a band classification propagates into rJson', () => {
    renderPage();
    // The first band has classification "level_1" pre-seeded — find that input.
    const inputs = screen.getAllByRole('textbox');
    const classificationInput = inputs.find((el) => el.value === 'level_1');
    expect(classificationInput).toBeTruthy();
    fireEvent.change(classificationInput, { target: { value: 'tier_alpha' } });
    fireEvent.click(screen.getByRole('tab', { name: /JSON \(advanced\)/i }));
    const rTextarea = screen.getByLabelText(/Scoring rules JSON/i);
    expect(rTextarea.value).toMatch(/"classification": "tier_alpha"/);
  });

  it('Editing a band maxScore propagates into rJson', () => {
    renderPage();
    // Band 1's maxScore is 4. Find the first number input whose value is 4
    // — that's Band 1's maxScore (minScore is 0).
    const allInputs = Array.from(document.querySelectorAll('input[type="number"]'));
    const maxScore1 = allInputs.find((el) => el.value === '4');
    expect(maxScore1).toBeTruthy();
    fireEvent.change(maxScore1, { target: { value: '6' } });
    fireEvent.click(screen.getByRole('tab', { name: /JSON \(advanced\)/i }));
    const rTextarea = screen.getByLabelText(/Scoring rules JSON/i);
    expect(rTextarea.value).toMatch(/"maxScore": 6/);
  });

  it('Move-band-down reorders bands in rJson', () => {
    renderPage();
    const moveDownBtns = screen.getAllByRole('button', { name: /Move band down/i });
    fireEvent.click(moveDownBtns[0]);
    fireEvent.click(screen.getByRole('tab', { name: /JSON \(advanced\)/i }));
    const rTextarea = screen.getByLabelText(/Scoring rules JSON/i);
    const starterIdx = rTextarea.value.indexOf('"Starter"');
    const establishedIdx = rTextarea.value.indexOf('"Established"');
    expect(establishedIdx).toBeGreaterThan(0);
    expect(starterIdx).toBeGreaterThan(establishedIdx);
  });

  it('Remove band drops a band from the rJson', () => {
    renderPage();
    expect(screen.getByRole('heading', { name: /Scoring bands \(3\)/i })).toBeTruthy();
    const removeBandBtns = screen.getAllByRole('button', { name: /Remove band/i });
    fireEvent.click(removeBandBtns[0]);
    expect(screen.getByRole('heading', { name: /Scoring bands \(2\)/i })).toBeTruthy();
  });

  it('Validate flags scoring-method other than weighted-sum', () => {
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: /JSON \(advanced\)/i }));
    const rTextarea = screen.getByLabelText(/Scoring rules JSON/i);
    const broken = JSON.stringify({ method: 'sum', bands: [{ minScore: 0, maxScore: 5 }] });
    fireEvent.change(rTextarea, { target: { value: broken } });
    fireEvent.click(screen.getByRole('button', { name: /Validate JSON locally/i }));
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/method must be "weighted-sum"/i);
  });

  it('Validate flags an empty bands array', () => {
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: /JSON \(advanced\)/i }));
    const rTextarea = screen.getByLabelText(/Scoring rules JSON/i);
    fireEvent.change(rTextarea, { target: { value: JSON.stringify({ method: 'weighted-sum', bands: [] }) } });
    fireEvent.click(screen.getByRole('button', { name: /Validate JSON locally/i }));
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/non-empty "bands" array/i);
  });

  it('Validate flags an empty questions array', () => {
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: /JSON \(advanced\)/i }));
    const qTextarea = screen.getByLabelText(/Questions JSON/i);
    fireEvent.change(qTextarea, { target: { value: JSON.stringify({ questions: [] }) } });
    fireEvent.click(screen.getByRole('button', { name: /Validate JSON locally/i }));
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/non-empty "questions" array/i);
  });

  it('Create uses the currently-selected sub-brand in the POST + uppercased success', async () => {
    routePost(() => Promise.resolve({ id: 7, version: 2, subBrand: 'rfu' }));
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /RFU \(Umrah\)/i }));
    fireEvent.click(screen.getByRole('button', { name: /Create bank/i }));
    await waitFor(() => {
      const createCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/diagnostic-banks' && o?.method === 'POST',
      );
      expect(createCall).toBeTruthy();
      const body = JSON.parse(createCall[1].body);
      expect(body.subBrand).toBe('rfu');
    });
    await waitFor(() => {
      expect(notifyObj.success).toHaveBeenCalled();
      const msg = notifyObj.success.mock.calls[0][0];
      expect(msg).toMatch(/v2 created for RFU/);
    });
  });

  it('Create swallows a rejection lacking body.error with a generic fallback message', async () => {
    routePost(() => Promise.reject({ status: 500 }));
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Create bank/i }));
    await waitFor(() => {
      expect(notifyObj.error).toHaveBeenCalled();
      const msg = notifyObj.error.mock.calls[0][0];
      expect(msg).toMatch(/Failed to create bank/i);
    });
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('Create blocks when validation fails (broken JSON) and surfaces a fix-first notify', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: /JSON \(advanced\)/i }));
    const qTextarea = screen.getByLabelText(/Questions JSON/i);
    fireEvent.change(qTextarea, { target: { value: 'not json' } });
    fireEvent.click(screen.getByRole('button', { name: /Create bank/i }));
    await waitFor(() => {
      expect(notifyObj.error).toHaveBeenCalled();
      const msg = notifyObj.error.mock.calls[0][0];
      expect(msg).toMatch(/Fix validation errors/i);
    });
    // The mount load may have queried the bank list, but no POST (create) fires.
    expect(fetchApiMock.mock.calls.some(([, o]) => o?.method === 'POST')).toBe(false);
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('Create button shows "Creating…" + disabled state while the POST is in-flight', async () => {
    let resolveCreate;
    routePost(() => new Promise((resolve) => { resolveCreate = resolve; }));
    renderPage();
    const createBtn = screen.getByRole('button', { name: /Create bank/i });
    fireEvent.click(createBtn);
    // While in-flight, the button text flips to "Creating…" and aria-disabled propagates via disabled prop.
    await waitFor(() => {
      const live = screen.getByRole('button', { name: /Create bank/i });
      expect(live.textContent).toMatch(/Creating…/);
      expect(live.disabled).toBe(true);
    });
    // Resolve the pending POST so the test cleanly tears down.
    resolveCreate({ id: 1, version: 1, subBrand: 'tmc' });
    await waitFor(() => expect(navigateMock).toHaveBeenCalled());
  });

  it('Import CSV POSTs to /import.csv and reports the imported/updated/skipped summary', async () => {
    const summary = { imported: 5, updated: 2, skipped: 1, errors: [] };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(summary),
    });
    global.fetch = fetchMock;
    renderPage();
    // Programmatically populate the hidden file input.
    const fileInput = screen.getByLabelText(/Upload diagnostic-banks CSV/i);
    const file = new File(['subBrand,version\ntmc,1\n'], 'banks.csv', { type: 'text/csv' });
    Object.defineProperty(fileInput, 'files', { value: [file] });
    fireEvent.change(fileInput);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe('/api/travel/diagnostic-banks/import.csv');
      expect(opts.method).toBe('POST');
      expect(opts.headers.Authorization).toBe('Bearer test-token');
      // Upload now goes over FormData (not a raw text/csv body) so binary
      // XLSX files survive the trip too — no explicit Content-Type header
      // is set, since fetch/FormData compute the multipart boundary itself.
      expect(opts.headers['Content-Type']).toBeUndefined();
      expect(opts.body).toBeInstanceOf(FormData);
    });
    await waitFor(() => {
      expect(notifyObj.success).toHaveBeenCalled();
      const msg = notifyObj.success.mock.calls[0][0];
      expect(msg).toMatch(/Imported 5, updated 2, skipped 1/);
    });
  });

  it('Import CSV surfaces the first per-row error when the response includes errors[]', async () => {
    const summary = {
      imported: 2,
      updated: 0,
      skipped: 1,
      errors: [{ rowNumber: 3, reason: 'questionsJson is not valid JSON' }],
    };
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(summary) });
    renderPage();
    const fileInput = screen.getByLabelText(/Upload diagnostic-banks CSV/i);
    const file = new File(['bad,row\n'], 'banks.csv', { type: 'text/csv' });
    Object.defineProperty(fileInput, 'files', { value: [file] });
    fireEvent.change(fileInput);
    await waitFor(() => {
      expect(notifyObj.error).toHaveBeenCalled();
      const msg = notifyObj.error.mock.calls[0][0];
      expect(msg).toMatch(/Row 3: questionsJson is not valid JSON/);
    });
  });

  it('Import CSV surfaces the backend error string when response is non-ok', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: 'CSV missing required column: subBrand' }),
    });
    renderPage();
    const fileInput = screen.getByLabelText(/Upload diagnostic-banks CSV/i);
    const file = new File(['oops\n'], 'banks.csv', { type: 'text/csv' });
    Object.defineProperty(fileInput, 'files', { value: [file] });
    fireEvent.change(fileInput);
    await waitFor(() => {
      expect(notifyObj.error).toHaveBeenCalled();
      const msg = notifyObj.error.mock.calls[0][0];
      expect(msg).toMatch(/CSV missing required column/);
    });
  });

  // ─── Extension cases — wave 2026-05-26 (B) ─────────────────────────
  // Cover the remaining uncovered branches: move-up boundary disabled
  // state, ID-collision skip in addQuestion / addOption, move-up reorders,
  // question type select mutation, scoring-band ParseErrorPanel branch,
  // ScoringVisualEditor "missing bands array" message, recommendedTier
  // edit propagation, and re-validate clearing state.

  it('Move-question-up is disabled on the first question (boundary state)', () => {
    renderPage();
    // The first question's "Move question up" button is rendered but disabled.
    const moveUpBtns = screen.getAllByRole('button', { name: /Move question up/i });
    expect(moveUpBtns[0].disabled).toBe(true);
    // Clicking should be a no-op — the JSON order doesn't change.
    fireEvent.click(moveUpBtns[0]);
    fireEvent.click(screen.getByRole('tab', { name: /JSON \(advanced\)/i }));
    const qTextarea = screen.getByLabelText(/Questions JSON/i);
    const tripsIdx = qTextarea.value.indexOf('How many trips do you organize per year');
    const groupIdx = qTextarea.value.indexOf('Average group size');
    // Original order preserved: Q1 (trips) precedes Q2 (group).
    expect(tripsIdx).toBeGreaterThan(0);
    expect(groupIdx).toBeGreaterThan(tripsIdx);
  });

  it('Move-question-down is disabled on the last question (boundary state)', () => {
    renderPage();
    const moveDownBtns = screen.getAllByRole('button', { name: /Move question down/i });
    // Last question's "Move question down" is disabled.
    expect(moveDownBtns[moveDownBtns.length - 1].disabled).toBe(true);
  });

  it('Move-question-up reorders an interior question', () => {
    renderPage();
    // Move Q2 up → Q2 should now precede Q1 in the JSON.
    const moveUpBtns = screen.getAllByRole('button', { name: /Move question up/i });
    // moveUpBtns[0] is Q1's (disabled), moveUpBtns[1] is Q2's (enabled).
    fireEvent.click(moveUpBtns[1]);
    fireEvent.click(screen.getByRole('tab', { name: /JSON \(advanced\)/i }));
    const qTextarea = screen.getByLabelText(/Questions JSON/i);
    const tripsIdx = qTextarea.value.indexOf('How many trips do you organize per year');
    const groupIdx = qTextarea.value.indexOf('Average group size');
    expect(groupIdx).toBeGreaterThan(0);
    expect(tripsIdx).toBeGreaterThan(groupIdx);
  });

  it('Move-band-up reorders a band (the symmetric direction of move-band-down)', () => {
    renderPage();
    const moveUpBtns = screen.getAllByRole('button', { name: /Move band up/i });
    // Band-1's move-up is disabled; Band-2's is enabled. Click Band-2's to swap with Band-1.
    expect(moveUpBtns[0].disabled).toBe(true);
    fireEvent.click(moveUpBtns[1]);
    fireEvent.click(screen.getByRole('tab', { name: /JSON \(advanced\)/i }));
    const rTextarea = screen.getByLabelText(/Scoring rules JSON/i);
    const starterIdx = rTextarea.value.indexOf('"Starter"');
    const establishedIdx = rTextarea.value.indexOf('"Established"');
    expect(establishedIdx).toBeGreaterThan(0);
    expect(starterIdx).toBeGreaterThan(establishedIdx);
  });

  it('Add question skips IDs already in use (q1+q2 seeded → next is q3, then add+remove+add yields q3+q4 not q3+q3)', () => {
    renderPage();
    // Seeded ids are q1, q2. Click "Add question" once → should yield q3.
    fireEvent.click(screen.getByRole('button', { name: /Add question/i }));
    fireEvent.click(screen.getByRole('tab', { name: /JSON \(advanced\)/i }));
    let qTextarea = screen.getByLabelText(/Questions JSON/i);
    expect(qTextarea.value).toMatch(/"id": "q3"/);
    // Switch back to Visual, add another → q4 (since q3 is now used).
    fireEvent.click(screen.getByRole('tab', { name: /Visual builder/i }));
    fireEvent.click(screen.getByRole('button', { name: /Add question/i }));
    fireEvent.click(screen.getByRole('tab', { name: /JSON \(advanced\)/i }));
    qTextarea = screen.getByLabelText(/Questions JSON/i);
    expect(qTextarea.value).toMatch(/"id": "q4"/);
    // Both q3 and q4 should be present (no collision).
    const q3Count = (qTextarea.value.match(/"id": "q3"/g) || []).length;
    const q4Count = (qTextarea.value.match(/"id": "q4"/g) || []).length;
    expect(q3Count).toBe(1);
    expect(q4Count).toBe(1);
  });

  it('Changing question type via the select propagates into qJson', () => {
    renderPage();
    // Find the first <select> with QUESTION_TYPES options. There are 2 question
    // cards, each with a type select pre-set to "single-choice".
    const selects = Array.from(document.querySelectorAll('select'));
    const typeSelect = selects.find((s) => s.value === 'single-choice');
    expect(typeSelect).toBeTruthy();
    fireEvent.change(typeSelect, { target: { value: 'multi-select' } });
    fireEvent.click(screen.getByRole('tab', { name: /JSON \(advanced\)/i }));
    const qTextarea = screen.getByLabelText(/Questions JSON/i);
    expect(qTextarea.value).toMatch(/"type": "multi-select"/);
  });

  it('Editing recommendedTier propagates into rJson', () => {
    renderPage();
    // Pre-seeded recommendedTier values: "entry", "primary", "premium".
    const inputs = screen.getAllByRole('textbox');
    const tierInput = inputs.find((el) => el.value === 'entry');
    expect(tierInput).toBeTruthy();
    fireEvent.change(tierInput, { target: { value: 'starter-special' } });
    fireEvent.click(screen.getByRole('tab', { name: /JSON \(advanced\)/i }));
    const rTextarea = screen.getByLabelText(/Scoring rules JSON/i);
    expect(rTextarea.value).toMatch(/"recommendedTier": "starter-special"/);
  });

  it('ScoringVisualEditor shows a ParseErrorPanel when rJson is unparseable', () => {
    renderPage();
    // Break the scoring JSON via the JSON tab, then swap back to Visual.
    fireEvent.click(screen.getByRole('tab', { name: /JSON \(advanced\)/i }));
    const rTextarea = screen.getByLabelText(/Scoring rules JSON/i);
    fireEvent.change(rTextarea, { target: { value: '{ not json' } });
    fireEvent.click(screen.getByRole('tab', { name: /Visual builder/i }));
    // The ScoringVisualEditor branch shows its own ParseErrorPanel.
    expect(screen.getByText(/scoringRulesJson string is not valid JSON/i)).toBeTruthy();
  });

  it('ScoringVisualEditor flags a missing-bands-array payload distinctly from unparseable JSON', () => {
    renderPage();
    // Provide VALID JSON that lacks the "bands" array (object-but-no-bands branch).
    fireEvent.click(screen.getByRole('tab', { name: /JSON \(advanced\)/i }));
    const rTextarea = screen.getByLabelText(/Scoring rules JSON/i);
    fireEvent.change(rTextarea, { target: { value: JSON.stringify({ method: 'weighted-sum', notBands: [] }) } });
    fireEvent.click(screen.getByRole('tab', { name: /Visual builder/i }));
    // Distinct message: "missing a 'bands' array", not "not valid JSON".
    expect(screen.getByText(/scoringRulesJson is missing a "bands" array/i)).toBeTruthy();
  });

  it('Validate re-evaluation transitions from errors to ok after fixing the broken JSON', () => {
    renderPage();
    // Step 1: break questionsJson, validate → errors panel.
    fireEvent.click(screen.getByRole('tab', { name: /JSON \(advanced\)/i }));
    const qTextarea = screen.getByLabelText(/Questions JSON/i);
    fireEvent.change(qTextarea, { target: { value: 'totally broken' } });
    fireEvent.click(screen.getByRole('button', { name: /Validate JSON locally/i }));
    let alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/Validation errors/i);
    // Step 2: restore valid JSON, re-validate → ok panel.
    const fixedQ = JSON.stringify({ questions: [{ id: 'q1', text: 'x', type: 'single-choice', options: [{ value: 'a', label: 'A', weight: 1 }] }] });
    fireEvent.change(qTextarea, { target: { value: fixedQ } });
    fireEvent.click(screen.getByRole('button', { name: /Validate JSON locally/i }));
    alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/Both JSON payloads parse and have the required shape/i);
  });

  // ─── T11 Engine Weights tab (TMC-only) + Promote-to-active ─────────
  // Pins PRD_TMC_DIAGNOSTIC_SALES_ROUTING_ENGINE §10 row T11 contract:
  //   - Engine Weights tab visible only when subBrand=tmc
  //   - 6 weight inputs default to §3.3.3 (50 / 20 / 15 / 10 / 10 / 8)
  //   - Threshold defaults to 70
  //   - Save PUTs to /api/travel/engine-weights
  //   - Validation rejects negative weights / out-of-range threshold
  //   - Version auto-bumps when weights change (v1 → v2)
  //   - Promote-to-active button calls T5's POST /:id/promote-to-active

  // GET /api/travel/engine-weights default-row resolver used across the
  // T11 cases. Returns the §3.3.3 defaults so the form initial-render
  // matches what the PRD pins.
  function makeWeightsFetch({ existingWeights, archivedCatalogue } = {}) {
    const weightsRow = existingWeights || {
      id: 1,
      tenantId: 1,
      version: 'v1',
      weightPrimaryOutcome: 50,
      weightSecondarySkill: 20,
      weightGrowthArea: 15,
      weightCurriculumHook: 10,
      weightGradeBandCenter: 10,
      weightTierValueLean: 8,
      scoresWellThreshold: 70,
    };
    const archived = archivedCatalogue || [];
    return (url, opts) => {
      if (typeof url === 'string' && url.startsWith('/api/travel/engine-weights')) {
        if (opts?.method === 'PUT') {
          const body = opts.body ? JSON.parse(opts.body) : {};
          return Promise.resolve({ ...weightsRow, ...body });
        }
        return Promise.resolve(weightsRow);
      }
      if (typeof url === 'string' && url.startsWith('/api/travel-tmc-catalogue')) {
        if (url.includes('/promote-to-active')) {
          return Promise.resolve({ promoted: true });
        }
        return Promise.resolve(archived);
      }
      if (url === '/api/travel/diagnostic-banks' && opts?.method === 'POST') {
        return Promise.resolve({ id: 1, version: 1, subBrand: 'tmc' });
      }
      return Promise.resolve(null);
    };
  }

  it('T11: Engine Weights tab visible only when subBrand=tmc', async () => {
    fetchApiMock.mockImplementation(makeWeightsFetch());
    renderPage();
    // TMC is default — tab is present.
    expect(screen.getByRole('tab', { name: /Engine Weights/i })).toBeTruthy();
    // Switch to RFU — tab disappears.
    fireEvent.click(screen.getByRole('button', { name: /RFU \(Umrah\)/i }));
    expect(screen.queryByRole('tab', { name: /Engine Weights/i })).toBeNull();
    // Switch back to TMC — tab returns.
    fireEvent.click(screen.getByRole('button', { name: /TMC \(school trips\)/i }));
    expect(screen.getByRole('tab', { name: /Engine Weights/i })).toBeTruthy();
  });

  it('T11: 6 weight inputs render with PRD §3.3.3 defaults (50/20/15/10/10/8)', async () => {
    fetchApiMock.mockImplementation(makeWeightsFetch());
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: /Engine Weights/i }));
    await waitFor(() => {
      expect(screen.getByLabelText(/Primary-outcome match/i)).toBeTruthy();
    });
    // Default values per PRD §3.3.3.
    expect(screen.getByLabelText(/Primary-outcome match/i).value).toBe('50');
    expect(screen.getByLabelText(/Secondary-skill match/i).value).toBe('20');
    expect(screen.getByLabelText(/Growth-area match/i).value).toBe('15');
    expect(screen.getByLabelText(/Curriculum hook depth/i).value).toBe('10');
    expect(screen.getByLabelText(/Grade-band centering/i).value).toBe('10');
    expect(screen.getByLabelText(/Tier-value lean/i).value).toBe('8');
  });

  it('T11: Threshold input renders with default 70 per §3.3.5', async () => {
    fetchApiMock.mockImplementation(makeWeightsFetch());
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: /Engine Weights/i }));
    await waitFor(() => {
      expect(screen.getByLabelText(/Scores-well threshold/i)).toBeTruthy();
    });
    expect(screen.getByLabelText(/Scores-well threshold/i).value).toBe('70');
    // Version label seeded from the persisted row.
    expect(screen.getByLabelText(/Version label/i).value).toBe('v1');
  });

  it('T11: Save triggers PUT /api/travel/engine-weights with the right shape', async () => {
    fetchApiMock.mockImplementation(makeWeightsFetch());
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: /Engine Weights/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Save engine weights/i })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: /Save engine weights/i }));
    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/engine-weights' && o?.method === 'PUT',
      );
      expect(putCall).toBeTruthy();
      const body = JSON.parse(putCall[1].body);
      expect(body.weightPrimaryOutcome).toBe(50);
      expect(body.weightSecondarySkill).toBe(20);
      expect(body.scoresWellThreshold).toBe(70);
      expect(body.version).toBe('v1');
    });
    await waitFor(() => {
      expect(notifyObj.success).toHaveBeenCalled();
    });
  });

  it('T11: Validation rejects a negative weight + blocks the PUT', async () => {
    fetchApiMock.mockImplementation(makeWeightsFetch());
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: /Engine Weights/i }));
    await waitFor(() => {
      expect(screen.getByLabelText(/Primary-outcome match/i)).toBeTruthy();
    });
    const primaryInput = screen.getByLabelText(/Primary-outcome match/i);
    fireEvent.change(primaryInput, { target: { value: '-5' } });
    fireEvent.click(screen.getByRole('button', { name: /Save engine weights/i }));
    await waitFor(() => {
      expect(notifyObj.error).toHaveBeenCalled();
      const msg = notifyObj.error.mock.calls[0][0];
      expect(msg).toMatch(/Fix validation errors/i);
    });
    // PUT was NOT issued.
    const putCalls = fetchApiMock.mock.calls.filter(
      ([u, o]) => u === '/api/travel/engine-weights' && o?.method === 'PUT',
    );
    expect(putCalls.length).toBe(0);
    // Inline alert lists the specific error.
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/Primary-outcome match must be an integer ≥ 0/i);
  });

  it('T11: Validation rejects a threshold outside [0, 100]', async () => {
    fetchApiMock.mockImplementation(makeWeightsFetch());
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: /Engine Weights/i }));
    await waitFor(() => {
      expect(screen.getByLabelText(/Scores-well threshold/i)).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText(/Scores-well threshold/i), { target: { value: '150' } });
    fireEvent.click(screen.getByRole('button', { name: /Save engine weights/i }));
    await waitFor(() => {
      expect(notifyObj.error).toHaveBeenCalled();
    });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/threshold must be an integer in \[0, 100\]/i);
  });

  it('T11: Version auto-bumps from v1 → v2 when a weight changes and operator did not touch version', async () => {
    fetchApiMock.mockImplementation(makeWeightsFetch());
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: /Engine Weights/i }));
    await waitFor(() => {
      expect(screen.getByLabelText(/Primary-outcome match/i)).toBeTruthy();
    });
    // Operator changes primary-outcome weight 50 → 60 (a real tuning move).
    fireEvent.change(screen.getByLabelText(/Primary-outcome match/i), { target: { value: '60' } });
    fireEvent.click(screen.getByRole('button', { name: /Save engine weights/i }));
    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/engine-weights' && o?.method === 'PUT',
      );
      expect(putCall).toBeTruthy();
      const body = JSON.parse(putCall[1].body);
      expect(body.weightPrimaryOutcome).toBe(60);
      // Auto-bumped v1 → v2 because operator left the version field untouched.
      expect(body.version).toBe('v2');
    });
  });

  it('T11: ADMIN sees Save enabled; non-ADMIN role sees read-only notice', async () => {
    fetchApiMock.mockImplementation(makeWeightsFetch());
    renderPage({ role: 'MANAGER' });
    fireEvent.click(screen.getByRole('tab', { name: /Engine Weights/i }));
    await waitFor(() => {
      expect(screen.getByLabelText(/Primary-outcome match/i)).toBeTruthy();
    });
    // Save button is disabled for non-ADMIN.
    const saveBtn = screen.getByRole('button', { name: /Save engine weights/i });
    expect(saveBtn.disabled).toBe(true);
    // Read-only notice copy is visible.
    expect(screen.getByText(/Read-only \(ADMIN required to save\)/i)).toBeTruthy();
  });

  // T25: the legacy in-tab Promote-to-active sub-panel was deprecated
  // once T16 shipped the dedicated /travel/tmc/catalogue admin page
  // (TmcCatalogueAdmin.jsx). Engine Weights tab now surfaces a single
  // link to that page; the full archived-row list + promote flow lives
  // there. The two prior T11 tests that pinned the in-tab archived
  // list + per-row Promote button + empty-state copy were removed —
  // those behaviours are now covered by TmcCatalogueAdmin.test.jsx.
  it('T25: Engine Weights tab links to /travel/tmc/catalogue (T16 dedicated page)', async () => {
    fetchApiMock.mockImplementation(makeWeightsFetch());
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: /Engine Weights/i }));
    const link = await screen.findByRole('link', { name: /Open TMC Catalogue Admin/i });
    expect(link).toBeTruthy();
    expect(link.getAttribute('href')).toBe('/travel/tmc/catalogue');
    // The page must NOT fire the legacy in-tab archived-list GET (T16's
    // dedicated page does its own load). Confirm no archived-list call
    // went out from this surface.
    const archivedListCalls = fetchApiMock.mock.calls.filter(
      ([u]) => typeof u === 'string' && u.startsWith('/api/travel-tmc-catalogue'),
    );
    expect(archivedListCalls.length).toBe(0);
  });

  // ─── PRD §4.2 — Request change (Phase-1 view-only scoring) ─────────
  // Scoring is view-only in Phase 1; the bank header surfaces a
  // "Request change" button (only when an existing bank loaded) that
  // opens a summary+details modal and POSTs to
  // /api/travel/diagnostics/banks/:id/request-change, toasting the
  // created GS ticket id.

  // Mount-GET resolver that returns one existing TMC bank (id 42, v3)
  // so the Request-change button renders; optional postHandler routes
  // everything else (the modal's POST).
  function makeExistingBankFetch(postHandler) {
    fetchApiMock.mockImplementation((url, opts) => {
      if (typeof url === 'string' && url.includes('/diagnostic-banks?')) {
        return Promise.resolve({
          banks: [{
            id: 42,
            version: 3,
            subBrand: 'tmc',
            isActive: true,
            questionsJson: JSON.stringify({
              questions: [{ id: 'q1', text: 'T?', type: 'single-choice', options: [{ value: 'a', label: 'A', weight: 1 }] }],
            }),
            scoringRulesJson: JSON.stringify({
              method: 'weighted-sum',
              bands: [{ minScore: 0, maxScore: 9, classification: 'level_1', label: 'L1', recommendedTier: 'entry' }],
            }),
          }],
        });
      }
      if (postHandler) return postHandler(url, opts);
      return Promise.resolve(null);
    });
  }

  it('Request change button renders for an existing bank and opens the modal', async () => {
    makeExistingBankFetch();
    renderPage();
    const btn = await screen.findByRole('button', { name: /^Request change$/i });
    // No dialog until clicked.
    expect(screen.queryByRole('dialog', { name: /Request scoring change/i })).toBeNull();
    fireEvent.click(btn);
    expect(screen.getByRole('dialog', { name: /Request scoring change/i })).toBeTruthy();
    expect(screen.getByLabelText(/Change request summary/i)).toBeTruthy();
    expect(screen.getByLabelText(/Change request details/i)).toBeTruthy();
  });

  it('Request change button does NOT render when no bank exists yet', async () => {
    renderPage(); // beforeEach default: { banks: [] }
    await waitFor(() => {
      expect(screen.getByText(/No diagnostic bank yet for this brand/i)).toBeTruthy();
    });
    expect(screen.queryByRole('button', { name: /^Request change$/i })).toBeNull();
  });

  it('Submitting the modal POSTs summary+details to /request-change and toasts the ticket id', async () => {
    makeExistingBankFetch((url, opts) => {
      if (url === '/api/travel/diagnostics/banks/42/request-change' && opts?.method === 'POST') {
        return Promise.resolve({ ticket: { id: 555, subject: 'x', status: 'Open' } });
      }
      return Promise.resolve(null);
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /^Request change$/i }));
    fireEvent.change(screen.getByLabelText(/Change request summary/i), {
      target: { value: 'Band 2 threshold too low' },
    });
    fireEvent.change(screen.getByLabelText(/Change request details/i), {
      target: { value: 'Repeat organisers keep landing in level_1.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Submit change request/i }));
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/diagnostics/banks/42/request-change' && o?.method === 'POST',
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body.summary).toBe('Band 2 threshold too low');
      expect(body.details).toBe('Repeat organisers keep landing in level_1.');
    });
    await waitFor(() => {
      expect(notifyObj.success).toHaveBeenCalled();
      expect(notifyObj.success.mock.calls[0][0]).toMatch(/ticket #555/i);
    });
    // Modal closes on success.
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /Request scoring change/i })).toBeNull();
    });
  });

  it('Submitting with an empty summary blocks the POST with a notify', async () => {
    makeExistingBankFetch();
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /^Request change$/i }));
    fireEvent.click(screen.getByRole('button', { name: /Submit change request/i }));
    await waitFor(() => {
      expect(notifyObj.error).toHaveBeenCalled();
      expect(notifyObj.error.mock.calls[0][0]).toMatch(/Summary is required/i);
    });
    expect(
      fetchApiMock.mock.calls.some(
        ([u, o]) => typeof u === 'string' && u.includes('/request-change') && o?.method === 'POST',
      ),
    ).toBe(false);
    // Modal stays open so the user can fill the summary in.
    expect(screen.getByRole('dialog', { name: /Request scoring change/i })).toBeTruthy();
  });

  it('Request-change failure surfaces the backend error and keeps the modal open', async () => {
    makeExistingBankFetch((url, opts) => {
      if (typeof url === 'string' && url.includes('/request-change') && opts?.method === 'POST') {
        return Promise.reject({ status: 404, data: { error: 'Bank not found' } });
      }
      return Promise.resolve(null);
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /^Request change$/i }));
    fireEvent.change(screen.getByLabelText(/Change request summary/i), {
      target: { value: 'Band 2 threshold too low' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Submit change request/i }));
    await waitFor(() => {
      expect(notifyObj.error).toHaveBeenCalled();
      expect(notifyObj.error.mock.calls[0][0]).toMatch(/Bank not found/i);
    });
    expect(screen.getByRole('dialog', { name: /Request scoring change/i })).toBeTruthy();
  });
});
