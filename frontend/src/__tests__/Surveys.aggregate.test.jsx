/**
 * #613 — Surveys aggregation panel renders count, average score, NPS,
 * promoter / passive / detractor breakdown, and the score-distribution
 * chart from a mocked /api/surveys/:id/aggregate response. Pins the
 * server-side-aggregation contract so any future regression to client-side
 * reduce-over-paginated-list breaks the test.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../utils/api', () => ({ fetchApi: vi.fn() }));
vi.mock('../utils/notify', () => ({
  useNotify: () => ({
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    confirm: () => Promise.resolve(true),
    prompt: () => Promise.resolve(''),
  }),
}));

// Recharts uses ResponsiveContainer that needs a real DOM with measurable
// width; jsdom returns 0. Mock it so the chart renders in tests.
vi.mock('recharts', async () => {
  const actual = await vi.importActual('recharts');
  return {
    ...actual,
    ResponsiveContainer: ({ children }) => (
      <div data-testid="responsive">{children}</div>
    ),
  };
});

import { fetchApi } from '../utils/api';
import Surveys from '../pages/Surveys';

const surveys = [
  { id: 42, name: 'Q2 NPS', type: 'NPS', question: 'How likely?', responseCount: 10, npsScore: 30 },
];

const aggregate = {
  surveyId: 42,
  type: 'NPS',
  count: 10,
  avgScore: 7.4,
  npsScore: 30,
  promoters: 5,
  passives: 3,
  detractors: 2,
  distribution: Array.from({ length: 11 }, (_, score) => ({
    score,
    count: { 0: 1, 3: 1, 7: 1, 8: 2, 9: 3, 10: 2 }[score] || 0,
  })),
};

describe('<Surveys /> — #613 aggregation panel', () => {
  beforeEach(() => {
    fetchApi.mockReset();
    fetchApi.mockImplementation((url) => {
      if (url === '/api/surveys') return Promise.resolve(surveys);
      if (url.endsWith('/aggregate')) return Promise.resolve(aggregate);
      if (url.endsWith('/responses')) return Promise.resolve([]);
      return Promise.resolve([]);
    });
  });

  it('renders count + avg + NPS + promoter/passive/detractor split from /aggregate', async () => {
    const user = userEvent.setup();
    render(<Surveys />);
    await waitFor(() => expect(screen.getByText('Q2 NPS')).toBeInTheDocument());

    // Open detail view
    await user.click(screen.getByText('Q2 NPS'));

    // Stats summary cards: count, avg, NPS
    await waitFor(() => {
      // Avg score (formatted to 2dp by the page) — uniquely identifies the
      // avg-score card; "10" / "30" appear in the score-axis tick labels
      // too so we anchor on the decimal-formatted value instead.
      expect(screen.getByText('7.40')).toBeInTheDocument();
    });

    // NPS bucket breakdown — the #613 deliverable. All three categories surface.
    expect(screen.getByText('Promoters')).toBeInTheDocument();
    expect(screen.getByText('Passives')).toBeInTheDocument();
    expect(screen.getByText('Detractors')).toBeInTheDocument();

    // Promoter/passive/detractor counts surface as "% of responses" lines too,
    // which uniquely tag the bucket-card values vs the chart-axis duplicates.
    // 5 promoters / 10 = 50%, 3 passives = 30%, 2 detractors = 20%.
    expect(screen.getByText(/50% of responses/i)).toBeInTheDocument();
    expect(screen.getByText(/30% of responses/i)).toBeInTheDocument();
    expect(screen.getByText(/20% of responses/i)).toBeInTheDocument();
  });

  it('calls /aggregate (not legacy /stats) when entering detail view', async () => {
    const user = userEvent.setup();
    render(<Surveys />);
    await waitFor(() => expect(screen.getByText('Q2 NPS')).toBeInTheDocument());
    await user.click(screen.getByText('Q2 NPS'));
    await waitFor(() =>
      expect(fetchApi).toHaveBeenCalledWith('/api/surveys/42/aggregate')
    );
  });

  it('falls back to /stats if /aggregate 404s (back-compat)', async () => {
    fetchApi.mockReset();
    fetchApi.mockImplementation((url) => {
      if (url === '/api/surveys') return Promise.resolve(surveys);
      if (url.endsWith('/aggregate')) return Promise.reject(new Error('not found'));
      if (url.endsWith('/stats')) return Promise.resolve({ count: 1, avgScore: 9, npsScore: 100, distribution: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], type: 'NPS' });
      if (url.endsWith('/responses')) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    const user = userEvent.setup();
    render(<Surveys />);
    await waitFor(() => expect(screen.getByText('Q2 NPS')).toBeInTheDocument());
    await user.click(screen.getByText('Q2 NPS'));
    await waitFor(() =>
      expect(fetchApi).toHaveBeenCalledWith('/api/surveys/42/stats')
    );
  });
});
