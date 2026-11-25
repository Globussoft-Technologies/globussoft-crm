import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { LeadCampaignDial, LeadSelectionBar } from '../components/LeadWorkspaceControls';

it('requires an explicit campaign status selection before dialing', async () => {
  const dial = vi.fn(); const select = vi.fn();
  render(<LeadCampaignDial campaigns={[{ id: 10, name: 'Fresher outreach', leadCount: 40 }]} selectedIds={['10']} onSelection={select} onDial={dial} />);
  fireEvent.click(screen.getByRole('button', { name: 'Bulk dial' }));
  const dialog = await screen.findByRole('dialog', { name: 'Bulk dial options' });
  expect(within(dialog).getByLabelText(/Fresher outreach/)).toBeChecked();
  expect(dial).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole('button', { name: /Choose lead statuses/ }));
  const confirm = within(dialog).getByRole('button', { name: 'Start campaign calls' });
  expect(confirm).toBeDisabled();
  expect(within(dialog).getAllByRole('checkbox')).toHaveLength(4);
  expect(within(dialog).queryByRole('checkbox', { name: /qualified/i })).toBeNull();
  fireEvent.click(within(dialog).getByRole('checkbox', { name: /^DNP/ }));
  fireEvent.click(within(dialog).getByRole('checkbox', { name: /^Junk/ }));
  fireEvent.click(confirm);
  expect(dial).toHaveBeenCalledExactlyOnceWith(['dnp', 'junk']);
});

it('assigns a selected staff member directly from the floating bar', async () => {
  const assign = vi.fn();
  render(<LeadSelectionBar count={2} canUpdate staff={[{ id: 8, name: 'Priya Nair' }]} campaigns={[]} onAssignStaff={assign} />);
  fireEvent.click(screen.getByRole('button', { name: 'Assign staff to selected leads' }));
  const options = await screen.findByRole('listbox', { name: 'Assign staff to selected leads' });
  fireEvent.click(within(options).getByRole('option', { name: 'Priya Nair' }));
  expect(assign).toHaveBeenCalledWith('8');
});

it('shows accurate compact progress without a native full-width loading banner', async () => {
  render(<LeadSelectionBar count={100} busy progress={{ done: 20, total: 100 }} staff={[]} campaigns={[]} />);
  const progress = screen.getByRole('progressbar', { name: 'Bulk action progress' });
  expect(progress).toHaveAttribute('aria-valuenow', '20');
  expect(progress).toHaveAttribute('aria-valuemax', '100');
  expect(progress.firstChild).toHaveStyle({ width: '20%' });
  await waitFor(() => expect(screen.getByText('Updating 20 / 100')).toBeInTheDocument());
});
it('dials multiple statuses without selecting a campaign', async () => {
  const dial = vi.fn();
  render(<LeadCampaignDial campaigns={[]} selectedIds={[]} onDial={dial} />);
  fireEvent.click(screen.getByRole('button', { name: 'Bulk dial' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Choose status' }));
  const start = screen.getByRole('button', { name: 'Start bulk calls' });
  expect(start).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox', { name: /^DNP/ }));
  fireEvent.click(screen.getByRole('checkbox', { name: /^Pending/ }));
  fireEvent.click(start);
  expect(dial).toHaveBeenCalledExactlyOnceWith(['dnp', 'pending'], true);
});
