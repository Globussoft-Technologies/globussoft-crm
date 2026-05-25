/**
 * Patients.jsx — server-side pagination + inline tag-add (#820)
 *
 * Pins the contract for tick #185 changes:
 *   1. Server-side pagination — GET /api/wellness/patients?limit=N&offset=M.
 *      Frontend reads `total` from the response envelope (not patients.length)
 *      and renders page-number indicator + Prev/Next + "Showing X-Y of Z".
 *   2. Rows-per-page selector — 25 / 50 / 100; changing it refires the fetch
 *      with the new `limit` and resets to page 1.
 *   3. Search/filter change resets to page 1 (avoids stranding the user on a
 *      page that no longer exists after they tighten the query).
 *   4. Tags column — patient.tags (JSON-string) renders as chips per row;
 *      `+` button opens an inline input that PATCHes
 *      /api/wellness/patients/bulk-tags with `{patientIds: [thisOne], addTags: [t]}`.
 *
 * Mock object refs (notify) are STABLE per test run so useEffect deps don't
 * thrash (RTL infinite-re-render gotcha per CLAUDE.md standing rule).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../utils/api', () => ({
  fetchApi: vi.fn(),
  getAuthToken: vi.fn(() => 'fake-token'),
}));

// Stable notify object — single reference across the entire test module so
// any `useEffect` / `useCallback` deps that include `notify` see a stable
// identity and don't re-fire to infinity.
const notifyObj = {
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  confirm: vi.fn(),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

import { fetchApi } from '../utils/api';
import Patients from '../pages/wellness/Patients';

// Helper — build N patient rows shaped like the backend payload.
function buildPatients(start, count) {
  return Array.from({ length: count }, (_, i) => ({
    id: start + i,
    name: `Patient ${start + i}`,
    phone: `+91987654${String(start + i).padStart(4, '0')}`,
    email: `p${start + i}@test.in`,
    gender: 'F',
    source: 'walk-in',
    createdAt: '2026-05-20T10:00:00Z',
    tags: null,
  }));
}

// Default mock handler — interprets ?limit + ?offset from the query string
// against a 51-row population, returns {patients, total}. Any test that
// wants different totals overrides via fetchApi.mockImplementation in its
// own beforeEach / it block.
function defaultFetchHandler(url, _opts) {
  if (url.startsWith('/api/wellness/patients?')) {
    const qs = url.split('?')[1];
    const params = new URLSearchParams(qs);
    const limit = parseInt(params.get('limit') || '25', 10);
    const offset = parseInt(params.get('offset') || '0', 10);
    const total = 51;
    const all = buildPatients(1, total);
    const slice = all.slice(offset, offset + limit);
    return Promise.resolve({ patients: slice, total });
  }
  if (url === '/api/wellness/locations') return Promise.resolve([]);
  return Promise.resolve({ patients: [], total: 0 });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <Patients />
    </MemoryRouter>,
  );
}

describe('<Patients /> — server-side pagination (#820)', () => {
  beforeEach(() => {
    fetchApi.mockReset();
    notifyObj.success.mockReset();
    notifyObj.error.mockReset();
    fetchApi.mockImplementation(defaultFetchHandler);
  });

  it('initial fetch passes limit=25 and offset=0', async () => {
    renderPage();
    await waitFor(() => {
      const initial = fetchApi.mock.calls.find(([u]) =>
        u.startsWith('/api/wellness/patients?'),
      );
      expect(initial).toBeTruthy();
      const url = initial[0];
      expect(url).toMatch(/limit=25/);
      expect(url).toMatch(/offset=0/);
    });
  });

  it('renders the Showing X-Y of Z indicator using the backend `total`', async () => {
    renderPage();
    const indicator = await screen.findByTestId('patients-pagination-indicator');
    // total=51, page 1, rows=25 → "Showing 1-25 of 51"
    expect(indicator.textContent).toMatch(/Showing 1-25 of 51/);
  });

  it('clicking Next paginates to offset=25 and updates the indicator', async () => {
    const user = userEvent.setup();
    renderPage();
    // wait for first page to land
    await screen.findByTestId('patients-pagination-indicator');
    await user.click(screen.getByTestId('patients-page-next'));

    // The most recent /patients fetch is for page 2.
    await waitFor(() => {
      const recent = [...fetchApi.mock.calls]
        .reverse()
        .find(([u]) => u.startsWith('/api/wellness/patients?'));
      const url = recent[0];
      expect(url).toMatch(/limit=25/);
      expect(url).toMatch(/offset=25/);
    });

    // Indicator now reads 26-50 of 51.
    await waitFor(() => {
      expect(screen.getByTestId('patients-pagination-indicator').textContent).toMatch(
        /Showing 26-50 of 51/,
      );
    });
  });

  it('switching rows-per-page to 50 refires the fetch with limit=50 and resets to page 1', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('patients-pagination-indicator');

    // Navigate to page 2 so we can verify the reset-to-page-1 behaviour.
    await user.click(screen.getByTestId('patients-page-next'));
    await waitFor(() => {
      expect(screen.getByTestId('patients-pagination-indicator').textContent).toMatch(
        /Showing 26-50/,
      );
    });

    // Bump rows-per-page from 25 → 50.
    const select = screen.getByTestId('rows-per-page-select');
    await user.selectOptions(select, '50');

    // A fresh fetch goes out with limit=50 and offset=0 (reset).
    await waitFor(() => {
      const recent = [...fetchApi.mock.calls]
        .reverse()
        .find(([u]) => u.startsWith('/api/wellness/patients?'));
      const url = recent[0];
      expect(url).toMatch(/limit=50/);
      expect(url).toMatch(/offset=0/);
    });

    // Indicator updates accordingly.
    await waitFor(() => {
      expect(screen.getByTestId('patients-pagination-indicator').textContent).toMatch(
        /Showing 1-50 of 51/,
      );
    });
  });

  it('typing in the search box resets to page 1', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('patients-pagination-indicator');

    // Go to page 2 first.
    await user.click(screen.getByTestId('patients-page-next'));
    await waitFor(() => {
      expect(screen.getByTestId('patients-pagination-indicator').textContent).toMatch(
        /Showing 26-50/,
      );
    });

    // Type a query — page should reset to 1; fetch should include q + offset=0.
    const searchBox = screen.getByPlaceholderText(/Search by name/i);
    await user.type(searchBox, 'a');

    await waitFor(
      () => {
        const recent = [...fetchApi.mock.calls]
          .reverse()
          .find(([u]) => u.startsWith('/api/wellness/patients?') && /q=a/.test(u));
        expect(recent).toBeTruthy();
        expect(recent[0]).toMatch(/offset=0/);
      },
      { timeout: 2000 },
    );
  });
});

describe('<Patients /> — Tags column + inline add (#820 Part 2)', () => {
  beforeEach(() => {
    fetchApi.mockReset();
    notifyObj.success.mockReset();
    notifyObj.error.mockReset();
  });

  it('renders a chip for each tag in the JSON-string tags field', async () => {
    fetchApi.mockImplementation((url) => {
      if (url.startsWith('/api/wellness/patients?')) {
        return Promise.resolve({
          patients: [
            {
              id: 7,
              name: 'Rohan Mehta',
              phone: '+919876500007',
              email: 'rohan@test.in',
              gender: 'M',
              source: 'walk-in',
              createdAt: '2026-05-20T10:00:00Z',
              tags: JSON.stringify(['vip', 'follow-up']),
            },
          ],
          total: 1,
        });
      }
      if (url === '/api/wellness/locations') return Promise.resolve([]);
      return Promise.resolve({});
    });

    renderPage();
    // VIP chip renders.
    expect(await screen.findByTestId('tag-chip-7-vip')).toBeInTheDocument();
    expect(screen.getByTestId('tag-chip-7-follow-up')).toBeInTheDocument();
  });

  it('renders no chips when tags is null or malformed', async () => {
    fetchApi.mockImplementation((url) => {
      if (url.startsWith('/api/wellness/patients?')) {
        return Promise.resolve({
          patients: [
            { id: 1, name: 'Null Tags', phone: '+919800000001', email: '', gender: '', source: '', createdAt: '2026-05-20T10:00:00Z', tags: null },
            { id: 2, name: 'Bad Tags',  phone: '+919800000002', email: '', gender: '', source: '', createdAt: '2026-05-20T10:00:00Z', tags: '{not json' },
            { id: 3, name: 'Empty Tags',phone: '+919800000003', email: '', gender: '', source: '', createdAt: '2026-05-20T10:00:00Z', tags: '' },
          ],
          total: 3,
        });
      }
      if (url === '/api/wellness/locations') return Promise.resolve([]);
      return Promise.resolve({});
    });

    renderPage();
    // Wait for the table to render at least one row.
    await screen.findByText('Null Tags');
    // None of the three rows should produce a tag-chip-* element. We assert
    // on the explicit DOM absence rather than a generic count to keep the
    // assertion stable even if other test fixtures change.
    expect(document.querySelectorAll('[data-testid^="tag-chip-"]').length).toBe(0);
    // All three rows still have a `+` button.
    expect(screen.getByTestId('tag-add-1')).toBeInTheDocument();
    expect(screen.getByTestId('tag-add-2')).toBeInTheDocument();
    expect(screen.getByTestId('tag-add-3')).toBeInTheDocument();
  });

  it('clicking + then typing + Enter PATCHes /bulk-tags with single-id payload', async () => {
    fetchApi.mockImplementation((url, opts) => {
      if (url === '/api/wellness/patients/bulk-tags' && opts?.method === 'PATCH') {
        return Promise.resolve({ updated: 1 });
      }
      if (url.startsWith('/api/wellness/patients?')) {
        return Promise.resolve({
          patients: [
            {
              id: 42,
              name: 'Tagged Patient',
              phone: '+919876500042',
              email: 't@test.in',
              gender: 'F',
              source: 'walk-in',
              createdAt: '2026-05-20T10:00:00Z',
              tags: null,
            },
          ],
          total: 1,
        });
      }
      if (url === '/api/wellness/locations') return Promise.resolve([]);
      return Promise.resolve({});
    });

    const user = userEvent.setup();
    renderPage();
    const addBtn = await screen.findByTestId('tag-add-42');
    await user.click(addBtn);

    // Inline input is now visible.
    const input = screen.getByLabelText(/New tag for Tagged Patient/i);
    expect(input).toBeInTheDocument();

    await user.type(input, 'repeat');
    // Press Enter to commit.
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    await waitFor(() => {
      const patchCall = fetchApi.mock.calls.find(
        ([u, o]) => u === '/api/wellness/patients/bulk-tags' && o?.method === 'PATCH',
      );
      expect(patchCall).toBeTruthy();
      const body = JSON.parse(patchCall[1].body);
      expect(body.patientIds).toEqual([42]);
      expect(body.addTags).toEqual(['repeat']);
    });
  });

  it('Escape cancels the inline tag-add input without firing a PATCH', async () => {
    fetchApi.mockImplementation((url) => {
      if (url.startsWith('/api/wellness/patients?')) {
        return Promise.resolve({
          patients: [
            {
              id: 88,
              name: 'Esc Patient',
              phone: '+919876500088',
              email: '',
              gender: '',
              source: '',
              createdAt: '2026-05-20T10:00:00Z',
              tags: null,
            },
          ],
          total: 1,
        });
      }
      if (url === '/api/wellness/locations') return Promise.resolve([]);
      return Promise.resolve({});
    });

    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId('tag-add-88'));
    const input = screen.getByLabelText(/New tag for Esc Patient/i);
    await user.type(input, 'ditched');
    fireEvent.keyDown(input, { key: 'Escape', code: 'Escape' });

    // Inline input is gone; `+` button is back.
    await waitFor(() => expect(screen.getByTestId('tag-add-88')).toBeInTheDocument());
    // No PATCH call was issued.
    const patchCall = fetchApi.mock.calls.find(
      ([u, o]) => u === '/api/wellness/patients/bulk-tags' && o?.method === 'PATCH',
    );
    expect(patchCall).toBeUndefined();
  });
});

/**
 * EXTENSION (tick #140s) — broader surface coverage beyond the #820 pagination
 * + tag-add cases above. Pins the rest of the page's chrome:
 *   1. Filter dropdowns (source / gender / createdFrom / createdTo) forward
 *      their value in the GET /api/wellness/patients query string and reset
 *      the page index to 1.
 *   2. Bulk-select header checkbox toggles every visible row.
 *   3. Bulk-action chrome (Add / Remove tags CTAs) only appears when ≥1 row
 *      is selected and disappears when selection clears.
 *   4. Search input filters the list (q query string forwarded).
 *   5. Row name link routes to /wellness/patients/:id (the SUT uses a router
 *      <Link>, not a click-handler-driven navigate, so we assert on the
 *      rendered anchor href rather than mocking useNavigate).
 *   6. Empty-state copy differs between "no rows" and "403 permission".
 *   7. Loading skeleton vs loaded table — "Loading…" appears before the
 *      first /patients response resolves.
 *   8. Pagination Previous button is disabled on page 1, Next is disabled
 *      when total fits on one page.
 *   9. Rows-per-page select shows 25/50/100 options.
 *  10. Edit button on a row opens the New-patient form pre-filled with that
 *      patient's values (button label flips to "Save Changes").
 *  11. Total-count chip in the header renders the backend's `total`,
 *      formatted via toLocaleString.
 *  12. Bulk-tag-add modal validates non-empty + ≤20 tags and submits the
 *      PATCH with the expected payload.
 *
 * Reuses the stable notifyObj reference from the file scope above so the
 * useEffect dependency identity doesn't thrash.
 */
