import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import DealModal from '../components/DealModal';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Replace the nested CPQBuilder with a stub so we isolate DealModal
vi.mock('../components/CPQBuilder', () => ({
  default: () => React.createElement('div', { 'data-testid': 'cpq-stub' }),
}));

const deal = {
  id: 42,
  title: 'Test Deal',
  company: 'Acme',
  amount: 1000,
  currency: 'USD',
  stage: 'proposal',
  probability: 65,
  expectedClose: '2026-05-01',
  notes: 'Initial notes',
};

describe('DealModal', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    fetchApiMock.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders nothing when deal is null', () => {
    const { container } = render(<DealModal deal={null} onClose={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the deal header (title, company, stage)', async () => {
    render(<DealModal deal={deal} onClose={() => {}} />);
    expect(screen.getByText('Test Deal')).toBeInTheDocument();
    expect(screen.getByText(/Acme/)).toBeInTheDocument();
    expect(screen.getByText(/PROPOSAL/)).toBeInTheDocument();
  });

  it('loads attachments on mount', async () => {
    render(<DealModal deal={deal} onClose={() => {}} />);
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith('/api/deals_documents/42/attachments'));
  });

  it('clicking the close button invokes onClose', () => {
    const onClose = vi.fn();
    render(<DealModal deal={deal} onClose={onClose} />);
    // X button (close)
    const dialog = screen.getByRole('dialog');
    // locate the top-right close via looking for a button with an svg X
    const buttons = dialog.querySelectorAll('button');
    fireEvent.click(buttons[0]);
    expect(onClose).toHaveBeenCalled();
  });

  it('clicking the backdrop invokes onClose', () => {
    const onClose = vi.fn();
    const { container } = render(<DealModal deal={deal} onClose={onClose} />);
    // The outermost backdrop has the onClick
    const backdrop = container.firstChild;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalled();
  });

  it('shows empty-state when no attachments', async () => {
    render(<DealModal deal={deal} onClose={() => {}} />);
    expect(await screen.findByText(/No documents attached/i)).toBeInTheDocument();
  });

  it('generate-quote button triggers POST to generate-quote endpoint', async () => {
    // #585: the route now returns binary PDF bytes inline (Content-Type
    // application/pdf), so the frontend uses raw fetch to grab a blob and
    // trigger a real download — fetchApi (which forces JSON parsing) is
    // bypassed for this one call. Mock global.fetch + URL.createObjectURL
    // so the click still drives a single POST against /generate-quote.
    fetchApiMock.mockResolvedValue([]);
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      blob: () => Promise.resolve(new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])], { type: 'application/pdf' })),
    });
    const createObjectURL = vi.fn(() => 'blob:fake');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(global.URL, 'createObjectURL', { value: createObjectURL, configurable: true });
    Object.defineProperty(global.URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true });
    render(<DealModal deal={deal} onClose={() => {}} />);
    fireEvent.click(await screen.findByText(/Generate Quote/i));
    await waitFor(() => {
      const postCall = fetchSpy.mock.calls.find(
        ([url, opts]) => typeof url === 'string' && url.includes('/generate-quote') && opts?.method === 'POST',
      );
      expect(postCall).toBeDefined();
    });
    fetchSpy.mockRestore();
  });

  it('saving a note PUTs to /api/deals/:id', async () => {
    fetchApiMock.mockResolvedValue([]);
    render(<DealModal deal={deal} onClose={() => {}} />);
    const textarea = screen.getByPlaceholderText(/Log a call, meeting/i);
    fireEvent.change(textarea, { target: { value: 'Edited note' } });
    fireEvent.click(screen.getByText(/Save Note/i));
    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(([url, opts]) => url === '/api/deals/42' && opts?.method === 'PUT');
      expect(putCall).toBeDefined();
      expect(putCall[1].body).toContain('Edited note');
    });
  });

  it('renders attachments when list is non-empty', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url.includes('/attachments')) {
        return Promise.resolve([
          { id: 1, filename: 'contract.pdf', fileUrl: '/files/c.pdf', createdAt: '2026-01-01' },
        ]);
      }
      return Promise.resolve([]);
    });
    render(<DealModal deal={deal} onClose={() => {}} />);
    expect(await screen.findByText('contract.pdf')).toBeInTheDocument();
    expect(screen.getByText('Open')).toBeInTheDocument();
  });

  it('shows CPQ builder stub', async () => {
    render(<DealModal deal={deal} onClose={() => {}} />);
    expect(await screen.findByTestId('cpq-stub')).toBeInTheDocument();
  });
});
