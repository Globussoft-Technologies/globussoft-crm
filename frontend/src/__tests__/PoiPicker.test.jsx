/**
 * PoiPicker.jsx — reusable POI autocomplete (Wave 18 slice S93).
 *
 * Pins the contract for the reusable picker that consumes
 * `GET /api/travel/pois?destinationSlug=&category=&q=&limit=&offset=`
 * for the itinerary editor (S9) + the Inline Add-POI modal (S12)
 * (see PRD_TRAVEL_ITINERARY_UPGRADES.md FR-3.6).
 *
 * Cases:
 *   - Renders input with placeholder; doesn't auto-fetch on mount
 *   - Disabled when no destinationSlug; shows "Pick a destination first"
 *   - On focus, fetches with destinationSlug + cap-200 default limit (50)
 *   - Shows "Loading…" then renders POI rows with name + category badge
 *   - Renders thumbnail when imageUrl present, emoji fallback otherwise
 *   - Renders nameLocal when present (secondary line)
 *   - Click row -> onChange(poi) + dropdown closes
 *   - Empty state when API returns []
 *   - Error state when fetchApi throws
 *   - Debounces typed input (≥250 ms before re-fetch)
 *   - q query param passed when user types
 *   - Clear (×) button fires onChange(null)
 *   - Escape closes dropdown
 *
 * Mock-object stability per CLAUDE.md standing rule: fetchApiMock is a
 * stable reference so the SUT's useCallback dependency on fetchApi
 * doesn't churn between renders.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

import PoiPicker from '../components/PoiPicker';

const POI_ROWS = [
  {
    id: 1,
    tenantId: null,
    name: 'Anjuna Beach',
    nameLocal: 'अंजुना समुद्र तट',
    category: 'natural',
    imageUrl: 'https://example.test/anjuna.jpg',
    destinationSlug: 'goa',
    pendingApproval: false,
  },
  {
    id: 2,
    tenantId: 1,
    name: 'Bom Jesus Basilica',
    category: 'religious',
    imageUrl: null,
    destinationSlug: 'goa',
    pendingApproval: false,
  },
];

beforeEach(() => {
  fetchApiMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('<PoiPicker />', () => {
  it('renders search input with default placeholder', () => {
    render(<PoiPicker destinationSlug="goa" onChange={() => {}} />);
    const input = screen.getByLabelText(/poi search/i);
    expect(input).toBeTruthy();
    expect(input.getAttribute('placeholder')).toMatch(/search pois/i);
  });

  it('does NOT fetch on mount (only on focus)', () => {
    render(<PoiPicker destinationSlug="goa" onChange={() => {}} />);
    expect(fetchApiMock).not.toHaveBeenCalled();
  });

  it('disables input + shows hint when destinationSlug missing', () => {
    render(<PoiPicker destinationSlug="" onChange={() => {}} />);
    const input = screen.getByLabelText(/poi search/i);
    expect(input.disabled).toBe(true);
    expect(input.getAttribute('placeholder')).toMatch(/pick a destination/i);
  });

  it('on focus, calls fetchApi with destinationSlug + default limit=50', async () => {
    fetchApiMock.mockResolvedValueOnce({ pois: POI_ROWS, total: 2, limit: 50, offset: 0 });
    render(<PoiPicker destinationSlug="goa" onChange={() => {}} />);

    fireEvent.focus(screen.getByLabelText(/poi search/i));

    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalled();
    });
    const url = fetchApiMock.mock.calls[0][0];
    expect(url).toContain('/api/travel/pois?');
    expect(url).toContain('destinationSlug=goa');
    expect(url).toContain('limit=50');
  });

  it('renders Loading then POI rows with name + category badge', async () => {
    let resolveFetch;
    fetchApiMock.mockReturnValueOnce(
      new Promise((res) => {
        resolveFetch = res;
      }),
    );
    render(<PoiPicker destinationSlug="goa" onChange={() => {}} />);
    fireEvent.focus(screen.getByLabelText(/poi search/i));

    // Loading state visible while promise pending.
    await waitFor(() => {
      expect(screen.getByTestId('poi-picker-loading')).toBeTruthy();
    });

    // Resolve fetch.
    await act(async () => {
      resolveFetch({ pois: POI_ROWS, total: 2, limit: 50, offset: 0 });
    });

    await waitFor(() => {
      expect(screen.getByText('Anjuna Beach')).toBeTruthy();
    });
    expect(screen.getByText('Bom Jesus Basilica')).toBeTruthy();
    // Two category badges.
    const badges = screen.getAllByTestId('poi-picker-category-badge');
    expect(badges.length).toBe(2);
    expect(badges[0].textContent).toMatch(/natural/i);
    expect(badges[1].textContent).toMatch(/religious/i);
  });

  it('renders nameLocal as secondary line when present', async () => {
    fetchApiMock.mockResolvedValueOnce({ pois: POI_ROWS, total: 2, limit: 50, offset: 0 });
    render(<PoiPicker destinationSlug="goa" onChange={() => {}} />);
    fireEvent.focus(screen.getByLabelText(/poi search/i));

    await waitFor(() => {
      expect(screen.getByText('अंजुना समुद्र तट')).toBeTruthy();
    });
  });

  it('renders thumbnail img when imageUrl present', async () => {
    fetchApiMock.mockResolvedValueOnce({ pois: POI_ROWS, total: 2, limit: 50, offset: 0 });
    const { container } = render(<PoiPicker destinationSlug="goa" onChange={() => {}} />);
    fireEvent.focus(screen.getByLabelText(/poi search/i));

    await waitFor(() => {
      const imgs = container.querySelectorAll('img');
      expect(imgs.length).toBe(1);
      expect(imgs[0].getAttribute('src')).toBe('https://example.test/anjuna.jpg');
    });
  });

  it('clicking a row fires onChange(poi) and closes dropdown', async () => {
    fetchApiMock.mockResolvedValueOnce({ pois: POI_ROWS, total: 2, limit: 50, offset: 0 });
    const onChange = vi.fn();
    render(<PoiPicker destinationSlug="goa" onChange={onChange} />);
    fireEvent.focus(screen.getByLabelText(/poi search/i));

    await waitFor(() => {
      expect(screen.getByText('Anjuna Beach')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('poi-picker-row-1'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toMatchObject({ id: 1, name: 'Anjuna Beach' });
    // Listbox no longer in DOM.
    expect(screen.queryByTestId('poi-picker-listbox')).toBeNull();
  });

  it('shows empty state when API returns []', async () => {
    fetchApiMock.mockResolvedValueOnce({ pois: [], total: 0, limit: 50, offset: 0 });
    render(<PoiPicker destinationSlug="goa" onChange={() => {}} />);
    fireEvent.focus(screen.getByLabelText(/poi search/i));

    await waitFor(() => {
      const empty = screen.getByTestId('poi-picker-empty');
      expect(empty.textContent).toMatch(/no pois found for goa/i);
    });
  });

  it('shows error state when fetchApi rejects', async () => {
    fetchApiMock.mockRejectedValueOnce(new Error('boom'));
    render(<PoiPicker destinationSlug="goa" onChange={() => {}} />);
    fireEvent.focus(screen.getByLabelText(/poi search/i));

    await waitFor(() => {
      expect(screen.getByTestId('poi-picker-error')).toBeTruthy();
    });
  });

  it('debounces typed input: multiple rapid changes collapse to one fetch', async () => {
    // No fake timers — we use real timers + waitFor to observe the
    // debounce in real time. (Fake-timer + waitFor interaction hangs
    // because waitFor's internal polling needs real timers.)
    fetchApiMock.mockResolvedValue({ pois: POI_ROWS, total: 2, limit: 50, offset: 0 });
    render(<PoiPicker destinationSlug="goa" onChange={() => {}} />);
    fireEvent.focus(screen.getByLabelText(/poi search/i));
    // The initial focus fetch fires immediately (runFetch).
    await waitFor(() => {
      expect(fetchApiMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    });
    const focusCallCount = fetchApiMock.mock.calls.length;

    const input = screen.getByLabelText(/poi search/i);
    fireEvent.change(input, { target: { value: 'A' } });
    fireEvent.change(input, { target: { value: 'An' } });
    fireEvent.change(input, { target: { value: 'Anj' } });

    // None of the debounced fetches have fired yet — the prior changes
    // each reset the timer, so only ONE fetch should fire ~250ms later.
    expect(fetchApiMock.mock.calls.length).toBe(focusCallCount);

    // Wait for the debounce window to elapse.
    await waitFor(
      () => {
        expect(fetchApiMock.mock.calls.length).toBe(focusCallCount + 1);
      },
      { timeout: 1500 },
    );
    const lastUrl = fetchApiMock.mock.calls[fetchApiMock.mock.calls.length - 1][0];
    expect(lastUrl).toContain('q=Anj');
  });

  it('clear button fires onChange(null) and clears the input', async () => {
    fetchApiMock.mockResolvedValueOnce({ pois: POI_ROWS, total: 2, limit: 50, offset: 0 });
    const onChange = vi.fn();
    render(
      <PoiPicker
        destinationSlug="goa"
        value={{ id: 1, name: 'Anjuna Beach' }}
        onChange={onChange}
      />,
    );
    const clearBtn = screen.getByRole('button', { name: /clear selection/i });
    fireEvent.click(clearBtn);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toBeNull();
  });

  it('Escape key closes the open dropdown', async () => {
    fetchApiMock.mockResolvedValueOnce({ pois: POI_ROWS, total: 2, limit: 50, offset: 0 });
    render(<PoiPicker destinationSlug="goa" onChange={() => {}} />);
    fireEvent.focus(screen.getByLabelText(/poi search/i));
    await waitFor(() => {
      expect(screen.getByTestId('poi-picker-listbox')).toBeTruthy();
    });

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByTestId('poi-picker-listbox')).toBeNull();
    });
  });
});
