import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../../utils/api', () => ({ fetchApi: (...args) => fetchApiMock(...args) }));
vi.mock('../../utils/notify', () => ({
  useNotify: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), confirm: vi.fn() }),
}));
vi.mock('../../hooks/usePermissions', () => ({
  usePermissions: () => ({ hasPermission: () => false, isReady: true }),
}));
vi.mock('../../components/EditContactModal', () => ({ default: () => null }));
vi.mock('../../components/contact/ContactDetailsDrawer', () => ({ default: () => null }));

import WellnessLeadDetail from '../../pages/wellness/WellnessLeadDetail';

const CONTACT = {
  id: 42,
  name: 'Asha Wellness Lead',
  email: 'asha@example.com',
  phone: '+91 9876543210',
  status: 'Prospect',
  lifecycleStageKey: 'contacted',
  appointments: [],
};

const PATIENT = { id: 88, name: 'Asha Patient', source: 'website' };
const STAGE_LABELS = {
  new: 'New',
  contacted: 'Contacted',
  interested: 'Interested',
  qualified: 'Qualified',
  booked: 'Booked',
  active_patient: 'Active Patient',
  not_interested: 'Not Interested',
  not_qualified: 'Not Qualified',
  lost_lead: 'Lost Lead',
};

function makeFetchImpl(contact = CONTACT, activityPages = null, appointmentPages = null) {
  return (url, options = {}) => {
    if (url === `/api/contacts/${contact.id}` && options.method === 'PUT') {
      const payload = JSON.parse(options.body);
      const lifecycleActivity = {
        id: 99,
        type: 'Patient journey stage updated',
        description: `Updated from ${STAGE_LABELS[contact.lifecycleStageKey]} to ${STAGE_LABELS[payload.lifecycleStageKey]}${payload.lifecycleTransitionReason ? `. Reason: ${payload.lifecycleTransitionReason}` : ''}`,
        createdAt: '2026-11-23T11:30:00.000Z',
        user: { id: 7, name: 'Dr Wellness' },
      };
      return Promise.resolve({
        ...contact,
        status: payload.status,
        lifecycleStageKey: payload.lifecycleStageKey,
        lifecycleActivity,
      });
    }
    if (url === `/api/contacts/${contact.id}`) return Promise.resolve(contact);
    if (url.startsWith(`/api/contacts/${contact.id}/activities?`)) {
      const query = new URLSearchParams(url.slice(url.indexOf('?') + 1));
      const mode = query.get('type') === 'Note' ? 'notes' : 'activity';
      const page = Number(query.get('page')) || 1;
      if (activityPages) return Promise.resolve(activityPages[mode]?.[page] || { data: [], total: 0, page, limit: 20, totalPages: 1 });
      return Promise.resolve({ data: [], total: 0, page, limit: 20, totalPages: 1 });
    }
    if (url.startsWith('/api/wellness/visits?')) {
      const query = new URLSearchParams(url.slice(url.indexOf('?') + 1));
      const page = Number(query.get('page')) || 1;
      if (appointmentPages) {
        return Promise.resolve(appointmentPages[page] || {
          visits: [],
          pagination: { total: 0, page, limit: 20, pages: 1, hasNext: false },
        });
      }
      const limit = Number(query.get('limit')) || 20;
      const upcoming = (contact.appointments || [])
        .filter((appointment) => (
          new Date(appointment.appointmentDate).getTime() >= Date.now()
          && !['cancelled', 'completed', 'no-show'].includes(String(appointment.status || '').toLowerCase())
        ))
        .sort((left, right) => new Date(left.appointmentDate) - new Date(right.appointmentDate));
      const visits = upcoming.slice((page - 1) * limit, page * limit).map((appointment) => ({
        id: appointment.id,
        patientId: appointment.patientId,
        visitDate: appointment.appointmentDate,
        status: appointment.status,
        reason: appointment.reason,
        service: { name: appointment.serviceName },
        doctor: { name: appointment.doctorName },
      }));
      return Promise.resolve({
        visits,
        pagination: { total: upcoming.length, page, limit, pages: Math.max(1, Math.ceil(upcoming.length / limit)), hasNext: page * limit < upcoming.length },
      });
    }
    if (url.startsWith('/api/wellness/patients?')) return Promise.resolve({ patients: [PATIENT], total: 1 });
    if (url === '/api/wellness/locations' || url === '/api/staff?fields=summary') return Promise.resolve([]);
    return Promise.resolve({});
  };
}

