// @ts-check
/**
 * Callified calling is offered on FOUR wellness surfaces — an Appointments
 * row, a Patients row, All Leads and Converted Leads — and all of them go
 * through one set of handlers in routes/wellness_callified.js.
 *
 * That sharing is the point: contact resolution, the redial cooldown, the
 * dial itself, the CallLog row and the audit entry must behave identically no
 * matter which page the operator clicked Call on. The surfaces differ ONLY in
 * how the subject is loaded and how the call is labelled, and that difference
 * is expressed by the subject descriptors pinned here.
 *
 * Also pins route registration, because the failure mode of a refactor that
 * drops one surface is silent — the page just stops being able to call.
 */

import { describe, test, expect } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const router = requireCJS('../../routes/wellness_callified');
const { visitSubject, patientSubject, leadSubject } = router;

const PATIENT = { id: 7, name: 'Asha Menon', phone: '9876543210', contactId: null };
const CONTACT = { id: 31, name: 'Ravi Kumar', phone: '9812345670', email: 'r@t.in' };

describe('call subjects', () => {
  test('an appointment call carries the appointment through to audit + response', () => {
    const s = visitSubject({
      id: 42,
      visitDate: '2026-08-26T10:00:00.000Z',
      patient: PATIENT,
      service: { id: 3, name: 'Body Polishing' },
    });

    expect(s.person).toBe(PATIENT);
    expect(s.surface).toBe('wellness_appointments');
    // `ref` is spread into BOTH the audit payload and the JSON response, so a
    // call placed from Appointments stays traceable to the appointment.
    expect(s.ref).toEqual({ visitId: 42, patientId: 7 });
    expect(s.context).toEqual({
      visitId: 42,
      visitDate: '2026-08-26T10:00:00.000Z',
      serviceName: 'Body Polishing',
    });
  });

  test('the service name becomes the call interest, so Callified shows why we rang', () => {
    const s = visitSubject({ id: 1, patient: PATIENT, service: { name: 'Body Polishing' } });
    expect(s.defaultInterest).toBe('Appointment — Body Polishing');
  });

  test('an appointment with no service still has a usable interest', () => {
    const s = visitSubject({ id: 1, patient: PATIENT, service: null });
    expect(s.defaultInterest).toBe('Wellness appointment call');
    expect(s.context.serviceName).toBeNull();
  });

  test('a patient call carries no appointment fields at all', () => {
    const s = patientSubject(PATIENT);

    expect(s.person).toBe(PATIENT);
    expect(s.surface).toBe('wellness_patients');
    expect(s.ref).toEqual({ patientId: 7 });
    // Nothing appointment-shaped may leak in — there is no appointment.
    expect(s.context).toEqual({});
    expect(s.defaultInterest).toBe('Wellness patient call');
  });

  test('a lead call identifies the lead, not a patient that does not exist', () => {
    const s = leadSubject(CONTACT);

    expect(s.person).toBe(CONTACT);
    expect(s.surface).toBe('wellness_leads');
    expect(s.ref).toEqual({ leadId: 31 });
    expect(s.context).toEqual({ leadId: 31 });
    expect(s.defaultInterest).toBe('Wellness lead call');
    // A lead has no patient record; claiming a patientId would be a lie in
    // the audit trail.
    expect(s.ref.patientId).toBeUndefined();
  });

  test('a lead resolves to ITSELF as the contact — no duplicate contact created', async () => {
    // Every other surface promotes its record into a Contact before dialling.
    // A lead already IS a Contact, so this short-circuit is what stops the
    // calling flow creating a second contact for a record it already had.
    const s = leadSubject(CONTACT);
    expect(typeof s.resolveContact).toBe('function');
    await expect(s.resolveContact(CONTACT, 1)).resolves.toEqual({ id: 31 });
  });

  test('patient-backed surfaces do NOT short-circuit contact resolution', () => {
    // They must fall through to ensurePatientContact, which creates and
    // back-links the Contact. Supplying resolveContact here would skip that.
    expect(visitSubject({ id: 1, patient: PATIENT, service: null }).resolveContact).toBeUndefined();
    expect(patientSubject(PATIENT).resolveContact).toBeUndefined();
  });

  test('every surface is distinguishable in the audit trail', () => {
    const surfaces = [
      visitSubject({ id: 1, patient: PATIENT, service: null }).surface,
      patientSubject(PATIENT).surface,
      leadSubject(CONTACT).surface,
    ];
    // An auditor has to be able to tell which page placed the call.
    expect(new Set(surfaces).size).toBe(surfaces.length);
  });

  test('every subject exposes the fields the shared handlers read', () => {
    // If a surface omits one, the handlers start needing per-surface
    // branching — the exact duplication this design exists to avoid.
    const required = ['person', 'surface', 'defaultInterest', 'ref', 'context'];
    for (const s of [
      visitSubject({ id: 1, patient: PATIENT, service: null }),
      patientSubject(PATIENT),
      leadSubject(CONTACT),
    ]) {
      for (const key of required) {
        expect(s, `${s.surface} is missing ${key}`).toHaveProperty(key);
      }
    }
  });
});

describe('route registration', () => {
  const registered = router.stack
    .filter((l) => l.route)
    .map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);

  test.each([
    'GET /callified/visits/:visitId/context',
    'POST /callified/visits/:visitId/ai-call',
    'POST /callified/visits/:visitId/manual-call',
    'GET /callified/patients/:patientId/context',
    'POST /callified/patients/:patientId/ai-call',
    'POST /callified/patients/:patientId/manual-call',
    'GET /callified/leads/:leadId/context',
    'POST /callified/leads/:leadId/ai-call',
    'POST /callified/leads/:leadId/manual-call',
  ])('%s is mounted', (route) => {
    expect(registered).toContain(route);
  });

  test('every call route sits behind the same gate', () => {
    // callGate = verifyToken + verifyWellnessRole + requirePermission. A route
    // registered without it would be an open calling endpoint.
    const callRoutes = router.stack.filter(
      (l) => l.route && /\/callified\/(visits|patients|leads)\//.test(l.route.path),
    );
    expect(callRoutes).toHaveLength(9);
    const gateSizes = new Set(callRoutes.map((l) => l.route.stack.length));
    expect(gateSizes.size).toBe(1);
  });
});
