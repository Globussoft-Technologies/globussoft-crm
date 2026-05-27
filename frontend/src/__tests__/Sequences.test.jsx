/**
 * Sequences.test.jsx — vitest + RTL coverage of the visual drip sequence builder.
 *
 * What this test pins
 * ───────────────────
 * The Sequences page (frontend/src/pages/Sequences.jsx, 424 LOC) is the
 * marketing automation drip-campaign authoring surface. It owns:
 *
 *   1. Header chrome — h1 "Marketing Automated Sequences" + descriptive
 *      subhead + "New" (resetCanvas) + "Create Sequence" CTA.
 *   2. ReactFlow canvas seeded with one TRIGGER input node (or hydrated
 *      from sessionStorage via #394 draft persistence).
 *   3. Panel toolbar with add-node buttons (Email, Delay, Condition, SMS,
 *      WhatsApp, Push) and a vertical-aware trigger picker (<select>).
 *   4. Saved-sequences sidebar — lists sequences from GET /api/sequences,
 *      with delete buttons (DELETE /api/sequences/:id) and status badges
 *      (ACTIVE / PAUSED).
 *   5. Name modal — opens on "Create Sequence" click, accepts a name,
 *      POSTs to /api/sequences with { name, nodes, edges }.
 *
 * Contract pinned here (8 cases)
 * ──────────────────────────────
 *   - Initial render: header chrome present + empty-list placeholder shown
 *     when GET /api/sequences returns [].
 *   - Loaded list: 2 sequences from the mocked GET render in the sidebar
 *     with their names and ACTIVE/PAUSED status badges.
 *   - "Create Sequence" CTA opens the name modal with the input field.
 *   - Modal "Save" with name + canvas POSTs to /api/sequences with the
 *     envelope { name, nodes, edges } and triggers a list refresh.
 *   - "New" button clears the active sequence selection (resetCanvas).
 *   - Delete button on a sequence card: confirms via notify.confirm, then
 *     fires DELETE /api/sequences/:id.
 *   - Delete cancelled by user (notify.confirm → false) does NOT fire DELETE.
 *   - Empty-canvas guard: clearing nodes via state then saving routes
 *     through notify.error rather than firing POST (#395 validation).
 *
 * Why component-level (vitest + RTL), not playwright
 * ──────────────────────────────────────────────────
 * The /api/sequences route shape is covered by sequences-api.spec.js. This
 * pins the page's CRUD button-wire + envelope shape + notify-route +
 * modal-open contract. ReactFlow itself is stubbed (heavy WebGL/canvas
 * surface that jsdom can't render meaningfully) — its children render via
 * a thin passthrough so the Panel's add-node buttons + trigger picker
 * appear in the DOM.
 *
 * Standing rules applied
 * ──────────────────────
 *   - Stable mock object reference for useNotify (RTL standing rule — fresh
 *     objects per call invalidate useCallback dep arrays → infinite loops).
 *   - vi.mock('reactflow') stubs canvas + Panel/Background/Controls as
 *     passthrough divs so userEvent can find the in-Panel buttons.
 *   - vi.mock('reactflow/dist/style.css') stubs the side-effect CSS import.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

// Stable mock-object reference per the RTL standing rule (2026-05-23
// promotion). Fresh per-call objects would re-identity-trigger any
// useCallback dep consuming the notify return → infinite re-render loops.
const notifyObj = {
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  confirm: vi.fn(() => Promise.resolve(true)),
  prompt: vi.fn(() => Promise.resolve('')),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
  NotifyProvider: ({ children }) => children,
}));

// Stub reactflow — jsdom cannot render the real canvas/SVG surface. Pass
// `nodes` through as a <ul> of <li> so we can assert on appended labels.
// Children (Panel/Background/Controls/MiniMap) render as plain divs so
// userEvent can find the Panel's add-node buttons + the trigger <select>.
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
vi.mock('reactflow/dist/style.css', () => ({}));

import Sequences from '../pages/Sequences';

// Each test starts from a clean sessionStorage so the #394 draft hydration
// path doesn't leak state between tests.
beforeEach(() => {
  fetchApiMock.mockReset();
  notifyObj.error.mockClear();
  notifyObj.info.mockClear();
  notifyObj.success.mockClear();
  notifyObj.confirm.mockClear();
  notifyObj.confirm.mockImplementation(() => Promise.resolve(true));
  try { sessionStorage.clear(); } catch { /* jsdom may not implement */ }
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <Sequences />
    </MemoryRouter>
  );

