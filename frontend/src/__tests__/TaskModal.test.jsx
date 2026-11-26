import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../utils/notify', () => ({
  useNotify: () => ({ error: vi.fn(), success: vi.fn() }),
}));

import { AuthContext } from '../appContexts';
import { TaskModal } from '../components/contact/ActionModals';

const CONTACT = { id: 7, name: 'Rakesh Rana' };

function renderTaskModal(vertical) {
  return render(
    <AuthContext.Provider value={{ tenant: { vertical }, user: { role: 'ADMIN', userId: 1 } }}>
      <TaskModal contact={CONTACT} staff={[]} onClose={vi.fn()} onDone={vi.fn()} />
    </AuthContext.Provider>,
  );
}

describe('TaskModal vertical-specific presentation', () => {
  it('shows the requested required markers, Due time label, and left-aligned actions for generic CRM', () => {
    renderTaskModal('generic');

    expect(screen.getByLabelText('Task type *')).toBeInTheDocument();
    expect(screen.getByLabelText('Priority *')).toBeInTheDocument();
    expect(screen.getByLabelText('Due time *')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Task' }).parentElement).toHaveClass('cp-task-actions--generic');
  });

  it('keeps the non-generic task labels and right-aligned actions unchanged', () => {
    renderTaskModal('wellness');

    expect(screen.getByLabelText('Task type')).toBeInTheDocument();
    expect(screen.getByLabelText('Time')).toBeInTheDocument();
    expect(screen.queryByLabelText('Due time *')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Task' }).parentElement).not.toHaveClass('cp-task-actions--generic');
  });
});
