// Appointment service — centralized business logic for patient-facing
// booking, cancellation, and rescheduling.
//
// Both the legacy /api/wellness/appointments/* routes (CUSTOMER session
// token) and the new /api/wellness/portal/appointments/* routes (phone+OTP
// portal token OR CUSTOMER session via verifyPatientToken Path B) converge
// on this service so business rules stay in one place. Routes are auth +
// patient-resolution + envelope-shape adapters only — they MUST NOT add
// validation here.
//
// PATIENT DETECTION (Phase 1 — no dedicated PATIENT role)
//
// The service is auth-agnostic: it takes a tenant-scoped patientId that
// the caller has already resolved at the route boundary. The `actor`
// argument distinguishes who is performing the action so the audit row
// records actorType + the right id:
//   • { type: 'user', id }    — staff or CUSTOMER session
//   • { type: 'patient', id } — phone+OTP portal session
//
// MIGRATION NOTE: if a dedicated PATIENT role lands later, only the
// routes change (the actor mapping above is updated to read the new
// role). This service stays untouched.

const prisma = require('../lib/prisma');
const { writeAudit } = require('../lib/audit');

// Visit statuses considered "active" — these block slot conflicts and
// cannot be cancelled (except 'booked' which IS cancellable + reschedulable).
const ACTIVE_VISIT_STATUSES = ['booked', 'confirmed', 'arrived', 'in-treatment'];
const TERMINAL_VISIT_STATUSES = ['completed', 'cancelled', 'no-show'];

class AppointmentError extends Error {
  constructor({ status, code, message }) {
    super(message);
    this.name = 'AppointmentError';
    this.status = status;
    this.code = code;
  }
}

