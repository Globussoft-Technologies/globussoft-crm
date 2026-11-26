import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  GraduationCap,
  Link2,
  Mail,
  Phone,
  RefreshCw,
  Search,
  School,
  Users,
} from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { createPortal } from 'react-dom';
import { AuthContext } from '../../App';
import AccessDenied from '../../components/AccessDenied';
import { usePermissions } from '../../hooks/usePermissions';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { useActiveSubBrand } from '../../utils/subBrand';
import { getTeacherRegistrationLink } from '../../utils/tmcLinks';
import './TmcTeacherManagement.css';

const PAGE_SIZE = 10;
const INFINITE_SCROLL_BATCH_SIZE = 10;

export default function TmcTeacherManagement() {
  const { teacherId } = useParams();
  const { user, tenant } = useContext(AuthContext) || {};
  const { activeSubBrand } = useActiveSubBrand();
  const { hasPermission, isLoading: permissionsLoading } = usePermissions();
  const rawSubBrandAccess = user?.subBrandAccess;
  let subBrandAccess = rawSubBrandAccess;
  if (typeof rawSubBrandAccess === 'string') {
    try {
      subBrandAccess = JSON.parse(rawSubBrandAccess);
    } catch {
      subBrandAccess = [];
    }
  }
  const canAccessTmc = subBrandAccess == null || (Array.isArray(subBrandAccess) && subBrandAccess.includes('tmc'));
  const isTmcOnlyUser = Array.isArray(subBrandAccess) && subBrandAccess.length === 1 && subBrandAccess[0] === 'tmc';
  const isInTmcSubBrand = activeSubBrand === 'tmc' || (!activeSubBrand && isTmcOnlyUser);

  if (tenant?.vertical !== 'travel' || !canAccessTmc || !isInTmcSubBrand) {
    return (
      <AccessDenied
        title="TMC teacher onboarding is unavailable"
        message="Select the TMC sub-brand from the sidebar to manage TMC teachers."
      />
    );
  }
  if (permissionsLoading) return <div role="status">Loading permissions…</div>;
  if (!hasPermission('roles', 'read')) {
    return <AccessDenied permission={{ module: 'roles', action: 'read' }} />;
  }

  return teacherId
    ? <TeacherDetailPage teacherId={teacherId} />
    : <TeacherDirectoryPage />;
}

