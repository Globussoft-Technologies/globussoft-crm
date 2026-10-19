import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import GenericLeadDetailPanel from '../components/GenericLeadDetailPanel';
import { copyToClipboard } from '../utils/clipboard';
vi.mock('../utils/clipboard', () => ({ copyToClipboard: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../utils/notify', () => ({ useNotify: () => ({ success: vi.fn(), error: vi.fn() }) }));

describe('GenericLeadDetailPanel', () => {
  it('copies Name and Company and makes the exiting panel non-interactive', async () => {
    const props = { lead: { name: 'Arjun', company: 'Bangalore AI Labs' }, onClose: vi.fn(), onOpen: vi.fn() };
    const { rerender } = render(<GenericLeadDetailPanel {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy lead name' }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy lead company' }));
    await waitFor(() => expect(copyToClipboard).toHaveBeenCalledWith('Bangalore AI Labs'));
    expect(copyToClipboard).toHaveBeenCalledWith('Arjun');
    rerender(<GenericLeadDetailPanel {...props} closing />);
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    expect(document.querySelector('aside')).toHaveAttribute('inert');
  });
  it('renders real details, handles missing fields and hides editing without permission', () => {
    render(<GenericLeadDetailPanel lead={{ id: 1, name: 'Arjun', email: 'arjun@example.test' }} onClose={() => {}} onOpen={() => {}} />);
    expect(screen.getByText('arjun@example.test')).toBeInTheDocument();
    expect(screen.getByText('Not scored')).toBeInTheDocument();
    expect(screen.getByText('Unassigned')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit lead' })).not.toBeInTheDocument();
  });
  it('supports closing, Escape, edit and full-detail actions', () => {
    const onClose = vi.fn(), onOpen = vi.fn(), onEdit = vi.fn();
    render(<GenericLeadDetailPanel lead={{ id: 1, name: 'Arjun', aiScore: 0 }} canEdit onClose={onClose} onOpen={onOpen} onEdit={onEdit} />);
    expect(screen.getByText('0 / 100')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit lead' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open full detail' }));
    fireEvent.keyDown(screen.getByRole('complementary'), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Close lead preview' }));
    expect(onEdit).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
