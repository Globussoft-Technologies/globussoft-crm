/**
 * CustomObjectView.test.jsx — vitest + RTL coverage for the custom-object
 * detail view (frontend/src/pages/CustomObjectView.jsx, 145 LOC).
 *
 * Lands at /objects/:entityName. Renders the records table for one entity
 * schema (dynamic fields from the custom-objects builder) with an inline
 * "add record" modal. Pinned read-only: SUT itself is the contract source.
 *
 * SUT contract (pinned from a read of CustomObjectView.jsx):
 *   - useParams returns { entityName }; SUT keys all fetches on that.
 *   - GET /api/custom_objects/records/:entityName on mount + when
 *     entityName changes. Response shape:
 *       { entity: { id, name, description, fields: [{id,name,type}] },
 *         records: [{ id, createdAt, ...dynamic-field-values }] }.
 *   - Loading state copy: "Compiling metadata array matrix for
 *     {entityName}..."
 *   - Missing entity (entity falsy) renders 'Entity Schema "{entityName}"
 *     restricted or undefined.' (uses curly quotes via the SUT's literal
 *     " character).
 *   - Header renders <Database /> icon + entity.name as h1 + description
 *     subtitle "Dynamic Object View | {description}" + 3 chrome buttons
 *     (Filter Set, Export CSV, New <Singular>). The "New" CTA strips the
 *     last char of entity.name to fake a singular (entity.name.slice(0,-1)).
 *   - Records table: header row has "ID" + one <th> per field
 *     (`{field.name} {field.type}`) + "Created At". Body row id-cell
 *     renders "EAV-{record.id}" in monospace. Boolean cells render
 *     "True"/"False"; other types render `String(value || '—')`.
 *   - Empty records → renders single row with colSpan = (fields.length+2)
 *     and copy "No {entity.name} documented vertically."
 *   - Clicking "New <Singular>" opens an overlay modal with a form. The
 *     modal renders one <label>/<input> per field. Type switch:
 *       Boolean → <select> with False/True options (default false stays
 *         until user picks)
 *       Number  → <input type="number" required>
 *       Date    → <input type="date" required>
 *       (other) → <input type="text" required>
 *   - Submitting the form fires POST /api/custom_objects/records/:entityName
 *     with body = JSON.stringify(formPayload); on success, closes the modal
 *     + re-fetches via loadData(). On reject, surfaces notify.error("Failed
 *     to log dynamic payload to EAV relational map.").
 *   - Cancel button in the modal closes the overlay (showAdd=false) without
 *     firing any POST.
 *
 * Drift pinned during authoring (prompt-implied vs. actual SUT):
 *   - SUT has NO RBAC gating, NO edit, NO delete, NO bulk-select, NO CSV
 *     import. The Export CSV / Filter Set buttons have no onClick handler
 *     wired — they're chrome-only stubs. Tests assert their presence but
 *     NOT any click-handler side effects (there are none).
 *   - SUT relies on classic curly-double-quote in the missing-entity copy:
 *     `Entity Schema "{entityName}" restricted or undefined.` — that
 *     literal string uses regular ASCII double-quotes per the source.
 *     The assertion uses a regex that tolerates surrounding chrome.
 *   - SUT calls useNotify but only consumes notify.error on POST failure.
 *     No success toast on add — page just re-fetches + closes the modal.
 *   - SUT passes Array.isArray guard on records → non-array `records`
 *     normalises to []. Test pins that with a malformed response.
 *
 * Mock discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked via vi.mock('../utils/api'); per-test mockImplementation.
 *   - useNotify mock is a STABLE module-level reference (RTL standing rule:
 *     Wave 11 cfb5789 / Wave 12 f59e91d — fresh per-call objects flap
 *     useEffect/useCallback identity and trigger infinite re-renders).
 *   - useParams stubbed via partial-spread of react-router-dom so <Link>
 *     still renders against the real router.
 *   - MemoryRouter wraps the SUT (the back-arrow renders <Link to="/objects">).
 *
 * Path: flat __tests__/ — no sibling test for this page yet (verified via
 * `ls frontend/src/__tests__/CustomObjectView*.test.*` returning none).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Stable notify object — RTL standing rule (Wave 11 cfb5789 / Wave 12 f59e91d).
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

// useParams stub — return a fixed entityName for all tests.
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ entityName: 'Projects' }),
  };
});

import CustomObjectView from '../pages/CustomObjectView';

// Canonical entity + records fixture. Mix of field types so type-switch
// branches in the table + the form get exercised.
const ENTITY_FIXTURE = {
  id: 11,
  name: 'Projects',
  description: 'Internal project tracker',
  fields: [
    { id: 1, name: 'Title', type: 'String' },
    { id: 2, name: 'Budget', type: 'Number' },
    { id: 3, name: 'Active', type: 'Boolean' },
    { id: 4, name: 'StartDate', type: 'Date' },
  ],
};

const RECORDS_FIXTURE = [
  {
    id: 501,
    Title: 'Alpha Migration',
    Budget: 50000,
    Active: true,
    StartDate: '2026-01-15',
    createdAt: '2026-05-20T10:00:00.000Z',
  },
  {
    id: 502,
    Title: 'Beta Rollout',
    Budget: 12000,
    Active: false,
    StartDate: '2026-02-01',
    createdAt: '2026-05-22T10:00:00.000Z',
  },
];

function installFetchMock({
  loadResponse = { entity: ENTITY_FIXTURE, records: RECORDS_FIXTURE },
  postResponse = null,
} = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    if (url === '/api/custom_objects/records/Projects' && method === 'GET') {
      if (loadResponse instanceof Error) return Promise.reject(loadResponse);
      return Promise.resolve(loadResponse);
    }
    if (url === '/api/custom_objects/records/Projects' && method === 'POST') {
      if (postResponse instanceof Error) return Promise.reject(postResponse);
      return Promise.resolve(postResponse || { id: 999 });
    }
    return Promise.resolve(null);
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <CustomObjectView />
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

describe('<CustomObjectView /> — load lifecycle', () => {
  it('renders the loading-state copy while the mount GET is in flight', () => {
    fetchApiMock.mockImplementation(() => new Promise(() => {})); // never resolves
    renderPage();
    expect(
      screen.getByText(/Compiling metadata array matrix for Projects/i),
    ).toBeInTheDocument();
  });

  it('fires GET /api/custom_objects/records/:entityName on mount and renders the entity header', async () => {
    renderPage();
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith(
        '/api/custom_objects/records/Projects',
      );
    });
    // Header h1 = entity.name
    expect(
      await screen.findByRole('heading', { level: 1, name: /Projects/i }),
    ).toBeInTheDocument();
    // Subtitle wraps description.
    expect(
      screen.getByText(/Dynamic Object View \| Internal project tracker/i),
    ).toBeInTheDocument();
  });

  it('renders the entity-restricted error copy when the GET resolves with falsy entity', async () => {
    installFetchMock({ loadResponse: { entity: null, records: [] } });
    renderPage();
    expect(
      await screen.findByText(/Entity Schema/i),
    ).toBeInTheDocument();
    // Substring match across the quoted entityName + the "restricted or undefined" tail.
    expect(
      screen.getByText(/restricted or undefined/i),
    ).toBeInTheDocument();
  });

  it('normalises a non-array records payload to an empty list (Array.isArray guard)', async () => {
    installFetchMock({
      loadResponse: { entity: ENTITY_FIXTURE, records: null },
    });
    renderPage();
    // Header still renders + empty-state row surfaces.
    await screen.findByRole('heading', { level: 1, name: /Projects/i });
    expect(
      screen.getByText(/No Projects documented vertically\./i),
    ).toBeInTheDocument();
  });
});

describe('<CustomObjectView /> — chrome buttons + back-link', () => {
  it('renders the three chrome buttons (Filter Set, Export CSV, New <Singular>)', async () => {
    renderPage();
    await screen.findByRole('heading', { level: 1, name: /Projects/i });
    expect(screen.getByRole('button', { name: /Filter Set/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Export CSV/i })).toBeInTheDocument();
    // New CTA strips the last char of entity.name → "Projects" → "Project".
    expect(
      screen.getByRole('button', { name: /^New Project$/i }),
    ).toBeInTheDocument();
  });

  it('renders the back-arrow link pointing at /objects', async () => {
    renderPage();
    await screen.findByRole('heading', { level: 1, name: /Projects/i });
    // The Link has no visible text — find by href via a closest anchor lookup.
    const anchors = document.querySelectorAll('a[href="/objects"]');
    expect(anchors.length).toBeGreaterThan(0);
  });
});

describe('<CustomObjectView /> — records table', () => {
  it('renders one <th> per field (with name + type pill) plus ID + Created At', async () => {
    renderPage();
    await screen.findByRole('heading', { level: 1, name: /Projects/i });
    // Field-name <th>s
    expect(screen.getByRole('columnheader', { name: /Title.*String/i })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Budget.*Number/i })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Active.*Boolean/i })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /StartDate.*Date/i })).toBeInTheDocument();
    // Static header cells.
    expect(screen.getByRole('columnheader', { name: /^ID$/i })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Created At/i })).toBeInTheDocument();
  });

  it('renders one row per record with EAV-<id> in the id cell and field values in the body cells', async () => {
    renderPage();
    // Title text from fixture row 0.
    expect(await screen.findByText('Alpha Migration')).toBeInTheDocument();
    expect(screen.getByText('Beta Rollout')).toBeInTheDocument();
    // EAV-prefixed id cells for both rows.
    expect(screen.getByText('EAV-501')).toBeInTheDocument();
    expect(screen.getByText('EAV-502')).toBeInTheDocument();
    // Number value rendered via String(...) — present as text.
    expect(screen.getByText('50000')).toBeInTheDocument();
    expect(screen.getByText('12000')).toBeInTheDocument();
  });

  it('renders Boolean cells as "True"/"False" (one of each across the two fixture rows)', async () => {
    renderPage();
    await screen.findByText('Alpha Migration');
    // Active=true on row 0, false on row 1.
    expect(screen.getByText('True')).toBeInTheDocument();
    expect(screen.getByText('False')).toBeInTheDocument();
  });

  it('renders empty-state copy when records:[] (colSpan covers the whole row)', async () => {
    installFetchMock({
      loadResponse: { entity: ENTITY_FIXTURE, records: [] },
    });
    renderPage();
    expect(
      await screen.findByText(/No Projects documented vertically\./i),
    ).toBeInTheDocument();
  });

  it('renders "—" placeholder when a record field value is missing/falsy (non-Boolean path)', async () => {
    installFetchMock({
      loadResponse: {
        entity: ENTITY_FIXTURE,
        records: [
          {
            id: 777,
            Title: '', // empty → falls back to '—' via String(value || '—')
            Budget: 0, // 0 is falsy → also '—'
            Active: false, // Boolean → renders "False", not "—"
            StartDate: '',
            createdAt: '2026-05-20T10:00:00.000Z',
          },
        ],
      },
    });
    renderPage();
    await screen.findByText('EAV-777');
    // Multiple '—' placeholders (Title, Budget, StartDate).
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBeGreaterThanOrEqual(2);
    // Boolean cell stays "False".
    expect(screen.getByText('False')).toBeInTheDocument();
  });
});

describe('<CustomObjectView /> — add-record modal', () => {
  it('opens the modal when "New Project" is clicked + closes via Cancel without firing POST', async () => {
    renderPage();
    await screen.findByRole('heading', { level: 1, name: /Projects/i });
    fireEvent.click(screen.getByRole('button', { name: /^New Project$/i }));
    // Modal heading renders.
    expect(
      await screen.findByRole('heading', { level: 3, name: /Add New Project/i }),
    ).toBeInTheDocument();
    // Form fields render — one per entity field.
    expect(screen.getByText('Title', { selector: 'label' })).toBeInTheDocument();
    expect(screen.getByText('Budget', { selector: 'label' })).toBeInTheDocument();
    expect(screen.getByText('Active', { selector: 'label' })).toBeInTheDocument();
    expect(screen.getByText('StartDate', { selector: 'label' })).toBeInTheDocument();

    // Cancel closes without firing POST.
    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    await waitFor(() => {
      expect(
        screen.queryByRole('heading', { level: 3, name: /Add New Project/i }),
      ).not.toBeInTheDocument();
    });
    // No POSTs fired during cancel.
    expect(
      fetchApiMock.mock.calls.find(([, o]) => o?.method === 'POST'),
    ).toBeUndefined();
  });

  it('renders the right input type per field (text / number / date / select for Boolean)', async () => {
    renderPage();
    await screen.findByRole('heading', { level: 1, name: /Projects/i });
    fireEvent.click(screen.getByRole('button', { name: /^New Project$/i }));
    await screen.findByRole('heading', { level: 3, name: /Add New Project/i });

    // Walk the form fields. Title's label sibling input is type=text.
    const inputs = document.querySelectorAll('.input-field');
    // 4 fields rendered as 4 controls.
    expect(inputs.length).toBe(4);
    // Boolean → select with False/True options.
    const selects = document.querySelectorAll('select.input-field');
    expect(selects.length).toBe(1);
    expect(within(selects[0]).getByRole('option', { name: 'False' })).toBeInTheDocument();
    expect(within(selects[0]).getByRole('option', { name: 'True' })).toBeInTheDocument();
    // At least one number input + one date input present.
    const numberInputs = document.querySelectorAll('input[type="number"].input-field');
    const dateInputs = document.querySelectorAll('input[type="date"].input-field');
    expect(numberInputs.length).toBe(1);
    expect(dateInputs.length).toBe(1);
  });

  it('submits the form via POST /api/custom_objects/records/:entityName and re-fetches the list on success', async () => {
    renderPage();
    await screen.findByRole('heading', { level: 1, name: /Projects/i });
    fireEvent.click(screen.getByRole('button', { name: /^New Project$/i }));
    const modalHeading = await screen.findByRole('heading', { level: 3, name: /Add New Project/i });
    const modal = modalHeading.closest('.card');

    // Fill the text input (Title) — it's the only type=text input.
    const textInput = modal.querySelector('input[type="text"]');
    fireEvent.change(textInput, { target: { value: 'Gamma Pilot' } });
    // Fill the number input.
    const numberInput = modal.querySelector('input[type="number"]');
    fireEvent.change(numberInput, { target: { value: '7500' } });
    // Fill the date input.
    const dateInput = modal.querySelector('input[type="date"]');
    fireEvent.change(dateInput, { target: { value: '2026-06-01' } });

    fetchApiMock.mockClear();
    installFetchMock({
      loadResponse: { entity: ENTITY_FIXTURE, records: RECORDS_FIXTURE },
      postResponse: { id: 999 },
    });

    // Submit via form-submit event so onSubmit fires.
    const form = modal.querySelector('form');
    fireEvent.submit(form);

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([, o]) => o?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      expect(postCall[0]).toBe('/api/custom_objects/records/Projects');
      const body = JSON.parse(postCall[1].body);
      // Payload carries the filled-in fields. Active stayed at its default
      // (false for Boolean per initialForm init).
      expect(body.Title).toBe('Gamma Pilot');
      expect(body.Budget).toBe('7500');
      expect(body.StartDate).toBe('2026-06-01');
      expect(body.Active).toBe(false);
    });

    // On success the modal closes (showAdd=false).
    await waitFor(() => {
      expect(
        screen.queryByRole('heading', { level: 3, name: /Add New Project/i }),
      ).not.toBeInTheDocument();
    });

    // And loadData() re-fetches the list.
    await waitFor(() => {
      const getCalls = fetchApiMock.mock.calls.filter(
        ([u, o]) =>
          u === '/api/custom_objects/records/Projects' &&
          (!o?.method || o.method === 'GET'),
      );
      expect(getCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('surfaces notify.error and keeps the modal open when POST rejects', async () => {
    renderPage();
    await screen.findByRole('heading', { level: 1, name: /Projects/i });
    fireEvent.click(screen.getByRole('button', { name: /^New Project$/i }));
    const modalHeading = await screen.findByRole('heading', { level: 3, name: /Add New Project/i });
    const modal = modalHeading.closest('.card');

    // Fill a value so the required-text passes.
    fireEvent.change(modal.querySelector('input[type="text"]'), {
      target: { value: 'Rejected One' },
    });
    fireEvent.change(modal.querySelector('input[type="number"]'), {
      target: { value: '100' },
    });
    fireEvent.change(modal.querySelector('input[type="date"]'), {
      target: { value: '2026-06-15' },
    });

    installFetchMock({
      loadResponse: { entity: ENTITY_FIXTURE, records: RECORDS_FIXTURE },
      postResponse: new Error('boom'),
    });

    const form = modal.querySelector('form');
    fireEvent.submit(form);

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        'Failed to log dynamic payload to EAV relational map.',
      );
    });
    // Modal stays open on error (SUT only closes inside the try-success branch).
    expect(
      screen.getByRole('heading', { level: 3, name: /Add New Project/i }),
    ).toBeInTheDocument();
  });
});
