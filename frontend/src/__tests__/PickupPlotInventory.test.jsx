import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AuthContext } from '../App';
import PickupPlotInventory from '../pages/PickupPlotInventory';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({ fetchApi: (...args) => fetchApiMock(...args) }));

const geocodeSuggestMock = vi.fn();
vi.mock('../lib/geocoder', () => ({
  geocodeSuggest: (...args) => geocodeSuggestMock(...args),
}));

const notify = { success: vi.fn(), error: vi.fn(), info: vi.fn(), confirm: vi.fn() };
vi.mock('../utils/notify', () => ({ useNotify: () => notify }));
vi.mock('../components/PlotBoundaryMap', () => ({
  default: ({ editable, boundary = [], onChange }) => (
    <div data-testid={editable ? 'boundary-editor' : 'boundary-viewer'}>
      <span>{boundary.length} GPS points</span>
      {editable && <button type="button" onClick={() => onChange([
        { latitude: 12.935, longitude: 77.61 },
        { latitude: 12.935, longitude: 77.6101 },
        { latitude: 12.9351, longitude: 77.6101 },
      ])}>Draw test boundary</button>}
    </div>
  ),
}));

const inventory = {
  pickupLocations: [{
    id: 1, name: 'North Gate', address: '10 Market Road',
    googleMapsLink: 'https://maps.google.com/?q=12,77', isActive: true, plotCount: 2,
  }],
  plots: [{
    id: 9, name: 'Plot A-9', address: '25 Lake Road', area: '1200 sq ft', price: '250000',
    availability: 'AVAILABLE', isActive: true,
  }],
  summary: { activeLocations: 1, totalPlots: 1, availablePlots: 1, reservedPlots: 0, soldPlots: 0 },
};

function renderPage() {
  return render(
    <AuthContext.Provider value={{ tenant: { vertical: 'generic', locale: 'en-IN', defaultCurrency: 'INR' } }}>
      <PickupPlotInventory />
    </AuthContext.Provider>,
  );
}

beforeEach(() => {
  fetchApiMock.mockReset();
  fetchApiMock.mockImplementation((url, options) => {
    if (url === '/api/pickup-plot-inventory' && !options) return Promise.resolve(inventory);
    return Promise.resolve({});
  });
  geocodeSuggestMock.mockReset();
  geocodeSuggestMock.mockResolvedValue([]);
  Object.values(notify).forEach((mock) => mock.mockReset());
});