// Parse an "appointment date + appointment time" pair into a UTC Date
// pinned to IST wall-clock. Mirrors the calculation in the legacy booking
// endpoint so storage timestamps stay consistent across the two surfaces.
function parseIstVisitDate(appointmentDate, appointmentTime) {
  if (!appointmentDate || !appointmentTime) return null;
  const parts = String(appointmentTime).split(':');
  if (parts.length < 2) return null;
  const hours = parseInt(parts[0], 10);
  const mins = parseInt(parts[1], 10);
  if (Number.isNaN(hours) || Number.isNaN(mins)) return null;
  const iso = `${appointmentDate}T${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:00+05:30`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function visitInclude() {
  return {
    patient: { select: { id: true, name: true, email: true, phone: true } },
    doctor: { select: { id: true, name: true } },
    service: { select: { id: true, name: true, category: true } },
  };
}

// Audit helpers — patient-actor audits set actorType=patient + patientId.
function auditUserId(actor) {
  return actor && actor.type === 'user' ? actor.id : null;
}
function auditOpts(actor) {
  if (actor && actor.type === 'patient') {
    return { actorType: 'patient', patientId: actor.id };
  }
  return {};
}

// Map a Visit row (with patient/doctor/service relations) into the
// patient-facing appointment envelope. `canCancel` / `canReschedule` are
// computed server-side so the UI doesn't re-derive them — single source
// of truth for which actions are eligible. The flags MUST mirror the
// policies enforced in cancelAppointment / rescheduleAppointment so
// the UI never surfaces a button that the service would 409 on.
function mapVisitToAppointment(v) {
  const status = v.status || 'booked';
  // Cancel is blocked once the patient has arrived or treatment started.
  const canCancel = status === 'booked' || status === 'confirmed';
  const canReschedule = status === 'booked';
  return {
    id: v.id,
    patientId: v.patientId,
    patientName: v.patient?.name || null,
    serviceId: v.serviceId,
    serviceName: v.service?.name || 'General',
    doctorId: v.doctorId,
    doctorName: v.doctor?.name || (v.doctorId ? null : 'Pending assignment'),
    appointmentDate: v.visitDate,
    status,
    reason: v.reason || null,
    bookingType: v.bookingType || 'CLINIC_VISIT',
    membershipId: v.membershipId || null,
    doctorAssigned: !!v.doctorId,
    canCancel,
    canReschedule,
    createdAt: v.createdAt,
  };
}

// Slot-conflict probe — returns the colliding visit (if any) for the
// given (doctorId, hour) window. Used by book + reschedule to enforce
// the "one doctor, one patient per hour" guard.
async function findSlotConflict({ tenantId, doctorId, visitDate, excludeVisitId = null }) {
  if (!doctorId) return null;
  const hourStart = new Date(visitDate);
  hourStart.setMinutes(0, 0, 0);
  const hourEnd = new Date(hourStart);
  hourEnd.setHours(hourEnd.getHours() + 1);
  const where = {
    tenantId,
    doctorId,
    status: { in: ACTIVE_VISIT_STATUSES },
    visitDate: { gte: hourStart, lt: hourEnd },
  };
  if (excludeVisitId) where.id = { not: excludeVisitId };
  return prisma.visit.findFirst({ where });
}

async function findResourceConflict({ tenantId, resourceId, visitDate, excludeVisitId = null }) {
  if (!resourceId) return null;
  const hourStart = new Date(visitDate);
  hourStart.setMinutes(0, 0, 0);
  const hourEnd = new Date(hourStart);
  hourEnd.setHours(hourEnd.getHours() + 1);
  const where = {
    tenantId,
    resourceId,
    status: { in: ACTIVE_VISIT_STATUSES },
    visitDate: { gte: hourStart, lt: hourEnd },
  };
  if (excludeVisitId) where.id = { not: excludeVisitId };
  return prisma.visit.findFirst({ where });
}

async function findApprovedLeave({ tenantId, doctorId, visitDate }) {
  if (!doctorId) return null;
  return prisma.leaveRequest.findFirst({
    where: {
      tenantId,
      userId: doctorId,
      status: 'APPROVED',
      startDate: { lte: visitDate },
      endDate: { gte: visitDate },
    },
  });
}

// Book an appointment. Patient resolution happens at the route layer
// (the service does NOT auto-create patients — callers must pass an
// already-known patientId scoped to tenantId).
async function bookAppointment({
  tenantId,
  patientId,
  doctorId = null,
  serviceId = null,
  membershipId = null,
  appointmentDate,
  appointmentTime,
  reason,
  bookingType = 'CLINIC_VISIT',
  actor,
}) {
  if (!tenantId || !patientId) {
    throw new AppointmentError({ status: 400, code: 'MISSING_FIELDS', message: 'tenantId and patientId are required' });
  }
  if (!appointmentDate || !appointmentTime) {
    throw new AppointmentError({ status: 400, code: 'MISSING_FIELDS', message: 'Missing required fields: appointmentDate, appointmentTime' });
  }
  const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
  if (!trimmedReason) {
    throw new AppointmentError({ status: 400, code: 'REASON_REQUIRED', message: 'Reason for appointment is required' });
  }

  const visitDate = parseIstVisitDate(appointmentDate, appointmentTime);
  if (!visitDate) {
    throw new AppointmentError({ status: 400, code: 'INVALID_DATE', message: 'Invalid appointment date' });
  }

  const parsedDoctorId = doctorId ? parseInt(doctorId, 10) : null;
  if (parsedDoctorId) {
    const leave = await findApprovedLeave({ tenantId, doctorId: parsedDoctorId, visitDate });
    if (leave) {
      throw new AppointmentError({ status: 409, code: 'DOCTOR_UNAVAILABLE', message: 'Doctor is not available on this date' });
    }
  }

  let resolvedMembershipId = null;
  if (membershipId != null && membershipId !== '') {
    const mId = parseInt(membershipId, 10);
    if (Number.isNaN(mId)) {
      throw new AppointmentError({ status: 400, code: 'INVALID_MEMBERSHIP', message: 'Invalid membership' });
    }
    const m = await prisma.membership.findFirst({ where: { id: mId, tenantId, patientId } });
    const now = new Date();
    if (!m || m.status !== 'active' || m.endDate < now) {
      throw new AppointmentError({ status: 400, code: 'MEMBERSHIP_INACTIVE', message: 'Selected membership is not active' });
    }
    resolvedMembershipId = mId;
  }

  const visit = await prisma.visit.create({
    data: {
      tenantId,
      patientId,
      doctorId: parsedDoctorId,
      serviceId: serviceId ? parseInt(serviceId, 10) : null,
      membershipId: resolvedMembershipId,
      visitDate,
      status: 'booked',
      bookingType,
      reason: trimmedReason,
      createdAt: new Date(),
    },
    include: visitInclude(),
  });

  await writeAudit('Visit', 'CREATE', auditUserId(actor), visit.id, tenantId, {
    patientId,
    doctorId: parsedDoctorId,
    visitDate: visitDate.toISOString(),
    action: actor && actor.type === 'patient' ? 'Patient self-booked appointment' : 'User self-booked appointment',
  }, auditOpts(actor));

  return { visit };
}

async function cancelAppointment({ tenantId, patientId, visitId, actor }) {
  const id = parseInt(visitId, 10);
  if (Number.isNaN(id)) {
    throw new AppointmentError({ status: 400, code: 'INVALID_ID', message: 'Invalid appointment id' });
  }
  const visit = await prisma.visit.findUnique({ where: { id } });
  if (!visit || visit.tenantId !== tenantId) {
    throw new AppointmentError({ status: 404, code: 'NOT_FOUND', message: 'Appointment not found' });
  }
  if (visit.patientId !== patientId) {
    throw new AppointmentError({ status: 403, code: 'FORBIDDEN', message: 'Can only cancel your own appointments' });
  }
  if (visit.status === 'cancelled') {
    // Idempotent — already cancelled, return current state without audit churn.
    const refreshed = await prisma.visit.findUnique({ where: { id }, include: visitInclude() });
    return { visit: refreshed };
  }
  if (TERMINAL_VISIT_STATUSES.includes(visit.status) || ['arrived', 'in-treatment'].includes(visit.status)) {
    throw new AppointmentError({ status: 409, code: 'STATUS_NOT_CANCELLABLE', message: 'Appointment cannot be cancelled in its current state' });
  }

  const updated = await prisma.visit.update({
    where: { id },
    data: { status: 'cancelled' },
    include: visitInclude(),
  });

  await writeAudit('Visit', 'UPDATE', auditUserId(actor), visit.id, tenantId, {
    action: actor && actor.type === 'patient' ? 'Patient cancelled appointment' : 'User cancelled appointment',
    status: 'cancelled',
  }, auditOpts(actor));

  return { visit: updated };
}

async function rescheduleAppointment({ tenantId, patientId, visitId, newAppointmentDate, newAppointmentTime, actor }) {
  const id = parseInt(visitId, 10);
  if (Number.isNaN(id)) {
    throw new AppointmentError({ status: 400, code: 'INVALID_ID', message: 'Invalid appointment id' });
  }
  const visit = await prisma.visit.findUnique({ where: { id } });
  if (!visit || visit.tenantId !== tenantId) {
    throw new AppointmentError({ status: 404, code: 'NOT_FOUND', message: 'Appointment not found' });
  }
  if (visit.patientId !== patientId) {
    throw new AppointmentError({ status: 403, code: 'FORBIDDEN', message: 'Can only reschedule your own appointments' });
  }
  if (visit.status !== 'booked') {
    throw new AppointmentError({ status: 409, code: 'STATUS_NOT_RESCHEDULABLE', message: 'Only booked appointments can be rescheduled' });
  }

  if (!newAppointmentDate || !newAppointmentTime) {
    throw new AppointmentError({ status: 400, code: 'MISSING_FIELDS', message: 'Missing required fields: appointmentDate, appointmentTime' });
  }
  const newVisitDate = parseIstVisitDate(newAppointmentDate, newAppointmentTime);
  if (!newVisitDate) {
    throw new AppointmentError({ status: 400, code: 'INVALID_DATE', message: 'Invalid appointment date' });
  }
  if (newVisitDate.getTime() <= Date.now()) {
    throw new AppointmentError({ status: 400, code: 'DATE_NOT_FUTURE', message: 'Appointment must be scheduled in the future' });
  }

  if (visit.doctorId) {
    const leave = await findApprovedLeave({ tenantId, doctorId: visit.doctorId, visitDate: newVisitDate });
    if (leave) {
      throw new AppointmentError({ status: 409, code: 'DOCTOR_UNAVAILABLE', message: 'Doctor is not available on this date' });
    }
    const slotConflict = await findSlotConflict({ tenantId, doctorId: visit.doctorId, visitDate: newVisitDate, excludeVisitId: id });
    if (slotConflict) {
      throw new AppointmentError({ status: 409, code: 'SLOT_TAKEN', message: 'Doctor is already booked at this time' });
    }
  }
  if (visit.resourceId) {
    const resourceConflict = await findResourceConflict({ tenantId, resourceId: visit.resourceId, visitDate: newVisitDate, excludeVisitId: id });
    if (resourceConflict) {
      throw new AppointmentError({ status: 409, code: 'RESOURCE_TAKEN', message: 'Resource is already booked at this time' });
    }
  }

  const oldVisitDate = visit.visitDate;
  const updated = await prisma.visit.update({
    where: { id },
    data: { visitDate: newVisitDate },
    include: visitInclude(),
  });

  await writeAudit('Visit', 'RESCHEDULE', auditUserId(actor), visit.id, tenantId, {
    oldVisitDate: oldVisitDate ? new Date(oldVisitDate).toISOString() : null,
    newVisitDate: newVisitDate.toISOString(),
    action: actor && actor.type === 'patient' ? 'Patient rescheduled appointment' : 'User rescheduled appointment',
  }, auditOpts(actor));

  return { visit: updated };
}

// Assign a doctor to a pending appointment (one with `doctorId: null`).
//
// Used by the staff Calendar + Appointments page when a portal booking
// arrived with "No preference — admin will assign". The admin picks a
// doctor from the availability dropdown, this service runs the same
// availability guards as bookAppointment, and the visit flips from
// the patient's "Pending Assignment" bucket into the "Upcoming" bucket
// on their next fetch (visibility-change refresh keeps it live).
//
// Reassignment (changing an existing doctor) intentionally goes through
// PUT /visits/:id instead of this endpoint — that path already exists
// and has its own audit trail. This endpoint is specifically for the
// pending → assigned transition.
async function assignDoctor({ tenantId, visitId, doctorId, actor }) {
  const id = parseInt(visitId, 10);
  if (Number.isNaN(id)) {
    throw new AppointmentError({ status: 400, code: 'INVALID_ID', message: 'Invalid appointment id' });
  }
  const newDoctorId = parseInt(doctorId, 10);
  if (Number.isNaN(newDoctorId)) {
    throw new AppointmentError({ status: 400, code: 'INVALID_DOCTOR', message: 'Invalid doctor id' });
  }

  const visit = await prisma.visit.findUnique({ where: { id } });
  if (!visit || visit.tenantId !== tenantId) {
    throw new AppointmentError({ status: 404, code: 'NOT_FOUND', message: 'Appointment not found' });
  }
  if (visit.status !== 'booked') {
    throw new AppointmentError({ status: 409, code: 'STATUS_NOT_ASSIGNABLE', message: 'Only booked appointments can be assigned a doctor' });
  }
  if (visit.doctorId) {
    // Prevent silent overwrite of an existing doctor — reassignment goes
    // through PUT /visits/:id which has the same guards plus a different
    // audit-action code (UPDATE vs ASSIGN_DOCTOR) for the audit log.
    throw new AppointmentError({ status: 409, code: 'ALREADY_ASSIGNED', message: 'Appointment already has a doctor assigned; use update to reassign' });
  }

  // Doctor must be a valid, active practitioner in this tenant.
  const doctor = await prisma.user.findFirst({
    where: { id: newDoctorId, tenantId, deactivatedAt: null },
    select: { id: true, name: true, wellnessRole: true },
  });
  if (!doctor) {
    throw new AppointmentError({ status: 400, code: 'INVALID_DOCTOR', message: 'Doctor not found' });
  }
  if (!['doctor', 'professional'].includes(doctor.wellnessRole)) {
    throw new AppointmentError({ status: 400, code: 'INVALID_DOCTOR', message: 'Selected user is not a bookable practitioner' });
  }

  const leave = await findApprovedLeave({ tenantId, doctorId: newDoctorId, visitDate: visit.visitDate });
  if (leave) {
    throw new AppointmentError({ status: 409, code: 'DOCTOR_UNAVAILABLE', message: 'Doctor is on leave at this time' });
  }
  const slotConflict = await findSlotConflict({ tenantId, doctorId: newDoctorId, visitDate: visit.visitDate, excludeVisitId: id });
  if (slotConflict) {
    throw new AppointmentError({ status: 409, code: 'SLOT_TAKEN', message: 'Doctor is already booked at this time' });
  }

  const updated = await prisma.visit.update({
    where: { id },
    data: { doctorId: newDoctorId },
    include: visitInclude(),
  });

  await writeAudit('Visit', 'ASSIGN_DOCTOR', auditUserId(actor), id, tenantId, {
    visitId: id,
    assignedDoctorId: newDoctorId,
    action: 'Staff assigned doctor to pending appointment',
  }, auditOpts(actor));

  return { visit: updated };
}

// Bucket the patient's visits into the four MyBookings sections. Returns
// an array of Visit rows (with relations) — the route layer maps each
// row through `mapVisitToAppointment` for the response envelope.
async function listPatientAppointments({ tenantId, patientId, bucket = 'upcoming' }) {
  const where = { tenantId, patientId };
  let orderBy = { visitDate: 'desc' };

  if (bucket === 'upcoming') {
    // Doctor assigned + still in an active status (not completed /
    // cancelled / no-show). Pending-assignment visits live in their own
    // bucket so receptionists can triage them.
    //
    // We intentionally do NOT filter on `visitDate >= now` here. When
    // admin assigns a doctor to a portal booking for a past slot
    // (patient self-booked yesterday, admin assigns today), the visit
    // must surface somewhere — otherwise it falls out of the patient's
    // view entirely between leaving "Pending Assignment" and being
    // marked completed / no-show by staff. The status enum is the
    // authoritative "still live work" signal; date is incidental.
    //
    // Sort soonest-upcoming first (asc) so the patient's next visit
    // sits at the top of the list.
    where.doctorId = { not: null };
    where.status = { in: ACTIVE_VISIT_STATUSES };
    orderBy = { visitDate: 'asc' };
  } else if (bucket === 'pending') {
    where.doctorId = null;
    where.status = 'booked';
    orderBy = { visitDate: 'asc' };
  } else if (bucket === 'completed') {
    where.status = 'completed';
  } else if (bucket === 'cancelled') {
    where.status = { in: ['cancelled', 'no-show'] };
  } else {
    throw new AppointmentError({ status: 400, code: 'INVALID_BUCKET', message: 'Unknown bucket' });
  }

  return prisma.visit.findMany({ where, orderBy, take: 100, include: visitInclude() });
}

module.exports = {
  AppointmentError,
  ACTIVE_VISIT_STATUSES,
  TERMINAL_VISIT_STATUSES,
  bookAppointment,
  cancelAppointment,
  rescheduleAppointment,
  assignDoctor,
  listPatientAppointments,
  mapVisitToAppointment,
  parseIstVisitDate,
};
