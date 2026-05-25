/**
 * KbArticleView.test.jsx — vitest + RTL coverage for the public (unauthed)
 * /portal/:tenantSlug/kb/:slug knowledge-base article-view page.
 *
 * Tick #143 Agent — adds first unit coverage for
 * frontend/src/pages/KbArticleView.jsx (321 LOC). The SUT is the public
 * article landing page consumers reach from the help-center portal — it
 * GETs /api/knowledge-base/public/:tenantSlug/article/:slug, renders the
 * article body via a lightweight inline markdown subset (## / ### / -
 * list / **bold** / paragraphs), and surfaces metadata (Updated date,
 * view count). No auth context, no useNotify, no fetchApi wrapper — it
 * uses native window.fetch directly and useParams() for the route slugs.
 *
 * Scope — pins the page-surface invariants:
 *   1. Mount fires GET /api/knowledge-base/public/:tenantSlug/article/:slug
 *      with both URL params encoded verbatim. No auth headers.
 *   2. Loading state ("Loading article…") renders while in flight.
 *   3. 404 response renders the "Article not found or unpublished." copy
 *      inside the "Article unavailable" chrome.
 *   4. Non-2xx (500) renders the generic "Could not load this article."
 *      copy under the same chrome.
 *   5. Network throw (fetch rejection) renders the same generic copy.
 *   6. Successful response renders article.title as the h1, the "Updated
 *      {date}" footer line, and the formatted view count.
 *   7. View-count uses .toLocaleString() — large numbers get grouped.
 *   8. View-count falls back to "0 views" when article.views is missing.
 *   9. Markdown rendering: ## headers render as <h2>, ### as <h3>, and
 *      "- " bullet lines render inside a <ul>.
 *   10. Inline **bold** wrappers render as <strong>.
 *   11. Empty/blank content surfaces the italic "This article has no
 *       content yet." fallback.
 *   12. "Back to help center" link points at /portal.
 *
 * Drift notes pinned during authoring:
 *   - SUT uses NATIVE fetch (not fetchApi from utils/api), so the global
 *     fetch is stubbed per-test.
 *   - SUT uses useParams() — must wrap in MemoryRouter + Routes + Route
 *     with path="/portal/:tenantSlug/kb/:slug" so both slugs are
 *     populated. (The Sidebar/portal link is /portal — used by the
 *     ArrowLeft Back link.)
 *   - SUT has no AuthContext consumption (public page).
 *   - SUT has no useNotify consumption (errors render inline).
 *   - The "Article unavailable" heading is the chrome wrapper; the
 *     specific 404 vs 5xx copy varies inside it.
 *
 * Mock discipline (per CLAUDE.md feedback rules):
 *   - global.fetch is per-test stubbed (vi.fn) so each test asserts its
 *     own URL/body shape; reset in beforeEach.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

import KbArticleView from '../pages/KbArticleView';

const TENANT_SLUG = 'enhanced-wellness';
const ARTICLE_SLUG = 'getting-started';

function makeArticle(overrides = {}) {
  return {
    id: 42,
    title: 'How to Onboard a New Patient',
    slug: ARTICLE_SLUG,
    content: '## Section A\n\nWelcome to the guide.\n\n### Sub heading\n\n- First item\n- Second item with **bold word** inside\n\nFinal paragraph.',
    views: 1234,
    updatedAt: '2026-05-20T10:00:00.000Z',
    ...overrides,
  };
}

function renderPage(tenantSlug = TENANT_SLUG, slug = ARTICLE_SLUG) {
  return render(
    <MemoryRouter initialEntries={[`/portal/${tenantSlug}/kb/${slug}`]}>
      <Routes>
        <Route path="/portal/:tenantSlug/kb/:slug" element={<KbArticleView />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('KbArticleView — public KB article landing page surface', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fires GET /api/knowledge-base/public/:tenantSlug/article/:slug on mount with both URL params', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(makeArticle()),
    });

    renderPage(TENANT_SLUG, ARTICLE_SLUG);

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(global.fetch).toHaveBeenCalledWith(
      `/api/knowledge-base/public/${TENANT_SLUG}/article/${ARTICLE_SLUG}`,
    );
    // No options arg — this is a public endpoint, no Authorization header.
    expect(global.fetch.mock.calls[0][1]).toBeUndefined();
  });

  it('renders the "Loading article…" chrome while the fetch is in flight', () => {
    // Never-resolving fetch keeps the loading state visible.
    global.fetch.mockReturnValue(new Promise(() => {}));
    renderPage();
    // The ellipsis in the SUT is a literal "…" char (renderable through JSX text).
    expect(screen.getByText(/Loading article/i)).toBeInTheDocument();
  });

  it('renders the "Article not found or unpublished." copy when GET returns 404', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: () => Promise.resolve({}),
    });
    renderPage();

    expect(
      await screen.findByText(/Article not found or unpublished/i),
    ).toBeInTheDocument();
    // The "Article unavailable" chrome heading is also present.
    expect(screen.getByText(/Article unavailable/i)).toBeInTheDocument();
    // Article body must NOT render on the error path.
    expect(
      screen.queryByRole('heading', { name: /How to Onboard a New Patient/i }),
    ).not.toBeInTheDocument();
  });

  it('renders the generic "Could not load this article." copy on a non-2xx (500) response', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({}),
    });
    renderPage();

    expect(
      await screen.findByText(/Could not load this article/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Article unavailable/i)).toBeInTheDocument();
  });

  it('renders the generic "Could not load this article." copy when fetch itself throws (network error)', async () => {
    global.fetch.mockRejectedValueOnce(new Error('socket hang up'));
    renderPage();

    expect(
      await screen.findByText(/Could not load this article/i),
    ).toBeInTheDocument();
  });

  it('renders the article title as an h1 and the Updated-date metadata on a successful response', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(makeArticle()),
    });
    renderPage();

    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: /How to Onboard a New Patient/i,
      }),
    ).toBeInTheDocument();
    // The "Updated " prefix is literal SUT text; the date itself is locale-
    // formatted via formatDate() so we only assert the prefix to stay ICU-safe.
    expect(screen.getByText(/Updated/)).toBeInTheDocument();
  });

  it('formats view count with locale grouping via .toLocaleString()', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(makeArticle({ views: 12345 })),
    });
    renderPage();

    // 12345 → "12,345" in en-US, "12,345" in en-IN — every common
    // locale groups thousand+ values, so the comma is present cross-ICU.
    // Assert on the formatted "views" suffix to anchor the lookup.
    expect(await screen.findByText(/12,345 views/)).toBeInTheDocument();
  });

  it('falls back to "0 views" when article.views is missing/null', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(makeArticle({ views: null })),
    });
    renderPage();

    expect(await screen.findByText(/0 views/)).toBeInTheDocument();
  });

  it('renders the static "Knowledge Base" badge in the header chrome', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(makeArticle()),
    });
    renderPage();

    expect(await screen.findByText(/Knowledge Base/)).toBeInTheDocument();
  });

  it('renders markdown ## headers as <h2> elements', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(makeArticle({
        content: '## Section A\n\nBody paragraph here.',
      })),
    });
    renderPage();

    // "Section A" is the ## header — must land as an <h2>.
    const h2 = await screen.findByRole('heading', { level: 2, name: /Section A/ });
    expect(h2).toBeInTheDocument();
    expect(h2.tagName).toBe('H2');
  });

  it('renders markdown ### headers as <h3> elements', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(makeArticle({
        content: '### Sub heading\n\nDetails text.',
      })),
    });
    renderPage();

    const h3 = await screen.findByRole('heading', { level: 3, name: /Sub heading/ });
    expect(h3).toBeInTheDocument();
    expect(h3.tagName).toBe('H3');
  });

  it('renders "- " bullet lines as <ul> list items', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(makeArticle({
        content: '- First item\n- Second item\n- Third item',
      })),
    });
    renderPage();

    expect(await screen.findByText(/First item/)).toBeInTheDocument();
    const firstLi = screen.getByText(/First item/).closest('li');
    expect(firstLi).not.toBeNull();
    expect(firstLi.parentElement.tagName).toBe('UL');
    // All three items are list items.
    expect(screen.getByText(/Second item/).closest('li')).not.toBeNull();
    expect(screen.getByText(/Third item/).closest('li')).not.toBeNull();
  });

  it('renders inline **bold** markers as <strong> elements', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(makeArticle({
        content: 'A paragraph with a **bolded phrase** inside the text.',
      })),
    });
    renderPage();

    const strong = await screen.findByText('bolded phrase');
    expect(strong.tagName).toBe('STRONG');
  });

  it('renders the italic empty-content fallback when article.content is blank', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(makeArticle({ content: '' })),
    });
    renderPage();

    expect(
      await screen.findByText(/This article has no content yet/i),
    ).toBeInTheDocument();
  });

  it('renders the italic empty-content fallback for whitespace-only content', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(makeArticle({ content: '   \n   \n' })),
    });
    renderPage();

    expect(
      await screen.findByText(/This article has no content yet/i),
    ).toBeInTheDocument();
  });

  it('renders the "Back to help center" link pointing at /portal', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(makeArticle()),
    });
    renderPage();

    const back = await screen.findByRole('link', { name: /Back to help center/i });
    expect(back).toBeInTheDocument();
    expect(back.getAttribute('href')).toBe('/portal');
  });

  it('renders the markdown body block container only after the article resolves (not during loading)', async () => {
    // While loading, no markdown body block is mounted — only the
    // "Loading article…" chrome. Once the article resolves, the article
    // <h1> + body content appear together.
    let resolveFetch;
    global.fetch.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    renderPage();

    // During in-flight: Loading chrome present, body absent.
    expect(screen.getByText(/Loading article/i)).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', {
        level: 1,
        name: /How to Onboard a New Patient/i,
      }),
    ).not.toBeInTheDocument();

    // Resolve the in-flight fetch.
    resolveFetch({
      ok: true,
      status: 200,
      json: () => Promise.resolve(makeArticle()),
    });

    // After resolve: body appears, loading chrome disappears.
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: /How to Onboard a New Patient/i,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Loading article/i)).not.toBeInTheDocument();
  });
});