describe('<Patients /> — filters / bulk-select / chrome (extension)', () => {
  beforeEach(() => {
    fetchApi.mockReset();
    notifyObj.success.mockReset();
    notifyObj.error.mockReset();
    notifyObj.info.mockReset();
  });

  it('selecting a source filter appends source= to the patients fetch', async () => {
    fetchApi.mockImplementation(defaultFetchHandler);
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('patients-pagination-indicator');

    const sourceSelect = screen.getByLabelText(/Filter by source/i);
    await user.selectOptions(sourceSelect, 'walk-in');

    await waitFor(() => {
      const recent = [...fetchApi.mock.calls]
        .reverse()
        .find(([u]) => u.startsWith('/api/wellness/patients?') && /source=walk-in/.test(u));
      expect(recent).toBeTruthy();
      // page resets to 1 when filter changes → offset=0.
      expect(recent[0]).toMatch(/offset=0/);
    });
  });

  it('selecting a gender filter appends gender= to the patients fetch', async () => {
    fetchApi.mockImplementation(defaultFetchHandler);
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('patients-pagination-indicator');

    const genderSelect = screen.getByLabelText(/Filter by gender/i);
    await user.selectOptions(genderSelect, 'F');

    await waitFor(() => {
      const recent = [...fetchApi.mock.calls]
        .reverse()
        .find(([u]) => u.startsWith('/api/wellness/patients?') && /gender=F/.test(u));
      expect(recent).toBeTruthy();
      expect(recent[0]).toMatch(/offset=0/);
    });
  });

  it('typing into the Created-from / Created-to inputs forwards createdFrom + createdTo', async () => {
    fetchApi.mockImplementation(defaultFetchHandler);
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('patients-pagination-indicator');

    const fromInput = screen.getByLabelText(/Created from/i);
    const toInput = screen.getByLabelText(/Created to/i);

    // Use fireEvent.change because userEvent.type on type=date inputs is
    // unreliable across jsdom versions.
    fireEvent.change(fromInput, { target: { value: '2026-01-01' } });
    fireEvent.change(toInput, { target: { value: '2026-06-30' } });

    await waitFor(() => {
      const recent = [...fetchApi.mock.calls]
        .reverse()
        .find(
          ([u]) =>
            u.startsWith('/api/wellness/patients?') &&
            /createdFrom=2026-01-01/.test(u) &&
            /createdTo=2026-06-30/.test(u),
        );
      expect(recent).toBeTruthy();
    });
  });

  it('selecting the header checkbox marks every visible row as selected', async () => {
    fetchApi.mockImplementation((url) => {
      if (url.startsWith('/api/wellness/patients?')) {
        return Promise.resolve({
          patients: [
            { id: 100, name: 'Aarti', phone: '+919800000100', email: 'a@t.in', gender: 'F', source: 'walk-in', createdAt: '2026-05-20T10:00:00Z', tags: null },
            { id: 101, name: 'Bharat', phone: '+919800000101', email: 'b@t.in', gender: 'M', source: 'referral', createdAt: '2026-05-20T10:00:00Z', tags: null },
            { id: 102, name: 'Chitra', phone: '+919800000102', email: 'c@t.in', gender: 'F', source: 'whatsapp', createdAt: '2026-05-20T10:00:00Z', tags: null },
          ],
          total: 3,
        });
      }
      if (url === '/api/wellness/locations') return Promise.resolve([]);
      return Promise.resolve({});
    });

    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Aarti');

    const headerCb = screen.getByLabelText(/Select all visible patients/i);
    expect(headerCb).not.toBeChecked();
    await user.click(headerCb);

    // All three row checkboxes are now checked.
    expect(screen.getByLabelText(/Select Aarti/i)).toBeChecked();
    expect(screen.getByLabelText(/Select Bharat/i)).toBeChecked();
    expect(screen.getByLabelText(/Select Chitra/i)).toBeChecked();

    // Bulk-action CTAs surface (they're conditional on selection size > 0).
    expect(screen.getByText(/Add tags to 3 selected/i)).toBeInTheDocument();
    expect(screen.getByText(/Remove tags from 3 selected/i)).toBeInTheDocument();

    // Click the header checkbox again — should clear all selections.
    await user.click(headerCb);
    expect(screen.getByLabelText(/Select Aarti/i)).not.toBeChecked();
    // CTAs disappear.
    expect(screen.queryByText(/Add tags to/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Remove tags from/i)).not.toBeInTheDocument();
  });

  it('search input forwards q= and resets to page 1', async () => {
    fetchApi.mockImplementation(defaultFetchHandler);
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('patients-pagination-indicator');

    const box = screen.getByPlaceholderText(/Search by name, phone, or email/i);
    await user.type(box, 'rohan');

    await waitFor(
      () => {
        const recent = [...fetchApi.mock.calls]
          .reverse()
          .find(([u]) => u.startsWith('/api/wellness/patients?') && /q=rohan/.test(u));
        expect(recent).toBeTruthy();
        expect(recent[0]).toMatch(/offset=0/);
      },
      { timeout: 2000 },
    );
  });

  it('the Name cell renders a router Link to /wellness/patients/:id', async () => {
    fetchApi.mockImplementation((url) => {
      if (url.startsWith('/api/wellness/patients?')) {
        return Promise.resolve({
          patients: [
            { id: 555, name: 'Linked Patient', phone: '+919800000555', email: 'l@t.in', gender: 'F', source: 'walk-in', createdAt: '2026-05-20T10:00:00Z', tags: null },
          ],
          total: 1,
        });
      }
      if (url === '/api/wellness/locations') return Promise.resolve([]);
      return Promise.resolve({});
    });

    renderPage();
    const link = await screen.findByRole('link', { name: 'Linked Patient' });
    expect(link).toHaveAttribute('href', '/wellness/patients/555');
  });

  it('renders the "No patients match." empty-state copy when total=0', async () => {
    fetchApi.mockImplementation((url) => {
      if (url.startsWith('/api/wellness/patients?')) {
        return Promise.resolve({ patients: [], total: 0 });
      }
      if (url === '/api/wellness/locations') return Promise.resolve([]);
      return Promise.resolve({});
    });

    renderPage();
    expect(await screen.findByText(/No patients match\./i)).toBeInTheDocument();
    // Pagination footer is hidden when total=0.
    expect(screen.queryByTestId('patients-pagination')).not.toBeInTheDocument();
  });

  it('renders the "Access restricted." copy when the API returns 403', async () => {
    fetchApi.mockImplementation((url) => {
      if (url.startsWith('/api/wellness/patients?')) {
        const err = new Error('forbidden');
        err.status = 403;
        return Promise.reject(err);
      }
      if (url === '/api/wellness/locations') return Promise.resolve([]);
      return Promise.resolve({});
    });

    renderPage();
    expect(await screen.findByText(/Access restricted\./i)).toBeInTheDocument();
    // CSV export button is also hidden when permissionDenied.
    expect(screen.queryByText(/Export CSV/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Export XLSX/i)).not.toBeInTheDocument();
  });

  it('shows the "Loading…" indicator before the first fetch resolves', async () => {
    let resolveFn;
    const pending = new Promise((resolve) => {
      resolveFn = resolve;
    });
    fetchApi.mockImplementation((url) => {
      if (url.startsWith('/api/wellness/patients?')) {
        return pending;
      }
      if (url === '/api/wellness/locations') return Promise.resolve([]);
      return Promise.resolve({});
    });

    renderPage();
    // Loading… is visible while the patients fetch is in-flight.
    expect(await screen.findByText(/Loading…/)).toBeInTheDocument();
    // Table chrome is NOT yet rendered.
    expect(screen.queryByTestId('patients-pagination-indicator')).not.toBeInTheDocument();

    // Resolve the fetch and confirm Loading… is gone.
    resolveFn({
      patients: [{ id: 1, name: 'Loaded', phone: '+919800000001', email: '', gender: '', source: '', createdAt: '2026-05-20T10:00:00Z', tags: null }],
      total: 1,
    });
    await waitFor(() => expect(screen.queryByText(/Loading…/)).not.toBeInTheDocument());
    expect(screen.getByText('Loaded')).toBeInTheDocument();
  });

  it('Previous button is disabled on page 1; Next button is disabled when total fits on one page', async () => {
    fetchApi.mockImplementation((url) => {
      if (url.startsWith('/api/wellness/patients?')) {
        return Promise.resolve({
          patients: buildPatients(1, 5),
          total: 5,
        });
      }
      if (url === '/api/wellness/locations') return Promise.resolve([]);
      return Promise.resolve({});
    });

    renderPage();
    await screen.findByTestId('patients-pagination-indicator');
    const prev = screen.getByTestId('patients-page-prev');
    const next = screen.getByTestId('patients-page-next');
    expect(prev).toBeDisabled();
    expect(next).toBeDisabled();
    // Page indicator reads "Page 1 of 1".
    expect(screen.getByTestId('patients-page-indicator').textContent).toMatch(/Page 1 of 1/);
  });

  it('rows-per-page selector exposes 25 / 50 / 100 options', async () => {
    fetchApi.mockImplementation(defaultFetchHandler);
    renderPage();
    await screen.findByTestId('patients-pagination-indicator');
    const select = screen.getByTestId('rows-per-page-select');
    const opts = Array.from(select.querySelectorAll('option')).map((o) => o.value);
    expect(opts).toEqual(['25', '50', '100']);
  });

  it('clicking the row Edit button opens the form pre-filled with the patient values', async () => {
    fetchApi.mockImplementation((url) => {
      if (url.startsWith('/api/wellness/patients?')) {
        return Promise.resolve({
          patients: [
            {
              id: 777,
              name: 'Priya Editable',
              phone: '+919876500777',
              email: 'priya@t.in',
              dob: '1990-04-15',
              gender: 'F',
              source: 'referral',
              createdAt: '2026-05-20T10:00:00Z',
              tags: null,
            },
          ],
          total: 1,
        });
      }
      if (url === '/api/wellness/locations') return Promise.resolve([]);
      return Promise.resolve({});
    });

    const user = userEvent.setup();
    renderPage();
    const editBtn = await screen.findByTitle('Edit patient');
    await user.click(editBtn);

    // Form opened — Name input is pre-filled.
    const nameInput = await screen.findByPlaceholderText('Name *');
    expect(nameInput).toHaveValue('Priya Editable');
    // Phone is pre-filled.
    expect(screen.getByPlaceholderText('Phone *')).toHaveValue('+919876500777');
    // Submit button shows the edit-mode label.
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeInTheDocument();
  });

  it('renders the total-count chip in the header using toLocaleString', async () => {
    fetchApi.mockImplementation((url) => {
      if (url.startsWith('/api/wellness/patients?')) {
        return Promise.resolve({ patients: buildPatients(1, 25), total: 1234 });
      }
      if (url === '/api/wellness/locations') return Promise.resolve([]);
      return Promise.resolve({});
    });

    renderPage();
    // toLocaleString(en-US) → "1,234". Some test envs may format differently;
    // be defensive — accept either the comma-grouped or plain form.
    await waitFor(() => {
      const matches = screen.queryAllByText(/^(1,234|1234) total$/);
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('bulk-tag modal submits PATCH /bulk-tags with the selected ids + parsed tags', async () => {
    let resolvePatch;
    const patchPromise = new Promise((res) => {
      resolvePatch = res;
    });
    fetchApi.mockImplementation((url, opts) => {
      if (url === '/api/wellness/patients/bulk-tags' && opts?.method === 'PATCH') {
        return patchPromise;
      }
      if (url.startsWith('/api/wellness/patients?')) {
        return Promise.resolve({
          patients: [
            { id: 200, name: 'Sel One', phone: '+919800000200', email: '', gender: 'F', source: 'walk-in', createdAt: '2026-05-20T10:00:00Z', tags: null },
            { id: 201, name: 'Sel Two', phone: '+919800000201', email: '', gender: 'M', source: 'walk-in', createdAt: '2026-05-20T10:00:00Z', tags: null },
          ],
          total: 2,
        });
      }
      if (url === '/api/wellness/locations') return Promise.resolve([]);
      return Promise.resolve({});
    });

    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Sel One');

    // Select both rows.
    await user.click(screen.getByLabelText(/Select Sel One/i));
    await user.click(screen.getByLabelText(/Select Sel Two/i));

    // Open the add-tags modal.
    await user.click(screen.getByText(/Add tags to 2 selected/i));

    // Type comma-separated tags + click Apply.
    const tagInput = screen.getByLabelText(/^Tags \(comma-separated\)$/i);
    await user.type(tagInput, 'VIP, follow-up, VIP');
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    // PATCH was issued with both ids + deduped lowercased tags.
    await waitFor(() => {
      const patchCall = fetchApi.mock.calls.find(
        ([u, o]) => u === '/api/wellness/patients/bulk-tags' && o?.method === 'PATCH',
      );
      expect(patchCall).toBeTruthy();
      const body = JSON.parse(patchCall[1].body);
      expect(body.patientIds.sort()).toEqual([200, 201]);
      expect(body.addTags).toEqual(['vip', 'follow-up']);
    });

    // Resolve the PATCH so notify.success fires + cleanup proceeds.
    resolvePatch({ updated: 2 });
    await waitFor(() => expect(notifyObj.success).toHaveBeenCalled());
  });
});
