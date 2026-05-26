/**
 * BookingPages.jsx — vitest + RTL coverage.
 *
 * Originally pinned the #810 (Zylu-Gap MINI-002) embed-widget snippet UI.
 * Extended to cover the broader 856-LOC BookingPages page: list/create/edit/
 * delete CRUD, publish/active-status toggle, weekly-availability slot
 * configuration, embed-code copy, CSV export, loading + error + empty
 * states, and create-modal validation.
 *
 * Pinned surfaces (read at module level; all routes funnel through fetchApi
 * which is mocked per-test):
 *   GET    /api/booking-pages                  — list
 *   POST   /api/booking-pages                  — create
 *   GET    /api/booking-pages/:id/bookings     — recent bookings drawer
 *   PUT    /api/booking-pages/:id              — save edits (incl. isActive toggle)
 *   DELETE /api/booking-pages/:id              — delete page
 *   POST   /api/booking-pages/:id/cancel/:bid  — cancel a booking
 *   POST   /api/booking-pages/:id/upload       — logo/hero upload (fetch raw)
 *   GET    /api/csv/bookings/export.csv        — cross-page CSV export
 *
 * Stable mock-object pattern (per 2026-05-23 RTL standing rule): notify
 * methods all live on one object reference that the mock factory returns
 * every call, so the useNotify identity remains stable across renders and
 * doesn't trip useCallback dependency re-flap.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../utils/api', () => ({
  fetchApi: vi.fn(),
  getAuthToken: vi.fn(() => 'fake-token'),
}));

const notify = {
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  confirm: vi.fn(() => Promise.resolve(true)),
  prompt: vi.fn(() => Promise.resolve('')),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notify,
}));

import { fetchApi } from '../utils/api';
import BookingPages, { embedSnippetForSlug } from '../pages/BookingPages';

const samplePage = {
  id: 7,
  slug: 'discovery-call',
  title: 'Discovery Call',
  description: 'A 30-min intro',
  durationMins: 30,
  bufferMins: 0,
  isActive: true,
  availability: null,
  bookingCount: 4,
};

const pausedPage = {
  id: 8,
  slug: 'strategy-session',
  title: 'Strategy Session',
  description: 'Quarterly planning',
  durationMins: 60,
  bufferMins: 15,
  isActive: false,
  availability: null,
  bookingCount: 0,
};

function renderBookingPages() {
  return render(
    <MemoryRouter>
      <BookingPages />
    </MemoryRouter>
  );
}

function resetAllMocks() {
  fetchApi.mockReset();
  notify.success.mockReset();
  notify.error.mockReset();
  notify.info.mockReset();
  notify.confirm.mockReset();
  notify.confirm.mockImplementation(() => Promise.resolve(true));
  notify.prompt.mockReset();
  notify.prompt.mockImplementation(() => Promise.resolve(''));
}

// ─────────────────────────────────────────────────────────────────────
// Pure helper: embedSnippetForSlug() — preserved from initial coverage.
// ─────────────────────────────────────────────────────────────────────

describe('embedSnippetForSlug() — #810 snippet shape', () => {
  it('returns a 3-line HTML snippet including the slug and script URL', () => {
    const snippet = embedSnippetForSlug('discovery-call', 'https://crm.globusdemos.com');
    expect(snippet).toMatch(/data-gbs-form/);
    expect(snippet).toMatch(/data-slug="discovery-call"/);
    expect(snippet).toMatch(/https:\/\/crm\.globusdemos\.com\/embed\/widget\.js/);
    expect(snippet.split('\n').length).toBe(3);
  });

  it('falls back to the demo origin when window.location is not provided', () => {
    const snippet = embedSnippetForSlug('demo-slug', '');
    expect(snippet).toMatch(/crm\.globusdemos\.com\/embed\/widget\.js|http:\/\/localhost/);
  });

  it('puts the slug into the data-slug attribute verbatim (no escaping for safe slugs)', () => {
    const snippet = embedSnippetForSlug('enhanced-wellness', 'https://example.com');
    expect(snippet).toMatch(/data-slug="enhanced-wellness"/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Original two cases: embed UI visibility + copy.
// ─────────────────────────────────────────────────────────────────────

describe('<BookingPages /> — #810 embed snippet UI', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  it('shows the Embed Widget Code section when a page is opened in the editor', async () => {
    fetchApi.mockImplementation((url) => {
      if (url === '/api/booking-pages') return Promise.resolve([samplePage]);
      if (url.endsWith('/bookings')) return Promise.resolve([]);
      return Promise.resolve([]);
    });

    const user = userEvent.setup();
    renderBookingPages();

    await waitFor(() => expect(screen.getByText('Discovery Call')).toBeInTheDocument());
    await user.click(screen.getByText('Discovery Call'));

    await waitFor(() => expect(screen.getByText(/Embed Widget Code/i)).toBeInTheDocument());

    const textarea = screen.getByTestId('embed-snippet');
    expect(textarea).toBeInTheDocument();
    expect(textarea.value).toMatch(/data-slug="discovery-call"/);
    expect(textarea.value).toMatch(/\/embed\/widget\.js/);
    expect(textarea).toHaveAttribute('readOnly');
  });

  it('clicking "Copy snippet" exposes the snippet via clipboard OR prompt fallback', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    try {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        writable: true,
        configurable: true,
      });
    } catch { /* jsdom lockdown — prompt fallback */ }

    fetchApi.mockImplementation((url) => {
      if (url === '/api/booking-pages') return Promise.resolve([samplePage]);
      if (url.endsWith('/bookings')) return Promise.resolve([]);
      return Promise.resolve([]);
    });

    const user = userEvent.setup();
    renderBookingPages();
    await waitFor(() => expect(screen.getByText('Discovery Call')).toBeInTheDocument());
    await user.click(screen.getByText('Discovery Call'));

    const copyBtn = await screen.findByTestId('copy-embed-snippet');
    expect(copyBtn).toBeInTheDocument();
    const textarea = screen.getByTestId('embed-snippet');
    expect(textarea.value).toMatch(/data-slug="discovery-call"/);
    expect(textarea.value).toMatch(/\/embed\/widget\.js/);

    await user.click(copyBtn);

    await waitFor(() => {
      const clipboardFired = writeText.mock.calls.length > 0;
      const promptFired = notify.prompt.mock.calls.length > 0;
      const successFired = notify.success.mock.calls.length > 0;
      expect(clipboardFired || promptFired || successFired).toBe(true);
    }, { timeout: 3000 });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Extended coverage — list / create / edit / delete / publish-toggle /
