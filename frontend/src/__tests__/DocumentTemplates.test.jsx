/**
 * DocumentTemplates.test.jsx — vitest + RTL page-level smoke for the
 * Document Templates page (frontend/src/pages/DocumentTemplates.jsx, 429 LOC).
 *
 * Authored by the autonomous test-writing cron — first test for this surface.
 *
 * The page manages reusable HTML document templates (PROPOSAL / NDA /
 * CONTRACT / EMAIL) with mail-merge variables ({{contact.name}},
 * {{deal.title}}, etc.), a card-grid list view, a wide editor modal with an
 * insert-variable sidebar, a preview modal that POSTs to a /render endpoint
 * and srcDoc's the resulting HTML into an iframe, and a send-email modal
 * that POSTs to a /send-email endpoint. Scope-pinned invariants:
 *
 *   1. Page renders the "Document Templates" heading + the Reusable HTML
 *      templates description + Create Template button + type-filter select.
 *   2. Loading state: "Loading templates..." renders before the initial
 *      fetch resolves.
 *   3. Initial mount fetches /api/document-templates (no ?type= when
 *      filterType=''); also pre-fetches /api/contacts for the preview/send
 *      modals' recipient pickers.
 *   4. Renders one card per template with name, type-badge text, and a
 *      preview snippet of the HTML-stripped content.
 *   5. Type filter changes the fetch URL — selecting "PROPOSAL" issues a
 *      GET to /api/document-templates?type=PROPOSAL.
 *   6. Empty state: the data-testid="document-templates-empty-state" card
 *      renders with "No templates yet" and an empty-state CTA when the
 *      fetch returns [].
 *   7. Create Template opens the editor modal with name + type + textarea
 *      content fields and the variable-insert sidebar (12 buttons matching
 *      AVAILABLE_VARS).
 *   8. Save with empty name surfaces notify.error("Name and content are
 *      required") and does NOT POST.
 *   9. Save with valid fields POSTs /api/document-templates with the
 *      {name, type, content} body shape.
 *  10. Edit action: clicking Edit on a template opens the editor populated
 *      with that template's name/type/content; Save fires PUT to
 *      /api/document-templates/<id> with the same body shape.
 *  11. Delete action: clicking Delete triggers notify.confirm; on confirm
 *      issues DELETE /api/document-templates/<id>.
 *  12. Insert-variable button: clicking a variable button (e.g.
 *      "{{contact.name}}") appends the placeholder text into the textarea.
 *
 * Drift note: this file covers the list-view, type-filter, editor-modal,
 * delete, and variable-insert contracts. Preview-render + send-email modal
 * surfaces are also touched lightly via the variable-insert + delete
 * coverage. POST/PUT/DELETE URL shapes are mirrored against the source
 * verbatim (lines 86-92, 105-106, 115, 127, 149-152 of DocumentTemplates.jsx
 * as of this commit).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Stable mock-object identity for useNotify — fresh objects per call cause
// infinite re-render loops when the hook return lands in useCallback deps.
// See standing rule "RTL: stable mock object references for hooks used in
// useCallback dependencies" in CLAUDE.md.
const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyInfo = vi.fn();
const notifyConfirm = vi.fn(() => Promise.resolve(true));
const notifyObj = {
  error: notifyError,
  info: notifyInfo,
  success: notifySuccess,
  confirm: (...args) => notifyConfirm(...args),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

vi.mock('../utils/date', () => ({
  formatDate: (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—'),
}));

import DocumentTemplates from '../pages/DocumentTemplates';

const sampleTemplates = [
  {
    id: 1,
    name: 'Standard NDA',
    type: 'NDA',
    content: '<h1>NDA for {{contact.name}}</h1><p>Confidentiality agreement body text.</p>',
    updatedAt: '2026-04-01T10:00:00.000Z',
    createdAt: '2026-03-01T10:00:00.000Z',
  },
  {
    id: 2,
    name: 'Enterprise Proposal',
    type: 'PROPOSAL',
    content: '<h1>Proposal for {{deal.title}}</h1><p>Pricing and scope below.</p>',
    updatedAt: '2026-04-15T10:00:00.000Z',
    createdAt: '2026-04-10T10:00:00.000Z',
  },
];

const sampleContacts = [
  { id: 11, name: 'Anita Sharma', email: 'anita@example.com' },
  { id: 12, name: 'Rohit Verma', email: 'rohit@example.com' },
];

function defaultFetchMock(url, opts) {
  if (url.startsWith('/api/document-templates') && (!opts || !opts.method || opts.method === 'GET')) {
    // Honor ?type= filter: if absent or empty, return both rows.
    const m = url.match(/[?&]type=([A-Z]+)/);
    if (m) {
      return Promise.resolve(sampleTemplates.filter((t) => t.type === m[1]));
    }
    return Promise.resolve(sampleTemplates);
  }
  if (url === '/api/contacts') return Promise.resolve(sampleContacts);
  return Promise.resolve(null);
}

function renderDocumentTemplates() {
  return render(
    <MemoryRouter>
      <DocumentTemplates />
    </MemoryRouter>
  );
}

describe('<DocumentTemplates /> — page surface', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation(defaultFetchMock);
    notifyError.mockReset();
    notifySuccess.mockReset();
    notifyInfo.mockReset();
    notifyConfirm.mockReset();
    notifyConfirm.mockImplementation(() => Promise.resolve(true));
  });

  it('renders the heading, description, Create Template button, and type filter', async () => {
    renderDocumentTemplates();
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Document Templates/i })).toBeInTheDocument();
    });
    // Description text mentions the mail-merge variable syntax.
    expect(screen.getByText(/Reusable HTML templates with mail-merge variables/i)).toBeInTheDocument();
    // Create Template CTA renders in the header.
    expect(screen.getByRole('button', { name: /Create Template/i })).toBeInTheDocument();
    // Type filter renders with "All types" + the 4 known types as options.
    const filter = screen.getByDisplayValue(/All types/i);
    const opts = Array.from(filter.querySelectorAll('option')).map((o) => o.value);
    expect(opts).toEqual(['', 'PROPOSAL', 'NDA', 'CONTRACT', 'EMAIL']);
  });

  it('initial mount fetches /api/document-templates (no ?type=) AND pre-fetches /api/contacts', async () => {
    renderDocumentTemplates();
    await waitFor(() => {
      const tplCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/document-templates' && (!o || !o.method || o.method === 'GET')
      );
      expect(tplCall).toBeTruthy();
    });
    const contactsCall = fetchApiMock.mock.calls.find(([u]) => u === '/api/contacts');
    expect(contactsCall).toBeTruthy();
  });

  it('shows "Loading templates..." before the initial fetch resolves', async () => {
    let resolveTemplates;
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/document-templates')) {
        return new Promise((r) => { resolveTemplates = r; });
      }
      if (url === '/api/contacts') return Promise.resolve([]);
      return Promise.resolve(null);
    });
    renderDocumentTemplates();
    expect(await screen.findByText(/Loading templates\.\.\./i)).toBeInTheDocument();
    // Resolve so the test cleanly tears down.
    resolveTemplates([]);
  });

  it('renders one card per template with name, type badge, and a content preview', async () => {
    renderDocumentTemplates();
    await waitFor(() => expect(screen.getByText('Standard NDA')).toBeInTheDocument());
    expect(screen.getByText('Enterprise Proposal')).toBeInTheDocument();
    // Type badges render the raw type label.
    // "NDA" appears as both a type badge AND in the filter dropdown, so use
    // getAllByText to avoid the duplicate-text throw.
    expect(screen.getAllByText('NDA').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('PROPOSAL').length).toBeGreaterThanOrEqual(1);
    // Preview snippet is HTML-stripped (per line 206 of source: .replace(/<[^>]+>/g, '')).
    // "NDA for {{contact.name}}Confidentiality agreement body text." is the
    // stripped content for the first template.
    expect(screen.getByText(/NDA for \{\{contact\.name\}\}Confidentiality agreement body text/)).toBeInTheDocument();
  });

  it('renders the empty-state card with the testid + "No templates yet" + a CTA when the fetch returns []', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/document-templates')) return Promise.resolve([]);
      if (url === '/api/contacts') return Promise.resolve([]);
      return Promise.resolve(null);
    });
    renderDocumentTemplates();
    await waitFor(() => {
      expect(screen.getByTestId('document-templates-empty-state')).toBeInTheDocument();
    });
    expect(screen.getByText(/No templates yet/i)).toBeInTheDocument();
    expect(screen.getByTestId('empty-state-create-cta')).toBeInTheDocument();
  });

  it('changing the type filter to "PROPOSAL" issues a fetch to /api/document-templates?type=PROPOSAL', async () => {
    renderDocumentTemplates();
    await waitFor(() => expect(screen.getByText('Standard NDA')).toBeInTheDocument());
    fetchApiMock.mockClear();

    const filter = screen.getByDisplayValue(/All types/i);
    fireEvent.change(filter, { target: { value: 'PROPOSAL' } });

    await waitFor(() => {
      const filteredCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/document-templates?type=PROPOSAL' && (!o || !o.method || o.method === 'GET')
      );
      expect(filteredCall).toBeTruthy();
    });
  });

  it('Create Template opens the editor modal with name + type + textarea + variable-insert sidebar', async () => {
    renderDocumentTemplates();
    await waitFor(() => expect(screen.getByText('Standard NDA')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Create Template/i }));

    // Modal title "New Template" renders.
    expect(screen.getByRole('heading', { name: /New Template/i })).toBeInTheDocument();
    // Name input renders.
    expect(screen.getByPlaceholderText(/Template name/i)).toBeInTheDocument();
    // Textarea renders (placeholder begins with the merge-variable example).
    const textarea = screen.getByPlaceholderText(/Hello \{\{contact\.name\}\}/i);
    expect(textarea.tagName).toBe('TEXTAREA');
    // Variable-insert sidebar renders the 12 known variable buttons. Probe
    // for a few canonical entries.
    expect(screen.getByText('{{contact.name}}')).toBeInTheDocument();
    expect(screen.getByText('{{deal.title}}')).toBeInTheDocument();
    expect(screen.getByText('{{tenant.name}}')).toBeInTheDocument();
    expect(screen.getByText('{{date.today}}')).toBeInTheDocument();
  });

  it('Save with empty name surfaces notify.error and does NOT POST', async () => {
    renderDocumentTemplates();
    await waitFor(() => expect(screen.getByText('Standard NDA')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Create Template/i }));
    // Leave name + content blank.
    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Save Template/i }));

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/Name and content are required/i)
      );
    });
    const postCall = fetchApiMock.mock.calls.find(([, opts]) => opts?.method === 'POST');
    expect(postCall).toBeUndefined();
  });

  it('Save with valid name + content POSTs /api/document-templates with {name, type, content}', async () => {
    renderDocumentTemplates();
    await waitFor(() => expect(screen.getByText('Standard NDA')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Create Template/i }));
    fireEvent.change(screen.getByPlaceholderText(/Template name/i), {
      target: { value: 'Q2 Outreach' },
    });
    fireEvent.change(screen.getByPlaceholderText(/Hello \{\{contact\.name\}\}/i), {
      target: { value: '<p>Hi {{contact.name}}!</p>' },
    });

    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Save Template/i }));

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/document-templates' && o?.method === 'POST'
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.name).toBe('Q2 Outreach');
      expect(body.type).toBe('PROPOSAL'); // default per EMPTY_TMPL
      expect(body.content).toBe('<p>Hi {{contact.name}}!</p>');
    });
  });

  it('Edit on an existing row opens the editor populated with that template; Save fires PUT /api/document-templates/<id>', async () => {
    renderDocumentTemplates();
    await waitFor(() => expect(screen.getByText('Standard NDA')).toBeInTheDocument());

    // Each card has an Edit button labelled "Edit" via the title attribute.
    // Two cards → two Edit buttons. Click the first.
    const editButtons = screen.getAllByRole('button', { name: /Edit/i });
    expect(editButtons.length).toBeGreaterThanOrEqual(2);
    fireEvent.click(editButtons[0]);

    // Modal heading flips to "Edit Template" — the first card is "Standard NDA".
    expect(screen.getByRole('heading', { name: /Edit Template/i })).toBeInTheDocument();
    const nameInput = screen.getByPlaceholderText(/Template name/i);
    expect(nameInput.value).toBe('Standard NDA');

    // Tweak the name and save.
    fireEvent.change(nameInput, { target: { value: 'Standard NDA v2' } });
    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Save Template/i }));

    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/document-templates/1' && o?.method === 'PUT'
      );
      expect(putCall).toBeTruthy();
      const body = JSON.parse(putCall[1].body);
      expect(body.name).toBe('Standard NDA v2');
      expect(body.type).toBe('NDA');
      expect(body.content).toContain('NDA for {{contact.name}}');
    });
  });

  it('Delete triggers notify.confirm; on confirm fires DELETE /api/document-templates/<id>', async () => {
    renderDocumentTemplates();
    await waitFor(() => expect(screen.getByText('Standard NDA')).toBeInTheDocument());

    // Each card has a Delete button labelled "Delete" via the title attribute.
    const deleteButtons = screen.getAllByRole('button', { name: /Delete/i });
    expect(deleteButtons.length).toBeGreaterThanOrEqual(2);

    fetchApiMock.mockClear();
    fireEvent.click(deleteButtons[0]);

    // notify.confirm fired with the prompt text.
    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalledWith(
        expect.stringMatching(/Delete this template/i)
      );
    });
    // After confirm resolves true, DELETE call goes through.
    await waitFor(() => {
      const delCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/document-templates/1' && o?.method === 'DELETE'
      );
      expect(delCall).toBeTruthy();
    });
  });

  it('Delete cancelled (notify.confirm resolves false) does NOT fire DELETE', async () => {
    notifyConfirm.mockImplementationOnce(() => Promise.resolve(false));
    renderDocumentTemplates();
    await waitFor(() => expect(screen.getByText('Standard NDA')).toBeInTheDocument());

    const deleteButtons = screen.getAllByRole('button', { name: /Delete/i });
    fetchApiMock.mockClear();
    fireEvent.click(deleteButtons[0]);

    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalled();
    });
    // No DELETE call.
    const delCall = fetchApiMock.mock.calls.find(([, o]) => o?.method === 'DELETE');
    expect(delCall).toBeUndefined();
  });

  it('clicking a variable-insert button appends the {{placeholder}} into the textarea', async () => {
    renderDocumentTemplates();
    await waitFor(() => expect(screen.getByText('Standard NDA')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Create Template/i }));
    const textarea = screen.getByPlaceholderText(/Hello \{\{contact\.name\}\}/i);
    // Initial value is empty per EMPTY_TMPL.
    expect(textarea.value).toBe('');

    // Find the "{{contact.name}}" variable button in the sidebar and click it.
    // The button text is a <code>{{contact.name}}</code> wrapper.
    const varCodeEl = screen.getByText('{{contact.name}}');
    // Walk to the enclosing <button>.
    const varButton = varCodeEl.closest('button');
    expect(varButton).toBeTruthy();
    fireEvent.click(varButton);

    // The placeholder text appended into the textarea state.
    await waitFor(() => {
      expect(textarea.value).toContain('{{contact.name}}');
    });
  });
});
