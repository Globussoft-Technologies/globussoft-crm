/**
 * wave8-marketing-html-body.test.jsx — Wave 8 SHIP-NOW combined fix pin.
 *
 * Pins the contract for #596:
 *
 *   #596 — Marketing → Email Campaign body field labelled "Body (HTML)" must
 *          preserve safe HTML (`<p>`, `<strong>`, `<a>`, etc.) on save.
 *          Pre-fix the body was routed through sanitizeText (allowedTags=[])
 *          which silently stripped every tag, leaving only the plain text.
 *          Post-fix the route uses sanitizeHtmlBody which preserves a
 *          documented marketing-email allow-list (h1–h6, p, br, ul/li, table,
 *          strong, em, a, img, …) while still blocking `<script>` /
 *          `<iframe>` / on*= handlers.
 *
 * Frontend-side contract pinned by this test: the editor sends the body
 * through to /api/marketing/campaigns/:id/schedule verbatim. The backend
 * sanitizer is unit-tested separately at backend/test/utils/sanitize-json.test.js
 * with a 12-case suite for the new sanitizeHtmlBody helper. This file
 * pins the wire shape — when the editor textarea contains HTML, the same
 * HTML hits the schedule POST body unchanged (no client-side stripping).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

const notifyError = vi.fn();
const notifyInfo = vi.fn();
const notifySuccess = vi.fn();
vi.mock('../utils/notify', () => ({
  useNotify: () => ({
    error: notifyError,
    info: notifyInfo,
    success: notifySuccess,
    confirm: () => Promise.resolve(true),
    prompt: () => Promise.resolve(''),
  }),
}));

vi.mock('socket.io-client', () => ({
  io: () => ({ on: vi.fn(), disconnect: vi.fn() }),
}));

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyError.mockReset();
  notifyInfo.mockReset();
  notifySuccess.mockReset();
});

describe('#596 Marketing — Email Campaign body preserves HTML on save', () => {
  it('HTML body in the editor is forwarded verbatim to the /schedule POST', async () => {
    const Marketing = (await import('../pages/Marketing')).default;

    const htmlBody = '<h1>Hello {{first_name}}</h1><p>Welcome to <strong>Globus Wellness</strong>.</p><p><a href="https://example.com">Book now</a></p>';

    fetchApiMock.mockImplementation((url, opts) => {
      if (url.startsWith('/api/marketing/campaigns?channel=EMAIL') && (!opts || !opts.method)) {
        return Promise.resolve([
          {
            id: 77,
            name: 'HTML Body Test',
            status: 'Draft',
            channel: 'EMAIL',
            budget: 0,
            sent: 0,
            opened: 0,
            clicked: 0,
            scheduledAt: '2026-09-15T10:00:00.000Z',
            scheduleFilters: JSON.stringify({
              subject: 'Welcome',
              preheader: 'Hi',
              body: htmlBody,
              audienceFilter: { status: '' },
            }),
          },
        ]);
      }
      return Promise.resolve({ ok: true });
    });

    render(
      <MemoryRouter>
        <Marketing />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText(/HTML Body Test/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText(/Edit campaign HTML Body Test/i));
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: /Edit campaign/i })).toBeInTheDocument();
    });

    // The body textarea is pre-populated with the HTML.
    const bodyTextarea = document.querySelector('[role="dialog"] textarea');
    expect(bodyTextarea).toBeTruthy();
    // The editor reads the body out of scheduleFilters.body — assert the
    // pre-populated value contains the HTML tags rather than just the text.
    expect(bodyTextarea.value).toContain('<h1>');
    expect(bodyTextarea.value).toContain('<strong>Globus Wellness</strong>');
    expect(bodyTextarea.value).toContain('<a href="https://example.com">');

    fetchApiMock.mockClear();

    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      const scheduleCall = fetchApiMock.mock.calls.find(
        ([url, opts]) =>
          /\/api\/marketing\/campaigns\/77\/schedule/.test(url) &&
          opts?.method === 'POST',
      );
      expect(scheduleCall).toBeDefined();
      const reqBody = JSON.parse(scheduleCall[1].body);
      // Frontend forwards the HTML verbatim — no client-side stripping.
      expect(reqBody.filters.body).toContain('<h1>');
      expect(reqBody.filters.body).toContain('<strong>Globus Wellness</strong>');
      expect(reqBody.filters.body).toContain('href="https://example.com"');
    });
  });
});
