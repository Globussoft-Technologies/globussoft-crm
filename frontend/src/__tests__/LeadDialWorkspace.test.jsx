import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CallifiedConnection, DialToolbar, LeadDialComposer, LeadDialRuns } from '../components/LeadDialWorkspace';
import { runLeadBatches } from '../utils/leadBulkWork';
import { fetchApi } from '../utils/api';
vi.mock('../utils/api', () => ({ fetchApi: vi.fn() }));
const notify = vi.hoisted(() => ({ info: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock('../utils/notify', () => ({ useNotify: () => notify }));
beforeEach(() => { vi.clearAllMocks(); fetchApi.mockResolvedValue({ jobs: [] }); });

describe('calling workspace', () => {
  it('shows upcoming work inside the idle Call Status button', async () => {
    fetchApi.mockResolvedValueOnce({ running: [], activeCalls: 0, upcoming: 3 });
    const open = vi.fn();
    render(<DialToolbar onOpen={open}>{badge => <button onClick={open}>Call Status {badge}</button>}</DialToolbar>);
    fireEvent.click(await screen.findByRole('button', { name: /Call Status 3 upcoming/i }));
    expect(open).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Stop all dialing' })).toBeNull();
  });
  it('opens live status and stops the queue directly from the toolbar', async () => {
    fetchApi.mockResolvedValueOnce({ running: [], activeCalls: 1 }).mockResolvedValueOnce({ paused: true });
    const open = vi.fn();
    render(<DialToolbar canManage onOpen={open}>Call Status</DialToolbar>);
    fireEvent.click(await screen.findByRole('button', { name: 'Open live call status' }));
    expect(open).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Stop all dialing' }));
    await screen.findByText('Call Status');
    expect(fetchApi).toHaveBeenCalledWith('/api/callified/dial-jobs/control', expect.objectContaining({ method: 'PUT', body: '{"paused":true}' }));
  });
  it('offers a quiet connection badge and connect action', () => {
    const connect = vi.fn();
    render(<CallifiedConnection connected={false} onConnect={connect} />);
    expect(screen.getByText(/Not connected/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(connect).toHaveBeenCalledOnce();
  });
  it('sends whole-campaign selection with only the chosen statuses', async () => {
    render(<LeadDialComposer selection={{ campaignIds: [19] }} onClose={vi.fn()} />);
    fireEvent.click(screen.getByLabelText(/Yet to call/));
    fireEvent.click(screen.getByLabelText(/Pending/));
    fireEvent.click(screen.getByRole('button', { name: 'Start dial run' }));
    await waitFor(() => expect(fetchApi).toHaveBeenCalled());
    const body = JSON.parse(fetchApi.mock.calls[0][1].body);
    expect(body).toEqual({ campaignIds: [19], statuses: ['dnp'] });
    expect(screen.queryByRole('checkbox', { name: /^Qualified/ })).toBeNull();
  });
  it('schedules the selected local datetime as an absolute instant', async () => {
    render(<LeadDialComposer selection={{ contactIds: [3] }} onClose={vi.fn()} />);
    fireEvent.click(screen.getByLabelText(/Pick date/));
    const future = new Date(Date.now() + 86_400_000);
    const value = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, '0')}-${String(future.getDate()).padStart(2, '0')}T15:00`;
    fireEvent.change(screen.getByLabelText(/Scheduled start/), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: 'Schedule calls' }));
    await waitFor(() => expect(fetchApi).toHaveBeenCalled());
    expect(JSON.parse(fetchApi.mock.calls[0][1].body).scheduledAt).toBe(new Date(value + 'Z').toISOString());
  });
  it('keeps failed submissions open with an actionable inline message', async () => {
    fetchApi.mockRejectedValue(new Error('Connect Callified first.'));
    const close = vi.fn();
    render(<LeadDialComposer selection={{ contactIds: [3] }} onClose={close} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start dial run' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Connect Callified first.');
    expect(close).not.toHaveBeenCalled();
  });
  it('cancels queued work and explains that the current call continues', async () => {
    fetchApi.mockImplementation((url, options) => options?.method === 'POST'
      ? Promise.resolve({ cancelled: true, currentCallContinues: true })
      : Promise.resolve({ jobs: [{ id: 5, status: 'running', scheduledAt: new Date().toISOString(), total: 9, completed: 1, skipped: 0, failed: 0 }] }));
    render(<LeadDialRuns />);
    fireEvent.click(await screen.findByRole('button', { name: 'Stop dialing' }));
    await waitFor(() => expect(notify.success).toHaveBeenCalledWith(expect.stringContaining('current call will finish normally')));
    expect(fetchApi).toHaveBeenCalledWith('/api/callified/dial-jobs/5/cancel', expect.objectContaining({ method: 'POST' }));
  });
  it('shows campaign, bulk and scheduled runs with their lifecycle and results', async () => {
    const counts = { total: 9, completed: 1, skipped: 2, failed: 1 };
    fetchApi.mockResolvedValue({ jobs: [
      { ...counts, id: 1, campaignCount: 2, statuses: ['dnp', 'junk'], status: 'running', activeCallLogId: 42 },
      { ...counts, id: 2, status: 'scheduled', scheduled: true, scheduledAt: new Date(Date.now() + 86_400_000).toISOString() },
      { ...counts, id: 3, status: 'completed' },
    ] });
    render(<LeadDialRuns canWrite={false} />);
    expect(await screen.findByText('Dial run #1', { selector: 'strong' })).toBeVisible();
    expect(screen.queryByText(/Leads dialed/)).toBeNull();
    fetchApi.mockResolvedValueOnce({ dialedCount: 9, calls: [{ id: 42, name: 'Test lead', phone: '12345', outcome: 'pending', at: new Date().toISOString() }] });
    fireEvent.click(screen.getByLabelText('View details for run 1'));
    expect(await screen.findByText('Leads dialed (9)')).toBeVisible();
    expect(screen.getByText('Test lead')).toBeVisible();
    expect(screen.getByText('12345')).toBeVisible();
    expect(screen.getByText('1 call submitted · awaiting outcome')).toBeVisible();
    expect(screen.getByText('9 leads', { selector: 'strong' })).toBeVisible();
    const type = screen.getByRole('combobox', { name: 'Filter run type' });
    fireEvent.change(type, { target: { value: 'scheduled' } });
    expect(screen.queryByText('Dial run #1', { selector: 'strong' })).toBeNull();
    fireEvent.change(type, { target: { value: 'all' } });
    expect(screen.queryByRole('button', { name: 'Stop dialing' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Past runs (1)' }));
    expect(screen.getByText('Dial run #3', { selector: 'strong' })).toBeVisible();
    expect(screen.getByText('2 skipped')).toBeVisible();
  });
  it('shows five past runs at a time with their recorded outcome counts', async () => {
    fetchApi.mockResolvedValue({ jobs: Array.from({ length: 7 }, (_, index) => ({
      id: index + 1, status: 'completed', total: 2, completed: 2, skipped: 0, failed: 0,
      outcomes: { qualified: 1, dnp: 1 },
    })) });
    render(<LeadDialRuns />);
    fireEvent.click(await screen.findByRole('button', { name: 'Past runs (7)' }));
    expect(screen.getAllByText('1 Qualified')).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: 'Show 2 more runs · 2 left' }));
    expect(screen.getAllByText('1 DNP')).toHaveLength(7);
  });
  it('shows the server clock and the automatic queues alongside runs', async () => {
    const retry = { enabled: true, maxRetries: 2, due: 1, upcoming: 0, waiting: 0, entries: [] };
    fetchApi.mockResolvedValue({ jobs: [], queues: {
      serverTime: '2026-11-19T08:00:00.000Z', timezone: 'Asia/Kolkata', workerEnabled: true, activeCalls: 1,
      pending: { ...retry, entries: [{ id: 4, name: 'Pending lead', callifiedDnpNextRetryAt: '2026-11-19T07:59:28.000Z', callifiedDnpRetryCount: 1, retryFailure: 'CALLIFIED_API_503' }] },
      dnp: { ...retry, enabled: false },
      autoDial: { enabled: true, queued: 3, submitting: 1 },
    } });
    render(<LeadDialRuns />);
    fireEvent.click(await screen.findByText(/Queues and dialing controls/));
    expect(await screen.findByText('CRM time')).toBeVisible();
    expect(screen.getByText(/1:30:0\d PM/)).toBeVisible();
    expect(screen.getByRole('region', { name: 'Pending retries' })).toHaveTextContent('Pending lead');
    expect(screen.getByRole('region', { name: 'Pending retries' })).toHaveTextContent(/1:29:28 PM.*Previous submission failed \(CALLIFIED_API_503\)/);
    expect(screen.getByRole('region', { name: 'DNP retries' })).toHaveTextContent('Off');
    expect(screen.getByRole('region', { name: 'New-lead auto-dial' })).toHaveTextContent('3 queued');
    expect(screen.getByText('1 active Callified call')).toBeVisible();
  });
});

describe('bulk backpressure', () => {
  it('splits large selections into bounded serial requests', async () => {
    let active = 0;
    fetchApi.mockImplementation(async (_url, options) => {
      expect(++active).toBe(1);
      const ids = JSON.parse(options.body).contactIds;
      expect(ids.length).toBeLessThanOrEqual(100);
      --active; return { updated: ids.length };
    });
    const progress = vi.fn();
    const result = await runLeadBatches('/bulk', 'PUT', Array.from({ length: 251 }, (_, i) => i + 1), {}, progress);
    expect(result.updated).toBe(251); expect(fetchApi).toHaveBeenCalledTimes(3);
    expect(progress).toHaveBeenLastCalledWith({ done: 251, total: 251 });
  });
  it('stops at a failed batch without retrying destructive requests', async () => {
    fetchApi.mockResolvedValueOnce({ deleted: 100 }).mockRejectedValueOnce(new Error('offline'));
    await expect(runLeadBatches('/bulk', 'DELETE', Array.from({ length: 251 }, (_, i) => i + 1))).rejects.toThrow('offline');
    expect(fetchApi).toHaveBeenCalledTimes(2);
  });
});
