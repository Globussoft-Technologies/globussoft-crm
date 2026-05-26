/**
 * DuplicateContactModal — presentational component test.
 *
 * The 409 DUPLICATE_CONTACT pop-up surfaced on the generic Contacts page
 * (PRD §4.5 Phase 2 dedup; mirrors the RFU passport-collision modal that
 * shipped in commit 106b7dc).
 *
 * The component is pure presentational (props in, callbacks out) — the
 * parent owns dupModal + creatingContact state and the POST retry, so the
 * test surface is just rendering + button wiring + the Link href.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import DuplicateContactModal from '../components/DuplicateContactModal';

function renderModal(overrides = {}) {
  const props = {
    existingContactId: 42,
    matchedBy: 'email',
    contact: {
      id: 42,
      name: 'Alice Cooper',
      email: 'alice@example.com',
      phone: '+91-9876543210',
      company: 'Acme Inc',
      status: 'Lead',
    },
    creating: false,
    onEditDetails: vi.fn(),
    onCreateAnyway: vi.fn(),
    ...overrides,
  };
  const utils = render(
    <MemoryRouter>
      <DuplicateContactModal {...props} />
    </MemoryRouter>
  );
  return { props, ...utils };
}

describe('DuplicateContactModal', () => {
  it('renders the existing contact projection (name + email + phone + company + status)', () => {
    renderModal();
    expect(screen.getByText('Alice Cooper')).toBeInTheDocument();
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    expect(screen.getByText('+91-9876543210')).toBeInTheDocument();
    expect(screen.getByText('Acme Inc')).toBeInTheDocument();
    expect(screen.getByText(/Status: Lead/i)).toBeInTheDocument();
  });

  it('labels the duplicate match for matchedBy="email"', () => {
    renderModal({ matchedBy: 'email' });
    expect(screen.getByRole('dialog')).toHaveTextContent(/email address already exists/i);
  });

  it('labels the duplicate match for matchedBy="phone"', () => {
    renderModal({ matchedBy: 'phone' });
    expect(screen.getByRole('dialog')).toHaveTextContent(/phone number already exists/i);
  });

  it('labels the duplicate match for matchedBy="both"', () => {
    renderModal({ matchedBy: 'both' });
    expect(screen.getByRole('dialog')).toHaveTextContent(
      /email and phone number already exists/i
    );
  });

  it('clicking "Edit details" fires onEditDetails', () => {
    const { props } = renderModal();
    fireEvent.click(screen.getByText('Edit details'));
    expect(props.onEditDetails).toHaveBeenCalledTimes(1);
    expect(props.onCreateAnyway).not.toHaveBeenCalled();
  });

  it('clicking the header close button also fires onEditDetails', () => {
    const { props } = renderModal();
    fireEvent.click(screen.getByLabelText('Close'));
    expect(props.onEditDetails).toHaveBeenCalledTimes(1);
  });

  it('clicking "Create anyway" fires onCreateAnyway (and only that)', () => {
    const { props } = renderModal();
    fireEvent.click(screen.getByText('Create anyway'));
    expect(props.onCreateAnyway).toHaveBeenCalledTimes(1);
    expect(props.onEditDetails).not.toHaveBeenCalled();
  });

  it('disables "Create anyway" while creating=true and shows the loading label', () => {
    const { props } = renderModal({ creating: true });
    const btn = screen.getByText('Creating…');
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(props.onCreateAnyway).not.toHaveBeenCalled();
  });

  it('"Open existing" link points to /contacts/<existingContactId>', () => {
    renderModal({ existingContactId: 99 });
    const link = screen.getByText('Open existing').closest('a');
    expect(link).toHaveAttribute('href', '/contacts/99');
  });

  it('falls back to "Contact #<id>" when the contact has no name', () => {
    renderModal({
      existingContactId: 7,
      contact: { id: 7, email: 'nameless@example.com' },
    });
    expect(screen.getByText('Contact #7')).toBeInTheDocument();
    expect(screen.getByText('nameless@example.com')).toBeInTheDocument();
  });
});
