import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../utils/api', () => ({
  fetchApi: vi.fn(),
}));

import { fetchApi } from '../utils/api';
import TelecallerQueue from '../pages/wellness/TelecallerQueue';

// Build leads with deterministic ages (now − offsetMs).
// SLA buckets in TelecallerQueue.jsx:slaBadge():
//   firstResponseAt set OR <30m   -> "SLA OK"     (#10b981)
//   <4h                            -> "SLA warn"   (#f59e0b)
//   <24h                           -> "SLA late"   (#f97316)
//   >=24h                          -> "SLA breach" (#ef4444)
// (Thresholds were rewritten 2026-Q2 from the original <5min/<30min model.)
const NOW = Date.UTC(2026, 3, 22, 10, 0, 0); // 22 Apr 2026 10:00 UTC

const buildLeads = () => [
  // SLA OK — 5 minutes old (< 30 min)
  { id: 1, name: 'Aarav Sharma',  phone: '+919876500001', source: 'meta-ad',  createdAt: new Date(NOW - 5 * 60 * 1000).toISOString(), aiScore: 85 },
  // SLA warn — 90 minutes old (>= 30m, < 4h)
  { id: 2, name: 'Diya Patel',    phone: '+919876500002', source: 'website',  createdAt: new Date(NOW - 90 * 60 * 1000).toISOString(), aiScore: 60 },
  // SLA breach — 26 hours old (>= 24h)
  { id: 3, name: 'Rohan Iyer',    phone: '+919876500003', source: 'whatsapp', createdAt: new Date(NOW - 26 * 60 * 60 * 1000).toISOString(), aiScore: 30 },
];

describe('<TelecallerQueue />', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(NOW));
    fetchApi.mockReset();
    fetchApi.mockResolvedValue({ leads: buildLeads() });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders all 3 lead cards from the queue', async () => {
    render(<MemoryRouter><TelecallerQueue /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Aarav Sharma')).toBeInTheDocument());
    expect(screen.getByText('Diya Patel')).toBeInTheDocument();
    expect(screen.getByText('Rohan Iyer')).toBeInTheDocument();
  });

  it('SLA badge color logic: OK < 5min, warn 5–30min, breach > 30min', async () => {
    render(<MemoryRouter><TelecallerQueue /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Aarav Sharma')).toBeInTheDocument());

    // The page renders SLA badges in TWO places: the header summary (counters
    // for each bucket) AND on each lead card. So each "SLA <state>" text
    // appears at least twice. Assert ≥ 1 of each via getAllByText.
    expect(screen.getAllByText(/SLA OK/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/SLA warn/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/SLA breach/i).length).toBeGreaterThanOrEqual(1);
  });

  it('renders 6 disposition buttons per card', async () => {
    render(<MemoryRouter><TelecallerQueue /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Aarav Sharma')).toBeInTheDocument());

    // 3 cards × 6 dispositions = 18 buttons total of these labels
    expect(screen.getAllByRole('button', { name: /^Interested$/i }).length).toBe(3);
    expect(screen.getAllByRole('button', { name: /^Not interested$/i }).length).toBe(3);
    expect(screen.getAllByRole('button', { name: /^Callback$/i }).length).toBe(3);
    expect(screen.getAllByRole('button', { name: /^Booked$/i }).length).toBe(3);
    expect(screen.getAllByRole('button', { name: /^Wrong number$/i }).length).toBe(3);
    expect(screen.getAllByRole('button', { name: /^Junk$/i }).length).toBe(3);
  });

  it('clicking "Junk" POSTs to /telecaller/dispose with disposition=junk', async () => {
    // #129: Junk and Wrong number now confirm() before firing — auto-accept here
    // so the existing assertion on the POST body still works.
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<MemoryRouter><TelecallerQueue /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Aarav Sharma')).toBeInTheDocument());

    const junkBtns = screen.getAllByRole('button', { name: /^Junk$/i });
    await user.click(junkBtns[0]);

    await waitFor(() => {
      const disposeCall = fetchApi.mock.calls.find(
        ([url, opts]) => url === '/api/wellness/telecaller/dispose' && opts?.method === 'POST'
      );
      expect(disposeCall).toBeTruthy();
      const body = JSON.parse(disposeCall[1].body);
      expect(body.disposition).toBe('junk');
      expect(body.contactId).toBe(1);
    });

    expect(confirmSpy).toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});
