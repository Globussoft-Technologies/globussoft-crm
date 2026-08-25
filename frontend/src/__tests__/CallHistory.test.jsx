/**
 * CallHistory.test.jsx — the dedicated call-history page.
 *
 * This page exists because reading call history through the per-lead
 * transcripts drawer was unusable: it listed EVERY attempt for one contact
 * with no paging, no filters and no per-call detail, so a lead with 29 calls
 * rendered 29 undifferentiated rows.
 *
 * The properties worth pinning are therefore the ones that fix that:
 * pagination actually pages, filters actually reach the query, and opening a
 * call shows the transcript for THAT attempt rather than all of the lead's.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

import CallHistory from '../pages/wellness/CallHistory';

function makeCall(over = {}) {
  return {
    id: 1,
    createdAt: '2026-08-25T10:00:00.000Z',
    status: 'COMPLETED',
    duration: 45,
    recordingUrl: null,
    calleeNumber: '+916200039874',
    contactId: 11,
    contactName: 'Mohit das',
    placedBy: 'Ganesh Sharma',
    mode: 'ai',
    campaignId: 943,
    callifiedLeadId: 191188,
    callSid: 'EXsid1',
    ...over,
  };
}

function listResponse(calls, over = {}) {
  return { calls, total: calls.length, page: 1, limit: 25, totalPages: 1, ...over };
}

/** Every /calls?… request made so far, with its parsed query. */
function listCalls() {
  return fetchApiMock.mock.calls
    .map(([url]) => url)
    .filter((url) => typeof url === 'string' && url.startsWith('/api/callified/calls?'))
    .map((url) => new URLSearchParams(url.split('?')[1]));
}

beforeEach(() => {
  fetchApiMock.mockReset();
  fetchApiMock.mockResolvedValue(listResponse([makeCall()]));
});

describe('<CallHistory /> — list', () => {
  it('renders a call with customer, outcome, duration and who placed it', async () => {
    render(<CallHistory />);

    expect(await screen.findByText('Mohit das')).toBeInTheDocument();
    expect(screen.getByText('+916200039874')).toBeInTheDocument();
    expect(screen.getByText('COMPLETED')).toBeInTheDocument();
    expect(screen.getByText('45s')).toBeInTheDocument();
    expect(screen.getByText('Ganesh Sharma')).toBeInTheDocument();
  });

  it('distinguishes AI from manual calls', async () => {
    fetchApiMock.mockResolvedValue(
      listResponse([makeCall({ id: 1, mode: 'ai' }), makeCall({ id: 2, mode: 'browser' })]),
    );
    render(<CallHistory />);

    expect(await screen.findByText('AI')).toBeInTheDocument();
    expect(screen.getByText('Manual')).toBeInTheDocument();
  });

  it('asks for the first page with a bounded limit', async () => {
    render(<CallHistory />);
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));

    const q = listCalls()[0];
    expect(q.get('page')).toBe('1');
    expect(Number(q.get('limit'))).toBeLessThanOrEqual(100);
  });

  it('shows an empty state rather than a blank table', async () => {
    fetchApiMock.mockResolvedValue(listResponse([], { total: 0 }));
    render(<CallHistory />);
    expect(await screen.findByText(/No calls match these filters/i)).toBeInTheDocument();
  });

  it('surfaces a load failure', async () => {
    fetchApiMock.mockRejectedValue(new Error('Failed to load call history'));
    render(<CallHistory />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load call history');
  });
});

describe('<CallHistory /> — pagination', () => {
  beforeEach(() => {
    fetchApiMock.mockResolvedValue(
      listResponse([makeCall()], { total: 60, page: 1, totalPages: 3 }),
    );
  });

  it('reports the visible range out of the total', async () => {
    render(<CallHistory />);
    expect(await screen.findByTestId('call-history-range')).toHaveTextContent(/of 60 calls/i);
  });

  it('Previous is disabled on the first page', async () => {
    render(<CallHistory />);
    expect(await screen.findByTestId('call-history-prev')).toBeDisabled();
  });

  it('Next requests the following page', async () => {
    const user = userEvent.setup();
    render(<CallHistory />);

    await user.click(await screen.findByTestId('call-history-next'));

    await waitFor(() => {
      expect(listCalls().some((q) => q.get('page') === '2')).toBe(true);
    });
  });

  it('Next is disabled on the last page', async () => {
    fetchApiMock.mockResolvedValue(
      listResponse([makeCall()], { total: 10, page: 1, totalPages: 1 }),
    );
    render(<CallHistory />);
    expect(await screen.findByTestId('call-history-next')).toBeDisabled();
  });
});