// slot config / CSV export / loading + error + empty / validation.
// ─────────────────────────────────────────────────────────────────────

describe('<BookingPages /> — list + empty + loading states', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  it('renders the loading state while the initial list request is pending', () => {
    // Return an unresolved promise to keep loading=true.
    fetchApi.mockImplementation(() => new Promise(() => {}));
    renderBookingPages();
    expect(screen.getByText(/Loading\.\.\./i)).toBeInTheDocument();
  });

  it('renders the empty state when /api/booking-pages returns []', async () => {
    fetchApi.mockImplementation((url) => {
      if (url === '/api/booking-pages') return Promise.resolve([]);
      return Promise.resolve([]);
    });
    renderBookingPages();
    await waitFor(() => expect(screen.getByText(/No booking pages yet/i)).toBeInTheDocument());
    // Two "Create Page" CTAs: header button + the empty-state CTA.
    const createCtas = screen.getAllByText(/Create Page/i);
    expect(createCtas.length).toBeGreaterThanOrEqual(1);
  });

  it('renders one card per page with title, slug, duration, booking count, status', async () => {
    fetchApi.mockImplementation((url) => {
      if (url === '/api/booking-pages') return Promise.resolve([samplePage, pausedPage]);
      return Promise.resolve([]);
    });
    renderBookingPages();

    await waitFor(() => expect(screen.getByText('Discovery Call')).toBeInTheDocument());
    expect(screen.getByText('Strategy Session')).toBeInTheDocument();
    // Slugs render as /slug.
    expect(screen.getByText('/discovery-call')).toBeInTheDocument();
    expect(screen.getByText('/strategy-session')).toBeInTheDocument();
    // Active vs paused badges.
    expect(screen.getByText('ACTIVE')).toBeInTheDocument();
    expect(screen.getByText('PAUSED')).toBeInTheDocument();
    // Duration shows minutes.
    expect(screen.getByText(/30m/)).toBeInTheDocument();
    expect(screen.getByText(/60m/)).toBeInTheDocument();
  });

  it('silently sets loading=false when /api/booking-pages rejects (no notify.error gate)', async () => {
    fetchApi.mockImplementation(() => Promise.reject(new Error('boom')));
    renderBookingPages();
    // The catch handler clears loading state but doesn't surface an error
    // notify — the SUT lets the empty state render in that case.
    await waitFor(() => {
      expect(screen.queryByText(/Loading\.\.\./i)).not.toBeInTheDocument();
    });
    // Falls into the "No booking pages yet" branch because pages stays [].
    expect(screen.getByText(/No booking pages yet/i)).toBeInTheDocument();
  });
});

