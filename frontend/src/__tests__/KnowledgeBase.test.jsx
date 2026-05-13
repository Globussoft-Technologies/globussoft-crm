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
