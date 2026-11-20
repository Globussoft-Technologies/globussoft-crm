import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import CallifiedCallStatusDrawer from '../components/CallifiedCallStatusDrawer';
import { fetchApi } from '../utils/api';
vi.mock('../utils/api', () => ({ fetchApi: vi.fn() }));
const notify = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn(), success: vi.fn() }));
vi.mock('../utils/notify', () => ({ useNotify: () => notify }));
vi.mock('../components/LeadDialWorkspace', () => ({ LeadDialRuns: () => <section aria-label="Dial runs" /> }));
vi.mock('../components/CallifiedCallDetailsDrawer', () => ({ default: ({ lead }) => <div>Details for {lead.name}</div> }));
const history = [
  { id: 1, contactId: 11, status: 'RINGING', createdAt: new Date().toISOString(), contact: { name: 'Alice', phone: '+919876543210' } },
  { id: 2, contactId: 12, status: 'COMPLETED', createdAt: new Date().toISOString(), contact: { name: 'Bob', phone: '+14155551234' } },
];
beforeEach(() => {
  vi.clearAllMocks();
  fetchApi.mockImplementation(async (url) => url.endsWith('call-status-history') ? { history } : {});
});
it('filters history by status and searchable lead information', async () => {
  render(<CallifiedCallStatusDrawer onClose={vi.fn()} />);
  await screen.findByText('Alice');
  fireEvent.click(screen.getByRole('button', { name: 'Active', exact: true }));
  expect(screen.queryByText('Bob')).toBeNull();
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'missing' } });
  expect(screen.getByText('No calls match your filters.')).toBeInTheDocument();
});
it('closes transcript details before closing Call status on Escape', async () => {
  const onClose = vi.fn();
  render(<CallifiedCallStatusDrawer onClose={onClose} />);
  await screen.findByText('Alice');
  fireEvent.click(within(screen.getByText('Alice').closest('article')).getByRole('button', { name: 'Transcript & details' }));
  expect(screen.getByText('Details for Alice')).toBeInTheDocument();
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.queryByText('Details for Alice')).not.toBeInTheDocument();
  expect(onClose).not.toHaveBeenCalled();

  const search = screen.getByRole('searchbox');
  search.focus();
  fireEvent.keyDown(search, { key: 'Escape' });
  expect(onClose).toHaveBeenCalledOnce();
});
it('places refresh in the header and removes the footer controls', async () => {
  render(<CallifiedCallStatusDrawer onClose={vi.fn()} />);
  await screen.findByText('Alice');
  expect(screen.queryByRole('button', { name: 'Stop call' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Refresh call status' }).closest('header')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Clear history' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Close', exact: true })).toBeNull();
  expect(fetchApi.mock.calls.some(([url]) => url.endsWith('/stop'))).toBe(false);
});
it('keeps a read-only viewer from syncing or stopping calls', async () => {
  render(<CallifiedCallStatusDrawer onClose={vi.fn()} canWrite={false} />);
  await screen.findByText('Alice');
  expect(screen.queryByRole('button', { name: 'Stop call' })).toBeNull();
  expect(fetchApi.mock.calls.some(([url]) => url.endsWith('sync-call-statuses'))).toBe(false);
});
it('pages recent calls in groups of fifteen and searches beyond the visible cards', async () => {
  const calls = Array.from({ length: 18 }, (_, i) => ({ id: i + 1, status: 'COMPLETED', contactId: i + 1,
    createdAt: new Date(Date.UTC(2026, 10, 20, 12, 0, 59 - i)).toISOString(), contact: { name: `Contact ${i + 1}` } }));
  fetchApi.mockImplementation(async url => url.endsWith('call-status-history') ? { history: calls } : {});
  render(<CallifiedCallStatusDrawer onClose={vi.fn()} />);
  expect(await screen.findByText('Showing 15 of 18 calls')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Show 3 more · 3 left' }));
  expect(screen.getByText('Contact 18')).toBeVisible();
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Contact 18' } });
  expect(screen.getByText('Showing 1 of 18 calls')).toBeVisible();
});
