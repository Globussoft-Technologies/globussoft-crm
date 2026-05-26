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

  // ------------------------------------------------------------------
  // Extension cases (2026-05-26)
  //
  // SUT note: DealModal is NOT a create/edit form — it's a Document
  // Center modal that surfaces an EXISTING deal's read-only properties
  // (amount, probability, close date) alongside attachments + notes +
  // CPQ. The "create vs edit / form validation / stage select" cases
  // suggested by the prompt don't apply to this SUT shape. The
  // following cases pin the actually-observable behaviour: read-only
  // property surface, click-stop on inner dialog, attachment open +
  // delete + cancel-delete flow, upload POST, deal-property edge cases.
  // Pure pin — no source changes.
  // ------------------------------------------------------------------

  it('renders read-only deal properties (probability + formatted close date + amount)', async () => {
    render(<DealModal deal={deal} onClose={() => {}} />);
    // probability surfaced as "65%"
    expect(screen.getByText('65%')).toBeInTheDocument();
    // formatted close date appears in the side pane (locale string, not raw ISO)
    expect(screen.queryByText('2026-05-01')).not.toBeInTheDocument();
    const closeDateText = new Date('2026-05-01').toLocaleDateString();
    // at least one element contains the locale-formatted date
    const dateNodes = screen.getAllByText(new RegExp(closeDateText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    expect(dateNodes.length).toBeGreaterThanOrEqual(1);
    // amount renders inside header via formatMoney
    expect(screen.getByText(/1,000|1000/)).toBeInTheDocument();
  });

  it('shows "Not Set" when deal has no expectedClose', async () => {
    const noDateDeal = { ...deal, expectedClose: null };
    render(<DealModal deal={noDateDeal} onClose={() => {}} />);
    expect(screen.getByText('Not Set')).toBeInTheDocument();
  });

  it('clicking inside the inner dialog does NOT trigger onClose (stop-propagation guard)', () => {
    const onClose = vi.fn();
    render(<DealModal deal={deal} onClose={onClose} />);
    const dialog = screen.getByRole('dialog');
    // click on the dialog body — should NOT bubble to backdrop
    fireEvent.click(dialog);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('delete attachment button opens confirm dialog with Cancel + Delete actions', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url.includes('/attachments')) {
        return Promise.resolve([
          { id: 7, filename: 'spec.pdf', fileUrl: '/files/spec.pdf', createdAt: '2026-02-15' },
        ]);
      }
      return Promise.resolve([]);
    });
    render(<DealModal deal={deal} onClose={() => {}} />);
    await screen.findByText('spec.pdf');
    // the trash icon button is the second button in the attachment row
    // (after "Open"). Find by its title attribute.
    const deleteBtn = document.querySelector('button[title="Delete attachment"]');
    expect(deleteBtn).not.toBeNull();
    fireEvent.click(deleteBtn);
    expect(await screen.findByText(/Delete Attachment\?/i)).toBeInTheDocument();
    expect(screen.getByText(/This action cannot be undone/i)).toBeInTheDocument();
    // Cancel + Delete buttons both present
    expect(screen.getByText('Cancel')).toBeInTheDocument();
    expect(screen.getByText('Delete')).toBeInTheDocument();
  });

  it('confirming delete fires DELETE to /api/deals_documents/:id', async () => {
    const deleteCalls = [];
    fetchApiMock.mockImplementation((url, opts) => {
      if (url.includes('/attachments')) {
        return Promise.resolve([
          { id: 99, filename: 'doc.pdf', fileUrl: '/files/doc.pdf', createdAt: '2026-03-01' },
        ]);
      }
      if (opts?.method === 'DELETE') {
        deleteCalls.push(url);
        return Promise.resolve({});
      }
      return Promise.resolve([]);
    });
    render(<DealModal deal={deal} onClose={() => {}} />);
    await screen.findByText('doc.pdf');
    fireEvent.click(document.querySelector('button[title="Delete attachment"]'));
    await screen.findByText(/Delete Attachment\?/i);
    fireEvent.click(screen.getByText('Delete'));
    await waitFor(() => {
      expect(deleteCalls).toContain('/api/deals_documents/99');
    });
  });

  it('cancelling the delete confirm dismisses the dialog without firing DELETE', async () => {
    let deleteFired = false;
    fetchApiMock.mockImplementation((url, opts) => {
      if (url.includes('/attachments')) {
        return Promise.resolve([
          { id: 5, filename: 'invoice.pdf', fileUrl: '/files/i.pdf', createdAt: '2026-04-01' },
        ]);
      }
      if (opts?.method === 'DELETE') {
        deleteFired = true;
        return Promise.resolve({});
      }
      return Promise.resolve([]);
    });
    render(<DealModal deal={deal} onClose={() => {}} />);
    await screen.findByText('invoice.pdf');
    fireEvent.click(document.querySelector('button[title="Delete attachment"]'));
    await screen.findByText(/Delete Attachment\?/i);
    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() => {
      expect(screen.queryByText(/Delete Attachment\?/i)).not.toBeInTheDocument();
    });
    expect(deleteFired).toBe(false);
  });

  it('file upload POSTs to /upload endpoint with FormData + bearer token', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200 });
    fetchApiMock.mockResolvedValue([]);
    const { container } = render(<DealModal deal={deal} onClose={() => {}} />);
    const fileInput = container.querySelector('input[type="file"]');
    expect(fileInput).not.toBeNull();
    const file = new File(['hello'], 'upload.pdf', { type: 'application/pdf' });
    // jsdom's input[type=file] needs an explicit FileList; fireEvent.change supports files prop
    Object.defineProperty(fileInput, 'files', { value: [file] });
    fireEvent.change(fileInput);
    await waitFor(() => {
      const uploadCall = fetchSpy.mock.calls.find(
        ([url, opts]) => typeof url === 'string' && url.includes('/upload') && opts?.method === 'POST',
      );
      expect(uploadCall).toBeDefined();
      // bearer token header is set
      expect(uploadCall[1].headers.Authorization).toBe('Bearer test-token');
      // body is a FormData
      expect(uploadCall[1].body).toBeInstanceOf(FormData);
    });
    fetchSpy.mockRestore();
  });

  it('notes textarea pre-fills from deal.notes', async () => {
    render(<DealModal deal={deal} onClose={() => {}} />);
    const textarea = screen.getByPlaceholderText(/Log a call, meeting/i);
    expect(textarea.value).toBe('Initial notes');
  });

  it('Save Note button is disabled while a save is in flight', async () => {
    // delay the PUT response so we observe the in-flight state
    let resolveSave;
    fetchApiMock.mockImplementation((url, opts) => {
      if (url.includes('/attachments')) return Promise.resolve([]);
      if (opts?.method === 'PUT') {
        return new Promise((res) => {
          resolveSave = res;
        });
      }
      return Promise.resolve([]);
    });
    render(<DealModal deal={deal} onClose={() => {}} />);
    const saveBtn = screen.getByText(/Save Note/i);
    fireEvent.click(saveBtn);
    // while in flight, label switches to "Saving..." and button is disabled
    await waitFor(() => {
      expect(screen.getByText(/Saving\.\.\./i)).toBeInTheDocument();
    });
    const savingBtn = screen.getByText(/Saving\.\.\./i).closest('button');
    expect(savingBtn.disabled).toBe(true);
    // resolve so the test cleans up
    if (resolveSave) resolveSave({});
  });
});
