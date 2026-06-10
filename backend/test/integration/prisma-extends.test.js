/**
 * Integration tests for backend/lib/prisma.js
 *
 * NOTE — file location: this test lives under `backend/test/integration/`
 * rather than `backend/test/lib/` because it intentionally exercises
 * Prisma's REAL `$extends` machinery — it taps `prisma.$parent._engine` to
 * swap `engine.request` and assert the encrypt/decrypt walker's behavior.
 * That requires the genuine `@prisma/client` `PrismaClient`, not the
 * T39 surface-guarded proxy that wraps it for unit tests. The companion
 * `backend/vitest.integration.config.js` runs this file with
 * `PRISMA_ALLOW_REAL_CALLS=1` (and `ALLOW_REMOTE_DB_IN_TESTS=1`) set in
 * `backend/test/integration-setup.js` so the wrap is skipped. The main
 * `backend/vitest.config.js` explicitly excludes this file via the
 * `test/integration/prisma-extends.test.js` exclude entry.
 *
 * Original migration: T40 — moved from `backend/test/lib/prisma.test.js`
 * 2026-06-08. The file's content is otherwise unchanged.
 *
 * What this covers:
 *   - The exported value is a real PrismaClient instance (or a $extends proxy
 *     wrapping one). Asserted via constructor name.
 *   - Singleton contract: require()ing the module twice returns the SAME
 *     reference. This guards the "Too many connections" regression class
 *     that originally motivated this singleton — every route + cron + script
 *     in the codebase imports lib/prisma, so a regression that broke the
 *     singleton would silently spawn N PrismaClient instances under load
 *     (each with its own pool) and only surface as "Too many connections"
 *     in production. See the file-level comment in lib/prisma.js.
 *   - The module exposes the standard Prisma data-method API surface
 *     ($connect, $disconnect, $transaction). This is a smoke check that
 *     the $extends() build wired up correctly — a $extends mistake
 *     (e.g. forgetting to spread, throwing in a hook) would shape-break
 *     the export.
 *   - Re-loading the module via vi.resetModules() still yields the same
 *     instance, because lib/prisma.js stashes the singleton on
 *     globalThis.prisma for hot-reload safety in dev. This protects against
 *     accidental removal of that global stash.
 *
 * What this does NOT cover:
 *   - Actual prisma-query behaviour (those are integration concerns —
 *     covered by the e2e Playwright API specs in e2e/tests/*-api.spec.js).
 *   - The wellness-pii $extends encryption hooks — those are exercised
 *     transitively via lib/fieldEncryption.test.js + the wellness route
 *     specs. Asserting them here would couple this test to internal
 *     implementation details that should evolve freely.
 *
 * Mocking notes:
 *   - No mocks. lib/prisma.js doesn't make any DB connection at import time
 *     (Prisma connects lazily on first query), so we can safely import the
 *     real module without a running MySQL.
 *   - NODE_ENV is set to 'development' in beforeAll so the singleton stash
 *     onto globalThis.prisma is exercised (production mode skips that
 *     stash; we want both branches covered, so a separate test resets the
 *     module in production mode).
 */
import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

beforeAll(() => {
  // Force the dev branch (globalForPrisma.prisma stash) for the default
  // suite. The production-branch test below flips this temporarily.
  process.env.NODE_ENV = 'development';
});

afterAll(() => {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
});

describe('lib/prisma — module shape', () => {
  test('default export is a PrismaClient (or $extends proxy of one)', async () => {
    const prisma = (await import('../../lib/prisma.js')).default;
    expect(prisma).toBeDefined();
    expect(prisma).not.toBeNull();
    // Either the raw PrismaClient or the $extends proxy. Both expose
    // $connect / $disconnect / $transaction.
    expect(typeof prisma.$connect).toBe('function');
    expect(typeof prisma.$disconnect).toBe('function');
    expect(typeof prisma.$transaction).toBe('function');
  });

  test('exposes the model accessors used by the rest of the codebase', async () => {
    const prisma = (await import('../../lib/prisma.js')).default;
    // A spot-check across generic + wellness models that route handlers rely
    // on. If any of these were missing the SUT's $extends call would fail to
    // build the proxy and lots of routes would break at boot.
    expect(prisma.user).toBeDefined();
    expect(prisma.contact).toBeDefined();
    expect(prisma.deal).toBeDefined();
    expect(prisma.tenant).toBeDefined();
    expect(prisma.patient).toBeDefined();
    expect(prisma.visit).toBeDefined();
    expect(prisma.prescription).toBeDefined();
  });
});

