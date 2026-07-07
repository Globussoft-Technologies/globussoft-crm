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

  it('PUBLISHED page renders the "Open live" link to /trips; DRAFT does not', async () => {
    // The builder distinguishes two related surfaces (PR-E preview wiring):
    //   - The "Preview" BUTTON (always visible) mints a 5-min preview
    //     token and opens /api/landing-pages/:id/preview in a new tab.
    //     Works for DRAFT + PUBLISHED — production renderer either way.
    //   - The "Open live" LINK appears ONLY when status=PUBLISHED and
    //     points at the public /p/<slug> URL.
    // Render the DRAFT first — no "Open live" link.
    const { unmount } = renderBuilder('/landing-pages/42');
    await waitFor(() => expect(screen.getByLabelText('Page title')).toBeInTheDocument());

    expect(screen.queryByRole('link', { name: /Open live/i })).not.toBeInTheDocument();
    unmount();

    // Now render the PUBLISHED variant — "Open live" link present.
    renderBuilder('/landing-pages/43');
    await waitFor(() => expect(screen.getByLabelText('Page title')).toBeInTheDocument());

    const openLive = screen.getByRole('link', { name: /Open live/i });
    expect(openLive).toBeInTheDocument();
    // Public marketing URL is /trips (renders the currently featured page).
    expect(openLive.getAttribute('href')).toMatch(/\/trips$/);
  });

  it('renders both desktop + mobile preview-mode toggle buttons', async () => {
    renderBuilder();
    await waitFor(() => expect(screen.getByLabelText('Page title')).toBeInTheDocument());

    expect(screen.getByLabelText('Desktop preview')).toBeInTheDocument();
    expect(screen.getByLabelText('Mobile preview')).toBeInTheDocument();
  });

  // ─────────────────────────────────────────────────────────────────────
  // EXTENSION cases — added 2026-05-26 to cover block library variety,
  // property-editor mutation, remove / reorder block controls, save-state
  // transitions, body-shape edge cases, and form-block routing rules.
  // ─────────────────────────────────────────────────────────────────────

  it('adds a Button block from the palette and renders its default text on the canvas', async () => {
    const user = userEvent.setup();
    renderBuilder();
    await waitFor(() => expect(screen.getByLabelText('Page title')).toBeInTheDocument());

    const buttonPaletteBtn = screen.getAllByText('Button')[0].closest('button');
    await user.click(buttonPaletteBtn);

    // The Button block's defaultProps.text === 'Click Here'.
    await waitFor(() => expect(screen.getByText('Click Here')).toBeInTheDocument());

    // Page section count reflects 1 component now.
    const countLine = screen.getByText(/Components:/);
    expect(countLine.parentElement.textContent).toMatch(/Components:\s*1\s*$/);
  });

  it('adds a Form block and surfaces its default fields on the canvas', async () => {
    const user = userEvent.setup();
    renderBuilder();
    await waitFor(() => expect(screen.getByLabelText('Page title')).toBeInTheDocument());

    const formPaletteBtn = screen.getAllByText('Form')[0].closest('button');
    await user.click(formPaletteBtn);

    // Form defaultProps.fields contains Name + Email field labels and
    // defaultProps.submitText === 'Submit'.
    await waitFor(() => expect(screen.getByText('Submit')).toBeInTheDocument());
    // Name + Email labels appear as form field labels on the canvas.
    expect(screen.getByText(/^Name/)).toBeInTheDocument();
    expect(screen.getByText(/^Email/)).toBeInTheDocument();
  });

  it('selecting a block surfaces the type-specific property editor in the right rail', async () => {
    const user = userEvent.setup();
    renderBuilder();
    await waitFor(() => expect(screen.getByLabelText('Page title')).toBeInTheDocument());

    // Add a heading and then click it on the canvas to select it.
    const headingBtn = screen.getAllByText('Heading')[0].closest('button');
    await user.click(headingBtn);
    const canvasHeading = await screen.findByText('Your Headline Here');
    await user.click(canvasHeading);

    // Right rail header reads "Component · heading" once selected.
    await waitFor(() =>
      expect(screen.getByText(/Component · heading/i)).toBeInTheDocument(),
    );

    // Heading property editor surfaces "Text" + "Level" + "Align" + "Color"
    // label markers in the right rail. "Text" appears multiple times (also
    // a palette label), so use getAllByText. "Level" + "Align" are unique
    // to the property editor.
    expect(screen.getAllByText(/^Text$/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/^Level$/)).toBeInTheDocument();
    expect(screen.getByText(/^Align$/)).toBeInTheDocument();
  });

  it('editing a block prop via the property editor updates the live canvas preview', async () => {
    const user = userEvent.setup();
    renderBuilder();
    await waitFor(() => expect(screen.getByLabelText('Page title')).toBeInTheDocument());

    // Add + select a Heading.
    const headingBtn = screen.getAllByText('Heading')[0].closest('button');
    await user.click(headingBtn);
    const canvasHeading = await screen.findByText('Your Headline Here');
    await user.click(canvasHeading);

    // The Heading property-editor "Text" field starts populated with the
    // default. There are multiple "Text" elements (palette button label
    // also has the text "Text"); the property-editor label is the one
    // whose parent has an <input> sibling with the current text value.
    const textLabels = screen.getAllByText(/^Text$/);
    let textInput = null;
    for (const label of textLabels) {
      const candidate = label.parentElement && label.parentElement.querySelector('input, textarea');
      if (candidate && candidate.value === 'Your Headline Here') {
        textInput = candidate;
        break;
      }
    }
    expect(textInput).toBeTruthy();
    await user.clear(textInput);
    await user.type(textInput, 'New Headline');

    // The canvas updates in real time (the SUT dispatches SET on every
    // prop edit so canvas re-renders immediately even before the 500ms
    // history-commit debounce fires).
    await waitFor(() =>
      expect(screen.getByText('New Headline')).toBeInTheDocument(),
    );
  });

  it('selecting a block shows the in-canvas Move Up / Move Down / Trash row controls', async () => {
    const user = userEvent.setup();
    renderBuilder();
    await waitFor(() => expect(screen.getByLabelText('Page title')).toBeInTheDocument());

    // Add two heading blocks so there's something to reorder.
    const headingPaletteBtn = screen.getAllByText('Heading')[0].closest('button');
    await user.click(headingPaletteBtn);
    await user.click(headingPaletteBtn);

    // Two "Your Headline Here" instances on the canvas.
    await waitFor(() =>
      expect(screen.getAllByText('Your Headline Here').length).toBe(2),
    );

    // Click the first heading to select it.
    const headings = screen.getAllByText('Your Headline Here');
    await user.click(headings[0]);

    // Once selected, the row's overlay surface 3 icon buttons (ChevronUp,
    // ChevronDown, Trash2). They are unlabelled <button> elements under
    // the selection overlay. There's no aria-label on them in the SUT, so
    // we count the rendered svg icons next to the selected heading.
    const selectedRow = headings[0].closest('div'); // ComponentPreview wrapper
    // The overlay buttons live in a sibling div, not inside the heading
    // text. Walk up to the cursor wrapper that has the overlay child.
    const wrapper = selectedRow.parentElement;
    // The overlay div contains 3 <button> elements; locate via querySelector.
    const overlayButtons = wrapper.querySelectorAll('button');
    expect(overlayButtons.length).toBeGreaterThanOrEqual(3);
  });

  it('removing a block via the canvas trash icon shrinks the component count', async () => {
    const user = userEvent.setup();
    renderBuilder();
    await waitFor(() => expect(screen.getByLabelText('Page title')).toBeInTheDocument());

    // Add one Spacer block (no visible text label on the canvas — it just
    // adds a div with height). Use Components count to assert state.
    const spacerPaletteBtn = screen.getAllByText('Spacer')[0].closest('button');
    await user.click(spacerPaletteBtn);

    // Count is 1.
    await waitFor(() => {
      const line = screen.getByText(/Components:/);
      expect(line.parentElement.textContent).toMatch(/Components:\s*1\s*$/);
    });

    // Now ALSO add a Heading so we have a visible thing to click → select.
    const headingPaletteBtn = screen.getAllByText('Heading')[0].closest('button');
    await user.click(headingPaletteBtn);
    const canvasHeading = await screen.findByText('Your Headline Here');

    // Click to select the Heading.
    await user.click(canvasHeading);

    // The selection overlay shows 3 buttons; the LAST is the Trash button
    // (per SUT order: ChevronUp, ChevronDown, Trash2).
    const wrapper = canvasHeading.parentElement.parentElement; // overlay sibling
    const overlayButtons = wrapper.querySelectorAll('button');
    expect(overlayButtons.length).toBeGreaterThanOrEqual(3);
    const trashBtn = overlayButtons[overlayButtons.length - 1];
    await user.click(trashBtn);

    // Heading is gone; only Spacer remains → count is 1.
    await waitFor(() => {
      expect(screen.queryByText('Your Headline Here')).not.toBeInTheDocument();
      const line = screen.getByText(/Components:/);
      expect(line.parentElement.textContent).toMatch(/Components:\s*1\s*$/);
    });
  });

  it('Save POST body has the right shape — title + content (JSON) + slug — for a populated canvas', async () => {
    const user = userEvent.setup();
    renderBuilder();
    await waitFor(() => expect(screen.getByLabelText('Page title')).toBeInTheDocument());

    // Add a Heading + a Spacer.
    await user.click(screen.getAllByText('Heading')[0].closest('button'));
    await user.click(screen.getAllByText('Spacer')[0].closest('button'));
    await waitFor(() => expect(screen.getByText('Your Headline Here')).toBeInTheDocument());

    // Now save.
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetch);

    // Dirty marker means the accessible name is "Save •" not just "Save",
    // so use a permissive matcher.
    const saveBtn = screen.getByRole('button', { name: /Save/ });
    await user.click(saveBtn);

    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url.startsWith('/api/landing-pages/42') && opts?.method === 'PUT',
      );
      expect(putCall).toBeTruthy();
      const body = JSON.parse(putCall[1].body);
      // title carried.
      expect(body.title).toBe('Spring Launch');
      // slug carried.
      expect(body.slug).toBe('spring-launch');
      // content is a JSON-encoded array with the 2 blocks we added.
      const parsed = JSON.parse(body.content);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(2);
      expect(parsed[0].type).toBe('heading');
      expect(parsed[1].type).toBe('spacer');
      // Each block has an id (Date.now() string) + props.
      parsed.forEach((b) => {
        expect(typeof b.id).toBe('string');
        expect(typeof b.props).toBe('object');
      });
    });
  });

  it('Save failure surfaces notify.error("Save failed") for a generic backend error', async () => {
    const user = userEvent.setup();

    // First, normal load — then on PUT, return a non-409 error.
    fetchApiMock.mockImplementation((url, opts) => {
      const method = (opts && opts.method) || 'GET';
      if (url === '/api/landing-pages/42' && method === 'GET') return Promise.resolve(samplePageDraft);
      if (url === '/api/lead-routing' && method === 'GET') return Promise.resolve(sampleRules);
      if (url.startsWith('/api/landing-pages/') && method === 'PUT') {
        return Promise.reject(Object.assign(new Error('Bang'), { status: 500 }));
      }
      return Promise.resolve([]);
    });

    renderBuilder();
    await waitFor(() => expect(screen.getByLabelText('Page title')).toBeInTheDocument());

    const saveBtn = screen.getByRole('button', { name: /^Save$/ });
    await user.click(saveBtn);

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith('Save failed');
    });
  });

  it('form-block property editor populates the Lead Routing dropdown from /api/lead-routing', async () => {
    const user = userEvent.setup();
    renderBuilder();
    await waitFor(() => expect(screen.getByLabelText('Page title')).toBeInTheDocument());

    // Add + select a Form block.
    const formPaletteBtn = screen.getAllByText('Form')[0].closest('button');
    await user.click(formPaletteBtn);
    // Canvas form's submit button shows.
    const canvasSubmit = await screen.findByText('Submit');
    // Click the form block (closest container) to select it.
    await user.click(canvasSubmit);

    // Right rail header reads "Component · form".
    await waitFor(() =>
      expect(screen.getByText(/Component · form/i)).toBeInTheDocument(),
    );

    // Two rule names from sampleRules appear in the dropdown options.
    await waitFor(() => {
      expect(screen.getByText(/Hot Lead Router/)).toBeInTheDocument();
    });
    expect(screen.getByText(/Cold Drop/)).toBeInTheDocument();

    // The "tenant-level routing" fallback option also renders.
    expect(screen.getByText(/Use tenant-level routing/i)).toBeInTheDocument();
  });

  it('the "↻" derive-slug button derives a slug from the current title', async () => {
    const user = userEvent.setup();
    renderBuilder();
    await waitFor(() => expect(screen.getByLabelText('Page title')).toBeInTheDocument());

    // Change the title.
    const titleInput = screen.getByLabelText('Page title');
    await user.clear(titleInput);
    await user.type(titleInput, 'Holiday Promo 2027');

    // Click the derive button (↻ glyph).
    const deriveBtn = screen.getByTitle(/Derive slug from current page title/i);
    await user.click(deriveBtn);

    // Slug input now reads the derived value: "holiday-promo-2027".
    const slugInput = screen.getByLabelText('Page URL slug');
    expect(slugInput.value).toBe('holiday-promo-2027');
  });

  it('deriving a slug from an empty title surfaces notify.error', async () => {
    const user = userEvent.setup();
    renderBuilder();
    await waitFor(() => expect(screen.getByLabelText('Page title')).toBeInTheDocument());

    // Clear title.
    const titleInput = screen.getByLabelText('Page title');
    await user.clear(titleInput);

    // Click derive — should error.
    const deriveBtn = screen.getByTitle(/Derive slug from current page title/i);
    await user.click(deriveBtn);

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/Set a title first/),
      );
    });
  });

  it('typing in the title input flips the Save button into the dirty state (• marker)', async () => {
    const user = userEvent.setup();
    renderBuilder();
    await waitFor(() => expect(screen.getByLabelText('Page title')).toBeInTheDocument());

    // Initially the save button has no • marker — its text is just "Save".
    const saveBtnInitial = screen.getByRole('button', { name: /^Save$/ });
    expect(saveBtnInitial.textContent).not.toMatch(/•/);

    // Type a change into the title.
    const titleInput = screen.getByLabelText('Page title');
    await user.type(titleInput, ' (Edited)');

    // The • marker now appears.
    await waitFor(() => {
      const saveBtnDirty = screen.getByRole('button', { name: /Save/ });
      expect(saveBtnDirty.textContent).toMatch(/•/);
    });
  });

  it('clicking the Mobile preview toggle switches the active state away from Desktop', async () => {
    const user = userEvent.setup();
    renderBuilder();
    await waitFor(() => expect(screen.getByLabelText('Page title')).toBeInTheDocument());

    const desktop = screen.getByLabelText('Desktop preview');
    const mobile = screen.getByLabelText('Mobile preview');

    // Desktop starts with accent background — the SUT sets background:
    // 'var(--accent-color)' when previewMode === 'desktop'. We can't read
    // resolved CSS reliably, but we can read inline style.
    expect(desktop.getAttribute('style')).toMatch(/var\(--accent-color\)/);
    expect(mobile.getAttribute('style')).not.toMatch(/var\(--accent-color\)/);

    await user.click(mobile);

    // After click — mobile is the accented one.
    await waitFor(() => {
      expect(mobile.getAttribute('style')).toMatch(/var\(--accent-color\)/);
      expect(desktop.getAttribute('style')).not.toMatch(/var\(--accent-color\)/);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// VersionHistoryModal — renamed from VersionsDrawer (side <aside>) to a
// centered <div role="dialog"> modal. The trigger button's aria-label is
// "View version history". The modal's root element carries role="dialog"
// aria-label="Version history". Closing it removes the dialog from the
// DOM and resets selectedVersion to null.
//
// API shape: GET /api/landing-pages/:id/versions returns
//   { versions: [] }  (the SUT reads data?.versions).
// When versions is empty the modal renders the "No versions yet" copy.
// ─────────────────────────────────────────────────────────────────────
describe('<LandingPageBuilder /> — VersionHistoryModal', () => {
  // Wire the versions endpoint to return an empty list so the modal
  // renders the "No versions yet" copy without trying to show cards.
  function versionsEmptyFetch(url, opts) {
    const method = (opts && opts.method) || 'GET';
    if (url === '/api/landing-pages/42' && method === 'GET') return Promise.resolve(samplePageDraft);
    if (url === '/api/lead-routing' && method === 'GET') return Promise.resolve(sampleRules);
    if (url === '/api/landing-pages/42/versions' && method === 'GET')
      return Promise.resolve({ versions: [] });
    if (url.startsWith('/api/landing-pages/') && method === 'PUT')
      return Promise.resolve({ ...samplePageDraft, ...JSON.parse(opts.body) });
    return Promise.resolve([]);
  }

  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifySuccess.mockReset();
    notifyInfo.mockReset();
    confirmMock.mockReset();
    confirmMock.mockImplementation(() => Promise.resolve(true));
    fetchApiMock.mockImplementation(versionsEmptyFetch);
  });

  it('clicking "View version history" renders a dialog with role="dialog" and aria-label="Version history"', async () => {
    const user = userEvent.setup();
    renderBuilder();
    await waitFor(() => expect(screen.getByLabelText('Page title')).toBeInTheDocument());

    // The trigger is an icon-only button in the top bar; its accessible
    // name is "View version history" (aria-label on the <button>).
    const historyBtn = screen.getByLabelText('View version history');
    expect(historyBtn).toBeInTheDocument();

    // Modal is not yet visible.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(historyBtn);

    // After click the modal mounts with role="dialog" aria-label="Version history".
    await waitFor(() => {
      const dialog = screen.getByRole('dialog');
      expect(dialog).toBeInTheDocument();
      expect(dialog).toHaveAttribute('aria-label', 'Version history');
      expect(dialog).toHaveAttribute('aria-modal', 'true');
    });

    // With an empty versions list the modal shows the "No versions yet" copy.
    expect(
      screen.getByText(/No versions yet/i),
    ).toBeInTheDocument();
  });

  it('clicking the Close button (✕) dismisses the VersionHistoryModal', async () => {
    const user = userEvent.setup();
    renderBuilder();
    await waitFor(() => expect(screen.getByLabelText('Page title')).toBeInTheDocument());

    // Open the modal.
    await user.click(screen.getByLabelText('View version history'));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());

    // The close button carries aria-label="Close" (see LandingPageBuilder.jsx:1070).
    const closeBtn = screen.getByRole('button', { name: /^Close$/i });
    await user.click(closeBtn);

    // Dialog is removed from the DOM after close.
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });
});
