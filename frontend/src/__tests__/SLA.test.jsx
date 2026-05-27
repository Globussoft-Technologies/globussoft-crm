/**
 * SLA.test.jsx — vitest + RTL coverage for the SLA Policies & Breaches page.
 *
 * Scope: pins the page-surface invariants for the 3-tab SLA console
 * (frontend/src/pages/SLA.jsx, 627 LOC):
 *   1. Page renders the heading "SLA Policies & Breaches", header subtitle,
 *      Refresh + Apply-to-Tickets buttons, and the 4 stat cards
 *      (Active Policies, Breaches Today, Avg Response, Avg Resolve).
 *   2. Mount-time loads: /api/sla/stats, /api/sla/policies, /api/sla/breaches,
 *      /api/canned-responses are each called on the initial render.
 *   3. Policies tab (default): renders one row per policy from
 *      /api/sla/policies with name, PriorityBadge (Urgent / High / Medium /
 *      Low), response target, resolve target, Active/Inactive label, and
 *      Edit/Delete icon buttons.
 *   4. Policies tab: empty-state copy "No SLA policies yet. Create one to
 *      start tracking." renders when /api/sla/policies returns [].
 *   5. Breaches tab: clicking the "Breaches" tab swaps the body to a list
 *      of breached tickets; sample row renders subject, priority badge,
 *      "Response Xh Ym overdue" / "Resolve Xh Ym overdue" badges.
 *   6. Breaches tab empty: "No tickets currently in breach. Great work!"
 *      copy renders when /api/sla/breaches returns [].
 *   7. Canned tab: clicking "Canned Responses" tab swaps to the card grid;
 *      sample card renders name, category chip, and content preview.
 *   8. New Policy modal: clicking "New Policy" opens a modal titled
 *      "New SLA Policy" with Policy Name input, Priority select containing
 *      the 4 PRIORITIES (Low/Medium/High/Urgent), and two minute-target
 *      number inputs.
 *   9. Policy validation — name required: submitting the modal with an
 *      empty name surfaces the "Policy name is required" error and does
 *      NOT POST /api/sla/policies.
 *  10. Policy validation — responseMinutes >= 1 (issue #465): submitting
 *      the modal with responseMinutes = 0 surfaces "Response Target must
 *      be at least 1 minute" and blocks the POST.
 *  11. Policy validation — resolveMinutes >= 1 (issue #465): submitting
 *      with resolveMinutes = 0 surfaces "Resolve Target must be at least
 *      1 minute" and blocks the POST.
 *  12. Create policy happy path: filling name + priority + targets and
 *      clicking "Create Policy" POSTs /api/sla/policies with the form body
 *      and re-fetches the policy list + stats.
 *  13. Apply-to-Tickets: clicking the header "Apply to Tickets" button
 *      POSTs /api/sla/apply-all and surfaces the applied/skipped notify.
 *  14. Refresh: clicking the header "Refresh" button re-fires the 4 GETs.
 *
 * Backend contracts pinned by this test:
 *   GET    /api/sla/stats
 *   GET    /api/sla/policies
 *   GET    /api/sla/breaches
 *   GET    /api/canned-responses
 *   POST   /api/sla/policies          { name, priority, responseMinutes, resolveMinutes, isActive }
 *   POST   /api/sla/apply-all
 *   PUT    /api/sla/policies/:id      (toggle / edit)
 *   DELETE /api/sla/policies/:id
 *
 * Standing-rules adherence:
 *   - Stable mock object reference for useNotify (avoids useCallback identity
 *     flap → infinite re-render — CLAUDE.md "RTL: stable mock object
 *     references for hooks used in useCallback dependencies").
 *   - Uses getAllByText where priority/severity labels appear as both
 *     filter-style badges and row badges.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

// Stable notify object — CLAUDE.md standing rule on useCallback-deps identity.
const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyInfo = vi.fn();
const notifyConfirm = vi.fn(() => Promise.resolve(true));
const notifyObj = {
  error: notifyError,
  info: notifyInfo,
  success: notifySuccess,
  confirm: notifyConfirm,
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

import { AuthContext } from '../App';
import SLA from '../pages/SLA';

const ADMIN_USER = { userId: 1, name: 'Admin', email: 'a@x.com', role: 'ADMIN' };

const samplePolicies = [
  {
    id: 1,
    name: 'Urgent Standard',
    priority: 'Urgent',
    responseMinutes: 15,
    resolveMinutes: 240,
    isActive: true,
  },
  {
    id: 2,
    name: 'Medium Business',
    priority: 'Medium',
    responseMinutes: 120,
    resolveMinutes: 1440,
    isActive: false,
  },
];

const sampleBreaches = [
  {
    id: 501,
    subject: 'Email delivery delay for Acme tenant',
    status: 'open',
    priority: 'High',
    assignee: { name: 'Priya Sharma' },
    responseBreach: true,
    resolveBreach: false,
    responseOverdueMinutes: 75,
    resolveOverdueMinutes: 0,
  },
  {
    id: 502,
    subject: 'Outage report from Globus India ops',
    status: 'in_progress',
    priority: 'Urgent',
    assignee: { name: 'Rahul Kumar' },
    responseBreach: false,
    resolveBreach: true,
    responseOverdueMinutes: 0,
    resolveOverdueMinutes: 360,
  },
];

const sampleCanned = [
  {
    id: 11,
    name: 'Apology for delay',
    content: 'Hi {{contact.name}}, we apologise for the delay in responding…',
    category: 'Apology',
  },
];

const sampleStats = {
  activePolicies: 3,
  breachesToday: 4,
  avgResponseMinutes: 42,
  avgResolveMinutes: 480,
};

function renderSLA(user = ADMIN_USER) {
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={{ user, token: 'tk', tenant: { id: 1 }, loading: false }}>
        <SLA />
      </AuthContext.Provider>
    </MemoryRouter>
  );
}

function defaultFetchImpl(url) {
  if (url === '/api/sla/stats') return Promise.resolve(sampleStats);
  if (url === '/api/sla/policies') return Promise.resolve(samplePolicies);
  if (url === '/api/sla/breaches') return Promise.resolve(sampleBreaches);
  if (url === '/api/canned-responses') return Promise.resolve(sampleCanned);
  return Promise.resolve(null);
}

describe('<SLA /> — page surface', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifySuccess.mockReset();
    notifyInfo.mockReset();
    notifyConfirm.mockReset();
    notifyConfirm.mockImplementation(() => Promise.resolve(true));
    fetchApiMock.mockImplementation(defaultFetchImpl);
  });

  it('renders heading + subtitle + Refresh + Apply-to-Tickets buttons', async () => {
    renderSLA();
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: /SLA Policies & Breaches/i })
      ).toBeInTheDocument();
    });
    expect(
      screen.getByText(/Define service-level targets and monitor ticket breaches/i)
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Refresh/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Apply to Tickets/i })).toBeInTheDocument();
  });

  it('fetches stats + policies + breaches + canned on mount', async () => {
    renderSLA();
    await waitFor(() => {
      const urls = fetchApiMock.mock.calls.map(([u]) => u);
      expect(urls).toEqual(expect.arrayContaining([
        '/api/sla/stats',
        '/api/sla/policies',
        '/api/sla/breaches',
        '/api/canned-responses',
      ]));
    });
  });

  it('Policies tab renders one row per policy with priority badges', async () => {
    renderSLA();
    await waitFor(() => {
      expect(screen.getByText('Urgent Standard')).toBeInTheDocument();
    });
    expect(screen.getByText('Medium Business')).toBeInTheDocument();
    // Priority badges. Note: "Urgent" and "Medium" each appear ONCE as a
    // row badge (the policy modal isn't open yet, so the <option> values
    // don't render). Use getAllByText to be future-proof against the modal
    // adding a second occurrence.
    expect(screen.getAllByText('Urgent').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Medium').length).toBeGreaterThanOrEqual(1);
    // Active/Inactive labels — row #1 active, row #2 inactive.
    // "Active" also appears in the "Active Policies" stat card label, so
    // use getAllByText (CLAUDE.md "RTL: prefer getAllByText for labels that
    // appear as both chrome AND row badges").
    expect(screen.getAllByText('Active').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Inactive')).toBeInTheDocument();
  });

  it('Policies tab empty-state copy', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/sla/policies') return Promise.resolve([]);
      return defaultFetchImpl(url);
    });
    renderSLA();
    await waitFor(() => {
      expect(
        screen.getByText(/No SLA policies yet\. Create one to start tracking\./i)
      ).toBeInTheDocument();
    });
  });

  it('Breaches tab: clicking switches body to breach rows', async () => {
    renderSLA();
    await waitFor(() => expect(screen.getByText('Urgent Standard')).toBeInTheDocument());

    // Click the Breaches tab. There are 2 buttons containing "Breaches" copy
    // (the tab + nothing else), find by exact name with the count suffix.
    const breachesTabs = screen.getAllByRole('button').filter((b) =>
      /^Breaches\s*\d*$/.test(b.textContent.replace(/\s+/g, ' ').trim())
    );
    expect(breachesTabs.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(breachesTabs[0]);

    await waitFor(() => {
      // Subject text from sampleBreaches.
      expect(
        screen.getByText(/Email delivery delay for Acme tenant/i)
      ).toBeInTheDocument();
    });
    expect(
      screen.getByText(/Outage report from Globus India ops/i)
    ).toBeInTheDocument();
    // Overdue badges render — "1h 15m" for 75min response, "6h 0m" for 360.
    expect(screen.getByText(/Response 1h 15m overdue/)).toBeInTheDocument();
    expect(screen.getByText(/Resolve 6h 0m overdue/)).toBeInTheDocument();
  });

  it('Breaches tab empty-state copy', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/sla/breaches') return Promise.resolve([]);
      return defaultFetchImpl(url);
    });
    renderSLA();
    await waitFor(() => expect(screen.getByText('Urgent Standard')).toBeInTheDocument());

    const breachesTabs = screen.getAllByRole('button').filter((b) =>
      /^Breaches\s*\d*$/.test(b.textContent.replace(/\s+/g, ' ').trim())
    );
    fireEvent.click(breachesTabs[0]);
    await waitFor(() => {
      expect(
        screen.getByText(/No tickets currently in breach\. Great work!/i)
      ).toBeInTheDocument();
    });
  });

  it('Canned Responses tab renders cards from /api/canned-responses', async () => {
    renderSLA();
    await waitFor(() => expect(screen.getByText('Urgent Standard')).toBeInTheDocument());

    const cannedTabs = screen.getAllByRole('button').filter((b) =>
      /Canned Responses/.test(b.textContent)
    );
    expect(cannedTabs.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(cannedTabs[0]);

    await waitFor(() => {
      expect(screen.getByText('Apology for delay')).toBeInTheDocument();
    });
    expect(screen.getByText('Apology')).toBeInTheDocument();
    expect(
      screen.getByText(/we apologise for the delay in responding/i)
    ).toBeInTheDocument();
  });

  it('New Policy modal opens with name input + priority select + 2 minute inputs', async () => {
    renderSLA();
    await waitFor(() => expect(screen.getByText('Urgent Standard')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /New Policy/i }));

    // Modal heading.
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: /New SLA Policy/i })
      ).toBeInTheDocument();
    });
    // The priority <select> renders the 4 PRIORITIES as <option>s. Each
    // option text is a node, so getByText finds them inside the <select>.
    expect(screen.getByRole('option', { name: 'Low' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Medium' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'High' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Urgent' })).toBeInTheDocument();
    // The two minute targets.
    expect(screen.getByText(/Response Target \(minutes\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Resolve Target \(minutes\)/i)).toBeInTheDocument();
    // The default emptyPolicy starts blank → name input value is empty.
    // The Create button.
    expect(screen.getByRole('button', { name: /Create Policy/i })).toBeInTheDocument();
  });

  it('name required: empty name blocks POST and surfaces "Policy name is required"', async () => {
    renderSLA();
    await waitFor(() => expect(screen.getByText('Urgent Standard')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /New Policy/i }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /New SLA Policy/i })).toBeInTheDocument()
    );

    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Create Policy/i }));

    await waitFor(() => {
      expect(screen.getByText(/Policy name is required/i)).toBeInTheDocument();
    });
    // No POST was made.
    const postCall = fetchApiMock.mock.calls.find(
      ([url, opts]) => url === '/api/sla/policies' && opts?.method === 'POST'
    );
    expect(postCall).toBeFalsy();
  });

  it('responseMinutes >= 1 (issue #465): 0 blocks POST + surfaces error', async () => {
    renderSLA();
    await waitFor(() => expect(screen.getByText('Urgent Standard')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /New Policy/i }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /New SLA Policy/i })).toBeInTheDocument()
    );

    // Set a valid name first so the name-required check passes.
    const nameInputs = screen.getAllByRole('textbox');
    fireEvent.change(nameInputs[0], { target: { value: 'Zero-Minute Policy' } });

    // Set responseMinutes = 0.
    const numberInputs = document.querySelectorAll('input[type="number"]');
    expect(numberInputs.length).toBeGreaterThanOrEqual(2);
    fireEvent.change(numberInputs[0], { target: { value: '0' } });

    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Create Policy/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/Response Target must be at least 1 minute/i)
      ).toBeInTheDocument();
    });
    const postCall = fetchApiMock.mock.calls.find(
      ([url, opts]) => url === '/api/sla/policies' && opts?.method === 'POST'
    );
    expect(postCall).toBeFalsy();
  });

  it('resolveMinutes >= 1 (issue #465): 0 blocks POST + surfaces error', async () => {
    renderSLA();
    await waitFor(() => expect(screen.getByText('Urgent Standard')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /New Policy/i }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /New SLA Policy/i })).toBeInTheDocument()
    );

    const nameInputs = screen.getAllByRole('textbox');
    fireEvent.change(nameInputs[0], { target: { value: 'Zero-Resolve Policy' } });

    const numberInputs = document.querySelectorAll('input[type="number"]');
    // responseMinutes stays at default 60. resolveMinutes -> 0.
    fireEvent.change(numberInputs[1], { target: { value: '0' } });

    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Create Policy/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/Resolve Target must be at least 1 minute/i)
      ).toBeInTheDocument();
    });
    const postCall = fetchApiMock.mock.calls.find(
      ([url, opts]) => url === '/api/sla/policies' && opts?.method === 'POST'
    );
    expect(postCall).toBeFalsy();
  });

  it('Create policy happy path: POSTs /api/sla/policies and refetches list', async () => {
    renderSLA();
    await waitFor(() => expect(screen.getByText('Urgent Standard')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /New Policy/i }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /New SLA Policy/i })).toBeInTheDocument()
    );

    const nameInputs = screen.getAllByRole('textbox');
    fireEvent.change(nameInputs[0], { target: { value: 'Premium Gold' } });

    // Priority — change the select to "High".
    const prioritySelect = screen.getByRole('combobox');
    fireEvent.change(prioritySelect, { target: { value: 'High' } });

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/sla/policies' && opts?.method === 'POST') {
        return Promise.resolve({ id: 99, name: 'Premium Gold' });
      }
      return defaultFetchImpl(url);
    });

    fireEvent.click(screen.getByRole('button', { name: /Create Policy/i }));

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/sla/policies' && opts?.method === 'POST'
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.name).toBe('Premium Gold');
      expect(body.priority).toBe('High');
      expect(body.responseMinutes).toBe(60);
      expect(body.resolveMinutes).toBe(1440);
      expect(body.isActive).toBe(true);
    });

    // Refetch policies after save.
    await waitFor(() => {
      const refetch = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/sla/policies' && (!opts || opts.method === undefined)
      );
      expect(refetch).toBeTruthy();
    });
  });

  it('Apply-to-Tickets POSTs /api/sla/apply-all and surfaces success notify', async () => {
    renderSLA();
    await waitFor(() => expect(screen.getByText('Urgent Standard')).toBeInTheDocument());

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/sla/apply-all' && opts?.method === 'POST') {
        return Promise.resolve({ applied: 7, skipped: 2 });
      }
      return defaultFetchImpl(url);
    });

    fireEvent.click(screen.getByRole('button', { name: /Apply to Tickets/i }));

    await waitFor(() => {
      const applyCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/sla/apply-all' && opts?.method === 'POST'
      );
      expect(applyCall).toBeTruthy();
    });
    await waitFor(() => {
      expect(notifySuccess).toHaveBeenCalledWith(
        expect.stringMatching(/Applied to 7 ticket\(s\)\. Skipped 2\./)
      );
    });
  });

  it('Refresh button re-fires the 4 GETs', async () => {
    renderSLA();
    await waitFor(() => expect(screen.getByText('Urgent Standard')).toBeInTheDocument());

    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Refresh/i }));

    await waitFor(() => {
      const urls = fetchApiMock.mock.calls.map(([u]) => u);
      expect(urls).toEqual(expect.arrayContaining([
        '/api/sla/stats',
        '/api/sla/policies',
        '/api/sla/breaches',
        '/api/canned-responses',
      ]));
    });
  });

  // ── Extension cases: policy CRUD beyond Create, canned validation,
  // breach severity, stat-card rendering, error paths ─────────────────────

  it('Edit policy: pre-fills modal with row values and PUTs /api/sla/policies/:id', async () => {
    renderSLA();
    await waitFor(() => expect(screen.getByText('Urgent Standard')).toBeInTheDocument());

    // Find the Edit button on row 1 (Urgent Standard). Walk to <tr> ancestor.
    const row1Name = screen.getByText('Urgent Standard');
    const tr = row1Name.closest('tr');
    expect(tr).toBeTruthy();
    const rowButtons = tr.querySelectorAll('button');
    // Two icon buttons in the row: [0] Edit, [1] Delete.
    expect(rowButtons.length).toBeGreaterThanOrEqual(2);
    fireEvent.click(rowButtons[0]);

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /Edit SLA Policy/i })).toBeInTheDocument()
    );
    // Save label changes from "Create Policy" to "Save Changes" in edit mode.
    expect(screen.getByRole('button', { name: /Save Changes/i })).toBeInTheDocument();
    // Name input pre-filled.
    const nameInputs = screen.getAllByRole('textbox');
    expect(nameInputs[0].value).toBe('Urgent Standard');

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/sla/policies/1' && opts?.method === 'PUT') {
        return Promise.resolve({ id: 1 });
      }
      return defaultFetchImpl(url);
    });
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/i }));

    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/sla/policies/1' && opts?.method === 'PUT'
      );
      expect(putCall).toBeTruthy();
      const body = JSON.parse(putCall[1].body);
      expect(body.name).toBe('Urgent Standard');
      expect(body.priority).toBe('Urgent');
      expect(body.responseMinutes).toBe(15);
      expect(body.resolveMinutes).toBe(240);
    });
  });

  it('Toggle policy active: clicking checkbox PUTs /api/sla/policies/:id with {isActive: !current}', async () => {
    renderSLA();
    await waitFor(() => expect(screen.getByText('Urgent Standard')).toBeInTheDocument());

    // Row 2 "Medium Business" is currently inactive (isActive=false).
    const row2Name = screen.getByText('Medium Business');
    const tr = row2Name.closest('tr');
    const cb = tr.querySelector('input[type="checkbox"]');
    expect(cb).toBeTruthy();
    expect(cb.checked).toBe(false);

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/sla/policies/2' && opts?.method === 'PUT') {
        return Promise.resolve({ id: 2 });
      }
      return defaultFetchImpl(url);
    });

    fireEvent.click(cb);

    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/sla/policies/2' && opts?.method === 'PUT'
      );
      expect(putCall).toBeTruthy();
      const body = JSON.parse(putCall[1].body);
      expect(body.isActive).toBe(true);
    });
  });

  it('Delete policy: notify.confirm true → DELETE /api/sla/policies/:id', async () => {
    renderSLA();
    await waitFor(() => expect(screen.getByText('Urgent Standard')).toBeInTheDocument());

    const row1Name = screen.getByText('Urgent Standard');
    const tr = row1Name.closest('tr');
    const rowButtons = tr.querySelectorAll('button');
    const deleteBtn = rowButtons[1];

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/sla/policies/1' && opts?.method === 'DELETE') {
        return Promise.resolve({ ok: true });
      }
      return defaultFetchImpl(url);
    });
    notifyConfirm.mockImplementation(() => Promise.resolve(true));

    fireEvent.click(deleteBtn);

    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalledWith(
        expect.stringMatching(/Delete policy "Urgent Standard"\?/)
      );
    });
    await waitFor(() => {
      const delCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/sla/policies/1' && opts?.method === 'DELETE'
      );
      expect(delCall).toBeTruthy();
    });
  });

  it('Delete policy: notify.confirm false → NO DELETE request fired', async () => {
    renderSLA();
    await waitFor(() => expect(screen.getByText('Urgent Standard')).toBeInTheDocument());

    const row1Name = screen.getByText('Urgent Standard');
    const tr = row1Name.closest('tr');
    const rowButtons = tr.querySelectorAll('button');
    const deleteBtn = rowButtons[1];

    fetchApiMock.mockClear();
    notifyConfirm.mockImplementation(() => Promise.resolve(false));

    fireEvent.click(deleteBtn);

    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalled();
    });
    await new Promise((r) => setTimeout(r, 0));
    const delCall = fetchApiMock.mock.calls.find(
      ([url, opts]) => url === '/api/sla/policies/1' && opts?.method === 'DELETE'
    );
    expect(delCall).toBeFalsy();
  });

  it('Apply-to-Tickets failure: surfaces notify.error when /api/sla/apply-all rejects', async () => {
    renderSLA();
    await waitFor(() => expect(screen.getByText('Urgent Standard')).toBeInTheDocument());

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/sla/apply-all' && opts?.method === 'POST') {
        return Promise.reject(new Error('Apply backend offline'));
      }
      return defaultFetchImpl(url);
    });

    fireEvent.click(screen.getByRole('button', { name: /Apply to Tickets/i }));

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/Apply backend offline|Apply-all failed/i)
      );
    });
    expect(notifySuccess).not.toHaveBeenCalled();
  });

  it('Canned tab: empty-state copy renders when /api/canned-responses returns []', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/canned-responses') return Promise.resolve([]);
      return defaultFetchImpl(url);
    });
    renderSLA();
    await waitFor(() => expect(screen.getByText('Urgent Standard')).toBeInTheDocument());

    const cannedTabs = screen.getAllByRole('button').filter((b) =>
      /Canned Responses/.test(b.textContent)
    );
    fireEvent.click(cannedTabs[0]);

    await waitFor(() => {
      expect(
        screen.getByText(/No canned responses yet\. Create reusable reply templates\./i)
      ).toBeInTheDocument();
    });
  });

  it('Canned modal: name + content required — empty submission blocks POST + surfaces error', async () => {
    renderSLA();
    await waitFor(() => expect(screen.getByText('Urgent Standard')).toBeInTheDocument());

    const cannedTabs = screen.getAllByRole('button').filter((b) =>
      /Canned Responses/.test(b.textContent)
    );
    fireEvent.click(cannedTabs[0]);
    await waitFor(() => expect(screen.getByText('Apology for delay')).toBeInTheDocument());

    // Open "New" canned modal (button label is exactly "New").
    const newCannedBtn = screen
      .getAllByRole('button')
      .find((b) => b.textContent.trim() === 'New');
    expect(newCannedBtn).toBeTruthy();
    fireEvent.click(newCannedBtn);

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /New Canned Response/i })).toBeInTheDocument()
    );

    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /^Create$/i }));

    await waitFor(() => {
      expect(screen.getByText(/Name and content are required/i)).toBeInTheDocument();
    });
    const postCall = fetchApiMock.mock.calls.find(
      ([url, opts]) => url === '/api/canned-responses' && opts?.method === 'POST'
    );
    expect(postCall).toBeFalsy();
  });

  it('Canned: create happy path POSTs /api/canned-responses with form body', async () => {
    renderSLA();
    await waitFor(() => expect(screen.getByText('Urgent Standard')).toBeInTheDocument());

    const cannedTabs = screen.getAllByRole('button').filter((b) =>
      /Canned Responses/.test(b.textContent)
    );
    fireEvent.click(cannedTabs[0]);
    await waitFor(() => expect(screen.getByText('Apology for delay')).toBeInTheDocument());

    const newCannedBtn = screen
      .getAllByRole('button')
      .find((b) => b.textContent.trim() === 'New');
    fireEvent.click(newCannedBtn);
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /New Canned Response/i })).toBeInTheDocument()
    );

    // Modal inputs: [0]=name, [1]=category, [2]=content (textarea).
    const textInputs = screen.getAllByRole('textbox');
    fireEvent.change(textInputs[0], { target: { value: 'Greeting Hindi' } });
    fireEvent.change(textInputs[2], { target: { value: 'Namaste {{contact.name}}, kaise hain aap?' } });

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/canned-responses' && opts?.method === 'POST') {
        return Promise.resolve({ id: 99 });
      }
      return defaultFetchImpl(url);
    });

    fireEvent.click(screen.getByRole('button', { name: /^Create$/i }));

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/canned-responses' && opts?.method === 'POST'
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.name).toBe('Greeting Hindi');
      expect(body.content).toMatch(/Namaste \{\{contact\.name\}\}/);
      expect(body.category).toBe('General');
    });
  });

  it('Stat cards render values from /api/sla/stats — activePolicies + breachesToday + formatted minutes', async () => {
    renderSLA();
    await waitFor(() => expect(screen.getByText('Urgent Standard')).toBeInTheDocument());

    // sampleStats.activePolicies = 3, breachesToday = 4.
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    // avgResponseMinutes=42 → "42m"; avgResolveMinutes=480 → "8h 0m".
    expect(screen.getByText('42m')).toBeInTheDocument();
    expect(screen.getByText('8h 0m')).toBeInTheDocument();
    // 4 stat-card labels.
    expect(screen.getAllByText(/Active Policies/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Breaches Today/i)).toBeInTheDocument();
    expect(screen.getByText(/Avg Response/i)).toBeInTheDocument();
    expect(screen.getByText(/Avg Resolve/i)).toBeInTheDocument();
  });

  it('Tab badge counts mirror policies/breaches/canned array lengths', async () => {
    renderSLA();
    await waitFor(() => expect(screen.getByText('Urgent Standard')).toBeInTheDocument());

    const policiesTab = screen
      .getAllByRole('button')
      .find((b) => /^Policies\s*\d+$/.test(b.textContent.replace(/\s+/g, ' ').trim()));
    const breachesTab = screen
      .getAllByRole('button')
      .find((b) => /^Breaches\s*\d+$/.test(b.textContent.replace(/\s+/g, ' ').trim()));
    const cannedTab = screen
      .getAllByRole('button')
      .find((b) => /^Canned Responses\s*\d+$/.test(b.textContent.replace(/\s+/g, ' ').trim()));

    expect(policiesTab).toBeTruthy();
    expect(breachesTab).toBeTruthy();
    expect(cannedTab).toBeTruthy();
    // policies.length=2, breaches.length=2, canned.length=1.
    expect(policiesTab.textContent).toMatch(/2/);
    expect(breachesTab.textContent).toMatch(/2/);
    expect(cannedTab.textContent).toMatch(/1/);
  });

  it('Breach severity: resolveOverdueMinutes > 240 (4h) renders red severity row; <= 240 amber', async () => {
    renderSLA();
    await waitFor(() => expect(screen.getByText('Urgent Standard')).toBeInTheDocument());

    const breachesTabs = screen.getAllByRole('button').filter((b) =>
      /^Breaches\s*\d*$/.test(b.textContent.replace(/\s+/g, ' ').trim())
    );
    fireEvent.click(breachesTabs[0]);
    await waitFor(() =>
      expect(screen.getByText(/Email delivery delay for Acme tenant/i)).toBeInTheDocument()
    );

    // Breach #2: 360min resolve overdue (>240) → red #ef4444 / rgba(239,68,68,*).
    const row2Subject = screen.getByText(/Outage report from Globus India ops/i);
    let row = row2Subject.parentElement;
    let depth = 0;
    while (row && depth < 6) {
      const s = row.getAttribute && row.getAttribute('style');
      if (s && (s.includes('239, 68, 68') || s.includes('#ef4444'))) break;
      row = row.parentElement;
      depth++;
    }
    expect(row).toBeTruthy();
    expect((row.getAttribute('style') || '').toLowerCase()).toMatch(/#ef4444|rgba?\(\s*239,\s*68,\s*68/);

    // Breach #1: 75min response (<=240) → amber #f59e0b / rgba(245,158,11,*).
    const row1Subject = screen.getByText(/Email delivery delay for Acme tenant/i);
    let row1 = row1Subject.parentElement;
    let d1 = 0;
    while (row1 && d1 < 6) {
      const s = row1.getAttribute && row1.getAttribute('style');
      if (s && (s.includes('245, 158, 11') || s.includes('#f59e0b'))) break;
      row1 = row1.parentElement;
      d1++;
    }
    expect(row1).toBeTruthy();
    expect((row1.getAttribute('style') || '').toLowerCase()).toMatch(/#f59e0b|rgba?\(\s*245,\s*158,\s*11/);
    // And NOT the red color (severity discriminator).
    expect((row1.getAttribute('style') || '').toLowerCase()).not.toMatch(/239,\s*68,\s*68/);
  });
});
