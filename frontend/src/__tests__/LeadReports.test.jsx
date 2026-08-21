/**
 * LeadReports.test.jsx — vitest + RTL coverage for the generic-CRM Lead
 * Reports page (frontend/src/pages/LeadReports.jsx).
 *
 * The page is a seven-tab shell over the /api/lead-reports/* cluster. Each tab
 * owns one report, and the tab you're on decides which single endpoint is
 * fetched — so the invariants worth pinning are (a) the right endpoint per
 * tab, (b) the right query params per control, and (c) that each tab renders
 * its payload rather than a blank card.
 *
 * Scope:
 *   1. Chrome: heading + the seven tab buttons render synchronously.
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

const calls = () => fetchApiMock.mock.calls.map((c) => c[0]);

beforeEach(() => {
  fetchApiMock.mockReset();
  localStorage.clear();
  localStorage.setItem('tenant', JSON.stringify({ defaultCurrency: 'USD', locale: 'en-US' }));
  fetchApiMock.mockImplementation(buildFetchApi());
});

describe('LeadReports — chrome', () => {
  it('renders the heading and all seven report tabs', () => {
    renderPage();
    expect(screen.getByRole('heading', { name: 'Lead Reports' })).toBeInTheDocument();
    ['Productivity', 'Lead Quality', 'Follow-Ups', 'Source Analysis', 'Lead Funnel', 'Meetings & Visits', 'Visited · Not Booked']
      .forEach((label) => expect(screen.getByRole('button', { name: new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })).toBeInTheDocument());
  });
});

describe('LeadReports — productivity tab', () => {
  it('fetches the productivity report with the daily period on mount', async () => {
    renderPage();
    await waitFor(() => expect(calls().some((u) => u.includes('/api/lead-reports/productivity'))).toBe(true));
    expect(calls().find((u) => u.includes('productivity'))).toContain('period=daily');
  });

  it('renders the window totals and the per-user table', async () => {
    renderPage();
    expect(await screen.findByText('Leads created')).toBeInTheDocument();
    // "Asha Rao" lands twice — once in the owner filter <option> (populated
    // from the productivity payload's `users`) and once in the table row.
    expect((await screen.findAllByText('Asha Rao')).length).toBeGreaterThanOrEqual(2);
    // taskCompletionRate 75 → "75.0%" via formatPercent
    expect(await screen.findByText('75.0%')).toBeInTheDocument();
  });

  it('refires with period=monthly when the period select changes', async () => {
    renderPage();
    await screen.findByText('Leads created');
    fireEvent.change(screen.getByDisplayValue('Daily'), { target: { value: 'monthly' } });
    await waitFor(() =>
      expect(calls().some((u) => u.includes('/api/lead-reports/productivity') && u.includes('period=monthly'))).toBe(true));
  });
});

describe('LeadReports — tab routing', () => {
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

describe('LeadReports — lead quality tab', () => {
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

describe('LeadReports — follow-up tracking tab', () => {
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

describe('LeadReports — source analysis tab', () => {
  it('renders per-source performance rows', async () => {
    renderPage();
    await screen.findByText('Leads created');
    fireEvent.click(screen.getByRole('button', { name: /Source Analysis/ }));
    expect(await screen.findByText('Source performance')).toBeInTheDocument();
    expect((await screen.findAllByText('Website')).length).toBeGreaterThan(0);
  });
});

describe('LeadReports — funnel tab', () => {
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

describe('LeadReports — visits tab', () => {
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

describe('LeadReports — work-queue entry points', () => {
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

describe('LeadReports — visited-not-booked tab', () => {
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

describe('LeadReports — drill-downs', () => {
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

describe('LeadReports — table pagination', () => {
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

describe('LeadReports — date range picker', () => {
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
    await screen.findByText('Leads created');
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
    await screen.findByText('Leads created');
    const bar = container.querySelector('.lead-reports-page__filters');
    expect(bar).toBeTruthy();
    expect(bar.querySelector('select')).toBeTruthy();
    // The date range is one pill, not two native inputs.
    expect(bar.querySelectorAll('input[type="date"]')).toHaveLength(0);
    expect(within(bar).getByRole('button', { name: 'Date range' })).toBeInTheDocument();
  });

  it('renders every tab button through the themed tab class', async () => {
    const { container } = renderPage();
    await screen.findByText('Leads created');
    expect(container.querySelectorAll('.lead-reports-page__tab')).toHaveLength(7);
    expect(container.querySelectorAll('.lead-reports-page__tab--active')).toHaveLength(1);
  });

  it('does not tint a zero-valued stat red — an empty tenant is not an alarm', async () => {
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

  it('tints a non-zero drop-out count as danger', async () => {
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
      if (url.startsWith('/api/lead-reports/productivity')) return Promise.reject(new Error('Report engine offline'));
      return buildFetchApi()(url);
    });
    renderPage();
    expect(await screen.findByText('Report engine offline')).toBeInTheDocument();
    // Chrome survives — the tabs are still usable.
    expect(screen.getByRole('button', { name: /Lead Quality/ })).toBeInTheDocument();
  });

  it('warns when the response hit the reporting row cap', async () => {
    fetchApiMock.mockImplementation(buildFetchApi({ productivity: { ...PRODUCTIVITY, truncated: true } }));
    renderPage();
    expect(await screen.findByText(/exceeds the reporting row cap/)).toBeInTheDocument();
  });
});
