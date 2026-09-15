/**
 * TravelKnowledgeBaseAdmin.test.jsx - RTL coverage for the travel knowledge
 * base admin page. Pins the two table-section badges so the displayed row
 * counts stay aligned with the fetched jobs and files data.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
const notify = {
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
};

vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

vi.mock('../utils/notify', () => ({
  useNotify: () => notify,
}));

import { AuthContext } from '../App';
import KnowledgeBaseAdmin from '../pages/travel/KnowledgeBaseAdmin';

const ADMIN_USER = { userId: 1, name: 'Admin', email: 'admin@example.com', role: 'ADMIN' };

const JOBS = [
  {
    id: 11,
    startedAt: '2026-08-20T09:00:00.000Z',
    status: 'completed',
    filesDiscovered: 4,
    filesIndexed: 4,
    filesFailed: 0,
  },
  {
    id: 12,
    startedAt: '2026-08-20T10:00:00.000Z',
    status: 'completed',
    filesDiscovered: 2,
    filesIndexed: 2,
    filesFailed: 0,
  },
];

const FILES = [
  {
    id: 21,
    subBrand: 'tmc',
    fileName: 'brochure-a.pdf',
    folderPath: 'Brochures/tmc',
    status: 'active',
    indexedAt: '2026-08-20T09:15:00.000Z',
    driveViewLink: 'https://drive.google.com/file/d/1',
  },
  {
    id: 22,
    subBrand: 'rfu',
    fileName: 'brochure-b.pdf',
    folderPath: 'Brochures/rfu',
    status: 'active',
    indexedAt: '2026-08-20T09:30:00.000Z',
    driveViewLink: 'https://drive.google.com/file/d/2',
  },
];

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={{ user: ADMIN_USER, loading: false }}>
        <KnowledgeBaseAdmin />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notify.success.mockReset();
  notify.error.mockReset();
  notify.info.mockReset();
});

describe('<KnowledgeBaseAdmin />', () => {
  it('renders sync-job and indexed-file badges that match the loaded rows', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/travel/knowledge-base/config') {
        return Promise.resolve({ rootFolderId: 'root-folder', qdrantEnabled: true });
      }
      if (url === '/api/travel/knowledge-base/status') {
        return Promise.resolve({ stats: [], lastJob: null });
      }
      if (url === '/api/travel/knowledge-base/jobs?limit=5') {
        return Promise.resolve({ jobs: JOBS });
      }
      if (url === '/api/travel/knowledge-base/files?limit=20&offset=0') {
        return Promise.resolve({ files: FILES, total: 12 });
      }
      if (url === '/api/travel/knowledge-base/oauth/status') {
        return Promise.resolve({
          configured: true,
          connected: true,
          userInfo: { displayName: 'Admin', emailAddress: 'admin@example.com' },
          rootFolderId: 'root-folder',
        });
      }
      return Promise.resolve({});
    });

    renderPage();

    expect(await screen.findByRole('heading', { name: /Travel Brochure Library/i })).toBeInTheDocument();
    expect(screen.getByTitle('2 Total Library Updates')).toBeInTheDocument();
    expect(screen.getByTitle('12 Total Brochures In Library')).toBeInTheDocument();
    expect(screen.getByTestId('knowledge-files-pager')).toBeInTheDocument();
    expect(screen.getByText('1–12')).toBeInTheDocument();
    expect(screen.getByLabelText('Files per page')).toHaveValue('20');
  });

  it('ignores an older page response after a newer page request completes', async () => {
    const pageTwo = deferred();
    const pageThree = deferred();
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/travel/knowledge-base/config') return Promise.resolve({ rootFolderId: 'root-folder', qdrantEnabled: true });
      if (url === '/api/travel/knowledge-base/status') return Promise.resolve({ stats: [], lastJob: null });
      if (url === '/api/travel/knowledge-base/jobs?limit=5') return Promise.resolve({ jobs: [] });
      if (url === '/api/travel/knowledge-base/files?limit=20&offset=0') return Promise.resolve({ files: FILES, total: 60 });
      if (url === '/api/travel/knowledge-base/files?limit=20&offset=20') return pageTwo.promise;
      if (url === '/api/travel/knowledge-base/files?limit=20&offset=40') return pageThree.promise;
      if (url === '/api/travel/knowledge-base/oauth/status') return Promise.resolve({ configured: true, connected: true, rootFolderId: 'root-folder' });
      return Promise.resolve({});
    });
    renderPage();
    await screen.findByText('brochure-a.pdf');

    // Batch both clicks to reproduce the pre-render window where React state
    // has not yet disabled the pager buttons.
    act(() => {
      screen.getByRole('button', { name: 'Page 2' }).click();
      screen.getByRole('button', { name: 'Page 3' }).click();
    });

    await act(async () => {
      pageThree.resolve({ files: [{ ...FILES[0], id: 303, fileName: 'newest-page.pdf' }], total: 60 });
      await pageThree.promise;
    });
    expect(await screen.findByText('newest-page.pdf')).toBeInTheDocument();

    await act(async () => {
      pageTwo.resolve({ files: [{ ...FILES[0], id: 202, fileName: 'stale-page.pdf' }], total: 60 });
      await pageTwo.promise;
    });
    await waitFor(() => {
      expect(screen.getByText('newest-page.pdf')).toBeInTheDocument();
      expect(screen.queryByText('stale-page.pdf')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Page 3' })).toHaveAttribute('aria-current', 'page');
    });
  });

  it('suppresses duplicate requests for the same page synchronously', async () => {
    const pageTwo = deferred();
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/travel/knowledge-base/config') return Promise.resolve({ rootFolderId: 'root-folder', qdrantEnabled: true });
      if (url === '/api/travel/knowledge-base/status') return Promise.resolve({ stats: [], lastJob: null });
      if (url === '/api/travel/knowledge-base/jobs?limit=5') return Promise.resolve({ jobs: [] });
      if (url === '/api/travel/knowledge-base/files?limit=20&offset=0') return Promise.resolve({ files: FILES, total: 40 });
      if (url === '/api/travel/knowledge-base/files?limit=20&offset=20') return pageTwo.promise;
      if (url === '/api/travel/knowledge-base/oauth/status') return Promise.resolve({ configured: true, connected: true, rootFolderId: 'root-folder' });
      return Promise.resolve({});
    });
    renderPage();
    await screen.findByText('brochure-a.pdf');

    act(() => {
      const pageButton = screen.getByRole('button', { name: 'Page 2' });
      pageButton.click();
      pageButton.click();
    });

    expect(fetchApiMock.mock.calls.filter(([url]) => url === '/api/travel/knowledge-base/files?limit=20&offset=20')).toHaveLength(1);
    await act(async () => {
      pageTwo.resolve({ files: [], total: 0 });
      await pageTwo.promise;
    });
    await waitFor(() => expect(screen.queryByTestId('knowledge-files-pager')).not.toBeInTheDocument());
  });
});
