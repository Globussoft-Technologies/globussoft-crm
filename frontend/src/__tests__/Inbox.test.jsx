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

  // Many user.click/type calls under userEvent's per-action wait — passes
  // in isolation (~3.5s) but trips the 5s test timeout when the full
  // 76-file suite runs under CPU contention. Bump to 15s for headroom.
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
  }, 15_000);
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

// #580 — Sentiment indicators were referenced in the Section 7 test plan
// but the AI/Gemini backend that would compute them is not planned (#563
// closed as Not planned). De-scope: the Inbox UI must NOT surface sentiment
// columns / dots / "AI sentiment coming soon" hints, since shipping a stub
// for a feature that won't be wired is dishonest. This regression pin keeps
// the surface honest — if a future patch reintroduces a sentiment hint
// without the backend, this test will catch it.
describe('<Inbox /> — #580 no sentiment surface', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifySuccess.mockReset();
    fetchApiMock.mockImplementation(defaultFetch);
  });

  it('does NOT render any sentiment column / badge / hint', async () => {
    renderInbox();
    await waitFor(() => expect(screen.getByText(/Emails \(/i)).toBeInTheDocument());
    // No sentiment-named UI surfaces anywhere on the page.
    expect(screen.queryByText(/sentiment/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/AI tone/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/coming soon/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/sentiment/i)).not.toBeInTheDocument();
  });

  it('opening an email row does NOT render a sentiment score in the detail modal', async () => {
    const user = userEvent.setup();
    renderInbox();
    await waitFor(() => expect(screen.getByText('sample sent')).toBeInTheDocument());
    await user.click(screen.getByText('sample sent'));
    // No sentiment surface in the detail modal either.
    expect(screen.queryByText(/sentiment/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/positive|neutral|negative/i)).not.toBeInTheDocument();
  });
});

// #594 — Compose WhatsApp affordance + send flow. Pre-fix the WhatsApp
// tab could only render inbound threads; there was no way to start a new
// outbound conversation. Fix added a header button that opens a channel-
// specific composer (phone + body, no subject/cc/bcc) which POSTs to
// /api/whatsapp/send.
describe('<Inbox /> — #594 Compose WhatsApp', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifySuccess.mockReset();
    fetchApiMock.mockImplementation((url, opts) => {
      if (!opts || !opts.method || opts.method === 'GET') {
        if (url === '/api/communications/inbox' || url.startsWith('/api/communications/inbox?')) return Promise.resolve([]);
        if (url === '/api/communications/calls') return Promise.resolve([]);
        if (url === '/api/contacts') return Promise.resolve([
          { id: 1, name: 'Rishu Goyal', email: 'rishu@x.in', phone: '+919876543210' },
        ]);
        if (url === '/api/sms/messages') return Promise.resolve([]);
        if (url === '/api/whatsapp/messages') return Promise.resolve({ messages: [] });
      }
      if (opts?.method === 'POST' && url === '/api/whatsapp/send') {
        return Promise.resolve({ success: true, messageId: 42 });
      }
      return Promise.resolve([]);
    });
  });

  it('renders a "Compose WhatsApp" button in the Inbox header', async () => {
    renderInbox();
    expect(await screen.findByRole('button', { name: /compose whatsapp/i })).toBeInTheDocument();
  });

  it('clicking Compose WhatsApp opens a channel-specific modal (phone + body, no subject/cc/bcc)', async () => {
    const user = userEvent.setup();
    renderInbox();
    const btn = await screen.findByRole('button', { name: /compose whatsapp/i });
    await user.click(btn);

    // Phone + body fields exist.
    expect(await screen.findByLabelText(/Phone Number \(E\.164\)/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Message:$/i)).toBeInTheDocument();

    // Email-specific surfaces are NOT in the WhatsApp composer.
    // (The Cc/Bcc toggle belongs to the email composer, which isn't open.)
    expect(screen.queryByRole('button', { name: /show cc and bcc/i })).not.toBeInTheDocument();
    // The send button is WhatsApp-flavoured, not "Send Email".
    expect(screen.getByRole('button', { name: /send whatsapp/i })).toBeInTheDocument();
  });

  it('submitting the WhatsApp composer POSTs { to, body } to /api/whatsapp/send', async () => {
    const user = userEvent.setup();
    renderInbox();
    await user.click(await screen.findByRole('button', { name: /compose whatsapp/i }));

    const phoneInput = await screen.findByLabelText(/Phone Number \(E\.164\)/i);
    const bodyInput = screen.getByLabelText(/^Message:$/i);
    await user.type(phoneInput, '+919876543210');
    await user.type(bodyInput, 'Hello from the WhatsApp composer');

    await user.click(screen.getByRole('button', { name: /send whatsapp/i }));

    await waitFor(() => {
      const sendCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/whatsapp/send' && opts?.method === 'POST'
      );
      expect(sendCall).toBeTruthy();
      const sentBody = JSON.parse(sendCall[1].body);
      expect(sentBody.to).toBe('+919876543210');
      expect(sentBody.body).toBe('Hello from the WhatsApp composer');
      // Email-specific keys must not be in the WhatsApp request body.
      expect(sentBody.subject).toBeUndefined();
      expect(sentBody.cc).toBeUndefined();
      expect(sentBody.bcc).toBeUndefined();
    });
  });
});

