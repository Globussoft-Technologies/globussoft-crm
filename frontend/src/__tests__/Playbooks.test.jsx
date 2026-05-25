/**
 * Playbooks.test.jsx — vitest + RTL coverage for the Sales Playbooks page.
 *
 * Scope: pins the page-surface invariants for the playbook editor + the
 * apply-to-deal progress tracker. Playbooks.jsx has TWO load surfaces:
 *   - Library load: /api/playbooks (list) + /api/playbooks/stats + /api/deals
 *   - Per-deal load: /api/playbooks/deal/<dealId> (returns
 *     [{ playbook, progress }, ...] for the selected deal's stage)
 *
 *   1. Renders the heading "Sales Playbooks" + Create Playbook button.
 *   2. Loading state renders "Loading playbooks..." before the first fetch
 *      resolves.
 *   3. Stats tiles render Total / Active / Inactive / Stages Covered with
 *      the values from /api/playbooks/stats.
 *   4. Renders one card per playbook with name + step count + StageBadge.
 *   5. Empty state: "No playbooks yet..." renders when /api/playbooks
 *      returns [].
 *   6. Stage filter: changing the dropdown re-fires /api/playbooks with
 *      ?stage=<value>.
 *   7. Create modal: clicking "Create Playbook" opens a modal titled
 *      "Create Playbook" with a Name input + Stage select + a default
 *      empty step row.
 *   8. Validation: saving with an empty name calls notify.error('Name is
 *      required'). No POST is fired.
 *   9. Validation: saving with name set but every step blank calls
 *      notify.error('At least one step is required'). No POST is fired.
 *  10. Save flow: filling name + one step title and clicking the modal's
 *      "Create Playbook" submit POSTs /api/playbooks with { name, stage,
 *      steps:[{title, description, order:0}], isActive }.
 *  11. Edit flow: clicking "Edit" on a card opens the modal titled
 *      "Edit Playbook" pre-filled with the playbook's name + stage; saving
 *      PUTs /api/playbooks/<id>.
 *  12. Delete flow: clicking the trash button on a card triggers
 *      notify.confirm; on YES, DELETE /api/playbooks/<id> is fired.
 *  13. Duplicate flow: clicking "Duplicate" POSTs /api/playbooks/<id>/duplicate.
 *  14. Apply-to-deal: selecting a deal from the dropdown fires
 *      /api/playbooks/deal/<dealId> and renders the progress card with
 *      pctComplete badge + checkable step rows.
 *  15. Toggle step progress: clicking a step row POSTs
 *      /api/playbooks/deal/<dealId>/step with { playbookId, stepIndex,
 *      completed: <flipped> }.
 *
 * Pattern matched: frontend/src/__tests__/Approvals.test.jsx +
 * Estimates.test.jsx — stable notify object reference (no fresh mocks per
 * render — see CLAUDE.md "RTL: stable mock object references" standing
 * rule), MemoryRouter wrap, fetchApi route-string switch in beforeEach.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Stable notify object so the useNotify() identity stays stable across
// renders. Fresh-per-call mocks here would trigger infinite re-renders
// because notify lands in handler closures.
const notifyError = vi.fn();
const notifyConfirm = vi.fn(() => Promise.resolve(true));
const notifyObj = {
  error: notifyError,
  info: vi.fn(),
  success: vi.fn(),
  confirm: notifyConfirm,
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

import Playbooks from '../pages/Playbooks';

const samplePlaybooks = [
  {
    id: 100,
    name: 'Discovery Call Playbook',
    stage: 'lead',
    isActive: true,
    steps: [
      { title: 'Intro email', description: 'Send intro' },
      { title: 'Qualify budget', description: 'BANT' },
    ],
  },
  {
    id: 101,
    name: 'Closing Playbook',
    stage: 'proposal',
    isActive: false,
    steps: [{ title: 'Send proposal', description: '' }],
  },
];

const sampleStats = {
  total: 2,
  active: 1,
  inactive: 1,
  stages: ['lead', 'proposal'],
};

const sampleDeals = [
  { id: 'd-1', title: 'Acme Renewal', stage: 'lead' },
  { id: 'd-2', title: 'Globex Expansion', stage: 'proposal' },
];

const sampleDealPlaybooks = [
  {
    playbook: {
      id: 100,
      name: 'Discovery Call Playbook',
      stage: 'lead',
      steps: [
        { title: 'Intro email', description: 'Send intro' },
        { title: 'Qualify budget', description: 'BANT' },
      ],
    },
    progress: { completedSteps: [0], pctComplete: 50 },
  },
];

function defaultMock(url, _opts) {
  if (url === '/api/playbooks' || url.startsWith('/api/playbooks?')) {
    return Promise.resolve(samplePlaybooks);
  }
  if (url === '/api/playbooks/stats') return Promise.resolve(sampleStats);
  if (url === '/api/deals') return Promise.resolve(sampleDeals);
  if (url.startsWith('/api/playbooks/deal/')) return Promise.resolve(sampleDealPlaybooks);
  return Promise.resolve(null);
}

function renderPlaybooks() {
  return render(
    <MemoryRouter>
      <Playbooks />
    </MemoryRouter>
  );
}

describe('<Playbooks /> — page surface', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifyConfirm.mockClear();
    notifyConfirm.mockImplementation(() => Promise.resolve(true));
    fetchApiMock.mockImplementation(defaultMock);
  });

  it('renders heading "Sales Playbooks" + Create Playbook button', async () => {
    renderPlaybooks();
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Sales Playbooks/i })).toBeInTheDocument();
    });
    // "Create Playbook" appears twice once the modal opens (button + modal title);
    // before opening the modal there is exactly one trigger button.
    expect(screen.getByRole('button', { name: /Create Playbook/i })).toBeInTheDocument();
  });

  it('shows "Loading playbooks..." before the first fetch resolves', async () => {
    // Use a never-resolving promise for /api/playbooks so loading state sticks.
    let resolvePlaybooks;
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/playbooks' || url.startsWith('/api/playbooks?')) {
        return new Promise((res) => { resolvePlaybooks = res; });
      }
      if (url === '/api/playbooks/stats') return new Promise(() => {});
      if (url === '/api/deals') return new Promise(() => {});
      return Promise.resolve(null);
    });
    renderPlaybooks();
    expect(await screen.findByText(/Loading playbooks\.\.\./i)).toBeInTheDocument();
    // Resolve to keep the test from leaking pending promises.
    resolvePlaybooks?.([]);
  });

  it('renders stats tiles (Total / Active / Inactive / Stages Covered)', async () => {
    renderPlaybooks();
    await waitFor(() => {
      expect(screen.getByText('Total')).toBeInTheDocument();
    });
    // The values come from sampleStats. Active=1 and Inactive=1 share the
    // same numeric value, so disambiguate via getAllByText length.
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Inactive')).toBeInTheDocument();
    expect(screen.getByText(/Stages Covered/i)).toBeInTheDocument();
    // Total = 2, Stages = 2 → number 2 appears at least twice.
    expect(screen.getAllByText('2').length).toBeGreaterThanOrEqual(2);
  });

  it('renders one card per playbook with name + step count + StageBadge', async () => {
    renderPlaybooks();
    await waitFor(() => {
      expect(screen.getByText('Discovery Call Playbook')).toBeInTheDocument();
    });
    expect(screen.getByText('Closing Playbook')).toBeInTheDocument();
    // Step counts: 2 steps + 1 step.
    expect(screen.getByText(/2 steps/i)).toBeInTheDocument();
    expect(screen.getByText(/1 step$/i)).toBeInTheDocument();
    // StageBadge: "Lead" appears on the card AND inside the filter
    // <option>, so getAllByText is required.
    expect(screen.getAllByText('Lead').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Proposal').length).toBeGreaterThanOrEqual(1);
  });

  it('shows the empty-state message when /api/playbooks returns []', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/playbooks' || url.startsWith('/api/playbooks?')) {
        return Promise.resolve([]);
      }
      if (url === '/api/playbooks/stats') return Promise.resolve({ total: 0, active: 0, inactive: 0, stages: [] });
      if (url === '/api/deals') return Promise.resolve([]);
      return Promise.resolve(null);
    });
    renderPlaybooks();
    await waitFor(() => {
      expect(screen.getByText(/No playbooks yet\./i)).toBeInTheDocument();
    });
  });

  it('stage filter: changing dropdown re-fires /api/playbooks?stage=<value>', async () => {
    renderPlaybooks();
    await waitFor(() => expect(screen.getByText('Discovery Call Playbook')).toBeInTheDocument());
    fetchApiMock.mockClear();

    // The stage filter <select> currently has value "" (All stages). Find it
    // by its current display value.
    const filterSelect = screen.getByDisplayValue('All stages');
    fireEvent.change(filterSelect, { target: { value: 'won' } });

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u]) =>
        typeof u === 'string' && /^\/api\/playbooks\?stage=won$/.test(u)
      );
      expect(call).toBeTruthy();
    });
  });

  it('Create modal: clicking "Create Playbook" opens a modal titled "Create Playbook"', async () => {
    renderPlaybooks();
    await waitFor(() => expect(screen.getByText('Discovery Call Playbook')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Create Playbook/i }));

    // Modal opens — heading + Name input + Stage select.
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Create Playbook/i })).toBeInTheDocument();
    });
    expect(screen.getByPlaceholderText(/Discovery Call Playbook/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Step 1 title/i)).toBeInTheDocument();
  });

  it('validation: saving with empty name surfaces "Name is required" notify.error', async () => {
    renderPlaybooks();
    await waitFor(() => expect(screen.getByText('Discovery Call Playbook')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Create Playbook/i }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Create Playbook/i })).toBeInTheDocument();
    });

    fetchApiMock.mockClear();
    // Click the modal's submit "Create Playbook" button. There are TWO buttons
    // with that text (the header trigger + the modal submit) — pick the LAST.
    const allCreateBtns = screen.getAllByRole('button', { name: /Create Playbook/i });
    fireEvent.click(allCreateBtns[allCreateBtns.length - 1]);

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith('Name is required');
    });
    // No POST should have fired.
    const postCall = fetchApiMock.mock.calls.find(
      ([_url, opts]) => opts && opts.method === 'POST'
    );
    expect(postCall).toBeFalsy();
  });

  it('validation: saving with name but no step title surfaces "At least one step is required"', async () => {
    renderPlaybooks();
    await waitFor(() => expect(screen.getByText('Discovery Call Playbook')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Create Playbook/i }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Create Playbook/i })).toBeInTheDocument();
    });

    // Fill name only; leave step title blank.
    const nameInput = screen.getByPlaceholderText(/Discovery Call Playbook/i);
    fireEvent.change(nameInput, { target: { value: 'My New Playbook' } });

    fetchApiMock.mockClear();
    const allCreateBtns = screen.getAllByRole('button', { name: /Create Playbook/i });
    fireEvent.click(allCreateBtns[allCreateBtns.length - 1]);

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith('At least one step is required');
    });
    const postCall = fetchApiMock.mock.calls.find(
      ([_url, opts]) => opts && opts.method === 'POST'
    );
    expect(postCall).toBeFalsy();
  });

  it('save flow: filling name + step then submitting POSTs /api/playbooks with the payload', async () => {
    renderPlaybooks();
    await waitFor(() => expect(screen.getByText('Discovery Call Playbook')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Create Playbook/i }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Create Playbook/i })).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText(/Discovery Call Playbook/i), {
      target: { value: 'Onboarding Playbook' },
    });
    fireEvent.change(screen.getByPlaceholderText(/Step 1 title/i), {
      target: { value: 'Kickoff call' },
    });

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/playbooks' && opts?.method === 'POST') {
        return Promise.resolve({ id: 999 });
      }
      return defaultMock(url, opts);
    });

    const allCreateBtns = screen.getAllByRole('button', { name: /Create Playbook/i });
    fireEvent.click(allCreateBtns[allCreateBtns.length - 1]);

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/playbooks' && opts?.method === 'POST'
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body.name).toBe('Onboarding Playbook');
      expect(body.stage).toBe('lead');
      expect(body.isActive).toBe(true);
      expect(body.steps).toEqual([
        { title: 'Kickoff call', description: '', order: 0 },
      ]);
    });
  });

  it('edit flow: clicking Edit opens "Edit Playbook" modal pre-filled and PUTs on save', async () => {
    renderPlaybooks();
    await waitFor(() => expect(screen.getByText('Discovery Call Playbook')).toBeInTheDocument());

    // Click the FIRST Edit button (Discovery Call Playbook).
    const editBtns = screen.getAllByRole('button', { name: /^\s*Edit\s*$/i });
    expect(editBtns.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(editBtns[0]);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Edit Playbook/i })).toBeInTheDocument();
    });

    // Name pre-filled.
    const nameInput = screen.getByPlaceholderText(/Discovery Call Playbook/i);
    expect(nameInput).toHaveValue('Discovery Call Playbook');

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/playbooks/100' && opts?.method === 'PUT') {
        return Promise.resolve({ id: 100 });
      }
      return defaultMock(url, opts);
    });

    // Submit ("Save Changes" button).
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/i }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/playbooks/100' && opts?.method === 'PUT'
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body.name).toBe('Discovery Call Playbook');
      expect(body.stage).toBe('lead');
      expect(body.isActive).toBe(true);
      expect(body.steps.length).toBe(2);
    });
  });

  it('delete flow: clicking trash → notify.confirm yes → DELETE /api/playbooks/<id>', async () => {
    renderPlaybooks();
    await waitFor(() => expect(screen.getByText('Discovery Call Playbook')).toBeInTheDocument());

    // Each card has Edit / Duplicate / Trash + a toggle-active button. The
    // trash button has no accessible text — find it by the danger background
    // colour (`rgba(239,68,68,0.12)`). Scope to the Discovery card by walking
    // up the DOM from its name node to the card root (4 levels up: name span
    // → name wrapper → header row → card root).
    const nameNode = screen.getByText('Discovery Call Playbook');
    // Walk up to the playbook card root by looking for the parent whose
    // first child contains the StageBadge "Lead" — easier to do via the
    // grid container: find an ancestor that contains BOTH "Edit" and a
    // "Duplicate" button.
    let card = nameNode;
    while (card && card.parentElement) {
      card = card.parentElement;
      const txt = card.textContent || '';
      if (txt.includes('Edit') && txt.includes('Duplicate') && txt.includes('Discovery Call Playbook')) {
        break;
      }
    }
    expect(card).toBeTruthy();
    const cardButtons = Array.from(card.querySelectorAll('button'));
    // Among the action-row buttons (Edit / Duplicate / Trash), the trash one
    // is the icon-only button (Edit + Duplicate both have text labels). The
    // toggle-active power button also has no text, but it sits in the HEADER
    // row of the card; the trash button sits in the ACTIONS row alongside
    // Edit + Duplicate. Filter to icon-only buttons, then exclude any whose
    // immediate prev-sibling text suggests it's NOT in the actions row.
    // Simpler: take all icon-only buttons; the trash button has style.color
    // === '#ef4444' (danger), while the toggle has color '#94a3b8' or '#e2e8f0'.
    const iconOnly = cardButtons.filter(
      (b) => b.textContent.trim() === '' && b.querySelector('svg')
    );
    const trashBtn = iconOnly.find((b) => {
      const color = b.style && b.style.color;
      return color && color.includes('239, 68, 68');
    });
    expect(trashBtn).toBeTruthy();

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/playbooks/100' && opts?.method === 'DELETE') {
        return Promise.resolve({});
      }
      return defaultMock(url, opts);
    });

    fireEvent.click(trashBtn);

    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalled();
    });
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/playbooks/100' && opts?.method === 'DELETE'
      );
      expect(call).toBeTruthy();
    });
  });

  it('duplicate flow: clicking Duplicate POSTs /api/playbooks/<id>/duplicate', async () => {
    renderPlaybooks();
    await waitFor(() => expect(screen.getByText('Discovery Call Playbook')).toBeInTheDocument());

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/playbooks/100/duplicate' && opts?.method === 'POST') {
        return Promise.resolve({ id: 200 });
      }
      return defaultMock(url, opts);
    });

    const dupBtns = screen.getAllByRole('button', { name: /Duplicate/i });
    fireEvent.click(dupBtns[0]);

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/playbooks/100/duplicate' && opts?.method === 'POST'
      );
      expect(call).toBeTruthy();
    });
  });

  it('apply-to-deal: selecting a deal fires /api/playbooks/deal/<id> and renders the progress card', async () => {
    renderPlaybooks();
    await waitFor(() => expect(screen.getByText('Discovery Call Playbook')).toBeInTheDocument());

    // The Apply-to-Deal <select> shows "Select a deal..." initially.
    const dealSelect = screen.getByDisplayValue(/Select a deal\.\.\./i);
    fireEvent.change(dealSelect, { target: { value: 'd-1' } });

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u]) =>
        typeof u === 'string' && u === '/api/playbooks/deal/d-1'
      );
      expect(call).toBeTruthy();
    });

    // Progress card renders with the pctComplete badge.
    await waitFor(() => {
      expect(screen.getByText('50%')).toBeInTheDocument();
    });
    // Step titles render. "Discovery Call Playbook" now appears in BOTH
    // the library card AND the apply-to-deal progress card, so getAllByText.
    expect(screen.getAllByText('Discovery Call Playbook').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Intro email')).toBeInTheDocument();
    expect(screen.getByText('Qualify budget')).toBeInTheDocument();
  });

  it('toggle step progress: clicking a step POSTs /api/playbooks/deal/<id>/step with flipped completed', async () => {
    renderPlaybooks();
    await waitFor(() => expect(screen.getByText('Discovery Call Playbook')).toBeInTheDocument());

    const dealSelect = screen.getByDisplayValue(/Select a deal\.\.\./i);
    fireEvent.change(dealSelect, { target: { value: 'd-1' } });

    await waitFor(() => expect(screen.getByText('50%')).toBeInTheDocument());

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/playbooks/deal/d-1/step' && opts?.method === 'POST') {
        return Promise.resolve({ ok: true });
      }
      return defaultMock(url, opts);
    });

    // Step index 0 ("Intro email") is currently completed (in completedSteps).
    // Clicking it should fire { stepIndex: 0, completed: false }. Step index
    // 1 ("Qualify budget") is NOT completed; click it → completed: true.
    const stepRow = screen.getByText('Qualify budget').closest('div').parentElement;
    fireEvent.click(stepRow);

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/playbooks/deal/d-1/step' && opts?.method === 'POST'
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body.playbookId).toBe(100);
      expect(body.stepIndex).toBe(1);
      expect(body.completed).toBe(true);
    });
  });
});
