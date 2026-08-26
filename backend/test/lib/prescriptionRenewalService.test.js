// @ts-check
/**
 * Unit tests for backend/lib/prescriptionRenewalService.js — the single place
 * the prescription renewal / medicine-request workflow lives.
 *
 * Why this file exists
 * ────────────────────
 * Two clients drive this service from opposite ends: the Android app raises a
 * request through /api/wellness/portal/prescription-requests, and the clinic
 * actions it through /api/wellness/prescription-requests. Everything they
 * could disagree about — what "renew the whole prescription" means on the
 * wire, which medicines are even askable, which status moves are legal — is
 * decided here, so this is where it gets pinned.
 *
 * What is covered
 * ───────────────
 *   resolveRequestedDrugs — the trust boundary. Absent/empty ⇒ full-Rx (null);
 *     names matched case-/whitespace-insensitively against the SOURCE Rx;
 *     a medicine not on the Rx is rejected by name; "all of them" collapses
 *     back to full-Rx; duplicates are idempotent; the stored object is the
 *     clinic's drug row, not the client's payload.
 *   parseRequestedWindow — duration + date-window validation and the caps.
 *   toPublicRequest — the wire shape both clients read, incl. the derived
 *     `isFullPrescription` flag and the parsed drugs array.
 *   isAllowedTransition — the status machine, including terminal states.
 *   createRenewalRequest — cross-patient Rx is a 404 (not a 403 — a probing
 *     client must not learn the id exists); doctorId is taken from the Rx and
 *     NOT from the body; a second open request is a 409.
 *   transitionRequest — rejection needs a reason; a closed request cannot be
 *     reopened; a lost compare-and-set race surfaces as 409, not a silent
 *     overwrite.
 *
 * Pattern: prisma singleton monkey-patch before requiring the service, same
 * as backend/test/routes/wellness-appointments-book.test.js.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const prisma = requireCJS('../../lib/prisma');

prisma.prescription = prisma.prescription || {};
prisma.prescription.findFirst = vi.fn();

prisma.prescriptionRequest = prisma.prescriptionRequest || {};
prisma.prescriptionRequest.findFirst = vi.fn();
prisma.prescriptionRequest.findMany = vi.fn();
prisma.prescriptionRequest.create = vi.fn();
prisma.prescriptionRequest.updateMany = vi.fn();
prisma.prescriptionRequest.count = vi.fn();
prisma.prescriptionRequest.groupBy = vi.fn();

prisma.prescriptionRequestEvent = prisma.prescriptionRequestEvent || {};
prisma.prescriptionRequestEvent.create = vi.fn();

prisma.user = prisma.user || {};
prisma.user.findMany = vi.fn();

prisma.patientNotification = prisma.patientNotification || {};
prisma.patientNotification.create = vi.fn();

prisma.notification = prisma.notification || {};
prisma.notification.create = vi.fn();
// notificationService.notify() dedups against a recent identical row before
// inserting — stub the probe so the insert path is the one under test.
prisma.notification.findFirst = vi.fn();

prisma.auditLog = prisma.auditLog || {};
prisma.auditLog.create = vi.fn().mockResolvedValue({ id: 1 });
prisma.auditLog.findFirst = vi.fn().mockResolvedValue(null);

prisma.notificationPreference = prisma.notificationPreference || {};
prisma.notificationPreference.findUnique = vi.fn().mockResolvedValue(null);

const svc = requireCJS('../../lib/prescriptionRenewalService');

const RX_DRUGS = JSON.stringify([
  { name: 'Amoxicillin', strengthValue: 500, strengthUnit: 'mg', dosage: '1 capsule', frequency: 'three times daily', duration: '5 days' },
  { name: 'Crocin Advance', dosage: '1 tablet', frequency: 'twice daily', duration: '3 days' },
  { name: 'Azithromycin', dosage: '500 mg', frequency: 'once daily', duration: '7 days' },
]);

beforeEach(() => {
  vi.clearAllMocks();
  prisma.user.findMany.mockResolvedValue([]);
  prisma.notification.create.mockResolvedValue({ id: 1 });
  prisma.notification.findFirst.mockResolvedValue(null);
  prisma.patientNotification.create.mockResolvedValue({ id: 1 });
  prisma.auditLog.create.mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockResolvedValue(null);
  prisma.notificationPreference.findUnique.mockResolvedValue(null);
});

// ─────────────────────────────────────────────────────────────────────────
// resolveRequestedDrugs — the trust boundary
// ─────────────────────────────────────────────────────────────────────────

describe('resolveRequestedDrugs', () => {
  test('undefined / null / [] all mean "renew the complete prescription"', () => {
    expect(svc.resolveRequestedDrugs(RX_DRUGS, undefined)).toBeNull();
    expect(svc.resolveRequestedDrugs(RX_DRUGS, null)).toBeNull();
    expect(svc.resolveRequestedDrugs(RX_DRUGS, [])).toBeNull();
  });

  test('matches bare medicine names case- and whitespace-insensitively', () => {
    const out = svc.resolveRequestedDrugs(RX_DRUGS, ['  crocin   ADVANCE ']);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('Crocin Advance');
  });

  test('accepts objects and returns the SOURCE prescription drug, not the client payload', () => {
    // The client sends a stripped object; we must store the clinic's row so a
    // later amendment can't retroactively change what was asked for.
    const out = svc.resolveRequestedDrugs(RX_DRUGS, [
      { name: 'Amoxicillin', dosage: 'whatever the client says' },
    ]);
    expect(out).toEqual([
      {
        name: 'Amoxicillin',
        strengthValue: 500,
        strengthUnit: 'mg',
        dosage: '1 capsule',
        frequency: 'three times daily',
        duration: '5 days',
      },
    ]);
  });

  test('rejects a medicine that is not on the prescription, naming it', () => {
    expect(() => svc.resolveRequestedDrugs(RX_DRUGS, ['Tramadol'])).toThrowError(
      /Not on this prescription: Tramadol/,
    );
    try {
      svc.resolveRequestedDrugs(RX_DRUGS, ['Amoxicillin', 'Tramadol']);
    } catch (err) {
      expect(err.code).toBe('MEDICINE_NOT_ON_PRESCRIPTION');
      expect(err.status).toBe(400);
    }
  });

  test('selecting every medicine collapses back to a full-prescription renewal', () => {
    const out = svc.resolveRequestedDrugs(RX_DRUGS, [
      'Amoxicillin',
      'Crocin Advance',
      'Azithromycin',
    ]);
    expect(out).toBeNull();
  });

  test('duplicate selections are idempotent, not an error', () => {
    const out = svc.resolveRequestedDrugs(RX_DRUGS, ['Amoxicillin', 'amoxicillin']);
    expect(out).toHaveLength(1);
  });

  test('a non-array selection is a 400', () => {
    try {
      svc.resolveRequestedDrugs(RX_DRUGS, 'Amoxicillin');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.code).toBe('INVALID_MEDICINES');
    }
  });

  test('a nameless entry is a 400', () => {
    try {
      svc.resolveRequestedDrugs(RX_DRUGS, [{ dosage: '1 tablet' }]);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.code).toBe('INVALID_MEDICINES');
    }
  });

  test('specific medicines against an Rx with no drugs recorded is a 400', () => {
    try {
      svc.resolveRequestedDrugs('[]', ['Amoxicillin']);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.code).toBe('PRESCRIPTION_HAS_NO_DRUGS');
    }
  });

  test('malformed drugs JSON degrades to "no drugs" rather than throwing', () => {
    expect(svc.parseDrugList('not json at all')).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// parseRequestedWindow
// ─────────────────────────────────────────────────────────────────────────

describe('parseRequestedWindow', () => {
  test('all fields optional — an empty request is valid', () => {
    expect(svc.parseRequestedWindow({})).toEqual({
      requestedDurationDays: null,
      requestedFrom: null,
      requestedTo: null,
    });
  });

  test('accepts a positive whole-day duration', () => {
    expect(svc.parseRequestedWindow({ durationDays: 60 }).requestedDurationDays).toBe(60);
    expect(svc.parseRequestedWindow({ durationDays: '30' }).requestedDurationDays).toBe(30);
  });

  test('rejects zero, negative, fractional and non-numeric durations', () => {
    for (const bad of [0, -5, 1.5, 'soon']) {
      expect(() => svc.parseRequestedWindow({ durationDays: bad })).toThrowError(
        /positive whole number/,
      );
    }
  });

  test('caps the duration at one year', () => {
    try {
      svc.parseRequestedWindow({ durationDays: svc.MAX_DURATION_DAYS + 1 });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.code).toBe('DURATION_TOO_LONG');
    }
  });

  test('parses a YYYY-MM-DD window to UTC midnight', () => {
    const out = svc.parseRequestedWindow({ from: '2026-09-01', to: '2026-10-31' });
    expect(out.requestedFrom.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(out.requestedTo.toISOString()).toBe('2026-10-31T00:00:00.000Z');
  });

  test('rejects an unparseable date and a backwards range', () => {
    expect(() => svc.parseRequestedWindow({ from: 'next tuesday' })).toThrowError(
      /YYYY-MM-DD/,
    );
    try {
      svc.parseRequestedWindow({ from: '2026-10-31', to: '2026-09-01' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.code).toBe('INVALID_DATE_RANGE');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// toPublicRequest — the wire shape
// ─────────────────────────────────────────────────────────────────────────

describe('toPublicRequest', () => {
  test('a full-Rx request reports isFullPrescription with null drugs', () => {
    const out = svc.toPublicRequest({
      id: 5,
      status: 'PENDING',
      prescriptionId: 9,
      patientId: 3,
      requestedDrugs: null,
      createdAt: new Date('2026-08-26T10:00:00Z'),
    });
    expect(out.isFullPrescription).toBe(true);
    expect(out.requestedDrugs).toBeNull();
  });

  test('a partial request parses the stored JSON into an array', () => {
    const out = svc.toPublicRequest({
      id: 6,
      status: 'PENDING',
      prescriptionId: 9,
      patientId: 3,
      requestedDrugs: '[{"name":"Amoxicillin"}]',
      createdAt: new Date(),
    });
    expect(out.isFullPrescription).toBe(false);
    expect(out.requestedDrugs).toEqual([{ name: 'Amoxicillin' }]);
  });

  test('flattens joined patient / doctor / reviewer names and the Rx drugs', () => {
    const out = svc.toPublicRequest({
      id: 7,
      status: 'ACCEPTED',
      prescriptionId: 9,
      patientId: 3,
      doctorId: 11,
      requestedDrugs: null,
      createdAt: new Date(),
      patient: { id: 3, name: 'Asha Menon', phone: '9999295298' },
      doctor: { id: 11, name: 'Dr Rao' },
      reviewedBy: { id: 12, name: 'Front Desk' },
      prescription: { id: 9, drugs: RX_DRUGS, createdAt: new Date() },
    });
    expect(out.patientName).toBe('Asha Menon');
    expect(out.doctorName).toBe('Dr Rao');
    expect(out.reviewedByName).toBe('Front Desk');
    // Normalised through the shared prescriptionHelpers, so dosage/frequency
    // come back as integers exactly like every other Rx response.
    expect(out.prescription.drugs[0]).toMatchObject({
      name: 'Amoxicillin 500mg',
      dosage: 1,
      frequency: 3,
      duration: 5,
    });
  });

  test('maps the event rows to a renderable history list', () => {
    const out = svc.toPublicRequest({
      id: 8,
      status: 'REJECTED',
      prescriptionId: 9,
      patientId: 3,
      requestedDrugs: null,
      createdAt: new Date(),
      events: [
        { id: 1, action: 'CREATED', toStatus: 'PENDING', actorType: 'patient', createdAt: new Date() },
        {
          id: 2,
          action: 'REJECTED',
          fromStatus: 'PENDING',
          toStatus: 'REJECTED',
          note: 'Needs a review consult first',
          actorType: 'user',
          actor: { id: 4, name: 'Dr Rao' },
          createdAt: new Date(),
        },
      ],
    });
    expect(out.history).toHaveLength(2);
    expect(out.history[0].actorType).toBe('patient');
    expect(out.history[1].actorName).toBe('Dr Rao');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Status machine
// ─────────────────────────────────────────────────────────────────────────

describe('isAllowedTransition', () => {
  test('PENDING can go anywhere', () => {
    expect(svc.isAllowedTransition('PENDING', 'ACCEPTED')).toBe(true);
    expect(svc.isAllowedTransition('PENDING', 'REJECTED')).toBe(true);
    expect(svc.isAllowedTransition('PENDING', 'COMPLETED')).toBe(true);
  });

  test('ACCEPTED can still be completed or rejected', () => {
    expect(svc.isAllowedTransition('ACCEPTED', 'COMPLETED')).toBe(true);
    expect(svc.isAllowedTransition('ACCEPTED', 'REJECTED')).toBe(true);
  });

  test('terminal states are terminal', () => {
    for (const to of svc.REQUEST_STATUSES) {
      expect(svc.isAllowedTransition('REJECTED', to)).toBe(false);
      expect(svc.isAllowedTransition('COMPLETED', to)).toBe(false);
    }
  });

  test('normalizeStatus is case-insensitive and rejects unknown values', () => {
    expect(svc.normalizeStatus('accepted')).toBe('ACCEPTED');
    expect(svc.normalizeStatus('  Pending ')).toBe('PENDING');
    expect(svc.normalizeStatus('MAYBE')).toBeNull();
    expect(svc.normalizeStatus(undefined)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// createRenewalRequest
// ─────────────────────────────────────────────────────────────────────────

describe('createRenewalRequest', () => {
  test('requires a prescriptionId', async () => {
    await expect(
      svc.createRenewalRequest({ patientId: 3, tenantId: 1, body: {} }),
    ).rejects.toMatchObject({ code: 'PRESCRIPTION_ID_REQUIRED', status: 400 });
  });

  test('another patient\'s prescription is a 404, not a 403', async () => {
    // The lookup is scoped by patientId + tenantId, so a cross-patient id
    // simply does not resolve — the caller learns nothing about it existing.
    prisma.prescription.findFirst.mockResolvedValue(null);
    await expect(
      svc.createRenewalRequest({
        patientId: 3,
        tenantId: 1,
        body: { prescriptionId: 999 },
      }),
    ).rejects.toMatchObject({ code: 'PRESCRIPTION_NOT_FOUND', status: 404 });
    expect(prisma.prescription.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 999, patientId: 3, tenantId: 1 },
      }),
    );
  });

  test('takes doctorId from the prescription and ignores the client\'s claim', async () => {
    prisma.prescription.findFirst.mockResolvedValue({
      id: 9,
      drugs: RX_DRUGS,
      doctorId: 11,
      status: 'issued',
      createdAt: new Date(),
    });
    prisma.prescriptionRequest.findFirst.mockResolvedValue(null);
    prisma.prescriptionRequest.create.mockImplementation(async ({ data }) => ({
      id: 21,
      ...data,
      patient: { id: 3, name: 'Asha Menon' },
    }));

    await svc.createRenewalRequest({
      patientId: 3,
      tenantId: 1,
      // A malicious client attributing the request to a different doctor.
      body: { prescriptionId: 9, doctorId: 4242 },
    });

    const created = prisma.prescriptionRequest.create.mock.calls[0][0].data;
    expect(created.doctorId).toBe(11);
    expect(created.tenantId).toBe(1);
    expect(created.patientId).toBe(3);
    expect(created.status).toBe('PENDING');
    // No medicines supplied ⇒ whole-prescription renewal.
    expect(created.requestedDrugs).toBeNull();
    // The CREATED history row is written in the same call.
    expect(created.events.create).toMatchObject({
      action: 'CREATED',
      toStatus: 'PENDING',
      actorType: 'patient',
    });
  });

  test('stores the selected medicines as a JSON snapshot', async () => {
    prisma.prescription.findFirst.mockResolvedValue({
      id: 9,
      drugs: RX_DRUGS,
      doctorId: 11,
      status: null,
      createdAt: new Date(),
    });
    prisma.prescriptionRequest.findFirst.mockResolvedValue(null);
    prisma.prescriptionRequest.create.mockImplementation(async ({ data }) => ({
      id: 22,
      ...data,
      patient: { id: 3, name: 'Asha Menon' },
    }));

    await svc.createRenewalRequest({
      patientId: 3,
      tenantId: 1,
      body: { prescriptionId: 9, medicines: ['Amoxicillin'], durationDays: 30 },
    });

    const created = prisma.prescriptionRequest.create.mock.calls[0][0].data;
    expect(JSON.parse(created.requestedDrugs)).toHaveLength(1);
    expect(created.requestedDurationDays).toBe(30);
  });

  test('a cancelled prescription cannot be renewed', async () => {
    prisma.prescription.findFirst.mockResolvedValue({
      id: 9,
      drugs: RX_DRUGS,
      doctorId: 11,
      status: 'cancelled',
      createdAt: new Date(),
    });
    await expect(
      svc.createRenewalRequest({
        patientId: 3,
        tenantId: 1,
        body: { prescriptionId: 9 },
      }),
    ).rejects.toMatchObject({ code: 'PRESCRIPTION_CANCELLED', status: 409 });
  });

  test('a second open request on the same Rx is a 409, not a duplicate row', async () => {
    prisma.prescription.findFirst.mockResolvedValue({
      id: 9,
      drugs: RX_DRUGS,
      doctorId: 11,
      status: 'issued',
      createdAt: new Date(),
    });
    prisma.prescriptionRequest.findFirst.mockResolvedValue({ id: 20 });

    await expect(
      svc.createRenewalRequest({
        patientId: 3,
        tenantId: 1,
        body: { prescriptionId: 9 },
      }),
    ).rejects.toMatchObject({ code: 'REQUEST_ALREADY_OPEN', status: 409 });
    expect(prisma.prescriptionRequest.create).not.toHaveBeenCalled();
  });

  test('notifies the tenant admins AND the prescribing doctor, deep-linked', async () => {
    prisma.prescription.findFirst.mockResolvedValue({
      id: 9,
      drugs: RX_DRUGS,
      doctorId: 11,
      status: 'issued',
      createdAt: new Date(),
    });
    prisma.prescriptionRequest.findFirst.mockResolvedValue(null);
    prisma.prescriptionRequest.create.mockImplementation(async ({ data }) => ({
      id: 23,
      ...data,
      patient: { id: 3, name: 'Asha Menon' },
    }));
    prisma.user.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);

    await svc.createRenewalRequest({
      patientId: 3,
      tenantId: 1,
      body: { prescriptionId: 9 },
    });

    const notifiedUserIds = prisma.notification.create.mock.calls.map(
      (c) => c[0].data.userId,
    );
    expect(notifiedUserIds.sort((a, b) => a - b)).toEqual([1, 2, 11]);
    const first = prisma.notification.create.mock.calls[0][0].data;
    expect(first.link).toBe('/wellness/prescription-requests?request=23');
    expect(first.entityType).toBe('prescription-request');
    expect(first.entityId).toBe(23);
    // The patient gets a receipt in their own inbox too.
    expect(prisma.patientNotification.create).toHaveBeenCalled();
  });

  test('a notification failure never loses the request', async () => {
    prisma.prescription.findFirst.mockResolvedValue({
      id: 9,
      drugs: RX_DRUGS,
      doctorId: null,
      status: 'issued',
      createdAt: new Date(),
    });
    prisma.prescriptionRequest.findFirst.mockResolvedValue(null);
    prisma.prescriptionRequest.create.mockImplementation(async ({ data }) => ({
      id: 24,
      ...data,
      patient: { id: 3, name: 'Asha Menon' },
    }));
    prisma.user.findMany.mockRejectedValue(new Error('db is having a moment'));

    const out = await svc.createRenewalRequest({
      patientId: 3,
      tenantId: 1,
      body: { prescriptionId: 9 },
    });
    expect(out.id).toBe(24);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// transitionRequest
// ─────────────────────────────────────────────────────────────────────────

describe('transitionRequest', () => {
  const pending = {
    id: 30,
    status: 'PENDING',
    patientId: 3,
    tenantId: 1,
    requestedDrugs: null,
    requestedDurationDays: null,
  };

  test('rejects an unknown target status', async () => {
    prisma.prescriptionRequest.findFirst.mockResolvedValue(pending);
    await expect(
      svc.transitionRequest({ tenantId: 1, id: 30, toStatus: 'MAYBE', user: { userId: 7 } }),
    ).rejects.toMatchObject({ code: 'INVALID_STATUS', status: 400 });
  });

  test('404s a request from another tenant', async () => {
    prisma.prescriptionRequest.findFirst.mockResolvedValue(null);
    await expect(
      svc.transitionRequest({ tenantId: 2, id: 30, toStatus: 'ACCEPTED', user: { userId: 7 } }),
    ).rejects.toMatchObject({ code: 'REQUEST_NOT_FOUND', status: 404 });
  });

  test('a rejection without a reason is refused', async () => {
    prisma.prescriptionRequest.findFirst.mockResolvedValue(pending);
    await expect(
      svc.transitionRequest({ tenantId: 1, id: 30, toStatus: 'REJECTED', user: { userId: 7 } }),
    ).rejects.toMatchObject({ code: 'REJECTION_REASON_REQUIRED', status: 400 });
    expect(prisma.prescriptionRequest.updateMany).not.toHaveBeenCalled();
  });

  test('a closed request cannot be reopened', async () => {
    prisma.prescriptionRequest.findFirst.mockResolvedValue({
      ...pending,
      status: 'COMPLETED',
    });
    await expect(
      svc.transitionRequest({ tenantId: 1, id: 30, toStatus: 'ACCEPTED', user: { userId: 7 } }),
    ).rejects.toMatchObject({ code: 'REQUEST_CLOSED', status: 409 });
  });

  test('re-applying the current status is a no-op 409, not a duplicate event', async () => {
    prisma.prescriptionRequest.findFirst.mockResolvedValue(pending);
    await expect(
      svc.transitionRequest({ tenantId: 1, id: 30, toStatus: 'PENDING', user: { userId: 7 } }),
    ).rejects.toMatchObject({ code: 'STATUS_UNCHANGED', status: 409 });
    expect(prisma.prescriptionRequestEvent.create).not.toHaveBeenCalled();
  });

  test('accepting writes the review fields, a history row, and notifies the patient', async () => {
    prisma.prescriptionRequest.findFirst
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce({ ...pending, status: 'ACCEPTED' });
    prisma.prescriptionRequest.updateMany.mockResolvedValue({ count: 1 });
    prisma.prescriptionRequestEvent.create.mockResolvedValue({ id: 1 });

    await svc.transitionRequest({
      tenantId: 1,
      id: 30,
      toStatus: 'ACCEPTED',
      note: 'Repeat for 30 days',
      user: { userId: 7 },
    });

    const update = prisma.prescriptionRequest.updateMany.mock.calls[0][0];
    // Compare-and-set: the WHERE pins the status we validated against.
    expect(update.where).toMatchObject({ id: 30, tenantId: 1, status: 'PENDING' });
    expect(update.data).toMatchObject({ status: 'ACCEPTED', reviewedById: 7 });
    expect(prisma.prescriptionRequestEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'ACCEPTED',
          fromStatus: 'PENDING',
          toStatus: 'ACCEPTED',
          actorUserId: 7,
          actorType: 'user',
        }),
      }),
    );
    expect(prisma.patientNotification.create).toHaveBeenCalled();
  });

  test('a lost race surfaces as 409 instead of silently overwriting a decision', async () => {
    prisma.prescriptionRequest.findFirst.mockResolvedValue(pending);
    // Another reviewer moved the row between our read and our write.
    prisma.prescriptionRequest.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      svc.transitionRequest({ tenantId: 1, id: 30, toStatus: 'ACCEPTED', user: { userId: 7 } }),
    ).rejects.toMatchObject({ code: 'CONCURRENT_UPDATE', status: 409 });
    expect(prisma.prescriptionRequestEvent.create).not.toHaveBeenCalled();
  });

  test('a fulfilling prescription must belong to the same patient and tenant', async () => {
    prisma.prescriptionRequest.findFirst.mockResolvedValue(pending);
    prisma.prescription.findFirst.mockResolvedValue(null);

    await expect(
      svc.transitionRequest({
        tenantId: 1,
        id: 30,
        toStatus: 'COMPLETED',
        fulfilledPrescriptionId: 77,
        user: { userId: 7 },
      }),
    ).rejects.toMatchObject({
      code: 'FULFILLING_PRESCRIPTION_NOT_FOUND',
      status: 404,
    });
    expect(prisma.prescription.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 77, tenantId: 1, patientId: 3 } }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// listRequestsForStaff — filters + tab counts
// ─────────────────────────────────────────────────────────────────────────

describe('listRequestsForStaff', () => {
  beforeEach(() => {
    prisma.prescriptionRequest.findMany.mockResolvedValue([]);
    prisma.prescriptionRequest.count.mockResolvedValue(0);
    prisma.prescriptionRequest.groupBy.mockResolvedValue([]);
  });

  test('always scopes by tenant and defaults to newest-first', async () => {
    await svc.listRequestsForStaff({ tenantId: 42 });
    const args = prisma.prescriptionRequest.findMany.mock.calls[0][0];
    expect(args.where).toMatchObject({ tenantId: 42 });
    expect(args.orderBy).toEqual({ createdAt: 'desc' });
  });

  test('applies status, patient, doctor and free-text filters', async () => {
    await svc.listRequestsForStaff({
      tenantId: 42,
      status: 'pending',
      patientId: '3',
      doctorId: '11',
      q: 'asha',
    });
    const where = prisma.prescriptionRequest.findMany.mock.calls[0][0].where;
    expect(where.status).toBe('PENDING');
    expect(where.patientId).toBe(3);
    expect(where.doctorId).toBe(11);
    expect(where.patient.is.OR).toHaveLength(3);
  });

  test('tab counts ignore the status filter so the other tabs keep their badges', async () => {
    prisma.prescriptionRequest.groupBy.mockResolvedValue([
      { status: 'PENDING', _count: { _all: 4 } },
      { status: 'COMPLETED', _count: { _all: 2 } },
    ]);
    const out = await svc.listRequestsForStaff({ tenantId: 42, status: 'PENDING' });
    expect(prisma.prescriptionRequest.groupBy.mock.calls[0][0].where.status).toBeUndefined();
    expect(out.counts).toEqual({
      PENDING: 4,
      ACCEPTED: 0,
      REJECTED: 0,
      COMPLETED: 2,
    });
  });

  test('caps the page size so a hostile ?limit cannot pull the table', async () => {
    await svc.listRequestsForStaff({ tenantId: 42, limit: 100000 });
    expect(prisma.prescriptionRequest.findMany.mock.calls[0][0].take).toBe(200);
  });
});
