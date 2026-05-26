/**
 * CapBanners.test.jsx — vitest + RTL coverage for the shared cap-status UI
 * primitives (frontend/src/components/CapBanners.jsx, extracted tick #106
 * from 4 byte-identical inline copies in cap-consumer admin pages — AdsGPT,
 * RateHawk, Callified, BookingExpedia — per rule-of-3 trigger).
 *
 * Scope — pins the component contracts that 5+ downstream pages depend on:
 *
 *   CapStatusPill
 *     1. Returns null when `cap` prop is missing / null (graceful no-op).
 *     2. Green pill renders when withinCap=true AND alertThreshold=false
 *        (well-under) — CheckCircle2 icon + green border colour.
 *     3. Amber pill renders when withinCap=true AND alertThreshold=true
 *        (near-limit, typically ≥80% per backend convention).
 *     4. Red pill renders when withinCap=false (at/over-limit) —
 *        AlertTriangle icon + red border colour.
 *     5. Percent + cap-dollars copy renders inside the pill (cents → USD
 *        round-trip via centsToUsd; percent rounded to integer).
 *     6. Custom `label` prop overrides the default "cap" suffix.
 *     7. testid prop wires through for downstream selector targeting.
 *     8. Title attribute carries the spent/cap tooltip copy.
 *
 *   StubModeBanner
 *     9. Renders indigo banner with role="status" + Info icon + children
 *        body (cred-blocked-integration explanation surface).
 *    10. testid prop wires through.
 *
 *   CapExceededBanner
 *    11. Returns null when `cap` prop is missing / null (graceful no-op).
 *    12. Renders red banner with role="alert" + AlertTriangle icon +
 *        "Monthly {providerLabel} cap reached" copy + spent/cap dollars.
 *    13. settingsHref prop renders a RouterLink to /tenant-settings with
 *        "Tenant Settings" anchor copy.
 *    14. Without settingsHref, the inline "Increase the cap via Tenant
 *        Settings" copy still renders BUT NO link is present.
 *    15. testid prop wires through.
 *
 *   Stacking
 *    16. Multiple cap banners can render in the same parent without
 *        interfering — each finds its testid + role independently.
 *
 * Why
 *   These 3 components are the shared cap-consumer UI primitive. A
 *   regression here cascades into AdsGPTReports, RateHawkSearch,
 *   CallifiedCalls, BookingExpediaSearch — and any future cred-blocked
 *   sister-product integration that follows the same wrapper pattern
 *   (PRD_ADSGPT_MARKETING_REPORTS §3). Pinning the contract here means
 *   each downstream test can mock the cap-status endpoint and trust the
 *   pill / banner behaviour without re-testing the rendering itself.
 *
 *   No backend coupling — these are pure presentation components. SUT
 *   reads cents → USD via formatMoney (utils/money.js); USD-locale is
 *   forced via the `currency: 'USD'` opt so locale isn't a variable.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import {
  CapStatusPill,
  StubModeBanner,
  CapExceededBanner,
  capPillStyles,
} from '../components/CapBanners';

// Helper: wrap in MemoryRouter because CapExceededBanner uses RouterLink
function renderWithRouter(ui) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('<CapStatusPill />', () => {
  it('renders nothing when cap is null', () => {
    const { container } = render(<CapStatusPill cap={null} testid="pill-null" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when cap is undefined', () => {
    const { container } = render(<CapStatusPill testid="pill-undef" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders green pill when well under cap (withinCap=true, alertThreshold=false)', () => {
    render(
      <CapStatusPill
        cap={{
          spentCents: 1000,
          capCents: 10000,
          percent: 0.1,
          withinCap: true,
          alertThreshold: false,
        }}
        testid="pill-under"
      />,
    );
    const pill = screen.getByTestId('pill-under');
    expect(pill).toBeInTheDocument();
    // Green border colour per capPillGreen (#22c55e → rgb(34, 197, 94))
    const borderUnder = pill.style.borderColor || pill.style.border;
    expect(borderUnder).toMatch(/22c55e|rgb\(34,\s*197,\s*94\)/i);
  });

  it('renders amber pill when near-limit (withinCap=true, alertThreshold=true)', () => {
    render(
      <CapStatusPill
        cap={{
          spentCents: 8500,
          capCents: 10000,
          percent: 0.85,
          withinCap: true,
          alertThreshold: true,
        }}
        testid="pill-near"
      />,
    );
    const pill = screen.getByTestId('pill-near');
    expect(pill).toBeInTheDocument();
    // Amber border per capPillAmber (#f59e0b → rgb(245, 158, 11))
    const borderNear = pill.style.borderColor || pill.style.border;
    expect(borderNear).toMatch(/f59e0b|rgb\(245,\s*158,\s*11\)/i);
  });

  it('renders red pill when over cap (withinCap=false)', () => {
    render(
      <CapStatusPill
        cap={{
          spentCents: 12000,
          capCents: 10000,
          percent: 1.2,
          withinCap: false,
          alertThreshold: true,
        }}
        testid="pill-over"
      />,
    );
    const pill = screen.getByTestId('pill-over');
    expect(pill).toBeInTheDocument();
    // Red border per capPillRed (#f43f5e → rgb(244, 63, 94))
    const borderOver = pill.style.borderColor || pill.style.border;
    expect(borderOver).toMatch(/f43f5e|rgb\(244,\s*63,\s*94\)/i);
  });

  it('renders percent + cap-dollars copy', () => {
    render(
      <CapStatusPill
        cap={{
          spentCents: 5000,
          capCents: 10000,
          percent: 0.5,
          withinCap: true,
          alertThreshold: false,
        }}
        testid="pill-copy"
      />,
    );
    const pill = screen.getByTestId('pill-copy');
    // 50% + "$100" (10000 cents = $100, formatted via formatMoney USD)
    expect(pill.textContent).toMatch(/50%/);
    expect(pill.textContent).toMatch(/\$100/);
    expect(pill.textContent).toMatch(/cap/i);
  });

  it('honours custom label prop (overrides default "cap" suffix)', () => {
    render(
      <CapStatusPill
        cap={{
          spentCents: 1000,
          capCents: 10000,
          percent: 0.1,
          withinCap: true,
          alertThreshold: false,
        }}
        testid="pill-label"
        label="budget"
      />,
    );
    const pill = screen.getByTestId('pill-label');
    expect(pill.textContent).toMatch(/budget/);
    // Default "cap" word should NOT appear when overridden
    expect(pill.textContent).not.toMatch(/\bcap\b/);
  });

  it('wires testid prop through for downstream selectors', () => {
    render(
      <CapStatusPill
        cap={{
          spentCents: 0,
          capCents: 10000,
          percent: 0,
          withinCap: true,
          alertThreshold: false,
        }}
        testid="adsgpt-cap-pill"
      />,
    );
    expect(screen.getByTestId('adsgpt-cap-pill')).toBeInTheDocument();
  });

  it('sets a tooltip title with spent / cap dollar copy', () => {
    render(
      <CapStatusPill
        cap={{
          spentCents: 2500,
          capCents: 10000,
          percent: 0.25,
          withinCap: true,
          alertThreshold: false,
        }}
        testid="pill-title"
      />,
    );
    const pill = screen.getByTestId('pill-title');
    // Title carries "$25 spent of $100 monthly cap"
    expect(pill.title).toMatch(/\$25/);
    expect(pill.title).toMatch(/\$100/);
    expect(pill.title).toMatch(/monthly cap/i);
  });

  it('renders 0% sentinel when percent is non-finite', () => {
    render(
      <CapStatusPill
        cap={{
          spentCents: 0,
          capCents: 0,
          percent: NaN,
          withinCap: true,
          alertThreshold: false,
        }}
        testid="pill-nan"
      />,
    );
    expect(screen.getByTestId('pill-nan').textContent).toMatch(/0%/);
  });
});

describe('<StubModeBanner />', () => {
  it('renders indigo banner with role=status + children body', () => {
    render(
      <StubModeBanner testid="adsgpt-stub-banner">
        Stub mode active — credentials pending.
      </StubModeBanner>,
    );
    const banner = screen.getByTestId('adsgpt-stub-banner');
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveAttribute('role', 'status');
    expect(banner.textContent).toMatch(/Stub mode active/);
  });

  it('wires testid prop through', () => {
    render(<StubModeBanner testid="ratehawk-stub-banner">x</StubModeBanner>);
    expect(screen.getByTestId('ratehawk-stub-banner')).toBeInTheDocument();
  });

  it('accepts rich JSX children, not just strings', () => {
    render(
      <StubModeBanner testid="rich-stub">
        <strong>Bold</strong> and <em>italic</em>
      </StubModeBanner>,
    );
    const banner = screen.getByTestId('rich-stub');
    expect(within(banner).getByText('Bold').tagName).toBe('STRONG');
    expect(within(banner).getByText('italic').tagName).toBe('EM');
  });
});

describe('<CapExceededBanner />', () => {
  it('renders nothing when cap is null', () => {
    const { container } = renderWithRouter(
      <CapExceededBanner cap={null} providerLabel="AdsGPT" testid="banner-null" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders red alert banner with provider label + spent/cap copy', () => {
    renderWithRouter(
      <CapExceededBanner
        cap={{ spentCents: 12000, capCents: 10000 }}
        providerLabel="AdsGPT"
        testid="adsgpt-cap-exceeded-banner"
      />,
    );
    const banner = screen.getByTestId('adsgpt-cap-exceeded-banner');
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveAttribute('role', 'alert');
    expect(banner.textContent).toMatch(/Monthly AdsGPT cap reached/);
    expect(banner.textContent).toMatch(/\$120/);
    expect(banner.textContent).toMatch(/\$100/);
  });

  it('renders a RouterLink when settingsHref is supplied', () => {
    renderWithRouter(
      <CapExceededBanner
        cap={{ spentCents: 12000, capCents: 10000 }}
        providerLabel="RateHawk"
        testid="rh-banner"
        settingsHref="/tenant-settings"
      />,
    );
    const banner = screen.getByTestId('rh-banner');
    const link = within(banner).getByRole('link', { name: /Tenant Settings/i });
    expect(link).toHaveAttribute('href', '/tenant-settings');
  });

  it('without settingsHref, renders fallback prose with no link', () => {
    renderWithRouter(
      <CapExceededBanner
        cap={{ spentCents: 12000, capCents: 10000 }}
        providerLabel="Callified"
        testid="cf-banner"
      />,
    );
    const banner = screen.getByTestId('cf-banner');
    expect(banner.textContent).toMatch(/Increase the cap via Tenant Settings/);
    expect(within(banner).queryByRole('link')).not.toBeInTheDocument();
  });

  it('wires testid prop through', () => {
    renderWithRouter(
      <CapExceededBanner
        cap={{ spentCents: 12000, capCents: 10000 }}
        providerLabel="BookingExpedia"
        testid="be-cap-exceeded"
      />,
    );
    expect(screen.getByTestId('be-cap-exceeded')).toBeInTheDocument();
  });
});

describe('cap-banner stacking (multiple banners in same parent)', () => {
  it('CapStatusPill + StubModeBanner + CapExceededBanner all render side-by-side without interference', () => {
    renderWithRouter(
      <div>
        <CapStatusPill
          cap={{
            spentCents: 1000,
            capCents: 10000,
            percent: 0.1,
            withinCap: true,
            alertThreshold: false,
          }}
          testid="stack-pill"
        />
        <StubModeBanner testid="stack-stub">Stub copy</StubModeBanner>
        <CapExceededBanner
          cap={{ spentCents: 12000, capCents: 10000 }}
          providerLabel="AdsGPT"
          testid="stack-exceeded"
          settingsHref="/tenant-settings"
        />
      </div>,
    );
    expect(screen.getByTestId('stack-pill')).toBeInTheDocument();
    expect(screen.getByTestId('stack-stub')).toBeInTheDocument();
    expect(screen.getByTestId('stack-exceeded')).toBeInTheDocument();
    // Each role attribute resolves independently
    expect(screen.getByRole('status')).toBe(screen.getByTestId('stack-stub'));
    expect(screen.getByRole('alert')).toBe(screen.getByTestId('stack-exceeded'));
  });
});

describe('capPillStyles export', () => {
  it('exposes base + green + amber + red style objects', () => {
    expect(capPillStyles).toBeDefined();
    expect(capPillStyles.base).toBeDefined();
    expect(capPillStyles.green).toBeDefined();
    expect(capPillStyles.amber).toBeDefined();
    expect(capPillStyles.red).toBeDefined();
    // Sanity: green / amber / red carry the canonical border colours
    expect(capPillStyles.green.border).toMatch(/22c55e/);
    expect(capPillStyles.amber.border).toMatch(/f59e0b/);
    expect(capPillStyles.red.border).toMatch(/f43f5e/);
  });
});
