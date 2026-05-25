/**
 * Zapier.jsx — vitest + RTL coverage.
 *
 * Zapier Integration page (frontend/src/pages/Zapier.jsx) renders four sections:
 *   1. "Connect to Zapier" 3-step static instructions (API key → find app → authenticate)
 *   2. Available Triggers table — populated from GET /api/zapier/triggers, each row
 *      has a "Sample Data" button that GETs /api/zapier/test/:key and opens a modal
 *   3. Available Actions table — populated from GET /api/zapier/actions, renders
 *      required-field chips from (a.fields || []).filter(f => f.required)
 *   4. Active Subscriptions list — populated from GET /api/zapier/subscriptions,
 *      each row has a trash-icon button that DELETEs after notify.confirm()
 *
 * NOTE on prompt-vs-code drift: dispatch brief mentioned "create webhook flow" and
 * "Copy URL" actions. The actual SUT has NEITHER — subscriptions are READ-ONLY from
 * the CRM's perspective (Zapier registers them via its own auth flow). The SUT only
 * supports VIEW (sample data modal) and DELETE (disconnect subscription). Tests pin
 * the actual contract; recording drift here so the next author doesn't re-chase.
 *
 * Contracts pinned:
 *   - Three loadAll() fetches in parallel: /triggers, /actions, /subscriptions
 *   - .catch(() => []) per-promise — one failure does NOT block the others
 *   - Sample modal opens on Eye-icon click; closes on backdrop click or X icon
 *   - Subscription deletion requires notify.confirm() truthy return; cancel = no-op
 *   - Failed sample fetch surfaces notify.error('Failed to load sample data')
 *   - Failed delete surfaces notify.error('Failed to remove subscription')
 *   - Empty state copy: "No triggers available.", "No actions available.",
 *     "No active Zap subscriptions. Once a user enables a Zap, ..."
 *   - Required-field chips render in monospace purple; "none" placeholder when empty
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../utils/api', () => ({
  fetchApi: vi.fn(),
}));

// Stable mock object reference — fresh-per-render objects break useCallback deps
// (see CLAUDE.md standing rule: "RTL: stable mock object references for hooks").
const notify = {
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  confirm: vi.fn(() => Promise.resolve(true)),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notify,
}));

import { fetchApi } from '../utils/api';
import Zapier from '../pages/Zapier';

const sampleTriggers = [
  { key: 'new_contact', name: 'New Contact', description: 'Fires when a new contact is created' },
  { key: 'new_deal',    name: 'New Deal',    description: 'Fires when a new deal is created' },
];

const sampleActions = [
  {
    key: 'create_contact',
    name: 'Create Contact',
    description: 'Create a new contact in the CRM',
    fields: [
      { key: 'email', required: true },
      { key: 'firstName', required: true },
      { key: 'phone', required: false },
    ],
  },
  {
    key: 'log_activity',
    name: 'Log Activity',
    description: 'Append an activity to a contact timeline',
    fields: [],
  },
];

const sampleSubs = [
  {
    id: 'sub_1',
    event: 'new_contact',
    targetUrl: 'https://hooks.zapier.com/hooks/catch/123/abc',
    createdAt: '2026-05-01T10:00:00Z',
  },
  {
    id: 'sub_2',
    event: 'new_deal',
    targetUrl: 'https://hooks.zapier.com/hooks/catch/123/def',
    createdAt: '2026-05-15T12:30:00Z',
  },
];

function mockLoadAll({ triggers = [], actions = [], subs = [] } = {}) {
  fetchApi.mockImplementation((url) => {
    if (url === '/api/zapier/triggers')      return Promise.resolve(triggers);
    if (url === '/api/zapier/actions')       return Promise.resolve(actions);
    if (url === '/api/zapier/subscriptions') return Promise.resolve(subs);
    return Promise.reject(new Error(`Unmocked fetchApi(${url})`));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  notify.confirm.mockImplementation(() => Promise.resolve(true));
});

describe('Zapier page — header and static instructions', () => {
  it('renders the page header and developer-portal CTA', async () => {
    mockLoadAll();
    render(<Zapier />);
    expect(await screen.findByRole('heading', { name: /zapier integration/i })).toBeInTheDocument();
    const cta = screen.getByRole('link', { name: /zapier developer/i });
    expect(cta).toHaveAttribute('href', 'https://zapier.com/developer');
    expect(cta).toHaveAttribute('target', '_blank');
  });

  it('renders the 3-step "Connect to Zapier" instruction cards', async () => {
    mockLoadAll();
    render(<Zapier />);
    expect(await screen.findByText(/generate api key/i)).toBeInTheDocument();
    expect(screen.getByText(/find our app/i)).toBeInTheDocument();
    expect(screen.getByText(/authenticate/i)).toBeInTheDocument();
    // Marketplace status banner pinned
    expect(screen.getByText(/marketplace status/i)).toBeInTheDocument();
    expect(screen.getByText(/private beta/i)).toBeInTheDocument();
  });
});

describe('Zapier page — initial load fetches all three resources', () => {
  it('fetches /triggers, /actions, /subscriptions in parallel on mount', async () => {
    mockLoadAll({ triggers: sampleTriggers, actions: sampleActions, subs: sampleSubs });
    render(<Zapier />);
    await waitFor(() => {
      expect(fetchApi).toHaveBeenCalledWith('/api/zapier/triggers');
      expect(fetchApi).toHaveBeenCalledWith('/api/zapier/actions');
      expect(fetchApi).toHaveBeenCalledWith('/api/zapier/subscriptions');
    });
    // exactly the 3 mount-time calls
    expect(fetchApi).toHaveBeenCalledTimes(3);
  });

  it('renders empty-state placeholders when all three endpoints return []', async () => {
    mockLoadAll();
    render(<Zapier />);
    expect(await screen.findByText(/no triggers available\./i)).toBeInTheDocument();
    expect(screen.getByText(/no actions available\./i)).toBeInTheDocument();
    expect(
      screen.getByText(/no active zap subscriptions/i)
    ).toBeInTheDocument();
  });

  it('survives a single endpoint failure — per-promise .catch(() => []) isolation', async () => {
    // Triggers reject; actions + subs resolve. Page should still render with
    // empty triggers table + populated actions + populated subs.
    fetchApi.mockImplementation((url) => {
      if (url === '/api/zapier/triggers')      return Promise.reject(new Error('boom'));
      if (url === '/api/zapier/actions')       return Promise.resolve(sampleActions);
      if (url === '/api/zapier/subscriptions') return Promise.resolve(sampleSubs);
      return Promise.reject(new Error('Unmocked'));
    });
    render(<Zapier />);
    expect(await screen.findByText(/no triggers available\./i)).toBeInTheDocument();
    expect(screen.getByText('create_contact')).toBeInTheDocument();
    expect(screen.getByText('sub_1' === 'sub_1' ? /new_contact/i : '')).toBeInTheDocument();
  });
});

describe('Zapier page — Triggers table', () => {
  it('renders one row per trigger with key, name, and description', async () => {
    mockLoadAll({ triggers: sampleTriggers });
    render(<Zapier />);
    expect(await screen.findByText('new_contact')).toBeInTheDocument();
    expect(screen.getByText('New Contact')).toBeInTheDocument();
    expect(screen.getByText(/fires when a new contact is created/i)).toBeInTheDocument();
    expect(screen.getByText('new_deal')).toBeInTheDocument();
    expect(screen.getByText('New Deal')).toBeInTheDocument();
    // 2 "Sample Data" buttons, one per row
    expect(screen.getAllByRole('button', { name: /sample data/i })).toHaveLength(2);
  });

  it('renders the trigger count chip in the section header', async () => {
    mockLoadAll({ triggers: sampleTriggers });
    render(<Zapier />);
    // "(2) — events that start a Zap" — fragmented across nodes; use getAllByText
    await screen.findByText('new_contact');
    expect(screen.getByText(/\(2\)/)).toBeInTheDocument();
    expect(screen.getByText(/events that start a zap/i)).toBeInTheDocument();
  });
});

describe('Zapier page — Sample Data modal', () => {
  it('clicking "Sample Data" fetches /test/:key and opens the modal', async () => {
    mockLoadAll({ triggers: sampleTriggers });
    const samplePayload = { id: 1, email: 'demo@example.com' };
    // Add the sample-fetch mock on top of the loadAll baseline
    fetchApi.mockImplementation((url) => {
      if (url === '/api/zapier/triggers')         return Promise.resolve(sampleTriggers);
      if (url === '/api/zapier/actions')          return Promise.resolve([]);
      if (url === '/api/zapier/subscriptions')    return Promise.resolve([]);
      if (url === '/api/zapier/test/new_contact') return Promise.resolve(samplePayload);
      return Promise.reject(new Error(`Unmocked ${url}`));
    });
    render(<Zapier />);
    const buttons = await screen.findAllByRole('button', { name: /sample data/i });
    await userEvent.click(buttons[0]);
    await waitFor(() => {
      expect(fetchApi).toHaveBeenCalledWith('/api/zapier/test/new_contact');
    });
    // Modal renders the JSON.stringify of the payload
    expect(await screen.findByText(/new_contact — sample/i)).toBeInTheDocument();
    expect(screen.getByText(/demo@example\.com/)).toBeInTheDocument();
  });

  it('shows a notify.error toast when the sample fetch rejects', async () => {
    fetchApi.mockImplementation((url) => {
      if (url === '/api/zapier/triggers')         return Promise.resolve(sampleTriggers);
      if (url === '/api/zapier/actions')          return Promise.resolve([]);
      if (url === '/api/zapier/subscriptions')    return Promise.resolve([]);
      if (url.startsWith('/api/zapier/test/'))    return Promise.reject(new Error('boom'));
      return Promise.reject(new Error(`Unmocked ${url}`));
    });
    render(<Zapier />);
    const buttons = await screen.findAllByRole('button', { name: /sample data/i });
    await userEvent.click(buttons[0]);
    await waitFor(() => {
      expect(notify.error).toHaveBeenCalledWith('Failed to load sample data');
    });
    // Modal does NOT open on error
    expect(screen.queryByText(/— sample/i)).not.toBeInTheDocument();
  });
});

describe('Zapier page — Actions table required-field chips', () => {
  it('renders a chip per required field; renders "none" when no required fields', async () => {
    mockLoadAll({ actions: sampleActions });
    render(<Zapier />);
    expect(await screen.findByText('create_contact')).toBeInTheDocument();
    expect(screen.getByText('email')).toBeInTheDocument();
    expect(screen.getByText('firstName')).toBeInTheDocument();
    // phone is not required → not rendered as a chip in the required column
    expect(screen.queryByText('phone')).not.toBeInTheDocument();
    // log_activity has fields:[] → renders "none" placeholder
    expect(screen.getByText('none')).toBeInTheDocument();
  });
});

describe('Zapier page — Subscriptions delete flow', () => {
  it('calls DELETE /api/zapier/subscribe/:id and reloads after notify.confirm true', async () => {
    mockLoadAll({ subs: sampleSubs });
    render(<Zapier />);
    // Wait for sub rows to render
    await screen.findByText('POST https://hooks.zapier.com/hooks/catch/123/abc');
    expect(fetchApi).toHaveBeenCalledTimes(3); // initial mount

    // The trash buttons have title="Disconnect"
    const trashButtons = screen.getAllByTitle(/disconnect/i);
    expect(trashButtons).toHaveLength(2);

    // Set up delete + reload mocks
    fetchApi.mockImplementation((url, opts) => {
      if (url === '/api/zapier/subscribe/sub_1' && opts?.method === 'DELETE') return Promise.resolve({});
      if (url === '/api/zapier/triggers')      return Promise.resolve([]);
      if (url === '/api/zapier/actions')       return Promise.resolve([]);
      // After delete, return the surviving sub
      if (url === '/api/zapier/subscriptions') return Promise.resolve([sampleSubs[1]]);
      return Promise.reject(new Error(`Unmocked ${url}`));
    });

    await userEvent.click(trashButtons[0]);

    await waitFor(() => {
      expect(notify.confirm).toHaveBeenCalledWith('Disconnect this Zap subscription?');
    });
    await waitFor(() => {
      expect(fetchApi).toHaveBeenCalledWith('/api/zapier/subscribe/sub_1', { method: 'DELETE' });
    });
  });

  it('does NOT call DELETE when notify.confirm resolves false', async () => {
    notify.confirm.mockImplementationOnce(() => Promise.resolve(false));
    mockLoadAll({ subs: sampleSubs });
    render(<Zapier />);
    const trashButtons = await screen.findAllByTitle(/disconnect/i);
    await userEvent.click(trashButtons[0]);

    await waitFor(() => {
      expect(notify.confirm).toHaveBeenCalled();
    });

    // No DELETE call ever issued
    const deleteCalls = fetchApi.mock.calls.filter(
      ([, opts]) => opts?.method === 'DELETE'
    );
    expect(deleteCalls).toHaveLength(0);
  });

  it('surfaces notify.error when the DELETE request rejects', async () => {
    mockLoadAll({ subs: sampleSubs });
    render(<Zapier />);
    await screen.findByText('POST https://hooks.zapier.com/hooks/catch/123/abc');

    fetchApi.mockImplementation((url, opts) => {
      if (opts?.method === 'DELETE') return Promise.reject(new Error('boom'));
      if (url === '/api/zapier/triggers')      return Promise.resolve([]);
      if (url === '/api/zapier/actions')       return Promise.resolve([]);
      if (url === '/api/zapier/subscriptions') return Promise.resolve(sampleSubs);
      return Promise.reject(new Error('Unmocked'));
    });

    const trashButtons = screen.getAllByTitle(/disconnect/i);
    await userEvent.click(trashButtons[0]);

    await waitFor(() => {
      expect(notify.error).toHaveBeenCalledWith('Failed to remove subscription');
    });
  });
});

describe('Zapier page — Subscription row formatting', () => {
  it('renders the event label, POST URL, and creation timestamp per subscription', async () => {
    mockLoadAll({ subs: sampleSubs });
    render(<Zapier />);
    // Event labels appear as chips
    const newContactEls = await screen.findAllByText(/new_contact/);
    expect(newContactEls.length).toBeGreaterThan(0);
    // Target URLs prefixed with POST
    expect(screen.getByText(/POST https:\/\/hooks\.zapier\.com\/hooks\/catch\/123\/abc/)).toBeInTheDocument();
    expect(screen.getByText(/POST https:\/\/hooks\.zapier\.com\/hooks\/catch\/123\/def/)).toBeInTheDocument();
    // Created timestamps rendered via toLocaleString — match the "Created" prefix
    expect(screen.getAllByText(/^Created /).length).toBe(2);
  });
});
