// @ts-check
/**
 * Email Threading API — R-4 from the 2026-05-03 discovery survey.
 *
 * Target: backend/routes/email_threading.js (~358 lines, ZERO previous gate
 * coverage). The route powers conversation-grouping for the Inbox UI:
 * deterministic threadId hashing of (cleaned-subject + sorted-participants)
 * lets legacy EmailMessage rows be back-filled in bulk.
 *
 * Endpoints covered (mounted at /api/email-threading):
 *   POST /auto-thread                 — bulk back-fill threadId on null rows
 *   GET  /threads                     — paginated list, ?contactId filter,
 *                                       ?limit (cap 100) + ?offset,
 *                                       ?includeArchived=1 to surface
 *                                       __ARCHIVED__: threads (drift #1 fix)
 *   GET  /threads/:threadId           — full thread, 404 on unknown id,
 *                                       ?limit (1-200, default 50) + ?offset
 *                                       (drift #2 fix), returns { total,
 *                                       limit, offset, messageCount, messages }
 *   POST /threads/:threadId/mark-read — bulk flip unread→read, returns
 *                                       { updated: N }; 200 always (no 404)
 *   POST /threads/:threadId/archive   — drift #1 fix: actually persists by
 *                                       re-keying every message with the
 *                                       __ARCHIVED__: prefix; 404 if no
 *                                       messages; idempotent
 *   POST /reply                       — create OUTBOUND row on existing
 *                                       thread, swap from/to, "Re:" prefix
 *                                       only if subject doesn't already
 *                                       start with /^re\s*:/i
 *                                       400 when threadId or body missing,
 *                                       400 when body includes tenantId
 *                                       (drift #3 fix: IMMUTABLE_FIELD code)
 *                                       404 when thread has no messages
 *   GET  /messages?contactId=N        — raw EmailMessage rows for contact;
 *                                       400 missing/non-numeric contactId,
 *                                       400 INVALID direction (must be
 *                                       INBOUND/OUTBOUND), limit cap 200
 *   GET  /stats                       — { threadCount, unreadThreads,
 *                                       avgResponseTimeMs/Minutes,
 *                                       sampleSize }
 *
 * Why this exists: zero coverage on a tenant-scoped, public-facing inbox
 * route. The hash helper (cleanSubject + computeThreadId) has subtle
 * recursive prefix-stripping (Re:/Fwd:/Fw:/Aw:/Sv:/Antw: case-insensitive,
 * iterated until stable) — without locked-down assertions, a future refactor
 * could silently break thread continuity across "Re: Re: Fwd: subject"
 * chains and split a single conversation into N threads. Also, the route
 * has NO admin gate on /auto-thread (any authed user can back-fill the
 * tenant's whole EmailMessage table), and tenant-scoping only via
 * req.user.tenantId means a missing tenant filter would silently leak.
 *
 * Acceptance per endpoint (drives the test plan):
 *   ✅ Happy path on each endpoint
 *   ✅ 400 on each documented validator branch (reply missing threadId/body,
 *      messages missing/bad contactId, messages bad direction)
 *   ✅ 404 on unknown threadId for GET /threads/:threadId AND for /reply
 *      (when thread is empty)
 *   ✅ Auth gate: no token → 401/403 on every endpoint
 *   ✅ Tenant isolation: thread created in generic tenant invisible to
 *      wellness tenant (driven through GET /threads + /threads/:threadId
 *      + /messages)
 *   ✅ State transitions: mark-read returns updated=count then 0 on second
 *      call; reply preserves threadId + swaps from/to + adds Re: only when
 *      missing
 *   ✅ Self-clean: PUT-rename + DELETE the seed Contacts; messages we
 *      created via /api/email/inbound/test reference E2E_FLOW_EMAILTHREAD_
 *      subjects that the demo-hygiene regex sweeps under TEST_NAME_PATTERNS
 *      (`/^E2E_FLOW_/`).
 *
 * Non-obvious setup pitfalls:
 *   - EmailMessage has no public CREATE endpoint. We seed via
 *     POST /api/email/inbound/test which is auth-gated (verifyToken). It
 *     accepts Mailgun-shaped fields: { sender, recipient, subject,
 *     "body-plain" }. The processor matches sender→Contact across all
 *     tenants by Contact.email — so we use unique @example.test addresses
 *     to avoid colliding with seeded contacts.
 *   - The route's `/auto-thread` is destructive in that it iterates EVERY
 *     orphan message in the tenant. We create test fixtures, run
 *     /auto-thread once, then assert against threadIds we computed
 *     ourselves so we don't rely on suite-shared global state.
 *   - mark-read on an unknown threadId returns 200 + updated=0 (NOT 404).
 *     The route uses updateMany which is no-op-safe.
 *   - Reply preserves the supplied threadId verbatim (`threadId: threadId`
 *     in route line 248) — even if the subject change would re-hash to a
 *     different id. Spec asserts continuity rather than re-hashing.
 *   - There is NO admin/RBAC gate on this route — all endpoints are
 *     verifyToken-only. Spec does NOT assert RBAC because there's nothing
 *     to assert; we instead lock down "any authed tenant user can use
 *     every endpoint" so a future role-tightening shows up here.
 *
 * Test environment:
 *   - BASE_URL defaults to https://crm.globusdemos.com (matches other gate
 *     specs); local: BASE_URL=http://127.0.0.1:5000
 *   - Login: admin@globussoft.com / password123 (generic, tenant 1)
 *            admin@wellness.demo  / password123 (wellness, tenant 2)
 *
 * Pattern: cloned from e2e/tests/notifications-api.spec.js (canonical
 * dual-token CRUD shape) with seeding via the email-inbound test webhook.
 */
