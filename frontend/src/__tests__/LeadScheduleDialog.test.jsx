import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
vi.mock('../utils/api', () => ({ fetchApi: vi.fn() }));
import { fetchApi } from '../utils/api';
import LeadScheduleDialog from '../components/LeadScheduleDialog';
import { scheduleInstant } from '../utils/workspaceClock';

it('maps India wall time to the correct UTC instant', () => {
  expect(scheduleInstant(new Date(2026, 10, 19), 9, 0, 'AM', 'Asia/Kolkata').toISOString()).toBe('2026-11-19T03:30:00.000Z');
});
it('maps noon and midnight correctly', () => {
  expect(scheduleInstant(new Date(2026, 10, 19), 12, 15, 'PM', 'UTC').toISOString()).toBe('2026-11-19T12:15:00.000Z');
  expect(scheduleInstant(new Date(2026, 10, 19), 12, 0, 'AM', 'UTC').toISOString()).toBe('2026-11-19T00:00:00.000Z');
});

it('uses server time across midnight even when the device clock is ahead', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-18T18:43:00Z'));
  try {
    const contactIds = Array.from({ length: 300 }, (_, index) => index + 1);
    fetchApi.mockImplementation(async (url) => url.endsWith('/control')
      ? { serverTime: '2026-11-18T18:28:00Z' }
      : { eligibleIds: [1], withPhone: 1, missingPhone: 299, unavailable: 0 });
    render(<LeadScheduleDialog contactIds={contactIds} timezone="Asia/Kolkata" />);
    expect(await screen.findByText('India (IST)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '19', pressed: true })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Hour' })).toHaveValue('12');
    expect(screen.getByRole('textbox', { name: 'Minute' })).toHaveValue('00');
    expect(screen.getByRole('button', { name: 'AM', pressed: true })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Schedule 1 leads' })).toBeEnabled();
    expect(await screen.findByText('CRM time')).toBeInTheDocument();
    expect(screen.getByText(/11:58:00 PM/)).toBeInTheDocument();
    expect(screen.getByText(/Starts in 2 min/)).toBeInTheDocument();
    expect(fetchApi).toHaveBeenCalledWith('/api/callified/dial-jobs/preview', {
      method: 'POST', silent: true, body: JSON.stringify({ contactIds }),
    });
  } finally {
    now.mockRestore();
  }
});

it.each([
  ['Asia/Kathmandu', '2026-11-19T03:15:00.000Z'],
  ['Pacific/Chatham', '2026-11-18T19:15:00.000Z'],
  ['America/St_Johns', '2026-11-19T12:30:00.000Z'],
])('maps 9 AM in %s to the correct UTC instant', (timezone, expected) => {
  expect(scheduleInstant(new Date(2026, 10, 19), 9, 0, 'AM', timezone).toISOString()).toBe(expected);
});

it('rejects a missing hour on a daylight-saving transition', () => {
  const skipped = scheduleInstant(new Date(2026, 2, 8), 2, 30, 'AM', 'America/New_York');
  expect(Number.isNaN(skipped.getTime())).toBe(true);
});