describe('<BookingPages /> — create-page modal', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  it('opens the Create modal when the header "Create Page" button is clicked', async () => {
    fetchApi.mockImplementation((url) => {
      if (url === '/api/booking-pages') return Promise.resolve([samplePage]);
      return Promise.resolve([]);
    });
    const user = userEvent.setup();
    renderBookingPages();
    await waitFor(() => expect(screen.getByText('Discovery Call')).toBeInTheDocument());

    // Header CTA = "Create Page" button (there can be multiple matches if
    // empty-state shows one; here we have a card so only the header one).
    const createBtns = screen.getAllByText(/Create Page/i);
    await user.click(createBtns[0]);

    expect(screen.getByText(/New Booking Page/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/30-min Discovery Call/i)).toBeInTheDocument();
  });

  it('POSTs /api/booking-pages with title + description + durationMins on submit', async () => {
    fetchApi.mockImplementation((url, opts) => {
      if (url === '/api/booking-pages' && (!opts || opts.method !== 'POST')) {
        return Promise.resolve([]);
      }
      if (url === '/api/booking-pages' && opts && opts.method === 'POST') {
        return Promise.resolve({ id: 99 });
      }
      return Promise.resolve([]);
    });

    const user = userEvent.setup();
    renderBookingPages();
    await waitFor(() => expect(screen.getByText(/No booking pages yet/i)).toBeInTheDocument());

    // Empty-state has its own Create Page button; click it.
    const createBtns = screen.getAllByText(/Create Page/i);
    await user.click(createBtns[0]);

    const titleInput = screen.getByPlaceholderText(/30-min Discovery Call/i);
    await user.type(titleInput, 'Quick Demo');

    // Find the submit "Create Page" button INSIDE the modal (it's the one
    // matching "Create Page" that lives near the cancel button).
    // The modal renders <button type="submit">Create Page</button>.
    const submitBtn = screen.getAllByText(/Create Page/i).find((el) => el.tagName === 'BUTTON' && el.getAttribute('type') === 'submit');
    expect(submitBtn).toBeTruthy();
    await user.click(submitBtn);

    await waitFor(() => {
      const postCall = fetchApi.mock.calls.find(([url, opts]) => url === '/api/booking-pages' && opts && opts.method === 'POST');
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.title).toBe('Quick Demo');
      expect(body.durationMins).toBe(30);
      // availability default present.
      expect(body.availability).toBeTruthy();
    });
  });

  it('validation: submit with empty title is a no-op (no POST fires)', async () => {
    fetchApi.mockImplementation((url) => {
      if (url === '/api/booking-pages') return Promise.resolve([]);
      return Promise.resolve([]);
    });

    const user = userEvent.setup();
    renderBookingPages();
    await waitFor(() => expect(screen.getByText(/No booking pages yet/i)).toBeInTheDocument());

    const createBtns = screen.getAllByText(/Create Page/i);
    await user.click(createBtns[0]);

    // The title input has required, AND the submit handler bails early on
    // empty title. We assert the early-bail path: clear any default and
    // attempt to submit via the form. Browsers (jsdom) honour `required` and
    // will block the click-submit too — either way no POST fires.
    const beforePostCount = fetchApi.mock.calls.filter(([url, opts]) => url === '/api/booking-pages' && opts && opts.method === 'POST').length;

    const submitBtn = screen.getAllByText(/Create Page/i).find((el) => el.tagName === 'BUTTON' && el.getAttribute('type') === 'submit');
    await user.click(submitBtn);

    // No POST should have fired.
    const afterPostCount = fetchApi.mock.calls.filter(([url, opts]) => url === '/api/booking-pages' && opts && opts.method === 'POST').length;
    expect(afterPostCount).toBe(beforePostCount);
  });

  it('surfaces notify.error when the create POST rejects', async () => {
    fetchApi.mockImplementation((url, opts) => {
      if (url === '/api/booking-pages' && (!opts || opts.method !== 'POST')) {
        return Promise.resolve([]);
      }
      if (url === '/api/booking-pages' && opts && opts.method === 'POST') {
        return Promise.reject(new Error('server down'));
      }
      return Promise.resolve([]);
    });

    const user = userEvent.setup();
    renderBookingPages();
    await waitFor(() => expect(screen.getByText(/No booking pages yet/i)).toBeInTheDocument());

    const createBtns = screen.getAllByText(/Create Page/i);
    await user.click(createBtns[0]);

    const titleInput = screen.getByPlaceholderText(/30-min Discovery Call/i);
    await user.type(titleInput, 'Will Fail');

    const submitBtn = screen.getAllByText(/Create Page/i).find((el) => el.tagName === 'BUTTON' && el.getAttribute('type') === 'submit');
    await user.click(submitBtn);

    await waitFor(() => {
      expect(notify.error).toHaveBeenCalled();
      expect(notify.error.mock.calls[0][0]).toMatch(/Failed to create booking page/i);
    });
  });
});