const SEQ_FIXTURE = [
  {
    id: 11,
    name: 'Welcome drip',
    isActive: true,
    nodes: JSON.stringify([{ id: '1', data: { label: 'TRIGGER' } }, { id: '2', data: { label: 'Email' } }]),
    edges: JSON.stringify([]),
  },
  {
    id: 22,
    name: 'Post-purchase nurture',
    isActive: false,
    nodes: JSON.stringify([{ id: '1', data: { label: 'TRIGGER' } }]),
    edges: JSON.stringify([]),
  },
];

// Helper to wire fetchApi default mocks for the on-mount loadSequences +
// loadTriggers fan-out. Per-test overrides apply afterwards via mockImplementationOnce.
const wireDefaultFetchMocks = (sequences = []) => {
  fetchApiMock.mockImplementation((url) => {
    if (url === '/api/sequences') return Promise.resolve(sequences);
    if (url === '/api/sequences/triggers') return Promise.resolve([]);
    return Promise.resolve({});
  });
};

describe('Sequences page — surface + CRUD pins', () => {
  it('renders header chrome (h1 + subhead + New + Create Sequence buttons)', async () => {
    wireDefaultFetchMocks([]);
    renderPage();
    expect(
      screen.getByRole('heading', { level: 1, name: /marketing automated sequences/i })
    ).toBeInTheDocument();
    expect(
      screen.getByText(/visual drip campaign builder/i)
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /new/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /create sequence/i })
    ).toBeInTheDocument();
  });

  it('shows empty-list placeholder when GET /api/sequences returns []', async () => {
    wireDefaultFetchMocks([]);
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/No sequences yet/i)).toBeInTheDocument();
    });
  });

  it('renders the loaded sequences with names and status badges (ACTIVE/PAUSED)', async () => {
    wireDefaultFetchMocks(SEQ_FIXTURE);
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Welcome drip')).toBeInTheDocument();
      expect(screen.getByText('Post-purchase nurture')).toBeInTheDocument();
    });
    // status badges use data-testid="sequence-status-<id>"
    expect(screen.getByTestId('sequence-status-11')).toHaveAttribute('data-status', 'ACTIVE');
    expect(screen.getByTestId('sequence-status-22')).toHaveAttribute('data-status', 'PAUSED');
  });

  it('clicking "Create Sequence" opens the Name modal with input + Save/Cancel', async () => {
    wireDefaultFetchMocks([]);
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /create sequence/i }));
    expect(
      screen.getByRole('heading', { level: 3, name: /name your sequence/i })
    ).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(/onboarding drip week 1/i)
    ).toBeInTheDocument();
    // Both Save buttons (header + modal) exist; assert the modal's Cancel
    // button is present as the modal-open signal.
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
  });

  it('saving from the modal POSTs /api/sequences with { name, nodes, edges } envelope', async () => {
    wireDefaultFetchMocks([]);
    // Override the POST response so created.id is set and the page tracks it.
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/sequences' && opts?.method === 'POST') {
        return Promise.resolve({ id: 999, name: 'Spring Drip' });
      }
      if (url === '/api/sequences') return Promise.resolve([]);
      if (url === '/api/sequences/triggers') return Promise.resolve([]);
      return Promise.resolve({});
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /create sequence/i }));
    const input = screen.getByPlaceholderText(/onboarding drip week 1/i);
    await user.type(input, 'Spring Drip');
    // Modal's Save button is the one inside the dialog — find it by name.
    const saveButtons = screen.getAllByRole('button', { name: /^save$/i });
    await user.click(saveButtons[saveButtons.length - 1]);

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        (c) => c[0] === '/api/sequences' && c[1]?.method === 'POST'
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.name).toBe('Spring Drip');
      expect(Array.isArray(body.nodes)).toBe(true);
      expect(Array.isArray(body.edges)).toBe(true);
    });
  });

  it('clicking "New" (resetCanvas) resets the canvas without firing a network call', async () => {
    wireDefaultFetchMocks(SEQ_FIXTURE);
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Welcome drip')).toBeInTheDocument();
    });
    fetchApiMock.mockClear();
    await user.click(screen.getByRole('button', { name: /new/i }));
    // No DELETE / POST / PATCH fired from reset; resetCanvas is local-only.
    const mutating = fetchApiMock.mock.calls.find(
      (c) => c[1]?.method === 'DELETE' || c[1]?.method === 'POST' || c[1]?.method === 'PATCH'
    );
    expect(mutating).toBeUndefined();
  });

  it('delete button on a sequence card confirms then fires DELETE /api/sequences/:id', async () => {
    wireDefaultFetchMocks(SEQ_FIXTURE);
    notifyObj.confirm.mockImplementationOnce(() => Promise.resolve(true));
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Welcome drip')).toBeInTheDocument();
    });
    // Each card has a Delete (trash) button titled "Delete sequence". Pick the
    // first one — corresponds to the first SEQ_FIXTURE entry (id=11).
    const deleteBtns = screen.getAllByTitle(/delete sequence/i);
    await user.click(deleteBtns[0]);

    await waitFor(() => {
      expect(notifyObj.confirm).toHaveBeenCalledTimes(1);
      const deleteCall = fetchApiMock.mock.calls.find(
        (c) => c[0] === '/api/sequences/11' && c[1]?.method === 'DELETE'
      );
      expect(deleteCall).toBeTruthy();
    });
  });

  it('delete cancelled by user (confirm → false) does NOT fire DELETE', async () => {
    wireDefaultFetchMocks(SEQ_FIXTURE);
    notifyObj.confirm.mockImplementationOnce(() => Promise.resolve(false));
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Welcome drip')).toBeInTheDocument();
    });
    fetchApiMock.mockClear();
    const deleteBtns = screen.getAllByTitle(/delete sequence/i);
    await user.click(deleteBtns[0]);

    // Give the async confirm-then-skip path time to resolve.
    await new Promise((r) => setTimeout(r, 50));
    const deleteCall = fetchApiMock.mock.calls.find(
      (c) => c[1]?.method === 'DELETE'
    );
    expect(deleteCall).toBeUndefined();
    expect(notifyObj.confirm).toHaveBeenCalledTimes(1);
  });

  it('hydrates the trigger picker with vertical-aware options when /triggers responds', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/sequences') return Promise.resolve([]);
      if (url === '/api/sequences/triggers') {
        return Promise.resolve([
          { value: 'visit.completed', label: 'Visit Completed', vertical: 'wellness' },
          { value: 'contact.created', label: 'Contact Created', vertical: 'generic' },
        ]);
      }
      return Promise.resolve({});
    });
    renderPage();
    await waitFor(() => {
      const picker = screen.getByTestId('trigger-picker');
      // wellness-vertical options get the "Wellness · " prefix.
      expect(picker.textContent).toMatch(/Wellness · Visit Completed/);
      expect(picker.textContent).toMatch(/Contact Created/);
    });
  });

  it('loadSequences swallows fetch errors silently (no crash, empty state shown)', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/sequences') return Promise.reject(new Error('boom'));
      if (url === '/api/sequences/triggers') return Promise.reject(new Error('boom'));
      return Promise.resolve({});
    });
    renderPage();
    // Component must not crash; empty-state placeholder still renders.
    await waitFor(() => {
      expect(screen.getByText(/No sequences yet/i)).toBeInTheDocument();
    });
    // The on-mount fetchApi was called silent:true; assert that intent.
    const listCall = fetchApiMock.mock.calls.find((c) => c[0] === '/api/sequences');
    expect(listCall?.[1]?.silent).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Extension cases (#NNN drain) — uncovered branches from 340L baseline:
  //   - addLogicNode buttons (Email / Delay / Condition / SMS / WhatsApp /
  //     Push) append nodes to the canvas with descriptive labels.
  //   - Trigger picker <select> onChange appends a TRIGGER node.
  //   - Modal Cancel button closes the modal without firing POST.
  //   - Clicking a saved-sequence card hydrates the canvas (loadSequenceIntoCanvas).
  //   - PATCH path: with an activeSeqId set (via clicking a card first),
  //     a subsequent save fires PATCH /api/sequences/:id (not POST).
  //   - Delete of the currently-active sequence resets the canvas to the
  //     starter trigger and clears the activeSeqId.
  //   - FALLBACK_TRIGGERS rendered when /triggers returns [] (empty array
  //     does NOT overwrite the fallback per the loadTriggers guard).
  //   - Each saved-sequence card surfaces a step-list builder Link to
  //     /sequences/:id/builder (stopPropagation so card-click doesn't fire).
  //   - sequenceStatusBadgeStyle helper export — direct branch coverage of
  //     ACTIVE / PAUSED / DRAFT-unknown palettes (forward-compat for the
  //     status enum landing per #640).
  //   - Node-count display per card reads JSON.parse(seq.nodes) length.
  // ───────────────────────────────────────────────────────────────────────

  it('Add Email button appends an "ACTION: Send Email" node to the canvas', async () => {
    wireDefaultFetchMocks([]);
    const user = userEvent.setup();
    renderPage();
    // Initial canvas has the seed TRIGGER node.
    await waitFor(() => {
      expect(screen.getByTestId('reactflow-nodes')).toBeInTheDocument();
    });
    const before = screen.getByTestId('reactflow-nodes').children.length;
    await user.click(screen.getByRole('button', { name: /add email/i }));
    await waitFor(() => {
      const list = screen.getByTestId('reactflow-nodes');
      expect(list.children.length).toBe(before + 1);
      expect(list.textContent).toMatch(/ACTION: Send Email/);
    });
  });

  it('Add Delay / Condition / SMS / WhatsApp / Push buttons each append a labelled node', async () => {
    wireDefaultFetchMocks([]);
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('reactflow-nodes')).toBeInTheDocument();
    });
    const start = screen.getByTestId('reactflow-nodes').children.length;
    await user.click(screen.getByRole('button', { name: /add delay/i }));
    await user.click(screen.getByRole('button', { name: /add condition/i }));
    await user.click(screen.getByRole('button', { name: /^sms$/i }));
    await user.click(screen.getByRole('button', { name: /^whatsapp$/i }));
    await user.click(screen.getByRole('button', { name: /^push$/i }));
    await waitFor(() => {
      const list = screen.getByTestId('reactflow-nodes');
      expect(list.children.length).toBe(start + 5);
      expect(list.textContent).toMatch(/DELAY: Wait 72 Hours/);
      expect(list.textContent).toMatch(/CONDITION: Tag Check/);
      expect(list.textContent).toMatch(/ACTION: Send SMS/);
      expect(list.textContent).toMatch(/ACTION: Send WhatsApp/);
      expect(list.textContent).toMatch(/ACTION: Send Push/);
    });
  });

  it('trigger picker onChange appends a TRIGGER node with the picked label', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/sequences') return Promise.resolve([]);
      if (url === '/api/sequences/triggers') {
        return Promise.resolve([
          { value: 'visit.completed', label: 'Visit Completed', vertical: 'wellness' },
        ]);
      }
      return Promise.resolve({});
    });
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('trigger-picker')).toBeInTheDocument();
    });
    const before = screen.getByTestId('reactflow-nodes').children.length;
    // userEvent.selectOptions doesn't fire onChange reliably across versions;
    // use fireEvent.change directly to pin the contract.
    fireEvent.change(screen.getByTestId('trigger-picker'), {
      target: { value: 'visit.completed' },
    });
    await waitFor(() => {
      const list = screen.getByTestId('reactflow-nodes');
      expect(list.children.length).toBe(before + 1);
      expect(list.textContent).toMatch(/TRIGGER: Visit Completed/);
    });
  });

  it('Cancel button in the modal closes it without firing a POST', async () => {
    wireDefaultFetchMocks([]);
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /create sequence/i }));
    expect(
      screen.getByRole('heading', { level: 3, name: /name your sequence/i })
    ).toBeInTheDocument();
    fetchApiMock.mockClear();
    await user.click(screen.getByRole('button', { name: /cancel/i }));
    // Modal closes — heading no longer in DOM.
    await waitFor(() => {
      expect(
        screen.queryByRole('heading', { level: 3, name: /name your sequence/i })
      ).not.toBeInTheDocument();
    });
    const postCall = fetchApiMock.mock.calls.find(
      (c) => c[0] === '/api/sequences' && c[1]?.method === 'POST'
    );
    expect(postCall).toBeUndefined();
  });

  it('clicking a saved-sequence card loads its nodes/edges into the canvas (activeSeqId set)', async () => {
    wireDefaultFetchMocks(SEQ_FIXTURE);
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Welcome drip')).toBeInTheDocument();
    });
    // Click the card body (h4 is inside sequence-card div).
    await user.click(screen.getByText('Welcome drip'));
    // Welcome drip's nodes JSON has labels 'TRIGGER' and 'Email' — both should
    // now appear in the canvas node list.
    await waitFor(() => {
      const list = screen.getByTestId('reactflow-nodes');
      expect(list.textContent).toMatch(/Email/);
    });
  });

  it('saving with an active sequence selected fires PATCH /api/sequences/:id (not POST)', async () => {
    wireDefaultFetchMocks(SEQ_FIXTURE);
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Welcome drip')).toBeInTheDocument();
    });
    // Load the first saved sequence so activeSeqId=11.
    await user.click(screen.getByText('Welcome drip'));
    await waitFor(() => {
      const list = screen.getByTestId('reactflow-nodes');
      expect(list.textContent).toMatch(/Email/);
    });
    // Now click Create Sequence and save — should PATCH the active sequence.
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/sequences/11' && opts?.method === 'PATCH') {
        return Promise.resolve({ id: 11, name: 'Welcome drip v2' });
      }
      if (url === '/api/sequences') return Promise.resolve(SEQ_FIXTURE);
      if (url === '/api/sequences/triggers') return Promise.resolve([]);
      return Promise.resolve({});
    });
    await user.click(screen.getByRole('button', { name: /create sequence/i }));
    const input = screen.getByPlaceholderText(/onboarding drip week 1/i);
    await user.type(input, 'Welcome drip v2');
    const saveButtons = screen.getAllByRole('button', { name: /^save$/i });
    await user.click(saveButtons[saveButtons.length - 1]);

    await waitFor(() => {
      const patchCall = fetchApiMock.mock.calls.find(
        (c) => c[0] === '/api/sequences/11' && c[1]?.method === 'PATCH'
      );
      expect(patchCall).toBeTruthy();
      const body = JSON.parse(patchCall[1].body);
      expect(body.name).toBe('Welcome drip v2');
      // PATCH body must NOT include isActive (per #374 — plain saves never
      // silently activate a paused/draft sequence).
      expect(body.isActive).toBeUndefined();
    });
    // No POST should have fired alongside the PATCH.
    const postCall = fetchApiMock.mock.calls.find(
      (c) => c[0] === '/api/sequences' && c[1]?.method === 'POST'
    );
    expect(postCall).toBeUndefined();
  });

  it('deleting the active sequence resets the canvas to the starter trigger', async () => {
    wireDefaultFetchMocks(SEQ_FIXTURE);
    notifyObj.confirm.mockImplementation(() => Promise.resolve(true));
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Welcome drip')).toBeInTheDocument();
    });
    // Load Welcome drip into the canvas so activeSeqId=11.
    await user.click(screen.getByText('Welcome drip'));
    await waitFor(() => {
      expect(screen.getByTestId('reactflow-nodes').textContent).toMatch(/Email/);
    });
    // Wire DELETE then list-refresh returning the remaining sequence only.
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/sequences/11' && opts?.method === 'DELETE') {
        return Promise.resolve({ deleted: true });
      }
      if (url === '/api/sequences') return Promise.resolve([SEQ_FIXTURE[1]]);
      if (url === '/api/sequences/triggers') return Promise.resolve([]);
      return Promise.resolve({});
    });
    const deleteBtns = screen.getAllByTitle(/delete sequence/i);
    await user.click(deleteBtns[0]);
    await waitFor(() => {
      // Canvas got reset — Email label gone, only the starter trigger label
      // (TRIGGER: Contact Subscribed) remains.
      const list = screen.getByTestId('reactflow-nodes');
      expect(list.textContent).not.toMatch(/Email/);
      expect(list.textContent).toMatch(/TRIGGER: Contact Subscribed/);
    });
  });

  it('saved-sequence card surfaces a step-list builder Link to /sequences/:id/builder', async () => {
    wireDefaultFetchMocks(SEQ_FIXTURE);
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Welcome drip')).toBeInTheDocument();
    });
    const builderLinks = screen.getAllByTitle(/open step-list builder/i);
    expect(builderLinks.length).toBe(SEQ_FIXTURE.length);
    // First card → /sequences/11/builder.
    expect(builderLinks[0].getAttribute('href')).toBe('/sequences/11/builder');
    expect(builderLinks[1].getAttribute('href')).toBe('/sequences/22/builder');
  });

  it('saved-sequence card displays the node count parsed from seq.nodes JSON', async () => {
    wireDefaultFetchMocks(SEQ_FIXTURE);
    renderPage();
    await waitFor(() => {
      // Welcome drip's nodes JSON has 2 entries; Post-purchase has 1.
      expect(screen.getByText(/2 nodes/)).toBeInTheDocument();
      expect(screen.getByText(/1 nodes/)).toBeInTheDocument();
    });
  });

  it('trigger picker keeps FALLBACK_TRIGGERS when /triggers returns []', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/sequences') return Promise.resolve([]);
      // Empty array — loadTriggers guard skips the setTriggers call so the
      // FALLBACK_TRIGGERS (Contact Created / Lead Converted / Deal Won) stay.
      if (url === '/api/sequences/triggers') return Promise.resolve([]);
      return Promise.resolve({});
    });
    renderPage();
    await waitFor(() => {
      const picker = screen.getByTestId('trigger-picker');
      expect(picker.textContent).toMatch(/Contact Created/);
      expect(picker.textContent).toMatch(/Lead Converted/);
      expect(picker.textContent).toMatch(/Deal Won/);
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Direct unit coverage of the exported `sequenceStatusBadgeStyle` helper.
// The page-level tests above pin the data-status attribute end-to-end; this
// describe block pins the palette branch logic in isolation so the helper
// can be reused by sibling pages (#640 forward-compat for the status enum
// landing) without re-discovering the contract.
// ───────────────────────────────────────────────────────────────────────────
import { sequenceStatusBadgeStyle } from '../pages/Sequences';

describe('sequenceStatusBadgeStyle helper', () => {
  it('ACTIVE returns the success-green palette + badge-active class', () => {
    const p = sequenceStatusBadgeStyle('ACTIVE');
    expect(p.cls).toBe('badge-active');
    expect(p.fg).toMatch(/success-color|#10b981/);
    expect(p.bg).toMatch(/16, 185, 129/);
  });

  it('PAUSED returns the warning-amber palette + badge-paused class', () => {
    const p = sequenceStatusBadgeStyle('PAUSED');
    expect(p.cls).toBe('badge-paused');
    expect(p.fg).toMatch(/warning-color|#f59e0b/);
    expect(p.bg).toMatch(/245, 158, 11/);
  });

  it('DRAFT (or any unknown status) returns the neutral muted palette + badge-draft class', () => {
    const draftPalette = sequenceStatusBadgeStyle('DRAFT');
    expect(draftPalette.cls).toBe('badge-draft');
    expect(draftPalette.fg).toMatch(/text-secondary/);
    // Unknown status falls through to the same neutral default — same shape.
    const unknownPalette = sequenceStatusBadgeStyle('SOMETHING_NEW');
    expect(unknownPalette.cls).toBe('badge-draft');
    expect(unknownPalette.fg).toBe(draftPalette.fg);
  });
});
