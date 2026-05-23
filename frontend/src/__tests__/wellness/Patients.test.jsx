/**
 * wellness/Patients.test.jsx — vitest + RTL coverage for the wellness master
 * patient-list page (daily-use surface for clinic staff).
 *
 * Scope: pins the page-surface invariants for the search-driven patient
 * roster — initial mount fetch, debounced search → server query, total
 * counter, empty/loading states, and the New-patient form open/close.
 *
 *   1. Page renders heading "Patients" + total counter (from /api/wellness/
 *      patients .total field) + "New patient" toggle button.
 *   2. Initial mount fires /api/wellness/patients with NO ?q= param (full
 *      list) — the debounced effect's first-mount short-circuit pins #331.
 *   3. Renders one row per patient with name (as a link to detail),
 *      phone, email, gender, source, and an edit button.
 *   4. Empty-state row "No patients match." renders when /api/wellness/
 *      patients returns { patients: [], total: 0 }.
 *   5. Typing in the search box debounces a /api/wellness/patients?q=…
 *      fetch after SEARCH_DEBOUNCE_MS (300ms). Use fake timers + advance
 *      to deterministically pin the debounce.
 *   6. Clicking "New patient" opens the create form; the form renders
 *      Name + Phone inputs.
 *   7. Submitting the New-patient form with an invalid Indian mobile
 *      surfaces notify.error("valid Indian mobile…") and does NOT POST.
 *   8. Loading state: "Loading…" message renders while the initial fetch
 *      is in-flight.
 *
 * Drift note: patient row-action / detail-page contracts are pinned by
 * PatientDetail.test.jsx. This file covers the roster page chrome +
 * search debounce + create-form validation.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
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

function defaultFetchMock(url, opts) {
  if (url.startsWith('/api/wellness/patients') && (!opts || !opts.method || opts.method === 'GET')) {
    return Promise.resolve({ patients: samplePatients, total: 2 });
  }
  if (url === '/api/wellness/locations') return Promise.resolve(sampleLocations);
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
    // jsdom doesn't implement scrollIntoView; the Patients page calls it
    // inside a useEffect when the New-patient form opens. Stub a no-op so
    // the effect doesn't throw and unmount the component.
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = vi.fn();
    }
  });

  it('renders the heading + total counter + New patient toggle', async () => {
    renderPatients();
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Patients/i })).toBeInTheDocument();
    });
    // Total counter from /api/wellness/patients's .total field — "2 total".
    // Async findByText: data-dependent text appears AFTER the mock fetch
    // resolves; synchronous getByText is a CI-only race (fast locally, slow
    // under shard load).
    expect(await screen.findByText(/2 total/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New patient/i })).toBeInTheDocument();
  });

  it('initial mount fetches /api/wellness/patients with NO ?q= (full list)', async () => {
    renderPatients();
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith('/api/wellness/patients');
    });
  });

  it('renders one row per patient with name (link), phone, email, gender, source', async () => {
    renderPatients();
    await waitFor(() => expect(screen.getByText('Anita Sharma')).toBeInTheDocument());
    expect(screen.getByText('Rohit Verma')).toBeInTheDocument();
    // Phone + email render inline.
    expect(screen.getByText('+919876543210')).toBeInTheDocument();
    expect(screen.getByText('anita@example.com')).toBeInTheDocument();
    // Gender renders the raw value ("F" / "M").
    expect(screen.getByText('F')).toBeInTheDocument();
    expect(screen.getByText('M')).toBeInTheDocument();
    // Source values render in row cells; also appear in <option> tags but
    // those are inside the closed New-patient form (showAdd=false). Just
    // assert at least one occurrence.
    expect(screen.getAllByText('walk-in').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('referral').length).toBeGreaterThanOrEqual(1);

    // Name is a Link to /wellness/patients/<id>.
    const link = screen.getByRole('link', { name: 'Anita Sharma' });
    expect(link.getAttribute('href')).toBe('/wellness/patients/1');
  });

  it('renders "No patients match." when /api/wellness/patients returns []', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/wellness/patients')) {
        return Promise.resolve({ patients: [], total: 0 });
      }
      if (url === '/api/wellness/locations') return Promise.resolve([]);
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
        expect(fetchApiMock).toHaveBeenCalledWith('/api/wellness/patients');
      });
      fetchApiMock.mockClear();

      // Type "anita" — this changes q which schedules a 300ms debounced load.
      const searchBox = screen.getByPlaceholderText(/Search by name, phone, or email/i);
      fireEvent.change(searchBox, { target: { value: 'anita' } });

      // Before timer fires, no fetch yet.
      expect(
        fetchApiMock.mock.calls.find(([u]) => u.includes('q=anita'))
      ).toBeUndefined();

      // Advance past the debounce window.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(350);
      });

      // The debounced fetch fires with the encoded q.
      const queriedCall = fetchApiMock.mock.calls.find(([u]) =>
        u.includes('/api/wellness/patients?q=anita')
      );
      expect(queriedCall).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clicking "New patient" toggles the create form open with Name + Phone inputs', async () => {
    renderPatients();
    await waitFor(() => expect(screen.getByText('Anita Sharma')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /New patient/i }));

    // Form renders Name + Phone inputs.
    expect(screen.getByPlaceholderText(/Name \*/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Phone \*/)).toBeInTheDocument();
    // Save button renders.
    expect(screen.getByRole('button', { name: /^Save$/ })).toBeInTheDocument();
  });

  it('submitting the form with an invalid Indian mobile triggers an error toast and does NOT POST', async () => {
    renderPatients();
    await waitFor(() => expect(screen.getByText('Anita Sharma')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /New patient/i }));

    // Fill name + a clearly invalid phone (starts with "1", not 6-9).
    fireEvent.change(screen.getByPlaceholderText(/Name \*/), {
      target: { value: 'Test Patient' },
    });
    fireEvent.change(screen.getByPlaceholderText(/Phone \*/), {
      target: { value: '1234567890' },
    });

    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));

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
      if (url.startsWith('/api/wellness/patients')) {
        return new Promise((r) => { resolvePatients = r; });
      }
      if (url === '/api/wellness/locations') return Promise.resolve([]);
      return Promise.resolve(null);
    });
    renderPatients();
    // While the patients fetch is in-flight, "Loading…" renders.
    expect(await screen.findByText(/Loading…/i)).toBeInTheDocument();
    // Resolve so the test cleanly tears down.
    resolvePatients({ patients: [], total: 0 });
  });
});