// #726 — Compose WhatsApp + Send WhatsApp must use btn-primary canonical
// teal, NOT the WhatsApp-brand-green outlined / solid styling. Before
// the fix, the header button was className="btn-secondary" with inline
// `background: rgba(37,211,102,0.15)` etc., and the modal submit was
// className="btn-primary" but with inline `background: #25D366`
// overriding it. Both rendered out-of-band among 4 sibling teal pills.
// Pin both buttons here so any future "the WhatsApp button should be
// green" regression is caught at the unit-test layer, not on a demo
// click-through.
describe('<Inbox /> — #726 WhatsApp buttons match canonical teal', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifySuccess.mockReset();
    fetchApiMock.mockImplementation((url, opts) => {
      if (!opts || !opts.method || opts.method === 'GET') {
        if (url === '/api/communications/inbox' || url.startsWith('/api/communications/inbox?')) return Promise.resolve([]);
        if (url === '/api/communications/calls') return Promise.resolve([]);
        if (url === '/api/contacts') return Promise.resolve([]);
        if (url === '/api/sms/messages') return Promise.resolve([]);
        if (url === '/api/whatsapp/messages') return Promise.resolve({ messages: [] });
      }
      return Promise.resolve([]);
    });
  });

  it('header "Compose WhatsApp" button uses btn-primary with NO inline color overrides', async () => {
    renderInbox();
    const btn = await screen.findByRole('button', { name: /compose whatsapp/i });

    // Class is the canonical primary class (not btn-secondary).
    expect(btn).toHaveClass('btn-primary');
    expect(btn).not.toHaveClass('btn-secondary');

    // None of the WhatsApp-brand-green inline overrides leak onto the DOM node.
    // Pre-fix: `background: rgba(37,211,102,0.15); border: 1px solid #25D366; color: #25D366`.
    // Post-fix: bare btn-primary class — no inline style on background/color/border.
    const style = btn.getAttribute('style') || '';
    expect(style).not.toMatch(/37,?\s*211,?\s*102/);  // rgba(37, 211, 102, ...)
    expect(style).not.toMatch(/#25D366/i);            // solid WhatsApp green
    expect(style).not.toMatch(/border:\s*1px\s+solid/i); // explicit outline
  });

  it('modal "Send WhatsApp" submit button uses btn-primary with NO inline #25D366 override', async () => {
    const user = userEvent.setup();
    renderInbox();
    await user.click(await screen.findByRole('button', { name: /compose whatsapp/i }));

    const submit = screen.getByRole('button', { name: /send whatsapp/i });
    expect(submit).toHaveClass('btn-primary');

    const style = submit.getAttribute('style') || '';
    // Pre-fix: `background: #25D366; border-color: #25D366`.
    // Post-fix: btn-primary inherits var(--brand) teal.
    expect(style).not.toMatch(/#25D366/i);
    expect(style).not.toMatch(/border-?color/i);
    expect(style).not.toMatch(/background:\s*(rgb\(37|#25D366)/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Extended coverage — channel tabs (emails/calls/sms/whatsapp), composers,
// dialer, scheduled meeting, detail modal, empty + loading + error states.
// Pins the unified-inbox surface (878 LOC SUT) against accidental regression
// of any one channel's UI affordance.
// ─────────────────────────────────────────────────────────────────────────

const inboundSms = {
  id: 'sms-1',
  from: '+919998887777',
  to: '+919876543210',
  body: 'Inbound SMS from a lead',
  direction: 'INBOUND',
  status: 'DELIVERED',
  createdAt: new Date('2026-05-01T10:00:00Z').toISOString(),
};
const inboundWa = {
  id: 'wa-1',
  from: '+919998887777',
  to: '+919876543210',
  body: 'Inbound WhatsApp from a lead',
  direction: 'INBOUND',
  status: 'READ',
  createdAt: new Date('2026-05-01T10:05:00Z').toISOString(),
};
const sampleCall = {
  id: 'call-1',
  direction: 'INBOUND',
  duration: 42,
  notes: 'discovery call notes',
  recordingUrl: 'https://example.com/rec.mp3',
  callerNumber: '+919998887777',
  calleeNumber: '+919876543210',
  status: 'COMPLETED',
  createdAt: new Date('2026-05-01T11:00:00Z').toISOString(),
};

function fullChannelFetch(url, opts) {
  if (!opts || !opts.method || opts.method === 'GET') {
    if (url === '/api/communications/inbox' || url.startsWith('/api/communications/inbox?')) {
      return Promise.resolve([sampleSentEmail]);
    }
    if (url === '/api/communications/calls') return Promise.resolve([sampleCall]);
    if (url === '/api/contacts') return Promise.resolve([
      { id: 'c1', name: 'Rishu Goyal', email: 'rishu@x.in', phone: '+919876543210', company: 'Enhanced Wellness' },
    ]);
    if (url === '/api/sms/messages') return Promise.resolve({ messages: [inboundSms] });
    if (url === '/api/whatsapp/messages') return Promise.resolve({ messages: [inboundWa] });
  }
  if (opts?.method === 'POST') {
    if (url === '/api/sms/send') return Promise.resolve({ success: true });
    if (url === '/api/whatsapp/send') return Promise.resolve({ success: true });
    if (url === '/api/communications/send-email') return Promise.resolve({ success: true });
    if (url === '/api/communications/calls') return Promise.resolve({ success: true, id: 'call-new' });
    if (url === '/api/telephony/click-to-call') return Promise.resolve({ callId: 'tcc-1' });
    if (url.startsWith('/api/contacts/') && url.endsWith('/activities')) return Promise.resolve({ success: true });
    if (url === '/api/ai/draft') return Promise.resolve({ draft: 'AI-generated body content' });
    if (url === '/api/ai/subject-lines') return Promise.resolve({ subjects: ['Subj A', 'Subj B'] });
  }
  return Promise.resolve([]);
}

describe('<Inbox /> — channel tab rendering + counts', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifySuccess.mockReset();
    fetchApiMock.mockImplementation(fullChannelFetch);
  });

  it('renders all 4 channel tabs (Emails / Call Logs / SMS / WhatsApp) with item counts', async () => {
    renderInbox();
    // Wait for data load so counts reflect the mocked rows.
    await waitFor(() => expect(screen.getByText(/Emails \(1\)/)).toBeInTheDocument());
    expect(screen.getByText(/Call Logs \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/SMS \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/WhatsApp \(1\)/)).toBeInTheDocument();
  });

  it('clicking the SMS tab reveals the inbound SMS row', async () => {
    const user = userEvent.setup();
    renderInbox();
    await waitFor(() => expect(screen.getByText(/SMS \(1\)/)).toBeInTheDocument());

    await user.click(screen.getByText(/SMS \(1\)/));

    expect(await screen.findByText('Inbound SMS from a lead')).toBeInTheDocument();
    // DELIVERED status pill rendered.
    expect(screen.getByText('DELIVERED')).toBeInTheDocument();
  });

  it('clicking the WhatsApp tab reveals the inbound WhatsApp row with READ status', async () => {
    const user = userEvent.setup();
    renderInbox();
    await waitFor(() => expect(screen.getByText(/WhatsApp \(1\)/)).toBeInTheDocument());

    await user.click(screen.getByText(/WhatsApp \(1\)/));

    expect(await screen.findByText('Inbound WhatsApp from a lead')).toBeInTheDocument();
    expect(screen.getByText('READ')).toBeInTheDocument();
  });

  it('clicking the Call Logs tab reveals the call row with duration + recording affordance', async () => {
    const user = userEvent.setup();
    renderInbox();
    await waitFor(() => expect(screen.getByText(/Call Logs \(1\)/)).toBeInTheDocument());

    await user.click(screen.getByText(/Call Logs \(1\)/));

    expect(await screen.findByText(/INBOUND CALL/i)).toBeInTheDocument();
    expect(screen.getByText(/42 seconds/)).toBeInTheDocument();
    // Recording present → Play Recording button rendered. (Accessible-name match
    // hits both the <button> text label AND the <button title="..."> attribute
    // when title === recordingUrl is also a button-label source; getAllByRole
    // is the right primitive per the 2026-05-22 standing rule.)
    expect(screen.getAllByRole('button', { name: /play recording/i }).length).toBeGreaterThanOrEqual(1);
  });
});

describe('<Inbox /> — message detail modal opens per channel', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifySuccess.mockReset();
    fetchApiMock.mockImplementation(fullChannelFetch);
  });

  it('clicking an SMS row opens the shared detail modal scoped to the SMS message', async () => {
    const user = userEvent.setup();
    renderInbox();
    await waitFor(() => expect(screen.getByText(/SMS \(1\)/)).toBeInTheDocument());
    await user.click(screen.getByText(/SMS \(1\)/));

    const row = await screen.findByText('Inbound SMS from a lead');
    await user.click(row);

    // SMS Message heading present in the detail modal.
    expect(await screen.findByRole('heading', { name: /SMS Message/i })).toBeInTheDocument();
    // Close button(s) present — the X icon (aria-label="Close") AND the
    // bottom Close button both render; getAllByRole avoids the duplicate trap.
    expect(screen.getAllByRole('button', { name: /close/i }).length).toBeGreaterThanOrEqual(1);
  });

  it('clicking an email row opens the email-specific detail modal', async () => {
    const user = userEvent.setup();
    renderInbox();
    await waitFor(() => expect(screen.getByText('sample sent')).toBeInTheDocument());

    await user.click(screen.getByText('sample sent'));

    // The email-specific heading appears in the modal.
    expect(await screen.findByRole('heading', { name: /^Email$/i })).toBeInTheDocument();
    // The full body renders inside the modal alongside the row body.
    const bodyMatches = screen.getAllByText('hello there');
    expect(bodyMatches.length).toBeGreaterThanOrEqual(1);
  });
});

describe('<Inbox /> — Compose SMS', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifySuccess.mockReset();
    fetchApiMock.mockImplementation(fullChannelFetch);
  });

  it('opening + submitting the SMS composer POSTs { to, body } to /api/sms/send', async () => {
    const user = userEvent.setup();
    renderInbox();
    await waitFor(() => expect(screen.getByRole('button', { name: /compose sms/i })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /compose sms/i }));

    await user.type(await screen.findByPlaceholderText(/\+91 X{8,}/i), '+919876543210');
    await user.type(screen.getByPlaceholderText(/Type your SMS message here/i), 'A quick SMS hello');

    await user.click(screen.getByRole('button', { name: /send sms/i }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/sms/send' && opts?.method === 'POST'
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body.to).toBe('+919876543210');
      expect(body.body).toBe('A quick SMS hello');
    });
  }, 15_000);

  it('SMS composer renders a live character counter (160-char SMS budget)', async () => {
    const user = userEvent.setup();
    renderInbox();
    await waitFor(() => expect(screen.getByRole('button', { name: /compose sms/i })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /compose sms/i }));

    // Counter starts at 0/160.
    expect(await screen.findByText(/Character count: 0\/160/i)).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText(/Type your SMS message here/i), 'hello');

    expect(screen.getByText(/Character count: 5\/160/i)).toBeInTheDocument();
  }, 15_000);
});

