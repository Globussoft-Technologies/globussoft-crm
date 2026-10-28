import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import GenericPickupPlotSelection from '../pages/public/GenericPickupPlotSelection';
const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({ fetchApi: (...args) => fetchApiMock(...args) }));
function renderPage() { return render(<MemoryRouter initialEntries={['/pickup-plot-selection/test-token']}><Routes><Route path="/pickup-plot-selection/:token" element={<GenericPickupPlotSelection />} /></Routes></MemoryRouter>); }
beforeEach(() => fetchApiMock.mockReset());
test('loads and submits a pickup and plot selection', async () => {
  fetchApiMock.mockResolvedValueOnce({ contact: { name: 'Kanchan' }, pickupLocations: [{ id: 12, name: 'Central Station' }], plots: [{ id: 30, name: 'Green Acres', plotNumber: 'A-1' }] }).mockResolvedValueOnce({ saved: true });
  renderPage(); fireEvent.change(await screen.findByLabelText('Pickup location'), { target: { value: '12' } }); fireEvent.change(screen.getByLabelText('Interested plot'), { target: { value: '30' } }); fireEvent.click(screen.getByRole('button', { name: 'Confirm selection' }));
  await waitFor(() => expect(fetchApiMock).toHaveBeenLastCalledWith('/api/pickup-plot-inventory/public/selection/test-token', { method: 'POST', body: JSON.stringify({ pickupLocationId: 12, plotSiteId: 30 }), silent: true }));
  expect(await screen.findByText('Selection received')).toBeInTheDocument();
});
test('renders an already-completed link without the form', async () => { fetchApiMock.mockResolvedValueOnce({ completed: true, contact: { name: 'Kanchan' } }); renderPage(); expect(await screen.findByText('Selection received')).toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'Confirm selection' })).toBeNull(); });
