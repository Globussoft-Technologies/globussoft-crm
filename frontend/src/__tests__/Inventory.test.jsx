/**
 * Inventory.test.jsx — vitest + RTL coverage for the wellness-vertical
 * inventory landing page (frontend/src/pages/wellness/Inventory.jsx).
 *
 * Scope: pins the page-surface invariants for the wellness inventory route.
 * Inventory in the wellness vertical is intentionally per-patient (it's a
 * consumption ledger, not a warehouse SKU list) — implemented as the
 * `InventoryTab` inside `frontend/src/pages/wellness/PatientDetail.jsx`. This
 * page exists only because `/wellness/inventory` previously rendered a blank
 * page (issue #305) — it explains the model and routes users to the patient
 * list where the real per-patient inventory tab lives. Low-stock alerts on
 * consumables (needles, fillers, etc.) run on the daily `lowStockEngine` cron
 * and surface as Owner-Dashboard recommendation cards — also referenced here
 * so users searching for "low stock" land on a useful page.
 *
 * Test cases (5):
 *   1. Heading "Inventory" renders with the lucide-react Package icon.
 *   2. Explainer copy renders: per-patient ledger framing + 6-of-10 laser
 *      sessions example + "treatment plan tracks how many units" + the
 *      "<strong>per patient</strong>" emphasis.
 *   3. Ordered-list steps render in order: "Open <Patients>", "Select a
 *      patient", "Switch to the <Inventory> tab inside their detail view".
 *   4. Primary CTA: <Link to="/wellness/patients"> with label
 *      "Go to Patients" renders, wrapped in MemoryRouter (Link requires
 *      Router context).
 *   5. Tip box: low-stock alerts copy renders including `lowStockEngine` (as
 *      `<code>`) + Owner-Dashboard reference + "needles, fillers" examples.
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - SUT is a PURE static informational page — no fetch, no state, no
 *     useEffect, no AuthContext consumption. No fetchApi mock, no useNotify
 *     mock needed. (Verified against SUT lines 1-76 verbatim.)
 *   - MemoryRouter wrapper IS required: SUT line 2 imports `Link` from
 *     react-router-dom and line 42 renders `<Link to="/wellness/patients">`.
 *     Rendering without a Router context throws "useHref() may be used only
 *     in the context of a <Router> component."
 *
 * Drift pinned (prompt vs. actual SUT):
 *   - Prompt anticipated GET on mount, filter chrome, table layout, low-stock
 *     filter, stock-level display, last-receipt date, navigation to
 *     /wellness/inventory-adjustments + /wellness/inventory-receipts,
 *     adjust-stock inline action, RBAC, error handling. REALITY: SUT is a
 *     static informational placeholder — ZERO of these surfaces exist. The
 *     SUT is 76 lines including blank lines, with no useState, no useEffect,
 *     no fetch, no form, no table. The only outbound link is to
 *     /wellness/patients (not to inventory-adjustments / inventory-receipts).
 *     Scaled down from 8-13 cases to 5 to match what's actually rendered.
 *   - Prompt anticipated "fetchApi mocked via vi.mock('../utils/api'...)".
 *     REALITY: SUT does not import `utils/api`. Omitted the mock.
 *   - Prompt anticipated "useNotify stable mock object refs". REALITY: SUT
 *     does not import `utils/notify`. Omitted.
 *   - Prompt anticipated "AuthContext via real Provider wrapper IF SUT
 *     consumes it". CONFIRMED — SUT does NOT consume AuthContext. Omitted.
 *   - Prompt anticipated "navigation: links to /wellness/inventory-adjustments
 *     or /wellness/inventory-receipts (if SUT exposes them)". CONFIRMED NOT
 *     exposed — SUT only links to /wellness/patients (line 43). Case 4 pins
 *     the actual link target.
 *   - Prompt anticipated "Loading…" verbatim. REALITY: SUT has no loading
 *     state because it has no async work. Omitted.
 *   - Prompt anticipated "empty-state: zero products → empty-state UI".
 *     REALITY: there are no products in this SUT at all — the page is itself
 *     an "empty-state explainer". The whole page IS the empty-state. Omitted
 *     as a separate case (covered structurally by cases 2-3).
 *   - Prompt anticipated "RBAC: USER hides mutation CTAs". REALITY: SUT has
 *     no mutation CTAs to hide. Omitted.
 *   - Prompt anticipated "error handling: 500 → silent degrade or
 *     notify.error". REALITY: SUT has no fetch → no error branch. Omitted.
 *   - Backend endpoint pattern: SUT makes NO backend calls. Per-patient
 *     inventory lives behind `/api/wellness/patients/:id/inventory` (consumed
 *     by PatientDetail's InventoryTab, not by this SUT). Pinned in case 3 via
 *     the "<Inventory> tab inside their detail view" copy.
 *
 * Path: flat `__tests__/Inventory.test.jsx` — matches the sibling
 * Locations/Vendors/Drugs/ServiceCategories flat-path convention.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import Inventory from '../pages/wellness/Inventory';

function renderPage() {
  return render(
    <MemoryRouter>
      <Inventory />
    </MemoryRouter>,
  );
}

describe('<Inventory /> — page chrome', () => {
  it('renders heading "Inventory" with the Package icon', () => {
    renderPage();
    expect(
      screen.getByRole('heading', { name: /^Inventory$/i }),
    ).toBeInTheDocument();
    // The lucide-react Package icon renders as an inline SVG with the
    // "lucide-package" class. Pin its presence so the chrome's leading-icon
    // contract doesn't silently regress to a wrong icon.
    const svgs = document.querySelectorAll('svg.lucide-package');
    expect(svgs.length).toBeGreaterThanOrEqual(1);
  });
});

describe('<Inventory /> — explainer copy', () => {
  it('renders per-patient ledger framing + 6-of-10 laser sessions example', () => {
    renderPage();
    // The framing paragraph is split by a <strong>per patient</strong> node,
    // so use a textContent function matcher. RTL's function matcher fires on
    // every ancestor whose textContent includes the match (body → wrapper →
    // glass div → <p>), so use getAllByText + >=1 floor per the sibling
    // Locations.test.jsx convention.
    expect(
      screen.getAllByText((_t, el) =>
        /Inventory in the wellness vertical is tracked\s+per patient as a\s+consumption ledger/i.test(
          el?.textContent || '',
        ),
      ).length,
    ).toBeGreaterThanOrEqual(1);
    // The laser-sessions example is in the same paragraph.
    expect(
      screen.getAllByText((_t, el) =>
        /6 of 10 laser sessions used/i.test(el?.textContent || ''),
      ).length,
    ).toBeGreaterThanOrEqual(1);
    // Confirm the <strong>per patient</strong> emphasis renders.
    expect(screen.getByText(/^per patient$/i).tagName).toBe('STRONG');
  });
});

describe('<Inventory /> — ordered-list steps', () => {
  it('renders the 3-step ordered list pointing users to the patient detail Inventory tab', () => {
    renderPage();
    // Each step is an <li>. Pin the count + the contents in order.
    const items = document.querySelectorAll('ol > li');
    expect(items.length).toBe(3);
    expect(items[0].textContent).toMatch(/Open\s+Patients\s+from the sidebar/i);
    expect(items[1].textContent).toMatch(/Select a patient/i);
    expect(items[2].textContent).toMatch(
      /Switch to the\s+Inventory\s+tab inside their detail view/i,
    );
    // The bolded keywords inside steps 1 + 3 are <strong> emphasis.
    const strongs = Array.from(document.querySelectorAll('ol > li strong')).map(
      (el) => el.textContent,
    );
    expect(strongs).toContain('Patients');
    expect(strongs).toContain('Inventory');
  });
});

describe('<Inventory /> — primary CTA', () => {
  it('renders a Link to /wellness/patients labelled "Go to Patients"', () => {
    renderPage();
    const link = screen.getByRole('link', { name: /Go to Patients/i });
    expect(link).toBeInTheDocument();
    expect(link.getAttribute('href')).toBe('/wellness/patients');
  });
});

describe('<Inventory /> — low-stock tip box', () => {
  it('renders the low-stock-alerts hint pointing at the lowStockEngine cron + Owner Dashboard', () => {
    renderPage();
    // The tip box mixes a <strong>Tip:</strong> + plain text + a <code>
    // lowStockEngine</code> element + plain text. Match against the parent
    // textContent so the inline <code> doesn't fragment the matcher. Use
    // getAllByText + >=1 since the textContent matcher resolves at every
    // ancestor up to <body>.
    expect(
      screen.getAllByText((_t, el) =>
        /Tip:.*low-stock alerts on consumables/i.test(el?.textContent || ''),
      ).length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      screen.getAllByText((_t, el) =>
        /needles, fillers/i.test(el?.textContent || ''),
      ).length,
    ).toBeGreaterThanOrEqual(1);
    // `lowStockEngine` renders inside a <code> element specifically.
    const codeEl = screen.getByText('lowStockEngine');
    expect(codeEl.tagName).toBe('CODE');
    // Owner Dashboard reference is in the same tip block.
    expect(
      screen.getAllByText((_t, el) =>
        /recommendation cards on\s+the Owner Dashboard/i.test(
          el?.textContent || '',
        ),
      ).length,
    ).toBeGreaterThanOrEqual(1);
  });
});
