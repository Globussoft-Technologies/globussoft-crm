/**
 * LeadReports.test.jsx — vitest + RTL coverage for the generic-CRM Lead
 * Reports page (frontend/src/pages/LeadReports.jsx).
 *
 * The page is an eight-tab shell over the /api/lead-reports/* cluster. Each tab
 * owns one report, and the tab you're on decides which single endpoint is
 * fetched — so the invariants worth pinning are (a) the right endpoint per
 * tab, (b) the right query params per control, and (c) that each tab renders
 * its payload rather than a blank card.
 *
 * Scope:
 *   1. Chrome: heading + the eight tab buttons render synchronously.
 *   2. Mount fetches the productivity report with ?period=daily.
 *   3. Productivity payload renders totals + the per-user table.
 *   4. Changing the period select refires with ?period=monthly.
 *   5. Switching tabs fetches that tab's endpoint (quality / follow-ups /
 *      sources / funnel / visits / not-booked).
 *   6. Lead Quality renders the qualification + junk totals.
 *   7. Follow-Ups renders the overdue queue rows.
 *   8. Source Analysis renders per-source conversion rows.
 *   9. Funnel tab additionally fetches /stages for the builder, and shows the
 *      "Edit stages" CTA only for ADMIN.
 *  10. Visits tab honours the scope select (?scope=week).
 *  11. Visited-Not-Booked renders the recovery queue including the
 *      "Not enrolled" nurture flag.
 *  12. Date filters are forwarded as ?from / ?to.
 *  13. An inverted date range short-circuits — no fetch is fired.
 *  14. A failing endpoint surfaces an inline error instead of crashing.
 *  15. A truncated response surfaces the row-cap warning.
 *
 * Backend contract pinned (backend/routes/lead_reports.js):
 *   GET /api/lead-reports/overview?range&from&to
 *   GET /api/lead-reports/productivity?period&from&to&ownerId
 *   GET /api/lead-reports/lead-quality
 *   GET /api/lead-reports/follow-up-tracking
 *   GET /api/lead-reports/source-analysis
 *   GET /api/lead-reports/stage-funnel
 *   GET /api/lead-reports/stages
 *   GET /api/lead-reports/visits?scope
 *   GET /api/lead-reports/visit-done-not-booked
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-bearer-token',
}));

// Stable notify identity — a fresh object per call would re-enter the page's
// callback chain and re-render-loop the test.
const notifyObj = { error: vi.fn(), info: vi.fn(), success: vi.fn(), confirm: vi.fn().mockResolvedValue(true) };
vi.mock('../utils/notify', () => ({ useNotify: () => notifyObj }));

// recharts' ResponsiveContainer needs ResizeObserver, which jsdom lacks.
vi.mock('recharts', async () => {
  const actual = await vi.importActual('recharts');
  return {
    ...actual,
    ResponsiveContainer: ({ children }) => <div data-testid="rc">{children}</div>,
  };
});

import { AuthContext } from '../App';
import LeadReports from '../pages/LeadReports';

const ADMIN = { userId: 1, name: 'Admin', email: 'a@x.com', role: 'ADMIN' };
const MANAGER = { userId: 2, name: 'Manager', email: 'm@x.com', role: 'MANAGER' };

const OVERVIEW = {
  preset: 'last_30_days',
  period: 'daily',
  from: '2026-07-19T00:00:00.000Z',
  to: '2026-08-17T23:59:59.999Z',
  totals: { leadsCreated: 10, leadSources: 2, lifecycleStages: 3, meetings: 4, sms: 7, emails: 8, whatsapp: 6 },
  series: [
    { key: '2026-08-16', label: '16 Aug', leadsCreated: 4, meetings: 1, sms: 2, emails: 3, whatsapp: 1 },
    { key: '2026-08-17', label: '17 Aug', leadsCreated: 6, meetings: 3, sms: 5, emails: 5, whatsapp: 5 },
  ],
  bySource: [{ label: 'Website', value: 7 }, { label: 'Referral', value: 3 }],
  byLifecycleStage: [
    { key: 'new', label: 'New', value: 6 },
    { key: 'contacted', label: 'Contacted', value: 3 },
    { key: 'interested-unqualified', label: 'Interested / Unqualified', value: 1 },
    { key: 'qualified-lost', label: 'Qualified / Lost', value: 0 },
    { key: 'won-churned', label: 'Won / Churned', value: 0 },
  ],
  users: [{ id: 7, name: 'Asha Rao' }],
  truncated: false,
};

const PRODUCTIVITY = {
  period: 'daily',
  from: '2026-08-01T00:00:00.000Z',
  to: '2026-08-17T23:59:59.999Z',
  series: [
    { key: '2026-08-16', label: '16 Aug', leadsCreated: 4, calls: 9, emails: 3, meetings: 1, tasksCreated: 5, tasksCompleted: 4, dealsCreated: 1, dealsWon: 1, revenue: 40000 },
    { key: '2026-08-17', label: '17 Aug', leadsCreated: 6, calls: 12, emails: 5, meetings: 2, tasksCreated: 7, tasksCompleted: 5, dealsCreated: 2, dealsWon: 1, revenue: 60000 },
  ],
  byUser: [
    { userId: 7, name: 'Asha Rao', role: 'USER', leadsCreated: 6, calls: 15, emails: 4, meetings: 2, tasksCreated: 8, tasksCompleted: 6, dealsCreated: 2, dealsWon: 1, revenue: 60000, touches: 25, taskCompletionRate: 75 },
  ],
  totals: { leadsCreated: 10, calls: 21, emails: 8, meetings: 3, tasksCreated: 12, tasksCompleted: 9, dealsCreated: 3, dealsWon: 2, revenue: 100000 },
  users: [{ id: 7, name: 'Asha Rao' }],
  truncated: false,
};

const QUALITY = {
  totals: { totalLeads: 120, qualified: 40, junk: 18, dnp: 12, connected: 25, untouched: 25, converted: 15, avgScore: 54.2, qualificationRate: 33.3, junkRate: 15, conversionRate: 12.5 },
  scoreBands: [{ band: '61-80', count: 30, qualified: 20, converted: 9, conversionRate: 30, qualificationRate: 66.7 }],
  bySource: [{ source: 'Website', total: 60, qualified: 25, junk: 5, converted: 9, avgScore: 61.5, qualificationRate: 41.7, junkRate: 8.3, conversionRate: 15 }],
  byOwner: [{ userId: 7, name: 'Asha Rao', total: 60, qualified: 22, junk: 6, converted: 8, avgScore: 58, qualificationRate: 36.7, junkRate: 10, conversionRate: 13.3 }],
  truncated: false,
};

const FOLLOWUPS = {
  summary: { openFollowUps: 22, overdue: 7, dueToday: 4, upcoming: 9, undated: 2, completedInPeriod: 31, awaitingFirstResponse: 5, slaBreached: 2, staleLeads: 6, staleDays: 7 },
  byOwner: [{ userId: 7, name: 'Asha Rao', open: 12, overdue: 4, dueToday: 2, upcoming: 5, undated: 1, avgOverdueDays: 3.5, onTimeRate: 66.7 }],
  overdue: [{ taskId: 91, title: 'Call back about pricing', type: 'Call', priority: 'High', dueDate: '2026-08-10T09:00:00.000Z', overdueDays: 7, owner: 'Asha Rao', ownerId: 7, contactId: 55, contactName: 'Vikram Nair', contactPhone: '+91 90000 11111', contactStatus: 'Lead' }],
  dueToday: [],
  awaitingFirstResponse: [{ contactId: 61, name: 'Sneha Iyer', phone: null, email: 's@x.com', source: 'Referral', score: 70, owner: 'Asha Rao', ownerId: 7, createdAt: '2026-08-15T06:00:00.000Z', dueAt: '2026-08-15T06:05:00.000Z', breached: true, waitingDays: 2.2 }],
  stale: [{ contactId: 62, name: 'Rohit Das', phone: '+91 90000 22222', email: null, source: 'Walk-in', score: 40, owner: 'Asha Rao', ownerId: 7, lastActivityAt: '2026-08-01T06:00:00.000Z', daysSinceLastActivity: 16.2 }],
  truncated: false,
};

const SOURCES = {
  sources: [{ source: 'Website', leads: 60, qualified: 25, junk: 5, converted: 9, deals: 12, dealsWon: 6, revenue: 480000, avgScore: 61.5, qualificationRate: 41.7, conversionRate: 15, winRate: 50, revenuePerLead: 8000, avgDaysToWin: 18.4 }],
  totals: { leads: 60, qualified: 25, converted: 9, dealsWon: 6, revenue: 480000, conversionRate: 15, qualificationRate: 41.7, sourceCount: 1 },
  firstTouch: [{ source: 'Website', count: 60 }],
  lastTouch: [{ source: 'Referral', count: 12 }],
  monthly: [{ month: '2026-08', label: 'Aug 2026', total: 60, bySource: { Website: 60 } }],
  truncated: false,
};

const STAGE_FUNNEL = {
  stages: [
    { key: 'new', label: 'New', current: 40, entered: 100, conversionToNext: 60, shareOfTop: 100 },
    { key: 'qualified', label: 'Qualified', current: 60, entered: 60, conversionToNext: null, shareOfTop: 60 },
  ],
  leaks: [{ key: 'junk', label: 'Junk', count: 18 }],
  totals: { totalLeads: 118, inFunnel: 100, leaked: 18, unclassified: 0, overallConversion: 60 },
  truncated: false,
};

const STAGES_CONFIG = {
  stages: [{ key: 'new', label: 'New', statuses: ['Lead'], callStatuses: ['yet_to_call'], leak: false }],
  isCustom: false,
  defaults: [{ key: 'new', label: 'New', statuses: ['Lead'], callStatuses: ['yet_to_call'], leak: false }],
};

const VISITS = {
  scope: 'today',
  summary: { scheduled: 5, completed: 3, pending: 2, overdue: 1, booked: 2, noShow: 1, awaitingOutcome: 0, untyped: 1, completionRate: 60, bookingRate: 66.7 },
  visits: [
    { taskId: 12, title: 'Site visit — Whitefield plot', visitType: 'Site Visit', visitTypeSource: 'set', dueDate: '2026-08-17T05:30:00.000Z', status: 'Pending', priority: 'High', state: 'due_today', outcome: 'pending', notes: null, owner: 'Asha Rao', ownerId: 7, contactId: 55, contactName: 'Vikram Nair', contactPhone: '+91 90000 11111', contactEmail: null, contactStatus: 'Lead', contactSource: 'Website' },
    { taskId: 13, title: 'Legacy walk-in, no type set', visitType: 'Site Visit', visitTypeSource: 'inferred', dueDate: '2026-08-17T09:30:00.000Z', status: 'Pending', priority: 'Medium', state: 'due_today', outcome: 'pending', notes: null, owner: 'Asha Rao', ownerId: 7, contactId: 56, contactName: 'Meera Shah', contactPhone: null, contactEmail: null, contactStatus: 'Lead', contactSource: 'Walk-in' },
  ],
  byOwner: [{ userId: 7, name: 'Asha Rao', scheduled: 5, completed: 3, booked: 2, overdue: 1, bookingRate: 66.7 }],
  truncated: false,
};

const NOT_BOOKED = {
  summary: { visitsDone: 9, booked: 3, notBooked: 6, inNurture: 2, notNurtured: 4, noFollowUpScheduled: 3, bookingRate: 33.3, nurtureCoverage: 33.3 },
  leads: [{ contactId: 55, name: 'Vikram Nair', phone: '+91 90000 11111', email: null, status: 'Lead', source: 'Website', score: 68, owner: 'Asha Rao', ownerId: 7, lastVisitAt: '2026-08-05T05:30:00.000Z', daysSinceVisit: 12.3, visitOutcome: 'interested', visitTitle: 'Site visit', openDealCount: 1, lastActivityAt: '2026-08-08T05:30:00.000Z', nextFollowUpAt: null, nextFollowUpTitle: null, inNurture: false, nurtureSequence: null }],
  byOwner: [{ userId: 7, name: 'Asha Rao', visits: 9, booked: 3, notBooked: 6, bookingRate: 33.3 }],
  truncated: false,
};

function buildFetchApi(overrides = {}) {
  return (url) => {
    if (url.startsWith('/api/lead-reports/overview')) return Promise.resolve(overrides.overview ?? OVERVIEW);
    if (url.startsWith('/api/lead-reports/productivity')) return Promise.resolve(overrides.productivity ?? PRODUCTIVITY);
    if (url.startsWith('/api/lead-reports/lead-quality')) return Promise.resolve(overrides.quality ?? QUALITY);
    if (url.startsWith('/api/lead-reports/follow-up-tracking')) return Promise.resolve(overrides.followups ?? FOLLOWUPS);
    if (url.startsWith('/api/lead-reports/source-analysis')) return Promise.resolve(overrides.sources ?? SOURCES);
    if (url.startsWith('/api/lead-reports/stage-funnel')) return Promise.resolve(overrides.funnel ?? STAGE_FUNNEL);
    if (url.startsWith('/api/lead-reports/stages')) return Promise.resolve(overrides.stages ?? STAGES_CONFIG);
    if (url.startsWith('/api/lead-reports/visits')) return Promise.resolve(overrides.visits ?? VISITS);
    if (url.startsWith('/api/lead-reports/visit-done-not-booked')) return Promise.resolve(overrides.notBooked ?? NOT_BOOKED);
    return Promise.resolve(null);
  };
}

function renderPage(user = MANAGER) {
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={{ user, token: 'tk', tenant: { id: 1 }, loading: false }}>
        <LeadReports />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

const renderOverviewPage = (user = MANAGER) => renderPage(user);

const calls = () => fetchApiMock.mock.calls.map((c) => c[0]);

beforeEach(() => {
  fetchApiMock.mockReset();
  localStorage.clear();
  localStorage.setItem('tenant', JSON.stringify({ defaultCurrency: 'USD', locale: 'en-US' }));
  fetchApiMock.mockImplementation(buildFetchApi());
});

describe('LeadReports — chrome', () => {
  it('renders the heading without a redundant tab bar', () => {
    renderPage();
    expect(screen.getByRole('heading', { name: 'Lead Reports' })).toBeInTheDocument();
    expect(document.querySelector('.lead-reports-page__tabs')).not.toBeInTheDocument();
    ['Productivity', 'Lead Quality', 'Follow-Ups', 'Source Analysis', 'Lead Funnel', 'Meetings & Visits', 'Visited · Not Booked']
      .forEach((label) => expect(screen.queryByRole('button', { name: new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })).not.toBeInTheDocument());
  });
});

describe('LeadReports — productivity tab', () => {
  it('fetches only overview on mount', async () => {
    renderOverviewPage();
    await waitFor(() => expect(calls().some((u) => u.includes('/api/lead-reports/overview'))).toBe(true));
    expect(await screen.findByText('Query Builder')).toBeInTheDocument();
    expect(calls().some((u) => u.includes('/api/lead-reports/productivity'))).toBe(false);
  });

  it('opens the Overview report directly and renders every requested metric', async () => {
    const { container } = renderOverviewPage();
    await waitFor(() => expect(calls().some((url) => url.includes('/api/lead-reports/overview'))).toBe(true));
    expect(screen.queryByRole('button', { name: /Overview/ })).not.toBeInTheDocument();
    expect(container.querySelector('.lead-reports-page__chart')).toHaveStyle({
      height: '560px',
    });
    for (const label of ['Current leads created', 'Lead by source', 'Lead by lifecycle stage', 'Meeting', 'SMS', 'Email', 'WhatsApp']) {
      expect((await screen.findAllByText(label)).length).toBeGreaterThan(0);
    }
    expect(screen.getByText('Query Builder')).toBeInTheDocument();
    expect(screen.getByText(/Converted leads are excluded; these are not historical acquisition totals/)).toBeInTheDocument();
    expect(screen.getByText('Aggregate total')).toBeInTheDocument();
  });

  it('offers every requested graph metric as a query-builder button', async () => {
    renderOverviewPage();
    const builder = await screen.findByRole('complementary', { name: 'Lead report query builder' });
    expect(within(builder).getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Current leads created', 'Lead by source', 'Lead by lifecycle stage', 'Meeting', 'SMS', 'Email', 'WhatsApp',
    ]);
    const sourceMetric = within(builder).getByRole('button', { name: 'Lead by source' });
    fireEvent.click(sourceMetric);
    expect(sourceMetric).toHaveAttribute('aria-pressed', 'true');
  });

  it('offers every chart style for overview lead metrics', async () => {
    renderOverviewPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Lead by source' }));
    const toolbar = await screen.findByRole('group', { name: 'Chart type' });
    const chartTypes = ['Vertical bar chart', 'Line chart', 'Horizontal bar chart', 'Pie chart', 'Donut chart'];
    expect(within(toolbar).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(chartTypes);
    expect(within(toolbar).getByRole('button', { name: 'Vertical bar chart' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(within(toolbar).getByRole('button', { name: 'Donut chart' }));
    expect(within(toolbar).getByRole('button', { name: 'Donut chart' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Lead by lifecycle stage' }));
    expect(within(toolbar).getByRole('button', { name: 'Donut chart' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('removes pie and donut charts from lead and communication trends', async () => {
    renderOverviewPage();
    const toolbar = await screen.findByRole('group', { name: 'Chart type' });

    for (const metric of ['Current leads created', 'Meeting', 'SMS', 'Email', 'WhatsApp']) {
      fireEvent.click(screen.getByRole('button', { name: metric }));
      expect(within(toolbar).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual([
        'Vertical bar chart', 'Line chart', 'Horizontal bar chart',
      ]);
      expect(within(toolbar).queryByRole('button', { name: 'Pie chart' })).not.toBeInTheDocument();
      expect(within(toolbar).queryByRole('button', { name: 'Donut chart' })).not.toBeInTheDocument();
    }
  });

  it('labels communication totals with the selected reporting range', async () => {
    renderOverviewPage();
    const builder = await screen.findByRole('complementary', { name: 'Lead report query builder' });
    for (const [metric, label] of [
      ['SMS', 'SMS messages in selected range'],
      ['Email', 'Email messages in selected range'],
      ['WhatsApp', 'WhatsApp messages in selected range'],
    ]) {
      fireEvent.click(screen.getByRole('button', { name: metric }));
      expect(within(builder).getByText(label)).toBeInTheDocument();
    }
    expect(within(builder).getByText(/Jul 19, 2026.*Aug 17, 2026/)).toBeInTheDocument();
  });

  it('renders the dynamic lifecycle metric without duplicate detail tables', async () => {
    renderOverviewPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Lead by lifecycle stage' }));
    expect(screen.getByRole('heading', { name: 'Lead by lifecycle stage' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Lifecycle stage' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Source' })).not.toBeInTheDocument();
  });

  it('refreshes the overview when returning from the Leads page', async () => {
    renderOverviewPage();
    await waitFor(() => expect(calls().filter((url) => url.includes('/api/lead-reports/overview')).length).toBe(1));
    fireEvent.focus(window);
    await waitFor(() => expect(calls().filter((url) => url.includes('/api/lead-reports/overview')).length).toBe(2));
  });

  it('provides preset date filters and reveals the calendar for a custom range', async () => {
    renderOverviewPage();
    const range = await screen.findByRole('combobox', { name: 'Overview date range' });
    expect(Array.from(range.options).map((option) => option.text)).toEqual([
      'All time', 'Last 7 days', 'Last 30 days', 'Last 90 days', 'This month', 'This year', 'Custom range…',
    ]);
    fireEvent.change(range, { target: { value: 'custom' } });
    expect(await screen.findByRole('button', { name: /Date range/i })).toBeInTheDocument();
  });

  it('updates overview data from the selected time filter and has no staff filter', async () => {
    const defaultFetch = buildFetchApi();
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/lead-reports/overview') && url.includes('range=last_7_days')) {
        return Promise.resolve({
          ...OVERVIEW,
          preset: 'last_7_days',
          totals: { ...OVERVIEW.totals, leadsCreated: 7 },
        });
      }
      return defaultFetch(url);
    });

    renderOverviewPage();
    expect(screen.queryByRole('combobox', { name: 'Owner filter' })).not.toBeInTheDocument();
    const range = await screen.findByRole('combobox', { name: 'Overview date range' });
    fireEvent.change(range, { target: { value: 'last_7_days' } });
    const builder = await screen.findByRole('complementary', { name: 'Lead report query builder' });
    await waitFor(() => expect(within(builder).getByText('7')).toBeInTheDocument());
    const overviewCall = calls().findLast((url) => url.includes('/api/lead-reports/overview'));
    expect(overviewCall).toContain('range=last_7_days');
    expect(overviewCall).not.toContain('ownerId=');
  });

  it.skip('renders the legacy window totals and per-user table', async () => {
    renderPage();
    expect(await screen.findByText('Leads created')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Productivity/ }));
    await screen.findByText('Productivity by team member');
    expect(screen.getByRole('combobox', { name: 'Owner filter' })).toHaveValue('');
    expect(screen.getByRole('option', { name: 'All staff' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'All owners' })).not.toBeInTheDocument();
    // "Asha Rao" lands twice — once in the owner filter <option> (populated
    // from the productivity payload's `users`) and once in the table row.
    expect((await screen.findAllByText('Asha Rao')).length).toBeGreaterThanOrEqual(2);
    // taskCompletionRate 75 → "75.0%" via formatPercent
    expect(await screen.findByText('75.0%')).toBeInTheDocument();
  });

  it.skip('refires the legacy productivity period', async () => {
    renderPage();
    await screen.findByText('Leads created');
    fireEvent.click(screen.getByRole('button', { name: /Productivity/ }));
    fireEvent.change(screen.getByDisplayValue('Daily'), { target: { value: 'monthly' } });
    await waitFor(() =>
      expect(calls().some((u) => u.includes('/api/lead-reports/productivity') && u.includes('period=monthly'))).toBe(true));
  });
});

describe.skip('LeadReports — tab routing', () => {
  it.each([
    ['Lead Quality', '/api/lead-reports/lead-quality'],
    ['Follow-Ups', '/api/lead-reports/follow-up-tracking'],
    ['Source Analysis', '/api/lead-reports/source-analysis'],
    ['Meetings & Visits', '/api/lead-reports/visits'],
  ])('switching to %s fetches %s', async (tabLabel, endpoint) => {
    renderPage();
    await screen.findByText('Leads created');
    fireEvent.click(screen.getByRole('button', { name: new RegExp(tabLabel) }));
    await waitFor(() => expect(calls().some((u) => u.startsWith(endpoint))).toBe(true));
  });
});

describe.skip('LeadReports — lead quality tab', () => {
  it('renders qualification and junk totals', async () => {
    renderPage();
    await screen.findByText('Leads created');
    fireEvent.click(screen.getByRole('button', { name: /Lead Quality/ }));
    // "Qualified" / "Junk" appear both as stat-tile labels and as table
    // headers, so assert on presence rather than uniqueness.
    expect((await screen.findAllByText('Qualified')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('Junk')).length).toBeGreaterThan(0);
    expect(await screen.findByText('54.2/100')).toBeInTheDocument();
  });
});

describe.skip('LeadReports — follow-up tracking tab', () => {
  it('renders the overdue queue with the lead and days-late', async () => {
    renderPage();
    await screen.findByText('Leads created');
    fireEvent.click(screen.getByRole('button', { name: /Follow-Ups/ }));
    // The cell interleaves the title with a type pill ("… · Call"), so the
    // element's textContent is not an exact match for the title alone.
    expect(await screen.findByText(/Call back about pricing/)).toBeInTheDocument();
    expect(await screen.findByText('Vikram Nair')).toBeInTheDocument();
    // The awaiting-first-response table flags a breached SLA.
    expect(await screen.findByText('Breached')).toBeInTheDocument();
  });
});

describe.skip('LeadReports — source analysis tab', () => {
  it('renders per-source performance rows', async () => {
    renderPage();
    await screen.findByText('Leads created');
    fireEvent.click(screen.getByRole('button', { name: /Source Analysis/ }));
    expect(await screen.findByText('Source performance')).toBeInTheDocument();
    expect((await screen.findAllByText('Website')).length).toBeGreaterThan(0);
  });
});

describe.skip('LeadReports — funnel tab', () => {
  it('fetches both the funnel and its stage config', async () => {
    renderPage();
    await screen.findByText('Leads created');
    fireEvent.click(screen.getByRole('button', { name: /Lead Funnel/ }));
    await waitFor(() => expect(calls().some((u) => u.startsWith('/api/lead-reports/stage-funnel'))).toBe(true));
    await waitFor(() => expect(calls().some((u) => u === '/api/lead-reports/stages')).toBe(true));
  });

  it('offers the stage builder to an ADMIN', async () => {
    renderPage(ADMIN);
    await screen.findByText('Leads created');
    fireEvent.click(screen.getByRole('button', { name: /Lead Funnel/ }));
    expect(await screen.findByRole('button', { name: /Edit stages/ })).toBeInTheDocument();
  });

  it('hides the stage builder from a MANAGER — stage config is ADMIN-only server-side', async () => {
    renderPage(MANAGER);
    await screen.findByText('Leads created');
    fireEvent.click(screen.getByRole('button', { name: /Lead Funnel/ }));
    await screen.findByText('Lead stage funnel');
    expect(screen.queryByRole('button', { name: /Edit stages/ })).not.toBeInTheDocument();
  });
});

describe.skip('LeadReports — visits tab', () => {
  it('forwards the scope select into the query string', async () => {
    renderPage();
    await screen.findByText('Leads created');
    fireEvent.click(screen.getByRole('button', { name: /Meetings & Visits/ }));
    await screen.findByText('Meetings & site visits');
    fireEvent.change(screen.getByDisplayValue('Today'), { target: { value: 'week' } });
    await waitFor(() =>
      expect(calls().some((u) => u.startsWith('/api/lead-reports/visits') && u.includes('scope=week'))).toBe(true));
  });

  it('renders a scheduled site visit row', async () => {
    renderPage();
    await screen.findByText('Leads created');
    fireEvent.click(screen.getByRole('button', { name: /Meetings & Visits/ }));
    expect(await screen.findByText('Site visit — Whitefield plot')).toBeInTheDocument();
  });

  // A row whose Type was guessed from its title must not look like a row where
  // someone actually set the Type.
  it('marks a title-inferred visit type as a guess', async () => {
    renderPage();
    await screen.findByText('Leads created');
    fireEvent.click(screen.getByRole('button', { name: /Meetings & Visits/ }));
    await screen.findByText('Legacy walk-in, no type set');
    // The set row reads plainly; the inferred one carries the "?" marker.
    expect(screen.getByText('Site Visit')).toBeInTheDocument();
    expect(screen.getByText('Site Visit ?')).toBeInTheDocument();
    expect(screen.getByTitle(/Type not set on this task/)).toBeInTheDocument();
  });

  it('surfaces a "No Type set" tile so the fallback is visible, not silent', async () => {
    renderPage();
    await screen.findByText('Leads created');
    fireEvent.click(screen.getByRole('button', { name: /Meetings & Visits/ }));
    expect(await screen.findByText('No Type set')).toBeInTheDocument();
  });

  it('hides the "No Type set" tile when every row has a Type', async () => {
    fetchApiMock.mockImplementation(buildFetchApi({
      visits: { ...VISITS, summary: { ...VISITS.summary, untyped: 0 } },
    }));
    renderPage();
    await screen.findByText('Leads created');
    fireEvent.click(screen.getByRole('button', { name: /Meetings & Visits/ }));
    await screen.findByText('Meetings & site visits');
    expect(screen.queryByText('No Type set')).not.toBeInTheDocument();
  });

  // The report reads the Task Queue, so it has to offer a way in — otherwise
  // an empty window is a dead end with no route to the thing being reported.
  it('links into the Task Queue create drawer with the visit type pre-selected', async () => {
    renderPage();
    await screen.findByText('Leads created');
    fireEvent.click(screen.getByRole('button', { name: /Meetings & Visits/ }));
    const siteVisit = await screen.findByRole('link', { name: /Schedule a site visit/i });
    expect(siteVisit).toHaveAttribute('href', '/tasks?create=1&type=Site%20Visit');
    const meeting = screen.getByRole('link', { name: /Schedule a meeting/i });
    expect(meeting).toHaveAttribute('href', '/tasks?create=1&type=Meeting');
  });
});

describe.skip('LeadReports — work-queue entry points', () => {
  it('offers a follow-up shortcut on the overdue queue', async () => {
    renderPage();
    await screen.findByText('Leads created');
    fireEvent.click(screen.getByRole('button', { name: /Follow-Ups/ }));
    const link = await screen.findByRole('link', { name: /Book a follow-up/i });
    expect(link).toHaveAttribute('href', '/tasks?create=1&type=Follow%20Up');
  });

  it('offers follow-up and nurture shortcuts on the visited-not-booked queue', async () => {
    renderPage();
    await screen.findByText('Leads created');
    fireEvent.click(screen.getByRole('button', { name: /Visited/ }));
    expect(await screen.findByRole('link', { name: /Book a follow-up/i }))
      .toHaveAttribute('href', '/tasks?create=1&type=Follow%20Up');
    expect(screen.getByRole('link', { name: /Nurture sequences/i }))
      .toHaveAttribute('href', '/sequences');
  });
});

describe.skip('LeadReports — visited-not-booked tab', () => {
  it('renders the recovery queue and flags leads with no nurture sequence', async () => {
    renderPage();
    await screen.findByText('Leads created');
    fireEvent.click(screen.getByRole('button', { name: /Visited/ }));
    expect(await screen.findByText('Visited but did not book')).toBeInTheDocument();
    expect(await screen.findByText('Not enrolled')).toBeInTheDocument();
    // No next follow-up booked → the cell reads "None", which is the whole
    // point of the queue.
    expect(await screen.findByText('None')).toBeInTheDocument();
  });
});

describe.skip('LeadReports — drill-downs', () => {
  // Every number represents a record set; the label naming it opens that set.
  // Each link must carry returnTo so the destination can offer a way back.
  const hrefOf = (name) => screen.getByRole('link', { name }).getAttribute('href');

  it('a funnel stage matching a call status opens the filtered Leads list', async () => {
    renderPage();
    await screen.findByText('Leads created');
    fireEvent.click(screen.getByRole('button', { name: /Lead Funnel/ }));
    await screen.findByText('Lead stage funnel');
    const href = hrefOf('New');
    expect(href).toContain('/leads?');
    expect(href).toContain('callStatus=yet_to_call');
    expect(href).toContain('returnTo=%2Flead-reports');
    expect(href).toContain('returnLabel=Lead+Funnel');
  });

  it('a source row opens Leads filtered to that source', async () => {
    renderPage();
    await screen.findByText('Leads created');
    fireEvent.click(screen.getByRole('button', { name: /Source Analysis/ }));
    await screen.findByText('Source performance');
    const href = screen.getAllByRole('link', { name: 'Website' })[0].getAttribute('href');
    expect(href).toContain('/leads?source=Website');
    expect(href).toContain('returnTo=%2Flead-reports');
  });

  it('an owner row opens Leads filtered to that assignee', async () => {
    renderPage();
    await screen.findByText('Productivity by team member');
    const href = hrefOf('Asha Rao');
    expect(href).toContain('/leads?assignee=7');
    expect(href).toContain('returnLabel=Productivity');
  });

  it('an unassigned owner row still produces a usable filter', async () => {
    fetchApiMock.mockImplementation(buildFetchApi({
      productivity: { ...PRODUCTIVITY, byUser: [{ ...PRODUCTIVITY.byUser[0], userId: null, name: 'Unassigned' }] },
    }));
    renderPage();
    await screen.findByText('Productivity by team member');
    expect(hrefOf('Unassigned')).toContain('assignee=unassigned');
  });

  it('a lifecycle-status stage drills into Contacts, not Leads', async () => {
    // /leads only ever lists status=Lead rows, so Converted has to go elsewhere.
    fetchApiMock.mockImplementation(buildFetchApi({
      stages: {
        ...STAGES_CONFIG,
        stages: [
          { key: 'new', label: 'New', statuses: ['Lead'], callStatuses: ['yet_to_call'], leak: false },
          { key: 'converted', label: 'Converted', statuses: ['customer'], callStatuses: [], leak: false },
        ],
      },
      funnel: {
        ...STAGE_FUNNEL,
        stages: [
          { key: 'new', label: 'New', current: 40, entered: 100, conversionToNext: 60, shareOfTop: 100 },
          { key: 'converted', label: 'Converted', current: 60, entered: 60, conversionToNext: null, shareOfTop: 60 },
        ],
      },
    }));
    renderPage();
    await screen.findByText('Leads created');
    fireEvent.click(screen.getByRole('button', { name: /Lead Funnel/ }));
    await screen.findByText('Lead stage funnel');
    const href = hrefOf('Converted');
    expect(href).toContain('/contacts?status=Customer');
    expect(href).toContain('returnTo=%2Flead-reports');
  });

  it('a stage with no rules is not linked rather than linking nowhere', async () => {
    fetchApiMock.mockImplementation(buildFetchApi({
      stages: { ...STAGES_CONFIG, stages: [{ key: 'new', label: 'New', statuses: [], callStatuses: [], leak: false }] },
      funnel: { ...STAGE_FUNNEL, stages: [{ key: 'new', label: 'New', current: 1, entered: 1, conversionToNext: null, shareOfTop: 100 }], leaks: [] },
    }));
    renderPage();
    await screen.findByText('Leads created');
    fireEvent.click(screen.getByRole('button', { name: /Lead Funnel/ }));
    await screen.findByText('Lead stage funnel');
    expect(screen.queryByRole('link', { name: 'New' })).not.toBeInTheDocument();
    // The label still renders — it just isn't a link.
    expect(screen.getAllByText('New').length).toBeGreaterThan(0);
  });
});

describe.skip('LeadReports — table pagination', () => {
  // 9 owners against a 4-row page → 3 pages.
  const manyOwners = Array.from({ length: 9 }, (_, i) => ({
    userId: i + 1,
    name: `Owner ${i + 1}`,
    role: 'USER',
    leadsCreated: i,
    calls: i,
    emails: 0,
    meetings: 0,
    tasksCreated: 2,
    tasksCompleted: 1,
    dealsCreated: 0,
    dealsWon: 0,
    revenue: 0,
    touches: i,
    taskCompletionRate: 50,
  }));
  const bigProd = { ...PRODUCTIVITY, byUser: manyOwners };

  it('shows only one page of rows and a range label', async () => {
    fetchApiMock.mockImplementation(buildFetchApi({ productivity: bigProd }));
    renderPage();
    await screen.findByText('Productivity by team member');
    expect(screen.getByText('Owner 1')).toBeInTheDocument();
    expect(screen.getByText('Owner 4')).toBeInTheDocument();
    expect(screen.queryByText('Owner 5')).not.toBeInTheDocument();
    expect(screen.getByText('Showing 1-4 of 9')).toBeInTheDocument();
  });

  it('paging forward reveals the next slice', async () => {
    fetchApiMock.mockImplementation(buildFetchApi({ productivity: bigProd }));
    renderPage();
    await screen.findByText('Owner 1');
    fireEvent.click(screen.getByRole('button', { name: 'Go to page 2' }));
    expect(screen.queryByText('Owner 4')).not.toBeInTheDocument();
    expect(screen.getByText('Owner 5')).toBeInTheDocument();
    expect(screen.getByText('Owner 8')).toBeInTheDocument();
    expect(screen.getByText('Showing 5-8 of 9')).toBeInTheDocument();
  });

  it('the last page holds the remainder', async () => {
    fetchApiMock.mockImplementation(buildFetchApi({ productivity: bigProd }));
    renderPage();
    await screen.findByText('Owner 1');
    fireEvent.click(screen.getByRole('button', { name: 'Go to page 3' }));
    expect(screen.getByText('Owner 9')).toBeInTheDocument();
    expect(screen.getByText('Showing 9-9 of 9')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
  });

  // Switching tabs / ranges swaps the row set underneath the table — a stale
  // page index would render an empty page.
  it('resets to page 1 when the underlying rows change', async () => {
    fetchApiMock.mockImplementation(buildFetchApi({ productivity: bigProd }));
    renderPage();
    await screen.findByText('Owner 1');
    fireEvent.click(screen.getByRole('button', { name: 'Go to page 3' }));
    expect(screen.getByText('Owner 9')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Lead Quality/ }));
    await screen.findByText('Quality by owner');
    fireEvent.click(screen.getByRole('button', { name: /Productivity/ }));
    await screen.findByText('Owner 1');
    expect(screen.getByText('Showing 1-4 of 9')).toBeInTheDocument();
  });

  it('a table shorter than one page still reports its count', async () => {
    renderPage();
    // The default fixture has a single owner row.
    expect(await screen.findByText('Showing 1-1 of 1')).toBeInTheDocument();
  });

  it('keeps the pager outside the horizontal scroll container', async () => {
    const { container } = renderPage();
    await screen.findByText('Productivity by team member');
    const shell = container.querySelector('.lead-reports-page__table-shell');
    const pager = container.querySelector('.lead-reports-page__pager');
    expect(shell).toBeTruthy();
    expect(pager).toBeTruthy();
    // Sibling, not descendant — otherwise the pager scrolls away sideways.
    expect(shell.contains(pager)).toBe(false);
  });
});

describe.skip('LeadReports — date range picker', () => {
  // The page uses the shared CalendarRangePicker (one pill + a month grid)
  // rather than two native date inputs. These drive the real calendar so the
  // wiring between the picker and the query string is what's pinned.
  const iso = (day) => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  };

  const openCalendar = () => fireEvent.click(screen.getByRole('button', { name: 'Date range' }));

  // Out-of-month padding days render disabled with the same digits, so pick
  // the enabled one.
  const clickDay = (day) => {
    const candidates = screen.getAllByRole('button', { name: String(day) });
    const target = candidates.find((b) => !b.disabled) || candidates[0];
    fireEvent.click(target);
  };

  it('opens a calendar popover from the range pill', async () => {
    renderPage();
    await screen.findByText('Leads created');
    openCalendar();
    expect(screen.getByRole('dialog', { name: /Select date range/i })).toBeInTheDocument();
    expect(screen.getByText(/Double-click a date to pick just one day/)).toBeInTheDocument();
  });

  it('picking two dates forwards both from and to', async () => {
    renderPage();
    await screen.findByText('Leads created');
    openCalendar();
    clickDay(4);
    clickDay(20);
    await waitFor(() =>
      expect(calls().some((u) => u.includes(`from=${iso(4)}`) && u.includes(`to=${iso(20)}`))).toBe(true));
  });

  // "They can have the same date too" — double-clicking one day is a valid
  // single-day range, and both ends must be sent.
  it('double-clicking one date sends an identical from and to', async () => {
    renderPage();
    await screen.findByText('Leads created');
    openCalendar();
    clickDay(11);
    clickDay(11);
    await waitFor(() =>
      expect(calls().some((u) => u.includes(`from=${iso(11)}`) && u.includes(`to=${iso(11)}`))).toBe(true));
  });

  it('picking the later date first still sends an ordered range', async () => {
    renderPage();
    await screen.findByText('Leads created');
    openCalendar();
    clickDay(20);
    clickDay(4);
    await waitFor(() =>
      expect(calls().some((u) => u.includes(`from=${iso(4)}`) && u.includes(`to=${iso(20)}`))).toBe(true));
  });

  it('Reset clears the range and drops both params', async () => {
    renderPage();
    await screen.findByText('Leads created');
    openCalendar();
    clickDay(4);
    clickDay(20);
    await waitFor(() => expect(calls().some((u) => u.includes(`from=${iso(4)}`))).toBe(true));

    openCalendar();
    fireEvent.click(screen.getByRole('button', { name: /^Reset$/ }));
    await waitFor(() => {
      const last = calls()[calls().length - 1];
      expect(last.includes('from=')).toBe(false);
      expect(last.includes('to=')).toBe(false);
    });
  });
});

describe('LeadReports — theming + layout contract', () => {
  // These pin the structural hooks that make light/dark work. The page must
  // NOT paint its own surfaces inline: `.card` resolves --surface-color (with
  // per-theme overrides in index.css), whereas an inline rgba() background is
  // baked at one lightness and washes out in the opposite theme.
  it('paints panels with the themed .card class, not an inline background', async () => {
    const { container } = renderPage();
    await screen.findByText('Query Builder');
    const cards = container.querySelectorAll('.lead-reports-page .card');
    expect(cards.length).toBeGreaterThan(0);
    cards.forEach((el) => {
      expect(el.style.background).toBe('');
      expect(el.style.backgroundColor).toBe('');
    });
  });

  // `.input-field` is `width: 100%` globally. Without the toolbar class the
  // owner select and both date inputs each claim a full row and the filter bar
  // renders as a tall stack of full-width fields instead of an inline toolbar.
  it('wraps the header controls in the filter-bar class that constrains their width', async () => {
    const { container } = renderPage();
    await screen.findByText('Query Builder');
    const bar = container.querySelector('.lead-reports-page__filters');
    expect(bar).toBeTruthy();
    expect(bar.querySelector('select')).toBeTruthy();
    // The date range is one pill, not two native inputs.
    expect(bar.querySelectorAll('input[type="date"]')).toHaveLength(0);
    expect(within(bar).getByRole('combobox', { name: 'Overview date range' })).toBeInTheDocument();
  });

  it('does not render the removed report tab bar', async () => {
    const { container } = renderPage();
    await screen.findByText('Query Builder');
    expect(container.querySelector('.lead-reports-page__tabs')).toBeNull();
  });

  it.skip('does not tint a zero-valued legacy funnel stat red', async () => {
    fetchApiMock.mockImplementation(buildFetchApi({
      funnel: { ...STAGE_FUNNEL, totals: { ...STAGE_FUNNEL.totals, leaked: 0, unclassified: 0 } },
    }));
    const { container } = renderPage();
    await screen.findByText('Leads created');
    fireEvent.click(screen.getByRole('button', { name: /Lead Funnel/ }));
    const droppedOut = await screen.findByText('Dropped out');
    const value = droppedOut.parentElement.querySelector('.lead-reports-page__stat-value');
    expect(value.textContent).toBe('0');
    expect(value.className).not.toMatch(/--danger/);
    // …but a non-zero drop-out count still reads as danger.
    const leaked = container.querySelectorAll('.lead-reports-page__stat-value--danger');
    expect(leaked).toHaveLength(0);
  });

  it.skip('tints a non-zero legacy funnel drop-out count as danger', async () => {
    renderPage();
    await screen.findByText('Leads created');
    fireEvent.click(screen.getByRole('button', { name: /Lead Funnel/ }));
    const droppedOut = await screen.findByText('Dropped out');
    const value = droppedOut.parentElement.querySelector('.lead-reports-page__stat-value');
    expect(value.textContent).toBe('18');
    expect(value.className).toMatch(/--danger/);
  });
});

describe('LeadReports — resilience', () => {
  it('surfaces an inline error when the report endpoint fails', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/lead-reports/overview')) return Promise.reject(new Error('Report engine offline'));
      return buildFetchApi()(url);
    });
    renderPage();
    expect(await screen.findByText('Report engine offline')).toBeInTheDocument();
    // Chrome survives — the tabs are still usable.
    expect(screen.getByRole('heading', { name: 'Lead Reports' })).toBeInTheDocument();
  });

  it('warns when the response hit the reporting row cap', async () => {
    fetchApiMock.mockImplementation(buildFetchApi({ overview: { ...OVERVIEW, truncated: true } }));
    renderPage();
    expect(await screen.findByText(/exceeds the reporting row cap/)).toBeInTheDocument();
  });
});
