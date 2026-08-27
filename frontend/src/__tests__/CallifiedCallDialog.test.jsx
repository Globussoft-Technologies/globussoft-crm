/**
 * CallifiedCallDialog.test.jsx — the "Call Customer" chooser.
 *
 * What matters about this component:
 *   1. Clicking a Call action must NOT dial. The dialog is the deliberate
 *      step between the click and a real phone ringing, so both modes are
 *      offered side by side and nothing fires on mount.
 *   2. A customer with no valid phone gets an explanation, not a dead button.
 *   3. Neither mode is clickable until a campaign is chosen — the campaign
 *      carries the voice/script settings both modes need.
 *   4. AI and Manual hit DIFFERENT endpoints. Crossing them would silently
 *      swap who talks to the customer.
 *   5. A double click cannot place two calls. React state has not re-rendered
 *      yet on the second click, so the component holds a synchronous ref
 *      latch; that latch is what this pins.
 *   6. A successful manual call hands off to the live-call panel.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Stable notify reference — a fresh object per render would flap the
// useCallback identity the dialog's placeCall closes over.
const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyObj = { error: notifyError, success: notifySuccess, info: vi.fn(), confirm: vi.fn() };
vi.mock('../utils/notify', () => ({ useNotify: () => notifyObj }));

// The live-call panel opens a microphone and a WebSocket; neither exists in
// jsdom, and neither is what this file is testing.
vi.mock('../components/CallifiedManualCallPanel', () => ({
  default: ({ call }) => <div data-testid="manual-panel-stub">bridged:{call.callSid}</div>,
}));

import CallifiedCallDialog from '../components/CallifiedCallDialog';

const ENDPOINTS = {
  context: '/api/wellness/callified/visits/9/context',
  campaigns: '/api/wellness/callified/campaigns',
  aiCall: '/api/wellness/callified/visits/9/ai-call',
  manualCall: '/api/wellness/callified/visits/9/manual-call',
};

const CONTEXT_OK = {
  visitId: 9,
  patientId: 3,
  patientName: 'Asha Menon',
  contactId: null,
  phone: '9876543210',
  normalizedPhone: '+919876543210',
  phoneValid: true,
  recentCallAt: null,
};

const CAMPAIGNS_TWO = {
  campaigns: [
    { id: 42, name: 'Reminder Campaign', status: 'active' },
    { id: 43, name: 'Winback Campaign', status: 'active' },
  ],
};

function installFetch({ context = CONTEXT_OK, campaigns = CAMPAIGNS_TWO, onPost } = {}) {
  fetchApiMock.mockImplementation((url, opts = {}) => {
    if (url === ENDPOINTS.context) return Promise.resolve(context);
    if (url === ENDPOINTS.campaigns) return Promise.resolve(campaigns);
    if (opts.method === 'POST') return onPost ? onPost(url, opts) : Promise.resolve({});
    return Promise.resolve({});
  });
}

// The footer links to the Call History page, so the dialog needs router
// context even though it renders no routes of its own.
function renderDialog(props = {}) {
  return render(
    <MemoryRouter>
      <CallifiedCallDialog
        customer={{ name: 'Asha Menon', phone: '9876543210', subtitle: 'Body Polishing' }}
        endpoints={ENDPOINTS}
        onClose={props.onClose || vi.fn()}
        onCalled={props.onCalled}
      />
    </MemoryRouter>,
  );
}

// jsdom has no media devices. A manual call now opens the microphone BEFORE
// placing the call, so every manual-mode test needs one.
let getUserMediaMock;
let micTrackStop;
beforeEach(() => {
  fetchApiMock.mockReset();
  notifyError.mockReset();
  notifySuccess.mockReset();
  micTrackStop = vi.fn();
  getUserMediaMock = vi.fn(() => Promise.resolve({ getTracks: () => [{ stop: micTrackStop }] }));
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: getUserMediaMock } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CallifiedCallDialog', () => {
  test('offers both modes and dials nothing on open', async () => {
    installFetch();
    renderDialog();

    expect(await screen.findByTestId('callified-call-mode-ai')).toBeInTheDocument();
    expect(screen.getByTestId('callified-call-mode-manual')).toBeInTheDocument();
    expect(screen.getByText('Call Customer')).toBeInTheDocument();

    const posts = fetchApiMock.mock.calls.filter(([, opts]) => opts?.method === 'POST');
    expect(posts).toHaveLength(0);
  });

  test('explains a customer with no dialable number instead of failing later', async () => {
    installFetch({ context: { ...CONTEXT_OK, phoneValid: false, normalizedPhone: null } });
    renderDialog();

    expect(await screen.findByTestId('callified-call-dialog-no-phone')).toBeInTheDocument();
    expect(screen.queryByTestId('callified-call-mode-ai')).not.toBeInTheDocument();
  });

  test('opens on the first active campaign so the dialog is ready to call', async () => {
    // Contract changed: the dialog used to open with nothing selected and both
    // modes disabled. A default is now chosen, and the notice below the field
    // is what stops that default from being silent.
    installFetch();
    renderDialog();

    await waitFor(() =>
      expect(screen.getByTestId('callified-call-dialog-campaign')).toHaveValue('42'),
    );
    expect(screen.getByTestId('callified-call-mode-ai')).toBeEnabled();
    expect(screen.getByTestId('callified-call-mode-manual')).toBeEnabled();
  });

  test('says out loud that the campaign was picked for you, and names it', async () => {
    // The campaign carries the voice and the script, so a default nobody
    // noticed is how the wrong script reaches a customer.
    installFetch();
    renderDialog();

    const notice = await screen.findByTestId('callified-campaign-default-notice');
    expect(notice).toHaveTextContent(/we picked/i);
    expect(notice).toHaveTextContent('Reminder Campaign');
    expect(notice).toHaveTextContent(/voice and script/i);
  });

  test('drops the notice once the caller chooses for themselves', async () => {
    installFetch();
    renderDialog();
    await screen.findByTestId('callified-campaign-default-notice');

    fireEvent.change(screen.getByTestId('callified-call-dialog-campaign'), {
      target: { value: '43' },
    });

    await waitFor(() =>
      expect(screen.queryByTestId('callified-campaign-default-notice')).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId('callified-call-mode-ai')).toBeEnabled();
  });

  test('both modes go back to disabled if the campaign is cleared', async () => {
    installFetch();
    renderDialog();
    await waitFor(() =>
      expect(screen.getByTestId('callified-call-dialog-campaign')).toHaveValue('42'),
    );

    fireEvent.change(screen.getByTestId('callified-call-dialog-campaign'), {
      target: { value: '' },
    });

    await waitFor(() => expect(screen.getByTestId('callified-call-mode-ai')).toBeDisabled());
    expect(screen.getByText(/Pick a campaign to enable calling/i)).toBeInTheDocument();
  });

  test('preselects the campaign when there is only one to choose', async () => {
    installFetch({ campaigns: { campaigns: [{ id: 42, name: 'Only', status: 'active' }] } });
    renderDialog();

    await waitFor(() =>
      expect(screen.getByTestId('callified-call-dialog-campaign')).toHaveValue('42'),
    );
    expect(screen.getByTestId('callified-call-mode-ai')).toBeEnabled();
    // Nothing was decided on the caller's behalf — there was no choice to make.
    expect(screen.queryByTestId('callified-campaign-default-notice')).not.toBeInTheDocument();
  });

  test('AI Call posts to the ai-call endpoint with the chosen campaign', async () => {
    const onPost = vi.fn(() => Promise.resolve({ callifiedLeadId: 900, contactId: 11 }));
    installFetch({ onPost });
    const onCalled = vi.fn();
    renderDialog({ onCalled });

    fireEvent.change(await screen.findByTestId('callified-call-dialog-campaign'), {
      target: { value: '43' },
    });
    fireEvent.click(screen.getByTestId('callified-call-mode-ai'));

    await waitFor(() => expect(onPost).toHaveBeenCalledOnce());
    const [url, opts] = onPost.mock.calls[0];
    expect(url).toBe(ENDPOINTS.aiCall);
    expect(JSON.parse(opts.body)).toEqual({ campaignId: 43 });
    await waitFor(() => expect(onCalled).toHaveBeenCalledOnce());
    expect(notifySuccess).toHaveBeenCalled();
  });

  test('Manual Call posts to the manual-call endpoint and opens the live panel', async () => {
    const onPost = vi.fn(() =>
      Promise.resolve({
        callifiedLeadId: 900,
        contactId: 11,
        callSid: 'EXsid1',
        bridgeTicket: 'ticket-abc',
        bridgePath: '/ws/callified-agent',
      }),
    );
    installFetch({ onPost });
    renderDialog();

    fireEvent.change(await screen.findByTestId('callified-call-dialog-campaign'), {
      target: { value: '42' },
    });
    fireEvent.click(screen.getByTestId('callified-call-mode-manual'));

    await waitFor(() => expect(onPost).toHaveBeenCalledOnce());
    expect(onPost.mock.calls[0][0]).toBe(ENDPOINTS.manualCall);
    expect(await screen.findByTestId('manual-panel-stub')).toHaveTextContent('bridged:EXsid1');
  });

  test('a double click cannot place two calls', async () => {
    let resolvePost;
    const onPost = vi.fn(
      () =>
        new Promise((resolve) => {
          resolvePost = resolve;
        }),
    );
    installFetch({ onPost });
    renderDialog();

    fireEvent.change(await screen.findByTestId('callified-call-dialog-campaign'), {
      target: { value: '42' },
    });
    const ai = screen.getByTestId('callified-call-mode-ai');
    fireEvent.click(ai);
    fireEvent.click(ai);
    fireEvent.click(ai);

    expect(onPost).toHaveBeenCalledOnce();
    resolvePost({ callifiedLeadId: 900 });
    await waitFor(() => expect(screen.getByTestId('callified-call-dialog-result')).toBeInTheDocument());
  });

  test('a placed call cannot be re-placed from the same dialog', async () => {
    const onPost = vi.fn(() => Promise.resolve({ callifiedLeadId: 900 }));
    installFetch({ onPost });
    renderDialog();

    fireEvent.change(await screen.findByTestId('callified-call-dialog-campaign'), {
      target: { value: '42' },
    });
    fireEvent.click(screen.getByTestId('callified-call-mode-ai'));
    await waitFor(() => expect(screen.getByTestId('callified-call-dialog-result')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('callified-call-mode-manual'));
    expect(onPost).toHaveBeenCalledOnce();
  });

  test('a failed call surfaces the server message and stays retryable', async () => {
    const onPost = vi.fn(() => Promise.reject(new Error('Monthly AI calling spend cap reached.')));
    installFetch({ onPost });
    renderDialog();

    fireEvent.change(await screen.findByTestId('callified-call-dialog-campaign'), {
      target: { value: '42' },
    });
    fireEvent.click(screen.getByTestId('callified-call-mode-ai'));

    const result = await screen.findByTestId('callified-call-dialog-result');
    expect(result).toHaveTextContent('Monthly AI calling spend cap reached.');
    expect(notifyError).toHaveBeenCalledWith('Monthly AI calling spend cap reached.');
    // Failure is not a placed call — the operator can fix the cap and retry.
    await waitFor(() => expect(screen.getByTestId('callified-call-mode-ai')).toBeEnabled());
  });

  test('says so when the tenant has no campaigns rather than offering a dead button', async () => {
    installFetch({ campaigns: { campaigns: [] } });
    renderDialog();

    expect(await screen.findByText(/No Callified campaigns found/i)).toBeInTheDocument();
    expect(screen.queryByTestId('callified-call-mode-ai')).not.toBeInTheDocument();
  });

  // Call History is its own page now. The dialog no longer renders history
  // inline — it points at the page and closes itself on the way out, so the
  // modal is not left mounted over the page the user just navigated to.
  test('points at the Call History page instead of showing history inline', async () => {
    installFetch({ context: { ...CONTEXT_OK, contactId: 11 } });
    const onClose = vi.fn();
    renderDialog({ onClose });

    const link = await screen.findByTestId('callified-call-dialog-history-link');
    expect(link).toHaveAttribute('href', '/wellness/call-history');
    // The old in-dialog drawer shortcut must not creep back.
    expect(screen.queryByTestId('callified-call-dialog-history')).not.toBeInTheDocument();

    fireEvent.click(link);
    expect(onClose).toHaveBeenCalled();
  });
});

/**
 * Microphone pre-flight for manual calls.
 *
 * Callified dials the customer the instant the manual-call request succeeds,
 * and the ONLY way to hang that leg up again is a `{"type":"hangup"}` frame
 * over the agent WebSocket — which cannot exist if the microphone never
 * opened and the socket was therefore never created.
 *
 * Checking the microphone first is what stops a machine with no microphone
 * ringing a real customer and leaving them on a live line hearing silence.
 * The observed failure was "Could not open the microphone: Requested device
 * not found" AFTER the phone was already ringing.
 */
