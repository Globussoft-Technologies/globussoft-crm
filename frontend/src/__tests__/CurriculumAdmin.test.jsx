/**
 * CurriculumAdmin.test.jsx — vitest + RTL coverage for the Phase 1 TMC
 * Curriculum Mappings admin CRUD page (frontend/src/pages/travel/
 * CurriculumAdmin.jsx, tick #181 — consumes /api/travel-curriculum from
 * backend commit 6d5919a8 — tick #180).
 *
 * Scope — pins the page-surface invariants for the curriculum-mappings
 * admin (sibling to EmbassyRulesAdmin / QuotesAdmin / InvoicesAdmin):
 *
 *   1. Loading state: shows "Loading…" before the first GET resolves
 *      (await findByText per CLAUDE.md tick #108 cron-learning).
 *   2. Page chrome on mount: heading "Curriculum Mappings" + filter
 *      chrome (curriculum / grade / subject / active selects) +
 *      "New Mapping" CTA (ADMIN only).
 *   3. GET on mount: hits /api/travel-curriculum (no query string when
 *      all filters empty) exactly once.
 *   4. List render: mappings table renders one row per mapping with
 *      curriculum / grade / subject / learning outcome / destination /
 *      fitScore badge / isActive + per-row Edit/Delete actions
 *      (ADMIN-only). FitScore badge color class reflects band
 *      (green ≥80, amber 50-79, red <50).
 *   5. Filter interaction: choosing CBSE in the curriculum filter
 *      triggers re-fetch with ?curriculum=CBSE. isActive=false re-fetch
 *      fires with ?isActive=false.
 *   6. New Mapping modal: clicking "New Mapping" opens the modal with
 *      all expected fields. Submit fires POST /api/travel-curriculum
 *      with the trimmed body (curriculum/grade/subject/learningOutcome/
 *      destinationLabel/fitScore/fitRationale/isActive).
 *   7. Validation — learningOutcome >300 chars: surfaces an inline
 *      error and does NOT fire a POST. (We use a 301-char payload to
 *      bypass jsdom's lack of maxLength enforcement on fireEvent.change.)
 *   8. Validation — fitScore=150: surfaces an inline error and does
 *      NOT fire a POST.
 *   9. Validation — fitScore=-5: surfaces an inline error and does
 *      NOT fire a POST.
 *  10. Edit flow: opens modal pre-filled + fires PUT on submit.
 *  11. Delete flow: window.confirm=true → DELETE fires; confirm=false →
 *      NO DELETE fires.
 *  12. RBAC: role=USER hides the New Mapping CTA + per-row Edit/Delete
 *      buttons (the GET still fires for read-only visibility).
 *  13. Server error mapping: a POST returning CURRICULUM_DUPLICATE
 *      surfaces the user-friendly message via notify.error.
 *  14. Server error mapping: a POST returning INVALID_FIT_SCORE
 *      surfaces an inline field error AND notify.error.
 *
 * Backend contract pinned (per backend/routes/travel_curriculum.js — 6d5919a8):
 *   GET    /api/travel-curriculum?curriculum&grade&subject&isActive
 *          → 200 { mappings, total, limit, offset }
 *   POST   /api/travel-curriculum → 201 created (ADMIN-only)
 *          body: { curriculum, grade, subject, learningOutcome?,
 *                  destinationId?, destinationLabel?, fitScore?,
 *                  fitRationale?, isActive? }
 *   PUT    /api/travel-curriculum/:id → 200 updated (ADMIN-only)
 *   DELETE /api/travel-curriculum/:id → 200 soft-deleted
 *   Error codes: CURRICULUM_NOT_FOUND / CURRICULUM_DUPLICATE /
 *                INVALID_FIT_SCORE / INVALID_DESTINATION_ID /
 *                MISSING_FIELDS / EMPTY_BODY / INVALID_ID / RBAC_DENIED
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at ../utils/api (the page's dep, NOT global fetch).
 *   - notifyObj is a STABLE module-level reference so useNotify identity
 *     stays stable across renders (RTL standing rule: Wave 11 cfb5789 /
 *     Wave 12 f59e91d — fresh per-call objects flap state across renders).
 *   - AuthContext is wrapped via Provider — Default user role = ADMIN;
 *     one test mounts with role=USER to assert RBAC hide.
 *   - window.confirm is stubbed per-test (vi.spyOn) so we can drive the
 *     confirm=true / confirm=false branches of the delete flow.
 *   - All data-dependent assertions use await findBy / waitFor.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Stable notify object — RTL standing rule (Wave 11 cfb5789 / Wave 12
// f59e91d). The SUT closes over notify in submit / handleDelete
// handlers; a fresh per-call object would flap useCallback identity.
const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyInfo = vi.fn();
const notifyConfirm = vi.fn(() => Promise.resolve(true));
const notifyObj = {
  error: notifyError,
  info: notifyInfo,
  success: notifySuccess,
  confirm: notifyConfirm,
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

import { AuthContext } from '../App';
import CurriculumAdmin from '../pages/travel/CurriculumAdmin';

const ADMIN_USER = { userId: 1, name: 'Admin', email: 'a@x.com', role: 'ADMIN' };
const USER_USER = { userId: 3, name: 'Plain User', email: 'u@x.com', role: 'USER' };

function makeMapping(overrides = {}) {
  return {
    id: 501,
    tenantId: 1,
    curriculum: 'CBSE',
    grade: '9',
    subject: 'History',
    learningOutcome: 'Mughal architecture — field trip linkage to Agra/Delhi monuments',
    destinationId: 42,
    destinationLabel: 'Agra + Delhi heritage circuit',
    fitScore: 85,
    fitRationale: 'Direct alignment between Class 9 NCERT history chapter on Mughal era and on-site Agra/Delhi monuments.',
    isActive: true,
    createdById: 1,
    createdAt: '2026-05-23T10:00:00.000Z',
    updatedAt: '2026-05-23T10:00:00.000Z',
    ...overrides,
  };
}

const MAPPINGS_DEFAULT = [
  makeMapping({
    id: 501,
    curriculum: 'CBSE',
    grade: '9',
    subject: 'History',
    learningOutcome: 'Mughal architecture — field trip linkage to Agra/Delhi monuments',
    destinationLabel: 'Agra + Delhi heritage circuit',
    fitScore: 85, // green
    isActive: true,
  }),
  makeMapping({
    id: 502,
    curriculum: 'ICSE',
    grade: '10',
    subject: 'Physics',
    learningOutcome: 'Practical electromagnetism — ISRO Bengaluru lab visit',
    destinationLabel: 'Bengaluru STEM circuit',
    fitScore: 65, // amber
    isActive: true,
  }),
  makeMapping({
    id: 503,
    curriculum: 'IB',
    grade: '11',
    subject: 'Geography',
    learningOutcome: 'Coastal erosion patterns — Goa shoreline study',
    destinationLabel: 'Goa coastal study',
    fitScore: 35, // red
    isActive: false,
  }),
];

function installFetchMock({
  list = { mappings: MAPPINGS_DEFAULT, total: MAPPINGS_DEFAULT.length, limit: 100, offset: 0 },
  create = null,
  update = null,
  del = null,
} = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    if (typeof url === 'string' && url.startsWith('/api/travel-curriculum')) {
      if (method === 'GET') {
        if (list instanceof Error) return Promise.reject(list);
        return Promise.resolve(list);
      }
      if (method === 'POST') {
        if (create instanceof Error) return Promise.reject(create);
        return Promise.resolve(create || makeMapping({ id: 999 }));
      }
      if (method === 'PUT') {
        if (update instanceof Error) return Promise.reject(update);
        return Promise.resolve(update || makeMapping({ id: 501 }));
      }
      if (method === 'DELETE') {
        if (del instanceof Error) return Promise.reject(del);
        return Promise.resolve(del || { ...makeMapping({ id: 501 }), isActive: false });
      }
    }
    return Promise.resolve(null);
  });
}

function renderPage(user = ADMIN_USER) {
  const value = { user, token: 'tk', tenant: { id: 1, defaultCurrency: 'INR' }, loading: false };
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={value}>
        <CurriculumAdmin />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyError.mockReset();
  notifySuccess.mockReset();
  notifyInfo.mockReset();
  notifyConfirm.mockReset();
  notifyConfirm.mockResolvedValue(true);
  installFetchMock();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<CurriculumAdmin /> — page chrome + RBAC', () => {
  it('renders heading + filter chrome + "New Mapping" CTA when role=ADMIN; fires GET on mount', async () => {
    renderPage();
    expect(screen.getByRole('heading', { name: /Curriculum Mappings/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/Filter by curriculum/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Filter by grade/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Filter by subject/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Filter by active state/i)).toBeInTheDocument();
    expect(screen.getByTestId('curriculum-mapping-new')).toBeInTheDocument();
    await waitFor(() => {
      const calls = fetchApiMock.mock.calls.filter(
        ([u]) => typeof u === 'string' && u.startsWith('/api/travel-curriculum'),
      );
      expect(calls.length).toBeGreaterThan(0);
    });
  });

  it('hides "New Mapping" + Edit/Delete CTAs for role=USER; GET still fires for read-only', async () => {
    renderPage(USER_USER);
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    expect(screen.queryByTestId('curriculum-mapping-new')).toBeNull();
    await screen.findByText(/Mughal architecture/i);
    expect(screen.queryByTestId('curriculum-mapping-edit-501')).toBeNull();
    expect(screen.queryByTestId('curriculum-mapping-delete-501')).toBeNull();
  });
});

describe('<CurriculumAdmin /> — list + filter lifecycle', () => {
  it('shows "Loading…" before first GET resolves', async () => {
    let resolveList;
    fetchApiMock.mockImplementation((url) => {
      if (typeof url === 'string' && url.startsWith('/api/travel-curriculum')) {
        return new Promise((res) => { resolveList = res; });
      }
      return Promise.resolve(null);
    });
    renderPage();
    await waitFor(() => {
      expect(screen.getAllByText(/Loading…/i).length).toBeGreaterThanOrEqual(1);
    });
    resolveList({ mappings: MAPPINGS_DEFAULT, total: MAPPINGS_DEFAULT.length, limit: 100, offset: 0 });
    await screen.findByText(/Mughal architecture/i);
  });

  it('GET on mount with NO query string when filters are empty; renders one row per mapping + fit-score badge band classes', async () => {
    renderPage();
    await waitFor(() => {
      const getCall = fetchApiMock.mock.calls.find(
        ([u, o]) =>
          typeof u === 'string'
          && u.startsWith('/api/travel-curriculum')
          && (!o?.method || o.method === 'GET'),
      );
      expect(getCall).toBeTruthy();
      expect(getCall[0]).toBe('/api/travel-curriculum');
    });
    // Each mapping renders by learningOutcome text.
    expect(await screen.findByText(/Mughal architecture/i)).toBeInTheDocument();
    expect(screen.getByText(/Practical electromagnetism/i)).toBeInTheDocument();
    expect(screen.getByText(/Coastal erosion patterns/i)).toBeInTheDocument();
    // Fit score badge classes — verify the band classes are applied.
    const row501 = screen.getByTestId('curriculum-mapping-row-501');
    const row502 = screen.getByTestId('curriculum-mapping-row-502');
    const row503 = screen.getByTestId('curriculum-mapping-row-503');
    expect(row501.querySelector('.curriculum-fit-green')).toBeTruthy(); // 85 ≥ 80
    expect(row502.querySelector('.curriculum-fit-amber')).toBeTruthy(); // 65 in [50, 80)
    expect(row503.querySelector('.curriculum-fit-red')).toBeTruthy();   // 35 < 50
  });

  it('curriculum filter re-fetches with ?curriculum=CBSE', async () => {
    renderPage();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    fetchApiMock.mockClear();
    fireEvent.change(screen.getByLabelText(/Filter by curriculum/i), { target: { value: 'CBSE' } });
    await waitFor(() => {
      const fetchCall = fetchApiMock.mock.calls.find(
        ([u]) => typeof u === 'string' && u.includes('curriculum=CBSE'),
      );
      expect(fetchCall).toBeTruthy();
    });
  });

  it('isActive=false filter re-fetches with ?isActive=false', async () => {
    renderPage();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    fetchApiMock.mockClear();
    fireEvent.change(screen.getByLabelText(/Filter by active state/i), { target: { value: 'false' } });
    await waitFor(() => {
      const fetchCall = fetchApiMock.mock.calls.find(
        ([u]) => typeof u === 'string' && u.includes('isActive=false'),
      );
      expect(fetchCall).toBeTruthy();
    });
  });
});

describe('<CurriculumAdmin /> — create modal', () => {
  it('opens with all expected fields when "New Mapping" is clicked', async () => {
    renderPage();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('curriculum-mapping-new'));
    expect(await screen.findByText(/New Curriculum Mapping/i)).toBeInTheDocument();
    expect(screen.getByTestId('curriculum-form-curriculum')).toBeInTheDocument();
    expect(screen.getByTestId('curriculum-form-grade')).toBeInTheDocument();
    expect(screen.getByTestId('curriculum-form-subject')).toBeInTheDocument();
    expect(screen.getByTestId('curriculum-form-learning-outcome')).toBeInTheDocument();
    expect(screen.getByTestId('curriculum-form-destination-label')).toBeInTheDocument();
    expect(screen.getByTestId('curriculum-form-destination-id')).toBeInTheDocument();
    expect(screen.getByTestId('curriculum-form-fit-score')).toBeInTheDocument();
    expect(screen.getByTestId('curriculum-form-fit-rationale')).toBeInTheDocument();
    expect(screen.getByTestId('curriculum-form-active')).toBeInTheDocument();
  });

  it('submit happy path: POST /api/travel-curriculum with all expected fields', async () => {
    renderPage();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('curriculum-mapping-new'));
    await screen.findByText(/New Curriculum Mapping/i);

    fireEvent.change(screen.getByTestId('curriculum-form-curriculum'), { target: { value: 'IB' } });
    fireEvent.change(screen.getByTestId('curriculum-form-grade'), { target: { value: '11' } });
    fireEvent.change(screen.getByTestId('curriculum-form-subject'), { target: { value: 'Biology' } });
    fireEvent.change(screen.getByTestId('curriculum-form-learning-outcome'), {
      target: { value: 'Marine ecosystems — Andaman coral reef study' },
    });
    fireEvent.change(screen.getByTestId('curriculum-form-destination-label'), {
      target: { value: 'Andaman marine biology trip' },
    });
    fireEvent.change(screen.getByTestId('curriculum-form-fit-score'), { target: { value: '90' } });
    fireEvent.change(screen.getByTestId('curriculum-form-fit-rationale'), {
      target: { value: 'Direct IB Bio HL ecology unit alignment.' },
    });

    fetchApiMock.mockClear();
    installFetchMock();

    fireEvent.click(screen.getByTestId('curriculum-form-submit'));

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel-curriculum' && o?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.curriculum).toBe('IB');
      expect(body.grade).toBe('11');
      expect(body.subject).toBe('Biology');
      expect(body.learningOutcome).toBe('Marine ecosystems — Andaman coral reef study');
      expect(body.destinationLabel).toBe('Andaman marine biology trip');
      expect(body.fitScore).toBe(90);
      expect(body.fitRationale).toBe('Direct IB Bio HL ecology unit alignment.');
      expect(body.isActive).toBe(true);
    });
    await waitFor(() => expect(notifySuccess).toHaveBeenCalled());
  });

  it('validation — learningOutcome >300 chars surfaces inline error and does NOT POST', async () => {
    renderPage();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('curriculum-mapping-new'));
    await screen.findByText(/New Curriculum Mapping/i);

    fireEvent.change(screen.getByTestId('curriculum-form-curriculum'), { target: { value: 'CBSE' } });
    fireEvent.change(screen.getByTestId('curriculum-form-grade'), { target: { value: '9' } });
    fireEvent.change(screen.getByTestId('curriculum-form-subject'), { target: { value: 'History' } });
    // 301-char string. jsdom doesn't enforce maxLength on fireEvent.change
    // so we exercise the client-side gate by pushing past the limit.
    const longText = 'x'.repeat(301);
    fireEvent.change(screen.getByTestId('curriculum-form-learning-outcome'), {
      target: { value: longText },
    });

    fetchApiMock.mockClear();
    fireEvent.click(screen.getByTestId('curriculum-form-submit'));

    await waitFor(() => {
      expect(screen.getByText(/300 characters or fewer/i)).toBeInTheDocument();
    });
    const postCalls = fetchApiMock.mock.calls.filter(
      ([u, o]) => u === '/api/travel-curriculum' && o?.method === 'POST',
    );
    expect(postCalls.length).toBe(0);
  });

  it('validation — fitScore=150 fires inline error and does NOT POST', async () => {
    renderPage();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('curriculum-mapping-new'));
    await screen.findByText(/New Curriculum Mapping/i);

    fireEvent.change(screen.getByTestId('curriculum-form-curriculum'), { target: { value: 'CBSE' } });
    fireEvent.change(screen.getByTestId('curriculum-form-grade'), { target: { value: '9' } });
    fireEvent.change(screen.getByTestId('curriculum-form-subject'), { target: { value: 'History' } });
    fireEvent.change(screen.getByTestId('curriculum-form-fit-score'), { target: { value: '150' } });

    fetchApiMock.mockClear();
    fireEvent.click(screen.getByTestId('curriculum-form-submit'));

    await waitFor(() => {
      expect(screen.getByText(/whole number between 1 and 100/i)).toBeInTheDocument();
    });
    const postCalls = fetchApiMock.mock.calls.filter(
      ([u, o]) => u === '/api/travel-curriculum' && o?.method === 'POST',
    );
    expect(postCalls.length).toBe(0);
  });

  it('validation — fitScore=-5 fires inline error and does NOT POST', async () => {
    renderPage();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('curriculum-mapping-new'));
    await screen.findByText(/New Curriculum Mapping/i);

    fireEvent.change(screen.getByTestId('curriculum-form-curriculum'), { target: { value: 'CBSE' } });
    fireEvent.change(screen.getByTestId('curriculum-form-grade'), { target: { value: '9' } });
    fireEvent.change(screen.getByTestId('curriculum-form-subject'), { target: { value: 'History' } });
    fireEvent.change(screen.getByTestId('curriculum-form-fit-score'), { target: { value: '-5' } });

    fetchApiMock.mockClear();
    fireEvent.click(screen.getByTestId('curriculum-form-submit'));

    await waitFor(() => {
      expect(screen.getByText(/whole number between 1 and 100/i)).toBeInTheDocument();
    });
    const postCalls = fetchApiMock.mock.calls.filter(
      ([u, o]) => u === '/api/travel-curriculum' && o?.method === 'POST',
    );
    expect(postCalls.length).toBe(0);
  });

  it('server error mapping: CURRICULUM_DUPLICATE → notify.error with user-friendly message', async () => {
    const err = new Error('A curriculum mapping with that (curriculum, grade, subject, learningOutcome) already exists for this tenant.');
    err.code = 'CURRICULUM_DUPLICATE';
    err.data = { code: 'CURRICULUM_DUPLICATE', error: err.message };

    installFetchMock({ create: err });
    renderPage();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('curriculum-mapping-new'));
    await screen.findByText(/New Curriculum Mapping/i);

    fireEvent.change(screen.getByTestId('curriculum-form-curriculum'), { target: { value: 'CBSE' } });
    fireEvent.change(screen.getByTestId('curriculum-form-grade'), { target: { value: '9' } });
    fireEvent.change(screen.getByTestId('curriculum-form-subject'), { target: { value: 'History' } });
    fireEvent.click(screen.getByTestId('curriculum-form-submit'));

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalled();
      const msg = notifyError.mock.calls[0][0];
      expect(msg).toMatch(/already exists/i);
    });
  });

  it('server error mapping: INVALID_FIT_SCORE → inline field error + notify.error', async () => {
    const err = new Error('fitScore must be an integer between 1 and 100');
    err.code = 'INVALID_FIT_SCORE';
    err.data = { code: 'INVALID_FIT_SCORE', error: err.message };

    installFetchMock({ create: err });
    renderPage();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('curriculum-mapping-new'));
    await screen.findByText(/New Curriculum Mapping/i);

    // Submit values that PASS client-side gates so the request actually
    // fires and we exercise the server-error mapping path.
    fireEvent.change(screen.getByTestId('curriculum-form-curriculum'), { target: { value: 'CBSE' } });
    fireEvent.change(screen.getByTestId('curriculum-form-grade'), { target: { value: '9' } });
    fireEvent.change(screen.getByTestId('curriculum-form-subject'), { target: { value: 'History' } });
    fireEvent.click(screen.getByTestId('curriculum-form-submit'));

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalled();
      const msg = notifyError.mock.calls[0][0];
      expect(msg).toMatch(/whole number between 1 and 100/i);
    });
    // Inline field error rendered on the fitScore field.
    expect(screen.getAllByText(/whole number between 1 and 100/i).length).toBeGreaterThanOrEqual(1);
  });
});

describe('<CurriculumAdmin /> — edit + delete', () => {
  it('edit flow: opens modal pre-filled + fires PUT on submit', async () => {
    renderPage();
    const editBtn = await screen.findByTestId('curriculum-mapping-edit-501');
    fireEvent.click(editBtn);
    expect(await screen.findByText(/Edit Curriculum Mapping/i)).toBeInTheDocument();
    // Pre-filled from the mapping.
    expect(screen.getByTestId('curriculum-form-curriculum').value).toBe('CBSE');
    expect(screen.getByTestId('curriculum-form-grade').value).toBe('9');
    expect(screen.getByTestId('curriculum-form-subject').value).toBe('History');
    expect(screen.getByTestId('curriculum-form-learning-outcome').value).toMatch(/Mughal architecture/i);

    // Tweak the learning outcome + submit.
    fireEvent.change(screen.getByTestId('curriculum-form-learning-outcome'), {
      target: { value: 'Mughal architecture — Agra/Delhi monuments + Fatehpur Sikri added' },
    });

    fetchApiMock.mockClear();
    installFetchMock();

    fireEvent.click(screen.getByTestId('curriculum-form-submit'));

    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel-curriculum/501' && o?.method === 'PUT',
      );
      expect(putCall).toBeTruthy();
      const body = JSON.parse(putCall[1].body);
      expect(body.learningOutcome).toMatch(/Fatehpur Sikri/);
    });
    await waitFor(() => expect(notifySuccess).toHaveBeenCalled());
  });

  it('delete flow: window.confirm=true → DELETE fires; confirm=false → NO DELETE fires', async () => {
    renderPage();
    const deleteBtn = await screen.findByTestId('curriculum-mapping-delete-501');

    // First click: user cancels the confirm dialog.
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fetchApiMock.mockClear();
    fireEvent.click(deleteBtn);
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    const cancelledDeletes = fetchApiMock.mock.calls.filter(
      ([u, o]) => u === '/api/travel-curriculum/501' && o?.method === 'DELETE',
    );
    expect(cancelledDeletes.length).toBe(0);

    // Second click: user confirms.
    confirmSpy.mockReturnValue(true);
    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(deleteBtn);
    await waitFor(() => {
      const deleteCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel-curriculum/501' && o?.method === 'DELETE',
      );
      expect(deleteCall).toBeTruthy();
    });
    await waitFor(() => expect(notifySuccess).toHaveBeenCalled());
    confirmSpy.mockRestore();
  });
});
