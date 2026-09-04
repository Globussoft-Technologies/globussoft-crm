/**
 * TravelKnowledgeBaseAdmin.test.jsx - RTL coverage for the travel knowledge
 * base admin page. Pins the two table-section badges so the displayed row
 * counts stay aligned with the fetched jobs and files data.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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
      if (url === '/api/travel/knowledge-base/files?limit=50&offset=0') {
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
    expect(screen.queryByText(/Page 1 of 1|Load more files/i)).not.toBeInTheDocument();
  });
});
