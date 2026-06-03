// Unit tests for backend/services/appointmentService.js
//
// What this module does:
//   Centralized business logic for patient-facing appointment booking,
//   cancellation, and rescheduling. Both the legacy
//   /api/wellness/appointments/* routes (CUSTOMER session) and the new
//   /api/wellness/portal/appointments/* routes (phone+OTP OR CUSTOMER
//   via verifyPatientToken) converge here so the rules can't drift.
//
// Surface area covered:
//   bookAppointment:
//     1. Happy path returns a visit with relations and writes an audit row
//     2. Missing required fields → 400 MISSING_FIELDS
//     3. Missing reason → 400 REASON_REQUIRED
//     4. Invalid date → 400 INVALID_DATE
//     5. Doctor on approved leave → 409 DOCTOR_UNAVAILABLE
//     6. Inactive / expired / wrong-tenant membership → 400 MEMBERSHIP_INACTIVE
//   cancelAppointment:
//     7. Happy path cancels and audits
//     8. Wrong-tenant visit → 404
//     9. Visit belongs to a different patient → 403
//    10. Already-cancelled visit returns success without re-audit (idempotent)
//    11. In-treatment / completed visits → 409 STATUS_NOT_CANCELLABLE
//   rescheduleAppointment:
//    12. Happy path moves the visit + audits with old + new visitDate
//    13. Non-booked status (in-treatment / completed) → 409 STATUS_NOT_RESCHEDULABLE
//    14. Past date → 400 DATE_NOT_FUTURE
//    15. Doctor on leave at new date → 409 DOCTOR_UNAVAILABLE
//    16. Same-doctor slot conflict at new hour → 409 SLOT_TAKEN
//   listPatientAppointments:
//    17. Bucket filters honour upcoming / pending / completed / cancelled
//    18. Invalid bucket → 400 INVALID_BUCKET

import { describe, test, expect, afterEach, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);

// Hoisted Prisma + audit mocks — CJS require interception via Node's
// Module._cache because vitest's ESM-level vi.mock can't reach require().
const mocks = vi.hoisted(() => {
  const prismaMock = {
    visit: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    leaveRequest: { findFirst: vi.fn() },
    membership: { findFirst: vi.fn() },
    // user.findFirst is hit by assignDoctor to validate the new doctor's
    // tenant + role + active status.
    user: { findFirst: vi.fn() },
  };
  const auditMock = { writeAudit: vi.fn().mockResolvedValue(undefined) };

  const Module = require('node:module');
  const requireFromCwd = Module.createRequire(process.cwd() + '/');
  const prismaLibPath = requireFromCwd.resolve('./lib/prisma');
  const auditLibPath = requireFromCwd.resolve('./lib/audit');
  Module._cache[prismaLibPath] = {
    id: prismaLibPath, filename: prismaLibPath, loaded: true,
    exports: prismaMock, children: [], paths: [],
  };
  Module._cache[auditLibPath] = {
    id: auditLibPath, filename: auditLibPath, loaded: true,
    exports: auditMock, children: [], paths: [],
  };
  return { prisma: prismaMock, audit: auditMock };
});

let svc;

