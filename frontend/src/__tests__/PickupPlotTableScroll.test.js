import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');
const pickupCustomersCss = readFileSync(resolve(process.cwd(), 'src/pages/PickupCustomers.css'), 'utf8');

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

  it('removes responsive card padding from the shared table scroll viewport', () => {
    expect(css).toMatch(/body\[data-vertical="generic"\]\s+\.card\.pickup-plot-table-scroll,[\s\S]*?\.card\.pickup-plot-table-scroll\s*\{[^}]*padding:\s*0\s*!important\s*;/s);
  });

  it('sizes directory and plot-inventory cards from their table content', () => {
    expect(css).toMatch(/\.pickup-person-directory-page \.pickup-plot-table-scroll,[\s\S]*?\.pickup-plot-inventory-page \.pickup-plot-table-scroll,[\s\S]*?\.pickup-inventory-page \.pickup-plot-table-scroll,[\s\S]*?\.billing-directory-page \.pickup-plot-table-scroll,[\s\S]*?\.staff-work-assignment-page \.pickup-plot-table-scroll\s*\{[^}]*flex:\s*0 0 auto\s*;[^}]*max-height:\s*calc\(100vh - 260px\)\s*;/s);
  });

  it('keeps Generic CRM Pickup Inventory inside one bounded scroll viewport', () => {
    expect(css).toMatch(/body\[data-vertical="generic"\] \.app-main > main\.generic-page-content:has\(\.pickup-inventory-page\)\s*\{[^}]*overflow-y:\s*hidden\s*!important\s*;/s);
    expect(css).toMatch(/body\[data-vertical="generic"\] \.pickup-inventory-page > \.pickup-plot-table-body-scroll\s*\{[^}]*flex:\s*1 1 auto\s*!important\s*;[^}]*max-height:\s*none\s*!important\s*;/s);
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

  it('keeps Plot & Pickup table rows behind an opaque, elevated header while scrolling', () => {
    expect(css).toMatch(/body\[data-vertical="generic"\]\s+\.pickup-plot-table-body-scroll\s*\{[^}]*isolation:\s*isolate\s*;/s);
    expect(css).toMatch(/body\[data-vertical="generic"\]\s+table\.pickup-plot-leads-table\s*\{[^}]*border-collapse:\s*separate\s*!important[^}]*border-spacing:\s*0/s);
    expect(css).toMatch(/\.pickup-plot-table-body-scroll table\.pickup-plot-leads-table thead[\s,\n]*[^{}]*\{[^}]*position:\s*static\s*!important/s);
    expect(css).toMatch(/\.pickup-plot-table-body-scroll table\.pickup-plot-leads-table thead th\s*\{[^}]*position:\s*sticky\s*!important[^}]*top:\s*0\s*!important[^}]*z-index:\s*20\s*!important[^}]*background-color:\s*var\(--popover-bg/s);
    expect(css).toMatch(/\.pickup-plot-table-body-scroll table\.pickup-plot-leads-table thead th\s*\{[^}]*height:\s*44px\s*!important[^}]*padding:\s*0\.75rem 0\.8rem\s*!important[^}]*vertical-align:\s*middle/s);
    expect(css).not.toMatch(/pickup-plot-table-body-scroll[\s\S]{0,180}scrollbar-track-piece:vertical[\s\S]{0,120}margin-top:\s*44px/);
    expect(css).toMatch(/\.pickup-customers-page \.pickup-directory-scroll table\.pickup-customer-table thead th,[\s\S]*?z-index:\s*11\s*!important/);
  });

  it('keeps the Customer Status directory table readable', () => {
    expect(pickupCustomersCss).toContain('font-size:clamp(.8rem, .72rem + .16vw, .9rem) !important');
    expect(pickupCustomersCss).toContain('font-size:clamp(.78rem, .7rem + .16vw, .9rem)');
    expect(pickupCustomersCss).toContain('.pickup-customers-page .pickup-customer-table .pickup-plot-empty-copy h2 { font-size:1.1rem; }');
    expect(pickupCustomersCss).toMatch(/table\.pickup-customer-table th \{\s*font-size: 0\.85rem !important/);
    expect(pickupCustomersCss).toMatch(/table\.pickup-customer-table td \{\s*font-size: 0\.84rem !important/);
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
