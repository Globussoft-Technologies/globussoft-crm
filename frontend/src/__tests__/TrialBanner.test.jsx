import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import TrialBanner from '../components/TrialBanner';

/**
 * frontend/src/components/TrialBanner.jsx
 *
 * What's tested
 *   - Render-gating: shows when daysRemaining > 0, hides when 0 / negative
 *     / undefined / null.
 *   - Countdown copy: "expires in <N> days" + correct singular/plural form
 *     ("1 day" vs "2 days").
 *   - Urgency styling: daysRemaining <= 3 flips background to amber
 *     (#fef3c7) + border to amber (#f59e0b); >3 stays in the warmer
 *     orange palette (#fef8f0 / #f97316).
 *   - Upgrade CTA: renders a Link to /pricing labelled "Upgrade Now".
 *   - Dismiss: clicking the ✕ button hides the banner AND persists the
 *     dismissal via sessionStorage('trial-banner-dismissed').
 *   - Cross-render persistence: when sessionStorage already has the
 *     dismissed flag, the banner does NOT render on mount.
 *
 * Why
 *   TrialBanner gates the conversion path from free-trial → paid. A
 *   render-regression that hides the CTA silently kills upgrade revenue;
 *   a dismiss-regression that re-shows the banner on every navigation is
 *   the kind of UX papercut that piles up CS tickets without surfacing
 *   in any backend metric. Pinning the conditional-render matrix +
 *   sessionStorage round-trip prevents both classes.
 *
 * Contracts pinned
 *   - prop: daysRemaining (number | null | undefined | 0 | negative)
 *   - render: returns null when dismissed OR daysRemaining <= 0
 *   - sessionStorage key: 'trial-banner-dismissed', value 'true'
 *   - aria: dismiss button has aria-label="Dismiss banner"
 *   - link: <Link to="/pricing">Upgrade Now</Link>
 */

function renderWithRouter(ui) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('<TrialBanner />', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('renders the trial-expiry copy when daysRemaining is a positive number', () => {
    renderWithRouter(<TrialBanner daysRemaining={7} />);
    expect(screen.getByText(/Your free trial expires in/i)).toBeInTheDocument();
    // "7 days" is inside a <strong>; match via regex since RTL collapses
    // whitespace between {daysRemaining} and the day/days token.
    expect(screen.getByText(/^\s*7\s+days\s*$/)).toBeInTheDocument();
    expect(screen.getByText(/Upgrade now to continue using all features/i)).toBeInTheDocument();
  });

  it('uses singular "day" when daysRemaining === 1', () => {
    renderWithRouter(<TrialBanner daysRemaining={1} />);
    expect(screen.getByText(/^\s*1\s+day\s*$/)).toBeInTheDocument();
    // Make sure it didn't render the plural form anywhere in the strong.
    expect(screen.queryByText(/^\s*1\s+days\s*$/)).not.toBeInTheDocument();
  });

  it('uses plural "days" when daysRemaining >= 2', () => {
    renderWithRouter(<TrialBanner daysRemaining={5} />);
    expect(screen.getByText(/^\s*5\s+days\s*$/)).toBeInTheDocument();
    expect(screen.queryByText(/^\s*5\s+day\s*$/)).not.toBeInTheDocument();
  });

  it('renders null when daysRemaining is 0', () => {
    const { container } = renderWithRouter(<TrialBanner daysRemaining={0} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(/Your free trial expires/i)).not.toBeInTheDocument();
  });

  it('renders null when daysRemaining is negative (trial already expired)', () => {
    const { container } = renderWithRouter(<TrialBanner daysRemaining={-2} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders null when daysRemaining is undefined / null (not on a trial)', () => {
    const { container: c1 } = renderWithRouter(<TrialBanner />);
    expect(c1).toBeEmptyDOMElement();

    const { container: c2 } = renderWithRouter(<TrialBanner daysRemaining={null} />);
    expect(c2).toBeEmptyDOMElement();
  });

  it('renders an Upgrade CTA that links to /pricing', () => {
    renderWithRouter(<TrialBanner daysRemaining={10} />);
    const cta = screen.getByRole('link', { name: /upgrade now/i });
    expect(cta).toBeInTheDocument();
    expect(cta).toHaveAttribute('href', '/pricing');
  });

  it('applies the urgent (amber) palette when daysRemaining <= 3', () => {
    const { container } = renderWithRouter(<TrialBanner daysRemaining={2} />);
    const banner = container.firstChild;
    expect(banner).toBeTruthy();
    // jsdom normalises hex → rgb; assert on the computed inline-style values.
    // #fef3c7 → rgb(254, 243, 199); #f59e0b → rgb(245, 158, 11).
    expect(banner.style.backgroundColor).toBe('rgb(254, 243, 199)');
    expect(banner.style.borderLeft).toContain('rgb(245, 158, 11)');
  });

  it('applies the non-urgent (orange) palette when daysRemaining > 3', () => {
    const { container } = renderWithRouter(<TrialBanner daysRemaining={14} />);
    const banner = container.firstChild;
    // #fef8f0 → rgb(254, 248, 240); #f97316 → rgb(249, 115, 22).
    expect(banner.style.backgroundColor).toBe('rgb(254, 248, 240)');
    expect(banner.style.borderLeft).toContain('rgb(249, 115, 22)');
  });

  it('hides the banner when the dismiss button is clicked', async () => {
    const user = userEvent.setup();
    renderWithRouter(<TrialBanner daysRemaining={9} />);

    // Banner is visible to start.
    expect(screen.getByText(/Your free trial expires in/i)).toBeInTheDocument();

    const dismiss = screen.getByRole('button', { name: /dismiss banner/i });
    await user.click(dismiss);

    expect(screen.queryByText(/Your free trial expires in/i)).not.toBeInTheDocument();
  });

  it('persists the dismissal to sessionStorage on click', async () => {
    const user = userEvent.setup();
    renderWithRouter(<TrialBanner daysRemaining={6} />);
    expect(sessionStorage.getItem('trial-banner-dismissed')).toBe(null);

    await user.click(screen.getByRole('button', { name: /dismiss banner/i }));

    expect(sessionStorage.getItem('trial-banner-dismissed')).toBe('true');
  });

  it('does NOT render on mount when sessionStorage already has the dismissed flag', () => {
    sessionStorage.setItem('trial-banner-dismissed', 'true');
    const { container } = renderWithRouter(<TrialBanner daysRemaining={4} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(/Your free trial expires/i)).not.toBeInTheDocument();
  });
});
