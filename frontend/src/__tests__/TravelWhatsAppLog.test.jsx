/**
 * TravelWhatsAppLog.test.jsx — vitest + RTL coverage for the Travel-
 * vertical WhatsApp dispatch-log page
 * (frontend/src/pages/travel/WhatsAppLog.jsx, Q9 Wati transport).
 *
 * Scope — pins page-surface invariants for the read-only operator log of
 * WhatsAppMessage rows persisted by backend/services/watiClient.js:
 *
 *   1. Page chrome: heading "WhatsApp" + subtitle + Refresh button.
 *   2. Loading state before first GET resolves.
 *   3. GET on mount: /api/whatsapp/messages?page=1&limit=25; renders one
 *      row per message (recipient, template, body, status badge).
 *   4. Stub-mode hint banner renders when any row is QUEUED.
 *   5. No stub-mode hint when no row is QUEUED.
 *   6. Status filter re-fetches with ?status= and resets to page 1.
 *   7. Direction filter re-fetches with ?direction=.
 *   8. Empty state: "No WhatsApp messages yet."
 *   9. Load error: inline error card (fetch rejection).
 *  10. FAILED row surfaces its errorMessage.
 *  11. Pagination: renders for pages>1; Next re-fetches page=2.
 *
 * Backend contract pinned (per backend/routes/whatsapp.js GET /messages):
 *   GET /api/whatsapp/messages?status=&direction=&page=&limit=
 *     → 200 { messages: [{ id, to, from, body, direction, status,
 *               templateName, errorMessage, createdAt, contact? }],
 *             pagination: { total, page, limit, pages } }
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at ../utils/api (the page's dep, NOT global fetch).
 *   - All data-dependent assertions use await findBy / waitFor.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

import TravelWhatsAppLog from '../pages/travel/WhatsAppLog';

const MSG_QUEUED = {
  id: 30,
  to: '919811111102',
  from: null,
  body: 'Hi Ahmed Khan! Your Goa itinerary is ready. View it here: https://x/p/itinerary/tok',
  direction: 'OUTBOUND',
  status: 'QUEUED',
  templateName: null,
  errorMessage: null,
  createdAt: '2026-06-11T08:07:53.650Z',
  contact: { id: 65, name: 'Ahmed Khan', phone: '+919811111102' },
};

const MSG_SENT = {
  id: 31,
  to: '919811111103',
  from: null,
  body: 'Your Travel Stall verification code is 4321.',
  direction: 'OUTBOUND',
  status: 'SENT',
  templateName: 'otp_verification',
  errorMessage: null,
  createdAt: '2026-06-11T09:00:00.000Z',
  contact: null,
};

const MSG_FAILED = {
  id: 32,
  to: '919811111104',
  from: null,
  body: 'Web check-in is now open.',
  direction: 'OUTBOUND',
  status: 'FAILED',
  templateName: 'web_checkin_nudge',
  errorMessage: 'Wati HTTP 401: invalid token',
  createdAt: '2026-06-11T10:00:00.000Z',
  contact: null,
};

function respond({ messages = [], total = messages.length, pages = 1, page = 1 } = {}) {
  return Promise.resolve({
    messages,
    pagination: { total, page, limit: 25, pages },
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <TravelWhatsAppLog />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchApiMock.mockReset();
});

describe('<TravelWhatsAppLog /> — chrome + load', () => {
  it('1. renders heading, subtitle and Refresh button', async () => {
    fetchApiMock.mockImplementation(() => respond({ messages: [MSG_SENT] }));
    renderPage();
    expect(
      await screen.findByRole('heading', { name: /WhatsApp/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Travel WhatsApp dispatch log \(Wati\)/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Refresh messages/i })).toBeInTheDocument();
  });

  it('2. shows the loading placeholder before the first GET resolves', async () => {
    let resolveFetch;
    fetchApiMock.mockImplementation(
      () => new Promise((res) => { resolveFetch = res; }),
    );
    renderPage();
    expect(screen.getByRole('status')).toHaveTextContent(/Loading/i);
    resolveFetch({ messages: [], pagination: { total: 0, page: 1, limit: 25, pages: 1 } });
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });

  it('3. GETs /api/whatsapp/messages with page+limit on mount and renders rows', async () => {
    fetchApiMock.mockImplementation(() => respond({ messages: [MSG_QUEUED, MSG_SENT] }));
    renderPage();
    expect(await screen.findByText('919811111102')).toBeInTheDocument();
    expect(screen.getByText('Ahmed Khan')).toBeInTheDocument();
    expect(screen.getByText('otp_verification')).toBeInTheDocument();
    expect(screen.getByText('QUEUED')).toBeInTheDocument();
    expect(screen.getByText('SENT')).toBeInTheDocument();
    const firstUrl = fetchApiMock.mock.calls[0][0];
    expect(firstUrl).toContain('/api/whatsapp/messages?');
    expect(firstUrl).toContain('page=1');
    expect(firstUrl).toContain('limit=25');
  });
});

describe('<TravelWhatsAppLog /> — stub-mode hint', () => {
  it('4. renders the stub-mode hint when any row is QUEUED', async () => {
    fetchApiMock.mockImplementation(() => respond({ messages: [MSG_QUEUED, MSG_SENT] }));
    renderPage();
    expect(await screen.findByTestId('stub-mode-hint')).toHaveTextContent(/stub mode/i);
  });

  it('5. omits the stub-mode hint when no row is QUEUED', async () => {
    fetchApiMock.mockImplementation(() => respond({ messages: [MSG_SENT] }));
    renderPage();
    await screen.findByText('SENT');
    expect(screen.queryByTestId('stub-mode-hint')).toBeNull();
  });
});

describe('<TravelWhatsAppLog /> — filters', () => {
  it('6. status filter re-fetches with ?status= and resets page', async () => {
    fetchApiMock.mockImplementation(() => respond({ messages: [MSG_FAILED] }));
    renderPage();
    await screen.findByText('FAILED');
    fetchApiMock.mockClear();
    fireEvent.change(screen.getByLabelText(/Filter by status/i), {
      target: { value: 'FAILED' },
    });
    await waitFor(() => {
      const url = fetchApiMock.mock.calls[0][0];
      expect(url).toContain('status=FAILED');
      expect(url).toContain('page=1');
    });
  });

  it('7. direction filter re-fetches with ?direction=', async () => {
    fetchApiMock.mockImplementation(() => respond({ messages: [MSG_SENT] }));
    renderPage();
    await screen.findByText('SENT');
    fetchApiMock.mockClear();
    fireEvent.change(screen.getByLabelText(/Filter by direction/i), {
      target: { value: 'OUTBOUND' },
    });
    await waitFor(() => {
      expect(fetchApiMock.mock.calls[0][0]).toContain('direction=OUTBOUND');
    });
  });
});

describe('<TravelWhatsAppLog /> — empty / error / failure detail', () => {
  it('8. renders the empty state when no messages exist', async () => {
    fetchApiMock.mockImplementation(() => respond({ messages: [] }));
    renderPage();
    expect(await screen.findByText(/No WhatsApp messages yet/i)).toBeInTheDocument();
  });

  it('9. renders the inline error card when the GET rejects', async () => {
    fetchApiMock.mockImplementation(() => Promise.reject(new Error('boom')));
    renderPage();
    expect(
      await screen.findByText(/Failed to load WhatsApp messages/i),
    ).toBeInTheDocument();
  });

  it('10. FAILED rows surface their errorMessage', async () => {
    fetchApiMock.mockImplementation(() => respond({ messages: [MSG_FAILED] }));
    renderPage();
    expect(await screen.findByText(/Wati HTTP 401: invalid token/i)).toBeInTheDocument();
  });
});

describe('<TravelWhatsAppLog /> — pagination', () => {
  it('11. renders pager for pages>1 and Next re-fetches page=2', async () => {
    fetchApiMock.mockImplementation(() => respond({ messages: [MSG_SENT], total: 60, pages: 3 }));
    renderPage();
    expect(await screen.findByText(/Page 1 of 3/i)).toBeInTheDocument();
    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Next page/i }));
    await waitFor(() => {
      expect(fetchApiMock.mock.calls[0][0]).toContain('page=2');
    });
  });
});
