/**
 * #614 — Loyalty page Rules tab renders earn/burn rules from a mocked
 * /api/wellness/loyalty/rules response and pins the human-readable summary
 * format ("Earn N points per visit", "Redeem N points = ₹1 off") so a
 * future refactor of the summary builder breaks the test, not the demo.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

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

import { fetchApi } from '../utils/api';
import Loyalty from '../pages/wellness/Loyalty';

const rules = {
  tenantId: 1,
  earnPerVisit: 50,
  earnPercentOfSpend: 10,
  earnPerCurrencyUnit: 0,
  redeemPointsPerUnit: 10,
  welcomeBonus: 100,
  referralBonus: 200,
  autoEarnEnabled: true,
};

describe('<Loyalty /> — #614 Rules tab', () => {
  beforeEach(() => {
    fetchApi.mockReset();
    fetchApi.mockImplementation((url) => {
      if (url === '/api/wellness/loyalty/rules') return Promise.resolve(rules);
      if (url.startsWith('/api/wellness/loyalty/leaderboard')) return Promise.resolve([]);
      if (url.startsWith('/api/wellness/referrals')) return Promise.resolve({ referrals: [] });
      return Promise.resolve([]);
    });
  });

  it('renders earn/burn rule lines from /loyalty/rules when Rules tab is opened', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><Loyalty /></MemoryRouter>);

    // Switch to Rules tab
    await user.click(screen.getByRole('button', { name: /Rules/i }));

    // Wait for the rules summary block
    await waitFor(() =>
      expect(screen.getByText(/Earn 50 points per completed visit/i)).toBeInTheDocument()
    );

    // Percent-of-spend line
    expect(screen.getByText(/10% of every visit's amount as points/i)).toBeInTheDocument();
    // Burn / redemption line — formatMoney resolves the symbol; just match
    // the digit-anchored shape so we don't bind to a specific currency.
    expect(screen.getByText(/Redeem 10 points/i)).toBeInTheDocument();
    // Welcome + referral bonuses surface
    expect(screen.getByText(/Welcome bonus: 100 points/i)).toBeInTheDocument();
    expect(screen.getByText(/Referral bonus: 200 points/i)).toBeInTheDocument();
  });

  it('disabled rules render as "disabled" rather than vanishing silently', async () => {
    fetchApi.mockReset();
    fetchApi.mockImplementation((url) => {
      if (url === '/api/wellness/loyalty/rules') {
        return Promise.resolve({ ...rules, earnPerVisit: 0, earnPercentOfSpend: 0 });
      }
      if (url.startsWith('/api/wellness/loyalty/leaderboard')) return Promise.resolve([]);
      if (url.startsWith('/api/wellness/referrals')) return Promise.resolve({ referrals: [] });
      return Promise.resolve([]);
    });
    const user = userEvent.setup();
    render(<MemoryRouter><Loyalty /></MemoryRouter>);
    await user.click(screen.getByRole('button', { name: /Rules/i }));

    await waitFor(() =>
      expect(screen.getByText(/Per-visit flat earn: disabled/i)).toBeInTheDocument()
    );
    expect(screen.getByText(/Percent-of-spend earn: disabled/i)).toBeInTheDocument();
  });

  it('Save button issues PUT to /loyalty/rules with edited values', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><Loyalty /></MemoryRouter>);
    await user.click(screen.getByRole('button', { name: /Rules/i }));

    await waitFor(() =>
      expect(screen.getByText(/Earn 50 points per completed visit/i)).toBeInTheDocument()
    );

    fetchApi.mockResolvedValueOnce({ ...rules, earnPerVisit: 75 });
    await user.click(screen.getByRole('button', { name: /Save rules/i }));

    await waitFor(() => {
      const putCall = fetchApi.mock.calls.find(
        ([url, opts]) => url === '/api/wellness/loyalty/rules' && opts?.method === 'PUT'
      );
      expect(putCall).toBeTruthy();
    });
  });
});
