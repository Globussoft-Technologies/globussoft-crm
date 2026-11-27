import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import RichTextNotePreview from '../components/contact/RichTextNotePreview';

describe('Generic CRM note preview', () => {
  it('renders sent-email subjects with normal quotes instead of HTML entities', () => {
    render(<RichTextNotePreview value={'Sent email: "Lead update acknowledgement"'} />);

    expect(screen.getByText('Sent email: "Lead update acknowledgement"')).toBeInTheDocument();
    expect(screen.queryByText(/&quot;/)).not.toBeInTheDocument();
  });

  it('shows a stored image and provides a details action', () => {
    render(<RichTextNotePreview value={'<img src="/api/uploads/images/note.png" alt="Selected note">'} />);
    expect(screen.getByRole('img', { name: 'Selected note' })).toHaveAttribute(
      'src',
      'http://localhost:3000/api/uploads/images/note.png',
    );
    expect(screen.getByRole('button', { name: 'View details' })).toBeInTheDocument();
  });

  it('shows View details when a text preview exceeds two lines', () => {
    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
    const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 60 });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 30 });
    render(<RichTextNotePreview value="A long generic CRM note that occupies more than two lines." />);
    expect(screen.getByRole('button', { name: 'View details' })).toBeInTheDocument();
    if (originalScrollHeight) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight);
    if (originalClientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight);
    vi.restoreAllMocks();
  });

  it('shows View details when a single-line note is horizontally truncated', () => {
    const originalScrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth');
    const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get: () => 300 });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 120 });
    render(<RichTextNotePreview value="A long generic CRM note truncated with an ellipsis." />);
    expect(screen.getByRole('button', { name: 'View details' })).toBeInTheDocument();
    if (originalScrollWidth) Object.defineProperty(HTMLElement.prototype, 'scrollWidth', originalScrollWidth);
    if (originalClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth);
    vi.restoreAllMocks();
  });
});