function renderLead() {
  return render(
    <MemoryRouter initialEntries={['/wellness/leads/42']}>
      <Routes>
        <Route path="/wellness/leads/:id" element={<WellnessLeadDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchApiMock.mockReset();
  fetchApiMock.mockImplementation(makeFetchImpl());
});

describe('WellnessLeadDetail', () => {
  it('omits the Patients block while keeping patient records available in their tab', async () => {
    renderLead();

    expect(await screen.findByRole('heading', { name: 'Lead summary' })).toBeInTheDocument();
    expect(screen.queryByText('Linked clinical records')).not.toBeInTheDocument();
    expect(screen.queryByText('No patient record is linked to this lead yet. Linked patient charts will appear here.')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Next appointments' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Patient summary' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Patient records (1)' }));
    expect(await screen.findByRole('heading', { name: 'Linked patients' })).toBeInTheDocument();
    expect(screen.getByText('Asha Patient')).toBeInTheDocument();
  });

  it('updates a forward stage without asking for a reason', async () => {
    renderLead();
    await screen.findByRole('heading', { name: 'Lead summary' });

    fireEvent.click(screen.getByRole('button', { name: 'Qualified' }));

    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith('/api/contacts/42', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ status: 'Prospect', lifecycleStageKey: 'qualified' }),
    })));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('requires and records a reason for moving backward, then shows the actor and time in Activity', async () => {
    renderLead();
    await screen.findByRole('heading', { name: 'Lead summary' });

    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(fetchApiMock).not.toHaveBeenCalledWith('/api/contacts/42', expect.objectContaining({ method: 'PUT' }));

    fireEvent.click(screen.getByRole('button', { name: 'Confirm stage change' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a reason before changing this stage.');
    expect(fetchApiMock).not.toHaveBeenCalledWith('/api/contacts/42', expect.objectContaining({ method: 'PUT' }));

    fireEvent.change(screen.getByRole('textbox', { name: 'Reason for stage change' }), {
      target: { value: 'The lead was contacted by mistake.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm stage change' }));

    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith('/api/contacts/42', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({
        status: 'Lead',
        lifecycleStageKey: 'new',
        lifecycleTransitionReason: 'The lead was contacted by mistake.',
      }),
    })));

    fireEvent.click(screen.getByRole('button', { name: 'Activity' }));
    expect(await screen.findByText('Updated from Contacted to New. Reason: The lead was contacted by mistake.')).toBeInTheDocument();
    expect(screen.getByText(/Dr Wellness/)).toBeInTheDocument();
    expect(screen.getByText(/2026/)).toBeInTheDocument();
  });

  it('requires a reason when selecting an alternative stage from its dropdown', async () => {
    const interestedContact = { ...CONTACT, status: 'Prospect', lifecycleStageKey: 'interested' };
    fetchApiMock.mockImplementation(makeFetchImpl(interestedContact));
    renderLead();
    await screen.findByRole('heading', { name: 'Lead summary' });

    fireEvent.click(screen.getByRole('button', { name: 'Choose status for Interested' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Not Interested' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(fetchApiMock).not.toHaveBeenCalledWith('/api/contacts/42', expect.objectContaining({ method: 'PUT' }));

    fireEvent.change(screen.getByRole('textbox', { name: 'Reason for stage change' }), {
      target: { value: 'The patient decided not to proceed.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm stage change' }));

    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith('/api/contacts/42', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({
        status: 'Churned',
        lifecycleStageKey: 'not_interested',
        lifecycleTransitionReason: 'The patient decided not to proceed.',
      }),
    })));
  });

  it('loads more activities and notes when their fixed-height lists are scrolled', async () => {
    const makeRow = (id, type, description) => ({
      id,
      type,
      description,
      createdAt: `2026-11-${String(24 - id).padStart(2, '0')}T11:30:00.000Z`,
      user: { id: 7, name: 'Dr Wellness' },
    });
    const activityPages = {
      activity: {
        1: { data: [makeRow(1, 'Patient journey stage updated', 'Activity page one')], total: 2, page: 1, limit: 20, totalPages: 2 },
        2: { data: [makeRow(2, 'Patient journey stage updated', 'Activity page two')], total: 2, page: 2, limit: 20, totalPages: 2 },
      },
      notes: {
        1: { data: [makeRow(3, 'Note', 'Note page one')], total: 2, page: 1, limit: 20, totalPages: 2 },
        2: { data: [makeRow(4, 'Note', 'Note page two')], total: 2, page: 2, limit: 20, totalPages: 2 },
      },
    };
    fetchApiMock.mockImplementation(makeFetchImpl(CONTACT, activityPages));
    renderLead();
    await screen.findByRole('heading', { name: 'Lead summary' });

    fireEvent.click(screen.getByRole('button', { name: 'Activity' }));
    const activityList = await screen.findByRole('region', { name: 'Activity list' });
    expect(activityList.parentElement).toHaveClass('wellness-lead-scroll-tab');
    expect(await screen.findByText('Activity page one')).toBeInTheDocument();
    fireEvent.scroll(activityList);
    expect(await screen.findByText('Activity page two')).toBeInTheDocument();
    expect(fetchApiMock).toHaveBeenCalledWith('/api/contacts/42/activities?page=2&limit=20&excludeType=Note', { silent: true });

    fireEvent.click(screen.getByRole('button', { name: 'Notes' }));
    const notesList = await screen.findByRole('region', { name: 'Notes list' });
    expect(notesList.parentElement).toHaveClass('wellness-lead-scroll-tab');
    expect(await screen.findByText('Note page one')).toBeInTheDocument();
    fireEvent.scroll(notesList);
    expect(await screen.findByText('Note page two')).toBeInTheDocument();
    expect(fetchApiMock).toHaveBeenCalledWith('/api/contacts/42/activities?page=2&limit=20&type=Note', { silent: true });
  });

  it('shows only the nearest upcoming appointment in Overview', async () => {
    const contactWithAppointments = {
      ...CONTACT,
      appointments: [
        { id: 1, appointmentDate: new Date(Date.now() + 60 * 60 * 1000).toISOString(), serviceName: 'Nearest consultation', doctorName: 'Dr Rao', status: 'booked' },
        { id: 2, appointmentDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), serviceName: 'Later follow-up', doctorName: 'Dr Rao', status: 'booked' },
        { id: 3, appointmentDate: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), serviceName: 'Past check-in', doctorName: 'Dr Rao', status: 'booked' },
      ],
    };
    fetchApiMock.mockImplementation(makeFetchImpl(contactWithAppointments));
    renderLead();

    expect(await screen.findByText('Nearest consultation')).toBeInTheDocument();
    expect(screen.queryByText('Later follow-up')).not.toBeInTheDocument();
    expect(screen.queryByText('Past check-in')).not.toBeInTheDocument();
    expect(fetchApiMock).toHaveBeenCalledWith(
      '/api/wellness/visits?contactId=42&upcoming=true&page=1&limit=1&paginate=true&sortBy=asc',
      { silent: true },
    );
  });

  it('loads further upcoming appointments when the fixed-height list is scrolled', async () => {
    const appointmentPages = {
      1: {
        visits: [{ id: 601, patientId: 88, visitDate: '2027-01-03T10:00:00.000Z', status: 'booked', service: { name: 'First appointment' }, doctor: { name: 'Dr Rao' } }],
        pagination: { total: 2, page: 1, limit: 20, pages: 2, hasNext: true },
      },
      2: {
        visits: [{ id: 602, patientId: 88, visitDate: '2027-01-04T10:00:00.000Z', status: 'booked', service: { name: 'Second appointment' }, doctor: { name: 'Dr Rao' } }],
        pagination: { total: 2, page: 2, limit: 20, pages: 2, hasNext: false },
      },
    };
    fetchApiMock.mockImplementation(makeFetchImpl(CONTACT, null, appointmentPages));
    renderLead();
    await screen.findByRole('heading', { name: 'Lead summary' });

    fireEvent.click(screen.getByRole('button', { name: 'Appointments' }));
    const appointmentList = await screen.findByRole('region', { name: 'Upcoming appointments list' });
    expect(appointmentList.parentElement).toHaveClass('wellness-lead-scroll-tab');
    expect(await screen.findByText('First appointment')).toBeInTheDocument();
    fireEvent.scroll(appointmentList);
    expect(await screen.findByText('Second appointment')).toBeInTheDocument();
    expect(fetchApiMock).toHaveBeenCalledWith(
      '/api/wellness/visits?contactId=42&upcoming=true&page=2&limit=20&paginate=true&sortBy=asc',
      { silent: true },
    );
  });
});
