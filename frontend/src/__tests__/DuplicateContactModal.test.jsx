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

  // -------------------------------------------------------------------------
  // Extended coverage — edge cases on matchedBy fallback, contact projection
  // gating, partial-field rendering, accessibility wiring, and idempotent
  // callback behaviour. Brings test ratio from 59% (111L/186L) to ~115%+.
  // -------------------------------------------------------------------------

  it('falls back to the "email or phone number" label when matchedBy is unrecognised', () => {
    renderModal({ matchedBy: 'something_else' });
    expect(screen.getByRole('dialog')).toHaveTextContent(
      /email or phone number already exists/i
    );
  });

  it('falls back to the "email or phone number" label when matchedBy is undefined', () => {
    renderModal({ matchedBy: undefined });
    expect(screen.getByRole('dialog')).toHaveTextContent(
      /email or phone number already exists/i
    );
  });

  it('omits the contact projection block entirely when contact is null', () => {
    renderModal({ contact: null, existingContactId: 100 });
    // The dialog still renders (operator can still pick a path), but the
    // projection card with name/email/phone is not shown.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByText('Alice Cooper')).not.toBeInTheDocument();
    expect(screen.queryByText(/Contact #100/)).not.toBeInTheDocument();
    // The three action buttons are still rendered.
    expect(screen.getByText('Edit details')).toBeInTheDocument();
    expect(screen.getByText('Create anyway')).toBeInTheDocument();
    expect(screen.getByText('Open existing')).toBeInTheDocument();
  });

  it('omits the Status line when contact.status is missing', () => {
    renderModal({
      contact: {
        id: 42,
        name: 'Bob Builder',
        email: 'bob@example.com',
      },
    });
    expect(screen.getByText('Bob Builder')).toBeInTheDocument();
    expect(screen.queryByText(/Status:/i)).not.toBeInTheDocument();
  });

  it('renders only the email line when phone + company + status are absent', () => {
    renderModal({
      contact: {
        id: 5,
        name: 'Solo Mio',
        email: 'solo@example.com',
      },
    });
    expect(screen.getByText('Solo Mio')).toBeInTheDocument();
    expect(screen.getByText('solo@example.com')).toBeInTheDocument();
    expect(screen.queryByText(/\+\d/)).not.toBeInTheDocument(); // no phone-shaped text
    expect(screen.queryByText('Acme Inc')).not.toBeInTheDocument();
    expect(screen.queryByText(/Status:/i)).not.toBeInTheDocument();
  });

  it('renders only the phone line when email + company + status are absent', () => {
    renderModal({
      contact: {
        id: 6,
        name: 'Phone Only',
        phone: '+1-555-0123',
      },
    });
    expect(screen.getByText('Phone Only')).toBeInTheDocument();
    expect(screen.getByText('+1-555-0123')).toBeInTheDocument();
    expect(screen.queryByText(/@/)).not.toBeInTheDocument(); // no email
  });

  it('declares aria attributes for screen readers (role="dialog", aria-modal, aria-labelledby)', () => {
    renderModal();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-labelledby', 'dup-contact-modal-title');
    // And the labelledby target must actually exist in the DOM, otherwise
    // assistive tech finds nothing to announce.
    const title = document.getElementById('dup-contact-modal-title');
    expect(title).not.toBeNull();
    expect(title).toHaveTextContent(/Possible duplicate contact/i);
  });

  it('renders exactly three actionable affordances (Edit details, Create anyway, Open existing)', () => {
    renderModal();
    // The two callback buttons.
    expect(screen.getByRole('button', { name: 'Edit details' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create anyway' })).toBeInTheDocument();
    // The Link rendered as an anchor — react-router-dom's <Link> emits an <a>.
    const openExisting = screen.getByText('Open existing').closest('a');
    expect(openExisting).toBeInTheDocument();
    expect(openExisting.tagName).toBe('A');
    // And the header close button is a SEPARATE element with aria-label "Close".
    const closeBtn = screen.getByLabelText('Close');
    expect(closeBtn).toBeInTheDocument();
    expect(closeBtn.tagName).toBe('BUTTON');
  });

  it('"Create anyway" is enabled and clickable when creating=false', () => {
    const { props } = renderModal({ creating: false });
    const btn = screen.getByText('Create anyway');
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    fireEvent.click(btn);
    // Parent owns idempotency / debounce; the component fires the callback
    // for every click while enabled.
    expect(props.onCreateAnyway).toHaveBeenCalledTimes(2);
  });

  it('header close button and Edit details button both invoke the SAME callback', () => {
    const { props } = renderModal();
    fireEvent.click(screen.getByLabelText('Close'));
    fireEvent.click(screen.getByText('Edit details'));
    // Both routes are deliberately the same path (close-modal) so the parent
    // sees one channel for cancellation regardless of which UI affordance the
    // operator used.
    expect(props.onEditDetails).toHaveBeenCalledTimes(2);
  });

  it('"Open existing" link href reflects the existingContactId prop verbatim (no normalization)', () => {
    renderModal({ existingContactId: 0 });
    // existingContactId=0 is a degenerate value but the component should not
    // silently rewrite it — the parent owns validation. The link still emits
    // /contacts/0 so the bug is visible to the operator if it happens.
    const link = screen.getByText('Open existing').closest('a');
    expect(link).toHaveAttribute('href', '/contacts/0');
  });
});
