import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SearchableSingleSelect from '../../pages/wellness/services/SearchableSingleSelect';

const OPTIONS = [
  { value: '1', label: 'Hair Transplant' },
  { value: '2', label: 'Botox / Fillers' },
  { value: '3', label: 'Laser Treatment' },
];

describe('<SearchableSingleSelect />', () => {
  it('renders the selected label when closed', () => {
    render(<SearchableSingleSelect value="2" options={OPTIONS} aria-label="Service" />);
    expect(screen.getByRole('combobox')).toHaveValue('Botox / Fillers');
  });

  it('opens the listbox on focus and shows the none option plus all items', async () => {
    const user = userEvent.setup();
    render(<SearchableSingleSelect value="" options={OPTIONS} aria-label="Service" />);
    await user.click(screen.getByRole('combobox'));
    expect(await screen.findByRole('listbox')).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(4); // none + 3 services
  });

  it('calls onChange with the selected option value', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SearchableSingleSelect value="" options={OPTIONS} onChange={onChange} aria-label="Service" />);
    await user.click(screen.getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: 'Laser Treatment' }));
    expect(onChange).toHaveBeenCalledWith('3');
  });

  it('filters options while the user types', async () => {
    const user = userEvent.setup();
    render(<SearchableSingleSelect value="" options={OPTIONS} aria-label="Service" />);
    const input = screen.getByRole('combobox');
    await user.click(input);
    await screen.findByRole('listbox');
    await user.type(input, 'bot');
    expect(screen.getAllByRole('option')).toHaveLength(2); // none + Botox
    expect(screen.getByRole('option', { name: 'Botox / Fillers' })).toBeInTheDocument();
  });

  it('selects the none option to clear the value', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SearchableSingleSelect value="2" options={OPTIONS} onChange={onChange} aria-label="Service" />);
    await user.click(screen.getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: '— none —' }));
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('closes the listbox on Escape and returns focus to the input', async () => {
    const user = userEvent.setup();
    render(<SearchableSingleSelect value="" options={OPTIONS} aria-label="Service" />);
    const input = screen.getByRole('combobox');
    await user.click(input);
    await screen.findByRole('listbox');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(input);
  });

  it('navigates options with arrow keys and selects with Enter', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SearchableSingleSelect value="" options={OPTIONS} onChange={onChange} aria-label="Service" />);
    await user.click(screen.getByRole('combobox'));
    await screen.findByRole('listbox');
    // first ArrowDown highlights the "none" row, second highlights "Hair Transplant"
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenCalledWith('1');
  });

  it('renders a no-results message when filtering eliminates all options', async () => {
    const user = userEvent.setup();
    render(<SearchableSingleSelect value="" options={OPTIONS} aria-label="Service" />);
    const input = screen.getByRole('combobox');
    await user.click(input);
    await screen.findByRole('listbox');
    await user.type(input, 'xyz');
    expect(screen.getByText('No options found')).toBeInTheDocument();
    expect(screen.queryAllByRole('option')).toHaveLength(1); // only the none option
  });
});
