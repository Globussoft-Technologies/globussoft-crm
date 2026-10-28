import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PickupPlotWorkAssignments from '../pages/PickupPlotWorkAssignments';

const fetchApiMock = vi.fn();
const notifySuccess = vi.fn();
const notifyError = vi.fn();
const notify = { success: notifySuccess, error: notifyError };

vi.mock('../utils/api', () => ({ fetchApi: (...args) => fetchApiMock(...args) }));
vi.mock('../utils/notify', () => ({
  useNotify: () => notify,
}));

describe('PickupPlotWorkAssignments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchApiMock.mockResolvedValue({
      staff: [{
        id: 12,
        name: 'Asha Rao',
        email: 'asha@example.com',
        phone: '9000012345',
        workTypes: ['transport'],
      }],
    });
  });

  it('lets an admin assign multiple work types to a person in any role', async () => {
    render(<PickupPlotWorkAssignments />);

    expect(await screen.findByText('Asha Rao')).toBeInTheDocument();
    expect(screen.queryByText('Sales Executive')).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Transport for Asha Rao' })).toBeChecked();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Site Visits for Asha Rao' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Billing for Asha Rao' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith(
      '/api/pickup-plot-inventory/work-assignments',
      {
        method: 'PUT',
        body: JSON.stringify({ targetUserId: 12, workTypes: ['transport', 'broker', 'billing'] }),
      },
    ));
    expect(notifySuccess).toHaveBeenCalledWith('Work assignments updated for Asha Rao.');
  });

  it('filters the staff list without changing assignments', async () => {
    render(<PickupPlotWorkAssignments />);
    await screen.findByText('Asha Rao');

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search staff' }), { target: { value: 'billing manager' } });

    expect(screen.queryByText('Asha Rao')).not.toBeInTheDocument();
    expect(screen.getByText('No staff members match your search.')).toBeInTheDocument();
    expect(fetchApiMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the page fixed and scrolls only the table data area', async () => {
    render(<PickupPlotWorkAssignments />);
    await screen.findByText('Asha Rao');

    const headerActions = screen.getByTestId('staff-work-assignment-header-actions');
    expect(headerActions).toContainElement(screen.getByRole('searchbox', { name: 'Search staff' }));
    expect(headerActions).toContainElement(screen.getByText('staff with assigned work'));
    expect(screen.getByTestId('staff-work-assignment-count')).toHaveStyle({ height: '44px', boxSizing: 'border-box' });
    expect(screen.getByTestId('staff-work-assignment-page')).toHaveStyle({ overflow: 'hidden', minHeight: '0' });
    expect(screen.getByTestId('staff-work-assignment-table-scroll')).toHaveClass('pickup-plot-table-body-scroll');
    expect(screen.getByTestId('staff-work-assignment-table-scroll')).toHaveStyle({ overflow: 'auto', minHeight: '0' });
    expect(screen.getByRole('table', { name: 'Staff work assignments' })).toHaveStyle({ tableLayout: 'fixed' });
    expect(screen.getByRole('columnheader', { name: 'Staff' })).toHaveStyle({ position: 'sticky', top: '0px' });
  });

  it('distinguishes an empty staff directory from a search with no matches', async () => {
    fetchApiMock.mockResolvedValueOnce({ staff: [] });

    render(<PickupPlotWorkAssignments />);

    expect(await screen.findByText('No active staff accounts are available.')).toBeInTheDocument();
    expect(screen.queryByText('No staff members match your search.')).not.toBeInTheDocument();
  });

  it('shows a retry action when loading staff fails', async () => {
    fetchApiMock
      .mockRejectedValueOnce(new Error('Staff API unavailable'))
      .mockResolvedValueOnce({ staff: [] });

    render(<PickupPlotWorkAssignments />);

    expect(await screen.findByText('Staff API unavailable')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('No active staff accounts are available.')).toBeInTheDocument();
    expect(fetchApiMock).toHaveBeenCalledTimes(2);
  });
});
