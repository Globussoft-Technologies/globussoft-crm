/**
 * Sidebar active-state regression spec - issue #631.
 *
 * This spec pins the contract that these nav links render as active on the
 * matching routes:
 * - /deal-insights
 * - /document-templates
 * - /reports
 * - /reports/agent
 *
 * It also asserts that unrelated and sibling-prefix routes do not light up
 * the wrong link.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import { AuthContext } from '../App';
import { fetchApi } from '../utils/api';

vi.mock('../utils/adsgpt', () => ({
  launchAdsGptAs: vi.fn(),
  ADSGPT_DASHBOARD: 'https://example.test',
}));
vi.mock('../utils/callified', () => ({ launchCallifiedSSO: vi.fn() }));
vi.mock('../utils/notify', () => ({
  useNotify: () => ({ error: vi.fn(), success: vi.fn(), confirm: vi.fn() }),
}));
vi.mock('socket.io-client', () => ({ io: () => ({ on: vi.fn(), disconnect: vi.fn() }) }));
vi.mock('../utils/api', () => ({ fetchApi: vi.fn(() => Promise.resolve([])) }));

function renderSidebarAt(path, role = 'MANAGER', vertical = 'generic') {
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthContext.Provider
        value={{
          user: { name: 'Test', email: 't@x.test', role },
          setUser: vi.fn(),
          token: 't-abc',
          setToken: vi.fn(),
          tenant: { vertical },
          setTenant: vi.fn(),
        }}
      >
        <Sidebar />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

async function findLinkByLabel(label) {
  const span = await screen.findByText(label);
  return span.closest('a');
}

beforeEach(() => {
  fetchApi.mockResolvedValue([]);
});

describe('Sidebar active-state - #631', () => {
  it('marks Deal Insights nav link as active when on /deal-insights', async () => {
    renderSidebarAt('/deal-insights');
    await waitFor(() => expect(fetchApi).toHaveBeenCalled());
    const link = await findLinkByLabel('Deal Insights');
    expect(link).toBeTruthy();
    expect(link.className).toMatch(/\bactive\b/);
  });

  it('marks Doc Templates nav link as active when on /document-templates', async () => {
    renderSidebarAt('/document-templates');
    await waitFor(() => expect(fetchApi).toHaveBeenCalled());
    const link = await findLinkByLabel('Doc Templates');
    expect(link).toBeTruthy();
    expect(link.className).toMatch(/\bactive\b/);
  });

  it('marks Reports nav link as active when on /reports', async () => {
    renderSidebarAt('/reports');
    await waitFor(() => expect(fetchApi).toHaveBeenCalled());
    const link = await findLinkByLabel('Reports');
    expect(link).toBeTruthy();
    expect(link.className).toMatch(/\bactive\b/);
  });

  it('marks Reports nav link as active when on a child route /reports/agent', async () => {
    renderSidebarAt('/reports/agent');
    await waitFor(() => expect(fetchApi).toHaveBeenCalled());
    const link = await findLinkByLabel('Reports');
    expect(link).toBeTruthy();
    expect(link.className).toMatch(/\bactive\b/);
  });

  it('does NOT mark Deal Insights as active when on an unrelated route', async () => {
    renderSidebarAt('/contacts');
    await waitFor(() => expect(fetchApi).toHaveBeenCalled());
    const link = await findLinkByLabel('Deal Insights');
    expect(link).toBeTruthy();
    expect(link.className).not.toMatch(/\bactive\b/);
  });

  it('does NOT mark Reports as active for sibling-prefix routes', async () => {
    renderSidebarAt('/reports-archive');
    await waitFor(() => expect(fetchApi).toHaveBeenCalled());
    const link = await findLinkByLabel('Reports');
    expect(link).toBeTruthy();
    expect(link.className).not.toMatch(/\bactive\b/);
  });
});
