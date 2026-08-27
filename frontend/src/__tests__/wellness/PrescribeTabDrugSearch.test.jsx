/**
 * PrescribeTabDrugSearch.test.jsx — the drug typeahead on the prescribe form.
 *
 * THE BUG THIS PINS
 *   The typeahead requests `?limit=20`, which puts GET /api/wellness/drugs into
 *   its PAGINATED shape — `{ items, page, limit, total, hasMore }`, not a bare
 *   array. The component read the response with
 *   `Array.isArray(data) ? data : []`, so every single result was discarded and
 *   searching the catalogue matched nothing, ever.
 *
 *   It stayed invisible because the dropdown only rendered when
 *   `results.length > 0` — an always-empty list looks exactly like a closed
 *   dropdown. It only surfaced once the "add this drug" row gave the empty
 *   state something to draw.
 *
 *   Hence the first test below: the component must cope with the paginated
 *   envelope. The second keeps the bare-array path working, because the same
 *   endpoint returns one when no pagination params are sent.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const notifySuccess = vi.fn();
const notifyError = vi.fn();
vi.mock('../../utils/notify', () => ({
  useNotify: () => ({
    error: notifyError,
    success: notifySuccess,
    info: vi.fn(),
    confirm: () => Promise.resolve(true),
  }),
}));

vi.mock('../../utils/api', () => ({
  fetchApi: vi.fn(),
  getAuthToken: () => 'test-token',
}));

vi.mock('../../utils/date', () => ({
  formatDate: (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—'),
}));

vi.mock('../../utils/useFormAutosave', () => {
  const { useState } = require('react');
  return {
    useFormAutosave: (_key, initial) => {
      const [draft, setDraft] = useState(initial);
      return [draft, setDraft, false, () => {}];
    },
  };
});

import PrescribeTab from '../../pages/wellness/patientDetail/tabs/PrescribeTab';
import { fetchApi } from '../../utils/api';

const PATIENT = {
  id: 2965,
  name: 'Mohit das',
  visits: [{ id: 4, visitDate: '2026-08-26T09:00:00.000Z', service: { name: 'Basic FUE' } }],
  prescriptions: [],
};

const MINOXIDIL = {
  id: 96,
  name: 'Minoxidil',
  genericName: null,
  dosageForm: 'other',
  strengthValue: '5',
  strengthUnit: '%',
  isActive: true,
  quantity: 40,
  lowStockThreshold: 10,
};

/**
 * The add-row interpolates the typed name between &ldquo;/&rdquo;, so the label
 * is split across text nodes and uses curly quotes. Match the assembled
 * textContent of the <li> rather than a single node.
 */
const addRow = (name) => (_t, el) =>
  el?.tagName === 'LI' &&
  el.textContent?.includes('to the drug catalogue') &&
  el.textContent?.includes(name);

/** How the route actually answers when `limit` is present. */
const paginated = (items) => ({ items, page: 1, limit: 20, total: items.length, hasMore: false });

let drugResponse;

function renderTab() {
  return render(<PrescribeTab patient={PATIENT} onSaved={() => {}} />);
}

async function search(term) {
  const input = screen.getByPlaceholderText(/Drug name/i);
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: term } });
  return input;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  drugResponse = paginated([MINOXIDIL]);
  fetchApi.mockImplementation(async (url) => {
    if (url.startsWith('/api/wellness/drugs?')) return drugResponse;
    return {};
  });
});

describe('PrescribeTab — drug typeahead', () => {
  it('reads the PAGINATED envelope the route returns for ?limit=', async () => {
    renderTab();
    await search('mino');
    vi.advanceTimersByTime(300);

    // The whole bug in one assertion: `{ items: [...] }` must not be dropped.
    expect(await screen.findByText('Minoxidil')).toBeInTheDocument();
  });

  it('still reads a bare array, which the route returns without pagination', async () => {
    drugResponse = [MINOXIDIL];
    renderTab();
    await search('mino');
    vi.advanceTimersByTime(300);
    expect(await screen.findByText('Minoxidil')).toBeInTheDocument();
  });

  it('asks for the slim summary shape, which now carries stock', async () => {
    renderTab();
    await search('mino');
    vi.advanceTimersByTime(300);

    await waitFor(() => {
      // Focus fires an empty search first, so assert on the one carrying `q`.
      const url = fetchApi.mock.calls.map((c) => c[0]).find((u) => u?.includes('q=mino'));
      expect(url).toBeTruthy();
      expect(url).toContain('fields=summary');
      expect(url).toContain('isActive=true');
      expect(url).toContain('limit=20');
    });
  });

  it('shows the quantity on hand next to each suggestion', async () => {
    renderTab();
    await search('mino');
    vi.advanceTimersByTime(300);
    // 40 on hand against a reorder point of 10 — comfortably stocked.
    expect(await screen.findByText('40 in stock')).toBeInTheDocument();
  });

  it('warns when a suggested drug is out of stock', async () => {
    drugResponse = paginated([{ ...MINOXIDIL, quantity: 0 }]);
    renderTab();
    await search('mino');
    vi.advanceTimersByTime(300);
    expect(await screen.findByText('out of stock')).toBeInTheDocument();
  });

  it('flags a drug at or below its reorder point as low', async () => {
    drugResponse = paginated([{ ...MINOXIDIL, quantity: 8, lowStockThreshold: 10 }]);
    renderTab();
    await search('mino');
    vi.advanceTimersByTime(300);
    expect(await screen.findByText(/8 left — low/)).toBeInTheDocument();
  });

  it('offers to add a drug the catalogue does not have', async () => {
    drugResponse = paginated([]);
    renderTab();
    await search('Paracetamol');
    vi.advanceTimersByTime(300);
    expect(await screen.findByText(addRow('Paracetamol'))).toBeInTheDocument();
  });

  it('does not offer to add a drug that already matched exactly', async () => {
    renderTab();
    await search('Minoxidil');
    vi.advanceTimersByTime(300);
    await screen.findByText('Minoxidil');
    expect(screen.queryByText(addRow('Minoxidil'))).toBeNull();
  });

  it('quick-adds a missing drug and fills the row with it', async () => {
    drugResponse = paginated([]);
    fetchApi.mockImplementation(async (url, options) => {
      if (url === '/api/wellness/drugs/quick-add' && options?.method === 'POST') {
        return { id: 700, name: 'Paracetamol', created: true };
      }
      if (url.startsWith('/api/wellness/drugs?')) return drugResponse;
      return {};
    });

    renderTab();
    await search('Paracetamol');
    vi.advanceTimersByTime(300);

    fireEvent.mouseDown(await screen.findByText(addRow('Paracetamol')));

    await waitFor(() => {
      const post = fetchApi.mock.calls.find((c) => c[1]?.method === 'POST');
      expect(post[0]).toBe('/api/wellness/drugs/quick-add');
      expect(JSON.parse(post[1].body)).toEqual({ name: 'Paracetamol' });
    });
    // The doctor is told an admin has to set its stock — the row lands at 0.
    await waitFor(() =>
      expect(notifySuccess).toHaveBeenCalledWith(
        expect.stringContaining('set its stock'),
      ),
    );
  });
});
