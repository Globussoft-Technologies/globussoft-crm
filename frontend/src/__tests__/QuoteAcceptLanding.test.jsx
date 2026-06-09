/**
 * QuoteAcceptLanding.jsx — public customer-facing quote landing
 * (PRD_TRAVEL_QUOTE_BUILDER §3.7 / slice C9).
 *
 * Lives at /p/quote/:shareToken. Fetches the customer envelope, renders
 * read-only line items + total, surfaces three actions (Accept / Reject /
 * Counter-offer) with confirmation modals. Maps backend error status:
 *   - 404 → "expired or no longer available"
 *   - 410 → "Share link expired"
 *   - 409 → "This quote was already actioned"
 *
 * Contract pins:
 *   1. Initial render → loading state
 *   2. Quote loads → renders id + customer name + lines + total
 *   3. 404 → friendly expired/unavailable message
 *   4. 410 → "Share link expired"
 *   5. Accept happy path → confirmation form → POST → thank-you
 *   6. Reject requires reason (validation)
 *   7. Counter requires proposedTotal > 0 (validation)
 *   8. 409 from accept → "already actioned" surfaced
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import QuoteAcceptLanding from '../pages/public/QuoteAcceptLanding';

function makeEnvelope(over = {}) {
  return {
    quote: {
      id: 42,
      subBrand: 'tmc',
      status: 'Sent',
      totalAmount: '50000.00',
      currency: 'INR',
      validUntil: '2026-07-09T00:00:00.000Z',
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-08T00:00:00.000Z',
    },
    lines: [
      {
        id: 1,
        lineType: 'hotel',
        description: 'Hotel — 3 nights',
        quantity: 3,
        unitPrice: '10000.00',
        amount: '30000.00',
        currency: 'INR',
        sortOrder: 0,
      },
      {
        id: 2,
        lineType: 'transport',
        description: 'Coach transfer',
        quantity: 1,
        unitPrice: '20000.00',
        amount: '20000.00',
        currency: 'INR',
        sortOrder: 1,
      },
    ],
    customer: { name: 'Aisha Khan' },
    ...over,
  };
}

let fetchSpy;
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch');
  // Default — happy load.
  fetchSpy.mockImplementation(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(makeEnvelope()),
    }),
  );
});
afterEach(() => {
  fetchSpy.mockRestore();
});

function renderPage(token = 'eyJtok.en.sig') {
  return render(
    <MemoryRouter initialEntries={[`/p/quote/${token}`]}>
      <Routes>
        <Route path="/p/quote/:shareToken" element={<QuoteAcceptLanding />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('QuoteAcceptLanding — public customer landing (C9)', () => {
  it('1. initial render shows loading state before fetch resolves', () => {
    fetchSpy.mockImplementation(() => new Promise(() => {}));
    renderPage();
    expect(screen.getByText(/Loading your quote/i)).toBeInTheDocument();
  });

  it('2. quote envelope loads → renders id + customer + lines + total', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/Your quote/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/Quote #42/i)).toBeInTheDocument();
    expect(screen.getByText(/Aisha Khan/i)).toBeInTheDocument();
    expect(screen.getByText(/Hotel — 3 nights/i)).toBeInTheDocument();
    expect(screen.getByText(/Coach transfer/i)).toBeInTheDocument();
    // Total displayed (some Intl runtimes render with NBSP). Use a regex
    // that tolerates either a plain space or non-breaking space between
    // currency symbol and digits.
    const totalNode = await screen.findByText((content) =>
      /50,000/.test(content) || /50000/.test(content),
    );
    expect(totalNode).toBeInTheDocument();
  });

  it('3. 404 → friendly "expired or no longer available" message', async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ error: 'gone', code: 'QUOTE_EXPIRED' }),
      }),
    );
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/expired or is no longer available/i)).toBeInTheDocument(),
    );
  });

  it('4. 410 → "Share link expired" message', async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve({
        ok: false,
        status: 410,
        json: () => Promise.resolve({ error: 'gone', code: 'LINK_EXPIRED' }),
      }),
    );
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/Share link expired/i)).toBeInTheDocument(),
    );
  });

  it('5. accept happy path → confirmation form → POST → thank-you', async () => {
    renderPage();
    await waitFor(() => screen.getByText(/Your quote/i));

    fireEvent.click(screen.getByRole('button', { name: /Accept this quote/i }));
    await waitFor(() =>
      expect(screen.getByText(/Confirm acceptance/i)).toBeInTheDocument(),
    );

    // Switch fetch mock for the POST.
    fetchSpy.mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          status: 'accepted',
          quoteId: 42,
          previousStatus: 'Sent',
          acceptedAt: '2026-06-09T10:00:00Z',
        }),
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: /Confirm accept/i }));

    await waitFor(() =>
      expect(screen.getByText(/Thank you/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/Quote accepted/i)).toBeInTheDocument();
  });

  it('6. reject requires reason — empty submit surfaces validation', async () => {
    renderPage();
    await waitFor(() => screen.getByText(/Your quote/i));

    fireEvent.click(screen.getByRole('button', { name: /Decline/i }));
    await waitFor(() =>
      expect(screen.getByText(/Decline this quote/i)).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole('button', { name: /Submit decline/i }));
    await waitFor(() =>
      expect(screen.getByText(/share a brief reason/i)).toBeInTheDocument(),
    );
    // fetch should NOT have been re-called (only initial load).
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('7. counter requires proposed total > 0', async () => {
    renderPage();
    await waitFor(() => screen.getByText(/Your quote/i));

    fireEvent.click(screen.getByRole('button', { name: /Counter-offer/i }));
    await waitFor(() =>
      expect(screen.getByText(/Submit a counter-offer/i)).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole('button', { name: /^Submit counter-offer$/i }));
    await waitFor(() =>
      expect(screen.getByText(/Please enter your counter-offer amount/i)).toBeInTheDocument(),
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('8. 409 ALREADY_ACTIONED on accept → friendly message', async () => {
    renderPage();
    await waitFor(() => screen.getByText(/Your quote/i));

    fireEvent.click(screen.getByRole('button', { name: /Accept this quote/i }));
    await waitFor(() =>
      expect(screen.getByText(/Confirm acceptance/i)).toBeInTheDocument(),
    );

    fetchSpy.mockImplementationOnce(() =>
      Promise.resolve({
        ok: false,
        status: 409,
        json: () => Promise.resolve({ error: 'already', code: 'ALREADY_ACTIONED', status: 'Accepted' }),
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: /Confirm accept/i }));
    await waitFor(() =>
      expect(screen.getByText(/already actioned/i)).toBeInTheDocument(),
    );
  });

  it('counter happy-path POSTs proposedTotal numeric', async () => {
    renderPage();
    await waitFor(() => screen.getByText(/Your quote/i));

    fireEvent.click(screen.getByRole('button', { name: /Counter-offer/i }));
    await waitFor(() => screen.getByText(/Submit a counter-offer/i));

    const totalInput = screen.getByLabelText(/Your proposed total/i);
    fireEvent.change(totalInput, { target: { value: '45000' } });

    fetchSpy.mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          status: 'countered',
          quoteId: 42,
          previousStatus: 'Sent',
          proposedTotal: 45000,
          counteredAt: '2026-06-09T10:00:00Z',
        }),
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: /^Submit counter-offer$/i }));

    await waitFor(() =>
      expect(screen.getByText(/Thank you/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/Counter-offer submitted/i)).toBeInTheDocument();

    // Inspect the POST call.
    const postCall = fetchSpy.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('/counter'),
    );
    expect(postCall).toBeTruthy();
    const body = JSON.parse(postCall[1].body);
    expect(body.proposedTotal).toBe(45000);
  });
});
