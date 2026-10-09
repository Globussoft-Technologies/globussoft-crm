import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import MultiSelectDropdown from '../components/MultiSelectDropdown';

describe('<MultiSelectDropdown />', () => {
  it('counts only selected values that are present in the visible options', () => {
    render(<MultiSelectDropdown
      ariaLabel="Plots"
      options={[
        { value: 1, label: 'Plot 1' },
        { value: 2, label: 'Plot 2' },
      ]}
      selected={[1, 2, 91, 92, 93]}
      onChange={() => {}}
      placeholder="Select plots"
    />);

    expect(screen.getByRole('button', { name: 'Plots' })).toHaveTextContent('2 selected');
    fireEvent.click(screen.getByRole('button', { name: 'Plots' }));
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    expect(screen.getAllByRole('checkbox').every((checkbox) => checkbox.checked)).toBe(true);
  });

  it('clears visible selections without dropping hidden historical values', () => {
    const onChange = vi.fn();
    render(<MultiSelectDropdown
      ariaLabel="Plots"
      options={[{ value: 1, label: 'Plot 1' }]}
      selected={[1, 91, 92]}
      onChange={onChange}
      placeholder="Select plots"
    />);

    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(onChange).toHaveBeenCalledWith([91, 92]);
  });
});
