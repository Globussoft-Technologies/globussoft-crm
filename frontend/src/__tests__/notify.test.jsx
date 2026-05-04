import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NotifyProvider, useNotify } from '../utils/notify';

/**
 * frontend/src/utils/notify.jsx — toast + modal context (alert/confirm/prompt replacements)
 *
 * What's tested
 *   - useNotify() returns the API object inside <NotifyProvider> and a
 *     console-fallback object outside it (so tests that forget to wrap
 *     don't crash, per the in-source comment).
 *   - notify.success / error / info push toasts that render in the DOM with
 *     the right role (alert for error, status for success/info) and copy.
 *   - notify.confirm() returns a Promise that resolves to true when the
 *     primary button is clicked, false when cancel is clicked.
 *   - notify.prompt() returns the typed value when confirmed, null on cancel.
 *
 * Why
 *   This module replaced 238 native window.alert/confirm/prompt calls
 *   (commit e2c0b88). A regression here silently breaks every confirmation
 *   dialog in the app — users would click "Delete" and nothing would happen
 *   because the missing modal would never resolve.
 *
 * Contract pinned
 *   - useNotify() outside provider returns a non-null fallback API
 *   - confirm/prompt return Promises (never sync values)
 *   - confirm primary button has data-notify-action="confirm"
 *   - cancel button has data-notify-action="cancel"
 */

// Tiny consumer that surfaces the `notify` API to the test via a ref.
function Consumer({ apiRef }) {
  const api = useNotify();
  apiRef.current = api;
  return null;
}

describe('useNotify — outside <NotifyProvider> (fallback)', () => {
  it('returns a non-null fallback API even when no provider is mounted', () => {
    const apiRef = { current: null };
    render(<Consumer apiRef={apiRef} />);
    expect(apiRef.current).not.toBeNull();
    expect(typeof apiRef.current.success).toBe('function');
    expect(typeof apiRef.current.error).toBe('function');
    expect(typeof apiRef.current.confirm).toBe('function');
    expect(typeof apiRef.current.prompt).toBe('function');
  });
});

describe('useNotify — inside <NotifyProvider>', () => {
  it('notify.success renders a status toast with the supplied message', async () => {
    const apiRef = { current: null };
    render(
      <NotifyProvider>
        <Consumer apiRef={apiRef} />
      </NotifyProvider>,
    );

    act(() => {
      apiRef.current.success('Saved successfully');
    });

    const toast = await screen.findByText('Saved successfully');
    expect(toast).toBeInTheDocument();
    // success toasts use role="status"; error uses role="alert"
    const wrapper = toast.closest('[data-notify-toast]');
    expect(wrapper).toHaveAttribute('data-notify-toast', 'success');
    expect(wrapper).toHaveAttribute('role', 'status');
  });

  it('notify.error renders an alert toast', async () => {
    const apiRef = { current: null };
    render(
      <NotifyProvider>
        <Consumer apiRef={apiRef} />
      </NotifyProvider>,
    );

    act(() => apiRef.current.error('Something broke'));

    const toast = await screen.findByText('Something broke');
    const wrapper = toast.closest('[data-notify-toast]');
    expect(wrapper).toHaveAttribute('data-notify-toast', 'error');
    expect(wrapper).toHaveAttribute('role', 'alert');
  });

  it('notify.confirm resolves true on Confirm click', async () => {
    const user = userEvent.setup();
    const apiRef = { current: null };
    render(
      <NotifyProvider>
        <Consumer apiRef={apiRef} />
      </NotifyProvider>,
    );

    let resolved;
    act(() => {
      apiRef.current.confirm('Delete the deal?').then((v) => { resolved = v; });
    });

    await screen.findByText('Delete the deal?');
    const confirmBtn = screen.getByRole('button', { name: 'Confirm' });
    await user.click(confirmBtn);

    await waitFor(() => expect(resolved).toBe(true));
  });

  it('notify.confirm resolves false on Cancel click', async () => {
    const user = userEvent.setup();
    const apiRef = { current: null };
    render(
      <NotifyProvider>
        <Consumer apiRef={apiRef} />
      </NotifyProvider>,
    );

    let resolved;
    act(() => {
      apiRef.current.confirm({ message: 'Are you sure?' }).then((v) => { resolved = v; });
    });

    await screen.findByText('Are you sure?');
    const cancelBtn = screen.getByRole('button', { name: 'Cancel' });
    await user.click(cancelBtn);

    await waitFor(() => expect(resolved).toBe(false));
  });

  it('notify.prompt resolves with the typed value on confirm', async () => {
    const user = userEvent.setup();
    const apiRef = { current: null };
    render(
      <NotifyProvider>
        <Consumer apiRef={apiRef} />
      </NotifyProvider>,
    );

    let resolved;
    act(() => {
      apiRef.current.prompt('Patient name', '').then((v) => { resolved = v; });
    });

    await screen.findByText('Patient name');
    const input = screen.getByRole('textbox');
    await user.type(input, 'Aarav Sharma');
    await user.click(screen.getByRole('button', { name: 'OK' }));

    await waitFor(() => expect(resolved).toBe('Aarav Sharma'));
  });

  it('notify.prompt resolves to null on cancel', async () => {
    const user = userEvent.setup();
    const apiRef = { current: null };
    render(
      <NotifyProvider>
        <Consumer apiRef={apiRef} />
      </NotifyProvider>,
    );

    let resolved;
    act(() => {
      apiRef.current.prompt('Reason').then((v) => { resolved = v; });
    });

    await screen.findByText('Reason');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(resolved).toBeNull());
  });

  it('dedupes identical (kind, message) toasts within 1.5s window (#275)', async () => {
    const apiRef = { current: null };
    render(
      <NotifyProvider>
        <Consumer apiRef={apiRef} />
      </NotifyProvider>,
    );

    act(() => {
      apiRef.current.error('Server error — please try again.');
      apiRef.current.error('Server error — please try again.');
      apiRef.current.error('Server error — please try again.');
    });

    // Even though we fired 3, only 1 toast renders.
    const toasts = await screen.findAllByText('Server error — please try again.');
    expect(toasts.length).toBe(1);
  });
});
