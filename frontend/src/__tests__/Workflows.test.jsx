/**
 * Workflows.test.jsx — vitest + RTL coverage of the visual workflow canvas.
 *
 * What this test pins
 * ───────────────────
 * The Workflows page (frontend/src/pages/Workflows.jsx, 98 LOC) is the
 * ReactFlow-based "Visual Logic Canvas" for constructing AutomationRule
 * graphs. It owns:
 *
 *   1. Header chrome — "Visual Logic Canvas" h1 + descriptive subhead.
 *   2. ReactFlow canvas seeded with one TRIGGER input node
 *      ("TRIGGER: Deal Stage → Won").
 *   3. Three Panel buttons that append nodes to the canvas:
 *      - "Data Check" → orange CONDITION node, label includes
 *        `currencySymbol()` + "10,000".
 *      - "Emit Invoice" → blue ACTION output node.
 *      - "POST Call" → pink WEBHOOK output node.
 *   4. "Deploy Boolean Logic" save button — POSTs an AutomationRule
 *      envelope to /api/workflows; success/error are routed through
 *      notify.success / notify.error; the button label flips to
 *      "Compiling Nodes..." while in-flight and the button is disabled.
 *
 * Contract pinned here
 * ────────────────────
 *   - Mount renders the page chrome (h1 + subhead + save button).
 *   - Mount renders the seed TRIGGER node label inside the canvas surface.
 *   - The three Panel buttons exist with their lucide-icon labels.
 *   - Clicking "Data Check" appends a CONDITION node whose label contains
 *     the `currencySymbol()` token + "10,000".
 *   - Clicking "Emit Invoice" appends the ACTION node "ACTION: Issue
 *     Final Invoice".
 *   - Clicking "POST Call" appends the WEBHOOK node "WEBHOOK: Dispatch
 *     Payload".
 *   - Clicking "Deploy Boolean Logic" fires fetchApi('/api/workflows',
 *     { method: 'POST', body: <JSON string> }); the JSON parses into an
 *     envelope with the documented field set { name, triggerType,
 *     actionType, targetState } where triggerType/actionType/targetState
 *     are pinned literals and `name` is the "Visual Graph Matrix <N>"
 *     pattern.
 *   - Save success calls notify.success once; error calls notify.error
 *     once; both clear the saving flag (button re-enables, label flips
 *     back to "Deploy Boolean Logic").
 *
 * Why component-level (vitest + RTL), not playwright
 * ──────────────────────────────────────────────────
 * /api/workflows shape is covered by workflows-api.spec.js at the API
 * layer; this pins the page's button-wire + envelope-shape + notify-route
 * contract. ReactFlow itself is stubbed (heavy WebGL/canvas surface that
 * jsdom can't render meaningfully) — we render its children via a thin
 * passthrough so the Panel's three Add-Node buttons + seed-node label
 * appear in the DOM.
 *
 * Standing rules applied
 * ──────────────────────
 *   - Stable mock object reference for useNotify (CLAUDE.md "RTL: stable
 *     mock object references" — fresh objects infinite-loop useCallback
 *     deps).
 *   - vi.mock('reactflow') stubs the canvas + Panel/Background/Controls
 *     children with simple passthrough divs so userEvent can find and
 *     click the in-Panel add-node buttons.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

// Stable mock-object reference per the RTL standing rule. Fresh objects
// per call would invalidate any useCallback dep-array consumer.
const notifyObj = {
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  confirm: vi.fn(() => Promise.resolve(true)),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
  NotifyProvider: ({ children }) => children,
}));

vi.mock('../utils/money', () => ({
  currencySymbol: () => '$',
  formatMoney: (n) => `$${n}`,
}));

// Stub reactflow. jsdom cannot render the real canvas/SVG surface, and
// the test only cares about (a) seed-node label rendering and (b) the
// Panel children (the 3 add-node buttons) being clickable. Render
// children as plain divs; surface the nodes prop as readable labels so
// the test can assert on appended nodes via screen.getByText().
vi.mock('reactflow', () => {
  const ReactFlow = ({ nodes = [], children }) => (
    <div data-testid="reactflow-canvas">
      <ul data-testid="reactflow-nodes">
        {nodes.map((n) => (
          <li key={n.id} data-node-id={n.id}>
            {typeof n.data?.label === 'string' ? n.data.label : ''}
          </li>
        ))}
      </ul>
      {children}
    </div>
  );
  const passthrough = ({ children }) => <div>{children}</div>;
  return {
    __esModule: true,
    default: ReactFlow,
    MiniMap: passthrough,
    Controls: passthrough,
    Background: passthrough,
    Panel: passthrough,
    addEdge: (params, eds) => [...eds, params],
    applyNodeChanges: (_changes, nds) => nds,
    applyEdgeChanges: (_changes, eds) => eds,
  };
});

// reactflow ships a CSS import the SUT pulls in. Stub it.
vi.mock('reactflow/dist/style.css', () => ({}));

import Workflows from '../pages/Workflows';

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyObj.error.mockClear();
  notifyObj.info.mockClear();
  notifyObj.success.mockClear();
});

describe('Workflows page surface', () => {
  it('renders header chrome with title, subhead, and save button', () => {
    render(<Workflows />);
    expect(
      screen.getByRole('heading', { level: 1, name: /visual logic canvas/i })
    ).toBeInTheDocument();
    expect(
      screen.getByText(/construct algorithmic business logic vectors/i)
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /deploy boolean logic/i })
    ).toBeInTheDocument();
  });

  it('seeds the canvas with one TRIGGER node on mount', () => {
    render(<Workflows />);
    expect(
      screen.getByText('TRIGGER: Deal Stage → Won')
    ).toBeInTheDocument();
  });

  it('renders the three add-node Panel buttons', () => {
    render(<Workflows />);
    expect(
      screen.getByRole('button', { name: /data check/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /emit invoice/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /post call/i })
    ).toBeInTheDocument();
  });

  it('appends a CONDITION node with the currency-aware label when Data Check is clicked', async () => {
    const user = userEvent.setup();
    render(<Workflows />);
    await user.click(screen.getByRole('button', { name: /data check/i }));
    await waitFor(() => {
      expect(
        screen.getByText(/CONDITION: Value > \$10,000/)
      ).toBeInTheDocument();
    });
  });

  it('appends the ACTION node when Emit Invoice is clicked', async () => {
    const user = userEvent.setup();
    render(<Workflows />);
    await user.click(screen.getByRole('button', { name: /emit invoice/i }));
    await waitFor(() => {
      expect(
        screen.getByText('ACTION: Issue Final Invoice')
      ).toBeInTheDocument();
    });
  });

  it('appends the WEBHOOK node when POST Call is clicked', async () => {
    const user = userEvent.setup();
    render(<Workflows />);
    await user.click(screen.getByRole('button', { name: /post call/i }));
    await waitFor(() => {
      expect(
        screen.getByText('WEBHOOK: Dispatch Payload')
      ).toBeInTheDocument();
    });
  });

  it('POSTs the AutomationRule envelope to /api/workflows on save and notifies success', async () => {
    fetchApiMock.mockResolvedValueOnce({ id: 1 });
    const user = userEvent.setup();
    render(<Workflows />);

    await user.click(
      screen.getByRole('button', { name: /deploy boolean logic/i })
    );

    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledTimes(1);
    });

    const [path, opts] = fetchApiMock.mock.calls[0];
    expect(path).toBe('/api/workflows');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body).toEqual(
      expect.objectContaining({
        triggerType: 'Canvas Graph Node',
        actionType: 'Multi-threaded Action',
        targetState: 'active',
      })
    );
    expect(body.name).toMatch(/^Visual Graph Matrix \d+$/);

    await waitFor(() => {
      expect(notifyObj.success).toHaveBeenCalledTimes(1);
    });
    expect(notifyObj.error).not.toHaveBeenCalled();
  });

  it('routes fetchApi rejection through notify.error and clears the saving flag', async () => {
    fetchApiMock.mockRejectedValueOnce(new Error('boom'));
    const user = userEvent.setup();
    render(<Workflows />);

    const saveBtn = screen.getByRole('button', { name: /deploy boolean logic/i });
    await user.click(saveBtn);

    await waitFor(() => {
      expect(notifyObj.error).toHaveBeenCalledTimes(1);
    });
    expect(notifyObj.success).not.toHaveBeenCalled();

    // Saving flag cleared: button label flips back and button is re-enabled.
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /deploy boolean logic/i })
      ).not.toBeDisabled();
    });
  });
});
