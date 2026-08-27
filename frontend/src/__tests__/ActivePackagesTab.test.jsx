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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-08-27T12:00:00'));
  fetchApiMock.mockReset().mockResolvedValue({});
  notifyObj.error.mockReset();
  notifyObj.success.mockReset();
  notifyObj.confirm.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
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

  it('spells out the commercial terms — tax, validity and sell-by', () => {
    render(
      <ActivePackagesTab
        packages={[{ ...DRAFT, taxPercent: 18, validityDays: 180, sellByDate: '2099-12-31T00:00:00.000Z' }]}
        loading={false}
      />
    );

    expect(screen.getByText(/\+18% tax/)).toBeInTheDocument();
    expect(screen.getByText(/Valid 6 months after purchase/i)).toBeInTheDocument();
    // "Sell by <date>" — the bare "Sell by" label belongs to the date editor.
    expect(screen.getByText(/Sell by \d/)).toBeInTheDocument();
  });

  it('says a published package past its sell-by is hidden from customers', () => {
    // The confusing state: the card reads "Live" while the customer catalog
    // has already dropped it. Staff must not have to guess why.
    render(
      <ActivePackagesTab
        packages={[{ ...LIVE, sellByDate: '2020-01-01T00:00:00.000Z' }]}
        loading={false}
      />
    );

    expect(screen.getByText('Past sell-by')).toBeInTheDocument();
    expect(screen.getByText(/Hidden from customers/i)).toBeInTheDocument();
  });

  it('does not claim a DRAFT is hidden by its sell-by — it was never listed', () => {
    render(
      <ActivePackagesTab
        packages={[{ ...DRAFT, sellByDate: '2020-01-01T00:00:00.000Z' }]}
        loading={false}
      />
    );

    expect(screen.queryByText(/Hidden from customers/i)).not.toBeInTheDocument();
    expect(screen.getByText(/has passed/i)).toBeInTheDocument();
  });

  it('puts a lapsed package back on sale by changing its sell-by date', async () => {
    // Without this the date could only be set at build time, so a package that
    // ran past it was stuck off the catalog until someone rebuilt it.
    const user = userEvent.setup();
    const onChanged = vi.fn();
    render(
      <ActivePackagesTab
        packages={[{ ...LIVE, sellByDate: '2020-01-01T00:00:00.000Z' }]}
        loading={false}
        onChanged={onChanged}
      />
    );

    fireEvent.change(screen.getByTestId('package-sellby-2'), { target: { value: '2027-01-31' } });

    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledOnce());
    const [url, opts] = fetchApiMock.mock.calls[0];
    expect(url).toBe('/api/wellness/packages/2');
    expect(opts.method).toBe('PUT');
    // Sell-by only — no bundle/sessions/discount, so the package cannot be
    // re-priced at today's service prices on the way through.
    expect(JSON.parse(opts.body)).toEqual({ sellByDate: '2027-01-31' });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(user).toBeTruthy();
  });

  it('blocks moving sell-by to a past date', async () => {
    render(
      <ActivePackagesTab
        packages={[{ ...LIVE, sellByDate: '2027-01-31T00:00:00.000Z' }]}
        loading={false}
        onChanged={vi.fn()}
      />
    );

    fireEvent.change(screen.getByTestId('package-sellby-2'), { target: { value: '2026-08-26' } });

    await waitFor(() => expect(notifyObj.error).toHaveBeenCalledWith('Sell-by date cannot be in the past'));
    expect(fetchApiMock).not.toHaveBeenCalled();
  });

  it('does not offer past dates in the sell-by editor', () => {
    render(<ActivePackagesTab packages={[LIVE]} loading={false} onChanged={vi.fn()} />);

    expect(screen.getByTestId('package-sellby-2')).toHaveAttribute('min', '2026-08-27');
  });

  it('clearing the date sends an explicit null, not an empty string', async () => {
    render(
      <ActivePackagesTab
        packages={[{ ...LIVE, sellByDate: '2027-01-31T00:00:00.000Z' }]}
        loading={false}
        onChanged={vi.fn()}
      />
    );

    fireEvent.change(screen.getByTestId('package-sellby-2'), { target: { value: '' } });

    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledOnce());
    expect(JSON.parse(fetchApiMock.mock.calls[0][1].body)).toEqual({ sellByDate: null });
  });

  it('gives customers a buy button and no staff controls', () => {
    render(<ActivePackagesTab packages={[LIVE]} loading={false} readOnly onBuy={vi.fn()} />);

    expect(screen.getByTestId('package-buy-2')).toBeInTheDocument();
    expect(screen.queryByTestId('package-publish-2')).not.toBeInTheDocument();
    expect(screen.queryByTestId('package-retire-2')).not.toBeInTheDocument();
  });

  it('hands the whole package to the checkout, never a price', async () => {
    // The amount is the server's business — anything sent from here could be
    // tampered with before it reaches the gateway.
    const user = userEvent.setup();
    const onBuy = vi.fn();
    render(<ActivePackagesTab packages={[LIVE]} loading={false} readOnly onBuy={onBuy} />);

    await user.click(screen.getByTestId('package-buy-2'));

    expect(onBuy).toHaveBeenCalledWith(expect.objectContaining({ id: 2, name: 'Published Bundle' }));
  });

  it('shows no buy button to staff, who are managing rather than buying', () => {
    render(<ActivePackagesTab packages={[LIVE]} loading={false} onBuy={vi.fn()} onChanged={vi.fn()} />);

    expect(screen.queryByTestId('package-buy-2')).not.toBeInTheDocument();
    expect(screen.getByTestId('package-publish-2')).toBeInTheDocument();
  });

  it('locks every buy button while one checkout is opening', () => {
    render(
      <ActivePackagesTab
        packages={[LIVE, { ...LIVE, id: 5, name: 'Second Bundle' }]}
        loading={false}
        readOnly
        onBuy={vi.fn()}
        buyingId={2}
      />
    );

    expect(screen.getByTestId('package-buy-2')).toBeDisabled();
    expect(screen.getByTestId('package-buy-5')).toBeDisabled();
    expect(screen.getByText(/Opening checkout/i)).toBeInTheDocument();
  });

  it('does not offer a retired package for sale', () => {
    render(<ActivePackagesTab packages={[RETIRED]} loading={false} readOnly onBuy={vi.fn()} />);

    expect(screen.queryByTestId('package-buy-3')).not.toBeInTheDocument();
  });

  it('tells a buyer the package is theirs, with what is left and until when', () => {
    // Before this the card looked identical before and after paying — the one
    // thing a buyer wants to know is how long they have to use it.
    render(
      <ActivePackagesTab
        packages={[{
          ...LIVE,
          ownedPlan: {
            id: 77,
            status: 'active',
            totalSessions: 4,
            completedSessions: 1,
            startedAt: '2026-08-26T13:00:00.000Z',
            nextDueAt: '2099-09-02T13:00:00.000Z',
          },
        }]}
        loading={false}
        readOnly
        onBuy={vi.fn()}
      />
    );

    expect(screen.getByTestId('package-owned-2')).toBeInTheDocument();
    expect(screen.getByText(/You bought this/i)).toBeInTheDocument();
    expect(screen.getByText(/3 of 4 sessions left/i)).toBeInTheDocument();
    expect(screen.getByText(/Book your sessions by/i)).toBeInTheDocument();
    expect(screen.getByTestId('package-valid-till-2')).toHaveTextContent(/Package valid till/i);
    // Sessions still in hand, so the package is not for sale to them again —
    // that only returns once the plan is spent or its window closes.
    expect(screen.queryByTestId('package-buy-2')).not.toBeInTheDocument();
  });

  it('warns when the window to use a bought package has run out', () => {
    render(
      <ActivePackagesTab
        packages={[{
          ...LIVE,
          ownedPlan: {
            id: 78,
            status: 'active',
            totalSessions: 4,
            completedSessions: 0,
            startedAt: '2020-01-01T00:00:00.000Z',
            nextDueAt: '2020-02-01T00:00:00.000Z',
          },
        }]}
        loading={false}
        readOnly
        onBuy={vi.fn()}
      />
    );

    expect(screen.getByText(/Ran out on/i)).toBeInTheDocument();
    expect(screen.queryByText(/Book your sessions by/i)).not.toBeInTheDocument();
  });

  it('says a package with no expiry can be booked whenever', () => {
    render(
      <ActivePackagesTab
        packages={[{
          ...LIVE,
          ownedPlan: { id: 79, status: 'active', totalSessions: 4, completedSessions: 0, startedAt: '2026-08-26T13:00:00.000Z', nextDueAt: null },
        }]}
        loading={false}
        readOnly
        onBuy={vi.fn()}
      />
    );

    expect(screen.getByText(/No expiry — book whenever suits you/i)).toBeInTheDocument();
  });

  it('does not offer to sell a package the viewer already holds unused', () => {
    // The server refuses this purchase (PACKAGE_ALREADY_HELD); a button that
    // cannot work is worse than no button.
    render(
      <ActivePackagesTab
        packages={[{
          ...LIVE,
          ownedPlan: { id: 77, status: 'active', totalSessions: 4, completedSessions: 0, startedAt: '2026-08-27T00:00:00.000Z', nextDueAt: '2099-08-27T00:00:00.000Z' },
        }]}
        loading={false}
        readOnly
        onBuy={vi.fn()}
        onRequestSession={vi.fn()}
      />
    );

    expect(screen.getByTestId('package-owned-2')).toBeInTheDocument();
    expect(screen.getByTestId('package-request-session-2')).toBeInTheDocument();
    expect(screen.queryByTestId('package-buy-2')).not.toBeInTheDocument();
  });

  it('offers it again once every session has been used', async () => {
    render(
      <ActivePackagesTab
        packages={[{
          ...LIVE,
          ownedPlan: { id: 78, status: 'active', totalSessions: 4, completedSessions: 4, startedAt: '2026-08-27T00:00:00.000Z', nextDueAt: '2099-08-27T00:00:00.000Z' },
        }]}
        loading={false}
        readOnly
        onBuy={vi.fn()}
      />
    );

    expect(screen.getByTestId('package-buy-2')).toHaveTextContent(/Buy again/i);
    // Nothing left to book, so no request button either.
    expect(screen.queryByTestId('package-request-session-2')).not.toBeInTheDocument();
  });

  it('offers it again once the window to use it has closed', () => {
    render(
      <ActivePackagesTab
        packages={[{
          ...LIVE,
          ownedPlan: { id: 79, status: 'active', totalSessions: 4, completedSessions: 1, startedAt: '2020-01-01T00:00:00.000Z', nextDueAt: '2020-02-01T00:00:00.000Z' },
        }]}
        loading={false}
        readOnly
        onBuy={vi.fn()}
      />
    );

    expect(screen.getByText(/Ran out on/i)).toBeInTheDocument();
    expect(screen.getByTestId('package-buy-2')).toBeInTheDocument();
  });

  it('shows no ownership panel on a package the viewer has not bought', () => {
    render(<ActivePackagesTab packages={[LIVE]} loading={false} readOnly onBuy={vi.fn()} />);

    expect(screen.queryByTestId('package-owned-2')).not.toBeInTheDocument();
    expect(screen.getByTestId('package-buy-2')).toHaveTextContent(/Buy package/i);
  });

  it('keeps the ownership panel out of the staff view', () => {
    // Staff are looking at the catalog they sell, not at their own purchases.
    render(
      <ActivePackagesTab
        packages={[{ ...LIVE, ownedPlan: { id: 80, status: 'active', totalSessions: 4, completedSessions: 0, startedAt: null, nextDueAt: null } }]}
        loading={false}
        onChanged={vi.fn()}
      />
    );

    expect(screen.queryByTestId('package-owned-2')).not.toBeInTheDocument();
  });

  it('saves a new session count on blur, not on every keystroke', async () => {
    // A PUT per keystroke would re-price the package on the way to a number
    // the user has not finished typing.
    const user = userEvent.setup();
    render(<ActivePackagesTab packages={[DRAFT]} loading={false} onChanged={vi.fn()} />);

    const field = screen.getByTestId('package-sessions-1');
    await user.clear(field);
    await user.type(field, '10');
    expect(fetchApiMock).not.toHaveBeenCalled();

    await user.tab();

    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledOnce());
    const [url, opts] = fetchApiMock.mock.calls[0];
    expect(url).toBe('/api/wellness/packages/1');
    expect(JSON.parse(opts.body)).toEqual({ sessions: 10 });
  });

  it('saves a new discount the same way', async () => {
    const user = userEvent.setup();
    render(<ActivePackagesTab packages={[DRAFT]} loading={false} onChanged={vi.fn()} />);

    const field = screen.getByTestId('package-discount-1');
    await user.clear(field);
    await user.type(field, '25');
    await user.tab();

    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledOnce());
    expect(JSON.parse(fetchApiMock.mock.calls[0][1].body)).toEqual({ discountPercent: 25 });
  });

  it('refuses an out-of-range value and puts the old one back', async () => {
    // The server caps sessions at 60; a field that lets you commit 99 just
    // trades a clear message for a failed request.
    const user = userEvent.setup();
    render(<ActivePackagesTab packages={[DRAFT]} loading={false} onChanged={vi.fn()} />);

    const field = screen.getByTestId('package-sessions-1');
    await user.clear(field);
    await user.type(field, '99');
    await user.tab();

    await waitFor(() => expect(notifyObj.error).toHaveBeenCalledWith(expect.stringMatching(/between 1 and 60/i)));
    expect(fetchApiMock).not.toHaveBeenCalled();
    expect(field).toHaveValue(6); // DRAFT.sessions restored
  });

  it('saves nothing when the number is left as it was', async () => {
    const user = userEvent.setup();
    render(<ActivePackagesTab packages={[DRAFT]} loading={false} onChanged={vi.fn()} />);

    await user.click(screen.getByTestId('package-discount-1'));
    await user.tab();

    expect(fetchApiMock).not.toHaveBeenCalled();
  });

  it('changes the tax slab as soon as it is picked', async () => {
    const user = userEvent.setup();
    render(<ActivePackagesTab packages={[DRAFT]} loading={false} onChanged={vi.fn()} />);

    await user.click(within(screen.getByTestId('package-tax-1')).getByRole('button'));
    await user.click(await screen.findByRole('option', { name: 'GST 18%' }));

    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledOnce());
    // Tax alone: no bundle field rides along, so the package cannot be
    // re-priced on the way through.
    expect(JSON.parse(fetchApiMock.mock.calls[0][1].body)).toEqual({ taxPercent: 18 });
  });

  it('warns that a session or discount edit re-prices the package', async () => {
    render(<ActivePackagesTab packages={[DRAFT]} loading={false} onChanged={vi.fn()} />);

    expect(screen.getByText(/re-prices this package at today/i)).toBeInTheDocument();
    expect(screen.getByText(/already bought keep the price they were sold at/i)).toBeInTheDocument();
  });

  it('gives customers no terms editor at all', () => {
    render(<ActivePackagesTab packages={[LIVE]} loading={false} readOnly onBuy={vi.fn()} />);

    expect(screen.queryByTestId('package-terms-2')).not.toBeInTheDocument();
    expect(screen.queryByTestId('package-sessions-2')).not.toBeInTheDocument();
    expect(screen.queryByTestId('package-tax-2')).not.toBeInTheDocument();
  });

  it('offers no sell-by editor to customers', () => {
    render(<ActivePackagesTab packages={[{ ...LIVE, sellByDate: '2027-01-31T00:00:00.000Z' }]} loading={false} readOnly />);

    expect(screen.queryByTestId('package-sellby-2')).not.toBeInTheDocument();
  });

  it('says nothing about terms a package does not carry', () => {
    render(<ActivePackagesTab packages={[DRAFT]} loading={false} />);

    // The "+N% tax" chip, not the word — the terms editor below always has a
    // Tax field, which is the control for setting one rather than a claim
    // that this package carries one.
    expect(screen.queryByText(/\+\d+% tax/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Valid /i)).not.toBeInTheDocument();
    // No "Sell by <date>" line. The editor's own "Sell by" label still shows —
    // that is the control for setting one, not a claim that one exists.
    expect(screen.queryByText(/Sell by \d/)).not.toBeInTheDocument();
    expect(screen.getByTestId('package-sellby-1')).toHaveValue('');
    expect(screen.queryByText('Past sell-by')).not.toBeInTheDocument();
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

  it('flips the badge on click, before the request comes back', async () => {
    // Publishing is a PUT plus the parent's refetch. Waiting for both to
    // repaint the badge reads as a dead click.
    const user = userEvent.setup();
    let resolvePut;
    fetchApiMock.mockImplementationOnce(() => new Promise((res) => { resolvePut = res; }));
    render(<ActivePackagesTab packages={[DRAFT]} loading={false} onChanged={vi.fn()} />);

    expect(screen.getByText('Draft')).toBeInTheDocument();
    await user.click(screen.getByTestId('package-publish-1'));

    // Still in flight — the card already reads Live.
    await waitFor(() => expect(screen.getByText('Live')).toBeInTheDocument());
    expect(screen.queryByText('Draft')).not.toBeInTheDocument();
    expect(screen.getByTestId('package-publish-1')).toHaveTextContent(/Unpublish/i);

    resolvePut({});
  });

  it('puts the badge back when the request fails', async () => {
    // The card must not keep showing something that did not happen.
    const user = userEvent.setup();
    fetchApiMock.mockRejectedValueOnce(new Error('Network down'));
    render(<ActivePackagesTab packages={[DRAFT]} loading={false} onChanged={vi.fn()} />);

    await user.click(screen.getByTestId('package-publish-1'));

    await waitFor(() => expect(notifyObj.error).toHaveBeenCalled());
    expect(screen.getByText('Draft')).toBeInTheDocument();
    expect(screen.queryByText('Live')).not.toBeInTheDocument();
  });

  it('holds the optimistic badge until the reloaded list carries it', async () => {
    // Clearing on the PUT resolving instead would flash the old badge for the
    // frame between that and the parent's refetch landing.
    const user = userEvent.setup();
    const { rerender } = render(
      <ActivePackagesTab packages={[DRAFT]} loading={false} onChanged={vi.fn()} />
    );

    await user.click(screen.getByTestId('package-publish-1'));
    await waitFor(() => expect(screen.getByText('Live')).toBeInTheDocument());

    // Parent re-renders with the pre-toggle data still in hand.
    rerender(<ActivePackagesTab packages={[DRAFT]} loading={false} onChanged={vi.fn()} />);
    expect(screen.getByText('Live')).toBeInTheDocument();

    // …and now the refetch lands.
    rerender(<ActivePackagesTab packages={[{ ...DRAFT, isPublic: true }]} loading={false} onChanged={vi.fn()} />);
    expect(screen.getByText('Live')).toBeInTheDocument();
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
    notifyObj.confirm.mockResolvedValueOnce(true);
    render(<ActivePackagesTab packages={[DRAFT]} loading={false} onChanged={vi.fn()} />);

    await user.click(screen.getByTestId('package-retire-1'));

    // The app's own dialog, not the browser's — a native confirm is chrome
    // outside the app and blocks the QA tooling that drives these flows.
    expect(notifyObj.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ destructive: true, confirmText: expect.stringMatching(/retire/i) }),
    );
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledOnce());
    const [url, opts] = fetchApiMock.mock.calls[0];
    expect(url).toBe('/api/wellness/packages/1');
    expect(opts.method).toBe('DELETE');
    // No ?hard=true — a quoted package must keep resolving.
    expect(url).not.toContain('hard');
  });

  it('leaves the package alone when the retire dialog is dismissed', async () => {
    const user = userEvent.setup();
    notifyObj.confirm.mockResolvedValueOnce(false);
    render(<ActivePackagesTab packages={[DRAFT]} loading={false} onChanged={vi.fn()} />);

    await user.click(screen.getByTestId('package-retire-1'));

    await waitFor(() => expect(notifyObj.confirm).toHaveBeenCalled());
    expect(fetchApiMock).not.toHaveBeenCalled();
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
