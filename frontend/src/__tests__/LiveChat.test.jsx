/**
 * LiveChat.jsx — page surface regression pin.
 *
 * What this test pins
 * ───────────────────
 *   The page wires four real-time chat affordances:
 *     1. Session list (GET /api/live-chat) with loading + empty + populated states.
 *     2. Stats header (GET /api/live-chat/stats) — "X active · Y closed today".
 *     3. Active-thread fetch (GET /api/live-chat/:id) + message rendering.
 *     4. Composer (POST /api/live-chat/:id/messages), assign
 *        (POST /api/live-chat/:id/assign), close
 *        (POST /api/live-chat/:id/close) with optional rating.
 *
 *   #476 — the green pill ("Online") in the header is a passive status
 *   indicator, NOT a toggle. It must render with role="status" + cursor:default
 *   so the affordance matches reality. A real online/offline switch needs a
 *   backend agent-presence API that doesn't exist yet.
 *
 * Backend contracts pinned
 * ────────────────────────
 *   - GET  /api/live-chat
 *   - GET  /api/live-chat/stats
 *   - GET  /api/live-chat/:id              → { session, messages[] }
 *   - POST /api/live-chat/:id/messages     body: { body }
 *   - POST /api/live-chat/:id/assign       body: {}
 *   - POST /api/live-chat/:id/close        body: { rating? }
 *
 * Why a frontend test, not a backend / API test
 * ─────────────────────────────────────────────
 *   The route handlers + socket fan-out are covered server-side.
 *   This file pins the page surface — that the list / thread / composer /
 *   action buttons render the right shape and POST the right body. The
 *   socket.io-client module is mocked so the unit test does not require a
 *   running server.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ─── Mocks (stable references; see CLAUDE.md "RTL: stable mock object
// references" standing rule — fresh objects per call cause re-render loops).

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

const notifyObj = {
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  confirm: () => Promise.resolve(true),
  prompt: () => Promise.resolve(''),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
  NotifyProvider: ({ children }) => children,
}));

// socket.io-client — return a stable spy-bag so we can assert
// connect/join_room/disconnect were wired even though no real socket exists.
const socketBag = {
  handlers: {},
  on: vi.fn((evt, cb) => { socketBag.handlers[evt] = cb; }),
  emit: vi.fn(),
  off: vi.fn(),
  disconnect: vi.fn(),
};
vi.mock('socket.io-client', () => ({
  io: () => socketBag,
}));

import LiveChat from '../pages/LiveChat';
import { AuthContext } from '../App';

// ─── Helpers / fixtures.

const sampleSessions = [
  {
    id: 11,
    visitorName: 'Aanya Sharma',
    visitorEmail: 'aanya@example.com',
    visitorId: 'v-aanya',
    status: 'OPEN',
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    lastMessage: {
      id: 901,
      body: 'Need help choosing a plan',
      sender: 'visitor',
      createdAt: new Date(Date.now() - 30_000).toISOString(),
    },
  },
  {
    id: 12,
    visitorName: 'Rohan Mehta',
    visitorEmail: 'rohan@example.com',
    visitorId: 'v-rohan',
    status: 'ASSIGNED',
    startedAt: new Date(Date.now() - 120_000).toISOString(),
    lastMessage: {
      id: 902,
      body: 'Thanks for the call',
      sender: 'agent',
      createdAt: new Date(Date.now() - 90_000).toISOString(),
    },
  },
];

const sampleStats = { open: 3, assigned: 2, closedToday: 7 };

const sampleThread = {
  session: { ...sampleSessions[0] },
  messages: [
    { id: 9001, sender: 'system', body: 'Session started', createdAt: new Date().toISOString() },
    { id: 9002, sender: 'visitor', body: 'Hi, are you there?', createdAt: new Date().toISOString() },
    { id: 9003, sender: 'agent', body: 'Yes, how can I help?', createdAt: new Date().toISOString() },
  ],
};

function defaultFetch(url, opts) {
  if (!opts || !opts.method || opts.method === 'GET') {
    if (url === '/api/live-chat') return Promise.resolve(sampleSessions);
    if (url === '/api/live-chat/stats') return Promise.resolve(sampleStats);
    if (url === '/api/live-chat/11') return Promise.resolve(sampleThread);
    if (url === '/api/live-chat/12') {
      return Promise.resolve({
        session: { ...sampleSessions[1] },
        messages: [
          { id: 9101, sender: 'agent', body: 'Hello Rohan', createdAt: new Date().toISOString() },
        ],
      });
    }
  }
  if (opts?.method === 'POST') {
    return Promise.resolve({ ok: true });
  }
  return Promise.resolve([]);
}

function renderLiveChat(authValue = {
  user: { id: 1, name: 'Test Agent', role: 'ADMIN' },
  tenant: { id: 1, name: 'Demo Tenant' },
}) {
  return render(
    <AuthContext.Provider value={authValue}>
      <LiveChat />
    </AuthContext.Provider>
  );
}

// ─── Tests.

describe('<LiveChat /> — page chrome + session list', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyObj.error.mockReset();
    notifyObj.info.mockReset();
    notifyObj.success.mockReset();
    socketBag.handlers = {};
    socketBag.on.mockClear();
    socketBag.emit.mockClear();
    socketBag.disconnect.mockClear();
    fetchApiMock.mockImplementation(defaultFetch);
  });

  it('renders the page header with title and live-chat subtitle', async () => {
    renderLiveChat();
    expect(await screen.findByText('Live Chat')).toBeInTheDocument();
    expect(screen.getByText('Real-time visitor conversations')).toBeInTheDocument();
  });

  it('renders the Online status pill as role="status" (passive indicator, #476)', async () => {
    renderLiveChat();
    const pill = await screen.findByRole('status', { name: /live chat agent status/i });
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveTextContent(/Online/);
    // Pre-fix: pill looked clickable. Post-fix: cursor:default + role="status".
    expect(pill.getAttribute('style') || '').toMatch(/cursor:\s*default/i);
  });

  it('renders the stats summary from /api/live-chat/stats', async () => {
    renderLiveChat();
    // 3 open + 2 assigned = 5 active · 7 closed today
    await waitFor(() => {
      expect(screen.getByText('5')).toBeInTheDocument();
      expect(screen.getByText('7')).toBeInTheDocument();
    });
    // The literal "active" + "closed today" labels live alongside.
    expect(screen.getByText(/active/i)).toBeInTheDocument();
    expect(screen.getByText(/closed today/i)).toBeInTheDocument();
  });

  it('shows "Loading..." then the session list once /api/live-chat resolves', async () => {
    renderLiveChat();
    // Loading copy shows initially (before promises resolve).
    expect(screen.getByText(/Loading/i)).toBeInTheDocument();
    // Then visitor names land.
    expect(await screen.findByText('Aanya Sharma')).toBeInTheDocument();
    expect(screen.getByText('Rohan Mehta')).toBeInTheDocument();
  });

  it('shows the empty-state copy when /api/live-chat returns []', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/live-chat') return Promise.resolve([]);
      if (url === '/api/live-chat/stats') return Promise.resolve({ open: 0, assigned: 0, closedToday: 0 });
      return Promise.resolve([]);
    });
    renderLiveChat();
    expect(await screen.findByText(/No active chats/i)).toBeInTheDocument();
    // Counter header reads "0 open sessions".
    expect(screen.getByText(/0 open sessions/i)).toBeInTheDocument();
  });

  it('renders the right-pane empty-state when no session is selected', async () => {
    renderLiveChat();
    await waitFor(() => expect(screen.getByText('Aanya Sharma')).toBeInTheDocument());
    expect(screen.getByText(/Select a chat to start responding/i)).toBeInTheDocument();
  });

  it('the visitor list shows lastMessage preview snippets (getAllByText for shared chrome)', async () => {
    renderLiveChat();
    await waitFor(() => expect(screen.getByText('Aanya Sharma')).toBeInTheDocument());
    // The two visitor previews show as distinct text nodes.
    expect(screen.getByText('Need help choosing a plan')).toBeInTheDocument();
    expect(screen.getByText('Thanks for the call')).toBeInTheDocument();
  });
});

describe('<LiveChat /> — active thread + composer', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyObj.error.mockReset();
    notifyObj.info.mockReset();
    notifyObj.success.mockReset();
    socketBag.handlers = {};
    socketBag.on.mockClear();
    socketBag.emit.mockClear();
    socketBag.disconnect.mockClear();
    fetchApiMock.mockImplementation(defaultFetch);
  });

  it('clicking a session fetches /api/live-chat/:id and renders its messages', async () => {
    const user = userEvent.setup();
    renderLiveChat();
    await waitFor(() => expect(screen.getByText('Aanya Sharma')).toBeInTheDocument());
    await user.click(screen.getByText('Aanya Sharma'));

    // Thread messages appear.
    expect(await screen.findByText('Hi, are you there?')).toBeInTheDocument();
    expect(screen.getByText('Yes, how can I help?')).toBeInTheDocument();
    // System message also surfaces.
    expect(screen.getByText(/Session started/i)).toBeInTheDocument();

    // /api/live-chat/11 fetch happened.
    expect(
      fetchApiMock.mock.calls.some(([url]) => url === '/api/live-chat/11')
    ).toBe(true);
  });

  it('typing into composer + clicking Send POSTs { body } to /api/live-chat/:id/messages', async () => {
    const user = userEvent.setup();
    renderLiveChat();
    await waitFor(() => expect(screen.getByText('Aanya Sharma')).toBeInTheDocument());
    await user.click(screen.getByText('Aanya Sharma'));

    const input = await screen.findByPlaceholderText(/Type your reply/i);
    await user.type(input, 'Sure, happy to help — what plan?');
    await user.click(screen.getByRole('button', { name: /^send$/i }));

    await waitFor(() => {
      const sendCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/live-chat/11/messages' && opts?.method === 'POST'
      );
      expect(sendCall).toBeTruthy();
      const body = JSON.parse(sendCall[1].body);
      expect(body.body).toBe('Sure, happy to help — what plan?');
    });
  }, 15_000);

  it('Send button is disabled when draft is empty (no whitespace-only send)', async () => {
    const user = userEvent.setup();
    renderLiveChat();
    await waitFor(() => expect(screen.getByText('Aanya Sharma')).toBeInTheDocument());
    await user.click(screen.getByText('Aanya Sharma'));

    const btn = await screen.findByRole('button', { name: /^send$/i });
    expect(btn).toBeDisabled();

    // Typing a real char enables it.
    const input = screen.getByPlaceholderText(/Type your reply/i);
    await user.type(input, 'x');
    expect(btn).not.toBeDisabled();
  });

  it('OPEN session shows "Assign to me" button; ASSIGNED session does not', async () => {
    const user = userEvent.setup();
    renderLiveChat();
    await waitFor(() => expect(screen.getByText('Aanya Sharma')).toBeInTheDocument());

    // Open session 11 (status OPEN) → Assign button present.
    await user.click(screen.getByText('Aanya Sharma'));
    expect(await screen.findByRole('button', { name: /Assign to me/i })).toBeInTheDocument();

    // Switch to session 12 (status ASSIGNED) → Assign button gone.
    await user.click(screen.getByText('Rohan Mehta'));
    await waitFor(() => expect(screen.getByText('Hello Rohan')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Assign to me/i })).not.toBeInTheDocument();
  });

  it('clicking "Assign to me" POSTs to /api/live-chat/:id/assign', async () => {
    const user = userEvent.setup();
    renderLiveChat();
    await waitFor(() => expect(screen.getByText('Aanya Sharma')).toBeInTheDocument());
    await user.click(screen.getByText('Aanya Sharma'));

    await user.click(await screen.findByRole('button', { name: /Assign to me/i }));

    await waitFor(() => {
      const assignCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/live-chat/11/assign' && opts?.method === 'POST'
      );
      expect(assignCall).toBeTruthy();
    });
  });

  it('clicking Close once reveals the rating prompt; a second click POSTs to /close', async () => {
    const user = userEvent.setup();
    renderLiveChat();
    await waitFor(() => expect(screen.getByText('Aanya Sharma')).toBeInTheDocument());
    await user.click(screen.getByText('Aanya Sharma'));

    // First Close click → rating prompt appears.
    await user.click(await screen.findByRole('button', { name: /^Close$/i }));
    expect(await screen.findByText(/Rate this chat/i)).toBeInTheDocument();

    // Confirm Close → POST fires.
    await user.click(screen.getByRole('button', { name: /Confirm Close/i }));
    await waitFor(() => {
      const closeCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/live-chat/11/close' && opts?.method === 'POST'
      );
      expect(closeCall).toBeTruthy();
      // Rating defaults to undefined when user skipped star clicks.
      const body = JSON.parse(closeCall[1].body);
      expect(body.rating).toBeUndefined();
    });
  });

  it('toast on send failure: notify.error fires when POST /messages rejects', async () => {
    const user = userEvent.setup();
    fetchApiMock.mockImplementation((url, opts) => {
      if (!opts || !opts.method || opts.method === 'GET') {
        return defaultFetch(url, opts);
      }
      if (url === '/api/live-chat/11/messages' && opts.method === 'POST') {
        return Promise.reject(new Error('send blew up'));
      }
      return Promise.resolve({ ok: true });
    });

    renderLiveChat();
    await waitFor(() => expect(screen.getByText('Aanya Sharma')).toBeInTheDocument());
    await user.click(screen.getByText('Aanya Sharma'));

    const input = await screen.findByPlaceholderText(/Type your reply/i);
    await user.type(input, 'will fail');
    await user.click(screen.getByRole('button', { name: /^send$/i }));

    await waitFor(() => {
      expect(notifyObj.error).toHaveBeenCalledWith('Failed to send message');
    });
  }, 15_000);
});

describe('<LiveChat /> — socket.io wiring', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyObj.error.mockReset();
    notifyObj.info.mockReset();
    notifyObj.success.mockReset();
    socketBag.handlers = {};
    socketBag.on.mockClear();
    socketBag.emit.mockClear();
    socketBag.disconnect.mockClear();
    fetchApiMock.mockImplementation(defaultFetch);
  });

  it('subscribes to the four socket events (new_session, assigned, message, closed)', async () => {
    renderLiveChat();
    await waitFor(() => expect(screen.getByText('Aanya Sharma')).toBeInTheDocument());

    const events = socketBag.on.mock.calls.map(([evt]) => evt);
    expect(events).toContain('connect');
    expect(events).toContain('chat_new_session');
    expect(events).toContain('chat_assigned');
    expect(events).toContain('chat_message');
    expect(events).toContain('chat_closed');
  });

  it('unmount disconnects the socket (cleanup)', async () => {
    const { unmount } = renderLiveChat();
    await waitFor(() => expect(screen.getByText('Aanya Sharma')).toBeInTheDocument());
    unmount();
    expect(socketBag.disconnect).toHaveBeenCalledTimes(1);
  });
});
