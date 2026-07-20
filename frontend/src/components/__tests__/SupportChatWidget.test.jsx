/**
 * SupportChatWidget.test.jsx — vitest + RTL coverage for the Wellness
 * Admin Support Chatbot floating widget
 * (frontend/src/components/SupportChatWidget.jsx).
 *
 * What's pinned
 * -------------
 *   - Visibility        renders ONLY for wellness tenants with an
 *                       authenticated user; null otherwise
 *   - FAB               48px floating button, default bottom-right
 *   - Click vs drag     a sub-5px press toggles the panel; a >=5px move
 *                       drags (no toggle) and persists the position to
 *                       localStorage wellness_support_chat_pos_<userId>
 *   - Drag clamping     never leaves the viewport, never crosses the left
 *                       sidebar (#app-sidebar)
 *   - Chat turn         POSTs /api/support-chat/message with message,
 *                       history and the CURRENT ROUTE as pageContext;
 *                       renders the reply + deep-link buttons; persists the
 *                       session to wellness_support_chat_session_<userId>
 *   - Provider not set  AI_PROVIDER_NOT_CONFIGURED surfaces as a friendly
 *                       chat bubble (no toast, no crash)
 *   - Session restore   a prior session in localStorage renders on mount
 *
 * Mocks: fetchApi (utils/api) and ../App (AuthContext only — the real App
 * module pulls the entire router tree). PointerEvent falls back to
 * MouseEvent where jsdom lacks it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';

if (typeof window !== 'undefined' && !window.PointerEvent) {
  window.PointerEvent = window.MouseEvent;
}

const fetchApiMock = vi.fn();
vi.mock('../../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

vi.mock('../../App', async () => {
  const ReactMod = await import('react');
  return {
    AuthContext: ReactMod.createContext(null),
    ThemeContext: ReactMod.createContext(null),
  };
});

import SupportChatWidget from '../SupportChatWidget';
import { AuthContext } from '../../App';

const WELLNESS_USER = { id: 7, name: 'Alice', email: 'alice@clinic.test', role: 'ADMIN' };

function renderWidget({ user = WELLNESS_USER, tenant = { id: 1, vertical: 'wellness' }, route = '/wellness/appointments' } = {}) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <AuthContext.Provider value={{ user, tenant, token: 't-1' }}>
        <SupportChatWidget />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

function fab() {
  return screen.getByTestId('support-chat-fab');
}

// jsdom viewport is 1024x768; the default FAB position is
// { x: 1024-48-32, y: 768-48-32 } = { x: 944, y: 688 }.
const DEFAULT_POS = { x: 944, y: 688 };

beforeEach(() => {
  fetchApiMock.mockReset();
  localStorage.clear();
});

describe('visibility', () => {
  it('renders nothing for non-wellness tenants', () => {
    const { container } = renderWidget({ tenant: { id: 1, vertical: 'generic' } });
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when no user is authenticated', () => {
    const { container } = renderWidget({ user: null });
    expect(container.firstChild).toBeNull();
  });

  it('renders the 48px FAB for wellness tenants, closed by default', () => {
    renderWidget();
    const btn = fab();
    expect(btn).toBeInTheDocument();
    expect(btn.style.width).toBe('48px');
    expect(btn.style.height).toBe('48px');
    expect(btn.style.left).toBe(`${DEFAULT_POS.x}px`);
    expect(btn.style.top).toBe(`${DEFAULT_POS.y}px`);
    expect(screen.queryByTestId('support-chat-panel')).not.toBeInTheDocument();
  });
});

describe('click vs drag', () => {
  it('a sub-5px press toggles the panel open and hides the FAB', () => {
    renderWidget();
    fireEvent.pointerDown(fab(), { clientX: 950, clientY: 700 });
    fireEvent.pointerMove(window, { clientX: 952, clientY: 701 }); // ~2.2px
    fireEvent.pointerUp(window);
    expect(screen.getByTestId('support-chat-panel')).toBeInTheDocument();
    // FAB is hidden while the panel is open; closing re-renders it below.
    expect(screen.queryByTestId('support-chat-fab')).not.toBeInTheDocument();
  });

  it('a >=5px move drags the button (no toggle) and persists the position', () => {
    renderWidget();
    fireEvent.pointerDown(fab(), { clientX: 950, clientY: 700 });
    fireEvent.pointerMove(window, { clientX: 850, clientY: 600 }); // dx=-100, dy=-100
    fireEvent.pointerUp(window);

    expect(screen.queryByTestId('support-chat-panel')).not.toBeInTheDocument();
    expect(fab().style.left).toBe(`${DEFAULT_POS.x - 100}px`);
    expect(fab().style.top).toBe(`${DEFAULT_POS.y - 100}px`);

    const saved = JSON.parse(localStorage.getItem('wellness_support_chat_pos_7'));
    expect(saved).toEqual({ x: DEFAULT_POS.x - 100, y: DEFAULT_POS.y - 100 });
  });

  it('clamps the drag inside the viewport', () => {
    renderWidget();
    fireEvent.pointerDown(fab(), { clientX: 950, clientY: 700 });
    fireEvent.pointerMove(window, { clientX: -2000, clientY: -2000 });
    fireEvent.pointerUp(window);
    // No #app-sidebar in the DOM → min is the plain 8px viewport margin.
    expect(fab().style.left).toBe('8px');
    expect(fab().style.top).toBe('8px');
  });

  it('never crosses the left sidebar while dragging', () => {
    const sidebar = document.createElement('div');
    sidebar.id = 'app-sidebar';
    // The global setup stubs getBoundingClientRect to right:800 for every
    // element; pin the sidebar to its real 250px width for this test.
    sidebar.getBoundingClientRect = () => ({
      width: 250, height: 768, top: 0, left: 0, right: 250, bottom: 768, x: 0, y: 0, toJSON: () => ({}),
    });
    document.body.appendChild(sidebar);
    try {
      renderWidget();
      fireEvent.pointerDown(fab(), { clientX: 950, clientY: 700 });
      fireEvent.pointerMove(window, { clientX: 0, clientY: 700 }); // way left
      fireEvent.pointerUp(window);
      expect(fab().style.left).toBe('258px'); // 250 + 8px margin
    } finally {
      sidebar.remove();
    }
  });

  it('restores a saved position from localStorage', () => {
    localStorage.setItem('wellness_support_chat_pos_7', JSON.stringify({ x: 300, y: 200 }));
    renderWidget();
    expect(fab().style.left).toBe('300px');
    expect(fab().style.top).toBe('200px');
  });
});

describe('chat turns', () => {
  async function openPanel() {
    fireEvent.pointerDown(fab(), { clientX: 950, clientY: 700 });
    fireEvent.pointerUp(window);
    return screen.findByTestId('support-chat-panel');
  }

  it('sends the message with current page context and renders reply + deep links', async () => {
    fetchApiMock.mockResolvedValue({
      reply: 'Open the Appointments page and pick the booking.',
      links: [{ label: 'Appointments', path: '/wellness/appointments' }],
      ticket: null,
    });
    renderWidget({ route: '/wellness/appointments' });
    await openPanel();

    fireEvent.change(screen.getByTestId('support-chat-input'), {
      target: { value: 'How do I reschedule?' },
    });
    fireEvent.click(screen.getByTestId('support-chat-send'));

    expect(await screen.findByText('Open the Appointments page and pick the booking.')).toBeInTheDocument();

    expect(fetchApiMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchApiMock.mock.calls[0];
    expect(url).toBe('/api/support-chat/message');
    const body = JSON.parse(opts.body);
    expect(body.message).toBe('How do I reschedule?');
    expect(body.pageContext).toEqual({ path: '/wellness/appointments', pageName: 'Appointments' });
    expect(Array.isArray(body.history)).toBe(true);

    // Deep-link button rendered from the response links.
    expect(screen.getByRole('button', { name: /Appointments →/ })).toBeInTheDocument();

    // Session persisted per user.
    const session = JSON.parse(localStorage.getItem('wellness_support_chat_session_7'));
    expect(session).toHaveLength(2);
    expect(session[0]).toEqual({ role: 'user', content: 'How do I reschedule?' });
    expect(session[1].role).toBe('assistant');
  });

  it('shows a friendly bubble when the AI provider is not configured', async () => {
    const err = new Error('AI provider not configured');
    err.code = 'AI_PROVIDER_NOT_CONFIGURED';
    fetchApiMock.mockRejectedValue(err);
    renderWidget();
    await openPanel();

    fireEvent.change(screen.getByTestId('support-chat-input'), { target: { value: 'help' } });
    fireEvent.click(screen.getByTestId('support-chat-send'));

    expect(
      await screen.findByText(/AI provider is not configured yet/i),
    ).toBeInTheDocument();
  });

  it('restores the prior session from localStorage', async () => {
    localStorage.setItem(
      'wellness_support_chat_session_7',
      JSON.stringify([
        { role: 'user', content: 'earlier question' },
        { role: 'assistant', content: 'earlier answer' },
      ]),
    );
    renderWidget();
    await openPanel();
    expect(screen.getByText('earlier question')).toBeInTheDocument();
    expect(screen.getByText('earlier answer')).toBeInTheDocument();
  });
});