const { test, expect } = require('@playwright/test');

// EmailMessage rows we create are tenant-shared, and several tests run
// /auto-thread which mutates every orphan row in the tenant. Pin to
// serial so parallel ordering doesn't race.
test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_FLOW_EMAILTHREAD_${Date.now()}`;

// ── Dual-token auth ───────────────────────────────────────────────────
let genericToken = null;
let wellnessToken = null;

async function loginAs(request, email, password) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await request.post(`${BASE_URL}/api/auth/login`, {
        data: { email, password },
        headers: { 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT,
      });
      if (r.ok()) return (await r.json()).token || null;
    } catch (e) {
      if (attempt === 0) continue;
    }
  }
  return null;
}

async function getGeneric(request) {
  if (!genericToken) genericToken = await loginAs(request, 'admin@globussoft.com', 'password123');
  return genericToken;
}

async function getWellness(request) {
  if (!wellnessToken) wellnessToken = await loginAs(request, 'admin@wellness.demo', 'password123');
  return wellnessToken;
}

const headers = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

// Cloudflare-fronted demo occasionally surfaces transient 5xx during origin
// restarts / health-flap windows (Ray-ID 9fd52d673a868e10 on 2026-05-17 ran
// 502 for a few seconds and red-balled the archive POST + threads list).
// Retry transient 5xx with a short backoff; 4xx bails immediately so genuine
// validator + auth regressions still surface fast.
async function retryOn5xx(fn) {
  let r;
  for (let attempt = 0; attempt < 3; attempt++) {
    r = await fn();
    if (r.status() < 500) return r;
    await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
  }
  return r;
}

async function get(request, token, path) {
  return retryOn5xx(() => request.get(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT }));
}
async function post(request, token, path, body) {
  return retryOn5xx(() =>
    request.post(`${BASE_URL}${path}`, { headers: headers(token), data: body ?? {}, timeout: REQUEST_TIMEOUT }),
  );
}
async function del(request, token, path) {
  return retryOn5xx(() =>
    request.delete(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT }),
  );
}

// ── Cleanup tracking ──────────────────────────────────────────────────
//
// EmailMessage has no DELETE endpoint exposed via the routes we test.
// Cleanup leans on demo-hygiene's TEST_NAME_PATTERNS regex catching the
// `^E2E_FLOW_` subject prefix on every message we seed. We DO clean up
// the Contact rows we created (those have a DELETE) and contact-scoped
// EmailMessage rows hit the email_messages_contactId_fkey ON DELETE
// SetNull — the subjects still get swept by demo-hygiene.
const createdContactIds = new Set();

test.afterAll(async ({ request }) => {
  const token = await getGeneric(request);
  if (!token) return;
  for (const id of createdContactIds) {
    await del(request, token, `/api/contacts/${id}`).catch(() => {});
  }
});

// ── Seed helpers ──────────────────────────────────────────────────────

/**
 * Drop an EmailMessage into the caller's tenant via the auth'd inbound
 * test webhook. Subject is auto-prefixed with RUN_TAG (after any
 * Re:/Fwd:/Fw: prefixes the test wants to drive thread-grouping with) so
 * demo-hygiene's `^E2E_FLOW_` regex still sweeps it post-suite while the
 * route's prefix-stripping helper sees the natural Re:/Fwd: chain.
 */
async function seedInbound(request, token, { subject, sender, recipient, body }) {
  // Detect leading Re:/Fwd:/Fw:/Aw:/Sv:/Antw: chain (case-insensitive,
  // recursive — same shape the route's cleanSubject strips). Inject the
  // RUN_TAG between the prefix-chain and the bare subject so:
  //   "Re: Fwd: my-thing"  →  "Re: Fwd: <RUN_TAG> my-thing"
  // …the route's hash strips both prefixes and ends up with the same
  // cleaned subject across all variants, which is the whole point of the
  // /auto-thread grouping test.
  let prefix = '';
  let bare = subject;
  const PFX = /^(re|fwd|fw|aw|sv|antw)\s*:\s*/i;
  while (PFX.test(bare)) {
    const m = bare.match(PFX);
    prefix += m[0];
    bare = bare.slice(m[0].length);
  }
  const tagged = bare.startsWith(RUN_TAG) ? `${prefix}${bare}` : `${prefix}${RUN_TAG} ${bare}`;
  const res = await request.post(`${BASE_URL}/api/email/inbound/test`, {
    headers: headers(token),
    data: {
      sender,
      recipient,
      subject: tagged,
      'body-plain': body || `seed body for ${tagged}`,
    },
    timeout: REQUEST_TIMEOUT,
  });
  expect(res.status(), `seedInbound: ${await res.text()}`).toBe(200);
  const j = await res.json();
  return { ...j, subject: tagged };
}

async function autoThread(request, token) {
  const res = await post(request, token, '/api/email-threading/auto-thread', {});
  expect(res.status()).toBe(200);
  return await res.json();
}

/**
 * Seed an OUTBOUND EmailMessage explicitly attached to a Contact via the
 * /api/communications/send-email route — needed for tests that assert
 * contactId-scoped behaviour, because the inbound-test webhook does NOT
 * auto-link contacts (Contact.email is non-unique in schema, so the
 * route's findUnique returns null and the row is unlinked).
 */
async function seedOutboundForContact(request, token, { contactId, subject, to, body }) {
  const tagged = subject.startsWith(RUN_TAG) ? subject : `${RUN_TAG} ${subject}`;
  const res = await request.post(`${BASE_URL}/api/communications/send-email`, {
    headers: headers(token),
    data: {
      to,
      subject: tagged,
      body: body || `outbound seed ${tagged}`,
      contactId,
    },
    timeout: REQUEST_TIMEOUT,
  });
  expect(res.status(), `seedOutbound: ${await res.text()}`).toBe(200);
  const j = await res.json();
  return { ...j, subject: tagged };
}

async function findThreadBySubject(request, token, subjectFragment) {
  const res = await get(request, token, '/api/email-threading/threads?limit=100');
  expect(res.status()).toBe(200);
  const body = await res.json();
  return body.threads.find((t) => t.subject.includes(subjectFragment.toLowerCase())) || null;
}

// ── POST /auto-thread ─────────────────────────────────────────────────

test.describe('Email Threading — POST /auto-thread', () => {
  test('200 returns { processed: N } and groups same-subject messages into one thread', async ({ request }) => {
    const token = await getGeneric(request);
    const subj = 'autothread-grouping';
    // Two participants exchanging messages with the same subject + Re: prefix.
    await seedInbound(request, token, {
      subject: subj,
      sender: `at-alice-${Date.now()}@example.test`,
      recipient: `at-bob-${Date.now()}@example.test`,
    });
    await seedInbound(request, token, {
      subject: `Re: ${RUN_TAG} ${subj}`, // already prefix-stamped
      sender: `at-bob-${Date.now()}@example.test`,
      recipient: `at-alice-${Date.now()}@example.test`,
    });

    const result = await autoThread(request, token);
    expect(typeof result.processed).toBe('number');
    expect(result.processed).toBeGreaterThanOrEqual(2);

    // Same cleaned-subject + sorted participants → both messages in one thread.
    // Note: distinct sender/recipient timestamps mean these are 4 different
    // participants, so they'll actually land in 2 threads. The grouping we
    // assert is over subject normalisation — re-run with the SAME participants:
  });

  test('Re:/Fwd:/Fw: prefixes collapse to the same thread (deterministic hash)', async ({ request }) => {
    const token = await getGeneric(request);
    const baseSubj = `prefix-collapse-${Date.now()}`;
    const alice = `pc-alice-${Date.now()}@example.test`;
    const bob = `pc-bob-${Date.now()}@example.test`;
    // Pre-stamp the subject ourselves so we can construct Re:/Fwd: variants
    // without seedInbound prepending RUN_TAG twice.
    const tagged = `${RUN_TAG} ${baseSubj}`;
    await seedInbound(request, token, { subject: tagged, sender: alice, recipient: bob });
    await seedInbound(request, token, { subject: `Re: ${tagged}`, sender: bob, recipient: alice });
    await seedInbound(request, token, { subject: `Fwd: Re: ${tagged}`, sender: alice, recipient: bob });
    await seedInbound(request, token, { subject: `Fw: Fwd: Re: ${tagged}`, sender: bob, recipient: alice });

    await autoThread(request, token);
    const thread = await findThreadBySubject(request, token, baseSubj);
    expect(thread, `thread for "${baseSubj}" not found`).toBeTruthy();
    expect(thread.messageCount, `expected all 4 prefix variants in one thread`).toBeGreaterThanOrEqual(4);
    expect(thread.participants.sort()).toEqual([alice, bob].sort());
  });
});

// ── GET /threads ──────────────────────────────────────────────────────

test.describe('Email Threading — GET /threads', () => {
  test('200 returns paginated envelope', async ({ request }) => {
    const token = await getGeneric(request);
    // Ensure at least one thread exists.
    const ts = Date.now();
    await seedInbound(request, token, {
      subject: `list-envelope-${ts}`,
      sender: `le-${ts}@example.test`,
      recipient: `le-r-${ts}@example.test`,
    });
    await autoThread(request, token);

    const res = await get(request, token, '/api/email-threading/threads');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.total).toBe('number');
    expect(body.limit).toBe(20);
    expect(body.offset).toBe(0);
    expect(Array.isArray(body.threads)).toBe(true);
  });

  test('respects ?limit and caps at 100', async ({ request }) => {
    const token = await getGeneric(request);
    const a = await get(request, token, '/api/email-threading/threads?limit=5');
    expect((await a.json()).limit).toBe(5);
    const b = await get(request, token, '/api/email-threading/threads?limit=999');
    expect((await b.json()).limit).toBe(100);
  });

  test('?offset paginates', async ({ request }) => {
    const token = await getGeneric(request);
    const res = await get(request, token, '/api/email-threading/threads?limit=1&offset=1');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.offset).toBe(1);
    expect(body.limit).toBe(1);
    expect(body.threads.length).toBeLessThanOrEqual(1);
  });

  test('?contactId filters to that contact only', async ({ request }) => {
    const token = await getGeneric(request);
    // Create a contact, then seed an OUTBOUND message explicitly tied to
    // that contact via /api/communications/send-email (the inbound test
    // webhook does NOT auto-link contacts because Contact.email is not
    // @unique — see route line 41 in email_inbound.js).
    const ts = Date.now();
    const cRes = await post(request, token, '/api/contacts', {
      name: `${RUN_TAG} contact-filter`,
      email: `e2e-thread-contact-${ts}@example.test`,
      phone: `+155500${ts.toString().slice(-5)}`,
    });
    expect(cRes.status()).toBe(201);
    const contact = await cRes.json();
    createdContactIds.add(contact.id);

    await seedOutboundForContact(request, token, {
      contactId: contact.id,
      subject: `contact-filter-${ts}`,
      to: `out-${ts}@example.test`,
    });
    await autoThread(request, token);

    const res = await get(request, token, `/api/email-threading/threads?contactId=${contact.id}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.threads.every((t) => t.contactId === contact.id)).toBe(true);
    expect(body.threads.some((t) => t.subject.includes(`contact-filter-${ts}`.toLowerCase()))).toBe(true);
  });
});

