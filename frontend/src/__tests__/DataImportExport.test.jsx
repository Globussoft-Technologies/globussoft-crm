/**
 * DataImportExport.test.jsx - coverage for the unified CSV hub.
 *
 * This test pins the generic CRM behavior: on a non-wellness tenant, the
 * first dropdown option should be Contacts and the toolbar must receive the
 * generic /api/csv/contacts/* endpoints rather than the wellness PHI routes.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const toolbarSpy = vi.fn();
vi.mock('../components/wellness/CsvImportExportToolbar', () => ({
  default: (props) => {
    toolbarSpy(props);
    return (
      <div
        data-testid="toolbar"
        data-entity={props.entity}
        data-export={props.endpoints?.export || ''}
        data-template={props.endpoints?.template || ''}
      >
        {props.label}
      </div>
    );
  },
}));

import { AuthContext } from '../App';
import DataImportExport from '../pages/DataImportExport';

function renderPage(tenant = { id: 1, vertical: 'generic' }) {
  const user = { userId: 1, name: 'Admin', email: 'admin@example.com', role: 'ADMIN' };
  return render(
    <AuthContext.Provider value={{ user, token: 'tk', tenant, loading: false }}>
      <DataImportExport />
    </AuthContext.Provider>,
  );
}

describe('<DataImportExport />', () => {
  it('uses generic contacts endpoints for a generic tenant', () => {
    renderPage();

    expect(screen.getByRole('heading', { name: /Import \/ Export Data/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Contacts' })).toBeInTheDocument();
    expect(screen.getByTestId('toolbar')).toHaveTextContent('Contacts');
    expect(screen.getByTestId('toolbar')).toHaveAttribute('data-entity', 'contacts');
    expect(screen.getByTestId('toolbar')).toHaveAttribute('data-export', '/api/csv/contacts/export.csv');
    expect(screen.getByTestId('toolbar')).toHaveAttribute('data-template', '/api/csv/contacts/template.csv');
    expect(toolbarSpy).toHaveBeenCalled();
  });

  it('switches to the wellness patient dataset for a wellness tenant', () => {
    renderPage({ id: 2, vertical: 'wellness' });

    expect(screen.getByRole('option', { name: 'Patients' })).toBeInTheDocument();
    expect(screen.getByTestId('toolbar')).toHaveAttribute('data-entity', 'customers');
    expect(screen.getByTestId('toolbar')).toHaveTextContent('Patients');
  });
});
