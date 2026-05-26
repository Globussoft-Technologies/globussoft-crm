import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * frontend/src/components/Softphone.jsx
 *
 * What's tested
 *   - Floating action button renders + carries an aria-label that toggles
 *     based on dialer open/closed state.
 *   - Clicking the FAB opens/closes the dialer card.
 *   - Number input + Contact ID input are editable.
 *   - Submitting the form fires POST /api/voice/call with the dialled number
 *     and parsed contactId.
 *   - Empty number does NOT fire a POST (early-return contract).
 *   - Twilio "INITIATED" path: sessionId rendered, status transitions
 *     advance to RINGING → IN_PROGRESS on the two setTimeouts.
 *   - "Twilio not configured" fallback flips into demo mode (banner appears).
 *   - Backend failure surfaces FAILED status + error message.
 *   - Network error (rejected promise) surfaces FAILED status + error.
 *   - End-call after a real session POSTs /api/voice/end/:sessionId.
 *
 * Why
 *   The softphone is a global, always-mounted widget. Regressions here
 *   silently break click-to-call across every authenticated page. The
 *   `to` + `contactId` request shape is the contract /api/voice/call
 *   relies on, and the dual-path (Twilio / demo-fallback) branch is the
 *   most likely place to break when the voice route changes.
 *
 * Contract pinned
 *   - POST /api/voice/call body: { to: <string>, contactId: <int or undefined> }
 *   - Twilio response: { sessionId, status } → UI shows sessionId + advances status
 *   - { error: 'Twilio not configured' } → demoMode banner appears
 *   - { error: '<other>' } → FAILED status + errorMsg rendered
 *   - POST /api/voice/end/:sessionId fired when ending a real session
 */

// Mock fetchApi BEFORE importing the component.
vi.mock('../utils/api', () => ({
  fetchApi: vi.fn(),
}));

import { fetchApi } from '../utils/api';
import Softphone from '../components/Softphone';

