/**
 * LeadsImportExport.test.jsx - wiring test for the Leads page import/export toolbar.
 *
 * Pins the page-level contract that the Leads header renders the shared CSV/XLSX
 * toolbar with the generic contacts endpoints, so the page keeps showing the same
 * import/export affordance as Patients.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: vi.fn(() => 'fake-token'),
}));

const toolbarSpy = vi.fn();
vi.mock('../components/wellness/CsvImportExportToolbar', () => ({
  default: (props) => {
    toolbarSpy(props);
    return (
      <div
        data-testid="leads-csv-toolbar"
        data-entity={props.entity}
        data-label={props.label || ''}
        data-formats={JSON.stringify(props.formats || [])}
        data-export={props.endpoints?.export || ''}
        data-template={props.endpoints?.template || ''}
        data-import={props.endpoints?.import || ''}
      />
    );
  },
}));

import { AuthContext } from '../App';
import Leads from '../pages/Leads';

function renderLeads() {
  const authValue = {
    user: { userId: 1, name: 'Admin', email: 'admin@example.com', role: 'ADMIN' },
    token: 'fake-token',
    tenant: { id: 1, vertical: 'generic', name: 'Generic CRM' },
    loading: false,
  };

  return render(
    <MemoryRouter>
      <AuthContext.Provider value={authValue}>
        <Leads />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchApiMock.mockReset();
  toolbarSpy.mockReset();
  fetchApiMock.mockImplementation((url, opts) => {
    if (opts?.method === 'POST') return Promise.resolve({ id: 1 });
    if (opts?.method === 'PUT') return Promise.resolve({ ok: true });
    if (typeof url === 'string' && url.startsWith('/api/contacts?status=Lead')) return Promise.resolve([]);
    if (url === '/api/staff' && !opts) return Promise.resolve([]);
    if (url === '/api/integrations/callified/config' && !opts) return Promise.resolve({ isActive: false });
    if (url === '/api/callified/campaigns/with-lead-counts' && !opts) return Promise.resolve({ campaigns: [] });
    if (typeof url === 'string' && url.startsWith('/api/callified/leads/call-summary') && !opts) {
      return Promise.resolve({ summaries: {} });
    }
    return Promise.resolve([]);
  });
});

describe('<Leads /> import/export toolbar wiring', () => {
  it('renders the shared contacts CSV/XLSX toolbar with the leads endpoints', async () => {
    renderLeads();

    await waitFor(() => expect(screen.getByTestId('leads-csv-toolbar')).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: /Leads/i })).toBeInTheDocument();
    expect(toolbarSpy).toHaveBeenCalled();

    const props = toolbarSpy.mock.calls.at(-1)[0];
    expect(props.entity).toBe('contacts');
    expect(props.label).toBe('Leads');
    expect(props.formats).toEqual(['csv', 'xlsx']);
    expect(props.endpoints).toMatchObject({
      export: '/api/csv/contacts/export.csv',
      template: '/api/csv/contacts/template.csv',
      meta: '/api/csv/contacts',
      import: '/api/csv/contacts/import.csv',
    });
  });
});
