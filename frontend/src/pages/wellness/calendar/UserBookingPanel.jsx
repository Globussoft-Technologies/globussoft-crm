export default function UserBookingPanel({
  showBooking,
  onToggleBooking,
  bookingForm,
  setBookingForm,
  bookingSubmitting,
  onBookAppointment,
  availability,
  services,
  myAppointments,
  onCancelAppointment,
}) {
  return (
    <div style={{ marginTop: '2rem', padding: '1.5rem', borderTop: '1px solid rgba(255,255,255,0.1)' }}>
      <button
        onClick={onToggleBooking}
        style={{
          padding: '0.6rem 1.5rem',
          background: showBooking ? 'var(--primary-color, var(--accent-color, #6366f1))' : 'transparent',
          color: showBooking ? '#fff' : 'var(--text-primary)',
          border: `1px solid ${showBooking ? 'transparent' : 'var(--border-color, rgba(0,0,0,0.15))'}`,
          borderRadius: 8,
          cursor: 'pointer',
          fontWeight: 600,
          fontSize: '0.9rem',
          transition: 'all 0.2s'
        }}
      >
        {showBooking ? '✓ Book Appointment' : '+ Book Appointment'}
      </button>

      {showBooking && (
        <div style={{ marginTop: '1.5rem', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2rem' }}>
          {/* Left: Booking Form */}
          <div style={{ padding: '1.5rem', background: 'rgba(255,255,255,0.02)', borderRadius: 12, border: '1px solid rgba(255,255,255,0.08)' }}>
            <h3 style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: '1rem' }}>Book an Appointment</h3>
            <form onSubmit={onBookAppointment} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div>
                <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '0.5rem' }}>Doctor</label>
                <select
                  value={bookingForm.doctorId}
                  onChange={(e) => setBookingForm({...bookingForm, doctorId: e.target.value})}
                  required
                  style={{ padding: '0.5rem 0.7rem', borderRadius: 8, border: '1px solid var(--border-color, rgba(0,0,0,0.15))', background: 'var(--input-bg, rgba(0,0,0,0.03))', color: 'var(--text-primary)', fontSize: '0.9rem', outline: 'none', width: '100%' }}
                >
                  <option value="">— Select Doctor —</option>
                  {availability.map(doc => (
                    <option key={doc.id} value={doc.id} disabled={!doc.available}>
                      {doc.name} {!doc.available ? '(On Leave)' : ''}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '0.5rem' }}>Service</label>
                <select
                  value={bookingForm.serviceId}
                  onChange={(e) => setBookingForm({...bookingForm, serviceId: e.target.value})}
                  style={{ padding: '0.5rem 0.7rem', borderRadius: 8, border: '1px solid var(--border-color, rgba(0,0,0,0.15))', background: 'var(--input-bg, rgba(0,0,0,0.03))', color: 'var(--text-primary)', fontSize: '0.9rem', outline: 'none', width: '100%' }}
                >
                  <option value="">— Select Service —</option>
                  {services.map(svc => (
                    <option key={svc.id} value={svc.id}>{svc.name}</option>
                  ))}
                </select>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                <div>
                  <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '0.5rem' }}>Date</label>
                  <input
                    type="date"
                    value={bookingForm.appointmentDate}
                    onChange={(e) => setBookingForm({...bookingForm, appointmentDate: e.target.value})}
                    required
                    style={{ padding: '0.5rem 0.7rem', borderRadius: 8, border: '1px solid var(--border-color, rgba(0,0,0,0.15))', background: 'var(--input-bg, rgba(0,0,0,0.03))', color: 'var(--text-primary)', fontSize: '0.9rem', outline: 'none', width: '100%' }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '0.5rem' }}>Time</label>
                  <input
                    type="time"
                    value={bookingForm.appointmentTime}
                    onChange={(e) => setBookingForm({...bookingForm, appointmentTime: e.target.value})}
                    required
                    style={{ padding: '0.5rem 0.7rem', borderRadius: 8, border: '1px solid var(--border-color, rgba(0,0,0,0.15))', background: 'var(--input-bg, rgba(0,0,0,0.03))', color: 'var(--text-primary)', fontSize: '0.9rem', outline: 'none', width: '100%' }}
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={bookingSubmitting || !bookingForm.doctorId}
                style={{
                  padding: '0.6rem 1.2rem',
                  background: bookingSubmitting || !bookingForm.doctorId ? '#ccc' : 'var(--primary-color, var(--accent-color, #6366f1))',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 8,
                  cursor: bookingSubmitting || !bookingForm.doctorId ? 'not-allowed' : 'pointer',
                  fontWeight: 600,
                  fontSize: '0.9rem'
                }}
              >
                {bookingSubmitting ? 'Booking...' : 'Book Now'}
              </button>
            </form>
          </div>

          {/* Right: My Appointments */}
          <div style={{ padding: '1.5rem', background: 'rgba(255,255,255,0.02)', borderRadius: 12, border: '1px solid rgba(255,255,255,0.08)' }}>
            <h3 style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: '1rem' }}>My Appointments</h3>
            {myAppointments.length === 0 ? (
              <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '2rem 0' }}>No appointments booked yet</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {myAppointments.map(apt => (
                  <div key={apt.id} style={{ padding: '0.75rem', background: 'rgba(99,102,241,0.1)', borderRadius: 8, border: '1px solid rgba(99,102,241,0.2)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                      <div>
                        <div style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: '0.25rem' }}>
                          Dr. {apt.doctorName}
                        </div>
                        <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                          {apt.serviceName} • {new Date(apt.appointmentDate).toLocaleDateString()} at {new Date(apt.appointmentDate).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                        </div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
                          Status: <span style={{ textTransform: 'capitalize', fontWeight: 500 }}>{apt.status}</span>
                        </div>
                      </div>
                      {apt.status === 'booked' && (
                        <button
                          onClick={() => onCancelAppointment(apt.id)}
                          style={{
                            padding: '0.3rem 0.7rem',
                            background: 'rgba(239,68,68,0.1)',
                            color: '#ef4444',
                            border: '1px solid rgba(239,68,68,0.3)',
                            borderRadius: 6,
                            cursor: 'pointer',
                            fontSize: '0.75rem',
                            fontWeight: 500
                          }}
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
