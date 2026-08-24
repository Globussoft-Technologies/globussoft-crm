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

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

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

function renderDialog(props = {}) {
  return render(
    <CallifiedCallDialog
      customer={{ name: 'Asha Menon', phone: '9876543210', subtitle: 'Body Polishing' }}
      endpoints={ENDPOINTS}
      onClose={props.onClose || vi.fn()}
      onCalled={props.onCalled}
      onViewHistory={props.onViewHistory}
    />,
  );
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyError.mockReset();
  notifySuccess.mockReset();
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

  test('both modes stay disabled until a campaign is picked', async () => {
    installFetch();
    renderDialog();

    const ai = await screen.findByTestId('callified-call-mode-ai');
    expect(ai).toBeDisabled();
    expect(screen.getByTestId('callified-call-mode-manual')).toBeDisabled();

    fireEvent.change(screen.getByTestId('callified-call-dialog-campaign'), {
      target: { value: '42' },
    });
    await waitFor(() => expect(ai).toBeEnabled());
  });

  test('preselects the campaign when there is only one to choose', async () => {
    installFetch({ campaigns: { campaigns: [{ id: 42, name: 'Only', status: 'active' }] } });
    renderDialog();

    await waitFor(() =>
      expect(screen.getByTestId('callified-call-dialog-campaign')).toHaveValue('42'),
    );
    expect(screen.getByTestId('callified-call-mode-ai')).toBeEnabled();
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

  test('offers call history once a contact is known', async () => {
    installFetch({ context: { ...CONTEXT_OK, contactId: 11 } });
    const onViewHistory = vi.fn();
    renderDialog({ onViewHistory });

    fireEvent.click(await screen.findByTestId('callified-call-dialog-history'));
    expect(onViewHistory).toHaveBeenCalledWith(11);
  });
});
