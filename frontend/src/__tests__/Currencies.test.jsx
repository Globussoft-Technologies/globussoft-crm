/**
 * Currencies.test.jsx — vitest + RTL coverage for the multi-currency admin
 * page (per-tenant currency config + FX rates + pivot card).
 *
 * Scope: pins the page-surface invariants for the Currencies admin —
 * initial mount fetch (parallel `/api/currencies` + `/api/currencies/pivot/
 * deals`), preview vs persisted banner gate (#473 + #719), CRUD flows
 * (seed / add / set-base / edit-rate / delete), loading + empty + error
 * states, the pivot card rendering, and currency-symbol client formatting.
 *
 *   1. Renders heading "Currencies" + Refresh + Add Currency CTAs.
 *   2. Initial mount fires BOTH `/api/currencies` AND
 *      `/api/currencies/pivot/deals` (parallel `Promise.all`).
 *   3. Currency rows render with code / symbol / name / 4-decimal rate.
 *   4. Preview banner ("Default currencies (preview)") renders when ANY row
 *      has a non-positive id; clicking "Initialize Defaults" POSTs
 *      `/api/currencies/seed` (#473 — banner gates on every row being
 *      persisted, not just the first).
 *   5. Add Currency modal opens, submits POST `/api/currencies` with the
 *      five-field body shape `{code, symbol, name, exchangeRate, isBase}`,
 *      and rejects submission when required fields are missing (notify.error).
 *   6. Set-base action POSTs `/api/currencies/:id/set-base`.
 *   7. Edit-rate flow PUTs `/api/currencies/:id` with `{exchangeRate}`.
 *   8. Delete flow asks notify.confirm and only DELETEs on confirm=true.
 *   9. Empty state "No currencies configured." renders for `[]`.
 *  10. Loading state "Loading currencies..." renders while fetch in-flight.
 *  11. Error renders inline when fetch rejects.
 *  12. Pivot card renders with formatted INR / USD amounts (₹ / $).
 *
 * Drift note: currency-conversion math (convertCurrency) is pinned by
 * utils/currency unit tests; this file covers the page chrome + fetch
 * contracts only.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

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

import Currencies from '../pages/Currencies';

const persistedCurrencies = [
  { id: 1, code: 'USD', symbol: '$',  name: 'US Dollar',    exchangeRate: 1.0,    isBase: true },
  { id: 2, code: 'INR', symbol: '₹',  name: 'Indian Rupee', exchangeRate: 83.25,  isBase: false },
  { id: 3, code: 'EUR', symbol: '€',  name: 'Euro',         exchangeRate: 0.92,   isBase: false },
  { id: 4, code: 'SAR', symbol: 'ر.س', name: 'Saudi Riyal', exchangeRate: 3.75,   isBase: false },
];

const previewCurrencies = [
  { id: -1, code: 'USD', symbol: '$', name: 'US Dollar',    exchangeRate: 1.0,   isBase: true  },
  { id: -2, code: 'INR', symbol: '₹', name: 'Indian Rupee', exchangeRate: 83.25, isBase: false },
];

const samplePivot = {
  baseCode: 'USD',
  totalInBase: 12345.67,
  dealCount: 5,
  byCurrency: {
    USD: { count: 3, amount: 10000 },
    INR: { count: 2, amount: 200000 },
  },
};

function defaultFetchMock(url, opts) {
  if (url === '/api/currencies' && (!opts || !opts.method || opts.method === 'GET')) {
    return Promise.resolve(persistedCurrencies);
  }
  if (url === '/api/currencies/pivot/deals') {
    return Promise.resolve(samplePivot);
  }
  return Promise.resolve(null);
}

function renderCurrencies() {
  return render(
    <MemoryRouter>
      <Currencies />
    </MemoryRouter>,
  );
}

describe('<Currencies /> — page surface', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation(defaultFetchMock);
    notifyError.mockReset();
    notifySuccess.mockReset();
    notifyConfirm.mockReset();
    notifyConfirm.mockResolvedValue(true);
  });

  it('renders heading "Currencies" + Refresh + Add Currency CTAs', async () => {
    renderCurrencies();
    expect(await screen.findByRole('heading', { name: /Currencies/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Refresh/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add Currency/i })).toBeInTheDocument();
  });

  it('initial mount fires BOTH /api/currencies and /api/currencies/pivot/deals (parallel)', async () => {
    renderCurrencies();
    await waitFor(() => {
      const listCall = fetchApiMock.mock.calls.find(([u]) => u === '/api/currencies');
      const pivotCall = fetchApiMock.mock.calls.find(([u]) => u === '/api/currencies/pivot/deals');
      expect(listCall).toBeTruthy();
      expect(pivotCall).toBeTruthy();
    });
  });

  it('renders one row per currency with code / symbol / name / 4-decimal rate', async () => {
    renderCurrencies();
    // Code cells (also appear in pivot tile + stat tile — assert presence with getAllByText)
    expect(await screen.findByText('US Dollar')).toBeInTheDocument();
    expect(screen.getByText('Indian Rupee')).toBeInTheDocument();
    expect(screen.getByText('Euro')).toBeInTheDocument();
    expect(screen.getByText('Saudi Riyal')).toBeInTheDocument();
    // Codes appear in multiple surfaces; assert at least one occurrence each.
    expect(screen.getAllByText('USD').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('INR').length).toBeGreaterThanOrEqual(1);
    // 4-decimal-fixed rate rendering (Number(c.exchangeRate).toFixed(4)).
    expect(screen.getByText('1.0000')).toBeInTheDocument();
    expect(screen.getByText('83.2500')).toBeInTheDocument();
    expect(screen.getByText('0.9200')).toBeInTheDocument();
    expect(screen.getByText('3.7500')).toBeInTheDocument();
  });

  it('preview banner renders when ANY row has a non-positive id (#473)', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/currencies') return Promise.resolve(previewCurrencies);
      if (url === '/api/currencies/pivot/deals') return Promise.resolve(null);
      return Promise.resolve(null);
    });
    renderCurrencies();
    expect(await screen.findByText(/Default currencies \(preview\)/i)).toBeInTheDocument();
    // Stat tile label switches to "Available Currencies (preview)" too.
    expect(screen.getByText(/Available Currencies \(preview\)/i)).toBeInTheDocument();
    // Initialize Defaults CTA is the call to action inside the banner.
    expect(screen.getByRole('button', { name: /Initialize Defaults/i })).toBeInTheDocument();
  });

  it('preview banner HIDES when every row has a positive id (#473 every-row gate)', async () => {
    renderCurrencies();
    // Wait for the persisted-data load to settle.
    await screen.findByText('US Dollar');
    expect(screen.queryByText(/Default currencies \(preview\)/i)).not.toBeInTheDocument();
    // Stat tile label switches to "Active Currencies".
    expect(screen.getByText(/Active Currencies/i)).toBeInTheDocument();
  });

  it('clicking "Initialize Defaults" POSTs /api/currencies/seed and reloads', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/currencies' && (!opts || !opts.method || opts.method === 'GET')) {
        return Promise.resolve(previewCurrencies);
      }
      if (url === '/api/currencies/seed' && opts?.method === 'POST') {
        return Promise.resolve({ ok: true });
      }
      if (url === '/api/currencies/pivot/deals') return Promise.resolve(null);
      return Promise.resolve(null);
    });
    renderCurrencies();
    const seedBtn = await screen.findByRole('button', { name: /Initialize Defaults/i });
    fireEvent.click(seedBtn);
    await waitFor(() => {
      const seedCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/currencies/seed' && o?.method === 'POST',
      );
      expect(seedCall).toBeTruthy();
    });
  });

  it('opens the Add Currency modal and POSTs /api/currencies with the 5-field body', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/currencies' && opts?.method === 'POST') {
        return Promise.resolve({ id: 99 });
      }
      return defaultFetchMock(url, opts);
    });
    renderCurrencies();
    // Wait for table to settle.
    await screen.findByText('US Dollar');

    fireEvent.click(screen.getByRole('button', { name: /Add Currency/i }));

    // Modal renders inputs.
    const codeInput = screen.getByPlaceholderText(/Code \(e\.g\. JPY\)/i);
    const symbolInput = screen.getByPlaceholderText(/Symbol \(e\.g\. ¥\)/i);
    const nameInput = screen.getByPlaceholderText(/Name \(e\.g\. Japanese Yen\)/i);
    const rateInput = screen.getByPlaceholderText(/Exchange rate/i);
    expect(codeInput).toBeInTheDocument();

    fireEvent.change(codeInput, { target: { value: 'jpy' } }); // tests upper-casing
    fireEvent.change(symbolInput, { target: { value: '¥' } });
    fireEvent.change(nameInput, { target: { value: 'Japanese Yen' } });
    fireEvent.change(rateInput, { target: { value: '149.50' } });

    fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));

    await waitFor(() => {
      const createCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/currencies' && o?.method === 'POST',
      );
      expect(createCall).toBeTruthy();
      const body = JSON.parse(createCall[1].body);
      // Code is upper-cased on input (pinned in onChange handler).
      expect(body.code).toBe('JPY');
      expect(body.symbol).toBe('¥');
      expect(body.name).toBe('Japanese Yen');
      // exchangeRate is parsed via parseFloat (number, not string).
      expect(body.exchangeRate).toBe(149.5);
      expect(body.isBase).toBe(false);
    });
  });

  it('Add Currency with missing fields fires notify.error and does NOT POST', async () => {
    renderCurrencies();
    await screen.findByText('US Dollar');

    fireEvent.click(screen.getByRole('button', { name: /Add Currency/i }));
    // Click Create without filling anything.
    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/Code, symbol, and name are required/i),
      );
    });
    // No POST fired.
    const postCall = fetchApiMock.mock.calls.find(
      ([u, o]) => u === '/api/currencies' && o?.method === 'POST',
    );
    expect(postCall).toBeUndefined();
  });

  it('clicking "Set as base" on a non-base row POSTs /api/currencies/:id/set-base', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (/\/api\/currencies\/\d+\/set-base$/.test(url) && opts?.method === 'POST') {
        return Promise.resolve({ ok: true });
      }
      return defaultFetchMock(url, opts);
    });
    renderCurrencies();
    await screen.findByText('Indian Rupee');

    // Click the "Set as base" Star icon button on the INR row (id=2).
    // There are multiple Star buttons (one per non-base persisted row); pick
    // the first one which corresponds to INR (id=2).
    const setBaseButtons = screen.getAllByTitle(/Set as base/i);
    // The radio + the star both carry this title; click the icon button (last).
    fireEvent.click(setBaseButtons[setBaseButtons.length - 1]);

    await waitFor(() => {
      const setBaseCall = fetchApiMock.mock.calls.find(
        ([u, o]) => /\/api\/currencies\/\d+\/set-base$/.test(u) && o?.method === 'POST',
      );
      expect(setBaseCall).toBeTruthy();
    });
  });

  it('edit-rate flow PUTs /api/currencies/:id with { exchangeRate }', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (/\/api\/currencies\/\d+$/.test(url) && opts?.method === 'PUT') {
        return Promise.resolve({ ok: true });
      }
      return defaultFetchMock(url, opts);
    });
    renderCurrencies();
    await screen.findByText('Indian Rupee');

    // Click the Edit pencil — the EUR row (non-base, id=3). All "Edit rate"
    // buttons render once per non-base persisted row; pick the first.
    const editButtons = screen.getAllByTitle(/Edit rate/i);
    fireEvent.click(editButtons[0]);

    // The edit row replaces the rate cell with a number input + Save.
    // Find the inline number input that just opened (only one at a time).
    const numberInputs = document
      .querySelectorAll('input[type="number"]');
    // Pick the LAST number input (the inline editor — others are inside the
    // closed Add modal at this point, which is closed, so this is the only one).
    const inlineRate = numberInputs[numberInputs.length - 1];
    fireEvent.change(inlineRate, { target: { value: '90.5' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));

    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        ([u, o]) => /\/api\/currencies\/\d+$/.test(u) && o?.method === 'PUT',
      );
      expect(putCall).toBeTruthy();
      const body = JSON.parse(putCall[1].body);
      expect(body.exchangeRate).toBe(90.5);
    });
  });

  it('delete flow asks notify.confirm and DELETEs /api/currencies/:id on confirm=true', async () => {
    notifyConfirm.mockResolvedValue(true);
    fetchApiMock.mockImplementation((url, opts) => {
      if (/\/api\/currencies\/\d+$/.test(url) && opts?.method === 'DELETE') {
        return Promise.resolve({ ok: true });
      }
      return defaultFetchMock(url, opts);
    });
    renderCurrencies();
    await screen.findByText('Indian Rupee');

    const deleteButtons = screen.getAllByTitle(/^Delete$/i);
    fireEvent.click(deleteButtons[0]);

    await waitFor(() => expect(notifyConfirm).toHaveBeenCalled());
    await waitFor(() => {
      const delCall = fetchApiMock.mock.calls.find(
        ([u, o]) => /\/api\/currencies\/\d+$/.test(u) && o?.method === 'DELETE',
      );
      expect(delCall).toBeTruthy();
    });
  });

  it('delete flow with confirm=false does NOT DELETE', async () => {
    notifyConfirm.mockResolvedValue(false);
    renderCurrencies();
    await screen.findByText('Indian Rupee');

    fetchApiMock.mockClear();
    const deleteButtons = screen.getAllByTitle(/^Delete$/i);
    fireEvent.click(deleteButtons[0]);

    await waitFor(() => expect(notifyConfirm).toHaveBeenCalled());
    // Give the click handler a tick to settle.
    await new Promise((r) => setTimeout(r, 10));
    const delCall = fetchApiMock.mock.calls.find(
      ([u, o]) => /\/api\/currencies\/\d+$/.test(u) && o?.method === 'DELETE',
    );
    expect(delCall).toBeUndefined();
  });

  it('renders empty state "No currencies configured." when /api/currencies returns []', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/currencies') return Promise.resolve([]);
      if (url === '/api/currencies/pivot/deals') return Promise.resolve(null);
      return Promise.resolve(null);
    });
    renderCurrencies();
    expect(await screen.findByText(/No currencies configured\./i)).toBeInTheDocument();
  });

  it('shows "Loading currencies..." before the initial fetch resolves', async () => {
    let resolveCurrencies;
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/currencies') {
        return new Promise((r) => { resolveCurrencies = r; });
      }
      if (url === '/api/currencies/pivot/deals') return Promise.resolve(null);
      return Promise.resolve(null);
    });
    renderCurrencies();
    expect(await screen.findByText(/Loading currencies/i)).toBeInTheDocument();
    // Cleanly resolve so the component unmount tear-down runs.
    resolveCurrencies([]);
  });

  it('renders inline error card when /api/currencies rejects', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/currencies') {
        return Promise.reject(new Error('Backend exploded'));
      }
      if (url === '/api/currencies/pivot/deals') return Promise.resolve(null);
      return Promise.resolve(null);
    });
    renderCurrencies();
    expect(await screen.findByText(/Backend exploded/i)).toBeInTheDocument();
  });

  it('pivot card renders with formatCurrency-formatted ₹ + $ amounts', async () => {
    renderCurrencies();
    // Wait for the pivot card to mount (only renders when `pivot` resolves).
    expect(await screen.findByText(/Open Pipeline by Currency/i)).toBeInTheDocument();
    // USD 10,000 → formatCurrency('USD', 10000) = "$10,000.00"
    expect(screen.getByText('$10,000.00')).toBeInTheDocument();
    // INR 200,000 → formatCurrency('INR', 200000) = "₹2,00,000.00" (Indian grouping)
    expect(screen.getByText('₹2,00,000.00')).toBeInTheDocument();
    // Total-in-base also USD-formatted — appears in BOTH the StatCard
    // ("Open Pipeline (in USD)" tile) AND the pivot card's footer total,
    // so use getAllByText and assert at least 2 occurrences (one per
    // surface). The duplication is load-bearing — the pivot total is the
    // single source of truth that both surfaces consume.
    expect(screen.getAllByText('$12,345.67').length).toBeGreaterThanOrEqual(2);
  });
});
