/**
 * Portal.test.jsx — vitest + RTL coverage for the public Support & Knowledge Base portal page.
 *
 * SUT: frontend/src/pages/Portal.jsx (151 LOC, untested prior to this commit).
 *
 * What Portal.jsx actually does (pinned by reading the source, not assumed):
 *   - Renders a public-facing "Support & Knowledge Base" hero heading.
 *   - Renders 6 hardcoded Help Articles in a collapsible accordion. Article
 *     titles are static strings inside the module — they ship with the bundle,
 *     no fetch involved.
 *   - Each article header shows the title + "Read knowledge base article →"
 *     hint until clicked, then expands to show the article body (which uses
 *     a renderBoldText helper that converts `**foo**` markdown-ish runs into
 *     <strong> tags).
 *   - Clicking the same article header again collapses it (toggleArticle
 *     resets expandedArticle to null on second click).
 *   - Only ONE article can be expanded at a time — clicking article B while
 *     article A is open closes A.
 *   - Renders a "Raise IT Ticket" form with subject (required), priority
 *     <select> (4 options, default Medium), description (required textarea).
 *   - On submit: POSTs JSON { subject, description, priority } to
 *     /api/tickets/submit via global fetch() (NOT fetchApi). On success,
 *     swaps to a "Ticket Received Securely" success card with a green
 *     ShieldAlert icon + a "Submit Another Bug" button that resets state.
 *   - On fetch rejection: calls notify.error("Portal failure communicating with Core API.").
 *
 * Hook usage:
 *   - useNotify() from '../utils/notify' — only `.error(msg)` is called.
 *   - useState for form / submitted / expandedArticle.
 *
 * No router needed (Portal renders no <Link> or useNavigate); no AuthContext
 * needed (Portal is a public ingress and does not read user/tenant).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Stable notify object reference (RTL standing rule from 2026-05-07: fresh
// objects per call → useCallback dep churn → infinite re-render).
const notifyError = vi.fn();
const notifyObj = {
  error: notifyError,
  info: vi.fn(),
  success: vi.fn(),
  confirm: () => Promise.resolve(true),
  prompt: () => Promise.resolve(''),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
  NotifyProvider: ({ children }) => children,
}));

import Portal from '../pages/Portal';

describe('Portal page', () => {
  beforeEach(() => {
    notifyError.mockClear();
    notifyObj.info.mockClear();
    notifyObj.success.mockClear();
    global.fetch = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'tkt_1' }) })
    );
  });

  afterEach(() => {
    delete global.fetch;
  });

  it('renders the hero heading and 6 hardcoded help articles', () => {
    render(<Portal />);
    expect(screen.getByRole('heading', { name: /Support & Knowledge Base/i })).toBeInTheDocument();
    expect(screen.getByText(/Getting Started with Globussoft CRM/i)).toBeInTheDocument();
    expect(screen.getByText(/Managing Contacts, Leads & Clients/i)).toBeInTheDocument();
    expect(screen.getByText(/Pipeline & Deal Management/i)).toBeInTheDocument();
    expect(screen.getByText(/Invoicing, Estimates & Expenses/i)).toBeInTheDocument();
    expect(screen.getByText(/Automation: Sequences & Workflows/i)).toBeInTheDocument();
    expect(screen.getByText(/Using the Developer Portal/i)).toBeInTheDocument();
  });

  it('shows the "Read knowledge base article →" hint on collapsed cards', () => {
    render(<Portal />);
    const hints = screen.getAllByText(/Read knowledge base article/i);
    // All 6 articles render their hint while collapsed.
    expect(hints.length).toBe(6);
  });

  it('expands an article body when its header is clicked', async () => {
    const user = userEvent.setup();
    render(<Portal />);
    // Body content for "Getting Started" includes the literal "Import your contacts" phrase.
    expect(screen.queryByText(/Import your contacts/i)).not.toBeInTheDocument();
    await user.click(screen.getByText(/Getting Started with Globussoft CRM/i));
    await waitFor(() => {
      expect(screen.getByText(/Import your contacts/i)).toBeInTheDocument();
    });
  });

  it('collapses an article when its header is clicked a second time', async () => {
    const user = userEvent.setup();
    render(<Portal />);
    const header = screen.getByText(/Getting Started with Globussoft CRM/i);
    await user.click(header);
    await waitFor(() => expect(screen.getByText(/Import your contacts/i)).toBeInTheDocument());
    await user.click(header);
    await waitFor(() => expect(screen.queryByText(/Import your contacts/i)).not.toBeInTheDocument());
  });

  it('only allows one article expanded at a time (clicking another closes the first)', async () => {
    const user = userEvent.setup();
    render(<Portal />);
    await user.click(screen.getByText(/Getting Started with Globussoft CRM/i));
    await waitFor(() => expect(screen.getByText(/Import your contacts/i)).toBeInTheDocument());
    // Open a different article — first one should collapse.
    await user.click(screen.getByText(/Pipeline & Deal Management/i));
    await waitFor(() => {
      expect(screen.queryByText(/Import your contacts/i)).not.toBeInTheDocument();
      expect(screen.getByText(/Drag & Drop/i)).toBeInTheDocument();
    });
  });

  it('renders bold-text runs from **foo** markdown inside expanded article body', async () => {
    const user = userEvent.setup();
    render(<Portal />);
    await user.click(screen.getByText(/Getting Started with Globussoft CRM/i));
    // "Import your contacts" appears inside **bold** markers in the source.
    await waitFor(() => {
      const strongs = document.querySelectorAll('strong');
      const matches = Array.from(strongs).map(s => s.textContent);
      expect(matches.some(t => /Import your contacts/i.test(t))).toBe(true);
    });
  });

  it('renders the ticket form with subject, priority select, description, and submit button', () => {
    render(<Portal />);
    expect(screen.getByPlaceholderText(/Brief description of your issue/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Please explain the technical steps/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Lodge Support Case Payload/i })).toBeInTheDocument();
    // 4 priority options.
    expect(screen.getByText('Low')).toBeInTheDocument();
    expect(screen.getByText('Medium')).toBeInTheDocument();
    expect(screen.getByText('High')).toBeInTheDocument();
    expect(screen.getByText(/Urgent \(Showstopper\)/i)).toBeInTheDocument();
  });

  it('defaults priority to Medium', () => {
    render(<Portal />);
    const select = screen.getByRole('combobox');
    expect(select.value).toBe('Medium');
  });

  it('POSTs subject + description + priority to /api/tickets/submit and swaps to the success card', async () => {
    const user = userEvent.setup();
    render(<Portal />);
    await user.type(screen.getByPlaceholderText(/Brief description of your issue/i), 'VPN dropping');
    await user.type(
      screen.getByPlaceholderText(/Please explain the technical steps/i),
      'Disconnects every 5 minutes on macOS Sonoma'
    );
    await user.click(screen.getByRole('button', { name: /Lodge Support Case Payload/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('/api/tickets/submit');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body);
    expect(body.subject).toBe('VPN dropping');
    expect(body.description).toBe('Disconnects every 5 minutes on macOS Sonoma');
    expect(body.priority).toBe('Medium');

    // Success card replaces the form.
    await waitFor(() => {
      expect(screen.getByText(/Ticket Received Securely/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Submit Another Bug/i })).toBeInTheDocument();
    });
  });

  it('shows notify.error on fetch rejection and stays on the form', async () => {
    global.fetch = vi.fn(() => Promise.reject(new Error('network down')));
    const user = userEvent.setup();
    render(<Portal />);
    await user.type(screen.getByPlaceholderText(/Brief description of your issue/i), 'Test');
    await user.type(screen.getByPlaceholderText(/Please explain the technical steps/i), 'Body');
    await user.click(screen.getByRole('button', { name: /Lodge Support Case Payload/i }));

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith('Portal failure communicating with Core API.');
    });
    // Still on the form — success card NOT rendered.
    expect(screen.queryByText(/Ticket Received Securely/i)).not.toBeInTheDocument();
  });

  it('"Submit Another Bug" button resets back to the empty form', async () => {
    const user = userEvent.setup();
    render(<Portal />);
    await user.type(screen.getByPlaceholderText(/Brief description of your issue/i), 'X');
    await user.type(screen.getByPlaceholderText(/Please explain the technical steps/i), 'Y');
    await user.click(screen.getByRole('button', { name: /Lodge Support Case Payload/i }));
    await waitFor(() => expect(screen.getByText(/Ticket Received Securely/i)).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /Submit Another Bug/i }));
    await waitFor(() => {
      expect(screen.queryByText(/Ticket Received Securely/i)).not.toBeInTheDocument();
      expect(screen.getByPlaceholderText(/Brief description of your issue/i)).toBeInTheDocument();
    });
    // Form fields should be cleared.
    expect(screen.getByPlaceholderText(/Brief description of your issue/i).value).toBe('');
    expect(screen.getByPlaceholderText(/Please explain the technical steps/i).value).toBe('');
  });

  it('changing the priority select propagates into the submitted payload', async () => {
    const user = userEvent.setup();
    render(<Portal />);
    await user.type(screen.getByPlaceholderText(/Brief description of your issue/i), 'Crash');
    await user.type(screen.getByPlaceholderText(/Please explain the technical steps/i), 'On startup');
    await user.selectOptions(screen.getByRole('combobox'), 'Urgent (Showstopper)');
    await user.click(screen.getByRole('button', { name: /Lodge Support Case Payload/i }));

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.priority).toBe('Urgent (Showstopper)');
  });
});
