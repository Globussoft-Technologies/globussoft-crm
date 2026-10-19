import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import useLeadPanelPresence from '../hooks/useLeadPanelPresence';

describe('useLeadPanelPresence', () => {
  afterEach(() => vi.useRealTimers());
  it('retains the outgoing lead for the exit transition and cancels a stale close on reopening', () => {
    vi.useFakeTimers();
    const first = { id: 1 }, second = { id: 2 };
    const { result, rerender, unmount } = renderHook(({ lead }) => useLeadPanelPresence(lead), { initialProps: { lead: first } });
    rerender({ lead: null });
    expect(result.current).toBe(first);
    act(() => vi.advanceTimersByTime(100));
    rerender({ lead: second });
    act(() => vi.advanceTimersByTime(200));
    expect(result.current).toBe(second);
    rerender({ lead: null });
    act(() => vi.advanceTimersByTime(200));
    expect(result.current).toBeNull();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
