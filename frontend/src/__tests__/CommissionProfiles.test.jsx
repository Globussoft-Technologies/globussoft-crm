/**
 * CommissionProfiles.test.jsx — vitest + RTL coverage for the Commission
 * Profiles admin page (PRD Gap §1.5).
 *
 * Target: frontend/src/pages/CommissionProfiles.jsx (344 LOC) — tenant-scoped
 * payroll commission rule sets. NO prior test file existed.
 *
 * Scope: pins page-surface invariants — fetch contracts, CRUD modal,
 * validation guards, soft-disable rendering. RBAC is enforced server-side on
 * /api/staff/commission-profiles routes; the page chrome itself does not
 * role-gate (mirrors Quotas.jsx's design), so we don't test role-gating here.
 *
 *   1. Mount fires GET /api/staff/commission-profiles on first render.
 *   2. Heading "Commission Profiles" + "New profile" CTA render.
 *   3. Loading state: "Loading…" placeholder renders before the initial
 *      list fetch resolves.
 *   4. Empty state: "No commission profiles yet." copy renders when the
 *      list endpoint returns [].
 *   5. List state: one row per profile with name + basis label + percent
 *      formatted with `%` + flat amount + category filter.
 *   6. Active vs disabled badges: row's active state renders the "Active"
 *      green span; isActive=false renders the "Disabled" subdued span.
 *   7. Basis enum value gets mapped to its human label
 *      ("REVENUE_PERCENT" → "Revenue percent") in the row Basis cell.
 *   8. "New profile" CTA opens the modal with empty fields + the
 *      "New commission profile" heading.
 *   9. Save with empty name shows the "Name is required." error and does
 *      NOT fire POST.
 *  10. Save with name but BOTH percentage and flatAmount empty shows the
 *      "Either percentage or flat amount must be set." error and does NOT
 *      fire POST.
 *  11. Happy-path create: POST /api/staff/commission-profiles fires with
 *      the right body shape (trimmed name, numeric percentage, flatAmount
 *      null, basis enum, appliesToCategory null on empty, isActive true).
 *      Modal closes; list re-fetches.
 *  12. Edit row: clicking the Edit icon opens the modal pre-filled with
 *      the row's values + the heading flips to "Edit commission profile".
 *      Save fires PUT /api/staff/commission-profiles/<id> with the
 *      same-shape body and re-loads.
 *  13. Delete row: clicking the Delete icon invokes notify.confirm with
 *      the row name + destructive=true. On confirm, fires DELETE
 *      /api/staff/commission-profiles/<id> and re-loads the list.
 *  14. Delete cancelled: when notify.confirm resolves false, no DELETE
 *      fires.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

// Stable notify object — see the 2026-05-RTL "stable mock object references
// for hooks" standing rule. Re-creating { error: vi.fn(), confirm: vi.fn() }
// per useNotify() call would invalidate the page's downstream callbacks and
// cause infinite re-render loops in any consumer that put notify into a
// useCallback / useMemo dependency array.
const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyConfirm = vi.fn(() => Promise.resolve(true));
const notifyObj = {
  error: notifyError,
  info: vi.fn(),
  success: notifySuccess,
  confirm: (...args) => notifyConfirm(...args),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

import CommissionProfiles from '../pages/CommissionProfiles';

const sampleRows = [
  {
    id: 11,
    name: 'Senior Doctor Cut',
    basis: 'REVENUE_PERCENT',
    percentage: 25,
    flatAmount: null,
    appliesToCategory: 'Aesthetics',
    isActive: true,
  },
  {
    id: 12,
    name: 'Helper Flat Bonus',
    basis: 'FLAT_PER_INVOICE',
    percentage: null,
    flatAmount: 500,
    appliesToCategory: null,
    isActive: false,
  },
];

const COMMISSION_URL = '/api/staff/commission-profiles';

function defaultFetchMock(url) {
  if (url === COMMISSION_URL) return Promise.resolve(sampleRows);
  return Promise.resolve(null);
}

function renderPage() {
  return render(<CommissionProfiles />);
}

describe('<CommissionProfiles /> — Commission Profiles admin page surface', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifySuccess.mockReset();
    notifyConfirm.mockReset();
    notifyConfirm.mockImplementation(() => Promise.resolve(true));
    fetchApiMock.mockImplementation(defaultFetchMock);
  });

  it('mounts and fires GET /api/staff/commission-profiles', async () => {
    renderPage();
    await waitFor(() => {
      const listCall = fetchApiMock.mock.calls.find(
        ([u, opts]) => u === COMMISSION_URL && (!opts || !opts.method || opts.method === 'GET'),
      );
      expect(listCall).toBeTruthy();
    });
  });

  it('renders heading "Commission Profiles" + the "New profile" CTA', async () => {
    renderPage();
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: /Commission Profiles/i }),
      ).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /New profile/i })).toBeInTheDocument();
  });

  it('shows the "Loading…" placeholder before the initial list fetch resolves', async () => {
    let resolveList;
    fetchApiMock.mockImplementation((url) => {
      if (url === COMMISSION_URL) {
        return new Promise((r) => { resolveList = r; });
      }
      return Promise.resolve(null);
    });
    renderPage();
    expect(await screen.findByText(/Loading…/i)).toBeInTheDocument();
    // Resolve so the test tears down cleanly.
    resolveList([]);
  });

  it('renders the "No commission profiles yet." empty state when list is []', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === COMMISSION_URL) return Promise.resolve([]);
      return Promise.resolve(null);
    });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/No commission profiles yet\./i)).toBeInTheDocument();
    });
  });

  it('renders one row per profile with name + formatted percent + flat amount + category', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Senior Doctor Cut')).toBeInTheDocument());
    expect(screen.getByText('Helper Flat Bonus')).toBeInTheDocument();
    // Percent column — row 1 has "25%"; row 2 has the em-dash placeholder.
    expect(screen.getByText('25%')).toBeInTheDocument();
    // Flat amount column — row 2 renders 500 as toLocaleString'd "500"; row 1 has em-dash.
    expect(screen.getByText('500')).toBeInTheDocument();
    // Category filter column — row 1 = "Aesthetics", row 2 = em-dash.
    expect(screen.getByText('Aesthetics')).toBeInTheDocument();
  });

  it('renders the Active green badge for isActive=true rows and Disabled for isActive=false', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Senior Doctor Cut')).toBeInTheDocument());
    // "Active" appears TWICE on screen: once as the table column <th>Active</th>
    // header and once as the green status badge on the active row — per the
    // CLAUDE.md "RTL: prefer getAllByText for labels that appear as both filter
    // chrome AND row badges" standing rule, assert via the count.
    expect(screen.getAllByText(/^Active$/).length).toBeGreaterThanOrEqual(2);
    // "Disabled" only appears as the row badge (no matching column header).
    expect(screen.getByText(/^Disabled$/)).toBeInTheDocument();
  });

  it('maps the basis enum value to its human label in the row Basis cell', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Senior Doctor Cut')).toBeInTheDocument());
    // "REVENUE_PERCENT" → "Revenue percent"; "FLAT_PER_INVOICE" → "Flat per invoice".
    expect(screen.getByText('Revenue percent')).toBeInTheDocument();
    expect(screen.getByText('Flat per invoice')).toBeInTheDocument();
  });

  it('"New profile" CTA opens the modal in create mode with empty fields', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Senior Doctor Cut')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /New profile/i }));

    expect(
      await screen.findByRole('heading', { name: /New commission profile/i }),
    ).toBeInTheDocument();

    // Name input renders empty.
    const nameInput = screen.getByTestId('profile-form-name');
    expect(nameInput).toHaveValue('');
  });

  it('Save with empty name shows the "Name is required." error and does NOT POST', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Senior Doctor Cut')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /New profile/i }));
    await screen.findByRole('heading', { name: /New commission profile/i });

    // Clear the POST-call tracking baseline.
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetchMock);

    fireEvent.click(screen.getByTestId('profile-form-save'));

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith('Name is required.');
    });
    // No POST should have fired.
    const postCall = fetchApiMock.mock.calls.find(
      ([, opts]) => opts && opts.method === 'POST',
    );
    expect(postCall).toBeUndefined();
  });

  it('Save with a name but no percentage AND no flat amount errors and does NOT POST', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Senior Doctor Cut')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /New profile/i }));
    await screen.findByRole('heading', { name: /New commission profile/i });

    fireEvent.change(screen.getByTestId('profile-form-name'), { target: { value: 'Mid-tier' } });

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetchMock);

    fireEvent.click(screen.getByTestId('profile-form-save'));

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith('Either percentage or flat amount must be set.');
    });
    const postCall = fetchApiMock.mock.calls.find(
      ([, opts]) => opts && opts.method === 'POST',
    );
    expect(postCall).toBeUndefined();
  });

  it('happy-path create: POST fires with trimmed name + numeric percentage + flatAmount null + category null', async () => {
    let postBody = null;
    let listCallCount = 0;
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === COMMISSION_URL && opts && opts.method === 'POST') {
        postBody = JSON.parse(opts.body);
        return Promise.resolve({ id: 999 });
      }
      if (url === COMMISSION_URL) {
        listCallCount += 1;
        return Promise.resolve(sampleRows);
      }
      return Promise.resolve(null);
    });

    renderPage();
    await waitFor(() => expect(screen.getByText('Senior Doctor Cut')).toBeInTheDocument());
    const initialListCount = listCallCount;

    fireEvent.click(screen.getByRole('button', { name: /New profile/i }));
    await screen.findByRole('heading', { name: /New commission profile/i });

    // Set name (with surrounding whitespace to pin .trim()).
    fireEvent.change(screen.getByTestId('profile-form-name'), {
      target: { value: '  New Tier  ' },
    });

    // Percentage number input — the first numeric input in the modal.
    const numberInputs = document.querySelectorAll('input[type="number"]');
    expect(numberInputs.length).toBeGreaterThanOrEqual(2);
    fireEvent.change(numberInputs[0], { target: { value: '15' } });
    // Leave flat amount blank to pin "flatAmount: null when empty".
    // Leave category blank to pin "appliesToCategory: null when empty".

    fireEvent.click(screen.getByTestId('profile-form-save'));

    await waitFor(() => {
      expect(postBody).not.toBeNull();
    });
    expect(postBody.name).toBe('New Tier');
    expect(postBody.percentage).toBe(15);
    expect(postBody.flatAmount).toBeNull();
    expect(postBody.basis).toBe('REVENUE_PERCENT');
    expect(postBody.appliesToCategory).toBeNull();
    expect(postBody.isActive).toBe(true);

    // Modal closes + list re-loads.
    await waitFor(() => {
      expect(
        screen.queryByRole('heading', { name: /New commission profile/i }),
      ).not.toBeInTheDocument();
    });
    expect(listCallCount).toBeGreaterThan(initialListCount);
  });

  it('edit row: opens modal pre-filled + heading "Edit commission profile" + Save PUTs with body', async () => {
    let putUrl = null;
    let putBody = null;
    fetchApiMock.mockImplementation((url, opts) => {
      if (url.startsWith('/api/staff/commission-profiles/') && opts && opts.method === 'PUT') {
        putUrl = url;
        putBody = JSON.parse(opts.body);
        return Promise.resolve({ id: 11 });
      }
      if (url === COMMISSION_URL) return Promise.resolve(sampleRows);
      return Promise.resolve(null);
    });

    renderPage();
    await waitFor(() => expect(screen.getByText('Senior Doctor Cut')).toBeInTheDocument());

    // Click the row-level Edit icon (data-testid pinned by the page).
    fireEvent.click(screen.getByTestId('profile-edit-11'));

    expect(
      await screen.findByRole('heading', { name: /Edit commission profile/i }),
    ).toBeInTheDocument();

    // Pre-filled name = "Senior Doctor Cut".
    expect(screen.getByTestId('profile-form-name')).toHaveValue('Senior Doctor Cut');

    // Bump the percentage to 30.
    const numberInputs = document.querySelectorAll('input[type="number"]');
    fireEvent.change(numberInputs[0], { target: { value: '30' } });

    fireEvent.click(screen.getByTestId('profile-form-save'));

    await waitFor(() => {
      expect(putUrl).toBe('/api/staff/commission-profiles/11');
    });
    expect(putBody.name).toBe('Senior Doctor Cut');
    expect(putBody.percentage).toBe(30);
    expect(putBody.basis).toBe('REVENUE_PERCENT');
    expect(putBody.appliesToCategory).toBe('Aesthetics');
    expect(putBody.isActive).toBe(true);
  });

  it('delete row: confirms with row name + destructive=true, then DELETE fires and list re-loads', async () => {
    let deletedUrl = null;
    let listCallCount = 0;
    fetchApiMock.mockImplementation((url, opts) => {
      if (url.startsWith('/api/staff/commission-profiles/') && opts && opts.method === 'DELETE') {
        deletedUrl = url;
        return Promise.resolve({ ok: true });
      }
      if (url === COMMISSION_URL) {
        listCallCount += 1;
        return Promise.resolve(sampleRows);
      }
      return Promise.resolve(null);
    });

    renderPage();
    await waitFor(() => expect(screen.getByText('Senior Doctor Cut')).toBeInTheDocument());
    const initialListCount = listCallCount;

    fireEvent.click(screen.getByTestId('profile-delete-11'));

    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalled();
    });
    const confirmArg = notifyConfirm.mock.calls[0][0];
    expect(confirmArg.message).toMatch(/Senior Doctor Cut/);
    expect(confirmArg.destructive).toBe(true);

    await waitFor(() => {
      expect(deletedUrl).toBe('/api/staff/commission-profiles/11');
    });
    expect(listCallCount).toBeGreaterThan(initialListCount);
  });

  it('delete cancelled: when notify.confirm resolves false, no DELETE fires', async () => {
    notifyConfirm.mockImplementation(() => Promise.resolve(false));
    let deleteCalled = false;
    fetchApiMock.mockImplementation((url, opts) => {
      if (url.startsWith('/api/staff/commission-profiles/') && opts && opts.method === 'DELETE') {
        deleteCalled = true;
        return Promise.resolve({ ok: true });
      }
      if (url === COMMISSION_URL) return Promise.resolve(sampleRows);
      return Promise.resolve(null);
    });

    renderPage();
    await waitFor(() => expect(screen.getByText('Senior Doctor Cut')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('profile-delete-11'));

    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalled();
    });
    // Give the rejected promise a tick to settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(deleteCalled).toBe(false);
  });
});
