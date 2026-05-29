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

/**
 * Extended cases — toast TTL split (#540), manual dismiss, info variant,
 * multi-toast stacking, confirm custom labels, prompt default + empty + queue,
 * provider re-render preservation.
 *
 * The existing block above pins basic toast/success/error rendering and
 * confirm/prompt happy paths. These extensions cover the timing rule
 * (8000ms error / 4500ms non-error per inline #540 comment), the
 * close-button manual dismiss path, and the modal queue order (single
 * slot + queueRef overflow per openModal() at line 63-74).
 */

describe('useNotify — toast TTL (#540) and stacking', () => {
  it('error toast lives 8000ms; non-error toast lives 4500ms (fake-timer split)', async () => {
    vi.useFakeTimers();
    try {
      const apiRef = { current: null };
      render(
        <NotifyProvider>
          <Consumer apiRef={apiRef} />
        </NotifyProvider>,
      );

      act(() => {
        apiRef.current.error('Boom');
        apiRef.current.success('Yay');
      });

      // Both visible right after firing.
      expect(screen.getByText('Boom')).toBeInTheDocument();
      expect(screen.getByText('Yay')).toBeInTheDocument();

      // Advance past success TTL (4500ms) but not error TTL (8000ms).
      // 5000ms → success should have been pruned, error still there.
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(screen.queryByText('Yay')).not.toBeInTheDocument();
      expect(screen.getByText('Boom')).toBeInTheDocument();

      // Advance past the error TTL too (total 8500ms).
      act(() => {
        vi.advanceTimersByTime(3500);
      });
      expect(screen.queryByText('Boom')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('multiple distinct toasts stack and each renders in DOM', async () => {
    const apiRef = { current: null };
    render(
      <NotifyProvider>
        <Consumer apiRef={apiRef} />
      </NotifyProvider>,
    );

    act(() => {
      apiRef.current.success('First');
      apiRef.current.error('Second');
      apiRef.current.info('Third');
    });

    // Three distinct toasts are rendered — dedupe only kicks in for
    // identical (kind, message) pairs within 1.5s; these are all distinct.
    await screen.findByText('First');
    await screen.findByText('Second');
    await screen.findByText('Third');

    const all = document.querySelectorAll('[data-notify-toast]');
    expect(all.length).toBe(3);
  });

  it('manual dismiss via close button removes the toast immediately', async () => {
    const user = userEvent.setup();
    const apiRef = { current: null };
    render(
      <NotifyProvider>
        <Consumer apiRef={apiRef} />
      </NotifyProvider>,
    );

    act(() => apiRef.current.info('Dismiss me'));

    const toast = await screen.findByText('Dismiss me');
    expect(toast).toBeInTheDocument();

    // Each toast has an aria-labelled close button at line 219-220 of SUT.
    const closeBtn = screen.getByRole('button', { name: 'Dismiss notification' });
    await user.click(closeBtn);

    await waitFor(() => {
      expect(screen.queryByText('Dismiss me')).not.toBeInTheDocument();
    });
  });

  it('notify.info renders with role="status" and data-notify-toast="info"', async () => {
    const apiRef = { current: null };
    render(
      <NotifyProvider>
        <Consumer apiRef={apiRef} />
      </NotifyProvider>,
    );

    act(() => apiRef.current.info('Heads up'));

    const toast = await screen.findByText('Heads up');
    const wrapper = toast.closest('[data-notify-toast]');
    expect(wrapper).toHaveAttribute('data-notify-toast', 'info');
    expect(wrapper).toHaveAttribute('role', 'status');
  });
});

describe('useNotify — confirm() custom labels + options-object form', () => {
  it('confirm({ title, confirmText, cancelText }) renders custom labels', async () => {
    const user = userEvent.setup();
    const apiRef = { current: null };
    render(
      <NotifyProvider>
        <Consumer apiRef={apiRef} />
      </NotifyProvider>,
    );

    let resolved;
    act(() => {
      apiRef.current
        .confirm({
          title: 'Delete patient record?',
          message: 'This cannot be undone.',
          confirmText: 'Delete',
          cancelText: 'Keep',
          destructive: true,
        })
        .then((v) => {
          resolved = v;
        });
    });

    // Title + message + custom button copy all render.
    await screen.findByText('Delete patient record?');
    expect(screen.getByText('This cannot be undone.')).toBeInTheDocument();
    const deleteBtn = screen.getByRole('button', { name: 'Delete' });
    expect(screen.getByRole('button', { name: 'Keep' })).toBeInTheDocument();
    expect(deleteBtn).toHaveAttribute('data-notify-action', 'confirm');

    await user.click(deleteBtn);
    await waitFor(() => expect(resolved).toBe(true));
  });
});

describe('useNotify — prompt() default value + empty + queue', () => {
  it('prompt() with default value pre-fills the input and returns default on immediate OK', async () => {
    const user = userEvent.setup();
    const apiRef = { current: null };
    render(
      <NotifyProvider>
        <Consumer apiRef={apiRef} />
      </NotifyProvider>,
    );

    let resolved;
    act(() => {
      apiRef.current.prompt('Folder name', 'Untitled').then((v) => {
        resolved = v;
      });
    });

    await screen.findByText('Folder name');
    const input = screen.getByRole('textbox');
    expect(input).toHaveValue('Untitled');

    // Click OK without editing — returns the default.
    await user.click(screen.getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(resolved).toBe('Untitled'));
  });

  it('prompt() with empty input resolves to empty string on OK (not null)', async () => {
    // Per SUT line 261: confirmValue for prompt = current input value.
    // Empty input → resolves to empty string (caller must validate themselves).
    const user = userEvent.setup();
    const apiRef = { current: null };
    render(
      <NotifyProvider>
        <Consumer apiRef={apiRef} />
      </NotifyProvider>,
    );

    let resolved;
    act(() => {
      apiRef.current.prompt('Optional note').then((v) => {
        resolved = v;
      });
    });

    await screen.findByText('Optional note');
    await user.click(screen.getByRole('button', { name: 'OK' }));

    await waitFor(() => expect(resolved).toBe(''));
    // Explicitly NOT null — only cancel returns null per SUT line 260.
    expect(resolved).not.toBeNull();
  });

  it('two confirm() calls queue: second presents only after first resolves', async () => {
    const user = userEvent.setup();
    const apiRef = { current: null };
    render(
      <NotifyProvider>
        <Consumer apiRef={apiRef} />
      </NotifyProvider>,
    );

    const order = [];
    act(() => {
      apiRef.current.confirm('First question?').then((v) => {
        order.push(['first', v]);
      });
      apiRef.current.confirm('Second question?').then((v) => {
        order.push(['second', v]);
      });
    });

    // Only the first is visible — second is queued (modalQueueRef.current).
    await screen.findByText('First question?');
    expect(screen.queryByText('Second question?')).not.toBeInTheDocument();

    // Resolve first → second pops from queue.
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    await screen.findByText('Second question?');
    expect(screen.queryByText('First question?')).not.toBeInTheDocument();

    // Resolve second.
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(order.length).toBe(2));
    // Order preserved.
    expect(order[0]).toEqual(['first', true]);
    expect(order[1]).toEqual(['second', false]);
  });
});

describe('useNotify — provider re-render preserves in-flight toasts', () => {
  it('parent re-rendering does not blow away an active toast', async () => {
    const apiRef = { current: null };
    function Parent({ flag }) {
      // `flag` toggle forces a re-render of NotifyProvider's parent,
      // which triggers a re-render of the provider itself.
      return (
        <div data-flag={flag ? 'on' : 'off'}>
          <NotifyProvider>
            <Consumer apiRef={apiRef} />
          </NotifyProvider>
        </div>
      );
    }

    const { rerender } = render(<Parent flag={false} />);

    act(() => apiRef.current.success('Sticky toast'));
    await screen.findByText('Sticky toast');

    // Re-render parent with different prop — provider's internal state
    // (toasts array) must survive because the component instance is the
    // same (key stable). If the toast disappears after a re-render, the
    // toast-stack state is wrongly being reset on every parent update.
    rerender(<Parent flag={true} />);

    // Still there.
    expect(screen.getByText('Sticky toast')).toBeInTheDocument();
  });
});
