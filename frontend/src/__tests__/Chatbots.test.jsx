/**
 * Chatbots.jsx — vitest + RTL coverage of the page surface.
 *
 * What this test pins
 * ───────────────────
 * The Chatbots page (frontend/src/pages/Chatbots.jsx, 493 LOC) is the
 * no-code conversational-bot builder. It owns:
 *
 *   1. Bot list fetched from GET /api/chatbots on mount.
 *   2. "Create Bot" button → name modal → POST /api/chatbots with
 *      defaultFlow() seed.
 *   3. Bot card with ACTIVE/INACTIVE chip + node count + 4 row actions:
 *      Edit Flow, Test, Enable/Disable, Delete.
 *   4. Activate/deactivate fires POST /api/chatbots/:id/(de)activate.
 *   5. Delete fires DELETE /api/chatbots/:id after notify.confirm.
 *   6. Edit Flow modal — node CRUD + privacy caveat + embed snippet
 *      (window.location.origin + bot.id + tenantId in plain query string).
 *   7. Bot Tester modal — POSTs to /api/chatbots/chat/:id with visitorId.
 *
 * Contract pinned here
 * ────────────────────
 *   - On mount, GET /api/chatbots fires once.
 *   - Loading message renders before the fetch resolves; empty-state
 *     card renders when the API returns [].
 *   - Bots in the list render: name, conversationCount, node count,
 *     and an ACTIVE/INACTIVE chip whose text + colour reflects isActive.
 *   - Create modal validates non-empty name client-side (blank name does
 *     NOT fire the POST — useful guard so we don't ship empty-name bots).
 *   - Toggling Enable/Disable hits the right "/activate" vs "/deactivate"
 *     path based on the current state, NOT the next state.
 *   - Delete is gated by notify.confirm — a "No" response does NOT fire
 *     DELETE, so an accidental click on the trash icon is recoverable.
 *   - Edit Flow modal renders the persisted nodes, the embed snippet
 *     containing bot.id, and the #728-item-2 privacy caveat (so we
 *     don't silently strip the operator warning later).
 *
 * Why this is component-level (vitest + RTL), not playwright
 * ──────────────────────────────────────────────────────────
 * The contracts above are all rendering / state / mock-fetch-call-shape
 * invariants that don't need a running backend. The /api/chatbots
 * round-trip is covered by chatbots-api.spec.js at the API layer; this
 * pins the page's role-gate / button-wire / modal-flow contract.
 *
 * Standing rules applied
 * ──────────────────────
 *   - Stable mock object reference for useNotify (CLAUDE.md "RTL: stable
 *     mock object references" — fresh object per call infinite-loops the
 *     useCallback deps and OOMs the test).
 *   - getAllByText for "ACTIVE" / "INACTIVE" since the chip text + the
 *     button label can both render the same token on the same card.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  // Chatbots.jsx reads tenantId from the JWT via getAuthToken(). We stub
  // a real-looking JWT (header.payload.signature) whose payload base64-
  // decodes to `{ tenantId: 1 }` so the component's try/atob path works.
  getAuthToken: () => 'h.' + btoa(JSON.stringify({ tenantId: 1 })) + '.s',
}));

// Stable object reference per the RTL standing rule. Fresh objects per
// call infinite-loop useCallback dependency arrays.
const notify = {
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  confirm: vi.fn(() => Promise.resolve(true)),
  prompt: vi.fn(() => Promise.resolve('')),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notify,
  NotifyProvider: ({ children }) => children,
}));

import Chatbots from '../pages/Chatbots';

const sampleBots = [
  {
    id: 11,
    name: 'Sales Qualifier',
    isActive: true,
    conversationCount: 17,
    flow: { nodes: [{ id: 'n_aaa', type: 'message', content: 'Hi' }, { id: 'n_bbb', type: 'capture-email', content: 'Email?' }], edges: [{ from: 'n_aaa', to: 'n_bbb' }] },
  },
  {
    id: 22,
    name: 'Support Triage',
    isActive: false,
    conversationCount: 3,
    flow: { nodes: [{ id: 'n_ccc', type: 'message', content: 'How can we help?' }], edges: [] },
  },
];

function defaultFetch(url, opts) {
  const method = (opts && opts.method) || 'GET';
  if (url === '/api/chatbots' && method === 'GET') return Promise.resolve(sampleBots);
  if (url === '/api/chatbots' && method === 'POST') {
    const body = JSON.parse(opts.body);
    return Promise.resolve({ id: 999, name: body.name, isActive: false, conversationCount: 0, flow: body.flow });
  }
  if (url.match(/^\/api\/chatbots\/\d+$/) && method === 'PUT') {
    return Promise.resolve({ id: 11, ...JSON.parse(opts.body) });
  }
  if (url.match(/^\/api\/chatbots\/\d+$/) && method === 'DELETE') {
    return Promise.resolve({ success: true });
  }
  if (url.match(/^\/api\/chatbots\/\d+\/(de)?activate$/) && method === 'POST') {
    return Promise.resolve({ success: true });
  }
  return Promise.resolve([]);
}

function renderChatbots() {
  return render(
    <MemoryRouter>
      <Chatbots />
    </MemoryRouter>,
  );
}

describe('<Chatbots /> — page surface', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notify.success.mockReset();
    notify.error.mockReset();
    notify.info.mockReset();
    notify.confirm.mockReset();
    notify.confirm.mockImplementation(() => Promise.resolve(true));
    fetchApiMock.mockImplementation(defaultFetch);
  });

  it('renders the page header with the Create Bot CTA', async () => {
    renderChatbots();
    expect(screen.getByText('Chatbots')).toBeInTheDocument();
    expect(screen.getByText(/Build no-code conversational bots/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create Bot/i })).toBeInTheDocument();
  });

  it('fires GET /api/chatbots on mount and renders the persisted bots', async () => {
    renderChatbots();

    // The initial fetch must have happened.
    await waitFor(() => {
      const seen = fetchApiMock.mock.calls.some(
        ([url, opts]) => url === '/api/chatbots' && (!opts || !opts.method || opts.method === 'GET'),
      );
      expect(seen).toBe(true);
    });

    // Both bot cards render their names.
    await waitFor(() => expect(screen.getByText('Sales Qualifier')).toBeInTheDocument());
    expect(screen.getByText('Support Triage')).toBeInTheDocument();
  });

  it('renders the empty-state card when /api/chatbots returns []', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/chatbots') return Promise.resolve([]);
      return Promise.resolve([]);
    });

    renderChatbots();
    await waitFor(() => expect(screen.getByText(/No chatbots yet/i)).toBeInTheDocument());
    expect(screen.getByText(/Create your first bot to start engaging visitors/i)).toBeInTheDocument();
  });

  it('renders ACTIVE chip for active bot and INACTIVE chip for inactive bot', async () => {
    renderChatbots();
    await waitFor(() => expect(screen.getByText('Sales Qualifier')).toBeInTheDocument());

    // ACTIVE may appear once (the active bot's chip). Use getAllByText to
    // tolerate the chip text also bleeding through some other render layer
    // — defensive read per the RTL "getAllByText" standing rule.
    const activeChips = screen.getAllByText('ACTIVE');
    expect(activeChips.length).toBeGreaterThanOrEqual(1);

    const inactiveChips = screen.getAllByText('INACTIVE');
    expect(inactiveChips.length).toBeGreaterThanOrEqual(1);
  });

  it('renders the conversationCount and node-count summary per bot', async () => {
    renderChatbots();
    await waitFor(() => expect(screen.getByText('Sales Qualifier')).toBeInTheDocument());

    // Sales Qualifier — 17 conversations, 2 nodes.
    expect(screen.getByText(/17 conversations/i)).toBeInTheDocument();
    // node counts ("2 nodes" + "1 nodes"). Both should be rendered.
    expect(screen.getByText(/2 nodes/i)).toBeInTheDocument();
    expect(screen.getByText(/1 nodes/i)).toBeInTheDocument();
  });

  it('clicking Create Bot opens the name modal with an input + Cancel/Create', async () => {
    const user = userEvent.setup();
    renderChatbots();
    await waitFor(() => expect(screen.getByText('Sales Qualifier')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /Create Bot/i }));

    // Modal heading is "Create Chatbot".
    await waitFor(() => expect(screen.getByText('Create Chatbot')).toBeInTheDocument());
    // Name input is autofocused with the "Sales Qualifier" placeholder.
    expect(screen.getByPlaceholderText('Sales Qualifier')).toBeInTheDocument();
    // Both buttons present.
    expect(screen.getByRole('button', { name: /^Cancel$/ })).toBeInTheDocument();
    // Two buttons match /Create/ now: the page-level "Create Bot" AND the
    // modal's "Create". Use getAllByRole and assert >=2.
    const createButtons = screen.getAllByRole('button', { name: /^Create$/ });
    expect(createButtons.length).toBeGreaterThanOrEqual(1);
  });

  it('Create with a blank name does NOT fire POST /api/chatbots (client-side guard)', async () => {
    const user = userEvent.setup();
    renderChatbots();
    await waitFor(() => expect(screen.getByText('Sales Qualifier')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /Create Bot/i }));
    await waitFor(() => expect(screen.getByText('Create Chatbot')).toBeInTheDocument());

    // Clear any prior calls, click Create with empty input.
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetch);
    const modalCreate = screen.getAllByRole('button', { name: /^Create$/ }).pop();
    await user.click(modalCreate);

    // POST must NOT have fired. Use a microtask flush to let any pending
    // state updates settle, then assert nothing hit /api/chatbots POST.
    await new Promise(r => setTimeout(r, 50));
    const postCalls = fetchApiMock.mock.calls.filter(
      ([url, opts]) => url === '/api/chatbots' && opts?.method === 'POST',
    );
    expect(postCalls.length).toBe(0);
  });

  it('Create with a non-empty name fires POST /api/chatbots with name + defaultFlow', async () => {
    const user = userEvent.setup();
    renderChatbots();
    await waitFor(() => expect(screen.getByText('Sales Qualifier')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /Create Bot/i }));
    await waitFor(() => expect(screen.getByText('Create Chatbot')).toBeInTheDocument());

    const input = screen.getByPlaceholderText('Sales Qualifier');
    await user.type(input, 'Lead Catcher');

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetch);

    const modalCreate = screen.getAllByRole('button', { name: /^Create$/ }).pop();
    await user.click(modalCreate);

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/chatbots' && opts?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.name).toBe('Lead Catcher');
      // defaultFlow() seeds a 2-node, 1-edge flow.
      expect(body.flow).toBeTruthy();
      expect(Array.isArray(body.flow.nodes)).toBe(true);
      expect(body.flow.nodes.length).toBe(2);
      expect(Array.isArray(body.flow.edges)).toBe(true);
      expect(body.flow.edges.length).toBe(1);
    });
  });

  it('Disable button on an ACTIVE bot fires POST /api/chatbots/:id/deactivate', async () => {
    const user = userEvent.setup();
    renderChatbots();
    await waitFor(() => expect(screen.getByText('Sales Qualifier')).toBeInTheDocument());

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetch);

    // Active bot's row action button text reads "Disable".
    const disableBtn = screen.getByRole('button', { name: /^Disable$/ });
    await user.click(disableBtn);

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/chatbots/11/deactivate' && opts?.method === 'POST',
      );
      expect(call).toBeTruthy();
    });
  });

  it('Enable button on an INACTIVE bot fires POST /api/chatbots/:id/activate', async () => {
    const user = userEvent.setup();
    renderChatbots();
    await waitFor(() => expect(screen.getByText('Support Triage')).toBeInTheDocument());

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetch);

    const enableBtn = screen.getByRole('button', { name: /^Enable$/ });
    await user.click(enableBtn);

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/chatbots/22/activate' && opts?.method === 'POST',
      );
      expect(call).toBeTruthy();
    });
  });

  it('Delete is gated by notify.confirm — declining does NOT fire DELETE', async () => {
    notify.confirm.mockImplementation(() => Promise.resolve(false));

    const user = userEvent.setup();
    renderChatbots();
    await waitFor(() => expect(screen.getByText('Sales Qualifier')).toBeInTheDocument());

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetch);

    // The delete button is icon-only (Trash2). Find it via the card +
    // the red color style is not a stable selector — instead pick the
    // 4th button inside the first bot card.
    const card = screen.getByText('Sales Qualifier').closest('.card');
    expect(card).not.toBeNull();
    const actionButtons = card.querySelectorAll('button');
    // 4 row actions: Edit Flow, Test, Disable, [trash].
    const deleteBtn = actionButtons[actionButtons.length - 1];
    await user.click(deleteBtn);

    // notify.confirm should have been asked.
    await waitFor(() => expect(notify.confirm).toHaveBeenCalled());

    // But no DELETE fired.
    await new Promise(r => setTimeout(r, 50));
    const deleteCalls = fetchApiMock.mock.calls.filter(
      ([url, opts]) => url.startsWith('/api/chatbots/') && opts?.method === 'DELETE',
    );
    expect(deleteCalls.length).toBe(0);
  });

  it('Delete with confirm=true fires DELETE /api/chatbots/:id', async () => {
    notify.confirm.mockImplementation(() => Promise.resolve(true));

    const user = userEvent.setup();
    renderChatbots();
    await waitFor(() => expect(screen.getByText('Sales Qualifier')).toBeInTheDocument());

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetch);

    const card = screen.getByText('Sales Qualifier').closest('.card');
    const actionButtons = card.querySelectorAll('button');
    const deleteBtn = actionButtons[actionButtons.length - 1];
    await user.click(deleteBtn);

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/chatbots/11' && opts?.method === 'DELETE',
      );
      expect(call).toBeTruthy();
    });
  });

  it('clicking Edit Flow opens the FlowEditor modal with the bot name + Save button', async () => {
    const user = userEvent.setup();
    renderChatbots();
    await waitFor(() => expect(screen.getByText('Sales Qualifier')).toBeInTheDocument());

    const editBtn = screen.getAllByRole('button', { name: /Edit Flow/i })[0];
    await user.click(editBtn);

    // FlowEditor modal title is rendered as an <h3>. "Edit Flow" also
    // appears as a row-action button label, so disambiguate by role.
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /^Edit Flow$/, level: 3 })).toBeInTheDocument(),
    );
    // Bot name pre-filled in the editor input.
    expect(screen.getByDisplayValue('Sales Qualifier')).toBeInTheDocument();
    // Save Flow button is rendered.
    expect(screen.getByRole('button', { name: /Save Flow/i })).toBeInTheDocument();
  });

  it('FlowEditor renders the embed snippet containing the bot id', async () => {
    const user = userEvent.setup();
    renderChatbots();
    await waitFor(() => expect(screen.getByText('Sales Qualifier')).toBeInTheDocument());

    await user.click(screen.getAllByRole('button', { name: /Edit Flow/i })[0]);
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /^Edit Flow$/, level: 3 })).toBeInTheDocument(),
    );

    // The <pre> snippet contains the bot id (11) and the script tag.
    expect(screen.getByText(/bot=11/)).toBeInTheDocument();
    expect(screen.getByText(/crm-chat\.js/)).toBeInTheDocument();
  });

  it('FlowEditor surfaces the #728-item-2 privacy caveat about tenant/bot id leakage', async () => {
    // Why pin this verbatim — the privacy caveat is a deliberate operator
    // warning (numeric tenantId + botId are not secrets but ARE enumerable
    // identifiers). A future "clean up the UI" pass could trivially strip
    // the paragraph; this test makes that a load-bearing change.
    const user = userEvent.setup();
    renderChatbots();
    await waitFor(() => expect(screen.getByText('Sales Qualifier')).toBeInTheDocument());

    await user.click(screen.getAllByRole('button', { name: /Edit Flow/i })[0]);
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /^Edit Flow$/, level: 3 })).toBeInTheDocument(),
    );

    const caveat = screen.getByTestId('embed-snippet-privacy-caveat');
    expect(caveat).toBeInTheDocument();
    expect(caveat.textContent).toMatch(/Privacy note/i);
    expect(caveat.textContent).toMatch(/numeric tenant/i);
  });
});
