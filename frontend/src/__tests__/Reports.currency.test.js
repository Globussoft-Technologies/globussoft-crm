import { describe, expect, it, vi } from 'vitest';

vi.mock('../utils/money', () => ({
  currencySymbol: (currency = 'USD') => ({ INR: '₹', USD: '$', EUR: '€' })[currency] || currency,
}));

import { getReportMetricOptions } from '../utils/reportMetrics';

describe('Reports metric currency labels', () => {
  it('uses the selected display currency in the revenue metric label', () => {
    expect(getReportMetricOptions('INR').find(option => option.value === 'revenue').label).toBe('Revenue (₹)');
    expect(getReportMetricOptions('EUR').find(option => option.value === 'revenue').label).toBe('Revenue (€)');
  });

  it('does not change non-currency metric labels', () => {
    const options = getReportMetricOptions('INR');

    expect(options.find(option => option.value === 'count').label).toBe('Deal Count');
    expect(options.find(option => option.value === 'win_rate').label).toBe('Win/Loss Rate');
  });
});
