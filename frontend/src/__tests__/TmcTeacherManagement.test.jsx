import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useParams } from 'react-router-dom';

const { fetchApiMock, notifyObj, permissionState, subBrandState } = vi.hoisted(() => ({
  fetchApiMock: vi.fn(),
  notifyObj: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
  permissionState: { canReadRoles: true, isLoading: false },
  subBrandState: { activeSubBrand: 'tmc' },
}));

vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

vi.mock('../hooks/usePermissions', () => ({
  usePermissions: () => ({
    hasPermission: (module, action) => module === 'roles' && action === 'read' && permissionState.canReadRoles,
    isLoading: permissionState.isLoading,
  }),
}));

vi.mock('../utils/subBrand', () => ({
  useActiveSubBrand: () => ({ activeSubBrand: subBrandState.activeSubBrand }),
}));

import { AuthContext } from '../App';
import TmcTeacherManagement from '../pages/travel/TmcTeacherManagement';

function TripOverviewRouteProbe() {
  const { tripId } = useParams();
  const location = useLocation();
  return <div>Trip overview route: {tripId}{location.search}</div>;
}

function renderPage({
  activeSubBrand = 'tmc',
  subBrandAccess = null,
  vertical = 'travel',
  path = '/travel/tmc/teachers',
} = {}, responses = {}) {
  subBrandState.activeSubBrand = activeSubBrand;
  fetchApiMock.mockImplementation((url) => Promise.resolve(responses[url] || {}));
  return render(
    <AuthContext.Provider
      value={{
        user: { id: 1, role: 'ADMIN', userType: 'STAFF', email: 'admin@x', subBrandAccess },
        tenant: { vertical },
        token: 'tok',
        loading: false,
      }}
    >
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/travel/tmc/teachers" element={<TmcTeacherManagement />} />
          <Route path="/travel/tmc/teachers/:teacherId" element={<TmcTeacherManagement />} />
          <Route path="/travel/trips/:tripId" element={<TripOverviewRouteProbe />} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

const teacher = {
  id: 7,
  name: 'Asha Rao',
  email: 'asha@example.com',
  phone: '+91 90000 00000',
  company: 'Riverside School',
  createdAt: '2026-06-01T04:30:00.000Z',
  assignedTripCount: 1,
};

const teacherOverview = {
  teacher,
  trips: [{
    id: 41,
    tripCode: 'DAR-2026',
    destination: 'Darjeeling',
    departDate: '2026-11-06T00:00:00.000Z',
    returnDate: '2026-11-12T00:00:00.000Z',
    status: 'confirmed',
    parentPortalLink: 'https://example.com/tmc/register/parent?token=abc',
    participantCount: 1,
    parentCount: 1,
    parentRegistrations: [{ id: 91, name: 'Arijit Singh', email: 'arijit@example.com', phone: '+91 90000 00001', createdAt: '2026-09-10T00:00:00.000Z' }],
    participants: [{
      id: 601,
      tripId: 41,
      fullName: 'Manish Singh',
      studentDob: '2013-03-02T00:00:00.000Z',
      studentSchool: 'Riverside School',
      studentClass: '7',
      studentGender: 'Male',
      parentName: 'Arijit Singh',
      parentEmail: 'arijit@example.com',
      parentPhone: '+91 90000 00001',
      parentRelation: 'Father',
      applicationStatus: 'registered',
      createdAt: '2026-09-10T00:10:00.000Z',
    }],
  }],
};

function withTeacher(responses = {}) {
  return {
    '/api/portal/tmc/staff/teachers': { teachers: [teacher] },
    '/api/portal/tmc/staff/teachers/7/overview': teacherOverview,
    ...responses,
  };
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyObj.error.mockReset();
  notifyObj.success.mockReset();
  notifyObj.info.mockReset();
  permissionState.canReadRoles = true;
  permissionState.isLoading = false;
  subBrandState.activeSubBrand = 'tmc';
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TMC teacher onboarding pages', () => {
  it('shows the registration link with copy and open actions above the teacher directory', async () => {
    renderPage({}, withTeacher());

    expect(await screen.findByRole('heading', { name: 'Teacher OnBoarding' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Teacher registration link' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Registered teachers (1)' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute('href', expect.stringContaining('/tmc/register/teacher'));
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('/tmc/register/teacher')));
    expect(notifyObj.success).toHaveBeenCalledWith('Teacher registration link copied');
    expect(screen.queryByRole('region', { name: 'Teacher details' })).toBeNull();
  });

  it('opens a separate teacher subpage with profile timestamps and school details', async () => {
    renderPage({}, withTeacher());

    const directory = screen.getByRole('region', { name: 'Registered teachers' });
    fireEvent.click(await within(directory).findByRole('link', { name: /Asha Rao/ }));

    expect(await screen.findByRole('heading', { name: 'Teacher overview' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to teachers' })).toHaveAttribute('href', '/travel/tmc/teachers');
    expect(screen.getByText('Riverside School')).toBeInTheDocument();
    expect(screen.getAllByText('asha@example.com')).toHaveLength(2);
    expect(screen.getByText(/2026.*\d{1,2}:\d{2}/i)).toBeInTheDocument();
    expect(screen.queryByText('Trip participants', { exact: true })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Recent assigned trips' })).toBeInTheDocument();
  });

  it('opens a recent assigned trip in its TMC Trips overview', async () => {
    renderPage({ path: '/travel/tmc/teachers/7' }, withTeacher());

    expect(await screen.findByRole('heading', { name: 'Asha Rao' })).toBeInTheDocument();
    const tripLink = screen.getByRole('link', { name: 'Open Darjeeling in TMC Trips' });
    expect(tripLink).toHaveAttribute('href', '/travel/trips/41?tab=overview');

    fireEvent.click(tripLink);

    expect(await screen.findByText('Trip overview route: 41?tab=overview')).toBeInTheDocument();
  });

  it('shows assigned trips and trip-specific parent and student details with timestamps', async () => {
    renderPage({ path: '/travel/tmc/teachers/7' }, withTeacher());

    expect(await screen.findByRole('heading', { name: 'Asha Rao' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /Assigned Trips/ }));
    expect(await screen.findByText('DAR-2026')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Darjeeling in TMC Trips' })).toHaveAttribute('href', '/travel/trips/41?tab=overview');
    expect(screen.getByRole('button', { name: 'Copy parent portal link for Darjeeling' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /Parents & Students/ }));
    const tripSelect = screen.getByRole('combobox', { name: 'Select trip' });
    expect(tripSelect).toHaveTextContent('None selected');
    expect(screen.queryByRole('searchbox', { name: 'Search trips' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Parent portal registrations' })).toBeNull();
    fireEvent.click(tripSelect);
    expect(screen.getByRole('option', { name: 'None selected' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: /DAR-2026/ }));
    expect(await screen.findByRole('heading', { name: 'Parent portal registrations' })).toBeInTheDocument();
    expect(screen.getByText('Arijit Singh')).toBeInTheDocument();
    expect(screen.getByText('arijit@example.com')).toBeInTheDocument();
    expect(screen.getByText('Manish Singh')).toBeInTheDocument();
    expect(screen.getByText(/Class 7 · Riverside School · DOB .* 2013 · Male/)).toBeInTheDocument();
    expect(screen.getByText('Parent relation: Father')).toBeInTheDocument();
    expect(screen.getByText(/Student added.*2026.*\d{1,2}:\d{2}/i)).toBeInTheDocument();
    expect(screen.getAllByText(/2026.*\d{1,2}:\d{2}/i).length).toBeGreaterThanOrEqual(2);

    fireEvent.click(tripSelect);
    fireEvent.click(screen.getByRole('option', { name: 'None selected' }));
    expect(tripSelect).toHaveTextContent('None selected');
    expect(screen.queryByRole('heading', { name: 'Parent portal registrations' })).toBeNull();
  });

  it('loads parent registrations and unlinked participants in ten-row batches while scrolling', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const trip = {
      ...teacherOverview.trips[0],
      parentRegistrations: Array.from({ length: 12 }, (_, index) => ({
        id: 100 + index,
        name: 'Parent ' + (index + 1),
        email: 'parent' + (index + 1) + '@example.com',
        phone: '',
        createdAt: '2026-09-10T00:00:00.000Z',
      })),
      participants: Array.from({ length: 12 }, (_, index) => ({
        id: 700 + index,
        tripId: 41,
        fullName: 'Student ' + (index + 1),
        parentName: 'No matching parent',
        parentEmail: 'unmatched' + (index + 1) + '@example.com',
        applicationStatus: 'approved',
        createdAt: '2026-09-10T00:00:00.000Z',
      })),
    };
    renderPage({ path: '/travel/tmc/teachers/7' }, {
      '/api/portal/tmc/staff/teachers/7/overview': { teacher, trips: [trip] },
    });

    fireEvent.click(await screen.findByRole('tab', { name: /Parents & Students/ }));
    fireEvent.click(screen.getByRole('combobox', { name: 'Select trip' }));
    fireEvent.click(screen.getByRole('option', { name: /DAR-2026/ }));

    const parentList = screen.getByRole('region', { name: 'Parent portal registration list' });
    const participantList = screen.getByRole('region', { name: 'Participants without a parent portal account list' });
    expect(within(parentList).getByText('Parent 10')).toBeInTheDocument();
    expect(within(parentList).queryByText('Parent 11')).toBeNull();
    expect(within(participantList).getByText('Student 10')).toBeInTheDocument();
    expect(within(participantList).queryByText('Student 11')).toBeNull();

    fireEvent.scroll(parentList);
    fireEvent.scroll(participantList);
    expect(await within(parentList).findByText('Parent 11')).toBeInTheDocument();
    expect(await within(participantList).findByText('Student 11')).toBeInTheDocument();
  });

  it('starts with no trip selected and filters the trip dropdown by trip name or code', async () => {
    const secondTrip = {
      ...teacherOverview.trips[0],
      id: 42,
      tripCode: 'MYS-2027',
      destination: 'Mysore',
      parentRegistrations: [],
      participants: [],
    };
    renderPage({ path: '/travel/tmc/teachers/7' }, {
      '/api/portal/tmc/staff/teachers/7/overview': {
        teacher,
        trips: [...teacherOverview.trips, secondTrip],
      },
    });

    fireEvent.click(await screen.findByRole('tab', { name: /Parents & Students/ }));
    const tripSelect = screen.getByRole('combobox', { name: 'Select trip' });
    expect(tripSelect).toHaveTextContent('None selected');
    expect(screen.getByText('Select a trip to view its parent and student registrations.')).toBeInTheDocument();

    fireEvent.click(tripSelect);
    expect(screen.getByRole('option', { name: 'None selected' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search trips' }), { target: { value: 'MYS-2027' } });
    expect(screen.getByRole('option', { name: /MYS-2027/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Darjeeling/ })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: /MYS-2027/ }));
    expect(tripSelect).toHaveTextContent(/Mysore.*MYS-2027/);
  });

  it('loads assigned trips in ten-trip batches while scrolling', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const trips = Array.from({ length: 12 }, (_, index) => ({
      id: index + 1,
      tripCode: 'TRIP-' + (index + 1),
      destination: 'Trip ' + (index + 1),
      departDate: '2026-11-06T00:00:00.000Z',
      returnDate: '2026-11-07T00:00:00.000Z',
      status: 'confirmed',
      participantCount: 0,
      parentCount: 0,
      participants: [],
      parentRegistrations: [],
    }));
    renderPage({ path: '/travel/tmc/teachers/7' }, {
      '/api/portal/tmc/staff/teachers/7/overview': { teacher, trips },
    });

    fireEvent.click(await screen.findByRole('tab', { name: /Assigned Trips/ }));
    const tripList = screen.getByRole('region', { name: 'Assigned trips list' });
    expect(await within(tripList).findByText('Trip 1')).toBeInTheDocument();
    expect(within(tripList).getByText('Trip 10')).toBeInTheDocument();
    expect(within(tripList).queryByText('Trip 11')).toBeNull();
    fireEvent.scroll(tripList);
    expect(await within(tripList).findByText('Trip 11')).toBeInTheDocument();
  });

  it('searches and paginates the registered teacher directory', async () => {
    const teachers = Array.from({ length: 12 }, (_, index) => ({
      id: index + 1,
      name: 'Teacher ' + (index + 1),
      email: 'teacher' + (index + 1) + '@example.com',
      company: 'School ' + (index + 1),
      createdAt: '2026-06-01T04:30:00.000Z',
      assignedTripCount: index,
    }));
    renderPage({}, { '/api/portal/tmc/staff/teachers': { teachers } });

    const directory = screen.getByRole('region', { name: 'Registered teachers' });
    expect(await within(directory).findByText('Teacher 1')).toBeInTheDocument();
    expect(within(directory).queryByText('Teacher 11')).toBeNull();
    fireEvent.click(within(directory).getByRole('button', { name: 'Next page' }));
    expect(await within(directory).findByText('Teacher 11')).toBeInTheDocument();
    expect(within(directory).queryByText('Teacher 1')).toBeNull();

    fireEvent.change(screen.getByRole('textbox', { name: 'Search teachers by name, email, phone or school' }), { target: { value: 'School 12' } });
    expect(await within(directory).findByText('Teacher 12')).toBeInTheDocument();
    expect(within(directory).queryByText('Teacher 11')).toBeNull();
  });

  it('keeps TMC and roles.read access guards on both directory and detail routes', async () => {
    renderPage({ activeSubBrand: 'rfu' });
    expect(screen.getByTestId('access-denied')).toBeInTheDocument();
    expect(fetchApiMock).not.toHaveBeenCalled();

    cleanup();
    permissionState.canReadRoles = false;
    renderPage({ activeSubBrand: 'tmc', path: '/travel/tmc/teachers/7' });
    expect(screen.getByTestId('access-denied')).toBeInTheDocument();
    expect(fetchApiMock).not.toHaveBeenCalled();
  });

  it('allows a TMC-only user on the teacher directory when no sub-brand is explicitly selected', async () => {
    renderPage({ activeSubBrand: null, subBrandAccess: ['tmc'] }, {
      '/api/portal/tmc/staff/teachers': { teachers: [] },
    });

    expect(await screen.findByText('No teachers have registered yet.')).toBeInTheDocument();
    expect(screen.queryByTestId('access-denied')).not.toBeInTheDocument();
  });
});