describe('<Inbox /> — Call Dialer + Initiate Call', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifySuccess.mockReset();
    fetchApiMock.mockImplementation(fullChannelFetch);
  });

  it('opening + submitting the Initiate Call modal POSTs to /api/communications/calls', async () => {
    const user = userEvent.setup();
    renderInbox();
    await waitFor(() => expect(screen.getByRole('button', { name: /call dialer/i })).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /call dialer/i }));

    // The Initiate Call form appears (a heading, not the header trigger button).
    expect(await screen.findByRole('heading', { name: /Initiate Call/i })).toBeInTheDocument();

    // Pick the seeded contact from the dropdown.
    const contactSelect = screen.getByRole('combobox');
    await user.selectOptions(contactSelect, 'c1');

    await user.click(screen.getByRole('button', { name: /start call/i }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/communications/calls' && opts?.method === 'POST'
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body.contactId).toBe('c1');
      expect(body.direction).toBe('OUTBOUND');
    });
  }, 15_000);
});

describe('<Inbox /> — Schedule Meeting', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifySuccess.mockReset();
    fetchApiMock.mockImplementation(fullChannelFetch);
  });

  it('submitting the Schedule Meeting form POSTs an activity to /api/contacts/:id/activities', async () => {
    const user = userEvent.setup();
    renderInbox();
    await waitFor(() => expect(screen.getByRole('button', { name: /schedule meeting/i })).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /schedule meeting/i }));

    // Calendar Sync modal heading appears (distinct from the header trigger button).
    expect(await screen.findByRole('heading', { name: /Calendar Sync/i })).toBeInTheDocument();

    const contactSelect = screen.getByRole('combobox');
    await user.selectOptions(contactSelect, 'c1');

    // Browser inputs accept date/time strings directly via fireEvent-style typing.
    const dateInput = document.querySelector('input[type="date"]');
    const timeInput = document.querySelector('input[type="time"]');
    expect(dateInput).toBeTruthy();
    expect(timeInput).toBeTruthy();
    await user.type(dateInput, '2026-12-01');
    await user.type(timeInput, '14:30');
    await user.type(screen.getByPlaceholderText(/Zoom\/Google Meet links/i), 'product demo agenda');

    await user.click(screen.getByRole('button', { name: /send invites/i }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => typeof url === 'string' && url === '/api/contacts/c1/activities' && opts?.method === 'POST'
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body.type).toBe('Meeting');
      expect(body.description).toMatch(/product demo agenda/);
    });
  }, 15_000);
});

