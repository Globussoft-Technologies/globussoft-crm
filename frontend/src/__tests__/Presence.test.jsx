import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import React from 'react';
import Presence from '../components/Presence';
import { AuthContext } from '../App';

// Hold a reference to the socket instance the module under test gets so we
// can drive events from the test. socket-io-client is mocked so NO real
// network happens.
let lastSocket = null;

vi.mock('socket.io-client', () => {
  return {
    io: vi.fn(() => {
      const handlers = {};
      const sock = {
        connected: false,
        on: vi.fn((ev, cb) => { handlers[ev] = cb; }),
        emit: vi.fn(),
        disconnect: vi.fn(),
        _fire: (ev, data) => handlers[ev]?.(data),
        _handlers: handlers,
      };
      lastSocket = sock;
      return sock;
    }),
  };
});

function renderWithUser(user) {
  return render(
    <AuthContext.Provider value={{ user, setUser: () => {}, token: 't', setToken: () => {}, tenant: null, setTenant: () => {} }}>
      <Presence />
    </AuthContext.Provider>
  );
}

describe('Presence', () => {
  beforeEach(() => {
    lastSocket = null;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders the fixed overlay div even with no user', () => {
    const { container } = renderWithUser(null);
    // Renders an empty overlay div
    expect(container.querySelector('div[style]')).toBeTruthy();
  });

  it('connects the socket and joins presence on connect event', () => {
    renderWithUser({ id: 42, name: 'Alice' });
    expect(lastSocket).toBeTruthy();
    // emulate socket's "connect" event
    lastSocket._fire('connect');
    expect(lastSocket.emit).toHaveBeenCalledWith(
      'join_presence',
      expect.objectContaining({ userId: 42, name: 'Alice' }),
    );
  });

  it('handles cursor_update events by rendering cursor chips', () => {
    const { container } = renderWithUser({ id: 1, name: 'Me' });
    act(() => {
      lastSocket._fire('connect');
      lastSocket._fire('cursor_update', {
        id: 'other-socket',
        rx: 0.5,
        ry: 0.5,
        name: 'Bob',
        color: '#10b981',
      });
    });
    expect(container.textContent).toMatch(/Bob/);
  });

  it('removes cursor on user_left', () => {
    const { container } = renderWithUser({ id: 1, name: 'Me' });
    act(() => {
      lastSocket._fire('connect');
      lastSocket._fire('cursor_update', { id: 'x', rx: 0.1, ry: 0.1, name: 'Bob', color: '#f00' });
    });
    expect(container.textContent).toMatch(/Bob/);
    act(() => {
      lastSocket._fire('user_left', 'x');
    });
    expect(container.textContent).not.toMatch(/Bob/);
  });

  it('disconnects the socket on unmount', () => {
    const { unmount } = renderWithUser({ id: 1, name: 'Me' });
    unmount();
    expect(lastSocket.disconnect).toHaveBeenCalled();
  });

  it('mousemove emits mouse_move when connected', () => {
    renderWithUser({ id: 1, name: 'Me' });
    lastSocket.connected = true;
    const ev = new MouseEvent('mousemove', { clientX: 100, clientY: 100 });
    window.dispatchEvent(ev);
    expect(lastSocket.emit).toHaveBeenCalledWith(
      'mouse_move',
      expect.objectContaining({ rx: expect.any(Number), ry: expect.any(Number) }),
    );
  });

  it('mousemove does NOT emit when socket is disconnected', () => {
    renderWithUser({ id: 1, name: 'Me' });
    lastSocket.connected = false;
    lastSocket.emit.mockClear();
    const ev = new MouseEvent('mousemove', { clientX: 50, clientY: 50 });
    window.dispatchEvent(ev);
    expect(lastSocket.emit).not.toHaveBeenCalled();
  });
});