function TeacherDirectoryPage() {
  const notify = useNotify();
  const [teachers, setTeachers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [copied, setCopied] = useState(false);
  const registrationLink = getTeacherRegistrationLink();

  const loadTeachers = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const response = await fetchApi('/api/portal/tmc/staff/teachers');
      setTeachers(Array.isArray(response?.teachers) ? response.teachers : []);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTeachers();
  }, [loadTeachers]);

  useEffect(() => {
    setPage(1);
  }, [search]);

  const filteredTeachers = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return teachers;
    return teachers.filter((teacher) => [teacher.name, teacher.email, teacher.phone, teacher.company]
      .some((value) => String(value || '').toLowerCase().includes(query)));
  }, [search, teachers]);
  const pageCount = Math.max(1, Math.ceil(filteredTeachers.length / PAGE_SIZE));
  const visibleTeachers = filteredTeachers.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const assignedTripCount = teachers.reduce((count, teacher) => count + Number(teacher.assignedTripCount || 0), 0);

  async function copyRegistrationLink() {
    try {
      await navigator.clipboard.writeText(registrationLink);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
      notify.success?.('Teacher registration link copied');
    } catch {
      notify.error?.('Copy was not available. Select and copy the link manually.');
    }
  }

  return (
    <main className="tmc-teacher-page">
      <header className="tmc-teacher-page__heading">
        <div>
          <h1>Teacher OnBoarding</h1>
          <p>Share the registration link and manage TMC teacher profiles.</p>
        </div>
      </header>

      <section className="tmc-teacher-page__registration" aria-labelledby="tmc-registration-heading">
        <span className="tmc-teacher-page__icon-box"><Link2 size={19} /></span>
        <div className="tmc-teacher-page__registration-copy">
          <h2 id="tmc-registration-heading">Teacher registration link</h2>
          <p>Share this permanent link with teachers to register for the Teacher Portal.</p>
        </div>
        <div className="tmc-teacher-page__registration-actions">
          <button type="button" className="btn-secondary" onClick={copyRegistrationLink}>
            {copied ? <Check size={15} /> : <Copy size={15} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
          <a className="btn-secondary" href={registrationLink} target="_blank" rel="noreferrer">
            <ExternalLink size={15} /> Open
          </a>
        </div>
      </section>

      <section className="tmc-teacher-page__directory" aria-label="Registered teachers">
        <div className="tmc-teacher-page__directory-heading">
          <div>
            <h2>Registered teachers {!loading && !error && <span>({filteredTeachers.length})</span>}</h2>
            <p>Search the teacher directory and open a profile to view its trips and registrations.</p>
          </div>
          <button type="button" className="btn-secondary tmc-teacher-page__refresh" onClick={loadTeachers} disabled={loading} aria-label="Refresh teachers">
            <RefreshCw size={15} /> {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        <label className="tmc-teacher-page__search">
          <Search size={16} aria-hidden="true" />
          <span className="tmc-teacher-page__sr-only">Search teachers by name, email, phone or school</span>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search teachers by name, email or school…"
          />
          {search && <button type="button" aria-label="Clear teacher search" onClick={() => setSearch('')}>×</button>}
        </label>

        {loading ? (
          <div className="tmc-teacher-page__empty" role="status">Loading registered teachers…</div>
        ) : error ? (
          <div className="tmc-teacher-page__empty tmc-teacher-page__empty--error" role="alert">
            <span>Could not load teacher profiles.</span>
            <button type="button" className="tmc-teacher-page__text-button" onClick={loadTeachers}>Try again</button>
          </div>
        ) : visibleTeachers.length === 0 ? (
          <div className="tmc-teacher-page__empty">
            {search ? 'No registered teachers match this search.' : 'No teachers have registered yet.'}
          </div>
        ) : (
          <div className="tmc-teacher-page__table-scroll">
            <table className="tmc-teacher-page__table">
              <thead>
                <tr><th>Teacher</th><th>School</th><th>Registered</th><th>Assigned trips</th><th /></tr>
              </thead>
              <tbody>
                {visibleTeachers.map((teacher) => (
                  <tr key={teacher.id}>
                    <td>
                      <Link className="tmc-teacher-page__teacher-link" to={'/travel/tmc/teachers/' + teacher.id}>
                        <span className="tmc-teacher-page__avatar">{teacherInitials(teacher.name)}</span>
                        <span className="tmc-teacher-page__teacher-name">
                          <strong>{teacher.name || 'Unnamed teacher'}</strong>
                          <small>{teacher.email || 'No email provided'}</small>
                        </span>
                      </Link>
                    </td>
                    <td>{teacher.company || <span className="tmc-teacher-page__muted">Not provided</span>}</td>
                    <td>{formatDateTime(teacher.createdAt)}</td>
                    <td>{Number(teacher.assignedTripCount || 0)}</td>
                    <td><Link className="tmc-teacher-page__view-link" to={'/travel/tmc/teachers/' + teacher.id}>View details <ChevronRight size={15} /></Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!loading && !error && filteredTeachers.length > 0 && (
          <Pagination page={page} pageCount={pageCount} total={filteredTeachers.length} onChange={setPage} />
        )}
        {!loading && !error && teachers.length > 0 && (
          <p className="tmc-teacher-page__directory-footnote">{assignedTripCount} trip assignments across {teachers.length} registered teachers</p>
        )}
      </section>
    </main>
  );
}

function TeacherDetailPage({ teacherId }) {
  const notify = useNotify();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [activeTab, setActiveTab] = useState('overview');

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(false);
    fetchApi('/api/portal/tmc/staff/teachers/' + encodeURIComponent(teacherId) + '/overview')
      .then((response) => {
        if (active) setData(response || null);
      })
      .catch(() => {
        if (active) {
          setData(null);
          setError(true);
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [teacherId, refreshKey]);

  const teacher = data?.teacher || null;
  const trips = Array.isArray(data?.trips) ? data.trips : [];
  const parentCount = trips.reduce((count, trip) => count + (Array.isArray(trip.parentRegistrations) ? trip.parentRegistrations.length : 0), 0);

  return (
    <main className="tmc-teacher-page">
      <Link className="tmc-teacher-page__back-link" to="/travel/tmc/teachers"><ArrowLeft size={16} /> Back to teachers</Link>
      {loading ? (
        <div className="tmc-teacher-page__empty" role="status">Loading teacher profile…</div>
      ) : error || !teacher ? (
        <div className="tmc-teacher-page__empty" role="alert">
          <span>{error ? 'Could not load this teacher profile.' : 'This teacher profile could not be found.'}</span>
          <button type="button" className="tmc-teacher-page__text-button" onClick={() => setRefreshKey((value) => value + 1)}>Try again</button>
        </div>
      ) : (
        <>
          <header className="tmc-teacher-page__profile-header">
            <span className="tmc-teacher-page__avatar tmc-teacher-page__avatar--large">{teacherInitials(teacher.name)}</span>
            <div className="tmc-teacher-page__profile-identity">
              <div className="tmc-teacher-page__name-line">
                <h1>{teacher.name || 'Teacher profile'}</h1>
                <span className="tmc-teacher-page__registered-badge">Registered teacher</span>
              </div>
              <div className="tmc-teacher-page__contact-line">
                {teacher.email && <span><Mail size={14} /> {teacher.email}</span>}
                {teacher.phone && <span><Phone size={14} /> {teacher.phone}</span>}
              </div>
            </div>
            <button type="button" className="btn-secondary" onClick={() => setRefreshKey((value) => value + 1)} disabled={loading}>
              <RefreshCw size={14} /> Refresh details
            </button>
          </header>

          <nav className="tmc-teacher-page__tabs" role="tablist" aria-label="Teacher details">
            {[
              ['overview', 'Overview', <GraduationCap key="overview" size={16} />],
              ['trips', 'Assigned Trips', <CalendarDays key="trips" size={16} />, trips.length],
              ['parents', 'Parents & Students', <Users key="parents" size={16} />, parentCount],
            ].map(([value, label, icon, count]) => (
              <button key={value} type="button" role="tab" aria-selected={activeTab === value} onClick={() => setActiveTab(value)}>
                {icon}{label}{count !== undefined && <span>{count}</span>}
              </button>
            ))}
          </nav>

          <section className="tmc-teacher-page__detail-panel">
            {activeTab === 'overview' && (
              <TeacherOverview teacher={teacher} trips={trips} onShowTrips={() => setActiveTab('trips')} />
            )}
            {activeTab === 'trips' && <AssignedTrips trips={trips} onCopyParentLink={async (trip) => {
              try {
                await navigator.clipboard.writeText(trip.parentPortalLink);
                notify.success?.('Parent portal link copied');
              } catch {
                notify.error?.('Copy was not available. Open the link to copy it manually.');
              }
            }} />}
            {activeTab === 'parents' && <ParentsAndStudents trips={trips} />}
          </section>
        </>
      )}
    </main>
  );
}

function TeacherOverview({ teacher, trips, onShowTrips }) {
  return (
    <div className="tmc-teacher-page__overview">
      <div className="tmc-teacher-page__overview-heading">
        <div><h2>Teacher overview</h2><p>Profile and activity summary.</p></div>
      </div>
      <div className="tmc-teacher-page__profile-grid">
        <ProfileField icon={<GraduationCap size={16} />} label="Teacher name" value={teacher.name} />
        <ProfileField icon={<Mail size={16} />} label="Email" value={teacher.email} />
        <ProfileField icon={<Phone size={16} />} label="Phone" value={teacher.phone} />
        <ProfileField icon={<School size={16} />} label="School" value={teacher.company} />
        <ProfileField icon={<CalendarDays size={16} />} label="Registered" value={formatDateTime(teacher.createdAt)} />
      </div>
      {trips.length > 0 && (
        <div className="tmc-teacher-page__recent-trips">
          <div><h3>Recent assigned trips</h3><button type="button" className="tmc-teacher-page__text-button" onClick={onShowTrips}>View all</button></div>
          <TripTable trips={trips.slice(0, 4)} compact />
        </div>
      )}
    </div>
  );
}

function ProfileField({ icon, label, value }) {
  return (
    <div className="tmc-teacher-page__profile-field">
      <span className="tmc-teacher-page__field-icon">{icon}</span>
      <div><span>{label}</span><strong>{value || 'Not provided'}</strong></div>
    </div>
  );
}

function AssignedTrips({ trips, onCopyParentLink }) {
  const tripList = useInfiniteScrollList(trips.length, trips.length);
  const visibleTrips = trips.slice(0, tripList.visibleCount);

  return (
    <div>
      <div className="tmc-teacher-page__section-heading">
        <div><h2>Assigned trips</h2><p>Trips assigned to this teacher and their parent portal links.</p></div>
        <span className="tmc-teacher-page__count">{trips.length}</span>
      </div>
      {trips.length === 0 ? (
        <div className="tmc-teacher-page__empty">No trips have been assigned to this teacher yet.</div>
      ) : (
        <TripTable trips={visibleTrips} onCopyParentLink={onCopyParentLink} infiniteList={tripList} />
      )}
    </div>
  );
}

function TripTable({ trips, onCopyParentLink, compact = false, infiniteList = null }) {
  return (
    <div
      ref={infiniteList?.scrollRef}
      className={'tmc-teacher-page__table-scroll' + (infiniteList ? ' tmc-teacher-page__infinite-list' : '')}
      role={infiniteList ? 'region' : undefined}
      aria-label={infiniteList ? 'Assigned trips list' : undefined}
      onScroll={infiniteList?.onScroll}
    >
      <table className={'tmc-teacher-page__table' + (compact ? ' is-compact' : '')}>
        <thead><tr><th>Trip</th><th>Dates</th><th>Participants</th><th>Parent portal registrations</th><th>Status</th>{onCopyParentLink && <th>Parent portal link</th>}</tr></thead>
        <tbody>{trips.map((trip) => (
          <tr key={trip.id}>
            <td>
              <Link
                className="tmc-teacher-page__trip-link"
                to={`/travel/trips/${trip.id}?tab=overview`}
                aria-label={`Open ${trip.destination || trip.tripCode || 'trip'} in TMC Trips`}
              >
                <strong>{trip.destination || 'Unnamed trip'}</strong>
                <small>{trip.tripCode || 'Trip code unavailable'}</small>
              </Link>
            </td>
            <td>{formatDateRange(trip.departDate, trip.returnDate)}</td>
            <td>{trip.participantCount || 0}</td>
            <td>{trip.parentCount || 0}</td>
            <td><span className="tmc-teacher-page__trip-status">{formatStatus(trip.status)}</span></td>
            {onCopyParentLink && (
              <td><span className="tmc-teacher-page__link-actions">
                {trip.parentPortalLink && <button type="button" className="tmc-teacher-page__icon-button" onClick={() => onCopyParentLink(trip)} aria-label={'Copy parent portal link for ' + trip.destination}><Copy size={14} /></button>}
                {trip.parentPortalLink && <a className="tmc-teacher-page__icon-button" href={trip.parentPortalLink} target="_blank" rel="noreferrer" aria-label={'Open parent portal link for ' + trip.destination}><ExternalLink size={14} /></a>}
              </span></td>
            )}
          </tr>
        ))}</tbody>
      </table>
      {infiniteList?.hasMore && <div ref={infiniteList.sentinelRef} className="tmc-teacher-page__infinite-sentinel" aria-hidden="true" />}
    </div>
  );
}

function ParentsAndStudents({ trips }) {
  const [selectedTripId, setSelectedTripId] = useState('');
  const selectedTrip = trips.find((trip) => String(trip.id) === String(selectedTripId)) || null;
  const registrations = Array.isArray(selectedTrip?.parentRegistrations) ? selectedTrip.parentRegistrations : [];
  const participants = Array.isArray(selectedTrip?.participants) ? selectedTrip.participants : [];
  const parents = registrations.map((parent) => ({
    parent,
    students: participants.filter((participant) => participantMatchesParent(participant, parent)),
  }));
  const linkedParticipantIds = new Set(parents.flatMap((entry) => entry.students.map((student) => String(student.id))));
  const unlinkedParticipants = participants.filter((participant) => !linkedParticipantIds.has(String(participant.id)));
  const parentList = useInfiniteScrollList(parents.length, selectedTrip?.id);
  const unlinkedList = useInfiniteScrollList(unlinkedParticipants.length, selectedTrip?.id);
  const visibleParents = parents.slice(0, parentList.visibleCount);
  const visibleUnlinkedParticipants = unlinkedParticipants.slice(0, unlinkedList.visibleCount);

  return (
    <div className="tmc-teacher-page__parents">
      <div className="tmc-teacher-page__section-heading">
        <div><h2>Parents & Students</h2><p>Review parent portal registrations and the students linked to each trip.</p></div>
        {trips.length > 0 && (
          <div className="tmc-teacher-page__trip-picker">
            <span>Trip</span>
            <TripSearchSelect
              trips={trips}
              selectedTripId={selectedTripId}
              onSelect={setSelectedTripId}
            />
          </div>
        )}
      </div>

      {!selectedTrip ? (
        <div className="tmc-teacher-page__empty">
          {trips.length === 0
            ? 'No trips are assigned to this teacher yet.'
            : 'Select a trip to view its parent and student registrations.'}
        </div>
      ) : (
        <>
          <div className="tmc-teacher-page__selected-trip">
            <strong>{selectedTrip.destination || 'Unnamed trip'}</strong>
            <span>{selectedTrip.tripCode} · {formatDateRange(selectedTrip.departDate, selectedTrip.returnDate)}</span>
          </div>
          <div className="tmc-teacher-page__section-heading tmc-teacher-page__subsection-heading">
            <div><h3>Parent portal registrations</h3><p>Parents who completed portal sign-up. Participant totals count students, so one parent may correspond to multiple participants.</p></div>
            <span className="tmc-teacher-page__count">{registrations.length}</span>
          </div>
          {registrations.length === 0 ? (
            <div className="tmc-teacher-page__empty">No parents have registered for this trip yet.</div>
          ) : (
            <div
              ref={parentList.scrollRef}
              className="tmc-teacher-page__table-scroll tmc-teacher-page__infinite-list"
              role="region"
              aria-label="Parent portal registration list"
              onScroll={parentList.onScroll}
            >
              <table className="tmc-teacher-page__table tmc-teacher-page__parent-table">
                <thead><tr><th>Parent</th><th>Contact</th><th>Registered</th><th>Student details</th></tr></thead>
                <tbody>{visibleParents.map(({ parent, students }) => (
                  <tr key={parent.id}>
                    <td><strong>{parent.name || 'Unnamed parent'}</strong></td>
                    <td><span>{parent.email || 'No email'}</span><small>{parent.phone || 'No phone'}</small></td>
                    <td>{formatDateTime(parent.createdAt)}</td>
                    <td>
                      {students.length ? (
                        <div className="tmc-teacher-page__student-list">
                          {students.map((student) => <StudentSummary key={student.id} student={student} />)}
                        </div>
                      ) : <span className="tmc-teacher-page__muted">No linked student record</span>}
                    </td>
                  </tr>
                ))}</tbody>
              </table>
              {parentList.hasMore && <div ref={parentList.sentinelRef} className="tmc-teacher-page__infinite-sentinel" aria-hidden="true" />}
            </div>
          )}

          {unlinkedParticipants.length > 0 && (
            <section className="tmc-teacher-page__unlinked-students">
              <div className="tmc-teacher-page__section-heading">
                <div><h3>Participants without a parent portal account</h3><p>Student registrations that are not linked to a completed parent portal registration.</p></div>
                <span className="tmc-teacher-page__count">{unlinkedParticipants.length}</span>
              </div>
              <div
                ref={unlinkedList.scrollRef}
                className="tmc-teacher-page__table-scroll tmc-teacher-page__infinite-list"
                role="region"
                aria-label="Participants without a parent portal account list"
                onScroll={unlinkedList.onScroll}
              >
                <table className="tmc-teacher-page__table">
                  <thead><tr><th>Student</th><th>Parent contact</th><th>Status</th><th>Student registered</th></tr></thead>
                  <tbody>{visibleUnlinkedParticipants.map((student) => (
                    <tr key={student.id}>
                      <td><StudentSummary student={student} /></td>
                      <td><span>{student.parentName || 'Parent name pending'}</span><small>{student.parentEmail || student.parentPhone || 'No contact provided'}</small></td>
                      <td><span className="tmc-teacher-page__trip-status">{formatStatus(student.applicationStatus)}</span></td>
                      <td>{formatDateTime(student.createdAt)}</td>
                    </tr>
                  ))}</tbody>
                </table>
                {unlinkedList.hasMore && <div ref={unlinkedList.sentinelRef} className="tmc-teacher-page__infinite-sentinel" aria-hidden="true" />}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function useInfiniteScrollList(total, resetKey) {
  const [visibleCount, setVisibleCount] = useState(INFINITE_SCROLL_BATCH_SIZE);
  const scrollRef = useRef(null);
  const sentinelRef = useRef(null);

  useEffect(() => {
    setVisibleCount(INFINITE_SCROLL_BATCH_SIZE);
  }, [resetKey]);

  const loadMore = useCallback(() => {
    setVisibleCount((current) => Math.min(total, current + INFINITE_SCROLL_BATCH_SIZE));
  }, [total]);

  useEffect(() => {
    if (visibleCount >= total || typeof IntersectionObserver === 'undefined') return undefined;
    const root = scrollRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel) return undefined;

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadMore();
    }, { root, rootMargin: '0px 0px 100px 0px' });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadMore, total, visibleCount]);

  const onScroll = useCallback((event) => {
    if (typeof IntersectionObserver !== 'undefined') return;
    const { scrollTop, clientHeight, scrollHeight } = event.currentTarget;
    if (scrollHeight - scrollTop - clientHeight <= 100) loadMore();
  }, [loadMore]);

  return {
    visibleCount,
    hasMore: visibleCount < total,
    scrollRef,
    sentinelRef,
    onScroll,
  };
}

function TripSearchSelect({ trips, selectedTripId, onSelect }) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [menuPosition, setMenuPosition] = useState(null);
  const dropdownRef = useRef(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const searchRef = useRef(null);
  const selectedTrip = trips.find((trip) => String(trip.id) === String(selectedTripId));
  const filteredTrips = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return trips;
    return trips.filter((trip) => [trip.destination, trip.tripCode]
      .some((value) => String(value || '').toLowerCase().includes(normalizedQuery)));
  }, [query, trips]);

  const updateMenuPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    if (rect.bottom <= 0 || rect.top >= window.innerHeight) {
      setIsOpen(false);
      return;
    }
    const viewportPadding = 8;
    const gap = 4;
    const desiredHeight = 300;
    const availableBelow = Math.max(0, window.innerHeight - rect.bottom - gap - viewportPadding);
    const availableAbove = Math.max(0, rect.top - gap - viewportPadding);
    const opensBelow = availableBelow >= desiredHeight || availableBelow >= availableAbove;
    const availableHeight = opensBelow ? availableBelow : availableAbove;
    const maxHeight = Math.max(96, Math.min(desiredHeight, availableHeight));
    const width = Math.min(rect.width, window.innerWidth - (viewportPadding * 2));
    const left = Math.max(viewportPadding, Math.min(rect.left, window.innerWidth - viewportPadding - width));
    const rawTop = opensBelow ? rect.bottom + gap : rect.top - gap - maxHeight;
    const top = Math.max(viewportPadding, Math.min(rawTop, window.innerHeight - viewportPadding - maxHeight));

    setMenuPosition({
      position: 'fixed',
      top,
      left,
      width,
      maxHeight,
      '--tmc-teacher-accent': 'var(--primary-color, var(--accent-color))',
      '--tmc-trip-select-options-height': `${Math.max(32, maxHeight - 62)}px`,
    });
  }, []);

  useLayoutEffect(() => {
    if (!isOpen) {
      setMenuPosition(null);
      return undefined;
    }
    updateMenuPosition();
    window.addEventListener('resize', updateMenuPosition);
    window.addEventListener('scroll', updateMenuPosition, true);
    return () => {
      window.removeEventListener('resize', updateMenuPosition);
      window.removeEventListener('scroll', updateMenuPosition, true);
    };
  }, [isOpen, updateMenuPosition]);

  useEffect(() => {
    if (!isOpen) return undefined;
    searchRef.current?.focus();
    const closeOnOutsideClick = (event) => {
      if (!dropdownRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) setIsOpen(false);
    };
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [isOpen]);

  const selectTrip = (tripId) => {
    onSelect(tripId);
    setQuery('');
    setIsOpen(false);
  };

  return (
    <div className="tmc-teacher-page__trip-select" ref={dropdownRef}>
      <button
        type="button"
        className="tmc-teacher-page__trip-select-trigger"
        ref={triggerRef}
        role="combobox"
        aria-label="Select trip"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls="tmc-trip-options"
        onClick={() => setIsOpen((open) => !open)}
      >
        <span>{selectedTrip ? tripOptionLabel(selectedTrip) : 'None selected'}</span>
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      {isOpen && menuPosition && createPortal(
        <div ref={menuRef} className="tmc-teacher-page__trip-select-menu" style={menuPosition}>
          <label className="tmc-teacher-page__trip-select-search">
            <Search size={15} aria-hidden="true" />
            <input
              ref={searchRef}
              type="search"
              aria-label="Search trips"
              placeholder="Search trips..."
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div id="tmc-trip-options" className="tmc-teacher-page__trip-select-options" role="listbox" aria-label="Trips">
            <button
              type="button"
              role="option"
              aria-selected={!selectedTripId}
              className={'tmc-teacher-page__trip-select-option' + (!selectedTripId ? ' is-selected' : '')}
              onClick={() => selectTrip('')}
            >
              None selected
            </button>
            {filteredTrips.map((trip) => (
              <button
                key={trip.id}
                type="button"
                role="option"
                aria-selected={String(trip.id) === String(selectedTripId)}
                className={'tmc-teacher-page__trip-select-option' + (String(trip.id) === String(selectedTripId) ? ' is-selected' : '')}
                onClick={() => selectTrip(String(trip.id))}
              >
                {tripOptionLabel(trip)}
              </button>
            ))}
            {filteredTrips.length === 0 && (
              <div className="tmc-teacher-page__trip-select-empty">No trips match this search.</div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

function tripOptionLabel(trip) {
  return [trip.destination || 'Unnamed trip', trip.tripCode].filter(Boolean).join(' · ');
}

function StudentSummary({ student }) {
  const details = [
    student.studentClass && 'Class ' + student.studentClass,
    student.studentSchool,
    student.studentDob && 'DOB ' + formatDate(student.studentDob),
    student.studentGender,
  ].filter(Boolean);
  return (
    <div className="tmc-teacher-page__student-summary">
      <strong>{student.fullName || 'Student name pending'}</strong>
      {details.length > 0 && <small>{details.join(' · ')}</small>}
      {student.parentRelation && <small>Parent relation: {student.parentRelation}</small>}
      <small>Student added {formatDateTime(student.createdAt)}</small>
    </div>
  );
}

function Pagination({ page, pageCount, total, onChange }) {
  const start = total === 0 ? 0 : ((page - 1) * PAGE_SIZE) + 1;
  const end = Math.min(total, page * PAGE_SIZE);
  return (
    <div className="tmc-teacher-page__pagination">
      <span>Showing {start}–{end} of {total}</span>
      <div>
        <button type="button" className="btn-secondary" aria-label="Previous page" disabled={page <= 1} onClick={() => onChange(page - 1)}><ChevronLeft size={16} /></button>
        <span>Page {page} of {pageCount}</span>
        <button type="button" className="btn-secondary" aria-label="Next page" disabled={page >= pageCount} onClick={() => onChange(page + 1)}><ChevronRight size={16} /></button>
      </div>
    </div>
  );
}

function participantMatchesParent(participant, parent) {
  const participantEmail = String(participant.parentEmail || '').trim().toLowerCase();
  const parentEmail = String(parent.email || '').trim().toLowerCase();
  if (participantEmail && parentEmail && participantEmail === parentEmail) return true;
  const participantPhone = String(participant.parentPhone || '').replace(/\D/g, '');
  const parentPhone = String(parent.phone || '').replace(/\D/g, '');
  if (participantPhone && parentPhone && participantPhone === parentPhone) return true;
  const participantName = String(participant.parentName || '').trim().toLowerCase();
  const parentName = String(parent.name || '').trim().toLowerCase();
  return !participantEmail && !parentEmail && !participantPhone && !parentPhone && Boolean(participantName && parentName && participantName === parentName);
}

function teacherInitials(name) {
  return String(name || 'T').trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'T';
}

function formatDate(value) {
  if (!value) return 'Not provided';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Not provided' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDateTime(value) {
  if (!value) return 'Not available';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Not available' : date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatDateRange(start, end) {
  if (!start && !end) return 'Dates to be confirmed';
  if (!start) return formatDate(end);
  if (!end) return formatDate(start);
  return formatDate(start) + ' – ' + formatDate(end);
}

function formatStatus(value) {
  return String(value || 'Pending').replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}