describe('<Inbox /> — loading + empty states', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifySuccess.mockReset();
  });

  it('renders the "Syncing communications..." loading indicator before fetches resolve', async () => {
    // Use a never-resolving promise to hold the page in loading state.
    fetchApiMock.mockImplementation(() => new Promise(() => { /* never resolve */ }));
    renderInbox();
    expect(await screen.findByText(/Syncing communications/i)).toBeInTheDocument();
  });

  it('empty SMS tab shows the "Configure SMS in Settings > Channels" hint', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (!opts || !opts.method || opts.method === 'GET') {
        if (url === '/api/communications/inbox' || url.startsWith('/api/communications/inbox?')) return Promise.resolve([]);
        if (url === '/api/communications/calls') return Promise.resolve([]);
        if (url === '/api/contacts') return Promise.resolve([]);
        if (url === '/api/sms/messages') return Promise.resolve([]);
        if (url === '/api/whatsapp/messages') return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });

    const user = userEvent.setup();
    renderInbox();
    await waitFor(() => expect(screen.getByText(/SMS \(0\)/)).toBeInTheDocument());
    await user.click(screen.getByText(/SMS \(0\)/));

    expect(await screen.findByText(/Configure SMS in Settings > Channels/i)).toBeInTheDocument();
  });

  it('empty WhatsApp tab shows the "Configure WhatsApp in Settings > Channels" hint', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (!opts || !opts.method || opts.method === 'GET') {
        if (url === '/api/communications/inbox' || url.startsWith('/api/communications/inbox?')) return Promise.resolve([]);
        if (url === '/api/communications/calls') return Promise.resolve([]);
        if (url === '/api/contacts') return Promise.resolve([]);
        if (url === '/api/sms/messages') return Promise.resolve([]);
        if (url === '/api/whatsapp/messages') return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });

    const user = userEvent.setup();
    renderInbox();
    await waitFor(() => expect(screen.getByText(/WhatsApp \(0\)/)).toBeInTheDocument());
    await user.click(screen.getByText(/WhatsApp \(0\)/));

    expect(await screen.findByText(/Configure WhatsApp in Settings > Channels/i)).toBeInTheDocument();
  });

  it('empty Call Logs tab shows the "No recent calls" hint', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (!opts || !opts.method || opts.method === 'GET') {
        if (url === '/api/communications/inbox' || url.startsWith('/api/communications/inbox?')) return Promise.resolve([]);
        if (url === '/api/communications/calls') return Promise.resolve([]);
        if (url === '/api/contacts') return Promise.resolve([]);
        if (url === '/api/sms/messages') return Promise.resolve([]);
        if (url === '/api/whatsapp/messages') return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });

    const user = userEvent.setup();
    renderInbox();
    await waitFor(() => expect(screen.getByText(/Call Logs \(0\)/)).toBeInTheDocument());
    await user.click(screen.getByText(/Call Logs \(0\)/));

    expect(await screen.findByText(/No recent calls/i)).toBeInTheDocument();
  });
});

