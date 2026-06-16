/**
 * VisaChecklists.test.jsx — vitest + RTL coverage for the Visa Sure
 * document-checklist TEMPLATE admin (frontend/src/pages/travel/visa/Checklists.jsx).
 *
 * The page graduated from a Phase-3 SHELL to a real CRUD admin over the
 * VisaChecklistTemplate model (PRD FR-6.1):
 *   GET    /api/travel/visa/checklists           — list templates
 *   POST   /api/travel/visa/checklists           — add a document
 *   PUT    /api/travel/visa/checklists/:id        — toggle required
 *   DELETE /api/travel/visa/checklists/:id        — remove
 *
 * Mocking: stable useNotify object (CLAUDE.md RTL rule); fetchApi scripted per
 * URL + method.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../utils/api', () => ({ fetchApi: vi.fn() }));

const notifyObj = { error: vi.fn(), success: vi.fn(), info: vi.fn(), confirm: vi.fn() };
vi.mock('../utils/notify', () => ({ useNotify: () => notifyObj }));

import { fetchApi } from '../utils/api';
import VisaChecklists from '../pages/travel/visa/Checklists.jsx';

const ITEMS = [
  { id: 1, applicationType: 'tourist', destinationCountry: 'US', docType: 'Passport', required: true },
  { id: 2, applicationType: 'tourist', destinationCountry: 'US', docType: 'Bank statement', required: false },
  { id: 3, applicationType: 'student', destinationCountry: 'UK', docType: 'CAS letter', required: true },
];

function mockList(items = ITEMS) {
  fetchApi.mockImplementation((url, opts) => {
    const method = opts && opts.method;
    if (url === '/api/travel/visa/checklists' && method === 'POST') {
      return Promise.resolve({ id: 99, ...JSON.parse(opts.body) });
    }
    if (method === 'PUT' || method === 'DELETE') return Promise.resolve({ success: true });
    if (url === '/api/travel/visa/checklists') return Promise.resolve({ items });
    return Promise.resolve(null);
  });
}

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/travel/visa/checklists']}>
      <VisaChecklists />
    </MemoryRouter>,
  );

describe('VisaChecklists (template admin)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the heading and loads checklist items grouped by type × destination', async () => {
    mockList();
    renderPage();
    expect(screen.getByRole('heading', { level: 1, name: /Visa Checklists/i })).toBeInTheDocument();
    expect(await screen.findByText('Passport')).toBeInTheDocument();
    expect(screen.getByText('Bank statement')).toBeInTheDocument();
    expect(screen.getByText('CAS letter')).toBeInTheDocument();
  });

  it('adds a document via the form (POST with the right body)', async () => {
    mockList();
    renderPage();
    await screen.findByText('Passport');
    fireEvent.change(screen.getByTestId('checklist-add-country'), { target: { value: 'Canada' } });
    fireEvent.change(screen.getByTestId('checklist-add-doc'), { target: { value: 'Photo' } });
    fireEvent.click(screen.getByTestId('checklist-add-submit'));
    await waitFor(() => {
      const post = fetchApi.mock.calls.find((c) => c[0] === '/api/travel/visa/checklists' && c[1] && c[1].method === 'POST');
      expect(post).toBeTruthy();
      const body = JSON.parse(post[1].body);
      expect(body.docType).toBe('Photo');
      expect(body.destinationCountry).toBe('Canada');
      expect(body.applicationType).toBe('tourist');
    });
    expect(await screen.findByText('Photo')).toBeInTheDocument();
  });

  it('deletes a row (DELETE) and removes it from the list', async () => {
    mockList();
    renderPage();
    await screen.findByText('Passport');
    fireEvent.click(screen.getByTestId('checklist-delete-1'));
    await waitFor(() => {
      const del = fetchApi.mock.calls.find((c) => c[1] && c[1].method === 'DELETE');
      expect(del).toBeTruthy();
    });
    await waitFor(() => expect(screen.queryByText('Passport')).toBeNull());
  });

  it('toggles required via PUT', async () => {
    mockList();
    renderPage();
    await screen.findByText('Passport');
    fireEvent.click(screen.getByTestId('checklist-required-1'));
    await waitFor(() => {
      const put = fetchApi.mock.calls.find((c) => c[1] && c[1].method === 'PUT');
      expect(put).toBeTruthy();
      expect(JSON.parse(put[1].body).required).toBe(false);
    });
  });

  it('shows an empty state when there are no templates', async () => {
    mockList([]);
    renderPage();
    expect(await screen.findByText(/No checklist templates yet/i)).toBeInTheDocument();
  });

  it('has a Back to Visa Sure link', async () => {
    mockList([]);
    renderPage();
    const back = screen.getByRole('link', { name: /Back to Visa Sure/i });
    expect(back).toHaveAttribute('href', '/travel/visa');
  });
});

// ── Quotation templates tab (FR-5.2) ──────────────────────────────────
// The checklist admin page extends to manage quotation templates too, behind
// a "Quotation templates" tab that lazily loads its own data on first switch.
const QUOTES = [
  {
    id: 11,
    name: 'Tourist visa — standard',
    applicationType: 'tourist',
    currency: 'INR',
    isActive: true,
    lines: [
      { label: 'Service tier base price', amount: 5000 },
      { label: 'Credit: free entry diagnostic', amount: -500 },
    ],
  },
];

function mockBoth(quotes = QUOTES) {
  fetchApi.mockImplementation((url, opts) => {
    const method = opts && opts.method;
    if (url === '/api/travel/visa/quotation-templates' && method === 'POST') {
      return Promise.resolve({ id: 99, ...JSON.parse(opts.body) });
    }
    if (url.startsWith('/api/travel/visa/quotation-templates')) {
      if (method === 'DELETE' || method === 'PUT') return Promise.resolve({ success: true });
      return Promise.resolve({ items: quotes });
    }
    // checklists load on initial (default) tab mount
    if (url === '/api/travel/visa/checklists') return Promise.resolve({ items: [] });
    return Promise.resolve(null);
  });
}

describe('VisaChecklists — quotation templates tab (FR-5.2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('switching to the Quotation templates tab loads + lists templates', async () => {
    mockBoth();
    renderPage();
    fireEvent.click(screen.getByTestId('tab-quotations'));
    expect(await screen.findByText('Tourist visa — standard')).toBeInTheDocument();
    // Line items + a credit line render.
    expect(screen.getByText('Service tier base price')).toBeInTheDocument();
    expect(screen.getByText('Credit: free entry diagnostic')).toBeInTheDocument();
    const getCall = fetchApi.mock.calls.find(
      (c) => c[0] === '/api/travel/visa/quotation-templates' && (!c[1] || !c[1].method),
    );
    expect(getCall).toBeTruthy();
  });

  it('adds a quotation template (POST with name + applicationType + lines)', async () => {
    mockBoth();
    renderPage();
    fireEvent.click(screen.getByTestId('tab-quotations'));
    await screen.findByText('Tourist visa — standard');
    fireEvent.change(screen.getByTestId('quote-add-name'), { target: { value: 'Student visa — UK' } });
    fireEvent.change(screen.getByTestId('quote-add-type'), { target: { value: 'student' } });
    fireEvent.change(screen.getByTestId('quote-line-label-0'), { target: { value: 'CAS processing' } });
    fireEvent.change(screen.getByTestId('quote-line-amount-0'), { target: { value: '8000' } });
    fireEvent.click(screen.getByTestId('quote-add-submit'));
    await waitFor(() => {
      const post = fetchApi.mock.calls.find(
        (c) => c[0] === '/api/travel/visa/quotation-templates' && c[1] && c[1].method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(post[1].body);
      expect(body.name).toBe('Student visa — UK');
      expect(body.applicationType).toBe('student');
      expect(body.lines).toEqual([{ label: 'CAS processing', amount: 8000 }]);
    });
    expect(await screen.findByText('Student visa — UK')).toBeInTheDocument();
  });

  it('rejects an empty-name or no-line submit before calling POST', async () => {
    mockBoth();
    renderPage();
    fireEvent.click(screen.getByTestId('tab-quotations'));
    await screen.findByText('Tourist visa — standard');
    // No name, no line label → submit should not POST.
    fireEvent.click(screen.getByTestId('quote-add-submit'));
    await waitFor(() => expect(notifyObj.error).toHaveBeenCalled());
    const post = fetchApi.mock.calls.find(
      (c) => c[0] === '/api/travel/visa/quotation-templates' && c[1] && c[1].method === 'POST',
    );
    expect(post).toBeFalsy();
  });

  it('deletes a quotation template (DELETE) and removes the row', async () => {
    mockBoth();
    renderPage();
    fireEvent.click(screen.getByTestId('tab-quotations'));
    await screen.findByText('Tourist visa — standard');
    fireEvent.click(screen.getByTestId('quote-delete-11'));
    await waitFor(() => {
      const del = fetchApi.mock.calls.find(
        (c) => c[0] === '/api/travel/visa/quotation-templates/11' && c[1] && c[1].method === 'DELETE',
      );
      expect(del).toBeTruthy();
    });
    await waitFor(() => expect(screen.queryByText('Tourist visa — standard')).toBeNull());
  });

  it('shows the quotation empty state when there are no templates', async () => {
    mockBoth([]);
    renderPage();
    fireEvent.click(screen.getByTestId('tab-quotations'));
    expect(await screen.findByText(/No quotation templates yet/i)).toBeInTheDocument();
  });
});
