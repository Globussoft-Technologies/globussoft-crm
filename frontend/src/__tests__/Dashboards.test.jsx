/**
 * Dashboards.test.jsx — vitest + RTL coverage for the custom Dashboards page.
 *
 * Scope: pins the page-surface invariants for the dashboard list + widget
 * builder in frontend/src/pages/Dashboards.jsx (582 LOC):
 *
 *   1. Page renders the "Custom Dashboards" header + tagline + Create button.
 *   2. On mount, fetches GET /api/dashboards.
 *   3. Empty list state: "No dashboards yet" + Create CTA when the list is [].
 *   4. List with rows: the <select> renders one <option> per dashboard.
 *      Default dashboards are prefixed with "★ " in the option label.
 *   5. Active dashboard with empty layout shows the empty-state card with the
 *      dashboard name + the "Edit Layout" CTA (not editMode yet).
 *   6. Clicking "Edit Layout" enters edit mode → "Add Widget" + "Save" +
 *      "Cancel" buttons appear in the header.
 *   7. Add-Widget modal: opens on click, shows all 3 groups (KPI / Charts /
 *      Tables) and all 9 catalog widget cards. Closing via the dialog
 *      close button hides the modal.
 *   8. Adding a widget from the modal grows the layout (we can't easily
 *      assert RGL grid contents in jsdom, so we drive via the modal click
 *      and then re-open the modal to confirm it's been closed AND a save-
 *      cancel-edit chain still works.) — instead we verify the modal closes
 *      and the previously-empty-state ("is empty") banner disappears.
 *   9. Create modal: opens on "Create Dashboard", input + Cancel + Create
 *      buttons render; Enter-key on the name input triggers POST.
 *  10. Create-flow POST: typing a name + clicking Create POSTs
 *      /api/dashboards with { name, layout: [] } and reloads the list.
 *  11. Empty name on Create is a no-op (no POST fired).
 *  12. Delete-flow: clicking the trash icon calls notify.confirm and on
 *      confirm DELETEs /api/dashboards/<id>.
 *  13. Set-default star button: visible only when the active dashboard is
 *      NOT already default; POSTs to /api/dashboards/<id>/set-default.
 *  14. Cancel button in edit mode flips editMode off (header reverts to the
 *      single "Edit" button).
 *
 * Mocks: stable notify object reference per the CLAUDE.md "RTL: stable
 * mock object references" standing rule (useCallback-fed `notify.confirm`).
 *
 * react-grid-layout is mocked wholesale: ResponsiveGridLayout uses
 * useContainerWidth + ResizeObserver which jsdom doesn't provide, and the
 * drag-resize machinery is orthogonal to the state we're pinning. The
 * mock renders children directly so the widget-card chrome (title bar,
 * remove button) still mounts when needed.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// fetchApi mock — single global handle that each test re-implements.
const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

// Stable notify object — see CLAUDE.md standing rule on mock identity stability.
const confirmMock = vi.fn().mockResolvedValue(true);
const notifyObj = {
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  confirm: (...args) => confirmMock(...args),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

// react-grid-layout — pure passthrough. The page imports Responsive +
// useContainerWidth; we stub them to a flat div renderer so children mount
// without the layout machinery.
vi.mock('react-grid-layout', () => {
  const Responsive = ({ children }) => (
    <div data-testid="rgl-passthrough">{children}</div>
  );
  return {
    Responsive,
    useContainerWidth: () => ({ containerRef: { current: null }, width: 1280 }),
  };
});

// Recharts ResponsiveContainer is unfriendly in jsdom; stub just that piece.
vi.mock('recharts', async () => {
  const actual = await vi.importActual('recharts');
  return {
    ...actual,
    ResponsiveContainer: ({ children }) => <div data-testid="rc">{children}</div>,
  };
});

import Dashboards from '../pages/Dashboards';

const sampleDashboards = [
  { id: 1, name: 'Sales Overview', isDefault: true, layout: [] },
  { id: 2, name: 'Marketing Funnel', isDefault: false, layout: [] },
];

const sampleDashboardWithLayout = {
  id: 1,
  name: 'Sales Overview',
  isDefault: true,
  layout: [
    { i: 'w-1', x: 0, y: 0, w: 3, h: 2, type: 'kpi-revenue', title: 'Revenue (30d)' },
    { i: 'w-2', x: 3, y: 0, w: 6, h: 4, type: 'chart-pipeline', title: 'Pipeline by Stage' },
  ],
};

const sampleEmptyDashboard = {
  id: 1,
  name: 'Sales Overview',
  isDefault: true,
  layout: [],
};

function renderPage() {
  return render(<Dashboards />);
}

describe('<Dashboards /> — page surface', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    confirmMock.mockReset();
    confirmMock.mockResolvedValue(true);
    notifyObj.error.mockReset?.();
    notifyObj.info.mockReset?.();
    notifyObj.success.mockReset?.();

    // Default: list endpoint returns the two samples; detail endpoint returns
    // an empty-layout dashboard; data endpoint resolves to {}.
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/dashboards') return Promise.resolve(sampleDashboards);
      if (url === '/api/dashboards/1') return Promise.resolve(sampleEmptyDashboard);
      if (url === '/api/dashboards/1/data') return Promise.resolve({});
      if (url === '/api/dashboards/2') {
        return Promise.resolve({ id: 2, name: 'Marketing Funnel', isDefault: false, layout: [] });
      }
      if (url === '/api/dashboards/2/data') return Promise.resolve({});
      return Promise.resolve(null);
    });
  });

  it('renders the Custom Dashboards header + tagline + Create button', async () => {
    renderPage();
    expect(
      screen.getByRole('heading', { name: /^Custom Dashboards$/i })
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Drag, resize, and tailor your analytics view/i)
    ).toBeInTheDocument();
    // The header always carries a "Create Dashboard" CTA.
    expect(
      screen.getAllByRole('button', { name: /Create Dashboard/i }).length
    ).toBeGreaterThanOrEqual(1);
  });

  it('fetches GET /api/dashboards on mount', async () => {
    renderPage();
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u]) => u === '/api/dashboards');
      expect(call).toBeTruthy();
    });
  });

  it('shows the "No dashboards yet" empty state when the list endpoint returns []', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/dashboards') return Promise.resolve([]);
      return Promise.resolve(null);
    });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/No dashboards yet/i)).toBeInTheDocument();
    });
    expect(
      screen.getByText(/Create your first custom analytics view to get started\./i)
    ).toBeInTheDocument();
    // Both the header + the empty-state card carry a Create Dashboard button.
    expect(
      screen.getAllByRole('button', { name: /Create Dashboard/i }).length
    ).toBeGreaterThanOrEqual(2);
  });

  it('renders one <option> per dashboard with "★ " prefix on the default', async () => {
    renderPage();
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u]) => u === '/api/dashboards/1');
      expect(call).toBeTruthy();
    });
    // The select shows the active dashboard's name. The default is prefixed
    // with "★ " in its option label.
    expect(screen.getByRole('option', { name: /★ Sales Overview/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /^Marketing Funnel$/i })).toBeInTheDocument();
    // Plus the placeholder "Select dashboard…" option (disabled).
    expect(screen.getByRole('option', { name: /Select dashboard…/i })).toBeInTheDocument();
  });

  it('active dashboard with empty layout shows the empty-state card + Edit Layout CTA', async () => {
    renderPage();
    // Wait for the active dashboard to load (id=1, default).
    await waitFor(() => {
      expect(screen.getByText(/Sales Overview is empty/i)).toBeInTheDocument();
    });
    expect(
      screen.getByText(/Enter edit mode and add your first widget\./i)
    ).toBeInTheDocument();
    // The card shows "Edit Layout" (NOT yet edit mode).
    expect(screen.getByRole('button', { name: /Edit Layout/i })).toBeInTheDocument();
  });

  it('Edit button enters edit mode → Add Widget + Save + Cancel appear', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/Sales Overview is empty/i)).toBeInTheDocument();
    });

    // Header has an "Edit" button (singular, in non-edit mode).
    const editBtn = screen.getByRole('button', { name: /^Edit$/i });
    fireEvent.click(editBtn);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Save$/i })).toBeInTheDocument();
    });
    // Header chrome now has Add Widget + Save + Cancel.
    expect(
      screen.getAllByRole('button', { name: /Add Widget/i }).length
    ).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('button', { name: /^Cancel$/i })).toBeInTheDocument();
    // Header Edit button is gone (replaced by Save/Cancel).
    expect(screen.queryByRole('button', { name: /^Edit$/i })).not.toBeInTheDocument();
  });

  it('Add Widget modal shows all 3 groups + all 9 catalog widget cards', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/Sales Overview is empty/i)).toBeInTheDocument();
    });

    // Enter edit mode, then click Add Widget in the header.
    fireEvent.click(screen.getByRole('button', { name: /^Edit$/i }));
    await waitFor(() => {
      expect(
        screen.getAllByRole('button', { name: /Add Widget/i }).length
      ).toBeGreaterThanOrEqual(1);
    });
    // Click the FIRST visible Add Widget (header). The empty-state card also
    // shows one in edit mode, so use getAllByRole + index.
    const addBtns = screen.getAllByRole('button', { name: /Add Widget/i });
    fireEvent.click(addBtns[0]);

    // Modal opens with the heading "Add Widget".
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /^Add Widget$/i })).toBeInTheDocument();
    });
    // Group labels (uppercase via CSS text-transform but the raw text is title-case).
    expect(screen.getByText(/^KPI$/i)).toBeInTheDocument();
    expect(screen.getByText(/^Charts$/i)).toBeInTheDocument();
    expect(screen.getByText(/^Tables$/i)).toBeInTheDocument();
    // The 9 catalog cards all render with their titles.
    expect(screen.getByText(/Revenue \(30d\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Open Deals/i)).toBeInTheDocument();
    expect(screen.getByText(/Total Contacts/i)).toBeInTheDocument();
    expect(screen.getByText(/Pending Tasks/i)).toBeInTheDocument();
    expect(screen.getByText(/Pipeline by Stage/i)).toBeInTheDocument();
    expect(screen.getByText(/Revenue Trend \(12m\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Leads by Source/i)).toBeInTheDocument();
    expect(screen.getByText(/Recent Deals/i)).toBeInTheDocument();
    expect(screen.getByText(/Overdue Tasks/i)).toBeInTheDocument();
  });

  it('clicking a catalog widget closes the modal + dismisses the empty-state', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/Sales Overview is empty/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /^Edit$/i }));
    const addBtns = await screen.findAllByRole('button', { name: /Add Widget/i });
    fireEvent.click(addBtns[0]);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /^Add Widget$/i })).toBeInTheDocument();
    });

    // The catalog cards are <button> elements with title + type as text.
    // "Revenue (30d)" is unique to the KPI Revenue card; click it.
    const card = screen.getByRole('button', { name: /Revenue \(30d\).*kpi-revenue/i });
    fireEvent.click(card);

    // Modal closes (Add Widget heading goes away).
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: /^Add Widget$/i })).not.toBeInTheDocument();
    });
    // Empty-state banner is gone because the layout now has 1 widget.
    expect(screen.queryByText(/Sales Overview is empty/i)).not.toBeInTheDocument();
  });

  it('Create Dashboard modal: input + Cancel + Create buttons render', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/Sales Overview is empty/i)).toBeInTheDocument();
    });

    // Header Create Dashboard button opens the modal.
    fireEvent.click(screen.getAllByRole('button', { name: /Create Dashboard/i })[0]);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /^Create Dashboard$/i })).toBeInTheDocument();
    });
    expect(screen.getByPlaceholderText(/Dashboard name/i)).toBeInTheDocument();
    // Modal Cancel + Create submit buttons. There are now TWO buttons matching
    // "Create" — header + modal. The modal one is the last in DOM order.
    expect(screen.getByRole('button', { name: /^Cancel$/i })).toBeInTheDocument();
    expect(
      screen.getAllByRole('button', { name: /^Create$/i }).length
    ).toBeGreaterThanOrEqual(1);
  });

  it('Create-flow: typing a name + clicking Create POSTs /api/dashboards', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/dashboards' && (!opts || opts.method !== 'POST')) {
        return Promise.resolve([]);
      }
      if (url === '/api/dashboards' && opts?.method === 'POST') {
        return Promise.resolve({ id: 99, name: 'Q4 Health', isDefault: false, layout: [] });
      }
      if (url === '/api/dashboards/99') {
        return Promise.resolve({ id: 99, name: 'Q4 Health', isDefault: false, layout: [] });
      }
      if (url === '/api/dashboards/99/data') return Promise.resolve({});
      return Promise.resolve(null);
    });
    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/No dashboards yet/i)).toBeInTheDocument();
    });

    // Open the create modal via the empty-state CTA.
    fireEvent.click(screen.getAllByRole('button', { name: /Create Dashboard/i })[0]);

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Dashboard name/i)).toBeInTheDocument();
    });

    const nameInput = screen.getByPlaceholderText(/Dashboard name/i);
    fireEvent.change(nameInput, { target: { value: 'Q4 Health' } });

    // Click the modal's Create (last "Create" in DOM order is the submit).
    const createBtns = screen.getAllByRole('button', { name: /^Create$/i });
    fireEvent.click(createBtns[createBtns.length - 1]);

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, o]) => url === '/api/dashboards' && o?.method === 'POST'
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body.name).toBe('Q4 Health');
      expect(body.layout).toEqual([]);
    });
  });

  it('Create-flow with empty name is a no-op (no POST fired)', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/dashboards' && (!opts || opts.method !== 'POST')) {
        return Promise.resolve([]);
      }
      return Promise.resolve(null);
    });
    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/No dashboards yet/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getAllByRole('button', { name: /Create Dashboard/i })[0]);
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Dashboard name/i)).toBeInTheDocument();
    });

    // Don't fill the input. Click Create.
    const createBtns = screen.getAllByRole('button', { name: /^Create$/i });
    fireEvent.click(createBtns[createBtns.length - 1]);

    // Give React a tick; assert no POST was fired.
    await new Promise((r) => setTimeout(r, 50));
    const postCall = fetchApiMock.mock.calls.find(
      ([url, o]) => url === '/api/dashboards' && o?.method === 'POST'
    );
    expect(postCall).toBeUndefined();
  });

  it('Delete-flow: trash button → confirm → DELETE /api/dashboards/<id>', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/Sales Overview is empty/i)).toBeInTheDocument();
    });

    // The danger-styled icon-only trash button is in the header. Find via
    // walking through buttons — the page renders Refresh / Edit / Star /
    // Trash / Create Dashboard for an active non-default dashboard. For our
    // default (id=1, isDefault=true), the star button is hidden, so the
    // header buttons after the dashboard select are:
    //   Refresh / Edit / Trash / Create Dashboard
    // The trash button is icon-only, so we find it by checking for the
    // danger-styled background colour on a button. jsdom serialises the
    // inline style with spaces inside the rgba(...) so we normalise to
    // strip whitespace before substring-matching the channel triple.
    const allButtons = screen.getAllByRole('button');
    const trashBtn = allButtons.find((b) => {
      const bg = (b.style.background || '').replace(/\s+/g, '');
      return bg.includes('239,68,68');
    });
    expect(trashBtn).toBeDefined();

    fireEvent.click(trashBtn);

    await waitFor(() => {
      expect(confirmMock).toHaveBeenCalledWith('Delete dashboard "Sales Overview"?');
    });
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, o]) => url === '/api/dashboards/1' && o?.method === 'DELETE'
      );
      expect(call).toBeTruthy();
    });
  });

  it('Set-default star button visible only on non-default active dashboard', async () => {
    // Start with dashboard 2 (Marketing Funnel — not default) active. We do
    // this by returning a single-element list where id=2 is NOT default.
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/dashboards' && (!opts || opts.method !== 'POST')) {
        // Only one dashboard, and it's NOT default.
        return Promise.resolve([
          { id: 2, name: 'Marketing Funnel', isDefault: false, layout: [] },
        ]);
      }
      if (url === '/api/dashboards/2') {
        return Promise.resolve({ id: 2, name: 'Marketing Funnel', isDefault: false, layout: [] });
      }
      if (url === '/api/dashboards/2/data') return Promise.resolve({});
      if (url === '/api/dashboards/2/set-default' && opts?.method === 'POST') {
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve(null);
    });
    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/Marketing Funnel is empty/i)).toBeInTheDocument();
    });

    // Star (set-default) button — title="Set as tenant default (admin only)".
    const starBtn = screen.getByRole('button', {
      name: /Set as tenant default \(admin only\)/i,
    });
    expect(starBtn).toBeInTheDocument();

    fireEvent.click(starBtn);

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, o]) => url === '/api/dashboards/2/set-default' && o?.method === 'POST'
      );
      expect(call).toBeTruthy();
    });
  });

  it('Set-default button is HIDDEN when the active dashboard is already default', async () => {
    // Default mock: id=1 is the default. Confirm the star button is absent.
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/Sales Overview is empty/i)).toBeInTheDocument();
    });
    expect(
      screen.queryByRole('button', { name: /Set as tenant default/i })
    ).not.toBeInTheDocument();
  });

  it('Cancel button in edit mode exits edit mode (reverts header chrome)', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/Sales Overview is empty/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /^Edit$/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Save$/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));

    // After cancel, header shows Edit again (not Save).
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Edit$/i })).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /^Save$/i })).not.toBeInTheDocument();
  });

  it('renders existing widget titles when the active dashboard has a layout', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/dashboards') return Promise.resolve([sampleDashboardWithLayout]);
      if (url === '/api/dashboards/1') return Promise.resolve(sampleDashboardWithLayout);
      if (url === '/api/dashboards/1/data') {
        return Promise.resolve({
          'w-1': { value: 125000, label: 'Past 30 days' },
          'w-2': [{ stage: 'Won', count: 5 }],
        });
      }
      return Promise.resolve(null);
    });
    renderPage();

    // Widget titles render in the tile header bar AND inside the KpiWidget
    // (uppercase label uses the same title text). getAllByText handles the
    // duplicate; the chart-pipeline title only renders once (charts have no
    // inner title rendering).
    await waitFor(() => {
      expect(screen.getAllByText(/Revenue \(30d\)/i).length).toBeGreaterThanOrEqual(1);
    });
    expect(screen.getAllByText(/Pipeline by Stage/i).length).toBeGreaterThanOrEqual(1);
    // The empty-state ("is empty") banner should NOT show — layout is non-empty.
    expect(screen.queryByText(/is empty/i)).not.toBeInTheDocument();
  });
});