describe('<BookingPages /> — edit drawer (pre-fill + save + publish toggle)', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  it('pre-fills the edit drawer with the selected page fields', async () => {
    fetchApi.mockImplementation((url) => {
      if (url === '/api/booking-pages') return Promise.resolve([samplePage]);
      if (url.endsWith('/bookings')) return Promise.resolve([]);
      if (url === '/api/wellness/services') return Promise.resolve([]);
      return Promise.resolve([]);
    });
    const user = userEvent.setup();
    renderBookingPages();
    await waitFor(() => expect(screen.getByText('Discovery Call')).toBeInTheDocument());
    await user.click(screen.getByText('Discovery Call'));

    // Drawer title row carries the page title.
    await waitFor(() => {
      // Title appears in BOTH the card AND the drawer; assert ≥2.
      expect(screen.getAllByText('Discovery Call').length).toBeGreaterThanOrEqual(2);
    });
    // Title input pre-filled.
    const titleInput = screen.getAllByDisplayValue('Discovery Call').find((el) => el.tagName === 'INPUT');
    expect(titleInput).toBeTruthy();
    // Description input pre-filled.
    expect(screen.getByDisplayValue('A 30-min intro')).toBeInTheDocument();
    // Status dropdown defaults to "Active".
    expect(screen.getByDisplayValue('Active')).toBeInTheDocument();
  });

  it('Save Changes PUTs /api/booking-pages/:id with the edited payload', async () => {
    fetchApi.mockImplementation((url, opts) => {
      if (url === '/api/booking-pages' && (!opts || !opts.method)) return Promise.resolve([samplePage]);
      if (url === '/api/booking-pages/7' && opts && opts.method === 'PUT') {
        return Promise.resolve({ ...samplePage, title: 'Discovery Call Updated' });
      }
      if (url === '/api/booking-pages/7/bookings') return Promise.resolve([]);
      if (url === '/api/wellness/services') return Promise.resolve([]);
      return Promise.resolve([]);
    });
    const user = userEvent.setup();
    renderBookingPages();
    await waitFor(() => expect(screen.getByText('Discovery Call')).toBeInTheDocument());
    await user.click(screen.getByText('Discovery Call'));

    await waitFor(() => expect(screen.getByText(/Save Changes/i)).toBeInTheDocument());
    await user.click(screen.getByText(/Save Changes/i));

    await waitFor(() => {
      const putCall = fetchApi.mock.calls.find(([url, opts]) => url === '/api/booking-pages/7' && opts && opts.method === 'PUT');
      expect(putCall).toBeTruthy();
      const body = JSON.parse(putCall[1].body);
      // Pre-filled fields round-trip.
      expect(body.title).toBe('Discovery Call');
      expect(body.durationMins).toBe(30);
      // Booleans + availability sent.
      expect(typeof body.isActive).toBe('boolean');
      expect(body.availability).toBeTruthy();
    });
  });

  it('toggling Status dropdown from Active → Paused flows into the PUT payload', async () => {
    fetchApi.mockImplementation((url, opts) => {
      if (url === '/api/booking-pages' && (!opts || !opts.method)) return Promise.resolve([samplePage]);
      if (url === '/api/booking-pages/7' && opts && opts.method === 'PUT') {
        const body = JSON.parse(opts.body);
        return Promise.resolve({ ...samplePage, isActive: body.isActive });
      }
      if (url === '/api/booking-pages/7/bookings') return Promise.resolve([]);
      if (url === '/api/wellness/services') return Promise.resolve([]);
      return Promise.resolve([]);
    });
    const user = userEvent.setup();
    renderBookingPages();
    await waitFor(() => expect(screen.getByText('Discovery Call')).toBeInTheDocument());
    await user.click(screen.getByText('Discovery Call'));

    await waitFor(() => expect(screen.getByDisplayValue('Active')).toBeInTheDocument());
    const statusSelect = screen.getByDisplayValue('Active');
    // Active option has value '1'; Paused has value '0'.
    fireEvent.change(statusSelect, { target: { value: '0' } });

    await user.click(screen.getByText(/Save Changes/i));

    await waitFor(() => {
      const putCall = fetchApi.mock.calls.find(([url, opts]) => url === '/api/booking-pages/7' && opts && opts.method === 'PUT');
      expect(putCall).toBeTruthy();
      const body = JSON.parse(putCall[1].body);
      expect(body.isActive).toBe(false);
    });
  });

  it('surfaces notify.error when the Save PUT rejects', async () => {
    fetchApi.mockImplementation((url, opts) => {
      if (url === '/api/booking-pages' && (!opts || !opts.method)) return Promise.resolve([samplePage]);
      if (url === '/api/booking-pages/7' && opts && opts.method === 'PUT') {
        return Promise.reject(new Error('500'));
      }
      if (url === '/api/booking-pages/7/bookings') return Promise.resolve([]);
      if (url === '/api/wellness/services') return Promise.resolve([]);
      return Promise.resolve([]);
    });

    const user = userEvent.setup();
    renderBookingPages();
    await waitFor(() => expect(screen.getByText('Discovery Call')).toBeInTheDocument());
    await user.click(screen.getByText('Discovery Call'));
    await waitFor(() => expect(screen.getByText(/Save Changes/i)).toBeInTheDocument());
    await user.click(screen.getByText(/Save Changes/i));

    await waitFor(() => {
      expect(notify.error).toHaveBeenCalled();
      expect(notify.error.mock.calls[0][0]).toMatch(/Failed to save changes/i);
    });
  });
});

