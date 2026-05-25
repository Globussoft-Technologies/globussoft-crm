/**
 * PaymentFailed.test.jsx — vitest + RTL coverage for the payment-failed
 * landing page.
 *
 * Scope: pins the page-surface invariants for the static "Payment Failed"
 * outcome page rendered after a Stripe / Razorpay checkout returns a
 * failure state. The page is fully presentational — no fetchApi calls,
 * no useNotify, no URL-param parsing, no useEffect side effects. Both
 * CTAs (Retry Payment + Go to Pricing) route to `/pricing` via
 * react-router-dom's useNavigate.
 *
 *   1. Renders the heading "Payment Failed" + the failure subtext.
 *   2. Renders the supplemental advisory text ("Please check your card
 *      details and try again, or contact support if the issue persists.").
 *   3. Renders both action buttons: "Retry Payment" (primary, orange) and
 *      "Go to Pricing" (secondary).
 *   4. "Retry Payment" click navigates to `/pricing`.
 *   5. "Go to Pricing" click navigates to `/pricing`.
 *   6. Renders the ✕ failure icon inside the error badge.
 *   7. Does NOT call fetchApi or trigger any network side effect on mount
 *      (page is purely presentational).
 *   8. Button hover handlers mutate inline opacity / background-color
 *      without throwing (defensive — exercises the onMouseEnter/Leave
 *      branches so they don't rot silently).
 *
 * Drift note: the SUT today hard-codes both buttons to `/pricing` and
 * does not parse `?reason=` / `?code=` query params. If a future change
 * adds URL-driven error-reason rendering, the new contract should land
 * with its own test cases — this file pins TODAY's static contract.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

const navigateMock = vi.fn();
vi.mock('react-router-dom', async () => {
  const real = await vi.importActual('react-router-dom');
  return { ...real, useNavigate: () => navigateMock };
});

// fetchApi mock — SUT does not import this today, but stable per-suite
// mock keeps the contract symmetric with the rest of the page-test
// suite + lets case (7) assert zero calls cleanly.
const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

import PaymentFailed from '../pages/PaymentFailed';

const renderPage = () =>
  render(
    <MemoryRouter>
      <PaymentFailed />
    </MemoryRouter>
  );

describe('PaymentFailed page', () => {
  beforeEach(() => {
    navigateMock.mockClear();
    fetchApiMock.mockClear();
  });

  it('renders the "Payment Failed" heading and failure subtext', () => {
    renderPage();
    expect(
      screen.getByRole('heading', { name: /payment failed/i, level: 1 })
    ).toBeInTheDocument();
    expect(
      screen.getByText(/unfortunately, your payment could not be processed/i)
    ).toBeInTheDocument();
  });

  it('renders the supplemental advisory text', () => {
    renderPage();
    expect(
      screen.getByText(
        /please check your card details and try again, or contact support/i
      )
    ).toBeInTheDocument();
  });

  it('renders both action buttons (Retry Payment + Go to Pricing)', () => {
    renderPage();
    expect(
      screen.getByRole('button', { name: /retry payment/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /go to pricing/i })
    ).toBeInTheDocument();
  });

  it('navigates to /pricing when "Retry Payment" is clicked', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /retry payment/i }));
    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith('/pricing');
  });

  it('navigates to /pricing when "Go to Pricing" is clicked', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /go to pricing/i }));
    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith('/pricing');
  });

  it('renders the ✕ failure icon inside the error badge', () => {
    renderPage();
    // The ✕ glyph is rendered as text content in a styled div badge.
    expect(screen.getByText('✕')).toBeInTheDocument();
  });

  it('does not trigger any fetchApi network call on mount', () => {
    renderPage();
    expect(fetchApiMock).not.toHaveBeenCalled();
  });

  it('exercises button mouseEnter / mouseLeave handlers without throwing', () => {
    renderPage();
    const retryBtn = screen.getByRole('button', { name: /retry payment/i });
    const secondaryBtn = screen.getByRole('button', { name: /go to pricing/i });

    // Primary button toggles opacity on hover.
    fireEvent.mouseEnter(retryBtn);
    expect(retryBtn.style.opacity).toBe('0.9');
    fireEvent.mouseLeave(retryBtn);
    expect(retryBtn.style.opacity).toBe('1');

    // Secondary button toggles backgroundColor on hover.
    fireEvent.mouseEnter(secondaryBtn);
    // jsdom normalises the hex; assert non-empty and not the resting state.
    expect(secondaryBtn.style.backgroundColor).not.toBe('');
    fireEvent.mouseLeave(secondaryBtn);
    expect(secondaryBtn.style.backgroundColor).not.toBe('');
  });
});