describe('<CallHistory /> — filters', () => {
  it('sends the selected call type', async () => {
    const user = userEvent.setup();
    render(<CallHistory />);
    await screen.findByText('Mohit das');

    await user.selectOptions(screen.getByTestId('call-history-mode'), 'browser');

    await waitFor(() => {
      expect(listCalls().some((q) => q.get('mode') === 'browser')).toBe(true);
    });
  });

  it('sends the selected outcome', async () => {
    const user = userEvent.setup();
    render(<CallHistory />);
    await screen.findByText('Mohit das');

    await user.selectOptions(screen.getByTestId('call-history-status'), 'FAILED');

    await waitFor(() => {
      expect(listCalls().some((q) => q.get('status') === 'FAILED')).toBe(true);
    });
  });

  it('debounces the search box instead of firing per keystroke', async () => {
    render(<CallHistory />);
    await screen.findByText('Mohit das');
    const before = listCalls().length;

    const box = screen.getByTestId('call-history-search');
    fireEvent.change(box, { target: { value: 'M' } });
    fireEvent.change(box, { target: { value: 'Mo' } });
    fireEvent.change(box, { target: { value: 'Moh' } });

    await waitFor(() => {
      expect(listCalls().some((q) => q.get('search') === 'Moh')).toBe(true);
    });
    // Three keystrokes must not become three requests.
    expect(listCalls().length - before).toBeLessThan(3);
  });

  it('returns to page 1 when a filter changes', async () => {
    const user = userEvent.setup();
    fetchApiMock.mockResolvedValue(
      listResponse([makeCall()], { total: 60, page: 1, totalPages: 3 }),
    );
    render(<CallHistory />);
    await screen.findByText('Mohit das');

    await user.click(screen.getByTestId('call-history-next'));
    await waitFor(() => expect(listCalls().some((q) => q.get('page') === '2')).toBe(true));

    await user.selectOptions(screen.getByTestId('call-history-status'), 'FAILED');

    // Staying on page 4 of a freshly-filtered set usually lands on nothing.
    await waitFor(() => {
      const withFilter = listCalls().filter((q) => q.get('status') === 'FAILED');
      expect(withFilter.length).toBeGreaterThan(0);
      expect(withFilter.every((q) => q.get('page') === '1')).toBe(true);
    });
  });
});

