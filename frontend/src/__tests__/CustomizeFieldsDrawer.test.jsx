import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CustomizeFieldsDrawer, {
  ALL_OVERVIEW_FIELDS,
  DEFAULT_VISIBLE_FIELD_KEYS,
  normalizeVisibleKeys,
} from '../components/contact/CustomizeFieldsDrawer';

function renderDrawer(props = {}) {
  const onSave = vi.fn();
  const onClose = vi.fn();
  const utils = render(
    <CustomizeFieldsDrawer
      visibleKeys={[...DEFAULT_VISIBLE_FIELD_KEYS]}
      onSave={onSave}
      onClose={onClose}
      {...props}
    />,
  );
  return { onSave, onClose, ...utils };
}

describe('CustomizeFieldsDrawer', () => {
  it('shows the visible count and both sections', () => {
    renderDrawer();
    expect(screen.getByText(/Customize fields/)).toBeTruthy();
    expect(screen.getByText(`${DEFAULT_VISIBLE_FIELD_KEYS.length}/${ALL_OVERVIEW_FIELDS.length}`)).toBeTruthy();
    expect(screen.getByText('Fields visible in overview')).toBeTruthy();
    expect(screen.getByText('Fields not shown in overview')).toBeTruthy();
    expect(screen.getByLabelText('Hide Location')).toBeTruthy();
    expect(screen.getByLabelText('Show First name')).toBeTruthy();
  });

  it('search filters both sections', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await user.type(screen.getByLabelText('Search fields'), 'utm');
    expect(screen.queryByLabelText('Hide Location')).toBeNull();
    expect(screen.getByLabelText('Show UTM Source')).toBeTruthy();
    expect(screen.getByLabelText('Show UTM Medium')).toBeTruthy();
  });

  it('unchecking a visible field moves it to hidden and Save persists the rest', async () => {
    const user = userEvent.setup();
    const { onSave } = renderDrawer();
    await user.click(screen.getByLabelText('Hide Email'));
    expect(screen.getByLabelText('Show Email')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0][0];
    expect(saved).not.toContain('email');
    expect(saved).toHaveLength(DEFAULT_VISIBLE_FIELD_KEYS.length - 1);
  });

  it('checking a hidden field appends it to the visible list', async () => {
    const user = userEvent.setup();
    const { onSave } = renderDrawer();
    await user.click(screen.getByLabelText('Show Job title'));
    const visibleSection = screen.getByText('Fields visible in overview').parentElement;
    expect(within(visibleSection.parentElement).getByLabelText('Hide Job title')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const saved = onSave.mock.calls[0][0];
    expect(saved[ saved.length - 1 ]).toBe('jobTitle');
  });

  it('reorder buttons change the saved order', async () => {
    const user = userEvent.setup();
    const { onSave } = renderDrawer();
    await user.click(screen.getByLabelText('Move Account up'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const saved = onSave.mock.calls[0][0];
    expect(saved[0]).toBe('company');
    expect(saved[1]).toBe('location');
  });

  it('Cancel and Close discard without saving', async () => {
    const user = userEvent.setup();
    const { onSave, onClose } = renderDrawer();
    await user.click(screen.getByLabelText('Hide Email'));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('normalizeVisibleKeys tolerates legacy map prefs and unknown keys', () => {
    expect(normalizeVisibleKeys({ location: true, email: true, nope: true })).toEqual(['location', 'email']);
    expect(normalizeVisibleKeys(['email', 'email', 'nope', 'phone'])).toEqual(['email', 'phone']);
    expect(normalizeVisibleKeys(null)).toEqual(DEFAULT_VISIBLE_FIELD_KEYS);
  });
});
