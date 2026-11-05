import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import PlotPayouts from '../pages/PlotPayouts';
import { NotifyProvider } from '../utils/notify';

vi.mock('../utils/api', () => ({ fetchApi: vi.fn(), getAuthToken: vi.fn(() => 'test-token'), registerGlobalNotify: vi.fn() }));
import { fetchApi } from '../utils/api';

const workspace = {
  plots: [{ id: 30, name: 'Electronic City Greens', plotNumber: 'F-601', price: 7500000, availability: 'AVAILABLE' }],
  staff: [{ id: 7, name: 'Priya Sharma', role: 'USER' }, { id: 8, name: 'Arjun Patel', role: 'MANAGER' }],
  plans: [],
  records: [{ plot: { id: 30, name: 'Electronic City Greens', plotNumber: 'F-601' }, actualAmountPaise: 750000000, collectionTargetPaise: 750000000, collectedAmountPaise: 0, outstandingPaise: 750000000, status: 'NO_PAYMENT_COLLECTED', statusLabel: 'No payment collected', plan: null, rules: [] }],
};

const renderPage = () => render(<NotifyProvider><PlotPayouts /></NotifyProvider>);

beforeEach(() => {
  fetchApi.mockReset();
  fetchApi.mockResolvedValue(workspace);
});

