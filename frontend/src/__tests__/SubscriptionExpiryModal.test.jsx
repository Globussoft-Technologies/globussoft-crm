/**
 * SubscriptionExpiryModal — presentational component test.
 *
 * Pins the tenant-trial-expiry pop-up surfaced when `daysRemaining <= 1`.
 * The modal is pure presentational + a "remind later" localStorage stamp:
 *   - parent passes `daysRemaining` + `trialEndsAt` + `onClose` callback
 *   - render-gates on `daysRemaining` being truthy AND `<= 1`
 *   - "Choose Plan" is a `<Link to="/pricing">` (parent navigation)
 *   - "Remind Later" writes a localStorage key (next-midnight epoch ms) +
 *     internal `reminded` flag flips the SUT back to null + fires `onClose`
 *
 * Contracts the test pins:
 *   1. `daysRemaining=null` / `undefined` / `0` (falsy) renders nothing.
 *   2. `daysRemaining > 1` renders nothing.
 *   3. `daysRemaining=1` renders modal + formatted trial-end date.
 *   4. "Choose Plan" link points at /pricing.
 *   5. "Remind Later" stamps a `trial-remind-until-<midnight>` localStorage
 *      key, fires `onClose`, and removes the modal from the DOM.
 *   6. Calling "Remind Later" without an `onClose` prop doesn't throw
 *      (parent may omit the callback).
 *   7. The trial-end date is formatted as Mon-Day-Year (en-US short month).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import SubscriptionExpiryModal from '../components/SubscriptionExpiryModal';

function renderModal(overrides = {}) {
  const props = {
    daysRemaining: 1,
    trialEndsAt: '2026-06-15T00:00:00.000Z',
    onClose: vi.fn(),
    ...overrides,
  };
  const utils = render(
    <MemoryRouter>
      <SubscriptionExpiryModal {...props} />
    </MemoryRouter>
  );
  return { props, ...utils };
}

describe('SubscriptionExpiryModal', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders nothing when daysRemaining is falsy (null/undefined/0)', () => {
    const { container, rerender } = renderModal({ daysRemaining: null });
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(/Trial Expires Soon/i)).not.toBeInTheDocument();

    rerender(
      <MemoryRouter>
        <SubscriptionExpiryModal daysRemaining={undefined} trialEndsAt="2026-06-15" onClose={vi.fn()} />
      </MemoryRouter>
    );
    expect(screen.queryByText(/Trial Expires Soon/i)).not.toBeInTheDocument();

    rerender(
      <MemoryRouter>
        <SubscriptionExpiryModal daysRemaining={0} trialEndsAt="2026-06-15" onClose={vi.fn()} />
      </MemoryRouter>
    );
    expect(screen.queryByText(/Trial Expires Soon/i)).not.toBeInTheDocument();
  });

  it('renders nothing when daysRemaining > 1 (only fires at <=1 days)', () => {
    renderModal({ daysRemaining: 2 });
    expect(screen.queryByText(/Trial Expires Soon/i)).not.toBeInTheDocument();

    renderModal({ daysRemaining: 7 });
    expect(screen.queryByText(/Trial Expires Soon/i)).not.toBeInTheDocument();
  });

  it('renders the trial-expiry modal when daysRemaining is exactly 1', () => {
    renderModal({ daysRemaining: 1 });
    expect(screen.getByText(/Trial Expires Soon/i)).toBeInTheDocument();
    expect(screen.getByText(/Your free trial expires on/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Choose a plan to continue using all features/i)
    ).toBeInTheDocument();
  });

  it('formats the trial-end date as Mon-Day-Year (en-US short)', () => {
    renderModal({
      daysRemaining: 1,
      trialEndsAt: '2026-06-15T12:00:00.000Z',
    });
    // toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })
    // -> "Jun 15, 2026"
    expect(screen.getByText(/Jun 15, 2026/)).toBeInTheDocument();
  });

  it('exposes "Choose Plan" as a <Link to="/pricing">', () => {
    renderModal({ daysRemaining: 1 });
    const chooseLink = screen.getByRole('link', { name: /Choose Plan/i });
    expect(chooseLink).toBeInTheDocument();
    expect(chooseLink).toHaveAttribute('href', '/pricing');
  });

  it('"Remind Later" stamps a midnight-anchored localStorage key, fires onClose, and removes the modal', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderModal({ daysRemaining: 1, onClose });

    expect(screen.getByText(/Trial Expires Soon/i)).toBeInTheDocument();

    const remindBtn = screen.getByRole('button', { name: /Remind Later/i });
    await user.click(remindBtn);

    // onClose fired exactly once
    expect(onClose).toHaveBeenCalledTimes(1);

    // localStorage key is `trial-remind-until-<next-midnight-epoch-ms>`.
    // We can't pin the exact ms in a TZ-portable way (mirrors the wave-6 ICU
    // standing rule), so assert key SHAPE + truthy value.
    const keys = Object.keys(localStorage);
    const remindKey = keys.find((k) => k.startsWith('trial-remind-until-'));
    expect(remindKey).toBeDefined();
    expect(localStorage.getItem(remindKey)).toBe('true');
    // suffix is a numeric epoch ms (Date#setHours returns a number)
    const suffix = remindKey.replace('trial-remind-until-', '');
    expect(Number.isFinite(Number(suffix))).toBe(true);

    // After "Remind Later" the internal `reminded` flag flips the render to null.
    expect(screen.queryByText(/Trial Expires Soon/i)).not.toBeInTheDocument();
  });

  it('"Remind Later" does not throw when onClose is omitted (optional callback)', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        {/* onClose intentionally omitted */}
        <SubscriptionExpiryModal daysRemaining={1} trialEndsAt="2026-06-15" />
      </MemoryRouter>
    );

    const remindBtn = screen.getByRole('button', { name: /Remind Later/i });
    await expect(user.click(remindBtn)).resolves.not.toThrow();
    expect(screen.queryByText(/Trial Expires Soon/i)).not.toBeInTheDocument();
  });
});