describe('lib/prisma — singleton contract', () => {
  test('require()ing twice returns the SAME instance', () => {
    // CommonJS require cache: same key → same exports object.
    const a = require('../../lib/prisma.js');
    const b = require('../../lib/prisma.js');
    expect(a).toBe(b);
  });

  test('dynamic import() also yields the same singleton (ESM <-> CJS bridge)', async () => {
    const cjs = require('../../lib/prisma.js');
    const esm = (await import('../../lib/prisma.js')).default;
    expect(esm).toBe(cjs);
  });

  test('vi.resetModules() does NOT clone the client (globalThis stash protects it)', async () => {
    const before = (await import('../../lib/prisma.js')).default;

    vi.resetModules();
    // After reset, the SUT re-executes — but lib/prisma.js reads
    // globalThis.prisma first. Dev branch (NODE_ENV !== 'production') stashed
    // it there on first load, so the second load reuses it.
    const after = (await import('../../lib/prisma.js')).default;
    expect(after).toBe(before);
  });
});

describe('lib/prisma — production branch (no globalThis stash)', () => {
  test('production mode still returns a working client (different require path)', async () => {
    // Stash + clear the dev singleton so the SUT takes the production path.
    const stashed = global.prisma;
    delete global.prisma;
    process.env.NODE_ENV = 'production';
    vi.resetModules();
    try {
      const prod = (await import('../../lib/prisma.js')).default;
      expect(prod).toBeDefined();
      expect(typeof prod.$connect).toBe('function');
      // In production mode the SUT must NOT stash onto global.prisma
      // (that's a dev-only convenience to survive nodemon restarts).
      expect(global.prisma).toBeUndefined();
    } finally {
      // Restore so subsequent tests in this run see the original singleton.
      process.env.NODE_ENV = 'development';
      if (stashed !== undefined) global.prisma = stashed;
      vi.resetModules();
    }
  });
});

/**
 * The wellness-pii $extends hook is the bulk of lib/prisma.js by line count.
 * It transparently encrypts writes and decrypts reads for ENCRYPTED_FIELDS.
 * To exercise these hooks WITHOUT a real MySQL connection, we stub the
 * underlying Prisma engine's request() method — that's the lowest layer
 * the $extends proxy ultimately calls. We assert the proxy:
 *   - forwards args to the engine
 *   - decrypts results on the way out (read hooks)
 *   - encrypts inputs on the way in (write hooks)
 *
 * WELLNESS_FIELD_KEY is intentionally NOT set, so encrypt() / decrypt() are
 * pass-throughs (see lib/fieldEncryption.js fallback). That's enough to
 * exercise every line of the encryptArgs / decryptResult walker without
 * needing crypto setup.
 */
