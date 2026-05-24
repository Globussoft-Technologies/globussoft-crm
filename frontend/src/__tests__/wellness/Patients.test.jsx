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
  // tick #188 — XLSX export uses raw fetch + getAuthToken (separate from
  // fetchApi). Mock the helper so the export click doesn't TypeError on
  // `getAuthToken is not a function` under the module-mock that previously
  // only exposed fetchApi.
  getAuthToken: () => 'fake-token',
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
    // #820 Part 1 (tick #185 dd67f1a0) — initial mount now passes limit + offset
    // every call. Assert NO q= param but ALLOW limit/offset query string.
    await waitFor(() => {
      const initialCall = fetchApiMock.mock.calls.find(([u]) =>
        typeof u === 'string'
        && u.startsWith('/api/wellness/patients?')
        && !u.includes('q=')
        && !u.includes('.csv')
        && !u.includes('/bulk-tags')
      );
      expect(initialCall).toBeTruthy();
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
      // #820 Part 1 (tick #185 dd67f1a0) — initial mount passes limit + offset.
      await waitFor(() => {
        const initialCall = fetchApiMock.mock.calls.find(([u]) =>
          typeof u === 'string'
          && u.startsWith('/api/wellness/patients?')
          && !u.includes('q=')
          && !u.includes('.csv')
          && !u.includes('/bulk-tags')
        );
        expect(initialCall).toBeTruthy();
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

  // #820 (tick #192) — list-filter dropdowns. Pins the source / gender /
  // createdFrom / createdTo controls and their fetch-forwarding contract.
  // Backend filters shipped tick #191 (`4fa87b0a`, `applyPatientListFilters`
  // helper at backend/routes/wellness.js:208). Four invariants here:
  //   1. Source select renders with the vocab from the New-patient form
  //      (single source of truth — `walk-in`, `referral`, `whatsapp`, etc.)
  //      and changing it issues a fetch carrying `?source=…`.
  //   2. Gender select renders with F / M / O options and changing it
  //      issues a fetch carrying `?gender=F` (matches backend's case-
  //      normalized accepted set).
  //   3. Date-from + date-to inputs render with aria-labels "Created from"
  //      and "Created to" and setting both fires a single fetch with both
  //      params encoded.
  //   4. Changing a filter resets the page to 1 (mirrors the existing
  //      search-input + rowsPerPage reset shape). Verified by the offset=0
  //      param on the post-change fetch.
  describe('#820 list filters (tick #192)', () => {
    it('Source select renders + changing fires a fetch with ?source=walk-in', async () => {
      renderPatients();
      await waitFor(() => expect(screen.getByText('Anita Sharma')).toBeInTheDocument());
      const sourceSel = screen.getByLabelText(/Filter by source/i);
      // Vocab matches the New-patient form's <option> set.
      expect(sourceSel).toBeInTheDocument();
      const options = Array.from(sourceSel.querySelectorAll('option')).map((o) => o.value);
      expect(options).toEqual([
        '', 'walk-in', 'referral', 'website-form', 'whatsapp',
        'instagram', 'meta-ad', 'google-ad', 'indiamart',
      ]);

      fetchApiMock.mockClear();
      fireEvent.change(sourceSel, { target: { value: 'walk-in' } });

      await waitFor(() => {
        const filteredCall = fetchApiMock.mock.calls.find(([u]) =>
          typeof u === 'string'
          && u.startsWith('/api/wellness/patients?')
          && u.includes('source=walk-in')
        );
        expect(filteredCall).toBeTruthy();
      });
    });

    it('Gender select renders with F/M/O and changing fires a fetch with ?gender=F', async () => {
      renderPatients();
      await waitFor(() => expect(screen.getByText('Anita Sharma')).toBeInTheDocument());
      const genderSel = screen.getByLabelText(/Filter by gender/i);
      const values = Array.from(genderSel.querySelectorAll('option')).map((o) => o.value);
      expect(values).toEqual(['', 'F', 'M', 'O']);

      fetchApiMock.mockClear();
      fireEvent.change(genderSel, { target: { value: 'F' } });

      await waitFor(() => {
        const filteredCall = fetchApiMock.mock.calls.find(([u]) =>
          typeof u === 'string'
          && u.startsWith('/api/wellness/patients?')
          && u.includes('gender=F')
        );
        expect(filteredCall).toBeTruthy();
      });
    });

    it('Date-from + date-to render and setting both fires a fetch carrying both params', async () => {
      renderPatients();
      await waitFor(() => expect(screen.getByText('Anita Sharma')).toBeInTheDocument());

      const fromInput = screen.getByLabelText(/Created from/i);
      const toInput = screen.getByLabelText(/Created to/i);
      expect(fromInput).toBeInTheDocument();
      expect(toInput).toBeInTheDocument();

      fetchApiMock.mockClear();
      fireEvent.change(fromInput, { target: { value: '2026-01-01' } });
      fireEvent.change(toInput, { target: { value: '2026-03-31' } });

      // Both date filters share the SEARCH_DEBOUNCE_MS debounce, so the
      // last-typed value's debounced fire must include both params (state
      // for both has already been set by the time the timer runs).
      await waitFor(() => {
        const filteredCall = fetchApiMock.mock.calls.find(([u]) =>
          typeof u === 'string'
          && u.startsWith('/api/wellness/patients?')
          && u.includes('createdFrom=2026-01-01')
          && u.includes('createdTo=2026-03-31')
        );
        expect(filteredCall).toBeTruthy();
      });
    });

    it('changing a filter resets pagination to page 1 (offset=0)', async () => {
      // Seed a larger dataset so page-2 actually exists.
      fetchApiMock.mockImplementation((url, opts) => {
        if (url.startsWith('/api/wellness/patients') && (!opts || !opts.method || opts.method === 'GET')) {
          return Promise.resolve({ patients: samplePatients, total: 200 });
        }
        if (url === '/api/wellness/locations') return Promise.resolve(sampleLocations);
        return Promise.resolve(null);
      });
      renderPatients();
      await waitFor(() => expect(screen.getByText('Anita Sharma')).toBeInTheDocument());

      // Click Next to land on page 2 — the next fetch carries offset=25.
      fireEvent.click(screen.getByTestId('patients-page-next'));
      await waitFor(() => {
        const page2Call = fetchApiMock.mock.calls.find(([u]) =>
          typeof u === 'string' && u.includes('offset=25')
        );
        expect(page2Call).toBeTruthy();
      });

      // Now flip the gender filter — the post-change fetch MUST be offset=0.
      fetchApiMock.mockClear();
      fireEvent.change(screen.getByLabelText(/Filter by gender/i), { target: { value: 'M' } });

      await waitFor(() => {
        const resetCall = fetchApiMock.mock.calls.find(([u]) =>
          typeof u === 'string'
          && u.startsWith('/api/wellness/patients?')
          && u.includes('gender=M')
          && u.includes('offset=0')
        );
        expect(resetCall).toBeTruthy();
      });
    });
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

  // #931 — bulk-tag-add UI. Pins the row-checkbox + "Add tags to N selected"
  // CTA visibility + modal open + PATCH /api/wellness/patients/bulk-tags
  // body shape + success / error notify branches.
  describe('#931 bulk-tag-add', () => {
    it('CTA is hidden when no rows are selected', async () => {
      renderPatients();
      await waitFor(() => expect(screen.getByText('Anita Sharma')).toBeInTheDocument());
      expect(screen.queryByText(/Add tags to .* selected/i)).not.toBeInTheDocument();
    });

    it('checking a row reveals the "Add tags to N selected" CTA', async () => {
      renderPatients();
      await waitFor(() => expect(screen.getByText('Anita Sharma')).toBeInTheDocument());
      const anitaCheckbox = screen.getByRole('checkbox', { name: /Select Anita Sharma/i });
      fireEvent.click(anitaCheckbox);
      expect(screen.getByRole('button', { name: /Add tags to 1 selected/i })).toBeInTheDocument();
    });

    it('clicking the CTA opens the modal with a tags input', async () => {
      renderPatients();
      await waitFor(() => expect(screen.getByText('Anita Sharma')).toBeInTheDocument());
      fireEvent.click(screen.getByRole('checkbox', { name: /Select Anita Sharma/i }));
      fireEvent.click(screen.getByRole('button', { name: /Add tags to 1 selected/i }));
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByLabelText(/Tags \(comma-separated\)/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Apply/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Cancel/i })).toBeInTheDocument();
    });

    it('Apply fires PATCH /api/wellness/patients/bulk-tags with patientIds + addTags, closes modal, notifies success', async () => {
      fetchApiMock.mockImplementation((url, opts) => {
        if (url === '/api/wellness/patients/bulk-tags' && opts?.method === 'PATCH') {
          return Promise.resolve({ updated: 1 });
        }
        return defaultFetchMock(url, opts);
      });
      renderPatients();
      await waitFor(() => expect(screen.getByText('Anita Sharma')).toBeInTheDocument());
      fireEvent.click(screen.getByRole('checkbox', { name: /Select Anita Sharma/i }));
      fireEvent.click(screen.getByRole('button', { name: /Add tags to 1 selected/i }));

      // Type two tags with mixed case + leading/trailing whitespace + a dup
      // so we also pin the client-side trim/lowercase/dedupe shape.
      fireEvent.change(screen.getByLabelText(/Tags \(comma-separated\)/i), {
        target: { value: 'VIP, dermatology , vip' },
      });
      fireEvent.click(screen.getByRole('button', { name: /^Apply$/ }));

      await waitFor(() => {
        const call = fetchApiMock.mock.calls.find(
          ([u, o]) => u === '/api/wellness/patients/bulk-tags' && o?.method === 'PATCH'
        );
        expect(call).toBeTruthy();
        const body = JSON.parse(call[1].body);
        expect(body.patientIds).toEqual([1]);
        // Trim + lowercase + dedupe shape: VIP + vip collapse to "vip".
        expect(body.addTags).toEqual(['vip', 'dermatology']);
      });

      // Modal closes + success toast fires.
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
      expect(notifySuccess).toHaveBeenCalledWith(
        expect.stringMatching(/Added 2 tags to 1 patient/i),
      );
    });

    it('error response keeps the modal open and fires notify.error', async () => {
      fetchApiMock.mockImplementation((url, opts) => {
        if (url === '/api/wellness/patients/bulk-tags' && opts?.method === 'PATCH') {
          return Promise.reject(new Error('Bulk-tag service unavailable'));
        }
        return defaultFetchMock(url, opts);
      });
      renderPatients();
      await waitFor(() => expect(screen.getByText('Anita Sharma')).toBeInTheDocument());
      fireEvent.click(screen.getByRole('checkbox', { name: /Select Anita Sharma/i }));
      fireEvent.click(screen.getByRole('button', { name: /Add tags to 1 selected/i }));
      fireEvent.change(screen.getByLabelText(/Tags \(comma-separated\)/i), {
        target: { value: 'vip' },
      });
      fireEvent.click(screen.getByRole('button', { name: /^Apply$/ }));

      await waitFor(() => {
        expect(notifyError).toHaveBeenCalledWith(
          expect.stringMatching(/Bulk-tag service unavailable/i),
        );
      });
      // Modal stays open so the user can correct + retry.
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(notifySuccess).not.toHaveBeenCalled();
    });
  });

  // #820 (tick #188) — XLSX export button. Mirrors the CSV button surface;
  // pinned here because the backend xlsx endpoint shipped tick #187 (ed00be9b)
  // and the chrome is the same fetch+blob mechanic as CSV. Three load-bearing
  // invariants:
  //   1. Button renders + is clickable when not permission-denied + total > 0.
  //   2. Clicking issues fetch GET to /api/wellness/patients.xlsx and honors
  //      the active ?q= search filter.
  //   3. Both CSV + XLSX buttons disable while a download is in-flight so a
  //      double-click can't issue two concurrent downloads of the same
  //      snapshot.
  describe('#820 XLSX export (tick #188)', () => {
    let createObjectURLMock;
    let revokeObjectURLMock;
    let realFetch;
    let fetchMock;

    beforeEach(() => {
      // jsdom doesn't implement URL.createObjectURL / revokeObjectURL — the
      // page calls them on the blob response. Stub for the test run.
      createObjectURLMock = vi.fn(() => 'blob:fake-url');
      revokeObjectURLMock = vi.fn();
      URL.createObjectURL = createObjectURLMock;
      URL.revokeObjectURL = revokeObjectURLMock;
      // Spy on the global fetch (the XLSX/CSV exports bypass fetchApi).
      realFetch = global.fetch;
      fetchMock = vi.fn();
      global.fetch = fetchMock;
    });

    afterEach(() => {
      global.fetch = realFetch;
    });

    it('renders an "Export XLSX" button that is enabled with data and not permission-denied', async () => {
      renderPatients();
      // Wait for the table to populate so total > 0.
      await waitFor(() => expect(screen.getByText('Anita Sharma')).toBeInTheDocument());
      const xlsxBtn = screen.getByRole('button', { name: /Export XLSX/i });
      expect(xlsxBtn).toBeInTheDocument();
      expect(xlsxBtn).not.toBeDisabled();
    });

    it('clicking "Export XLSX" issues a fetch to /api/wellness/patients.xlsx honoring the current ?q= filter', async () => {
      // Resolve the global fetch with a Response-like { ok, blob() }.
      fetchMock.mockResolvedValue({
        ok: true,
        blob: () => Promise.resolve(new Blob(['fake-xlsx'])),
      });
      renderPatients();
      await waitFor(() => expect(screen.getByText('Anita Sharma')).toBeInTheDocument());

      // Type a search query so the export call includes it.
      const searchBox = screen.getByPlaceholderText(/Search by name, phone, or email/i);
      fireEvent.change(searchBox, { target: { value: 'anita' } });

      // Click the Export XLSX button.
      fireEvent.click(screen.getByRole('button', { name: /Export XLSX/i }));

      // Assert fetch was called for the xlsx URL with the q param.
      await waitFor(() => {
        const xlsxCall = fetchMock.mock.calls.find(([u]) =>
          typeof u === 'string' && u.startsWith('/api/wellness/patients.xlsx')
        );
        expect(xlsxCall).toBeTruthy();
        expect(xlsxCall[0]).toMatch(/q=anita/);
      });
      // Bearer header forwarded from the mocked getAuthToken.
      const lastCall = fetchMock.mock.calls.find(([u]) =>
        typeof u === 'string' && u.startsWith('/api/wellness/patients.xlsx')
      );
      expect(lastCall[1].headers).toEqual(
        expect.objectContaining({ Authorization: 'Bearer fake-token' }),
      );
      // The blob → object-url plumbing actually fired.
      await waitFor(() => {
        expect(createObjectURLMock).toHaveBeenCalled();
      });
    });

    it('disables BOTH Export CSV and Export XLSX while a download is in flight', async () => {
      // Never-resolving fetch — the click sets xlsxBusy=true and stays there.
      fetchMock.mockReturnValue(new Promise(() => {}));
      renderPatients();
      await waitFor(() => expect(screen.getByText('Anita Sharma')).toBeInTheDocument());

      const csvBtn = screen.getByRole('button', { name: /Export CSV/i });
      const xlsxBtn = screen.getByRole('button', { name: /Export XLSX/i });
      // Pre-click: both enabled.
      expect(csvBtn).not.toBeDisabled();
      expect(xlsxBtn).not.toBeDisabled();

      fireEvent.click(xlsxBtn);

      // After the click, xlsxBusy=true; both buttons disabled until the
      // (never-arriving) response settles.
      await waitFor(() => {
        expect(xlsxBtn).toBeDisabled();
        expect(csvBtn).toBeDisabled();
      });
    });
  });

  // #820 (tick #190) — "Download template" button. Surfaces the CSV import
  // template (9-col header + 1 fictional example row + UTF-8 BOM) shipped at
  // /api/wellness/patients/import-template.csv in tick #189 (6b4831bb). Pins:
  //   1. Button renders + is clickable regardless of row count (template is
  //      invariant — unlike Export CSV/XLSX which need total > 0).
  //   2. Click issues fetch GET to /api/wellness/patients/import-template.csv
  //      with NO query string (template ignores the active search filter).
  //   3. All three export buttons (CSV / XLSX / template) disable while ANY
  //      download is in-flight — preserves the existing combined-busy gate.
  describe('#820 Download template (tick #190)', () => {
    let createObjectURLMock;
    let revokeObjectURLMock;
    let realFetch;
    let fetchMock;

    beforeEach(() => {
      createObjectURLMock = vi.fn(() => 'blob:fake-url');
      revokeObjectURLMock = vi.fn();
      URL.createObjectURL = createObjectURLMock;
      URL.revokeObjectURL = revokeObjectURLMock;
      realFetch = global.fetch;
      fetchMock = vi.fn();
      global.fetch = fetchMock;
    });

    afterEach(() => {
      global.fetch = realFetch;
    });

    it('renders a "Download template" button that is enabled (template is invariant of row count)', async () => {
      renderPatients();
      await waitFor(() => expect(screen.getByText('Anita Sharma')).toBeInTheDocument());
      const tplBtn = screen.getByRole('button', { name: /Download template/i });
      expect(tplBtn).toBeInTheDocument();
      expect(tplBtn).not.toBeDisabled();
    });

    it('clicking "Download template" issues a fetch to /api/wellness/patients/import-template.csv with NO query params', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        blob: () => Promise.resolve(new Blob(['name,phone,email\nAnita,+919876543210,a@x.in\n'])),
      });
      renderPatients();
      await waitFor(() => expect(screen.getByText('Anita Sharma')).toBeInTheDocument());

      // Type a search query — proves the template URL ignores it.
      const searchBox = screen.getByPlaceholderText(/Search by name, phone, or email/i);
      fireEvent.change(searchBox, { target: { value: 'anita' } });

      fireEvent.click(screen.getByRole('button', { name: /Download template/i }));

      await waitFor(() => {
        const tplCall = fetchMock.mock.calls.find(([u]) =>
          typeof u === 'string' && u.startsWith('/api/wellness/patients/import-template.csv')
        );
        expect(tplCall).toBeTruthy();
        // No query string — template is invariant of the current search.
        expect(tplCall[0]).toBe('/api/wellness/patients/import-template.csv');
      });
      // Bearer header forwarded from the mocked getAuthToken.
      const tplCall = fetchMock.mock.calls.find(([u]) =>
        typeof u === 'string' && u.startsWith('/api/wellness/patients/import-template.csv')
      );
      expect(tplCall[1].headers).toEqual(
        expect.objectContaining({ Authorization: 'Bearer fake-token' }),
      );
      await waitFor(() => {
        expect(createObjectURLMock).toHaveBeenCalled();
      });
    });

    it('disables CSV + XLSX + template buttons while a template download is in flight', async () => {
      // Never-resolving fetch keeps templateBusy=true forever.
      fetchMock.mockReturnValue(new Promise(() => {}));
      renderPatients();
      await waitFor(() => expect(screen.getByText('Anita Sharma')).toBeInTheDocument());

      const csvBtn = screen.getByRole('button', { name: /Export CSV/i });
      const xlsxBtn = screen.getByRole('button', { name: /Export XLSX/i });
      const tplBtn = screen.getByRole('button', { name: /Download template/i });
      // Pre-click: all three enabled.
      expect(csvBtn).not.toBeDisabled();
      expect(xlsxBtn).not.toBeDisabled();
      expect(tplBtn).not.toBeDisabled();

      fireEvent.click(tplBtn);

      // All three disabled while the template fetch hangs.
      await waitFor(() => {
        expect(tplBtn).toBeDisabled();
        expect(csvBtn).toBeDisabled();
        expect(xlsxBtn).toBeDisabled();
      });
    });
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
