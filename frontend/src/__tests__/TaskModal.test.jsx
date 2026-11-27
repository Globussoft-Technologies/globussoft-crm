import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const { fetchApiMock, notifyError } = vi.hoisted(() => ({
  fetchApiMock: vi.fn(),
  notifyError: vi.fn(),
}));

vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

vi.mock('../utils/notify', () => ({
  useNotify: () => ({ error: notifyError, success: vi.fn() }),
}));

import { AuthContext } from '../appContexts';
import { TaskModal } from '../components/contact/ActionModals';

const CONTACT = { id: 7, name: 'Rakesh Rana' };

function renderTaskModal(vertical, { staff = [] } = {}) {
  return render(
    <AuthContext.Provider value={{ tenant: { vertical, timezone: 'UTC' }, user: { role: 'ADMIN', userId: 1 } }}>
      <TaskModal contact={CONTACT} staff={staff} onClose={vi.fn()} onDone={vi.fn()} />
    </AuthContext.Provider>,
  );
}

afterEach(() => {
  vi.useRealTimers();
  fetchApiMock.mockReset();
  notifyError.mockReset();
});

describe('TaskModal vertical-specific presentation', () => {
  it('shows the requested required markers, Due time label, and left-aligned actions for generic CRM', () => {
    renderTaskModal('generic');

    expect(screen.getByLabelText('Task type *')).toBeInTheDocument();
    expect(screen.getByLabelText('Priority *')).toBeInTheDocument();
    expect(screen.getByLabelText('Due time *')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Task' }).parentElement).toHaveClass('cp-task-actions--generic');
  });

  it('blocks a generic CRM due date and time that is earlier than now', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-27T10:30:00.000Z'));
    renderTaskModal('generic', { staff: [{ id: 2, name: 'Sales User', role: 'USER' }] });

    const dueDate = screen.getByLabelText('Due date *');
    const dueTime = screen.getByLabelText('Due time *');
    expect(dueDate).toHaveAttribute('min', '2026-11-27');

    fireEvent.change(screen.getByLabelText('Title *'), { target: { value: 'Follow up' } });
    fireEvent.change(screen.getByLabelText('Task type *'), { target: { value: 'Task' } });
    fireEvent.change(screen.getByLabelText('Assignee *'), { target: { value: '2' } });
    fireEvent.change(dueDate, { target: { value: '2026-11-27' } });
    expect(dueTime).toHaveAttribute('min', '10:30');
    fireEvent.change(dueTime, { target: { value: '10:29' } });
    const reportValidity = vi.fn();
    Object.defineProperty(dueTime, 'reportValidity', { configurable: true, value: reportValidity });
    fireEvent.blur(dueTime);
    expect(reportValidity).toHaveBeenCalledTimes(1);
    fireEvent.submit(screen.getByRole('button', { name: 'Add Task' }).closest('form'));

    expect(notifyError).toHaveBeenCalledWith('Due date and time cannot be in the past.');
    expect(fetchApiMock).not.toHaveBeenCalled();
  });

  it('keeps the non-generic task labels and right-aligned actions unchanged', () => {
    renderTaskModal('wellness');

    expect(screen.getByLabelText('Task type')).toBeInTheDocument();
    expect(screen.getByLabelText('Time')).toBeInTheDocument();
    expect(screen.getByLabelText('Due date *')).not.toHaveAttribute('min');
    expect(screen.getByLabelText('Time')).not.toHaveAttribute('min');
    const reportValidity = vi.fn();
    Object.defineProperty(screen.getByLabelText('Time'), 'reportValidity', { configurable: true, value: reportValidity });
    fireEvent.blur(screen.getByLabelText('Time'));
    expect(reportValidity).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Due time *')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Task' }).parentElement).not.toHaveClass('cp-task-actions--generic');
  });
});