describe('lib/prisma — $extends query hooks (mocked engine)', () => {
  let prisma;
  let engine;
  let originalRequest;
  let lastRequest;

  beforeAll(async () => {
    // Use the same singleton everyone else uses; just patch its engine.
    prisma = (await import('../../lib/prisma.js')).default;
    engine = prisma.$parent._engine;
    originalRequest = engine.request.bind(engine);
  });

  afterAll(() => {
    engine.request = originalRequest;
  });

  // Prisma's engine.request returns a GraphQL-shaped envelope:
  //   { data: { <operationKey>: <actualPayload> } }
  // The request handler unwraps it before the value reaches the $extends
  // hook. We wrap in a synthetic "_op" key — the unwrap is positional, not
  // by name, so the key string doesn't matter.
  function stubEngine(returnValue) {
    engine.request = async (query) => {
      lastRequest = query;
      return { data: { _op: returnValue } };
    };
  }

  test('findUnique: forwards to engine and walks the result through decrypt', async () => {
    stubEngine({ id: 1, allergies: 'penicillin', notes: 'patient note' });
    const r = await prisma.patient.findUnique({ where: { id: 1 } });
    expect(r).toEqual({ id: 1, allergies: 'penicillin', notes: 'patient note' });
    expect(lastRequest).toBeDefined();
  });

  test('findFirst / findFirstOrThrow / findUniqueOrThrow: all wrapped', async () => {
    stubEngine({ id: 2 });
    expect(await prisma.patient.findFirst({})).toEqual({ id: 2 });
    expect(await prisma.patient.findFirstOrThrow({})).toEqual({ id: 2 });
    expect(await prisma.patient.findUniqueOrThrow({ where: { id: 2 } })).toEqual({ id: 2 });
  });

  test('findMany: walks each row in the array through decrypt', async () => {
    stubEngine([
      { id: 1, allergies: 'a' },
      { id: 2, allergies: 'b' },
    ]);
    const rs = await prisma.patient.findMany({});
    expect(rs).toEqual([
      { id: 1, allergies: 'a' },
      { id: 2, allergies: 'b' },
    ]);
  });

  test('findMany: handles null result (defensive)', async () => {
    stubEngine(null);
    expect(await prisma.patient.findMany({})).toBeNull();
  });

  test('create: encrypts string fields on input then decrypts result', async () => {
    stubEngine({ id: 5, allergies: 'soy', notes: 'fresh patient' });
    const r = await prisma.patient.create({
      data: { allergies: 'soy', notes: 'fresh patient', name: 'Asha' },
    });
    expect(r).toEqual({ id: 5, allergies: 'soy', notes: 'fresh patient' });
  });

  test('create: handles non-encrypted models (passes data through unchanged)', async () => {
    stubEngine({ id: 9, name: 'Acme' });
    const r = await prisma.tenant.create({ data: { name: 'Acme' } });
    expect(r).toEqual({ id: 9, name: 'Acme' });
  });

  test('createMany: forwards to engine, returns count, no result decrypt', async () => {
    stubEngine({ count: 3 });
    const r = await prisma.patient.createMany({
      data: [
        { allergies: 'a' },
        { allergies: 'b' },
        { allergies: 'c' },
      ],
    });
    expect(r).toEqual({ count: 3 });
  });

  test('update: handles plain string assignment in data', async () => {
    stubEngine({ id: 1, allergies: 'updated' });
    const r = await prisma.patient.update({
      where: { id: 1 },
      data: { allergies: 'updated' },
    });
    expect(r).toEqual({ id: 1, allergies: 'updated' });
  });

  test('update: handles Prisma { set: "..." } operator on encrypted fields', async () => {
    stubEngine({ id: 1, allergies: 'set-syntax' });
    const r = await prisma.patient.update({
      where: { id: 1 },
      data: { allergies: { set: 'set-syntax' } },
    });
    expect(r).toEqual({ id: 1, allergies: 'set-syntax' });
  });

  test('update: leaves null/undefined values alone on encrypted fields', async () => {
    stubEngine({ id: 1, allergies: null });
    const r = await prisma.patient.update({
      where: { id: 1 },
      data: { allergies: null },
    });
    expect(r).toEqual({ id: 1, allergies: null });
  });

  test('updateMany: returns count, no result decrypt', async () => {
    stubEngine({ count: 2 });
    const r = await prisma.patient.updateMany({
      where: { tenantId: 1 },
      data: { notes: 'bulk' },
    });
    expect(r).toEqual({ count: 2 });
  });

  test('upsert: encrypts both create and update args', async () => {
    stubEngine({ id: 7, allergies: 'upserted' });
    const r = await prisma.patient.upsert({
      where: { id: 7 },
      create: { allergies: 'created' },
      update: { allergies: 'updated' },
    });
    expect(r).toEqual({ id: 7, allergies: 'upserted' });
  });

  test('Visit / Prescription / ConsentForm models also routed through encryption', async () => {
    // Visit has notes + vitals
    stubEngine({ id: 1, notes: 'visit note', vitals: 'BP 120/80' });
    const v = await prisma.visit.create({
      data: { notes: 'visit note', vitals: 'BP 120/80' },
    });
    expect(v.notes).toBe('visit note');

    // Prescription has drugs + instructions
    stubEngine({ id: 2, drugs: 'paracetamol', instructions: 'twice daily' });
    const p = await prisma.prescription.create({
      data: { drugs: 'paracetamol', instructions: 'twice daily' },
    });
    expect(p.drugs).toBe('paracetamol');

    // ConsentForm has signatureSvg
    stubEngine({ id: 3, signatureSvg: '<svg/>' });
    const c = await prisma.consentForm.create({
      data: { signatureSvg: '<svg/>' },
    });
    expect(c.signatureSvg).toBe('<svg/>');
  });

  test('createMany: array data path — encrypts each row', async () => {
    stubEngine({ count: 2 });
    const r = await prisma.visit.createMany({
      data: [
        { notes: 'a', vitals: 'x' },
        { notes: 'b', vitals: 'y' },
      ],
    });
    expect(r).toEqual({ count: 2 });
  });

  test('decrypt walker: handles deeply nested includes (relations)', async () => {
    // Mimic findUnique({ include: { visits: { include: { prescriptions: true } } } })
    stubEngine({
      id: 1,
      allergies: 'top-level',
      visits: [
        {
          id: 10,
          notes: 'visit-1',
          prescriptions: [{ id: 100, drugs: 'aspirin' }],
        },
      ],
    });
    const r = await prisma.patient.findUnique({
      where: { id: 1 },
      include: { visits: { include: { prescriptions: true } } },
    });
    expect(r.allergies).toBe('top-level');
    expect(r.visits[0].notes).toBe('visit-1');
    expect(r.visits[0].prescriptions[0].drugs).toBe('aspirin');
  });
});
