/**
 * AutomationHealth.jsx — Travel CRM web check-in automation health
 * (PRD_AIRLINE_WEBCHECKIN_AUTOMATION FR-8 / AC-5).
 *
 * Pins the frontend contract for the page over
 * GET /api/travel/automation-health/per-airline:
 *   - Header renders.
 *   - Empty state renders the PRD-correct "stubbed adapters" messaging.
 *   - Per-airline cards render name + success rate (rounded %) + breakdown.
 *   - successRate=null renders "N/A" (no live adapter yet).
 *   - A sub-threshold (<60%) airline trips the degradation banner.
 *   - The window selector changes the fetch URL (windowHours query param).
 *
 * Mock stability: useNotify + fetchApi are stable references per the
 * CLAUDE.md feedback rule.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

const notifyObj = { error: vi.fn(), success: vi.fn(), info: vi.fn() };
vi.mock('../utils/notify', () => ({ useNotify: () => notifyObj }));

import AutomationHealth from '../pages/travel/AutomationHealth';

const HEALTHY = {
  windowHours: 24,
  perAirline: [
    { airlineCode: '6E', total: 10, success: 9, failure: 1, captcha: 0, notImplemented: 0, successRate: 0.9, lastFailureAt: '2026-07-01T00:00:00.000Z' },
    { airlineCode: 'EK', total: 3, success: 0, failure: 0, captcha: 0, notImplemented: 3, successRate: null, lastFailureAt: null },
  ],
};

function renderPage() {
  return render(
    <MemoryRouter>
      <AutomationHealth />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyObj.error.mockReset();
});

describe('AutomationHealth — per-airline cards', () => {
  it('renders the header', async () => {
    fetchApiMock.mockResolvedValue({ windowHours: 24, perAirline: [] });
    renderPage();
    expect(await screen.findByText(/automation health/i)).toBeInTheDocument();
  });

  it('renders empty-state messaging when there are no runs', async () => {
    fetchApiMock.mockResolvedValue({ windowHours: 24, perAirline: [] });
    renderPage();
    expect(await screen.findByText(/No automation runs in this window/i)).toBeInTheDocument();
    expect(screen.getByText(/stubbed/i)).toBeInTheDocument();
  });

  it('renders airline cards with rounded success rate + N/A for null', async () => {
    fetchApiMock.mockResolvedValue(HEALTHY);
    renderPage();
    expect(await screen.findByText('IndiGo')).toBeInTheDocument();
    expect(screen.getByText('90%')).toBeInTheDocument();
    expect(screen.getByText('Emirates')).toBeInTheDocument();
    expect(screen.getByText('N/A')).toBeInTheDocument();
  });

  it('shows the degradation banner when an airline is below threshold', async () => {
    fetchApiMock.mockResolvedValue({
      windowHours: 24,
      perAirline: [
        { airlineCode: '6E', total: 10, success: 4, failure: 6, captcha: 0, notImplemented: 0, successRate: 0.4, lastFailureAt: '2026-07-01T00:00:00.000Z' },
      ],
    });
    renderPage();
    expect(await screen.findByText(/below the 60% success threshold/i)).toBeInTheDocument();
  });

  it('window selector changes the fetch URL windowHours param', async () => {
    fetchApiMock.mockResolvedValue({ windowHours: 24, perAirline: [] });
    renderPage();
    await screen.findByText(/automation health/i);
    expect(fetchApiMock).toHaveBeenCalledWith(expect.stringContaining('windowHours=24'));
    fireEvent.change(screen.getByLabelText(/time window/i), { target: { value: '168' } });
    await waitFor(() =>
      expect(fetchApiMock).toHaveBeenCalledWith(expect.stringContaining('windowHours=168')),
    );
  });
});
