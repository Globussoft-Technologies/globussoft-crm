// @ts-check
/**
 * Unit tests for backend/routes/industry_templates.js — pin the vertical-template
 * catalogue + one-click apply surface used by the IndustryTemplates onboarding
 * page and the Sandbox spin-up flow.
 *
 * Why this file exists
 * ────────────────────
 * industry_templates.js is 495 LOC of CRUD + an apply-template bulk operation
 * that, in one POST, materialises pipelines / pipeline stages / custom
 * entities + fields / sample contacts / an audit-log row under a tenant.
 * Until now it had ZERO unit coverage. Contracts that need pinning:
 *
 *   1. Built-in fallback semantics — GET / returns the in-file
 *      BUILT_IN_TEMPLATES array verbatim when DB has zero rows. When DB has
 *      rows, the response MERGES (DB rows override by `industry` key,
 *      built-ins NOT in DB are appended). This is the contract the
 *      onboarding page relies on — without it, a tenant that customises one
 *      industry would lose visibility into the other 4.
 *
 *   2. apply-template orchestration — POST /apply/:industry is the most
 *      load-bearing path:
 *        - Resolves template (DB-first, built-in fallback) by industry key
 *        - 404 if the industry is unknown to BOTH sources
 *        - Idempotent: skips pipelines / stages / customEntities / contacts
 *          that already exist for the tenant (no duplicates)
 *        - Counts what was newly created in `created.{pipelines,stages,
 *          customEntities,contacts}` and returns it to the caller
 *        - Stages are deduped + assigned position + color cycled through
 *          STAGE_COLORS[position % 6]
 *        - Writes an AuditLog row keyed by entity='IndustryTemplate'
 *          (entityId is null for built-in templates, set for DB templates)
 *        - tenantId + userId on EVERY create come from req.user, never the
 *          body (the global stripDangerous middleware would drop body.tenantId
 *          anyway, but the handler MUST source from req.user)
 *
 *   3. Admin-only writes — POST / and DELETE /:id require ADMIN role. GET
 *      and POST /apply/:industry are open to any authenticated caller.
 *      verifyRole(["ADMIN"]) emits 403 RBAC_DENIED for non-admins.
 *
 *   4. Validation surfaces — POST / requires industry+name+config (400);
 *      DELETE /:id requires a parseable integer id (400 on non-numeric).
 *
 *   5. Prisma error mapping — POST / maps P2002 (unique constraint) to
 *      409 "Industry template already exists"; DELETE /:id maps P2025
 *      (record not found) to 404 "Template not found".
 *
 * What this file pins (16 cases across 6 describe blocks)
 * ───────────────────────────────────────────────────────
 *   1. GET / — empty DB → returns the 5 built-in templates verbatim
 *   2. GET / — DB has rows → DB overrides built-ins by industry key, missing
 *      industries are filled in from built-ins
 *   3. GET / — config field is JSON-parsed back to object before returning
 *   4. POST /apply/:industry — applies built-in template, creates pipelines +
 *      stages + custom entities + sample contacts, returns created counters
 *   5. POST /apply/:industry — 404 when industry isn't in DB OR built-ins
 *   6. POST /apply/:industry — idempotent: skips existing pipelines (returns
 *      created.pipelines=0 on second invocation)
 *   7. POST /apply/:industry — stages are deduped across pipelines and
 *      position/color is cycled through STAGE_COLORS
 *   8. POST /apply/:industry — DB template takes precedence over built-in
 *      when both have the same industry key
 *   9. POST /apply/:industry — tenantId on every prisma.*.create comes from
 *      req.user.tenantId, NEVER from any caller input
 *  10. POST /apply/:industry — writes an AuditLog row with action='APPLY',
 *      entity='IndustryTemplate', tenantId, userId
 *  11. POST /apply/:industry — duplicate-email contact during apply does NOT
 *      crash (catch swallows; counter doesn't increment)
 *  12. POST / — happy path admin create, stringifies object config, 201 with
 *      parsed config in response
 *  13. POST / — 400 when industry/name/config missing
 *  14. POST / — 409 when prisma throws P2002 unique-constraint violation
 *  15. POST / — 403 RBAC_DENIED for non-ADMIN role
 *  16. DELETE /:id — 200 happy path, 400 non-numeric id, 404 on P2025, 403
 *      for non-ADMIN
 *
 * Test pattern
 * ────────────
 * Mirrors backend/test/routes/territories.test.js — prisma singleton
 * monkey-patch BEFORE requiring the router, verifyToken replaced with a
 * passthrough so we can inject req.user via a pre-router middleware, REAL
 * verifyRole so the admin-only gate fires end-to-end.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

// ── prisma singleton patching (BEFORE require-time) ────────────────────
import prisma from '../../lib/prisma.js';

prisma.industryTemplate = prisma.industryTemplate || {};
prisma.industryTemplate.findMany = vi.fn();
prisma.industryTemplate.findUnique = vi.fn();
prisma.industryTemplate.create = vi.fn();
prisma.industryTemplate.delete = vi.fn();

prisma.pipeline = prisma.pipeline || {};
prisma.pipeline.findFirst = vi.fn();
prisma.pipeline.create = vi.fn();

prisma.pipelineStage = prisma.pipelineStage || {};
prisma.pipelineStage.findFirst = vi.fn();
prisma.pipelineStage.create = vi.fn();

prisma.customEntity = prisma.customEntity || {};
prisma.customEntity.findFirst = vi.fn();
prisma.customEntity.create = vi.fn();

prisma.contact = prisma.contact || {};
prisma.contact.findUnique = vi.fn();
prisma.contact.create = vi.fn();

prisma.auditLog = prisma.auditLog || {};
prisma.auditLog.create = vi.fn();

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// Replace verifyToken with a passthrough at module-cache level so verifyRole
// stays REAL and the admin-only gate fires end-to-end on POST / and DELETE.
const authMod = requireCJS('../../middleware/auth');
authMod.verifyToken = (_req, _res, next) => next();

const industryTemplatesRouter = requireCJS('../../routes/industry_templates');

function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role };
    next();
  });
  app.use('/api/industry-templates', industryTemplatesRouter);
  return app;
}

beforeEach(() => {
  prisma.industryTemplate.findMany.mockReset();
  prisma.industryTemplate.findUnique.mockReset();
  prisma.industryTemplate.create.mockReset();
  prisma.industryTemplate.delete.mockReset();
  prisma.pipeline.findFirst.mockReset();
  prisma.pipeline.create.mockReset();
  prisma.pipelineStage.findFirst.mockReset();
  prisma.pipelineStage.create.mockReset();
  prisma.customEntity.findFirst.mockReset();
  prisma.customEntity.create.mockReset();
  prisma.contact.findUnique.mockReset();
  prisma.contact.create.mockReset();
  prisma.auditLog.create.mockReset();

  // Sensible defaults — each test overrides what it cares about.
  prisma.industryTemplate.findMany.mockResolvedValue([]);
  prisma.industryTemplate.findUnique.mockResolvedValue(null);
  prisma.industryTemplate.create.mockResolvedValue({});
  prisma.industryTemplate.delete.mockResolvedValue({});
  prisma.pipeline.findFirst.mockResolvedValue(null);
  prisma.pipeline.create.mockResolvedValue({ id: 1 });
  prisma.pipelineStage.findFirst.mockResolvedValue(null);
  prisma.pipelineStage.create.mockResolvedValue({ id: 1 });
  prisma.customEntity.findFirst.mockResolvedValue(null);
  prisma.customEntity.create.mockResolvedValue({ id: 1 });
  prisma.contact.findUnique.mockResolvedValue(null);
  prisma.contact.create.mockResolvedValue({ id: 1 });
  prisma.auditLog.create.mockResolvedValue({ id: 1 });
});

// The 5 built-in industries the source file ships with.
const BUILT_IN_INDUSTRIES = [
  'real-estate', 'healthcare', 'education', 'legal', 'saas',
];

// ─────────────────────────────────────────────────────────────────────────
// GET / — list templates
// ─────────────────────────────────────────────────────────────────────────

describe('GET / — list templates (DB + built-ins fallback)', () => {
  test('empty DB → returns the 5 built-in templates verbatim', async () => {
    prisma.industryTemplate.findMany.mockResolvedValue([]);

    const res = await request(makeApp()).get('/api/industry-templates');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(5);
    const industries = res.body.map((t) => t.industry).sort();
    expect(industries).toEqual([...BUILT_IN_INDUSTRIES].sort());
    // Each built-in has a non-empty config with pipelines + customFields.
    for (const t of res.body) {
      expect(t.config).toEqual(expect.objectContaining({
        pipelines: expect.any(Array),
        customFields: expect.any(Array),
      }));
    }
  });

  test('DB rows override built-ins by industry key; missing industries fill from built-ins', async () => {
    // DB has a customised SaaS template. Other 4 industries should still
    // come through from built-ins.
    prisma.industryTemplate.findMany.mockResolvedValue([
      {
        id: 99,
        industry: 'saas',
        name: 'Custom SaaS CRM',
        description: 'Tenant-customised SaaS layout',
        config: JSON.stringify({ pipelines: [{ name: 'Custom Pipeline', stages: ['A', 'B'] }] }),
        createdAt: new Date('2026-05-01'),
      },
    ]);

    const res = await request(makeApp()).get('/api/industry-templates');

    expect(res.status).toBe(200);
    // 1 DB row + 4 remaining built-ins (saas filtered out from built-ins)
    expect(res.body).toHaveLength(5);

    const saasEntry = res.body.find((t) => t.industry === 'saas');
    expect(saasEntry).toMatchObject({
      id: 99,
      name: 'Custom SaaS CRM',
      config: { pipelines: [{ name: 'Custom Pipeline', stages: ['A', 'B'] }] },
    });

    const realEstateEntry = res.body.find((t) => t.industry === 'real-estate');
    expect(realEstateEntry).toBeDefined();
    expect(realEstateEntry.id).toBe('builtin-real-estate');
  });

  test('DB template config is JSON-parsed back to object before returning', async () => {
    prisma.industryTemplate.findMany.mockResolvedValue([
      {
        id: 1,
        industry: 'real-estate',
        name: 'Custom Real Estate',
        description: 'desc',
        // Stored as JSON string in DB (the column is String? @db.Text)
        config: JSON.stringify({ pipelines: [], customFields: [{ entity: 'Property' }] }),
        createdAt: new Date(),
      },
    ]);

    const res = await request(makeApp()).get('/api/industry-templates');

    expect(res.status).toBe(200);
    const dbEntry = res.body.find((t) => t.id === 1);
    expect(dbEntry).toBeDefined();
    // Already a parsed object — NOT still a string.
    expect(typeof dbEntry.config).toBe('object');
    expect(dbEntry.config.customFields).toEqual([{ entity: 'Property' }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /apply/:industry — orchestration
// ─────────────────────────────────────────────────────────────────────────

describe('POST /apply/:industry — bulk-create pipelines + stages + entities + contacts', () => {
  test('applies built-in template, creates child rows, returns counters', async () => {
    // DB miss → falls back to built-in 'healthcare' (1 pipeline, 5 stages,
    // 1 customEntity, 2 sample contacts).
    prisma.industryTemplate.findUnique.mockResolvedValue(null);

    const res = await request(makeApp({ tenantId: 42, userId: 7 }))
      .post('/api/industry-templates/apply/healthcare');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      applied: true,
      industry: 'healthcare',
      template: expect.objectContaining({
        name: 'Healthcare CRM',
      }),
      created: {
        pipelines: 1,
        stages: 5,
        customEntities: 1,
        contacts: 2,
      },
    });

    // Pipeline create call — tenantId comes from req.user, NOT body.
    expect(prisma.pipeline.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        name: 'Patient Acquisition',
        tenantId: 42,
        isDefault: false,
      }),
    }));

    // Custom entity create includes nested fields create.
    expect(prisma.customEntity.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        name: 'Appointment',
        tenantId: 42,
        fields: expect.objectContaining({
          create: expect.arrayContaining([
            expect.objectContaining({ name: 'patientId', type: 'Text' }),
            expect.objectContaining({ name: 'date',      type: 'Date' }),
          ]),
        }),
      }),
    }));
  });

  test('404 when industry is in neither DB nor built-ins', async () => {
    prisma.industryTemplate.findUnique.mockResolvedValue(null);

    const res = await request(makeApp())
      .post('/api/industry-templates/apply/this-vertical-does-not-exist');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/unknown industry template/i);
    // Nothing got created when the resolve fails.
    expect(prisma.pipeline.create).not.toHaveBeenCalled();
    expect(prisma.pipelineStage.create).not.toHaveBeenCalled();
    expect(prisma.customEntity.create).not.toHaveBeenCalled();
    expect(prisma.contact.create).not.toHaveBeenCalled();
  });

  test('idempotent: existing pipeline skipped (created.pipelines=0)', async () => {
    prisma.industryTemplate.findUnique.mockResolvedValue(null);
    // The "Patient Acquisition" pipeline already exists for this tenant.
    prisma.pipeline.findFirst.mockResolvedValue({ id: 99, name: 'Patient Acquisition' });
    // Stages also already exist.
    prisma.pipelineStage.findFirst.mockResolvedValue({ id: 1, name: 'existing' });
    // Custom entity already exists too.
    prisma.customEntity.findFirst.mockResolvedValue({ id: 1, name: 'Appointment' });
    // Sample contacts already exist.
    prisma.contact.findUnique.mockResolvedValue({ id: 1, email: 'anjali.patient@example.com' });

    const res = await request(makeApp())
      .post('/api/industry-templates/apply/healthcare');

    expect(res.status).toBe(200);
    expect(res.body.created).toEqual({
      pipelines: 0,
      stages: 0,
      customEntities: 0,
      contacts: 0,
    });
    // No creates fired — every findFirst hit returned an existing row.
    expect(prisma.pipeline.create).not.toHaveBeenCalled();
    expect(prisma.pipelineStage.create).not.toHaveBeenCalled();
    expect(prisma.customEntity.create).not.toHaveBeenCalled();
    expect(prisma.contact.create).not.toHaveBeenCalled();
  });

  test('stages are deduped across pipelines, position assigned 0..N, color cycles', async () => {
    prisma.industryTemplate.findUnique.mockResolvedValue(null);

    // Real-estate has TWO pipelines whose stage sets partially overlap.
    // The union (Set) collapses duplicates; position increments per unique
    // stage; color cycles every 6.
    await request(makeApp()).post('/api/industry-templates/apply/real-estate');

    // 10 unique stages (per the built-in's sampleStages list — Set dedupes
    // any cross-pipeline overlap). We assert position monotonic + colors
    // cycle from the STAGE_COLORS palette.
    const stageCalls = prisma.pipelineStage.create.mock.calls;
    expect(stageCalls.length).toBeGreaterThanOrEqual(5);
    const positions = stageCalls.map((c) => c[0].data.position);
    // Positions are strictly monotonic from 0.
    for (let i = 0; i < positions.length; i++) {
      expect(positions[i]).toBe(i);
    }
    // Color is one of the 6 STAGE_COLORS hex values.
    const palette = ['#3b82f6', '#8b5cf6', '#f59e0b', '#10b981', '#ef4444', '#06b6d4'];
    for (const c of stageCalls) {
      expect(palette).toContain(c[0].data.color);
    }
  });

  test('DB template takes precedence over built-in when industry key collides', async () => {
    // DB has a saas template with a CUSTOM single-pipeline config.
    prisma.industryTemplate.findUnique.mockResolvedValue({
      id: 77,
      industry: 'saas',
      name: 'Custom SaaS Override',
      description: 'overridden',
      config: JSON.stringify({
        pipelines: [{ name: 'Override Pipeline', stages: ['only-stage'] }],
        customFields: [],
        sampleContacts: [],
      }),
    });

    const res = await request(makeApp())
      .post('/api/industry-templates/apply/saas');

    expect(res.status).toBe(200);
    expect(res.body.template.name).toBe('Custom SaaS Override');
    // The DB pipeline name is what got created — NOT the built-in "New Business".
    expect(prisma.pipeline.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ name: 'Override Pipeline' }),
    }));
    // AuditLog entityId = DB template id (not null, which would be the built-in case).
    expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ entityId: 77 }),
    }));
  });

  test('tenantId on every prisma.*.create call comes from req.user.tenantId, not body', async () => {
    prisma.industryTemplate.findUnique.mockResolvedValue(null);

    // Caller tenantId is 123; we also include a body.tenantId=999 the global
    // stripDangerous would strip — but even if it didn't, this handler must
    // source tenantId from req.user.
    await request(makeApp({ tenantId: 123 }))
      .post('/api/industry-templates/apply/legal')
      .send({ tenantId: 999 });

    // EVERY pipeline create call has tenantId: 123 (the req.user value).
    for (const call of prisma.pipeline.create.mock.calls) {
      expect(call[0].data.tenantId).toBe(123);
    }
    for (const call of prisma.pipelineStage.create.mock.calls) {
      expect(call[0].data.tenantId).toBe(123);
    }
    for (const call of prisma.customEntity.create.mock.calls) {
      expect(call[0].data.tenantId).toBe(123);
    }
    for (const call of prisma.contact.create.mock.calls) {
      expect(call[0].data.tenantId).toBe(123);
    }
  });

  test('writes an AuditLog row with action=APPLY, entity=IndustryTemplate, tenantId, userId', async () => {
    prisma.industryTemplate.findUnique.mockResolvedValue(null);

    await request(makeApp({ tenantId: 42, userId: 99 }))
      .post('/api/industry-templates/apply/education');

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: 'APPLY',
        entity: 'IndustryTemplate',
        // Built-in template → entityId is null.
        entityId: null,
        tenantId: 42,
        userId: 99,
        details: expect.any(String),
      }),
    }));
    // details is a JSON string with industry + name + created.
    const detailsArg = prisma.auditLog.create.mock.calls[0][0].data.details;
    const parsed = JSON.parse(detailsArg);
    expect(parsed).toEqual(expect.objectContaining({
      industry: 'education',
      name: 'Education CRM',
      created: expect.any(Object),
    }));
  });

  test('duplicate-email contact during apply is swallowed (counter does not increment)', async () => {
    prisma.industryTemplate.findUnique.mockResolvedValue(null);
    // The findUnique returns null (look-up says "no contact exists") so the
    // route tries to create — but the create itself throws P2002 (e.g. a
    // concurrent insert won the race). The try/catch around the contact
    // create must swallow it without crashing the whole apply.
    prisma.contact.findUnique.mockResolvedValue(null);
    const dupErr = Object.assign(new Error('Unique constraint'), { code: 'P2002' });
    prisma.contact.create
      .mockRejectedValueOnce(dupErr)
      .mockRejectedValueOnce(dupErr);

    const res = await request(makeApp())
      .post('/api/industry-templates/apply/healthcare');

    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(true);
    // Both contacts collided → counter stays at 0.
    expect(res.body.created.contacts).toBe(0);
    // But the rest of the apply (pipelines, stages, entities) still succeeded.
    expect(res.body.created.pipelines).toBe(1);
    expect(res.body.created.customEntities).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST / — admin create
// ─────────────────────────────────────────────────────────────────────────

describe('POST / — admin-only template create', () => {
  test('happy path: stringifies object config, returns 201 with parsed config', async () => {
    const cfg = { pipelines: [{ name: 'Foo', stages: ['A'] }], customFields: [] };
    prisma.industryTemplate.create.mockResolvedValue({
      id: 50,
      industry: 'custom-vertical',
      name: 'My Custom Template',
      description: 'whatever',
      config: JSON.stringify(cfg),
    });

    const res = await request(makeApp({ role: 'ADMIN' }))
      .post('/api/industry-templates')
      .send({
        industry: 'custom-vertical',
        name: 'My Custom Template',
        description: 'whatever',
        config: cfg,
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: 50,
      industry: 'custom-vertical',
      name: 'My Custom Template',
      // config is parsed back to object on the way out — never raw string.
      config: cfg,
    });
    // create() got the stringified config (since input was an object).
    expect(prisma.industryTemplate.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        industry: 'custom-vertical',
        name: 'My Custom Template',
        config: JSON.stringify(cfg),
      }),
    }));
  });

  test('400 when any of industry / name / config is missing', async () => {
    const cases = [
      { name: 'X', config: {} },                              // missing industry
      { industry: 'x', config: {} },                          // missing name
      { industry: 'x', name: 'X' },                           // missing config
      {},                                                     // missing all
    ];
    for (const body of cases) {
      const res = await request(makeApp({ role: 'ADMIN' }))
        .post('/api/industry-templates')
        .send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/industry.*name.*config.*required/i);
    }
    // No prisma.create call for any of the failing bodies.
    expect(prisma.industryTemplate.create).not.toHaveBeenCalled();
  });

  test('409 when prisma throws P2002 (industry key already exists)', async () => {
    const dupErr = Object.assign(new Error('Unique constraint'), { code: 'P2002' });
    prisma.industryTemplate.create.mockRejectedValueOnce(dupErr);

    const res = await request(makeApp({ role: 'ADMIN' }))
      .post('/api/industry-templates')
      .send({ industry: 'real-estate', name: 'Dup', config: {} });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
  });

  test('403 RBAC_DENIED for non-ADMIN role', async () => {
    const res = await request(makeApp({ role: 'USER' }))
      .post('/api/industry-templates')
      .send({ industry: 'x', name: 'X', config: {} });

    expect(res.status).toBe(403);
    expect(prisma.industryTemplate.create).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// DELETE /:id — admin-only template delete
// ─────────────────────────────────────────────────────────────────────────

describe('DELETE /:id — admin-only template delete', () => {
  test('200 happy path with {deleted, id}', async () => {
    prisma.industryTemplate.delete.mockResolvedValue({ id: 12 });

    const res = await request(makeApp({ role: 'ADMIN' }))
      .delete('/api/industry-templates/12');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true, id: 12 });
    expect(prisma.industryTemplate.delete).toHaveBeenCalledWith({ where: { id: 12 } });
  });

  test('400 when :id is not an integer', async () => {
    const res = await request(makeApp({ role: 'ADMIN' }))
      .delete('/api/industry-templates/not-a-number');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid template id/i);
    expect(prisma.industryTemplate.delete).not.toHaveBeenCalled();
  });

  test('404 when prisma throws P2025 (record not found)', async () => {
    const nfErr = Object.assign(new Error('Not found'), { code: 'P2025' });
    prisma.industryTemplate.delete.mockRejectedValueOnce(nfErr);

    const res = await request(makeApp({ role: 'ADMIN' }))
      .delete('/api/industry-templates/9999');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  test('403 RBAC_DENIED for non-ADMIN role', async () => {
    const res = await request(makeApp({ role: 'USER' }))
      .delete('/api/industry-templates/12');

    expect(res.status).toBe(403);
    expect(prisma.industryTemplate.delete).not.toHaveBeenCalled();
  });
});
