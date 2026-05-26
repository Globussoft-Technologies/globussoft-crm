/**
 * KnowledgeBase.test.jsx — vitest + RTL coverage for the Knowledge Base page.
 *
 * Pins the contracts surfaced by the 2026-05-14 pen-test wave:
 *
 *   #722 — Header article count + pluralization stay consistent across the
 *          publish round-trip. Pre-fix the bug report on v3.7.6 showed
 *          "1 articles · Manage…" in the header after publishing a new draft
 *          while the status tabs + sidebar both correctly read 11. Root cause
 *          was a race between togglePublish()'s non-awaited loadAll() and the
 *          publishing-spinner clear — the header could render against a
 *          stale articles state for a frame. Fix is `await loadAll()` inside
 *          togglePublish so the spinner can't clear before the refetch
 *          settles. Pluralization is "1 article" / "N articles" via the
 *          totalArticles === 1 guard in the JSX.
 *
 *   #723 — Empty "+ category" submit is no longer a silent no-op. The button
 *          is disabled (aria-disabled true via the `disabled` attribute) when
 *          the input is empty/whitespace, AND createCategory() shows a toast
 *          error if the Enter-key path is hit on an empty input (keyboard /
 *          screen-reader users who can't see the disabled styling).
 *
 * Backend contracts touched (unchanged by this fix; pinned for completeness):
 *   GET    /api/knowledge-base/categories          → bare array of category rows
 *   GET    /api/knowledge-base/articles            → bare array of article rows
 *   POST   /api/knowledge-base/articles/:id/publish → single updated article
 *   POST   /api/knowledge-base/categories          → single created category
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

// Stable notify object so useCallback identity inside the component stays
// stable across renders (the standing RTL rule from the 2026-05-07 wave
// catalogue — fresh-objects-per-call infinite-loop pattern).
const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyObj = {
  error: notifyError,
  info: vi.fn(),
  success: notifySuccess,
  confirm: () => Promise.resolve(true),
  prompt: () => Promise.resolve(''),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
  NotifyProvider: ({ children }) => children,
}));

import { AuthContext } from '../App';
import KnowledgeBase from '../pages/KnowledgeBase';

const ADMIN_USER = { userId: 1, name: 'Admin', email: 'a@x.com', role: 'ADMIN' };
const TENANT = { id: 1, name: 'Test Org', slug: 'test-org', vertical: 'generic' };

function makeArticle(id, { isPublished = false, title = `Article ${id}`, categoryId = null } = {}) {
  return {
    id,
    title,
    slug: `article-${id}`,
    content: `Body of article ${id}`,
    categoryId,
    isPublished,
    views: 0,
    updatedAt: '2026-05-14T10:00:00.000Z',
  };
}

function renderKB() {
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={{ user: ADMIN_USER, token: 'tk', tenant: TENANT, loading: false }}>
        <KnowledgeBase />
      </AuthContext.Provider>
    </MemoryRouter>
  );
}

describe('KnowledgeBase — #722 header count stays consistent after publish', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifySuccess.mockReset();
  });

  it('renders the header with correct count + plural form on initial load (10 articles)', async () => {
    const articles = Array.from({ length: 10 }, (_, i) =>
      makeArticle(i + 1, { isPublished: i < 8 }) // 8 published, 2 drafts
    );
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/knowledge-base/categories') return Promise.resolve([]);
      if (url === '/api/knowledge-base/articles') return Promise.resolve(articles);
      return Promise.resolve({});
    });
    renderKB();
    await waitFor(() => {
      expect(screen.getByText(/10 articles/)).toBeInTheDocument();
    });
    // Plural form (not "10 article")
    // No "10 article" (singular) — pluralization must use "articles"
    expect(screen.queryByText(/^10 article ·/)).not.toBeInTheDocument();
  });

  it('renders singular "1 article" form when exactly one article exists', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/knowledge-base/categories') return Promise.resolve([]);
      if (url === '/api/knowledge-base/articles') return Promise.resolve([makeArticle(1)]);
      return Promise.resolve({});
    });
    renderKB();
    await waitFor(() => {
      expect(screen.getByText(/1 article/)).toBeInTheDocument();
    });
    // Pluralization guard — must NOT say "1 articles"
    const header = screen.getByText(/1 article/);
    expect(header.textContent).toMatch(/1 article ·/);
    expect(header.textContent).not.toMatch(/1 articles/);
  });

  it('renders "0 articles" when the article list is empty (plural — there is no "0 article")', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/knowledge-base/categories') return Promise.resolve([]);
      if (url === '/api/knowledge-base/articles') return Promise.resolve([]);
      return Promise.resolve({});
    });
    renderKB();
    await waitFor(() => {
      expect(screen.getByText(/0 articles/)).toBeInTheDocument();
    });
  });

  it('header count stays in sync with status-tab counts after publish (await loadAll race fix)', async () => {
    // Initial: 10 articles, 8 published / 2 drafts.
    let articles = Array.from({ length: 10 }, (_, i) =>
      makeArticle(i + 1, { isPublished: i < 8 })
    );
    // After publishing the second draft (id=10): 11 effective articles in the
    // test? No — actually the issue scenario was 11 = 10 + 1 newly-created.
    // We simulate the post-publish refetch returning 11 articles, 9 published.
    const articlesAfterPublish = [
      ...articles.map((a) => (a.id === 10 ? { ...a, isPublished: true } : a)),
      makeArticle(11, { isPublished: false }), // simulating the "just created"
    ];

    let articleListResponses = [articles, articlesAfterPublish];
    let callCount = 0;
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/knowledge-base/categories') return Promise.resolve([]);
      if (url === '/api/knowledge-base/articles') {
        const idx = Math.min(callCount, articleListResponses.length - 1);
        callCount += 1;
        return Promise.resolve(articleListResponses[idx]);
      }
      if (url.endsWith('/publish')) {
        return Promise.resolve({ ...articles[9], isPublished: true });
      }
      return Promise.resolve({});
    });

    renderKB();
    await waitFor(() => {
      expect(screen.getByText(/10 articles/)).toBeInTheDocument();
    });
    expect(screen.getByText(/8 Published/)).toBeInTheDocument();
    expect(screen.getByText(/2 Drafts/)).toBeInTheDocument();

    // Click Publish on the first draft (article id 9 is the first draft —
    // articles 0..7 are published in the seed). togglePublish flips it.
    const publishButtons = screen.getAllByText(/^Publish$/);
    expect(publishButtons.length).toBeGreaterThan(0);

    await act(async () => {
      fireEvent.click(publishButtons[0]);
      // Let the await chain (POST + await loadAll) settle
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByText(/11 articles/)).toBeInTheDocument();
    });
    // And tabs + sidebar count match (the canonical "stay consistent" claim)
    expect(screen.getByText(/9 Published/)).toBeInTheDocument();
    // Notification confirms publish landed
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/published successfully/i),
    );
  });
});

describe('KnowledgeBase — #723 empty-category submit is no longer silent', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifySuccess.mockReset();
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/knowledge-base/categories') return Promise.resolve([]);
      if (url === '/api/knowledge-base/articles') return Promise.resolve([]);
      return Promise.resolve({});
    });
  });

  it('disables the "+" button when the new-category input is empty', async () => {
    renderKB();
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/New category…/i)).toBeInTheDocument();
    });
    // The "+" button is the create-category button next to the input. We
    // identify it by aria-label so the test isn't coupled to icon DOM.
    const btn = screen.getByLabelText(/Create category/i);
    expect(btn).toBeDisabled();
  });

  it('enables the "+" button once the input has non-whitespace content', async () => {
    renderKB();
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/New category…/i)).toBeInTheDocument();
    });
    const input = screen.getByPlaceholderText(/New category…/i);
    fireEvent.change(input, { target: { value: 'FAQ' } });
    const btn = screen.getByLabelText(/Create category/i);
    expect(btn).not.toBeDisabled();
  });

  it('keeps the "+" button disabled on whitespace-only input', async () => {
    renderKB();
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/New category…/i)).toBeInTheDocument();
    });
    const input = screen.getByPlaceholderText(/New category…/i);
    fireEvent.change(input, { target: { value: '   ' } });
    const btn = screen.getByLabelText(/Create category/i);
    expect(btn).toBeDisabled();
  });

  it('Enter-key on an empty input shows an error toast instead of silently no-op-ing', async () => {
    renderKB();
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/New category…/i)).toBeInTheDocument();
    });
    const input = screen.getByPlaceholderText(/New category…/i);
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    expect(notifyError).toHaveBeenCalledWith(
      expect.stringMatching(/enter a category name/i),
    );
    // No POST should fire on an empty submit
    const postCalls = fetchApiMock.mock.calls.filter(
      (c) => c[1]?.method === 'POST'
    );
    expect(postCalls).toHaveLength(0);
  });

  it('Enter-key on a populated input fires the POST without an error toast', async () => {
    renderKB();
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/New category…/i)).toBeInTheDocument();
    });
    const input = screen.getByPlaceholderText(/New category…/i);
    fireEvent.change(input, { target: { value: 'Billing' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
      await Promise.resolve();
    });
    const postCalls = fetchApiMock.mock.calls.filter(
      (c) => c[0] === '/api/knowledge-base/categories' && c[1]?.method === 'POST'
    );
    expect(postCalls).toHaveLength(1);
    expect(JSON.parse(postCalls[0][1].body)).toEqual({ name: 'Billing' });
    expect(notifyError).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ *
 * Extension wave — broad surface coverage for the 1027-LOC SUT.
 *
 * Pins the loaded-list / categories-tree / edit-modal / create-modal /
 * delete-confirm / search-filter / empty / loading / error contracts.
 * Stable mock-object pattern (per the 2026-05-23 RTL standing rule) —
 * notifyObj has ONE reference for the whole module so useCallback
 * identity inside the SUT stays stable.
 * ------------------------------------------------------------------ */

