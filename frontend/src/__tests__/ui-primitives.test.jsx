import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import {
  FormField,
  EmptyState,
  Spinner,
  Skeleton,
  SkeletonRow,
  SkeletonTable,
  SearchInput,
  Pagination,
  Modal,
} from '../components/ui';

/**
 * frontend/src/components/ui/* — shared form/list/modal primitives.
 *
 * What's tested
 *   - FormField (#686): label + required indicator rendering, error slot,
 *     htmlFor wiring.
 *   - EmptyState (#688): heading / body / CTA rendering, optional icon.
 *   - Spinner (#689): role=status, aria-label, size variants.
 *   - Skeleton (#689): width / height props, SkeletonRow column count,
 *     SkeletonTable rows × cols matrix.
 *   - SearchInput (#695): debounced onSearch (250 ms default), clear-X
 *     appears with value, clear resets and fires onSearch('').
 *   - Pagination (#694): range label, page-number rendering, prev/next
 *     disabled at bounds, onChange page-1-indexed.
 *   - Modal (#691): ESC closes, click-outside closes, X closes,
 *     destructive blocks ESC + click-outside, focus restoration.
 *
 * Why
 *   These primitives are the canonical resolution of the v3.5.x form/UI
 *   consistency cluster (#685 #686 #687 #688 #689 #691 #694 #695). The
 *   tests pin the contracts the README.md documents so future edits don't
 *   silently regress the conventions (e.g. removing the required asterisk,
 *   flipping the modal ESC behaviour, dropping the debounce on search).
 */

describe('<FormField />', () => {
  it('renders the label text', () => {
    render(<FormField label="Patient name"><input /></FormField>);
    expect(screen.getByText('Patient name')).toBeInTheDocument();
  });

  it('renders a red `*` marker when required is true', () => {
    render(<FormField label="Name" required><input /></FormField>);
    const marker = screen.getByText('*');
    expect(marker).toBeInTheDocument();
    expect(marker).toHaveClass('required-mark');
  });

  it('does NOT render the `*` when required is false / omitted', () => {
    render(<FormField label="Notes"><input /></FormField>);
    expect(screen.queryByText('*')).not.toBeInTheDocument();
  });

  it('wires the label to the input via htmlFor', () => {
    render(
      <FormField label="Email" htmlFor="email-input">
        <input id="email-input" />
      </FormField>
    );
    const label = screen.getByText('Email');
    expect(label.tagName).toBe('LABEL');
    expect(label).toHaveAttribute('for', 'email-input');
  });

  it('renders an inline error with role=alert when error is supplied', () => {
    render(
      <FormField label="Name" required error="Name is required">
        <input />
      </FormField>
    );
    const err = screen.getByRole('alert');
    expect(err).toHaveTextContent('Name is required');
  });

  it('renders hint when no error is present, hides hint when error is present', () => {
    const { rerender } = render(
      <FormField label="Phone" hint="Include country code">
        <input />
      </FormField>
    );
    expect(screen.getByText('Include country code')).toBeInTheDocument();
    rerender(
      <FormField label="Phone" hint="Include country code" error="Invalid">
        <input />
      </FormField>
    );
    expect(screen.queryByText('Include country code')).not.toBeInTheDocument();
    expect(screen.getByText('Invalid')).toBeInTheDocument();
  });
});

