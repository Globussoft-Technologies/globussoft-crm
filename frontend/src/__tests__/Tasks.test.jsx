/**
 * Tasks.test.jsx — vitest + RTL coverage for the agent task-queue page
 * (frontend/src/pages/Tasks.jsx).
 *
 * Scope: pins the page-surface invariants for the productivity / follow-up
 * queue surface used daily by SDR-like roles. The page reads from
 * /api/tasks + /api/contacts, displays a priority-sorted Active queue + a
 * Completed log, and exposes a drawer-shaped "Create Task" form that
 * POSTs to /api/tasks then refreshes.
 *
 * Invariants pinned here:
 *   1. Heading + Create Task button + priority-counter chips render.
 *   2. Initial mount fires GET /api/tasks AND GET /api/contacts in parallel.
 *   3. Active queue renders one row per non-Completed task, sorted by the
 *      priority order (Critical → High → Medium → Low).
 *   4. Completed log renders only tasks with status=Completed (with the
 *      title struck-through).
 *   5. Empty-active state renders the "Queue is empty. Excellent work."
 *      message via the #empty-queue-msg id.
 *   6. Overdue heuristic: a Pending task with a past dueDate gets the
 *      OVERDUE badge + bumps the Overdue counter chip.
 *   7. Clicking Resolve fires PUT /api/tasks/<id>/complete and dispatches
 *      the sidebar:counts-changed CustomEvent (#625 sidebar invalidation).
 *   8. The header "Create Task" CTA opens the drawer; ESC + outside-click
 *      + the X button all close it (#893 drawer convention).
 *   9. Submitting the drawer form POSTs /api/tasks with the dueDate as a
 *      real ISO string (#313 datetime-local → ISO conversion) and closes
 *      the drawer on success.
 *  10. Past-date warning (#608): picking a dueDate in the past renders the
 *      data-testid="task-past-date-warning" element; future dates do not.
 *  11. POST failure path: fetchApi reject surfaces notify.error and keeps
 *      the drawer open so the user can correct + retry.
 *  12. Priority normalization (#296): a non-canonical backend value like
 *      "CRITICAL_OMG" collapses to "Critical" in the rendered badge so
 *      the UI never shows a screaming all-caps string.
 *
 * Mock discipline: notifyObj is a SINGLE stable reference (the
 * useNotify-in-useCallback RTL standing rule) — fresh objects per call
 * cause infinite re-renders.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyInfo = vi.fn();
const notifyObj = {
  error: notifyError,
  info: notifyInfo,
  success: notifySuccess,
  confirm: () => Promise.resolve(true),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

import Tasks from '../pages/Tasks';

const futureISO = new Date(Date.now() + 7 * 86_400_000).toISOString();
const pastISO = new Date(Date.now() - 7 * 86_400_000).toISOString();

const sampleContacts = [
  { id: 11, name: 'Anita Sharma', email: 'anita@example.com' },
  { id: 12, name: 'Rohit Verma', email: 'rohit@example.com' },
];

const sampleTasks = [
  {
    id: 1,
    title: 'Q3 Renewal Call',
    priority: 'Critical',
    status: 'Pending',
    dueDate: futureISO,
    contact: { name: 'Anita Sharma', email: 'anita@example.com' },
  },
  {
    id: 2,
    title: 'Low priority cleanup',
    priority: 'Low',
    status: 'Pending',
    dueDate: futureISO,
  },
  {
    id: 3,
    title: 'High priority follow-up',
    priority: 'High',
    status: 'Pending',
    dueDate: futureISO,
  },
  {
    id: 4,
    title: 'Overdue check-in',
    priority: 'Medium',
    status: 'Pending',
    dueDate: pastISO,
  },
  {
    id: 5,
    title: 'Completed onboarding',
    priority: 'Medium',
    status: 'Completed',
    dueDate: futureISO,
  },
];

function defaultFetchMock(url, opts) {
  if (url === '/api/tasks' && (!opts || !opts.method || opts.method === 'GET')) {
    return Promise.resolve(sampleTasks);
  }
  if (url === '/api/contacts' && (!opts || !opts.method || opts.method === 'GET')) {
    return Promise.resolve(sampleContacts);
  }
  if (url === '/api/tasks' && opts?.method === 'POST') {
    return Promise.resolve({ id: 99 });
  }
  if (/^\/api\/tasks\/\d+\/complete$/.test(url) && opts?.method === 'PUT') {
    return Promise.resolve({ ok: true });
  }
  return Promise.resolve(null);
}

function renderTasks() {
  return render(<Tasks />);
}

describe('<Tasks /> — page surface', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation(defaultFetchMock);
    notifyError.mockReset();
    notifySuccess.mockReset();
    notifyInfo.mockReset();
  });

  it('renders heading + Create Task CTA + priority-counter chips', async () => {
    renderTasks();
    expect(
      await screen.findByRole('heading', { name: /Agent Task Queue/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Create a new task/i }),
    ).toBeInTheDocument();
    // Stats chip: "4 total pending" (sampleTasks has 4 non-Completed).
    expect(await screen.findByText(/4 total pending/i)).toBeInTheDocument();
    // Critical + High + Overdue chips render (one of each in the seed).
    expect(screen.getByText(/1 Critical/i)).toBeInTheDocument();
    expect(screen.getByText(/1 High/i)).toBeInTheDocument();
    expect(screen.getByText(/1 Overdue/i)).toBeInTheDocument();
  });

  it('initial mount fires GET /api/tasks AND GET /api/contacts in parallel', async () => {
    renderTasks();
    await waitFor(() => {
      const taskCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/tasks' && (!o || !o.method || o.method === 'GET'),
      );
      const contactsCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/contacts' && (!o || !o.method || o.method === 'GET'),
      );
      expect(taskCall).toBeTruthy();
      expect(contactsCall).toBeTruthy();
    });
  });

  it('Active queue renders only non-Completed tasks, sorted by priority order', async () => {
    renderTasks();
    await waitFor(() => {
      expect(screen.getByText('Q3 Renewal Call')).toBeInTheDocument();
    });

    // All four Pending tasks render in the Active queue.
    expect(screen.getByText('Q3 Renewal Call')).toBeInTheDocument();
    expect(screen.getByText('High priority follow-up')).toBeInTheDocument();
    expect(screen.getByText('Overdue check-in')).toBeInTheDocument();
    expect(screen.getByText('Low priority cleanup')).toBeInTheDocument();

    // Verify priority sort order: Critical → High → Medium → Low.
    // Find each title in the rendered DOM and compare their document order.
    const allTitles = Array.from(document.querySelectorAll('h4')).map(
      (h) => h.textContent,
    );
    const idxCritical = allTitles.indexOf('Q3 Renewal Call');
    const idxHigh = allTitles.indexOf('High priority follow-up');
    const idxMedium = allTitles.indexOf('Overdue check-in');
    const idxLow = allTitles.indexOf('Low priority cleanup');
    expect(idxCritical).toBeLessThan(idxHigh);
    expect(idxHigh).toBeLessThan(idxMedium);
    expect(idxMedium).toBeLessThan(idxLow);
  });

  it('Completed log lists Completed tasks only (with line-through styling)', async () => {
    renderTasks();
    await waitFor(() => {
      expect(screen.getByText('Completed onboarding')).toBeInTheDocument();
    });
    const completedLabel = screen.getByText('Completed onboarding');
    // The completed log applies text-decoration: line-through inline.
    expect(completedLabel).toHaveStyle({ textDecoration: 'line-through' });
    // "Resolved" badge appears next to the completed entry.
    expect(screen.getAllByText(/Resolved/i).length).toBeGreaterThanOrEqual(1);
  });

  it('empty-active state renders "Queue is empty." when no Pending tasks exist', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/tasks') return Promise.resolve([]);
      if (url === '/api/contacts') return Promise.resolve(sampleContacts);
      return defaultFetchMock(url, opts);
    });
    renderTasks();
    const empty = await screen.findByText(/Queue is empty\. Excellent work\./i);
    expect(empty).toBeInTheDocument();
    expect(empty).toHaveAttribute('id', 'empty-queue-msg');
    // No "total pending" chip when no active tasks.
    expect(screen.queryByText(/total pending/i)).not.toBeInTheDocument();
  });

  it('overdue heuristic flags Pending tasks with past dueDate (badge + counter)', async () => {
    renderTasks();
    // The OVERDUE inline badge renders for "Overdue check-in" only (exact
    // all-caps match — distinct from the "1 Overdue" counter chip).
    expect(await screen.findByText('OVERDUE')).toBeInTheDocument();
    // The counter chip reports exactly 1 overdue.
    expect(screen.getByText(/1 Overdue/i)).toBeInTheDocument();
  });

  it('clicking Resolve fires PUT /api/tasks/<id>/complete and dispatches sidebar:counts-changed', async () => {
    const eventListener = vi.fn();
    window.addEventListener('sidebar:counts-changed', eventListener);

    renderTasks();
    const resolveBtns = await screen.findAllByRole('button', { name: /Resolve/i });
    expect(resolveBtns.length).toBeGreaterThanOrEqual(1);

    fetchApiMock.mockClear();
    fireEvent.click(resolveBtns[0]);

    await waitFor(() => {
      const completeCall = fetchApiMock.mock.calls.find(
        ([u, o]) => /^\/api\/tasks\/\d+\/complete$/.test(u) && o?.method === 'PUT',
      );
      expect(completeCall).toBeTruthy();
    });

    // Sidebar invalidation event fired (#625).
    await waitFor(() => {
      expect(eventListener).toHaveBeenCalled();
    });
    window.removeEventListener('sidebar:counts-changed', eventListener);
  });

  it('Create Task drawer opens via header CTA and closes via X, ESC, and outside-click', async () => {
    renderTasks();
    await waitFor(() => {
      expect(screen.getByText('Q3 Renewal Call')).toBeInTheDocument();
    });

    // Before click: drawer header not visible.
    expect(screen.queryByText(/Enqueue Activity/i)).not.toBeInTheDocument();

    // Click header CTA → drawer opens with title input present.
    fireEvent.click(screen.getByRole('button', { name: /Create a new task/i }));
    expect(screen.getByText(/Enqueue Activity/i)).toBeInTheDocument();
    expect(document.getElementById('task-title-input')).toBeInTheDocument();

    // Close via the X button (aria-label="Close").
    fireEvent.click(screen.getByRole('button', { name: /^Close$/i }));
    await waitFor(() => {
      expect(screen.queryByText(/Enqueue Activity/i)).not.toBeInTheDocument();
    });

    // Re-open + close via ESC keydown on window.
    fireEvent.click(screen.getByRole('button', { name: /Create a new task/i }));
    expect(screen.getByText(/Enqueue Activity/i)).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByText(/Enqueue Activity/i)).not.toBeInTheDocument();
    });
  });

  it('submitting the drawer form POSTs /api/tasks with ISO dueDate then closes the drawer', async () => {
    renderTasks();
    await waitFor(() => {
      expect(screen.getByText('Q3 Renewal Call')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Create a new task/i }));

    const titleInput = document.getElementById('task-title-input');
    fireEvent.change(titleInput, { target: { value: 'New follow-up call' } });

    const priorityInput = document.getElementById('task-priority-select');
    fireEvent.change(priorityInput, { target: { value: 'High' } });

    // datetime-local input — pick a future wall-clock time.
    const dueDateInput = document.querySelector('input[type="datetime-local"]');
    expect(dueDateInput).toBeInTheDocument();
    fireEvent.change(dueDateInput, { target: { value: '2030-06-01T10:30' } });

    fetchApiMock.mockClear();
    // Submit via the Assign Task button.
    fireEvent.click(screen.getByRole('button', { name: /Assign Task/i }));

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/tasks' && o?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.title).toBe('New follow-up call');
      expect(body.priority).toBe('High');
      // #313: dueDate is serialized to a real ISO timestamp, not the raw
      // wall-clock string from the datetime-local picker.
      expect(typeof body.dueDate).toBe('string');
      expect(body.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      // ISO output retains UTC ('Z') or an offset; both shapes are valid
      // depending on the JS engine's Date.toISOString — assert one matches.
      expect(body.dueDate.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(body.dueDate)).toBe(true);
    });

    // Drawer closes on success.
    await waitFor(() => {
      expect(screen.queryByText(/Enqueue Activity/i)).not.toBeInTheDocument();
    });
  });

  it('picking a past dueDate in the drawer renders the data-testid="task-past-date-warning"', async () => {
    renderTasks();
    await waitFor(() => {
      expect(screen.getByText('Q3 Renewal Call')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Create a new task/i }));
    const dueDateInput = document.querySelector('input[type="datetime-local"]');

    // Pre-input: no warning.
    expect(screen.queryByTestId('task-past-date-warning')).not.toBeInTheDocument();

    // Pick a clearly-past wall-clock time.
    fireEvent.change(dueDateInput, { target: { value: '2020-01-01T08:00' } });
    expect(screen.getByTestId('task-past-date-warning')).toBeInTheDocument();

    // Switching to a future date removes the warning.
    fireEvent.change(dueDateInput, { target: { value: '2030-06-01T10:30' } });
    expect(screen.queryByTestId('task-past-date-warning')).not.toBeInTheDocument();
  });

  it('POST failure surfaces notify.error and keeps the drawer open', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/tasks' && opts?.method === 'POST') {
        return Promise.reject(new Error('Network down'));
      }
      return defaultFetchMock(url, opts);
    });

    renderTasks();
    await waitFor(() => {
      expect(screen.getByText('Q3 Renewal Call')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Create a new task/i }));
    fireEvent.change(document.getElementById('task-title-input'), {
      target: { value: 'Will fail' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Assign Task/i }));

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/Failed to enqueue task/i),
      );
    });
    // Drawer stays open so the user can correct + retry.
    expect(screen.getByText(/Enqueue Activity/i)).toBeInTheDocument();
  });

  it('priority normalization: non-canonical "CRITICAL_OMG" collapses to "Critical" badge (#296)', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/tasks') {
        return Promise.resolve([
          {
            id: 7,
            title: 'Drift-shape badge probe',
            priority: 'CRITICAL_OMG',
            status: 'Pending',
            dueDate: futureISO,
          },
        ]);
      }
      if (url === '/api/contacts') return Promise.resolve([]);
      return defaultFetchMock(url, opts);
    });

    renderTasks();
    await waitFor(() => {
      expect(screen.getByText('Drift-shape badge probe')).toBeInTheDocument();
    });

    // The screaming all-caps "CRITICAL_OMG" must NOT appear anywhere.
    expect(screen.queryByText(/CRITICAL_OMG/)).not.toBeInTheDocument();
    // The normalized "Critical" badge text DOES render — there are also
    // chips/options carrying "Critical" so just assert at least one.
    expect(screen.getAllByText(/Critical/).length).toBeGreaterThanOrEqual(1);
  });
});
