import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import HotelOfferImageGenerator from '../pages/travel/HotelOfferImageGenerator';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyInfo = vi.fn();
const notifyConfirm = vi.fn(() => Promise.resolve(true));
const notifyObj = {
  error: notifyError,
  info: notifyInfo,
  success: notifySuccess,
  confirm: notifyConfirm,
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

function defaultFetchHandler(url, opts) {
  const method = opts?.method || 'GET';
  if (url === '/api/v1/flight-plugin/extract-hotel-prices' && method === 'POST') {
    return Promise.resolve({
      provider: 'stub',
      currency: 'INR',
      hotelLabel: 'Hotel quotation',
      city: 'Goa',
      stayLabel: '2 nights',
      checkIn: '2026-08-02',
      checkOut: '2026-08-04',
      rows: [
        {
          label: 'Grand Hotel',
          roomType: 'Deluxe Room',
          nights: 2,
          basePrice: 12000,
          priceBasis: 'total',
          currency: 'INR',
        },
      ],
      summary: {
        hotelLabel: 'Hotel quotation',
        city: 'Goa',
        stayLabel: '2 nights',
        checkIn: '2026-08-02',
        checkOut: '2026-08-04',
        basisLabel: 'Total price',
        sourceLabel: 'Offline hotel prices',
      },
    });
  }
  return Promise.resolve(null);
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyError.mockReset();
  notifySuccess.mockReset();
  notifyInfo.mockReset();
  notifyConfirm.mockReset();
  notifyConfirm.mockResolvedValue(true);
  fetchApiMock.mockImplementation(defaultFetchHandler);
});

describe('<HotelOfferImageGenerator />', () => {
  it('renders the hotel offer workflow and generates a final-price image', async () => {
    render(<HotelOfferImageGenerator />);

    expect(await screen.findByRole('heading', { name: /Hotel offer image generator/i })).toBeInTheDocument();

    const file = new File(['hotel'], 'hotel.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText(/Upload hotel screenshots/i), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));

    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith('/api/v1/flight-plugin/extract-hotel-prices', expect.objectContaining({ method: 'POST' }));
    });

    const hotelName = await screen.findByLabelText(/Hotel name 1/i);
    expect(hotelName).toHaveValue('Grand Hotel');
    expect(screen.getByLabelText(/Room type 1/i)).toHaveValue('Deluxe Room');

    fireEvent.change(screen.getByLabelText(/Base price 1/i), { target: { value: '13000' } });
    fireEvent.change(screen.getByLabelText(/Adjustment mode 1/i), { target: { value: 'discount' } });
    fireEvent.change(screen.getByLabelText(/Adjustment value 1/i), { target: { value: '1500' } });
    expect(screen.getByLabelText(/Final price 1/i).value).toMatch(/11,500/);

    fireEvent.click(screen.getByRole('button', { name: /Next/i }));
    fireEvent.click(screen.getByRole('button', { name: /Generate image/i }));

    await waitFor(() => {
      expect(screen.getByAltText(/Generated hotel offer preview/i)).toBeInTheDocument();
    });
  });
});




