/**
 * VisaDashboard.test.jsx — vitest + RTL coverage for the Visa Sure landing
 * dashboard (frontend/src/pages/travel/visa/Dashboard.jsx).
 *
 * The page graduated from a Phase-3 SHELL to a real, data-backed overview
 * that reads two existing tenant-scoped + visasure-scoped endpoints:
 *   GET /api/travel/visa/applications/stats
 *   GET /api/travel/visa/applications?limit=5
 *
 * Coverage:
 *   - fetches both endpoints on mount
 *   - renders KPI tiles (total / approved / rejected / approval rate)
 *   - renders the by-status breakdown + recent applications (linked to detail)
 *   - quick links resolve to the built sibling pages
 *   - empty state when the tenant has zero visa applications
 *
 * Mocking discipline (CLAUDE.md RTL standing rules): useNotify returns ONE
 * stable object reference for the whole run (no per-call re-creation).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../utils/api', () => ({ fetchApi: vi.fn() }));

const notifyObj = { error: vi.fn(), success: vi.fn(), info: vi.fn(), confirm: vi.fn() };
vi.mock('../utils/notify', () => ({ useNotify: () => notifyObj }));

import { fetchApi } from '../utils/api';
import VisaDashboard from '../pages/travel/visa/Dashboard.jsx';

const STATS = {
  total: 12,
  byStatus: {
    intake: { count: 2 }, 'docs-pending': { count: 3 }, filed: { count: 2 },
    approved: { count: 4 }, rejected: { count: 1 }, appeal: { count: 0 },
  },
  byApplicationType: { tourist: { count: 5 }, work: { count: 4 }, umrah: { count: 3 } },
  byDestinationCountry: { 'United States': { count: 4 }, 'Saudi Arabia': { count: 3 } },
  complexCount: 2,
  flaggedCount: 1,
  lastActivityAt: '2026-06-14T10:00:00.000Z',
};

const RECENT = [
  { id: 101, status: 'approved', applicationType: 'tourist', destinationCountry: 'United States', contact: { name: 'Ali Khan' }, updatedAt: '2026-06-14T10:00:00.000Z' },
  { id: 102, status: 'docs-pending', applicationType: 'umrah', destinationCountry: 'Saudi Arabia', contactId: 55, updatedAt: '2026-06-13T10:00:00.000Z' },
];

function mockApi({ stats = STATS, recent = RECENT } = {}) {
  fetchApi.mockImplementation((url) => {
    if (typeof url === 'string' && url.includes('/applications/stats')) return Promise.resolve(stats);
    if (typeof url === 'string' && url.includes('/applications?')) return Promise.resolve(recent);
    return Promise.resolve(null);
  });
}

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/travel/visa']}>
      <VisaDashboard />
    </MemoryRouter>,
  );

describe('VisaDashboard (data-backed Visa Sure landing)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the "Visa Sure" heading as an <h1>', async () => {
    mockApi();
    renderPage();
    expect(screen.getByRole('heading', { level: 1, name: /Visa Sure/i })).toBeInTheDocument();
  });

  it('fetches the stats + recent-applications endpoints on mount', async () => {
    mockApi();
    renderPage();
    await waitFor(() => {
      const urls = fetchApi.mock.calls.map((c) => c[0]);
      expect(urls.some((u) => u.includes('/api/travel/visa/applications/stats'))).toBe(true);
      expect(urls.some((u) => u.includes('/api/travel/visa/applications?limit=5'))).toBe(true);
    });
  });

  it('renders KPI tiles with the computed values (total, approved, approval rate)', async () => {
    mockApi();
    renderPage();
    expect(await screen.findByText('Total applications')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument(); // total
    expect(screen.getByText('Approval rate')).toBeInTheDocument();
    // approved 4 / (4+1 decided) = 80%
    expect(screen.getByText('80%')).toBeInTheDocument();
  });

  it('KPI tiles are clickable and drill into the matching detailed view', async () => {
    mockApi();
    renderPage();
    await screen.findByText('Total applications');
    const href = (testid) => screen.getByTestId(testid).getAttribute('href');
    expect(href('kpi-total-applications')).toBe('/travel/visa/applications');
    expect(href('kpi-approved')).toBe('/travel/visa/applications?status=approved');
    expect(href('kpi-rejected')).toBe('/travel/visa/applications?status=rejected');
    expect(href('kpi-in-progress')).toBe('/travel/visa/applications');
    expect(href('kpi-approval-rate')).toBe('/travel/visa/reports');
    expect(href('kpi-risk-flagged')).toBe('/travel/visa/applications');
  });

  it('renders the by-status breakdown section', async () => {
    mockApi();
    renderPage();
    expect(await screen.findByText('By status')).toBeInTheDocument();
    // Labels unique to the breakdown: KPI tiles reuse "Approved"/"Rejected"
    // and the recent-app badges reuse "Docs pending"; "Intake"/"Filed" appear
    // only in the status breakdown given these fixtures.
    expect(screen.getByText('Intake')).toBeInTheDocument();
    expect(screen.getByText('Filed')).toBeInTheDocument();
  });

  it('renders recent applications linking to their detail page', async () => {
    mockApi();
    renderPage();
    const row = await screen.findByText(/#101 · Ali Khan/);
    expect(row).toBeInTheDocument();
    const detailLink = screen.getAllByRole('link').find((l) => l.getAttribute('href') === '/travel/visa/applications/101');
    expect(detailLink).toBeTruthy();
  });

  it('renders quick links to the built sibling pages', async () => {
    mockApi();
    renderPage();
    await screen.findByText('Total applications');
    const hrefs = screen.getAllByRole('link').map((l) => l.getAttribute('href'));
    expect(hrefs).toContain('/travel/visa/applications');
    expect(hrefs).toContain('/travel/visa/reports');
    expect(hrefs).toContain('/travel/visa/embassy-rules');
  });

  it('shows an empty state when the tenant has no visa applications', async () => {
    mockApi({ stats: { ...STATS, total: 0, byStatus: {} }, recent: [] });
    renderPage();
    expect(await screen.findByText(/No visa applications yet/i)).toBeInTheDocument();
  });
});