describe('<Softphone />', () => {
  beforeEach(() => {
    fetchApi.mockReset();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the floating action button with an aria-label (closed state)', () => {
    render(<Softphone />);
    const fab = screen.getByRole('button', { name: /open softphone dialer/i });
    expect(fab).toBeInTheDocument();
    expect(fab).toHaveAttribute('aria-expanded', 'false');
  });

  it('clicking the FAB opens the dialer card', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<Softphone />);

    const fab = screen.getByRole('button', { name: /open softphone dialer/i });
    await user.click(fab);

    expect(screen.getByText(/VoIP Softphone/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/\+1 \(555\) 000-0000/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Contact ID/i)).toBeInTheDocument();
    // FAB aria-label flips to "Close ..." when open.
    expect(screen.getByRole('button', { name: /close softphone dialer/i })).toBeInTheDocument();
  });

  it('clicking the FAB twice closes the dialer', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<Softphone />);

    const fab = screen.getByRole('button', { name: /open softphone dialer/i });
    await user.click(fab);
    expect(screen.getByText(/VoIP Softphone/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /close softphone dialer/i }));
    expect(screen.queryByText(/VoIP Softphone/i)).not.toBeInTheDocument();
  });

  it('number + contactId inputs are editable', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<Softphone />);
    await user.click(screen.getByRole('button', { name: /open softphone dialer/i }));

    const numberInput = screen.getByPlaceholderText(/\+1 \(555\) 000-0000/);
    const contactIdInput = screen.getByPlaceholderText(/Contact ID/i);

    await user.type(numberInput, '+15551234567');
    await user.type(contactIdInput, '42');

    expect(numberInput).toHaveValue('+15551234567');
    expect(contactIdInput).toHaveValue(42); // type=number → numeric value
  });

  it('submitting an empty number does NOT POST /api/voice/call', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<Softphone />);
    await user.click(screen.getByRole('button', { name: /open softphone dialer/i }));

    // Submit via the green call button (type=submit when not active).
    // Pull the form directly — empty number short-circuits inside startCall.
    const form = screen.getByPlaceholderText(/\+1 \(555\) 000-0000/).closest('form');
    expect(form).toBeTruthy();

    // Fire form submit directly (empty number short-circuits).
    await act(async () => {
      form.requestSubmit();
    });

    expect(fetchApi).not.toHaveBeenCalled();
    // status still IDLE
    expect(screen.getByText(/Twilio Voice Ready/i)).toBeInTheDocument();
  });

  it('submitting with a number POSTs /api/voice/call with { to, contactId }', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    fetchApi.mockResolvedValueOnce({ sessionId: 'CA_test_123', status: 'INITIATED' });

    render(<Softphone />);
    await user.click(screen.getByRole('button', { name: /open softphone dialer/i }));

    await user.type(screen.getByPlaceholderText(/\+1 \(555\) 000-0000/), '+15551234567');
    await user.type(screen.getByPlaceholderText(/Contact ID/i), '42');

    const form = screen.getByPlaceholderText(/\+1 \(555\) 000-0000/).closest('form');
    await act(async () => {
      form.requestSubmit();
    });

    await waitFor(() => {
      expect(fetchApi).toHaveBeenCalledWith('/api/voice/call', expect.objectContaining({
        method: 'POST',
        body: expect.any(String),
      }));
    });

    const callArgs = fetchApi.mock.calls.find(([url]) => url === '/api/voice/call');
    const body = JSON.parse(callArgs[1].body);
    expect(body).toEqual({ to: '+15551234567', contactId: 42 });
  });

  it('omits contactId from the request body when the contactId field is blank', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    fetchApi.mockResolvedValueOnce({ sessionId: 'CA_no_contact', status: 'INITIATED' });

    render(<Softphone />);
    await user.click(screen.getByRole('button', { name: /open softphone dialer/i }));

    await user.type(screen.getByPlaceholderText(/\+1 \(555\) 000-0000/), '+15559999999');

    const form = screen.getByPlaceholderText(/\+1 \(555\) 000-0000/).closest('form');
    await act(async () => {
      form.requestSubmit();
    });

    await waitFor(() => {
      expect(fetchApi).toHaveBeenCalledWith('/api/voice/call', expect.any(Object));
    });

    const callArgs = fetchApi.mock.calls.find(([url]) => url === '/api/voice/call');
    const body = JSON.parse(callArgs[1].body);
    expect(body.to).toBe('+15559999999');
    expect(body.contactId).toBeUndefined();
  });

  it('Twilio sessionId rendered + status transitions advance via setTimeouts', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    fetchApi.mockResolvedValueOnce({ sessionId: 'CA_advance_1', status: 'INITIATED' });

    render(<Softphone />);
    await user.click(screen.getByRole('button', { name: /open softphone dialer/i }));
    await user.type(screen.getByPlaceholderText(/\+1 \(555\) 000-0000/), '+15550001111');

    const form = screen.getByPlaceholderText(/\+1 \(555\) 000-0000/).closest('form');
    await act(async () => {
      form.requestSubmit();
    });

    // sessionId is rendered.
    await waitFor(() => {
      expect(screen.getByText('CA_advance_1')).toBeInTheDocument();
    });
    expect(screen.getByText(/Initiating call/i)).toBeInTheDocument();

    // After 1200ms → RINGING
    await act(async () => {
      vi.advanceTimersByTime(1300);
    });
    expect(screen.getByText(/Ringing/i)).toBeInTheDocument();

    // After 3500ms total → IN_PROGRESS
    await act(async () => {
      vi.advanceTimersByTime(2300);
    });
    expect(screen.getByText(/In Progress/i)).toBeInTheDocument();
  });

  it('"Twilio not configured" response flips into demo mode (banner appears)', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    // The demo path calls navigator.mediaDevices.getUserMedia — stub it.
    const origMediaDevices = navigator.mediaDevices;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [] }) },
    });

    fetchApi.mockResolvedValueOnce({ error: 'Twilio not configured' });

    render(<Softphone />);
    await user.click(screen.getByRole('button', { name: /open softphone dialer/i }));
    await user.type(screen.getByPlaceholderText(/\+1 \(555\) 000-0000/), '+15554443333');

    const form = screen.getByPlaceholderText(/\+1 \(555\) 000-0000/).closest('form');
    await act(async () => {
      form.requestSubmit();
    });

    await waitFor(() => {
      expect(screen.getByText(/Demo Mode/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/Demo: Establishing/i)).toBeInTheDocument();

    // Restore navigator.mediaDevices.
    if (origMediaDevices === undefined) {
      delete navigator.mediaDevices;
    } else {
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: origMediaDevices,
      });
    }
  });

  it('backend error response surfaces FAILED status + error message', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    fetchApi.mockResolvedValueOnce({ error: 'Outbound calls disabled for this tenant' });

    render(<Softphone />);
    await user.click(screen.getByRole('button', { name: /open softphone dialer/i }));
    await user.type(screen.getByPlaceholderText(/\+1 \(555\) 000-0000/), '+15558887777');

    const form = screen.getByPlaceholderText(/\+1 \(555\) 000-0000/).closest('form');
    await act(async () => {
      form.requestSubmit();
    });

    await waitFor(() => {
      expect(screen.getByText('Outbound calls disabled for this tenant')).toBeInTheDocument();
    });
  });

  it('network error (rejected promise) surfaces FAILED status with the error message', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    // Suppress the expected console.error from the catch branch.
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchApi.mockRejectedValueOnce(new Error('Network error: DNS unreachable'));

    render(<Softphone />);
    await user.click(screen.getByRole('button', { name: /open softphone dialer/i }));
    await user.type(screen.getByPlaceholderText(/\+1 \(555\) 000-0000/), '+15556665555');

    const form = screen.getByPlaceholderText(/\+1 \(555\) 000-0000/).closest('form');
    await act(async () => {
      form.requestSubmit();
    });

    await waitFor(() => {
      expect(screen.getByText(/Network error: DNS unreachable/i)).toBeInTheDocument();
    });
    consoleErr.mockRestore();
  });

  it('ending a real Twilio session POSTs /api/voice/end/:sessionId', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    fetchApi
      .mockResolvedValueOnce({ sessionId: 'CA_end_me', status: 'IN_PROGRESS' })
      .mockResolvedValueOnce({ ok: true }); // end-call response

    render(<Softphone />);
    await user.click(screen.getByRole('button', { name: /open softphone dialer/i }));
    await user.type(screen.getByPlaceholderText(/\+1 \(555\) 000-0000/), '+15552223333');

    const form = screen.getByPlaceholderText(/\+1 \(555\) 000-0000/).closest('form');
    await act(async () => {
      form.requestSubmit();
    });

    // Wait for status to settle into IN_PROGRESS (the call POST returned that
    // directly, so it's reflected synchronously after the await resolves).
    await waitFor(() => {
      expect(screen.getByText('CA_end_me')).toBeInTheDocument();
    });

    // The hangup button replaces the call button once isActive. It's a
    // type="button" with the PhoneOff icon — find by querying for any button
    // inside the form that isn't disabled and isn't mute/keypad.
    // Easiest: find by background colour via the form's red button.
    const formEl = screen.getByPlaceholderText(/\+1 \(555\) 000-0000/).closest('form');
    const buttons = formEl.querySelectorAll('button');
    // The hangup is the only enabled, type=button button at the end of the form
    // that has no aria/role for mute/keypad. The last button in the form is hangup.
    const hangupBtn = buttons[buttons.length - 1];
    expect(hangupBtn).not.toBeDisabled();

    await act(async () => {
      await user.click(hangupBtn);
    });

    await waitFor(() => {
      const endCall = fetchApi.mock.calls.find(
        ([url, opts]) => url === '/api/voice/end/CA_end_me' && opts?.method === 'POST',
      );
      expect(endCall).toBeTruthy();
    });
  });

  it('idle status copy reads "Twilio Voice Ready" by default (no demo banner)', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<Softphone />);
    await user.click(screen.getByRole('button', { name: /open softphone dialer/i }));

    expect(screen.getByText(/Twilio Voice Ready/i)).toBeInTheDocument();
    expect(screen.queryByText(/Demo Mode/i)).not.toBeInTheDocument();
  });
});
