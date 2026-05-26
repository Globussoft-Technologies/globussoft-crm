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
 *   2. Tab strip (Zylu-Gap #796) — All / Unread / Blocked tabs render with
 *      counts; selecting Unread re-fetches with ?unread=true; selecting
 *      Blocked fetches /api/whatsapp/opt-outs and renders opt-out rows.
 *   3. Search box — typing a query + submitting the form re-fetches with
 *      ?q=<query>.
 *   4. Open thread — clicking a row fetches /api/whatsapp/threads/:id and
 *      renders messages from `detail.messages` in the right pane.
 *   5. Reply send — typing in the textarea + clicking Send POSTs
 *      /api/whatsapp/send with { to: <contactPhone>, body: <reply> }.
 *      Ctrl+Enter inside the textarea also triggers send.
 *   6. Assign-to-me — POST /api/whatsapp/threads/:id/assign with
 *      `targetUserId` (NOT `userId` — stripDangerous deletes the latter
 *      per CLAUDE.md standing rules; the bug at #646 was that the page
 *      was sending the stripped key, which the backend interpreted as
 *      "unassign").
 *   7. Close thread — POST /api/whatsapp/threads/:id/close after the
 *      confirm() resolves true.
 *   8. Snooze — prompt() collects hours; POST /snooze with `until` field
 *      (ISO timestamp `Date.now() + hours * 3.6e6`).
 *   9. Opt-out reply gate — when `detail.optedOut` is set, the right
 *      pane renders the DPDP/TRAI compliance chip AND the reply textarea
 *      + Send button are NOT rendered (DPDP-mandated reply lockout).
 *  10. 24-hour window banner (Zylu-Gap #798) — banner reads OPEN when the
 *      latest inbound is <24h old (free-form allowed) and CLOSED when
 *      no inbound exists OR latest inbound is >24h ago (compose textarea
 *      disabled). Server-side authoritative gate is OUTSIDE_24H_WINDOW
 *      at routes/whatsapp.js:145.
 *  11. Template picker (Zylu-Gap #797) — Templates button opens a modal,
 *      fetches /api/whatsapp/templates, and substitutes {{name}} /
 *      {{phone}} variables from the active thread when "Use this template"
 *      drops the body into the reply textarea.
 *
 * Backend contracts pinned by this test
 * ─────────────────────────────────────
 *   - GET  /api/whatsapp/threads?limit=50[&unread][&q]
 *   - GET  /api/whatsapp/threads/:id            (returns { thread, messages, optedOut })
 *   - GET  /api/whatsapp/opt-outs?limit=100     (Blocked tab data)
 *   - GET  /api/whatsapp/templates              (template picker)
 *   - POST /api/whatsapp/threads/:id/mark-read  (auto-fired when unreadCount > 0)
 *   - POST /api/whatsapp/threads/:id/assign     ({ targetUserId })
 *   - POST /api/whatsapp/threads/:id/close
 *   - POST /api/whatsapp/threads/:id/snooze     ({ until })
 *   - POST /api/whatsapp/send                   ({ to, body })
 *
 * Why a frontend test, not a backend / API test
 * ─────────────────────────────────────────────
 *   The backend route shapes are covered by e2e/tests/whatsapp-api.spec.js.
 *   This file pins the page surface — that the tab strip wires to the right
 *   query strings, that the reply box honours the opt-out + 24h gates, that
 *   the template picker substitutes variables, and that "Assign to me"
 *   sends `targetUserId` (which would silently break if a refactor reverted
 *   to `userId`).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

// RTL standing rule (CLAUDE.md) — return ONE stable mock object across the
// run for hooks landed in useCallback / useMemo dependency arrays.
const notifyObj = {
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  confirm: vi.fn(() => Promise.resolve(true)),
  prompt: vi.fn(() => Promise.resolve('4')),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
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
  // Inbound 10 minutes ago — well inside the 24h window.
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

// 24h-closed thread — last inbound was 2 days ago.
const sampleDetailClosed = {
  thread: {
    id: 14,
    contactPhone: '+919811112222',
    contact: { name: 'Cold Contact' },
    patient: null,
    status: 'OPEN',
    unreadCount: 0,
    assignedTo: null,
    snoozedUntil: null,
    lastInboundAt: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
  },
  messages: [
    {
      id: 2001,
      direction: 'INBOUND',
      body: 'Old message',
      status: 'DELIVERED',
      createdAt: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
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

const sampleOptOuts = [
  {
    id: 501,
    contactPhone: '+919999988888',
    reason: 'STOP_KEYWORD',
    capturedAt: new Date(Date.now() - 86_400_000).toISOString(),
    notes: null,
  },
  {
    id: 502,
    contactPhone: '+919999977777',
    reason: 'USER_REQUESTED',
    capturedAt: new Date(Date.now() - 3_600_000).toISOString(),
    notes: null,
  },
];

const sampleTemplates = [
  {
    id: 901,
    name: 'appointment_reminder',
    body: 'Hi {{name}}, your appointment is tomorrow at {{appointment_time}}. — Globussoft Clinic',
    status: 'APPROVED',
    category: 'UTILITY',
  },
  {
    id: 902,
    name: 'welcome',
    body: 'Welcome {{firstName}}! Reply YES to confirm.',
    status: 'PENDING',
    category: 'MARKETING',
  },
];

function defaultFetch(url, opts) {
  if (!opts || !opts.method || opts.method === 'GET') {
    if (url.startsWith('/api/whatsapp/threads/11')) {
      return Promise.resolve(sampleDetailOpen);
    }
    if (url.startsWith('/api/whatsapp/threads/13')) {
      return Promise.resolve(sampleDetailOptedOut);
    }
    if (url.startsWith('/api/whatsapp/threads/14')) {
      return Promise.resolve(sampleDetailClosed);
    }
    if (url.startsWith('/api/whatsapp/threads')) {
      return Promise.resolve({ threads: sampleThreads });
    }
    if (url.startsWith('/api/whatsapp/opt-outs')) {
      return Promise.resolve({ optOuts: sampleOptOuts });
    }
    if (url.startsWith('/api/whatsapp/templates')) {
      return Promise.resolve(sampleTemplates);
    }
  }
  if (opts?.method === 'POST') {
    return Promise.resolve({ success: true });
  }
  return Promise.resolve({});
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyObj.error.mockReset();
  notifyObj.info.mockReset();
  notifyObj.success.mockReset();
  notifyObj.confirm.mockReset();
  notifyObj.confirm.mockImplementation(() => Promise.resolve(true));
  notifyObj.prompt.mockReset();
  notifyObj.prompt.mockImplementation(() => Promise.resolve('4'));
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
    // The first thread has unreadCount=2 — the badge is the literal text "2"
    // in the row. Use getAllByText since "2" is a common token (tab count
    // for All also reads as numbers).
    await screen.findByText('Rishu Goyal');
    expect(screen.getAllByText('2').length).toBeGreaterThan(0);
  });
});

// #796 — All / Unread / Blocked tab strip replaces the prior status-dropdown
// + unread-checkbox surface.
describe('<WhatsAppThreads /> — All/Unread/Blocked tabs (#796)', () => {
  it('renders three tabs with counts on the left rail', async () => {
    render(<WhatsAppThreads />);
    await screen.findByText('Rishu Goyal');

    const tablist = screen.getByTestId('whatsapp-thread-tabs');
    expect(within(tablist).getByTestId('whatsapp-tab-all')).toBeInTheDocument();
    expect(within(tablist).getByTestId('whatsapp-tab-unread')).toBeInTheDocument();
    expect(within(tablist).getByTestId('whatsapp-tab-blocked')).toBeInTheDocument();
  });

  it('selecting the Unread tab re-fetches with ?unread=true', async () => {
    const user = userEvent.setup();
    render(<WhatsAppThreads />);
    await screen.findByText('Rishu Goyal');

    fetchApiMock.mockClear();
    await user.click(screen.getByTestId('whatsapp-tab-unread'));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url]) => typeof url === 'string' && url.includes('unread=true')
      );
      expect(call).toBeTruthy();
    });
  });

  it('selecting the Blocked tab fetches /api/whatsapp/opt-outs and renders opt-out rows', async () => {
    const user = userEvent.setup();
    render(<WhatsAppThreads />);
    await screen.findByText('Rishu Goyal');

    fetchApiMock.mockClear();
    await user.click(screen.getByTestId('whatsapp-tab-blocked'));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url]) => typeof url === 'string' && url.startsWith('/api/whatsapp/opt-outs')
      );
      expect(call).toBeTruthy();
    });

    // Opt-out phones render in the rail.
    expect(await screen.findByTestId('whatsapp-blocked-row-501')).toBeInTheDocument();
    expect(screen.getByText('+919999988888')).toBeInTheDocument();
  });
});