describe('<BookingPages /> — delete confirm flow', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  it('delete fires confirm() and on accept DELETEs /api/booking-pages/:id then reloads', async () => {
    notify.confirm.mockImplementation(() => Promise.resolve(true));

    let listCallCount = 0;
    fetchApi.mockImplementation((url, opts) => {
      if (url === '/api/booking-pages' && (!opts || !opts.method)) {
        listCallCount += 1;
        return Promise.resolve(listCallCount === 1 ? [samplePage] : []);
      }
      if (url === '/api/booking-pages/7' && opts && opts.method === 'DELETE') {
        return Promise.resolve({});
      }
      return Promise.resolve([]);
    });

    const user = userEvent.setup();
    const { container } = renderBookingPages();
    await waitFor(() => expect(screen.getByText('Discovery Call')).toBeInTheDocument());

    // The delete button is a red Trash2 icon button — find it via the
    // wrapping card's last button. Simpler: query all buttons inside the
    // card and click the last one (delete is third in the action row).
    const cardButtons = container.querySelectorAll('.card button');
    // 3 action buttons per card: Copy URL, Edit, Delete. Header + empty-state
    // CTAs are not inside .card.card here because the header is a sibling.
    // The DELETE icon button is the LAST button inside the card.
    const deleteBtn = cardButtons[cardButtons.length - 1];
    await user.click(deleteBtn);

    await waitFor(() => {
      expect(notify.confirm).toHaveBeenCalled();
      const deleteCall = fetchApi.mock.calls.find(([url, opts]) => url === '/api/booking-pages/7' && opts && opts.method === 'DELETE');
      expect(deleteCall).toBeTruthy();
    });
  });

  it('delete is cancelled when confirm() resolves false (no DELETE fires)', async () => {
    notify.confirm.mockImplementation(() => Promise.resolve(false));

    fetchApi.mockImplementation((url) => {
      if (url === '/api/booking-pages') return Promise.resolve([samplePage]);
      return Promise.resolve([]);
    });

    const user = userEvent.setup();
    const { container } = renderBookingPages();
    await waitFor(() => expect(screen.getByText('Discovery Call')).toBeInTheDocument());

    const cardButtons = container.querySelectorAll('.card button');
    const deleteBtn = cardButtons[cardButtons.length - 1];
    await user.click(deleteBtn);

    await waitFor(() => expect(notify.confirm).toHaveBeenCalled());

    // No DELETE call should have fired.
    const deleteCall = fetchApi.mock.calls.find(([url, opts]) => url === '/api/booking-pages/7' && opts && opts.method === 'DELETE');
    expect(deleteCall).toBeFalsy();
  });
});

