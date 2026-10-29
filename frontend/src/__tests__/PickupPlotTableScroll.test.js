import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

const PICKUP_PLOT_TABLE_SOURCES = [
  'pages/PickupPlotInventory.jsx',
  'pages/PickupInventory.jsx',
  'pages/PickupCustomers.jsx',
  'pages/BillingPersons.jsx',
  'pages/PickupPlotWorkAssignments.jsx',
  'components/PickupPlotPeopleDirectory.jsx',
];

describe('Pickup & Plot table scroll cards', () => {
  it('disables the global card shimmer that creates phantom horizontal overflow', () => {
    expect(css).toMatch(/\.card\.pickup-plot-table-scroll::before\s*\{[^}]*display:\s*none\s*;/s);
  });

  it('keeps table scroll cards visually unchanged on hover', () => {
    const hoverRule = css.match(/\.card\.pickup-plot-table-scroll:hover\s*\{([^}]*)\}/s);

    expect(hoverRule).not.toBeNull();
    expect(hoverRule[1]).toMatch(/transform:\s*none\s*;/);
    expect(hoverRule[1]).toMatch(/box-shadow:\s*0 4px 15px rgba\(0, 0, 0, 0\.2\)\s*;/);
    expect(hoverRule[1]).toMatch(/border-color:\s*var\(--border-color\)\s*;/);
  });

  it('sizes directory and plot-inventory cards from their table content', () => {
    expect(css).toMatch(/\.pickup-person-directory-page \.pickup-plot-table-scroll,[\s\S]*?\.pickup-plot-inventory-page \.pickup-plot-table-scroll,[\s\S]*?\.pickup-inventory-page \.pickup-plot-table-scroll,[\s\S]*?\.billing-directory-page \.pickup-plot-table-scroll,[\s\S]*?\.staff-work-assignment-page \.pickup-plot-table-scroll\s*\{[^}]*flex:\s*0 0 auto\s*;[^}]*max-height:\s*calc\(100vh - 260px\)\s*;/s);
  });

  it('removes row hover styling only for Generic CRM Pickup & Plot tables', () => {
    expect(css).toMatch(/body\[data-vertical="generic"\]\s+table\.pickup-plot-no-row-hover\s+tbody\s+tr:not\(\.is-selected\):hover/);
    expect(css).toMatch(/table\.pickup-plot-no-row-hover\s+tbody\s+tr:not\(\.is-selected\):hover[^{}]*\{[^}]*background-color:\s*transparent\s*!important\s*;/s);
    expect(css).not.toMatch(/body\[data-vertical="(?:wellness|travel)"\]\s+table\.pickup-plot-no-row-hover/);
  });

  it('marks every Pickup & Plot sidebar table with the no-hover class', () => {
    for (const sourcePath of PICKUP_PLOT_TABLE_SOURCES) {
      const source = readFileSync(resolve(process.cwd(), 'src', sourcePath), 'utf8');
      const tableTags = [...source.matchAll(/<table\b[^>]*>/g)].map(([tag]) => tag);

      expect(tableTags.length, `${sourcePath} should contain a table`).toBeGreaterThan(0);
      for (const tag of tableTags) {
        expect(tag, `${sourcePath} has an unscoped Pickup & Plot table`).toContain('pickup-plot-no-row-hover');
        expect(tag, `${sourcePath} is missing the shared Leads table appearance`).toContain('pickup-plot-leads-table');
      }
    }
  });

  it('applies the shared table appearance only to Generic CRM', () => {
    expect(css).toMatch(/body\[data-vertical="generic"\]\s+table\.pickup-plot-leads-table\s*\{/);
    expect(css).toMatch(/table\.pickup-plot-leads-table\s+thead\s+th[^{}]*\{[^}]*font-size:\s*0\.75rem\s*;/s);
    expect(css).not.toMatch(/body\[data-vertical="(?:wellness|travel)"\]\s+table\.pickup-plot-leads-table/);
  });

  it('uses theme tokens for Generic CRM Pickup & Plot table headers', () => {
    expect(css).toMatch(/body\[data-vertical="generic"\]\s+table\.pickup-plot-leads-table\s+thead\s+tr,[\s\S]*?background-color:\s*var\(--popover-bg,\s*var\(--modal-bg,\s*var\(--surface-color\)\)\)/);
    expect(css).not.toMatch(/table\.pickup-plot-leads-table\s+thead\s+th[^{}]*\{[^}]*background-color:\s*var\(--table-header-bg/s);
    expect(css).toMatch(/body\[data-vertical="generic"\]\s+table\.pickup-plot-leads-table\s+thead\s+th\s*\{\s*color:\s*var\(--text-primary\)\s*!important\s*;/);
  });

  it('uses an opaque themed surface for the active customer filter', () => {
    const workspaceCss = readFileSync(resolve(process.cwd(), 'src/components/TransportDriverWorkspace.css'), 'utf8');
    const activeTabRule = workspaceCss.match(/\.transport-tabs button\.active\s*\{([^}]*)\}/s);

    expect(activeTabRule).not.toBeNull();
    expect(activeTabRule[1]).toMatch(/background:\s*var\(--popover-bg,\s*var\(--modal-bg,\s*var\(--surface-color\)\)\)/);
    expect(activeTabRule[1]).not.toMatch(/background:\s*(?:#fff|rgba?\()/);
  });

  it('keeps the transport schedule calendar and save controls easy to target', () => {
    const workspaceCss = readFileSync(resolve(process.cwd(), 'src/components/TransportDriverWorkspace.css'), 'utf8');
    expect(workspaceCss).toMatch(
      /\.transport-trip-times input\[type="datetime-local"\]::-webkit-calendar-picker-indicator\s*\{[^}]*width:\s*20px[^}]*height:\s*20px/s,
    );
    expect(workspaceCss).toMatch(
      /\.transport-save-time-check\s*\{[^}]*width:\s*34px[^}]*height:\s*34px[^}]*border:\s*1px solid var\(--border-color\)/s,
    );
  });
});
