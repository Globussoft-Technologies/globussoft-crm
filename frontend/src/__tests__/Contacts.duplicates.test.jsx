/**
 * Contacts.jsx — Find Duplicates UI affordances (#592).
 *
 * Pre-#592, the Find Duplicates panel surfaced 780 duplicate groups in a
 * read-only list with no way to act on them. The fix adds two affordances
 * per group:
 *   - "Merge into Primary" (already existed pre-#592 but had no confirm)
 *   - "Dismiss" (new — POSTs to /api/contacts/duplicates/dismiss)
 *
 * This spec asserts the buttons render on every group card AND the
 * destructive-merge confirm fires before the network call goes out.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';
import Contacts from '../pages/Contacts';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

const confirmMock = vi.fn(() => Promise.resolve(true));
const errorMock = vi.fn();
vi.mock('../utils/notify', () => ({
  useNotify: () => ({
    error: errorMock,
    success: vi.fn(),
    info: vi.fn(),
    confirm: (...args) => confirmMock(...args),
    prompt: () => Promise.resolve(''),
  }),
}));

const SEEDED_GROUPS = [
  {
    primary: { id: 1, name: 'Aarav Sharma', email: 'aarav@example.com', company: 'Acme', aiScore: 80 },
    duplicates: [
      { id: 2, name: 'Aarav Sharma', email: 'aarav@example.com', company: 'Acme', aiScore: 50 },
    ],
    reason: 'Same email',
    groupKey: 'abcdef0123456789',
  },
  {
    primary: { id: 10, name: 'Sneha Iyer', email: 'sneha@example.com', company: 'Wellness Co', aiScore: 70 },
    duplicates: [
      { id: 11, name: 'Sneha Iyer', email: 'sneha+1@example.com', company: 'Wellness Co', aiScore: 60 },
      { id: 12, name: 'Sneha Iyer', email: 'sneha+2@example.com', company: 'Wellness Co', aiScore: 55 },
    ],
    reason: 'Same name + company',
    groupKey: 'fedcba9876543210',
  },
];

beforeEach(() => {
  fetchApiMock.mockReset();
  confirmMock.mockReset();
  errorMock.mockReset();
  fetchApiMock.mockImplementation((url) => {
    if (url === '/api/contacts/duplicates/find') return Promise.resolve(SEEDED_GROUPS);
    if (url === '/api/contacts') return Promise.resolve([]);
    if (url === '/api/staff') return Promise.resolve([]);
    if (url === '/api/contacts/merge') return Promise.resolve({ success: true, merged: 1, primaryId: 1 });
    if (url === '/api/contacts/duplicates/dismiss') return Promise.resolve({ success: true, groupKey: 'abcdef0123456789' });
    return Promise.resolve(null);
  });
  confirmMock.mockResolvedValue(true);
});

function renderContacts() {
  return render(
    <MemoryRouter>
      <Contacts />
    </MemoryRouter>,
  );
}

async function openFindDuplicates() {
  const btn = await screen.findByRole('button', { name: /Find Duplicates/i });
  fireEvent.click(btn);
}

describe('Contacts.jsx — duplicate group UI (#592)', () => {
  it('renders Merge AND Dismiss buttons on every duplicate group', async () => {
    renderContacts();
    await openFindDuplicates();

    // Wait for the modal to populate with the seeded groups.
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /Merge into Primary/i }).length).toBe(SEEDED_GROUPS.length);
    });
    expect(screen.getAllByRole('button', { name: /Dismiss duplicate group/i }).length).toBe(SEEDED_GROUPS.length);
  });

  it('asks for confirmation before firing the merge POST (destructive)', async () => {
    renderContacts();
    await openFindDuplicates();

    const mergeButtons = await screen.findAllByRole('button', { name: /Merge into Primary/i });
    fireEvent.click(mergeButtons[0]);

    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    // The confirm should be flagged destructive so the dialog can render the
    // red-button treatment.
    const callArg = confirmMock.mock.calls[0][0];
    expect(callArg).toMatchObject({ destructive: true });

    await waitFor(() => {
      const mergeCall = fetchApiMock.mock.calls.find(([url]) => url === '/api/contacts/merge');
      expect(mergeCall).toBeTruthy();
      expect(JSON.parse(mergeCall[1].body)).toEqual({ primaryId: 1, secondaryIds: [2] });
    });
  });

  it('does NOT fire the merge POST when the user cancels the confirm', async () => {
    confirmMock.mockResolvedValueOnce(false);
    renderContacts();
    await openFindDuplicates();

    const mergeButtons = await screen.findAllByRole('button', { name: /Merge into Primary/i });
    fireEvent.click(mergeButtons[0]);

    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    const mergeCall = fetchApiMock.mock.calls.find(([url]) => url === '/api/contacts/merge');
    expect(mergeCall).toBeFalsy();
  });

  it('dismiss POSTs the contact-id list to /api/contacts/duplicates/dismiss', async () => {
    renderContacts();
    await openFindDuplicates();

    const dismissButtons = await screen.findAllByRole('button', { name: /Dismiss duplicate group/i });
    fireEvent.click(dismissButtons[1]); // Sneha Iyer group — primary 10, dups [11,12]

    await waitFor(() => {
      const dismissCall = fetchApiMock.mock.calls.find(([url]) => url === '/api/contacts/duplicates/dismiss');
      expect(dismissCall).toBeTruthy();
      const body = JSON.parse(dismissCall[1].body);
      expect(body).toEqual({ primaryId: 10, secondaryIds: [11, 12] });
    });
  });
});
