/**
 * PaymentSuccess.test.jsx -- vitest + RTL coverage for the post-checkout
 * payment-success landing page at frontend/src/pages/PaymentSuccess.jsx.
 *
 * The SUT is a pure-render page (NO fetchApi, NO useNotify, NO useApi, NO
 * AuthContext consumption). Its contract is small but load-bearing:
 *
 *   1. Render chrome: success checkmark, "Payment Successful!" h1,
 *      "Your subscription has been activated" sub-copy, "Plan Details"
 *      label, redirect-countdown copy, "Continue to Dashboard" button.
 *   2. Plan name source: reads `location.state?.planName` from
 *      react-router-dom's useLocation. Falls back to the literal string
 *      "Subscription" when state.planName is absent.
 *   3. End-date source: reads `location.state?.endDate` and, when present,
 *      formats it via `new Date(endDate).toLocaleDateString('en-US', {
 *      year: 'numeric', month: 'long', day: 'numeric' })`. When absent the
 *      "Active until: …" line is omitted entirely.
 *   4. Auto-redirect: useEffect installs a 3000ms setTimeout that fires
 *      navigate('/dashboard'). Cleanup clears the timer on unmount.
 *   5. Manual redirect: the "Continue to Dashboard" button onClick calls
 *      navigate('/dashboard') immediately (no wait for the timer).
 *
 * Drift pinned (prompt vs. actual SUT)
 * ------------------------------------
 *   - Prompt anticipated URL-param parsing for `session_id` /
 *     `razorpay_payment_id` (Stripe / Razorpay redirect target). REALITY:
 *     the SUT consumes ONLY useLocation().state (planName + endDate) — no
 *     useSearchParams, no useParams, no query-string reads. The current
 *     checkout flow passes plan metadata via navigate(..., { state })
 *     after a successful payment, not via URL params. Pinning ACTUAL
 *     contract — if the page is later changed to also read URL params
 *     (e.g. for resume-after-OAuth flows), the new param tests live in a
 *     follow-up commit.
 *   - Prompt mentioned "error states if any". REALITY: there are no error
 *     surfaces — the page is reached only AFTER a successful payment in
 *     the upstream flow. No error branch to pin.
 *
 * Mocking strategy
 * ----------------
 *   - react-router-dom: real MemoryRouter wraps the SUT so useLocation
 *     resolves from `initialEntries`. useNavigate is mocked via
 *     vi.mock('react-router-dom', async () => { ... }) so the test can
 *     assert exact navigate('/dashboard') calls without needing a Routes
 *     tree. The mock preserves MemoryRouter via importOriginal — that's
 *     the canonical pattern from the existing test suite.
 *   - Fake timers: vi.useFakeTimers() drives the 3000ms auto-redirect
 *     deterministically. vi.advanceTimersByTime(3000) fires it; the
 *     cleanup test asserts the timer is cleared on unmount (no navigate
 *     call after the unmount + advance).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Stable navigate mock — one identity across the whole test run, so
// useEffect dependencies don't re-fire on mock-object identity changes
// (per CLAUDE.md standing rule on stable mock object refs for hooks used
// in useCallback/useEffect dependency arrays).
const navigateMock = vi.fn();

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

import PaymentSuccess from '../pages/PaymentSuccess';

function renderPaymentSuccess(state) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: '/payment/success', state }]}>
      <PaymentSuccess />
    </MemoryRouter>,
  );
}

describe('<PaymentSuccess /> -- post-checkout landing page', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    navigateMock.mockReset();
  });

  afterEach(() => {
    // Drain any pending timers + restore real timers so userEvent in the
    // next test's beforeEach doesn't see lingering fake-timer state.
    vi.useRealTimers();
  });

  it('renders the success chrome: checkmark, h1, sub-copy, plan-details block, countdown copy, continue button', () => {
    renderPaymentSuccess({ planName: 'Pro Annual' });
    // The h1 is the load-bearing "Payment Successful!" heading.
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.textContent).toMatch(/Payment Successful/i);
    // Sub-copy + plan-details label + countdown copy + CTA.
    expect(screen.getByText(/Your subscription has been activated/i)).toBeInTheDocument();
    expect(screen.getByText(/Plan Details/i)).toBeInTheDocument();
    expect(screen.getByText(/Redirecting to dashboard in 3 seconds/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Continue to Dashboard/i }),
    ).toBeInTheDocument();
  });

  it('renders the plan name from location.state.planName when provided', () => {
    renderPaymentSuccess({ planName: 'Enterprise Monthly' });
    expect(screen.getByText('Enterprise Monthly')).toBeInTheDocument();
    // The literal fallback "Subscription" MUST NOT render when an explicit
    // planName is provided.
    expect(screen.queryByText(/^Subscription$/)).not.toBeInTheDocument();
  });

  it('falls back to the literal "Subscription" when location.state.planName is absent', () => {
    // No state at all — useLocation() returns state=null/undefined.
    renderPaymentSuccess(undefined);
    expect(screen.getByText('Subscription')).toBeInTheDocument();
  });

  it('renders the "Active until" line with the endDate formatted via toLocaleDateString en-US', () => {
    // Pick a date with no TZ-rollover ambiguity for en-US (midnight UTC
    // on 15 June 2026 renders as "June 15, 2026" across all common ICU
    // builds; the format tokens are { year: 'numeric', month: 'long',
    // day: 'numeric' } per the SUT).
    renderPaymentSuccess({
      planName: 'Pro Annual',
      endDate: '2026-06-15T00:00:00Z',
    });
    // "Active until:" label renders, with the long-month formatted date
    // following inside a <strong>. Match on the label + the year token
    // to stay robust against TZ-shift of the day boundary across runners
    // (the en-US format is deterministic for month + year; day may slip
    // by one across UTC↔local boundaries on some CI runners).
    expect(screen.getByText(/Active until:/i)).toBeInTheDocument();
    // The formatted date contains "June" + "2026" regardless of which
    // day the local TZ resolves the UTC midnight into.
    const planBlock = screen.getByText(/Active until:/i).closest('p');
    expect(planBlock).not.toBeNull();
    expect(planBlock.textContent).toMatch(/June/);
    expect(planBlock.textContent).toMatch(/2026/);
  });

  it('omits the "Active until" line when location.state.endDate is absent', () => {
    renderPaymentSuccess({ planName: 'Pro Annual' });
    expect(screen.queryByText(/Active until:/i)).not.toBeInTheDocument();
  });

  it('auto-redirects to /dashboard 3000ms after mount via setTimeout', () => {
    renderPaymentSuccess({ planName: 'Pro Annual' });
    // Before the timer fires, navigate has not been called.
    expect(navigateMock).not.toHaveBeenCalled();
    // Advance fake timers by exactly 3000ms — the useEffect's setTimeout
    // payload fires synchronously under fake timers, scheduling a React
    // state update inside act().
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith('/dashboard');
  });

  it('clears the auto-redirect timer on unmount so navigate is not called after the user leaves', () => {
    const { unmount } = renderPaymentSuccess({ planName: 'Pro Annual' });
    // Unmount BEFORE the 3000ms timer fires.
    unmount();
    // Advance well past the timer — if the cleanup didn't run, navigate
    // would have been called. The SUT's useEffect returns
    // `() => clearTimeout(timer)`, so this MUST stay at 0 calls.
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('the "Continue to Dashboard" button navigates immediately on click (no wait for the 3s timer)', () => {
    // fireEvent is the synchronous primitive — userEvent's pointer
    // simulation routes through setTimeout under the hood, which deadlocks
    // against fake timers. The button's onClick handler is a single
    // navigate('/dashboard') call, so fireEvent.click is sufficient to
    // pin the contract.
    renderPaymentSuccess({ planName: 'Pro Annual' });
    const cta = screen.getByRole('button', { name: /Continue to Dashboard/i });
    fireEvent.click(cta);
    // The click handler fires navigate('/dashboard') directly — the 3s
    // timer hasn't been advanced, so the only navigate call is the
    // click-driven one.
    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith('/dashboard');
  });
});
