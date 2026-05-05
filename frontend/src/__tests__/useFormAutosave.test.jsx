import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useFormAutosave } from '../utils/useFormAutosave';

/**
 * frontend/src/utils/useFormAutosave.js — sessionStorage form draft + dirty guard
 *
 * What's tested
 *   - Initial state mirrors the `initial` arg when nothing is in sessionStorage.
 *   - Edits hydrate sessionStorage at `gbs.form.<key>`.
 *   - Refresh-style remount picks up the persisted draft.
 *   - isDirty flips true on edit, false again after clear().
 *   - clear() removes the sessionStorage entry AND resets state to `initial`.
 *   - beforeunload listener is registered while dirty, removed on clear (smoke).
 *
 * Why
 *   Half-finished prescriptions, consents, and visit notes all rely on this
 *   hook to survive accidental tab close / refresh (#226). A regression
 *   silently loses user input — users won't notice until they get angry.
 *
 * Contract pinned
 *   - sessionStorage key: `gbs.form.<key>`
 *   - Returns tuple [state, setState, isDirty, clear]
 *   - When state === initial: sessionStorage entry removed, beforeunload off
 *   - JSON-shape: stored value is JSON.stringify(state) (no extra wrapping)
 */

// Tiny harness so we can drive the hook from a test.
function Harness({ formKey, initial, onRender }) {
  const [draft, setDraft, isDirty, clear] = useFormAutosave(formKey, initial);
  // Surface state to the test
  if (onRender) onRender({ draft, setDraft, isDirty, clear });
  return (
    <div>
      <span data-testid="name">{draft.name ?? ''}</span>
      <span data-testid="dirty">{String(isDirty)}</span>
      <button onClick={() => setDraft({ ...draft, name: 'Edited' })}>Edit</button>
      <button onClick={() => clear()}>Clear</button>
    </div>
  );
}

describe('useFormAutosave', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    sessionStorage.clear();
  });

  it('initial state matches the `initial` arg when no draft is stored', () => {
    render(<Harness formKey="t1" initial={{ name: 'Original' }} />);
    expect(screen.getByTestId('name').textContent).toBe('Original');
    expect(screen.getByTestId('dirty').textContent).toBe('false');
  });

  it('persists edits to sessionStorage under gbs.form.<key>', async () => {
    const user = userEvent.setup();
    render(<Harness formKey="rx-285" initial={{ name: 'Original' }} />);

    await user.click(screen.getByText('Edit'));

    expect(screen.getByTestId('name').textContent).toBe('Edited');
    expect(screen.getByTestId('dirty').textContent).toBe('true');
    const stored = JSON.parse(sessionStorage.getItem('gbs.form.rx-285'));
    expect(stored).toEqual({ name: 'Edited' });
  });

  it('rehydrates from sessionStorage on remount (refresh simulation)', () => {
    sessionStorage.setItem('gbs.form.note-9', JSON.stringify({ name: 'Saved Draft' }));
    render(<Harness formKey="note-9" initial={{ name: 'Original' }} />);
    expect(screen.getByTestId('name').textContent).toBe('Saved Draft');
    // Different from initial → dirty
    expect(screen.getByTestId('dirty').textContent).toBe('true');
  });

  it('clear() resets to initial and removes the sessionStorage entry', async () => {
    const user = userEvent.setup();
    render(<Harness formKey="t2" initial={{ name: 'Original' }} />);

    await user.click(screen.getByText('Edit'));
    expect(sessionStorage.getItem('gbs.form.t2')).not.toBeNull();

    await user.click(screen.getByText('Clear'));
    expect(screen.getByTestId('name').textContent).toBe('Original');
    expect(screen.getByTestId('dirty').textContent).toBe('false');
    expect(sessionStorage.getItem('gbs.form.t2')).toBeNull();
  });

  it('registers a beforeunload listener while dirty and removes it on clear', async () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');

    const user = userEvent.setup();
    render(<Harness formKey="t3" initial={{ name: 'Original' }} />);
    await user.click(screen.getByText('Edit'));

    // beforeunload should be one of the events added since dirty=true
    const addedEvents = addSpy.mock.calls.map((c) => c[0]);
    expect(addedEvents).toContain('beforeunload');

    await user.click(screen.getByText('Clear'));
    const removedEvents = removeSpy.mock.calls.map((c) => c[0]);
    expect(removedEvents).toContain('beforeunload');

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it('survives a sessionStorage failure (private mode) without throwing', () => {
    // Force getItem to throw — the hook should still return the initial state.
    const orig = Storage.prototype.getItem;
    Storage.prototype.getItem = () => { throw new Error('disabled'); };
    try {
      render(<Harness formKey="t4" initial={{ name: 'Fallback' }} />);
      expect(screen.getByTestId('name').textContent).toBe('Fallback');
    } finally {
      Storage.prototype.getItem = orig;
    }
  });
});