beforeEach(() => {
  // Fresh load per test so internal module state can't leak between tests.
  delete requireCjs.cache[requireCjs.resolve('../../services/appointmentService.js')];
  svc = requireCjs('../../services/appointmentService.js');
  // Sensible defaults — most tests don't need a doctor on leave, no membership, etc.
  mocks.prisma.leaveRequest.findFirst.mockResolvedValue(null);
  mocks.prisma.membership.findFirst.mockResolvedValue(null);
  mocks.prisma.visit.findFirst.mockResolvedValue(null);
  mocks.audit.writeAudit.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

const futureDateStr = () => {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  return d.toISOString().slice(0, 10);
};
const pastDateStr = () => {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString().slice(0, 10);
};
const baseBookingInput = (overrides = {}) => ({
  tenantId: 1,
  patientId: 100,
  doctorId: 50,
  serviceId: 7,
  appointmentDate: futureDateStr(),
  appointmentTime: '10:00',
  reason: 'Routine consult',
  actor: { type: 'user', id: 999 },
  ...overrides,
});

describe('appointmentService.bookAppointment', () => {
  test('happy path creates a visit + audit row', async () => {
    const fakeVisit = {
      id: 555, tenantId: 1, patientId: 100, doctorId: 50, serviceId: 7,
      visitDate: new Date('2026-06-15T04:30:00.000Z'), status: 'booked',
      bookingType: 'CLINIC_VISIT', reason: 'Routine consult', membershipId: null,
      patient: { id: 100, name: 'Alice', email: 'a@b.c' },
      doctor: { id: 50, name: 'Dr. Smith' },
      service: { id: 7, name: 'Consultation' },
    };
    mocks.prisma.visit.create.mockResolvedValue(fakeVisit);

    const { visit } = await svc.bookAppointment(baseBookingInput());

    expect(visit).toEqual(fakeVisit);
    expect(mocks.prisma.visit.create).toHaveBeenCalledTimes(1);
    const createArgs = mocks.prisma.visit.create.mock.calls[0][0];
    expect(createArgs.data.status).toBe('booked');
    expect(createArgs.data.bookingType).toBe('CLINIC_VISIT');
    expect(createArgs.data.reason).toBe('Routine consult');
    expect(mocks.audit.writeAudit).toHaveBeenCalledTimes(1);
    expect(mocks.audit.writeAudit.mock.calls[0][0]).toBe('Visit');
    expect(mocks.audit.writeAudit.mock.calls[0][1]).toBe('CREATE');
  });

  test('missing appointmentDate/appointmentTime → 400 MISSING_FIELDS', async () => {
    await expect(
      svc.bookAppointment(baseBookingInput({ appointmentDate: undefined })),
    ).rejects.toMatchObject({ status: 400, code: 'MISSING_FIELDS' });
  });

  test('missing reason → 400 REASON_REQUIRED', async () => {
    await expect(
      svc.bookAppointment(baseBookingInput({ reason: '   ' })),
    ).rejects.toMatchObject({ status: 400, code: 'REASON_REQUIRED' });
  });

  test('invalid date → 400 INVALID_DATE', async () => {
    await expect(
      svc.bookAppointment(baseBookingInput({ appointmentDate: 'not-a-date' })),
    ).rejects.toMatchObject({ status: 400, code: 'INVALID_DATE' });
  });

  test('doctor on approved leave → 409 DOCTOR_UNAVAILABLE', async () => {
    mocks.prisma.leaveRequest.findFirst.mockResolvedValue({ id: 1, status: 'APPROVED' });
    await expect(
      svc.bookAppointment(baseBookingInput()),
    ).rejects.toMatchObject({ status: 409, code: 'DOCTOR_UNAVAILABLE' });
  });

  test('expired / inactive / wrong-tenant membership → 400 MEMBERSHIP_INACTIVE', async () => {
    // Expired
    mocks.prisma.membership.findFirst.mockResolvedValueOnce({
      id: 1, status: 'active', endDate: new Date(Date.now() - 1000),
    });
    await expect(
      svc.bookAppointment(baseBookingInput({ membershipId: 1 })),
    ).rejects.toMatchObject({ status: 400, code: 'MEMBERSHIP_INACTIVE' });

    // Wrong tenant (returns null)
    mocks.prisma.membership.findFirst.mockResolvedValueOnce(null);
    await expect(
      svc.bookAppointment(baseBookingInput({ membershipId: 2 })),
    ).rejects.toMatchObject({ status: 400, code: 'MEMBERSHIP_INACTIVE' });
  });
});

describe('appointmentService.cancelAppointment', () => {
  test('happy path cancels and audits', async () => {
    mocks.prisma.visit.findUnique.mockResolvedValue({
      id: 555, tenantId: 1, patientId: 100, status: 'booked',
    });
    mocks.prisma.visit.update.mockResolvedValue({
      id: 555, status: 'cancelled',
      patient: { id: 100, name: 'Alice' }, doctor: null, service: null,
    });

    const { visit } = await svc.cancelAppointment({
      tenantId: 1, patientId: 100, visitId: 555,
      actor: { type: 'patient', id: 100 },
    });

    expect(visit.status).toBe('cancelled');
    expect(mocks.prisma.visit.update).toHaveBeenCalledWith({
      where: { id: 555 },
      data: { status: 'cancelled' },
      include: expect.any(Object),
    });
    expect(mocks.audit.writeAudit).toHaveBeenCalledTimes(1);
    // writeAudit signature: (entity, action, userId, entityId, tenantId, details, opts)
    // Patient actor → userId arg is null; opts carries actorType.
    expect(mocks.audit.writeAudit.mock.calls[0][2]).toBe(null);
    expect(mocks.audit.writeAudit.mock.calls[0][6]).toMatchObject({ actorType: 'patient' });
  });

  test('wrong-tenant visit → 404 NOT_FOUND', async () => {
    mocks.prisma.visit.findUnique.mockResolvedValue({
      id: 555, tenantId: 999, patientId: 100, status: 'booked',
    });
    await expect(
      svc.cancelAppointment({ tenantId: 1, patientId: 100, visitId: 555, actor: { type: 'patient', id: 100 } }),
    ).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  test('other patient\'s visit → 403 FORBIDDEN', async () => {
    mocks.prisma.visit.findUnique.mockResolvedValue({
      id: 555, tenantId: 1, patientId: 200, status: 'booked',
    });
    await expect(
      svc.cancelAppointment({ tenantId: 1, patientId: 100, visitId: 555, actor: { type: 'patient', id: 100 } }),
    ).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });

  test('already-cancelled visit returns success without re-auditing', async () => {
    const cancelled = {
      id: 555, tenantId: 1, patientId: 100, status: 'cancelled',
      patient: { id: 100, name: 'Alice' }, doctor: null, service: null,
    };
    mocks.prisma.visit.findUnique.mockResolvedValueOnce({ id: 555, tenantId: 1, patientId: 100, status: 'cancelled' });
    mocks.prisma.visit.findUnique.mockResolvedValueOnce(cancelled); // the refresh fetch
    const { visit } = await svc.cancelAppointment({
      tenantId: 1, patientId: 100, visitId: 555, actor: { type: 'patient', id: 100 },
    });
    expect(visit.status).toBe('cancelled');
    expect(mocks.prisma.visit.update).not.toHaveBeenCalled();
    expect(mocks.audit.writeAudit).not.toHaveBeenCalled();
  });

  test('completed / in-treatment visit → 409 STATUS_NOT_CANCELLABLE', async () => {
    mocks.prisma.visit.findUnique.mockResolvedValue({
      id: 555, tenantId: 1, patientId: 100, status: 'in-treatment',
    });
    await expect(
      svc.cancelAppointment({ tenantId: 1, patientId: 100, visitId: 555, actor: { type: 'patient', id: 100 } }),
    ).rejects.toMatchObject({ status: 409, code: 'STATUS_NOT_CANCELLABLE' });
  });
});

describe('appointmentService.rescheduleAppointment', () => {
  test('happy path reschedules and audits with old + new visitDate', async () => {
    const oldVisit = {
      id: 555, tenantId: 1, patientId: 100, doctorId: 50, status: 'booked',
      visitDate: new Date('2026-06-01T04:30:00.000Z'),
    };
    mocks.prisma.visit.findUnique.mockResolvedValue(oldVisit);
    mocks.prisma.visit.update.mockResolvedValue({
      ...oldVisit, visitDate: new Date('2026-06-15T04:30:00.000Z'),
      patient: { id: 100, name: 'Alice' }, doctor: { id: 50, name: 'Dr. Smith' }, service: null,
    });

    const { visit } = await svc.rescheduleAppointment({
      tenantId: 1, patientId: 100, visitId: 555,
      newAppointmentDate: futureDateStr(), newAppointmentTime: '10:00',
      actor: { type: 'patient', id: 100 },
    });
    expect(visit.id).toBe(555);
    expect(mocks.prisma.visit.update).toHaveBeenCalledTimes(1);
    expect(mocks.audit.writeAudit).toHaveBeenCalledTimes(1);
    expect(mocks.audit.writeAudit.mock.calls[0][1]).toBe('RESCHEDULE');
    const details = mocks.audit.writeAudit.mock.calls[0][5];
    expect(details).toHaveProperty('oldVisitDate');
    expect(details).toHaveProperty('newVisitDate');
  });

  test('non-booked visit → 409 STATUS_NOT_RESCHEDULABLE', async () => {
    mocks.prisma.visit.findUnique.mockResolvedValue({
      id: 555, tenantId: 1, patientId: 100, status: 'in-treatment',
    });
    await expect(
      svc.rescheduleAppointment({
        tenantId: 1, patientId: 100, visitId: 555,
        newAppointmentDate: futureDateStr(), newAppointmentTime: '10:00',
        actor: { type: 'patient', id: 100 },
      }),
    ).rejects.toMatchObject({ status: 409, code: 'STATUS_NOT_RESCHEDULABLE' });
  });

  test('past date → 400 DATE_NOT_FUTURE', async () => {
    mocks.prisma.visit.findUnique.mockResolvedValue({
      id: 555, tenantId: 1, patientId: 100, doctorId: 50, status: 'booked',
      visitDate: new Date(),
    });
    await expect(
      svc.rescheduleAppointment({
        tenantId: 1, patientId: 100, visitId: 555,
        newAppointmentDate: pastDateStr(), newAppointmentTime: '10:00',
        actor: { type: 'patient', id: 100 },
      }),
    ).rejects.toMatchObject({ status: 400, code: 'DATE_NOT_FUTURE' });
  });

  test('doctor on leave at new date → 409 DOCTOR_UNAVAILABLE', async () => {
    mocks.prisma.visit.findUnique.mockResolvedValue({
      id: 555, tenantId: 1, patientId: 100, doctorId: 50, status: 'booked',
      visitDate: new Date(),
    });
    mocks.prisma.leaveRequest.findFirst.mockResolvedValue({ id: 1, status: 'APPROVED' });
    await expect(
      svc.rescheduleAppointment({
        tenantId: 1, patientId: 100, visitId: 555,
        newAppointmentDate: futureDateStr(), newAppointmentTime: '10:00',
        actor: { type: 'patient', id: 100 },
      }),
    ).rejects.toMatchObject({ status: 409, code: 'DOCTOR_UNAVAILABLE' });
  });

  test('same-doctor slot conflict at new hour → 409 SLOT_TAKEN', async () => {
    mocks.prisma.visit.findUnique.mockResolvedValue({
      id: 555, tenantId: 1, patientId: 100, doctorId: 50, status: 'booked',
      visitDate: new Date(),
    });
    mocks.prisma.visit.findFirst.mockResolvedValue({ id: 777, doctorId: 50 }); // collision
    await expect(
      svc.rescheduleAppointment({
        tenantId: 1, patientId: 100, visitId: 555,
        newAppointmentDate: futureDateStr(), newAppointmentTime: '10:00',
        actor: { type: 'patient', id: 100 },
      }),
    ).rejects.toMatchObject({ status: 409, code: 'SLOT_TAKEN' });
  });
});

describe('appointmentService.listPatientAppointments', () => {
  test('upcoming bucket filters on non-null doctor + active statuses (NOT future-only)', async () => {
    // Regression: pre-fix, this bucket also required visitDate >= now,
    // which orphaned visits where admin assigned a doctor AFTER the
    // booked slot had passed — the visit dropped out of 'pending'
    // (doctor now set) but failed the date guard for 'upcoming',
    // landing in NO bucket. Patients lost visibility entirely.
    mocks.prisma.visit.findMany.mockResolvedValue([]);
    await svc.listPatientAppointments({ tenantId: 1, patientId: 100, bucket: 'upcoming' });
    const where = mocks.prisma.visit.findMany.mock.calls[0][0].where;
    expect(where.tenantId).toBe(1);
    expect(where.patientId).toBe(100);
    expect(where.doctorId).toEqual({ not: null });
    expect(where.status).toEqual({ in: ['booked', 'confirmed', 'arrived', 'in-treatment'] });
    // The visitDate filter is intentionally absent so past-dated active
    // visits (recently-assigned by admin) still surface in this bucket
    // until staff marks them completed / no-show.
    expect(where.visitDate).toBeUndefined();
    expect(where.AND).toBeUndefined();
  });

  test('pending bucket filters on doctorId IS NULL + status=booked', async () => {
    mocks.prisma.visit.findMany.mockResolvedValue([]);
    await svc.listPatientAppointments({ tenantId: 1, patientId: 100, bucket: 'pending' });
    const where = mocks.prisma.visit.findMany.mock.calls[0][0].where;
    expect(where.doctorId).toBeNull();
    expect(where.status).toBe('booked');
  });

  test('completed + cancelled buckets use status filters', async () => {
    mocks.prisma.visit.findMany.mockResolvedValue([]);
    await svc.listPatientAppointments({ tenantId: 1, patientId: 100, bucket: 'completed' });
    expect(mocks.prisma.visit.findMany.mock.calls[0][0].where.status).toBe('completed');

    mocks.prisma.visit.findMany.mockResolvedValue([]);
    await svc.listPatientAppointments({ tenantId: 1, patientId: 100, bucket: 'cancelled' });
    expect(mocks.prisma.visit.findMany.mock.calls[1][0].where.status).toEqual({ in: ['cancelled', 'no-show'] });
  });

  test('unknown bucket → 400 INVALID_BUCKET', async () => {
    await expect(
      svc.listPatientAppointments({ tenantId: 1, patientId: 100, bucket: 'garbage' }),
    ).rejects.toMatchObject({ status: 400, code: 'INVALID_BUCKET' });
  });
});

describe('appointmentService.mapVisitToAppointment', () => {
  test('booked + doctor-assigned → canCancel + canReschedule are true', () => {
    const out = svc.mapVisitToAppointment({
      id: 1, status: 'booked', visitDate: new Date(), patientId: 100, doctorId: 50,
      patient: { name: 'Alice' }, doctor: { name: 'Dr. Smith' }, service: { name: 'X' },
    });
    expect(out.canCancel).toBe(true);
    expect(out.canReschedule).toBe(true);
    expect(out.doctorName).toBe('Dr. Smith');
    expect(out.doctorAssigned).toBe(true);
  });

  test('pending-assignment (doctorId null) → doctorName = Pending assignment', () => {
    const out = svc.mapVisitToAppointment({
      id: 1, status: 'booked', visitDate: new Date(), patientId: 100, doctorId: null,
      patient: { name: 'Alice' }, doctor: null, service: { name: 'X' },
    });
    expect(out.doctorName).toBe('Pending assignment');
    expect(out.doctorAssigned).toBe(false);
    expect(out.canCancel).toBe(true);
    expect(out.canReschedule).toBe(true);
  });

  test('completed visit → neither cancellable nor reschedulable', () => {
    const out = svc.mapVisitToAppointment({
      id: 1, status: 'completed', visitDate: new Date(), patientId: 100, doctorId: 50,
      patient: { name: 'Alice' }, doctor: { name: 'Dr. Smith' }, service: { name: 'X' },
    });
    expect(out.canCancel).toBe(false);
    expect(out.canReschedule).toBe(false);
  });

  test('in-treatment / arrived → cancel disabled, reschedule disabled', () => {
    for (const status of ['in-treatment', 'arrived']) {
      const out = svc.mapVisitToAppointment({
        id: 1, status, visitDate: new Date(), patientId: 100, doctorId: 50,
        patient: { name: 'Alice' }, doctor: { name: 'Dr. Smith' }, service: { name: 'X' },
      });
      expect(out.canReschedule).toBe(false);
      // canCancel mirrors the service's policy — once the patient arrives
      // or treatment starts, cancellation goes through staff override.
      expect(out.canCancel).toBe(false);
    }
  });

  test('confirmed (post-booked) → still cancellable + reschedulable=false', () => {
    const out = svc.mapVisitToAppointment({
      id: 1, status: 'confirmed', visitDate: new Date(), patientId: 100, doctorId: 50,
      patient: { name: 'Alice' }, doctor: { name: 'Dr. Smith' }, service: { name: 'X' },
    });
    expect(out.canCancel).toBe(true);
    expect(out.canReschedule).toBe(false);
  });
});

describe('appointmentService.assignDoctor', () => {
  const validDoctor = { id: 50, name: 'Dr. Smith', wellnessRole: 'doctor' };

  test('happy path assigns doctor + audits with ASSIGN_DOCTOR action', async () => {
    mocks.prisma.visit.findUnique.mockResolvedValue({
      id: 555, tenantId: 1, patientId: 100, doctorId: null, status: 'booked',
      visitDate: new Date('2099-06-15T04:30:00.000Z'),
    });
    mocks.prisma.user.findFirst.mockResolvedValue(validDoctor);
    mocks.prisma.visit.update.mockResolvedValue({
      id: 555, doctorId: 50, status: 'booked',
      visitDate: new Date('2099-06-15T04:30:00.000Z'),
      patient: { id: 100, name: 'Alice' }, doctor: validDoctor, service: null,
    });

    const { visit } = await svc.assignDoctor({
      tenantId: 1, visitId: 555, doctorId: 50,
      actor: { type: 'user', id: 999 },
    });

    expect(visit.doctorId).toBe(50);
    expect(mocks.prisma.visit.update).toHaveBeenCalledWith({
      where: { id: 555 },
      data: { doctorId: 50 },
      include: expect.any(Object),
    });
    expect(mocks.audit.writeAudit).toHaveBeenCalledTimes(1);
    expect(mocks.audit.writeAudit.mock.calls[0][1]).toBe('ASSIGN_DOCTOR');
    const details = mocks.audit.writeAudit.mock.calls[0][5];
    expect(details.assignedDoctorId).toBe(50);
  });

  test('visit with doctor already assigned → 409 ALREADY_ASSIGNED', async () => {
    mocks.prisma.visit.findUnique.mockResolvedValue({
      id: 555, tenantId: 1, patientId: 100, doctorId: 42, status: 'booked',
      visitDate: new Date(),
    });
    await expect(
      svc.assignDoctor({ tenantId: 1, visitId: 555, doctorId: 50, actor: { type: 'user', id: 999 } }),
    ).rejects.toMatchObject({ status: 409, code: 'ALREADY_ASSIGNED' });
    expect(mocks.prisma.visit.update).not.toHaveBeenCalled();
  });

  test('non-booked status (in-treatment / completed) → 409 STATUS_NOT_ASSIGNABLE', async () => {
    mocks.prisma.visit.findUnique.mockResolvedValue({
      id: 555, tenantId: 1, patientId: 100, doctorId: null, status: 'in-treatment',
      visitDate: new Date(),
    });
    await expect(
      svc.assignDoctor({ tenantId: 1, visitId: 555, doctorId: 50, actor: { type: 'user', id: 999 } }),
    ).rejects.toMatchObject({ status: 409, code: 'STATUS_NOT_ASSIGNABLE' });
  });

  test('cross-tenant visit → 404 NOT_FOUND', async () => {
    mocks.prisma.visit.findUnique.mockResolvedValue({
      id: 555, tenantId: 999, patientId: 100, doctorId: null, status: 'booked',
      visitDate: new Date(),
    });
    await expect(
      svc.assignDoctor({ tenantId: 1, visitId: 555, doctorId: 50, actor: { type: 'user', id: 999 } }),
    ).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  test('doctor not found → 400 INVALID_DOCTOR', async () => {
    mocks.prisma.visit.findUnique.mockResolvedValue({
      id: 555, tenantId: 1, patientId: 100, doctorId: null, status: 'booked',
      visitDate: new Date(),
    });
    mocks.prisma.user.findFirst.mockResolvedValue(null);
    await expect(
      svc.assignDoctor({ tenantId: 1, visitId: 555, doctorId: 50, actor: { type: 'user', id: 999 } }),
    ).rejects.toMatchObject({ status: 400, code: 'INVALID_DOCTOR' });
  });

  test('doctor wellnessRole is not bookable → 400 INVALID_DOCTOR', async () => {
    mocks.prisma.visit.findUnique.mockResolvedValue({
      id: 555, tenantId: 1, patientId: 100, doctorId: null, status: 'booked',
      visitDate: new Date(),
    });
    mocks.prisma.user.findFirst.mockResolvedValue({ id: 50, name: 'Receptionist', wellnessRole: 'receptionist' });
    await expect(
      svc.assignDoctor({ tenantId: 1, visitId: 555, doctorId: 50, actor: { type: 'user', id: 999 } }),
    ).rejects.toMatchObject({ status: 400, code: 'INVALID_DOCTOR' });
  });

  test('doctor on approved leave → 409 DOCTOR_UNAVAILABLE', async () => {
    mocks.prisma.visit.findUnique.mockResolvedValue({
      id: 555, tenantId: 1, patientId: 100, doctorId: null, status: 'booked',
      visitDate: new Date(),
    });
    mocks.prisma.user.findFirst.mockResolvedValue(validDoctor);
    mocks.prisma.leaveRequest.findFirst.mockResolvedValue({ id: 1, status: 'APPROVED' });
    await expect(
      svc.assignDoctor({ tenantId: 1, visitId: 555, doctorId: 50, actor: { type: 'user', id: 999 } }),
    ).rejects.toMatchObject({ status: 409, code: 'DOCTOR_UNAVAILABLE' });
  });

  test('slot conflict at visit hour → 409 SLOT_TAKEN', async () => {
    mocks.prisma.visit.findUnique.mockResolvedValue({
      id: 555, tenantId: 1, patientId: 100, doctorId: null, status: 'booked',
      visitDate: new Date(),
    });
    mocks.prisma.user.findFirst.mockResolvedValue(validDoctor);
    mocks.prisma.visit.findFirst.mockResolvedValue({ id: 777, doctorId: 50 });
    await expect(
      svc.assignDoctor({ tenantId: 1, visitId: 555, doctorId: 50, actor: { type: 'user', id: 999 } }),
    ).rejects.toMatchObject({ status: 409, code: 'SLOT_TAKEN' });
  });
});
