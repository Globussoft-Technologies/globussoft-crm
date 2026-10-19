import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import GenericPipelineAnalytics from '../components/GenericPipelineAnalytics';

vi.mock('recharts', async () => ({
  ...(await vi.importActual('recharts')),
  ResponsiveContainer: () => <div data-testid="chart" />,
}));

const stats = { byStage: [{ stage: 'lead', count: 5, value: 1000, expectedValue: 100 }, { stage: 'won', count: 2, value: 4000, expectedValue: 4000 }] };

describe('GenericPipelineAnalytics', () => {
  it('starts on option one and navigates all six views with bounded controls', () => {
    render(<GenericPipelineAnalytics stats={stats} />);
    const previous = screen.getByRole('button', { name: 'Previous' });
    const next = screen.getByRole('button', { name: 'Next' });
    expect(previous).toBeDisabled();
    expect(screen.getByRole('heading', { name: 'Stage value bars' })).toBeInTheDocument();
    for (const title of ['Stage funnel', 'Weighted pipeline', 'Revenue momentum', 'Pipeline composition', 'Pipeline health']) {
      fireEvent.click(next);
      expect(screen.getByRole('heading', { name: title })).toBeInTheDocument();
    }
    expect(next).toBeDisabled();
    fireEvent.click(previous);
    expect(screen.getByRole('heading', { name: 'Pipeline composition' })).toBeInTheDocument();
  });

  it('uses real stage counts and explains missing historical data without fabricated charts', () => {
    render(<GenericPipelineAnalytics stats={stats} />);
    const next = screen.getByRole('button', { name: 'Next' });
    fireEvent.click(next);
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText(/snapshot, not historical conversion/)).toBeInTheDocument();
    fireEvent.click(next);
    fireEvent.click(next);
    expect(screen.getByText(/Revenue history is not available/)).toBeInTheDocument();
    expect(screen.queryByTestId('chart')).not.toBeInTheDocument();
  });

  it('handles an empty pipeline', () => {
    render(<GenericPipelineAnalytics stats={{ byStage: [] }} />);
    expect(screen.getByText(/No pipeline data yet/)).toBeInTheDocument();
  });
});