describe('CallifiedCallDialog — microphone pre-flight', () => {
  async function armDialog(onPost) {
    installFetch({ onPost });
    renderDialog();
    fireEvent.change(await screen.findByTestId('callified-call-dialog-campaign'), {
      target: { value: '42' },
    });
  }

  test('opens the microphone BEFORE placing the call', async () => {
    let micOpenedFirst = false;
    const onPost = vi.fn(() => {
      micOpenedFirst = getUserMediaMock.mock.calls.length > 0;
      return Promise.resolve({ callifiedLeadId: 900, callSid: 'EXsid1', bridgeTicket: 't', bridgePath: '/ws/callified-agent' });
    });
    await armDialog(onPost);

    fireEvent.click(screen.getByTestId('callified-call-mode-manual'));

    await waitFor(() => expect(onPost).toHaveBeenCalledOnce());
    expect(micOpenedFirst).toBe(true);
  });

  test('a missing microphone means the customer is NEVER called', async () => {
    const onPost = vi.fn(() => Promise.resolve({ callifiedLeadId: 900 }));
    getUserMediaMock.mockRejectedValue(
      Object.assign(new Error('Requested device not found'), { name: 'NotFoundError' }),
    );
    await armDialog(onPost);

    fireEvent.click(screen.getByTestId('callified-call-mode-manual'));

    // The load-bearing assertion: no request reached the manual-call endpoint,
    // so no phone rang.
    await waitFor(() =>
      expect(screen.getByTestId('callified-call-dialog-result')).toHaveTextContent(
        /No microphone found/i,
      ),
    );
    expect(onPost).not.toHaveBeenCalled();
  });

  test('a blocked microphone explains how to unblock it', async () => {
    getUserMediaMock.mockRejectedValue(
      Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }),
    );
    await armDialog(vi.fn());

    fireEvent.click(screen.getByTestId('callified-call-mode-manual'));

    await waitFor(() =>
      expect(screen.getByTestId('callified-call-dialog-result')).toHaveTextContent(
        /Allow the microphone for this site/i,
      ),
    );
  });

  test('a microphone held by another app says which apps to close', async () => {
    getUserMediaMock.mockRejectedValue(
      Object.assign(new Error('Device in use'), { name: 'NotReadableError' }),
    );
    await armDialog(vi.fn());

    fireEvent.click(screen.getByTestId('callified-call-mode-manual'));

    await waitFor(() =>
      expect(screen.getByTestId('callified-call-dialog-result')).toHaveTextContent(
        /being used by another app/i,
      ),
    );
  });

  test('a failed pre-flight leaves the call retryable', async () => {
    getUserMediaMock.mockRejectedValue(
      Object.assign(new Error('nope'), { name: 'NotFoundError' }),
    );
    await armDialog(vi.fn());

    fireEvent.click(screen.getByTestId('callified-call-mode-manual'));
    await waitFor(() => expect(screen.getByTestId('callified-call-dialog-result')).toBeInTheDocument());

    // Plugging a headset in and clicking again must work.
    await waitFor(() => expect(screen.getByTestId('callified-call-mode-manual')).toBeEnabled());
  });

  test('AI calls need no microphone at all', async () => {
    const onPost = vi.fn(() => Promise.resolve({ callifiedLeadId: 900 }));
    getUserMediaMock.mockRejectedValue(
      Object.assign(new Error('nope'), { name: 'NotFoundError' }),
    );
    await armDialog(onPost);

    fireEvent.click(screen.getByTestId('callified-call-mode-ai'));

    // Callified's own agent speaks — the staff member's mic is irrelevant.
    await waitFor(() => expect(onPost).toHaveBeenCalledOnce());
    expect(getUserMediaMock).not.toHaveBeenCalled();
  });
});

