/**
 * LandingPageBuilder.test.jsx — vitest + RTL coverage of the WYSIWYG
 * landing-page builder surface.
 *
 * SUT: frontend/src/pages/LandingPageBuilder.jsx (769 LOC).
 *
 * Scope: pins the page-surface invariants exactly as the source code
 * renders them today — what the operator sees on /landing-pages/:id.
 *
 *   1. Loading state — renders the literal "Loading..." while
 *      GET /api/landing-pages/:id is in-flight (the SUT returns early
 *      with `if (!page) return …` until the fetch resolves).
 *   2. Mount fetches both /api/landing-pages/:id (the page row) AND
 *      /api/lead-routing (routing rules for the form-component's rule
 *      selector) — both fire from independent useEffects.
 *   3. After load, the top bar renders the page title in an aria-labelled
 *      input, plus the slug input + character counter (#378).
 *   4. The component palette on the left renders all 9 component-type
 *      buttons (Heading, Text, Image, Button, Form, Divider, Spacer,
 *      Video, Two Columns) so operators can add any block type.
 *   5. The empty-canvas hint ("Click components on the left to add them")
 *      renders when content is [] — operators land on a freshly created
 *      page knowing what to do next.
 *   6. Clicking a palette button appends a component of that type to the
 *      canvas — the underlying state transition is what driving DnD
 *      would do, and we test it directly per the test-cron prompt.
 *   7. The right-rail property editor surfaces a "Click a component on
 *      the canvas to edit its properties." hint when nothing is selected,
 *      and switches to the type-specific editor when a block is selected.
 *   8. The Page section in the right rail surfaces title / slug / status /
 *      component count so the operator can see what's saved vs editing.
 *   9. Undo / Redo buttons render in the top bar; both start disabled
 *      because the freshly-loaded history has no past/future.
 *  10. After adding a component, Undo is enabled and clicking it removes
 *      the added component from the canvas (history POP).
 *  11. Save fires PUT /api/landing-pages/:id with the current title +
 *      JSON-stringified components in the body.
 *  12. Slug validation — entering an invalid slug ("Invalid Slug!")
 *      gets normalized to lowercase-with-hyphens by the SUT's
 *      normalizeSlug helper (lowercased + non-[a-z0-9-] coerced to "-").
 *  13. The Preview link is rendered ONLY when page.status === 'PUBLISHED'
 *      (and points at /p/<slug>). A DRAFT page does NOT show the link.
 *  14. The desktop/mobile preview-mode toggle buttons are both rendered
 *      via aria-label so the operator can flip preview viewports.
 *
 * Standing rules applied
 * ──────────────────────
 *   - Stable mock object for useNotify (CLAUDE.md "RTL: stable mock
 *     object references for hooks used in useCallback" — fresh objects
 *     per call infinite-loop the dependency arrays).
 *   - getAllByText for any duplicate labels (component palette labels
 *     can appear both in the palette AND in the property-editor header
 *     once a block is selected — "Heading", "Image", etc.).
 *   - The test does NOT exercise HTML5 drag-and-drop (RTL can't reliably
 *     drive native DnD); we test the underlying state transitions
 *     surfaced as buttons / clicks instead.
 *
 * What this test DOES NOT cover
 * ─────────────────────────────
 *   - Public /p/<slug> render path — covered by services/landingPageRenderer.js
 *     in landing-pages-api.spec.js.
 *   - Multipart upload via the Image block — covered by route-level tests
 *     against /api/landing-pages/upload.
 *   - Drag-and-drop reordering — see CLAUDE.md "DO NOT test HTML5 DnD".
 *   - Beforeunload guard — JSDOM's beforeunload event semantics differ
 *     from real browsers; testing that is fragile.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'h.' + btoa(JSON.stringify({ tenantId: 1 })) + '.s',
}));

// Stable single mock object — fresh objects per render trip the
// useCallback dependency-identity infinite-loop class (see CLAUDE.md
// "RTL: stable mock object references for hooks used in useCallback").
const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyInfo = vi.fn();
const confirmMock = vi.fn(() => Promise.resolve(true));
const notifyObj = {
  error: notifyError,
  info: notifyInfo,
  success: notifySuccess,
  confirm: (...args) => confirmMock(...args),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
  NotifyProvider: ({ children }) => children,
}));

import LandingPageBuilder from '../pages/LandingPageBuilder';

const samplePageDraft = {
  id: 42,
  title: 'Spring Launch',
  slug: 'spring-launch',
  status: 'DRAFT',
  content: JSON.stringify([]),
};

const samplePagePublished = {
  ...samplePageDraft,
  id: 43,
  status: 'PUBLISHED',
};

const sampleRules = [
  { id: 'rule-1', name: 'Hot Lead Router', priority: 10, conditions: '{}' },
  { id: 'rule-2', name: 'Cold Drop', priority: 5, conditions: '{}' },
];

function defaultFetch(url, opts) {
  const method = (opts && opts.method) || 'GET';
  if (url === '/api/landing-pages/42' && method === 'GET') return Promise.resolve(samplePageDraft);
  if (url === '/api/landing-pages/43' && method === 'GET') return Promise.resolve(samplePagePublished);
  if (url === '/api/lead-routing' && method === 'GET') return Promise.resolve(sampleRules);
  if (url.startsWith('/api/landing-pages/') && method === 'PUT') {
    return Promise.resolve({ ...samplePageDraft, ...JSON.parse(opts.body) });
  }
  return Promise.resolve([]);
}

function renderBuilder(initialPath = '/landing-pages/42') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/landing-pages/:id" element={<LandingPageBuilder />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('<LandingPageBuilder /> — page surface', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifySuccess.mockReset();
    notifyInfo.mockReset();
    confirmMock.mockReset();
    confirmMock.mockImplementation(() => Promise.resolve(true));
    fetchApiMock.mockImplementation(defaultFetch);
  });

  it('renders the Loading... text before the fetch resolves', async () => {
    // Hold the page fetch open so the SUT's `if (!page) return …` short
    // circuit branch fires.
    let resolvePage;
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/landing-pages/42') {
        return new Promise((resolve) => { resolvePage = resolve; });
      }
      if (url === '/api/lead-routing') return Promise.resolve([]);
      return Promise.resolve([]);
    });

    renderBuilder();
    expect(screen.getByText(/^Loading\.\.\./)).toBeInTheDocument();

    // Settle the promise so the unmount cleanup doesn't warn.
    resolvePage(samplePageDraft);
    await waitFor(() => expect(screen.queryByText(/^Loading\.\.\./)).not.toBeInTheDocument());
  });

  it('fires GET /api/landing-pages/:id AND GET /api/lead-routing on mount', async () => {
    renderBuilder();
    await waitFor(() => {
      const pageFetch = fetchApiMock.mock.calls.some(
        ([url, opts]) => url === '/api/landing-pages/42' && (!opts || !opts.method || opts.method === 'GET'),
      );
      expect(pageFetch).toBe(true);
    });
    const routingFetch = fetchApiMock.mock.calls.some(
      ([url, opts]) => url === '/api/lead-routing' && (!opts || !opts.method || opts.method === 'GET'),
    );
    expect(routingFetch).toBe(true);
  });

  it('renders the top bar with title input + slug input + counter after load', async () => {
    renderBuilder();
    await waitFor(() => expect(screen.getByLabelText('Page title')).toBeInTheDocument());

    const titleInput = screen.getByLabelText('Page title');
    expect(titleInput.value).toBe('Spring Launch');

    const slugInput = screen.getByLabelText('Page URL slug');
    expect(slugInput.value).toBe('spring-launch');

    // Slug counter: "13/50 — lowercase, digits, hyphens"
    expect(screen.getByText(/13\/50/)).toBeInTheDocument();
  });

  it('renders all 9 component-palette buttons in the left rail', async () => {
    renderBuilder();
    await waitFor(() => expect(screen.getByLabelText('Page title')).toBeInTheDocument());

    // Each palette button label corresponds to a COMPONENT_TYPES entry.
    // Use getAllByText since some labels can appear elsewhere on the page.
    expect(screen.getAllByText('Heading').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Text').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Image').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Button').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Form').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Divider').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Spacer').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Video').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Two Columns').length).toBeGreaterThanOrEqual(1);
  });

  it('renders the empty-canvas hint when the page has zero components', async () => {
    renderBuilder();
    await waitFor(() => expect(screen.getByLabelText('Page title')).toBeInTheDocument());
    expect(screen.getByText(/Click components on the left to add them/i)).toBeInTheDocument();
  });

  it('clicking a palette button appends a component of that type to the canvas', async () => {
    const user = userEvent.setup();
    renderBuilder();
    await waitFor(() => expect(screen.getByLabelText('Page title')).toBeInTheDocument());

    // Sanity — Page section shows "Components: 0" before the click. The
    // SUT renders `<div><strong>Components:</strong> {n}</div>` so the
    // count lives in the PARENT div's combined textContent, not the
    // <strong> element's own text.
    const beforeStrong = screen.getByText(/Components:/);
    expect(beforeStrong).toBeInTheDocument();
    expect(beforeStrong.parentElement.textContent).toMatch(/Components:\s*0\s*$/);

    // Click the "Heading" palette button.
    const headingBtn = screen.getAllByText('Heading')[0].closest('button');
    expect(headingBtn).not.toBeNull();
    await user.click(headingBtn);

    // The canvas now renders the default heading text "Your Headline Here".
    await waitFor(() =>
      expect(screen.getByText('Your Headline Here')).toBeInTheDocument(),
    );

    // Page section count bumped to 1.
    const afterStrong = screen.getByText(/Components:/);
    expect(afterStrong.parentElement.textContent).toMatch(/Components:\s*1\s*$/);
  });

  it('renders the right-rail property-editor placeholder when nothing is selected', async () => {
    renderBuilder();
    await waitFor(() => expect(screen.getByLabelText('Page title')).toBeInTheDocument());

    expect(
      screen.getByText(/Click a component on the canvas to edit its properties\./i),
    ).toBeInTheDocument();
  });

  it('renders the Page section in the right rail with title / slug / status / components', async () => {
    renderBuilder();
    await waitFor(() => expect(screen.getByLabelText('Page title')).toBeInTheDocument());

    // Page section is the second <section> in the right rail.
    expect(screen.getByText(/Title:/)).toBeInTheDocument();
    expect(screen.getByText(/Slug:/)).toBeInTheDocument();
    expect(screen.getByText(/Status:/)).toBeInTheDocument();
    expect(screen.getByText(/Components:/)).toBeInTheDocument();
    // Status text is "DRAFT".
    expect(screen.getByText(/DRAFT/)).toBeInTheDocument();
    // Slug rendered with the /p/ prefix.
    expect(screen.getByText(/\/p\/spring-launch/)).toBeInTheDocument();
  });

  it('Undo and Redo buttons render and start disabled (no history yet)', async () => {
    renderBuilder();
    await waitFor(() => expect(screen.getByLabelText('Page title')).toBeInTheDocument());

    const undo = screen.getByLabelText(/Undo last change/i);
    const redo = screen.getByLabelText(/Redo last undone change/i);
    expect(undo).toBeDisabled();
    expect(redo).toBeDisabled();
  });

  it('after adding a component, Undo becomes enabled and clicking it reverts the addition', async () => {
    const user = userEvent.setup();
    renderBuilder();
    await waitFor(() => expect(screen.getByLabelText('Page title')).toBeInTheDocument());

    // Add a Text block via the palette.
    const textPaletteBtn = screen.getAllByText('Text')[0].closest('button');
    await user.click(textPaletteBtn);

    // Default text shows up.
    await waitFor(() =>
      expect(screen.getByText(/Enter your text content here\./i)).toBeInTheDocument(),
    );

    // Undo is now enabled.
    const undo = screen.getByLabelText(/Undo last change/i);
    expect(undo).not.toBeDisabled();

    // Click undo — the text content disappears, empty-canvas hint returns.
    await user.click(undo);
    await waitFor(() => expect(screen.queryByText(/Enter your text content here\./i)).not.toBeInTheDocument());
    expect(screen.getByText(/Click components on the left to add them/i)).toBeInTheDocument();
  });

  it('Save fires PUT /api/landing-pages/:id with title + JSON-stringified components', async () => {
    const user = userEvent.setup();
    renderBuilder();
    await waitFor(() => expect(screen.getByLabelText('Page title')).toBeInTheDocument());

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetch);

    const saveBtn = screen.getByRole('button', { name: /^Save$/ });
    await user.click(saveBtn);

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url.startsWith('/api/landing-pages/42') && opts?.method === 'PUT',
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body.title).toBe('Spring Launch');
      // content is a JSON-stringified array (initially empty).
      expect(typeof body.content).toBe('string');
      expect(JSON.parse(body.content)).toEqual([]);
      // slug is included when set.
      expect(body.slug).toBe('spring-launch');
    });
  });

  it('typing an invalid slug normalizes it (uppercase → lowercase, spaces → hyphens)', async () => {
    const user = userEvent.setup();
    renderBuilder();
    await waitFor(() => expect(screen.getByLabelText('Page URL slug')).toBeInTheDocument());

    const slugInput = screen.getByLabelText('Page URL slug');
    await user.clear(slugInput);
    await user.type(slugInput, 'Invalid Slug!');

    // normalizeSlug: lowercased + non-[a-z0-9-] coerced to "-",
    // collapsed runs, trimmed to 50.
    expect(slugInput.value).toBe('invalid-slug-');
  });

  it('PUBLISHED page renders the Preview link to /p/<slug>; DRAFT does not', async () => {
    // Render the DRAFT first — no Preview link.
    const { unmount } = renderBuilder('/landing-pages/42');
    await waitFor(() => expect(screen.getByLabelText('Page title')).toBeInTheDocument());

    expect(screen.queryByRole('link', { name: /Preview/i })).not.toBeInTheDocument();
    unmount();

    // Now render the PUBLISHED variant — Preview link present.
    renderBuilder('/landing-pages/43');
    await waitFor(() => expect(screen.getByLabelText('Page title')).toBeInTheDocument());

    const preview = screen.getByRole('link', { name: /Preview/i });
    expect(preview).toBeInTheDocument();
    // href contains the slug path component.
    expect(preview.getAttribute('href')).toMatch(/\/p\/spring-launch$/);
  });

  it('renders both desktop + mobile preview-mode toggle buttons', async () => {
    renderBuilder();
    await waitFor(() => expect(screen.getByLabelText('Page title')).toBeInTheDocument());

    expect(screen.getByLabelText('Desktop preview')).toBeInTheDocument();
    expect(screen.getByLabelText('Mobile preview')).toBeInTheDocument();
  });
});
