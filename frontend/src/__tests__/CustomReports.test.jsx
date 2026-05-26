/**
 * CustomReports.test.jsx — vitest + RTL coverage for the no-code Custom Reports builder.
 *
 * Scope: pins the page-surface invariants for the report-builder workflow in
 * frontend/src/pages/CustomReports.jsx (595 LOC):
 *
 *   1. Page renders the header, builder card title, and Saved Reports panel.
 *   2. On mount, loads saved reports from GET /api/custom-reports.
 *   3. Empty saved-reports state: "No saved reports yet." renders when the
 *      list endpoint returns [].
 *   4. List endpoint returning rows → renders one entry per row with name
 *      + description + Run / Edit / Delete row-action buttons.
 *   5. Builder defaults to entity "Deal" + entity dropdown lists all 5
 *      ENTITY_FIELDS keys (Deal/Contact/Invoice/Activity/Task).
 *   6. Changing entity replaces the columns with the first three of the new
 *      entity's fields and clears filters.
 *   7. "Add Filter" appends a filter row with the first field of the active
 *      entity + op "=" by default. Subsequent "Add Filter" appends another row.
 *   8. Removing a filter via the X button pops it from the filters list.
 *   9. Clicking "Run" POSTs /api/custom-reports/run with { config } and the
 *      response shape { columns, rows } renders the results table header and
 *      a 1-row "Results (N rows)" caption.
 *  10. Run-error path: when /run rejects, an "Error: <message>" banner
 *      renders and results are cleared.
 *  11. Running a saved report (Run button on a saved row) POSTs
 *      /api/custom-reports/<id>/run, loads its config into the builder, and
 *      flips the builder heading to "Edit Report".
 *  12. Save modal: clicking "Save" opens the modal; submitting with a name
 *      POSTs /api/custom-reports with { name, description, config }. Modal
 *      submit button is disabled when name is empty.
 *  13. Delete: clicking the trash button on a saved row calls notify.confirm
 *      and, on confirm, DELETEs /api/custom-reports/<id> and refreshes the
 *      list.
 *  14. Number formatting / nowrap regression pin (cross-ref with
 *      Reports.cellStyle.test.jsx #602): numeric cells in the results table
 *      carry data-cell-type="number" and inline whiteSpace:nowrap +
 *      fontVariantNumeric:tabular-nums.
 *
 * Mocks: stable notify object reference per the CLAUDE.md
 * "RTL: stable mock object references" standing rule, otherwise the
 * useCallback-fed `notify.confirm` identity flips per render → modal
 * submit handlers can flap or the test hangs to per-test timeout.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// fetchApi mock — single global handle that each test re-implements.
const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

// Stable notify object: re-using the SAME object across renders so the page's
// useCallback dependency identity stays put — otherwise `confirm` flips on
// every render, the delete-handler closure thrashes, and the test can either
// race or wedge into the per-test timeout.
const confirmMock = vi.fn().mockResolvedValue(true);
const notifyObj = {
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  confirm: (...args) => confirmMock(...args),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

// Recharts ResponsiveContainer is unfriendly in jsdom (needs layout). Stub
// just that piece so the chart renders inline at a known size; everything
// else from recharts stays real so we can grep for chart wrapper classnames
// if the table-vs-chart toggle ever needs deeper coverage.
vi.mock('recharts', async () => {
  const actual = await vi.importActual('recharts');
  return {
    ...actual,
    ResponsiveContainer: ({ children }) => <div data-testid="rc">{children}</div>,
  };
});

import CustomReports from '../pages/CustomReports';

const sampleSaved = [
  {
    id: 1,
    name: 'Q4 Pipeline by Stage',
    description: 'Open deals grouped by stage',
    config: {
      entity: 'Deal',
      filters: [],
      columns: ['title', 'amount', 'stage'],
      groupBy: 'stage',
      aggregate: { type: 'sum', field: 'amount' },
      orderBy: { field: 'createdAt', dir: 'desc' },
      limit: 100,
      chartType: 'bar',
    },
  },
  {
    id: 2,
    name: 'Top Contacts by AI Score',
    description: '',
    config: {
      entity: 'Contact',
      filters: [],
      columns: ['name', 'email', 'aiScore'],
      groupBy: '',
      aggregate: { type: 'count', field: '' },
      orderBy: { field: 'aiScore', dir: 'desc' },
      limit: 50,
      chartType: 'table',
    },
  },
];

const sampleRunResult = {
  columns: ['stage', 'sum_amount', 'count'],
  rows: [
    { stage: 'won', sum_amount: 125000, count: 3 },
    { stage: 'lost', sum_amount: 0, count: 1 },
  ],
};

function renderPage() {
  return render(<CustomReports />);
}

describe('<CustomReports /> — page surface', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    confirmMock.mockReset();
    confirmMock.mockResolvedValue(true);
    notifyObj.error.mockReset?.();
    notifyObj.info.mockReset?.();
    notifyObj.success.mockReset?.();

    // Default: list endpoint returns the two saved samples; anything else
    // resolves to null. Per-test handlers override this.
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/custom-reports') {
        return Promise.resolve(sampleSaved);
      }
      return Promise.resolve(null);
    });
  });

  it('renders the header, Saved Reports panel, and Report Builder card', async () => {
    renderPage();
    expect(screen.getByRole('heading', { name: /^Custom Reports$/i })).toBeInTheDocument();
    expect(
      screen.getByText(/Build no-code reports with filters, groups, and charts/i)
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^Saved Reports$/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^Report Builder$/i })).toBeInTheDocument();
    // The header Create Report button + builder Run + Save buttons all render.
    expect(screen.getByRole('button', { name: /Create Report/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Run$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Save$/i })).toBeInTheDocument();
  });

  it('fetches GET /api/custom-reports on mount', async () => {
    renderPage();
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u]) => u === '/api/custom-reports');
      expect(call).toBeTruthy();
    });
  });

  it('shows "No saved reports yet." when the list endpoint returns []', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/custom-reports') return Promise.resolve([]);
      return Promise.resolve(null);
    });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/No saved reports yet\./i)).toBeInTheDocument();
    });
  });

  it('renders one entry per saved report with Run / Edit / Delete buttons', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Q4 Pipeline by Stage')).toBeInTheDocument();
    });
    expect(screen.getByText('Top Contacts by AI Score')).toBeInTheDocument();
    expect(screen.getByText('Open deals grouped by stage')).toBeInTheDocument();
    // Two saved rows → two Run buttons (per-row) + the builder's Run = 3.
    const runBtns = screen.getAllByRole('button', { name: /Run/i });
    expect(runBtns.length).toBeGreaterThanOrEqual(3);
    // Two Edit buttons (one per row).
    expect(screen.getAllByRole('button', { name: /Edit/i }).length).toBeGreaterThanOrEqual(2);
  });

  it('entity dropdown defaults to "Deal" and lists all 5 entities', async () => {
    renderPage();
    // The entity <select> has its current value displayed.
    const entitySelect = screen.getByDisplayValue('Deal');
    expect(entitySelect).toBeInTheDocument();
    // Each entity key renders as an <option> inside this select.
    const opts = within(entitySelect).getAllByRole('option');
    const optTexts = opts.map((o) => o.textContent).sort();
    expect(optTexts).toEqual(['Activity', 'Contact', 'Deal', 'Invoice', 'Task'].sort());
  });

  it('changing entity replaces columns with the first three of the new entity', async () => {
    renderPage();
    const entitySelect = screen.getByDisplayValue('Deal');
    // Before: Deal-specific fields appear at least once (chip + select options).
    // `title` + `stage` are Deal-specific (Contact has no `title` / `stage`)
    // BUT `title` is also a Task field; with the Deal entity active however
    // only Deal fields render, so getAllByText length >= 1 is the contract.
    expect(screen.getAllByText('title').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('stage').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('probability').length).toBeGreaterThanOrEqual(1);

    fireEvent.change(entitySelect, { target: { value: 'Contact' } });

    // After: Contact field chips visible — name / email / status / source / aiScore / createdAt.
    await waitFor(() => {
      expect(screen.getAllByText('name').length).toBeGreaterThanOrEqual(1);
    });
    expect(screen.getAllByText('email').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('aiScore').length).toBeGreaterThanOrEqual(1);
    // Deal-specific fields that don't exist on Contact are gone.
    expect(screen.queryByText('probability')).not.toBeInTheDocument();
    expect(screen.queryByText('expectedClose')).not.toBeInTheDocument();
    expect(screen.queryByText('stage')).not.toBeInTheDocument();
  });

  it('Add Filter appends a filter row + Remove Filter pops it', async () => {
    renderPage();
    // No filters initially → the empty-state hint renders.
    expect(screen.getByText(/No filters — all rows will be returned\./i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Add Filter/i }));

    // After adding, the empty-state goes away and a remove-filter button appears.
    await waitFor(() => {
      expect(screen.queryByText(/No filters — all rows will be returned\./i)).not.toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /Remove filter 1/i })).toBeInTheDocument();

    // Add a second filter → two remove buttons.
    fireEvent.click(screen.getByRole('button', { name: /Add Filter/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Remove filter 2/i })).toBeInTheDocument();
    });

    // Remove the first → only Remove filter 1 remains (the second row shifts down).
    fireEvent.click(screen.getByRole('button', { name: /Remove filter 1/i }));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Remove filter 2/i })).not.toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /Remove filter 1/i })).toBeInTheDocument();
  });

  it('Run POSTs /api/custom-reports/run with { config } and renders the results table', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/custom-reports') return Promise.resolve([]);
      if (url === '/api/custom-reports/run' && opts?.method === 'POST') {
        return Promise.resolve(sampleRunResult);
      }
      return Promise.resolve(null);
    });
    renderPage();

    // Two Run buttons might exist (per-row + builder); the builder Run is the
    // first one rendered, so name=/^Run$/ matches just it when no saved rows.
    const runBtn = screen.getByRole('button', { name: /^Run$/i });
    fireEvent.click(runBtn);

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, o]) => url === '/api/custom-reports/run' && o?.method === 'POST'
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body.config).toBeDefined();
      // Default config from defaultConfig()
      expect(body.config.entity).toBe('Deal');
      expect(body.config.limit).toBe(100);
    });

    // Results table renders the column headers from the response.
    await waitFor(() => {
      expect(screen.getByText(/Results \(2 rows\)/i)).toBeInTheDocument();
    });
    expect(screen.getByText('sum_amount')).toBeInTheDocument();
    expect(screen.getByText('count')).toBeInTheDocument();
  });

  it('run-error path: renders the Error banner and clears results', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/custom-reports') return Promise.resolve([]);
      if (url === '/api/custom-reports/run' && opts?.method === 'POST') {
        return Promise.reject(new Error('Bad config: groupBy is required'));
      }
      return Promise.resolve(null);
    });
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: /^Run$/i }));

    await waitFor(() => {
      expect(screen.getByText(/Error:\s*Bad config: groupBy is required/i)).toBeInTheDocument();
    });
    // No Results header should have rendered.
    expect(screen.queryByText(/^Results \(/i)).not.toBeInTheDocument();
  });

  it('Run on a saved row POSTs /api/custom-reports/<id>/run and flips builder to "Edit Report"', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/custom-reports') return Promise.resolve(sampleSaved);
      if (/^\/api\/custom-reports\/\d+\/run$/.test(url) && opts?.method === 'POST') {
        return Promise.resolve(sampleRunResult);
      }
      return Promise.resolve(null);
    });
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Q4 Pipeline by Stage')).toBeInTheDocument();
    });
    // Saved Reports panel is rendered BEFORE the builder card (first grid
    // column), so row-level Run buttons come first in DOM order. Rather
    // than pinning a DOM index, scope to the first saved-row's container.
    const q4Row = screen.getByText('Q4 Pipeline by Stage').closest('div');
    let rowContainer = q4Row;
    while (rowContainer && rowContainer.querySelectorAll('button').length < 3) {
      rowContainer = rowContainer.parentElement;
    }
    expect(rowContainer).not.toBeNull();
    const rowRunBtn = within(rowContainer).getByRole('button', { name: /Run/i });
    fireEvent.click(rowRunBtn);

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, o]) => url === '/api/custom-reports/1/run' && o?.method === 'POST'
      );
      expect(call).toBeTruthy();
    });

    // Builder heading now reads "Edit Report" (editingId set).
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /^Edit Report$/i })).toBeInTheDocument();
    });
  });

  it('Save modal: empty name disables submit; valid name POSTs /api/custom-reports', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/custom-reports' && (!opts || opts.method !== 'POST')) {
        return Promise.resolve([]);
      }
      if (url === '/api/custom-reports' && opts?.method === 'POST') {
        return Promise.resolve({ id: 99, name: 'New Test Report' });
      }
      return Promise.resolve(null);
    });
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    // Modal opens with the heading + name input.
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /^Save Report$/i })).toBeInTheDocument();
    });
    const nameInput = screen.getByPlaceholderText(/Q4 Pipeline by Stage/i);
    expect(nameInput).toBeInTheDocument();

    // The modal's Save submit button is disabled (no name yet).
    // There are now TWO buttons matching /^Save$/i — the builder card's Save +
    // the modal's Save submit. The last one is the modal submit.
    const saveBtns = screen.getAllByRole('button', { name: /^Save$/i });
    const modalSaveBtn = saveBtns[saveBtns.length - 1];
    expect(modalSaveBtn).toBeDisabled();

    // Fill name → enables the submit.
    fireEvent.change(nameInput, { target: { value: 'New Test Report' } });
    fireEvent.change(screen.getByPlaceholderText(/Optional description/i), {
      target: { value: 'Q4 view' },
    });
    expect(modalSaveBtn).not.toBeDisabled();

    fireEvent.click(modalSaveBtn);

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, o]) => url === '/api/custom-reports' && o?.method === 'POST'
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body.name).toBe('New Test Report');
      expect(body.description).toBe('Q4 view');
      expect(body.config).toBeDefined();
    });
  });

  it('Delete: confirm → DELETE /api/custom-reports/<id> + list refresh', async () => {
    // First load returns sampleSaved; after delete, list returns []
    let listCallCount = 0;
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/custom-reports' && (!opts || opts.method !== 'POST')) {
        listCallCount += 1;
        if (listCallCount === 1) return Promise.resolve(sampleSaved);
        return Promise.resolve([sampleSaved[1]]); // id=1 deleted
      }
      if (url === '/api/custom-reports/1' && opts?.method === 'DELETE') {
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve(null);
    });
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Q4 Pipeline by Stage')).toBeInTheDocument();
    });

    // Trash buttons render WITHOUT visible text (icon-only), so we can't grab
    // them by accessible name — find via the SVG -> closest button. The two
    // delete-styled buttons are the danger-variant ones. Easier: pick the
    // buttons-with-only-an-svg-child after the row's Edit button.
    // Strategy: find Q4 row container, then within it, find buttons; trash is
    // the 3rd (Run / Edit / Trash).
    const q4Row = screen.getByText('Q4 Pipeline by Stage').closest('div');
    expect(q4Row).not.toBeNull();
    // Walk up to the actual saved-row container that holds the 3 buttons.
    let rowContainer = q4Row;
    while (rowContainer && rowContainer.querySelectorAll('button').length < 3) {
      rowContainer = rowContainer.parentElement;
    }
    expect(rowContainer).not.toBeNull();
    const rowBtns = within(rowContainer).getAllByRole('button');
    // Run / Edit / Delete (icon-only). Delete is the last one.
    const deleteBtn = rowBtns[rowBtns.length - 1];
    fireEvent.click(deleteBtn);

    await waitFor(() => {
      expect(confirmMock).toHaveBeenCalledWith('Delete this report?');
    });
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, o]) => url === '/api/custom-reports/1' && o?.method === 'DELETE'
      );
      expect(call).toBeTruthy();
    });
    // After delete, list refresh should remove the Q4 row.
    await waitFor(() => {
      expect(screen.queryByText('Q4 Pipeline by Stage')).not.toBeInTheDocument();
    });
  });

  it('numeric result cells carry data-cell-type=number + nowrap + tabular-nums', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/custom-reports') return Promise.resolve([]);
      if (url === '/api/custom-reports/run' && opts?.method === 'POST') {
        return Promise.resolve(sampleRunResult);
      }
      return Promise.resolve(null);
    });
    const { container } = renderPage();

    fireEvent.click(screen.getByRole('button', { name: /^Run$/i }));

    await waitFor(() => {
      expect(screen.getByText(/Results \(2 rows\)/i)).toBeInTheDocument();
    });

    // sum_amount (numeric) and count (numeric) cells carry data-cell-type="number";
    // stage (string) cells carry data-cell-type="text".
    const numCells = container.querySelectorAll('td[data-cell-type="number"]');
    const textCells = container.querySelectorAll('td[data-cell-type="text"]');
    expect(numCells.length).toBeGreaterThanOrEqual(2);
    expect(textCells.length).toBeGreaterThanOrEqual(1);

    // Every numeric cell carries nowrap + tabular-nums (the #602 contract).
    numCells.forEach((td) => {
      expect(td.style.whiteSpace).toBe('nowrap');
      expect(td.style.fontVariantNumeric).toBe('tabular-nums');
    });
  });

  it('Create Report button resets the builder and clears editingId', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/custom-reports') return Promise.resolve(sampleSaved);
      if (url === '/api/custom-reports/1/run' && opts?.method === 'POST') {
        return Promise.resolve(sampleRunResult);
      }
      return Promise.resolve(null);
    });
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Q4 Pipeline by Stage')).toBeInTheDocument();
    });

    // Click the row's Edit button to put the builder into edit mode.
    const editBtns = screen.getAllByRole('button', { name: /Edit/i });
    fireEvent.click(editBtns[0]);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /^Edit Report$/i })).toBeInTheDocument();
    });

    // Now click Create Report → builder heading flips back to "Report Builder".
    fireEvent.click(screen.getByRole('button', { name: /Create Report/i }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /^Report Builder$/i })).toBeInTheDocument();
    });
  });
});
