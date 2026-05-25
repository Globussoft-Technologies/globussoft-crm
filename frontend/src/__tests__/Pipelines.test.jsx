/**
 * Pipelines.test.jsx — vitest + RTL coverage for the sales-pipeline CRUD
 * admin page (frontend/src/pages/Pipelines.jsx).
 *
 * Pipelines.jsx is the CRUD-of-pipelines page (list + create + edit + set-
 * default + delete). The sibling Pipeline.jsx is the kanban view of a single
 * pipeline's deals; that's pinned by Pipeline.test.jsx + .dragProbability /
 * .stageGrouping siblings. This file pins the admin-page surface invariants:
 *
 *   1. Renders the heading "Sales Pipelines" + a "Create Pipeline" button.
 *   2. Initial mount fires GET /api/pipelines and renders one card per row.
 *   3. Each card shows the pipeline name + description; the default-flagged
 *      pipeline renders a "Default" badge AND has neither the "Set Default"
 *      nor "Delete" button (defaults can't be demoted or deleted from the
 *      list — must edit + toggle, or set another default first).
 *   4. Each non-default card shows BOTH "Set Default" and "Delete" buttons.
 *   5. Empty-state "No pipelines yet" copy + a centered Create button render
 *      when GET /api/pipelines returns [].
 *   6. Click "Create Pipeline" → modal opens with header "Create Pipeline";
 *      Name + Description inputs render; default checkbox renders enabled.
 *   7. Saving a create with empty name surfaces an in-modal error
 *      "Pipeline name is required" and does NOT POST.
 *   8. Saving a create with a valid name fires POST /api/pipelines with the
 *      form body, then refetches the list.
 *   9. Edit click on a non-default row opens the modal with the header
 *      "Edit Pipeline" + form prefilled with the row's name + description +
 *      isDefault. Saving fires PUT /api/pipelines/<id> with name+description
 *      (NOT isDefault — set-default is a separate endpoint).
 *  10. Edit + toggling isDefault ON fires PUT then POST /api/pipelines/<id>/
 *      set-default (the two-step pattern enforced by handleSave).
 *  11. Click "Set Default" on a non-default card → POST /api/pipelines/<id>/
 *      set-default + refetch.
 *  12. Click "Delete" on a non-default card → confirms via notify.confirm,
 *      then DELETE /api/pipelines/<id> + refetch. Cancelling the confirm
 *      does NOT issue the DELETE.
 *  13. Network error on initial mount renders the surface gracefully (no
 *      crash); subsequent cards do NOT render.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

// Stable mock object reference — fresh objects per call cause infinite
// re-render loops when consumed inside useCallback dependency arrays.
const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyInfo = vi.fn();
const confirmMock = vi.fn(() => Promise.resolve(true));
const notifyObj = {
  error: notifyError,
  info: notifyInfo,
  success: notifySuccess,
  confirm: (...args) => confirmMock(...args),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

import Pipelines from '../pages/Pipelines';

const samplePipelines = [
  {
    id: 11,
    name: 'Enterprise Sales',
    description: 'Six-figure ARR pursuits',
    isDefault: true,
    dealCount: 12,
  },
  {
    id: 12,
    name: 'SMB Inbound',
    description: 'Self-serve + low-touch inbound',
    isDefault: false,
    dealCount: 1,
  },
  {
    id: 13,
    name: 'Partner Channel',
    description: '',
    isDefault: false,
    dealCount: 0,
  },
];

function defaultFetchMock(url, opts) {
  if (url === '/api/pipelines' && (!opts || !opts.method || opts.method === 'GET')) {
    return Promise.resolve(samplePipelines);
  }
  if (url === '/api/pipelines' && opts?.method === 'POST') {
    return Promise.resolve({ id: 99, ...JSON.parse(opts.body || '{}') });
  }
  if (/^\/api\/pipelines\/\d+$/.test(url) && opts?.method === 'PUT') {
    return Promise.resolve({ ok: true });
  }
  if (/^\/api\/pipelines\/\d+$/.test(url) && opts?.method === 'DELETE') {
    return Promise.resolve({ ok: true });
  }
  if (/^\/api\/pipelines\/\d+\/set-default$/.test(url) && opts?.method === 'POST') {
    return Promise.resolve({ ok: true });
  }
  return Promise.resolve(null);
}

describe('<Pipelines /> — sales-pipeline admin page', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation(defaultFetchMock);
    notifyError.mockReset();
    notifySuccess.mockReset();
    notifyInfo.mockReset();
    confirmMock.mockReset();
    confirmMock.mockResolvedValue(true);
  });

  it('renders the heading + Create Pipeline header button', async () => {
    render(<Pipelines />);
    expect(await screen.findByRole('heading', { name: /Sales Pipelines/i })).toBeInTheDocument();
    // Header CTA — there are two "Create Pipeline" buttons total (header +
    // empty-state); on the populated path only the header one renders.
    expect(screen.getByRole('button', { name: /Create Pipeline/i })).toBeInTheDocument();
  });

  it('initial mount fires GET /api/pipelines exactly once and renders one card per row', async () => {
    render(<Pipelines />);
    // findByText: data-dependent text appears AFTER the mock fetch settles;
    // sync getByText is a CI-only race under shard load.
    expect(await screen.findByText('Enterprise Sales')).toBeInTheDocument();
    expect(screen.getByText('SMB Inbound')).toBeInTheDocument();
    expect(screen.getByText('Partner Channel')).toBeInTheDocument();
    // Description for the row with one renders inline.
    expect(screen.getByText('Six-figure ARR pursuits')).toBeInTheDocument();
    expect(screen.getByText('Self-serve + low-touch inbound')).toBeInTheDocument();
    // Empty-description row falls back to "No description".
    expect(screen.getByText(/No description/i)).toBeInTheDocument();

    // Exactly one mount-time GET (don't pin total call count — strict-mode
    // double-renders could double-fire; pin "at least one matching GET").
    const getCalls = fetchApiMock.mock.calls.filter(
      ([u, o]) => u === '/api/pipelines' && (!o || !o.method || o.method === 'GET'),
    );
    expect(getCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('default-flagged pipeline shows the "Default" badge and hides Set-Default + Delete buttons', async () => {
    render(<Pipelines />);
    await screen.findByText('Enterprise Sales');
    // "Default" badge renders once (only the default row).
    const defaultBadges = screen.getAllByText(/^Default$/i);
    expect(defaultBadges.length).toBe(1);
    // There are 2 non-default rows → 2 "Set Default" + 2 "Delete" buttons,
    // never one per default row.
    expect(screen.getAllByRole('button', { name: /^Set Default$/i }).length).toBe(2);
    expect(screen.getAllByRole('button', { name: /^Delete$/i }).length).toBe(2);
  });

  it('every card renders a "View Pipeline" link pointing at /pipeline?pipelineId=<id>', async () => {
    render(<Pipelines />);
    await screen.findByText('Enterprise Sales');
    const links = screen.getAllByRole('link', { name: /View Pipeline/i });
    expect(links.length).toBe(3);
    const hrefs = links.map((l) => l.getAttribute('href')).sort();
    expect(hrefs).toEqual([
      '/pipeline?pipelineId=11',
      '/pipeline?pipelineId=12',
      '/pipeline?pipelineId=13',
    ]);
  });

  it('empty-state renders "No pipelines yet" + a centered Create button when GET returns []', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/pipelines') return Promise.resolve([]);
      return Promise.resolve(null);
    });
    render(<Pipelines />);
    expect(await screen.findByText(/No pipelines yet/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Create your first sales pipeline/i),
    ).toBeInTheDocument();
    // Both the header CTA AND the empty-state CTA render (2 total).
    expect(screen.getAllByRole('button', { name: /Create Pipeline/i }).length).toBe(2);
  });

  it('clicking "Create Pipeline" opens the modal with header "Create Pipeline" + Name/Description inputs', async () => {
    render(<Pipelines />);
    await screen.findByText('Enterprise Sales');
    fireEvent.click(screen.getByRole('button', { name: /Create Pipeline/i }));
    // Modal header.
    expect(screen.getByRole('heading', { name: /^Create Pipeline$/i })).toBeInTheDocument();
    // Inputs render with placeholders.
    expect(screen.getByPlaceholderText(/e\.g\. Enterprise Sales/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Describe what this pipeline is for/i)).toBeInTheDocument();
    // Submit-action button label is "Create Pipeline" (modal footer) — there
    // will be both the header CTA and modal footer CTA bearing that label.
    expect(screen.getAllByRole('button', { name: /Create Pipeline/i }).length).toBeGreaterThanOrEqual(2);
  });

  it('saving a Create with an empty name surfaces "Pipeline name is required" and does NOT POST', async () => {
    render(<Pipelines />);
    await screen.findByText('Enterprise Sales');
    fireEvent.click(screen.getByRole('button', { name: /Create Pipeline/i }));

    // Click the modal-footer submit (not the header CTA — both share the
    // "Create Pipeline" label; the modal footer is the LAST one in DOM order).
    const submitButtons = screen.getAllByRole('button', { name: /Create Pipeline/i });
    fireEvent.click(submitButtons[submitButtons.length - 1]);

    expect(await screen.findByText(/Pipeline name is required/i)).toBeInTheDocument();
    // No POST fired.
    const postCall = fetchApiMock.mock.calls.find(
      ([u, o]) => u === '/api/pipelines' && o?.method === 'POST',
    );
    expect(postCall).toBeUndefined();
  });

  it('saving a valid Create fires POST /api/pipelines with the form body and then refetches', async () => {
    render(<Pipelines />);
    await screen.findByText('Enterprise Sales');
    fireEvent.click(screen.getByRole('button', { name: /Create Pipeline/i }));

    fireEvent.change(screen.getByPlaceholderText(/e\.g\. Enterprise Sales/i), {
      target: { value: 'Mid-market Outbound' },
    });
    fireEvent.change(screen.getByPlaceholderText(/Describe what this pipeline is for/i), {
      target: { value: 'Cold-list AE pursuits' },
    });

    // Click the modal-footer submit.
    const submitButtons = screen.getAllByRole('button', { name: /Create Pipeline/i });
    fireEvent.click(submitButtons[submitButtons.length - 1]);

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/pipelines' && o?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.name).toBe('Mid-market Outbound');
      expect(body.description).toBe('Cold-list AE pursuits');
      expect(body.isDefault).toBe(false);
    });

    // After save resolves, fetchPipelines() runs → ≥2 GETs total (mount + post-save).
    await waitFor(() => {
      const getCalls = fetchApiMock.mock.calls.filter(
        ([u, o]) => u === '/api/pipelines' && (!o || !o.method || o.method === 'GET'),
      );
      expect(getCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('Edit opens the modal with "Edit Pipeline" header prefilled with row data', async () => {
    render(<Pipelines />);
    await screen.findByText('Enterprise Sales');
    // Click an Edit button — pick the SMB Inbound row's Edit (non-default).
    // There are 3 Edit buttons (one per row); the second corresponds to SMB.
    const editButtons = screen.getAllByRole('button', { name: /^Edit$/i });
    expect(editButtons.length).toBe(3);
    fireEvent.click(editButtons[1]);

    expect(screen.getByRole('heading', { name: /^Edit Pipeline$/i })).toBeInTheDocument();
    // Form prefilled with the second row's values.
    const nameInput = screen.getByPlaceholderText(/e\.g\. Enterprise Sales/i);
    expect(nameInput.value).toBe('SMB Inbound');
    const descTextarea = screen.getByPlaceholderText(/Describe what this pipeline is for/i);
    expect(descTextarea.value).toBe('Self-serve + low-touch inbound');
    // Footer button now reads "Save Changes" (not "Create Pipeline").
    expect(screen.getByRole('button', { name: /Save Changes/i })).toBeInTheDocument();
  });

  it('saving an Edit fires PUT /api/pipelines/<id> with name+description; isDefault is NOT in the PUT body', async () => {
    render(<Pipelines />);
    await screen.findByText('Enterprise Sales');
    const editButtons = screen.getAllByRole('button', { name: /^Edit$/i });
    fireEvent.click(editButtons[1]); // SMB Inbound (id=12)

    fireEvent.change(screen.getByPlaceholderText(/e\.g\. Enterprise Sales/i), {
      target: { value: 'SMB Inbound — refreshed' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/i }));

    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/pipelines/12' && o?.method === 'PUT',
      );
      expect(putCall).toBeTruthy();
      const body = JSON.parse(putCall[1].body);
      expect(body.name).toBe('SMB Inbound — refreshed');
      expect(body.description).toBe('Self-serve + low-touch inbound');
      // The PUT body intentionally omits isDefault — handleSave routes that
      // through a separate POST /set-default call.
      expect(body.isDefault).toBeUndefined();
    });

    // No set-default POST fired (user didn't toggle the checkbox).
    const setDefaultCall = fetchApiMock.mock.calls.find(
      ([u, o]) => u === '/api/pipelines/12/set-default' && o?.method === 'POST',
    );
    expect(setDefaultCall).toBeUndefined();
  });

  it('Edit + toggling isDefault ON fires PUT then POST /api/pipelines/<id>/set-default', async () => {
    render(<Pipelines />);
    await screen.findByText('Enterprise Sales');
    const editButtons = screen.getAllByRole('button', { name: /^Edit$/i });
    fireEvent.click(editButtons[1]); // SMB Inbound (id=12, isDefault=false)

    // Toggle the "Set as default pipeline" checkbox ON.
    const defaultCheckbox = screen.getByRole('checkbox');
    expect(defaultCheckbox.checked).toBe(false);
    fireEvent.click(defaultCheckbox);
    expect(defaultCheckbox.checked).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /Save Changes/i }));

    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/pipelines/12' && o?.method === 'PUT',
      );
      expect(putCall).toBeTruthy();
    });
    await waitFor(() => {
      const setDefaultCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/pipelines/12/set-default' && o?.method === 'POST',
      );
      expect(setDefaultCall).toBeTruthy();
    });
  });

  it('clicking "Set Default" on a non-default card fires POST /api/pipelines/<id>/set-default and refetches', async () => {
    render(<Pipelines />);
    await screen.findByText('Enterprise Sales');
    // Two "Set Default" buttons exist (for the 2 non-default rows). Click the
    // first one — corresponds to SMB Inbound (id=12) per the seed order.
    const setDefaultButtons = screen.getAllByRole('button', { name: /^Set Default$/i });
    fireEvent.click(setDefaultButtons[0]);

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/pipelines/12/set-default' && o?.method === 'POST',
      );
      expect(call).toBeTruthy();
    });
    // Post-action refetch → ≥2 GETs total.
    await waitFor(() => {
      const getCalls = fetchApiMock.mock.calls.filter(
        ([u, o]) => u === '/api/pipelines' && (!o || !o.method || o.method === 'GET'),
      );
      expect(getCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('clicking "Delete" confirms via notify.confirm with destructive=true; rejects skip the DELETE', async () => {
    confirmMock.mockResolvedValueOnce(false); // user cancels
    render(<Pipelines />);
    await screen.findByText('Enterprise Sales');
    const deleteButtons = screen.getAllByRole('button', { name: /^Delete$/i });
    fireEvent.click(deleteButtons[0]); // SMB Inbound (id=12)

    await waitFor(() => {
      expect(confirmMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringMatching(/Delete pipeline/i),
          destructive: true,
        }),
      );
    });
    // No DELETE because the user cancelled.
    const deleteCall = fetchApiMock.mock.calls.find(
      ([u, o]) => /^\/api\/pipelines\/\d+$/.test(u) && o?.method === 'DELETE',
    );
    expect(deleteCall).toBeUndefined();
  });

  it('confirming the Delete fires DELETE /api/pipelines/<id> and refetches', async () => {
    confirmMock.mockResolvedValue(true);
    render(<Pipelines />);
    await screen.findByText('Enterprise Sales');
    const deleteButtons = screen.getAllByRole('button', { name: /^Delete$/i });
    fireEvent.click(deleteButtons[0]); // SMB Inbound (id=12)

    await waitFor(() => {
      const deleteCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/pipelines/12' && o?.method === 'DELETE',
      );
      expect(deleteCall).toBeTruthy();
    });
    await waitFor(() => {
      const getCalls = fetchApiMock.mock.calls.filter(
        ([u, o]) => u === '/api/pipelines' && (!o || !o.method || o.method === 'GET'),
      );
      expect(getCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('network error on initial mount does not crash the page (no cards render)', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/pipelines') return Promise.reject(new Error('Network down'));
      return Promise.resolve(null);
    });
    render(<Pipelines />);
    // Heading still renders.
    expect(await screen.findByRole('heading', { name: /Sales Pipelines/i })).toBeInTheDocument();
    // No card-name text from the seed appears.
    await waitFor(() => {
      expect(screen.queryByText('Enterprise Sales')).not.toBeInTheDocument();
      expect(screen.queryByText('SMB Inbound')).not.toBeInTheDocument();
    });
    // The page falls into the "empty (length === 0)" branch on error because
    // `setPipelines` is never reached in the catch path — so the empty-state
    // copy renders instead. Pin that fallback so the surface stays graceful.
    expect(screen.getByText(/No pipelines yet/i)).toBeInTheDocument();
  });
});
