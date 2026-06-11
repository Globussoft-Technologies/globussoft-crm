/**
 * Landing.test.jsx — vitest + RTL coverage for the public marketing landing
 * page (the unauthenticated `/` shell that's served by Nginx + React Router
 * before any auth gate fires).
 *
 * SUT: frontend/src/pages/Landing.jsx
 *
 * Scope — pure static-surface pin. Landing.jsx is presentational only:
 *   - No `useEffect` / no API calls / no state.
 *   - No `useNotify` / `fetchApi` / `useNavigate` consumption.
 *   - Just `<Link>` from react-router-dom + fixed FEATURES / MODULES arrays.
 *
 * Cases pinned here:
 *   1. Smoke render — `<Landing />` mounts inside `<MemoryRouter>` without
 *      throwing.
 *   2. Hero CTAs — "Start Free Trial" (→ /get-started) and "Explore Features"
 *      anchor (→ #features) are present in the hero.
 *   3. Hero stats row — the 4 stat tiles (25+ Modules, 313 E2E Tests,
 *      30+ API Endpoints, 100% Pass Rate) all render.
 *   4. Features section — every entry in the FEATURES array renders as a
 *      heading.
 *   5. Modules pill row — the MODULES array (30 modules) all render.
 *   6. Internal nav links — `/get-started`, `/login`, `/pricing`, `/portal`
 *      resolve to the correct href.
 *   7. CTA tail-section — "Get Started Free" (→ /get-started) and
 *      "View Pricing" (→ /pricing) links are present.
 *   8. Footer copyright + branding — the © 2026 Globussoft line and the
 *      "Globus CRM" logo (image alt) render in both nav and footer.
 *   9. Idempotent re-render — re-rendering under a fresh `<MemoryRouter>`
 *      doesn't throw and still shows the hero headline.
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
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
    expect(screen.getByText(/Close more deals\./i)).toBeInTheDocument();
    expect(screen.getByText(/Know every customer\./i)).toBeInTheDocument();
    expect(screen.getByText(/Powered by AI\./i)).toBeInTheDocument();

    // Primary hero CTA → /get-started
    const startFreeTrial = screen.getByRole('link', { name: /Start Free Trial/i });
    expect(startFreeTrial).toHaveAttribute('href', '/get-started');

    // Secondary hero CTA — anchor to #features
    const exploreFeatures = screen.getByRole('link', { name: /Explore Features/i });
    expect(exploreFeatures).toHaveAttribute('href', '#features');
  });

  it('renders the hero stats row (4 tiles)', () => {
    renderLanding();
    expect(screen.getByText('25+')).toBeInTheDocument();
    expect(screen.getByText('313')).toBeInTheDocument();
    expect(screen.getByText('30+')).toBeInTheDocument();
    expect(screen.getByText('100%')).toBeInTheDocument();

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
    for (const m of expectedModules) {
      expect(screen.getAllByText(m).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('renders internal Link nav targets with correct href attributes', () => {
    renderLanding();
    // /get-started appears in navbar, hero, CTA tail, footer Sign Up.
    const getStartedLinks = screen.getAllByRole('link').filter(a => a.getAttribute('href') === '/get-started');
    expect(getStartedLinks.length).toBeGreaterThanOrEqual(3);

    // /login appears in navbar + footer.
    const loginLinks = screen.getAllByRole('link').filter(a => a.getAttribute('href') === '/login');
    expect(loginLinks.length).toBeGreaterThanOrEqual(2);

    // /pricing appears in navbar, CTA tail, footer.
    const pricingLinks = screen.getAllByRole('link').filter(a => a.getAttribute('href') === '/pricing');
    expect(pricingLinks.length).toBeGreaterThanOrEqual(3);

    // /portal appears 1× (footer Support Portal).
    const portalLinks = screen.getAllByRole('link').filter(a => a.getAttribute('href') === '/portal');
    expect(portalLinks.length).toBe(1);
  });

  it('renders the bottom CTA section with /get-started + /pricing links', () => {
    renderLanding();
    expect(
      screen.getByRole('heading', { name: /Ready to transform your sales process\?/i })
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Start your free trial today\. No credit card required\./i)
    ).toBeInTheDocument();

    const getStartedFreeLinks = screen.getAllByRole('link', { name: /Get Started Free/i });
    expect(getStartedFreeLinks.length).toBeGreaterThanOrEqual(1);
    for (const link of getStartedFreeLinks) {
      expect(link).toHaveAttribute('href', '/get-started');
    }

    const viewPricing = screen.getByRole('link', { name: /View Pricing/i });
    expect(viewPricing).toHaveAttribute('href', '/pricing');
  });

  it('renders the footer with copyright + logo branding', () => {
    renderLanding();
    expect(
      screen.getByText(/2026 Globussoft Technologies\. All rights reserved\./)
    ).toBeInTheDocument();

    // Logo image renders in nav and footer with alt "Globus CRM".
    const logos = screen.getAllByAltText('Globus CRM');
    expect(logos.length).toBeGreaterThanOrEqual(2);

    // Footer column headers.
    expect(screen.getByText(/^Product$/)).toBeInTheDocument();
    expect(screen.getByText(/^Account$/)).toBeInTheDocument();
  });

  it('re-rendering under a fresh MemoryRouter is idempotent (no errors, hero still visible)', () => {
    const { unmount } = renderLanding();
    unmount();
    renderLanding();
    expect(screen.getByText(/Close more deals\./i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Start Free Trial/i })).toBeInTheDocument();
  });
});
