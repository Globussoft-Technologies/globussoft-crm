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