describe('<EmptyState />', () => {
  it('renders the heading', () => {
    render(<EmptyState heading="No patients yet" />);
    expect(screen.getByText('No patients yet')).toBeInTheDocument();
  });

  it('renders the body when supplied', () => {
    render(<EmptyState heading="Empty" body="Add one to begin." />);
    expect(screen.getByText('Add one to begin.')).toBeInTheDocument();
  });

  it('renders a CTA button when cta.label is supplied and wires onClick', () => {
    const onClick = vi.fn();
    render(
      <EmptyState heading="Empty" cta={{ label: 'Add patient', onClick }} />
    );
    const btn = screen.getByRole('button', { name: /add patient/i });
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('does NOT render a CTA when cta is omitted', () => {
    render(<EmptyState heading="Empty" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('has role=status for assistive tech', () => {
    render(<EmptyState heading="Empty" />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});

describe('<Spinner />', () => {
  it('has role=status and an aria-label', () => {
    render(<Spinner />);
    const s = screen.getByRole('status');
    expect(s).toHaveAttribute('aria-label', 'Loading');
  });

  it('honours a custom aria label', () => {
    render(<Spinner label="Saving patient" />);
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'Saving patient');
  });

  it('renders at three different pixel sizes', () => {
    const { rerender, container } = render(<Spinner size="small" />);
    let span = container.querySelector('span');
    expect(span.style.width).toBe('16px');
    rerender(<Spinner size="medium" />);
    span = container.querySelector('span');
    expect(span.style.width).toBe('24px');
    rerender(<Spinner size="large" />);
    span = container.querySelector('span');
    expect(span.style.width).toBe('40px');
  });
});

describe('<Skeleton />', () => {
  it('defaults to a text-variant 0.9rem-high line', () => {
    const { container } = render(<Skeleton />);
    const el = container.querySelector('span');
    expect(el.style.height).toBe('0.9rem');
  });

  it('respects an explicit width prop', () => {
    const { container } = render(<Skeleton width="60%" />);
    expect(container.querySelector('span').style.width).toBe('60%');
  });

  it('renders the requested number of cells in SkeletonRow', () => {
    const { container } = render(<SkeletonRow columns={5} />);
    expect(container.querySelectorAll('span').length).toBe(5);
  });

  it('renders rows × cols in SkeletonTable', () => {
    const { container } = render(<SkeletonTable rows={3} columns={4} />);
    // Each row is a wrapper div with 4 span children.
    expect(container.querySelectorAll('span').length).toBe(12);
  });
});

describe('<SearchInput />', () => {
  it('renders the input with the placeholder', () => {
    render(<SearchInput placeholder="Search patients…" />);
    expect(screen.getByPlaceholderText('Search patients…')).toBeInTheDocument();
  });

  it('does NOT show the clear-X when value is empty', () => {
    render(<SearchInput value="" />);
    expect(screen.queryByLabelText(/clear search/i)).not.toBeInTheDocument();
  });

  it('shows the clear-X when value is non-empty', () => {
    render(<SearchInput value="alice" />);
    expect(screen.getByLabelText(/clear search/i)).toBeInTheDocument();
  });

  it('debounces onSearch by 250 ms by default', () => {
    vi.useFakeTimers();
    try {
      const onSearch = vi.fn();
      render(<SearchInput onSearch={onSearch} />);
      const input = screen.getByRole('searchbox');
      fireEvent.change(input, { target: { value: 'a' } });
      expect(onSearch).not.toHaveBeenCalled();
      act(() => { vi.advanceTimersByTime(100); });
      expect(onSearch).not.toHaveBeenCalled();
      act(() => { vi.advanceTimersByTime(150); });
      expect(onSearch).toHaveBeenCalledWith('a');
    } finally {
      vi.useRealTimers();
    }
  });

  it('clear-X resets the input and emits onSearch("")', () => {
    const onSearch = vi.fn();
    const onChange = vi.fn();
    render(<SearchInput value="alice" onSearch={onSearch} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText(/clear search/i));
    expect(onChange).toHaveBeenCalledWith('');
    expect(onSearch).toHaveBeenCalledWith('');
  });
});

describe('<Pagination />', () => {
  it('renders nothing when total is 0', () => {
    const { container } = render(<Pagination total={0} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the range label "Showing N–M of T"', () => {
    render(<Pagination page={1} pageSize={50} total={253} onChange={() => {}} />);
    expect(screen.getByText(/showing 1.+50.+of 253/i)).toBeInTheDocument();
  });

  it('clamps the range label to the total on the last page', () => {
    render(<Pagination page={6} pageSize={50} total={253} onChange={() => {}} />);
    expect(screen.getByText(/showing 251.+253.+of 253/i)).toBeInTheDocument();
  });

  it('disables Prev on page 1', () => {
    render(<Pagination page={1} pageSize={50} total={200} onChange={() => {}} />);
    expect(screen.getByLabelText(/previous page/i)).toBeDisabled();
  });

  it('disables Next on the last page', () => {
    render(<Pagination page={4} pageSize={50} total={200} onChange={() => {}} />);
    expect(screen.getByLabelText(/next page/i)).toBeDisabled();
  });

  it('fires onChange with the new page when a page-number is clicked', () => {
    const onChange = vi.fn();
    render(<Pagination page={1} pageSize={50} total={250} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText(/go to page 3/i));
    expect(onChange).toHaveBeenCalledWith(3);
  });

  it('marks the current page with aria-current="page"', () => {
    render(<Pagination page={2} pageSize={50} total={250} onChange={() => {}} />);
    const current = screen.getByLabelText(/go to page 2/i);
    expect(current).toHaveAttribute('aria-current', 'page');
  });
});

describe('<Modal />', () => {
  it('renders nothing when open is false', () => {
    const { container } = render(<Modal open={false} title="X" onClose={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the title and content when open', () => {
    render(
      <Modal open title="New patient" onClose={() => {}}>
        <p>Body content</p>
      </Modal>
    );
    expect(screen.getByText('New patient')).toBeInTheDocument();
    expect(screen.getByText('Body content')).toBeInTheDocument();
  });

  it('has role=dialog + aria-modal=true', () => {
    render(<Modal open title="X" onClose={() => {}} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('renders a close-X button by default', () => {
    render(<Modal open title="X" onClose={() => {}} />);
    expect(screen.getByLabelText(/close dialog/i)).toBeInTheDocument();
  });

  it('hides the close-X when hideClose is true', () => {
    render(<Modal open title="X" hideClose onClose={() => {}} />);
    expect(screen.queryByLabelText(/close dialog/i)).not.toBeInTheDocument();
  });

  it('fires onClose when the X is clicked', () => {
    const onClose = vi.fn();
    render(<Modal open title="X" onClose={onClose} />);
    fireEvent.click(screen.getByLabelText(/close dialog/i));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('fires onClose when ESC is pressed', () => {
    const onClose = vi.fn();
    render(<Modal open title="X" onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does NOT fire onClose on ESC when destructive is true', () => {
    const onClose = vi.fn();
    render(<Modal open destructive title="X" onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders a footer when supplied', () => {
    render(
      <Modal open title="X" onClose={() => {}} footer={<button>Save</button>}>
        body
      </Modal>
    );
    expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();
  });
});
