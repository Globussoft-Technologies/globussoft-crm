/**
 * TravelWhatsAppTemplates.test.jsx — vitest + RTL coverage for the Travel-
 * vertical Wati template library (frontend/src/pages/travel/WhatsAppTemplates.jsx).
 *
 * Read-only surface over GET /api/travel/whatsapp/templates (Wati account
 * templates; authored/approved in the Wati dashboard). Pins:
 *   1. Chrome: heading + Wati-dashboard pointer + back-to-chat link.
 *   2. Rows render name/status/language/body from the API shape.
 *   3. Stub note renders when the backend reports stub:true.
 *   4. Empty + error states.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

import TravelWhatsAppTemplates from '../pages/travel/WhatsAppTemplates';

const TEMPLATES = [
  { name: 'new_chat_v1', status: 'APPROVED', language: 'en', category: 'UTILITY', body: 'Hi {{1}}, This is an auto-reply message.' },
  { name: 'onboarding_signoff', status: 'REJECTED', language: 'en', category: 'UTILITY', body: 'Hi {{1}}, Thank you for signing up.' },
];

function renderPage() {
  return render(
    <MemoryRouter>
      <TravelWhatsAppTemplates />
    </MemoryRouter>,
  );
}

beforeEach(() => fetchApiMock.mockReset());

describe('<TravelWhatsAppTemplates />', () => {
  it('1. renders heading, Wati dashboard pointer and back-to-chat link', async () => {
    fetchApiMock.mockResolvedValue({ templates: TEMPLATES, stub: false });
    renderPage();
    expect(await screen.findByRole('heading', { name: /WhatsApp Templates/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Wati dashboard/i })).toHaveAttribute('href', 'https://app.wati.io');
    expect(screen.getByRole('link', { name: /Back to chat/i })).toHaveAttribute('href', '/travel/whatsapp');
  });

  it('2. renders one row per template with status badges', async () => {
    fetchApiMock.mockResolvedValue({ templates: TEMPLATES, stub: false });
    renderPage();
    expect(await screen.findByText('new_chat_v1')).toBeInTheDocument();
    expect(screen.getByText('onboarding_signoff')).toBeInTheDocument();
    expect(screen.getByText('APPROVED')).toBeInTheDocument();
    expect(screen.getByText('REJECTED')).toBeInTheDocument();
  });

  it('3. shows the stub note when backend reports stub mode', async () => {
    fetchApiMock.mockResolvedValue({ templates: [], stub: true });
    renderPage();
    expect(await screen.findByTestId('stub-note')).toHaveTextContent(/credentials are not configured/i);
  });

  it('4. empty state', async () => {
    fetchApiMock.mockResolvedValue({ templates: [], stub: false });
    renderPage();
    expect(await screen.findByText(/No templates on the Wati account yet/i)).toBeInTheDocument();
  });

  it('5. error state when the load fails', async () => {
    // Trigger the page's .catch() via a response whose property access
    // throws inside the .then() — equivalent failure path without a
    // floating rejected promise (this file's environment flags those as
    // unhandled even when the component chain handles them).
    const poisoned = {};
    Object.defineProperty(poisoned, 'templates', {
      get() { throw new Error('boom'); },
    });
    fetchApiMock.mockResolvedValue(poisoned);
    renderPage();
    expect(await screen.findByText(/Failed to load templates from Wati/i)).toBeInTheDocument();
  });
});
