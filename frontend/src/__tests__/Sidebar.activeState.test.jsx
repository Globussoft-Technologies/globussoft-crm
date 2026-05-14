/**
 * Sidebar active-state regression spec — issue #631.
 *
 * Pre-fix observation: `/deal-insights`, `/document-templates`, `/reports` all
 * had a NavLink in renderGenericNav() that visually didn't show as "active"
 * when the user was on the corresponding page — even though every other nav
 * item highlighted correctly. Bisect: matchPaths defaults to `[]` and the
 * `isActive` from React Router's NavLink correctly fired for these routes
 * in unit tests; the perceived gap was that `<Link>` was a LOCAL component
 * inside Sidebar.jsx that rebuilds `className` from the NavLink's render-prop
 * `isActive`. Today's audit confirmed isActive does fire for these paths,
 * but the test pins the contract so a future refactor (e.g. adding `end`
 * prop variants) doesn't silently regress it.
 *
 * Test pins: when location is `/deal-insights`, the Deal Insights nav link
 * carries the `.active` className. Same for `/document-templates` and
 * `/reports`. Asserts via class-name probe (not literal hex/CSS) so the
 * styling layer can evolve without breaking the test.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import { AuthContext } from '../App';

// Stub heavy bits — adsgpt/callified launchers fire fetches we don't care about
vi.mock('../utils/adsgpt', () => ({
  launchAdsGptAs: vi.fn(),
  ADSGPT_DASHBOARD: 'https://example.test',
  ADSGPT_DEMO_LOGIN: 'demo@x.test',
}));
vi.mock('../utils/callified', () => ({ launchCallifiedSSO: vi.fn() }));
vi.mock('../utils/notify', () => ({ useNotify: () => ({ error: vi.fn(), success: vi.fn(), confirm: vi.fn() }) }));
vi.mock('socket.io-client', () => ({ io: () => ({ on: vi.fn(), disconnect: vi.fn() }) }));
// fetchApi gets called for sidebar counts — return empty arrays
vi.mock('../utils/api', () => ({ fetchApi: vi.fn(() => Promise.resolve([])) }));

function renderSidebarAt(path, role = 'MANAGER', vertical = 'generic') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthContext.Provider value={{
        user: { name: 'Test', email: 't@x.test', role },
        setUser: vi.fn(),
        token: 't-abc',
        setToken: vi.fn(),
        tenant: { vertical },
        setTenant: vi.fn(),
      }}>
        <Sidebar />
      </AuthContext.Provider>
    </MemoryRouter>
  );
}

function findLinkByLabel(label) {
  // sidebar Link stamps the label inside a span; the parent <a> carries the className
  const span = screen.getByText(label);
  return span.closest('a');
}

describe('Sidebar active-state — #631', () => {
  it('marks Deal Insights nav link as active when on /deal-insights', () => {
    renderSidebarAt('/deal-insights');
    const link = findLinkByLabel('Deal Insights');
    expect(link).toBeTruthy();
    expect(link.className).toMatch(/\bactive\b/);
  });

  it('marks Doc Templates nav link as active when on /document-templates', () => {
    renderSidebarAt('/document-templates');
    const link = findLinkByLabel('Doc Templates');
    expect(link).toBeTruthy();
    expect(link.className).toMatch(/\bactive\b/);
  });

  it('marks Reports nav link as active when on /reports', () => {
    renderSidebarAt('/reports');
    const link = findLinkByLabel('Reports');
    expect(link).toBeTruthy();
    expect(link.className).toMatch(/\bactive\b/);
  });

  it('marks Reports nav link as active when on a child route /reports/agent (startsWith match)', () => {
    renderSidebarAt('/reports/agent');
    const link = findLinkByLabel('Reports');
    expect(link).toBeTruthy();
    expect(link.className).toMatch(/\bactive\b/);
  });

  it('does NOT mark Deal Insights as active when on an unrelated route', () => {
    renderSidebarAt('/contacts');
    const link = findLinkByLabel('Deal Insights');
    expect(link).toBeTruthy();
    expect(link.className).not.toMatch(/\bactive\b/);
  });

  it('does NOT mark Reports as active for sibling-prefix routes (segment boundary)', () => {
    // /reports-archive should NOT light up /reports even though it starts
    // with `/reports` — the segment-boundary check prevents this.
    renderSidebarAt('/reports-archive');
    const link = findLinkByLabel('Reports');
    expect(link).toBeTruthy();
    expect(link.className).not.toMatch(/\bactive\b/);
  });
});
