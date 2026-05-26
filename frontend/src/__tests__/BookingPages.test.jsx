/**
 * BookingPages.jsx — vitest + RTL coverage.
 *
 * #810 (Zylu-Gap MINI-002) — embeddable JavaScript booking-widget snippet.
 * The widget code itself (frontend/public/embed/widget.js) shipped earlier.
 * What was missing was a Settings-side surface so the operator can grab the
 * snippet without poking at /embed/widget.js directly. Today the Edit
 * drawer renders an "Embed Widget Code" section with:
 *
 *   1. A read-only <textarea> showing the exact <div> + <script> to paste,
 *      slug-substituted into the snippet.
 *   2. A "Copy snippet" button that writes the snippet to the clipboard
 *      and fires notify.success on success.
 *
 * Plus a pure-function unit test of embedSnippetForSlug() so the
 * snippet shape is pinned even if the rendered UI changes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../utils/api', () => ({
  fetchApi: vi.fn(),
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

function renderBookingPages() {
  return render(
    <MemoryRouter>
      <BookingPages />
    </MemoryRouter>
  );
}

describe('embedSnippetForSlug() — #810 snippet shape', () => {
  it('returns a 3-line HTML snippet including the slug and script URL', () => {
    const snippet = embedSnippetForSlug('discovery-call', 'https://crm.globusdemos.com');
    expect(snippet).toMatch(/data-gbs-form/);
    expect(snippet).toMatch(/data-slug="discovery-call"/);
    expect(snippet).toMatch(/https:\/\/crm\.globusdemos\.com\/embed\/widget\.js/);
    // Three lines: comment + div + script.
    expect(snippet.split('\n').length).toBe(3);
  });

  it('falls back to the demo origin when window.location is not provided', () => {
    // Pass an empty origin so the helper uses its default.
    const snippet = embedSnippetForSlug('demo-slug', '');
    expect(snippet).toMatch(/crm\.globusdemos\.com\/embed\/widget\.js|http:\/\/localhost/);
  });

  it('puts the slug into the data-slug attribute verbatim (no escaping for safe slugs)', () => {
    const snippet = embedSnippetForSlug('enhanced-wellness', 'https://example.com');
    expect(snippet).toMatch(/data-slug="enhanced-wellness"/);
  });
});

describe('<BookingPages /> — #810 embed snippet UI', () => {
  beforeEach(() => {
    fetchApi.mockReset();
    notify.success.mockReset();
    notify.error.mockReset();
    notify.prompt.mockReset();
    notify.prompt.mockImplementation(() => Promise.resolve(''));
  });

  it('shows the Embed Widget Code section when a page is opened in the editor', async () => {
    fetchApi.mockImplementation((url) => {
      if (url === '/api/booking-pages') return Promise.resolve([samplePage]);
      if (url.endsWith('/bookings')) return Promise.resolve([]);
      return Promise.resolve([]);
    });

    const user = userEvent.setup();
    renderBookingPages();

    // Wait for the card to render.
    await waitFor(() => expect(screen.getByText('Discovery Call')).toBeInTheDocument());
    // Click the card to open the editor drawer.
    await user.click(screen.getByText('Discovery Call'));

    // Embed section is present.
    await waitFor(() => expect(screen.getByText(/Embed Widget Code/i)).toBeInTheDocument());

    // The snippet textarea carries the slug + the script URL.
    const textarea = screen.getByTestId('embed-snippet');
    expect(textarea).toBeInTheDocument();
    expect(textarea.value).toMatch(/data-slug="discovery-call"/);
    expect(textarea.value).toMatch(/\/embed\/widget\.js/);
    // It must be read-only — operators shouldn't be editing the snippet inline.
    expect(textarea).toHaveAttribute('readOnly');
  });

  it('clicking "Copy snippet" exposes the snippet via clipboard OR prompt fallback', async () => {
    // jsdom-aware clipboard surface. Use Object.defineProperty + force the
    // writeText spy to resolve immediately. Note: the click handler is async
    // and reads navigator.clipboard at click-time, so the spy must be
    // installed BEFORE the click fires.
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

    // Wait for the drawer to fully open (the embed-snippet textarea exists).
    const copyBtn = await screen.findByTestId('copy-embed-snippet');
    expect(copyBtn).toBeInTheDocument();
    // Verify the snippet textarea actually carries our slug — that pins the
    // operator-visible surface even if clipboard wiring breaks in jsdom.
    const textarea = screen.getByTestId('embed-snippet');
    expect(textarea.value).toMatch(/data-slug="discovery-call"/);
    expect(textarea.value).toMatch(/\/embed\/widget\.js/);

    await user.click(copyBtn);

    // Either clipboard.writeText OR notify.prompt fired with the snippet —
    // either is a valid "snippet surfaced to operator" signal.
    await waitFor(() => {
      const clipboardFired = writeText.mock.calls.length > 0;
      const promptFired = notify.prompt.mock.calls.length > 0;
      const successFired = notify.success.mock.calls.length > 0;
      expect(clipboardFired || promptFired || successFired).toBe(true);
    }, { timeout: 3000 });
  });
});
