// @ts-check
/**
 * Tests for backend/lib/selfBookingPatient.js.
 *
 * This module replaced three byte-similar copies in routes/wellness.js that
 * each synced `name` and `email` onto a self-booking Patient and none of which
 * synced `phone`. The consequence was concrete: a customer who signed
 * themselves up showed a blank phone in the Patients list, had nowhere to
 * receive reminders, and could never be called from Appointments.
 *
 * So the load-bearing assertion in this file is simply: PHONE IS SYNCED —
 * on create, on drift, and when cleared. The rest pins the no-op behaviour
 * that stops every booking request writing to the database.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import prisma from '../../lib/prisma.js';

const requireCJS = createRequire(import.meta.url);
const {
  resolveSelfBookingPatient,
  syncPatientFromUser,
  desiredIdentityFromUser,
  identityDrift,
} = requireCJS('../../lib/selfBookingPatient');

const USER = {
  name: 'Mohit das',
  email: 'mohit@example.test',
  phone: '+916200039874',
};

beforeEach(() => {
  vi.restoreAllMocks();
  prisma.user = prisma.user || {};
  prisma.patient = prisma.patient || {};
  prisma.user.findUnique = vi.fn().mockResolvedValue({ ...USER });
  prisma.patient.findFirst = vi.fn().mockResolvedValue(null);
  prisma.patient.create = vi.fn().mockImplementation(({ data }) => ({ id: 900, ...data }));
  prisma.patient.update = vi.fn().mockImplementation(({ where, data }) => ({ id: where.id, ...data }));
});

describe('desiredIdentityFromUser', () => {
  test('carries the phone through', () => {
    expect(desiredIdentityFromUser(USER)).toEqual({
      name: 'Mohit das',
      email: 'mohit@example.test',
      phone: '+916200039874',
    });
  });

  test('falls back to email then a placeholder for an unnamed account', () => {
    expect(desiredIdentityFromUser({ email: 'x@y.z' }).name).toBe('x@y.z');
    expect(desiredIdentityFromUser({}).name).toBe('Patient');
    expect(desiredIdentityFromUser(null).name).toBe('Patient');
  });

  test('a missing phone is null, not undefined — it must be writable as a clear', () => {
    expect(desiredIdentityFromUser({ name: 'A' }).phone).toBeNull();
  });
});

describe('identityDrift', () => {
  test('detects a phone change and keeps the normalized key in step', () => {
    const drift = identityDrift(
      { name: 'Mohit das', email: 'mohit@example.test', phone: null },
      desiredIdentityFromUser(USER),
    );
    expect(drift.phone).toBe('+916200039874');
    expect(drift.normalizedPhone).toBe('916200039874');
    expect(drift).not.toHaveProperty('name');
  });

  test('clearing the phone nulls the normalized key too', () => {
    const drift = identityDrift(
      { name: 'A', email: null, phone: '+916200039874' },
      { name: 'A', email: null, phone: null },
    );
    expect(drift.phone).toBeNull();
    expect(drift.normalizedPhone).toBeNull();
  });

  test('an unchanged identity produces an empty patch', () => {
    const patient = { name: 'Mohit das', email: 'mohit@example.test', phone: '+916200039874' };
    expect(identityDrift(patient, desiredIdentityFromUser(USER))).toEqual({});
  });

  test('treats an absent patient phone as null rather than a change to undefined', () => {
    const drift = identityDrift(
      { name: 'A', email: null },
      { name: 'A', email: null, phone: null },
    );
    expect(drift).toEqual({});
  });
});

describe('resolveSelfBookingPatient', () => {
  test('creates the patient WITH the phone from the account', async () => {
    const patient = await resolveSelfBookingPatient({ userId: 251, tenantId: 1 });

    expect(prisma.patient.create).toHaveBeenCalledOnce();
    const { data } = prisma.patient.create.mock.calls[0][0];
    expect(data.phone).toBe('+916200039874');
    expect(data.normalizedPhone).toBe('916200039874');
    expect(data.name).toBe('Mohit das');
    expect(data.source).toBe('self-booking');
    expect(patient.id).toBe(900);
  });

  test('creates without a phone when the account has none', async () => {
    prisma.user.findUnique = vi.fn().mockResolvedValue({ name: 'A', email: 'a@b.c', phone: null });
    await resolveSelfBookingPatient({ userId: 251, tenantId: 1 });

    const { data } = prisma.patient.create.mock.calls[0][0];
    expect(data.phone).toBeNull();
    expect(data.normalizedPhone).toBeNull();
  });

  test('fills the phone on an existing patient that never had one', async () => {
    prisma.patient.findFirst = vi.fn().mockResolvedValue({
      id: 2965,
      name: 'Mohit das',
      email: 'mohit@example.test',
      phone: null,
    });

    await resolveSelfBookingPatient({ userId: 251, tenantId: 1 });

    expect(prisma.patient.create).not.toHaveBeenCalled();
    const { where, data } = prisma.patient.update.mock.calls[0][0];
    expect(where.id).toBe(2965);
    expect(data.phone).toBe('+916200039874');
  });

  test('does not write when nothing drifted', async () => {
    prisma.patient.findFirst = vi.fn().mockResolvedValue({
      id: 2965,
      name: 'Mohit das',
      email: 'mohit@example.test',
      phone: '+916200039874',
    });

    const patient = await resolveSelfBookingPatient({ userId: 251, tenantId: 1 });

    expect(prisma.patient.update).not.toHaveBeenCalled();
    expect(prisma.patient.create).not.toHaveBeenCalled();
    expect(patient.id).toBe(2965);
  });

  test('scopes the lookup to the tenant', async () => {
    await resolveSelfBookingPatient({ userId: 251, tenantId: 7 });
    expect(prisma.patient.findFirst).toHaveBeenCalledWith({
      where: { tenantId: 7, userId: 251 },
    });
  });

  test('a shared phone number is written without objection', async () => {
    // (tenantId, normalizedPhone) is a plain index, not a unique constraint —
    // a couple or a parent-and-child may share one number.
    prisma.patient.findFirst = vi.fn().mockResolvedValue({
      id: 3000,
      name: 'Mohit das',
      email: null,
      phone: null,
    });
    await expect(resolveSelfBookingPatient({ userId: 251, tenantId: 1 })).resolves.toBeTruthy();
    expect(prisma.patient.update.mock.calls[0][0].data.normalizedPhone).toBe('916200039874');
  });
});

describe('syncPatientFromUser', () => {
  test('pushes a profile phone onto the linked patient', async () => {
    prisma.patient.findFirst = vi.fn().mockResolvedValue({
      id: 2965,
      name: 'Mohit das',
      email: 'mohit@example.test',
      phone: null,
    });

    await syncPatientFromUser({ userId: 251, tenantId: 1 });

    expect(prisma.patient.update.mock.calls[0][0].data.phone).toBe('+916200039874');
  });

  test('is a no-op for a user with no linked patient (staff, or never booked)', async () => {
    prisma.patient.findFirst = vi.fn().mockResolvedValue(null);

    await expect(syncPatientFromUser({ userId: 9, tenantId: 1 })).resolves.toBeNull();
    expect(prisma.patient.update).not.toHaveBeenCalled();
    expect(prisma.patient.create).not.toHaveBeenCalled();
  });
});
