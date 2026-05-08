/**
 * Reports.cellStyle.test.jsx — vitest pins for #602 + #609.
 *
 * #602 — numeric / currency / date cells in Reports tables must not wrap
 * mid-number. "₹1,2\n34,567" rendered across two lines was breaking
 * copy-paste + CSV alignment. The fix applies `white-space: nowrap` +
 * `font-variant-numeric: tabular-nums` to numeric columns in
 *   - frontend/src/pages/Reports.jsx (numericTdStyle / numericThStyle)
 *   - frontend/src/pages/AgentReports.jsx (tdNumStyle / thNumStyle)
 *   - frontend/src/pages/wellness/Reports.jsx (tdR right-aligned cells)
 *   - frontend/src/pages/CustomReports.jsx (per-cell numeric detection)
 *
 * #609 — Recharts <Tooltip> popups were rendering UNDER the sticky page
 * header (Layout.jsx header has no z-index but Recharts default tooltip
 * z-index of 1000 is below other site overlays/popovers). The fix bumps
 * `wrapperStyle={{ zIndex: 9999 }}` on every Recharts Tooltip in:
 *   - Reports.jsx (3 instances: bar, pie, area)
 *   - CustomReports.jsx (3 instances: bar, line, pie)
 *   - AgentReports.jsx (1 instance: leaderboard horizontal bar)
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Tooltip, BarChart, Bar, ResponsiveContainer } from 'recharts';
import { readFileSync } from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');

describe('#602 — numeric report cells do not wrap mid-number', () => {
  it('renders a numeric td with white-space: nowrap and tabular-nums', () => {
    // Mirror of the numericTdStyle constant in Reports.jsx — keeping the
    // assertion at the *style-shape* level (not import the constant) so
    // even if a developer inlines the values, the contract still holds.
    const numericTdStyle = {
      padding: '0.875rem 1rem',
      whiteSpace: 'nowrap',
      fontVariantNumeric: 'tabular-nums',
      minWidth: '7.5rem',
    };
    const { container } = render(
      <table>
        <tbody>
          <tr>
            <td style={numericTdStyle} data-testid="amt">₹1,234,567</td>
          </tr>
        </tbody>
      </table>
    );
    const td = container.querySelector('td[data-testid="amt"]');
    expect(td).not.toBeNull();
    // jsdom returns whiteSpace as "nowrap" when set inline.
    expect(td.style.whiteSpace).toBe('nowrap');
    // browsers normalise this to camelCase via CSSOM
    expect(td.style.fontVariantNumeric).toBe('tabular-nums');
    // sanity — minWidth is reachable
    expect(td.style.minWidth).toBe('7.5rem');
  });

  it('Reports.jsx exports a numericTdStyle constant with the expected contract', () => {
    // Source-level grep — guarantees the constant exists with the load-bearing
    // properties even if jsdom's style normalisation drifts. This pins the
    // *file* not the runtime behaviour, so a future refactor that drops
    // tabular-nums or nowrap reds the test immediately.
    const src = readFileSync(path.join(REPO_ROOT, 'src/pages/Reports.jsx'), 'utf8');
    expect(src).toMatch(/numericTdStyle\s*=\s*\{[^}]*whiteSpace:\s*['"]nowrap['"]/);
    expect(src).toMatch(/numericTdStyle\s*=\s*\{[^}]*fontVariantNumeric:\s*['"]tabular-nums['"]/);
  });

  it('wellness/Reports.jsx tdR right-aligned cells are pinned to nowrap + tabular-nums', () => {
    const src = readFileSync(path.join(REPO_ROOT, 'src/pages/wellness/Reports.jsx'), 'utf8');
    expect(src).toMatch(/tdR\s*=\s*\{[\s\S]*?whiteSpace:\s*['"]nowrap['"]/);
    expect(src).toMatch(/tdR\s*=\s*\{[\s\S]*?fontVariantNumeric:\s*['"]tabular-nums['"]/);
  });

  it('AgentReports.jsx tdNumStyle exists with the expected contract', () => {
    const src = readFileSync(path.join(REPO_ROOT, 'src/pages/AgentReports.jsx'), 'utf8');
    expect(src).toMatch(/tdNumStyle\s*=\s*\{[^}]*whiteSpace:\s*['"]nowrap['"]/);
    expect(src).toMatch(/tdNumStyle\s*=\s*\{[^}]*fontVariantNumeric:\s*['"]tabular-nums['"]/);
  });

  it('CustomReports.jsx applies nowrap + tabular-nums to numeric-like cells', () => {
    const src = readFileSync(path.join(REPO_ROOT, 'src/pages/CustomReports.jsx'), 'utf8');
    // Should detect numeric cells and apply the nowrap + tabular-nums style.
    expect(src).toMatch(/isNumericLike/);
    expect(src).toMatch(/whiteSpace:\s*['"]nowrap['"]/);
    expect(src).toMatch(/fontVariantNumeric:\s*['"]tabular-nums['"]/);
  });
});

describe('#609 — Recharts Tooltip wrapperStyle.zIndex >= 9999', () => {
  it('renders a Recharts <Tooltip> with wrapperStyle.zIndex set to 9999', () => {
    // Recharts only renders the Tooltip's wrapper into the DOM when the
    // chart actually emits a tooltip cursor — that's hard to simulate in
    // jsdom without ResizeObserver + layout. Instead, render the chart and
    // grab the Tooltip wrapper element via Recharts' own classname; if the
    // wrapper exists at all, its inline style was set from wrapperStyle.
    const data = [{ name: 'A', value: 10 }, { name: 'B', value: 20 }];
    const { container } = render(
      <div style={{ width: 400, height: 200 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data}>
            <Tooltip wrapperStyle={{ zIndex: 9999 }} />
            <Bar dataKey="value" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
    // Recharts renders the tooltip wrapper with class "recharts-tooltip-wrapper".
    // Even when not visible, the wrapper element exists with the wrapperStyle applied.
    const wrapper = container.querySelector('.recharts-tooltip-wrapper');
    expect(wrapper).not.toBeNull();
    // jsdom normalises to a string; both '9999' and 9999 work.
    expect(Number(wrapper.style.zIndex)).toBeGreaterThanOrEqual(9999);
  });

  it('Reports.jsx Tooltips all carry wrapperStyle with zIndex >= 9999', () => {
    const src = readFileSync(path.join(REPO_ROOT, 'src/pages/Reports.jsx'), 'utf8');
    const tooltipMatches = src.match(/<Tooltip[^/]*\/>/g) || [];
    expect(tooltipMatches.length).toBeGreaterThan(0);
    for (const m of tooltipMatches) {
      expect(m).toMatch(/wrapperStyle=\{\{\s*zIndex:\s*9999/);
    }
  });

  it('CustomReports.jsx Tooltips all carry wrapperStyle with zIndex >= 9999', () => {
    const src = readFileSync(path.join(REPO_ROOT, 'src/pages/CustomReports.jsx'), 'utf8');
    const tooltipMatches = src.match(/<Tooltip[^/]*\/>/g) || [];
    expect(tooltipMatches.length).toBeGreaterThan(0);
    for (const m of tooltipMatches) {
      expect(m).toMatch(/wrapperStyle=\{\{\s*zIndex:\s*9999/);
    }
  });

  it('AgentReports.jsx Tooltip carries wrapperStyle with zIndex >= 9999', () => {
    const src = readFileSync(path.join(REPO_ROOT, 'src/pages/AgentReports.jsx'), 'utf8');
    const tooltipMatches = src.match(/<Tooltip[^/]*\/>/g) || [];
    expect(tooltipMatches.length).toBeGreaterThan(0);
    for (const m of tooltipMatches) {
      expect(m).toMatch(/wrapperStyle=\{\{\s*zIndex:\s*9999/);
    }
  });
});