describe('KnowledgeBase — extended surface coverage', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifySuccess.mockReset();
  });

  // -------- 1) Loaded articles list --------
  it('renders the articles table with one row per article (title + status badge)', async () => {
    const articles = [
      makeArticle(101, { title: 'How to reset password', isPublished: true }),
      makeArticle(102, { title: 'Setting up SSO', isPublished: false }),
      makeArticle(103, { title: 'Billing FAQ', isPublished: true }),
    ];
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/knowledge-base/categories') return Promise.resolve([]);
      if (url === '/api/knowledge-base/articles') return Promise.resolve(articles);
      return Promise.resolve({});
    });
    renderKB();
    await waitFor(() => {
      expect(screen.getByText('How to reset password')).toBeInTheDocument();
    });
    expect(screen.getByText('Setting up SSO')).toBeInTheDocument();
    expect(screen.getByText('Billing FAQ')).toBeInTheDocument();
    // Two distinct status badges — "Published" appears twice (2 published rows),
    // "Draft" appears once. Use getAllByText for the duplicate per RTL rule.
    const publishedBadges = screen.getAllByText(/^Published$/);
    expect(publishedBadges.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/^Draft$/)).toBeInTheDocument();
  });

  // -------- 2) Category tree renders --------
  it('renders all category rows in the left tree with their article counts', async () => {
    const categories = [
      { id: 11, name: 'Getting Started', articleCount: 4 },
      { id: 12, name: 'Billing', articleCount: 2 },
      { id: 13, name: 'Troubleshooting', articleCount: 7 },
    ];
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/knowledge-base/categories') return Promise.resolve(categories);
      if (url === '/api/knowledge-base/articles') return Promise.resolve([]);
      return Promise.resolve({});
    });
    renderKB();
    await waitFor(() => {
      expect(screen.getByText('Getting Started')).toBeInTheDocument();
    });
    expect(screen.getByText('Billing')).toBeInTheDocument();
    expect(screen.getByText('Troubleshooting')).toBeInTheDocument();
    // Article counts shown next to category names — '4', '2', '7' should all appear
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    // "All Articles" pseudo-category at the top — appears in BOTH the sidebar
    // AND the right-pane heading (h3), so allow either to match per RTL rule.
    const allArticlesHits = screen.getAllByText(/^All Articles$/);
    expect(allArticlesHits.length).toBeGreaterThanOrEqual(1);
  });

  // -------- 3) Click category → filters the article list --------
  it('clicking a category filters the article table to that category', async () => {
    const categories = [
      { id: 21, name: 'Getting Started', articleCount: 1 },
      { id: 22, name: 'Billing', articleCount: 1 },
    ];
    const articles = [
      makeArticle(201, { title: 'Welcome guide', categoryId: 21, isPublished: true }),
      makeArticle(202, { title: 'Invoice setup', categoryId: 22, isPublished: true }),
    ];
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/knowledge-base/categories') return Promise.resolve(categories);
      if (url === '/api/knowledge-base/articles') return Promise.resolve(articles);
      return Promise.resolve({});
    });
    renderKB();
    await waitFor(() => {
      expect(screen.getByText('Welcome guide')).toBeInTheDocument();
    });
    expect(screen.getByText('Invoice setup')).toBeInTheDocument();

    // Click the "Billing" category in the sidebar. The label may also appear
    // in the right-pane table's Category column for matching rows, so use
    // getAllByText and click the first match (sidebar comes first in DOM).
    const billingHits = screen.getAllByText('Billing');
    fireEvent.click(billingHits[0]);

    // After click, only Billing's article should remain in the table.
    await waitFor(() => {
      expect(screen.queryByText('Welcome guide')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Invoice setup')).toBeInTheDocument();
    // Heading switches to "Articles in \"Billing\""
    expect(screen.getByText(/Articles in "Billing"/i)).toBeInTheDocument();
  });

  // -------- 4) Edit-article modal opens + submits PUT --------
  it('clicking Edit opens the edit form pre-filled and submitting fires PUT', async () => {
    const articles = [
      makeArticle(301, { title: 'Existing article', isPublished: false }),
    ];
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/knowledge-base/categories') return Promise.resolve([]);
      if (url === '/api/knowledge-base/articles') return Promise.resolve(articles);
      if (url === '/api/knowledge-base/articles/301' && opts?.method === 'PUT') {
        return Promise.resolve({ ...articles[0], title: 'Updated title' });
      }
      return Promise.resolve({});
    });
    renderKB();
    await waitFor(() => {
      expect(screen.getByText('Existing article')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText(/^Edit$/));
    // Edit form header appears
    await waitFor(() => {
      expect(screen.getByText(/Edit Article/i)).toBeInTheDocument();
    });
    // Title input pre-filled
    const titleInput = screen.getByDisplayValue('Existing article');
    expect(titleInput).toBeInTheDocument();
    // Change the title + submit
    fireEvent.change(titleInput, { target: { value: 'Updated title' } });

    await act(async () => {
      fireEvent.click(screen.getByText(/Save Changes/i));
      await Promise.resolve();
      await Promise.resolve();
    });

    const putCalls = fetchApiMock.mock.calls.filter(
      (c) => c[0] === '/api/knowledge-base/articles/301' && c[1]?.method === 'PUT'
    );
    expect(putCalls).toHaveLength(1);
    const body = JSON.parse(putCalls[0][1].body);
    expect(body.title).toBe('Updated title');
  });

  // -------- 5) Create-article modal: required validation --------
  it('submitting the New Article form with empty title shows error toast and skips POST', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/knowledge-base/categories') return Promise.resolve([]);
      if (url === '/api/knowledge-base/articles') return Promise.resolve([]);
      return Promise.resolve({});
    });
    renderKB();
    await waitFor(() => {
      // The top-right CTA is a <button> with role="button". Use role query so
      // we don't collide with the form heading (h3) that also says "New Article".
      expect(screen.getByRole('button', { name: /New Article/i })).toBeInTheDocument();
    });
    // Click the top-right "New Article" button to open the create form
    fireEvent.click(screen.getByRole('button', { name: /New Article/i }));
    // The form submit button reads "Create Article" once the editor is open
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Create Article/i })).toBeInTheDocument();
    });
    // Locate the form element (only one form on the page when editor is open)
    const form = document.querySelector('form');
    expect(form).toBeTruthy();
    // Required HTML5 validation on the title input would prevent submit via
    // the button, but saveArticle() also explicitly validates form.title.trim().
    // Bypass the HTML5 layer by firing the submit event directly so we can
    // assert the JS-level guard fires.
    await act(async () => {
      fireEvent.submit(form);
      await Promise.resolve();
    });
    expect(notifyError).toHaveBeenCalledWith(
      expect.stringMatching(/title is required/i),
    );
    const postCalls = fetchApiMock.mock.calls.filter(
      (c) => c[0] === '/api/knowledge-base/articles' && c[1]?.method === 'POST'
    );
    expect(postCalls).toHaveLength(0);
  });

  // -------- 5b) Create-article happy path POST --------
  it('submitting the New Article form with a filled title fires POST', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/knowledge-base/categories') return Promise.resolve([]);
      if (url === '/api/knowledge-base/articles' && (!opts || !opts.method)) {
        return Promise.resolve([]);
      }
      if (url === '/api/knowledge-base/articles' && opts?.method === 'POST') {
        return Promise.resolve({ id: 999, title: 'Brand new' });
      }
      return Promise.resolve({});
    });
    renderKB();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /New Article/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /New Article/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Create Article/i })).toBeInTheDocument();
    });
    const titleInput = screen.getByPlaceholderText(/How to reset your password/i);
    fireEvent.change(titleInput, { target: { value: 'Brand new' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Create Article/i }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const postCalls = fetchApiMock.mock.calls.filter(
      (c) => c[0] === '/api/knowledge-base/articles' && c[1]?.method === 'POST'
    );
    expect(postCalls).toHaveLength(1);
    const body = JSON.parse(postCalls[0][1].body);
    expect(body.title).toBe('Brand new');
  });

  // -------- 6) Delete-article confirm + fire DELETE --------
  it('clicking Delete calls notify.confirm and fires DELETE on confirmation', async () => {
    const articles = [makeArticle(401, { title: 'Doomed article', isPublished: false })];
    const confirmSpy = vi.fn(() => Promise.resolve(true));
    notifyObj.confirm = confirmSpy;
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/knowledge-base/categories') return Promise.resolve([]);
      if (url === '/api/knowledge-base/articles' && (!opts || !opts.method)) {
        return Promise.resolve(articles);
      }
      if (url === '/api/knowledge-base/articles/401' && opts?.method === 'DELETE') {
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });
    renderKB();
    await waitFor(() => {
      expect(screen.getByText('Doomed article')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText(/^Delete$/));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(confirmSpy).toHaveBeenCalled();
    const deleteCalls = fetchApiMock.mock.calls.filter(
      (c) => c[0] === '/api/knowledge-base/articles/401' && c[1]?.method === 'DELETE'
    );
    expect(deleteCalls).toHaveLength(1);
    // Restore default confirm for sibling tests
    notifyObj.confirm = () => Promise.resolve(true);
  });

  it('clicking Delete and rejecting the confirm does NOT fire DELETE', async () => {
    const articles = [makeArticle(402, { title: 'Survivor article', isPublished: false })];
    notifyObj.confirm = () => Promise.resolve(false);
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/knowledge-base/categories') return Promise.resolve([]);
      if (url === '/api/knowledge-base/articles') return Promise.resolve(articles);
      return Promise.resolve({});
    });
    renderKB();
    await waitFor(() => {
      expect(screen.getByText('Survivor article')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText(/^Delete$/));
      await Promise.resolve();
      await Promise.resolve();
    });

    const deleteCalls = fetchApiMock.mock.calls.filter(
      (c) => c[1]?.method === 'DELETE'
    );
    expect(deleteCalls).toHaveLength(0);
    // Restore default
    notifyObj.confirm = () => Promise.resolve(true);
  });

  // -------- 7) Status-filter (Drafts / Published) acts like a search/filter --------
  it('clicking the Drafts pill filters the article list to drafts only', async () => {
    const articles = [
      makeArticle(501, { title: 'Live one', isPublished: true }),
      makeArticle(502, { title: 'Live two', isPublished: true }),
      makeArticle(503, { title: 'Hidden draft', isPublished: false }),
    ];
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/knowledge-base/categories') return Promise.resolve([]);
      if (url === '/api/knowledge-base/articles') return Promise.resolve(articles);
      return Promise.resolve({});
    });
    renderKB();
    await waitFor(() => {
      expect(screen.getByText('Live one')).toBeInTheDocument();
    });
    // Click Drafts pill
    fireEvent.click(screen.getByText(/1 Drafts/));
    await waitFor(() => {
      expect(screen.queryByText('Live one')).not.toBeInTheDocument();
    });
    expect(screen.queryByText('Live two')).not.toBeInTheDocument();
    expect(screen.getByText('Hidden draft')).toBeInTheDocument();
  });

  // -------- 8) Empty state --------
  it('renders the empty state when there are zero articles', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/knowledge-base/categories') return Promise.resolve([]);
      if (url === '/api/knowledge-base/articles') return Promise.resolve([]);
      return Promise.resolve({});
    });
    renderKB();
    await waitFor(() => {
      expect(screen.getByText(/No articles yet/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/Click "New Article" to create one/i)).toBeInTheDocument();
  });

  // -------- 9) Loading state — "Saving…" label on the submit button --------
  it('shows "Saving…" on the submit button while the POST is in flight', async () => {
    let resolvePost;
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/knowledge-base/categories') return Promise.resolve([]);
      if (url === '/api/knowledge-base/articles' && (!opts || !opts.method)) {
        return Promise.resolve([]);
      }
      if (url === '/api/knowledge-base/articles' && opts?.method === 'POST') {
        return new Promise((resolve) => {
          resolvePost = () => resolve({ id: 1, title: 'X' });
        });
      }
      return Promise.resolve({});
    });
    renderKB();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /New Article/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /New Article/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Create Article/i })).toBeInTheDocument();
    });
    const titleInput = screen.getByPlaceholderText(/How to reset your password/i);
    fireEvent.change(titleInput, { target: { value: 'Pending' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Create Article/i }));
      await Promise.resolve();
    });

    // While the POST is pending the button text flips to "Saving…"
    await waitFor(() => {
      expect(screen.getByText(/Saving…/)).toBeInTheDocument();
    });

    // Resolve the POST so the test cleans up without dangling promises
    await act(async () => {
      resolvePost();
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  // -------- 10) Error state — POST failure toasts via notify.error --------
  it('toasts "Failed to save article" when the create POST rejects', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/knowledge-base/categories') return Promise.resolve([]);
      if (url === '/api/knowledge-base/articles' && (!opts || !opts.method)) {
        return Promise.resolve([]);
      }
      if (url === '/api/knowledge-base/articles' && opts?.method === 'POST') {
        return Promise.reject(new Error('500: server boom'));
      }
      return Promise.resolve({});
    });
    renderKB();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /New Article/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /New Article/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Create Article/i })).toBeInTheDocument();
    });
    const titleInput = screen.getByPlaceholderText(/How to reset your password/i);
    fireEvent.change(titleInput, { target: { value: 'Will fail' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Create Article/i }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(notifyError).toHaveBeenCalledWith(
      expect.stringMatching(/failed to save article/i),
    );
  });

  // -------- 11) Cancel button closes the editor --------
  it('Cancel button on the editor returns to the list view without saving', async () => {
    const articles = [makeArticle(601, { title: 'Keep me', isPublished: true })];
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/knowledge-base/categories') return Promise.resolve([]);
      if (url === '/api/knowledge-base/articles') return Promise.resolve(articles);
      return Promise.resolve({});
    });
    renderKB();
    await waitFor(() => {
      expect(screen.getByText('Keep me')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText(/^Edit$/));
    await waitFor(() => {
      expect(screen.getByText(/Edit Article/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText(/Cancel/i));
    // Back to the list — the article row title is visible again, and the
    // "Edit Article" form heading is gone
    await waitFor(() => {
      expect(screen.queryByText(/Edit Article/i)).not.toBeInTheDocument();
    });
    expect(screen.getByText('Keep me')).toBeInTheDocument();
    // No PUT call should have fired
    const putCalls = fetchApiMock.mock.calls.filter((c) => c[1]?.method === 'PUT');
    expect(putCalls).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * 2026-05-26 extension wave — fills gaps not covered above:
 *   - Category DELETE (confirm + cancel + selected-category reset)
 *   - Unpublish round-trip (toggling from published → draft)
 *   - Total-views aggregation across articles
 *   - Public article link only renders for PUBLISHED rows + uses
 *     /kb/<tenant-slug>/<article-slug> path
 *   - Tenant-name prefix in the page header
 *   - Status-filter toggle round-trip (click Published twice → filter clears)
 *   - Category select inside the edit form lists categories + "Uncategorized"
 *   - Non-array API responses are handled defensively (no crash)
 *   - Slug field only renders in edit-mode, not in new-article mode
 * Stable mock-object pattern (per the 2026-05-23 RTL standing rule).
 * ------------------------------------------------------------------ */

describe('KnowledgeBase — category CRUD + unpublish + portal + defensive coverage', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifySuccess.mockReset();
    // Restore default confirm in case an earlier describe swapped it
    notifyObj.confirm = () => Promise.resolve(true);
  });

  // -------- 12) Category DELETE — confirmed path fires DELETE --------
  it('clicking the category trash icon fires DELETE on confirmation', async () => {
    const confirmSpy = vi.fn(() => Promise.resolve(true));
    notifyObj.confirm = confirmSpy;
    const categories = [{ id: 71, name: 'To-Be-Deleted', articleCount: 0 }];
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/knowledge-base/categories' && (!opts || !opts.method)) {
        return Promise.resolve(categories);
      }
      if (url === '/api/knowledge-base/articles') return Promise.resolve([]);
      if (url === '/api/knowledge-base/categories/71' && opts?.method === 'DELETE') {
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });
    renderKB();
    await waitFor(() => {
      expect(screen.getByText('To-Be-Deleted')).toBeInTheDocument();
    });
    const trashBtn = screen.getByTitle(/Delete category/i);
    await act(async () => {
      fireEvent.click(trashBtn);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(confirmSpy).toHaveBeenCalled();
    const deleteCalls = fetchApiMock.mock.calls.filter(
      (c) => c[0] === '/api/knowledge-base/categories/71' && c[1]?.method === 'DELETE'
    );
    expect(deleteCalls).toHaveLength(1);
  });

  // -------- 13) Category DELETE — rejected confirm skips the call --------
  it('cancelling the category-delete confirm does NOT fire DELETE', async () => {
    notifyObj.confirm = () => Promise.resolve(false);
    const categories = [{ id: 72, name: 'Survivor-Cat', articleCount: 3 }];
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/knowledge-base/categories') return Promise.resolve(categories);
      if (url === '/api/knowledge-base/articles') return Promise.resolve([]);
      return Promise.resolve({});
    });
    renderKB();
    await waitFor(() => {
      expect(screen.getByText('Survivor-Cat')).toBeInTheDocument();
    });
    const trashBtn = screen.getByTitle(/Delete category/i);
    await act(async () => {
      fireEvent.click(trashBtn);
      await Promise.resolve();
      await Promise.resolve();
    });
    const deleteCalls = fetchApiMock.mock.calls.filter(
      (c) => c[1]?.method === 'DELETE'
    );
    expect(deleteCalls).toHaveLength(0);
  });

  // -------- 14) Unpublish round-trip — published → draft flips status --------
  it('clicking Unpublish on a published article fires POST /unpublish + toasts', async () => {
    const articles = [makeArticle(801, { title: 'Already live', isPublished: true })];
    const articlesAfter = [{ ...articles[0], isPublished: false }];
    let articleCalls = 0;
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/knowledge-base/categories') return Promise.resolve([]);
      if (url === '/api/knowledge-base/articles' && (!opts || !opts.method)) {
        const payload = articleCalls === 0 ? articles : articlesAfter;
        articleCalls += 1;
        return Promise.resolve(payload);
      }
      if (url === '/api/knowledge-base/articles/801/unpublish' && opts?.method === 'POST') {
        return Promise.resolve(articlesAfter[0]);
      }
      return Promise.resolve({});
    });
    renderKB();
    await waitFor(() => {
      expect(screen.getByText('Already live')).toBeInTheDocument();
    });
    expect(screen.getByText(/^Unpublish$/)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByText(/^Unpublish$/));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const unpublishCalls = fetchApiMock.mock.calls.filter(
      (c) => c[0] === '/api/knowledge-base/articles/801/unpublish' && c[1]?.method === 'POST'
    );
    expect(unpublishCalls).toHaveLength(1);
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/unpublished successfully/i),
    );
  });

  // -------- 15) Total views stat aggregates across all articles --------
  it('stats bar displays sum of views across all articles (toLocaleString-formatted)', async () => {
    const articles = [
      { ...makeArticle(901, { isPublished: true }), views: 1200 },
      { ...makeArticle(902, { isPublished: true }), views: 250 },
      { ...makeArticle(903, { isPublished: false }), views: 50 },
    ];
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/knowledge-base/categories') return Promise.resolve([]);
      if (url === '/api/knowledge-base/articles') return Promise.resolve(articles);
      return Promise.resolve({});
    });
    renderKB();
    // 1200 + 250 + 50 = 1500 → "1,500" via toLocaleString
    await waitFor(() => {
      expect(screen.getByText(/1,500 total views/)).toBeInTheDocument();
    });
  });

  // -------- 16) Public View link renders only for published articles --------
  it('public View link renders for published articles but not for drafts', async () => {
    const articles = [
      makeArticle(1001, { title: 'Live article', isPublished: true }),
      makeArticle(1002, { title: 'Hidden draft', isPublished: false }),
    ];
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/knowledge-base/categories') return Promise.resolve([]);
      if (url === '/api/knowledge-base/articles') return Promise.resolve(articles);
      return Promise.resolve({});
    });
    renderKB();
    await waitFor(() => {
      expect(screen.getByText('Live article')).toBeInTheDocument();
    });
    // The published article row has an <a> with title "View public article".
    // (The /^View$/ text also matches a <strong>View</strong> in the portal-info
    // card explanation, so we target the link via its title attribute.)
    const anchor = screen.getByTitle(/View public article/i);
    expect(anchor.tagName).toBe('A');
    expect(anchor.getAttribute('href')).toBe('/kb/test-org/article-1001');
    expect(anchor.getAttribute('target')).toBe('_blank');
    // Only one such anchor — the draft row does NOT render a View link
    const allAnchors = document.querySelectorAll('a[title="View public article"]');
    expect(allAnchors).toHaveLength(1);
  });

  // -------- 17) Tenant name appears in the page header --------
  it('renders "<TenantName> Knowledge Base" header when tenant.name is set', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/knowledge-base/categories') return Promise.resolve([]);
      if (url === '/api/knowledge-base/articles') return Promise.resolve([]);
      return Promise.resolve({});
    });
    renderKB();
    // TENANT is { name: 'Test Org', ... } per the module-top constant
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: /Test Org Knowledge Base/i }),
      ).toBeInTheDocument();
    });
  });

  // -------- 18) Status filter pill round-trips off on a second click --------
  it('clicking the Published pill toggles the published filter ON then OFF', async () => {
    const articles = [
      makeArticle(1101, { title: 'Pub one', isPublished: true }),
      makeArticle(1102, { title: 'Pub two', isPublished: true }),
      makeArticle(1103, { title: 'Draft uno', isPublished: false }),
    ];
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/knowledge-base/categories') return Promise.resolve([]);
      if (url === '/api/knowledge-base/articles') return Promise.resolve(articles);
      return Promise.resolve({});
    });
    renderKB();
    await waitFor(() => {
      expect(screen.getByText('Pub one')).toBeInTheDocument();
    });
    // All three visible initially
    expect(screen.getByText('Draft uno')).toBeInTheDocument();

    // First click — filter to published only
    fireEvent.click(screen.getByText(/2 Published/));
    await waitFor(() => {
      expect(screen.queryByText('Draft uno')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Pub one')).toBeInTheDocument();

    // Second click — clears the filter, draft visible again
    fireEvent.click(screen.getByText(/2 Published/));
    await waitFor(() => {
      expect(screen.getByText('Draft uno')).toBeInTheDocument();
    });
    expect(screen.getByText('Pub one')).toBeInTheDocument();
  });

  // -------- 19) Edit form's Category <select> lists categories + Uncategorized --------
  it('edit-form Category select contains "Uncategorized" plus every loaded category', async () => {
    const categories = [
      { id: 1201, name: 'FAQ', articleCount: 1 },
      { id: 1202, name: 'How-To', articleCount: 0 },
    ];
    const articles = [makeArticle(1210, { title: 'Editable', categoryId: 1201, isPublished: false })];
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/knowledge-base/categories') return Promise.resolve(categories);
      if (url === '/api/knowledge-base/articles') return Promise.resolve(articles);
      return Promise.resolve({});
    });
    renderKB();
    await waitFor(() => {
      expect(screen.getByText('Editable')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText(/^Edit$/));
    await waitFor(() => {
      expect(screen.getByText(/Edit Article/i)).toBeInTheDocument();
    });
    // The select has three options — Uncategorized, FAQ, How-To
    const uncategorizedOpt = screen.getByRole('option', { name: /Uncategorized/i });
    expect(uncategorizedOpt).toBeInTheDocument();
    const faqOpt = screen.getByRole('option', { name: /^FAQ$/ });
    expect(faqOpt).toBeInTheDocument();
    const howToOpt = screen.getByRole('option', { name: /^How-To$/ });
    expect(howToOpt).toBeInTheDocument();
  });

  // -------- 20) Non-array API responses are handled defensively --------
  it('does not crash when /categories or /articles return a non-array payload', async () => {
    // Simulate a backend regression returning { error: '...' } instead of []
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/knowledge-base/categories') {
        return Promise.resolve({ error: 'unauthorized' });
      }
      if (url === '/api/knowledge-base/articles') {
        return Promise.resolve(null);
      }
      return Promise.resolve({});
    });
    renderKB();
    // No crash + empty-state renders (0 articles + empty categories list)
    await waitFor(() => {
      expect(screen.getByText(/0 articles/)).toBeInTheDocument();
    });
    expect(screen.getByText(/No articles yet/i)).toBeInTheDocument();
    // The header CTA is still present (page hasn't blown up)
    expect(screen.getByRole('button', { name: /New Article/i })).toBeInTheDocument();
  });

  // -------- 21) Slug field only appears in edit-mode, not new-article mode --------
  it('Slug field appears in edit-mode but is hidden in new-article mode', async () => {
    const articles = [makeArticle(1301, { title: 'Has slug', isPublished: false })];
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/knowledge-base/categories') return Promise.resolve([]);
      if (url === '/api/knowledge-base/articles') return Promise.resolve(articles);
      return Promise.resolve({});
    });
    renderKB();
    await waitFor(() => {
      expect(screen.getByText('Has slug')).toBeInTheDocument();
    });

    // New-article mode — no Slug field
    fireEvent.click(screen.getByRole('button', { name: /New Article/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Create Article/i })).toBeInTheDocument();
    });
    expect(screen.queryByPlaceholderText(/auto-generated from title/i)).not.toBeInTheDocument();

    // Cancel + open edit-mode — Slug field IS rendered (pre-filled from article.slug).
    // After cancel the form is gone; the table row is visible again. We detect
    // the return-to-list state by the absence of the "Create Article" submit
    // button (which only renders inside the new-article form).
    fireEvent.click(screen.getByText(/Cancel/i));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Create Article/i })).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByText(/^Edit$/));
    await waitFor(() => {
      expect(screen.getByText(/Edit Article/i)).toBeInTheDocument();
    });
    const slugInput = screen.getByPlaceholderText(/auto-generated from title/i);
    expect(slugInput).toBeInTheDocument();
    expect(slugInput.value).toBe('article-1301');
  });
});
