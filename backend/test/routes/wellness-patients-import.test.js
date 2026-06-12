// @ts-check
/**
 * Unit tests for the `customers` CSV entity — S103 firstName + lastName
 * column acceptance through the generic CSV import surface.
 *
 * SCOPE
 * ─────
 * Patient bulk-import in the wellness vertical goes through the entity-driven
 * `POST /api/wellness/csv/:entity/import` route (routes/wellnessCsv.js),
 * delegating the per-row parsing to the `customers` entity definition in
 * backend/lib/csvEntities.js. A dedicated `POST /api/wellness/patients/import`
 * endpoint does NOT exist — the entity-driven route is the canonical surface.
 *
 * What this file pins
 * ───────────────────
 *   1. Headers — `customers.headers` includes `firstName` + `lastName` slots
 *      at positions 1 and 2 (right after `name`); template `sample` populates
 *      both columns so the downloadable template advertises the new shape.
 *   2. parseRow — firstName + lastName accepted, trimmed, null when blank,
 *      rejected with an INVALID_NAME_FIELD-style row error when > 80 chars
 *      or non-string. Legacy 9-column CSVs still parse cleanly (both columns
 *      default to null — backward compat).
 *   3. runImport — full end-to-end orchestrator against mocked Prisma:
 *      legacy CSV (9-col) imports unchanged with firstName/lastName null;
 *      new CSV (11-col) persists both columns; mixed batch with one
 *      oversized firstName isolates the bad row + still imports siblings.
 *
 * Why mocked prisma (not the live MySQL container): keeps the unit-test
 * gate fast + isolated. The e2e-full / api_tests gates exercise the
 * round-trip against real MySQL via the e2e/tests/wellness-*-api.spec.js
 * suites; this file pins the per-row branching + envelope shape in
 * isolation.
 *
 * Pattern: patch the prisma singleton BEFORE requiring the entity / route
 * so the require'd modules bind to the spy'd delegates.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// ── Prisma surface required by routes/wellnessCsv.js's runImport. ──
// customers.parseRow touches patient.findFirst (dedup probe); runImport
// persists via patient.create + writeAudit (auditLog.create).
prisma.patient = prisma.patient || {};
prisma.patient.findFirst = vi.fn();
prisma.patient.create = vi.fn();

// auditLog.create is what writeAudit ultimately calls. Force-replace so
// the real client's delegate doesn't leak across tests.
prisma.auditLog = { create: vi.fn().mockResolvedValue({ id: 1 }) };

import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);

beforeEach(() => {
  prisma.patient.findFirst.mockReset();
  prisma.patient.create.mockReset();
  prisma.auditLog.create.mockReset();
  prisma.auditLog.create.mockResolvedValue({ id: 1 });

  // Default: no existing patient → no dedup hits. Tests can override.
  prisma.patient.findFirst.mockResolvedValue(null);
  // Default: each create returns a synthetic row whose id increments.
  let nextId = 1000;
  prisma.patient.create.mockImplementation(async ({ data }) => ({
    id: nextId++,
    ...data,
  }));
});

// ────────────────────────────────────────────────────────────────────
// S103 — CSV bulk-import accepts firstName + lastName columns.
//
// The CSV import path lives at POST /api/wellness/csv/customers/import
// (routes/wellnessCsv.js) and delegates the per-row parsing to
// backend/lib/csvEntities.js's `customers` entity. The actual surface
// extended for S103 is the `customers` entity's:
//   - headers     (CSV header acceptance — firstName + lastName slots)
//   - parseRow    (per-row validator + row-mapper to Prisma payload)
//   - serialize   (export cell ordering matches headers)
//   - sample      (downloadable template populates the new columns)
//
// These tests drive `getEntity('customers')` directly + also exercise
// the wellnessCsv.js `runImport` orchestrator end-to-end against
// mocked prisma delegates.
//
// Pins:
//   1. CSV with firstName + lastName columns → both persisted on Patient.
//   2. CSV with only firstName populated → lastName null.
//   3. CSV with neither column (legacy 9-column header) → both null.
//   4. firstName length > 80 → row error reported, other rows still imported.
//   5. Empty-string firstName → null (don't persist blank-string columns).
//   6. CSV with `name` + `firstName` + `lastName` all populated → all
//      three persisted (canonical `name` co-exists with structured split).
//   7. Non-string firstName (object) → row error (per-row isolation).
// ────────────────────────────────────────────────────────────────────

import { getEntity } from '../../lib/csvEntities.js';

const { runImport } = requireCJS('../../routes/wellnessCsv');

describe('S103 customers entity — firstName + lastName header acceptance', () => {
  const customers = getEntity('customers');

  test('headers include firstName + lastName slots (slot 2 + 3 after name)', () => {
    expect(customers.headers).toContain('firstName');
    expect(customers.headers).toContain('lastName');
    // Position after `name` keeps the human-readable template order.
    expect(customers.headers.indexOf('firstName')).toBe(1);
    expect(customers.headers.indexOf('lastName')).toBe(2);
  });

  test('sample template populates firstName + lastName (downloadable template)', () => {
    expect(customers.sample.firstName).toBeTruthy();
    expect(customers.sample.lastName).toBeTruthy();
  });
});

describe('S103 customers.parseRow — firstName + lastName persistence', () => {
  const customers = getEntity('customers');

  test('both columns populated → both persisted on Prisma payload', async () => {
    const { data, errors } = await customers.parseRow({
      name: 'Anita Sharma',
      firstName: 'Anita',
      lastName: 'Sharma',
      phone: '+919876543210',
    });
    expect(errors).toEqual([]);
    expect(data.firstName).toBe('Anita');
    expect(data.lastName).toBe('Sharma');
    // Canonical `name` still set (additive, not replacing).
    expect(data.name).toBe('Anita Sharma');
  });

  test('only firstName populated → lastName null', async () => {
    const { data, errors } = await customers.parseRow({
      name: 'Madonna',
      firstName: 'Madonna',
      phone: '+919876543210',
    });
    expect(errors).toEqual([]);
    expect(data.firstName).toBe('Madonna');
    expect(data.lastName).toBeNull();
  });

  test('only lastName populated → firstName null', async () => {
    const { data, errors } = await customers.parseRow({
      name: 'Khan',
      lastName: 'Khan',
      phone: '+919876543210',
    });
    expect(errors).toEqual([]);
    expect(data.firstName).toBeNull();
    expect(data.lastName).toBe('Khan');
  });

  test('legacy CSV (no firstName / lastName columns) → both null (backward compat)', async () => {
    const { data, errors } = await customers.parseRow({
      name: 'Anita Sharma',
      phone: '+919876543210',
      email: 'anita@example.com',
      gender: 'F',
      dob: '1992-04-18',
    });
    expect(errors).toEqual([]);
    expect(data.firstName).toBeNull();
    expect(data.lastName).toBeNull();
  });

  test('empty-string firstName → null (don\'t persist blank columns)', async () => {
    const { data, errors } = await customers.parseRow({
      name: 'Anita Sharma',
      firstName: '',
      lastName: '   ',
      phone: '+919876543210',
    });
    expect(errors).toEqual([]);
    expect(data.firstName).toBeNull();
    expect(data.lastName).toBeNull();
  });

  test('firstName > 80 chars → row error with INVALID_NAME_FIELD-style column tag', async () => {
    const longName = 'A'.repeat(81);
    const { data, errors } = await customers.parseRow({
      name: 'Anita Sharma',
      firstName: longName,
      phone: '+919876543210',
    });
    expect(data).toBeNull();
    const err = errors.find((e) => e.column === 'firstName');
    expect(err).toBeTruthy();
    expect(err.message).toMatch(/80/);
  });

  test('lastName > 80 chars → row error on the lastName column', async () => {
    const longName = 'B'.repeat(200);
    const { data, errors } = await customers.parseRow({
      name: 'Anita Sharma',
      lastName: longName,
      phone: '+919876543210',
    });
    expect(data).toBeNull();
    const err = errors.find((e) => e.column === 'lastName');
    expect(err).toBeTruthy();
    expect(err.message).toMatch(/80/);
  });

  test('firstName at exactly 80 chars → accepted (boundary)', async () => {
    const exact = 'C'.repeat(80);
    const { data, errors } = await customers.parseRow({
      name: 'Anita Sharma',
      firstName: exact,
      phone: '+919876543210',
    });
    expect(errors).toEqual([]);
    expect(data.firstName).toBe(exact);
  });

  test('non-string firstName (object) → row error', async () => {
    const { data, errors } = await customers.parseRow({
      name: 'Anita Sharma',
      firstName: { hack: 'me' },
      phone: '+919876543210',
    });
    expect(data).toBeNull();
    const err = errors.find((e) => e.column === 'firstName');
    expect(err).toBeTruthy();
    expect(err.message).toMatch(/must be a string/);
  });

  test('firstName surrounded by whitespace → trimmed before persist', async () => {
    const { data, errors } = await customers.parseRow({
      name: 'Anita Sharma',
      firstName: '  Anita  ',
      lastName: '  Sharma  ',
      phone: '+919876543210',
    });
    expect(errors).toEqual([]);
    expect(data.firstName).toBe('Anita');
    expect(data.lastName).toBe('Sharma');
  });
});

describe('S103 runImport — mixed batch with per-row firstName/lastName isolation', () => {
  const customers = getEntity('customers');

  test('legacy 9-col CSV (no firstName/lastName) still imports unchanged', async () => {
    const legacyCsv = [
      'name,phone,email,gender,dob,source,bloodGroup,allergies,notes',
      'Anita Sharma,+919876543210,anita@example.com,F,1992-04-18,walk-in,O+,,',
    ].join('\r\n');
    const result = await runImport(
      customers,
      Buffer.from(legacyCsv, 'utf8'),
      1,
      { lookups: {}, req: { user: { tenantId: 1, userId: 7 } } },
      'csv',
    );
    expect(result.inserted).toBe(1);
    expect(result.errors).toEqual([]);
    // The persisted row should have firstName + lastName null.
    expect(prisma.patient.create).toHaveBeenCalledTimes(1);
    const createArg = prisma.patient.create.mock.calls[0][0];
    expect(createArg.data.firstName).toBeNull();
    expect(createArg.data.lastName).toBeNull();
  });

  test('new 11-col CSV with firstName + lastName → both persisted', async () => {
    const newCsv = [
      'name,firstName,lastName,phone,email,gender,dob,source,bloodGroup,allergies,notes',
      'Anita Sharma,Anita,Sharma,+919876543210,anita@example.com,F,1992-04-18,walk-in,O+,,',
    ].join('\r\n');
    const result = await runImport(
      customers,
      Buffer.from(newCsv, 'utf8'),
      1,
      { lookups: {}, req: { user: { tenantId: 1, userId: 7 } } },
      'csv',
    );
    expect(result.inserted).toBe(1);
    expect(result.errors).toEqual([]);
    const createArg = prisma.patient.create.mock.calls[0][0];
    expect(createArg.data.firstName).toBe('Anita');
    expect(createArg.data.lastName).toBe('Sharma');
    expect(createArg.data.name).toBe('Anita Sharma');
  });

  test('mixed batch: oversized firstName on row 2 → row error, row 1 + 3 still imported', async () => {
    const long = 'X'.repeat(81);
    // Full 11-column header so the required-header check passes; only
    // row 2's firstName is malformed.
    const mixedCsv = [
      'name,firstName,lastName,phone,email,gender,dob,source,bloodGroup,allergies,notes',
      'Anita Sharma,Anita,Sharma,+919876543210,,,,,,,',
      `Bob Verma,${long},Verma,+919876543211,,,,,,,`,
      'Carol Singh,Carol,Singh,+919876543212,,,,,,,',
    ].join('\r\n');
    const result = await runImport(
      customers,
      Buffer.from(mixedCsv, 'utf8'),
      1,
      { lookups: {}, req: { user: { tenantId: 1, userId: 7 } } },
      'csv',
    );
    expect(result.inserted).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    const rowErr = result.errors.find((e) => e.column === 'firstName');
    expect(rowErr).toBeTruthy();
  });
});