describe('<Inbox /> — error path: WhatsApp send failure surfaces actionable notify', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifySuccess.mockReset();
  });

  it('shows actionable Settings>Channels error when /api/whatsapp/send rejects with "No active WhatsApp"', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (!opts || !opts.method || opts.method === 'GET') {
        if (url === '/api/communications/inbox' || url.startsWith('/api/communications/inbox?')) return Promise.resolve([]);
        if (url === '/api/communications/calls') return Promise.resolve([]);
        if (url === '/api/contacts') return Promise.resolve([]);
        if (url === '/api/sms/messages') return Promise.resolve([]);
        if (url === '/api/whatsapp/messages') return Promise.resolve({ messages: [] });
      }
      if (opts?.method === 'POST' && url === '/api/whatsapp/send') {
        return Promise.reject(new Error('No active WhatsApp provider'));
      }
      return Promise.resolve([]);
    });

    const user = userEvent.setup();
    renderInbox();
    await user.click(await screen.findByRole('button', { name: /compose whatsapp/i }));

    await user.type(await screen.findByLabelText(/Phone Number \(E\.164\)/i), '+919876543210');
    await user.type(screen.getByLabelText(/^Message:$/i), 'will fail');

    await user.click(screen.getByRole('button', { name: /send whatsapp/i }));

    await waitFor(() => {
      // The actionable Settings > Channels hint fires (not the generic "WhatsApp send failed").
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/Settings > Channels/i)
      );
    });
    // The success path must NOT have fired.
    expect(notifySuccess).not.toHaveBeenCalledWith(
      expect.stringMatching(/WhatsApp message queued/i)
    );
  }, 15_000);
});
