/**
 * QuotesComingSoon.test.jsx -- vitest + RTL coverage for the tactical
 * /quotes stub page at frontend/src/pages/QuotesComingSoon.jsx.
 *
 * The SUT is a pure-render stub (NO fetchApi, NO useNotify, NO useApi, NO
 * AuthContext consumption, NO navigation handlers — just two static
 * <Link> CTAs and a lucide-react FileText icon). Its contract is small
 * but load-bearing — once the full Quotes module ships under cluster B2
 * of docs/MANUAL_CODING_BACKLOG.md, this page will be replaced and the
 * test will need to be retired (or moved to a Quotes-feature suite).
 *
 * Pinned contract (what the page MUST render today)
 * -------------------------------------------------
 *   1. An h1 reading "Quotes — coming soon" (load-bearing heading; the
 *      sidebar "Quotes" link routes here and users see this title).
 *   2. Two paragraphs of explanatory copy — the "dedicated Quotes module"
 *      sentence + the "use Estimates / attach pricing to a Deal" sentence.
 *   3. A FileText icon (lucide-react) — visually anchors the page as a
 *      placeholder; assert presence by querying for the SVG by role
 *      img or by class-name fallback (lucide renders <svg> with class
 *      lucide-file-text).
 *   4. Two CTA <Link>s:
 *        - "Go to Estimates" -> href="/estimates"
 *        - "Open Pipeline"   -> href="/pipeline"
 *      Both are <Link to=...> from react-router-dom, which renders as
 *      <a href=...> when wrapped in a Router. MemoryRouter wrap is the
 *      canonical approach in this suite (mirrors PaymentSuccess.test).
 *
 * Mocking strategy
 * ----------------
 *   - react-router-dom: real MemoryRouter wraps the SUT so the two
 *     <Link> elements resolve to real <a href> tags. No useNavigate /
 *     useLocation in the SUT, so no further mocking required.
 *   - No fake timers, no userEvent, no async — the page is fully static.
 *
 * Drift pinned (prompt vs. actual SUT)
 * ------------------------------------
 *   - Prompt anticipated "icon presence" assertion. REALITY: lucide-react
 *     renders FileText as an inline <svg> with class "lucide lucide-file-text"
 *     and NO aria-label, so getByRole('img') won't find it (svg defaults
 *     to role=img only with aria-label). The reliable handle is the
 *     class-selector or container.querySelector('svg'). Pinning via
 *     querySelector to stay robust against future lucide minor-version
 *     class-name renames (which have happened historically — the class
 *     was "feather feather-file-text" in pre-v0.x lucide).
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import QuotesComingSoon from '../pages/QuotesComingSoon';

function renderQuotesComingSoon() {
  return render(
    <MemoryRouter initialEntries={['/quotes']}>
      <QuotesComingSoon />
    </MemoryRouter>,
  );
}

describe('<QuotesComingSoon /> -- tactical /quotes stub (BUG-T24 / #886)', () => {
  it('renders the load-bearing h1 "Quotes — coming soon" heading', () => {
    renderQuotesComingSoon();
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.textContent).toMatch(/Quotes/i);
    expect(heading.textContent).toMatch(/coming soon/i);
  });

  it('renders the explanatory subheading copy about the dedicated module + alternatives', () => {
    renderQuotesComingSoon();
    // First paragraph — describes what's under development.
    expect(
      screen.getByText(/dedicated Quotes module/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/line items, tax, discount, PDF export/i),
    ).toBeInTheDocument();
    // Second paragraph — points users to Estimates + Deal pricing as
    // interim alternatives. Use a partial regex because the copy is
    // wrapped in <strong> tags so a literal-equality match fails.
    expect(screen.getByText(/In the meantime, use/i)).toBeInTheDocument();
  });

  it('renders both CTAs with the expected visible labels', () => {
    renderQuotesComingSoon();
    // Each CTA is a <Link>, which renders as <a> under MemoryRouter, so
    // getByRole('link', { name }) is the canonical handle.
    expect(
      screen.getByRole('link', { name: /Go to Estimates/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Open Pipeline/i }),
    ).toBeInTheDocument();
  });

  it('the "Go to Estimates" CTA targets href="/estimates"', () => {
    renderQuotesComingSoon();
    const link = screen.getByRole('link', { name: /Go to Estimates/i });
    expect(link.getAttribute('href')).toBe('/estimates');
  });

  it('the "Open Pipeline" CTA targets href="/pipeline"', () => {
    renderQuotesComingSoon();
    const link = screen.getByRole('link', { name: /Open Pipeline/i });
    expect(link.getAttribute('href')).toBe('/pipeline');
  });

  it('renders the FileText lucide-react icon (visual placeholder anchor)', () => {
    const { container } = renderQuotesComingSoon();
    // lucide-react renders an inline <svg> with class "lucide-file-text"
    // (plus the generic "lucide" wrapper class). Querying by class is
    // robust against the no-aria-label nature of lucide svgs.
    const icon = container.querySelector('svg.lucide-file-text');
    expect(icon).not.toBeNull();
  });

  it('renders an ArrowRight icon inside each CTA (visual "go forward" cue)', () => {
    const { container } = renderQuotesComingSoon();
    // Both CTA links use <ArrowRight size={16} />. lucide-react renders
    // these as <svg class="lucide-arrow-right"> inside the <a> tag.
    const arrows = container.querySelectorAll('svg.lucide-arrow-right');
    // One arrow per CTA — pin at exactly 2.
    expect(arrows.length).toBe(2);
  });

  it('renders exactly two CTAs (no third link sneaks in unnoticed)', () => {
    renderQuotesComingSoon();
    // Pin the total link count so a future edit that adds a third CTA
    // forces an intentional test update rather than landing silently.
    const links = screen.getAllByRole('link');
    expect(links.length).toBe(2);
  });
});