describe('<WhatsAppThreads /> — search box', () => {
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

    const textarea = await screen.findByTestId('whatsapp-reply-textarea');
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

    const textarea = await screen.findByTestId('whatsapp-reply-textarea');
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
    expect(notifyObj.confirm).toHaveBeenCalled();
  });

  it('clicking "Snooze" collects hours via prompt() then POSTs /snooze with an `until` ISO timestamp', async () => {
    const user = userEvent.setup();
    notifyObj.prompt.mockImplementation(() => Promise.resolve('4'));
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

// #798 — Meta 24-hour window banner gates free-form sends.
describe('<WhatsAppThreads /> — 24-hour window banner (#798)', () => {
  it('renders the OPEN banner when latest inbound is within 24h', async () => {
    const user = userEvent.setup();
    render(<WhatsAppThreads />);
    await user.click(await screen.findByText('Rishu Goyal'));
    const banner = await screen.findByTestId('whatsapp-24h-banner');
    expect(banner).toBeInTheDocument();
    expect(banner.getAttribute('data-window-open')).toBe('true');
    expect(banner).toHaveTextContent(/24-hour window open/i);
  });

  it('renders the CLOSED banner + disables compose when latest inbound is >24h ago', async () => {
    // Override list to put thread 14 (closed-window) in the inbox.
    fetchApiMock.mockImplementation((url, opts) => {
      if (!opts || !opts.method || opts.method === 'GET') {
        if (url.startsWith('/api/whatsapp/threads/14')) {
          return Promise.resolve(sampleDetailClosed);
        }
        if (url.startsWith('/api/whatsapp/threads')) {
          return Promise.resolve({
            threads: [{
              id: 14,
              contactPhone: '+919811112222',
              contact: { name: 'Cold Contact' },
              patient: null,
              unreadCount: 0,
              status: 'OPEN',
              lastMessageAt: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
              assignedTo: null,
            }],
          });
        }
        if (url.startsWith('/api/whatsapp/templates')) {
          return Promise.resolve(sampleTemplates);
        }
      }
      return Promise.resolve({});
    });

    const user = userEvent.setup();
    render(<WhatsAppThreads />);
    await user.click(await screen.findByText('Cold Contact'));

    const banner = await screen.findByTestId('whatsapp-24h-banner');
    expect(banner.getAttribute('data-window-open')).toBe('false');
    expect(banner).toHaveTextContent(/24-hour window closed/i);

    // Compose textarea is disabled outside the window — only templates allowed.
    const textarea = await screen.findByTestId('whatsapp-reply-textarea');
    expect(textarea).toBeDisabled();
    // Send button also disabled.
    expect(screen.getByRole('button', { name: /^Send$/ })).toBeDisabled();
  });
});

// #797 — Template picker with {{variable}} substitution.
describe('<WhatsAppThreads /> — Template picker (#797)', () => {
  it('clicking Templates opens the modal and fetches /api/whatsapp/templates', async () => {
    const user = userEvent.setup();
    render(<WhatsAppThreads />);
    await user.click(await screen.findByText('Rishu Goyal'));
    await screen.findByText('Hi, can I book a follow-up?');

    await user.click(screen.getByTestId('whatsapp-pick-template'));

    // Modal opens.
    expect(await screen.findByTestId('whatsapp-template-modal')).toBeInTheDocument();
    // Templates fetched.
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url]) => typeof url === 'string' && url === '/api/whatsapp/templates'
      );
      expect(call).toBeTruthy();
    });
    // Both template rows rendered.
    expect(await screen.findByTestId('whatsapp-template-row-901')).toBeInTheDocument();
    expect(screen.getByTestId('whatsapp-template-row-902')).toBeInTheDocument();
  });

  it('substitutes {{name}} from the active thread when previewing a template', async () => {
    const user = userEvent.setup();
    render(<WhatsAppThreads />);
    await user.click(await screen.findByText('Rishu Goyal'));
    await screen.findByText('Hi, can I book a follow-up?');

    await user.click(screen.getByTestId('whatsapp-pick-template'));
    await screen.findByTestId('whatsapp-template-row-901');

    // The appointment_reminder body has "{{name}}" which should be replaced
    // with the contact name "Rishu Goyal" in the preview text. The
    // {{appointment_time}} variable has no source so it stays as-is.
    const row = screen.getByTestId('whatsapp-template-row-901');
    expect(row).toHaveTextContent(/Hi Rishu Goyal/);
    expect(row).toHaveTextContent(/\{\{appointment_time\}\}/);
  });

  it('clicking "Use this template" drops the substituted body into the reply textarea', async () => {
    const user = userEvent.setup();
    render(<WhatsAppThreads />);
    await user.click(await screen.findByText('Rishu Goyal'));
    await screen.findByText('Hi, can I book a follow-up?');

    await user.click(screen.getByTestId('whatsapp-pick-template'));
    await user.click(await screen.findByTestId('whatsapp-template-use-902'));

    const textarea = await screen.findByTestId('whatsapp-reply-textarea');
    // Template 902 body is "Welcome {{firstName}}! Reply YES to confirm."
    // firstName resolves to "Rishu" (first whitespace token of "Rishu Goyal").
    expect(textarea.value).toContain('Welcome Rishu!');
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
    expect(screen.queryByTestId('whatsapp-reply-textarea')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Send$/ })).not.toBeInTheDocument();

    // The DPDP / TRAI lockout copy renders in its place.
    expect(
      screen.getByText(/Reply box disabled — contact has opted out \(DPDP\/TRAI compliance\)/i)
    ).toBeInTheDocument();
  });
});
