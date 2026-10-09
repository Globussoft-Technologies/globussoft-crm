import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import SelfWorkProfile from '../components/SelfWorkProfile';

vi.mock('../utils/api', () => ({ fetchApi: vi.fn() }));
const success = vi.fn();
const error = vi.fn();
vi.mock('../utils/notify', () => ({ useNotify: () => ({ success, error }) }));

import { fetchApi } from '../utils/api';

const payload = {
  roleType: 'transport',
  profile: {
    id: 41,
    alternatePhone: '9000099999',
    vehicleType: 'SUV',
    vehicleNumber: 'KA 01 AB 1234',
    notes: 'Call first',
  },
  assignments: [{
    customerId: 61,
    plotSiteId: 30,
    customer: { id: 61, name: 'Priya Shah', company: 'Acme' },
    plot: { id: 30, name: 'Plot 30' },
  }],
  assignedPlots: [{ id: 30, name: 'Plot 30', referenceCode: 'P30' }],
  assignedPickupLocations: [{ id: 4, name: 'North Gate', address: 'MG Road' }],
  pickupLocationOptions: [
    { id: 4, name: 'North Gate', address: 'MG Road' },
    { id: 5, name: 'South Gate', address: 'Residency Road' },
  ],
  plotOptions: [
    { id: 30, name: 'Plot 30', referenceCode: 'P30' },
    { id: 31, name: 'Plot 31', referenceCode: 'P31' },
  ],
};

beforeEach(() => {
  fetchApi.mockReset();
  success.mockReset();
  error.mockReset();
});

describe('<SelfWorkProfile />', () => {
  it('shows fixed customer mappings and locks location selectors while a customer is incomplete', async () => {
    fetchApi.mockResolvedValueOnce(payload);
    render(<SelfWorkProfile />);

    expect(await screen.findByRole('heading', { name: 'Transport profile' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('KA 01 AB 1234')).toBeInTheDocument();
    expect(screen.getByText('Assigned customers')).toBeInTheDocument();
    expect(screen.getByText('Priya Shah')).toBeInTheDocument();
    expect(screen.getByLabelText('Customer plot for Priya Shah')).toHaveTextContent('Plot 30');
    expect(screen.queryByRole('combobox', { name: 'Assigned plot for Priya Shah' })).toBeNull();
    expect(screen.getByText('Assigned plots')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Assigned plots (select multiple)' })).toHaveTextContent('Plot 30 (P30)');
    expect(screen.getByRole('button', { name: 'Assigned plots (select multiple)' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Assigned pickup locations (select multiple)' })).toBeDisabled();
    expect(screen.getByText('Complete all assigned customer steps before changing plots.')).toBeInTheDocument();
    expect(screen.getByText('Complete all assigned customer steps before changing pickup locations.')).toBeInTheDocument();
  });

  it('saves role fields and the separate assigned-plot list', async () => {
    const completedPayload = { ...payload, assignments: [] };
    fetchApi.mockResolvedValueOnce(completedPayload).mockResolvedValueOnce({
      ...completedPayload,
      profile: { ...payload.profile, vehicleNumber: 'KA 02 CD 5678' },
    });
    render(<SelfWorkProfile />);

    fireEvent.change(await screen.findByDisplayValue('KA 01 AB 1234'), { target: { value: 'KA 02 CD 5678' } });
    fireEvent.click(screen.getByRole('button', { name: 'Assigned plots (select multiple)' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Plot 31 (P31)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Assigned pickup locations (select multiple)' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /South Gate/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save work profile' }));

    await waitFor(() => expect(fetchApi).toHaveBeenLastCalledWith(
      '/api/pickup-plot-inventory/people/me',
      expect.objectContaining({ method: 'PUT' }),
    ));
    const body = JSON.parse(fetchApi.mock.calls[1][1].body);
    expect(body).toMatchObject({
      roleType: 'transport',
      vehicleNumber: 'KA 02 CD 5678',
      plotSiteIds: [30, 31],
      pickupLocationIds: [4, 5],
    });
    expect(body).not.toHaveProperty('assignments');
    expect(success).toHaveBeenCalledWith('Work profile updated');
  });

  it.each([
    ['broker', 'Sales Executive profile'],
    ['billing', 'Billing profile'],
  ])('uses the same assigned-plot multi-select for the %s role', async (roleType, heading) => {
    fetchApi.mockResolvedValueOnce({ ...payload, roleType });
    render(<SelfWorkProfile />);

    expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Assigned plots (select multiple)' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Assigned pickup locations (select multiple)' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: /Assigned plot \d+/ })).toBeNull();
  });

  it('does not offer booked, reserved, or sold plots in the assigned-plot multi-select', async () => {
    fetchApi.mockResolvedValueOnce({
      ...payload,
      assignments: [],
      assignedPlots: [
        ...payload.assignedPlots,
        { id: 32, name: 'Booked Plot', availability: 'BOOKED' },
        { id: 33, name: 'Reserved Plot', availability: 'RESERVED' },
        { id: 34, name: 'Sold Plot', availability: 'SOLD' },
      ],
      plotOptions: [
        ...payload.plotOptions,
        { id: 32, name: 'Booked Plot', availability: 'BOOKED' },
        { id: 33, name: 'Reserved Plot', availability: 'RESERVED' },
        { id: 34, name: 'Sold Plot', availability: 'SOLD' },
      ],
    });
    render(<SelfWorkProfile />);

    const assignedPlots = await screen.findByRole('button', { name: 'Assigned plots (select multiple)' });
    expect(assignedPlots).toHaveTextContent('Plot 30 (P30)');
    expect(assignedPlots).not.toHaveTextContent('4 selected');
    fireEvent.click(assignedPlots);
    expect(screen.queryByRole('checkbox', { name: 'Booked Plot' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Reserved Plot' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Sold Plot' })).toBeNull();
  });

  it('stays hidden for users without an operational profile', async () => {
    fetchApi.mockRejectedValueOnce(new Error('not linked'));
    const { container } = render(<SelfWorkProfile />);
    await waitFor(() => expect(container.querySelector('[data-testid="self-work-profile"]')).toBeNull());
  });
});
