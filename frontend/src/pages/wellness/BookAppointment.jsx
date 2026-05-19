import { useEffect, useState, useContext } from 'react';
import { Calendar, Clock, User, Stethoscope } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { AuthContext } from '../../App';

export default function BookAppointment() {
  const notify = useNotify();
  const { user } = useContext(AuthContext);

  const [doctors, setDoctors] = useState([]);
  const [services, setServices] = useState([]);
  const [myAppointments, setMyAppointments] = useState([]);
  const [availableSlots, setAvailableSlots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [slotsLoading, setSlotsLoading] = useState(false);

  const [formData, setFormData] = useState({
    doctorId: '',
    serviceId: '',
    appointmentDate: new Date().toISOString().split('T')[0],
    appointmentTime: ''
  });

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      const [doctorsData, servicesData, appointmentsData] = await Promise.all([
        fetchApi('/api/wellness/doctors/availability?date=' + formData.appointmentDate).catch(() => []),
        fetchApi('/api/wellness/services').catch(() => []),
        fetchApi('/api/wellness/appointments/my').catch(() => [])
      ]);

      setDoctors(Array.isArray(doctorsData) ? doctorsData : []);
      setServices(Array.isArray(servicesData) ? servicesData.filter(s => s.isActive !== false) : []);
      setMyAppointments(Array.isArray(appointmentsData) ? appointmentsData : []);
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
    // Reload slots if doctor is already selected
    if (formData.doctorId) {
      loadTimeSlots(formData.doctorId, date);
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
      setAvailableSlots([]);
    }
  };

  const handleBookAppointment = async (e) => {
    e.preventDefault();
    if (!formData.doctorId) {
      notify.error('Please select a doctor');
      return;
    }

    setSubmitting(true);
    try {
      const result = await fetchApi('/api/wellness/appointments/book', {
        method: 'POST',
        body: JSON.stringify({
          doctorId: parseInt(formData.doctorId),
          serviceId: formData.serviceId ? parseInt(formData.serviceId) : null,
          appointmentDate: formData.appointmentDate,
          appointmentTime: formData.appointmentTime
        })
      });

      if (result.success) {
        notify.success(`Appointment booked with Dr. ${result.appointment.doctorName}`);
        setFormData({
          doctorId: '',
          serviceId: '',
          appointmentDate: new Date().toISOString().split('T')[0],
          appointmentTime: '10:00'
        });
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
            {/* Doctor Selection */}
            <div>
              <label style={{ fontSize: '0.85rem', fontWeight: 500, color: 'var(--text-primary)', display: 'block', marginBottom: '0.5rem' }}>
                Select Doctor *
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
                <option value="">— Select a Doctor —</option>
                {doctors.map(doc => {
                  const name = doc.name.trim();
                  const displayName = /^(dr\.?|doctor)\s/i.test(name) ? name : `Dr. ${name}`;
                  return (
                    <option key={doc.id} value={doc.id} disabled={!doc.available}>
                      {displayName} {!doc.available ? '(On Leave)' : ''}
                    </option>
                  );
                })}
              </select>
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
                  disabled={!formData.doctorId || availableSlots.length === 0}
                  style={{
                    width: '100%',
                    padding: '0.7rem',
                    background: !formData.doctorId || availableSlots.length === 0 ? 'rgba(255,255,255,0.02)' : 'rgba(255,255,255,0.05)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: 8,
                    color: 'var(--text-primary)',
                    fontSize: '0.9rem',
                    cursor: !formData.doctorId || availableSlots.length === 0 ? 'not-allowed' : 'pointer'
                  }}
                >
                  <option value="">
                    {!formData.doctorId
                      ? '— Select a doctor first —'
                      : availableSlots.length === 0
                      ? '— No available slots —'
                      : '— Select a time —'}
                  </option>
                  {availableSlots.map(slot => (
                    <option key={slot} value={slot}>
                      {slot}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Submit Button */}
            <button
              type="submit"
              disabled={submitting || !formData.doctorId}
              style={{
                padding: '0.85rem 1.5rem',
                background: submitting || !formData.doctorId ? '#999' : 'var(--primary-color, var(--accent-color, #6366f1))',
                color: '#fff',
                border: 'none',
                borderRadius: 8,
                cursor: submitting || !formData.doctorId ? 'not-allowed' : 'pointer',
                fontWeight: 600,
                fontSize: '0.95rem',
                transition: 'all 0.2s'
              }}
            >
              {submitting ? 'Booking...' : 'Confirm Appointment'}
            </button>
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
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
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
                      Dr. {apt.doctorName}
                    </div>
                    <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>
                      📋 {apt.serviceName}
                    </div>
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
