import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyConfirm = vi.fn(() => Promise.resolve(true));
const notifyObj = {
  error: notifyError,
  success: notifySuccess,
  info: vi.fn(),
  confirm: notifyConfirm,
};
vi.mock('../utils/notify', () => ({ useNotify: () => notifyObj }));

import { AuthContext } from '../App';
import KnowledgeBaseAdmin from '../pages/travel/KnowledgeBaseAdmin';

const ADMIN_USER = { userId: 1, role: 'ADMIN', name: 'Admin' };
const INDEXED_FILE = {
  id: 42,
  subBrand: 'tmc',
  fileName: 'Campus Overnight Adventure.pdf',
  folderPath: 'tmc/IN CAMPUS PROGRAMS/Campus Overnight Adventure.pdf',
  driveViewLink: 'https://drive.google.com/file/d/test',
  status: 'active',
  indexedAt: '2026-08-17T13:05:00.000Z',
};

function mockKnowledgeApi() {
  fetchApiMock.mockImplementation((url, opts = {}) => {
    const method = opts.method || 'GET';
    if (url === '/api/travel/knowledge-base/config') {
      return Promise.resolve({
        rootFolderId: 'drive-root',
        qdrantEnabled: true,
        embedEnabled: true,
        embedProvider: 'openai',
        embedModel: 'text-embedding-3-small',
        vectorSize: 1536,
      });
    }
    if (url === '/api/travel/knowledge-base/status') {
      return Promise.resolve({ stats: [], lastJob: null, providerChunks: {}, activeProvider: null });
    }
    if (url === '/api/travel/knowledge-base/jobs?limit=5') {
      return Promise.resolve({ jobs: [] });
    }
    if (url === '/api/travel/knowledge-base/files?limit=50&offset=0') {
      return Promise.resolve({ files: [INDEXED_FILE], total: 1 });
    }
    if (url === '/api/travel/knowledge-base/oauth/status') {
      return Promise.resolve({
        configured: true,
        connected: true,
        userInfo: { email: 'admin@example.com' },
        rootFolderId: 'drive-root',
      });
    }
    if (url === `/api/travel/knowledge-base/files/${INDEXED_FILE.id}` && method === 'DELETE') {
      return Promise.resolve({ success: true });
    }
    return Promise.resolve({});
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/travel/trip-knowledge']}>
      <AuthContext.Provider value={{ user: ADMIN_USER, tenant: { vertical: 'travel' }, loading: false }}>
        <KnowledgeBaseAdmin />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyError.mockReset();
  notifySuccess.mockReset();
  notifyConfirm.mockReset();
  notifyConfirm.mockResolvedValue(true);
  mockKnowledgeApi();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('KnowledgeBaseAdmin', () => {
  it('renders navigation links to Travel and Diagnostics', async () => {
    renderPage();
    await screen.findByText(INDEXED_FILE.fileName);
    expect(screen.getByRole('link', { name: /Back to Travel/i })).toHaveAttribute('href', '/travel');
    expect(screen.getByRole('link', { name: /Go to Diagnostics/i })).toHaveAttribute('href', '/travel/diagnostics');
  });

  it('renders a downloadable brochure folder template link', async () => {
    renderPage();
    await screen.findByText(INDEXED_FILE.fileName);
    const downloadLink = screen.getByRole('link', { name: /Download brochure folder template/i });
    expect(downloadLink).toHaveAttribute('href', '/templates/brochure-template.zip');
    expect(downloadLink).toHaveAttribute('download');
  });

  it('uses the in-CRM confirm modal before removing an indexed file', async () => {
    const nativeConfirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();

    await screen.findByText(INDEXED_FILE.fileName);
    fireEvent.click(screen.getByTitle('Remove from index'));

    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalledWith({
        title: 'Remove Indexed File',
        message: 'Remove this file from the index?',
        confirmText: 'Remove',
        destructive: true,
      });
    });
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith(`/api/travel/knowledge-base/files/${INDEXED_FILE.id}`, { method: 'DELETE' });
    });
    expect(nativeConfirm).not.toHaveBeenCalled();
    expect(notifySuccess).toHaveBeenCalledWith('File removed from index');
  });

  it('does not delete when the in-CRM confirm modal is cancelled', async () => {
    notifyConfirm.mockResolvedValueOnce(false);
    const nativeConfirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();

    await screen.findByText(INDEXED_FILE.fileName);
    fireEvent.click(screen.getByTitle('Remove from index'));

    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalled();
    });
    expect(fetchApiMock).not.toHaveBeenCalledWith(`/api/travel/knowledge-base/files/${INDEXED_FILE.id}`, { method: 'DELETE' });
    expect(nativeConfirm).not.toHaveBeenCalled();
  });
});
