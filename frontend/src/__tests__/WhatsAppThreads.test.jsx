/**
 * WhatsAppThreads.jsx — agent inbox for 2-way WhatsApp messaging.
 *
 * Carry-over from v3.5.0 → v3.5.1 → v3.5.2: the WhatsAppThreads page shipped
 * in Wave 2C `97b157f` (WhatsApp 2-way completion: Thread + agent assignment
 * + opt-out) but had zero frontend component coverage. This file pins the
 * page surface so the per-push gate's `frontend_unit_tests` job catches
 * regressions to the agent-inbox affordances.
 *
 * What this test pins
 * ───────────────────
 *   1. Thread list render — GET /api/whatsapp/threads renders one row per
 *      thread with display name + phone + unread badge + status pill.
 *   2. Status filter — selecting "Open" re-fetches with ?status=OPEN.
 *   3. Unread filter — toggling the "Unread" checkbox re-fetches with
 *      ?unread=true.
 *   4. Search box — typing a query + submitting the form re-fetches with
 *      ?q=<query>.
 *   5. Open thread — clicking a row fetches /api/whatsapp/threads/:id and
 *      renders messages from `detail.messages` in the right pane.
 *   6. Reply send — typing in the textarea + clicking Send POSTs
 *      /api/whatsapp/send with { to: <contactPhone>, body: <reply> }.
 *      Ctrl+Enter inside the textarea also triggers send.
 *   7. Assign-to-me — POST /api/whatsapp/threads/:id/assign with
 *      `targetUserId` (NOT `userId` — stripDangerous deletes the latter
 *      per CLAUDE.md standing rules; the bug at #646 was that the page
 *      was sending the stripped key, which the backend interpreted as
 *      "unassign").
 *   8. Close thread — POST /api/whatsapp/threads/:id/close after the
 *      confirm() resolves true.
 *   9. Snooze — prompt() collects hours; POST /snooze with `until` field
 *      (ISO timestamp `Date.now() + hours * 3.6e6`).
 *  10. Opt-out reply gate — when `detail.optedOut` is set, the right
 *      pane renders the DPDP/TRAI compliance chip AND the reply textarea
 *      + Send button are NOT rendered (DPDP-mandated reply lockout).
 *
 * Backend contracts pinned by this test
 * ─────────────────────────────────────
 *   - GET  /api/whatsapp/threads?limit=50[&status][&unread][&q]
 *   - GET  /api/whatsapp/threads/:id            (returns { thread, messages, optedOut })
 *   - POST /api/whatsapp/threads/:id/mark-read  (auto-fired when unreadCount > 0)
 *   - POST /api/whatsapp/threads/:id/assign     ({ targetUserId })
 *   - POST /api/whatsapp/threads/:id/close
 *   - POST /api/whatsapp/threads/:id/snooze     ({ until })
 *   - POST /api/whatsapp/send                   ({ to, body })
 *
 * Why a frontend test, not a backend / API test
 * ─────────────────────────────────────────────
 *   The backend route shapes are covered by e2e/tests/whatsapp-api.spec.js.
 *   This file pins the page surface — that the filters wire to the right
 *   query strings, that the reply box honours the opt-out gate, that
 *   "Assign to me" sends `targetUserId` (which would silently break if a
 *   refactor reverted to `userId`).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyConfirm = vi.fn(() => Promise.resolve(true));
const notifyPrompt = vi.fn(() => Promise.resolve('4'));
vi.mock('../utils/notify', () => ({
  useNotify: () => ({
    error: notifyError,
    info: vi.fn(),
    success: notifySuccess,
    confirm: notifyConfirm,
    prompt: notifyPrompt,
  }),
  NotifyProvider: ({ children }) => children,
}));

import WhatsAppThreads from '../pages/wellness/WhatsAppThreads';

// jsdom doesn't ship scrollIntoView; the page calls it on a ref after each
// detail load. Stub it once so the messages-end ref doesn't blow up.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function () {};
}

const sampleThreads = [
  {
    id: 11,
    contactPhone: '+919876543210',
    contact: { name: 'Rishu Goyal' },
    patient: null,
    unreadCount: 2,
    status: 'OPEN',
    lastMessageAt: new Date().toISOString(),
    assignedTo: null,
  },
  {
    id: 12,
    contactPhone: '+919812345678',
    contact: null,
    patient: { name: 'Priya Sharma' },
    unreadCount: 0,
    status: 'PENDING_AGENT',
    lastMessageAt: new Date(Date.now() - 3_600_000).toISOString(),
    assignedTo: { id: 7, name: 'Dr Harsh' },
  },
];

const sampleDetailOpen = {
  thread: {
    id: 11,
    contactPhone: '+919876543210',
    contact: { name: 'Rishu Goyal' },
    patient: null,
    status: 'OPEN',
    unreadCount: 2,
    assignedTo: null,
    snoozedUntil: null,
  },
  messages: [
    {
      id: 1001,
      direction: 'INBOUND',
      body: 'Hi, can I book a follow-up?',
      status: 'DELIVERED',
      createdAt: new Date(Date.now() - 600_000).toISOString(),
    },
    {
      id: 1002,
      direction: 'OUTBOUND',
      body: 'Yes — sending you a slot link now.',
      status: 'SENT',
      createdAt: new Date(Date.now() - 300_000).toISOString(),
    },
  ],
  optedOut: null,
};

const sampleDetailOptedOut = {
  thread: {
    id: 13,
    contactPhone: '+919900000000',
    contact: { name: 'Stop User' },
    patient: null,
    status: 'OPEN',
    unreadCount: 0,
    assignedTo: null,
    snoozedUntil: null,
  },
  messages: [
    {
      id: 1003,
      direction: 'INBOUND',
      body: 'STOP',
      status: 'DELIVERED',
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    },
  ],
  optedOut: {
    reason: 'KEYWORD_STOP',
    capturedAt: new Date().toISOString(),
  },
};

function defaultFetch(url, opts) {
  if (!opts || !opts.method || opts.method === 'GET') {
    if (url.startsWith('/api/whatsapp/threads/11')) {
      return Promise.resolve(sampleDetailOpen);
    }
    if (url.startsWith('/api/whatsapp/threads/13')) {
      return Promise.resolve(sampleDetailOptedOut);
    }
    if (url.startsWith('/api/whatsapp/threads')) {
      return Promise.resolve({ threads: sampleThreads });
    }
  }
  if (opts?.method === 'POST') {
    return Promise.resolve({ success: true });
  }
  return Promise.resolve({});
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyError.mockReset();
  notifySuccess.mockReset();
  notifyConfirm.mockReset();
  notifyConfirm.mockImplementation(() => Promise.resolve(true));
  notifyPrompt.mockReset();
  notifyPrompt.mockImplementation(() => Promise.resolve('4'));
  fetchApiMock.mockImplementation(defaultFetch);
  // Seed localStorage with a logged-in user for assign-to-me.
  window.localStorage.setItem(
    'user',
    JSON.stringify({ id: 99, name: 'Demo Agent', email: 'agent@demo.com' })
  );
});

describe('<WhatsAppThreads /> — thread list rendering', () => {
  it('fetches /api/whatsapp/threads on mount and renders one row per thread', async () => {
    render(<WhatsAppThreads />);

    // First load includes the limit param.
    await waitFor(() => {
      const listCall = fetchApiMock.mock.calls.find(
        ([url]) => typeof url === 'string' && url.startsWith('/api/whatsapp/threads?')
      );
      expect(listCall).toBeTruthy();
      expect(listCall[0]).toContain('limit=50');
    });

    // Both rows render with their display names + phones.
    expect(await screen.findByText('Rishu Goyal')).toBeInTheDocument();
    expect(screen.getByText('Priya Sharma')).toBeInTheDocument();
    expect(screen.getByText('+919876543210')).toBeInTheDocument();
    expect(screen.getByText('+919812345678')).toBeInTheDocument();
  });

  it('renders an unread badge for threads with unreadCount > 0', async () => {
    render(<WhatsAppThreads />);
    // The first thread has unreadCount=2.
    expect(await screen.findByText('2')).toBeInTheDocument();
  });
});

describe('<WhatsAppThreads /> — list filters', () => {
  it('changing the status filter re-fetches with ?status=OPEN', async () => {
    const user = userEvent.setup();
    render(<WhatsAppThreads />);
    await screen.findByText('Rishu Goyal');

    fetchApiMock.mockClear();
    // The status filter is the only <select> on the page.
    const select = screen.getByRole('combobox');
    await user.selectOptions(select, 'OPEN');

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url]) => typeof url === 'string' && url.includes('status=OPEN')
      );
      expect(call).toBeTruthy();
    });
  });

  it('toggling the Unread checkbox re-fetches with ?unread=true', async () => {
    const user = userEvent.setup();
    render(<WhatsAppThreads />);
    await screen.findByText('Rishu Goyal');

    fetchApiMock.mockClear();
    const unreadCheckbox = screen.getByRole('checkbox');
    await user.click(unreadCheckbox);

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url]) => typeof url === 'string' && url.includes('unread=true')
      );
      expect(call).toBeTruthy();
    });
  });

  it('typing in search + clicking Go re-fetches with ?q=<query>', async () => {
    const user = userEvent.setup();
    render(<WhatsAppThreads />);
    await screen.findByText('Rishu Goyal');

    fetchApiMock.mockClear();
    const search = screen.getByPlaceholderText(/Phone or contact name/i);
    await user.type(search, 'Rishu');
    await user.click(screen.getByRole('button', { name: /^Go$/ }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url]) => typeof url === 'string' && url.includes('q=Rishu')
      );
      expect(call).toBeTruthy();
    });
  });
});

describe('<WhatsAppThreads /> — opening a thread', () => {
  it('clicking a row fetches /api/whatsapp/threads/:id and renders messages in the right pane', async () => {
    const user = userEvent.setup();
    render(<WhatsAppThreads />);
    await user.click(await screen.findByText('Rishu Goyal'));

    await waitFor(() => {
      const detailCall = fetchApiMock.mock.calls.find(
        ([url]) => typeof url === 'string' && url === '/api/whatsapp/threads/11'
      );
      expect(detailCall).toBeTruthy();
    });

    // Both messages render in the right pane.
    expect(await screen.findByText('Hi, can I book a follow-up?')).toBeInTheDocument();
    expect(screen.getByText('Yes — sending you a slot link now.')).toBeInTheDocument();
  });

  it('auto-fires POST /mark-read when the opened thread has unreadCount > 0', async () => {
    const user = userEvent.setup();
    render(<WhatsAppThreads />);
    await user.click(await screen.findByText('Rishu Goyal'));

    await waitFor(() => {
      const markRead = fetchApiMock.mock.calls.find(
        ([url, opts]) =>
          url === '/api/whatsapp/threads/11/mark-read' && opts?.method === 'POST'
      );
      expect(markRead).toBeTruthy();
    });
  });
});

describe('<WhatsAppThreads /> — reply send', () => {
  it('typing in the reply textarea + clicking Send POSTs /api/whatsapp/send with { to, body }', async () => {
    const user = userEvent.setup();
    render(<WhatsAppThreads />);
    await user.click(await screen.findByText('Rishu Goyal'));

    const textarea = await screen.findByPlaceholderText(/Type a reply/i);
    await user.type(textarea, 'Slot is at 4pm');
    await user.click(screen.getByRole('button', { name: /^Send$/ }));

    await waitFor(() => {
      const sendCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/whatsapp/send' && opts?.method === 'POST'
      );
      expect(sendCall).toBeTruthy();
      const sentBody = JSON.parse(sendCall[1].body);
      expect(sentBody.to).toBe('+919876543210');
      expect(sentBody.body).toBe('Slot is at 4pm');
    });
  });

  it('Ctrl+Enter inside the textarea triggers POST /api/whatsapp/send', async () => {
    const user = userEvent.setup();
    render(<WhatsAppThreads />);
    await user.click(await screen.findByText('Rishu Goyal'));

    const textarea = await screen.findByPlaceholderText(/Type a reply/i);
    await user.type(textarea, 'Reply via shortcut');
    // userEvent's keyboard syntax for Ctrl+Enter chord.
    await user.keyboard('{Control>}{Enter}{/Control}');

    await waitFor(() => {
      const sendCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/whatsapp/send' && opts?.method === 'POST'
      );
      expect(sendCall).toBeTruthy();
      const sentBody = JSON.parse(sendCall[1].body);
      expect(sentBody.body).toBe('Reply via shortcut');
    });
  });
});

describe('<WhatsAppThreads /> — header actions', () => {
  it('clicking "Assign to me" POSTs /assign with targetUserId (NOT userId — stripDangerous regression #646)', async () => {
    const user = userEvent.setup();
    render(<WhatsAppThreads />);
    await user.click(await screen.findByText('Rishu Goyal'));
    await screen.findByText('Hi, can I book a follow-up?');

    await user.click(screen.getByRole('button', { name: /Assign to me/i }));

    await waitFor(() => {
      const assignCall = fetchApiMock.mock.calls.find(
        ([url, opts]) =>
          url === '/api/whatsapp/threads/11/assign' && opts?.method === 'POST'
      );
      expect(assignCall).toBeTruthy();
      const sentBody = JSON.parse(assignCall[1].body);
      // The page MUST send `targetUserId`, not `userId`. The global
      // stripDangerous middleware deletes `userId` on every request, so
      // sending `userId` would silently land at the backend as `{}` and
      // unassign instead of assigning. This is the explicit regression
      // surface for #646.
      expect(sentBody.targetUserId).toBe(99);
      expect(sentBody.userId).toBeUndefined();
    });
  });

  it('clicking "Close" prompts then POSTs /api/whatsapp/threads/:id/close', async () => {
    const user = userEvent.setup();
    render(<WhatsAppThreads />);
    await user.click(await screen.findByText('Rishu Goyal'));
    await screen.findByText('Hi, can I book a follow-up?');

    await user.click(screen.getByRole('button', { name: /^Close$/ }));

    await waitFor(() => {
      const closeCall = fetchApiMock.mock.calls.find(
        ([url, opts]) =>
          url === '/api/whatsapp/threads/11/close' && opts?.method === 'POST'
      );
      expect(closeCall).toBeTruthy();
    });
    // Confirm() must have been invoked first — this is a destructive action.
    expect(notifyConfirm).toHaveBeenCalled();
  });

  it('clicking "Snooze" collects hours via prompt() then POSTs /snooze with an `until` ISO timestamp', async () => {
    const user = userEvent.setup();
    notifyPrompt.mockImplementation(() => Promise.resolve('4'));
    render(<WhatsAppThreads />);
    await user.click(await screen.findByText('Rishu Goyal'));
    await screen.findByText('Hi, can I book a follow-up?');

    await user.click(screen.getByRole('button', { name: /Snooze/i }));

    await waitFor(() => {
      const snoozeCall = fetchApiMock.mock.calls.find(
        ([url, opts]) =>
          url === '/api/whatsapp/threads/11/snooze' && opts?.method === 'POST'
      );
      expect(snoozeCall).toBeTruthy();
      const sentBody = JSON.parse(snoozeCall[1].body);
      expect(sentBody.until).toBeTruthy();
      // `until` should be an ISO string parseable as a future Date.
      const untilMs = new Date(sentBody.until).getTime();
      expect(Number.isFinite(untilMs)).toBe(true);
      expect(untilMs).toBeGreaterThan(Date.now());
    });
  });
});

describe('<WhatsAppThreads /> — opt-out reply gate (DPDP / TRAI)', () => {
  beforeEach(() => {
    // Override defaultFetch so the list returns a thread whose detail is
    // an opted-out contact.
    fetchApiMock.mockImplementation((url, opts) => {
      if (!opts || !opts.method || opts.method === 'GET') {
        if (url.startsWith('/api/whatsapp/threads/13')) {
          return Promise.resolve(sampleDetailOptedOut);
        }
        if (url.startsWith('/api/whatsapp/threads')) {
          return Promise.resolve({
            threads: [
              {
                id: 13,
                contactPhone: '+919900000000',
                contact: { name: 'Stop User' },
                patient: null,
                unreadCount: 0,
                status: 'OPEN',
                lastMessageAt: new Date().toISOString(),
                assignedTo: null,
              },
            ],
          });
        }
      }
      if (opts?.method === 'POST') {
        return Promise.resolve({ success: true });
      }
      return Promise.resolve({});
    });
  });

  it('renders the "Opted out" chip in the right-pane header when detail.optedOut is set', async () => {
    const user = userEvent.setup();
    render(<WhatsAppThreads />);
    await user.click(await screen.findByText('Stop User'));

    // The chip text quotes the reason.
    expect(await screen.findByText(/Opted out \(KEYWORD_STOP\)/i)).toBeInTheDocument();
  });

  it('hides the reply textarea + Send button and shows the DPDP/TRAI compliance lockout message', async () => {
    const user = userEvent.setup();
    render(<WhatsAppThreads />);
    await user.click(await screen.findByText('Stop User'));
    // Wait for the chip (specifically — the action button uses "Opt out"
    // without the trailing 'ed', so /Opted out/i would not match it; but
    // belt-and-braces use the full reason-bearing chip copy).
    await screen.findByText(/Opted out \(KEYWORD_STOP\)/i);

    // The textarea must NOT be in the DOM (the page conditionally renders
    // the lockout copy instead of the reply box when optedOut is truthy).
    expect(screen.queryByPlaceholderText(/Type a reply/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Send$/ })).not.toBeInTheDocument();

    // The DPDP / TRAI lockout copy renders in its place.
    expect(
      screen.getByText(/Reply box disabled — contact has opted out \(DPDP\/TRAI compliance\)/i)
    ).toBeInTheDocument();
  });
});