describe('<PlotPayouts />', () => {
  it('loads the Finance Commissions workspace without selecting a plot automatically', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Commissions' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Rules/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('create-commission-rule')).toBeInTheDocument();
    expect(screen.queryByTestId('commission-plot-select')).not.toBeInTheDocument();
    expect(fetchApi).toHaveBeenCalledWith('/api/commissions/workspace', { silent: true });
  });

  it('lists saved rules and opens the rule creator', async () => {
    fetchApi.mockResolvedValue({ ...workspace, plans: [{ plotSiteId: 30, markupType: 'PERCENT', markupValue: 12, rules: [{ id: 42, name: 'Sales commission', commissionBasis: 'COLLECTED_AMOUNT', ratePercent: 8, applyToAllStaff: false, staffUserIds: [7], staff: [{ id: 7, name: 'Priya Sharma' }] }] }] });
    renderPage();
    expect(await screen.findByTestId('commission-rules-table')).toBeInTheDocument();
    expect(screen.getByText('#42')).toBeInTheDocument();
    expect(screen.getByText('Sales commission')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('create-commission-rule'));
    expect(await screen.findByTestId('commission-plot-select')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to rules' })).toBeInTheDocument();
  });

  it('opens rule details from the Rule ID in Records', async () => {
    const recordRule = { id: 42, name: 'Sales commission', basis: 'COLLECTED_AMOUNT', ratePercent: 8, applyToAllStaff: false, staffNames: ['Priya Sharma'], commissionPaise: 640000 };
    fetchApi.mockResolvedValue({ ...workspace, plans: [{ plotSiteId: 30, markupType: 'PERCENT', markupValue: 12, rules: [recordRule] }], records: [{ ...workspace.records[0], plan: { id: 5, markupType: 'PERCENT', markupValue: 12 }, collectionTargetPaise: 90000000, outstandingPaise: 90000000, rules: [recordRule] }] });
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: /Records/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'View details for rule 42' }));
    expect(await screen.findByRole('dialog', { name: 'Sales commission' })).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveTextContent('Rule ID #42');
    expect(screen.getByRole('dialog')).toHaveTextContent('Priya Sharma');
    fireEvent.click(screen.getByRole('button', { name: 'Close rule details' }));
    expect(screen.queryByRole('dialog', { name: 'Sales commission' })).not.toBeInTheDocument();
  });

  it('shows live records in the Records tab', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: /Records/ }));
    expect(await screen.findByText('Electronic City Greens')).toBeInTheDocument();
    expect(screen.getAllByText('No payment collected').length).toBeGreaterThan(0);
    expect(screen.getAllByText('₹75,00,000.00').length).toBeGreaterThanOrEqual(2);
  });

  it('shows payment, invoice, and message actions for a booked record', async () => {
    const bookedRecord = {
      ...workspace.records[0],
      booking: { id: 501, invoiceId: null, contact: { id: 88, name: 'Elena Rodriguez', email: 'elena@example.com', phone: '+919876543210' } },
    };
    fetchApi.mockResolvedValue({ ...workspace, records: [bookedRecord] });
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: /Records/ }));
    expect(await screen.findByRole('button', { name: /Mark payment completed/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Add invoice/ }));
    expect(await screen.findByRole('dialog', { name: 'Add invoice' })).toBeInTheDocument();
    expect(screen.getByLabelText('Invoice screenshot')).toBeInTheDocument();
    expect(screen.getByLabelText('Note')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close add invoice' }));
    fireEvent.click(screen.getByRole('button', { name: /Send payment message/ }));
    expect(await screen.findByRole('dialog', { name: 'Send payment message' })).toBeInTheDocument();
    expect(screen.getByLabelText('Message channel')).toHaveValue('email');
    fireEvent.click(screen.getByRole('button', { name: 'Close payment action' }));
    expect(screen.queryByRole('dialog', { name: 'Send payment message' })).not.toBeInTheDocument();
  });

  it('records a completed payment and sends the optional customer message', async () => {
    const bookedRecord = {
      ...workspace.records[0],
      booking: { id: 501, invoiceId: null, contact: { id: 88, name: 'Elena Rodriguez', email: 'elena@example.com', phone: '+919876543210' } },
    };
    fetchApi.mockImplementation(async (url) => {
      if (String(url).endsWith('/workspace')) return { ...workspace, records: [bookedRecord] };
      if (String(url).endsWith('/complete-payment')) return { status: 'COMPLETED', invoice: { id: 9001, invoiceNum: 'INV-9001' } };
      if (String(url).endsWith('/send-email')) return { success: true };
      return {};
    });
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: /Records/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Mark payment completed/ }));
    fireEvent.change(screen.getByLabelText('Payment reference'), { target: { value: 'UTR-9001' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mark completed' }));
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith('/api/commissions/records/30/complete-payment', expect.objectContaining({ method: 'POST', body: expect.stringContaining('UTR-9001') })));
    expect(fetchApi).toHaveBeenCalledWith('/api/communications/send-email', expect.objectContaining({ method: 'POST', body: expect.stringContaining('Elena Rodriguez') }));
  });

  it('paginates commission records and resets to the first page when filtered', async () => {
    const records = Array.from({ length: 11 }, (_value, index) => ({
      ...workspace.records[0],
      plot: { ...workspace.records[0].plot, id: 30 + index, name: `Plot ${index + 1}`, plotNumber: `P-${index + 1}` },
    }));
    fetchApi.mockResolvedValue({ ...workspace, records });
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: /Records/ }));

    expect(await screen.findByText('Showing 1–10 of 11 records')).toBeInTheDocument();
    expect(screen.getByText('Plot 1')).toBeInTheDocument();
    expect(screen.queryByText('Plot 11')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByText('Showing 11–11 of 11 records')).toBeInTheDocument();
    expect(screen.getByText('Plot 11')).toBeInTheDocument();
    expect(screen.queryByText('Plot 1')).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Search plot or customer'), { target: { value: 'Plot 1' } });
    expect(await screen.findByText('Showing 1–3 of 3 records')).toBeInTheDocument();
    expect(screen.getByText('Plot 1')).toBeInTheDocument();
  });

  it('supports larger row counts and loads additional rows while scrolling the fixed table', async () => {
    const records = Array.from({ length: 40 }, (_value, index) => ({
      ...workspace.records[0],
      plot: { ...workspace.records[0].plot, id: 30 + index, name: `Plot ${index + 1}`, plotNumber: `P-${index + 1}` },
    }));
    fetchApi.mockResolvedValue({ ...workspace, records });
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: /Records/ }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Rows per page' }), { target: { value: '50' } });

    expect(await screen.findByText('Showing 1–40 of 40 records')).toBeInTheDocument();
    expect(screen.queryByText('Plot 30')).not.toBeInTheDocument();

    const tableViewport = document.querySelector('.commission-records-table-wrap');
    fireEvent.scroll(tableViewport, { target: { scrollTop: 1000 } });
    expect(await screen.findByText('Plot 30')).toBeInTheDocument();
  });

  it('saves plot markup and a staff-specific commission rule', async () => {
    fetchApi.mockImplementation(async (url, _options = {}) => {
      if (String(url).endsWith('/workspace')) return workspace;
      if (String(url).includes('/plots/30/rules')) return { plan: { plotSiteId: 30 } };
      return {};
    });
    renderPage();
    fireEvent.click(await screen.findByTestId('create-commission-rule'));
    fireEvent.click(await screen.findByTestId('commission-plot-select'));
    fireEvent.click(screen.getAllByLabelText(/Electronic City Greens/).find((element) => element.tagName === 'INPUT'));
    fireEvent.change(screen.getByLabelText('Collection threshold (%)'), { target: { value: '12' } });
    fireEvent.change(screen.getByLabelText('Rule name'), { target: { value: 'Sales team commission' } });
    fireEvent.change(screen.getByLabelText('Rate (%)'), { target: { value: '8' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply to staff' }));
    fireEvent.click(screen.getAllByLabelText(/Priya Sharma/).find((element) => element.tagName === 'INPUT'));
    fireEvent.click(screen.getByRole('button', { name: 'Save rules for 1 plot' }));
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith('/api/commissions/plots/30/rules', expect.objectContaining({ method: 'PUT', body: expect.stringContaining('Sales team commission') })));
  });

  it('asks before moving a staff member from one rule to another', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('create-commission-rule'));
    fireEvent.click(await screen.findByTestId('commission-plot-select'));
    fireEvent.click(screen.getAllByLabelText(/Electronic City Greens/).find((element) => element.tagName === 'INPUT'));
    fireEvent.click(screen.getAllByRole('button', { name: /Apply to staff/ })[0]);
    fireEvent.click(screen.getAllByLabelText(/Priya Sharma/).find((element) => element.tagName === 'INPUT'));
    fireEvent.click(screen.getAllByRole('button', { name: /Apply to staff/ })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Add another rule' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Apply to staff' })[1]);
    fireEvent.click(screen.getAllByLabelText(/Priya Sharma/).find((element) => element.tagName === 'INPUT'));
    expect(await screen.findByRole('dialog', { name: 'Staff already assigned' })).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveTextContent(/Priya Sharma.*Rule 1/);
    fireEvent.click(screen.getByRole('button', { name: 'Override assignment' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Staff already assigned' })).toBeNull());
  });
});
