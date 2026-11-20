import { render, screen, fireEvent } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import AutomationStepper from '../components/AutomationStepper';

it('updates and commits the next value while respecting bounds', () => {
  const onChange = vi.fn();
  const onBlur = vi.fn();
  render(<AutomationStepper aria-label="Max retries" type="number" value={1} min={1} max={10} onChange={onChange} onBlur={onBlur} />);
  expect(screen.getByRole('button', { name: 'Decrease value' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Increase value' }));
  expect(onChange).toHaveBeenCalledWith({ target: { value: '2' } });
  expect(onBlur).toHaveBeenCalledWith({ target: { value: '2' } });
});
