/**
 * DiagnosticSubmitOverlay.jsx — multi-stage "processing your diagnostic"
 * loading screen shared across every diagnostic-taking surface.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import DiagnosticSubmitOverlay, { DEFAULT_DIAGNOSTIC_STAGES } from '../components/travel/DiagnosticSubmitOverlay';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('DiagnosticSubmitOverlay', () => {
  it('renders nothing when inactive', () => {
    const { container } = render(<DiagnosticSubmitOverlay active={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the first stage message immediately when activated', () => {
    render(<DiagnosticSubmitOverlay active stageDurationMs={1000} />);
    expect(screen.getByText(DEFAULT_DIAGNOSTIC_STAGES[0])).toBeInTheDocument();
  });

  it('advances through stages on the configured interval', () => {
    render(<DiagnosticSubmitOverlay active stageDurationMs={1000} />);
    expect(screen.getByText(DEFAULT_DIAGNOSTIC_STAGES[0])).toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText(DEFAULT_DIAGNOSTIC_STAGES[1])).toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText(DEFAULT_DIAGNOSTIC_STAGES[2])).toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText(DEFAULT_DIAGNOSTIC_STAGES[3])).toBeInTheDocument();
  });

  it('stalls on the final stage instead of looping or disappearing', () => {
    render(<DiagnosticSubmitOverlay active stageDurationMs={1000} />);
    act(() => { vi.advanceTimersByTime(1000 * 10); });
    expect(screen.getByText(DEFAULT_DIAGNOSTIC_STAGES[DEFAULT_DIAGNOSTIC_STAGES.length - 1])).toBeInTheDocument();
  });

  it('resets to the first stage the next time it is activated', () => {
    const { rerender } = render(<DiagnosticSubmitOverlay active stageDurationMs={1000} />);
    act(() => { vi.advanceTimersByTime(2000); });
    expect(screen.getByText(DEFAULT_DIAGNOSTIC_STAGES[2])).toBeInTheDocument();

    rerender(<DiagnosticSubmitOverlay active={false} stageDurationMs={1000} />);
    rerender(<DiagnosticSubmitOverlay active stageDurationMs={1000} />);
    expect(screen.getByText(DEFAULT_DIAGNOSTIC_STAGES[0])).toBeInTheDocument();
  });

  it('accepts a custom stage list', () => {
    render(<DiagnosticSubmitOverlay active stages={['Custom stage one']} stageDurationMs={1000} />);
    expect(screen.getByText('Custom stage one')).toBeInTheDocument();
  });

  it('stacks completed stage cards rather than replacing them, and has not rendered a future stage yet', () => {
    render(<DiagnosticSubmitOverlay active stageDurationMs={1000} />);
    act(() => { vi.advanceTimersByTime(2000); }); // now on stage index 2

    // Stages 0 and 1 are still in the DOM (completed cards), stage 2 is the
    // active card, and stage 3 hasn't appeared yet.
    expect(screen.getByText(DEFAULT_DIAGNOSTIC_STAGES[0])).toBeInTheDocument();
    expect(screen.getByText(DEFAULT_DIAGNOSTIC_STAGES[1])).toBeInTheDocument();
    expect(screen.getByText(DEFAULT_DIAGNOSTIC_STAGES[2])).toBeInTheDocument();
    expect(screen.queryByText(DEFAULT_DIAGNOSTIC_STAGES[3])).not.toBeInTheDocument();
  });
});
