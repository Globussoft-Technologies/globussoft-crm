import { describe, expect, it } from 'vitest';
import { pathWithDateRange, readDateRange, setDateRangeParams } from '../utils/dateRangeNavigation';

describe('date range navigation', () => {
  it('keeps a deal link and its selected date range together', () => {
    expect(pathWithDateRange('/pipeline?dealId=42', { from: '2026-10-15', to: '2026-10-20' }))
      .toBe('/pipeline?dealId=42&from=2026-10-15&to=2026-10-20');
  });

  it('clears dates without removing other filters', () => {
    const params = setDateRangeParams(new URLSearchParams('pipelineId=7&from=2026-10-15&to=2026-10-20'), { from: '', to: '' });
    expect(params.toString()).toBe('pipelineId=7');
  });

  it('ignores invalid dates in a shared link', () => {
    expect(readDateRange(new URLSearchParams('from=2026-02-30&to=2026-10-20')))
      .toEqual({ from: '', to: '2026-10-20' });
  });
});
