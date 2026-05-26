import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  CapStatusPill,
  StubModeBanner,
  CapExceededBanner,
  capPillStyles,
} from '../../components/CapBanners';

/**
 * frontend/src/components/CapBanners.jsx — shared cap-status UI
 * extracted (tick #107, commit 93acf61) from 4 byte-identical inline copies
 * across AdsGPTReports / RateHawkReports / CallifiedOps / BookingExpedia.
 *
 * What's tested
 *   - <CapStatusPill cap={...} testid label />:
 *       * returns null when cap is falsy (null / undefined)
 *       * renders the GREEN pill style when cap.withinCap is true and no
 *         alertThreshold flag is set (canonical "healthy" state)
 *       * renders the AMBER pill style when cap.withinCap is true and
 *         cap.alertThreshold is truthy ("approaching cap" warning state)
 *       * renders the RED pill style when cap.withinCap is false
 *         (over-cap "exceeded" state)
 *       * renders the percent + dollar copy in the form
 *         "<round-percent>% of $<cap>/mo <label || 'cap'>"
 *       * cents-to-USD formatting renders via formatMoney (USD fallback
 *         when no tenant in localStorage — e.g. "$10" for 1000 cents)
 *       * data-testid is preserved on the rendered root div
 *       * the supplied label (e.g. "ads cap") overrides the default
 *         "cap" suffix on the copy
 *   - <StubModeBanner testid>{children}</StubModeBanner>:
 *       * renders children inside a role=status banner
 *       * preserves the data-testid on the banner root
 *       * has indigo-tone styling consistent with the stub-mode design
 *   - <CapExceededBanner cap={...} providerLabel testid settingsHref />:
 *       * returns null when cap is falsy
 *       * renders the provider label inside a "Monthly <label> cap reached"
 *         strong header
 *       * shows the spent / cap cents pair via centsToUsd
 *       * renders a router link to settingsHref when supplied
 *       * renders a plain-text settings hint (NO link) when settingsHref
 *         is omitted
 *       * uses role=alert (vs role=status on the stub banner) since
 *         "over cap" is an error condition, not informational
 *   - capPillStyles named export:
 *       * exposes { base, green, amber, red } style objects with the
 *         expected pill-shape contract (display: inline-flex, borderRadius:
 *         999, fontWeight: 600); the colour variants extend base via
 *         spread (object-shape sanity, NOT pixel-perfect colour match)
 *
 * Why
 *   This is the canonical resolution of the rule-of-3 trigger that fired
 *   tick #106 (four byte-identical inline copies of the same cap-status
 *   UI block). The tests pin the contract that consumers depend on —
 *   testids (so e2e specs keep working), threshold-driven style choice
 *   (so a future "amber == warning" colour-swap doesn't silently flip the
 *   over-cap state to amber), and the role=alert vs role=status split
 *   (so screen-reader users get the right urgency cue). The data-testid
 *   preservation is load-bearing because 4 consumer admin pages reference
 *   testids like `adsgpt-cap-pill` / `ratehawk-cap-exceeded-banner` /
 *   `callified-stub-banner` in both UI specs and the e2e regression
 *   coverage.
 *
 * Contracts
 *   - Threshold ranking: withinCap=false → red ALWAYS (even if alertThreshold
 *     is also set); withinCap=true + alertThreshold → amber; withinCap=true
 *     + !alertThreshold → green. The check order in the SUT
 *     (CapBanners.jsx:77-79) is `if (!withinCap) red else if (alertThreshold)
 *     amber else green` — these tests pin that precedence.
 *   - formatMoney with explicit currency: USD falls through to "$N"
 *     (whole) or "$N.XX" (fractional) regardless of localStorage tenant.
 *     The SUT always passes `{ currency: 'USD' }` so the pill copy is
 *     tenant-independent (a Wellness IN tenant viewing AdsGPT spend
 *     still sees "$X spent" — provider cost is USD-billed upstream).
 */

beforeEach(() => {
  // Clear any tenant in localStorage so formatMoney's tenantCurrency
  // fallback is deterministic across this file's tests.
  try {
    window.localStorage.removeItem('tenant');
  } catch {
    /* noop */
  }
});

