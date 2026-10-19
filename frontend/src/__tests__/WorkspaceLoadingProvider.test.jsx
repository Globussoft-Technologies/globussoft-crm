import { StrictMode } from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WorkspaceLoadingProvider from '../components/WorkspaceLoadingProvider';
import WorkspacePreloader from '../components/WorkspacePreloader';

function Flow({ steps = [] }) {
  return (
    <WorkspaceLoadingProvider>
      {steps.map(step => <WorkspacePreloader key={step} label={step} />)}
      <button>Dashboard ready</button>
    </WorkspaceLoadingProvider>
  );
}

describe('WorkspaceLoadingProvider', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps one overlay and animation across sequential and overlapping loading phases', () => {
    const { rerender } = render(<Flow steps={['auth']} />);
    const status = screen.getByRole('status');
    const animation = status.querySelector('.workspace-preloader__logo');
    expect(animation).not.toBeNull();
    for (const steps of [['subscription', 'permissions'], ['permissions'], [], ['page visibility']]) {
      rerender(<Flow steps={steps} />);
      act(() => vi.advanceTimersByTime(100));
      expect(screen.getAllByRole('status')).toHaveLength(1);
      expect(screen.getByRole('status')).toBe(status);
      expect(status.querySelector('.workspace-preloader__logo')).toBe(animation);
      expect(status.closest('.workspace-loading-overlay')).not.toHaveClass('workspace-loading-overlay--closing');
    }
    rerender(<Flow />);
    act(() => vi.advanceTimersByTime(180));
    expect(status.closest('.workspace-loading-overlay')).toHaveClass('workspace-loading-overlay--closing');
    act(() => vi.advanceTimersByTime(180));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dashboard ready' }).closest('[inert]')).toBeNull();
  });

  it('cancels an outgoing fade if another guard starts and keeps the background inert', () => {
    const { rerender } = render(<Flow steps={['subscription']} />);
    const status = screen.getByRole('status');
    expect(screen.getByText('Dashboard ready').closest('[inert]')).not.toBeNull();
    rerender(<Flow />);
    act(() => vi.advanceTimersByTime(200));
    rerender(<Flow steps={['permissions']} />);
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByRole('status')).toBe(status);
    expect(status.closest('.workspace-loading-overlay')).not.toHaveClass('workspace-loading-overlay--closing');
  });

  it('stays absent when nothing is loading, including after StrictMode effect replay', () => {
    const { rerender } = render(<StrictMode><Flow steps={['auth']} /></StrictMode>);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    rerender(<StrictMode><Flow /></StrictMode>);
    act(() => vi.advanceTimersByTime(400));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dashboard ready' })).toBeVisible();
  });
});
