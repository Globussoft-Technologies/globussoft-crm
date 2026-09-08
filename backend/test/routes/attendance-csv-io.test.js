// @ts-check
/**
 * Unit tests for the Attendance dashboard's CSV / XLSX import + export
 * surfaces in backend/routes/attendance.js:
 *
 *   GET  /api/attendance/import-meta
 *   GET  /api/attendance/import-template
 *   GET  /api/attendance/export
 *   POST /api/attendance/import
 *
 * What this file pins
 * ───────────────────
 *   ROUTING / RBAC:
 *     1. The four literal paths resolve to their own handlers and never
 *        fall through to the PUT/DELETE /:id family below them.
 *     2. Export is ADMIN | MANAGER; import + template + meta are ADMIN-only
 *        (an import can overwrite an existing row, so it is gated exactly
 *        like PUT /:id). A MANAGER token gets 403 on import.
 *
 *   EXPORT:
 *     3. RFC4180 CSV with the UTF-8 BOM + attachment disposition, header row
 *        matching the import contract, so an export is a valid re-upload.
 *     4. The ?from/?to/?userId filters land on the prisma where clause and
 *        the tenantId comes from the JWT, never the query string.
 *     5. Derived cells (checkInType / checkOutType / recordedVia / absent)
 *        mirror the on-screen table labels.
 *     6. An inverted range is refused by the shared validateDateRange guard.
 *
 *   IMPORT:
 *     7. Missing required columns → 400 MISSING_FIELDS; empty file → 400
 *        EMPTY_CSV; no body at all → 400 NO_CSV.
 *     8. A new (employee, date) inserts; an existing one updates. The
 *        natural key is the @@unique([tenantId, userId, date]) tuple.
 *     9. ONLY columns present in the uploaded header are written — a file
 *        without a `checkIn` column leaves the existing timestamp alone.
 *    10. Unknown employee / bad date / bad status / checkOut-before-checkIn
 *        become per-row errors (envelope carries BOTH the toolbar's
 *        {row, column, value, message} keys and the legacy
 *        {rowNumber, reason} pair) without failing the whole upload.
 *    11. totalMinutes is recomputed from the POST-MERGE timestamps.
 *    12. The template's commented sample row is skipped, not errored.
 *
 * Test pattern mirrors backend/test/routes/attendance-summary.test.js —
 * prisma singleton monkey-patch + supertest with the real auth middleware.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';

// Prisma singleton patching. Must happen BEFORE the router is required.
prisma.attendance = {
  findMany: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.leaveRequest = { findMany: vi.fn() };
prisma.user = prisma.user || {};
prisma.user.findMany = vi.fn();
prisma.user.findFirst = vi.fn();
prisma.biometricDevice = prisma.biometricDevice || {};
prisma.biometricDevice.findMany = vi.fn();
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);
// writeAudit (lib/audit.js) runs for real against the stubbed singleton.
prisma.auditLog = prisma.auditLog || {};
prisma.auditLog.create = vi.fn().mockResolvedValue({});
prisma.auditLog.findFirst = vi.fn().mockResolvedValue(null);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// The punctuality classifiers read the shift policy at module-require time.
delete process.env.ATTENDANCE_SHIFT_START_HOUR;
delete process.env.ATTENDANCE_SHIFT_START_MINUTE;
delete process.env.ATTENDANCE_SHIFT_END_HOUR;
delete process.env.ATTENDANCE_ON_TIME_TOLERANCE_MIN;

const attendanceRouter = requireCJS('../../routes/attendance');

// Keep in sync with backend/middleware/auth.js fallback.
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';

function tokenFor({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/attendance', attendanceRouter);
  return app;
}

function authedGet(url, who = {}) {
  return request(makeApp()).get(url).set('Authorization', `Bearer ${tokenFor(who)}`);
}

// Upload a CSV string as a real multipart file, the way the toolbar does.
function uploadCsv(csv, who = {}, filename = 'attendance.csv') {
  return request(makeApp())
    .post('/api/attendance/import')
    .set('Authorization', `Bearer ${tokenFor(who)}`)
    .attach('file', Buffer.from(csv, 'utf8'), filename);
}

// One tenant-1 Attendance row with its user relation, as /export includes it.
function makeRow({
  id = 1,
  userId = 100,
  name = 'Nurse Joy',
  email = 'joy@clinic.test',
  dateStr = '2026-01-15',
  clockInAt = '2026-01-15T09:05:00.000Z',
  clockOutAt = '2026-01-15T18:02:00.000Z',
  status = 'PRESENT',
  totalMinutes = 537,
  notes = null,
  clockInLocationId = null,
  clockOutLocationId = null,
} = {}) {
  return {
    id,
    userId,
    tenantId: 1,
    date: new Date(`${dateStr}T00:00:00.000Z`),
    clockInAt: clockInAt ? new Date(clockInAt) : null,
    clockOutAt: clockOutAt ? new Date(clockOutAt) : null,
    clockInLocationId,
    clockOutLocationId,
    totalMinutes,
    status,
    source: 'MANUAL',
    notes,
    biometricDeviceId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    user: { id: userId, name, email },
  };
}

const STAFF = [
  { id: 100, name: 'Nurse Joy', email: 'joy@clinic.test' },
  { id: 101, name: 'Dr Priyambada', email: 'priya@clinic.test' },
];

// Parse an exported CSV body back into { headers, rows } for assertions.
function parseCsvBody(body) {
  const text = body.charCodeAt(0) === 0xfeff ? body.slice(1) : body;
  const lines = text.split('\r\n').filter((l) => l !== '');
  const split = (line) => {
    const cells = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const c = line[i];
      if (inQuotes) {
        if (c === '"' && line[i + 1] === '"') { field += '"'; i += 1; continue; }
        if (c === '"') { inQuotes = false; continue; }
        field += c;
        continue;
      }
      if (c === '"' && field === '') { inQuotes = true; continue; }
      if (c === ',') { cells.push(field); field = ''; continue; }
      field += c;
    }
    cells.push(field);
    return cells;
  };
  const headers = split(lines[0]);
  const rows = lines.slice(1).map((l) => {
    const cells = split(l);
    return Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? '']));
  });
  return { headers, rows };
}

beforeEach(() => {
  prisma.attendance.findMany.mockReset();
  prisma.attendance.findUnique.mockReset();
  prisma.attendance.create.mockReset();
  prisma.attendance.update.mockReset();
  prisma.user.findMany.mockReset();

  prisma.attendance.findMany.mockResolvedValue([]);
  prisma.attendance.findUnique.mockResolvedValue(null);
  prisma.attendance.create.mockImplementation(({ data }) => Promise.resolve({ id: 999, ...data }));
  prisma.attendance.update.mockImplementation(({ where, data }) => Promise.resolve({ ...where, ...data }));
  prisma.user.findMany.mockResolvedValue(STAFF);
});

// ── /import-meta ───────────────────────────────────────────────────

describe('GET /import-meta', () => {
  test('surfaces the column contract the toolbar validates against', async () => {
    const res = await authedGet('/api/attendance/import-meta');
    expect(res.status).toBe(200);
    expect(res.body.entity).toBe('attendance');
    expect(res.body.headers).toContain('employeeEmail');
    expect(res.body.headers).toContain('date');
    // Only the two identity columns are required; everything else is
    // optional so a partial upload doesn't trip the preview warning.
    expect(res.body.requiredHeaders).toEqual(['employeeEmail', 'date']);
    expect(res.body.optionalHeaders).toContain('checkIn');
    expect(res.body.optionalHeaders).not.toContain('date');
    expect(res.body.readOnlyHeaders).toContain('checkInType');
    expect(res.body.thresholds).toMatchObject({ rows: 5000, bytes: 5 * 1024 * 1024 });
  });

  test('is ADMIN-only', async () => {
    const res = await authedGet('/api/attendance/import-meta', { role: 'MANAGER' });
    expect(res.status).toBe(403);
  });
});

// ── /import-template ───────────────────────────────────────────────

describe('GET /import-template', () => {
  test('returns a BOM-prefixed CSV attachment carrying the full header row', async () => {
    const res = await authedGet('/api/attendance/import-template');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toContain('attendance-template.csv');
    expect(res.text.charCodeAt(0)).toBe(0xfeff);
    const { headers } = parseCsvBody(res.text);
    expect(headers).toEqual([
      'employeeName', 'employeeEmail', 'date', 'checkIn', 'checkOut',
      'checkInType', 'checkOutType', 'checkInRecordedVia', 'checkOutRecordedVia',
      'status', 'absent', 'totalMinutes', 'notes',
    ]);
  });

  test('format=xlsx returns a spreadsheet attachment', async () => {
    const res = await authedGet('/api/attendance/import-template?format=xlsx');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml.sheet');
    expect(res.headers['content-disposition']).toContain('attendance-template.xlsx');
  });
});

// ── /export ────────────────────────────────────────────────────────

describe('GET /export', () => {
  test('serialises rows with the on-screen labels and the import header order', async () => {
    prisma.attendance.findMany.mockResolvedValue([
      makeRow({}),
      makeRow({
        id: 2,
        userId: 101,
        name: 'Dr Priyambada',
        email: 'priya@clinic.test',
        clockInAt: '2026-01-15T08:00:00.000Z',   // > 15 min before 09:00 → Early
        clockOutAt: '2026-01-15T15:00:00.000Z',  // > 15 min before 18:00 → Early
        status: 'ABSENT',
        totalMinutes: null,
        notes: 'Called in, marked absent',
        clockInLocationId: 4,                     // has a location → biometric
      }),
    ]);

    const res = await authedGet('/api/attendance/export?from=2026-01-01&to=2026-01-31');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attendance-export-\d{4}-\d{2}-\d{2}\.csv/);

    const { headers, rows } = parseCsvBody(res.text);
    expect(headers[0]).toBe('employeeName');
    expect(rows).toHaveLength(2);

    expect(rows[0]).toMatchObject({
      employeeName: 'Nurse Joy',
      employeeEmail: 'joy@clinic.test',
      date: '2026-01-15',
      checkIn: '2026-01-15T09:05:00.000Z',
      checkInType: 'On Time',       // 09:05 is within ±15 min of 09:00
      checkOutType: 'On Time',      // 18:02 is within ±15 min of 18:00
      checkInRecordedVia: 'manual',
      status: 'PRESENT',
      absent: 'No',
      totalMinutes: '537',
    });

    expect(rows[1]).toMatchObject({
      employeeEmail: 'priya@clinic.test',
      checkInType: 'Early',
      checkOutType: 'Early',
      checkInRecordedVia: 'biometric',
      checkOutRecordedVia: 'manual',
      status: 'ABSENT',
      absent: 'Yes',
      totalMinutes: '',
      notes: 'Called in, marked absent',
    });
  });

  test('scopes to the JWT tenant and honours from/to/userId filters', async () => {
    await authedGet('/api/attendance/export?from=2026-01-01&to=2026-01-31&userId=101', { tenantId: 42 });
    const { where, take } = prisma.attendance.findMany.mock.calls[0][0];
    expect(where.tenantId).toBe(42);
    expect(where.userId).toBe(101);
    expect(where.date.gte).toEqual(new Date('2026-01-01'));
    expect(where.date.lte).toEqual(new Date('2026-01-31'));
    // Export is not capped at /list's 500-row display limit.
    expect(take).toBe(10000);
  });

  test('a MANAGER can export but cannot import', async () => {
    const exported = await authedGet('/api/attendance/export', { role: 'MANAGER' });
    expect(exported.status).toBe(200);

    const imported = await uploadCsv(
      'employeeEmail,date\njoy@clinic.test,2026-01-15\n',
      { role: 'MANAGER' },
    );
    expect(imported.status).toBe(403);
    expect(prisma.attendance.create).not.toHaveBeenCalled();
  });

  test('rejects an inverted date range through the shared guard', async () => {
    const res = await authedGet('/api/attendance/export?from=2026-01-31&to=2026-01-01');
    expect(res.status).toBe(400);
    expect(prisma.attendance.findMany).not.toHaveBeenCalled();
  });
});

// ── /import ────────────────────────────────────────────────────────

describe('POST /import — envelope + guards', () => {
  test('400 MISSING_FIELDS when an identity column is absent', async () => {
    const res = await uploadCsv('employeeName,checkIn\nNurse Joy,09:00\n');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_FIELDS');
  });

  test('400 EMPTY_CSV for a header-only file', async () => {
    const res = await uploadCsv('employeeEmail,date\n');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('EMPTY_CSV');
  });

  test('400 NO_CSV when nothing is uploaded', async () => {
    const res = await request(makeApp())
      .post('/api/attendance/import')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NO_CSV');
  });
});

describe('POST /import — upsert on (employee, date)', () => {
  test('inserts a new row anchored to 00:00 UTC of the date cell', async () => {
    const res = await uploadCsv(
      'employeeEmail,date,checkIn,checkOut,status,notes\n'
      + 'joy@clinic.test,2026-01-15,09:05,18:02,PRESENT,Opening shift\n',
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ inserted: 1, imported: 1, updated: 0, skipped: 0 });
    expect(res.body.errors).toEqual([]);

    const { data } = prisma.attendance.create.mock.calls[0][0];
    expect(data).toMatchObject({
      tenantId: 1,
      userId: 100,
      status: 'PRESENT',
      source: 'CSV_IMPORT',
      notes: 'Opening shift',
    });
    expect(data.date).toEqual(new Date('2026-01-15T00:00:00.000Z'));
    // HH:mm cells resolve against that day's UTC anchor.
    expect(data.clockInAt).toEqual(new Date('2026-01-15T09:05:00.000Z'));
    expect(data.clockOutAt).toEqual(new Date('2026-01-15T18:02:00.000Z'));
    // 09:05 → 18:02 is 8h57m.
    expect(data.totalMinutes).toBe(537);
  });

  test('updates the matched row instead of creating a duplicate', async () => {
    prisma.attendance.findUnique.mockResolvedValue(makeRow({ id: 55 }));

    const res = await uploadCsv(
      'employeeEmail,date,status\njoy@clinic.test,2026-01-15,LATE\n',
    );

    expect(res.body).toMatchObject({ inserted: 0, updated: 1 });
    expect(prisma.attendance.create).not.toHaveBeenCalled();
    expect(prisma.attendance.update.mock.calls[0][0].where).toEqual({ id: 55 });

    // The lookup used the @@unique([tenantId, userId, date]) tuple.
    expect(prisma.attendance.findUnique.mock.calls[0][0].where).toEqual({
      tenantId_userId_date: {
        tenantId: 1,
        userId: 100,
        date: new Date('2026-01-15T00:00:00.000Z'),
      },
    });
  });

  test('an ISO-8601 export round-trips back onto the same row', async () => {
    prisma.attendance.findUnique.mockResolvedValue(makeRow({ id: 55 }));

    const res = await uploadCsv(
      'employeeName,employeeEmail,date,checkIn,checkOut,checkInType,checkOutType,'
      + 'checkInRecordedVia,checkOutRecordedVia,status,absent,totalMinutes,notes\n'
      + 'Nurse Joy,joy@clinic.test,2026-01-15,2026-01-15T09:05:00.000Z,'
      + '2026-01-15T18:02:00.000Z,On Time,On Time,manual,manual,PRESENT,No,537,\n',
    );

    expect(res.body).toMatchObject({ inserted: 0, updated: 1, skipped: 0 });
    expect(res.body.errors).toEqual([]);
    const { data } = prisma.attendance.update.mock.calls[0][0];
    // Read-only export columns are ignored, not written back.
    expect(data).not.toHaveProperty('checkInType');
    expect(data).not.toHaveProperty('checkInRecordedVia');
    expect(data.clockInAt).toEqual(new Date('2026-01-15T09:05:00.000Z'));
    expect(data.totalMinutes).toBe(537);
  });
});

describe('POST /import — only supplied columns are written', () => {
  test('a file without a checkIn column leaves the existing timestamp alone', async () => {
    prisma.attendance.findUnique.mockResolvedValue(makeRow({ id: 55 }));

    await uploadCsv('employeeEmail,date,status\njoy@clinic.test,2026-01-15,HALF_DAY\n');

    const { data } = prisma.attendance.update.mock.calls[0][0];
    expect(data).not.toHaveProperty('clockInAt');
    expect(data).not.toHaveProperty('clockOutAt');
    expect(data).not.toHaveProperty('notes');
    expect(data.status).toBe('HALF_DAY');
    // totalMinutes still recomputes off the row's untouched timestamps.
    expect(data.totalMinutes).toBe(537);
  });

  test('a supplied-but-empty checkOut clears it and nulls totalMinutes', async () => {
    prisma.attendance.findUnique.mockResolvedValue(makeRow({ id: 55 }));

    await uploadCsv('employeeEmail,date,checkOut\njoy@clinic.test,2026-01-15,\n');

    const { data } = prisma.attendance.update.mock.calls[0][0];
    expect(data.clockOutAt).toBeNull();
    expect(data.totalMinutes).toBeNull();
  });

  test('an explicit Absent flag drives status when the status cell is blank', async () => {
    await uploadCsv('employeeEmail,date,status,absent\njoy@clinic.test,2026-01-15,,Yes\n');
    expect(prisma.attendance.create.mock.calls[0][0].data.status).toBe('ABSENT');
  });

  test('totalMinutes is taken from the sheet when only one timestamp exists', async () => {
    await uploadCsv(
      'employeeEmail,date,checkIn,totalMinutes\njoy@clinic.test,2026-01-15,09:00,240\n',
    );
    expect(prisma.attendance.create.mock.calls[0][0].data.totalMinutes).toBe(240);
  });
});

describe('POST /import — per-row errors', () => {
  test('bad rows are reported without failing the good ones', async () => {
    const res = await uploadCsv(
      'employeeEmail,date,checkIn,checkOut,status\n'
      + 'joy@clinic.test,2026-01-15,09:00,18:00,PRESENT\n'   // ok
      + 'ghost@clinic.test,2026-01-15,09:00,18:00,PRESENT\n' // unknown staff
      + 'joy@clinic.test,not-a-date,09:00,18:00,PRESENT\n'   // bad date
      + 'joy@clinic.test,2026-01-16,09:00,18:00,VACATION\n'  // bad status
      + 'joy@clinic.test,2026-01-17,18:00,09:00,PRESENT\n',  // out before in
    );

    expect(res.status).toBe(200);
    expect(res.body.inserted).toBe(1);
    expect(res.body.skipped).toBe(4);
    expect(res.body.errors).toHaveLength(4);

    const columns = res.body.errors.map((e) => e.column);
    expect(columns).toEqual(['employeeEmail', 'date', 'status', 'checkOut']);
    // Row numbers are 1-based with the header offset.
    expect(res.body.errors.map((e) => e.row)).toEqual([3, 4, 5, 6]);

    // The envelope carries BOTH shapes: the toolbar's error table reads
    // row/column/value/message, older CSV surfaces read rowNumber/reason.
    for (const e of res.body.errors) {
      expect(e.rowNumber).toBe(e.row);
      expect(e.reason).toBe(e.message);
      expect(typeof e.value).toBe('string');
    }
    expect(res.body.errors[2].message).toMatch(/status must be one of/);
    expect(res.body.errors[3].message).toBe('checkOut is before checkIn');
  });

  test('an unparseable time cell is a row error, not a silent null', async () => {
    const res = await uploadCsv(
      'employeeEmail,date,checkIn\njoy@clinic.test,2026-01-15,25:99\n',
    );
    expect(res.body.inserted).toBe(0);
    expect(res.body.errors[0]).toMatchObject({ column: 'checkIn', row: 2 });
    expect(res.body.errors[0].message).toMatch(/ISO-8601/);
  });

  test('flags a duplicate (employee, date) inside one upload', async () => {
    const res = await uploadCsv(
      'employeeEmail,date,status\n'
      + 'joy@clinic.test,2026-01-15,PRESENT\n'
      + 'joy@clinic.test,2026-01-15,LATE\n',
    );
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].message).toMatch(/duplicate/);
    // The later row still lands — it just wins.
    expect(res.body.inserted).toBe(2);
  });

  test("the template's commented sample row is skipped, not errored", async () => {
    const res = await uploadCsv(
      'employeeEmail,date\n'
      + '# required - staff login email,# required - YYYY-MM-DD\n'
      + 'joy@clinic.test,2026-01-15\n',
    );
    expect(res.body).toMatchObject({ inserted: 1, skipped: 1 });
    expect(res.body.errors).toEqual([]);
  });

  test('resolves an employee by name when the email cell is blank', async () => {
    const res = await uploadCsv(
      'employeeName,employeeEmail,date\nDr Priyambada,,2026-01-15\n',
    );
    expect(res.body.inserted).toBe(1);
    expect(prisma.attendance.create.mock.calls[0][0].data.userId).toBe(101);
  });

  test('the staff lookup is one tenant-scoped query for the whole batch', async () => {
    await uploadCsv(
      'employeeEmail,date\n'
      + 'joy@clinic.test,2026-01-15\n'
      + 'priya@clinic.test,2026-01-15\n'
      + 'joy@clinic.test,2026-01-16\n',
      { tenantId: 42 },
    );
    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.user.findMany.mock.calls[0][0].where).toEqual({ tenantId: 42 });
  });
});
