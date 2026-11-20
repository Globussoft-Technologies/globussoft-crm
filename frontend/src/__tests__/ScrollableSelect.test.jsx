import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ScrollableSelect from '../components/ScrollableSelect';

const options = [{ value: 'new', label: 'New' }, { value: 'pending', label: 'Pending' }, { value: 'qualified', label: 'Qualified' }];
describe('consistent lead dropdown', () => {
  it('opens a portal menu and supports keyboard selection', async () => {
    const change = vi.fn();
    render(<ScrollableSelect ariaLabel="Call status" value="pending" options={options} onChange={change} />);
    const trigger = screen.getByRole('button', { name: 'Call status' });
    expect(trigger).toHaveClass('crm-select-trigger');
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const menu = await screen.findByRole('listbox');
    expect(menu).toHaveClass('crm-select-popover');
    expect(menu.parentElement).toBe(document.body);
    await waitFor(() => expect(screen.getByRole('option', { name: 'Pending' })).toHaveFocus());
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: 'Qualified' })).toHaveFocus();
    fireEvent.click(screen.getByRole('option', { name: 'Qualified' }));
    expect(change).toHaveBeenCalledWith('qualified');
    expect(screen.queryByRole('listbox')).toBeNull();
  });
  it('closes with Escape and preserves the existing value', async () => {
    const change = vi.fn();
    render(<ScrollableSelect ariaLabel="Campaign" value="new" options={options} onChange={change} />);
    fireEvent.click(screen.getByRole('button', { name: 'Campaign' }));
    await screen.findByRole('listbox');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(change).not.toHaveBeenCalled();
  });
  it('keeps disabled fields inert', () => {
    render(<ScrollableSelect ariaLabel="Campaign" value="new" options={options} disabled />);
    expect(screen.getByRole('button', { name: 'Campaign' })).toBeDisabled();
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