describe('<CallHistory /> — detail', () => {
  // Matched on DURATION, not time. Callified's `created_at` is when it
  // finished post-processing — a call logged at Aug 24 14:43 UTC had a
  // transcript stamped Aug 25 11:52 — and the payload carries no call_sid.
  // `call_duration_s` is the only field that corresponds, and it matches the
  // CRM's measured duration to the second.
  const DETAILS = {
    transcripts: [
      { id: 501, call_duration_s: 45.2, created_at: '2026-08-26 11:52:56', transcript: [{ role: 'AI', text: 'Hello there' }, { role: 'User', text: 'Yes I did' }], recording_url: '/api/recordings/o/p/a.wav' },
      { id: 502, call_duration_s: 300.0, created_at: '2026-08-26 11:53:10', transcript: [{ role: 'agent', text: 'A different call' }], recording_url: null },
    ],
    reviews: [
      { transcript_id: 501, quality_score: 8, sentiment: 'positive', appointment_booked: true, summary: 'Customer agreed to a follow-up.' },
    ],
  };

  beforeEach(() => {
    fetchApiMock.mockImplementation((url) => {
      if (typeof url === 'string' && url.startsWith('/api/callified/calls?')) {
        return Promise.resolve(listResponse([makeCall()]));
      }
      if (typeof url === 'string' && url.includes('/details')) return Promise.resolve(DETAILS);
      return Promise.resolve({});
    });
  });

  it('opens the drawer for the clicked call', async () => {
    const user = userEvent.setup();
    render(<CallHistory />);
    await user.click(await screen.findByTestId('call-details-1'));

    expect(await screen.findByTestId('call-detail-drawer')).toBeInTheDocument();
  });

  it('shows only the transcript whose duration matches THIS attempt', async () => {
    const user = userEvent.setup();
    render(<CallHistory />);
    await user.click(await screen.findByTestId('call-details-1'));

    // The call ran 45s; transcript 501 is 45.2s, 502 is 300s.
    expect(await screen.findByText('Hello there')).toBeInTheDocument();
    expect(screen.queryByText('A different call')).not.toBeInTheDocument();
  });

  it('renders the AI review alongside the transcript', async () => {
    const user = userEvent.setup();
    render(<CallHistory />);
    await user.click(await screen.findByTestId('call-details-1'));

    expect(await screen.findByText(/Customer agreed to a follow-up/i)).toBeInTheDocument();
    expect(screen.getByText(/Score 8\/10/)).toBeInTheDocument();
    expect(screen.getByText(/Appointment booked/i)).toBeInTheDocument();
  });

  it('offers the recording on demand rather than auto-downloading it', async () => {
    const user = userEvent.setup();
    render(<CallHistory />);
    await user.click(await screen.findByTestId('call-details-1'));

    // A long WAV runs to tens of megabytes — it must not load unprompted.
    expect(await screen.findByTestId('call-detail-play')).toBeInTheDocument();
    expect(screen.queryByTestId('call-detail-audio')).not.toBeInTheDocument();
  });

  it('lists the customer recordings when no duration matches, rather than guessing', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (typeof url === 'string' && url.startsWith('/api/callified/calls?')) {
        return Promise.resolve(listResponse([makeCall()]));
      }
      if (typeof url === 'string' && url.includes('/details')) {
        // Two recordings for this customer, neither matching the 45s call.
        return Promise.resolve({
          transcripts: [
            { id: 601, call_duration_s: 120, created_at: '2026-08-26 09:00:00', recording_url: '/api/recordings/o/p/x.wav' },
            { id: 602, call_duration_s: 300, created_at: '2026-08-26 09:05:00', recording_url: null },
          ],
          reviews: [],
        });
      }
      return Promise.resolve({});
    });
    const user = userEvent.setup();
    render(<CallHistory />);
    await user.click(await screen.findByTestId('call-details-1'));

    // Guessing between them would attribute the wrong conversation to this call.
    expect(await screen.findByText(/could not be matched/i)).toBeInTheDocument();
    const list = screen.getByTestId('call-detail-all-transcripts');
    expect(list).toHaveTextContent('Recordings for this customer (2)');
  });

  it('says a call that never connected has nothing to show', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (typeof url === 'string' && url.startsWith('/api/callified/calls?')) {
        return Promise.resolve(listResponse([makeCall({ duration: 0, status: 'INITIATED' })]));
      }
      if (typeof url === 'string' && url.includes('/details')) {
        return Promise.resolve({ transcripts: [], reviews: [] });
      }
      return Promise.resolve({});
    });
    const user = userEvent.setup();
    render(<CallHistory />);
    await user.click(await screen.findByTestId('call-details-1'));

    expect(await screen.findByText(/never connected/i)).toBeInTheDocument();
  });

  it('closes without leaving the drawer mounted', async () => {
    const user = userEvent.setup();
    render(<CallHistory />);
    await user.click(await screen.findByTestId('call-details-1'));
    await screen.findByTestId('call-detail-drawer');

    await user.click(screen.getByRole('button', { name: /close/i }));

    await waitFor(() =>
      expect(screen.queryByTestId('call-detail-drawer')).not.toBeInTheDocument(),
    );
  });
});

/**
 * Transcript rendering.
 *
 * API_FLOW.md documents `{"role":"agent"}` / `{"role":"user"}`. The live API
 * sends **"AI" and "User"**, so a `role === 'agent'` equality check fell
 * through for EVERY line and labelled the agent's own speech as the
 * customer's — the entire conversation attributed to the wrong party.
 *
 * Separately, a transcript can exist with a recording and an AI review but
 * ZERO turns (observed on several short calls). Omitting the section then
 * reads as a broken page, so it must say so explicitly.
 */
