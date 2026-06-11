/**
 * TravelWhatsAppChat.test.jsx — vitest + RTL coverage for the Travel-
 * vertical 2-way WhatsApp chat (frontend/src/pages/travel/WhatsAppChat.jsx,
 * Q9 Wati transport — clone of the wellness agent inbox).
 *
 * Scope — pins the TRAVEL-specific diffs against the wellness original
 * (which keeps its own suite); the shared sub-components are exercised
 * through real renders (imported from ../pages/wellness/whatsapp/*):
 *
 *   1. Wati status strip: stub-mode copy when GET /api/travel/whatsapp/status
 *      returns enabled:false + "Dispatch log →" link to /travel/whatsapp/log.
 *   2. Status strip: connected copy + masked channel when enabled:true.
 *   3. Threads load from the SHARED tenant-scoped /api/whatsapp/threads and
 *      render in the left rail.
 *   4. Selecting a thread loads detail + renders message bubbles.
 *   5. Reply send POSTs /api/travel/whatsapp/send (Wati) with { to, body } —
 *      NOT the Meta-track /api/whatsapp/send.
 *   6. No /api/wellness/patients fetch fires (travel has no patients).
 *   7. Socket "whatsapp:received" event triggers a thread-list refetch
 *      (live inbound).
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at ../utils/api; notify object is a STABLE reference.
 *   - socket.io-client mocked with a handler-capturing fake so the test can
 *     fire "whatsapp:received" like the backend webhook would.
 *   - AuthContext provided manually (tenantId drives the socket room join).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

const notifyObj = {
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  confirm: vi.fn().mockResolvedValue(true),
  prompt: vi.fn(),
};
vi.mock('../utils/notify', () => ({ useNotify: () => notifyObj }));

// socket.io-client fake — captures event handlers so tests can fire
// "whatsapp:received" exactly like the travel Wati webhook does.
const socketHandlers = {};
const fakeSocket = {
  on: vi.fn((ev, fn) => { socketHandlers[ev] = fn; }),
  off: vi.fn(),
  emit: vi.fn(),
  disconnect: vi.fn(),
};
vi.mock('socket.io-client', () => ({ io: () => fakeSocket }));

import { AuthContext } from '../App';
import TravelWhatsAppChat from '../pages/travel/WhatsAppChat';

const ADMIN_USER = { userId: 1, name: 'Yasin', email: 'y@x.com', role: 'ADMIN', tenantId: 3 };

const THREAD = {
  id: 11,
  contactPhone: '+919811111102',
  status: 'OPEN',
  unreadCount: 0,
  lastMessageAt: '2026-06-11T08:00:00.000Z',
  contact: { id: 65, name: 'Ahmed Khan' },
};

const DETAIL = {
  thread: { ...THREAD, assignedTo: null, assignedToId: null },
  messages: [
    {
      id: 1,
      direction: 'INBOUND',
      body: 'salaam, is the Umrah package still available?',
      status: 'DELIVERED',
      createdAt: '2026-06-11T08:00:00.000Z',
    },
    {
      id: 2,
      direction: 'OUTBOUND',
      body: 'Walaikum salaam! Yes — shall I share the itinerary?',
      status: 'SENT',
      createdAt: '2026-06-11T08:01:00.000Z',
    },
  ],
  optedOut: null,
};

// Default route table — individual tests override fetchApiMock as needed.
function installDefaultRoutes({ watiEnabled = false, channelNumber = null } = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    if (url === '/api/travel/whatsapp/status') {
      return Promise.resolve({ enabled: watiEnabled, channelNumber });
    }
    if (url.startsWith('/api/whatsapp/threads/11/mark-read')) return Promise.resolve({});
    if (url.startsWith('/api/whatsapp/threads/11')) return Promise.resolve(DETAIL);
    if (url.startsWith('/api/whatsapp/threads')) return Promise.resolve({ threads: [THREAD] });
    if (url.startsWith('/api/whatsapp/templates')) return Promise.resolve({ templates: [] });
    if (url.startsWith('/api/whatsapp/opt-outs')) return Promise.resolve({ optOuts: [] });
    if (url.startsWith('/api/staff')) return Promise.resolve([]);
    if (url.startsWith('/api/contacts')) return Promise.resolve([]);
    if (url === '/api/travel/whatsapp/send' && method === 'POST') {
      return Promise.resolve({ success: true, status: 'QUEUED', stub: true, thread: { id: 11 } });
    }
    return Promise.resolve(null);
  });
}

function renderPage(user = ADMIN_USER) {
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={{ user }}>
        <TravelWhatsAppChat />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyObj.error.mockClear();
  notifyObj.info.mockClear();
  for (const k of Object.keys(socketHandlers)) delete socketHandlers[k];
});

describe('<TravelWhatsAppChat /> — Wati status strip', () => {
  it('1. stub mode: amber copy + dispatch-log link', async () => {
    installDefaultRoutes({ watiEnabled: false });
    renderPage();
    const strip = await screen.findByTestId('wati-status-strip');
    await waitFor(() => expect(strip).toHaveTextContent(/Wati stub mode/i));
    expect(strip).toHaveTextContent(/messages queue until the Wati credentials/i);
    const logLink = screen.getByRole('link', { name: /Dispatch log/i });
    expect(logLink).toHaveAttribute('href', '/travel/whatsapp/log');
  });

  it('2. connected: green copy with masked channel number', async () => {
    installDefaultRoutes({ watiEnabled: true, channelNumber: '9198•••102' });
    renderPage();
    const strip = await screen.findByTestId('wati-status-strip');
    await waitFor(() => expect(strip).toHaveTextContent(/Wati connected · 9198•••102/i));
  });
});

describe('<TravelWhatsAppChat /> — threads + chat flow', () => {
  it('3. loads threads from the shared tenant-scoped endpoint and renders the rail', async () => {
    installDefaultRoutes();
    renderPage();
    expect(await screen.findByText('Ahmed Khan')).toBeInTheDocument();
    const threadCalls = fetchApiMock.mock.calls.filter(([u]) => u.startsWith('/api/whatsapp/threads?'));
    expect(threadCalls.length).toBeGreaterThan(0);
  });

  it('4. selecting a thread loads detail and renders both message bubbles', async () => {
    installDefaultRoutes();
    renderPage();
    fireEvent.click(await screen.findByText('Ahmed Khan'));
    expect(
      await screen.findByText(/is the Umrah package still available/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/shall I share the itinerary/i)).toBeInTheDocument();
  });

  it('5. reply send POSTs to /api/travel/whatsapp/send (Wati), not the Meta path', async () => {
    installDefaultRoutes();
    renderPage();
    fireEvent.click(await screen.findByText('Ahmed Khan'));
    const box = await screen.findByPlaceholderText(/Type a message/i);
    fireEvent.change(box, { target: { value: 'On it — sending now' } });
    fireEvent.click(screen.getByTitle(/Send \(Ctrl\+Enter\)/i));
    await waitFor(() => {
      const sendCalls = fetchApiMock.mock.calls.filter(
        ([u, o]) => u === '/api/travel/whatsapp/send' && o?.method === 'POST',
      );
      expect(sendCalls).toHaveLength(1);
      const body = JSON.parse(sendCalls[0][1].body);
      expect(body).toEqual({ to: '+919811111102', body: 'On it — sending now' });
    });
    // Meta-track send endpoint must NEVER fire from the travel chat.
    const metaSends = fetchApiMock.mock.calls.filter(([u]) => u === '/api/whatsapp/send');
    expect(metaSends).toHaveLength(0);
  });

  it('6. never fetches /api/wellness/patients (travel has no patients)', async () => {
    installDefaultRoutes();
    renderPage();
    await screen.findByText('Ahmed Khan');
    const patientCalls = fetchApiMock.mock.calls.filter(([u]) => u.includes('/wellness/patients'));
    expect(patientCalls).toHaveLength(0);
  });

  it('7. socket whatsapp:received triggers a thread-list refetch (live inbound)', async () => {
    installDefaultRoutes();
    renderPage();
    await screen.findByText('Ahmed Khan');
    await waitFor(() => expect(socketHandlers['whatsapp:received']).toBeTypeOf('function'));
    const before = fetchApiMock.mock.calls.filter(([u]) => u.startsWith('/api/whatsapp/threads?')).length;
    socketHandlers['whatsapp:received']({
      tenantId: 3,
      threadId: 99,
      contactPhone: '+919811111103',
      body: 'new inbound',
    });
    await waitFor(() => {
      const after = fetchApiMock.mock.calls.filter(([u]) => u.startsWith('/api/whatsapp/threads?')).length;
      expect(after).toBeGreaterThan(before);
    });
  });
});
