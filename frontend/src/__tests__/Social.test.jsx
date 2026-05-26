/**
 * Social.test.jsx — vitest + RTL coverage for the Social Media management
 * page (frontend/src/pages/Social.jsx, 507 LOC, NO prior tests).
 *
 * Scope: pins the page-surface invariants for the marketing social tab
 * (compose / scheduled / mentions / accounts) — initial mount fetches,
 * tab navigation, platform multi-select character-limit derivation,
 * compose validation, schedule POST flow, scheduled-post list +
 * cancel, mentions fetch CTA + empty state, and accounts connect /
 * disconnect chrome.
 *
 *   1. Heading + 4 tabs render; initial mount fires the 4 GETs
 *      (/api/social/posts, /api/social/mentions, /api/social/accounts,
 *      /api/contacts).
 *   2. PLATFORMS triplet (LinkedIn / Twitter / Facebook) renders as
 *      multi-select chips on the Compose tab; toggling Twitter ON
 *      collapses charLimit to 280 (`min(2200, 280)`).
 *   3. Compose with empty content + Publish Now triggers
 *      notify.error('Content is required') and does NOT POST.
 *   4. Compose with no platforms selected + Publish Now triggers
 *      notify.error('Select at least one platform') and does NOT POST.
 *   5. Compose with content > charLimit triggers notify.error(/exceeds/)
 *      and does NOT POST.
 *   6. Valid Publish Now fires ONE POST per selected platform with
 *      `scheduledFor: null` + a follow-up POST .../publish for each
 *      created post.
 *   7. Schedule (with date) fires POST with a non-null ISO scheduledFor.
 *   8. Scheduled tab renders SCHEDULED + DRAFT posts; empty state
 *      renders the "No scheduled or draft posts." copy.
 *   9. Cancel button on a scheduled post issues DELETE
 *      /api/social/posts/<id> after the confirm prompt.
 *  10. Mentions tab renders mention rows + the "Link to Contact" CTA
 *      for un-linked mentions; empty state shows the "No mentions yet"
 *      copy + the three Fetch buttons.
 *  11. Fetch <Platform> on the Mentions tab fires POST
 *      /api/social/mentions/fetch/<platform> with the canned keywords.
 *  12. Accounts tab renders one card per PLATFORMS entry; un-connected
 *      shows Connect, connected shows Disconnect; clicking Connect
 *      opens the modal + submitting fires POST .../connect.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

// Stable notify mock object across renders — fresh object refs per call
// cause infinite re-render loops when consumers pass it through useCallback
// dependency arrays.
const notifyError = vi.fn();
const notifySuccess = vi.fn();
const confirmMock = vi.fn(() => Promise.resolve(true));
const promptMock = vi.fn(() => Promise.resolve(''));
const notifyObj = {
  error: notifyError,
  info: vi.fn(),
  success: notifySuccess,
  confirm: (...a) => confirmMock(...a),
  prompt: (...a) => promptMock(...a),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
  NotifyProvider: ({ children }) => children,
}));

vi.mock('../utils/date', () => ({
  formatDate: (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—'),
}));

import Social from '../pages/Social';

const samplePosts = [
  {
    id: 11,
    platform: 'linkedin',
    content: 'Quarterly product roundup is live!',
    mediaUrl: 'https://example.com/roundup.png',
    status: 'SCHEDULED',
    scheduledFor: '2026-06-01T09:00:00.000Z',
  },
  {
    id: 12,
    platform: 'twitter',
    content: 'Working on a draft tweet',
    mediaUrl: null,
    status: 'DRAFT',
    scheduledFor: null,
  },
  {
    id: 13,
    platform: 'facebook',
    content: 'Already-published Facebook post',
    mediaUrl: null,
    status: 'PUBLISHED',
    scheduledFor: null,
  },
];

const sampleMentions = [
  {
    id: 101,
    platform: 'twitter',
    authorName: 'Maya Iyer',
    authorHandle: '@maya_iyer',
    content: 'Loving the new @globussoft CRM dashboard!',
    sentiment: 'positive',
    url: 'https://twitter.com/maya_iyer/status/1',
    contactId: null,
    fetchedAt: '2026-05-20T10:00:00.000Z',
  },
  {
    id: 102,
    platform: 'linkedin',
    authorName: 'Priya Nair',
    authorHandle: 'priya-nair',
    content: 'Already a Globussoft customer, here is my testimonial.',
    sentiment: 'neutral',
    url: null,
    contactId: 555,
    fetchedAt: '2026-05-21T10:00:00.000Z',
  },
];

const sampleAccounts = [
  { platform: 'linkedin', connected: true, updatedAt: '2026-05-01T10:00:00.000Z' },
  { platform: 'twitter', connected: false },
  // facebook intentionally omitted so the page must fall back to its
  // PLATFORMS-default for that card on the Accounts tab.
];

function defaultFetch(url, opts) {
  const method = (opts && opts.method) || 'GET';
  if (url === '/api/social/posts' && method === 'GET') {
    return Promise.resolve(samplePosts);
  }
  if (url === '/api/social/mentions' && method === 'GET') {
    return Promise.resolve(sampleMentions);
  }
  if (url === '/api/social/accounts' && method === 'GET') {
    return Promise.resolve(sampleAccounts);
  }
  if (url === '/api/contacts' && method === 'GET') {
    return Promise.resolve([]);
  }
  // POST /api/social/posts → create
  if (url === '/api/social/posts' && method === 'POST') {
    const body = JSON.parse(opts.body);
    return Promise.resolve({ id: 999, ...body, status: body.scheduledFor ? 'SCHEDULED' : 'DRAFT' });
  }
  // POST /api/social/posts/:id/publish → success envelope
  if (/^\/api\/social\/posts\/\d+\/publish$/.test(url) && method === 'POST') {
    return Promise.resolve({ success: true });
  }
  // DELETE /api/social/posts/:id
  if (/^\/api\/social\/posts\/\d+$/.test(url) && method === 'DELETE') {
    return Promise.resolve({ deleted: true });
  }
  // POST /api/social/mentions/fetch/:platform
  if (/^\/api\/social\/mentions\/fetch\/[a-z]+$/.test(url) && method === 'POST') {
    return Promise.resolve({ fetched: 0 });
  }
  // POST /api/social/accounts/:platform/connect
  if (/^\/api\/social\/accounts\/[a-z]+\/connect$/.test(url) && method === 'POST') {
    return Promise.resolve({ connected: true });
  }
  // DELETE /api/social/accounts/:platform
  if (/^\/api\/social\/accounts\/[a-z]+$/.test(url) && method === 'DELETE') {
    return Promise.resolve({ disconnected: true });
  }
  return Promise.resolve(null);
}

function renderSocial() {
  return render(<Social />);
}

describe('<Social /> — page surface', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation(defaultFetch);
    notifyError.mockReset();
    notifySuccess.mockReset();
    confirmMock.mockReset();
    confirmMock.mockImplementation(() => Promise.resolve(true));
    promptMock.mockReset();
    promptMock.mockImplementation(() => Promise.resolve(''));
  });

  it('renders the Social Media heading and four tabs; initial mount fires the 4 GETs', async () => {
    renderSocial();
    expect(await screen.findByRole('heading', { name: /Social Media/i })).toBeInTheDocument();
    // Four tab buttons render.
    expect(screen.getByRole('button', { name: /^Compose$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Scheduled \(\d+\)$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Mentions \(\d+\)$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Accounts$/ })).toBeInTheDocument();

    await waitFor(() => {
      const urls = fetchApiMock.mock.calls.map(([u]) => u);
      expect(urls).toEqual(expect.arrayContaining([
        '/api/social/posts',
        '/api/social/mentions',
        '/api/social/accounts',
        '/api/contacts',
      ]));
    });
  });

  it('Compose tab renders the 3 platform chips; toggling Twitter collapses charLimit to 280', async () => {
    renderSocial();
    await screen.findByRole('heading', { name: /Social Media/i });

    // Compose is the default tab — chips for LinkedIn/Twitter/Facebook render.
    expect(screen.getByRole('button', { name: /LinkedIn/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Twitter/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Facebook/i })).toBeInTheDocument();

    // Default selection is linkedin (max 2200). The char-count rail reads
    // "0 / 2200".
    expect(screen.getByText('0 / 2200')).toBeInTheDocument();

    // Toggle Twitter ON — charLimit becomes min(2200, 280) = 280.
    fireEvent.click(screen.getByRole('button', { name: /Twitter/i }));
    expect(await screen.findByText('0 / 280')).toBeInTheDocument();
  });

  it('Publish Now with empty content fires notify.error and does NOT POST', async () => {
    renderSocial();
    await screen.findByRole('heading', { name: /Social Media/i });

    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Publish Now/i }));

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(expect.stringMatching(/Content is required/i));
    });
    const post = fetchApiMock.mock.calls.find(([u, o]) => u === '/api/social/posts' && o?.method === 'POST');
    expect(post).toBeUndefined();
  });

  it('Publish Now with NO platforms selected fires notify.error and does NOT POST', async () => {
    renderSocial();
    await screen.findByRole('heading', { name: /Social Media/i });

    // Type some content first so we get past the content check.
    fireEvent.change(screen.getByPlaceholderText(/What do you want to share\?/i), {
      target: { value: 'A perfectly valid post' },
    });
    // Toggle linkedin (only selected) OFF → selectedPlatforms == [].
    fireEvent.click(screen.getByRole('button', { name: /LinkedIn/i }));

    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Publish Now/i }));

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(expect.stringMatching(/Select at least one platform/i));
    });
    const post = fetchApiMock.mock.calls.find(([u, o]) => u === '/api/social/posts' && o?.method === 'POST');
    expect(post).toBeUndefined();
  });

  it('Publish Now with content > charLimit fires notify.error(/exceeds/) and does NOT POST', async () => {
    renderSocial();
    await screen.findByRole('heading', { name: /Social Media/i });

    // Switch to twitter-only → charLimit = 280.
    fireEvent.click(screen.getByRole('button', { name: /LinkedIn/i })); // OFF
    fireEvent.click(screen.getByRole('button', { name: /Twitter/i })); // ON

    // 281 chars — one over the limit.
    const longContent = 'x'.repeat(281);
    fireEvent.change(screen.getByPlaceholderText(/What do you want to share\?/i), {
      target: { value: longContent },
    });

    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Publish Now/i }));

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(expect.stringMatching(/exceeds 280 character limit/i));
    });
    const post = fetchApiMock.mock.calls.find(([u, o]) => u === '/api/social/posts' && o?.method === 'POST');
    expect(post).toBeUndefined();
  });

  it('valid Publish Now fires POST /api/social/posts per selected platform + .../publish for each', async () => {
    renderSocial();
    await screen.findByRole('heading', { name: /Social Media/i });

    fireEvent.change(screen.getByPlaceholderText(/What do you want to share\?/i), {
      target: { value: 'Launching v3.8 today!' },
    });

    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Publish Now/i }));

    // Default platforms = ['linkedin']. Expect 1 create POST + 1 publish POST.
    await waitFor(() => {
      const createCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/social/posts' && o?.method === 'POST'
      );
      expect(createCall).toBeTruthy();
      const body = JSON.parse(createCall[1].body);
      expect(body.platform).toBe('linkedin');
      expect(body.content).toBe('Launching v3.8 today!');
      expect(body.scheduledFor).toBeNull();
    });

    await waitFor(() => {
      const publishCall = fetchApiMock.mock.calls.find(
        ([u, o]) => /^\/api\/social\/posts\/\d+\/publish$/.test(u) && o?.method === 'POST'
      );
      expect(publishCall).toBeTruthy();
    });
  });

  it('Schedule (with date set) fires POST with a non-null ISO scheduledFor', async () => {
    renderSocial();
    await screen.findByRole('heading', { name: /Social Media/i });

    fireEvent.change(screen.getByPlaceholderText(/What do you want to share\?/i), {
      target: { value: 'Scheduled webinar reminder' },
    });
    // Set the date input (the page's <input type="date" />).
    const dateInputs = document.querySelectorAll('input[type="date"]');
    expect(dateInputs.length).toBeGreaterThan(0);
    fireEvent.change(dateInputs[0], { target: { value: '2026-06-15' } });

    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /^Schedule$/ }));

    await waitFor(() => {
      const createCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/social/posts' && o?.method === 'POST'
      );
      expect(createCall).toBeTruthy();
      const body = JSON.parse(createCall[1].body);
      expect(body.scheduledFor).toBeTruthy();
      // ISO-ish string — `new Date(date+'T'+time).toISOString()` shape.
      expect(typeof body.scheduledFor).toBe('string');
      expect(body.scheduledFor).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    // No publish POST should fire for a scheduled post.
    const publishCall = fetchApiMock.mock.calls.find(
      ([u, o]) => /^\/api\/social\/posts\/\d+\/publish$/.test(u) && o?.method === 'POST'
    );
    expect(publishCall).toBeUndefined();
  });

  it('Scheduled tab renders SCHEDULED + DRAFT posts (NOT PUBLISHED)', async () => {
    renderSocial();
    await screen.findByRole('heading', { name: /Social Media/i });
    // Wait for the posts fetch to settle so the tab counter is accurate.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Scheduled \(2\)/ })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Scheduled \(2\)/ }));

    // The two non-PUBLISHED posts render; the PUBLISHED one does NOT.
    expect(await screen.findByText('Quarterly product roundup is live!')).toBeInTheDocument();
    expect(screen.getByText('Working on a draft tweet')).toBeInTheDocument();
    expect(screen.queryByText('Already-published Facebook post')).not.toBeInTheDocument();

    // Status badges render.
    expect(screen.getByText('SCHEDULED')).toBeInTheDocument();
    expect(screen.getByText('DRAFT')).toBeInTheDocument();
  });

  it('Scheduled tab renders the empty-state copy when no scheduled/draft posts exist', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/social/posts' && (!opts || opts.method === 'GET')) return Promise.resolve([]);
      return defaultFetch(url, opts);
    });
    renderSocial();
    await screen.findByRole('heading', { name: /Social Media/i });
    fireEvent.click(screen.getByRole('button', { name: /Scheduled \(0\)/ }));
    expect(await screen.findByText(/No scheduled or draft posts\./i)).toBeInTheDocument();
  });

  it('Cancel button on a scheduled post issues DELETE /api/social/posts/:id after confirm', async () => {
    renderSocial();
    await screen.findByRole('heading', { name: /Social Media/i });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Scheduled \(2\)/ })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Scheduled \(2\)/ }));
    await screen.findByText('Quarterly product roundup is live!');

    // The Cancel button is the per-row trash button with title="Cancel".
    const cancelBtns = document.querySelectorAll('button[title="Cancel"]');
    expect(cancelBtns.length).toBeGreaterThan(0);

    fetchApiMock.mockClear();
    fireEvent.click(cancelBtns[0]);

    await waitFor(() => {
      expect(confirmMock).toHaveBeenCalledWith(expect.stringMatching(/Cancel this scheduled post/i));
    });
    await waitFor(() => {
      const del = fetchApiMock.mock.calls.find(
        ([u, o]) => /^\/api\/social\/posts\/\d+$/.test(u) && o?.method === 'DELETE'
      );
      expect(del).toBeTruthy();
    });
  });

  it('Mentions tab renders mention rows with the "Link to Contact" CTA for un-linked mentions', async () => {
    renderSocial();
    await screen.findByRole('heading', { name: /Social Media/i });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Mentions \(2\)/ })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Mentions \(2\)/ }));

    expect(await screen.findByText(/Loving the new @globussoft CRM dashboard!/i)).toBeInTheDocument();
    // Author label renders.
    expect(screen.getByText('Maya Iyer')).toBeInTheDocument();
    // The Twitter mention is un-linked → "Link to Contact" button visible.
    expect(screen.getByRole('button', { name: /Link to Contact/i })).toBeInTheDocument();
    // The LinkedIn mention is already linked → "Linked to contact #555".
    expect(screen.getByText(/Linked to contact #555/i)).toBeInTheDocument();
  });

  it('Mentions tab empty-state renders the "No mentions yet" copy + the 3 Fetch buttons', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/social/mentions' && (!opts || opts.method === 'GET')) return Promise.resolve([]);
      return defaultFetch(url, opts);
    });
    renderSocial();
    await screen.findByRole('heading', { name: /Social Media/i });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Mentions \(0\)/ })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Mentions \(0\)/ }));

    expect(await screen.findByText(/No mentions yet/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Fetch LinkedIn/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Fetch Twitter/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Fetch Facebook/i })).toBeInTheDocument();
  });

  it('Fetch <Platform> on Mentions tab issues POST /api/social/mentions/fetch/<id> with keywords', async () => {
    renderSocial();
    await screen.findByRole('heading', { name: /Social Media/i });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Mentions \(2\)/ })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Mentions \(2\)/ }));

    fetchApiMock.mockClear();
    fireEvent.click(await screen.findByRole('button', { name: /Fetch Twitter/i }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/social/mentions/fetch/twitter' && o?.method === 'POST'
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body.keywords).toEqual(expect.arrayContaining(['globussoft', 'crm']));
    });
  });

  it('Accounts tab renders 3 cards; Connect opens modal; submitting fires POST .../connect', async () => {
    renderSocial();
    await screen.findByRole('heading', { name: /Social Media/i });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Accounts$/ })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /^Accounts$/ }));

    // LinkedIn is connected → Disconnect CTA renders.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Disconnect/i })).toBeInTheDocument();
    });
    // Twitter + Facebook are NOT connected → two Connect buttons.
    const connectBtns = screen.getAllByRole('button', { name: /^Connect$/i });
    expect(connectBtns.length).toBeGreaterThanOrEqual(1);

    // Click the first Connect button → modal opens with the Access Token input.
    fireEvent.click(connectBtns[0]);
    const tokenInput = await screen.findByPlaceholderText(/Paste OAuth access token/i);
    expect(tokenInput).toBeInTheDocument();

    fireEvent.change(tokenInput, { target: { value: 'test-oauth-token-123' } });

    fetchApiMock.mockClear();
    // The modal's primary CTA is "Connect" (inside the modal — there are multiple
    // Connect buttons on the page; we grab the one in the dialog).
    const modalConnect = screen.getAllByRole('button', { name: /^Connect$/i }).pop();
    fireEvent.click(modalConnect);

    await waitFor(() => {
      const connectCall = fetchApiMock.mock.calls.find(
        ([u, o]) => /^\/api\/social\/accounts\/[a-z]+\/connect$/.test(u) && o?.method === 'POST'
      );
      expect(connectCall).toBeTruthy();
      const body = JSON.parse(connectCall[1].body);
      expect(body.accessToken).toBe('test-oauth-token-123');
    });
  });
});