describe('<CallHistory /> — transcript rendering', () => {
  function withTranscript(turns) {
    fetchApiMock.mockImplementation((url) => {
      if (typeof url === 'string' && url.startsWith('/api/callified/calls?')) {
        return Promise.resolve(listResponse([makeCall()]));
      }
      if (typeof url === 'string' && url.includes('/details')) {
        return Promise.resolve({
          transcripts: [{ id: 501, call_duration_s: 45, created_at: '2026-08-26 11:52:56', transcript: turns, recording_url: null }],
          reviews: [],
        });
      }
      return Promise.resolve({});
    });
  }

  it('labels an "AI" turn as Agent, not Customer', async () => {
    withTranscript([
      { role: 'AI', text: 'Hi, this is Aditya calling from Globussoft.' },
      { role: 'User', text: 'Yes, go ahead.' },
    ]);
    const user = userEvent.setup();
    render(<CallHistory />);
    await user.click(await screen.findByTestId('call-details-1'));

    const panel = await screen.findByTestId('call-detail-transcript');
    expect(panel).toHaveTextContent('Agent:');
    expect(panel).toHaveTextContent('Customer:');
    // The agent's line must NOT be attributed to the customer.
    expect(panel).toHaveTextContent('Agent: Hi, this is Aditya calling from Globussoft.');
  });

  it('still understands the documented agent/user vocabulary', async () => {
    withTranscript([
      { role: 'agent', text: 'Documented agent line' },
      { role: 'user', text: 'Documented user line' },
    ]);
    const user = userEvent.setup();
    render(<CallHistory />);
    await user.click(await screen.findByTestId('call-details-1'));

    const panel = await screen.findByTestId('call-detail-transcript');
    expect(panel).toHaveTextContent('Agent: Documented agent line');
    expect(panel).toHaveTextContent('Customer: Documented user line');
  });

  it('says so when a transcript exists but captured no turns', async () => {
    withTranscript([]);
    const user = userEvent.setup();
    render(<CallHistory />);
    await user.click(await screen.findByTestId('call-details-1'));

    // The section must still render — a missing section reads as a bug.
    const panel = await screen.findByTestId('call-detail-transcript');
    expect(panel).toHaveTextContent(/No transcript was captured for this call/i);
  });
});

/**
 * Manual calls are recorded, not analysed.
 *
 * A manual call is two humans talking — Callified's AI is not on the line, so
 * it produces no dialogue and no meaningful assessment. Verified against live
 * data: genuine manual calls return ZERO transcript turns and a default
 * `score 0 / neutral`, while the transcripts that DO carry turns contain the
 * AI's own script ("I'm Aditya calling from EmpMonitor…") and belong to AI
 * calls — they were being mis-attributed to manual ones by duration matching.
 *
 * Showing either would invent an assessment of a conversation the AI never
 * heard, which is worse than showing nothing.
 */
describe('<CallHistory /> — manual calls show recording only', () => {
  function withDetails(callOver) {
    fetchApiMock.mockImplementation((url) => {
      if (typeof url === 'string' && url.startsWith('/api/callified/calls?')) {
        return Promise.resolve(listResponse([makeCall(callOver)]));
      }
      if (typeof url === 'string' && url.includes('/details')) {
        return Promise.resolve({
          transcripts: [{
            id: 501,
            call_duration_s: 45,
            created_at: '2026-08-26 11:52:56',
            transcript: [{ role: 'AI', text: "I'm Aditya calling from EmpMonitor." }],
            recording_url: '/api/recordings/o/p/a.wav',
          }],
          reviews: [{ transcript_id: 501, quality_score: 0, sentiment: 'neutral', appointment_booked: false, summary: 'Nothing of note.' }],
        });
      }
      return Promise.resolve({});
    });
  }

  it('hides the transcript and AI review for a manual call', async () => {
    withDetails({ mode: 'browser' });
    const user = userEvent.setup();
    render(<CallHistory />);
    await user.click(await screen.findByTestId('call-details-1'));

    expect(await screen.findByText(/not transcribed or scored/i)).toBeInTheDocument();
    expect(screen.queryByTestId('call-detail-transcript')).not.toBeInTheDocument();
    expect(screen.queryByText(/AI review/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Score 0\/10/)).not.toBeInTheDocument();
  });

  it('still offers the recording for a manual call', async () => {
    withDetails({ mode: 'browser' });
    const user = userEvent.setup();
    render(<CallHistory />);
    await user.click(await screen.findByTestId('call-details-1'));

    // The audio is real even though the analysis is not.
    expect(await screen.findByTestId('call-detail-play')).toBeInTheDocument();
  });

  it('an AI call keeps its transcript and review', async () => {
    withDetails({ mode: 'ai' });
    const user = userEvent.setup();
    render(<CallHistory />);
    await user.click(await screen.findByTestId('call-details-1'));

    expect(await screen.findByTestId('call-detail-transcript')).toBeInTheDocument();
    expect(screen.getByText(/AI review/i)).toBeInTheDocument();
    expect(screen.queryByText(/not transcribed or scored/i)).not.toBeInTheDocument();
  });
});

