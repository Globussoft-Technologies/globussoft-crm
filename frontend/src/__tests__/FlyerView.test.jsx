/**
 * FlyerView.jsx — public flyer-share landing
 * (PRD_TRAVEL_MARKETING_FLYER #908 slice S18 — `docs/TRAVEL_BIG_SCOPE_BACKLOG.md`).
 *
 * Lives at /p/flyer/:slug?t=<jwt>[&embed=1]. Mirrors slice C9's
 * QuoteAcceptLanding test shape — fetches a metadata envelope from
 * `/api/v1/flyers/public/:slug/meta?t=` and renders a read-only flyer
 * card with format switcher + download link + copy-embed-code button.
 *
 * Contract pins:
 *   1. Initial render → loading state.
 *   2. Meta loads → renders templateName + brandName + format switcher
 *      + download button.
 *   3. 404 → friendly "no longer available" message.
 *   4. 410 → "This flyer link has expired" message.
 *   5. 401 (missing token) → "Invalid share link" message.
 *   6. Format switcher changes the asset URL passed to the <img> / <iframe>.
 *   7. Download button has the right `download` filename attribute.
 *   8. Copy embed button calls navigator.clipboard with the iframe snippet
 *      + flips label to "Copied".
 *   9. Embed mode (?embed=1) hides the operator chrome (no Download button).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import FlyerView from '../pages/public/FlyerView';

function makeMeta(over = {}) {
  return {
    templateName: 'Summer Umrah 2026',
    destSlug: 'summer-umrah-2026',
    themeTag: 'sapphire',
    brandName: 'Travel Stall',
    subBrand: 'rfu',
    expiresAt: '2026-07-10T00:00:00.000Z',
    embed: false,
    availableFormats: [
      'pdf-a4', 'pdf-a5', 'png-square', 'png-portrait-ig', 'png-landscape-fb',
    ],
    defaultFormat: 'png-square',
    ...over,
  };
}

let fetchSpy;
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch');
  fetchSpy.mockImplementation(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(makeMeta()),
    }),
  );
});
afterEach(() => {
  fetchSpy.mockRestore();
});

function renderPage(search = '?t=eyJtok.en.sig', path = 'summer-umrah-2026') {
  return render(
    <MemoryRouter initialEntries={[`/p/flyer/${path}${search}`]}>
      <Routes>
        <Route path="/p/flyer/:slug" element={<FlyerView />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('FlyerView — public flyer landing (S18)', () => {
  it('1. initial render shows loading state before meta resolves', () => {
    fetchSpy.mockImplementation(() => new Promise(() => {}));
    renderPage();
    expect(screen.getByText(/Loading flyer/i)).toBeInTheDocument();
  });

  it('2. meta loads → renders templateName + brandName + format select + download', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/Summer Umrah 2026/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/Travel Stall/i)).toBeInTheDocument();
    // Format selector
    expect(screen.getByLabelText(/Pick a flyer format/i)).toBeInTheDocument();
    // Download button (anchor with role link or button text)
    expect(screen.getByRole('link', { name: /Download/i })).toBeInTheDocument();
    // Copy embed code button
    expect(screen.getByRole('button', { name: /Copy embed code/i })).toBeInTheDocument();
  });

  it('3. 404 → friendly "no longer available" message', async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ error: 'gone', code: 'FLYER_NOT_FOUND' }),
      }),
    );
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/no longer available/i)).toBeInTheDocument(),
    );
  });

  it('4. 410 → "This flyer link has expired" message', async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve({
        ok: false,
        status: 410,
        json: () => Promise.resolve({ error: 'gone', code: 'LINK_EXPIRED' }),
      }),
    );
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/This flyer link has expired/i)).toBeInTheDocument(),
    );
  });

  it('5. missing token → "Invalid share link" message', async () => {
    // No fetch call expected — page short-circuits to error.
    renderPage('');
    await waitFor(() =>
      expect(screen.getByText(/Invalid share link/i)).toBeInTheDocument(),
    );
  });

  it('6. format select change updates asset URL passed to <img>', async () => {
    renderPage();
    await waitFor(() => screen.getByText(/Summer Umrah 2026/i));

    // The default format is png-square — <img> src includes format=png-square.
    const img = screen.getByAltText(/Summer Umrah 2026/i);
    expect(img.getAttribute('src')).toMatch(/format=png-square/);

    // Switch to pdf-a4 — the asset element flips to <iframe>.
    fireEvent.change(screen.getByLabelText(/Pick a flyer format/i), {
      target: { value: 'pdf-a4' },
    });
    await waitFor(() => {
      const iframe = screen.getByTitle(/Summer Umrah 2026/i);
      expect(iframe.getAttribute('src')).toMatch(/format=pdf-a4/);
    });
  });

  it('7. Download link carries a download attribute derived from templateName', async () => {
    renderPage();
    await waitFor(() => screen.getByText(/Summer Umrah 2026/i));
    const link = screen.getByRole('link', { name: /Download/i });
    expect(link.getAttribute('download')).toMatch(/summer-umrah-2026/);
    // Default format is PNG so the suffix is .png.
    expect(link.getAttribute('download')).toMatch(/\.png$/);
  });

  it('8. Copy embed code calls navigator.clipboard + flips to "Copied"', async () => {
    const writeTextSpy = vi.fn().mockResolvedValue(undefined);
    const originalClipboard = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeTextSpy },
      configurable: true,
    });
    try {
      renderPage();
      await waitFor(() => screen.getByText(/Summer Umrah 2026/i));
      fireEvent.click(screen.getByRole('button', { name: /Copy embed code/i }));
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /Copied/i })).toBeInTheDocument(),
      );
      expect(writeTextSpy).toHaveBeenCalled();
      expect(writeTextSpy.mock.calls[0][0]).toContain('<iframe');
      expect(writeTextSpy.mock.calls[0][0]).toContain('embed=1');
    } finally {
      // Restore clipboard regardless of test outcome.
      if (originalClipboard) {
        Object.defineProperty(navigator, 'clipboard', {
          value: originalClipboard,
          configurable: true,
        });
      } else {
        // Some jsdom versions don't define clipboard at all — delete the
        // property to avoid leaking the mock to sibling tests.
        delete navigator.clipboard;
      }
    }
  });

  it('9. embed mode (?embed=1) hides operator chrome — no Download / Copy buttons', async () => {
    renderPage('?t=eyJtok.en.sig&embed=1');
    await waitFor(() => {
      // The <img> still renders, but no controls.
      expect(screen.getByAltText(/Summer Umrah 2026/i)).toBeInTheDocument();
    });
    expect(screen.queryByRole('link', { name: /Download/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Copy embed code/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Pick a flyer format/i)).not.toBeInTheDocument();
  });
});
