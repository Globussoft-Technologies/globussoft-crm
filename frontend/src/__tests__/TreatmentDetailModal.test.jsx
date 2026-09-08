/**
 * The package detail dialog.
 *
 * Two properties, both learned the hard way:
 *
 *   1. It portals to <body>. The app shell's <main> runs `animation: fadeIn
 *      ... forwards`, and that animation's final keyframe leaves a transform
 *      on the element — which makes <main> the containing block for
 *      `position: fixed` descendants. Rendered in place, the overlay anchored
 *      to the scrolling content column instead of the viewport, so clicking a
 *      card near the bottom of the page opened the dialog somewhere else.
 *
 *   2. There is no "Mark complete". A package closes when its last session is
 *      delivered; a button that declares 0/4 complete only ever ends a package
 *      the customer paid for and has not used.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

const notifyObj = { error: vi.fn(), success: vi.fn(), info: vi.fn(), confirm: vi.fn() };
vi.mock('../utils/notify', () => ({ useNotify: () => notifyObj }));

import TreatmentDetailModal from '../pages/wellness/services/TreatmentDetailModal';

const PLAN = {
  id: 1436,
  name: '1 Year plan',
  status: 'active',
  totalSessions: 4,
  completedSessions: 0,
  totalPrice: 308418,
  startedAt: '2026-08-27T00:00:00.000Z',
  nextDueAt: '2027-08-27T00:00:00.000Z',
  patient: { id: 5, name: 'Sourav Adak' },
};

beforeEach(() => {
  fetchApiMock.mockReset().mockResolvedValue({});
  notifyObj.success.mockReset();
});

describe('<TreatmentDetailModal />', () => {
  it('renders into document.body, not inside the page that opened it', () => {
    // The regression: a fixed overlay inside <main> is trapped by <main>'s
    // transform and lands wherever that column happens to be scrolled to.
    const { container } = render(
      <TreatmentDetailModal treatment={PLAN} onClose={vi.fn()} onChanged={vi.fn()} />
    );

    expect(container).toBeEmptyDOMElement();
    expect(screen.getByText('1 Year plan')).toBeInTheDocument();
  });

  it('offers no way to declare a package complete', async () => {
    render(<TreatmentDetailModal treatment={PLAN} onClose={vi.fn()} onChanged={vi.fn()} />);

    expect(screen.queryByRole('button', { name: /mark complete/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Closes itself once the last session is completed/i)).toBeInTheDocument();
  });

  it('still allows pausing and cancelling', async () => {
    const user = userEvent.setup();
    render(<TreatmentDetailModal treatment={PLAN} onClose={vi.fn()} onChanged={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /pause/i }));

    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledOnce());
    const [url, opts] = fetchApiMock.mock.calls[0];
    expect(url).toBe('/api/wellness/treatment-plans/1436');
    expect(JSON.parse(opts.body)).toEqual({ status: 'paused' });
  });

  it('lets a package closed by mistake be resumed', async () => {
    // With no "Mark complete" button, Resume is the only way back — so it has
    // to be reachable on a completed plan.
    const user = userEvent.setup();
    render(
      <TreatmentDetailModal
        treatment={{ ...PLAN, status: 'completed' }}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />
    );

    expect(screen.getByText(/closed\. Resume it if that was a mistake/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /resume/i }));

    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledOnce());
    expect(JSON.parse(fetchApiMock.mock.calls[0][1].body)).toEqual({ status: 'active' });
  });

  it('closes on a backdrop click without touching the plan', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<TreatmentDetailModal treatment={PLAN} onClose={onClose} onChanged={vi.fn()} />);

    await user.click(screen.getByText('1 Year plan'));
    expect(onClose).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '×' }));
    expect(onClose).toHaveBeenCalled();
    expect(fetchApiMock).not.toHaveBeenCalled();
  });
});
