import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import TransportPersons from '../pages/TransportPersons';
import PlotBrokers from '../pages/PlotBrokers';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({ fetchApi: (...args) => fetchApiMock(...args) }));

const notify = { success: vi.fn(), error: vi.fn(), info: vi.fn(), confirm: vi.fn() };
vi.mock('../utils/notify', () => ({ useNotify: () => notify }));

beforeEach(() => {
  fetchApiMock.mockReset();
  Object.values(notify).forEach((mock) => mock.mockReset());
});

describe('<TransportPersons />', () => {
  it('keeps the page fixed while only the table data scrolls', async () => {
    fetchApiMock.mockResolvedValue({
      transportPersons: [{ id: 1, name: 'Ravi Kumar', phone: '9000011111', isActive: true }],
      pickupLocations: [], plots: [], customers: [], summary: {},
    });
    render(<TransportPersons />);
    await screen.findByText('Ravi Kumar');

    expect(screen.getByTestId('transport-directory-page')).toHaveStyle({ overflow: 'hidden', minHeight: '0' });
    expect(screen.getByTestId('transport-directory-table-scroll')).toHaveStyle({ overflowY: 'auto', minHeight: '0' });
    expect(screen.getByRole('columnheader', { name: 'Name' })).toHaveStyle({
      position: 'sticky', top: '0px',
      background: 'linear-gradient(var(--table-header-bg, rgba(148,163,184,.08)), var(--table-header-bg, rgba(148,163,184,.08))), var(--popover-bg, #fff)',
    });
  });

  it('refreshes stale saved service areas from plot addresses when editing', async () => {
    fetchApiMock.mockResolvedValue({
      transportPersons: [{
        id: 1,
        name: 'Ravi Kumar',
        phone: '9000011111',
        isActive: true,
        plotSiteIds: [9],
        serviceAreas: [{ plotSiteId: 9, area: 'Koramangala', state: '', pincode: '560095' }],
      }],
      pickupLocations: [],
      plots: [{
        id: 9,
        name: 'plot-1',
        address: 'CA-17, 6th Cross, 6th Block, Koramangala, Banglore - 560095',
        availability: 'AVAILABLE',
      }],
      customers: [],
      summary: { total: 1, active: 1, assigned: 1 },
    });

    render(<TransportPersons />);
    await screen.findByText('Ravi Kumar');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Ravi Kumar' }));
    fireEvent.click(screen.getByRole('button', { name: 'View all service areas (1)' }));

    const dialog = screen.getByRole('dialog', { name: 'All service areas (1)' });
    expect(within(dialog).getByText('Karnataka')).toBeInTheDocument();
    expect(within(dialog).queryByText('Not available in plot address')).toBeNull();
  });

  it('uses a plot dropdown and derives service areas from selected plot addresses', async () => {
    fetchApiMock.mockImplementation((url, options) => {
      if (url === '/api/pickup-plot-inventory/transport-persons' && !options) return Promise.resolve({
        transportPersons: [{ id: 1, name: 'Ravi Kumar', phone: '9000011111', vehicleType: 'Mini truck', vehicleNumber: 'KA 01 AB 1234', isActive: true, pickupLocationId: 4, pickupLocation: { id: 4, name: 'North Gate' } }],
        pickupLocations: [{ id: 4, name: 'North Gate' }, { id: 5, name: 'South Gate' }],
        plots: [
          { id: 9, name: 'Plot A-9', address: 'CA-17, 6th Cross, 6th Block, Koramangala, Bangalore - 560095', availability: 'AVAILABLE' },
          { id: 10, name: 'Plot B-10', address: '100 Feet Rd, Indiranagar, Bengaluru, Karnataka 560038', availability: 'RESERVED' },
        ],
        customers: [
          { id: 21, name: 'Priya Sharma', company: 'Aster Homes', phone: '9000066666' },
          { id: 22, name: 'Arjun Patel', email: 'arjun@example.com' },
        ],
        summary: { total: 1, active: 1, assigned: 1 },
      });
      return Promise.resolve({});
    });
    render(<TransportPersons />);
    expect(await screen.findByText('Ravi Kumar')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Transport Persons' })).toHaveStyle({ width: '100%', minWidth: '0', tableLayout: 'fixed' });
    expect(screen.getByText(/KA 01 AB 1234/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add Transport Person' }));
    const workEmail = screen.getByLabelText('Work email *');
    const loginSetup = screen.getByRole('combobox', { name: 'Transport login setup' });
    const nameInput = screen.getByLabelText('Name *');
    expect(loginSetup.compareDocumentPosition(nameInput) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(loginSetup.compareDocumentPosition(workEmail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'Mohan' } });
    fireEvent.change(screen.getByLabelText('Phone *'), { target: { value: '9000033333' } });
    fireEvent.change(screen.getByLabelText('Work email *'), { target: { value: 'mohan@example.com' } });
    fireEvent.change(screen.getByLabelText('Password *'), { target: { value: 'secret123' } });
    fireEvent.change(screen.getByLabelText('Work email *'), { target: { value: 'mohan@example.com' } });
    fireEvent.change(screen.getByLabelText('Password *'), { target: { value: 'Secret123' } });
    expect(screen.queryByRole('button', { name: /Pickup locations/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add service area' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Customers (select multiple)' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Priya Sharma · Aster Homes · 9000066666' }));
    fireEvent.click(screen.getByRole('button', { name: 'View selected customers (1)' }));
    const customersDialog = screen.getByRole('dialog', { name: 'Selected customers (1)' });
    expect(within(customersDialog).getByText('Priya Sharma')).toBeInTheDocument();
    expect(within(customersDialog).getByText('Aster Homes')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close selected customers' }));
    expect(screen.queryByRole('dialog', { name: 'Selected customers (1)' })).toBeNull();
    expect(screen.getByTestId('plots-field').style.gridColumn).toBe('');
    expect(screen.getByTestId('service-areas-field').style.gridColumn).toBe('');
    expect(screen.getByTestId('plots-field').parentElement).toBe(screen.getByTestId('service-areas-field').parentElement);
    fireEvent.click(screen.getByRole('button', { name: 'Plots / sites (select multiple)' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Plot A-9 (AVAILABLE)' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Plot B-10 (RESERVED)' }));
    expect(screen.queryByTestId('service-area-9')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'View all service areas (2)' }));
    const serviceAreasDialog = screen.getByRole('dialog', { name: 'All service areas (2)' });
    expect(screen.getByTestId('service-areas-list')).toHaveStyle({ overflowY: 'auto', maxHeight: 'calc(82vh - 80px)' });
    expect(within(serviceAreasDialog).getByText('2 selected plot areas')).toBeInTheDocument();
    expect(within(screen.getByTestId('service-area-9')).getByText('Koramangala')).toBeInTheDocument();
    expect(within(screen.getByTestId('service-area-9')).getByText('Karnataka')).toBeInTheDocument();
    expect(within(screen.getByTestId('service-area-9')).getByText('560095')).toBeInTheDocument();
    expect(within(screen.getByTestId('service-area-10')).getByText('Indiranagar')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close service areas' }));
    expect(screen.queryByRole('dialog', { name: 'All service areas (2)' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith(
      '/api/pickup-plot-inventory/transport-persons',
      expect.objectContaining({ method: 'POST' }),
    ));
    const call = fetchApiMock.mock.calls.find(([url, options]) => url.endsWith('/transport-persons') && options?.method === 'POST');
    expect(JSON.parse(call[1].body)).toMatchObject({
      name: 'Mohan', phone: '9000033333', email: 'mohan@example.com', password: 'Secret123',
      pickupLocationIds: [], plotSiteIds: [9, 10], customerIds: [21],
      serviceAreas: [
        { plotSiteId: 9, area: 'Koramangala', state: 'Karnataka', pincode: '560095' },
        { plotSiteId: 10, area: 'Indiranagar', state: 'Karnataka', pincode: '560038' },
      ],
    });
  });

  it('blocks an invalid phone number before calling the API', async () => {
    fetchApiMock.mockResolvedValue({ transportPersons: [], pickupLocations: [], summary: {} });
    render(<TransportPersons />);
    await screen.findByText('No transport persons yet.');
    fireEvent.click(screen.getByRole('button', { name: 'Add Transport Person' }));
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'Ravi Kumar' } });
    fireEvent.change(screen.getByLabelText('Phone *'), { target: { value: '123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(notify.error).toHaveBeenCalledWith('Phone must contain 7 to 15 digits.');
    expect(fetchApiMock.mock.calls.some(([url, options]) => url.endsWith('/transport-persons') && options?.method === 'POST')).toBe(false);
  });

  it('assigns an existing Transport Person staff account without sending a password', async () => {
    fetchApiMock.mockImplementation((url, options) => {
      if (url === '/api/pickup-plot-inventory/transport-persons' && !options) return Promise.resolve({
        transportPersons: [], plots: [], customers: [],
        staffUsers: [{ id: 82, name: 'Sant Kumar', email: 'sant@example.com', phone: '9000099999' }],
        transportRole: { id: 8, key: 'transport_person', name: 'Transport person' },
        summary: {},
      });
      return Promise.resolve({});
    });
    render(<TransportPersons />);
    await screen.findByText('No transport persons yet.');
    fireEvent.click(screen.getByRole('button', { name: 'Add Transport Person' }));
    const loginSetup = screen.getByRole('combobox', { name: 'Transport login setup' });
    fireEvent.change(loginSetup, { target: { value: 'existing' } });
    const existingStaff = screen.getByRole('combobox', { name: 'Existing transport staff' });
    expect(loginSetup.compareDocumentPosition(existingStaff) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.change(existingStaff, { target: { value: '82' } });

    expect(screen.getByLabelText('Name *')).toHaveValue('Sant Kumar');
    expect(screen.getByLabelText('Phone *')).toHaveValue('9000099999');
    expect(screen.queryByLabelText('Password *')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith(
      '/api/pickup-plot-inventory/transport-persons',
      expect.objectContaining({ method: 'POST' }),
    ));
    const call = fetchApiMock.mock.calls.find(([url, options]) => url.endsWith('/transport-persons') && options?.method === 'POST');
    expect(JSON.parse(call[1].body)).toMatchObject({ staffUserId: 82, name: 'Sant Kumar', phone: '9000099999' });
    expect(JSON.parse(call[1].body)).not.toHaveProperty('password');
  });

  it('refreshes customer choices when the directory regains focus', async () => {
    fetchApiMock
      .mockResolvedValueOnce({ transportPersons: [], plots: [], customers: [], summary: {} })
      .mockResolvedValueOnce({
        transportPersons: [], plots: [],
        customers: [{ id: 21, name: 'Priya Sharma', phone: '9000066666' }],
        summary: {},
      });
    render(<TransportPersons />);
    await screen.findByText('No transport persons yet.');

    fireEvent.focus(window);
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'Add Transport Person' }));
    fireEvent.click(screen.getByRole('button', { name: 'Customers (select multiple)' }));
    expect(screen.getByRole('checkbox', { name: /Priya Sharma/ })).toBeInTheDocument();
  });

  it('allows plots and customers to be shared by every transport person', async () => {
    const plots = [
      { id: 9, name: 'Plot A-9', address: 'Koramangala, Karnataka 560095', availability: 'AVAILABLE' },
      { id: 10, name: 'Plot B-10', address: 'Indiranagar, Karnataka 560038', availability: 'AVAILABLE' },
      { id: 11, name: 'Plot C-11', address: 'Jayanagar, Karnataka 560041', availability: 'AVAILABLE' },
    ];
    const customers = [
      { id: 21, name: 'Priya Sharma', phone: '9000066666' },
      { id: 22, name: 'Arjun Patel', phone: '9000077777' },
      { id: 23, name: 'Meera Rao', phone: '9000088888' },
    ];
    fetchApiMock.mockImplementation((url, options) => {
      if (url === '/api/pickup-plot-inventory/transport-persons' && !options) return Promise.resolve({
        transportPersons: [
          {
            id: 1, name: 'Ravi Kumar', phone: '9000011111', isActive: true,
            plotSiteIds: [9], customerIds: [21],
          },
          { id: 2, name: 'Mohan Das', phone: '9000022222', isActive: true, plotSiteIds: [10], customerIds: [22] },
        ],
        plots, customers, pickupLocations: [], summary: { total: 2, active: 2, assigned: 2 },
      });
      return Promise.resolve({});
    });

    render(<TransportPersons />);
    await screen.findByText('Ravi Kumar');

    fireEvent.click(screen.getByRole('button', { name: 'Add Transport Person' }));
    fireEvent.click(screen.getByRole('button', { name: 'Customers (select multiple)' }));
    expect(screen.getByRole('checkbox', { name: /Priya Sharma/ })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Arjun Patel/ })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Meera Rao/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Plots / sites (select multiple)' }));
    expect(screen.getByRole('checkbox', { name: /Plot A-9/ })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Plot B-10/ })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Plot C-11/ })).toBeInTheDocument();
  });
});

describe('<PlotBrokers />', () => {
  it('allows customers and plots already assigned to another broker to be selected', async () => {
    fetchApiMock.mockResolvedValue({
      brokers: [{ id: 2, name: 'Asha Rao', phone: '9000022222', isActive: true, plotSiteIds: [9], customerIds: [21] }],
      plots: [
        { id: 9, name: 'Plot A-9', availability: 'AVAILABLE' },
        { id: 10, name: 'Plot B-10', availability: 'RESERVED' },
      ],
      customers: [
        { id: 21, name: 'Priya Sharma', phone: '9000066666' },
        { id: 22, name: 'Arjun Patel', phone: '9000077777' },
      ],
      summary: {},
    });
    render(<PlotBrokers />);
    await screen.findByText('Asha Rao');
    fireEvent.click(screen.getByRole('button', { name: 'Add Plot Broker' }));
    fireEvent.click(screen.getByRole('button', { name: 'Customers (select multiple)' }));
    expect(screen.getByRole('checkbox', { name: /Priya Sharma/ })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Arjun Patel/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Broker plots / sites (select multiple)' }));
    expect(screen.getByRole('checkbox', { name: /Plot A-9/ })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Plot B-10/ })).toBeInTheDocument();
  });

  it('keeps the page fixed while only the table data scrolls', async () => {
    fetchApiMock.mockResolvedValue({
      brokers: [{ id: 2, name: 'Asha Rao', phone: '9000022222', isActive: true }],
      plots: [], customers: [], summary: {},
    });
    render(<PlotBrokers />);
    await screen.findByText('Asha Rao');

    expect(screen.getByTestId('broker-directory-page')).toHaveStyle({ overflow: 'hidden', minHeight: '0' });
    expect(screen.getByTestId('broker-directory-table-scroll')).toHaveStyle({ overflowY: 'auto', minHeight: '0' });
    expect(screen.getByRole('columnheader', { name: 'Name' })).toHaveStyle({
      position: 'sticky', top: '0px',
      background: 'linear-gradient(var(--table-header-bg, rgba(148,163,184,.08)), var(--table-header-bg, rgba(148,163,184,.08))), var(--popover-bg, #fff)',
    });
  });

  it('shows and clears instant inline errors below invalid name and phone fields', async () => {
    fetchApiMock.mockResolvedValue({ brokers: [], plots: [], summary: {} });
    render(<PlotBrokers />);
    await screen.findByText('No plot brokers yet.');
    fireEvent.click(screen.getByRole('button', { name: 'Add Plot Broker' }));

    const name = screen.getByLabelText('Name *');
    const phone = screen.getByLabelText('Phone *');
    fireEvent.change(name, { target: { value: 'vcgttg334534' } });
    fireEvent.change(phone, { target: { value: 'dfgftg223125' } });

    expect(screen.getByText(/Name can contain only letters/i)).toBeInTheDocument();
    expect(screen.getByText(/Phone contains invalid characters/i)).toBeInTheDocument();
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(phone).toHaveAttribute('aria-invalid', 'true');

    fireEvent.change(name, { target: { value: 'Vikram Rao' } });
    fireEvent.change(phone, { target: { value: '9000044444' } });
    expect(screen.queryByText(/Name can contain only letters/i)).toBeNull();
    expect(screen.queryByText(/Phone contains invalid characters/i)).toBeNull();
    expect(name).toHaveAttribute('aria-invalid', 'false');
    expect(phone).toHaveAttribute('aria-invalid', 'false');
  });

  it('shows plot assignments and creates a broker with commission', async () => {
    fetchApiMock.mockImplementation((url, options) => {
      if (url === '/api/pickup-plot-inventory/brokers' && !options) return Promise.resolve({
        brokers: [{ id: 2, name: 'Asha Rao', phone: '9000022222', agency: 'Prime Plots', commissionPercent: '2.50', isActive: true, plotSiteId: 9, plotSite: { id: 9, name: 'Plot A-9' } }],
        plots: [
          { id: 9, name: 'Plot A-9', address: '80 Feet Rd, Koramangala, Bengaluru, Karnataka 560095', availability: 'AVAILABLE' },
          { id: 10, name: 'Plot B-10', address: '100 Feet Rd, Indiranagar, Bengaluru, Karnataka 560038', availability: 'RESERVED' },
        ],
        customers: [{ id: 21, name: 'Priya Sharma', company: 'Aster Homes', phone: '9000066666' }],
        summary: { total: 1, active: 1, assigned: 1 },
      });
      return Promise.resolve({});
    });
    render(<PlotBrokers />);
    expect(await screen.findByText('Asha Rao')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Plot Brokers' })).toHaveStyle({ width: '100%', minWidth: '0', tableLayout: 'fixed' });
    expect(screen.getByText(/2.5%/)).toBeInTheDocument();
    const brokerRow = screen.getByText('Asha Rao').closest('tr');
    expect(within(brokerRow).getByText('Active')).toHaveStyle({
      alignSelf: 'flex-start', padding: '0.2rem 0.45rem', borderRadius: '6px',
      fontSize: '0.7rem', lineHeight: '1.2',
    });
    expect(within(brokerRow).getByRole('button', { name: 'Edit Asha Rao' })).toHaveTextContent('');
    expect(within(brokerRow).getByRole('button', { name: 'Deactivate Asha Rao' })).toHaveTextContent('');
    fireEvent.click(screen.getByRole('button', { name: 'Add Plot Broker' }));
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'Vikram' } });
    fireEvent.change(screen.getByLabelText('Phone *'), { target: { value: '9000044444' } });
    fireEvent.change(screen.getByLabelText('Work email *'), { target: { value: 'vikram@example.com' } });
    fireEvent.change(screen.getByLabelText('Password *'), { target: { value: 'secret123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Broker plots / sites (select multiple)' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Plot A-9 (AVAILABLE)' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Plot B-10 (RESERVED)' }));
    fireEvent.click(screen.getByRole('button', { name: 'View assigned plot areas (2)' }));
    const plotAreasDialog = screen.getByRole('dialog', { name: 'All service areas (2)' });
    expect(within(plotAreasDialog).getByText('Koramangala')).toBeInTheDocument();
    expect(within(plotAreasDialog).getByText('Indiranagar')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close service areas' }));
    fireEvent.change(screen.getByLabelText('Commission (%)'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Customers (select multiple)' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Priya Sharma · Aster Homes · 9000066666' }));
    fireEvent.click(screen.getByRole('button', { name: 'View selected customers (1)' }));
    expect(within(screen.getByRole('dialog', { name: 'Selected customers (1)' })).getByText('Priya Sharma')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close selected customers' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith(
      '/api/pickup-plot-inventory/brokers',
      expect.objectContaining({ method: 'POST' }),
    ));
    const call = fetchApiMock.mock.calls.find(([url, options]) => url.endsWith('/brokers') && options?.method === 'POST');
    expect(JSON.parse(call[1].body)).toMatchObject({
      name: 'Vikram', email: 'vikram@example.com', password: 'secret123',
      plotSiteIds: [9, 10], commissionPercent: '3', customerIds: [21],
    });
  });

  it('can assign an existing Broker staff user instead of creating a new login', async () => {
    fetchApiMock.mockImplementation((url, options) => {
      if (url === '/api/pickup-plot-inventory/brokers' && !options) return Promise.resolve({
        brokers: [], plots: [], customers: [],
        staffRole: { id: 8, key: 'BROOKER', name: 'BROOKER' },
        staffUsers: [{ id: 17, name: 'Sanjeev Rao', email: 'sanjeev@example.com', phone: '9000099999' }],
        summary: {},
      });
      return Promise.resolve({});
    });

    render(<PlotBrokers />);
    await screen.findByText('No plot brokers yet.');
    fireEvent.click(screen.getByRole('button', { name: 'Add Plot Broker' }));
    fireEvent.change(screen.getByLabelText('Broker login setup'), { target: { value: 'existing' } });
    fireEvent.change(screen.getByLabelText('Existing broker staff'), { target: { value: '17' } });
    expect(screen.getByLabelText('Name *')).toHaveValue('Sanjeev Rao');
    expect(screen.getByLabelText('Phone *')).toHaveValue('9000099999');
    expect(screen.queryByLabelText('Password *')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith(
      '/api/pickup-plot-inventory/brokers',
      expect.objectContaining({ method: 'POST' }),
    ));
    const call = fetchApiMock.mock.calls.find(([url, options]) => url.endsWith('/brokers') && options?.method === 'POST');
    expect(JSON.parse(call[1].body)).toMatchObject({ staffUserId: 17, name: 'Sanjeev Rao', phone: '9000099999' });
    expect(JSON.parse(call[1].body)).not.toHaveProperty('password');
  });

  it('filters brokers by searchable details, status, and plot assignment', async () => {
    fetchApiMock.mockResolvedValue({
      brokers: [
        { id: 2, name: 'Asha Rao', phone: '9000022222', agency: 'Prime Plots', isActive: true, plotSiteId: 9, plotSite: { id: 9, name: 'Plot A-9' } },
        { id: 3, name: 'Rohan Shah', phone: '9000055555', email: 'rohan@example.com', agency: 'Independent', isActive: false, plotSiteId: null, plotSite: null },
      ],
      plots: [{ id: 9, name: 'Plot A-9', availability: 'AVAILABLE' }],
      summary: { total: 2, active: 1, assigned: 1 },
    });
    render(<PlotBrokers />);
    expect(await screen.findByText('Asha Rao')).toBeInTheDocument();
    expect(screen.getByText('Rohan Shah')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search plot brokers' }), { target: { value: 'rohan@example.com' } });
    expect(screen.queryByText('Asha Rao')).toBeNull();
    expect(screen.getByText('Rohan Shah')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search plot brokers' }), { target: { value: '' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by status' }), { target: { value: 'active' } });
    expect(screen.getByText('Asha Rao')).toBeInTheDocument();
    expect(screen.queryByText('Rohan Shah')).toBeNull();

    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by status' }), { target: { value: 'all' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by assignment' }), { target: { value: 'unassigned' } });
    expect(screen.queryByText('Asha Rao')).toBeNull();
    expect(screen.getByText('Rohan Shah')).toBeInTheDocument();
  });
});
