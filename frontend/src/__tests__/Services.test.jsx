import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../utils/api', () => ({
  fetchApi: vi.fn(),
}));

import { fetchApi } from '../utils/api';
import Services from '../pages/wellness/Services';

const services = [
  { id: 10, name: 'GFC Hair', category: 'hair-restoration', ticketTier: 'high', basePrice: 8500, durationMin: 90, targetRadiusKm: 25, isActive: true },
  { id: 11, name: 'Botox 50u', category: 'aesthetics', ticketTier: 'medium', basePrice: 15000, durationMin: 45, targetRadiusKm: 30, isActive: true },
];

describe('<Services /> — Catalog tab', () => {
  beforeEach(() => {
    fetchApi.mockReset();
    fetchApi.mockResolvedValue(services);
  });

  it('renders catalog cards with price, duration, and radius', async () => {
    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('GFC Hair')).toBeInTheDocument());

    expect(screen.getByText('Botox 50u')).toBeInTheDocument();
    // Indian-grouped prices
    expect(screen.getByText(/8,500/)).toBeInTheDocument();
    expect(screen.getByText(/15,000/)).toBeInTheDocument();
    // Durations
    expect(screen.getByText(/90 min/)).toBeInTheDocument();
    expect(screen.getByText(/45 min/)).toBeInTheDocument();
    // Radius
    expect(screen.getByText(/25 km/)).toBeInTheDocument();
    expect(screen.getByText(/30 km/)).toBeInTheDocument();
  });

  it('clicking the pencil (Edit) button flips the card to edit mode', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('GFC Hair')).toBeInTheDocument());

    const editBtns = screen.getAllByTitle(/^Edit$/i);
    expect(editBtns.length).toBe(2);
    await user.click(editBtns[0]);

    // Edit mode shows a Save button + the name as an input value
    expect(screen.getByRole('button', { name: /^Save$/i })).toBeInTheDocument();
    expect(screen.getByDisplayValue('GFC Hair')).toBeInTheDocument();
  });

  it('Save in edit mode calls PUT to /api/wellness/services/:id', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('GFC Hair')).toBeInTheDocument());

    await user.click(screen.getAllByTitle(/^Edit$/i)[0]);
    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      const putCall = fetchApi.mock.calls.find(
        ([url, opts]) => url === '/api/wellness/services/10' && opts?.method === 'PUT'
      );
      expect(putCall).toBeTruthy();
    });
  });

  it('clicking the trash icon triggers confirm()', async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<MemoryRouter><Services /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('GFC Hair')).toBeInTheDocument());

    const deactivateBtns = screen.getAllByTitle(/Deactivate/i);
    await user.click(deactivateBtns[0]);

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy.mock.calls[0][0]).toMatch(/GFC Hair/);
  });
});