/**
 * Recording availability.
 *
 * "No recording" must be stated, not implied by an absent section — the same
 * mistake the missing-transcript case made. And the recording URL determines
 * WHO gets our bearer token: Callified now serves audio from its own object
 * storage on a different origin, and sending our token there came back 401 on
 * audio that was perfectly fine.
 */
describe('<CallHistory /> — recording availability', () => {
  function withRecording(recordingUrl) {
    fetchApiMock.mockImplementation((url) => {
      if (typeof url === 'string' && url.startsWith('/api/callified/calls?')) {
        return Promise.resolve(listResponse([makeCall({ mode: 'browser' })]));
      }
      if (typeof url === 'string' && url.includes('/details')) {
        return Promise.resolve({
          transcripts: [{ id: 501, call_duration_s: 45, created_at: '2026-08-26 11:52:56', transcript: [], recording_url: recordingUrl }],
          reviews: [],
        });
      }
      return Promise.resolve({});
    });
  }

  it('says so plainly when a call has no recording', async () => {
    withRecording(null);
    const user = userEvent.setup();
    render(<CallHistory />);
    await user.click(await screen.findByTestId('call-details-1'));

    const panel = await screen.findByTestId('call-detail-no-recording');
    expect(panel).toHaveTextContent(/No recording available for this call/i);
    expect(screen.queryByTestId('call-detail-play')).not.toBeInTheDocument();
  });

  it('offers a play button when a recording exists', async () => {
    withRecording('/api/recordings/o/p/a.wav');
    const user = userEvent.setup();
    render(<CallHistory />);
    await user.click(await screen.findByTestId('call-details-1'));

    expect(await screen.findByTestId('call-detail-play')).toBeInTheDocument();
    expect(screen.queryByTestId('call-detail-no-recording')).not.toBeInTheDocument();
  });
});

/**
 * Period presets and the staff filter.
 *
 * Two raw date boxes made the common case ("this week", "this month") a
 * typing exercise. Presets fill the dates in one click; Custom hands over to
 * the shared range calendar. The staff filter answers "who called this
 * customer" without scanning the table.
 */
describe('<CallHistory /> — period presets', () => {
  it('This month asks for the 1st through today', async () => {
    const user = userEvent.setup();
    render(<CallHistory />);
    await screen.findByText('Mohit das');

    await user.selectOptions(screen.getByTestId('call-history-period'), 'month');

    await waitFor(() => {
      const q = listCalls().at(-1);
      expect(q.get('from')).toMatch(/^\d{4}-\d{2}-01T00:00:00$/);
      expect(q.get('to')).toBeTruthy();
    });
  });

  it('This week starts on a Monday', async () => {
    const user = userEvent.setup();
    render(<CallHistory />);
    await screen.findByText('Mohit das');

    await user.selectOptions(screen.getByTestId('call-history-period'), 'week');

    await waitFor(() => {
      const from = listCalls().at(-1).get('from');
      expect(from).toBeTruthy();
      // Monday === 1. Everyone in the clinic sees the same week.
      expect(new Date(from.slice(0, 10) + 'T12:00:00').getDay()).toBe(1);
    });
  });

  it('All time clears both dates', async () => {
    const user = userEvent.setup();
    render(<CallHistory />);
    await screen.findByText('Mohit das');

    await user.selectOptions(screen.getByTestId('call-history-period'), 'month');
    await waitFor(() => expect(listCalls().at(-1).get('from')).toBeTruthy());

    await user.selectOptions(screen.getByTestId('call-history-period'), '');

    await waitFor(() => {
      const q = listCalls().at(-1);
      expect(q.get('from')).toBeNull();
      expect(q.get('to')).toBeNull();
    });
  });

  it('Custom reveals the range calendar and presets do not', async () => {
    const user = userEvent.setup();
    render(<CallHistory />);
    await screen.findByText('Mohit das');

    expect(screen.queryByTestId('call-history-custom-range')).not.toBeInTheDocument();

    await user.selectOptions(screen.getByTestId('call-history-period'), 'custom');
    expect(await screen.findByTestId('call-history-custom-range')).toBeInTheDocument();
  });
});

