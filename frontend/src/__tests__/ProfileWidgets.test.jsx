import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { InlineField } from '../components/contact/ProfileWidgets';

describe('InlineField', () => {
  it('saves the edited string on blur instead of forwarding the blur event', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<InlineField value="Old value" onSave={onSave} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit field' }));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'New value' } });
    fireEvent.blur(input);

    await waitFor(() => expect(onSave).toHaveBeenCalledWith('New value'));
  });

  it('contains rejected inline saves instead of creating an unhandled rejection', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('save failed'));
    render(<InlineField value="Old value" onSave={onSave} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit field' }));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'New value' } });
    fireEvent.blur(input);

    await waitFor(() => expect(onSave).toHaveBeenCalledWith('New value'));
    await waitFor(() => expect(screen.getByText('Old value')).toBeInTheDocument());
  });
});