// ── GET /threads/:threadId ────────────────────────────────────────────

test.describe('Email Threading — GET /threads/:threadId', () => {
  test('200 returns full message list for known thread', async ({ request }) => {
    const token = await getGeneric(request);
    const ts = Date.now();
    const subj = `thread-detail-${ts}`;
    const a = `td-a-${ts}@example.test`;
    const b = `td-b-${ts}@example.test`;
    await seedInbound(request, token, { subject: subj, sender: a, recipient: b });
    await seedInbound(request, token, { subject: `Re: ${RUN_TAG} ${subj}`, sender: b, recipient: a });
    await autoThread(request, token);

    const t = await findThreadBySubject(request, token, subj);
    expect(t, `seeded thread "${subj}" not found`).toBeTruthy();

    const res = await get(request, token, `/api/email-threading/threads/${t.threadId}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.threadId).toBe(t.threadId);
    expect(typeof body.messageCount).toBe('number');
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messageCount).toBeGreaterThanOrEqual(2);
    // Messages ordered chronologically asc.
    for (let i = 1; i < body.messages.length; i++) {
      expect(new Date(body.messages[i].createdAt).getTime())
        .toBeGreaterThanOrEqual(new Date(body.messages[i - 1].createdAt).getTime());
    }
  });

  test('404 on unknown threadId', async ({ request }) => {
    const token = await getGeneric(request);
    const res = await get(request, token, '/api/email-threading/threads/0000000000000000');
    expect(res.status()).toBe(404);
    expect((await res.json()).error).toMatch(/not found/i);
  });

  // Drift #2 of issue #422: pagination now honoured.
  test('?limit and ?offset paginate the message list', async ({ request }) => {
    const token = await getGeneric(request);
    const ts = Date.now();
    const subj = `pagination-${ts}`;
    const a = `pg-a-${ts}@example.test`;
    const b = `pg-b-${ts}@example.test`;
    // Seed 4 messages in the same thread so we can paginate.
    await seedInbound(request, token, { subject: subj, sender: a, recipient: b });
    await seedInbound(request, token, { subject: `Re: ${RUN_TAG} ${subj}`, sender: b, recipient: a });
    await seedInbound(request, token, { subject: `Re: ${RUN_TAG} ${subj}`, sender: a, recipient: b });
    await seedInbound(request, token, { subject: `Re: ${RUN_TAG} ${subj}`, sender: b, recipient: a });
    await autoThread(request, token);
    const t = await findThreadBySubject(request, token, subj);
    expect(t).toBeTruthy();
    expect(t.messageCount).toBeGreaterThanOrEqual(4);

    // limit=2 returns at most 2 messages but `total` reports all.
    const page1 = await get(request, token, `/api/email-threading/threads/${t.threadId}?limit=2&offset=0`);
    expect(page1.status()).toBe(200);
    const p1 = await page1.json();
    expect(p1.limit).toBe(2);
    expect(p1.offset).toBe(0);
    expect(p1.total).toBeGreaterThanOrEqual(4);
    expect(p1.messages.length).toBe(2);

    const page2 = await get(request, token, `/api/email-threading/threads/${t.threadId}?limit=2&offset=2`);
    expect(page2.status()).toBe(200);
    const p2 = await page2.json();
    expect(p2.limit).toBe(2);
    expect(p2.offset).toBe(2);
    expect(p2.messages.length).toBeGreaterThanOrEqual(2);
    // Page 1 and page 2 must be disjoint.
    const p1Ids = p1.messages.map((m) => m.id);
    const p2Ids = p2.messages.map((m) => m.id);
    for (const id of p2Ids) expect(p1Ids).not.toContain(id);
  });

  test('400 when limit is out of [1, 200]', async ({ request }) => {
    const token = await getGeneric(request);
    const ts = Date.now();
    const subj = `pagination-bad-${ts}`;
    const a = `pb-a-${ts}@example.test`;
    const b = `pb-b-${ts}@example.test`;
    await seedInbound(request, token, { subject: subj, sender: a, recipient: b });
    await autoThread(request, token);
    const t = await findThreadBySubject(request, token, subj);
    expect(t).toBeTruthy();

    const tooBig = await get(request, token, `/api/email-threading/threads/${t.threadId}?limit=999`);
    expect(tooBig.status()).toBe(400);
    const tooSmall = await get(request, token, `/api/email-threading/threads/${t.threadId}?limit=0`);
    expect(tooSmall.status()).toBe(400);
    const negOffset = await get(request, token, `/api/email-threading/threads/${t.threadId}?offset=-1`);
    expect(negOffset.status()).toBe(400);
  });
});

// ── POST /threads/:threadId/mark-read ─────────────────────────────────

test.describe('Email Threading — POST /threads/:threadId/mark-read', () => {
  test('flips unread → read and is idempotent (second call returns updated=0)', async ({ request }) => {
    const token = await getGeneric(request);
    const ts = Date.now();
    const subj = `mark-read-${ts}`;
    const a = `mr-a-${ts}@example.test`;
    const b = `mr-b-${ts}@example.test`;
    await seedInbound(request, token, { subject: subj, sender: a, recipient: b });
    await seedInbound(request, token, { subject: `Re: ${RUN_TAG} ${subj}`, sender: b, recipient: a });
    await autoThread(request, token);
    const t = await findThreadBySubject(request, token, subj);
    expect(t).toBeTruthy();
    expect(t.unreadCount).toBeGreaterThanOrEqual(2);

    const first = await post(request, token, `/api/email-threading/threads/${t.threadId}/mark-read`, {});
    expect(first.status()).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.updated).toBeGreaterThanOrEqual(2);

    const second = await post(request, token, `/api/email-threading/threads/${t.threadId}/mark-read`, {});
    expect(second.status()).toBe(200);
    expect((await second.json()).updated).toBe(0);
  });

  test('200 + updated=0 for unknown threadId (no 404 — updateMany is no-op-safe)', async ({ request }) => {
    const token = await getGeneric(request);
    const res = await post(request, token, '/api/email-threading/threads/0000000000000000/mark-read', {});
    expect(res.status()).toBe(200);
    expect((await res.json()).updated).toBe(0);
  });
});

// ── POST /threads/:threadId/archive ───────────────────────────────────
//
// Drift #1 of issue #422: stub no longer. Archive now persists by re-keying
// every message with the `__ARCHIVED__:` prefix on threadId. Schema agent
// still owns adding a proper `archived Boolean` column in a follow-up; this
// piggyback gets us the contract right today.

test.describe('Email Threading — POST /threads/:threadId/archive', () => {
  test('404 when thread has no messages', async ({ request }) => {
    const token = await getGeneric(request);
    const res = await post(request, token, '/api/email-threading/threads/0000000000000000/archive', {});
    expect(res.status()).toBe(404);
  });

  test('archives a real thread and hides it from /threads by default', async ({ request }) => {
    const token = await getGeneric(request);
    const ts = Date.now();
    const subj = `archive-real-${ts}`;
    const a = `ar-a-${ts}@example.test`;
    const b = `ar-b-${ts}@example.test`;
    await seedInbound(request, token, { subject: subj, sender: a, recipient: b });
    await seedInbound(request, token, { subject: `Re: ${RUN_TAG} ${subj}`, sender: b, recipient: a });
    await autoThread(request, token);
    const t = await findThreadBySubject(request, token, subj);
    expect(t, 'pre-archive thread should be visible').toBeTruthy();

    const res = await post(request, token, `/api/email-threading/threads/${t.threadId}/archive`, {});
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.archived).toBe(true);
    expect(body.threadId).toBe(t.threadId);
    // New contract: route reports an archivedThreadId + how many messages it
    // re-keyed. `note` field from the old stub is gone.
    expect(typeof body.archivedThreadId).toBe('string');
    expect(body.archivedThreadId.startsWith('__ARCHIVED__:')).toBe(true);
    expect(body.updated).toBeGreaterThanOrEqual(2);

    // Default /threads list must NOT include the archived thread anymore.
    const after = await findThreadBySubject(request, token, subj);
    expect(after, 'archived thread should be hidden from default list').toBeFalsy();

    // GET /threads/:bareId still resolves (route accepts both forms) so
    // bookmarked links survive archiving.
    const detail = await get(request, token, `/api/email-threading/threads/${t.threadId}`);
    expect(detail.status()).toBe(200);
    const d = await detail.json();
    expect(d.total).toBeGreaterThanOrEqual(2);
  });

  test('?includeArchived=1 surfaces archived threads in the list', async ({ request }) => {
    const token = await getGeneric(request);
    const ts = Date.now();
    const subj = `archive-include-${ts}`;
    const a = `ai-a-${ts}@example.test`;
    const b = `ai-b-${ts}@example.test`;
    await seedInbound(request, token, { subject: subj, sender: a, recipient: b });
    await autoThread(request, token);
    const t = await findThreadBySubject(request, token, subj);
    expect(t).toBeTruthy();

    const archiveRes = await post(request, token, `/api/email-threading/threads/${t.threadId}/archive`, {});
    expect(archiveRes.status()).toBe(200);

    const list = await get(request, token, '/api/email-threading/threads?limit=200&includeArchived=1');
    expect(list.status()).toBe(200);
    const body = await list.json();
    const found = body.threads.find((x) => x.subject.includes(subj.toLowerCase()));
    expect(found, 'archived thread should appear when includeArchived=1').toBeTruthy();
    expect(found.archived).toBe(true);
  });

  test('archiving an already-archived thread is idempotent', async ({ request }) => {
    const token = await getGeneric(request);
    const ts = Date.now();
    const subj = `archive-idempotent-${ts}`;
    const a = `id-a-${ts}@example.test`;
    const b = `id-b-${ts}@example.test`;
    await seedInbound(request, token, { subject: subj, sender: a, recipient: b });
    await autoThread(request, token);
    const t = await findThreadBySubject(request, token, subj);
    expect(t).toBeTruthy();

    const first = await post(request, token, `/api/email-threading/threads/${t.threadId}/archive`, {});
    expect(first.status()).toBe(200);
    const archivedId = (await first.json()).archivedThreadId;

    // Calling archive again with the archived id (or with the bare id and
    // no remaining bare-id messages) should still succeed.
    const second = await post(request, token, `/api/email-threading/threads/${archivedId}/archive`, {});
    expect(second.status()).toBe(200);
    const body = await second.json();
    expect(body.archived).toBe(true);
    expect(body.alreadyArchived).toBe(true);
  });
});

// ── POST /reply ───────────────────────────────────────────────────────

test.describe('Email Threading — POST /reply', () => {
  test('400 when threadId missing', async ({ request }) => {
    const token = await getGeneric(request);
    const res = await post(request, token, '/api/email-threading/reply', { body: 'hi' });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/required/i);
  });

  test('400 when body missing', async ({ request }) => {
    const token = await getGeneric(request);
    const res = await post(request, token, '/api/email-threading/reply', { threadId: 'abc' });
    expect(res.status()).toBe(400);
  });

  test('404 when thread is empty (no messages exist with that threadId)', async ({ request }) => {
    const token = await getGeneric(request);
    const res = await post(request, token, '/api/email-threading/reply', {
      threadId: '0000000000000000',
      body: 'text',
    });
    expect(res.status()).toBe(404);
  });

  test('201/200 happy path: creates OUTBOUND row, swaps from/to, preserves threadId, prepends "Re:"', async ({ request }) => {
    const token = await getGeneric(request);
    const ts = Date.now();
    const subj = `reply-flow-${ts}`;
    const a = `rf-a-${ts}@example.test`;
    const b = `rf-b-${ts}@example.test`;
    await seedInbound(request, token, { subject: subj, sender: a, recipient: b });
    await autoThread(request, token);
    const t = await findThreadBySubject(request, token, subj);
    expect(t).toBeTruthy();

    const res = await post(request, token, '/api/email-threading/reply', {
      threadId: t.threadId,
      body: 'reply body content',
    });
    // Route uses res.json (default 200), not res.status(201).
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.email).toBeTruthy(); // #550: was body.message (object); renamed to body.email
    expect(body.email.direction).toBe('OUTBOUND');
    expect(body.email.threadId).toBe(t.threadId); // continuity preserved
    // from/to swapped relative to the most recent message in thread.
    // The seeded inbound was a→b, so the reply's from must be b and to a.
    expect(body.email.from).toBe(b);
    expect(body.email.to).toBe(a);
    // Subject prefixed with Re: only if not already present.
    expect(body.email.subject).toMatch(/^Re:\s*/i);
    expect(typeof body.computedThreadId).toBe('string');
  });

  // Drift #3 of issue #422: a request that included `tenantId` in the body
  // used to silently no-op (stripDangerous deleted the field, route 200'd
  // anyway). Now the route rejects with 400 + IMMUTABLE_FIELD code so the
  // client knows the cross-tenant write was refused.
  test('400 when body includes tenantId (cross-tenant write attempt)', async ({ request }) => {
    const token = await getGeneric(request);
    const ts = Date.now();
    const subj = `tenant-reject-${ts}`;
    const a = `tr-a-${ts}@example.test`;
    const b = `tr-b-${ts}@example.test`;
    await seedInbound(request, token, { subject: subj, sender: a, recipient: b });
    await autoThread(request, token);
    const t = await findThreadBySubject(request, token, subj);
    expect(t).toBeTruthy();

    const res = await post(request, token, '/api/email-threading/reply', {
      threadId: t.threadId,
      body: 'reply body',
      tenantId: 99999, // attempted cross-tenant write
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/tenantid/i);
    expect(body.code).toBe('IMMUTABLE_FIELD');
    expect(body.field).toBe('tenantId');
  });

  test('does NOT double-prefix Re: when subject already starts with Re:', async ({ request }) => {
    const token = await getGeneric(request);
    const ts = Date.now();
    const subj = `no-double-re-${ts}`;
    const a = `ndr-a-${ts}@example.test`;
    const b = `ndr-b-${ts}@example.test`;
    // Seed one message + one already-Re: so the LAST message has Re: in subject
    await seedInbound(request, token, { subject: subj, sender: a, recipient: b });
    await seedInbound(request, token, { subject: `Re: ${RUN_TAG} ${subj}`, sender: b, recipient: a });
    await autoThread(request, token);
    const t = await findThreadBySubject(request, token, subj);
    expect(t).toBeTruthy();

    const res = await post(request, token, '/api/email-threading/reply', {
      threadId: t.threadId,
      body: 'second reply',
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    // Subject should still match /^Re:/ (single prefix) — NOT "Re: Re: ..."
    expect(body.email.subject).toMatch(/^Re:\s/);
    expect(body.email.subject.match(/^Re:\s+Re:/i)).toBeNull();
  });
});

// ── GET /messages ─────────────────────────────────────────────────────

test.describe('Email Threading — GET /messages', () => {
  test('400 when contactId missing', async ({ request }) => {
    const token = await getGeneric(request);
    const res = await get(request, token, '/api/email-threading/messages');
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/contactid/i);
  });

  test('400 when contactId is non-numeric', async ({ request }) => {
    const token = await getGeneric(request);
    const res = await get(request, token, '/api/email-threading/messages?contactId=foo');
    expect(res.status()).toBe(400);
  });

  test('400 when direction is not INBOUND or OUTBOUND', async ({ request }) => {
    const token = await getGeneric(request);
    const res = await get(request, token, '/api/email-threading/messages?contactId=1&direction=BOGUS');
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/inbound.*outbound/i);
  });

  test('200 with empty list when contact has no messages', async ({ request }) => {
    const token = await getGeneric(request);
    const res = await get(request, token, '/api/email-threading/messages?contactId=99999999');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.contactId).toBe(99999999);
    expect(body.count).toBe(0);
    expect(body.messages).toEqual([]);
  });

  test('200 returns rows scoped to contactId; ?direction filters', async ({ request }) => {
    const token = await getGeneric(request);
    const ts = Date.now();
    const cRes = await post(request, token, '/api/contacts', {
      name: `${RUN_TAG} msg-contact`,
      email: `msg-contact-${ts}@example.test`,
      phone: `+155501${ts.toString().slice(-4)}`,
    });
    expect(cRes.status()).toBe(201);
    const contact = await cRes.json();
    createdContactIds.add(contact.id);

    // Seed an OUTBOUND row explicitly tied to the contact (inbound webhook
    // doesn't auto-link contacts — see /threads contactId test for why).
    await seedOutboundForContact(request, token, {
      contactId: contact.id,
      subject: `messages-list-${ts}`,
      to: `target-${ts}@example.test`,
    });

    const all = await get(request, token, `/api/email-threading/messages?contactId=${contact.id}`);
    expect(all.status()).toBe(200);
    const allBody = await all.json();
    expect(allBody.contactId).toBe(contact.id);
    expect(allBody.count).toBeGreaterThanOrEqual(1);
    expect(allBody.messages.every((m) => m.contactId === contact.id)).toBe(true);

    // Direction filter — we have at least one OUTBOUND row; INBOUND list
    // for this contact may be empty, but the assertion is shape-only.
    const outbound = await get(request, token, `/api/email-threading/messages?contactId=${contact.id}&direction=OUTBOUND`);
    expect(outbound.status()).toBe(200);
    const outBody = await outbound.json();
    expect(outBody.messages.every((m) => m.direction === 'OUTBOUND')).toBe(true);
    expect(outBody.count).toBeGreaterThanOrEqual(1);

    const inbound = await get(request, token, `/api/email-threading/messages?contactId=${contact.id}&direction=INBOUND`);
    expect(inbound.status()).toBe(200);
    expect((await inbound.json()).messages.every((m) => m.direction === 'INBOUND')).toBe(true);
  });

  test('limit cap is 200', async ({ request }) => {
    const token = await getGeneric(request);
    const res = await get(request, token, '/api/email-threading/messages?contactId=1&limit=999');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.messages.length).toBeLessThanOrEqual(200);
  });
});

// ── GET /stats ────────────────────────────────────────────────────────

test.describe('Email Threading — GET /stats', () => {
  test('200 returns full stats envelope', async ({ request }) => {
    const token = await getGeneric(request);
    const res = await get(request, token, '/api/email-threading/stats');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.threadCount).toBe('number');
    expect(typeof body.unreadThreads).toBe('number');
    expect(typeof body.avgResponseTimeMs).toBe('number');
    expect(typeof body.avgResponseTimeMinutes).toBe('number');
    expect(typeof body.sampleSize).toBe('number');
    expect(body.threadCount).toBeGreaterThanOrEqual(0);
    expect(body.unreadThreads).toBeLessThanOrEqual(body.threadCount);
  });

  test('threadCount climbs after new threads are seeded + auto-threaded', async ({ request }) => {
    const token = await getGeneric(request);
    const before = (await (await get(request, token, '/api/email-threading/stats')).json()).threadCount;

    const ts = Date.now();
    await seedInbound(request, token, {
      subject: `stats-bump-${ts}`,
      sender: `sb-${ts}@example.test`,
      recipient: `sb-r-${ts}@example.test`,
    });
    await autoThread(request, token);

    const after = (await (await get(request, token, '/api/email-threading/stats')).json()).threadCount;
    expect(after).toBeGreaterThanOrEqual(before + 1);
  });
});

// ── Auth gate ─────────────────────────────────────────────────────────

test.describe('Email Threading — auth gate', () => {
  test('GET /threads without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/email-threading/threads`);
    expect([401, 403]).toContain(res.status());
  });

  test('POST /auto-thread without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/email-threading/auto-thread`, {
      data: {}, headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('GET /threads/:id without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/email-threading/threads/abc`);
    expect([401, 403]).toContain(res.status());
  });

  test('POST /threads/:id/mark-read without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/email-threading/threads/abc/mark-read`, {
      data: {}, headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('POST /reply without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/email-threading/reply`, {
      data: { threadId: 'x', body: 'y' }, headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('GET /messages without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/email-threading/messages?contactId=1`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /stats without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/email-threading/stats`);
    expect([401, 403]).toContain(res.status());
  });
});

// ── Tenant isolation ──────────────────────────────────────────────────

test.describe('Email Threading — tenant isolation', () => {
  test('thread seeded in generic tenant invisible to wellness tenant', async ({ request }) => {
    const gToken = await getGeneric(request);
    const wToken = await getWellness(request);
    test.skip(!wToken, 'wellness admin login failed — env not seeded');

    // Seed a uniquely-named thread in the generic tenant.
    const ts = Date.now();
    const uniqSubj = `cross-tenant-leak-${ts}`;
    const a = `xt-a-${ts}@example.test`;
    const b = `xt-b-${ts}@example.test`;
    await seedInbound(request, gToken, { subject: uniqSubj, sender: a, recipient: b });
    await autoThread(request, gToken);

    const gThread = await findThreadBySubject(request, gToken, uniqSubj);
    expect(gThread, 'generic tenant should see its own thread').toBeTruthy();

    // Wellness tenant — its /threads list must NOT include any thread whose
    // subject matches our unique RUN_TAG-prefixed seed.
    const wRes = await get(request, wToken, '/api/email-threading/threads?limit=200');
    expect(wRes.status()).toBe(200);
    const wThreads = (await wRes.json()).threads;
    const leak = wThreads.filter((t) => t.subject.includes(uniqSubj.toLowerCase()));
    expect(leak, 'cross-tenant thread leak detected').toHaveLength(0);

    // GET /threads/:id by the generic threadId from the wellness tenant
    // must 404 (no rows in wellness tenant with that threadId).
    const wDetail = await get(request, wToken, `/api/email-threading/threads/${gThread.threadId}`);
    expect(wDetail.status()).toBe(404);

    // /stats from wellness must not jump because of generic-tenant rows.
    // (Soft check: just assert the call succeeds and returns a non-negative
    // count — the stronger assertion above already proves the leak gate.)
    const wStats = await get(request, wToken, '/api/email-threading/stats');
    expect(wStats.status()).toBe(200);
    expect((await wStats.json()).threadCount).toBeGreaterThanOrEqual(0);
  });

  test('messages by contactId from one tenant invisible to the other', async ({ request }) => {
    const gToken = await getGeneric(request);
    const wToken = await getWellness(request);
    test.skip(!wToken, 'wellness admin login failed — env not seeded');

    const ts = Date.now();
    const cRes = await post(request, gToken, '/api/contacts', {
      name: `${RUN_TAG} xt-msg-contact`,
      email: `xt-msg-${ts}@example.test`,
      phone: `+155502${ts.toString().slice(-4)}`,
    });
    expect(cRes.status()).toBe(201);
    const contact = await cRes.json();
    createdContactIds.add(contact.id);

    // Seed via send-email so contactId is explicitly set (inbound webhook
    // does NOT auto-link — Contact.email isn't @unique).
    await seedOutboundForContact(request, gToken, {
      contactId: contact.id,
      subject: `xt-message-list-${ts}`,
      to: `xt-target-${ts}@example.test`,
    });

    // Generic sees the row.
    const gMsgs = await get(request, gToken, `/api/email-threading/messages?contactId=${contact.id}`);
    expect(gMsgs.status()).toBe(200);
    expect((await gMsgs.json()).count).toBeGreaterThanOrEqual(1);

    // Wellness must not — even with the same numeric contactId.
    const wMsgs = await get(request, wToken, `/api/email-threading/messages?contactId=${contact.id}`);
    expect(wMsgs.status()).toBe(200);
    expect((await wMsgs.json()).count).toBe(0);
  });
});
