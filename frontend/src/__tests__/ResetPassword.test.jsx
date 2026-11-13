import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthContext } from '../App';
import ResetPassword from '../pages/ResetPassword';

describe('ResetPassword', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/reset-password?token=portal-token&portal=1');
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'ok', code: 'PASSWORD_RESET_OK' }),
    });
  });

  it('submits Travel customer reset links to the portal reset endpoint', async () => {
    const setToken = vi.fn();
    const { container } = render(
      <AuthContext.Provider value={{ setToken }}>
        <MemoryRouter>
          <ResetPassword />
        </MemoryRouter>
      </AuthContext.Provider>,
    );
    const [password, confirm] = container.querySelectorAll('input[type="password"]');
    fireEvent.change(password, { target: { value: 'NewPassword123' } });
    fireEvent.change(confirm, { target: { value: 'NewPassword123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));

    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(
      '/api/portal/reset',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ token: 'portal-token', newPassword: 'NewPassword123' }),
      }),
    ));
    expect(setToken).toHaveBeenCalledWith(null);
  });
});
