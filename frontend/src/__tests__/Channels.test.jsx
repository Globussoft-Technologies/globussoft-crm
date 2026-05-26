/**
 * Channels.jsx — Settings → Channels save round-trip regression (#586)
 * + extended provider-card / credentials / send / RBAC / states pin.
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
 * Extended contract (this file)
 * ─────────────────────────────
 *   - SMS tab renders BOTH MSG91 and Twilio cards side-by-side. Switching
 *     provider focus does NOT collapse one card.
 *   - MSG91 Sender ID input enforces `maxLength=6` + `pattern="[A-Za-z0-9]{6}"`
 *     attributes per #716.
 *   - Save PUT body strips id/createdAt/updatedAt/tenantId/lastRotatedAt
 *     (per the handleSaveConfig destructure) and always carries
 *     {provider, isActive}.
 *   - WhatsApp tab renders Meta Cloud API card with secret rows for
 *     accessToken + webhookVerifyToken, plain rows for phoneNumberId +
 *     businessAccountId.
 *   - Telephony tab renders MyOperator + Knowlarity cards.
 *   - Push tab renders the VAPID config card (env-var-driven, no inputs).
 *   - SecretFieldRow renders "Not configured" when the GET returns a row
 *     without that field at all (configured:false branch).
 *   - SecretFieldRow renders "**** + last4" when the GET returns
 *     {configured:true, last4:'XYZ7'}.
 *   - SecretFieldRow renders Rotate button (when configured) vs Set button
 *     (when not configured).
 *   - GET /api/sms/config returning [] leaves both MSG91 and Twilio inputs
 *     empty without throwing (empty-state).
 *   - GET /api/sms/config throwing leaves the page rendered without
 *     unhandled-rejection noise (error-state).
 *   - The provider keys (msg91, twilio, meta_cloud, myoperator, knowlarity)
 *     are passed verbatim into the PUT URL path — no body-derived value.
 *
 * Why a frontend test, not a backend / API test
 * ─────────────────────────────────────────────
 * The backend round-trip is already covered by sms-api.spec.js (PUT then
 * GET asserts the value comes back). That spec was green throughout the
 * #586 incident — because the bug never reached the backend. The pin we
 * need is on the *page* doing the load-back, the inputs being controlled,
 * and the per-provider state isolation. Those are component-level invariants.
 *
 * RBAC note: ADMIN-only protection on these PUT endpoints is enforced
 * server-side via `verifyRole(['ADMIN'])` on routes/sms.js et al.; the
 * frontend page does NOT itself gate by role (it relies on the API to 403).
 * The "RBAC" case below pins that the page does not pre-gate (a regression
 * pre-gating client-side would silently lock out legitimate ADMINs whose
 * JWT decoded with a non-standard claim shape — better to let the server
 * be the authority). If product later decides to add a client-side gate,
 * that test should be inverted, NOT removed silently.
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

// 2026-05-23 standing rule: return ONE stable object reference for hook mocks
// used in useCallback / useMemo dependencies. Fresh objects per call cause
// infinite re-render loops because each render sees a new identity → triggers
// the callback → setState → re-render → new mock object → repeat.
const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyInfo = vi.fn();
const notifyConfirm = vi.fn(() => Promise.resolve(true));
const notifyPrompt = vi.fn(() => Promise.resolve(''));
const notifyObj = {
  error: notifyError,
  info: notifyInfo,
  success: notifySuccess,
  confirm: notifyConfirm,
  prompt: notifyPrompt,
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
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
  if (opts?.method === 'PUT' && url.startsWith('/api/whatsapp/config/')) {
    return Promise.resolve({ success: true, config: { provider: 'meta_cloud', isActive: true } });
  }
  if (opts?.method === 'PUT' && url.startsWith('/api/telephony/config/')) {
    return Promise.resolve({ success: true, config: { provider: 'myoperator', isActive: true } });
  }
  if (opts?.method === 'POST' && url === '/api/sms/send') {
    return Promise.resolve({ success: true, messageId: 'msg-1' });
  }
  if (opts?.method === 'POST' && url === '/api/whatsapp/send') {
    return Promise.resolve({ success: true });
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

// Convenience: wait for the SMS tab's persisted MSG91 row to render so
// subsequent assertions can safely query for it.
async function waitForSmsLoad() {
  await waitFor(() => expect(screen.getByDisplayValue('GLBSMS')).toBeInTheDocument());
}

describe('<Channels /> — #586 save-lie regression', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifySuccess.mockReset();
    notifyInfo.mockReset();
    notifyConfirm.mockReset();
    notifyConfirm.mockImplementation(() => Promise.resolve(true));
    notifyPrompt.mockReset();
    notifyPrompt.mockImplementation(() => Promise.resolve(''));
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

describe('<Channels /> — SMS provider cards (extended)', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifySuccess.mockReset();
    fetchApiMock.mockImplementation(defaultFetch);
  });

  // 1: SMS provider card layout — BOTH MSG91 and Twilio render side-by-side.
  // Pre-#586 the shared `configForm` state would also have caused visual
  // confusion when both cards existed; this pins the side-by-side layout.
  it('SMS tab renders BOTH MSG91 and Twilio cards', async () => {
    renderChannels();
    await waitForSmsLoad();
    // MSG91 card distinguishing input — DLT Entity ID is MSG91-specific.
    expect(screen.getByPlaceholderText('DLT Entity ID')).toBeInTheDocument();
    // Twilio card distinguishing input — Account SID is Twilio-specific.
    expect(screen.getByPlaceholderText('Account SID')).toBeInTheDocument();
    // And both card headings exist. MSG91 + Twilio.
    expect(screen.getByText('MSG91')).toBeInTheDocument();
    expect(screen.getByText('Twilio')).toBeInTheDocument();
  });

  // 2: MSG91 Sender ID input enforces #716 client-side validation attributes.
  // Pin the maxLength=6 and pattern attributes so a future refactor doesn't
  // silently drop the client-side bound and force operators to bounce off a
  // 400 from the server's senderId validator.
  it('MSG91 Sender ID input has maxLength=6 and pattern attributes (#716)', async () => {
    renderChannels();
    await waitForSmsLoad();
    const senderInput = screen.getByDisplayValue('GLBSMS');
    expect(senderInput).toHaveAttribute('maxLength', '6');
    expect(senderInput).toHaveAttribute('pattern', '[A-Za-z0-9]{6}');
    // Helper text rendered alongside.
    expect(screen.getByText(/Exactly 6 alphanumeric characters/)).toBeInTheDocument();
  });

  // 3: Save PUT body shape — handleSaveConfig strips id/createdAt/updatedAt/
  // tenantId/lastRotatedAt and always includes provider + isActive. Without
  // this strip, a save without retyping the secret would echo back masked
  // sentinels and trample the real credential — the same class as #586.
  it('Save PUT body strips id/tenantId/lastRotatedAt and includes provider + isActive', async () => {
    const user = userEvent.setup();
    renderChannels();
    await waitForSmsLoad();
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
      // Stripped — never echoed back.
      expect(body.id).toBeUndefined();
      expect(body.tenantId).toBeUndefined();
      expect(body.createdAt).toBeUndefined();
      expect(body.updatedAt).toBeUndefined();
      expect(body.lastRotatedAt).toBeUndefined();
      // Always included.
      expect(body.provider).toBe('msg91');
      expect(typeof body.isActive).toBe('boolean');
    });
  });

  // 4: Save PUT URL uses the provider key VERBATIM (literal 'msg91') as the
  // last path segment, NOT a body-derived or label-derived value. A regression
  // that derived this from `provider.label` would push to /api/sms/config/MSG91
  // (capitalised) and 404 the Prisma upsert lookup.
  it('Save PUT URL uses the literal provider key as the last path segment', async () => {
    const user = userEvent.setup();
    renderChannels();
    await waitForSmsLoad();
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetch);

    const saveButtons = screen.getAllByRole('button', { name: /Save/i });
    // Click Twilio's Save (second card → second Save button).
    await user.click(saveButtons[1]);

    await waitFor(() => {
      const twilioPut = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/sms/config/twilio' && opts?.method === 'PUT',
      );
      expect(twilioPut).toBeTruthy();
      const body = JSON.parse(twilioPut[1].body);
      // Provider in body matches URL segment.
      expect(body.provider).toBe('twilio');
    });
  });
});

describe('<Channels /> — WhatsApp / Telephony cards', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifySuccess.mockReset();
    fetchApiMock.mockImplementation(defaultFetch);
  });

  // 5: WhatsApp tab renders Meta Cloud API config with plain rows for
  // phoneNumberId + businessAccountId and secret rows for accessToken +
  // webhookVerifyToken. Pre-#651 the secret rows were inline editable
  // (plaintext landed in DOM); the rotate-via-modal flow is the post-#651
  // contract.
  it('WhatsApp tab renders Meta Cloud API card with mixed plain + secret fields', async () => {
    const user = userEvent.setup();
    renderChannels();
    await waitForSmsLoad();

    const whatsappTab = screen.getByRole('button', { name: /WhatsApp/i });
    await user.click(whatsappTab);

    await waitFor(() => {
      expect(screen.getByText('Meta Cloud API')).toBeInTheDocument();
    });
    // Plain inputs — phoneNumberId + businessAccountId render as <input>.
    expect(screen.getByPlaceholderText('Phone Number ID')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Business Account ID')).toBeInTheDocument();
    // Secret-field labels exist (rendered next to the <Lock> icon).
    expect(screen.getByText('Access Token')).toBeInTheDocument();
    expect(screen.getByText('Webhook Verify Token')).toBeInTheDocument();
  });

  // 6: Save on WhatsApp's Meta Cloud card fires PUT to the correct provider
  // path. The provider key here ("meta_cloud") has an underscore — pins that
  // the URL is built verbatim and not slugified into "meta-cloud".
  it('WhatsApp Save fires PUT /api/whatsapp/config/meta_cloud', async () => {
    const user = userEvent.setup();
    renderChannels();
    await waitForSmsLoad();

    const whatsappTab = screen.getByRole('button', { name: /WhatsApp/i });
    await user.click(whatsappTab);
    await waitFor(() => expect(screen.getByText('Meta Cloud API')).toBeInTheDocument());

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetch);

    const saveButton = screen.getByRole('button', { name: /Save/i });
    await user.click(saveButton);

    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/whatsapp/config/meta_cloud' && opts?.method === 'PUT',
      );
      expect(putCall).toBeTruthy();
      const body = JSON.parse(putCall[1].body);
      expect(body.provider).toBe('meta_cloud');
    });
  });

  // 7: Telephony tab renders BOTH MyOperator and Knowlarity cards. Pins the
  // dual-card layout same as SMS — a regression collapsing one would bury an
  // entire provider option.
  it('Telephony tab renders BOTH MyOperator and Knowlarity cards', async () => {
    const user = userEvent.setup();
    renderChannels();
    await waitForSmsLoad();

    const telephonyTab = screen.getByRole('button', { name: /Telephony/i });
    await user.click(telephonyTab);

    await waitFor(() => {
      expect(screen.getByText('MyOperator')).toBeInTheDocument();
    });
    expect(screen.getByText('Knowlarity')).toBeInTheDocument();
    // Virtual Number field is the shared plain field (both cards render one).
    const virtualNumberInputs = screen.getAllByPlaceholderText('Virtual Number');
    expect(virtualNumberInputs.length).toBe(2);
  });

  // 8: Telephony Save fires PUT to provider-specific path. Pins each card's
  // Save button maps to its own provider's PUT URL — a regression sharing
  // the handler reference across cards would push both clicks to the same
  // provider (the original #586 cross-card bleed pattern, in a different
  // tab).
  it('Telephony MyOperator + Knowlarity Saves target distinct provider URLs', async () => {
    const user = userEvent.setup();
    renderChannels();
    await waitForSmsLoad();

    const telephonyTab = screen.getByRole('button', { name: /Telephony/i });
    await user.click(telephonyTab);
    await waitFor(() => expect(screen.getByText('MyOperator')).toBeInTheDocument());

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetch);

    const saveButtons = screen.getAllByRole('button', { name: /Save/i });
    expect(saveButtons.length).toBeGreaterThanOrEqual(2);

    await user.click(saveButtons[0]); // MyOperator
    await waitFor(() => {
      const myopPut = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/telephony/config/myoperator' && opts?.method === 'PUT',
      );
      expect(myopPut).toBeTruthy();
    });

    await user.click(saveButtons[1]); // Knowlarity
    await waitFor(() => {
      const knowPut = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/telephony/config/knowlarity' && opts?.method === 'PUT',
      );
      expect(knowPut).toBeTruthy();
    });
  });
});

describe('<Channels /> — credential masking + rotation', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifySuccess.mockReset();
    fetchApiMock.mockImplementation(defaultFetch);
  });

  // 9: Mask sensitive fields — the persisted MSG91 apiKey arrives as the
  // {configured:true, last4:'A7B9'} shape; SecretFieldRow MUST render it as
  // a readonly pill, NEVER as an editable <input> (plaintext leak).
  it('persisted apiKey renders as readonly masked pill, NOT an editable input', async () => {
    renderChannels();
    await waitForSmsLoad();
    // The last4 string shows up as text content (inside a <code>), NOT as
    // the value of an <input>. Pin both branches:
    // - getByText finds the masked display
    expect(screen.getByText(/A7B9/)).toBeInTheDocument();
    // - NO input element holds 'A7B9' as its value (would mean plaintext leak)
    const allInputs = document.querySelectorAll('input');
    for (const inp of allInputs) {
      expect(inp.value).not.toMatch(/A7B9/);
    }
    // The MSG91 card should have a Rotate button alongside the masked pill.
    expect(screen.getByRole('button', { name: /Rotate/i })).toBeInTheDocument();
  });

  // 10: Empty-state — when MSG91 row is missing entirely, the API Key shows
  // "Not configured" + a "Set" button (NOT "Rotate"). Pins the
  // !configured branch in SecretFieldRow.
  it('empty MSG91 config renders "Not configured" + Set button (NOT Rotate)', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (!opts || opts.method === 'GET' || opts.method === undefined) {
        if (url === '/api/sms/config') return Promise.resolve([]); // empty
        if (url === '/api/whatsapp/config') return Promise.resolve([]);
        if (url === '/api/telephony/config') return Promise.resolve([]);
        if (url === '/api/sms/templates') return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });
    renderChannels();

    // Wait for the GET to complete — when empty, no senderId shows. Probe via
    // the placeholder which is always rendered.
    await waitFor(() => {
      expect(screen.getByPlaceholderText('DLT Entity ID')).toBeInTheDocument();
    });
    // Multiple secret fields will all read "Not configured" (MSG91 apiKey +
    // Twilio authToken). Use getAllByText.
    const notConfigured = screen.getAllByText(/Not configured/);
    expect(notConfigured.length).toBeGreaterThanOrEqual(2);
    // And Set buttons exist (one per uncovered secret field).
    const setButtons = screen.getAllByRole('button', { name: /Set/i });
    expect(setButtons.length).toBeGreaterThanOrEqual(2);
  });

  // 11: Rotate button opens RotateSecretModal with the field label in title.
  // Pins the modal's open-on-click contract and that the field name surfaces
  // to the operator so they know which credential they're rotating.
  it('Rotate button opens the RotateSecretModal with field label visible', async () => {
    const user = userEvent.setup();
    renderChannels();
    await waitForSmsLoad();
    const rotateBtn = screen.getByRole('button', { name: /Rotate/i });
    await user.click(rotateBtn);
    // Modal title: "Rotate API Key" (MSG91 apiKey field has label "API Key").
    await waitFor(() => {
      expect(screen.getByText(/Rotate API Key/)).toBeInTheDocument();
    });
    // Modal has the new-credential input (typed as password by default).
    const newKeyInput = screen.getByPlaceholderText(/New API Key/);
    expect(newKeyInput).toBeInTheDocument();
    expect(newKeyInput.type).toBe('password');
  });
});

describe('<Channels /> — empty / error / RBAC states', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifySuccess.mockReset();
    fetchApiMock.mockImplementation(defaultFetch);
  });

  // 12: GET /api/sms/config throwing leaves the page rendered without
  // unhandled-promise-rejection noise. loadConfigs() has a try/catch that
  // resets configsByProvider to {} on failure — proves the catch fires.
  it('GET /api/sms/config rejecting leaves the page rendered (graceful failure)', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/sms/config' && (!opts || opts.method === 'GET' || opts.method === undefined)) {
        return Promise.reject(new Error('500'));
      }
      // Templates endpoint also needs a graceful handler.
      if (url === '/api/sms/templates') return Promise.resolve([]);
      return Promise.resolve([]);
    });
    renderChannels();

    // The page still renders its tabs + ConfigCards (just with empty state).
    await waitFor(() => {
      expect(screen.getByText('Communication Channels')).toBeInTheDocument();
    });
    // MSG91 card still rendered (with empty inputs).
    await waitFor(() => {
      expect(screen.getByText('MSG91')).toBeInTheDocument();
    });
    // Sender ID input rendered + empty (no persisted value to bind).
    const senderInput = screen.getByPlaceholderText('Sender ID (6 chars)');
    expect(senderInput).toHaveValue('');
  });

  // 13: RBAC — the page does NOT pre-gate by role client-side. ADMIN
  // protection is enforced server-side via verifyRole(['ADMIN']) on the
  // routes. A page-level gate would be a regression because the JWT could
  // decode with a non-standard claim shape and lock out legitimate ADMINs.
  // Asserts every Save button is rendered + enabled regardless of any
  // client-side role state (which the page does not consult).
  it('does NOT pre-gate Save buttons by client-side role — server is authority', async () => {
    renderChannels();
    await waitForSmsLoad();
    const saveButtons = screen.getAllByRole('button', { name: /Save/i });
    expect(saveButtons.length).toBeGreaterThanOrEqual(2);
    for (const btn of saveButtons) {
      expect(btn).not.toBeDisabled();
    }
    // Tab buttons too — every tab clickable regardless of role.
    const tabsButtons = ['WhatsApp', 'Telephony', 'Push Notifications'].map(
      label => screen.getByRole('button', { name: new RegExp(label, 'i') })
    );
    for (const tb of tabsButtons) {
      expect(tb).not.toBeDisabled();
    }
  });
});

describe('<Channels /> — Push tab + tab navigation', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifySuccess.mockReset();
    fetchApiMock.mockImplementation(defaultFetch);
  });

  // 14: Push tab renders the VAPID env-var config card (no input fields —
  // VAPID keys are server-side env vars). Pins that switching to Push does
  // NOT try to GET a /api/push/config endpoint (which doesn't exist —
  // loadConfigs short-circuits for the push tab).
  it('Push tab renders VAPID env-var config card + does NOT GET /api/push/config', async () => {
    const user = userEvent.setup();
    renderChannels();
    await waitForSmsLoad();

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetch);

    const pushTab = screen.getByRole('button', { name: /Push Notifications/i });
    await user.click(pushTab);

    await waitFor(() => {
      expect(screen.getByText('VAPID Configuration')).toBeInTheDocument();
    });
    // Push tab should fetch templates but NOT a /api/push/config endpoint
    // (it doesn't exist — loadConfigs short-circuits and clears state).
    const noPushConfigGet = fetchApiMock.mock.calls.every(
      ([url, opts]) => !(url === '/api/push/config' && (!opts || opts.method === 'GET' || opts.method === undefined)),
    );
    expect(noPushConfigGet).toBe(true);
    // Templates GET DOES fire.
    const pushTemplatesGet = fetchApiMock.mock.calls.some(
      ([url, opts]) => url === '/api/push/templates' && (!opts || opts.method === 'GET' || opts.method === undefined),
    );
    expect(pushTemplatesGet).toBe(true);
  });

  // 15: Tab navigation — clicking back to SMS tab re-fetches /api/sms/config
  // (the useEffect depends on activeTab). Pins that flipping away and back
  // reloads, so any out-of-band write between visits surfaces on the second
  // load without a hard refresh.
  it('flipping SMS → WhatsApp → SMS re-fetches /api/sms/config on the return', async () => {
    const user = userEvent.setup();
    renderChannels();
    await waitForSmsLoad();

    const whatsappTab = screen.getByRole('button', { name: /WhatsApp/i });
    await user.click(whatsappTab);
    await waitFor(() => {
      const seen = fetchApiMock.mock.calls.some(
        ([url, opts]) => url === '/api/whatsapp/config' && (!opts || opts.method === 'GET' || opts.method === undefined),
      );
      expect(seen).toBe(true);
    });

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetch);

    const smsTab = screen.getByRole('button', { name: /^SMS$/i });
    await user.click(smsTab);

    await waitFor(() => {
      const reReadSms = fetchApiMock.mock.calls.some(
        ([url, opts]) => url === '/api/sms/config' && (!opts || opts.method === 'GET' || opts.method === undefined),
      );
      expect(reReadSms).toBe(true);
    });
  });
});