/**
 * The pre-flight PROBES the microphone — it must not hold it open.
 *
 * Handing the opened stream on to the live-call panel looked tidier and was a
 * real bug: React StrictMode double-mounts the panel, and the discarded first
 * bridge stops the tracks of whatever stream it holds. A shared stream
 * therefore left the bridge actually on screen with dead tracks — the agent
 * could hear the customer, but was never heard back. The bridge opens its own
 * stream instead (permission is already granted, so no second prompt).
 */
describe('CallifiedCallDialog — the mic probe releases its stream', () => {
  test('the probed stream is stopped, not passed on', async () => {
    const onPost = vi.fn(() =>
      Promise.resolve({ callifiedLeadId: 900, callSid: 'EXsid1', bridgeTicket: 't', bridgePath: '/ws/callified-agent' }),
    );
    installFetch({ onPost });
    renderDialog();
    fireEvent.change(await screen.findByTestId('callified-call-dialog-campaign'), {
      target: { value: '42' },
    });

    fireEvent.click(screen.getByTestId('callified-call-mode-manual'));
    await waitFor(() => expect(onPost).toHaveBeenCalledOnce());

    // Released immediately — a stream kept alive here is the one StrictMode
    // kills out from under the live bridge.
    await waitFor(() => expect(micTrackStop).toHaveBeenCalled());
  });
});