describe('<CallHistory /> — staff filter', () => {
  it('lists only staff who have actually placed calls, busiest first', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (typeof url === 'string' && url.startsWith('/api/callified/calls?')) {
        return Promise.resolve(listResponse([makeCall()]));
      }
      if (url === '/api/callified/calls/agents') {
        return Promise.resolve({
          agents: [
            { id: 7, name: 'Ganesh Sharma', callCount: 29 },
            { id: 9, name: 'Priya Patel', callCount: 3 },
          ],
        });
      }
      return Promise.resolve({});
    });
    render(<CallHistory />);

    const select = await screen.findByTestId('call-history-staff');
    await waitFor(() => expect(select).toHaveTextContent('Ganesh Sharma (29)'));
    expect(select).toHaveTextContent('Priya Patel (3)');
    expect(select).toHaveTextContent('All staff');
  });

  it('filtering by a staff member reaches the query', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (typeof url === 'string' && url.startsWith('/api/callified/calls?')) {
        return Promise.resolve(listResponse([makeCall()]));
      }
      if (url === '/api/callified/calls/agents') {
        return Promise.resolve({ agents: [{ id: 7, name: 'Ganesh Sharma', callCount: 29 }] });
      }
      return Promise.resolve({});
    });
    const user = userEvent.setup();
    render(<CallHistory />);
    await screen.findByText('Mohit das');

    await user.selectOptions(await screen.findByTestId('call-history-staff'), '7');

    await waitFor(() => expect(listCalls().some((q) => q.get('userId') === '7')).toBe(true));
  });

  it('a failed agent lookup leaves the page usable', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (typeof url === 'string' && url.startsWith('/api/callified/calls?')) {
        return Promise.resolve(listResponse([makeCall()]));
      }
      if (url === '/api/callified/calls/agents') return Promise.reject(new Error('boom'));
      return Promise.resolve({});
    });
    render(<CallHistory />);

    expect(await screen.findByText('Mohit das')).toBeInTheDocument();
    expect(screen.getByTestId('call-history-staff')).toHaveTextContent('All staff');
  });
});

/**
 * Who can see whose calls.
 *
 * A call recording is a real patient discussing real treatment, so the default
 * is "your own only". The server enforces it — this pins that the UI does not
 * offer a staff filter that cannot do anything, which would otherwise read as
 * a broken control.
 */
describe('<CallHistory /> — call visibility scope', () => {
  function withScope(scope, agents = []) {
    fetchApiMock.mockImplementation((url) => {
      if (typeof url === 'string' && url.startsWith('/api/callified/calls?')) {
        return Promise.resolve({ ...listResponse([makeCall()]), scope });
      }
      if (url === '/api/callified/calls/agents') return Promise.resolve({ agents, scope });
      return Promise.resolve({});
    });
  }

  it('hides the staff filter when the user only sees their own calls', async () => {
    withScope('own');
    render(<CallHistory />);
    await screen.findByText('Mohit das');

    await waitFor(() =>
      expect(screen.queryByTestId('call-history-staff')).not.toBeInTheDocument(),
    );
  });

  it('shows the staff filter for someone who can see everyone', async () => {
    withScope('all', [{ id: 7, name: 'Ganesh Sharma', callCount: 4 }]);
    render(<CallHistory />);
    await screen.findByText('Mohit das');

    expect(await screen.findByTestId('call-history-staff')).toBeInTheDocument();
  });

  it('own-scope users still get the rest of the page', async () => {
    withScope('own');
    render(<CallHistory />);

    // Scoping restricts WHOSE calls, not what you can do with your own.
    expect(await screen.findByText('Mohit das')).toBeInTheDocument();
    expect(screen.getByTestId('call-history-period')).toBeInTheDocument();
    expect(screen.getByTestId('call-history-mode')).toBeInTheDocument();
    expect(screen.getByTestId('call-details-1')).toBeInTheDocument();
  });
});