describe('<BookingPages /> — weekly availability slot configuration', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  it('renders all 7 day rows with default Mon-Fri windows and "Unavailable" on weekend', async () => {
    fetchApi.mockImplementation((url) => {
      if (url === '/api/booking-pages') return Promise.resolve([samplePage]);
      if (url.endsWith('/bookings')) return Promise.resolve([]);
      if (url === '/api/wellness/services') return Promise.resolve([]);
      return Promise.resolve([]);
    });
    const user = userEvent.setup();
    renderBookingPages();
    await waitFor(() => expect(screen.getByText('Discovery Call')).toBeInTheDocument());
    await user.click(screen.getByText('Discovery Call'));

    await waitFor(() => expect(screen.getByText(/Weekly Availability/i)).toBeInTheDocument());
    expect(screen.getByText('Mon')).toBeInTheDocument();
    expect(screen.getByText('Tue')).toBeInTheDocument();
    expect(screen.getByText('Wed')).toBeInTheDocument();
    expect(screen.getByText('Thu')).toBeInTheDocument();
    expect(screen.getByText('Fri')).toBeInTheDocument();
    expect(screen.getByText('Sat')).toBeInTheDocument();
    expect(screen.getByText('Sun')).toBeInTheDocument();
    // Sat + Sun default to "Unavailable" (two italic span labels).
    const unavail = screen.getAllByText(/Unavailable/i);
    expect(unavail.length).toBeGreaterThanOrEqual(2);
  });

  it('renders time inputs for each weekday window (5 weekdays × 2 inputs each = 10 time inputs)', async () => {
    fetchApi.mockImplementation((url) => {
      if (url === '/api/booking-pages') return Promise.resolve([samplePage]);
      if (url.endsWith('/bookings')) return Promise.resolve([]);
      if (url === '/api/wellness/services') return Promise.resolve([]);
      return Promise.resolve([]);
    });
    const user = userEvent.setup();
    const { container } = renderBookingPages();
    await waitFor(() => expect(screen.getByText('Discovery Call')).toBeInTheDocument());
    await user.click(screen.getByText('Discovery Call'));

    await waitFor(() => expect(screen.getByText(/Weekly Availability/i)).toBeInTheDocument());

    // 5 weekday rows × 2 time inputs (start + end) = 10 type=time inputs.
    const timeInputs = container.querySelectorAll('input[type="time"]');
    expect(timeInputs.length).toBe(10);
  });
});

