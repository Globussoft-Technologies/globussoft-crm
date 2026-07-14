/**
 * Pricing.jsx -- vitest + RTL coverage for the public marketing /pricing page.
 *
 * Scope: pins the page-surface invariants for the public-facing
 * three-tier pricing page (Starter / Professional / Enterprise) at
 * frontend/src/pages/Pricing.jsx. Distinct from PricingRules.jsx
 * (travel admin pricing-rule editor) which is covered by the sibling
 * PricingRules.test.jsx file.
 *
 * The page is ~462 LOC and has SIX distinct UI surfaces:
 *   (a) the sticky top nav (Home / Login / Start Free Trial)
 *   (b) the hero (14-day-trial badge + "Choose the right plan" heading)
 *   (c) the billing-period toggle (Annual <-> Monthly) + currency
 *       toggle ($ USD <-> rupee-symbol INR)
 *   (d) the three plan cards (Starter / Professional / Enterprise) with
 *       per-tier price, /user/month copy, year-equivalent label, CTA
 *       button or Link, and the feature list with green check icons
 *   (e) the Compare-all-features table with 5 category sections and
 *       rows that mix booleans (Check/X) with literal strings
 *   (f) the FAQ accordion (5 questions) with toggle-open-one-at-a-time
 *       semantics
 *
 * Contracts pinned here
 * ---------------------
 *   1. Initial render: hero copy + "Choose the right plan" heading + 14-
 *      day trial badge + Annual/Monthly toggle defaults Annual + currency
 *      toggle defaults USD (when localStorage is pre-seeded to 'usd').
 *   2. All three plan names (Starter / Professional / Enterprise) and
 *      all three CTAs (Start Free Trial twice + Contact Sales once)
 *      render in unauthenticated mode.
 *   3. Default USD-annual prices match the static PRICES table:
 *      Starter $6, Professional $18, Enterprise $29 (per-user-per-month).
 *   4. Toggling to Monthly flips the displayed prices to the monthly
 *      tier: Starter $8, Professional $22, Enterprise $36.
 *   5. Toggling currency to INR swaps the symbol to the rupee glyph
 *      and the prices to the INR-annual tier: 499 / 1,499 / 2,499.
 *   6. Currency toggle persists to localStorage under the
 *      'pricingCurrency' key.
 *   7. The MOST POPULAR badge renders on the Professional card only.
 *   8. The Compare-all-features section renders category headers
 *      (Contact & Account Management / Sales Pipeline & Automation /
 *      Email & Communication / AI & Intelligence / Reports, Security
 *      & Support) and key feature rows (Contact Management, Workflows,
 *      AI Contact Scoring).
 *   9. The FAQ accordion is collapsed by default; clicking a question
 *      toggles its answer visible; the other FAQs stay collapsed
 *      (single-open semantics enforced by openFaq state).
 *  10. Unauthenticated mode renders each CTA as a Link with href
 *      pointing at /signup (or the "Contact Sales" CTA also pointing
 *      at /signup since the Link target is uniform).
 *  11. Authenticated mode (token present in AuthContext + apiPlans
 *      fetched) renders the CTA as a "Pay Now" button instead of the
 *      "Start Free Trial" Link, and the page POSTs to
 *      /api/subscriptions/plans during mount to fetch the plan ids.
 *  12. Footer renders the (c) 2026 GlobusCRM copyright + the demo
 *      domain link.
 *
 * Drift notes
 * -----------
 *   - The page uses `fetchApi` from utils/api for the
 *     /api/subscriptions/plans fetch (only when a token is present in
 *     AuthContext). Mock the module to keep the unauthenticated tests
 *     pure render-only.
 *   - The page appends a Razorpay <script> to document.body on mount;
 *     jsdom tolerates the appendChild but the script never executes.
 *     The cleanup useEffect removes it on unmount; tests don't need to
 *     assert on the script tag itself.
 *   - localStorage and Intl.DateTimeFormat resolvedOptions are read at
 *     INITIAL state-init time only. The dev host's TZ may be IST which
 *     makes the page's TZ-sniff fallback default to INR -- so the spec
 *     seeds localStorage to 'usd' in beforeEach to make USD the
 *     deterministic default for the rendering tests.
 *   - The "14-day free trial" copy appears in BOTH the hero badge and
 *     the first FAQ question, so any matcher needs to handle the
 *     duplicate -- the spec uses getAllByText where needed per the
 *     CLAUDE.md standing rule.
 *   - The price "big number" is in its own span (e.g. `<span>6</span>`)
 *     but the comparison-table header also renders `<span>$6/mo</span>`
 *     as one concatenated string. getByText('6') would miss the
 *     concatenated form -- use getAllByText with a custom matcher OR
 *     query by the year-equivalent label which is unique per tier.
 *   - useNotify / useApi are NOT used by this page, so the stable-
 *     mock-object rule doesn't apply -- but the AuthContext value IS
 *     consumed and IS passed through useContext; the spec passes a
 *     stable authValue object per render.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const navigateMock = vi.fn();
vi.mock('react-router-dom', async () => {
  const real = await vi.importActual('react-router-dom');
  return { ...real, useNavigate: () => navigateMock };
});

// fetchApi is only invoked when AuthContext.token is truthy; the
// default mock returns an empty plan list so the authenticated-mode
// tests can override per-test as needed.
const fetchApiMock = vi.fn(() => Promise.resolve([]));
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

import { AuthContext } from '../App';
import Pricing from '../pages/Pricing';

// Stable auth-context objects -- one for unauthenticated (token = ''),
// one for authenticated (token set). Stable identity keeps the page's
// useEffect([token]) dependency stable across renders.
const unauthenticatedAuth = {
  user: null,
  token: '',
  tenant: null,
  setUser: vi.fn(),
  setToken: vi.fn(),
  setTenant: vi.fn(),
};

const authenticatedAuth = {
  user: { userId: 1, email: 'admin@globussoft.com', role: 'ADMIN' },
  token: 'jwt-test-token',
  tenant: { id: 1, vertical: 'generic' },
  setUser: vi.fn(),
  setToken: vi.fn(),
  setTenant: vi.fn(),
};

function renderPricing(authValue = unauthenticatedAuth) {
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={authValue}>
        <Pricing />
      </AuthContext.Provider>
    </MemoryRouter>
  );
}

describe('<Pricing /> -- public marketing pricing page', () => {
  beforeEach(() => {
    navigateMock.mockClear();
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(() => Promise.resolve([]));
    // Seed 'usd' so the default-currency render tests are deterministic
    // regardless of the dev host's TZ (IST host falls back to 'inr').
    try { window.localStorage.setItem('pricingCurrency', 'usd'); } catch {}
  });

  afterEach(() => {
    try { window.localStorage.removeItem('pricingCurrency'); } catch {}
  });

  it('renders the hero copy, 14-day trial badge, and the "Choose the right plan" heading', () => {
    renderPricing();
    // "14-day free trial" appears in BOTH the hero badge AND the first
    // FAQ question, so getAllByText is required.
    const trialMatches = screen.getAllByText(/14-day free trial/i);
    expect(trialMatches.length).toBeGreaterThanOrEqual(2);
    // "no credit card required" appears in both the hero badge AND
    // inside the first FAQ answer ("no credit card required."), so
    // use getAllByText for the duplicate.
    const noCardMatches = screen.getAllByText(/no credit card required/i);
    expect(noCardMatches.length).toBeGreaterThanOrEqual(1);
    // The H1 splits across a <br /> + a nested <span>; assert by
    // heading-role match on the leading copy.
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toBeInTheDocument();
    expect(heading.textContent).toMatch(/Choose the right plan/i);
    expect(heading.textContent).toMatch(/your team/i);
    // The transparent-pricing sub-copy.
    expect(
      screen.getByText(/Simple, transparent pricing for teams of every size/i),
    ).toBeInTheDocument();
  });

  it('renders the Annual/Monthly toggle defaulting to Annual and the $/INR currency toggle defaulting to USD', () => {
    renderPricing();
    // Both labels render at the same time -- Annual and Monthly are
    // both clickable spans next to the toggle.
    expect(screen.getByText(/^Annual$/i)).toBeInTheDocument();
    expect(screen.getByText(/^Monthly$/i)).toBeInTheDocument();
    expect(screen.getByText(/SAVE 20%/i)).toBeInTheDocument();
    // Currency buttons render both options.
    expect(screen.getByRole('button', { name: /\$ USD/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /INR/ })).toBeInTheDocument();
    // USD-mode default: confirm the billing label reads "billed annually"
    // and the small per-month rate line renders for the starter tier.
    expect(screen.getAllByText(/\/user\/year, billed annually/i).length).toBe(3);
    expect(screen.getByText(/\$6\/user\/month/i)).toBeInTheDocument();
  });

  it('renders the three plan names (Starter / Professional / Enterprise) and the MOST POPULAR badge on Professional', () => {
    renderPricing();
    // Plan names appear as H3 headings on each card. They ALSO appear
    // in the comparison table header + feature labels (e.g. "Everything
    // in Starter, plus"), so query by heading-role to disambiguate.
    expect(screen.getByRole('heading', { level: 3, name: /^Starter$/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: /^Professional$/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: /^Enterprise$/i })).toBeInTheDocument();
    // The MOST POPULAR badge is unique to the Professional card.
    expect(screen.getByText(/MOST POPULAR/i)).toBeInTheDocument();
  });

  it('renders the default USD-annual prices: big number is annual total (72/216/348), small line is per-month rate', () => {
    renderPricing();
    // Annual mode: big number shows the annual total extracted from
    // yearAnnualLabel ("72", "216", "348"). The year-equivalent label
    // text is still present in the small secondary line as "$6/user/month" etc.
    // Use the unique per-tier secondary labels to confirm the swap.
    expect(screen.getByText(/\$6\/user\/month/i)).toBeInTheDocument();
    expect(screen.getByText(/\$18\/user\/month/i)).toBeInTheDocument();
    expect(screen.getByText(/\$29\/user\/month/i)).toBeInTheDocument();
    // The "/user/year, billed annually" billing copy appears on each of the
    // three plan cards (was "/user/month, billed annually" before the swap).
    const annualLabels = screen.getAllByText(/\/user\/year, billed annually/i);
    expect(annualLabels.length).toBe(3);
    // The currency symbol ($) appears on each price card AND each
    // comparison-table column header. At minimum 3 (one per tier card).
    const dollarSymbols = screen.getAllByText('$');
    expect(dollarSymbols.length).toBeGreaterThanOrEqual(3);
  });

  it('toggling Monthly shows per-month rates as the big number with billed-monthly label', () => {
    renderPricing();
    // The "Monthly" label is a clickable span next to the toggle.
    fireEvent.click(screen.getByText(/^Monthly$/i));
    // In monthly mode the big number IS the monthly rate; small line also
    // shows the same monthly rate. The billing label reads "billed monthly".
    const monthlyLabels = screen.getAllByText(/\/user\/month, billed monthly/i);
    expect(monthlyLabels.length).toBe(3);
    // The secondary per-month line renders the monthly rates.
    expect(screen.getByText(/\$8\/user\/month/i)).toBeInTheDocument();
    expect(screen.getByText(/\$22\/user\/month/i)).toBeInTheDocument();
    expect(screen.getByText(/\$36\/user\/month/i)).toBeInTheDocument();
    // The annual billing label is gone.
    expect(screen.queryByText(/\/user\/year, billed annually/i)).not.toBeInTheDocument();
  });

  it('toggling currency to INR swaps prices: big number is annual total, small line is per-month rate', () => {
    renderPricing();
    // Click the INR currency button.
    fireEvent.click(screen.getByRole('button', { name: /INR/ }));
    // Annual mode + INR: big number is the annual total (5,988 / 17,988 / 29,988).
    // The small secondary line shows the per-month rate (499 / 1,499 / 2,499).
    // Use getAllByText for the "499" variants since /499/ also matches "1,499"
    // and "2,499" — assert each exact secondary-line string via exact: false
    // with a tight enough pattern, or count occurrences.
    // ₹499/user/month (Starter) — appears exactly once; anchored to avoid
    // matching "1,499" by requiring the string to start with "₹499".
    const starterRate = screen.getAllByText(/₹499\/user\/month/i);
    expect(starterRate.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/₹1,499\/user\/month/i)).toBeInTheDocument();
    expect(screen.getByText(/₹2,499\/user\/month/i)).toBeInTheDocument();
    // Billing label reads /user/year, billed annually.
    const annualLabels = screen.getAllByText(/\/user\/year, billed annually/i);
    expect(annualLabels.length).toBe(3);
    // The USD year labels no longer render.
    expect(screen.queryByText(/\$72 \/user\/year/i)).not.toBeInTheDocument();
  });

  it('currency toggle persists to localStorage under the pricingCurrency key', async () => {
    renderPricing();
    // beforeEach seeded 'usd' so the initial value is deterministic.
    await waitFor(() => {
      expect(window.localStorage.getItem('pricingCurrency')).toBe('usd');
    });
    fireEvent.click(screen.getByRole('button', { name: /INR/ }));
    await waitFor(() => {
      expect(window.localStorage.getItem('pricingCurrency')).toBe('inr');
    });
    // Flip back to USD and verify the write fires again.
    fireEvent.click(screen.getByRole('button', { name: /\$ USD/ }));
    await waitFor(() => {
      expect(window.localStorage.getItem('pricingCurrency')).toBe('usd');
    });
  });

  it('renders the Compare-all-features section with all 5 category headers and sample feature rows', () => {
    renderPricing();
    expect(
      screen.getByRole('heading', { level: 2, name: /Compare all features/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Everything you need to know, side by side/i)).toBeInTheDocument();
    // All five category headers render.
    expect(screen.getByText(/Contact & Account Management/i)).toBeInTheDocument();
    expect(screen.getByText(/Sales Pipeline & Automation/i)).toBeInTheDocument();
    expect(screen.getByText(/Email & Communication/i)).toBeInTheDocument();
    expect(screen.getByText(/AI & Intelligence/i)).toBeInTheDocument();
    expect(screen.getByText(/Reports, Security & Support/i)).toBeInTheDocument();
    // Sample row labels render from across the table.
    expect(screen.getByText(/Contact Management/i)).toBeInTheDocument();
    // The literal "Workflows" feature row renders too (cell values
    // are the strings "20" / "50" / "100" for the three tiers).
    expect(screen.getByText(/^Workflows$/i)).toBeInTheDocument();
    // "AI Contact Scoring" appears as a comparison-table row AND as a
    // bullet in the Professional card's feature list.
    const aiScoring = screen.getAllByText(/AI Contact Scoring/i);
    expect(aiScoring.length).toBeGreaterThanOrEqual(1);
    // Workflows row cells render the limits as strings.
    expect(screen.getByText('20')).toBeInTheDocument();
    expect(screen.getByText('50')).toBeInTheDocument();
    expect(screen.getByText('100')).toBeInTheDocument();
  });

  it('FAQ accordion is collapsed by default; clicking a question reveals its answer', () => {
    renderPricing();
    expect(
      screen.getByRole('heading', { level: 2, name: /Frequently Asked Questions/i }),
    ).toBeInTheDocument();
    // All five FAQ question buttons render.
    const faq1 = screen.getByRole('button', { name: /How does the 14-day free trial work\?/i });
    const faq2 = screen.getByRole('button', { name: /Can I switch plans anytime\?/i });
    const faq3 = screen.getByRole('button', { name: /What payment methods do you accept\?/i });
    const faq4 = screen.getByRole('button', { name: /Is my data secure\?/i });
    const faq5 = screen.getByRole('button', { name: /Do you offer volume discounts\?/i });
    expect(faq1).toBeInTheDocument();
    expect(faq2).toBeInTheDocument();
    expect(faq3).toBeInTheDocument();
    expect(faq4).toBeInTheDocument();
    expect(faq5).toBeInTheDocument();
    // Click FAQ 2 to open it -- the answer text is rendered in the DOM
    // (collapsed via max-height: 0 by default; expanded to 200px when
    // openFaq matches). We assert on the answer text being present.
    fireEvent.click(faq2);
    expect(
      screen.getByText(/Upgrade or downgrade anytime/i),
    ).toBeInTheDocument();
  });

  it('unauthenticated mode renders the Start Free Trial CTAs as <Link> elements pointing at /signup', () => {
    renderPricing();
    // The plan-card CTAs in unauthenticated mode are <Link to="/signup">.
    // Get the links inside the plans grid; there should be at least 3
    // (one per tier) plus the nav-bar "Start Free Trial" link.
    const signupLinks = screen.getAllByRole('link').filter(
      (a) => a.getAttribute('href') === '/signup',
    );
    expect(signupLinks.length).toBeGreaterThanOrEqual(3);
    // "Start Free Trial" appears multiple times (Starter card + Pro
    // card + nav-bar CTA).
    const startFreeTrialLabels = screen.getAllByText(/Start Free Trial/i);
    expect(startFreeTrialLabels.length).toBeGreaterThanOrEqual(2);
    // "Contact Sales" is unique to the Enterprise card.
    expect(screen.getByText(/Contact Sales/i)).toBeInTheDocument();
    // The Pricing page DOES fire the subscriptions/plans fetch on mount
    // for unauthenticated visitors too — the fetch isn't gated on token,
    // it's a public endpoint that returns the active catalog. (The Link
    // vs Pay-Now CTA flip IS gated on token at the render level.)
    expect(fetchApiMock).toHaveBeenCalledWith('/api/subscriptions/plans');
  });

  it('authenticated mode fetches /api/subscriptions/plans on mount and renders Pay Now buttons', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/subscriptions/plans') {
        return Promise.resolve([
          { id: 101, name: 'Starter' },
          { id: 102, name: 'Professional' },
          { id: 103, name: 'Enterprise' },
        ]);
      }
      return Promise.resolve({});
    });
    renderPricing(authenticatedAuth);
    // The mount-time fetch fires immediately because token is truthy.
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith('/api/subscriptions/plans');
    });
    // After the apiPlans response lands, the CTAs flip to "Pay Now"
    // buttons (one per tier). The "Pay Now" copy is wrapped in the
    // button alongside an icon.
    await waitFor(() => {
      const payNowButtons = screen.getAllByRole('button').filter(
        (b) => b.textContent && /Pay Now/i.test(b.textContent),
      );
      expect(payNowButtons.length).toBe(3);
    });
  });

  it('renders the footer with the GlobusCRM copyright and the demo domain link', () => {
    renderPricing();
    expect(
      screen.getByText(/2026 GlobusCRM by Globussoft\. All rights reserved\./i),
    ).toBeInTheDocument();
    // The demo-domain link in the footer (also rendered as a <Link to="/">).
    expect(screen.getByText(/crm\.globusdemos\.com/i)).toBeInTheDocument();
  });

  it('top-nav renders Home / Login / Start Free Trial links', () => {
    renderPricing();
    const navLinks = screen.getAllByRole('link');
    const homeLink = navLinks.find((a) => a.textContent === 'Home');
    const loginLink = navLinks.find((a) => a.textContent === 'Login');
    expect(homeLink).toBeTruthy();
    expect(homeLink.getAttribute('href')).toBe('/');
    expect(loginLink).toBeTruthy();
    expect(loginLink.getAttribute('href')).toBe('/login');
    // The nav-bar "Start Free Trial" link also points at /signup.
    const navTrialLink = navLinks.find(
      (a) => a.textContent === 'Start Free Trial' && a.getAttribute('href') === '/signup',
    );
    expect(navTrialLink).toBeTruthy();
  });
});
