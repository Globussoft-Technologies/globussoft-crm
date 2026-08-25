/**
 * ActivePackagesTab.test.jsx — saved service packages.
 *
 * Two properties matter here and neither is cosmetic:
 *
 *   1. A saved package starts as a DRAFT and is published deliberately, so
 *      nothing reaches the customer catalog by accident.
 *   2. Retire is not delete. A package already quoted to a customer has to
 *      keep resolving, so the destructive-looking action soft-retires.
 *
 * The same component backs the customer-facing Packages tab via `readOnly`,
 * which is why the absence of every mutating control is asserted too.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

const notifyObj = { error: vi.fn(), success: vi.fn(), info: vi.fn(), confirm: vi.fn() };
vi.mock('../utils/notify', () => ({ useNotify: () => notifyObj }));

import ActivePackagesTab from '../pages/wellness/services/ActivePackagesTab';

const DRAFT = {
  id: 1,
  name: 'Glow Bundle',
  description: 'Six sessions of glow',
  serviceIds: [10, 11],
  services: [
    { id: 10, name: 'Alpha Peel', basePrice: 1000 },
    { id: 11, name: 'Beta Laser', basePrice: 2000 },
  ],
  missingServiceIds: [],
  sessions: 6,
  discountPercent: 15,
  grossPrice: 18000,
  price: 15300,
  isActive: true,
  isPublic: false,
};

const LIVE = { ...DRAFT, id: 2, name: 'Published Bundle', isPublic: true };
const RETIRED = { ...DRAFT, id: 3, name: 'Old Bundle', isActive: false, isPublic: false };

beforeEach(() => {
  fetchApiMock.mockReset().mockResolvedValue({});
  notifyObj.error.mockReset();
  notifyObj.success.mockReset();
});

describe('<ActivePackagesTab />', () => {
  it('renders the bundled services, session count and discounted price', () => {
    render(<ActivePackagesTab packages={[DRAFT]} loading={false} />);

    expect(screen.getByText('Glow Bundle')).toBeInTheDocument();
    expect(screen.getByText('Alpha Peel')).toBeInTheDocument();
    expect(screen.getByText('Beta Laser')).toBeInTheDocument();
    expect(screen.getByText(/6 sessions/)).toBeInTheDocument();
    expect(screen.getByText(/15% off/)).toBeInTheDocument();
    expect(screen.getByText(/15,300/)).toBeInTheDocument();
    // Gross shown struck through so the saving is visible.
    expect(screen.getByText(/18,000/)).toBeInTheDocument();
  });

  it('distinguishes draft, live and retired at a glance', () => {
    render(<ActivePackagesTab packages={[DRAFT, LIVE, RETIRED]} loading={false} />);

    expect(screen.getByText('Draft')).toBeInTheDocument();
    expect(screen.getByText('Live')).toBeInTheDocument();
    expect(screen.getByText('Retired')).toBeInTheDocument();
  });

  it('publishes a draft without touching its price', async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    render(<ActivePackagesTab packages={[DRAFT]} loading={false} onChanged={onChanged} />);

    await user.click(screen.getByTestId('package-publish-1'));

    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledOnce());
    const [url, opts] = fetchApiMock.mock.calls[0];
    expect(url).toBe('/api/wellness/packages/1');
    expect(opts.method).toBe('PUT');
    // Visibility-only patch: no bundle/sessions/discount, so the backend
    // cannot re-price the package at today's service prices.
    expect(JSON.parse(opts.body)).toEqual({ isPublic: true });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('unpublishes a live package', async () => {
    const user = userEvent.setup();
    render(<ActivePackagesTab packages={[LIVE]} loading={false} onChanged={vi.fn()} />);

    await user.click(screen.getByTestId('package-publish-2'));

    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledOnce());
    expect(JSON.parse(fetchApiMock.mock.calls[0][1].body)).toEqual({ isPublic: false });
  });

  it('retires rather than deletes, and asks first', async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<ActivePackagesTab packages={[DRAFT]} loading={false} onChanged={vi.fn()} />);

    await user.click(screen.getByTestId('package-retire-1'));

    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledOnce());
    const [url, opts] = fetchApiMock.mock.calls[0];
    expect(url).toBe('/api/wellness/packages/1');
    expect(opts.method).toBe('DELETE');
    // No ?hard=true — a quoted package must keep resolving.
    expect(url).not.toContain('hard');
    confirmSpy.mockRestore();
  });

  it('cancelling the retire confirm changes nothing', async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<ActivePackagesTab packages={[DRAFT]} loading={false} onChanged={vi.fn()} />);

    await user.click(screen.getByTestId('package-retire-1'));

    expect(fetchApiMock).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('offers Restore on a retired package, and no publish control', () => {
    render(<ActivePackagesTab packages={[RETIRED]} loading={false} onChanged={vi.fn()} />);

    expect(screen.getByTestId('package-restore-3')).toBeInTheDocument();
    // Publishing a retired package would put it back in front of customers
    // without reactivating it — the control is not offered.
    expect(screen.queryByTestId('package-publish-3')).not.toBeInTheDocument();
  });

  it('warns when a bundled service has left the catalog', () => {
    render(
      <ActivePackagesTab
        packages={[{ ...DRAFT, missingServiceIds: [11], services: [DRAFT.services[0]] }]}
        loading={false}
      />,
    );
    expect(screen.getByText(/no longer in the catalog/i)).toBeInTheDocument();
  });

  it('surfaces a failed update instead of silently doing nothing', async () => {
    const user = userEvent.setup();
    fetchApiMock.mockRejectedValueOnce(new Error('Package not found'));
    render(<ActivePackagesTab packages={[DRAFT]} loading={false} onChanged={vi.fn()} />);

    await user.click(screen.getByTestId('package-publish-1'));

    await waitFor(() => expect(notifyObj.error).toHaveBeenCalledWith('Package not found'));
  });

  it('readOnly hides every mutating control — this is the customer view', () => {
    render(<ActivePackagesTab packages={[LIVE]} loading={false} readOnly />);

    expect(screen.getByText('Published Bundle')).toBeInTheDocument();
    expect(screen.queryByTestId('package-publish-2')).not.toBeInTheDocument();
    expect(screen.queryByTestId('package-retire-2')).not.toBeInTheDocument();
    expect(screen.queryByTestId('package-restore-2')).not.toBeInTheDocument();
  });

  it('empty state wording differs for staff and customers', () => {
    const { unmount } = render(<ActivePackagesTab packages={[]} loading={false} />);
    expect(screen.getByText(/No packages saved yet/i)).toBeInTheDocument();
    unmount();

    render(<ActivePackagesTab packages={[]} loading={false} readOnly />);
    expect(screen.getByText(/No packages available yet/i)).toBeInTheDocument();
  });

  it('shows a loading state', () => {
    render(<ActivePackagesTab packages={[]} loading />);
    expect(screen.getByText(/Loading packages/i)).toBeInTheDocument();
  });
});