describe('<BookingPages /> — CSV export', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  it('clicking "Export Bookings CSV" fetches /api/csv/bookings/export.csv with Bearer token', async () => {
    fetchApi.mockImplementation((url) => {
      if (url === '/api/booking-pages') return Promise.resolve([samplePage]);
      return Promise.resolve([]);
    });

    const blob = new Blob(['name,email\nAlice,a@b.c'], { type: 'text/csv' });
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      blob: () => Promise.resolve(blob),
    });
    // jsdom URL.createObjectURL is stubbed minimally.
    const createObjectURL = vi.fn(() => 'blob:fake-url');
    const revokeObjectURL = vi.fn();
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;

    try {
      const user = userEvent.setup();
      renderBookingPages();
      await waitFor(() => expect(screen.getByText('Discovery Call')).toBeInTheDocument());

      const exportBtn = screen.getByText(/Export Bookings CSV/i);
      await user.click(exportBtn);

      await waitFor(() => {
        const csvCall = fetchSpy.mock.calls.find(([url]) => url === '/api/csv/bookings/export.csv');
        expect(csvCall).toBeTruthy();
        // Bearer token header was attached.
        const opts = csvCall[1];
        expect(opts.headers.Authorization).toMatch(/^Bearer /);
      });

      // notify.success is called on completion.
      await waitFor(() => expect(notify.success).toHaveBeenCalled());
    } finally {
      fetchSpy.mockRestore();
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
    }
  });

  it('surfaces notify.error when the CSV fetch returns non-OK', async () => {
    fetchApi.mockImplementation((url) => {
      if (url === '/api/booking-pages') return Promise.resolve([samplePage]);
      return Promise.resolve([]);
    });

    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      blob: () => Promise.resolve(new Blob()),
    });

    try {
      const user = userEvent.setup();
      renderBookingPages();
      await waitFor(() => expect(screen.getByText('Discovery Call')).toBeInTheDocument());

      const exportBtn = screen.getByText(/Export Bookings CSV/i);
      await user.click(exportBtn);

      await waitFor(() => {
        expect(notify.error).toHaveBeenCalled();
        expect(notify.error.mock.calls[0][0]).toMatch(/Export failed|CSV/i);
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('<BookingPages /> — Copy URL action', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  it('clicking "Copy URL" on a card surfaces the public URL via clipboard, prompt, OR Copied! state', async () => {
    fetchApi.mockImplementation((url) => {
      if (url === '/api/booking-pages') return Promise.resolve([samplePage]);
      return Promise.resolve([]);
    });

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      writable: true,
      configurable: true,
    });

    const user = userEvent.setup();
    renderBookingPages();
    await waitFor(() => expect(screen.getByText('Discovery Call')).toBeInTheDocument());

    const copyBtn = screen.getByText(/Copy URL/i);
    await user.click(copyBtn);

    // Three valid completion signals: writeText fired, prompt fallback fired,
    // or the SUT flipped to its "Copied!" visual state (proves copyUrl ran).
    await waitFor(() => {
      const clipboardFired = writeText.mock.calls.length > 0;
      const promptFired = notify.prompt.mock.calls.length > 0;
      const copiedStateRendered = screen.queryByText(/Copied!/i) !== null;
      expect(clipboardFired || promptFired || copiedStateRendered).toBe(true);
    }, { timeout: 3000 });

    // URL pattern includes /api/booking-pages/public/<slug> — assert only
    // when whichever path captured the URL did fire.
    if (writeText.mock.calls.length > 0) {
      expect(writeText.mock.calls[0][0]).toMatch(/\/api\/booking-pages\/public\/discovery-call/);
    } else if (notify.prompt.mock.calls.length > 0) {
      expect(notify.prompt.mock.calls[0][1]).toMatch(/\/api\/booking-pages\/public\/discovery-call/);
    }
  });
});
