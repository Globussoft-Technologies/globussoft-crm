/**
 * Landing.test.jsx — vitest + RTL coverage for the public marketing landing
 * page (the unauthenticated `/` shell that's served by Nginx + React Router
 * before any auth gate fires).
 *
 * SUT: frontend/src/pages/Landing.jsx (229 LOC, was previously untested at
 *      the page level; closes the test-coverage gap).
 *
 * Scope — pure static-surface pin. Landing.jsx is presentational only:
 *   - No `useEffect` / no API calls / no state.
 *   - No `useNotify` / `fetchApi` / `useNavigate` consumption.
 *   - Just `<Link>` from react-router-dom + a fixed FEATURES / MODULES /
 *     SCREENSHOTS array iterated into the DOM.
 *
 * Cases pinned here:
 *   1. Smoke render — `<Landing />` mounts inside `<MemoryRouter>` without
 *      throwing.
 *   2. Hero CTAs — both the "Start Free Trial" link (→ /signup) and the
 *      "Explore Features" anchor (→ #features) are present in the hero.
 *   3. Hero stats row — the 4 stat tiles (25+ Modules, 313 E2E Tests,
 *      30+ API Endpoints, 100% Pass Rate) all render.
 *   4. Features section — every entry in the FEATURES array (Agent
 *      Assignment, Agent-wise Reports, Detailed Reports + Download, Auto
 *      Email Reports, AI Lead Scoring, Drag-Drop Pipeline) has its title
 *      rendered as a heading.
 *   5. Modules pill row — the MODULES array (30 modules incl. Dashboard,
 *      Pipeline (Kanban), CPQ Builder, Softphone) all render as pills.
 *   6. Internal nav links — `<Link to="/login">`, `<Link to="/signup">`,
 *      `<Link to="/pricing">`, `<Link to="/portal">` all resolve to the
 *      correct href on the rendered anchor.
 *   7. CTA tail-section — the bottom CTA's "Get Started Free" + "View
 *      Pricing" links are present and resolve to /signup and /pricing.
 *   8. Footer copyright + branding — the &copy; 2026 Globussoft line and
 *      the "Globus CRM" wordmark both render (latter appears in nav AND
 *      footer → uses `getAllByText` per the 2026-05-23 standing rule).
 *   9. Idempotent re-render — re-rendering the same `<Landing />` element
 *      under a fresh `<MemoryRouter>` doesn't throw and still shows the
 *      hero headline.
 *
 * Per the 2026-05-23 standing rule on stable mock refs: Landing.jsx has
 * no hooks to mock, so no `useNotify` / `fetchApi` stubs are needed. The
 * only mock surface is `<MemoryRouter>` wrapping for `<Link>`.
 *
 * Drift / known-bug discipline: if any assertion catches a real bug, the
 * test is marked `it.skip()` with a TODO referencing a GH issue filed via
 * `gh issue create` (no source-file edits in this scope).
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Landing from '../pages/Landing';

function renderLanding() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Landing />
    </MemoryRouter>
  );
}

describe('Landing (public marketing page)', () => {
  it('smoke: renders without crashing inside MemoryRouter', () => {
    const { container } = renderLanding();
    expect(container.firstChild).toBeTruthy();
  });

  it('renders the hero headline + primary CTA + secondary CTA', () => {
    renderLanding();
    // Hero copy is split across <br /> tags, so each fragment renders
    // as its own text node — match the most stable one.
    expect(screen.getByText(/Close more deals\./i)).toBeInTheDocument();
    expect(screen.getByText(/Know every customer\./i)).toBeInTheDocument();
    expect(screen.getByText(/Powered by AI\./i)).toBeInTheDocument();

    // Primary hero CTA → /signup
    const startFreeTrial = screen.getByRole('link', { name: /Start Free Trial/i });
    expect(startFreeTrial).toHaveAttribute('href', '/signup');

    // Secondary hero CTA — anchor to #features (an `<a href>`, not a Link)
    const exploreFeatures = screen.getByRole('link', { name: /Explore Features/i });
    expect(exploreFeatures).toHaveAttribute('href', '#features');
  });

  it('renders the hero stats row (4 tiles)', () => {
    renderLanding();
    // Each stat = number + label rendered separately. Pin labels (more
    // stable than numbers, which marketing copy may bump).
    expect(screen.getByText('25+')).toBeInTheDocument();
    expect(screen.getByText('313')).toBeInTheDocument();
    expect(screen.getByText('30+')).toBeInTheDocument();
    expect(screen.getByText('100%')).toBeInTheDocument();

    // "Modules" label appears in stats row AND in the section header
    // ("25+ Integrated Modules") — use getAllByText.
    expect(screen.getAllByText(/Modules/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('E2E Tests')).toBeInTheDocument();
    expect(screen.getByText('API Endpoints')).toBeInTheDocument();
    expect(screen.getByText('Pass Rate')).toBeInTheDocument();
  });

  it('renders every FEATURES entry as a section heading', () => {
    renderLanding();
    const expectedFeatures = [
      'Agent Assignment',
      'Agent-wise Reports',
      'Detailed Reports + Download',
      'Auto Email Reports',
      'AI Lead Scoring',
      'Drag-Drop Pipeline',
    ];
    for (const title of expectedFeatures) {
      expect(screen.getByRole('heading', { name: title })).toBeInTheDocument();
    }
  });

  it('renders the MODULES pill row (all 30 modules)', () => {
    renderLanding();
    const expectedModules = [
      'Dashboard', 'Pipeline (Kanban)', 'Contacts 360', 'Leads', 'Clients',
      'Agent Reports', 'BI Analytics', 'Auto Email Reports', 'AI Lead Scoring',
      'Sequences', 'Workflows', 'Inbox', 'Marketing', 'Invoices', 'Estimates',
      'Expenses', 'Contracts', 'CPQ Builder', 'Projects', 'Task Queue',
      'Tickets', 'Support', 'App Builder', 'Developer Portal', 'Staff / RBAC',
      'Notifications', 'Audit Log', 'CSV Import', 'Softphone', 'Command Palette',
    ];
    // Some module labels (Dashboard, Auto Email Reports, AI Lead Scoring,
    // Sequences) also appear elsewhere on the page (footer / features /
    // section text). Use getAllByText and assert ≥1 match per label.
    for (const m of expectedModules) {
      expect(screen.getAllByText(m).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('renders internal Link nav targets with correct href attributes', () => {
    renderLanding();
    // /signup appears 3× (navbar "Get Started Free", hero "Start Free
    // Trial", CTA tail "Get Started Free", footer "Sign Up"). All anchors
    // must point at /signup.
    const signupLinks = screen.getAllByRole('link').filter(a => a.getAttribute('href') === '/signup');
    expect(signupLinks.length).toBeGreaterThanOrEqual(3);

    // /login appears 2× (navbar Login, footer Login).
    const loginLinks = screen.getAllByRole('link').filter(a => a.getAttribute('href') === '/login');
    expect(loginLinks.length).toBeGreaterThanOrEqual(2);

    // /pricing appears 3× (navbar Pricing, CTA "View Pricing", footer Pricing).
    const pricingLinks = screen.getAllByRole('link').filter(a => a.getAttribute('href') === '/pricing');
    expect(pricingLinks.length).toBeGreaterThanOrEqual(3);

    // /portal appears 1× (footer Support Portal).
    const portalLinks = screen.getAllByRole('link').filter(a => a.getAttribute('href') === '/portal');
    expect(portalLinks.length).toBe(1);
  });

  it('renders the bottom CTA section with /signup + /pricing links', () => {
    renderLanding();
    expect(
      screen.getByRole('heading', { name: /Ready to transform your sales process\?/i })
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Start your free trial today\. No credit card required\./i)
    ).toBeInTheDocument();

    // "Get Started Free" appears in navbar + CTA tail — both should
    // resolve to /signup.
    const getStartedFreeLinks = screen.getAllByRole('link', { name: /Get Started Free/i });
    expect(getStartedFreeLinks.length).toBeGreaterThanOrEqual(2);
    for (const link of getStartedFreeLinks) {
      expect(link).toHaveAttribute('href', '/signup');
    }

    // "View Pricing" is unique to the CTA tail.
    const viewPricing = screen.getByRole('link', { name: /View Pricing/i });
    expect(viewPricing).toHaveAttribute('href', '/pricing');
  });

  it('renders the footer with copyright + branding (wordmark appears 2× per nav + footer)', () => {
    renderLanding();
    // © 2026 line. Use a regex because the `&copy;` entity gets resolved
    // to the literal `©` character at render time.
    expect(
      screen.getByText(/2026 Globussoft Technologies\. All rights reserved\./)
    ).toBeInTheDocument();

    // "Globus" wordmark text appears in navbar AND footer — must use
    // getAllByText per the standing rule on duplicate labels.
    const globusMarks = screen.getAllByText(/^Globus\s*$/);
    expect(globusMarks.length).toBeGreaterThanOrEqual(2);

    // "CRM" sibling of the wordmark appears in navbar AND footer.
    const crmMarks = screen.getAllByText('CRM');
    expect(crmMarks.length).toBeGreaterThanOrEqual(2);

    // Footer product / account column headers.
    expect(screen.getByText(/^Product$/)).toBeInTheDocument();
    expect(screen.getByText(/^Account$/)).toBeInTheDocument();
  });

  it('re-rendering under a fresh MemoryRouter is idempotent (no errors, hero still visible)', () => {
    const { unmount } = renderLanding();
    unmount();
    // Fresh tree, fresh router — should mount cleanly.
    renderLanding();
    expect(screen.getByText(/Close more deals\./i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Start Free Trial/i })).toBeInTheDocument();
  });
});
