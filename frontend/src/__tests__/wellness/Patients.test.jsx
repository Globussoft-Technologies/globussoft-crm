/**
 * wellness/Patients.test.jsx — vitest + RTL coverage for the wellness master
 * patient-list page (daily-use surface for clinic staff).
 *
 * Scope: pins the page-surface invariants for the search-driven patient
 * roster — initial mount fetch, debounced search → server query, total
 * counter, empty/loading states, and the "+ Add → New patient" modal.
 *
 *   1. Page renders heading "Patients" + total counter (from /api/wellness/
 *      patients .total field) + "+ Add" dropdown trigger.
 *   2. Initial mount fires GET /api/wellness/patients with paging params and
 *      NO ?q= param (full list) — the debounced effect's first-mount
 *      short-circuit pins #331.
 *   3. Renders one row per patient with name (as a link to detail),
 *      phone, email, gender, source.
 *   4. Empty-state row "No patients match." renders when /api/wellness/
 *      patients returns { patients: [], total: 0 }.
 *   5. Typing in the search box debounces a /api/wellness/patients?q=…
 *      fetch after SEARCH_DEBOUNCE_MS (300ms). Use fake timers + advance
 *      to deterministically pin the debounce.
 *   6. Clicking "Add" → "New patient" opens the create modal with Full
 *      name + Phone number inputs.
 *   7. Submitting the modal with an invalid Indian mobile surfaces
 *      notify.error("valid Indian mobile…") and does NOT POST.
 *   8. Loading state: "Loading…" message renders while the initial fetch
 *      is in-flight.
 *
 * Drift note: patient row-action / detail-page contracts are pinned by
 * PatientDetail.test.jsx. This file covers the roster page chrome +
 * search debounce + modal-create validation.
 *
 * The roster was rewritten (commit 2bbcde7) to use URL-driven filters,
 * a "+ Add" dropdown, and a portaled PatientCreateModal — assertions
 * below target that surface, not the prior inline-form layout.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  // The new Patients page imports getAuthToken alongside fetchApi for the
  // export-download path (signed fetch). Stub it so the import resolves.
  getAuthToken: () => 'test-token',
}));

const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyObj = {
  error: notifyError,
  info: vi.fn(),
  success: notifySuccess,
  confirm: () => Promise.resolve(true),
};
vi.mock('../../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

vi.mock('../../utils/date', () => ({
  formatDate: (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—'),
}));

import Patients from '../../pages/wellness/Patients';

const samplePatients = [
  {
    id: 1,
    name: 'Anita Sharma',
    phone: '+919876543210',
    email: 'anita@example.com',
    gender: 'F',
    source: 'walk-in',
    createdAt: '2026-04-01T10:00:00.000Z',
  },
  {
    id: 2,
    name: 'Rohit Verma',
    phone: '+919812345678',
    email: 'rohit@example.com',
    gender: 'M',
    source: 'referral',
    createdAt: '2026-04-15T10:00:00.000Z',
  },
];

const sampleLocations = [{ id: 1, name: 'Main Clinic' }];

// Match list-fetch URLs (with query params) but NOT the tag sub-route.
const isPatientListUrl = (url) =>
  typeof url === 'string'
    && url.startsWith('/api/wellness/patients')
    && !url.startsWith('/api/wellness/patients/tags');

function defaultFetchMock(url, opts) {
  if (isPatientListUrl(url) && (!opts || !opts.method || opts.method === 'GET')) {
    return Promise.resolve({ patients: samplePatients, total: 2 });
  }
  if (url === '/api/wellness/locations') return Promise.resolve(sampleLocations);
  if (url === '/api/wellness/patients/tags') return Promise.resolve({ tags: [] });
  return Promise.resolve(null);
}

function renderPatients() {
  return render(
    <MemoryRouter>
      <Patients />
    </MemoryRouter>
  );
}

describe('<wellness/Patients /> — page surface', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation(defaultFetchMock);
    notifyError.mockReset();
    notifySuccess.mockReset();
    // jsdom doesn't implement scrollIntoView; harmless stub so any code path
    // that uses it (legacy or future) doesn't blow up the render.
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = vi.fn();
    }
  });

  it('renders the heading + total counter + "+ Add" trigger', async () => {
    renderPatients();
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Patients/i })).toBeInTheDocument();
    });
    // Total counter from /api/wellness/patients's .total field — "2 total".
    expect(screen.getByText(/2 total/i)).toBeInTheDocument();
    // The "+ Add" dropdown trigger replaces the prior "New patient" inline
    // toggle. It's a button with aria-haspopup=menu.
    expect(screen.getByRole('button', { name: /Add/i, expanded: false })).toBeInTheDocument();
  });

  it('initial mount fetches /api/wellness/patients with NO ?q= (full list)', async () => {
    renderPatients();
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u]) => isPatientListUrl(u));
      expect(call).toBeTruthy();
      // The initial mount URL has no search term. Paging is handled
      // client-side (PAGE_SIZE = 20) — the URL stays bare on first load.
      expect(call[0]).not.toMatch(/[?&]q=/);
    });
  });

  it('renders one row per patient with name (link), phone, email, gender, source', async () => {
    renderPatients();
    await waitFor(() => expect(screen.getByText('Anita Sharma')).toBeInTheDocument());
    expect(screen.getByText('Rohit Verma')).toBeInTheDocument();
    // Phone + email render inline next to an icon; RTL's getByText
    // normalises the surrounding whitespace so a substring match on the
    // value still resolves to the single text node inside the cell <span>.
    expect(screen.getByText('+919876543210', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('anita@example.com', { exact: false })).toBeInTheDocument();
    // Gender column renders the raw value ("F" / "M").
    expect(screen.getByText('F')).toBeInTheDocument();
    expect(screen.getByText('M')).toBeInTheDocument();
    // Source values render in row cells.
    expect(screen.getAllByText('walk-in').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('referral').length).toBeGreaterThanOrEqual(1);

    // Name is a Link to /wellness/patients/<id>.
    const link = screen.getByRole('link', { name: 'Anita Sharma' });
    expect(link.getAttribute('href')).toBe('/wellness/patients/1');
  });

  it('renders "No patients match." when /api/wellness/patients returns []', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (isPatientListUrl(url)) {
        return Promise.resolve({ patients: [], total: 0 });
      }
      if (url === '/api/wellness/locations') return Promise.resolve([]);
      if (url === '/api/wellness/patients/tags') return Promise.resolve({ tags: [] });
      return Promise.resolve(null);
    });
    renderPatients();
    await waitFor(() => {
      expect(screen.getByText(/No patients match\./i)).toBeInTheDocument();
    });
  });

  it('typing in the search box debounces a ?q= fetch after 300ms', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderPatients();
      // Wait for the initial mount fetch to settle.
      await waitFor(() => {
        const call = fetchApiMock.mock.calls.find(([u]) => isPatientListUrl(u));
        expect(call).toBeTruthy();
      });
      fetchApiMock.mockClear();
      fetchApiMock.mockImplementation(defaultFetchMock);

      // Type "anita" — this changes q which schedules a 300ms debounced load.
      const searchBox = screen.getByPlaceholderText(/Search by name, phone, or email/i);
      fireEvent.change(searchBox, { target: { value: 'anita' } });

      // Before the timer fires, no q= fetch yet.
      expect(
        fetchApiMock.mock.calls.find(([u]) => typeof u === 'string' && u.includes('q=anita'))
      ).toBeUndefined();

      // Advance past the debounce window.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(350);
      });

      // The debounced fetch fires with the encoded q.
      const queriedCall = fetchApiMock.mock.calls.find(([u]) =>
        typeof u === 'string' && u.startsWith('/api/wellness/patients?') && u.includes('q=anita')
      );
      expect(queriedCall).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clicking "Add" → "New patient" opens the create modal with Full name + Phone inputs', async () => {
    renderPatients();
    await waitFor(() => expect(screen.getByText('Anita Sharma')).toBeInTheDocument());

    // Open the "+ Add" dropdown and pick "New patient".
    fireEvent.click(screen.getByRole('button', { name: /Add/i, expanded: false }));
    fireEvent.click(screen.getByRole('menuitem', { name: /New patient/i }));

    // Modal renders as a dialog with the "Create customer" title.
    const dialog = await screen.findByRole('dialog', { name: /Create customer/i });
    // Full name + Phone number inputs (FormField wraps each in an implicit
    // <label> with the field name as its text).
    expect(within(dialog).getByLabelText(/Full name/i)).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/Phone number/i)).toBeInTheDocument();
    // Primary CTA reads "Add customer" (renamed from the legacy "Save").
    expect(within(dialog).getByRole('button', { name: /Add customer/i })).toBeInTheDocument();
  });

  it('submitting the modal with an invalid Indian mobile triggers an error toast and does NOT POST', async () => {
    renderPatients();
    await waitFor(() => expect(screen.getByText('Anita Sharma')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Add/i, expanded: false }));
    fireEvent.click(screen.getByRole('menuitem', { name: /New patient/i }));

    const dialog = await screen.findByRole('dialog', { name: /Create customer/i });

    // Fill name + a clearly invalid phone (starts with "1", not 6-9).
    fireEvent.change(within(dialog).getByLabelText(/Full name/i), {
      target: { value: 'Test Patient' },
    });
    fireEvent.change(within(dialog).getByLabelText(/Phone number/i), {
      target: { value: '1234567890' },
    });

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetchMock);

    fireEvent.click(within(dialog).getByRole('button', { name: /Add customer/i }));

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/valid Indian mobile/i)
      );
    });
    // No POST fired.
    const postCall = fetchApiMock.mock.calls.find(([, opts]) => opts?.method === 'POST');
    expect(postCall).toBeUndefined();
  });

  it('shows "Loading…" before the initial fetch resolves', async () => {
    let resolvePatients;
    fetchApiMock.mockImplementation((url) => {
      if (isPatientListUrl(url)) {
        return new Promise((r) => { resolvePatients = r; });
      }
      if (url === '/api/wellness/locations') return Promise.resolve([]);
      if (url === '/api/wellness/patients/tags') return Promise.resolve({ tags: [] });
      return Promise.resolve(null);
    });
    renderPatients();
    // While the patients fetch is in-flight, "Loading…" renders.
    expect(await screen.findByText(/Loading…/i)).toBeInTheDocument();
    // Resolve so the test cleanly tears down.
    resolvePatients({ patients: [], total: 0 });
  });
});
