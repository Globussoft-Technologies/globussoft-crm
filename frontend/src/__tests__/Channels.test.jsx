/**
 * Channels.jsx — Settings → Channels save round-trip regression (#586).
 *
 * What this test pins
 * ───────────────────
 * Pre-#586 the Channels page was a privileged-only "save-lie": Admin / Owner
 * clicked Save on (e.g.) MSG91, the green "Configuration saved!" toast fired,
 * the backend upsert genuinely persisted the row — but on hard-refresh every
 * input rendered empty and the Enable checkbox was unchecked, because the
 * page never loaded the saved configs back. Operators (legitimately) read
 * this as "save did not persist", and would re-enter credentials before
 * giving up. Outbound SMS / WhatsApp then silently never went out.
 *
 * Two distinct frontend bugs combined to produce the symptom:
 *   (1) No `useEffect` fetched GET /api/<channel>/config on mount or tab
 *       change → existing rows were invisible to the UI.
 *   (2) <input> elements in ConfigCard had only `placeholder` + `onChange`
 *       (no `value`) — they were uncontrolled, so even if (1) had populated
 *       state, the inputs would not have rendered the values.
 *   (2b) The single shared `configForm` object collided across MSG91 + Twilio
 *        on the SMS tab (both providers share `apiKey` / `senderId` keys).
 *
 * Backend (routes/sms.js, routes/whatsapp.js, routes/telephony.js) was
 * already correct: PUT /api/<channel>/config/:provider awaits a Prisma upsert
 * keyed on the (tenantId, provider) composite unique constraint, returns
 * masked secrets. The bug surface lives entirely in Channels.jsx.
 *
 * Contract pinned here
 * ────────────────────
 *   - On mount, the page calls GET /api/sms/config (and templates), AND
 *     GET /api/whatsapp/config when the tab flips to WhatsApp, AND
 *     GET /api/telephony/config when the tab flips to Telephony.
 *   - When the GET returns a row for `provider: msg91`, the MSG91 card's
 *     senderId input renders the persisted value (so a hard-refresh reveals
 *     the saved state — toggle does NOT revert).
 *   - When the GET returns `isActive: true` for `msg91`, the MSG91 card's
 *     Enable checkbox is rendered checked.
 *   - MSG91 + Twilio cards have independent state (per-provider): typing
 *     into the Twilio Account SID field does NOT bleed into the MSG91
 *     API Key field.
 *   - Save fires PUT /api/sms/config/msg91 with the per-provider payload
 *     (NOT a contaminated cross-card object).
 *   - After Save, the page re-issues GET /api/sms/config (round-trip read)
 *     so the displayed state matches the DB.
 *
 * Why a frontend test, not a backend / API test
 * ─────────────────────────────────────────────
 * The backend round-trip is already covered by sms-api.spec.js (PUT then
 * GET asserts the value comes back). That spec was green throughout the
 * #586 incident — because the bug never reached the backend. The pin we
 * need is on the *page* doing the load-back, the inputs being controlled,
 * and the per-provider state isolation. Those are component-level invariants.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

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

import Channels from '../pages/Channels';

// Default mock: /api/sms/config returns one persisted MSG91 row + empty templates.
// Routes that aren't explicitly handled return [].
const persistedMsg91 = {
  id: 1,
  provider: 'msg91',
  // #651 (v3.7.x) — GET /sms/config returns credentials as { configured, last4 }
  // object shape instead of a masked string sentinel. The frontend SecretFieldRow
  // component reads .last4 to render the readonly "**** XYZ7" pill.
  apiKey: { configured: true, last4: 'A7B9' },
  authToken: null,
  senderId: 'GLBSMS',
  dltEntityId: 'DLT-12345',
  isActive: true,
  settings: null,
  tenantId: 1,
};

function defaultFetch(url, opts) {
  if (!opts || !opts.method || opts.method === 'GET') {
    if (url === '/api/sms/config') return Promise.resolve([persistedMsg91]);
    if (url === '/api/whatsapp/config') return Promise.resolve([]);
    if (url === '/api/telephony/config') return Promise.resolve([]);
    if (url === '/api/sms/templates') return Promise.resolve([]);
    if (url === '/api/whatsapp/templates') return Promise.resolve([]);
    if (url === '/api/push/templates') return Promise.resolve([]);
  }
  // PUT /api/sms/config/:provider — mimic the route's return envelope.
  if (opts?.method === 'PUT' && url.startsWith('/api/sms/config/')) {
    return Promise.resolve({ success: true, config: { ...persistedMsg91 } });
  }
  return Promise.resolve([]);
}

function renderChannels() {
  return render(
    <MemoryRouter>
      <Channels />
    </MemoryRouter>,
  );
}

describe('<Channels /> — #586 save-lie regression', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifySuccess.mockReset();
    fetchApiMock.mockImplementation(defaultFetch);
  });

  it('on mount, fetches GET /api/sms/config so the page can render persisted rows', async () => {
    renderChannels();
    await waitFor(() => {
      const seen = fetchApiMock.mock.calls.some(([url, opts]) => url === '/api/sms/config' && (!opts || opts.method === 'GET' || opts.method === undefined));
      expect(seen).toBe(true);
    });
  });

  it('renders the persisted MSG91 senderId in the MSG91 card after load', async () => {
    renderChannels();
    // Wait for the GET to complete and the controlled input to receive its value.
    await waitFor(() => {
      expect(screen.getByDisplayValue('GLBSMS')).toBeInTheDocument();
    });
    // And the last4 of the masked apiKey is rendered (proves the row is bound to the card).
    // #651 (v3.7.x) replaced the inline credential input with a SecretFieldRow that
    // shows the readonly pill "**** A7B9". Match on the last4 substring.
    expect(screen.getByText(/A7B9/)).toBeInTheDocument();
    expect(screen.getByDisplayValue('DLT-12345')).toBeInTheDocument();
  });

  it('renders the Enable checkbox as CHECKED when the persisted row has isActive=true', async () => {
    renderChannels();
    await waitFor(() => expect(screen.getByDisplayValue('GLBSMS')).toBeInTheDocument());
    // The MSG91 card is the first ConfigCard rendered on the SMS tab.
    // Find its Enable checkbox by walking up from the senderId input.
    const senderInput = screen.getByDisplayValue('GLBSMS');
    const card = senderInput.closest('.card');
    expect(card).not.toBeNull();
    const checkbox = card.querySelector('input[type="checkbox"]');
    expect(checkbox).not.toBeNull();
    expect(checkbox.checked).toBe(true);
  });

  it('typing in Twilio card does NOT contaminate MSG91 state (per-provider isolation)', async () => {
    const user = userEvent.setup();
    renderChannels();
    await waitFor(() => expect(screen.getByDisplayValue('GLBSMS')).toBeInTheDocument());

    // The Twilio card has labels "Account SID" / "Auth Token" / "Phone Number".
    // The MSG91 card has "API Key" / "Sender ID (6 chars)" / "DLT Entity ID".
    // Find the Twilio Account SID input via its placeholder.
    const twilioSidInput = screen.getByPlaceholderText('Account SID');
    await user.type(twilioSidInput, 'AC12345');

    // MSG91's persisted senderId must STILL render unchanged (state isolation).
    expect(screen.getByDisplayValue('GLBSMS')).toBeInTheDocument();
    // #651 — masked credential rendered as pill, not as input; match last4 substring.
    expect(screen.getByText(/A7B9/)).toBeInTheDocument();
    // And the Twilio Account SID input now holds what we typed.
    expect(twilioSidInput).toHaveValue('AC12345');
  });

  it('Save on MSG91 card fires PUT /api/sms/config/msg91 then re-reads /api/sms/config', async () => {
    const user = userEvent.setup();
    renderChannels();
    await waitFor(() => expect(screen.getByDisplayValue('GLBSMS')).toBeInTheDocument());

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetch);

    // Click the MSG91 card's Save button. Both cards have a "Save" button —
    // pick the first (MSG91 renders before Twilio in the layout).
    const saveButtons = screen.getAllByRole('button', { name: /Save/i });
    expect(saveButtons.length).toBeGreaterThanOrEqual(2);
    await user.click(saveButtons[0]);

    await waitFor(() => {
      // PUT must hit the URL with the provider in the path (not a body-derived value).
      const putCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/sms/config/msg91' && opts?.method === 'PUT',
      );
      expect(putCall).toBeTruthy();
    });

    // Round-trip: after the PUT, the page re-fetches /api/sms/config so the UI
    // reflects the DB. Without this, on next mount/refresh the displayed
    // state could drift from the persisted state — the original #586 symptom.
    await waitFor(() => {
      const reReadCalls = fetchApiMock.mock.calls.filter(
        ([url, opts]) => url === '/api/sms/config' && (!opts || opts.method === 'GET' || opts.method === undefined),
      );
      expect(reReadCalls.length).toBeGreaterThanOrEqual(1);
    });

    // Success toast fires.
    await waitFor(() => expect(notifySuccess).toHaveBeenCalled());
  });

  it('Save body does NOT echo masked-secret sentinels back as new credentials', async () => {
    const user = userEvent.setup();
    renderChannels();
    await waitFor(() => expect(screen.getByDisplayValue('GLBSMS')).toBeInTheDocument());

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetch);

    const saveButtons = screen.getAllByRole('button', { name: /Save/i });
    await user.click(saveButtons[0]);

    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/sms/config/msg91' && opts?.method === 'PUT',
      );
      expect(putCall).toBeTruthy();
      const body = JSON.parse(putCall[1].body);
      // The GET returned apiKey: "TEST-A****" (masked sentinel from the route).
      // If the user didn't retype it, the save MUST NOT echo it back as the
      // new value — otherwise a save-without-edit would overwrite the real
      // credential in the DB with the masked stub. The route's `!== undefined`
      // guard means dropping the field leaves the column untouched.
      expect(body.apiKey).toBeUndefined();
      // Non-masked fields pass through normally.
      expect(body.senderId).toBe('GLBSMS');
      expect(body.dltEntityId).toBe('DLT-12345');
      expect(body.isActive).toBe(true);
      expect(body.provider).toBe('msg91');
    });
  });

  it('switching to WhatsApp tab fetches GET /api/whatsapp/config (per-tab load)', async () => {
    const user = userEvent.setup();
    renderChannels();
    await waitFor(() => expect(screen.getByDisplayValue('GLBSMS')).toBeInTheDocument());

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetch);

    const whatsappTab = screen.getByRole('button', { name: /WhatsApp/i });
    await user.click(whatsappTab);

    await waitFor(() => {
      const seen = fetchApiMock.mock.calls.some(
        ([url, opts]) => url === '/api/whatsapp/config' && (!opts || opts.method === 'GET' || opts.method === undefined),
      );
      expect(seen).toBe(true);
    });
  });

  it('switching to Telephony tab fetches GET /api/telephony/config', async () => {
    const user = userEvent.setup();
    renderChannels();
    await waitFor(() => expect(screen.getByDisplayValue('GLBSMS')).toBeInTheDocument());

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetch);

    const telephonyTab = screen.getByRole('button', { name: /Telephony/i });
    await user.click(telephonyTab);

    await waitFor(() => {
      const seen = fetchApiMock.mock.calls.some(
        ([url, opts]) => url === '/api/telephony/config' && (!opts || opts.method === 'GET' || opts.method === undefined),
      );
      expect(seen).toBe(true);
    });
  });
});