describe('<CapStatusPill />', () => {
  it('returns null when cap is null', () => {
    const { container } = render(<CapStatusPill cap={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('returns null when cap is undefined', () => {
    const { container } = render(<CapStatusPill cap={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the GREEN pill when withinCap=true and no alertThreshold', () => {
    render(
      <CapStatusPill
        cap={{
          withinCap: true,
          alertThreshold: false,
          spentCents: 1000,
          capCents: 10000,
          percent: 0.1,
        }}
        testid="adsgpt-cap-pill"
      />
    );
    const pill = screen.getByTestId('adsgpt-cap-pill');
    // jsdom normalises the inline-style border colour from "#22c55e" → "rgb(34, 197, 94)".
    expect(pill.style.border).toBe('1px solid rgb(34, 197, 94)');
    expect(pill.style.color).toBe('rgb(34, 197, 94)');
  });

  it('renders the AMBER pill when withinCap=true and alertThreshold is truthy', () => {
    render(
      <CapStatusPill
        cap={{
          withinCap: true,
          alertThreshold: true,
          spentCents: 8500,
          capCents: 10000,
          percent: 0.85,
        }}
        testid="ratehawk-cap-pill"
      />
    );
    const pill = screen.getByTestId('ratehawk-cap-pill');
    expect(pill.style.border).toBe('1px solid rgb(245, 158, 11)');
    expect(pill.style.color).toBe('rgb(245, 158, 11)');
  });

  it('renders the RED pill when withinCap=false (even if alertThreshold is also true)', () => {
    render(
      <CapStatusPill
        cap={{
          withinCap: false,
          alertThreshold: true,
          spentCents: 12000,
          capCents: 10000,
          percent: 1.2,
        }}
        testid="callified-cap-pill"
      />
    );
    const pill = screen.getByTestId('callified-cap-pill');
    expect(pill.style.border).toBe('1px solid rgb(244, 63, 94)');
    expect(pill.style.color).toBe('rgb(244, 63, 94)');
  });

  it('renders "<percent>% of $<cap>/mo cap" copy with formatted cents', () => {
    render(
      <CapStatusPill
        cap={{
          withinCap: true,
          alertThreshold: false,
          spentCents: 2500,
          capCents: 10000,
          percent: 0.25,
        }}
        testid="cap-pill"
      />
    );
    const pill = screen.getByTestId('cap-pill');
    expect(pill).toHaveTextContent('25% of $100/mo cap');
  });

  it('honours a custom label suffix (overrides default "cap")', () => {
    render(
      <CapStatusPill
        cap={{
          withinCap: true,
          alertThreshold: false,
          spentCents: 1000,
          capCents: 5000,
          percent: 0.2,
        }}
        testid="cap-pill"
        label="ads cap"
      />
    );
    expect(screen.getByTestId('cap-pill')).toHaveTextContent('20% of $50/mo ads cap');
  });

  it('renders 0% when percent is not a finite number', () => {
    render(
      <CapStatusPill
        cap={{
          withinCap: true,
          alertThreshold: false,
          spentCents: 0,
          capCents: 10000,
          percent: NaN,
        }}
        testid="cap-pill"
      />
    );
    expect(screen.getByTestId('cap-pill')).toHaveTextContent('0% of $100/mo cap');
  });

  it('exposes the spent/cap tooltip via the title attribute', () => {
    render(
      <CapStatusPill
        cap={{
          withinCap: true,
          alertThreshold: false,
          spentCents: 2500,
          capCents: 10000,
          percent: 0.25,
        }}
        testid="cap-pill"
      />
    );
    expect(screen.getByTestId('cap-pill')).toHaveAttribute(
      'title',
      '$25 spent of $100 monthly cap'
    );
  });
});

describe('<StubModeBanner />', () => {
  it('renders children inside a role=status banner', () => {
    render(
      <StubModeBanner testid="adsgpt-stub-banner">
        <strong>Stub-mode response</strong>
      </StubModeBanner>
    );
    const banner = screen.getByRole('status');
    expect(within(banner).getByText('Stub-mode response')).toBeInTheDocument();
  });

  it('preserves the data-testid on the banner root', () => {
    render(<StubModeBanner testid="ratehawk-stub-banner">body</StubModeBanner>);
    expect(screen.getByTestId('ratehawk-stub-banner')).toBeInTheDocument();
  });

  it('has indigo-tone styling (rgba indigo background + indigo border)', () => {
    render(<StubModeBanner testid="cap-stub">body</StubModeBanner>);
    const banner = screen.getByTestId('cap-stub');
    // capBanners.jsx :: stubBannerStyle uses rgba(99, 102, 241, ...) indigo.
    expect(banner.style.background).toContain('99, 102, 241');
    expect(banner.style.border).toContain('99, 102, 241');
  });
});

describe('<CapExceededBanner />', () => {
  it('returns null when cap is null', () => {
    const { container } = render(
      <MemoryRouter>
        <CapExceededBanner cap={null} providerLabel="AdsGPT" />
      </MemoryRouter>
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the "Monthly <label> cap reached" header with the provider label', () => {
    render(
      <MemoryRouter>
        <CapExceededBanner
          cap={{ spentCents: 12000, capCents: 10000 }}
          providerLabel="AdsGPT"
          testid="adsgpt-cap-exceeded-banner"
        />
      </MemoryRouter>
    );
    expect(screen.getByText('Monthly AdsGPT cap reached')).toBeInTheDocument();
  });

  it('renders the spent / cap cents pair formatted as USD', () => {
    render(
      <MemoryRouter>
        <CapExceededBanner
          cap={{ spentCents: 12500, capCents: 10000 }}
          providerLabel="RateHawk"
          testid="cap-exceeded"
        />
      </MemoryRouter>
    );
    expect(screen.getByTestId('cap-exceeded')).toHaveTextContent('$125 / $100');
  });

  it('renders a router link to settingsHref when supplied', () => {
    render(
      <MemoryRouter>
        <CapExceededBanner
          cap={{ spentCents: 12000, capCents: 10000 }}
          providerLabel="Callified"
          testid="cap-exceeded"
          settingsHref="/settings/tenant"
        />
      </MemoryRouter>
    );
    const link = screen.getByRole('link', { name: /tenant settings/i });
    expect(link).toHaveAttribute('href', '/settings/tenant');
  });

  it('renders plain-text settings hint (NO link) when settingsHref is omitted', () => {
    render(
      <MemoryRouter>
        <CapExceededBanner
          cap={{ spentCents: 12000, capCents: 10000 }}
          providerLabel="BookingExpedia"
          testid="cap-exceeded"
        />
      </MemoryRouter>
    );
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(
      screen.getByText(/Increase the cap via Tenant Settings/i)
    ).toBeInTheDocument();
  });

  it('uses role=alert (high-urgency cue, distinct from stub banner role=status)', () => {
    render(
      <MemoryRouter>
        <CapExceededBanner
          cap={{ spentCents: 12000, capCents: 10000 }}
          providerLabel="AdsGPT"
          testid="cap-exceeded"
        />
      </MemoryRouter>
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('preserves the data-testid on the banner root', () => {
    render(
      <MemoryRouter>
        <CapExceededBanner
          cap={{ spentCents: 12000, capCents: 10000 }}
          providerLabel="AdsGPT"
          testid="adsgpt-cap-exceeded-banner"
        />
      </MemoryRouter>
    );
    expect(screen.getByTestId('adsgpt-cap-exceeded-banner')).toBeInTheDocument();
  });
});

describe('capPillStyles named export', () => {
  it('exposes the four variants', () => {
    expect(capPillStyles).toHaveProperty('base');
    expect(capPillStyles).toHaveProperty('green');
    expect(capPillStyles).toHaveProperty('amber');
    expect(capPillStyles).toHaveProperty('red');
  });

  it('base contract: inline-flex + borderRadius 999 + fontWeight 600', () => {
    expect(capPillStyles.base.display).toBe('inline-flex');
    expect(capPillStyles.base.borderRadius).toBe(999);
    expect(capPillStyles.base.fontWeight).toBe(600);
  });

  it('green / amber / red extend base (inherit display + borderRadius)', () => {
    for (const variant of ['green', 'amber', 'red']) {
      expect(capPillStyles[variant].display).toBe('inline-flex');
      expect(capPillStyles[variant].borderRadius).toBe(999);
      expect(capPillStyles[variant].fontWeight).toBe(600);
    }
  });

  it('green / amber / red each carry distinct border colours', () => {
    expect(capPillStyles.green.border).toContain('#22c55e');
    expect(capPillStyles.amber.border).toContain('#f59e0b');
    expect(capPillStyles.red.border).toContain('#f43f5e');
  });
});
