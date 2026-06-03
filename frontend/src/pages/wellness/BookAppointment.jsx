import { useEffect, useState, useContext } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Calendar, Clock, Stethoscope, Info, Sparkles } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { AuthContext } from '../../App';

// Half-hour slots from 09:00 to 19:00 — used when the patient hasn't picked a
// preferred doctor. Once a doctor IS chosen we use that doctor's actual
// availability via /doctors/:id/time-slots. The static set keeps the
// "any-doctor, admin will assign" path usable without a doctor lookup.
const GENERIC_SLOTS = (() => {
  const out = [];
  for (let h = 9; h <= 19; h++) {
    out.push(`${String(h).padStart(2, '0')}:00`);
    if (h < 19) out.push(`${String(h).padStart(2, '0')}:30`);
  }
  return out;
})();

export default function BookAppointment() {
  const notify = useNotify();
  const { user } = useContext(AuthContext); // eslint-disable-line no-unused-vars
  // #service-catalog "Book service" deep-link: ?serviceId=<id> pre-selects the
  // service the user tapped in the catalog. They fill in the rest (date/time/
  // doctor) as usual.
  const [searchParams] = useSearchParams();

  const [doctors, setDoctors] = useState([]);
  const [services, setServices] = useState([]);
  const [memberships, setMemberships] = useState([]);
  const [myAppointments, setMyAppointments] = useState([]);
  const [availableSlots, setAvailableSlots] = useState(GENERIC_SLOTS);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [slotsLoading, setSlotsLoading] = useState(false);

  const [formData, setFormData] = useState({
    reason: '',
    doctorId: '',
    serviceId: '',
    membershipId: '',
    appointmentDate: new Date().toISOString().split('T')[0],
    appointmentTime: ''
  });

  useEffect(() => {
    loadData();
  }, []);

  // Pre-select the service from ?serviceId once the catalog has loaded (and
  // only if it's a real, active service the user can actually book).
  useEffect(() => {
    const sid = searchParams.get('serviceId');
    if (!sid) return;
    if (services.some((s) => String(s.id) === String(sid))) {
      setFormData((prev) => (prev.serviceId ? prev : { ...prev, serviceId: sid }));
    }
  }, [services, searchParams]);

  const loadData = async () => {
    try {
      setLoading(true);
      const [doctorsData, servicesData, appointmentsData, membershipsData] = await Promise.all([
        fetchApi('/api/wellness/doctors/availability?date=' + formData.appointmentDate).catch(() => []),
        fetchApi('/api/wellness/services').catch(() => []),
        fetchApi('/api/wellness/appointments/my').catch(() => []),
        fetchApi('/api/wellness/appointments/my-memberships').catch(() => [])
      ]);

      setDoctors(Array.isArray(doctorsData) ? doctorsData : []);
      setServices(Array.isArray(servicesData) ? servicesData.filter(s => s.isActive !== false) : []);
      setMyAppointments(Array.isArray(appointmentsData) ? appointmentsData : []);
      setMemberships(Array.isArray(membershipsData) ? membershipsData : []);
    } catch (err) {
      console.error('Failed to load data:', err);
      notify.error('Failed to load appointment data');
    } finally {
      setLoading(false);
    }
  };

  const handleDateChange = async (date) => {
    setFormData({ ...formData, appointmentDate: date, appointmentTime: '' });
    try {
      const doctorsData = await fetchApi(`/api/wellness/doctors/availability?date=${date}`);
      setDoctors(Array.isArray(doctorsData) ? doctorsData : []);
    } catch (err) {
      console.error('Failed to load doctors:', err);
    }
    // Reload slots if doctor is already selected; otherwise fall back to the
    // generic preset (admin assigns the doctor at triage time).
    if (formData.doctorId) {
      loadTimeSlots(formData.doctorId, date);
    } else {
      setAvailableSlots(GENERIC_SLOTS);
    }
  };

  const loadTimeSlots = async (doctorId, date) => {
    try {
      setSlotsLoading(true);
      const slotsData = await fetchApi(`/api/wellness/doctors/${doctorId}/time-slots?date=${date}`);
      if (slotsData.available && Array.isArray(slotsData.slots)) {
        setAvailableSlots(slotsData.slots);
      } else {
        setAvailableSlots([]);
        if (!slotsData.available) {
          notify.error(slotsData.reason || 'No slots available');
        }
      }
    } catch (err) {
      console.error('Failed to load time slots:', err);
      setAvailableSlots([]);
      notify.error('Failed to load available time slots');
    } finally {
      setSlotsLoading(false);
    }
  };

  const handleDoctorChange = async (doctorId) => {
    setFormData({ ...formData, doctorId, appointmentTime: '' });
    if (doctorId) {
      await loadTimeSlots(doctorId, formData.appointmentDate);
    } else {
      // Patient cleared the doctor → revert to generic slots so they can still
      // pick a preferred time. Admin will reconcile against an actual doctor.
      setAvailableSlots(GENERIC_SLOTS);
    }
  };

  const handleBookAppointment = async (e) => {
    e.preventDefault();
    if (!formData.reason.trim()) {
      notify.error('Please describe the reason for your appointment');
      return;
    }
    if (!formData.appointmentTime) {
      notify.error('Please pick a time');
      return;
    }

    setSubmitting(true);
    try {
      const result = await fetchApi('/api/wellness/appointments/book', {
        method: 'POST',
        body: JSON.stringify({
          reason: formData.reason.trim(),
          doctorId: formData.doctorId ? parseInt(formData.doctorId) : null,
          serviceId: formData.serviceId ? parseInt(formData.serviceId) : null,
          membershipId: formData.membershipId ? parseInt(formData.membershipId) : null,
          appointmentDate: formData.appointmentDate,
          appointmentTime: formData.appointmentTime
        })
      });

      if (result.success) {
        const apt = result.appointment;
        notify.success(
          apt.doctorAssigned
            ? `Appointment booked with Dr. ${apt.doctorName}`
            : 'Appointment requested — our team will assign a doctor and confirm shortly.'
        );
        setFormData({
          reason: '',
          doctorId: '',
          serviceId: '',
          membershipId: '',
          appointmentDate: new Date().toISOString().split('T')[0],
          appointmentTime: ''
        });
        setAvailableSlots(GENERIC_SLOTS);
        loadData();
      }
    } catch (err) {
      notify.error(err.message || 'Failed to book appointment');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancelAppointment = async (appointmentId) => {
    if (!await notify.confirm({
      title: 'Cancel Appointment',
      message: 'Are you sure you want to cancel this appointment?',
      confirmText: 'Cancel',
      destructive: true
    })) return;

    try {
      await fetchApi(`/api/wellness/appointments/${appointmentId}/cancel`, { method: 'POST' });
      notify.success('Appointment cancelled');
      loadData();
    } catch (err) {
      notify.error(err.message || 'Failed to cancel appointment');
    }
  };

  if (loading) {
    return (
      <div style={{ padding: '2rem', textAlign: 'center' }}>
        <div style={{ color: 'var(--text-secondary)' }}>Loading...</div>
      </div>
    );
  }

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '2rem' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
          <Calendar size={28} /> Book an Appointment
        </h1>
        <p style={{ color: 'var(--text-secondary)' }}>
          Schedule a consultation with our healthcare professionals
        </p>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2rem', maxWidth: '1200px' }}>
        {/* Booking Form */}
        <div style={{
          padding: '1.5rem',
          background: 'rgba(255,255,255,0.02)',
          borderRadius: 12,
          border: '1px solid rgba(255,255,255,0.08)'
        }}>
          <h2 style={{ fontSize: '1.2rem', fontWeight: 600, marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Stethoscope size={20} /> New Appointment
          </h2>

          <form onSubmit={handleBookAppointment} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            {/* Reason — required. Triage-critical when doctor is left blank. */}
            <div>
              <label style={{ fontSize: '0.85rem', fontWeight: 500, color: 'var(--text-primary)', display: 'block', marginBottom: '0.5rem' }}>
                Reason for Appointment *
              </label>
              <textarea
                value={formData.reason}
                onChange={(e) => setFormData({ ...formData, reason: e.target.value })}
                placeholder="Briefly describe the issue or reason for your visit"
                rows={3}
                maxLength={1000}
                required
                style={{
                  width: '100%',
                  padding: '0.7rem',
                  background: 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 8,
                  color: 'var(--text-primary)',
                  fontSize: '0.9rem',
                  resize: 'vertical',
                  fontFamily: 'inherit',
                  boxSizing: 'border-box'
                }}
              />
            </div>

            {/* Doctor Selection — optional. Empty value means "any doctor"; admin will
                assign based on the reason + specialty + availability. */}
            <div>
              <label style={{ fontSize: '0.85rem', fontWeight: 500, color: 'var(--text-primary)', display: 'block', marginBottom: '0.5rem' }}>
                Preferred Doctor (Optional)
              </label>
              <select
                value={formData.doctorId}
                onChange={(e) => handleDoctorChange(e.target.value)}
                style={{
                  width: '100%',
                  padding: '0.7rem',
                  background: 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 8,
                  color: 'var(--text-primary)',
                  fontSize: '0.9rem',
                  cursor: 'pointer'
                }}
              >
                <option value="">— No preference (admin will assign) —</option>
                {doctors.map(doc => {
                  const name = (doc.name || '').trim();
                  const isDoctor = (doc.wellnessRole || '').toLowerCase() === 'doctor';
                  const displayName = /^(dr\.?|doctor)\s/i.test(name)
                    ? name
                    : (isDoctor ? `Dr. ${name}` : name);
                  const specialty = doc.specialty ? ` — ${doc.specialty}` : '';
                  return (
                    <option key={doc.id} value={doc.id} disabled={!doc.available}>
                      {displayName}{specialty} {!doc.available ? '(On Leave)' : ''}
                    </option>
                  );
                })}
              </select>
              {!formData.doctorId && (
                <div style={{
                  marginTop: '0.5rem',
                  padding: '0.5rem 0.7rem',
                  background: 'rgba(59,130,246,0.08)',
                  border: '1px solid rgba(59,130,246,0.2)',
                  borderRadius: 6,
                  fontSize: '0.78rem',
                  color: 'var(--text-secondary)',
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '0.4rem'
                }}>
                  <Info size={13} style={{ marginTop: 2, flexShrink: 0 }} />
                  <span>Our team will assign a doctor based on the reason you described and specialist availability.</span>
                </div>
              )}
            </div>

            {/* Service Selection */}
            <div>
              <label style={{ fontSize: '0.85rem', fontWeight: 500, color: 'var(--text-primary)', display: 'block', marginBottom: '0.5rem' }}>
                Service (Optional)
              </label>
              <select
                value={formData.serviceId}
                onChange={(e) => setFormData({ ...formData, serviceId: e.target.value })}
                style={{
                  width: '100%',
                  padding: '0.7rem',
                  background: 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 8,
                  color: 'var(--text-primary)',
                  fontSize: '0.9rem',
                  cursor: 'pointer'
                }}
              >
                <option value="">— Select a Service —</option>
                {services.map(svc => (
                  <option key={svc.id} value={svc.id}>
                    {svc.name} {svc.basePrice ? `(₹${svc.basePrice})` : ''}
                  </option>
                ))}
              </select>
            </div>

            {/* Membership — optional. Loaded from /appointments/my-memberships, which
                returns only active+unexpired rows for the current patient. */}
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                <label style={{ fontSize: '0.85rem', fontWeight: 500, color: 'var(--text-primary)' }}>
                  Membership (Optional)
                </label>
                <Link
                  to="/wellness/memberships"
                  style={{
                    fontSize: '0.78rem',
                    color: 'var(--primary-color, var(--accent-color, #6366f1))',
                    textDecoration: 'none',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.25rem'
                  }}
                >
                  <Sparkles size={12} /> Manage memberships
                </Link>
              </div>
              <select
                value={formData.membershipId}
                onChange={(e) => setFormData({ ...formData, membershipId: e.target.value })}
                disabled={memberships.length === 0}
                style={{
                  width: '100%',
                  padding: '0.7rem',
                  background: memberships.length === 0 ? 'rgba(255,255,255,0.02)' : 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 8,
                  color: 'var(--text-primary)',
                  fontSize: '0.9rem',
                  cursor: memberships.length === 0 ? 'not-allowed' : 'pointer'
                }}
              >
                <option value="">
                  {memberships.length === 0 ? '— No active memberships —' : '— None —'}
                </option>
                {memberships.map(m => (
                  <option key={m.id} value={m.id}>
                    {m.planName} (valid until {new Date(m.endDate).toLocaleDateString()})
                  </option>
                ))}
              </select>
            </div>

            {/* Date & Time */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <div>
                <label style={{ fontSize: '0.85rem', fontWeight: 500, color: 'var(--text-primary)', display: 'block', marginBottom: '0.5rem' }}>
                  Date *
                </label>
                <input
                  type="date"
                  value={formData.appointmentDate}
                  onChange={(e) => handleDateChange(e.target.value)}
                  min={new Date().toISOString().split('T')[0]}
                  style={{
                    width: '100%',
                    padding: '0.7rem',
                    background: 'rgba(255,255,255,0.05)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: 8,
                    color: 'var(--text-primary)',
                    fontSize: '0.9rem'
                  }}
                />
              </div>
              <div>
                <label style={{ fontSize: '0.85rem', fontWeight: 500, color: 'var(--text-primary)', display: 'block', marginBottom: '0.5rem' }}>
                  Time * {slotsLoading && <span style={{ fontSize: '0.75rem', opacity: 0.7 }}>(Loading...)</span>}
                </label>
                <select
                  value={formData.appointmentTime}
                  onChange={(e) => setFormData({ ...formData, appointmentTime: e.target.value })}
                  disabled={availableSlots.length === 0}
                  style={{
                    width: '100%',
                    padding: '0.7rem',
                    background: availableSlots.length === 0 ? 'rgba(255,255,255,0.02)' : 'rgba(255,255,255,0.05)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: 8,
                    color: 'var(--text-primary)',
                    fontSize: '0.9rem',
                    cursor: availableSlots.length === 0 ? 'not-allowed' : 'pointer'
                  }}
                >
                  <option value="">
                    {availableSlots.length === 0 ? '— No available slots —' : '— Select a time —'}
                  </option>
                  {availableSlots.map(slot => (
                    <option key={slot} value={slot}>
                      {slot}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Submit Button. Required: reason + time. Doctor + service +
                membership are all optional. */}
            {(() => {
              const canSubmit = !submitting && formData.reason.trim() && formData.appointmentTime;
              return (
                <button
                  type="submit"
                  disabled={!canSubmit}
                  style={{
                    padding: '0.85rem 1.5rem',
                    background: canSubmit ? 'var(--primary-color, var(--accent-color, #6366f1))' : '#999',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 8,
                    cursor: canSubmit ? 'pointer' : 'not-allowed',
                    fontWeight: 600,
                    fontSize: '0.95rem',
                    transition: 'all 0.2s'
                  }}
                >
                  {submitting ? 'Booking...' : 'Confirm Appointment'}
                </button>
              );
            })()}
          </form>
        </div>

        {/* My Appointments */}
        <div style={{
          padding: '1.5rem',
          background: 'rgba(255,255,255,0.02)',
          borderRadius: 12,
          border: '1px solid rgba(255,255,255,0.08)'
        }}>
          <h2 style={{ fontSize: '1.2rem', fontWeight: 600, marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Clock size={20} /> My Appointments
          </h2>

          {myAppointments.length === 0 ? (
            <div style={{
              textAlign: 'center',
              padding: '2rem 1rem',
              color: 'var(--text-secondary)',
              background: 'rgba(255,255,255,0.02)',
              borderRadius: 8,
              border: '1px dashed rgba(255,255,255,0.1)'
            }}>
              <Calendar size={32} style={{ opacity: 0.5, margin: '0 auto 1rem' }} />
              <p>No appointments booked yet</p>
              <p style={{ fontSize: '0.85rem', marginTop: '0.5rem' }}>
                Schedule your first appointment using the form on the left
              </p>
            </div>
          ) : (
            <div
              data-testid="my-appointments-scroll"
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '1rem',
                // Cap the list height so the panel doesn't stretch
                // indefinitely as the patient accumulates appointments.
                // Cards beyond the cap scroll inside this container
                // instead of pushing the booking form off-screen on
                // shorter viewports.
                maxHeight: '60vh',
                overflowY: 'auto',
                // Pad the right edge so the scrollbar doesn't clip the
                // card border, and reserve gutter even when the scrollbar
                // is hidden (overlay-scrollbar OSes) to avoid layout
                // shift between scrollable / non-scrollable states.
                paddingRight: '0.5rem',
                scrollbarWidth: 'thin',
                scrollbarColor: 'rgba(255,255,255,0.25) transparent',
                scrollbarGutter: 'stable',
              }}
            >
              {myAppointments.map(apt => (
                <div
                  key={apt.id}
                  style={{
                    padding: '1rem',
                    background: 'rgba(99,102,241,0.1)',
                    borderRadius: 8,
                    border: '1px solid rgba(99,102,241,0.2)',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'start'
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '0.95rem', marginBottom: '0.5rem' }}>
                      {apt.doctorAssigned === false ? apt.doctorName : `Dr. ${apt.doctorName}`}
                    </div>
                    <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>
                      📋 {apt.serviceName}
                    </div>
                    {apt.reason && (
                      <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', marginBottom: '0.25rem', fontStyle: 'italic' }}>
                        💬 {apt.reason}
                      </div>
                    )}
                    <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
                      📅 {new Date(apt.appointmentDate).toLocaleDateString()} at{' '}
                      {new Date(apt.appointmentDate).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </div>
                    <div style={{
                      fontSize: '0.8rem',
                      display: 'inline-block',
                      padding: '0.25rem 0.75rem',
                      background: apt.status === 'booked' ? 'rgba(59,130,246,0.2)' : 'rgba(107,114,128,0.2)',
                      color: apt.status === 'booked' ? '#3b82f6' : '#6b7280',
                      borderRadius: 4,
                      textTransform: 'capitalize',
                      fontWeight: 500
                    }}>
                      {apt.status}
                    </div>
                  </div>
                  {apt.status === 'booked' && (
                    <button
                      onClick={() => handleCancelAppointment(apt.id)}
                      style={{
                        padding: '0.5rem 1rem',
                        background: 'rgba(239,68,68,0.1)',
                        color: '#ef4444',
                        border: '1px solid rgba(239,68,68,0.3)',
                        borderRadius: 6,
                        cursor: 'pointer',
                        fontSize: '0.8rem',
                        fontWeight: 500,
                        whiteSpace: 'nowrap'
                      }}
                    >
                      Cancel
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