describe('<PickupPlotInventory />', () => {
  it('shows a retry error instead of a misleading empty inventory when loading fails', async () => {
    fetchApiMock.mockRejectedValueOnce(new Error('Database schema is unavailable'));
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('Inventory could not be loaded.');
    expect(screen.queryByText('No pickup locations yet.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Plot A-9')).toBeInTheDocument();
  });

  it('loads the plots and sites inventory without the pickup-locations page', async () => {
    renderPage();
    expect(await screen.findByText('Plot A-9')).toBeInTheDocument();
    expect(fetchApiMock).toHaveBeenCalledWith('/api/pickup-plot-inventory');
    expect(screen.getByRole('heading', { name: 'Plot & Site Inventory' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /Pickup Locations/i })).toBeNull();
    expect(screen.queryByText('No pickup locations yet.')).toBeNull();
    expect(screen.getByRole('button', { name: /Add Plot \/ Site/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Filter by status' })).not.toHaveStyle({ height: '26px' });
    expect(screen.getByText('Available')).toBeInTheDocument();
  });

  it('shows linked plots and sites inventory data', async () => {
    renderPage();
    expect(await screen.findByText('Plot A-9')).toBeInTheDocument();
    expect(screen.getByText('25 Lake Road')).toBeInTheDocument();
    expect(screen.getByText('Area: 1,200 sq ft')).toBeInTheDocument();
    expect(screen.getAllByText('1,200 sq ft')).toHaveLength(1);
    expect(screen.getByRole('columnheader', { name: 'Map' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View Plot A-9 on Google Maps' })).toHaveAttribute(
      'href',
      'https://www.google.com/maps/search/?api=1&query=25%20Lake%20Road',
    );
    expect(screen.getByRole('link', { name: 'Show Plot A-9 address on Google Maps' })).toHaveAttribute(
      'href',
      'https://www.google.com/maps/search/?api=1&query=25%20Lake%20Road',
    );
    expect(screen.getByTestId('pickup-plot-inventory-page')).toHaveStyle({
      display: 'flex', height: '100%', minHeight: '0', overflow: 'hidden',
    });
    expect(screen.getByTestId('plot-inventory-table')).toHaveStyle({
      flex: '1 1 0', minHeight: '0', width: '100%', maxWidth: '100%',
      overflowX: 'hidden', overflowY: 'auto',
    });
    expect(screen.getByRole('table')).toHaveStyle({ width: '100%', minWidth: '0', maxWidth: '100%' });
    const stickyHeader = screen.getByRole('columnheader', { name: 'Plot / Site' });
    expect(stickyHeader).toHaveStyle({
      position: 'sticky', top: '0px', zIndex: '1',
    });
    expect(stickyHeader.style.background).toContain('var(--popover-bg, #fff)');
    expect(screen.getByRole('table')).toHaveStyle({ display: 'table', overflow: 'visible', width: '100%', minWidth: '0', tableLayout: 'fixed' });
  });

  it('does not create an external map link when a plot has no stored address', async () => {
    fetchApiMock.mockResolvedValueOnce({
      ...inventory,
      plots: [{ ...inventory.plots[0], address: '' }],
    });
    renderPage();
    await screen.findByText('Plot A-9');

    expect(screen.getByLabelText('No map available')).toBeInTheDocument();
    expect(screen.getByLabelText('No address available')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Google Maps/i })).toBeNull();
  });

  it('filters plots by text, status, and availability', async () => {
    fetchApiMock.mockResolvedValueOnce({
      ...inventory,
      plots: [
        ...inventory.plots,
        { id: 10, name: 'Garden Plot', address: '99 Garden Road', area: '800 sq ft', price: '150000', availability: 'SOLD', isActive: false },
      ],
    });
    renderPage();
    expect(await screen.findByText('Plot A-9')).toBeInTheDocument();
    expect(screen.getByText('Garden Plot')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search plots and sites' }), { target: { value: 'Garden Road' } });
    expect(screen.queryByText('Plot A-9')).toBeNull();
    expect(screen.getByText('Garden Plot')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search plots and sites' }), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Filter by status' }));
    fireEvent.click(screen.getByRole('option', { name: 'Active' }));
    expect(screen.getByText('Plot A-9')).toBeInTheDocument();
    expect(screen.queryByText('Garden Plot')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Filter by status' }));
    fireEvent.click(screen.getByRole('option', { name: 'All statuses' }));
    fireEvent.click(screen.getByRole('button', { name: 'Filter by availability' }));
    fireEvent.click(screen.getByRole('option', { name: 'Sold' }));
    expect(screen.queryByText('Plot A-9')).toBeNull();
    expect(screen.getByText('Garden Plot')).toBeInTheDocument();
  });

  it('offers the complete area list and recalculates every area and per-unit price', async () => {
    fetchApiMock.mockResolvedValueOnce({
      ...inventory,
      plots: [
        inventory.plots[0],
        { id: 10, name: 'Garden Plot', address: '99 Garden Road', area: '900 sq ft', price: '150000', availability: 'SOLD', isActive: true },
      ],
    });
    renderPage();
    await screen.findByText('Plot A-9');

    const areaUnit = screen.getByRole('button', { name: 'Area unit' });
    fireEvent.click(areaUnit);
    const areaList = screen.getByRole('listbox', { name: 'Area unit' });
    expect(areaList).toHaveStyle({ maxHeight: '136px', overflowY: 'auto' });
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Sq. Ft. (ft²)', 'Sq. M. (m²)', 'Sq. Yd. (yd² / Gaj)', 'Acre', 'Hectare',
      'Cent', 'Guntha / Gunta', 'Ground', 'Ankanam', 'Kanal', 'Marla',
      'Bigha (regional)', 'Katha (regional)', 'Biswa (regional)', 'Decimal',
    ]);
    fireEvent.click(screen.getByRole('option', { name: 'Sq. Yd. (yd² / Gaj)' }));
    expect(screen.getAllByText('133 sq yd')).toHaveLength(1);
    expect(screen.getAllByText('100 sq yd')).toHaveLength(1);

    const priceUnit = screen.getByRole('button', { name: 'Price unit' });
    fireEvent.click(priceUnit);
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      '₹ (INR)', '₹ / Sq. Ft.', '₹ / Sq. Yd.', '₹ / Sq. M.', '₹ / Cent',
      '₹ / Guntha', '₹ / Acre', '₹ / Hectare', '₹ / Ground', '₹ / Ankanam',
    ]);
    fireEvent.click(screen.getByRole('option', { name: '₹ / Sq. Ft.' }));
    expect(screen.getByText('₹208.33 / sq ft')).toBeInTheDocument();
    expect(screen.getByText('₹166.67 / sq ft')).toBeInTheDocument();
  });

  it('uses Address instead of Reference Code and Pickup Location in the plot form', async () => {
    renderPage();
    await screen.findByText('Plot A-9');
    fireEvent.click(screen.getByRole('button', { name: /Add Plot \/ Site/i }));
    expect(screen.getByRole('dialog')).toHaveStyle({
      background: 'var(--modal-bg, #fff)',
      color: 'var(--text-primary)',
    });
    expect(screen.getByText('Address', { selector: 'label' }).parentElement).toHaveStyle({ gridColumn: '1 / -1' });
    expect(screen.queryByLabelText(/Reference code/i)).toBeNull();
    expect(screen.queryByLabelText(/Pickup location/i)).toBeNull();
    const labels = Array.from(
      screen.getByRole('dialog').querySelectorAll('label'),
      (label) => label.childNodes[0]?.textContent?.trim(),
    );
    expect(labels.slice(0, 5)).toEqual(['Name *', 'Availability', 'Area / size', 'Price', 'Address']);
    expect(screen.queryByText('Exact plot boundary')).toBeNull();
    expect(screen.queryByTestId('boundary-editor')).toBeNull();
  });

  it('suggests matching addresses and fills the selected result', async () => {
    geocodeSuggestMock.mockResolvedValueOnce([
      {
        lat: 12.9352,
        lng: 77.6245,
        display_name: 'CA-17, 6th Cross, Koramangala, Bengaluru, Karnataka, India',
      },
      {
        lat: 12.9279,
        lng: 77.6271,
        display_name: 'Koramangala 4th Block, Bengaluru, Karnataka, India',
      },
    ]);
    renderPage();
    await screen.findByText('Plot A-9');
    fireEvent.click(screen.getByRole('button', { name: /Add Plot \/ Site/i }));

    const addressInput = screen.getByRole('combobox', { name: 'Address' });
    expect(addressInput).toHaveAttribute('autocomplete', 'off');
    fireEvent.change(addressInput, { target: { value: 'Koramangala' } });

    expect(await screen.findByRole('listbox', { name: 'Address suggestions' })).toBeInTheDocument();
    expect(geocodeSuggestMock).toHaveBeenCalledWith('Koramangala', 6);
    expect(screen.getByRole('listbox', { name: 'Address suggestions' }).querySelectorAll('[role="option"]')).toHaveLength(2);

    fireEvent.keyDown(addressInput, { key: 'ArrowDown' });
    fireEvent.keyDown(addressInput, { key: 'Enter' });
    expect(addressInput).toHaveValue('Koramangala 4th Block, Bengaluru, Karnataka, India');
    expect(screen.queryByRole('listbox', { name: 'Address suggestions' })).toBeNull();
  });

  it('preserves stored GPS points and opens the highlighted boundary viewer', async () => {
    const surveyedPlot = {
      ...inventory.plots[0],
      boundaryAreaSqFt: 12875.4,
      boundary: [
        { latitude: 12.935, longitude: 77.61 },
        { latitude: 12.935, longitude: 77.6101 },
        { latitude: 12.9351, longitude: 77.6101 },
      ],
    };
    fetchApiMock.mockResolvedValueOnce({ ...inventory, plots: [surveyedPlot] });
    renderPage();
    await screen.findByText('Plot A-9');

    fireEvent.click(screen.getByRole('button', { name: 'View highlighted boundary for Plot A-9' }));
    expect(screen.getByRole('dialog', { name: 'Plot A-9 highlighted boundary' })).toBeInTheDocument();
    expect(screen.getByTestId('boundary-viewer')).toHaveTextContent('3 GPS points');
    fireEvent.click(screen.getByRole('button', { name: 'Close boundary map' }));

    fireEvent.click(screen.getByRole('button', { name: 'Edit Plot A-9' }));
    expect(screen.queryByTestId('boundary-editor')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith(
      '/api/pickup-plot-inventory/plots/9',
      expect.objectContaining({ method: 'PUT' }),
    ));
    const update = fetchApiMock.mock.calls.find(([url]) => url === '/api/pickup-plot-inventory/plots/9');
    expect(JSON.parse(update[1].body).boundary).toHaveLength(3);
  });

  it('activates or deactivates a plot through the status endpoint', async () => {
    renderPage();
    await screen.findByText('Plot A-9');
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate Plot A-9' }));
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith(
      '/api/pickup-plot-inventory/plots/9/status',
      { method: 'PATCH', body: JSON.stringify({ isActive: false }) },
    ));
  });
});
