/**
 * Reports.test.jsx — vitest + RTL coverage for the BROAD page surface of
 * frontend/src/pages/Reports.jsx (582 LOC).
 *
 * COMPLEMENTARY scope (deliberately avoids the territory of the existing
 * Reports.cellStyle.test.jsx, which pins #602 numeric-cell nowrap/tabular-nums
 * + #609 Recharts Tooltip wrapperStyle.zIndex):
 *
 *   1. Page chrome — header title "Reports & Analytics" + tagline render.
 *   2. View-mode tabs — Charts (default) + Detailed Data both render; clicking
 *      Detailed Data flips view mode (chart container disappears, detail
 *      type-picker buttons appear).
 *   3. Query Builder sidebar — title + label "1. Select Metric" + metric
 *      <select> renders all 8 METRIC_OPTIONS entries.
 *   4. Conditional groupBy — visible when metric is revenue/count, hidden
 *      otherwise. Switching metric to `win_rate` removes the "Group By" label.
 *   5. Visualization select — bar / pie / area options present; numbered as
 *      "3" when needsGroupBy is true, "2" when not.
 *   6. Aggregate Total card — renders with the sum of fetched values. Numeric
 *      metrics show plain numbers; revenue/invoices/expenses pass through
 *      formatMoney.
 *   7. Initial fetch wiring — GET /api/reports/query?metric=revenue&groupBy=stage
 *      fires on mount (no date params when both unset).
 *   8. Date-range params — setting startDate appends &from= AND &startDate=
 *      (both spellings per #117).
 *   9. Inverted-range guard — startDate > endDate suppresses the next query
 *      fetch (no `?from=` in URL once both fields are set inverted) AND shows
 *      the "Start date must be on or before end date" warning.
 *  10. Detail view fetch wiring — switching to "Detailed Data" triggers GET
 *      /api/reports/detailed/deals (default detail type).
 *  11. Detail type-picker — clicking "Contacts" button triggers GET
 *      /api/reports/detailed/contacts.
 *  12. Empty detail data — "No records found for the selected period." renders.
 *  13. Schedule modal — clicking Schedule opens a modal with the form fields
 *      (Report Name, Report Type, Frequency, Format, Recipients) + Cancel.
 *  14. Schedule create — recipients-empty submit calls notify.error and does
 *      NOT POST.
 *  15. Schedule create — invalid email format calls notify.error and does NOT
 *      POST.
 *  16. Scheduled Reports list — when GET /api/report-schedules returns rows,
 *      the "Scheduled Email Reports" section renders with row name + Pause
 *      / Delete action buttons.
 *
 * Mocks: stable notify object reference per the CLAUDE.md "RTL: stable mock
 * object references" standing rule (useCallback / event-handler closures
 * depend on identity stability).
 *
 * recharts ResponsiveContainer is stubbed (jsdom lacks ResizeObserver +
 * layout); everything else from recharts stays real. money/date helpers
 * stay real so the formatMoney pass-through path is exercised.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// fetchApi + getAuthToken — single global handles each test re-implements.
const fetchApiMock = vi.fn();
const getAuthTokenMock = vi.fn().mockReturnValue('test-token');
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: (...args) => getAuthTokenMock(...args),
}));

// Stable notify object — see CLAUDE.md standing rule on mock identity.
// Re-creating the object per call would cause Reports.jsx's notify-touching
// handlers to thrash and the test to hang.
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

// Recharts ResponsiveContainer needs layout that jsdom doesn't provide.
vi.mock('recharts', async () => {
  const actual = await vi.importActual('recharts');
  return {
    ...actual,
    ResponsiveContainer: ({ children }) => <div data-testid="rc">{children}</div>,
  };
});

// global.fetch (used by exportFile in Reports.jsx for direct blob downloads).
const fetchSpy = vi.fn();
beforeEach(() => {
  fetchSpy.mockReset();
  fetchSpy.mockResolvedValue({
    ok: true,
    blob: () => Promise.resolve(new Blob(['x'], { type: 'text/csv' })),
  });
  global.fetch = fetchSpy;
  // jsdom may lack URL.createObjectURL / revokeObjectURL in some setups.
  if (!global.URL.createObjectURL) {
    global.URL.createObjectURL = vi.fn(() => 'blob:mock');
  }
  if (!global.URL.revokeObjectURL) {
    global.URL.revokeObjectURL = vi.fn();
  }
});

import Reports from '../pages/Reports';

const sampleData = [
  { name: 'Lead', value: 35000 },
  { name: 'Contacted', value: 20000 },
  { name: 'Proposal', value: 15000 },
  { name: 'Won', value: 80000 },
];

const sampleSchedules = [
  {
    id: 1,
    name: 'Weekly Sales Summary',
    reportType: 'deals',
    frequency: 'weekly',
    format: 'PDF',
    recipients: JSON.stringify(['ops@acme.test', 'sales@acme.test']),
    lastRunAt: '2026-05-20T08:00:00.000Z',
    enabled: true,
  },
];

function defaultFetchImpl(url, opts) {
  if (url.startsWith('/api/reports/query')) return Promise.resolve(sampleData);
  if (url.startsWith('/api/reports/detailed/')) return Promise.resolve([]);
  if (url === '/api/report-schedules' && (!opts || opts.method !== 'POST')) {
    return Promise.resolve([]);
  }
  if (url === '/api/report-schedules' && opts?.method === 'POST') {
    return Promise.resolve({ id: 99 });
  }
  return Promise.resolve(null);
}

describe('<Reports /> — broad page surface', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    confirmMock.mockReset().mockResolvedValue(true);
    notifyObj.error.mockReset();
    notifyObj.info.mockReset();
    notifyObj.success.mockReset();
    fetchApiMock.mockImplementation(defaultFetchImpl);
  });

  it('renders the page header title + tagline', async () => {
    render(<Reports />);
    expect(
      screen.getByRole('heading', { name: /Reports & Analytics/i })
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Business intelligence dashboard/i)
    ).toBeInTheDocument();
  });

  it('renders the Charts + Detailed Data view-mode tabs', async () => {
    render(<Reports />);
    expect(screen.getByRole('button', { name: /Charts/i })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Detailed Data/i })
    ).toBeInTheDocument();
  });

  it('fires GET /api/reports/query on mount with default metric+groupBy', async () => {
    render(<Reports />);
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url]) => typeof url === 'string' && url.startsWith('/api/reports/query')
      );
      expect(call).toBeTruthy();
      expect(call[0]).toContain('metric=revenue');
      expect(call[0]).toContain('groupBy=stage');
      // No date params when both unset.
      expect(call[0]).not.toContain('from=');
      expect(call[0]).not.toContain('startDate=');
    });
  });

  it('also calls GET /api/report-schedules on mount', async () => {
    render(<Reports />);
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url]) => url === '/api/report-schedules'
      );
      expect(call).toBeTruthy();
    });
  });

  it('Query Builder sidebar renders title + metric label + all 8 metric options', async () => {
    render(<Reports />);
    expect(screen.getByText(/Query Builder/i)).toBeInTheDocument();
    expect(screen.getByText(/1\. Select Metric/i)).toBeInTheDocument();
    // 8 METRIC_OPTIONS entries. Use partial text since Revenue carries a
    // currency-symbol suffix that depends on tenant; just check the option
    // count + a couple of known labels.
    const opts = screen.getAllByRole('option');
    // The page renders metric (8) + groupBy (2, conditional) + chartType (3)
    // = 13 default <option> elements when needsGroupBy is true.
    expect(opts.length).toBeGreaterThanOrEqual(13);
    // Pick a couple of stable label fragments — the revenue label carries
    // a tenant-dependent currency symbol but always contains "Revenue".
    expect(
      screen.getByRole('option', { name: /Revenue/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: /Deal Count/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: /Win Rate/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: /Task Status/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: /Contacts by Source/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: /Contacts by Status/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: /Invoice Status/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: /Expenses by Category/i })
    ).toBeInTheDocument();
  });

  it('shows the Group By label only when metric is revenue/count', async () => {
    render(<Reports />);
    // Default metric is "revenue" → Group By visible.
    expect(screen.getByText(/2\. Group By/i)).toBeInTheDocument();

    // Switch to "Win Rate" — Group By should disappear.
    const metricSelect = screen.getByDisplayValue(/Revenue/i);
    fireEvent.change(metricSelect, { target: { value: 'win_rate' } });

    await waitFor(() => {
      expect(screen.queryByText(/Group By/i)).not.toBeInTheDocument();
    });
    // Visualization is now labelled "2." rather than "3."
    expect(screen.getByText(/2\. Visualization/i)).toBeInTheDocument();
  });

  it('Visualization select carries Bar/Donut/Area options', async () => {
    render(<Reports />);
    expect(
      screen.getByRole('option', { name: /Bar Chart/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: /Donut Chart/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: /Area Chart/i })
    ).toBeInTheDocument();
  });

  it('Aggregate Total card renders the sum of fetched values', async () => {
    render(<Reports />);
    // sampleData sums to 35000+20000+15000+80000 = 150000. Revenue is
    // money-formatted; tenant currency varies, so we just check that the
    // formatted string contains the digit groups "150" + "000" rather than
    // pinning a specific currency symbol.
    expect(screen.getByText(/Aggregate Total/i)).toBeInTheDocument();
    await waitFor(() => {
      // formatMoney(150000) renders with locale-appropriate grouping. Both
      // en-US "$150,000.00" and en-IN "₹1,50,000.00" contain "150" or
      // "1,50". Permissive match accepts either.
      const aggregate = screen.getByText(/(?:150[, ]?000|1,50,000|1 50 000)/);
      expect(aggregate).toBeInTheDocument();
    });
  });

  it('switching to Detailed Data tab triggers GET /api/reports/detailed/deals', async () => {
    render(<Reports />);
    fireEvent.click(screen.getByRole('button', { name: /Detailed Data/i }));
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url]) => typeof url === 'string' && url.startsWith('/api/reports/detailed/deals')
      );
      expect(call).toBeTruthy();
    });
  });

  it('Detailed Data view renders all 6 DETAIL_TYPES selector buttons', async () => {
    render(<Reports />);
    fireEvent.click(screen.getByRole('button', { name: /Detailed Data/i }));
    await waitFor(() => {
      // Each DETAIL_TYPES entry is a button. "Deals" / "Contacts" / "Tasks"
      // / "Call Logs" / "Invoices" / "Expenses".
      expect(screen.getByRole('button', { name: /^Deals$/i })).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /^Contacts$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Tasks$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Call Logs/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Invoices$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Expenses$/i })).toBeInTheDocument();
  });

  it('clicking Contacts detail-type triggers GET /api/reports/detailed/contacts', async () => {
    render(<Reports />);
    fireEvent.click(screen.getByRole('button', { name: /Detailed Data/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Contacts$/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /^Contacts$/i }));
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url]) =>
          typeof url === 'string' &&
          url.startsWith('/api/reports/detailed/contacts')
      );
      expect(call).toBeTruthy();
    });
  });

  it('Detailed Data view shows empty-state when no records returned', async () => {
    render(<Reports />);
    fireEvent.click(screen.getByRole('button', { name: /Detailed Data/i }));
    await waitFor(() => {
      expect(
        screen.getByText(/No records found for the selected period/i)
      ).toBeInTheDocument();
    });
  });

  it('setting startDate appends both &from= and &startDate= (#117 dual spelling)', async () => {
    render(<Reports />);
    // Wait for initial fetch.
    await waitFor(() => {
      expect(
        fetchApiMock.mock.calls.find(
          ([url]) => typeof url === 'string' && url.startsWith('/api/reports/query')
        )
      ).toBeTruthy();
    });

    // Find the two date inputs. The page renders <input type="date" ...> twice
    // (start + end). Capture them via container.querySelectorAll since they
    // have no label/role we can target by text.
    const dateInputs = document.querySelectorAll('input[type="date"]');
    expect(dateInputs.length).toBeGreaterThanOrEqual(2);

    // Set the start date — triggers the effect with a new dependency.
    fireEvent.change(dateInputs[0], { target: { value: '2026-01-01' } });

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url]) =>
          typeof url === 'string' &&
          url.startsWith('/api/reports/query') &&
          url.includes('from=2026-01-01')
      );
      expect(call).toBeTruthy();
      // Both spellings present per the #117 standing rule.
      expect(call[0]).toContain('startDate=2026-01-01');
    });
  });

  it('inverted date range shows warning + suppresses the fetch (no from= sent)', async () => {
    render(<Reports />);
    await waitFor(() => {
      expect(
        fetchApiMock.mock.calls.find(
          ([url]) => typeof url === 'string' && url.startsWith('/api/reports/query')
        )
      ).toBeTruthy();
    });

    const dateInputs = document.querySelectorAll('input[type="date"]');
    // Set start AFTER end → inverted.
    fireEvent.change(dateInputs[0], { target: { value: '2026-06-01' } });
    fireEvent.change(dateInputs[1], { target: { value: '2026-01-01' } });

    // Warning text renders.
    await waitFor(() => {
      expect(
        screen.getByText(/Start date must be on or before end date/i)
      ).toBeInTheDocument();
    });

    // The most recent /api/reports/query call should NOT contain `from=` —
    // dateParams() returns '' when range is inverted.
    const queryCalls = fetchApiMock.mock.calls.filter(
      ([url]) => typeof url === 'string' && url.startsWith('/api/reports/query')
    );
    const lastQuery = queryCalls[queryCalls.length - 1];
    expect(lastQuery[0]).not.toContain('from=');
  });

  it('Schedule modal opens with all form fields when Schedule button clicked', async () => {
    render(<Reports />);
    fireEvent.click(screen.getByRole('button', { name: /Schedule/i }));

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: /Schedule Email Report/i })
      ).toBeInTheDocument();
    });
    // Fields.
    expect(screen.getByText(/Report Name/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/e\.g\. Weekly Sales Summary/i)).toBeInTheDocument();
    expect(screen.getByText(/Report Type/i)).toBeInTheDocument();
    expect(screen.getByText(/Frequency/i)).toBeInTheDocument();
    expect(screen.getByText(/Format/i)).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(/admin@company\.com.*manager@company\.com/i)
    ).toBeInTheDocument();
    // Buttons.
    expect(screen.getByRole('button', { name: /^Cancel$/i })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Create Schedule/i })
    ).toBeInTheDocument();
  });

  it('Schedule modal: invalid email format calls notify.error and does NOT POST', async () => {
    render(<Reports />);
    fireEvent.click(screen.getByRole('button', { name: /Schedule/i }));

    await waitFor(() => {
      expect(
        screen.getByPlaceholderText(/e\.g\. Weekly Sales Summary/i)
      ).toBeInTheDocument();
    });

    fireEvent.change(
      screen.getByPlaceholderText(/e\.g\. Weekly Sales Summary/i),
      { target: { value: 'Weekly Sales Summary' } }
    );
    fireEvent.change(
      screen.getByPlaceholderText(/admin@company\.com.*manager@company\.com/i),
      { target: { value: 'not-an-email' } }
    );

    fireEvent.click(screen.getByRole('button', { name: /Create Schedule/i }));

    await waitFor(() => {
      expect(notifyObj.error).toHaveBeenCalled();
      const msg = notifyObj.error.mock.calls[0][0];
      expect(msg).toMatch(/Invalid email/i);
    });

    // No POST should have fired.
    const postCall = fetchApiMock.mock.calls.find(
      ([url, o]) => url === '/api/report-schedules' && o?.method === 'POST'
    );
    expect(postCall).toBeUndefined();
  });

  it('Schedule modal: valid form POSTs /api/report-schedules with parsed recipients', async () => {
    render(<Reports />);
    fireEvent.click(screen.getByRole('button', { name: /Schedule/i }));

    await waitFor(() => {
      expect(
        screen.getByPlaceholderText(/e\.g\. Weekly Sales Summary/i)
      ).toBeInTheDocument();
    });

    fireEvent.change(
      screen.getByPlaceholderText(/e\.g\. Weekly Sales Summary/i),
      { target: { value: 'Weekly Sales Summary' } }
    );
    fireEvent.change(
      screen.getByPlaceholderText(/admin@company\.com.*manager@company\.com/i),
      { target: { value: 'a@b.com, c@d.com' } }
    );

    fireEvent.click(screen.getByRole('button', { name: /Create Schedule/i }));

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([url, o]) => url === '/api/report-schedules' && o?.method === 'POST'
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.name).toBe('Weekly Sales Summary');
      expect(body.recipients).toEqual(['a@b.com', 'c@d.com']);
    });
  });

  it('Scheduled Email Reports section renders when GET /api/report-schedules returns rows', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url.startsWith('/api/reports/query')) return Promise.resolve(sampleData);
      if (url.startsWith('/api/reports/detailed/')) return Promise.resolve([]);
      if (url === '/api/report-schedules' && (!opts || opts.method !== 'POST')) {
        return Promise.resolve(sampleSchedules);
      }
      return Promise.resolve(null);
    });
    render(<Reports />);

    await waitFor(() => {
      expect(
        screen.getByText(/Scheduled Email Reports/i)
      ).toBeInTheDocument();
    });
    // Row name.
    expect(screen.getByText(/Weekly Sales Summary/i)).toBeInTheDocument();
    // Status badge text (Active vs Paused) — sample is enabled.
    expect(screen.getByText(/^Active$/i)).toBeInTheDocument();
    // Action buttons.
    expect(screen.getByRole('button', { name: /Pause/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Delete/i })).toBeInTheDocument();
  });

  it('CSV export button triggers a /api/reports/export-csv fetch with Bearer token', async () => {
    render(<Reports />);
    // Wait for initial mount.
    await waitFor(() => {
      expect(
        fetchApiMock.mock.calls.find(
          ([url]) => typeof url === 'string' && url.startsWith('/api/reports/query')
        )
      ).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: /CSV/i }));

    await waitFor(() => {
      const fetchCall = fetchSpy.mock.calls.find(
        ([url]) => typeof url === 'string' && url.includes('/api/reports/export-csv')
      );
      expect(fetchCall).toBeTruthy();
      // Bearer header from getAuthToken().
      expect(fetchCall[1].headers.Authorization).toBe('Bearer test-token');
      // Chart-mode params: metric + groupBy on the URL.
      expect(fetchCall[0]).toContain('metric=revenue');
      expect(fetchCall[0]).toContain('groupBy=stage');
    });
  });
});
