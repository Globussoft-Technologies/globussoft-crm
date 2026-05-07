/**
 * Inbox.jsx — composer + Sent folder regression (#623, #624).
 *
 * What this test pins
 * ───────────────────
 *   #623 — Inbox composer must expose Cc and Bcc inputs. They are
 *          collapsed by default behind a "Cc / Bcc" toggle (mirrors
 *          Gmail / Outlook chrome) and revealed when clicked. Once
 *          revealed, typing into them flows the values through into
 *          POST /api/communications/send-email.
 *
 *   #624 — Sent folder must be queryable from the Inbox UI. Pre-fix
 *          the Emails tab rendered every EmailMessage row (both
 *          INBOUND and OUTBOUND) in a single list, so users had no
 *          way to inspect "what did I send today?". Fix is a sub-tab
 *          (All / Inbox / Sent) that switches the backend filter via
 *          /api/communications/inbox?folder=sent.
 *
 * Backend contract pinned by this test
 * ────────────────────────────────────
 *   - GET /api/communications/inbox            (folder=all  → omitted)
 *   - GET /api/communications/inbox?folder=inbox
 *   - GET /api/communications/inbox?folder=sent
 *   - POST /api/communications/send-email      includes cc + bcc fields
 *
 * Why a frontend test, not a backend / API test
 * ─────────────────────────────────────────────
 *   The backend persistence + folder filter is covered by
 *   backend/test/routes/communications.test.js (cc/bcc land in the
 *   prisma.create call shape, ?folder=sent filters by direction).
 *   This file pins the page surface — that the inputs render at all,
 *   that the toggle expands them, that the Sent sub-tab triggers the
 *   right query string. Both layers are needed: the backend pins the
 *   contract, the frontend pins the user-facing affordance.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

const notifyError = vi.fn();
const notifySuccess = vi.fn();
vi.mock('../utils/notify', () => ({
  useNotify: () => ({
    error: notifyError,
    info: vi.fn(),
    success: notifySuccess,
    confirm: () => Promise.resolve(true),
    prompt: () => Promise.resolve(''),
  }),
  NotifyProvider: ({ children }) => children,
}));

import Inbox from '../pages/Inbox';

const sampleSentEmail = {
  id: 100,
  from: 'me@globussoft.com',
  to: 'client@x.com',
  subject: 'sample sent',
  body: 'hello there',
  direction: 'OUTBOUND',
  read: true,
  createdAt: new Date().toISOString(),
};

function defaultFetch(url, opts) {
  if (!opts || !opts.method || opts.method === 'GET') {
    if (url === '/api/communications/inbox' || url.startsWith('/api/communications/inbox?')) {
      // Sent folder query → return only the OUTBOUND row. All / inbox →
      // return both (here just one inbound stub).
      if (url.includes('folder=sent')) return Promise.resolve([sampleSentEmail]);
      if (url.includes('folder=inbox')) return Promise.resolve([]);
      return Promise.resolve([sampleSentEmail]);
    }
    if (url === '/api/communications/calls') return Promise.resolve([]);
    if (url === '/api/contacts') return Promise.resolve([]);
    if (url === '/api/sms/messages') return Promise.resolve([]);
    if (url === '/api/whatsapp/messages') return Promise.resolve([]);
  }
  if (opts?.method === 'POST' && url === '/api/communications/send-email') {
    return Promise.resolve({ success: true, delivered: true, email: { id: 999 } });
  }
  return Promise.resolve([]);
}

function renderInbox() {
  return render(<Inbox />);
}

describe('<Inbox /> — #623 composer Cc/Bcc', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifySuccess.mockReset();
    fetchApiMock.mockImplementation(defaultFetch);
  });

  it('opens the composer and shows the Cc / Bcc toggle (collapsed by default)', async () => {
    const user = userEvent.setup();
    renderInbox();
    await waitFor(() => expect(screen.getByText('Compose Email')).toBeInTheDocument());
    await user.click(screen.getByText('Compose Email'));

    // The toggle exists.
    expect(await screen.findByRole('button', { name: /show cc and bcc/i })).toBeInTheDocument();
    // The Cc / Bcc inputs are NOT yet rendered.
    expect(screen.queryByLabelText(/^Cc:$/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Bcc:$/)).not.toBeInTheDocument();
  });

  it('clicking the Cc / Bcc toggle reveals the Cc and Bcc inputs', async () => {
    const user = userEvent.setup();
    renderInbox();
    await waitFor(() => expect(screen.getByText('Compose Email')).toBeInTheDocument());
    await user.click(screen.getByText('Compose Email'));

    const toggle = await screen.findByRole('button', { name: /show cc and bcc/i });
    await user.click(toggle);

    // Both inputs are now in the DOM and labelled.
    expect(screen.getByLabelText(/^Cc:$/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Bcc:$/)).toBeInTheDocument();
    // The toggle disappears once expanded (no point re-clicking it).
    expect(screen.queryByRole('button', { name: /show cc and bcc/i })).not.toBeInTheDocument();
  });

  it('submitting the form sends cc + bcc through to /api/communications/send-email', async () => {
    const user = userEvent.setup();
    renderInbox();
    await waitFor(() => expect(screen.getByText('Compose Email')).toBeInTheDocument());
    await user.click(screen.getByText('Compose Email'));
    await user.click(await screen.findByRole('button', { name: /show cc and bcc/i }));

    // Fill required + cc + bcc.
    await user.type(screen.getByPlaceholderText(/client@company.com/i), 'primary@x.com');
    await user.type(screen.getByLabelText(/^Cc:$/), 'cc1@x.com, cc2@x.com');
    await user.type(screen.getByLabelText(/^Bcc:$/), 'bcc@x.com');
    await user.type(screen.getByPlaceholderText('Following up'), 'subject-here');
    await user.type(screen.getByPlaceholderText(/Write your email here/i), 'body-here');

    await user.click(screen.getByRole('button', { name: /send email/i }));

    await waitFor(() => {
      const sendCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/communications/send-email' && opts?.method === 'POST'
      );
      expect(sendCall).toBeTruthy();
      const sentBody = JSON.parse(sendCall[1].body);
      expect(sentBody.to).toBe('primary@x.com');
      expect(sentBody.cc).toBe('cc1@x.com, cc2@x.com');
      expect(sentBody.bcc).toBe('bcc@x.com');
      expect(sentBody.subject).toBe('subject-here');
      expect(sentBody.body).toBe('body-here');
    });
  });
});

describe('<Inbox /> — #624 Sent folder sub-tab', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifySuccess.mockReset();
    fetchApiMock.mockImplementation(defaultFetch);
  });

  it('renders an "All / Inbox / Sent" sub-tab on the Emails view', async () => {
    renderInbox();
    await waitFor(() => expect(screen.getByText(/Emails \(/i)).toBeInTheDocument());
    // Sub-tab buttons present.
    expect(screen.getByRole('tab', { name: 'All' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Inbox' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Sent' })).toBeInTheDocument();
  });

  it('clicking the Sent sub-tab triggers GET /api/communications/inbox?folder=sent', async () => {
    const user = userEvent.setup();
    renderInbox();
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Sent' })).toBeInTheDocument());

    await user.click(screen.getByRole('tab', { name: 'Sent' }));

    await waitFor(() => {
      const sentFetch = fetchApiMock.mock.calls.find(
        ([url]) => typeof url === 'string' && url === '/api/communications/inbox?folder=sent'
      );
      expect(sentFetch).toBeTruthy();
    });
  });

  it('clicking the Inbox sub-tab triggers GET /api/communications/inbox?folder=inbox', async () => {
    const user = userEvent.setup();
    renderInbox();
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Inbox' })).toBeInTheDocument());

    await user.click(screen.getByRole('tab', { name: 'Inbox' }));

    await waitFor(() => {
      const inboxFetch = fetchApiMock.mock.calls.find(
        ([url]) => typeof url === 'string' && url === '/api/communications/inbox?folder=inbox'
      );
      expect(inboxFetch).toBeTruthy();
    });
  });

  it('Sent folder shows the OUTBOUND email row from the backend response', async () => {
    const user = userEvent.setup();
    renderInbox();
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Sent' })).toBeInTheDocument());

    await user.click(screen.getByRole('tab', { name: 'Sent' }));

    // The OUTBOUND row from the mocked /folder=sent response renders.
    expect(await screen.findByText('sample sent')).toBeInTheDocument();
  });
});
