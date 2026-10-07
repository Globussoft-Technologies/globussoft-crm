import { test, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  fetchApi: vi.fn(),
  notify: { info: vi.fn(), error: vi.fn(), confirm: vi.fn().mockResolvedValue(true) },
}));
vi.mock('../utils/api', () => ({ fetchApi: mocks.fetchApi }));
vi.mock('../utils/notify', () => ({ useNotify: () => mocks.notify }));
import WhatsAppTemplates from '../pages/wellness/WhatsAppTemplates';

test('Generic bulk send follows bounded cursors and preserves the campaign across batches', async () => {
  let batches = 0;
  mocks.fetchApi.mockImplementation(async (url, options) => {
    if (url.endsWith('generic-web-form-send-all')) {
      batches++;
      return { queued: batches === 1 ? 100 : 5, skipped: 0, failed: 0, campaignKey: 'campaign', nextCursor: batches === 1 ? 100 : null };
    }
    if (options?.method === 'POST') return {};
    return [{ id: 11, name: 'welcome', status: 'APPROVED', genericWebFormStatuses: [] }];
  });
  render(<MemoryRouter initialEntries={['/whatsapp/templates']}><WhatsAppTemplates /></MemoryRouter>);
  const selectors = await screen.findAllByRole('combobox');
  fireEvent.change(selectors[0], { target: { value: '11' } });
  const button = await screen.findByRole('button', { name: 'Send changed templates to existing leads' });
  fireEvent.click(button);
  await waitFor(() => expect(mocks.notify.info).toHaveBeenCalledWith('Queued 105 message(s). Skipped 0. Failed 0.'));
  const calls = mocks.fetchApi.mock.calls.filter(([url]) => url.endsWith('generic-web-form-send-all'));
  expect(JSON.parse(calls[0][1].body)).toEqual({ afterId: 0 });
  expect(JSON.parse(calls[1][1].body)).toEqual({ afterId: 100, campaignKey: 'campaign' });
});
